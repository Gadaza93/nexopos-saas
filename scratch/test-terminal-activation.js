// scratch/test-terminal-activation.js
// Prueba del flujo de activación de terminal (SaaS multinegocio):
// 1. NexoSync.activateTerminal: credenciales, business_id desde app_metadata, sin red y Modo Demo.
// 2. ensureTerminalLinked / linkTerminal (app.js): terminal nueva bloqueada, instalaciones antiguas respetadas.
// 1e. Contraseña temporal: activateTerminal la señala, sin cambiarla no se sincroniza y changeTemporaryPassword la cambia.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: ACTIVACIÓN DE TERMINAL ===\n');

globalThis.__FORCE_DEMO_MODE__ = false;
let authResponse = null, lastCredentials = null, currentSession = null, clientOptions = null, remoteQueries = 0, signedOut = false;
let authCalls = [], updateUserError = null, rpcError = null; // cambio de contraseña temporal
let negociosRow = { id: 'bar_900123', nombre: 'Bar Central', activo: true };
// Cadena mínima tipo PostgREST: toda consulta resuelve a lista vacía salvo negocios.maybeSingle()
function queryChain(table) {
  remoteQueries++;
  const chain = {
    select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data: table === 'negocios' ? negociosRow : null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject)
  };
  return chain;
}
globalThis.supabase = {
  createClient: (url, key, options) => {
    clientOptions = options;
    return {
      auth: {
        signInWithPassword: async creds => { lastCredentials = creds; return authResponse; },
        getSession: async () => ({ data: { session: currentSession }, error: null }),
        signOut: async () => { signedOut = true; currentSession = null; return { error: null }; },
        updateUser: async attrs => { authCalls.push(['updateUser', attrs]); return { data: {}, error: updateUserError }; },
        // El servidor ya quitó la marca: la sesión renovada trae app_metadata sin must_change_password
        refreshSession: async () => {
          authCalls.push(['refreshSession']);
          if (rpcError) return { data: { session: currentSession }, error: null };
          const { must_change_password: _m, ...meta } = currentSession.user.app_metadata;
          currentSession = { ...currentSession, user: { ...currentSession.user, app_metadata: meta } };
          return { data: { session: currentSession }, error: null };
        }
      },
      rpc: async name => { authCalls.push(['rpc', name]); return { data: !rpcError, error: rpcError }; },
      from: queryChain
    };
  }
};
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], readyState: 'complete' }; // updateIndicator
require('../storage.js'); // adaptador de sesión (authStorage)
const NexoSync = require('../sync.js');

