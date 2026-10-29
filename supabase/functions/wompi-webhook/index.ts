// wompi-webhook (NexoPos)
// Recibe el evento transaction.updated de Wompi de las compras NEXOPOS-… y actualiza la compra.
// El comercio de Wompi es el mismo de NexoBar (una sola URL de eventos), así que el evento llega por dos caminos:
//   · Producción: el webhook de NexoBar verifica la firma de Wompi y reenvía aquí el cuerpo intacto,
//     firmado con HMAC-SHA256 (REENVIO_NEXOPOS_SECRET, compartido solo entre las dos funciones).
//   · Sandbox: la URL de eventos de pruebas de Wompi apunta directo aquí y se verifica con WOMPI_EVENTS_SECRET
//     (llave de pruebas). En producción ese secreto no se configura y las llamadas directas se rechazan.
// Además, un pago APROBADO se confirma consultando la transacción en la API pública de Wompi.
// Cuando el pago queda APROBADO:
//   1. crea el negocio y su cuenta (contraseña temporal) o, si el correo ya tiene cuenta, lo renueva
//      (+30 días el mensual, +365 el anual, activo = true);
//   2. envía al cliente su acceso a https://nexopos.netxpremium.com (o la confirmación de la renovación);
//   3. envía la alerta a NetxPremium.
// Wompi reintenta el evento si la respuesta no es 200, así que cada paso es idempotente.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';

