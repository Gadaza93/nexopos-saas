// admin-crear-negocio
// «Nuevo negocio» del panel SuperAdmin (admin.js): crea la fila de negocios y la cuenta de la terminal.
//   POST { p_id, p_nombre, p_email, p_password, p_plan, p_dias_vigencia }  (Authorization: Bearer <sesión del superadmin>)
// Reemplaza a la RPC admin_create_negocio, que recibía la contraseña como argumento de una función SQL (podía quedar
// en los registros de PostgREST/Postgres) y escribía directo en auth.users. Aquí la contraseña solo viaja por HTTPS
// hasta el servicio de autenticación (auth.admin.createUser), que la guarda con su propio hash.
// Seguridad:
//   - Solo una sesión con app_metadata.role = 'superadmin' (validada con auth.getUser, no leyendo el JWT a mano).
//   - La cuenta nace con app_metadata.must_change_password = true (puesta aquí; ver el paso 3 más abajo).
//   - Si la cuenta no se puede crear, se borra el negocio recién creado: no quedan negocios sin cuenta.
// Los errores responden 200 con { ok: false, error: { code, message } } para que el panel muestre el mensaje.
// Se publica con verify_jwt = false: la sesión se valida aquí dentro.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, getSecretKey(), { auth: { persistSession: false, autoRefreshToken: false } });

function getSecretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const first = Object.values(keys)[0];
    if (typeof first === 'string') return first;
  } catch (_) { /* proyecto con claves legacy */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fallo = (code: string, message: string) => json({ ok: false, error: { code, message } });

// Mismas reglas que buildCreatePayload en admin.js
const NEGOCIO_ID_RE = /^[a-z0-9_]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLANES = ['basico', 'pro'];

type Payload = { p_id: string; p_nombre: string; p_email: string; p_password: string; p_plan: string; p_dias_vigencia: number };

function validar(body: Record<string, unknown>): Payload | string {
  const p_id = String(body.p_id ?? '').trim().toLowerCase();
  const p_nombre = String(body.p_nombre ?? '').trim();
  const p_email = String(body.p_email ?? '').trim().toLowerCase();
  const p_password = String(body.p_password ?? '');
  const p_plan = String(body.p_plan ?? '').trim().toLowerCase();
  const p_dias_vigencia = Number(body.p_dias_vigencia);
  if (p_nombre.length < 2) return 'El nombre del negocio es obligatorio.';
  if (!NEGOCIO_ID_RE.test(p_id)) return 'El ID debe tener entre 3 y 40 caracteres: minúsculas, números o guion bajo.';
  if (!EMAIL_RE.test(p_email)) return 'El correo no es válido.';
  if (p_password.length < 8 || /\s/.test(p_password)) return 'La contraseña debe tener al menos 8 caracteres y sin espacios.';
  if (!PLANES.includes(p_plan)) return 'El plan no es válido.';
  if (!Number.isInteger(p_dias_vigencia) || p_dias_vigencia < 1 || p_dias_vigencia > 3650) return 'Los días de vigencia deben ser un entero entre 1 y 3650.';
  return { p_id, p_nombre, p_email, p_password, p_plan, p_dias_vigencia };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: { code: '405', message: 'Método no permitido' } }, 405);

  // 1. Solo el SuperAdmin
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return fallo('42501', 'No autorizado: inicia sesión como SuperAdmin.');
  const { data: quien, error: authError } = await supabase.auth.getUser(token);
  if (authError || quien?.user?.app_metadata?.role !== 'superadmin') return fallo('42501', 'No autorizado: solo el SuperAdmin puede crear negocios.');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return fallo('22023', 'Solicitud no válida.'); }
  const datos = validar(body ?? {});
  if (typeof datos === 'string') return fallo('22023', datos);

  // 2. El negocio (la llave primaria evita IDs repetidos)
  const vence = new Date(Date.now() + datos.p_dias_vigencia * 864e5).toISOString();
  const { error: negocioError } = await supabase.from('negocios').insert({ id: datos.p_id, nombre: datos.p_nombre, activo: true, plan: datos.p_plan, fecha_vencimiento: vence });
  if (negocioError) {
    if (negocioError.code === '23505') return fallo('23505', `El ID de negocio "${datos.p_id}" ya está en uso.`);
    console.error('negocios.insert', negocioError);
    return fallo(negocioError.code ?? 'P0001', negocioError.message);
  }

  // 3. La cuenta de la terminal: business_id y contraseña temporal obligatoria en app_metadata. La marca va explícita:
  // createUser inserta la cuenta y escribe app_metadata después, así que el trigger marcar_contrasena_temporal
  // (BEFORE INSERT) no ve el business_id y no la pondría.
  const { error: userError } = await supabase.auth.admin.createUser({
    email: datos.p_email,
    password: datos.p_password,
    email_confirm: true,
    app_metadata: { business_id: datos.p_id, must_change_password: true },
    user_metadata: { nombre: datos.p_nombre },
  });
  if (userError) {
    await supabase.from('negocios').delete().eq('id', datos.p_id);
    if (/already|registered|exists/i.test(userError.message)) return fallo('23505', `El correo "${datos.p_email}" ya está registrado con otro negocio.`);
    console.error('auth.createUser', userError.message);
    return fallo('P0001', userError.message);
  }

  return json({ ok: true, data: { success: true, id: datos.p_id, nombre: datos.p_nombre, email: datos.p_email } });
});
