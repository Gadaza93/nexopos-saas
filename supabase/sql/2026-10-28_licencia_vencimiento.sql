-- NexoPos · Vencimiento de la licencia (28-10-2026)
-- Pegar completo en el SQL Editor de Supabase. Se puede ejecutar varias veces.
--
-- 1. hora_servidor(): la app la consulta en cada descarga para medir el vencimiento con la hora real y detectar
--    un reloj del equipo atrasado (app.js → licenseClock).
-- 2. suspender_negocios_vencidos(): pone activo = false a los negocios vencidos hace más de 3 días (gracia).
--    pg_cron la ejecuta todos los días a las 10:00 a. m. de Colombia (15:00 UTC), con los bares cerrados.
--    Renovar (webhook de Wompi → provision_renovar_negocio) vuelve a poner activo = true.

-- 1. Hora del servidor
create or replace function public.hora_servidor()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select now() $$;

revoke all on function public.hora_servidor() from public, anon;
grant execute on function public.hora_servidor() to authenticated;

-- 2. Suspensión automática de vencidos (3 días de gracia). Devuelve cuántos negocios suspendió.
create or replace function public.suspender_negocios_vencidos()
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

revoke all on function public.suspender_negocios_vencidos() from public, anon, authenticated;

-- Con el mismo nombre, cron.schedule reemplaza la tarea si ya existe
select cron.schedule(
  'nexopos-suspender-vencidos',
  '0 15 * * *',
  $$ select public.suspender_negocios_vencidos(); $$
);

-- Verificación (solo lectura): la tarea programada y los negocios que suspendería hoy
-- select jobname, schedule, active from cron.job where jobname = 'nexopos-suspender-vencidos';
-- select id, nombre, fecha_vencimiento from public.negocios
--   where activo is not false and fecha_vencimiento < now() - interval '3 days';
