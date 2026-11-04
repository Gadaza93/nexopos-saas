// scratch/test-negocio-eliminado.js
// Negocio eliminado por el superadmin, con el código REAL de app.js, modules.js y sync.js (contexto vm):
// 1. verificarNegocioEliminado solo bloquea con las DOS señales: sin fila de negocios y la cuenta de la sesión
//    inexistente (user_not_found). Lista vacía con la cuenta viva, token vencido, error de red o modo demo: no bloquea.
// 2. Bloqueada: motivo «eliminada», modal de suspensión en el acto (aunque haya cuentas abiertas) y sesión cerrada.
// 3. La descarga se detiene al detectarlo; si el negocio vuelve a existir (creado de nuevo y caja vinculada), se desbloquea.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: NEGOCIO ELIMINADO EN LA NUBE (código real) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, closest: () => null,
    querySelector: () => mockElement(), querySelectorAll: () => [], append() {}, appendChild() {}, matches: () => false,
    replaceChildren(...c) { this.textContent = c.map(x => typeof x === 'string' ? x : x.textContent).join(''); }
  };
}
const document = {
  querySelector: sel => (els[sel] = els[sel] || mockElement()), querySelectorAll: () => [], addEventListener() {},
  createElement: () => mockElement(), body: mockElement(), documentElement: mockElement(), visibilityState: 'visible'
};
const memoryStorage = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const ctx = {
  console: { ...console, warn() {}, log() {} }, document, navigator: { onLine: true },
  window: { location: { search: '' }, addEventListener() {}, confirm: () => true },
  localStorage: memoryStorage(), sessionStorage: memoryStorage(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  structuredClone, Intl, crypto: globalThis.crypto, URLSearchParams, __IS_NODE_TEST__: true
};
ctx.globalThis = ctx; ctx.window.document = document; ctx.els = els;
vm.createContext(ctx);
for (const file of ['demo-mode.js', 'planes.js', 'storage.js', 'modules.js', 'sync.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
const get = code => { const json = run(`JSON.stringify(${code})`); return json === undefined ? undefined : JSON.parse(json); };
const ok = msg => console.log(`   ✅ ${msg}`);

// Nube simulada: negocios devuelve `negocio`; auth.getUser devuelve el usuario o el error indicado
run(`
  var signOuts = 0, nube = null;
  renderAll = () => {}; showToast = () => {}; scheduleSave = () => {};
  function nubeFalsa({ negocio = null, user = null, userError = null, negociosError = null } = {}) {
    const q = table => { const c = { select: () => c, eq: () => c, limit: () => c, in: () => c, order: () => c, range: () => c, gte: () => c,
      maybeSingle: async () => table === 'negocios' ? { data: negocio, error: negociosError } : { data: null, error: null },
      then: res => res({ data: [], error: null }) }; return c; };
    return { from: q, rpc: async () => ({ data: null, error: null }), channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      auth: { getUser: async () => ({ data: { user }, error: userError }), signOut: async () => { signOuts++; return { error: null }; },
              getSession: async () => ({ data: { session: null } }) } };
  }
  getClient = () => nube;
  function reset() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.terminal = { businessId: 'bar_borrado' };
    state.subscription = { active: true, plan: 'pro', expiresAt: '2026-12-31T00:00:00Z' };
    signOuts = 0; els['#suspendedDialog'] = undefined;
  }
  const verificar = opts => { nube = nubeFalsa(opts); return verificarNegocioEliminado(nube, 'bar_borrado'); };
`);
const userNotFound = '{ code: "user_not_found", status: 403, message: "User from sub claim in JWT does not exist" }';

(async () => {
  // 1. Las dos señales
  console.log('1. Solo bloquea con las dos señales...');
  const casos = [
    ['el negocio existe', `{ negocio: { id: 'bar_borrado' }, userError: ${userNotFound} }`],
    ['sin negocio pero la cuenta sigue viva (RLS o respuesta vacía)', `{ user: { id: 'u1' } }`],
    ['sin negocio y token vencido', `{ userError: { code: 'bad_jwt', status: 403, message: 'invalid JWT: token is expired' } }`],
    ['sin negocio y sin sesión', `{ userError: { name: 'AuthSessionMissingError', message: 'Auth session missing!' } }`],
    ['error de red al leer negocios', `{ negociosError: { message: 'Failed to fetch' }, userError: ${userNotFound} }`],
  ];
  for (const [nombre, opts] of casos) {
    run('reset();');
    assert.strictEqual(await run(`verificar(${opts})`), false, nombre);
    assert.strictEqual(get('state.subscription.deleted'), undefined, `${nombre}: no se marca`);
    assert.strictEqual(get('signOuts'), 0, `${nombre}: no cierra la sesión`);
  }
  ok('no bloquea si el negocio existe, si la cuenta sigue viva, con token vencido, sin sesión ni con error de red');
  run('reset(); globalThis.__FORCE_DEMO_MODE__ = true;');
  assert.strictEqual(await run(`verificar(${userNotFound.replace(/^/, '{ userError: ').replace(/$/, ' }')})`), false, 'modo demo');
  run('globalThis.__FORCE_DEMO_MODE__ = false;');
  ok('en modo demo nunca bloquea');

  // 2. Bloqueo
  console.log('\n2. Negocio y cuenta eliminados...');
  run(`reset(); state.orders = [{ id: 'o1', tableId: 'm1', tableName: 'Mesa 1', status: 'open', items: [{ productId: 'p', name: 'X', price: 1000, qty: 1 }] }];`);
  assert.strictEqual(await run(`verificar({ userError: ${userNotFound} })`), true);
  assert.strictEqual(get('state.subscription.deleted'), true, 'Se marca eliminado');
  assert.strictEqual(get('licenseBlockReason()'), 'eliminada', 'Motivo «eliminada»');
  assert.strictEqual(get('signOuts'), 1, 'Cierra la sesión de la terminal');
  assert.strictEqual(get('els["#suspendedDialog"].open'), true, 'El modal bloquea en el acto, aunque haya una cuenta abierta');
  assert.strictEqual(get('els["#suspendedBadge"].textContent'), 'Cuenta eliminada');
  assert.match(get('els["#suspendedMessage"].textContent'), /respaldo/, 'El mensaje ofrece descargar un respaldo');
  assert.strictEqual(get('state.orders.length'), 1, 'Los datos locales se conservan');
  assert.strictEqual(get('subscriptionInfo(state.subscription).active'), false, 'La tarjeta de licencia deja de decir activa');
  ok('motivo «eliminada», modal en el acto, sesión cerrada y datos locales intactos');

  // 3. Descarga y reactivación
  console.log('\n3. Descarga y reactivación...');
  run(`reset(); nube = nubeFalsa({ userError: ${userNotFound} });`);
  const res = await run(`pullAllFromSupabase('bar_borrado')`);
  assert.deepStrictEqual(get(`(${JSON.stringify(res)})`), { ok: false, error: 'Negocio eliminado' }, 'La descarga se detiene');
  assert.strictEqual(get('licenseBlockReason()'), 'eliminada');
  run(`applySubscriptionStatus({ id: 'bar_borrado', activo: true, plan: 'pro', fecha_vencimiento: '2026-12-31T00:00:00Z' });`);
  assert.strictEqual(get('state.subscription.deleted'), undefined, 'Si el negocio vuelve a existir se quita la marca');
  assert.strictEqual(get('licenseBlockReason()'), null, 'y la caja se desbloquea');
  ok('la descarga se detiene al detectarlo y el negocio creado de nuevo desbloquea la caja');

  console.log('\n=== TODAS LAS PRUEBAS DE NEGOCIO ELIMINADO PASARON ===');
})().catch(err => { console.error(err); process.exit(1); });
