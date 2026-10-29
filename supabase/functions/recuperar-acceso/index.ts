// recuperar-acceso
// Recuperación de la contraseña maestra de un negocio NexoPos con un código de 6 dígitos enviado por correo (Resend).
//   POST { accion: 'solicitar', email }                      → envía el código (vence en 15 minutos)
//   POST { accion: 'confirmar', email, codigo, password }    → cambia la contraseña si el código es válido
// Seguridad:
//   - 'solicitar' responde SIEMPRE lo mismo, exista o no el correo: nadie puede averiguar qué correos son clientes.
//   - Solo se envía a cuentas cuyo negocio está activo; máximo 3 códigos por correo por hora.
//   - En la base solo queda el HMAC del código (tabla recuperaciones_acceso, sin acceso para anon ni authenticated).
//   - Cada código admite 5 intentos; al acertar se marca usado junto con los demás códigos abiertos de ese correo.
// Los errores de negocio responden 200 con { ok: false, error } para que la app muestre el mensaje tal cual.
// Se publica con verify_jwt = false (la caja aún no tiene sesión cuando el dueño olvidó la contraseña).
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const CODIGO_MINUTOS = 15;
const MAX_ENVIOS_HORA = 3;
const MAX_INTENTOS = 5;
const MIN_PASSWORD = 8;
const REMITENTE = Deno.env.get('RECUPERACION_EMAIL_FROM') ?? 'NexoPos · NetxPremium <soporte@netxpremium.com>';
const MENSAJE_ENVIADO = 'Si el correo está registrado en un negocio activo, te enviamos un código de 6 dígitos. Revisa también la carpeta de spam.';

const secretKey = getSecretKey();
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, secretKey, { auth: { persistSession: false } });

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
const fallo = (error: string) => json({ ok: false, error });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizarEmail = (email: unknown) => String(email ?? '').trim().toLowerCase();

// HMAC-SHA256 del código ligado a su fila: el hash de un código no sirve para otra solicitud
async function hashCodigo(id: string, codigo: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}:${codigo}`));
  return Array.from(new Uint8Array(firma), (b) => b.toString(16).padStart(2, '0')).join('');
}
function igualesSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function codigoAleatorio(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, '0');
}
function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

type Cuenta = { user_id: string; business_id: string; negocio: string | null; activo: boolean };
async function buscarCuenta(email: string): Promise<Cuenta | null> {
  const { data, error } = await supabase.rpc('recuperacion_buscar_cuenta', { p_email: email });
  if (error) throw new Error(`recuperacion_buscar_cuenta: ${error.message}`);
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

async function enviarCodigo(to: string, negocio: string, codigo: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: REMITENTE,
      to: [to],
      subject: `${codigo} es tu código para recuperar el acceso a NexoPos`,
      html: `<div style="font-family:sans-serif;font-size:15px;color:#1f2937;max-width:480px">
        <h2 style="margin:0 0 12px">Recupera el acceso a NexoPos</h2>
        <p>Recibimos una solicitud para cambiar la contraseña maestra de <strong>${escapeHtml(negocio)}</strong>.</p>
        <p>Tu código es:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:8px 0 16px">${codigo}</p>
        <p>Escríbelo en la caja junto con tu nueva contraseña. Vence en <strong>${CODIGO_MINUTOS} minutos</strong> y sirve una sola vez.</p>
        <p style="color:#64748b;font-size:13px">Si no pediste este cambio, ignora este correo: tu contraseña actual sigue funcionando.</p>
        <p style="color:#64748b;font-size:13px">¿Dudas? Escríbenos a soporte@netxpremium.com o al WhatsApp +57 305 248 4278.<br>— Equipo NetxPremium</p>
      </div>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function solicitar(email: string, ip: string | null): Promise<Response> {
  if (!EMAIL_RE.test(email)) return fallo('Escribe un correo electrónico válido.');
  const cuenta = await buscarCuenta(email);
  if (!cuenta || !cuenta.activo) return json({ ok: true, mensaje: MENSAJE_ENVIADO }); // misma respuesta: no se revela nada

  const haceUnaHora = new Date(Date.now() - 3600_000).toISOString();
  const { count, error: countError } = await supabase.from('recuperaciones_acceso').select('id', { count: 'exact', head: true }).eq('email', email).gte('created_at', haceUnaHora);
  if (countError) throw new Error(`recuperaciones_acceso.count: ${countError.message}`);
  if ((count ?? 0) >= MAX_ENVIOS_HORA) return json({ ok: true, mensaje: MENSAJE_ENVIADO });

  const id = crypto.randomUUID(), codigo = codigoAleatorio();
  const { error } = await supabase.from('recuperaciones_acceso').insert({
    id, email, user_id: cuenta.user_id, business_id: cuenta.business_id, codigo_hash: await hashCodigo(id, codigo),
    expira_at: new Date(Date.now() + CODIGO_MINUTOS * 60_000).toISOString(), ip,
  });
  if (error) throw new Error(`recuperaciones_acceso.insert: ${error.message}`);

  try {
    await enviarCodigo(email, cuenta.negocio || cuenta.business_id, codigo);
  } catch (err) {
    console.error('correo', err);
    await supabase.from('recuperaciones_acceso').delete().eq('id', id); // no cuenta para el límite
    return fallo('No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos.');
  }
  return json({ ok: true, mensaje: MENSAJE_ENVIADO });
}

