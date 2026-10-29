// scratch/test-split-equal-and-invoice-edit.js
// Pruebas financieras con el código REAL de app.js y modules.js (cargados en un contexto vm, en el orden de index.html):
// 1. Cuenta dividida en partes iguales: siempre se recauda el total, la mesa solo cierra con saldo 0,
//    el avance persiste en el pedido y el inventario se descuenta una vez, en cantidades enteras.
// 2. Corrección de facturas: payment.payments (desglose) se actualiza con el método/importe y la caja lo refleja.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: PARTES IGUALES Y CORRECCIÓN DE FACTURAS (código real) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '',
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
// Valores del contexto vm serializados: se comparan como objetos del mismo «realm» que assert
const get = code => JSON.parse(run(`JSON.stringify(${code})`));

// Estado limpio: turno abierto, un producto con inventario y la mesa con 15 cervezas ($90.000)
run(`
  var toasts = [];
  renderAll = () => {}; renderOrderDialog = () => {}; showToast = msg => { toasts.push(String(msg)); };
  function resetScenario(qty = 15, price = 6000) {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.cashShift = { id: 'shift_t', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.products = [{ id: 'p1', name: 'Cerveza', category: 'Cervezas', price, cost: 3000, stock: 100, inventoryId: 'inv1' }];
    state.inventory = [{ id: 'inv1', name: 'Cerveza', qty: 100, min: 5, unit: 'und' }];
    state.orders = [{ id: 'ord_t', tableId: 't1', tableName: 'Mesa 1', status: 'open', createdAt: Date.now(), items: [{ productId: 'p1', name: 'Cerveza', price, cost: 3000, qty, inventoryId: 'inv1' }] }];
    state.currentOrderId = 'ord_t';
    splitBillData.people = 2; splitBillData.mode = 'equal';
    toasts.length = 0;
  }
  // Cobra una parte como en pantalla: abre la división, toca «Cobrar Fracción» y finaliza el pago
  function payPart(part, people) {
    openSplitBill(); if (people) setSplitPeopleExact(people);
    chargeEqualPart(part); confirmPayment();
    return state.payments[state.payments.length - 1];
  }
  function snapshot() {
    const order = getOrder('ord_t');
    return { collected: state.payments.reduce((s, p) => s + p.amount, 0), status: order.status, pending: orderPending(order), stock: state.inventory[0].qty,
      invoices: state.payments.map(p => ({ amount: p.amount, itemsValue: p.items.reduce((s, i) => s + i.price * i.qty, 0), qtys: p.items.map(i => i.qty) })) };
  }
`);

function checkInvoicesConsistent(snap) {
  for (const inv of snap.invoices) {
    assert.strictEqual(inv.itemsValue, inv.amount, 'Cada factura debe cuadrar: valor de líneas = importe cobrado');
    for (const q of inv.qtys) assert.ok(Number.isInteger(q), `Cantidades enteras en facturas (se encontró ${q})`);
  }
}

// --- A. $90.000 entre 3 personas, en orden 1-2-3 ---
run('resetScenario(); payPart(1, 3);');
let s = get('snapshot()');
assert.strictEqual(s.collected, 30000); assert.strictEqual(s.status, 'open'); assert.strictEqual(s.pending, 60000);
assert.strictEqual(s.stock, 100, 'Un abono no descuenta inventario');
run('payPart(2);'); s = get('snapshot()');
assert.strictEqual(s.collected, 60000); assert.strictEqual(s.status, 'open'); assert.strictEqual(s.pending, 30000);
run('payPart(3);'); s = get('snapshot()');
assert.deepStrictEqual(s.invoices.map(i => i.amount), [30000, 30000, 30000]);
assert.strictEqual(s.collected, 90000); assert.strictEqual(s.status, 'paid'); assert.strictEqual(s.pending, 0);
assert.strictEqual(s.stock, 85, 'Las 15 cervezas se descuentan una sola vez, en enteros');
checkInvoicesConsistent(s);
console.log('   ✅ Orden 1-2-3: $30.000 × 3 = $90.000; la mesa cierra solo al cobrar la última parte.');

// --- B. La persona 3 paga primero ---
run('resetScenario(); payPart(3, 3);'); s = get('snapshot()');
assert.strictEqual(s.collected, 30000); assert.strictEqual(s.status, 'open', 'Cobrar la tarjeta «3 de 3» primero NO cierra la mesa');
run('payPart(1); payPart(2);'); s = get('snapshot()');
assert.strictEqual(s.collected, 90000); assert.strictEqual(s.status, 'paid'); assert.strictEqual(s.stock, 85);
checkInvoicesConsistent(s);
console.log('   ✅ Persona 3 primero: la mesa sigue abierta y al final se recaudan los $90.000.');

