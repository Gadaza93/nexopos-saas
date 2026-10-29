// scratch/test-modificadores.js
// Adiciones y modificadores con el código REAL de app.js/modules.js/print.js (contexto vm, orden de index.html):
// 1. Grupos: crear, validar y asignar a productos (en el perfil: viajan a la nube con la configuración).
// 2. Agregar un producto con grupos abre la elección; el obligatorio se exige; la línea lleva precio, costo y nombre.
// 3. Misma combinación = misma línea; otra combinación = otra línea; sin grupos, como siempre.
// 4. Comanda con las opciones; cobrar descuenta los insumos de las adiciones.
// 5. Cobrar solo una línea (división por productos) y corregir la factura devuelve los insumos de la adición.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: ADICIONES Y MODIFICADORES (código real) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, remove() {}, closest: () => null,
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
const get = code => { const json = run(`JSON.stringify(${code})`); return json === undefined ? undefined : JSON.parse(json); };
const setVal = (sel, value) => { document.querySelector(sel).value = String(value); };
const ok = msg => console.log(`   ✅ ${msg}`);
const near = (a, b, msg) => assert(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

run(`
  var toasts = [], printed = [];
  renderAll = () => {}; renderOrderDialog = () => {}; showToast = msg => { toasts.push(String(msg)); };
  saveState = () => {};
  sendToPrinter = async (html, label) => { printed.push({ html, label }); return { ok: true }; };
  NexoSync = { syncOrders: async () => {}, syncSale: async () => {}, deleteActiveOrder: async () => {}, scheduleSync() {} };
  function resetScenario() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [],
      insumos: [
        { id: 'ins_carne', name: 'Carne', unit: 'kg', qty: 5, min: 1, cost: 20000 },
        { id: 'ins_queso', name: 'Queso', unit: 'kg', qty: 2, min: 0.5, cost: 30000 }
      ],
      products: [
        { id: 'hamb', name: 'Hamburguesa', category: 'Platos fuertes', price: 20000, cost: 0, tipo: 'preparado', receta: [{ insumoId: 'ins_carne', qty: 150, unit: 'g' }] },
        { id: 'jugo', name: 'Jugo', category: 'Bebidas', price: 6000, cost: 2000, inventoryId: 'inv_jugo' }
      ],
      inventory: [{ id: 'inv_jugo', name: 'Jugo', unit: 'und', qty: 50, min: 5 }]
    });
    state.cashShift = { id: 'shift_t', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.users = [{ id: 'u_admin', name: 'Ana', role: 'admin', active: true }];
    session = 'u_admin';
    state.profile.tipPercent = 0;
    state.orders = [{ id: 'o1', tableId: 'm1', tableName: 'Mesa 1', status: 'open', createdAt: Date.now(), items: [] }];
    state.currentOrderId = 'o1';
    toasts.length = 0; printed.length = 0;
  }
  // Como el editor de grupos: nombre y modo en el formulario, opciones y productos en el borrador
  function crearGrupo(name, mode, options, productIds) {
    openModifierGroupDialog();
    document.querySelector('#modifierGroupName').value = name;
    document.querySelector('#modifierGroupMode').value = mode;
    modifierDraft.options = options; modifierDraft.productIds = productIds;
    saveModifierGroup();
    return modifierGroups().find(g => g.name === name);
  }
  // Como tocar las opciones en la ventana y confirmar
  function elegir(productId, opciones) { addProduct(productId); opciones.forEach(([g, o]) => toggleModifierOption(g, o)); confirmModifierPick(); }
  const items = () => getOrder('o1').items;
`);

// 1. Grupos
console.log('1. Grupos de opciones...');
run('resetScenario();');
run(`var termino = crearGrupo('Término', 'una', [{ id: 'medio', name: 'Término medio', price: 0 }, { id: 'asada', name: 'Bien asada', price: 0 }], ['hamb']);
  var adiciones = crearGrupo('Adiciones', 'varias', [{ id: 'queso', name: 'Queso extra', price: 2000, insumoId: 'ins_queso', qty: 30, unit: 'g' }, { id: 'tocineta', name: 'Tocineta', price: 3000 }], ['hamb', 'jugo_no_existe']);`);
assert.deepStrictEqual(get('modifierGroups().map(g => [g.name, g.mode, g.options.length])'), [['Término', 'una', 2], ['Adiciones', 'varias', 2]]);
assert.deepStrictEqual(get('adiciones.productIds'), ['hamb'], 'productos inexistentes se descartan');
assert.strictEqual(get('state.profile.sync_status'), 'pending', 'viaja a la nube con el perfil');
run(`crearGrupo('', 'una', [{ id: 'x', name: 'X', price: 0 }], []);`);
assert.match(get('toasts[toasts.length - 1]'), /nombre del grupo/);
run(`crearGrupo('Malo', 'varias', [{ id: 'y', name: 'Con insumo', price: 0, insumoId: 'ins_queso' }], []);`);
assert.match(get('toasts[toasts.length - 1]'), /cantidad del insumo/);
assert.strictEqual(get('modifierGroups().length'), 2, 'los inválidos no se guardan');
ok('Grupos «Término» (obligatorio) y «Adiciones» (varias, una con insumo); inválidos rechazados');

// 2. Elegir al agregar
console.log('\n2. Elegir opciones al agregar...');
run(`addProduct('hamb');`);
assert.strictEqual(get('items().length'), 0, 'no se agrega sin elegir');
assert.strictEqual(get('modifierPick.productId'), 'hamb', 'abre la elección');
run(`toggleModifierOption(adiciones.id, 'queso'); confirmModifierPick();`);
assert.match(get('toasts[toasts.length - 1]'), /Elige: Término/, 'el obligatorio se exige');
assert.strictEqual(get('items().length'), 0);
run(`toggleModifierOption(termino.id, 'medio'); confirmModifierPick();`);
let linea = get('items()[0]');
assert.strictEqual(linea.name, 'Hamburguesa (Término medio, + Queso extra)');
assert.strictEqual(linea.price, 22000, 'precio + adición');
assert.strictEqual(linea.cost, 3000 + 900, 'costo de la receta (150 g × $20.000/kg) + 30 g de queso');
assert.strictEqual(linea.productId, 'hamb');
assert.ok(linea.lineId && linea.lineId !== 'hamb', 'línea propia');
assert.deepStrictEqual(linea.modifiers.map(m => [m.name, m.price]), [['Término medio', 0], ['Queso extra', 2000]]);
ok('Abre la elección, exige el término y agrega «Hamburguesa (Término medio, + Queso extra)» a $22.000');

// 3. Líneas
console.log('\n3. Líneas por combinación...');
run(`elegir('hamb', [[adiciones.id, 'queso'], [termino.id, 'medio']]);`); // mismo, en otro orden
assert.deepStrictEqual(get('items().map(i => [i.name, i.qty])'), [['Hamburguesa (Término medio, + Queso extra)', 2]], 'misma combinación suma cantidad');
run(`elegir('hamb', [[termino.id, 'asada']]);`);
run(`addProduct('jugo');`);
assert.deepStrictEqual(get('items().map(i => [i.name, i.qty, i.price])'), [['Hamburguesa (Término medio, + Queso extra)', 2, 22000], ['Hamburguesa (Bien asada)', 1, 20000], ['Jugo', 1, 6000]]);
assert.strictEqual(get('items()[2].lineId'), undefined, 'sin grupos: línea normal');
run(`changeItem(lineKey(items()[1]), 1);`);
assert.strictEqual(get('items()[1].qty'), 2, 'los botones +/− mueven la línea correcta');
assert.strictEqual(get('items()[0].qty'), 2, 'la otra combinación no cambia');
assert.strictEqual(get('orderTotal(getOrder("o1"))'), 2 * 22000 + 2 * 20000 + 6000);
ok('Misma combinación suma; otra combinación va aparte; +/− por línea; total $90.000');

// 4. Comanda y cobro
console.log('\n4. Comanda y cobro...');
run('sendOrderToKitchen();');
const comanda = get('printed.find(p => /Cocina/.test(p.label)).html');
assert.match(comanda, /Hamburguesa \(Término medio, \+ Queso extra\)/);
assert.match(comanda, /Hamburguesa \(Bien asada\)/);
run(`openPayment(); document.querySelector('#tenderCashReceived').value = '100000'; confirmPayment(); var pago = state.payments[0];`);
assert.strictEqual(get('pago.amount'), 90000);
const ins = Object.fromEntries(get('state.insumos.map(i => [i.id, i.qty])'));
near(ins.ins_carne, 5 - 4 * 0.15, 'carne: 4 hamburguesas');
near(ins.ins_queso, 2 - 2 * 0.03, 'queso: 2 adiciones');
assert.strictEqual(get('state.inventory[0].qty'), 49, 'el jugo (reventa) baja como siempre');
const recibo = get('buildReceiptHtml(pago, { profile: { name: "R" } })');
assert.match(recibo, /Hamburguesa \(Término medio, \+ Queso extra\)/);
ok('La comanda y el recibo muestran las opciones; al cobrar baja la carne (4) y el queso de las 2 adiciones');

// 5. Cobro por productos y corrección
console.log('\n5. Cobro por línea y corrección...');
run(`resetScenario(); var termino = crearGrupo('Término', 'una', [{ id: 'medio', name: 'Término medio', price: 0 }, { id: 'asada', name: 'Bien asada', price: 0 }], ['hamb']);
  var adiciones = crearGrupo('Adiciones', 'varias', [{ id: 'queso', name: 'Queso extra', price: 2000, insumoId: 'ins_queso', qty: 30, unit: 'g' }], ['hamb']);
  elegir('hamb', [[termino.id, 'medio'], [adiciones.id, 'queso']]); elegir('hamb', [[termino.id, 'asada']]);
  openSplitBill(); setSplitBillMode('items'); changeSplitItemQty(lineKey(items()[0]), 1); chargeSelectedSplitItems();
  document.querySelector('#tenderCashReceived').value = '30000'; confirmPayment(); var parcial = state.payments[0];`);
assert.deepStrictEqual(get('parcial.items.map(i => [i.name, i.qty])'), [['Hamburguesa (Término medio, + Queso extra)', 1]]);
assert.deepStrictEqual(get('items().map(i => i.name)'), ['Hamburguesa (Bien asada)'], 'queda solo la otra línea');
near(get('insumoById("ins_queso").qty'), 2 - 0.03, 'queso descontado');
run(`openInvoiceEdit(parcial.id); invoiceDraft.items = []; invoiceDraft.items.push({ productId: 'jugo', name: 'Jugo', price: 6000, cost: 2000, qty: 1, inventoryId: 'inv_jugo', category: 'Bebidas' });`);
setVal('#invoiceReason', 'Cambió el pedido'); setVal('#invoiceMethodEdit', 'Efectivo'); setVal('#invoiceCustomer', 'Mesa 1');
run('saveInvoiceEdit();');
near(get('insumoById("ins_queso").qty'), 2, 'quitar la hamburguesa de la factura devuelve el queso de la adición');
near(get('insumoById("ins_carne").qty'), 5, 'y la carne de la receta');
ok('Cobrar una línea de dos combinaciones; corregir la factura devuelve receta y adición');

console.log('\n=== TODAS LAS PRUEBAS DE MODIFICADORES PASARON ===');
