// scratch/test-recuperar-acceso.js
// Recuperar acceso con el código REAL de app.js, modules.js y sync.js (Supabase simulado, no toca la nube):
// 1. NexoSync.requestRecoveryCode / confirmRecoveryCode llaman a la Edge Function recuperar-acceso y devuelven su mensaje,
//    también cuando responde 500; sin internet o sin servidor dan un error claro.
// 2. Pantalla de recuperación: el código se pide con un correo válido y luego se pasa al paso del código.
// 3. ¿Olvidaste tu PIN?: solo el administrador, con la contraseña maestra del mismo negocio; el PIN nuevo se guarda,
//    se sube a la nube y entra. Credenciales de otro negocio no cambian nada.
// 4. El teclado del PIN no se come lo que se escribe en las pantallas de recuperación.
// 5. La Edge Function respeta las reglas acordadas (respuesta genérica, 15 min, 5 intentos, 3 envíos por hora, HMAC).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: RECUPERAR CONTRASEÑA Y PIN ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '', href: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, closest: () => null, click() {}, scrollIntoView() {},
    querySelector: () => mockElement(), querySelectorAll: () => [], append() {}, appendChild() {}, matches: () => false
  };
}
const document = {
  querySelector: sel => (els[sel] = els[sel] || mockElement()), querySelectorAll: () => [],
  addEventListener() {}, createElement: () => mockElement(), body: mockElement(), documentElement: mockElement(), visibilityState: 'visible'
};
const memoryStorage = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const ctx = {
  console: { ...console, warn() {} }, document, window: { location: { search: '' }, addEventListener() {}, confirm: () => true }, navigator: { onLine: true },
  localStorage: memoryStorage(), sessionStorage: memoryStorage(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  structuredClone, Intl, crypto: globalThis.crypto, URLSearchParams, TextEncoder, Blob, CSS: { escape: s => s }, __IS_NODE_TEST__: true
};
ctx.globalThis = ctx; ctx.window.document = document;
vm.createContext(ctx);
for (const file of ['demo-mode.js', 'planes.js', 'storage.js', 'modules.js', 'sync.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
const get = code => JSON.parse(run(`JSON.stringify(${code})`));
const el = sel => document.querySelector(sel);
run(`var toasts = []; showToast = m => toasts.push(String(m)); saveState = () => {}; renderAll = () => {}; logAudit = () => {};`);
let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };

(async () => {
  // --- 1. Cliente de la Edge Function ---
  run(`var invocaciones = [], respuesta = null; hasSupabaseLib = () => true;
    getClient = () => ({ functions: { invoke: async (name, opts) => { invocaciones.push({ name, body: opts.body }); return respuesta(); } } });`);
  run(`respuesta = () => ({ data: { ok: true, mensaje: 'Si el correo está registrado…' }, error: null });`);
  let r = await run(`requestRecoveryCode('dueno@bar.co')`);
  assert.deepStrictEqual(get('invocaciones'), [{ name: 'recuperar-acceso', body: { accion: 'solicitar', email: 'dueno@bar.co' } }]);
  assert.strictEqual(r.ok, true);
  run(`invocaciones = []; respuesta = () => ({ data: { ok: false, error: 'Código incorrecto. Te quedan 4 intentos.' }, error: null });`);
  r = await run(`confirmRecoveryCode('dueno@bar.co', '123456', 'nuevaClave1')`);
  assert.deepStrictEqual(get('invocaciones[0].body'), { accion: 'confirmar', email: 'dueno@bar.co', codigo: '123456', password: 'nuevaClave1' });
  assert.strictEqual(r.error, 'Código incorrecto. Te quedan 4 intentos.');
  run(`respuesta = () => ({ data: null, error: { context: { json: async () => ({ ok: false, error: 'Ocurrió un error en el servidor.' }) } } });`);
  assert.strictEqual((await run(`requestRecoveryCode('dueno@bar.co')`)).error, 'Ocurrió un error en el servidor.', 'el mensaje del 500 se muestra');
  run(`respuesta = () => { throw new Error('Failed to fetch'); };`);
  assert.match((await run(`requestRecoveryCode('dueno@bar.co')`)).error, /No se pudo conectar/);
  ctx.navigator.onLine = false;
  assert.match((await run(`requestRecoveryCode('dueno@bar.co')`)).error, /conexión a internet/);
  ctx.navigator.onLine = true;
  ok('requestRecoveryCode y confirmRecoveryCode usan recuperar-acceso y muestran su mensaje; sin red o con 500 dan un error claro');

  // --- 2. Pantalla de recuperación (app.js) ---
  run(`var pedidos = []; NexoSync = globalThis.NexoSync = { requestRecoveryCode: async e => { pedidos.push(e); return { ok: true, mensaje: 'Te enviamos un código' }; } };`);
  run(`openRecovery('');`);
  assert.ok(el('#recoveryDialog').open);
  await run(`sendRecoveryCode('no-es-correo')`);
  assert.deepStrictEqual(get('pedidos'), [], 'un correo inválido no llama al servidor');
  assert.match(el('#recoveryMessage').textContent, /correo electrónico válido/);
  await run(`sendRecoveryCode('dueno@bar.co')`);
  assert.deepStrictEqual(get('pedidos'), ['dueno@bar.co']);
  assert.strictEqual(el('#recoveryConfirmForm').hidden, false, 'pasa al paso del código');
  assert.strictEqual(el('#recoveryRequestForm').hidden, true);
  assert.match(el('#recoverySubtitle').textContent, /dueno@bar\.co/);
  assert.strictEqual(el('#recoveryMessage').textContent, 'Te enviamos un código');
  ok('recuperar contraseña: valida el correo, pide el código y pasa al paso del código con el correo a la vista');

  // --- 3. ¿Olvidaste tu PIN? ---
  run(`state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.terminal = { businessId: 'bar_x', email: 'dueno@bar.co' };
    var admin = state.users.find(u => u.role === 'admin'), cajero = newUser('Caja 1', 'cajero', '2222'); state.users.push(cajero);
    var pinesSubidos = [], salidas = 0, credenciales = { ok: true, businessId: 'bar_x', email: 'dueno@bar.co' };
    NexoSync = globalThis.NexoSync = { activateTerminal: async () => credenciales, syncAdminPin: async pin => { pinesSubidos.push(pin); return { ok: true }; }, signOutTerminal: async () => { salidas++; } };
    session = null;`);
  run(`loginTarget = cajero.id; openPinRecovery();`);
  assert.strictEqual(el('#pinRecoveryDialog').open, false, 'un cajero no restablece su PIN aquí');
  assert.match(el('#loginError').textContent, /administrador/);
  run(`loginTarget = admin.id; openPinRecovery();`);
  assert.ok(el('#pinRecoveryDialog').open);
  assert.strictEqual(el('#pinRecoveryEmail').value, 'dueno@bar.co', 'el correo de la caja viene escrito');
  const llenar = (pin, pin2 = pin) => { el('#pinRecoveryPassword').value = 'claveMaestra'; el('#pinRecoveryPin').value = pin; el('#pinRecoveryPin2').value = pin2; };
  llenar('12a4'); await run(`savePinRecovery({ preventDefault() {} })`);
  assert.match(el('#pinRecoveryMessage').textContent, /4 números/);
  llenar('5678', '5679'); await run(`savePinRecovery({ preventDefault() {} })`);
  assert.match(el('#pinRecoveryMessage').textContent, /no coinciden/);
  // Credenciales de otro negocio: no cambia el PIN y se cierra esa sesión
  const hashAntes = get('admin.pinHash');
  run(`credenciales = { ok: true, businessId: 'otro_bar', email: 'x@otro.co' };`);
  llenar('5678'); await run(`savePinRecovery({ preventDefault() {} })`);
  assert.strictEqual(get('admin.pinHash'), hashAntes);
  assert.strictEqual(run('salidas'), 1);
  assert.match(el('#pinRecoveryMessage').textContent, /otro negocio/);
  run(`credenciales = { ok: false, error: 'Correo o contraseña incorrectos.' };`);
  llenar('5678'); await run(`savePinRecovery({ preventDefault() {} })`);
  assert.strictEqual(el('#pinRecoveryMessage').textContent, 'Correo o contraseña incorrectos.');
  assert.strictEqual(get('admin.pinHash'), hashAntes);
  // Correcto
  run(`credenciales = { ok: true, businessId: 'bar_x', email: 'dueno@bar.co' }; admin.mustChangePin = true;`);
  llenar('5678'); await run(`savePinRecovery({ preventDefault() {} })`);
  assert.strictEqual(run(`hashPin('5678', admin.salt) === admin.pinHash`), true, 'el PIN nuevo funciona');
  assert.strictEqual(run('admin.mustChangePin'), false);
  assert.ok(run('admin.pinAt') > 0, 'pinAt: gana en las demás cajas');
  assert.deepStrictEqual(get('pinesSubidos'), ['5678'], 'se sube a la nube (syncAdminPin)');
  assert.strictEqual(run('session'), get('admin.id'), 'entra como administrador');
  assert.strictEqual(el('#pinRecoveryDialog').open, false);
  ok('¿Olvidaste tu PIN?: solo administrador, con la contraseña maestra del mismo negocio; el PIN nuevo se guarda, se sube y entra');

  // --- 4. Teclado del PIN ---
  run(`document.querySelector('#recoveryDialog').open = false; loginTarget = admin.id; loginPin = ''; document.querySelector('#loginDialog').open = true; document.querySelector('#pinRecoveryDialog').open = true;`);
  run(`handleLoginKeys({ key: '7', preventDefault() {} });`);
  assert.strictEqual(run('loginPin'), '', 'con la recuperación abierta, las teclas van al formulario');
  run(`document.querySelector('#pinRecoveryDialog').open = false; handleLoginKeys({ key: '7', preventDefault() {} });`);
  assert.strictEqual(run('loginPin'), '7', 'sin ella, el teclado del PIN funciona como siempre');
  ok('el teclado del PIN no captura lo que se escribe en las pantallas de recuperación');

  // --- 5. Reglas de la Edge Function ---
  const fn = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'recuperar-acceso', 'index.ts'), 'utf8');
  assert.match(fn, /const CODIGO_MINUTOS = 15;/);
  assert.match(fn, /const MAX_INTENTOS = 5;/);
  assert.match(fn, /const MAX_ENVIOS_HORA = 3;/);
  assert.match(fn, /if \(!cuenta \|\| !cuenta\.activo\) return json\(\{ ok: true, mensaje: MENSAJE_ENVIADO \}\)/, 'correo inexistente o negocio suspendido: misma respuesta');
  assert.match(fn, /name: 'HMAC'/, 'solo se guarda el HMAC del código');
  assert.match(fn, /soporte@netxpremium\.com/);
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'sql', '2026-10-28_eliminar_negocio_y_recuperar_acceso.sql'), 'utf8');
  assert.match(sql, /revoke all on public\.recuperaciones_acceso from anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.recuperacion_buscar_cuenta\(text\) to service_role;/);
  assert.match(sql, /p_confirmacion is distinct from p_negocio_id/, 'el servidor vuelve a validar la confirmación del borrado');
  ok('la Edge Function y el SQL cumplen las reglas: respuesta genérica, 15 min, 5 intentos, 3 envíos por hora, HMAC y sin acceso público');

  console.log(`\n${pasadas} PRUEBAS SUPERADAS`);
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