(async () => {
  // --- 1. activateTerminal ---
  authResponse = { data: { user: { email: 'caja@bar.com', app_metadata: { business_id: 'bar_900123' }, user_metadata: {} } }, error: null };
  let res = await NexoSync.activateTerminal('caja@bar.com', 'secreta');
  assert.deepStrictEqual(res, { ok: true, businessId: 'bar_900123', email: 'caja@bar.com', mustChangePassword: false });
  assert.deepStrictEqual(lastCredentials, { email: 'caja@bar.com', password: 'secreta' });
  console.log('   ✅ Credenciales válidas devuelven el business_id de app_metadata.');

  authResponse = { data: { user: null }, error: { message: 'Invalid login credentials' } };
  res = await NexoSync.activateTerminal('caja@bar.com', 'mala');
  assert.strictEqual(res.ok, false); assert.strictEqual(res.error, 'Correo o contraseña incorrectos.');
  console.log('   ✅ Credenciales inválidas muestran un error claro.');

  authResponse = { data: { user: { email: 'x@bar.com', app_metadata: {}, user_metadata: { business_id: 'otro_negocio' } } }, error: null };
  res = await NexoSync.activateTerminal('x@bar.com', 'secreta');
  assert.strictEqual(res.ok, false);
  console.log('   ✅ Se ignora business_id en user_metadata (editable por el usuario).');

  globalThis.__FORCE_DEMO_MODE__ = true;
  res = await NexoSync.activateTerminal('caja@bar.com', 'secreta');
  assert.strictEqual(res.ok, false);
  globalThis.__FORCE_DEMO_MODE__ = false;
  console.log('   ✅ En Modo Demo no se contacta a Supabase.');

  // --- 1b. El ciclo de sincronización no arranca sin terminal vinculada ---
  globalThis.state = { profile: { syncId: 'nexopos_default' } };
  assert.strictEqual(NexoSync.isTerminalLinked(), false);
  globalThis.state.terminal = { businessId: 'bar_900123' };
  assert.strictEqual(NexoSync.isTerminalLinked(), true);
  delete globalThis.state;
  console.log('   ✅ isTerminalLinked bloquea init()/scheduleSync hasta vincular la terminal.');

  // --- 1c. La sesión de Supabase Auth persiste entre recargas ---
  assert.strictEqual(clientOptions.auth.persistSession, true);
  assert.strictEqual(clientOptions.auth.autoRefreshToken, true);
  assert.strictEqual(clientOptions.auth.storageKey, 'nexopos-auth');
  assert.strictEqual(clientOptions.auth.storage, globalThis.authStorage);
  globalThis.authStorage.setItem('nexopos-auth', '{"access_token":"x"}');
  assert.strictEqual(globalThis.authStorage.getItem('nexopos-auth'), '{"access_token":"x"}');
  globalThis.authStorage.removeItem('nexopos-auth');
  assert.strictEqual(globalThis.authStorage.getItem('nexopos-auth'), null);
  console.log('   ✅ El cliente guarda y renueva la sesión en el almacenamiento propio (nexopos-auth).');

  // --- 1d. Sin sesión no se consulta Supabase (evita caer a 'anon') ---
  globalThis.state = { profile: { syncId: 'bar_900123' }, terminal: { businessId: 'bar_900123' } };
  currentSession = null; remoteQueries = 0;
  assert.strictEqual(await NexoSync.hasAuthSession(), false);
  assert.strictEqual(await NexoSync.checkInitialConnection(), false);
  assert.strictEqual(NexoSync.getStatus().status, 'auth');
  assert.strictEqual(remoteQueries, 0);
  currentSession = { access_token: 'jwt', user: { app_metadata: { business_id: 'bar_900123' } } };
  assert.strictEqual(await NexoSync.hasAuthSession(), true);
  assert.strictEqual(await NexoSync.checkInitialConnection(), true);
  console.log('   ✅ Sin sesión no hay consultas como anon; con sesión la conexión se verifica.');

  // --- 1e. Contraseña temporal ---
  authResponse = { data: { user: { email: 'nuevo@bar.com', app_metadata: { business_id: 'bar_900123', must_change_password: true }, user_metadata: {} } }, error: null };
  res = await NexoSync.activateTerminal('nuevo@bar.com', 'Temporal123');
  assert.strictEqual(res.ok, true); assert.strictEqual(res.mustChangePassword, true);
  currentSession = { access_token: 'jwt', user: { app_metadata: { business_id: 'bar_900123', must_change_password: true } } };
  assert.strictEqual(await NexoSync.hasAuthSession(), false, 'con la marca no se sincroniza (el RLS daría listas vacías)');
  rpcError = { message: 'network' };
  res = await NexoSync.changeTemporaryPassword('MiClaveNueva1');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /no se pudo confirmar/);
  rpcError = null; updateUserError = { message: 'New password should be different from the old password.' }; authCalls = [];
  res = await NexoSync.changeTemporaryPassword('MiClaveNueva1'); // reintento: la contraseña ya había cambiado
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(authCalls.map(c => c[0] === 'rpc' ? c[1] : c[0]), ['updateUser', 'marcar_contrasena_cambiada', 'refreshSession']);
  assert.strictEqual(await NexoSync.hasAuthSession(), true, 'con la sesión renovada ya sincroniza');
  updateUserError = { message: 'Password should be at least 6 characters. Password is known to be weak' };
  res = await NexoSync.changeTemporaryPassword('123');
  assert.strictEqual(res.ok, false); assert.match(res.error, /más segura/);
  updateUserError = null;
  console.log('   ✅ Contraseña temporal: se señala al vincular, bloquea la sincronización y se cambia (con reintento seguro).');

  await NexoSync.signOutTerminal();
  assert.strictEqual(signedOut, true);
  assert.strictEqual(await NexoSync.hasAuthSession(), false);
  console.log('   ✅ signOutTerminal cierra la sesión local.');

  // --- 1e. negocios.activo controla el bloqueo por suscripción ---
  let enforced = 0;
  globalThis.enforceSubscription = () => { enforced++; };
  currentSession = { access_token: 'jwt' };
  negociosRow = { ...negociosRow, activo: false };
  await NexoSync.pullAllFromSupabase('bar_900123');
  assert.deepStrictEqual(globalThis.state.subscription.active, false);
  assert.ok(enforced >= 1);
  negociosRow = { ...negociosRow, activo: true, plan: 'pro', fecha_vencimiento: '2026-11-25T20:12:35+00:00' };
  await NexoSync.pullAllFromSupabase('bar_900123');
  assert.strictEqual(globalThis.state.subscription.active, true);
  assert.strictEqual(globalThis.state.subscription.plan, 'pro');
  assert.strictEqual(globalThis.state.subscription.expiresAt, '2026-11-25T20:12:35+00:00');
  NexoSync.applySubscriptionStatus(undefined); // columna ausente: no cambia nada
  assert.strictEqual(globalThis.state.subscription.active, true);
  delete globalThis.enforceSubscription; delete globalThis.state;
  console.log('   ✅ activo=false suspende y activo=true reactiva; sin columna no se toca el estado.');

  // --- 2. ensureTerminalLinked / linkTerminal (extraídas de app.js) ---
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('function linkTerminal'), src.indexOf('function showActivation'));
  const makeCtx = profile => {
    const ctx = { state: { profile: { name: 'Bar', ...profile } }, saves: 0 };
    ctx.scheduleSave = () => { ctx.saves++; };
    vm.createContext(ctx); vm.runInContext(block, ctx);
    return ctx;
  };

  let ctx = makeCtx({ syncId: 'nexopos_default' });
  assert.strictEqual(ctx.ensureTerminalLinked(false), false);
  assert.strictEqual(ctx.state.terminal, undefined);
  console.log('   ✅ Terminal nueva sin datos queda bloqueada hasta activarse.');

  ctx = makeCtx({ syncId: 'nexopos_default' });
  assert.strictEqual(ctx.ensureTerminalLinked(true), true);
  assert.strictEqual(ctx.state.terminal.businessId, 'nexopos_default');
  assert.strictEqual(ctx.state.terminal.legacy, true);
  console.log('   ✅ Instalación existente con datos no se bloquea (vinculación heredada).');

  ctx = makeCtx({ syncId: 'bar_555' });
  assert.strictEqual(ctx.ensureTerminalLinked(false), true);
  assert.strictEqual(ctx.state.terminal.businessId, 'bar_555');
  console.log('   ✅ Un syncId personalizado se respeta como negocio vinculado.');

  ctx = makeCtx({ syncId: 'nexopos_default' });
  ctx.linkTerminal('bar_900123', { email: 'caja@bar.com' });
  assert.strictEqual(ctx.state.profile.syncId, 'bar_900123');
  assert.strictEqual(ctx.state.terminal.email, 'caja@bar.com');
  assert.ok(ctx.state.terminal.linkedAt > 0);
  assert.strictEqual(ctx.saves, 1);
  assert.strictEqual(ctx.ensureTerminalLinked(false), true);
  console.log('   ✅ linkTerminal guarda el negocio en el estado y fija profile.syncId.');

  // --- 3. Licencia en Mi negocio y aviso preventivo (subscriptionInfo, extraída de app.js) ---
  const subBlock = src.slice(src.indexOf('const SUBSCRIPTION_WARN_DAYS'), src.indexOf('function renderSubscription'));
  const subCtx = { Intl, Date, Math, Number, Boolean }; vm.createContext(subCtx); vm.runInContext(subBlock, subCtx);
  const now = Date.parse('2026-11-22T12:00:00-05:00'), day = 86400000;
  let info = subCtx.subscriptionInfo({ active: true, plan: 'pro', expiresAt: '2026-11-25T12:00:00-05:00' }, now);
  assert.strictEqual(info.plan, 'Plan Pro');
  assert.strictEqual(info.expiryLabel, '25 de noviembre de 2026');
  assert.strictEqual(info.banner.text, 'Tu suscripción vence en 3 días. Comunícate con soporte para renovar tu servicio.');
  assert.strictEqual(info.banner.urgent, false);
  assert.strictEqual(subCtx.subscriptionInfo({ active: true, expiresAt: new Date(now + day).toISOString() }, now).banner.text.startsWith('Tu suscripción vence en 1 día.'), true);
  assert.strictEqual(subCtx.subscriptionInfo({ active: true, expiresAt: new Date(now + 4 * day).toISOString() }, now).banner, null);
  assert.strictEqual(subCtx.subscriptionInfo({ active: false, expiresAt: new Date(now + day).toISOString() }, now).banner, null);
  assert.strictEqual(subCtx.subscriptionInfo(null, now).known, false);
  console.log('   ✅ Licencia: «Plan Pro», «25 de noviembre de 2026» y aviso solo si está activa y faltan ≤ 3 días.');

  console.log('\n=== TODAS LAS PRUEBAS DE ACTIVACIÓN PASARON ===');
  process.exit(0);
})().catch(err => { console.error('❌', err); process.exit(1); });
