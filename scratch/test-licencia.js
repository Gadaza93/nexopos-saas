// scratch/test-licencia.js
// Vencimiento de la licencia sin depender del reloj del equipo (app.js, bloque de suscripción):
// 1. Sin hora del servidor (SQL sin aplicar) solo bloquea activo=false, como antes.
// 2. Reloj atrasado más de 1 h tras verificar → «reloj»; ajustes menores no bloquean.
// 3. Vencida: 3 días de gracia medidos con la hora del servidor, aunque el reloj local esté mal.
// 4. Más de 7 días sin verificar → «sin-verificar». Volver a verificar desbloquea.
// 5. activo=false: «suspendida» o «vencida» según la fecha.
// 6. En uso, lo detectado por el equipo espera a que no haya cuentas abiertas; al arrancar bloquea siempre.
// 7. sync.js: la descarga registra la hora del servidor (hora_servidor) y sin la función no falla.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: LICENCIA Y RELOJ DEL EQUIPO ===\n');

const DAY = 86400000, HOUR = 3600000;
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const block = src.slice(src.indexOf('/* ---------- Suscripción del negocio'), src.indexOf('async function retrySubscriptionCheck'));
assert.ok(block.includes('function licenseBlockReason'), 'bloque de licencia encontrado');

function el() {
  return { textContent: '', open: false, children: [], replaceChildren(...c) { this.children = c; this.textContent = c.map(x => typeof x === 'string' ? x : x.textContent).join(''); },
    showModal() { this.open = true; }, close() { this.open = false; } };
}
const now = Date.parse('2026-10-28T20:00:00Z');
function makeCtx(subscription, orders = []) {
  const clock = { t: now };
  class FakeDate extends Date { static now() { return clock.t; } } // reloj del equipo controlado por la prueba
  const els = { '#suspendedDialog': el(), '#suspendedBadge': el(), '#suspendedTitle': el(), '#suspendedMessage': el(), '#suspendedRetry': el() };
  const other = el(); other.open = true;
  const ctx = {
    Date: FakeDate, clock, Math, Number, String, Array, Object, Boolean, Intl,
    state: { subscription, orders }, session: 'u1', saves: 0, toasts: [],
    isDemoMode: () => false,
    subscriptionDateFmt: new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }),
    showLogin() {}, els, other,
    document: { querySelector: s => els[s] || null, querySelectorAll: s => (s === 'dialog[open]' ? [els['#suspendedDialog'], other].filter(d => d.open) : []), createElement: () => el() },
  };
  ctx.scheduleSave = () => { ctx.saves++; };
  ctx.showToast = t => ctx.toasts.push(t);
  vm.createContext(ctx); vm.runInContext(block, ctx);
  return ctx;
}

let passed = 0;
const ok = msg => { passed++; console.log(`  ✓ ${msg}`); };
// El reloj del equipo marca t: tanto la consulta como enforceSubscription lo ven
const reason = (ctx, t) => { ctx.clock.t = t; return ctx.licenseBlockReason(); };
const register = (ctx, server, local) => { ctx.clock.t = local; ctx.registerLicenseCheck(server, local); };
const vence = new Date(now + 30 * DAY).toISOString();

// 1. Sin hora del servidor
let ctx = makeCtx({ active: true, plan: 'pro', expiresAt: new Date(now - 30 * DAY).toISOString() });
assert.strictEqual(reason(ctx, now), null);
assert.strictEqual(reason(makeCtx({ active: false }), now), 'suspendida');
assert.strictEqual(reason(makeCtx(undefined), now), null);
ok('sin hora del servidor (SQL sin aplicar) solo bloquea activo=false, como antes');

// 2. Reloj atrasado
ctx = makeCtx({ active: true, plan: 'pro', expiresAt: vence });
register(ctx, now, now);
assert.strictEqual(ctx.state.subscription.verifiedAt, now);
assert.strictEqual(reason(ctx, now - 30 * 60000), null, 'un ajuste de 30 min no bloquea');
assert.strictEqual(reason(ctx, now + 2 * HOUR), null);
assert.strictEqual(reason(ctx, now - 365 * DAY), 'reloj', 'atrasar un año bloquea');
ok('reloj atrasado un año → «reloj»; un ajuste de 30 minutos no bloquea');

// El máximo visto avanza con el uso: atrasar a la hora de la verificación después de 3 días también se detecta
ctx = makeCtx({ active: true, plan: 'pro', expiresAt: vence });
register(ctx, now, now);
assert.strictEqual(reason(ctx, now + 3 * DAY), null);
assert.strictEqual(ctx.state.subscription.localMax, now + 3 * DAY, 'se guarda el máximo visto');
assert.ok(ctx.saves > 0);
assert.strictEqual(reason(ctx, now + 1 * DAY), 'reloj');
ok('el máximo visto se guarda con el uso: volver atrás dos días también bloquea');

// 3. Vencida con 3 días de gracia, medida con la hora del servidor
const vencida = new Date(now - 2 * DAY).toISOString();
ctx = makeCtx({ active: true, plan: 'pro', expiresAt: vencida });
register(ctx, now, now);
assert.strictEqual(reason(ctx, now), null, 'dentro de la gracia');
assert.strictEqual(reason(ctx, now + 2 * DAY), 'vencida', 'pasada la gracia');
// Equipo con el reloj un año atrasado DESDE ANTES de verificar: la diferencia con el servidor corrige la fecha
const localAtrasado = now - 365 * DAY;
ctx = makeCtx({ active: true, plan: 'pro', expiresAt: vencida });
register(ctx, now, localAtrasado);
assert.strictEqual(reason(ctx, localAtrasado + 2 * DAY), 'vencida', 'se mide con la hora del servidor, no con la del equipo');
ok('vencida: 3 días de gracia, medidos con la hora del servidor aunque el reloj local esté un año atrás');

