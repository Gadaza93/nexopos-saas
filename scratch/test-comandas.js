// scratch/test-comandas.js
// Comandas de cocina con el código REAL de app.js/modules.js/print.js (contexto vm, orden de index.html):
// 1. Estación por categoría (por defecto y configurada) y conteo de lo pendiente.
// 2. «Enviar a cocina»: una comanda por estación, solo lo nuevo, nota por línea, impresora de cada estación.
// 3. Quitar algo ya enviado: el mesero no puede; el cajero sí y sale una anulación al guardar.
// 4. Cobro: lo no enviado sale solo; un cobro por productos no genera anulación ni bloquea envíos siguientes.
// 5. Unir cuentas conserva lo enviado; eliminar un pedido anula lo enviado.
// 6. Ticket de comanda: sin precios, nota, anulación y texto escapado.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: COMANDAS DE COCINA (código real) ===\n');

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
const get = code => { const json = run(`JSON.stringify(${code})`); return json === undefined ? undefined : JSON.parse(json); };
const ok = msg => console.log(`   ✅ ${msg}`);

run(`
  var toasts = [], printed = [];
  renderAll = () => {}; renderOrderDialog = () => {}; showToast = msg => { toasts.push(String(msg)); };
  saveState = () => {};
  NexoSync = { syncOrders: async () => {}, deleteActiveOrder: async () => {} };
  // La impresora real no existe en Node: se guarda qué se mandó y a qué impresora
  sendToPrinter = async (html, label, opts = {}) => { printed.push({ html, label, printerName: opts.printerName || '' }); return { ok: true }; };
  const line = (id, name, category, price, qty) => ({ productId: id, name, category, price, qty, cost: Math.round(price / 3), inventoryId: 'inv_' + id });
  function resetScenario() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    state.cashShift = { id: 'shift_t', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.products = [
      { id: 'ban', name: 'Bandeja paisa', category: 'Platos fuertes', price: 32000, cost: 14000, inventoryId: 'inv_ban' },
      { id: 'cap', name: 'Capuchino', category: 'Cafetería', price: 6500, cost: 2200, inventoryId: 'inv_cap' },
      { id: 'gas', name: 'Gaseosa', category: 'Bebidas', price: 4000, cost: 2000, inventoryId: 'inv_gas' }
    ];
    state.inventory = state.products.map(p => ({ id: p.inventoryId, name: p.name, qty: 100, min: 5, unit: 'und' }));
    state.users = [
      { id: 'u_mesero', name: 'Ana', role: 'mesero', active: true },
      { id: 'u_cajero', name: 'Luis', role: 'cajero', active: true }
    ];
    state.kitchenStations = { Bebidas: 'ninguna' }; // gaseosa lista: no se prepara
    state.printSettings = { paperWidth: 80, silent: true, printerName: 'Caja', stationPrinters: { cocina: 'Cocina-80mm', barra: '' } };
    state.orders = [{ id: 'o1', tableId: 'm1', tableName: 'Mesa 1', status: 'open', createdAt: Date.now(), userName: 'Ana', note: 'Alergia al maní',
      items: [line('ban', 'Bandeja paisa', 'Platos fuertes', 32000, 2), line('cap', 'Capuchino', 'Cafetería', 6500, 1), line('gas', 'Gaseosa', 'Bebidas', 4000, 1)] }];
    state.currentOrderId = 'o1';
    session = 'u_mesero';
    toasts.length = 0; printed.length = 0;
  }
`);

// 1. Estaciones
console.log('1. Estación por categoría...');
run('resetScenario();');
assert.strictEqual(get('kitchenStationFor("Platos fuertes")'), 'cocina');
assert.strictEqual(get('kitchenStationFor("Cafetería")'), 'barra', 'cafetería va a barra por defecto');
assert.strictEqual(get('kitchenStationFor("Bebidas")'), 'ninguna', 'lo configurado manda sobre el valor por defecto');
assert.strictEqual(get('kitchenStationFor("Postres")'), 'cocina');
assert.strictEqual(get('kitchenPendingCount(getOrder("o1"))'), 3, '2 bandejas + 1 capuchino (la gaseosa no cuenta)');
ok('Platos a Cocina, cafetería a Barra, categorías en «No se envía» fuera; pendientes = 3');

