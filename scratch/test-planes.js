// scratch/test-planes.js
// Funciones por plan (planes.js) con el código REAL de app.js, modules.js y sync.js:
// 1. El plan sale de state.subscription.plan (negocios.plan); sin plan conocido o en demo rige el Pro.
// 2. Plan Básico: máximo 10 mesas o barras (agregar y guardar), sin plano interactivo ni arrastre en el diseñador.
// 3. Plan Básico: sin utilidad neta, valoración de inventario, exportaciones ni gastos; un solo usuario administrador.
// 4. Un negocio que baja de plan conserva sus mesas y usuarios, pero no suma otros; el cambio llega por sincronización.
// 5. Panel superadmin: el botón de plan envía p_plan a admin_update_negocio_status.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: FUNCIONES POR PLAN (BÁSICO / PRO) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '', href: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, closest: () => null, click() {}, scrollIntoView() {},
    querySelector: () => mockElement(), querySelectorAll: () => [], append() {}, appendChild() {}, matches: () => false,
    setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 })
  };
}
const document = {
  querySelector: sel => (els[sel] = els[sel] || mockElement()), querySelectorAll: () => [],
  addEventListener() {}, createElement: () => mockElement(), body: mockElement(), documentElement: mockElement(), visibilityState: 'visible'
};
const memoryStorage = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const ctx = {
  console, document, window: { location: { search: '' }, addEventListener() {}, confirm: () => true }, navigator: { onLine: false },
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
run(`var toasts = [], descargas = []; showToast = m => toasts.push(String(m)); logAudit = () => {}; saveState = () => {}; renderAll = () => {};
  downloadBlob = (blob, name) => descargas.push(name); window.print = () => descargas.push('print');
  function fresh(plan) {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.subscription = plan === undefined ? undefined : { active: true, plan };
    floorDraft = null; floorDirty = false; floorSelected = null; floorDrag = null; toasts.length = 0; descargas.length = 0;
    session = state.users.find(u => u.role === 'admin').id;
    document.querySelector('#planUpgradeDialog').open = false;
  }`);
const modalAbierto = () => run(`document.querySelector('#planUpgradeDialog').open`);
const cerrarModal = () => run(`document.querySelector('#planUpgradeDialog').open = false`);
let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };

// --- 1. Origen del plan ---
run('fresh();');
assert.strictEqual(run('currentPlan()'), 'pro', 'sin plan conocido: Pro (ningún negocio pierde funciones antes de sincronizar)');
run('fresh("basico");'); assert.strictEqual(run('currentPlan()'), 'basico');
run('fresh("Básico");'); assert.strictEqual(run('currentPlan()'), 'basico', 'con tilde o mayúscula');
run('fresh("pro");'); assert.strictEqual(run('currentPlan()'), 'pro');
run('fresh("plan_raro");'); assert.strictEqual(run('currentPlan()'), 'pro', 'un valor desconocido no bloquea');
run('fresh("basico"); globalThis.__FORCE_DEMO_MODE__ = true;'); assert.strictEqual(run('currentPlan()'), 'pro', 'el demo muestra todo');
run('globalThis.__FORCE_DEMO_MODE__ = false;');
assert.strictEqual(run('subscriptionInfo({ active: true, plan: "basico" }).plan'), 'Plan Básico');
ok('el plan sale de negocios.plan (state.subscription); sin plan conocido, valor desconocido o en demo rige el Pro');

// --- 2. Límite de 10 mesas ---
run('fresh("basico");');
assert.strictEqual(get('state.tables.length'), 10, 'el estado inicial trae justo 10 elementos');
run('addFloorItem("mesa");');
assert.strictEqual(get('floorTables().length'), 10, 'la 11.ª mesa no se agrega');
assert.ok(modalAbierto(), 'se abre el modal «Mejora tu plan a PRO»');
cerrarModal(); run('addFloorItem("mostrador");'); assert.strictEqual(get('floorTables().length'), 10, 'tampoco una barra');
run('floorSelected = "m1"; deleteFloorItem(); addFloorItem("mesa");');
assert.strictEqual(get('floorTables().length'), 10, 'quitando una se puede agregar otra');
// Un borrador con 11 (manipulado) no se guarda
run('fresh("basico"); beginFloorDraft().push({ id: "extra", name: "Mesa 99", zone: "Salón", tipo: "mesa", posX: 50, posY: 50 }); floorDirty = true; saveFloorLayout();');
assert.strictEqual(get('state.tables.length'), 10, 'saveFloorLayout también valida el límite');
assert.ok(modalAbierto());
// Pro: sin límite
run('fresh("pro"); addFloorItem("mesa"); addFloorItem("mesa"); saveFloorLayout();');
assert.strictEqual(get('state.tables.length'), 12);
// Bajó de Pro a Básico con 12: conserva, renombra, no agrega
run('state.subscription.plan = "basico"; floorSelected = state.tables[0].id; updateFloorSelected({ name: "Barra VIP" }); saveFloorLayout();');
assert.strictEqual(get('state.tables[0].name'), 'Barra VIP', 'con más mesas que el límite puede editar las que tiene');
run('addFloorItem("mesa");'); assert.strictEqual(get('floorTables().length'), 12, 'pero no agregar');
ok('Plan Básico: la 11.ª mesa o barra se bloquea con el modal (al agregar y al guardar); Pro sin límite; al bajar de plan se conservan');

