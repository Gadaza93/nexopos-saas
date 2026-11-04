// scratch/test-pedido-modal-y-cobro-parcial.js
// Correcciones traídas de NexoBar (operación real en barra), con el código REAL de app.js, modules.js y sync.js:
// 1. Mesa recién abierta: la limpieza de pedidos vacíos (cleanupOrphanOrders, mergeRemoteOrders) no la borra con el
//    modal abierto; antes los clics en el catálogo dejaban de responder hasta cerrar y volver a abrir.
// 2. Tocar un producto o cambiar una cantidad solo redibuja la cuenta, no la grilla (la grilla saltaba de scroll).
// 3. Dividir cuenta por productos: un cobro parcial no borra la mesa de pedidos_activos (el aviso de borrado en
//    tiempo real la daba por cobrada); sale de la nube solo con el saldo en 0.
// 4. Total por cobrar en mesas y cuentas abiertas (barra del salón).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: MODAL DE PEDIDO Y COBRO PARCIAL (código real) ===\n');

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
  createElement: () => mockElement(), body: mockElement(), documentElement: mockElement(), visibilityState: 'visible'
};
const memoryStorage = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const ctx = {
  console, document, window: { location: { search: '' }, addEventListener() {}, confirm: () => true }, navigator: { onLine: false },
  localStorage: memoryStorage(), sessionStorage: memoryStorage(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  structuredClone, Intl, crypto: globalThis.crypto, URLSearchParams, __IS_NODE_TEST__: true
};
ctx.globalThis = ctx; ctx.window.document = document; ctx.els = els;
vm.createContext(ctx);
for (const file of ['demo-mode.js', 'storage.js', 'modules.js', 'sync.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
const get = code => { const json = run(`JSON.stringify(${code})`); return json === undefined ? undefined : JSON.parse(json); };
const ok = msg => console.log(`   ✅ ${msg}`);

run(`
  var toasts = [], deletedRemote = [];
  renderAll = () => {}; showToast = msg => { toasts.push(String(msg)); };
  saveState = () => {};
  var mergeRemoteOrdersReal = mergeRemoteOrders; // la real de sync.js (NexoSync se reemplaza abajo)
  NexoSync = { syncOrders: async () => {}, deleteActiveOrder: async id => { deletedRemote.push(id); }, syncSale: async () => {} };
  function resetScenario() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.cashShift = { id: 'shift_t', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.tables = [{ id: 'm1', name: 'Mesa 1', zone: 'Salón' }, { id: 'm2', name: 'Mesa 2', zone: 'Salón' }];
    state.products = [
      { id: 'gas', name: 'Gaseosa', category: 'Bebidas', price: 4000, cost: 2000, inventoryId: 'inv_gas' },
      { id: 'jug', name: 'Jugo natural', category: 'Bebidas', price: 7000, cost: 2500, inventoryId: 'inv_jug' }
    ];
    state.inventory = state.products.map(p => ({ id: p.inventoryId, name: p.name, qty: 100, min: 5, unit: 'und' }));
    state.kitchenStations = { Bebidas: 'ninguna' };
    state.users = [{ id: 'u_cajero', name: 'Luis', role: 'cajero', active: true }]; session = 'u_cajero';
    state.currentOrderId = null; els['#orderDialog'] = undefined;
    toasts.length = 0; deletedRemote.length = 0;
  }
`);

// 1. Mesa recién abierta y limpieza de pedidos vacíos
console.log('1. Mesa recién abierta con el modal abierto...');
run(`resetScenario(); openOrder('m1');`);
assert.strictEqual(get('document.querySelector("#orderDialog").open'), true, 'El modal queda abierto');
run(`cleanupOrphanOrders(); mergeRemoteOrdersReal([], { completa: false });`);
assert.ok(get('getOrder(state.currentOrderId)'), 'La limpieza no borra el pedido vacío abierto en el modal');
run(`addProduct('gas'); addProduct('gas');`);
assert.strictEqual(get('getOrder(state.currentOrderId).items[0].qty'), 2, 'Los clics siguen sumando tras la limpieza');
ok('la limpieza de pedidos vacíos respeta la mesa abierta en el modal y los clics siguen funcionando');
run(`resetScenario(); openOrder('m2'); document.querySelector('#orderDialog').close(); cleanupOrphanOrders();`);
assert.strictEqual(get('state.orders.length'), 0, 'Con el modal cerrado el pedido vacío sí se limpia');
ok('con el modal cerrado los pedidos vacíos se siguen limpiando');

// 2. Tocar un producto no redibuja la grilla
console.log('\n2. Tocar productos solo redibuja la cuenta...');
run(`resetScenario(); openOrder('m1'); els['#productGrid'].innerHTML = 'GRILLA-INTACTA'; addProduct('jug'); changeItem('jug', 1);`);
assert.strictEqual(get('els["#productGrid"].innerHTML'), 'GRILLA-INTACTA', 'addProduct/changeItem no tocan la grilla');
assert.ok(get('els["#ticketItems"].innerHTML').includes('Jugo natural'), 'La cuenta muestra el producto');
assert.strictEqual(get('els["#orderTotal"].textContent').replace(/\D/g, ''), '14000', 'El total se actualiza');
run(`renderOrderDialog();`);
assert.notStrictEqual(get('els["#productGrid"].innerHTML'), 'GRILLA-INTACTA', 'Abrir o filtrar sí dibuja el catálogo');
ok('agregar o cambiar cantidades redibuja solo la cuenta; el catálogo se dibuja al abrir o filtrar');

// 3. Dividir cuenta por productos
console.log('\n3. Dividir cuenta: cobro parcial...');
run(`resetScenario(); openOrder('m1'); for (let i = 0; i < 5; i++) addProduct('gas');
  openSplitBill(); setSplitBillMode('items'); changeSplitItemQty('gas', 1); changeSplitItemQty('gas', 1); changeSplitItemQty('gas', 1);
  chargeSelectedSplitItems(); confirmPayment();`);
let s = get(`(() => { const o = state.orders[0]; return { status: o.status, qty: o.items[0].qty, pending: orderPending(o), invoice: state.payments[0].items.map(i => i.qty), deleted: deletedRemote.length }; })()`);
assert.strictEqual(s.status, 'open', 'Tras cobrar 3 de 5 la mesa sigue abierta');
assert.strictEqual(s.qty, 2, 'Quedan exactamente los 2 no pagados');
assert.strictEqual(s.pending, 8000, 'El saldo es lo no pagado');
assert.deepStrictEqual(s.invoice, [3], 'La factura lleva solo lo seleccionado');
assert.strictEqual(s.deleted, 0, 'Un cobro parcial no borra la mesa de la nube');
ok('cobrar 3 de 5 deja la mesa abierta con los 2 restantes y sin borrarla de la nube');
run(`openSplitBill(); setSplitBillMode('items'); selectAllSplitItems(); chargeSelectedSplitItems(); confirmPayment();`);
assert.deepStrictEqual(get('({ status: state.orders[0].status, deleted: deletedRemote.length })'), { status: 'paid', deleted: 1 }, 'Con el saldo en 0 se cierra y sale de la nube');
ok('con el saldo en 0 la mesa se cierra y sale de pedidos_activos');

// 4. Total por cobrar
console.log('\n4. Total por cobrar en el salón...');
run(`resetScenario(); openOrder('m1'); addProduct('gas'); addProduct('gas'); openOrder('m2'); addProduct('jug'); renderStats();`);
assert.deepStrictEqual(get('openOrdersSummary()'), { count: 2, total: 15000 }, 'Suma lo pendiente de las cuentas abiertas');
assert.strictEqual(get('els["#openMoneyTotal"].textContent').replace(/\D/g, ''), '15000', 'La barra del salón muestra el total');
assert.strictEqual(get('els["#openMoneyCount"].textContent'), '2 cuentas abiertas');
ok('la barra del salón suma el saldo de todas las mesas y cuentas abiertas');

console.log('\n=== TODAS LAS PRUEBAS DE MODAL DE PEDIDO Y COBRO PARCIAL PASARON ===');
