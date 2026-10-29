-- NexoPos · Cambio obligatorio de la contraseña temporal (29-10-2026)
-- Pegar completo en el SQL Editor de Supabase. Se puede ejecutar varias veces.
--
-- Toda cuenta nueva de un negocio (webhook de Wompi o «Nuevo negocio» del superadmin) nace con
-- app_metadata.must_change_password = true. Mientras la tenga:
--   · get_business_id() devuelve '' → el RLS no le deja leer ni escribir datos del negocio (bloqueo en el servidor).
--   · La app no vincula la caja hasta que el cliente crea su contraseña (app.js → askNewPassword).
-- La marca se quita con marcar_contrasena_cambiada() (la app la llama después de auth.updateUser) o al
-- restablecer la contraseña con el código por correo (Edge Function recuperar-acceso).
-- Las cuentas que ya existen no se marcan.

-- 1. Cuentas nuevas con business_id (no el superadmin): nacen con la marca
create or replace function public.marcar_contrasena_temporal()
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
revoke all on function public.marcar_contrasena_temporal() from public, anon, authenticated;
drop trigger if exists marcar_contrasena_temporal on auth.users;
create trigger marcar_contrasena_temporal before insert on auth.users
  for each row execute function public.marcar_contrasena_temporal();

-- 2. La app la llama después de cambiar la contraseña con auth.updateUser: quita la marca de la propia cuenta
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
revoke all on function public.marcar_contrasena_cambiada() from public, anon;
grant execute on function public.marcar_contrasena_cambiada() to authenticated;

-- 3. Con la marca, la sesión no ve ningún negocio (todas las políticas usan get_business_id)
create or replace function public.get_business_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce(auth.jwt() -> 'app_metadata' ->> 'must_change_password', '') = 'true' then ''
    else coalesce(auth.jwt() -> 'app_metadata' ->> 'business_id', '')
  end;
$$;

-- Verificación (solo lectura)
-- select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
-- select count(*) from auth.users where raw_app_meta_data ->> 'must_change_password' = 'true';
