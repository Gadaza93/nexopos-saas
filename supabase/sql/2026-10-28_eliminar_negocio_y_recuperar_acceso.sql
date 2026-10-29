-- NexoPos · Supabase · 28-10-2026
-- Pegar completo en el SQL Editor del proyecto y ejecutar (Run). Se puede volver a ejecutar sin problema.

-- 1. Eliminar un negocio desde el panel superadmin, en una sola transacción.
-- Las tablas hijas se enlazan por business_id (texto, sin llave foránea): se borran explícitamente.
-- Las cuentas de acceso del negocio (auth.users con app_metadata.business_id) se borran también; sus sesiones,
-- identidades y tokens caen en cascada. p_confirmacion debe ser exactamente el ID: la confirmación se valida aquí.
-- (La tabla recuperaciones_acceso se crea primero porque la función la limpia.)

-- 2. Recuperación de la contraseña maestra con código por correo (Edge Function recuperar-acceso).
-- Solo el servidor (service_role) lee y escribe: RLS activo y sin políticas para anon ni authenticated.
create table if not exists public.recuperaciones_acceso (
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
create index if not exists recuperaciones_acceso_email_idx on public.recuperaciones_acceso (email, created_at desc);
alter table public.recuperaciones_acceso enable row level security;
revoke all on public.recuperaciones_acceso from anon, authenticated;

create or replace function public.admin_delete_negocio(p_negocio_id text, p_confirmacion text)
returns jsonb
language plpgsql
security definer
set search_path = public
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

  delete from public.pedidos_activos where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('pedidos_activos', v_n);
  delete from public.ventas          where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('ventas', v_n);
  delete from public.gastos          where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('gastos', v_n);
  delete from public.mermas          where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('mermas', v_n);
  delete from public.turnos_caja     where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('turnos_caja', v_n);
  delete from public.productos       where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('productos', v_n);
  delete from public.proveedores     where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('proveedores', v_n);
  delete from public.recuperaciones_acceso where business_id = p_negocio_id;
  delete from auth.users
   where raw_app_meta_data ->> 'business_id' = p_negocio_id
     and coalesce(raw_app_meta_data ->> 'role', '') <> 'superadmin';
  get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('cuentas', v_n);
  delete from public.negocios where id = p_negocio_id;

  return v_res || jsonb_build_object('id', p_negocio_id);
end;
$$;

-- Cuenta de acceso de un correo con su negocio (la Edge Function no puede consultar auth.users por PostgREST)
create or replace function public.recuperacion_buscar_cuenta(p_email text)
returns table(user_id uuid, business_id text, negocio text, activo boolean)
language sql
security definer
set search_path = public
as $$
  select u.id, n.id, n.nombre, coalesce(n.activo, true)
  from auth.users u
  join public.negocios n on n.id = u.raw_app_meta_data ->> 'business_id'
  where u.email = lower(trim(p_email))
  limit 1;
$$;

revoke all on function public.admin_delete_negocio(text, text) from public, anon;
grant execute on function public.admin_delete_negocio(text, text) to authenticated;
revoke all on function public.recuperacion_buscar_cuenta(text) from public, anon, authenticated;
grant execute on function public.recuperacion_buscar_cuenta(text) to service_role;