// --- C. Total que no divide exacto: $100.000 entre 3, en orden 3-1-2 ---
run('resetScenario(20, 5000); payPart(3, 3); payPart(1); payPart(2);'); s = get('snapshot()');
assert.strictEqual(s.collected, 100000); assert.strictEqual(s.status, 'paid');
assert.deepStrictEqual(s.invoices.map(i => i.amount).sort(), [33333, 33333, 33334]);
checkInvoicesConsistent(s);
console.log('   ✅ $100.000 entre 3 (33.333 + 33.333 + 33.334): el redondeo nunca deja pesos sin cobrar.');

// --- D. Persistencia: recarga de la app y diálogo cerrado a mitad de la división ---
run('resetScenario(); payPart(1, 3); document.querySelector("#splitBillDialog").close();');
run(`state = normalizeState(JSON.parse(JSON.stringify(state))); splitBillData.people = 2; splitBillData.mode = 'items';`); // como si se recargara
const eq = get('getOrder("ord_t").equalSplit');
assert.strictEqual(eq.parts, 3); assert.strictEqual(eq.baseTotal, 90000); assert.strictEqual(eq.paid.length, 1); assert.ok(eq.paid[0].paymentId);
run('openSplitBill();');
assert.strictEqual(run('splitBillData.people'), 3, 'Se retoma con 3 personas');
assert.strictEqual(run('splitBillData.mode'), 'equal');
run('setSplitPeopleExact(5);');
assert.strictEqual(run('getOrder("ord_t").equalSplit.parts'), 3, 'No se puede cambiar el número de personas con partes cobradas');
run('setSplitBillMode("items");');
assert.strictEqual(run('splitBillData.mode'), 'equal', 'No se puede pasar a «por productos» con partes cobradas');
run('payPart(2); payPart(3);'); s = get('snapshot()');
assert.strictEqual(s.collected, 90000); assert.strictEqual(s.status, 'paid');
console.log('   ✅ Persistencia: tras recargar, se retoma la división (3 personas, parte 1 cobrada) y se completa en $90.000.');

// --- E. «Cobrar» normal con partes ya cobradas: salda solo lo pendiente ---
run('resetScenario(); payPart(1, 3); openPayment(); confirmPayment();'); s = get('snapshot()');
assert.deepStrictEqual(s.invoices.map(i => i.amount), [30000, 60000]);
assert.strictEqual(s.collected, 90000); assert.strictEqual(s.status, 'paid'); assert.strictEqual(s.stock, 85);
checkInvoicesConsistent(s);
console.log('   ✅ «Cobrar» después de una parte cobra el saldo ($60.000), no el consumo completo.');

// --- F. Se agregan productos a mitad de la división ---
run('resetScenario(); payPart(1, 3); getOrder("ord_t").items[0].qty = 17;'); // +2 cervezas: total $102.000
assert.strictEqual(run('orderPending(getOrder("ord_t"))'), 72000);
run('payPart(2); payPart(3);'); s = get('snapshot()');
assert.strictEqual(s.collected, 102000); assert.strictEqual(s.status, 'paid'); assert.strictEqual(s.stock, 83);
checkInvoicesConsistent(s);
console.log('   ✅ Si se agregan productos a mitad de la división, el saldo nuevo se reparte entre las partes que faltan.');

// --- G. Reportes por producto: las líneas de abono/ajuste no son productos ---
run('resetScenario(); payPart(2, 3); payPart(1); payPart(3); reportRange = "today";');
const rep = get('(() => { const d = reportDataset(); return { total: d.cur.total, cost: d.cur.cost, byProduct: d.byProduct }; })()');
assert.strictEqual(rep.total, 90000);
assert.deepStrictEqual(Object.keys(rep.byProduct), ['Cerveza']);
assert.strictEqual(rep.byProduct.Cerveza.qty, 15); assert.strictEqual(rep.byProduct.Cerveza.sales, 90000);
assert.strictEqual(rep.cost, 45000, 'Costo de 15 cervezas, una sola vez');
console.log('   ✅ Reportes: Cerveza × 15 = $90.000 y costo $45.000, sin duplicados ni líneas contables como productos.');

// --- H. Corrección de factura: Efectivo $30.000 → Nequi $24.000 ---
run(`resetScenario(5); openPayment(); confirmPayment();
  var invoice = state.payments[0];
  logAudit = () => {}; can = () => true;`);
assert.strictEqual(run('cashSalesToday()'), 30000); assert.strictEqual(run('otherSalesToday()'), 0);
run(`openInvoiceEdit(invoice.id); invoiceDraft.items[0].qty = 4;
  document.querySelector('#invoiceReason').value = 'Pagó por Nequi y se cobró una cerveza de más';
  document.querySelector('#invoiceMethodEdit').value = 'Nequi'; document.querySelector('#invoiceCustomer').value = '';
  saveInvoiceEdit();`);
