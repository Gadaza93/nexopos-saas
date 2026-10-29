-- NexoPos · Esquema base de Supabase (proyecto Nexopos-saas)
-- Equivale al esquema del POS de NexoBar al 29-10-2026 (tablas, RLS, triggers de stock, funciones de SuperAdmin,
-- contraseña temporal, recuperación de acceso y vencimiento de licencias), con estos cambios:
--   · business_id es obligatorio y por defecto toma el negocio de la sesión (antes 'nexobar_default').
--   · Las cajas (rol authenticated) reciben solo los permisos que usan; anon no recibe nada.
--   · Las funciones internas (triggers, cálculos, tarea diaria) viven en el esquema private, fuera de la API.
--   · ventas_cantidades ignora los platos preparados (tipo 'preparado'): no tienen stock propio, se descuentan sus insumos.
--   · No incluye planes/compras (pagos Wompi del sitio comercial de NexoBar).
-- Toda tabla nueva con business_id debe agregarse a public.admin_delete_negocio.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Las funciones nuevas no quedan ejecutables por todos (cada una recibe su grant explícito)
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

/* ---------- Sesión ---------- */
-- Negocio de la sesión, leído SOLO de app_metadata (lo asigna el servidor). Con contraseña temporal pendiente devuelve '' (sin acceso a datos).
create or replace function public.get_business_id()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(auth.jwt() -> 'app_metadata' ->> 'must_change_password', '') = 'true' then ''
    else coalesce(auth.jwt() -> 'app_metadata' ->> 'business_id', '')
  end;
$$;

-- Reloj del servidor para la licencia (la hora del equipo se puede cambiar)
create or replace function public.hora_servidor()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select now() $$;

