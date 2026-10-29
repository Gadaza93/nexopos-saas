// scratch/test-admin-panel.js
// Prueba del Panel SuperAdmin (admin.js) con un cliente Supabase simulado (no toca la base real):
// 1. Solo app_metadata.role === 'superadmin' entra; otra cuenta recibe el error y se cierra su sesión.
// 2. Métricas, vencimientos y parámetros de admin_update_negocio_status (toggle y +30 días).

const assert = require('assert');

console.log('=== PRUEBAS: PANEL SUPERADMIN ===\n');

globalThis.__IS_NODE_TEST__ = true;
let signInResult = null, signOutCalls = 0, rpcCalls = [], rpcResult = { data: [], error: null };
globalThis.supabase = {
  createClient: () => ({
    auth: {
      signInWithPassword: async () => signInResult,
      signOut: async () => { signOutCalls++; return { error: null }; }
    },
    rpc: async (name, params) => { rpcCalls.push({ name, params }); return rpcResult; }
  })
};
const admin = require('../admin.js');

(async () => {
  // --- 1. Login ---
  signInResult = { data: { user: { email: 'root@nexopos.co', app_metadata: { role: 'superadmin' } } }, error: null };
  let res = await admin.adminSignIn('root@nexopos.co', 'x');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(signOutCalls, 0);
  console.log('   ✅ Una cuenta superadmin entra al tablero.');

  signInResult = { data: { user: { email: 'caja@bar.com', app_metadata: { business_id: 'bar_1' }, user_metadata: { role: 'superadmin' } } }, error: null };
  res = await admin.adminSignIn('caja@bar.com', 'x');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Acceso no autorizado: esta cuenta no tiene permisos de SuperAdmin');
  assert.strictEqual(signOutCalls, 1);
  console.log('   ✅ Cuenta sin rol (aunque user_metadata diga superadmin) recibe el error y se cierra su sesión.');

  signInResult = { data: { user: null }, error: { message: 'Invalid login credentials' } };
  res = await admin.adminSignIn('root@nexopos.co', 'mala');
  assert.strictEqual(res.error, 'Correo o contraseña incorrectos.');
  console.log('   ✅ Credenciales inválidas muestran un error claro.');

  // --- 2. Métricas ---
  const list = [
    { id: 'a', activo: true, total_ventas: 19 },
    { id: 'b', activo: false, total_ventas: '5' },
    { id: 'c', activo: true, total_ventas: null }
  ];
  assert.deepStrictEqual(admin.computeMetrics(list), { total: 3, active: 2, suspended: 1, sales: 24 });
  assert.deepStrictEqual(admin.computeMetrics(null), { total: 0, active: 0, suspended: 0, sales: 0 });
  console.log('   ✅ Métricas: total, activos, suspendidos y ventas globales.');

  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.strictEqual(admin.expiryInfo('2026-10-20T00:00:00Z', now).note, 'Vencida');
  assert.strictEqual(admin.expiryInfo('2026-10-29T12:00:00Z', now).tone, 'warn');
  assert.strictEqual(admin.expiryInfo('2026-11-25T20:12:35+00:00', now).tone, 'ok');
  assert.strictEqual(admin.expiryInfo(null, now).label, 'Sin fecha');
  console.log('   ✅ Fecha de vencimiento: vencida, próxima a vencer y vigente.');

  // --- 3. RPC ---
  const negocio = { id: 'bar_central_01', activo: true, plan: 'pro' };
  rpcCalls = []; rpcResult = { data: null, error: null };
  await admin.updateNegocio(negocio, { activo: false });
  assert.deepStrictEqual(rpcCalls[0], { name: 'admin_update_negocio_status', params: { p_negocio_id: 'bar_central_01', p_activo: false, p_plan: 'pro', p_extender_dias: 0 } });
  console.log('   ✅ Suspender envía p_activo=false conservando el plan y sin extender días.');

  rpcCalls = [];
  await admin.updateNegocio(negocio, { extenderDias: admin.EXTEND_DAYS });
  assert.deepStrictEqual(rpcCalls[0].params, { p_negocio_id: 'bar_central_01', p_activo: true, p_plan: 'pro', p_extender_dias: 30 });
  console.log('   ✅ "+30 días" conserva estado y plan y envía p_extender_dias=30.');

  rpcResult = { data: null, error: { message: 'permission denied' } };
  await assert.rejects(() => admin.updateNegocio(negocio, { activo: false }), /permission denied/);
  rpcResult = { data: [{ id: 'x', nombre: 'X' }], error: null }; rpcCalls = [];
  assert.deepStrictEqual(await admin.fetchNegocios(), [{ id: 'x', nombre: 'X' }]);
  assert.strictEqual(rpcCalls[0].name, 'admin_get_all_negocios');
  console.log('   ✅ La lista sale de admin_get_all_negocios y los errores de la RPC se propagan.');

  assert.strictEqual(admin.escapeAdminHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  console.log('   ✅ Nombres de negocio escapados antes de pintarlos.');

  // --- 4. Alta de negocio (admin_create_negocio) ---
  assert.strictEqual(admin.slugifyNegocioId('Gastrobar La Estación'), 'bar_la_estacion');
  assert.strictEqual(admin.slugifyNegocioId('Bar Central'), 'bar_central');
  assert.strictEqual(admin.slugifyNegocioId('El Rincón de Ñoño #2'), 'bar_el_rincon_de_nono_2');
  assert.strictEqual(admin.slugifyNegocioId('Bar'), 'bar_bar');
  assert.strictEqual(admin.slugifyNegocioId('   '), '');
  assert.ok(admin.slugifyNegocioId('x'.repeat(80)).length <= 40);
  console.log('   ✅ ID sugerido: «Gastrobar La Estación» → bar_la_estacion (sin tildes ni símbolos).');

  for (let i = 0; i < 200; i++) {
    const pwd = admin.generatePassword();
    assert.strictEqual(pwd.length, 8);
    assert.match(pwd, /[A-Z]/); assert.match(pwd, /[a-z]/); assert.match(pwd, /[2-9]/);
    assert.doesNotMatch(pwd, /[0O1lI\s]/);
  }
  assert.notStrictEqual(admin.generatePassword(), admin.generatePassword());
  console.log('   ✅ Contraseña generada: 8 caracteres, mayúscula + minúscula + número, sin caracteres ambiguos.');

  const form = { nombre: ' Gastrobar La Estación ', negocioId: 'bar_la_estacion', email: ' LaEstacion@Bar.com ', password: 'Ab3kP9xq', plan: 'pro', dias: '30' };
  const built = admin.buildCreatePayload(form);
  assert.deepStrictEqual(built, { ok: true, payload: { p_id: 'bar_la_estacion', p_nombre: 'Gastrobar La Estación', p_email: 'laestacion@bar.com', p_password: 'Ab3kP9xq', p_plan: 'pro', p_dias_vigencia: 30 } });
  assert.strictEqual(admin.buildCreatePayload({ ...form, negocioId: 'Bar La-Estación' }).field, 'id');
  assert.strictEqual(admin.buildCreatePayload({ ...form, email: 'sin-arroba' }).field, 'email');
  assert.strictEqual(admin.buildCreatePayload({ ...form, password: 'corta' }).field, 'password');
  assert.strictEqual(admin.buildCreatePayload({ ...form, plan: 'gold' }).field, 'plan');
  assert.strictEqual(admin.buildCreatePayload({ ...form, dias: '0' }).field, 'dias');
  assert.strictEqual(admin.buildCreatePayload({ ...form, dias: '2.5' }).field, 'dias');
  assert.strictEqual(admin.buildCreatePayload({ ...form, plan: 'basico' }).payload.p_plan, 'basico');
  console.log('   ✅ Validación del formulario: ID, correo, contraseña, plan y días.');

  rpcCalls = []; rpcResult = { data: { id: 'bar_la_estacion' }, error: null };
  let created = await admin.createNegocio(built.payload);
  assert.strictEqual(created.ok, true);
  assert.deepStrictEqual(rpcCalls, [{ name: 'admin_create_negocio', params: { p_id: 'bar_la_estacion', p_nombre: 'Gastrobar La Estación', p_email: 'laestacion@bar.com', p_password: 'Ab3kP9xq', p_plan: 'pro', p_dias_vigencia: 30 } }]);
  console.log('   ✅ admin_create_negocio recibe p_id, p_nombre, p_email, p_password, p_plan y p_dias_vigencia.');

  rpcResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "users_email_partial_key"' } };
  assert.strictEqual((await admin.createNegocio(built.payload)).error, 'Ya existe una cuenta con ese correo. Usa otro correo para la terminal.');
  rpcResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "negocios_pkey"', details: 'Key (id)=(bar_la_estacion) already exists.' } };
  assert.strictEqual((await admin.createNegocio(built.payload)).error, 'Ese ID de negocio ya está en uso. Elige otro.');
  rpcResult = { data: null, error: { code: '42501', message: 'permission denied for function admin_create_negocio' } };
  assert.match((await admin.createNegocio(built.payload)).error, /permisos de SuperAdmin/);
  rpcResult = { data: null, error: { code: 'P0001', message: 'invalid email format' } };
  assert.strictEqual((await admin.createNegocio(built.payload)).error, 'No se pudo crear el negocio: invalid email format');
  console.log('   ✅ Errores claros: correo duplicado, ID ocupado, sin permisos y otros mensajes de la RPC.');

  const text = admin.credentialsText(built.payload);
  assert.match(text, /Correo: laestacion@bar\.com/);
  assert.match(text, /Contraseña: Ab3kP9xq/);
  assert.match(text, /Plan PRO · Vigencia inicial: 30 días/);
  assert.strictEqual(admin.planLabel('basico'), 'BÁSICO');
  console.log('   ✅ «Copiar credenciales» arma el texto listo para WhatsApp.');

  // --- 4. Eliminar negocio ---
  assert.strictEqual(admin.deleteConfirmMatches('bar_la_estacion', 'bar_la_estacion'), true);
  assert.strictEqual(admin.deleteConfirmMatches('  bar_la_estacion ', 'bar_la_estacion'), true, 'espacios alrededor no cuentan');
  assert.strictEqual(admin.deleteConfirmMatches('BAR_LA_ESTACION', 'bar_la_estacion'), false, 'debe ser exacto');
  assert.strictEqual(admin.deleteConfirmMatches('ELIMINAR', 'bar_la_estacion'), false);
  assert.strictEqual(admin.deleteConfirmMatches('', 'bar_la_estacion'), false);
  rpcCalls = []; rpcResult = { data: { id: 'bar_la_estacion', ventas: 19, productos: 40, cuentas: 1 }, error: null };
  const borrado = await admin.deleteNegocio('bar_la_estacion', ' bar_la_estacion ');
  assert.deepStrictEqual(rpcCalls, [{ name: 'admin_delete_negocio', params: { p_negocio_id: 'bar_la_estacion', p_confirmacion: 'bar_la_estacion' } }]);
  assert.strictEqual(borrado.cuentas, 1);
  for (const [error, re] of [
    [{ code: '42501', message: 'Acceso no autorizado' }, /permisos de SuperAdmin/],
    [{ code: '22023', message: 'La confirmación no coincide con el ID del negocio' }, /no coincide/],
    [{ code: 'P0002', message: 'El negocio "x" no existe' }, /ya no existe/],
    [{ code: 'PGRST202', message: 'Could not find the function public.admin_delete_negocio' }, /Falta instalar/],
  ]) {
    rpcResult = { data: null, error };
    await assert.rejects(admin.deleteNegocio('bar_la_estacion', 'bar_la_estacion'), re);
  }
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(html, /id="deleteNegocioSubmit"[^>]*disabled/, 'el botón final arranca deshabilitado');
  console.log('   ✅ Eliminar: la confirmación exige el ID exacto, admin_delete_negocio la recibe y sus errores se explican.');

  console.log('\n=== TODAS LAS PRUEBAS DEL PANEL SUPERADMIN PASARON ===');
  process.exit(0);
})().catch(err => { console.error('❌', err); process.exit(1); });
