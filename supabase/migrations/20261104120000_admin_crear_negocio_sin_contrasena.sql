-- NexoPos · «Nuevo negocio» sin contraseña en SQL (04-11-2026)
-- Equivale al paso 12 de NexoBar. Pegar en el SQL Editor DESPUÉS de publicar la Edge Function admin-crear-negocio
-- y el admin.js que la usa (push a main). Se puede ejecutar varias veces.
--
-- admin_create_negocio recibía la contraseña de la terminal como argumento (p_password) y la cifraba dentro de
-- Postgres: el valor podía quedar en los registros de PostgREST/Postgres (por ejemplo, cuando la función fallaba).
-- El panel SuperAdmin ahora usa la Edge Function admin-crear-negocio, que crea la cuenta con auth.admin.createUser
-- (la contraseña solo viaja por HTTPS al servicio de autenticación) y pone must_change_password explícito.
--
-- Solo se quita el permiso de ejecutarla: la función se conserva para poder volver atrás
-- (grant execute on function public.admin_create_negocio(text, text, text, text, text, integer) to authenticated;).

revoke execute on function public.admin_create_negocio(text, text, text, text, text, integer) from public, anon, authenticated;

-- Comprobación: debe devolver false para authenticated y anon
select has_function_privilege('authenticated', 'public.admin_create_negocio(text, text, text, text, text, integer)', 'execute') as authenticated_puede,
       has_function_privilege('anon', 'public.admin_create_negocio(text, text, text, text, text, integer)', 'execute') as anon_puede;