const NEXOPOS_APP_URL = Deno.env.get('NEXOPOS_APP_URL') ?? 'https://nexopos.netxpremium.com';
const PREFIJO_REFERENCIA = 'NEXOPOS-';
const DIAS_POR_CICLO = { mensual: 30, anual: 365 } as const;
const REENVIO_TOLERANCIA_S = 300;
const WOMPI_API = { prod: 'https://production.wompi.co/v1', test: 'https://sandbox.wompi.co/v1' } as Record<string, string>;

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, getSecretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function getSecretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const first = Object.values(keys)[0];
    if (typeof first === 'string') return first;
  } catch (_) { /* proyecto con claves legacy */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hmacHex(secreto: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

// "transaction.amount_in_cents" → data.transaction.amount_in_cents
function valueAt(data: Record<string, unknown>, path: string): string {
  const value = path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    data,
  );
  return value === undefined || value === null ? '' : String(value);
}

// Comparación en tiempo constante: no revela por tiempos cuántos caracteres coinciden
function igualSeguro(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Firma de Wompi (llamada directa del sandbox)
async function firmaWompiValida(event: WompiEvent): Promise<boolean> {
  const secreto = Deno.env.get('WOMPI_EVENTS_SECRET') ?? '';
  const properties = event.signature?.properties ?? [];
  const checksum = event.signature?.checksum ?? '';
  if (!secreto) return false;
  if (!Array.isArray(properties) || !properties.length || typeof checksum !== 'string' || !checksum) return false;
  if (!event.data || typeof event.data !== 'object' || event.timestamp === undefined) return false;

  const concatenado = properties.map((p) => valueAt(event.data, String(p))).join('')
    + String(event.timestamp)
    + secreto;

  return igualSeguro(await sha256Hex(concatenado), checksum.toLowerCase());
}

// Firma del reenvío desde el webhook de NexoBar: HMAC del "timestamp.cuerpo", con 5 minutos de tolerancia
async function firmaReenvioValida(req: Request, cuerpo: string): Promise<boolean> {
  const secreto = Deno.env.get('REENVIO_NEXOPOS_SECRET') ?? '';
  const ts = req.headers.get('x-nexopos-reenvio-ts') ?? '';
  const firma = req.headers.get('x-nexopos-reenvio-firma') ?? '';
  if (!secreto || !/^\d+$/.test(ts) || !firma) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > REENVIO_TOLERANCIA_S) return false;
  return igualSeguro(await hmacHex(secreto, `${ts}.${cuerpo}`), firma.toLowerCase());
}

// Segunda verificación de un pago aprobado: la transacción tal como la reporta la API pública de Wompi
async function confirmarEnWompi(tx: WompiTransaction, ambiente: string | undefined): Promise<'ok' | 'no_coincide' | 'error'> {
  const api = WOMPI_API[ambiente ?? ''] ?? WOMPI_API.prod;
  try {
    const res = await fetch(`${api}/transactions/${encodeURIComponent(tx.id)}`);
    if (!res.ok) return 'error';
    const real = (await res.json())?.data as WompiTransaction | undefined;
    const coincide = real?.status === 'APPROVED' && real.reference === tx.reference
      && real.amount_in_cents === tx.amount_in_cents && real.currency === tx.currency;
    return coincide ? 'ok' : 'no_coincide';
  } catch (err) {
    console.error('API de Wompi', err);
    return 'error';
  }
}

function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

const cop = (valor: number) => `$ ${valor.toLocaleString('es-CO')} COP`;

const fechaLarga = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
  : '—';

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reintenta caídas momentáneas de Resend (red, 429, 5xx) dentro de la misma invocación.
// La Idempotency-Key es la misma en los reintentos: si Resend sí alcanzó a enviarlo, no lo duplica.
async function enviarCorreo(to: string, subject: string, html: string, replyTo?: string): Promise<void> {
  const idempotencyKey = crypto.randomUUID();
  const body = JSON.stringify({
    from: Deno.env.get('ALERTA_EMAIL_FROM'),
    to: [to],
    subject,
    html,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

  let ultimoError = '';
  for (const pausa of [0, 700, 2000]) {
    if (pausa) await esperar(pausa);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body,
      });
      if (res.ok) return;
      ultimoError = `Resend ${res.status}: ${await res.text()}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      ultimoError = `Resend sin conexión: ${(err as Error)?.message ?? err}`;
    }
  }
  throw new Error(ultimoError);
}

// ---------- Provisión del negocio en NexoPos ----------

// "Restaurante La Esquiña!" → "restaurante-la-esquina-7f3a"
function idNegocio(nombre: string): string {
  const base = nombre
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '') || 'negocio';
  return `${base}-${crypto.randomUUID().slice(0, 4)}`;
}

// Sin caracteres confundibles (0/O, 1/l/I) para que se pueda copiar a mano
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function contrasenaTemporal(largo = 12): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(largo)), (b) => ALFABETO[b % ALFABETO.length]).join('');
}

type Provision = { negocio_id: string; usuario_id: string; es_renovacion: boolean; duplicado_de?: string | null };

// Mismo documento con otro correo: probablemente un cliente que renovó con un correo distinto.
// No se fusiona solo (un mismo NIT puede tener varias sedes): se crea el negocio y se te avisa.
async function negocioPrevioDelDocumento(compra: Compra): Promise<string | null> {
  const { data } = await supabase
    .from('compras')
    .select('negocio_id, email')
    .eq('documento_tipo', compra.documento_tipo)
    .eq('documento', compra.documento)
    .neq('email', compra.email)
    .not('negocio_id', 'is', null)
    .limit(1);
  const previa = (data as { negocio_id: string; email: string }[] | null)?.[0];
  return previa ? `${previa.negocio_id} (${previa.email})` : null;
}

async function provisionar(compra: Compra): Promise<Provision> {
  const plan = compra.plan_id.replace(/_anual$/, '');
  const dias = DIAS_POR_CICLO[compra.plan_id.endsWith('_anual') ? 'anual' : 'mensual'];

  const { data: cuentas, error: buscarError } = await supabase.rpc('provision_buscar_cuenta', { p_email: compra.email });
  if (buscarError) throw new Error(`buscar cuenta: ${buscarError.message}`);

  const cuenta = (cuentas as { usuario_id: string; negocio_id: string | null }[] | null)?.[0];
  if (cuenta) {
    if (!cuenta.negocio_id) throw new Error('El correo ya existe en NexoPos pero no tiene un negocio asociado');
    const { data: vence, error } = await supabase.rpc('provision_renovar_negocio', {
      p_id: cuenta.negocio_id, p_plan: plan, p_dias: dias,
    });
    if (error) throw new Error(`renovar negocio: ${error.message}`);
    if (!vence) throw new Error(`El negocio ${cuenta.negocio_id} no existe`);
    return { negocio_id: cuenta.negocio_id, usuario_id: cuenta.usuario_id, es_renovacion: true };
  }

  let negocioId: string | null = null;
  for (let intento = 0; intento < 3 && !negocioId; intento++) {
    const id = idNegocio(compra.comercio);
    const { error } = await supabase.rpc('provision_crear_negocio', {
      p_id: id, p_nombre: compra.comercio, p_telefono: compra.telefono, p_plan: plan, p_dias: dias,
    });
    if (!error) negocioId = id;
    else if (error.code !== '23505') throw new Error(`crear negocio: ${error.message}`);
  }
  if (!negocioId) throw new Error('No se pudo generar un ID de negocio único');

  // must_change_password va explícito: el trigger marcar_contrasena_temporal solo la pone si business_id
  // llega en el insert, y Auth puede guardar app_metadata en un update posterior.
  // La contraseña real se asigna al enviar el acceso (ver notificarCliente).
  const { data: creado, error: userError } = await supabase.auth.admin.createUser({
    email: compra.email,
    password: contrasenaTemporal(24),
    email_confirm: true,
    app_metadata: { business_id: negocioId, must_change_password: true },
    user_metadata: { nombre: compra.comercio },
  });

  if (userError || !creado?.user) {
    await supabase.from('negocios').delete().eq('id', negocioId);
    throw new Error(`crear usuario: ${userError?.message ?? 'sin respuesta'}`);
  }

  return {
    negocio_id: negocioId,
    usuario_id: creado.user.id,
    es_renovacion: false,
    duplicado_de: await negocioPrevioDelDocumento(compra),
  };
}

// ---------- Correos ----------

type Compra = {
  referencia: string;
  plan_id: string;
  monto_cop: number;
  comercio: string;
  documento_tipo: string;
  documento: string;
  responsable: string;
  email: string;
  telefono: string;
  ciudad: string;
  acepta_marketing: boolean;
  metodo_pago: string | null;
  wompi_transaccion_id: string | null;
  pagado_at: string;
  negocio_id: string | null;
  usuario_id: string | null;
  es_renovacion: boolean | null;
  provision_error: string | null;
  duplicado_de: string | null;
  cliente_notificado_at: string | null;
  alerta_enviada_at: string | null;
  planes: { nombre: string } | null;
};

async function vencimiento(negocioId: string | null): Promise<string | null> {
  if (!negocioId) return null;
  const { data } = await supabase.from('negocios').select('fecha_vencimiento').eq('id', negocioId).maybeSingle();
  return data?.fecha_vencimiento ?? null;
}

const pieCorreo = `<p>¿Dudas? Escríbenos a soporte@netxpremium.com o al WhatsApp +57 305 248 4278.</p><p>— Equipo NetxPremium</p>`;
const appSinProtocolo = NEXOPOS_APP_URL.replace('https://', '');

async function notificarCliente(compra: Compra): Promise<void> {
  const plan = escapeHtml(compra.planes?.nombre ?? compra.plan_id);
  const saludo = `<p>Hola ${escapeHtml(compra.responsable)},</p>`;
  const replyTo = Deno.env.get('ALERTA_EMAIL_TO')!;

  if (compra.negocio_id && !compra.es_renovacion) {
    // Contraseña nueva en cada envío: si un reintento reenvía el correo, la anterior deja de servir
    const password = contrasenaTemporal();
    const { error } = await supabase.auth.admin.updateUserById(compra.usuario_id!, { password });
    if (error) throw new Error(`asignar contraseña: ${error.message}`);

    const vence = fechaLarga(await vencimiento(compra.negocio_id));
    await enviarCorreo(
      compra.email,
      'Bienvenido a NexoPos: tus datos de acceso',
      `${saludo}
       <p>Confirmamos tu pago de <strong>${plan}</strong> por <strong>${escapeHtml(cop(compra.monto_cop))}</strong>. Tu negocio <strong>${escapeHtml(compra.comercio)}</strong> ya está creado y listo para usar.</p>
       <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;margin:16px 0">
         <tr><td style="padding:6px 12px;color:#64748b">Ingresa en</td><td style="padding:6px 12px"><a href="${NEXOPOS_APP_URL}"><strong>${appSinProtocolo}</strong></a></td></tr>
         <tr><td style="padding:6px 12px;color:#64748b">Correo</td><td style="padding:6px 12px"><strong>${escapeHtml(compra.email)}</strong></td></tr>
         <tr><td style="padding:6px 12px;color:#64748b">Contraseña temporal</td><td style="padding:6px 12px"><strong style="font-family:monospace;font-size:16px;letter-spacing:1px">${password}</strong></td></tr>
         <tr><td style="padding:6px 12px;color:#64748b">Plan vigente hasta</td><td style="padding:6px 12px"><strong>${escapeHtml(vence)}</strong></td></tr>
       </table>
       <p><strong>Primeros pasos:</strong></p>
       <ol>
         <li>Abre <a href="${NEXOPOS_APP_URL}">${appSinProtocolo}</a> en el computador, tablet o celular de tu caja.</li>
         <li>En <em>Vincular Terminal</em> escribe tu correo y la contraseña temporal, y pulsa <em>Vincular y Descargar Catálogo</em>.</li>
         <li>La app te pedirá crear tu <strong>contraseña definitiva</strong> (mínimo 8 caracteres). Úsala de ahí en adelante para vincular tus cajas.</li>
         <li>Configura los datos de tu restaurante, tu menú, las estaciones de cocina y barra, y los usuarios de tu equipo.</li>
       </ol>
       <p>La contraseña temporal solo sirve para ese primer ingreso. Si más adelante olvidas tu contraseña definitiva, usa <em>¿Olvidaste tu contraseña?</em> en la pantalla de ingreso.</p>
       <p>Referencia de pago: <strong>${escapeHtml(compra.referencia)}</strong></p>
       ${pieCorreo}`,
      replyTo,
    );
    return;
  }

  if (compra.negocio_id && compra.es_renovacion) {
    const vence = fechaLarga(await vencimiento(compra.negocio_id));
    await enviarCorreo(
      compra.email,
      'Tu plan de NexoPos fue renovado',
      `${saludo}
       <p>Confirmamos tu pago de <strong>${plan}</strong> por <strong>${escapeHtml(cop(compra.monto_cop))}</strong>.</p>
       <p>Tu negocio sigue activo con los mismos datos de acceso en <a href="${NEXOPOS_APP_URL}">${appSinProtocolo}</a>. Plan vigente hasta el <strong>${escapeHtml(vence)}</strong>.</p>
       <p>Referencia de pago: <strong>${escapeHtml(compra.referencia)}</strong></p>
       ${pieCorreo}`,
      replyTo,
    );
    return;
  }

  // La provisión falló: NetxPremium recibe la alerta para crearlo manualmente
  await enviarCorreo(
    compra.email,
    'Recibimos tu pago de NexoPos',
    `${saludo}
     <p>Confirmamos el pago de <strong>${plan}</strong> por <strong>${escapeHtml(cop(compra.monto_cop))}</strong> para <strong>${escapeHtml(compra.comercio)}</strong>.</p>
     <p>Estamos terminando de crear tu negocio. Te enviaremos los datos de acceso a este correo y por WhatsApp al +57 ${escapeHtml(compra.telefono)} en las próximas horas.</p>
     <p>Referencia de pago: <strong>${escapeHtml(compra.referencia)}</strong></p>
     ${pieCorreo}`,
    replyTo,
  );
}

async function enviarAlertaAdmin(compra: Compra): Promise<void> {
  const plan = compra.planes?.nombre ?? compra.plan_id;
  const vence = fechaLarga(await vencimiento(compra.negocio_id));

  const [asunto, titulo, resultado] = compra.provision_error
    ? [`⚠️ Pago NexoPos sin negocio: ${compra.comercio}`, 'Pago aprobado: crea el negocio manualmente', `Error automático: ${compra.provision_error}`]
    : compra.es_renovacion
      ? [`🔁 Renovación NexoPos: ${compra.comercio} (${plan})`, 'Renovación aplicada automáticamente', `Negocio ${compra.negocio_id} renovado hasta ${vence}`]
      : [`✅ Nuevo negocio NexoPos: ${compra.comercio} (${plan})`, 'Negocio creado y acceso enviado', `Negocio ${compra.negocio_id} activo hasta ${vence}`];

  const filas: [string, string][] = [
    ['Resultado', resultado],
    ...(compra.duplicado_de
      ? [['⚠️ Posible duplicado', `Este documento ya tiene el negocio ${compra.duplicado_de}. Si es el mismo cliente, traslada el pago a ese negocio y desactiva el nuevo.`] as [string, string]]
      : []),
    ['Negocio', compra.comercio],
    ['ID del negocio', compra.negocio_id ?? '—'],
    ['Documento', `${compra.documento_tipo} ${compra.documento}`],
    ['Responsable', compra.responsable],
    ['Correo', compra.email],
    ['Celular', `+57 ${compra.telefono}`],
    ['Ciudad', compra.ciudad],
    ['Plan', plan],
    ['Valor pagado', cop(compra.monto_cop)],
    ['Medio de pago', compra.metodo_pago ?? '—'],
    ['Referencia', compra.referencia],
    ['Transacción Wompi', compra.wompi_transaccion_id ?? '—'],
    ['Acepta información comercial', compra.acepta_marketing ? 'Sí' : 'No'],
  ];

  const tabla = filas.map(([k, v]) => (
    `<tr><td style="padding:6px 12px;color:#64748b">${escapeHtml(k)}</td><td style="padding:6px 12px"><strong>${escapeHtml(v)}</strong></td></tr>`
  )).join('');

  await enviarCorreo(
    Deno.env.get('ALERTA_EMAIL_TO')!,
    asunto,
    `<h2>${escapeHtml(titulo)}</h2>
     <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">${tabla}</table>`,
    compra.email,
  );
}

type WompiEvent = {
  event: string;
  data: Record<string, unknown>;
  environment?: string;
  signature?: { properties?: string[]; checksum?: string };
  timestamp: number;
};

type WompiTransaction = {
  id: string;
  status: string;
  reference: string;
  amount_in_cents: number;
  currency: string;
  payment_method_type?: string;
};

const ok = () => new Response('ok', { status: 200 });
const reintentar = (motivo: string) => new Response(motivo, { status: 500 });
const ahora = () => new Date().toISOString();

async function leerCompra(referencia: string): Promise<Compra | null> {
  const { data } = await supabase
    .from('compras')
    .select('*, planes(nombre)')
    .eq('referencia', referencia)
    .in('estado', ['pagado', 'entregado'])
    .maybeSingle();
  return data as Compra | null;
}

// Pasos posteriores al pago. Devuelve false si algo falló y conviene que Wompi reintente.
// Solo una invocación a la vez por compra: si otra ya la está procesando, esta no hace nada
// (si aquella falla, responde 500 y Wompi o el barrido la reintentan).
async function completarCompra(referencia: string): Promise<boolean> {
  const { data: reclamada, error } = await supabase.rpc('compras_reclamar', { p_referencia: referencia });
  if (error) {
    console.error('compras_reclamar', error);
    return false;
  }
  if (!reclamada) return true;

  try {
    return await procesarCompra(referencia);
  } finally {
    await supabase.rpc('compras_liberar', { p_referencia: referencia });
  }
}

async function procesarCompra(referencia: string): Promise<boolean> {
  let compra = await leerCompra(referencia);
  if (!compra) return true;

  // 1. Provisión (una sola vez: queda marcada con negocio_id o provision_error)
  if (!compra.negocio_id && !compra.provision_error) {
    let cambios: Record<string, unknown>;
    try {
      cambios = { ...(await provisionar(compra)) };
    } catch (err) {
      console.error('provision', err);
      cambios = { provision_error: String((err as Error)?.message ?? err).slice(0, 500) };
    }
    await supabase.from('compras').update(cambios).eq('referencia', referencia);
    compra = (await leerCompra(referencia))!;
  }

  let todoOk = true;

  // 2. Correo al cliente: acceso, renovación o confirmación
  if (!compra.cliente_notificado_at) {
    try {
      await notificarCliente(compra);
      await supabase.from('compras').update({
        cliente_notificado_at: ahora(),
        ...(compra.negocio_id ? { estado: 'entregado', entregado_at: ahora() } : {}),
      }).eq('referencia', referencia);
    } catch (err) {
      console.error('correo cliente', err);
      todoOk = false;
    }
  }

  // 3. Alerta a NetxPremium
  if (!compra.alerta_enviada_at) {
    try {
      await enviarAlertaAdmin(compra);
      await supabase.from('compras').update({ alerta_enviada_at: ahora() }).eq('referencia', referencia);
    } catch (err) {
      console.error('alerta', err);
      todoOk = false;
    }
  }

  return todoOk;
}

// Barrido programado (pg_cron cada 10 min): reintenta correos y alertas pendientes de los últimos 3 días
async function barrido(): Promise<Response> {
  const desde = new Date(Date.now() - 3 * 864e5).toISOString();
  const { data, error } = await supabase
    .from('compras')
    .select('referencia, cliente_notificado_at, alerta_enviada_at')
    .in('estado', ['pagado', 'entregado'])
    .gte('pagado_at', desde)
    .limit(50);

  if (error) {
    console.error('barrido', error);
    return new Response('Error de base de datos', { status: 500 });
  }

  const pendientes = (data ?? []).filter((c) => !c.cliente_notificado_at || !c.alerta_enviada_at);
  let completas = 0;
  for (const c of pendientes) if (await completarCompra(c.referencia)) completas++;

  return new Response(JSON.stringify({ pendientes: pendientes.length, completas }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Método no permitido', { status: 405 });

  if (new URL(req.url).searchParams.has('barrido')) {
    const secreto = Deno.env.get('BARRIDO_SECRET') ?? '';
    if (!secreto || !igualSeguro(req.headers.get('x-barrido-secret') ?? '', secreto)) {
      return new Response('No autorizado', { status: 401 });
    }
    return barrido();
  }

  const cuerpo = await req.text();
  let event: WompiEvent;
  try {
    event = JSON.parse(cuerpo);
  } catch (_) {
    return new Response('JSON no válido', { status: 400 });
  }

  // Reenvío de NexoBar (producción) o llamada directa de Wompi (sandbox)
  const autentico = req.headers.has('x-nexopos-reenvio-firma')
    ? await firmaReenvioValida(req, cuerpo)
    : await firmaWompiValida(event);
  if (!autentico) {
    console.warn('Evento con firma inválida descartado');
    return new Response('Firma inválida', { status: 401 });
  }

  const ambienteEsperado = Deno.env.get('WOMPI_ENVIRONMENT');
  if (event.event !== 'transaction.updated' || (ambienteEsperado && event.environment !== ambienteEsperado)) {
    return ok();
  }

  const tx = event.data?.transaction as WompiTransaction | undefined;
  if (!tx?.reference?.startsWith(PREFIJO_REFERENCIA) || !tx.id) return ok();

  const { data: compra, error } = await supabase
    .from('compras')
    .select('referencia, monto_cop, estado, wompi_transaccion_id')
    .eq('referencia', tx.reference)
    .maybeSingle();

  if (error) {
    console.error('compras.select', error);
    return new Response('Error de base de datos', { status: 500 });
  }
  if (!compra) {
    console.warn('Referencia desconocida', tx.reference);
    return ok();
  }

  // Idempotencia por transacción: un id de Wompi solo puede quedar en una compra
  const { data: otra } = await supabase
    .from('compras')
    .select('referencia')
    .eq('wompi_transaccion_id', tx.id)
    .neq('referencia', tx.reference)
    .maybeSingle();
  if (otra) {
    console.error('Transacción ya asociada a otra compra', tx.id, otra.referencia);
    return ok();
  }

  const datosWompi = {
    wompi_transaccion_id: tx.id,
    wompi_estado: tx.status,
    metodo_pago: tx.payment_method_type ?? null,
  };

  if (tx.status === 'APPROVED') {
    // Ya pagada con esta misma transacción: solo se reintentan los pasos pendientes
    if (compra.estado === 'pagado' || compra.estado === 'entregado') {
      return (await completarCompra(tx.reference)) ? ok() : reintentar('Reintentar');
    }

    if (tx.currency !== 'COP' || tx.amount_in_cents !== compra.monto_cop * 100) {
      console.error('Monto no coincide', tx.reference, tx.amount_in_cents, compra.monto_cop);
      await supabase.from('compras').update({ ...datosWompi, wompi_estado: 'MONTO_NO_COINCIDE' }).eq('referencia', tx.reference);
      return ok();
    }

    const confirmacion = await confirmarEnWompi(tx, event.environment);
    if (confirmacion === 'error') return reintentar('No se pudo confirmar con Wompi');
    if (confirmacion === 'no_coincide') {
      console.error('La API de Wompi no confirma la transacción', tx.id, tx.reference);
      await supabase.from('compras').update({ ...datosWompi, wompi_estado: 'NO_CONFIRMADA' }).eq('referencia', tx.reference);
      return ok();
    }

    const { error: updateError } = await supabase
      .from('compras')
      .update({ ...datosWompi, estado: 'pagado', pagado_at: ahora() })
      .eq('referencia', tx.reference)
      .in('estado', ['pendiente', 'rechazado']);

    if (updateError) {
      console.error('compras.update', updateError);
      return new Response('Error de base de datos', { status: 500 });
    }

    return (await completarCompra(tx.reference)) ? ok() : reintentar('Reintentar');
  }

  if (['DECLINED', 'VOIDED', 'ERROR'].includes(tx.status)) {
    await supabase
      .from('compras')
      .update({ ...datosWompi, estado: 'rechazado' })
      .eq('referencia', tx.reference)
      .eq('estado', 'pendiente');
    return ok();
  }

  // PENDING u otros estados intermedios: solo se registra la información
  await supabase.from('compras').update(datosWompi).eq('referencia', tx.reference).eq('estado', 'pendiente');
  return ok();
});
