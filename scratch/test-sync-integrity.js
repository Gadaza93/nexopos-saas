// scratch/test-sync-integrity.js
// Regresión de los hallazgos A1, A2 y A3 de la auditoría, con el código REAL (contexto vm, orden de index.html + sync.js):
// A1 · mergeRemoteOrders no pisa cambios locales pendientes ni resucita pedidos cobrados, eliminados o unidos.
// A2 · syncOnStartup sube lo pendiente antes de descargar; si la subida falla no descarga; con la cola vacía no sube.
// A3 · eliminar la factura de una parte de un cobro en partes iguales devuelve la cuota al saldo de la mesa.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: INTEGRIDAD DE SINCRONIZACIÓN Y COBROS (A1 · A2 · A3) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, closest: () => null,
    querySelector: () => mockElement(), querySelectorAll: () => [], append() {}, appendChild() {}, matches: () => false
  };
}
const document = {
  querySelector: sel => (els[sel] = els[sel] || mockElement()), querySelectorAll: () => [], addEventListener() {},
  createElement: () => mockElement(), body: mockElement(), documentElement: mockElement(), head: mockElement(), visibilityState: 'visible'
};
const memoryStorage = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const ctx = {
  console: { log() {}, warn() {}, error() {}, info() {} }, document, window: { location: { search: '' }, addEventListener() {}, confirm: () => true },
  navigator: { onLine: false }, localStorage: memoryStorage(), sessionStorage: memoryStorage(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  structuredClone, Intl, crypto: globalThis.crypto, URLSearchParams, URL, __IS_NODE_TEST__: true
};
ctx.globalThis = ctx; ctx.window.document = document;
vm.createContext(ctx);
for (const file of ['demo-mode.js', 'storage.js', 'modules.js', 'sync.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
const get = code => { const json = run(`JSON.stringify(${code})`); return json === undefined ? undefined : JSON.parse(json); };

run(`
  var toasts = [];
  renderAll = () => {}; renderOrderDialog = () => {}; showToast = m => toasts.push(String(m)); saveState = () => {}; logAudit = () => {}; can = () => true;
  globalThis.NexoSync = Object.assign(window.NexoSync || {}, { syncOrders: async () => {}, deleteActiveOrder: async () => {}, deleteSale() {}, scheduleSync() {} });
  const beer = qty => ({ productId: 'prod_beer', name: 'Cerveza', price: 6000, qty, inventoryId: 'inv_beer' });
  function reset(qty = 3) {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.cashShift = { id: 'shift_s', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.tables = [{ id: 't1', name: 'Mesa 1', zone: 'Salón' }, { id: 't2', name: 'Mesa 2', zone: 'Salón' }, { id: 't3', name: 'Mesa 3', zone: 'Salón' }];
    state.products = [{ id: 'prod_beer', name: 'Cerveza', category: 'Cervezas', price: 6000, cost: 3000, stock: 500, inventoryId: 'inv_beer' }];
    state.inventory = [{ id: 'inv_beer', name: 'Cerveza', qty: 500, min: 5, unit: 'und' }];
    state.orders = [{ id: 'o1', tableId: 't1', tableName: 'Mesa 1', status: 'open', createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000, sync_status: 'synced', items: [beer(qty)] }];
    state.currentOrderId = 'o1'; splitBillData.people = 2; splitBillData.mode = 'equal'; toasts.length = 0;
  }
  const remote = (id, tableId, qty, extra = {}) => ({ id, tableId, tableName: 'Mesa ' + tableId.slice(1), status: 'open', items: [beer(qty)], ...extra });
  function payPart(part, people) { openSplitBill(); if (people) setSplitPeopleExact(people); chargeEqualPart(part); confirmPayment(); }
  function deleteInvoice(id) { openInvoiceDelete(id); document.querySelector('#invoiceDeleteReason').value = 'Error de cobro'; document.querySelector('#invoiceRestoreStock').checked = false; confirmDeleteInvoice(); }
`);

// ---------------- A1 · mergeRemoteOrders ----------------
run(`reset(3); getOrder('o1').items[0].qty = 5; touchOrder(getOrder('o1')); mergeRemoteOrders([remote('o1', 't1', 3)]);`);
assert.strictEqual(get('getOrder("o1").items[0].qty'), 5, 'Productos agregados sin subir se conservan');
assert.strictEqual(get('getOrder("o1").sync_status'), 'pending');
console.log('   ✅ A1 · Un pedido con cambios sin subir no se pisa con la copia remota vieja (5 cervezas se mantienen).');

run(`reset(3); mergeRemoteOrders([remote('o1', 't1', 7, { updatedAt: Date.now() + 1000 })]);`);
assert.strictEqual(get('getOrder("o1").items[0].qty'), 7, 'Pedido sincronizado: la copia remota se aplica');
run(`reset(3); getOrder('o1').items[0].qty = 5; touchOrder(getOrder('o1')); mergeRemoteOrders([remote('o1', 't1', 9, { updatedAt: Date.now() + 60000 })]);`);
assert.strictEqual(get('getOrder("o1").items[0].qty'), 9, 'Una versión remota POSTERIOR al cambio local sí se aplica');
console.log('   ✅ A1 · Las copias remotas siguen aplicándose a pedidos sincronizados o cuando son posteriores al cambio local.');

run(`reset(3); openPayment(); confirmPayment(); mergeRemoteOrders([remote('o1', 't1', 3)]);`);
assert.strictEqual(get('activeOrderForTable("t1")'), undefined, 'La mesa cobrada no se reabre');
run(`cleanupOrphanOrders(); mergeRemoteOrders([remote('o1', 't1', 3)]);`);
assert.strictEqual(get('activeOrderForTable("t1")'), undefined, 'Tampoco tras limpiar el pedido pagado (queda la tumba)');
assert.ok(get('state.deleted_order_ids.o1') > 0);
console.log('   ✅ A1 · Una mesa cobrada nunca se reabre desde la nube, ni antes ni después de limpiar el pedido pagado.');

run(`reset(3); moveOrderToTable('o1', 't3'); mergeRemoteOrders([remote('o1', 't1', 3)]);`);
assert.strictEqual(get('getOrder("o1").tableId'), 't3', 'El traslado no se revierte');
run(`reset(3); state.orders.push({ id: 'o2', tableId: 't2', tableName: 'Mesa 2', status: 'open', createdAt: Date.now() - 1000, sync_status: 'synced', items: [beer(2)] });
  moveOrderToTable('o1', 't2', { confirmMerge: () => true }); mergeRemoteOrders([remote('o1', 't1', 3), remote('o2', 't2', 2)]);`);
assert.strictEqual(get('activeOrderForTable("t1")'), undefined, 'La cuenta de origen no resucita');
assert.strictEqual(get('orderTotal(activeOrderForTable("t2"))'), 30000, 'La cuenta unida conserva lo fusionado');
run(`reset(3); state.currentOrderId = 'o1'; window.confirm = () => true; deleteCurrentOrder(); mergeRemoteOrders([remote('o1', 't1', 3)]);`);
assert.strictEqual(get('getOrder("o1")'), undefined, 'Un pedido eliminado no resucita');
console.log('   ✅ A1 · Traslados, uniones y pedidos eliminados no se deshacen con copias remotas viejas.');

run(`reset(3); mergeRemoteOrders([remote('o_otra_caja', 't2', 4, { updatedAt: Date.now() })]);`);
assert.strictEqual(get('orderTotal(activeOrderForTable("t2"))'), 24000, 'Un pedido nuevo de otra caja sigue entrando');
run(`reset(3); rememberRemovedOrder('viejo', Date.now() - 4 * 24 * 3600 * 1000); rememberRemovedOrder('nuevo');`);
assert.deepStrictEqual(Object.keys(get('state.deleted_order_ids')), ['nuevo'], 'Las tumbas de más de 3 días se purgan');
run(`reset(3); rememberRemovedOrder('o9'); state = normalizeState(JSON.parse(JSON.stringify(state)));`);
assert.ok(get('state.deleted_order_ids.o9') > 0, 'Las tumbas persisten tras recargar (IndexedDB)');
console.log('   ✅ A1 · Los pedidos nuevos de otras cajas entran; las tumbas persisten al recargar y se purgan a los 3 días.');

// ---------------- A2 · syncOnStartup ----------------
(async () => {
  async function startup(setup, pushOk, pendingCount = 0) {
    run(`reset(3); ${setup}; var calls = [];
      NexoSync.getPendingCount = () => calls.includes('push') && ${pushOk} ? 0 : ${pendingCount};
      NexoSync.syncAll = async () => { calls.push('push'); if (${pushOk}) state.orders.forEach(o => { o.sync_status = 'synced'; }); return { pedidos: { ok: ${pushOk} } }; };
      NexoSync.pullAllFromSupabase = async () => { calls.push('pull'); return { ok: true, count: 2 }; };`);
    const res = await run('syncOnStartup()');
    return { calls: get('calls'), pushed: res.pushed, pulled: res.pulled };
  }
  let r = await startup(`touchOrder(getOrder('o1'))`, true);
  assert.deepStrictEqual(r.calls, ['push', 'pull']); assert.strictEqual(r.pushed, true); assert.strictEqual(r.pulled, true);
  r = await startup(`state.payments.push({ id: 'pay_offline', amount: 1, sync_status: 'pending' })`, true, 1);
  assert.deepStrictEqual(r.calls, ['push', 'pull'], 'Una venta pendiente (no un pedido) también obliga a subir primero');
  console.log('   ✅ A2 · Con pedidos o ventas pendientes, primero sube y después descarga.');
  r = await startup(`touchOrder(getOrder('o1'))`, false);
  assert.deepStrictEqual(r.calls, ['push'], 'Si la subida falla no se descarga');
  assert.strictEqual(r.pulled, false);
  r = await startup(`state.payments.push({ id: 'pay_offline', amount: 1, sync_status: 'pending' })`, false, 1);
  assert.deepStrictEqual(r.calls, ['push'], 'Si quedan ventas sin subir no se descarga');
  console.log('   ✅ A2 · Si la subida falla o quedan registros sin subir, se omite la descarga (el ciclo de NexoSync reintenta).');
  r = await startup(``, true);
  assert.deepStrictEqual(r.calls, ['pull'], 'Cola vacía (p. ej. equipo recién instalado): no sube nada, solo descarga');
  console.log('   ✅ A2 · Con la cola vacía no sube nada (un equipo nuevo no pisa el perfil ni los pedidos del negocio).');

  // ---------------- A3 · eliminar factura de una parte ----------------
  run(`reset(15); payPart(1, 3);`);
  assert.strictEqual(get('orderPending(getOrder("o1"))'), 60000);
  run(`deleteInvoice(state.payments[0].id);`);
  assert.strictEqual(get('state.payments.length'), 0);
  assert.strictEqual(get('orderPending(getOrder("o1"))'), 90000, 'La cuota vuelve al saldo de la mesa');
  assert.strictEqual(get('getOrder("o1").equalSplit'), undefined, 'Sin partes cobradas, la cuenta se puede volver a dividir');
  assert.strictEqual(get('getOrder("o1").paidAmount'), 0);
  assert.strictEqual(get('getOrder("o1").sync_status'), 'pending', 'El pedido corregido queda para subir');
  assert.ok(get('toasts').some(t => t.includes('La parte 1 de Mesa 1 vuelve a quedar pendiente')));
  console.log('   ✅ A3 · Eliminar la factura de la parte 1 devuelve $30.000 al saldo: la mesa vuelve a deber $90.000.');

  run(`reset(15); payPart(1, 3); payPart(2);`);
  run(`deleteInvoice(state.payments[0].id);`);
  assert.strictEqual(get('orderPending(getOrder("o1"))'), 60000, 'Solo vuelve la parte eliminada');
  assert.deepStrictEqual(get('getOrder("o1").equalSplit.paid.map(p => p.part)'), [2]);
  run(`payPart(1); payPart(3);`);
  assert.strictEqual(get('state.payments.reduce((s, p) => s + p.amount, 0)'), 90000, 'Se recauda el total al volver a cobrar la parte');
  assert.strictEqual(get('getOrder("o1").status'), 'paid');
  console.log('   ✅ A3 · Con varias partes cobradas, solo vuelve la eliminada; al cobrarla de nuevo se recaudan los $90.000.');

  run(`reset(15); payPart(1, 3); openPayment(); confirmPayment();`); // «Cobrar» salda las partes 2 y 3 en una factura
  run(`state.orders.find(o => o.id === 'o1').status = 'open'; state.orders.find(o => o.id === 'o1').items = [beer(15)];`); // pedido aún abierto (caso borde)
  run(`deleteInvoice(state.payments[1].id);`);
  assert.deepStrictEqual(get('getOrder("o1").equalSplit.paid.map(p => p.part)'), [1], 'Una factura que cubrió varias partes las reabre todas');
  run(`reset(15); payPart(1, 3); payPart(2); payPart(3); var closedBefore = getOrder('o1').status; deleteInvoice(state.payments[0].id);`);
  assert.strictEqual(get('closedBefore'), 'paid');
  assert.strictEqual(get('activeOrderForTable("t1")'), undefined, 'Una mesa ya cerrada no se reabre al eliminar una de sus facturas');
  console.log('   ✅ A3 · Una factura de varias partes las reabre todas; si la mesa ya se cerró, no se reabre.');

  console.log('\n=== TODAS LAS PRUEBAS DE INTEGRIDAD (A1 · A2 · A3) PASARON ===');
  process.exit(0);
})().catch(err => { console.error('❌', err); process.exit(1); });
