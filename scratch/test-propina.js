// scratch/test-propina.js
// Propina voluntaria con el código REAL de app.js/modules.js/print.js (contexto vm, orden de index.html):
// 1. Porcentaje sugerido (10 % por defecto, configurable 0–30) y solo en pedidos de mesa.
// 2. Cobro con propina: la venta (amount) es solo el consumo; la propina va aparte y en el medio de pago.
// 3. Quitar o cambiar la propina; no se puede cambiar con pagos ya agregados.
// 4. Pago mixto: la propina se reparte entre los medios; las ventas por medio no la incluyen.
// 5. Caja: la propina en efectivo está en el efectivo esperado, aparte en el cierre y el Ticket Z.
// 6. Recibo y corrección de factura conservan la propina.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: PROPINA VOLUNTARIA (código real) ===\n');

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

run(`
  var toasts = [];
  renderAll = () => {}; renderOrderDialog = () => {}; showToast = msg => { toasts.push(String(msg)); };
  saveState = () => {}; sendToPrinter = async () => ({ ok: true });
  NexoSync = { syncOrders: async () => {}, syncSale: async () => {}, deleteActiveOrder: async () => {}, syncCashShift: async () => {} };
  const line = (id, name, price, qty) => ({ productId: id, name, price, qty, cost: Math.round(price / 3), category: 'Bebidas', inventoryId: 'inv_' + id });
  function resetScenario() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.cashShift = { id: 'shift_t', status: 'open', openingCash: 50000, openedAt: Date.now() };
    state.users = [{ id: 'u_admin', name: 'Ana', role: 'admin', active: true }];
    session = 'u_admin';
    state.profile.kitchenStations = { Bebidas: 'ninguna' };
    state.products = [{ id: 'jugo', name: 'Jugo', category: 'Bebidas', price: 10000, cost: 3000, inventoryId: 'inv_jugo' }];
    state.inventory = [{ id: 'inv_jugo', name: 'Jugo', unit: 'und', qty: 100, min: 5 }];
    state.orders = [
      { id: 'o_mesa', tableId: 'm1', tableName: 'Mesa 1', status: 'open', createdAt: Date.now(), items: [line('jugo', 'Jugo', 10000, 3)] },
      { id: 'o_mostrador', tableId: 'walkin', tableName: 'Venta en mostrador', status: 'open', createdAt: Date.now(), items: [line('jugo', 'Jugo', 10000, 1)] }
    ];
    toasts.length = 0;
  }
  function cobrar(orderId, prep) { state.currentOrderId = orderId; openPayment(); if (prep) prep(); confirmPayment(); return state.payments[state.payments.length - 1]; }
`);

// 1. Porcentaje
console.log('1. Porcentaje sugerido...');
run('resetScenario();');
assert.strictEqual(get('tipPercent()'), 10, '10 % por defecto');
run('saveTipPercent(15);');
assert.strictEqual(get('state.profile.tipPercent'), 15);
assert.strictEqual(get('state.profile.sync_status'), 'pending', 'sube a la nube con el perfil');
run('saveTipPercent(50);');
assert.strictEqual(get('state.profile.tipPercent'), 15, 'fuera de rango se rechaza');
assert.match(get('toasts[toasts.length - 1]'), /entre 0 % y 30 %/);
run('saveTipPercent(0);');
assert.strictEqual(get('suggestedTip(getOrder("o_mesa"), 30000)'), 0, '0 % la desactiva');
run('resetScenario();');
assert.strictEqual(get('suggestedTip(getOrder("o_mesa"), 30000)'), 3000);
assert.strictEqual(get('suggestedTip(getOrder("o_mostrador"), 10000)'), 0, 'mostrador: sin propina sugerida');
ok('10 % por defecto, configurable de 0 a 30 %, solo en pedidos de mesa');

// 2. Cobro con propina en efectivo
console.log('\n2. Cobro con propina...');
run(`resetScenario(); state.currentOrderId = 'o_mesa'; openPayment();`);
assert.deepStrictEqual([get('currentCheckout.total'), get('currentCheckout.tip'), get('checkoutDue()')], [30000, 3000, 33000]);
assert.strictEqual(get('document.querySelector("#tipRow").hidden'), false, 'la fila de propina se ve en mesa');
setVal('#tenderCashReceived', 40000);
run('confirmPayment(); var pago = state.payments[0];');
let pago = get('pago');
assert.deepStrictEqual([pago.amount, pago.tip], [30000, 3000], 'la venta es solo el consumo');
assert.deepStrictEqual(pago.payments.map(t => [t.method, t.amount, t.tip, t.received, t.change]), [['Efectivo', 33000, 3000, 40000, 7000]]);
assert.strictEqual(get('paymentTip(pago)'), 3000);
assert.strictEqual(get('cashSalesToday()'), 30000, 'ventas en efectivo sin propina');
assert.deepStrictEqual(get('tipsToday()'), { total: 3000, cash: 3000 });
assert.strictEqual(get('expectedCash()'), 50000 + 30000 + 3000, 'la propina en efectivo sí está en la caja');
assert.strictEqual(get('paymentMetrics(state.payments).total'), 30000, 'reportes sin propina');
ok('Mesa de $30.000: propina $3.000 aparte, cambio de $7.000, efectivo esperado $83.000, ventas $30.000');