let inv = get('invoice');
assert.strictEqual(inv.amount, 24000); assert.strictEqual(inv.method, 'Nequi');
assert.deepStrictEqual(inv.payments, [{ method: 'Nequi', amount: 24000, received: 24000, change: 0 }]);
assert.strictEqual(inv.sync_status, 'pending', 'La corrección debe subirse a Supabase');
assert.deepStrictEqual(inv.edits[0].before.payments.map(t => [t.method, t.amount]), [['Efectivo', 30000]]);
assert.strictEqual(run('cashSalesToday()'), 0, 'El efectivo de la caja baja a $0');
assert.strictEqual(run('otherSalesToday()'), 24000, 'Otros medios suben a $24.000');
const waText = decodeURIComponent(run('buildCloseWhatsappUrl({ id: "shift_t", openingCash: 0, closedAt: Date.now() })'));
assert.match(waText, /Nequi[^\n]*\$\s?24\.000/); assert.match(waText, /Efectivo[^\n]*\$\s?0/);
console.log('   ✅ Efectivo $30.000 → Nequi $24.000: la caja resta el efectivo, suma Nequi y el reporte de WhatsApp lo refleja.');

// --- I. Pago mixto: el desglose debe sumar el nuevo total ---
run(`resetScenario(5); openPayment();
  activePaymentMethod = 'Efectivo'; document.querySelector('#amountReceived').value = '20000'; addPaymentTender();
  activePaymentMethod = 'Nequi'; document.querySelector('#amountReceived').value = '10000'; addPaymentTender();
  confirmPayment(); invoice = state.payments[0];`);
assert.strictEqual(run('invoice.method'), 'Efectivo + Nequi');
run(`openInvoiceEdit(invoice.id); invoiceDraft.items[0].qty = 4; document.querySelector('#invoiceReason').value = 'Una cerveza de más'; toasts.length = 0; saveInvoiceEdit();`);
assert.strictEqual(run('invoice.amount'), 30000, 'Si el desglose no cuadra, no se guarda');
assert.ok(run('toasts.some(t => t.includes("El desglose del pago suma"))'));
run(`invoiceDraft.tenders[0].amount = 14000; saveInvoiceEdit();`);
inv = get('invoice');
assert.strictEqual(inv.amount, 24000); assert.strictEqual(inv.method, 'Efectivo + Nequi');
assert.deepStrictEqual(inv.payments.map(t => [t.method, t.amount]), [['Efectivo', 14000], ['Nequi', 10000]]);
assert.strictEqual(run('cashSalesToday()'), 14000); assert.strictEqual(run('otherSalesToday()'), 10000);
console.log('   ✅ Pago mixto: exige que el desglose sume el nuevo total y la caja usa los montos corregidos.');

// --- J. Efectivo con cambio: se conserva lo recibido ---
run(`resetScenario(5); openPayment(); activePaymentMethod = 'Efectivo';
  document.querySelector('#tenderCashReceived').value = '50000'; confirmPayment(); invoice = state.payments[0];
  openInvoiceEdit(invoice.id); invoiceDraft.items[0].qty = 4; document.querySelector('#invoiceReason').value = 'Una cerveza de más';
  document.querySelector('#invoiceMethodEdit').value = 'Efectivo'; saveInvoiceEdit();
  document.querySelector('#tenderCashReceived').value = '';`);
inv = get('invoice');
assert.deepStrictEqual(inv.payments, [{ method: 'Efectivo', amount: 24000, received: 50000, change: 26000 }]);
assert.strictEqual(run('cashSalesToday()'), 24000);
console.log('   ✅ Efectivo con cambio: el arqueo cuenta $24.000 (lo cobrado), no lo recibido.');

// --- K. Partes de una cuenta dividida: se corrige el medio, no los productos ---
run('resetScenario(); payPart(1, 3); invoice = state.payments[0];');
run(`openInvoiceEdit(invoice.id); document.querySelector('#invoiceReason').value = 'Pagó con Daviplata'; document.querySelector('#invoiceMethodEdit').value = 'Daviplata'; saveInvoiceEdit();`);
inv = get('invoice');
assert.strictEqual(inv.method, 'Daviplata'); assert.strictEqual(inv.amount, 30000);
assert.deepStrictEqual(inv.payments.map(t => [t.method, t.amount]), [['Daviplata', 30000]]);
run(`openInvoiceEdit(invoice.id); invoiceDraft.items[0].price = 1000; document.querySelector('#invoiceReason').value = 'Probar cambio'; toasts.length = 0; saveInvoiceEdit();`);
assert.strictEqual(run('invoice.amount'), 30000, 'El importe de una parte no cambia');
assert.ok(run('toasts.some(t => t.includes("parte de una cuenta dividida"))'));
console.log('   ✅ Partes de cuenta dividida: se corrige el medio de pago; cambiar productos/importe se rechaza.');

console.log('\n=== TODAS LAS PRUEBAS DE PARTES IGUALES Y CORRECCIÓN DE FACTURAS PASARON ===');