// --- 3. Plano interactivo y arrastre ---
run('fresh("basico"); setTableView("plano");');
assert.strictEqual(run('tableViewMode()'), 'grid', 'el salón se ve en cuadrícula aunque la preferencia sea el plano');
run('fresh("pro");'); assert.strictEqual(run('tableViewMode()'), 'plano', 'con Pro vuelve la preferencia guardada');
run('fresh("basico"); var antes; function mockEl() { return document.createElement("div"); }');
run('const t2 = beginFloorDraft()[0]; antes = [t2.posX, t2.posY]; floorDrag = { id: t2.id, el: mockEl(), rect: { width: 800, height: 500 }, x0: 0, y0: 0, px: t2.posX, py: t2.posY, moved: false, pointerId: 1 }; handleFloorPointerMove({ pointerId: 1, clientX: 120, clientY: 80 });');
assert.deepStrictEqual(get('[floorDraft[0].posX, floorDraft[0].posY]'), get('antes'), 'arrastrar no mueve la mesa');
assert.strictEqual(run('floorDrag'), null, 'el arrastre se cancela');
assert.ok(modalAbierto());
run('fresh("pro"); const t3 = beginFloorDraft()[0]; antes = [t3.posX, t3.posY]; floorDrag = { id: t3.id, el: mockEl(), rect: { width: 800, height: 500 }, x0: 0, y0: 0, px: t3.posX, py: t3.posY, moved: false, pointerId: 1 }; handleFloorPointerMove({ pointerId: 1, clientX: 120, clientY: 80 });');
assert.notDeepStrictEqual(get('[floorDraft[0].posX, floorDraft[0].posY]'), get('antes'), 'con Pro sí se mueve');
ok('Plan Básico: el salón se ve en cuadrícula y el diseñador no deja arrastrar mesas; con Pro ambos funcionan');

// --- 4. Reportes, exportaciones y gastos ---
run('fresh("basico"); reportTab = "net"; applyReportTab();'); assert.strictEqual(run('reportTab'), 'summary', 'utilidad neta bloqueada');
run('reportTab = "inventory"; applyReportTab();'); assert.strictEqual(run('reportTab'), 'summary', 'valoración bloqueada');
run('exportReportXlsx(); exportInventoryXlsx(); printReport();');
assert.deepStrictEqual(get('descargas'), [], 'ninguna exportación ni impresión');
assert.ok(modalAbierto());
run('fresh("pro"); reportTab = "summary"; exportReportXlsx();'); assert.strictEqual(get('descargas').length, 1, 'con Pro se exporta');
run('fresh("pro"); reportTab = "net"; applyReportTab();'); assert.strictEqual(run('reportTab'), 'net');
// Gastos: el guard de initModules envuelve openExpenseDialog y saveExpense
run(`var gastoAbierto = 0; openExpenseDialog = () => { gastoAbierto++; }; planGuard('openExpenseDialog', 'expenses');`);
run('fresh("basico"); openExpenseDialog();'); assert.strictEqual(run('gastoAbierto'), 0); assert.ok(modalAbierto());
run('fresh("pro"); openExpenseDialog();'); assert.strictEqual(run('gastoAbierto'), 1);
assert.match(fs.readFileSync(path.join(ROOT, 'modules.js'), 'utf8'), /\['openExpenseDialog', 'saveExpense'\]\.forEach\(n => planGuard\(n, 'expenses'\)\)/, 'initModules protege el registro de gastos');
assert.match(fs.readFileSync(path.join(ROOT, 'modules.js'), 'utf8'), /^\s*guard\('deleteCurrentOrder', 'cancelOrder'\);/m, 'el permiso de anular pedidos sigue activo');
ok('Plan Básico: sin utilidad neta, valoración, exportaciones a Excel/PDF ni registro de gastos (abre el modal); Pro sí');