// 2. Envío por estación, solo lo nuevo
console.log('\n2. Enviar a cocina...');
run('getOrder("o1").items[0].kitchenNote = "una sin frijol"; var r1 = sendOrderToKitchen();');
let r = get('r1');
assert.strictEqual(r.comandas.length, 2, 'una comanda por estación');
const cocina = r.comandas.find(c => c.station === 'cocina'), barra = r.comandas.find(c => c.station === 'barra');
assert.deepStrictEqual(cocina.items.map(i => [i.name, i.qty, i.note]), [['Bandeja paisa', 2, 'una sin frijol']]);
assert.deepStrictEqual(barra.items.map(i => [i.name, i.qty]), [['Capuchino', 1]]);
assert.strictEqual(cocina.orderNote, 'Alergia al maní');
assert.strictEqual(cocina.by, 'Ana');
assert.deepStrictEqual(r.comandas.map(c => c.n).sort(), [1, 2], 'consecutivo de comandas');
assert.deepStrictEqual(get('printed.map(p => p.printerName)').sort(), ['', 'Cocina-80mm'], 'Cocina a su impresora; Barra sin impresora propia usa la de tickets');
assert.deepStrictEqual(get('getOrder("o1").items.map(i => i.sentQty)'), [2, 1, 1], 'todo marcado como enviado (también lo que no se prepara)');
assert.strictEqual(get('getOrder("o1").items[0].kitchenNote'), undefined, 'la nota se usa una sola vez');
assert.strictEqual(get('getOrder("o1").comandas.length'), 2);
assert.strictEqual(get('kitchenPendingCount(getOrder("o1"))'), 0);
assert(get('state.auditLog.some(a => a.action === "Comanda enviada" && a.detail.includes("Bandeja paisa"))'), 'queda en auditoría');
run('printed.length = 0; var r2 = sendOrderToKitchen();');
assert.strictEqual(get('r2.comandas.length'), 0);
assert.strictEqual(get('printed.length'), 0, 'reenviar sin cambios no imprime nada');
assert.match(get('toasts[toasts.length - 1]'), /No hay productos nuevos/);
run('changeItem("ban", 1); printed.length = 0; var r3 = sendOrderToKitchen();');
r = get('r3');
assert.deepStrictEqual(r.comandas.map(c => [c.station, c.n, c.items.map(i => i.qty)]), [['cocina', 3, [1]]], 'solo la bandeja nueva, comanda #3');
ok('Comanda por estación con nota y nota del pedido; reenviar no duplica; una bandeja extra sale sola');

// 3. Quitar algo ya enviado
console.log('\n3. Anulaciones...');
run('printed.length = 0; changeItem("ban", -1);');
assert.strictEqual(get('getOrder("o1").items[0].qty'), 3, 'el mesero no puede quitar lo que ya salió a cocina');
assert.match(get('toasts[toasts.length - 1]'), /ya salió a cocina/);
run('session = "u_cajero"; changeItem("ban", -1);');
assert.strictEqual(get('getOrder("o1").items[0].qty'), 2);
assert.deepStrictEqual(get('getOrder("o1").pendingVoids.map(v => [v.name, v.qty])'), [['Bandeja paisa', 1]]);
assert.strictEqual(get('kitchenPendingCount(getOrder("o1"))'), 1, 'la anulación cuenta como pendiente');
run('saveOrder();');
assert.strictEqual(get('printed.length'), 1, 'al guardar sale la anulación');
assert.match(get('printed[0].html'), /ANULACIÓN/);
assert.strictEqual(get('getOrder("o1").pendingVoids.length'), 0);
assert(get('state.auditLog.some(a => a.action === "Comanda anulada")'));
run('session = "u_mesero"; state.currentOrderId = "o1"; changeItem("cap", 1); changeItem("cap", -1);');
assert.strictEqual(get('getOrder("o1").items[1].qty'), 1, 'quitar lo que aún no se envió no necesita permiso');
assert.strictEqual(get('(getOrder("o1").pendingVoids || []).length'), 0);
ok('Mesero bloqueado; cajero anula y la anulación se imprime al guardar; quitar lo no enviado es libre');

// 4. Cobro
console.log('\n4. Cobro...');
run(`resetScenario(); session = 'u_cajero'; printed.length = 0;
  openPayment(); document.querySelector('#tenderCashReceived').value = '90000'; confirmPayment();`); // 74.500 + 10 % de propina sugerida en mesa