// 4. Sin verificar
ctx = makeCtx({ active: true, plan: 'pro', expiresAt: vence });
register(ctx, now, now);
assert.strictEqual(reason(ctx, now + 6 * DAY), null);
assert.strictEqual(reason(ctx, now + 8 * DAY), 'sin-verificar');
register(ctx, now + 8 * DAY, now + 8 * DAY);
assert.strictEqual(reason(ctx, now + 8 * DAY), null, 'volver a verificar desbloquea');
ok('más de 7 días sin verificar → «sin-verificar»; verificar de nuevo desbloquea');

// 5. activo=false
ctx = makeCtx({ active: false, expiresAt: vence });
assert.strictEqual(reason(ctx, now), 'suspendida');
ctx = makeCtx({ active: false, expiresAt: vencida });
assert.strictEqual(reason(ctx, now), 'vencida');
ok('activo=false: «suspendida», o «vencida» si ya pasó la fecha');

// 6. Modal: en uso espera a que no haya cuentas abiertas; al arrancar bloquea siempre
const abierta = [{ id: 'o1', status: 'open', items: [{ qty: 2 }] }];
ctx = makeCtx({ active: true, plan: 'pro', expiresAt: new Date(now - 10 * DAY).toISOString() }, abierta);
register(ctx, now, now); // llama a enforceSubscription
const dialog = ctx.els['#suspendedDialog'];
assert.strictEqual(dialog.open, false, 'con una cuenta abierta no corta el servicio');
assert.strictEqual(ctx.other.open, true);
ctx.enforceSubscription({ startup: true });
assert.strictEqual(dialog.open, true, 'al arrancar bloquea aunque haya cuentas abiertas');
assert.strictEqual(ctx.other.open, false, 'cierra los demás diálogos');
assert.strictEqual(ctx.els['#suspendedBadge'].textContent, 'Licencia vencida');
assert.ok(ctx.els['#suspendedMessage'].textContent.startsWith('Tu plan venció el '), ctx.els['#suspendedMessage'].textContent);
ok('vencida en uso: espera a que no haya cuentas abiertas; al arrancar bloquea con el texto «Licencia vencida»');

ctx = makeCtx({ active: true, plan: 'pro', expiresAt: new Date(now - 10 * DAY).toISOString() }, []);
register(ctx, now, now);
assert.strictEqual(ctx.els['#suspendedDialog'].open, true, 'sin cuentas abiertas bloquea en el acto');
ctx = makeCtx({ active: false, expiresAt: vence }, abierta);
ctx.enforceSubscription();
assert.strictEqual(ctx.els['#suspendedDialog'].open, true, 'la suspensión en la nube bloquea en el acto');
assert.strictEqual(ctx.els['#suspendedTitle'].textContent, 'Suscripción suspendida');
// Renovada: al verificar de nuevo se cierra
ctx.state.subscription.active = true; ctx.enforceSubscription();
assert.strictEqual(ctx.els['#suspendedDialog'].open, false);
assert.deepStrictEqual(ctx.toasts, ['Licencia verificada. ¡Bienvenido de nuevo!']);
ok('sin cuentas abiertas o con suspensión en la nube bloquea en el acto; al renovar se cierra');

// 7. sync.js registra la hora del servidor en la descarga
(async () => {
  global.window = global;
  global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, readyState: 'complete' };
  global.navigator = { onLine: true };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.scheduleSave = () => {}; global.renderAll = () => {}; global.showToast = () => {};
  global.__FORCE_DEMO_MODE__ = false;
  let rpcMode = 'ok', registered = [];
  const chain = table => {
    const q = { select: () => q, eq: () => q, in: () => q, gt: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: table === 'negocios' ? { id: 'bar_1', nombre: 'Bar', activo: true, configuracion: {} } : null, error: null }),
      then: (a, b) => Promise.resolve({ data: [], error: null }).then(a, b) };
    return q;
  };
  global.supabase = { createClient: () => ({
    from: chain,
    rpc: async name => name !== 'hora_servidor' ? { data: null, error: null }
      : rpcMode === 'ok' ? { data: '2026-10-28T20:00:00.123+00:00', error: null }
      : { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.hora_servidor' } },
  }) };
  global.registerLicenseCheck = t => registered.push(t);
  const NexoSync = require('../sync.js');
  global.state = { profile: { syncId: 'bar_1' }, terminal: { businessId: 'bar_1' }, products: [], inventory: [], categories: [], payments: [], expenses: [], purchases: [], suppliers: [], stockLog: [], orders: [] };
  let r = await NexoSync.pullAllFromSupabase('bar_1');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(registered, [Date.parse('2026-10-28T20:00:00.123Z')]);
  rpcMode = 'missing'; registered = [];
  r = await NexoSync.pullAllFromSupabase('bar_1');
  assert.strictEqual(r.ok, true, 'sin la función hora_servidor la descarga sigue');
  assert.deepStrictEqual(registered, []);
  ok('la descarga registra hora_servidor; sin la función (SQL sin aplicar) sigue igual que antes');

  console.log(`\n${passed} PRUEBAS SUPERADAS`);
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