// 3. Quitar, cambiar y bloquear
console.log('\n3. Quitar o cambiar la propina...');
run(`resetScenario(); pago = cobrar('o_mesa', () => setCheckoutTip(0));`);
pago = get('pago');
assert.strictEqual(pago.tip, undefined, 'sin propina');
assert.deepStrictEqual(pago.payments.map(t => [t.amount, t.tip]), [[30000, undefined]]);
run(`resetScenario(); pago = cobrar('o_mesa', () => setCheckoutTip(5000));`);
assert.deepStrictEqual([get('pago.amount'), get('pago.tip')], [30000, 5000], 'propina cambiada a $5.000');
run(`resetScenario(); state.currentOrderId = 'o_mesa'; openPayment(); activePaymentMethod = 'Nequi';
  document.querySelector('#amountReceived').value = '10000'; addPaymentTender(); setCheckoutTip(0);`);
assert.strictEqual(get('currentCheckout.tip'), 3000, 'con pagos agregados la propina no cambia');
run(`resetScenario(); pago = cobrar('o_mostrador');`);
assert.deepStrictEqual([get('pago.amount'), get('pago.tip')], [10000, undefined], 'mostrador sin propina');
ok('Se puede quitar o cambiar antes de pagar; con pagos agregados queda fija; mostrador sin propina');

// 4. Pago mixto
console.log('\n4. Pago mixto...');
run(`resetScenario(); pago = cobrar('o_mesa', () => {
  activePaymentMethod = 'Nequi'; document.querySelector('#amountReceived').value = '22000'; addPaymentTender();
  activePaymentMethod = 'Efectivo'; document.querySelector('#amountReceived').value = '11000'; addPaymentTender();
});`);
pago = get('pago');
assert.deepStrictEqual(pago.payments.map(t => [t.method, t.amount, t.tip]), [['Nequi', 22000, 2000], ['Efectivo', 11000, 1000]], 'propina repartida en proporción');
assert.deepStrictEqual([get('cashSalesToday()'), get('otherSalesToday()')], [10000, 20000], 'ventas por medio sin propina');
assert.deepStrictEqual(get('tipsToday()'), { total: 3000, cash: 1000 });
assert.strictEqual(get('expectedCash()'), 50000 + 10000 + 1000);
ok('Nequi $22.000 + efectivo $11.000: propina $2.000 + $1.000; a la caja solo entra la de efectivo');

// 5. Cierre de caja y Ticket Z
console.log('\n5. Cierre y Ticket Z...');
setVal('#countedCash', 61000);
run('confirmClose(); var cierre = state.closedShifts[state.closedShifts.length - 1];');
const cierre = get('cierre');
assert.deepStrictEqual([cierre.totalSales, cierre.cashSales, cierre.tips, cierre.tipsCash, cierre.expected, cierre.difference], [30000, 10000, 3000, 1000, 61000, 0]);
const z = get('buildShiftZHtml(cierre, { totalSales: cierre.totalSales })');
assert.match(z, /Propinas \(aparte\):/); assert.match(z, /3\.000/); assert.match(z, /en efectivo:/);
const wa = decodeURIComponent(get('buildCloseWhatsappUrl(cierre)'));
assert.match(wa, /Propinas \(aparte de las ventas\): \$\s?3\.000/);
ok('Cierre cuadrado con $61.000: ventas $30.000 y propinas $3.000 aparte, también en el Ticket Z y WhatsApp');

// 6. Recibo y corrección de factura
console.log('\n6. Recibo y corrección...');
const recibo = get('buildReceiptHtml(pago, { profile: { name: "Restaurante" } })');
assert.match(recibo, /Consumo/); assert.match(recibo, /Propina voluntaria/);
assert.match(recibo, /TOTAL<\/span><span class="num">\$\s?33\.000/);
run(`resetScenario(); state.cashShift = { id: 'shift_t', status: 'open', openingCash: 0, openedAt: Date.now() };
  pago = cobrar('o_mesa'); openInvoiceEdit(pago.id);`);
assert.deepStrictEqual(get('invoiceDraft.tenders.map(t => t.amount)'), [30000], 'se edita solo el consumo');
setVal('#invoiceReason', 'Cambio de medio'); setVal('#invoiceMethodEdit', 'Nequi'); setVal('#invoiceCustomer', 'Mesa 1');
run('saveInvoiceEdit();');
pago = get('pago');
assert.deepStrictEqual([pago.amount, pago.tip, pago.method], [30000, 3000, 'Nequi']);
assert.deepStrictEqual(pago.payments.map(t => [t.method, t.amount, t.tip]), [['Nequi', 33000, 3000]], 'la propina se conserva en el medio nuevo');
ok('Recibo con consumo, propina y total; corregir el medio de pago conserva la propina');

console.log('\n=== TODAS LAS PRUEBAS DE PROPINA PASARON ===');