assert.strictEqual(get('state.payments.length'), 1, 'la venta se registró');
assert.deepStrictEqual(get('printed.map(p => p.label.split(" #")[0])').sort(), ['Comanda Barra', 'Comanda Cocina'], 'cobrar primero envía lo que faltaba');
run(`resetScenario(); session = 'u_cajero'; sendOrderToKitchen(); printed.length = 0;
  openSplitBill(); setSplitBillMode('items'); changeSplitItemQty('ban', 1); chargeSelectedSplitItems();
  document.querySelector('#tenderCashReceived').value = '40000'; confirmPayment();`);
assert.deepStrictEqual(get('getOrder("o1").items.map(i => [i.productId, i.qty, i.sentQty])'), [['ban', 1, 1], ['cap', 1, 1], ['gas', 1, 1]], 'cobrar 1 bandeja deja 1 enviada');
assert.strictEqual(get('printed.length'), 0, 'un cobro por productos no es anulación');
run('state.currentOrderId = "o1"; changeItem("ban", 1); var r4 = sendOrderToKitchen();');
assert.deepStrictEqual(get('r4.comandas.map(c => c.items.map(i => [i.name, i.qty]))'), [[['Bandeja paisa', 1]]], 'la bandeja pedida después sí sale');
ok('Cobro completo envía lo pendiente; cobro por productos ajusta lo enviado sin anular');

// 5. Unir cuentas y eliminar pedido
console.log('\n5. Unir y eliminar...');
run(`resetScenario(); session = 'u_cajero'; state.tables = [{ id: 'm1', name: 'Mesa 1', zone: 'Salón' }, { id: 'm2', name: 'Mesa 2', zone: 'Salón' }];
  sendOrderToKitchen();
  state.orders.push({ id: 'o2', tableId: 'm2', tableName: 'Mesa 2', status: 'open', createdAt: Date.now(), items: [line('ban', 'Bandeja paisa', 'Platos fuertes', 32000, 3)] });
  getOrder('o2').items[0].sentQty = 1;
  mergeOrderInto(getOrder('o2'), getOrder('o1'));`);
assert.deepStrictEqual(get('getOrder("o1").items[0]').qty, 5);
assert.strictEqual(get('getOrder("o1").items[0].sentQty'), 3, '2 + 1 ya enviadas');
assert.strictEqual(get('kitchenPendingCount(getOrder("o1"))'), 2, 'las 2 bandejas no enviadas de la Mesa 2 siguen pendientes');
run('printed.length = 0; state.currentOrderId = "o1"; deleteCurrentOrder();');
assert.strictEqual(get('getOrder("o1")'), undefined);
assert.strictEqual(get('printed.length'), 2, 'anulación para Cocina y para Barra');
assert(get('printed.every(p => /ANULACIÓN/.test(p.html))'));
assert(get('printed.some(p => /Bandeja paisa/.test(p.html) && /<span class="comanda-qty num">3<\\/span>/.test(p.html))'), 'se anula solo lo que se había enviado (3)');
ok('Unir suma lo enviado; eliminar el pedido anula lo que estaba en preparación');

// 6. Ticket
console.log('\n6. Ticket de comanda...');
const { buildComandaHtml } = require('../print.js');
const html = buildComandaHtml({ n: 7, station: 'cocina', stationLabel: 'Cocina', type: 'envio', tableName: 'Mesa <3>', by: 'Ana', at: Date.now(), orderNote: 'Rápido', items: [{ name: 'Sopa & pan', qty: 2, note: 'sin sal' }] });
assert.match(html, /Cocina/); assert.match(html, /#7/); assert.match(html, /sin sal/); assert.match(html, /Nota: Rápido/);
assert.match(html, /Mesa &lt;3&gt;/); assert.match(html, /Sopa &amp; pan/);
assert(!/\$/.test(html.replace(/<style>[\s\S]*?<\/style>/g, '')), 'la comanda no lleva precios');
assert(!/ANULACIÓN/.test(html));
assert.match(buildComandaHtml({ type: 'anulacion', stationLabel: 'Barra', items: [{ name: 'Capuchino', qty: 1 }] }), /\*\*\* ANULACIÓN \*\*\*/);
ok('Sin precios, con nota, número, mesa y mesero; texto escapado; anulación marcada');

console.log('\n=== TODAS LAS PRUEBAS DE COMANDAS PASARON ===');