/* ---------- Tablas ---------- */
create table public.negocios (
  id text primary key,
  nombre text not null,
  telefono text,
  configuracion jsonb default '{}'::jsonb,
  activo boolean default true,
  plan text default 'pro',
  fecha_vencimiento timestamptz default (now() + interval '30 days'),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.productos (
  id text primary key,
  business_id text not null default public.get_business_id(),
  nombre text not null,
  precio numeric not null default 0,
  costo numeric default 0,
  stock numeric not null default 0,
  min_stock numeric default 5,
  categoria text default 'General',
  activo boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.ventas (
  id text primary key,
  business_id text not null default public.get_business_id(),
  total numeric not null default 0,
  items jsonb not null default '[]'::jsonb,
  metodos_pago jsonb not null default '[]'::jsonb,
  cajero text,
  fecha timestamptz default now(),
  order_id text,
  method text,
  payments jsonb default '[]'::jsonb,
  customer jsonb default '{}'::jsonb,
  cashier text,
  shift_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.pedidos_activos (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default public.get_business_id(),
  mesa_id text,
  nombre_mesa text,
  cliente text,
  items jsonb default '[]'::jsonb,
  subtotal numeric default 0,
  total numeric default 0,
  estado text default 'abierto',
  tipo text default 'mesa',
  meta jsonb, -- el pedido completo (comandas, notas, abonos…); con esta columna la app usa el modo tabla
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.turnos_caja (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default public.get_business_id(),
  usuario_id text,
  monto_apertura numeric default 0,
  monto_cierre numeric,
  total_efectivo numeric default 0,
  total_ventas numeric default 0,
  diferencia numeric default 0,
  estado text default 'abierto',
  fecha_apertura timestamptz default now(),
  fecha_cierre timestamptz,
  created_at timestamptz default now()
);

create table public.gastos (
  id text primary key,
  business_id text not null default public.get_business_id(),
  descripcion text,
  monto numeric default 0,
  categoria text,
  metodo_pago text,
  proveedor_id text,
  comprobante text,
  fecha timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.mermas (
  id text primary key,
  business_id text not null default public.get_business_id(),
  producto_id text,
  producto_nombre text,
  cantidad numeric not null default 1,
  motivo text not null,
  observacion text,
  fecha timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.proveedores (
  id text primary key,
  business_id text not null default public.get_business_id(),
  nombre text,
  contacto text,
  telefono text,
  email text,
  direccion text,
  notas text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Stock por movimientos: las cajas suman y restan, nunca escriben el stock absoluto
create table public.movimientos_stock (
  id text primary key,
  business_id text not null default public.get_business_id(),
  producto_id text not null,
  delta numeric not null check (delta <> 0),
  motivo text not null default 'ajuste',
  created_at timestamptz not null default now()
);

-- Códigos de recuperación de la contraseña maestra (solo los usa la Edge Function recuperar-acceso con service_role)
create table public.recuperaciones_acceso (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  user_id uuid not null,
  business_id text not null,
  codigo_hash text not null,
  intentos smallint not null default 0,
  expira_at timestamptz not null,
  usado_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);

create index productos_negocio_idx on public.productos (business_id, id);
create index ventas_negocio_idx on public.ventas (business_id, id);
create index pedidos_activos_negocio_idx on public.pedidos_activos (business_id);
create index turnos_caja_negocio_idx on public.turnos_caja (business_id, estado, created_at desc);
create index gastos_negocio_idx on public.gastos (business_id, id);
create index mermas_negocio_idx on public.mermas (business_id, id);
create index proveedores_negocio_idx on public.proveedores (business_id, id);
create index movimientos_stock_negocio_idx on public.movimientos_stock (business_id, created_at desc);
create index recuperaciones_acceso_email_idx on public.recuperaciones_acceso (email, created_at desc);

/* ---------- RLS: cada caja ve y escribe solo su negocio ---------- */
alter table public.negocios enable row level security;
alter table public.productos enable row level security;
alter table public.ventas enable row level security;
alter table public.pedidos_activos enable row level security;
alter table public.turnos_caja enable row level security;
alter table public.gastos enable row level security;
alter table public.mermas enable row level security;
alter table public.proveedores enable row level security;
alter table public.movimientos_stock enable row level security;
alter table public.recuperaciones_acceso enable row level security; -- sin políticas: solo service_role

create policy negocios_select on public.negocios for select to authenticated
  using (id = (select public.get_business_id()));
create policy negocios_update on public.negocios for update to authenticated
  using (id = (select public.get_business_id())) with check (id = (select public.get_business_id()));

create policy productos_negocio on public.productos for all to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy ventas_negocio on public.ventas for all to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy pedidos_activos_negocio on public.pedidos_activos for all to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy turnos_caja_negocio on public.turnos_caja for all to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy gastos_negocio on public.gastos for all to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy mermas_negocio on public.mermas for all to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy proveedores_negocio on public.proveedores for all to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy movimientos_stock_select on public.movimientos_stock for select to authenticated
  using (business_id = (select public.get_business_id()));
create policy movimientos_stock_insert on public.movimientos_stock for insert to authenticated
  with check (business_id = (select public.get_business_id()));

/* ---------- Permisos: solo lo que la app usa ---------- */
revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on public.productos, public.ventas, public.pedidos_activos, public.turnos_caja,
  public.gastos, public.mermas, public.proveedores to authenticated;
-- negocios: las cajas no crean filas (las crea admin_create_negocio) y solo cambian nombre y configuración;
-- así un negocio no puede tocar activo, plan ni fecha_vencimiento
grant select on public.negocios to authenticated;
grant update (nombre, configuracion) on public.negocios to authenticated;
grant select, insert on public.movimientos_stock to authenticated;

/* ---------- Stock por movimientos (triggers) ---------- */
-- Cantidades por producto de los ítems de una venta (productId o id; qty no numérica = 0).
-- Los platos preparados no tienen stock propio: se excluyen.
create or replace function private.ventas_cantidades(p_items jsonb)
returns table (producto_id text, cantidad numeric)
language sql
immutable
set search_path = ''
as $$
  select coalesce(it ->> 'productId', it ->> 'id'),
         sum(case when jsonb_typeof(it -> 'qty') = 'number' then (it ->> 'qty')::numeric
                  when (it ->> 'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it ->> 'qty')::numeric
                  else 0 end)
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as it
  where coalesce(it ->> 'productId', it ->> 'id') is not null
    and coalesce(it ->> 'tipo', '') <> 'preparado'
  group by 1;
$$;

-- Venta nueva o con ítems editados: un movimiento por producto con la diferencia de cantidades
create or replace function private.ventas_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.movimientos_stock (id, business_id, producto_id, delta, motivo)
  select 'venta:' || new.id || ':' || d.producto_id || ':' || gen_random_uuid(),
         new.business_id, d.producto_id, d.delta,
         case when tg_op = 'INSERT' then 'venta' else 'venta editada' end
  from (
    select coalesce(n.producto_id, o.producto_id) as producto_id,
           coalesce(o.cantidad, 0) - coalesce(n.cantidad, 0) as delta
    from private.ventas_cantidades(new.items) n
    full join private.ventas_cantidades(case when tg_op = 'UPDATE' then old.items end) o
      on o.producto_id = n.producto_id
  ) d
  where d.delta <> 0
    and exists (select 1 from public.productos p where p.id = d.producto_id and p.business_id = new.business_id);
  return null;
end;
$$;

create or replace function private.movimientos_stock_aplicar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.productos
     set stock = stock + new.delta, updated_at = now()
   where id = new.producto_id and business_id = new.business_id;
  return null;
end;
$$;

create trigger ventas_stock after insert or update on public.ventas
  for each row execute function private.ventas_stock();
create trigger movimientos_stock_aplicar after insert on public.movimientos_stock
  for each row execute function private.movimientos_stock_aplicar();

/* ---------- Plan Básico: máximo 10 mesas en el plano ---------- */
create or replace function private.negocios_limite_mesas()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_max constant int := 10; v_nuevo int; v_anterior int;
begin
  if lower(coalesce(new.plan, '')) not in ('basico', 'básico') then return new; end if;
  v_nuevo := case when jsonb_typeof(new.configuracion -> 'floorPlan' -> 'tables') = 'array' then jsonb_array_length(new.configuracion -> 'floorPlan' -> 'tables') else 0 end;
  v_anterior := case when jsonb_typeof(old.configuracion -> 'floorPlan' -> 'tables') = 'array' then jsonb_array_length(old.configuracion -> 'floorPlan' -> 'tables') else 0 end;
  if v_nuevo > v_max and v_nuevo > v_anterior then
    if old.configuracion ? 'floorPlan' then new.configuracion := jsonb_set(new.configuracion, '{floorPlan}', old.configuracion -> 'floorPlan');
    else new.configuracion := new.configuracion - 'floorPlan'; end if;
  end if;
  return new;
end;
$$;
create trigger negocios_limite_mesas before update on public.negocios
  for each row execute function private.negocios_limite_mesas();

/* ---------- Contraseña temporal obligatoria ---------- */
-- Toda cuenta nueva de un negocio (no superadmin) nace con must_change_password: sin cambiarla no ve datos (get_business_id = '')
create or replace function private.marcar_contrasena_temporal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.raw_app_meta_data, '{}'::jsonb) ? 'business_id'
     and coalesce(new.raw_app_meta_data ->> 'role', '') <> 'superadmin' then
    new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('must_change_password', true);
  end if;
  return new;
end;
$$;
create trigger marcar_contrasena_temporal before insert on auth.users
  for each row execute function private.marcar_contrasena_temporal();

-- La cuenta quita su propia marca después de cambiar la contraseña
create or replace function public.marcar_contrasena_cambiada()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update auth.users
     set raw_app_meta_data = raw_app_meta_data - 'must_change_password'
   where id = auth.uid();
  return found;
end;
$$;

/* ---------- SuperAdmin (admin.html) ---------- */
-- Cada función comprueba el rol en el servidor: la verificación de admin.js es solo de interfaz
create or replace function public.admin_get_all_negocios()
returns table (id text, nombre text, activo boolean, plan text, fecha_vencimiento timestamptz, total_productos bigint, total_ventas bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'superadmin' then
    raise exception 'Acceso no autorizado' using errcode = '42501';
  end if;
  return query
  select n.id, n.nombre, coalesce(n.activo, true), coalesce(n.plan, 'pro'), n.fecha_vencimiento,
         (select count(*) from public.productos p where p.business_id = n.id),
         (select count(*) from public.ventas v where v.business_id = n.id)
  from public.negocios n
  order by n.id;
end;
$$;

create or replace function public.admin_update_negocio_status(p_negocio_id text, p_activo boolean, p_plan text default null, p_extender_dias integer default 0)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'superadmin' then
    raise exception 'Acceso no autorizado' using errcode = '42501';
  end if;
  update public.negocios
     set activo = p_activo,
         plan = coalesce(p_plan, plan),
         fecha_vencimiento = case when p_extender_dias > 0
           then coalesce(fecha_vencimiento, now()) + make_interval(days => p_extender_dias)
           else fecha_vencimiento end
   where id = p_negocio_id;
end;
$$;

create or replace function public.admin_create_negocio(p_id text, p_nombre text, p_email text, p_password text, p_plan text default 'pro', p_dias_vigencia integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := gen_random_uuid();
  v_id text := lower(trim(p_id));
  v_email text := lower(trim(p_email));
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'superadmin' then
    raise exception 'Acceso no autorizado: solo el SuperAdmin puede crear negocios' using errcode = '42501';
  end if;
  if v_id = '' or v_email = '' or trim(p_nombre) = '' or length(p_password) < 6 then
    raise exception 'Datos incompletos o contraseña menor a 6 caracteres';
  end if;
  if exists (select 1 from public.negocios where id = v_id) then
    raise exception 'El ID de negocio "%" ya está en uso', v_id;
  end if;
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'El correo "%" ya está registrado con otro negocio', v_email;
  end if;

  insert into public.negocios (id, nombre, activo, plan, fecha_vencimiento)
  values (v_id, trim(p_nombre), true, coalesce(nullif(trim(p_plan), ''), 'pro'), now() + make_interval(days => p_dias_vigencia));

  -- business_id va en app_metadata (el usuario no puede editarlo); el trigger marca la contraseña como temporal
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'business_id', v_id),
    jsonb_build_object('nombre', trim(p_nombre)), now(), now(),
    '', '', '', ''
  );
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_uid, v_uid::text, 'email',
          jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true), now(), now(), now());

  return jsonb_build_object('success', true, 'id', v_id, 'nombre', trim(p_nombre), 'email', v_email);
end;
$$;

-- Borra un negocio completo en una transacción. Las tablas hijas no tienen llave foránea:
-- toda tabla nueva con business_id debe agregarse aquí.
create or replace function public.admin_delete_negocio(p_negocio_id text, p_confirmacion text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res jsonb := '{}'::jsonb;
  v_n int;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'superadmin' then
    raise exception 'Acceso no autorizado' using errcode = '42501';
  end if;
  if p_negocio_id is null or trim(p_negocio_id) = '' or p_confirmacion is distinct from p_negocio_id then
    raise exception 'La confirmación no coincide con el ID del negocio' using errcode = '22023';
  end if;
  if not exists (select 1 from public.negocios where id = p_negocio_id) then
    raise exception 'El negocio "%" no existe', p_negocio_id using errcode = 'P0002';
  end if;

  delete from public.pedidos_activos   where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('pedidos_activos', v_n);
  delete from public.ventas            where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('ventas', v_n);
  delete from public.gastos            where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('gastos', v_n);
  delete from public.mermas            where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('mermas', v_n);
  delete from public.turnos_caja       where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('turnos_caja', v_n);
  delete from public.movimientos_stock where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('movimientos_stock', v_n);
  delete from public.productos         where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('productos', v_n);
  delete from public.proveedores       where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('proveedores', v_n);
  delete from public.recuperaciones_acceso where business_id = p_negocio_id;
  delete from auth.users
   where raw_app_meta_data ->> 'business_id' = p_negocio_id
     and coalesce(raw_app_meta_data ->> 'role', '') <> 'superadmin';
  get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('cuentas', v_n);
  delete from public.negocios where id = p_negocio_id;

  return v_res || jsonb_build_object('id', p_negocio_id);
end;
$$;

/* ---------- Recuperación de acceso (Edge Function recuperar-acceso, con service_role) ---------- */
create or replace function public.recuperacion_buscar_cuenta(p_email text)
returns table (user_id uuid, business_id text, negocio text, activo boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, n.id, n.nombre, coalesce(n.activo, true)
  from auth.users u
  join public.negocios n on n.id = u.raw_app_meta_data ->> 'business_id'
  where u.email = lower(trim(p_email))
  limit 1;
$$;

/* ---------- Licencias vencidas ---------- */
-- Suspende (activo = false) los negocios vencidos hace más de 3 días
create or replace function private.suspender_negocios_vencidos()
returns integer
language sql
security definer
set search_path = ''
as $$
  with suspendidos as (
    update public.negocios
       set activo = false
     where activo is not false
       and fecha_vencimiento is not null
       and fecha_vencimiento < now() - interval '3 days'
    returning 1
  )
  select count(*)::int from suspendidos;
$$;
-- Todos los días a las 10:00 a. m. de Colombia (15:00 UTC)
select cron.schedule('nexopos-suspender-vencidos', '0 15 * * *', $$ select private.suspender_negocios_vencidos(); $$);

/* ---------- Ejecución de funciones ---------- */
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.get_business_id() to authenticated, service_role; -- también es el valor por defecto de business_id
grant execute on function public.hora_servidor() to authenticated;
grant execute on function public.marcar_contrasena_cambiada() to authenticated;
grant execute on function public.admin_get_all_negocios() to authenticated;
grant execute on function public.admin_update_negocio_status(text, boolean, text, integer) to authenticated;
grant execute on function public.admin_create_negocio(text, text, text, text, text, integer) to authenticated;
grant execute on function public.admin_delete_negocio(text, text) to authenticated;
revoke execute on function public.recuperacion_buscar_cuenta(text) from authenticated;
grant execute on function public.recuperacion_buscar_cuenta(text) to service_role;

/* ---------- Tiempo real: tablas que escucha setupRealtime ---------- */
alter publication supabase_realtime add table public.negocios, public.productos, public.ventas, public.turnos_caja, public.pedidos_activos;