// --- 5. Un solo usuario administrador ---
run('fresh("basico");');
run('openUserDialog();'); assert.ok(modalAbierto(), 'no se crea un segundo usuario'); cerrarModal();
run(`editingUserId = null; document.querySelector('#userName').value = 'Pedro'; document.querySelector('#userRole').value = 'cajero'; document.querySelector('#userPin').value = '1111'; document.querySelector('#userActive').checked = true; saveUser();`);
assert.strictEqual(get('state.users.length'), 1, 'saveUser también valida (sin pasar por el botón)');
const adminId = get('state.users[0].id');
run(`openUserDialog(${JSON.stringify(adminId)}); document.querySelector('#userName').value = 'Dueño'; document.querySelector('#userRole').value = 'admin'; document.querySelector('#userPin').value = ''; document.querySelector('#userActive').checked = true; saveUser();`);
assert.strictEqual(get('state.users[0].name'), 'Dueño', 'el administrador sí se edita');
// Negocio que bajó de plan con un cajero: no entra, se le muestra el candado; el admin sí
run(`fresh("pro"); const caj = newUser('Caja 1', 'cajero', '2222'); state.users.push(caj); state.subscription.plan = 'basico'; loginTarget = caj.id; loginPin = '2222'; session = null; attemptLogin();`);
assert.strictEqual(run('session'), null, 'el cajero no inicia sesión en el Plan Básico');
assert.ok(modalAbierto());
run(`renderLogin();`); assert.match(run(`document.querySelector('#loginUsers').innerHTML`), /login-user plan-locked[^>]*>.*Caja 1.*PRO/, 'el cajero aparece con candado PRO');
run(`state.subscription.plan = 'pro'; loginTarget = state.users.find(u => u.name === 'Caja 1').id; loginPin = '2222'; attemptLogin();`);
assert.strictEqual(get('me()?.name'), 'Caja 1', 'con Pro entra');
ok('Plan Básico: un solo usuario administrador (crear, asignar rol e iniciar sesión se bloquean); Pro con roles');

// --- 6. Cambio de plan por sincronización ---
run(`var loginMostrado = 0; const _showLogin = showLogin; showLogin = () => { loginMostrado++; session = null; };`);
run(`state.subscription = { active: true, plan: 'pro' }; applySubscriptionStatus({ activo: true, plan: 'basico' });`);
assert.strictEqual(run('state.subscription.plan'), 'basico');
assert.strictEqual(run('loginMostrado'), 1, 'el cajero en sesión vuelve al inicio de sesión');
run(`applySubscriptionStatus({ activo: true, plan: 'basico' });`); assert.strictEqual(run('loginMostrado'), 1, 'sin cambio no repite');
const syncSrc = fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8');
assert.match(syncSrc, /table: "negocios", filter[\s\S]{0,800}applySubscriptionStatus\(row\)/, 'el tiempo real de negocios aplica el plan');
ok('el plan llega al descargar y en tiempo real; si pasa a Básico con un cajero en sesión, se pide el administrador');

// --- 7. Enlace de mejora y panel superadmin ---
run('fresh("basico"); state.profile.name = "Bar Luna";');
const url = run('planUpgradeUrl("tables")');
assert.match(decodeURIComponent(url), /Bar Luna.*Plan Pro.*Mesas ilimitadas/);
assert.ok(url.startsWith('https://wa.me/573052484278?text='), 'abre el chat de la línea de soporte');
assert.ok(run('getNetxpremiumWhatsappUrl()').startsWith('https://wa.me/573052484278?text='), 'el modal del demo usa la misma línea');
global.__IS_NODE_TEST__ = true;
const admin = require('../admin.js');
assert.deepStrictEqual(admin.statusPayload({ id: 'bar_x', activo: true, plan: 'pro' }, { plan: admin.otherPlan('pro') }), { p_negocio_id: 'bar_x', p_activo: true, p_plan: 'basico', p_extender_dias: 0 });
assert.strictEqual(admin.otherPlan('basico'), 'pro');
assert.deepStrictEqual(admin.statusPayload({ id: 'bar_x', activo: false, plan: 'basico' }, { extenderDias: 30 }).p_plan, 'basico', 'extender días conserva el plan');
ok('el modal enlaza a WhatsApp con el negocio y la función; el panel superadmin cambia el plan con admin_update_negocio_status');

console.log(`\n${pasadas} PRUEBAS SUPERADAS`);
process.exit(0);
