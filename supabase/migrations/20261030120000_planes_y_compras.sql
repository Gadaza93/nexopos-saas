-- NexoPos · Planes y compras desde la landing (netxpremium.com/nexopos, pago con Wompi)
-- Equivale a las migraciones de compras de NexoBar (sitio comercial, 28 y 29-10-2026), con estos cambios:
--   · Referencias NEXOPOS-AAAAMMDD-XXXXXXXX: el comercio de Wompi es el mismo de NexoBar (opción b),
--     su webhook reenvía a wompi-webhook de NexoPos solo los eventos con ese prefijo.
--   · Vigencia en días (mensual = 30, anual = 365) en vez de meses.
--   · Idempotencia por transacción de Wompi: wompi_transaccion_id es único.
--   · RLS cerrado: solo service_role (Edge Functions) y el superadmin (lectura; en planes también precios y estado).
-- compras no tiene business_id: negocio_id es llave foránea con on delete set null, así que
-- admin_delete_negocio conserva el historial de pagos y no necesita cambios.

/* ---------- Tablas ---------- */
create table public.planes (
  id text primary key,
  nombre text not null,
  descripcion text not null default '',
  precio_cop integer not null check (precio_cop > 0),
  caracteristicas text[] not null default '{}',
  ciclo text not null default 'mensual' check (ciclo in ('mensual', 'anual')),
  orden smallint not null default 0,
  activo boolean not null default true
);

create table public.compras (
  id uuid primary key default gen_random_uuid(),
  referencia text not null unique,
  plan_id text not null references public.planes (id),
  monto_cop integer not null check (monto_cop > 0),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'pagado', 'rechazado', 'entregado')),

  comercio text not null,
  documento_tipo text not null check (documento_tipo in ('NIT', 'CC', 'CE')),
  documento text not null,
  responsable text not null,
  email text not null,
  telefono text not null,
  ciudad text not null,
  acepta_marketing boolean not null default false,
  ip text,

  wompi_transaccion_id text unique,
  wompi_estado text,
  metodo_pago text,
  pagado_at timestamptz,

  negocio_id text references public.negocios (id) on delete set null,
  usuario_id uuid,
  es_renovacion boolean,
  provision_error text,
  duplicado_de text,
  procesando_hasta timestamptz,
  cliente_notificado_at timestamptz,
  alerta_enviada_at timestamptz,
  entregado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Postgres no indexa las llaves foráneas automáticamente
create index compras_plan_id_idx on public.compras (plan_id);
create index compras_negocio_id_idx on public.compras (negocio_id);
-- Bandeja de trabajo y barrido: "compras pagadas pendientes, las más recientes primero"
create index compras_estado_created_at_idx on public.compras (estado, created_at desc);
-- Límite de compras por IP en crear-compra
create index compras_ip_created_at_idx on public.compras (ip, created_at desc);

create or replace function private.compras_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger compras_touch_updated_at
before update on public.compras
for each row execute function private.compras_touch_updated_at();

/* ---------- RLS: solo service_role y superadmin ---------- */
-- service_role omite RLS. anon no recibe nada; authenticated solo pasa las políticas si es superadmin.
alter table public.planes enable row level security;
alter table public.compras enable row level security;

revoke all on public.planes, public.compras from anon, authenticated;
grant select on public.planes, public.compras to authenticated;
grant update (nombre, descripcion, precio_cop, caracteristicas, orden, activo) on public.planes to authenticated;

create policy planes_superadmin_select on public.planes for select to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin');
create policy planes_superadmin_update on public.planes for update to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin');
create policy compras_superadmin_select on public.compras for select to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin');

/* ---------- Planes (mismos precios que NexoBar; la landing los lee de aquí) ---------- */
insert into public.planes (id, nombre, descripcion, precio_cop, caracteristicas, ciclo, orden) values
  (
    'basico', 'Plan Básico', 'Pago mensual', 49990,
    array[
      'Hasta 10 mesas',
      '1 usuario administrador',
      'Comandas a cocina y barra por estación',
      'Insumos y recetas con costo por plato',
      'Adiciones y modificadores con precio',
      'Propina separada, cierre de caja y Ticket Z',
      'Funciona sin internet'
    ],
    'mensual', 1
  ),
  (
    'pro', 'Plan Pro', 'Pago mensual', 89990,
    array[
      'Todo lo del Plan Básico',
      'Mesas ilimitadas y plano del salón interactivo',
      'Varios usuarios: meseros y cajeros con su PIN',
      'Utilidad neta y rentabilidad',
      'Registro de gastos',
      'Exportación de reportes a Excel y PDF',
      'Valoración de inventario'
    ],
    'mensual', 2
  )
on conflict (id) do nothing;

-- Anuales: 2 meses gratis, mismas características
insert into public.planes (id, nombre, descripcion, precio_cop, caracteristicas, ciclo, orden)
select p.id || '_anual', p.nombre || ' Anual', 'Pago anual · 2 meses gratis', a.precio_cop, p.caracteristicas, 'anual', p.orden + 10
from public.planes p
join (values ('basico', 499900), ('pro', 899900)) as a (id, precio_cop) on a.id = p.id
on conflict (id) do nothing;

