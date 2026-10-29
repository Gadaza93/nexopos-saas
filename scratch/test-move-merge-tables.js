// scratch/test-move-merge-tables.js
// Traslado y unión de mesas con el código REAL de app.js/modules.js (contexto vm, orden de index.html):
// 1. Traslado a mesa libre: conserva productos (y un cobro en partes en curso) y libera la mesa de origen.
// 2. Unión con mesa ocupada: suma ítems repetidos, recalcula el total y elimina el pedido de origen.
// 3. Bloqueo de la unión si alguna cuenta tiene un cobro en partes iguales a medias.
// 4. Persistencia (IndexedDB vía saveState) y marcas de sincronización (NexoSync).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: MOVER Y UNIR MESAS (código real) ===\n');

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
ctx.globalThis = ctx; ctx.window.document = document;
vm.createContext(ctx);
for (const file of ['demo-mode.js', 'storage.js', 'modules.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
// Valores del contexto vm comparables con assert (undefined se conserva: «el pedido ya no existe»)
const get = code => { const json = run(`JSON.stringify(${code})`); return json === undefined ? undefined : JSON.parse(json); };

run(`
  var toasts = [], syncCalls = [], saves = 0;
  var realRenderOrderDialog = renderOrderDialog; // algunas secciones la sustituyen por un stub
  renderAll = () => {}; showToast = msg => { toasts.push(String(msg)); };
  saveState = () => { saves++; };
  NexoSync = { syncOrders: async () => { syncCalls.push('syncOrders'); }, deleteActiveOrder: async id => { syncCalls.push('delete:' + id); } };
  const line = (id, name, price, qty) => ({ productId: id, name, price, qty, cost: Math.round(price / 2), inventoryId: 'inv_' + id });
  function resetScenario() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.cashShift = { id: 'shift_t', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.tables = [
      { id: 't1', name: 'Mesa 1', zone: 'Salón' }, { id: 't2', name: 'Mesa 2', zone: 'Salón' },
      { id: 't3', name: 'Mesa 3', zone: 'Terraza' }, { id: 't4', name: 'Mesa 4', zone: 'Terraza' }
    ];
    state.orders = [
      { id: 'o1', tableId: 't1', tableName: 'Mesa 1', status: 'open', createdAt: 1000, note: 'Sin hielo', sync_status: 'synced',
        items: [line('cer', 'Cerveza', 6000, 3), line('agu', 'Aguardiente', 39000, 1)] },
      { id: 'o2', tableId: 't2', tableName: 'Mesa 2', status: 'open', createdAt: 2000, sync_status: 'synced',
        items: [line('cer', 'Cerveza', 6000, 2), line('pap', 'Papas', 3000, 1)] },
      { id: 'o_empty', tableId: 't3', tableName: 'Mesa 3', status: 'open', createdAt: 3000, items: [] },
      { id: 'o_bar', tableId: 'walkin', tableName: 'Venta en barra', status: 'open', createdAt: 4000, items: [line('cer', 'Cerveza', 6000, 1)] },
      { id: 'o_custom', tableId: 'custom_1', tableName: 'Juan', isCustom: true, status: 'open', createdAt: 5000, items: [line('cer', 'Cerveza', 6000, 1)] }
    ];
    state.currentOrderId = 'o1';
    toasts.length = 0; syncCalls.length = 0; saves = 0;
  }
  function tableStatus() { return Object.fromEntries(state.tables.map(t => [t.id, activeOrderForTable(t.id)?.id || 'libre'])); }
`);

// --- 1. Traslado a mesa libre ---
run('resetScenario();');
let targets = get('(() => { const t = moveTargets(getOrder("o1")); return { free: t.free.map(x => x.id), occupied: t.occupied.map(x => x.table.id) }; })()');
assert.deepStrictEqual(targets, { free: ['t3', 't4'], occupied: ['t2'] }, 'Libres y ocupadas, sin la mesa actual');
let r = get('moveOrderToTable("o1", "t3")');
assert.strictEqual(r.ok, true); assert.strictEqual(r.mode, 'move');
let o1 = get('getOrder("o1")');
assert.strictEqual(o1.tableId, 't3'); assert.strictEqual(o1.tableName, 'Mesa 3');
assert.deepStrictEqual(o1.items.map(i => [i.name, i.qty]), [['Cerveza', 3], ['Aguardiente', 1]]);
assert.strictEqual(o1.sync_status, 'pending');
assert.deepStrictEqual(get('tableStatus()'), { t1: 'libre', t2: 'o2', t3: 'o1', t4: 'libre' });
assert.strictEqual(get('getOrder("o_empty")'), undefined, 'El pedido vacío abierto en la mesa destino se descarta');
assert.strictEqual(get('state.currentOrderId'), 'o1');
assert.ok(run('saves') >= 1, 'Se guarda en IndexedDB');
assert.deepStrictEqual(get('syncCalls'), ['syncOrders'], 'Traslado: solo se sincronizan los pedidos (mismo id, nueva mesa)');
console.log('   ✅ Traslado a mesa libre: mismos productos e id, origen libre, destino ocupado, guardado y marcado para Supabase.');

// Traslado con un cobro en partes iguales en curso: el reparto viaja intacto
run(`resetScenario(); renderOrderDialog = () => {};
  openSplitBill(); setSplitPeopleExact(3); chargeEqualPart(1); confirmPayment();`);
const splitBefore = get('getOrder("o1").equalSplit');
r = get('moveOrderToTable("o1", "t4")');
assert.strictEqual(r.ok, true); assert.strictEqual(r.mode, 'move');
assert.deepStrictEqual(get('getOrder("o1").equalSplit'), splitBefore, 'El reparto (partes cobradas) se conserva');
assert.strictEqual(get('getOrder("o1").tableId'), 't4');
run('openSplitBill(); chargeEqualPart(2); confirmPayment(); openSplitBill(); chargeEqualPart(3); confirmPayment();');
assert.strictEqual(get('state.payments.reduce((s, p) => s + p.amount, 0)'), 57000);
assert.strictEqual(get('getOrder("o1").status'), 'paid');
console.log('   ✅ Traslado con cobro en partes a medias: el reparto se conserva y se termina de cobrar en la mesa nueva ($57.000).');

// --- 2. Unión con mesa ocupada ---
run('resetScenario(); var confirmMessages = [];');
r = get('moveOrderToTable("o1", "t2", { confirmMerge: msg => { confirmMessages.push(msg); return true; } })');
assert.strictEqual(r.ok, true); assert.strictEqual(r.mode, 'merge');
assert.deepStrictEqual(get('confirmMessages'), ['¿Deseas unir la cuenta de Mesa 1 con Mesa 2? Se combinarán los consumos en una sola cuenta.']);
const o2 = get('getOrder("o2")');
assert.deepStrictEqual(o2.items.map(i => [i.name, i.qty]), [['Cerveza', 5], ['Papas', 1], ['Aguardiente', 1]], 'Cerveza 2+3 sumadas; Aguardiente como línea nueva');
assert.strictEqual(get('orderTotal(getOrder("o2"))'), 72000, 'Total recalculado: 5×6.000 + 3.000 + 39.000');
assert.strictEqual(o2.note, 'Mesa 1: Sin hielo');
assert.strictEqual(o2.createdAt, 1000, 'La mesa unida conserva la hora de llegada más antigua');
assert.strictEqual(o2.sync_status, 'pending');
assert.strictEqual(get('getOrder("o1")'), undefined, 'El pedido de origen se elimina');
assert.deepStrictEqual(get('tableStatus()'), { t1: 'libre', t2: 'o2', t3: 'libre', t4: 'libre' });
assert.strictEqual(get('state.currentOrderId'), 'o2', 'Queda cargada la mesa destino');
assert.deepStrictEqual(get('syncCalls'), ['delete:o1', 'syncOrders'], 'Se borra el pedido origen en Supabase y se sincroniza el destino');
console.log('   ✅ Unión: Cerveza 3+2 = 5, Aguardiente como línea nueva, total $72.000, origen eliminado y libre.');

// Cancelar la confirmación no cambia nada
run('resetScenario();');
const before = get('state.orders');
r = get('moveOrderToTable("o1", "t2", { confirmMerge: () => false })');
assert.strictEqual(r.cancelled, true);
assert.deepStrictEqual(get('state.orders'), before); assert.deepStrictEqual(get('syncCalls'), []);
// Mismo producto con precio distinto: línea aparte (no altera importes)
run('resetScenario(); getOrder("o2").items[0].price = 6500;');
run('moveOrderToTable("o1", "t2", { confirmMerge: () => true });');
assert.deepStrictEqual(get('getOrder("o2").items.map(i => [i.name, i.price, i.qty])'), [['Cerveza', 6500, 2], ['Papas', 3000, 1], ['Cerveza', 6000, 3], ['Aguardiente', 39000, 1]]);
assert.strictEqual(get('orderTotal(getOrder("o2"))'), 13000 + 3000 + 18000 + 39000);
console.log('   ✅ Cancelar no cambia nada; un mismo producto con precio distinto queda en línea aparte sin alterar el total.');

// --- 3. Bloqueo de la unión con cobro en partes iguales a medias ---
run(`resetScenario(); renderOrderDialog = () => {};
  openSplitBill(); setSplitPeopleExact(3); chargeEqualPart(1); confirmPayment();`); // Mesa 1 con una parte cobrada
const ordersBlocked = get('state.orders');
r = get('moveOrderToTable("o1", "t2", { confirmMerge: () => { throw new Error("no debe preguntar"); } })');
assert.strictEqual(r.ok, false); assert.strictEqual(r.blocked, true);
assert.match(r.error, /Mesa 1 tiene un cobro en partes iguales a medias/);
assert.deepStrictEqual(get('state.orders'), ordersBlocked, 'Nada cambia');
// También si la cuenta a medias es la de la mesa destino
run(`state.currentOrderId = 'o1';`);
run(`(() => { const a = getOrder('o1'), b = getOrder('o2'); [a.equalSplit, b.equalSplit] = [undefined, a.equalSplit]; })()`);
r = get('moveOrderToTable("o1", "t2", { confirmMerge: () => true })');
assert.strictEqual(r.blocked, true); assert.match(r.error, /Mesa 2 tiene un cobro en partes iguales a medias/);
console.log('   ✅ Unión bloqueada si el origen o el destino tiene un cobro en partes iguales a medias (sin preguntar ni cambiar nada).');

// --- 4. Restricciones y botón ---
run('resetScenario();');
assert.match(get('moveOrderToTable("o_bar", "t3")').error, /Solo se pueden mover pedidos de mesa/);
assert.match(get('moveOrderToTable("o_custom", "t3")').error, /Solo se pueden mover pedidos de mesa/);
assert.match(get('moveOrderToTable("o_empty", "t4")').error, /Solo se pueden mover pedidos de mesa/);
assert.match(get('moveOrderToTable("o1", "t1")').error, /mesa distinta/);
assert.match(get('moveOrderToTable("o1", "no_existe")').error, /mesa distinta/);
for (const [id, enabled] of [['o1', true], ['o_bar', false], ['o_custom', false], ['o_empty', false]]) {
  run(`state.currentOrderId = '${id}'; realRenderOrderDialog();`);
  assert.strictEqual(run('document.querySelector("#moveOrderButton").disabled'), !enabled, `Botón para ${id}`);
}
console.log('   ✅ Solo pedidos de mesa con productos: barra, cuentas personalizadas, pedidos vacíos o la misma mesa se rechazan.');

// --- 5. Persistencia: la unión sobrevive a una recarga ---
run('resetScenario(); moveOrderToTable("o1", "t2", { confirmMerge: () => true }); state = normalizeState(JSON.parse(JSON.stringify(state)));');
assert.strictEqual(get('orderTotal(activeOrderForTable("t2"))'), 72000);
assert.strictEqual(get('activeOrderForTable("t1")'), undefined);
console.log('   ✅ Tras recargar, la cuenta unida y la mesa liberada se mantienen.');

console.log('\n=== TODAS LAS PRUEBAS DE MOVER Y UNIR MESAS PASARON ===');