async function confirmar(email: string, codigo: string, password: string): Promise<Response> {
  if (!EMAIL_RE.test(email)) return fallo('Escribe un correo electrónico válido.');
  if (!/^\d{6}$/.test(codigo)) return fallo('El código tiene 6 números.');
  if (password.length < MIN_PASSWORD) return fallo(`La nueva contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);

  const { data: fila, error } = await supabase.from('recuperaciones_acceso')
    .select('id, user_id, business_id, codigo_hash, intentos, expira_at')
    .eq('email', email).is('usado_at', null).gt('expira_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`recuperaciones_acceso.select: ${error.message}`);
  if (!fila) return fallo('El código venció o no es válido. Pide uno nuevo.');
  if (fila.intentos >= MAX_INTENTOS) return fallo('Superaste los intentos permitidos para este código. Pide uno nuevo.');

  if (!igualesSeguro(await hashCodigo(fila.id, codigo), fila.codigo_hash)) {
    const intentos = fila.intentos + 1;
    await supabase.from('recuperaciones_acceso').update({ intentos }).eq('id', fila.id);
    const quedan = MAX_INTENTOS - intentos;
    return fallo(quedan > 0 ? `Código incorrecto. Te ${quedan === 1 ? 'queda 1 intento' : `quedan ${quedan} intentos`}.` : 'Código incorrecto. Pide uno nuevo.');
  }

  const cuenta = await buscarCuenta(email); // el negocio pudo suspenderse o la cuenta cambiar mientras tanto
  if (!cuenta || !cuenta.activo || cuenta.user_id !== fila.user_id) return fallo('Esta cuenta no está activa. Comunícate con soporte.');

  // Elegir contraseña con el código del correo también cuenta como cambiar la temporal (cambio obligatorio)
  const { error: authError } = await supabase.auth.admin.updateUserById(fila.user_id, { password, app_metadata: { must_change_password: false } });
  if (authError) {
    console.error('updateUserById', authError);
    return fallo(/weak|short|password/i.test(authError.message) ? 'Elige una contraseña más segura (letras y números, al menos 8 caracteres).' : 'No se pudo cambiar la contraseña. Intenta de nuevo.');
  }
  await supabase.from('recuperaciones_acceso').update({ usado_at: new Date().toISOString() }).eq('email', email).is('usado_at', null);
  return json({ ok: true, mensaje: 'Contraseña actualizada. Ya puedes vincular la caja con tu nueva contraseña.' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_) {
    return fallo('Solicitud no válida.');
  }

  const email = normalizarEmail(body.email);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  try {
    if (body.accion === 'solicitar') return await solicitar(email, ip);
    if (body.accion === 'confirmar') return await confirmar(email, String(body.codigo ?? '').trim(), String(body.password ?? ''));
    return fallo('Acción no válida.');
  } catch (err) {
    console.error('recuperar-acceso', err);
    return json({ ok: false, error: 'Ocurrió un error en el servidor. Intenta de nuevo en unos minutos.' }, 500);
  }
});