/* ---------- Entrega automática (solo wompi-webhook, con service_role) ---------- */
-- Usuario y negocio asociados a un correo. SECURITY DEFINER para leer auth.users.
create or replace function public.provision_buscar_cuenta(p_email text)
returns table (usuario_id uuid, negocio_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.raw_app_meta_data ->> 'business_id'
  from auth.users u
  where u.email = lower(trim(p_email))
  limit 1;
$$;

-- Crea el negocio igual que admin_create_negocio: configuracion vacía, la app la completa al vincularse
create or replace function public.provision_crear_negocio(p_id text, p_nombre text, p_telefono text, p_plan text, p_dias integer)
returns timestamptz
language sql
set search_path = ''
as $$
  insert into public.negocios (id, nombre, telefono, activo, plan, fecha_vencimiento)
  values (p_id, p_nombre, p_telefono, true, p_plan, now() + make_interval(days => p_dias))
  returning fecha_vencimiento;
$$;

-- Renueva: activo = true y suma los días comprados desde hoy o desde el vencimiento, lo que sea posterior.
-- Si cambia de plan, el saldo vigente se convierte según el precio mensual de cada plan:
--   Básico con 15 días → Pro: 15 × 49.990 / 89.990 ≈ 8,3 días de Pro + los días comprados.
create or replace function public.provision_renovar_negocio(p_id text, p_plan text, p_dias integer)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_plan_actual text;
  v_vence timestamptz;
  v_precio_actual numeric;
  v_precio_nuevo numeric;
  v_saldo interval := interval '0';
begin
  select replace(lower(coalesce(plan, '')), 'á', 'a'), fecha_vencimiento
  into v_plan_actual, v_vence
  from public.negocios
  where id = p_id
  for update;

  if not found then
    return null;
  end if;

  if v_vence > now() then
    v_saldo := v_vence - now();
    select precio_cop into v_precio_actual from public.planes where id = v_plan_actual and ciclo = 'mensual';
    select precio_cop into v_precio_nuevo from public.planes where id = p_plan and ciclo = 'mensual';
    if v_precio_actual > 0 and v_precio_nuevo > 0 and v_precio_actual <> v_precio_nuevo then
      v_saldo := v_saldo * (v_precio_actual / v_precio_nuevo)::double precision;
    end if;
  end if;

  update public.negocios
  set activo = true,
      plan = p_plan,
      fecha_vencimiento = now() + v_saldo + make_interval(days => p_dias)
  where id = p_id
  returning fecha_vencimiento into v_vence;

  return v_vence;
end;
$$;

-- Bloqueo atómico: solo una invocación del webhook procesa cada compra a la vez.
-- El plazo evita que una función caída deje la compra bloqueada para siempre.
create or replace function public.compras_reclamar(p_referencia text, p_segundos integer default 120)
returns boolean
language sql
set search_path = ''
as $$
  with reclamada as (
    update public.compras
    set procesando_hasta = now() + make_interval(secs => p_segundos)
    where referencia = p_referencia
      and estado in ('pagado', 'entregado')
      and (procesando_hasta is null or procesando_hasta < now())
    returning 1
  )
  select exists (select 1 from reclamada);
$$;

create or replace function public.compras_liberar(p_referencia text)
returns void
language sql
set search_path = ''
as $$
  update public.compras set procesando_hasta = null where referencia = p_referencia;
$$;

/* ---------- Ejecución de funciones ---------- */
revoke execute on function private.compras_touch_updated_at() from public, anon, authenticated;
revoke execute on function public.provision_buscar_cuenta(text) from public, anon, authenticated;
revoke execute on function public.provision_crear_negocio(text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.provision_renovar_negocio(text, text, integer) from public, anon, authenticated;
revoke execute on function public.compras_reclamar(text, integer) from public, anon, authenticated;
revoke execute on function public.compras_liberar(text) from public, anon, authenticated;
grant execute on function public.provision_buscar_cuenta(text) to service_role;
grant execute on function public.provision_crear_negocio(text, text, text, text, integer) to service_role;
grant execute on function public.provision_renovar_negocio(text, text, integer) to service_role;
grant execute on function public.compras_reclamar(text, integer) to service_role;
grant execute on function public.compras_liberar(text) to service_role;

/* ---------- Barrido de entregas pendientes ---------- */
-- Cada 10 minutos reintenta correos y alertas que no salieron (p. ej. Resend caído) durante 3 días.
-- El secreto vive en Vault, no aquí. Antes de aplicar esta migración:
--   select vault.create_secret('<valor de BARRIDO_SECRET de NexoPos>', 'barrido_secret');
create extension if not exists pg_net;

select cron.schedule(
  'nexopos-reintentar-entregas',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://voesyutyotonbktndrum.supabase.co/functions/v1/wompi-webhook?barrido=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-barrido-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'barrido_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (
    select 1 from public.compras
    where estado in ('pagado', 'entregado')
      and pagado_at > now() - interval '3 days'
      and (cliente_notificado_at is null or alerta_enviada_at is null)
  );
  $$
);
