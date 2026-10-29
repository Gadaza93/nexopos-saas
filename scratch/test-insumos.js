// scratch/test-insumos.js
// Insumos y recetas con el código REAL de app.js/modules.js (contexto vm, orden de index.html):
// 1. Unidades (kg↔g, L↔ml, lb), costo de receta y porciones disponibles.
// 2. Crear insumo; un plato preparado no crea stock propio ni productos fantasma; pasar de reventa a preparado.
// 3. Venta: el pedido guarda la receta, avisa si faltan insumos y al cobrar los descuenta (puede quedar en negativo).
// 4. Corrección de factura devuelve insumos; compra en otra unidad suma stock y recalcula costo promedio y costo del plato.
// 5. Merma y ajuste sobre insumos; no se elimina un insumo que está en una receta.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: INSUMOS Y RECETAS (código real) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, readOnly: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '',
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
  var toasts = [];
  renderAll = () => {}; renderOrderDialog = () => {}; showToast = msg => { toasts.push(String(msg)); };
  saveState = () => {};
  sendToPrinter = async () => ({ ok: true });
  NexoSync = { syncOrders: async () => {}, syncAll: async () => {}, scheduleSync() {} };
  function resetScenario() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [],
      insumos: [
        { id: 'ins_arroz', name: 'Arroz', unit: 'kg', qty: 10, min: 3, cost: 4000 },
        { id: 'ins_carne', name: 'Carne', unit: 'kg', qty: 0.2, min: 1, cost: 20000 },
        { id: 'ins_huevo', name: 'Huevo', unit: 'und', qty: 30, min: 10, cost: 600 },
        { id: 'ins_aceite', name: 'Aceite', unit: 'L', qty: 2, min: 1, cost: 9000 }
      ],
      products: [
        { id: 'ban', name: 'Bandeja', category: 'Platos fuertes', price: 30000, cost: 0, tipo: 'preparado',
          receta: [{ insumoId: 'ins_arroz', qty: 150, unit: 'g' }, { insumoId: 'ins_carne', qty: 150, unit: 'g' }, { insumoId: 'ins_huevo', qty: 1, unit: 'und' }, { insumoId: 'ins_aceite', qty: 20, unit: 'ml' }] },
        { id: 'gas', name: 'Gaseosa', category: 'Bebidas', price: 4000, cost: 2000, inventoryId: 'inv_gas' }
      ],
      inventory: [{ id: 'inv_gas', name: 'Gaseosa', unit: 'und', qty: 24, min: 6 }]
    });
    state.cashShift = { id: 'shift_t', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.users = [{ id: 'u_cajero', name: 'Luis', role: 'cajero', active: true }];
    session = 'u_cajero';
    state.orders = [{ id: 'o1', tableId: 'm1', tableName: 'Mesa 1', status: 'open', createdAt: Date.now(), items: [] }];
    state.currentOrderId = 'o1';
    toasts.length = 0;
  }
`);

// 1. Unidades, costo y disponibilidad
console.log('1. Unidades, costo de receta y porciones...');
run('resetScenario();');
near(get('convertUnits(150, "g", "kg")'), 0.15, 'g→kg');
near(get('convertUnits(2, "L", "ml")'), 2000, 'L→ml');
near(get('convertUnits(1, "lb", "g")'), 500, 'libra colombiana');
assert.deepStrictEqual(get('compatibleUnits("kg")'), ['kg', 'g', 'lb']);
// 0,15 kg × 4.000 + 0,15 kg × 20.000 + 1 × 600 + 0,02 L × 9.000 = 600 + 3.000 + 600 + 180
assert.strictEqual(get('recipeCost(state.products[0])'), 4380);
assert.strictEqual(get('preparedAvailable(state.products[0])'), 1, 'la carne (200 g) alcanza para 1 porción de 150 g');
ok('Conversión kg/g, L/ml y libra de 500 g; costo por porción $4.380; alcanza para 1');

// 2. Insumos y productos preparados en el estado
console.log('\n2. Estado: insumos y platos preparados...');
assert.strictEqual(get('state.products[0].inventoryId'), undefined, 'normalizeState no le crea stock propio al plato');
assert.deepStrictEqual(get('state.inventory.map(i => i.id)'), ['inv_gas']);
assert.deepStrictEqual(get('getPOSProducts().map(p => p.id)'), ['ban', 'gas'], 'los insumos no aparecen como productos vendibles');
setVal('#insumoName', 'Fríjol'); setVal('#insumoUnit', 'kg'); setVal('#insumoQty', '5'); setVal('#insumoMin', '2'); setVal('#insumoCost', '9000');
run('editingInsumoId = null; saveInsumo();');
const frijol = get('state.insumos.find(i => i.name === "Fríjol")');
assert.deepStrictEqual([frijol.unit, frijol.qty, frijol.min, frijol.cost], ['kg', 5, 2, 9000]);
assert(get('state.stockLog.some(e => e.itemName === "Fríjol" && e.delta === 5 && e.reasonCategory === "Stock inicial")'), 'el stock inicial queda en el historial');
run('editingInsumoId = null; saveInsumo();');
assert.match(get('toasts[toasts.length - 1]'), /Ya existe un insumo/);
// Gaseosa de reventa → preparado: su stock propio desaparece (si no, getPOSProducts lo volvería un producto aparte)
setVal('#productPrice', '5000');
run(`recipeDraft = [{ insumoId: 'ins_huevo', qty: 2, unit: 'und' }]; savePreparedProduct({ name: 'Huevos al gusto', category: 'Desayunos', price: 5000, editingId: 'gas' });`);
assert.strictEqual(get('state.products.find(p => p.id === "gas").tipo'), 'preparado');
assert.strictEqual(get('state.products.find(p => p.id === "gas").cost'), 1200);
assert.deepStrictEqual(get('state.inventory'), [], 'el stock propio se elimina');
assert.deepStrictEqual(get('getPOSProducts().map(p => p.id)').sort(), ['ban', 'gas'], 'sin productos fantasma');
run(`recipeDraft = []; savePreparedProduct({ name: 'Vacío', category: 'X', price: 1000 });`);
assert.match(get('toasts[toasts.length - 1]'), /al menos un insumo/);
ok('Insumo creado con stock inicial; nombre repetido rechazado; reventa → preparado sin stock fantasma; receta vacía rechazada');

// 3. Venta
console.log('\n3. Venta de un plato preparado...');
run('resetScenario(); addProduct("ban");');
const item = get('getOrder("o1").items[0]');
assert.strictEqual(item.tipo, 'preparado');
assert.strictEqual(item.cost, 4380, 'el costo de la venta sale de la receta');
assert.strictEqual(item.receta.length, 4, 'la receta viaja con el pedido');
assert.strictEqual(get('toasts.length'), 0, 'con insumos suficientes no hay aviso');
run('addProduct("ban");');
assert.strictEqual(get('getOrder("o1").items[0].qty'), 2);
run('state.insumos.find(i => i.id === "ins_carne").qty = 0; toasts.length = 0; addProduct("ban");');
assert.match(get('toasts[0]'), /Faltan insumos para Bandeja/, 'avisa pero deja vender');
assert.strictEqual(get('getOrder("o1").items[0].qty'), 3);
run(`state.insumos.find(i => i.id === "ins_carne").qty = 0.2;
  openPayment(); document.querySelector('#tenderCashReceived').value = '100000'; confirmPayment();`);
assert.strictEqual(get('state.payments.length'), 1);
const ins = Object.fromEntries(get('state.insumos.map(i => [i.id, i.qty])'));
near(ins.ins_arroz, 10 - 0.45, 'arroz');
near(ins.ins_carne, 0.2 - 0.45, 'la carne queda en negativo (vendido de más)');
near(ins.ins_huevo, 27, 'huevos');
near(ins.ins_aceite, 2 - 0.06, 'aceite');
assert.strictEqual(get('state.products[0].stock'), undefined, 'el plato no lleva stock propio');
ok('El pedido guarda receta y costo; aviso sin bloqueo; al cobrar 3 bandejas se descuentan 450 g arroz, 450 g carne, 3 huevos y 60 ml aceite');

// 4. Corrección de factura y compras
console.log('\n4. Corrección de factura y compras...');
run('adjustSoldStock(state.payments[0].items[0], -1);');
near(get('state.insumos.find(i => i.id === "ins_huevo").qty'), 28, 'quitar una bandeja de la factura devuelve sus insumos');
near(get('state.insumos.find(i => i.id === "ins_arroz").qty'), 9.7, 'arroz devuelto');
// Compra: 5.000 g de arroz a $20 el gramo ($100.000) → 5 kg a $20.000/kg; promedio con 9,7 kg a $4.000
setVal('#purchaseSupplier', 'Mayorista'); setVal('#purchaseInvoice', 'FE-1'); setVal('#purchaseDate', '2026-10-29'); setVal('#purchaseMethod', 'Transferencia');
run(`purchaseDraft = [{ productId: 'ins_arroz', qty: 5000, unit: 'g', unitCost: 20 }]; savePurchase();`);
const arroz = get('state.insumos.find(i => i.id === "ins_arroz")');
near(arroz.qty, 14.7, 'stock en kg');
assert.strictEqual(arroz.cost, Math.round((9.7 * 4000 + 100000) / 14.7 * 100) / 100, 'costo promedio ponderado por kg');
assert.strictEqual(arroz.lastCost, 20000);
assert.strictEqual(get('state.purchases[0].lines[0].productName'), 'Arroz');
assert.strictEqual(get('state.products[0].cost'), get('recipeCost(state.products[0])'), 'el costo del plato se actualiza con la compra');
assert(get('state.products[0].cost') > 4380);
assert.deepStrictEqual(get('purchasableItems().map(i => i.id)'), ['gas', 'ins_arroz', 'ins_carne', 'ins_huevo', 'ins_aceite'], 'se compran productos de reventa e insumos; la bandeja (preparada) no');
assert.strictEqual(get('defaultUnitCost(insumoById("ins_huevo"), "und")'), 600);
assert.strictEqual(get('defaultUnitCost({ unit: "kg", cost: 4000 }, "g")'), 4, 'costo sugerido en la unidad de compra');
ok('Factura corregida devuelve insumos; compra en gramos suma 5 kg y recalcula promedio y costo del plato');

// 5. Merma, ajuste y eliminación
console.log('\n5. Merma, ajuste y eliminación...');
setVal('#wasteItem', 'ins_aceite'); setVal('#wasteQty', '0.5'); setVal('#wasteReason', 'Vencido'); setVal('#wasteNote', '');
run('saveWaste();');
near(get('state.insumos.find(i => i.id === "ins_aceite").qty'), 2 - 0.06 + 0.02 - 0.5, 'merma de aceite (vendido 60 ml, devuelto 20 ml por la factura corregida)');
const merma = get('state.stockLog[state.stockLog.length - 1]');
assert.deepStrictEqual([merma.itemName, merma.unit, merma.delta, merma.value], ['Aceite', 'L', -0.5, -4500]);
setVal('#inventorySelect', 'ins_huevo'); setVal('#inventoryAmount', '12'); setVal('#inventoryReason', 'Llegó pedido');
run('saveInventory();');
near(get('state.insumos.find(i => i.id === "ins_huevo").qty'), 40, 'ajuste suma huevos');
assert.match(get('stockItemOptions()'), /<optgroup label="Insumos">/);
run('deleteInsumo("ins_huevo");');
assert(get('state.insumos.some(i => i.id === "ins_huevo")'), 'no se elimina un insumo usado en recetas');
assert.match(get('toasts[toasts.length - 1]'), /receta de Bandeja/);
run('state.insumos.push({ id: "ins_sal", name: "Sal", unit: "g", qty: 0, min: 0, cost: 0 }); deleteInsumo("ins_sal");');
assert(!get('state.insumos.some(i => i.id === "ins_sal")'), 'uno sin recetas sí se elimina');
ok('Merma valorizada al costo del insumo; ajuste manual; eliminar protegido si está en recetas');

// 6. Crear un insumo desde la receta del producto
console.log('\n6. «+ Crear insumo» desde la receta...');
run(`resetScenario(); recipeDraft = [{ insumoId: 'ins_arroz', qty: 150, unit: 'g' }, { insumoId: 'ins_arroz', qty: 0, unit: 'g' }];
  openInsumoDialog(null, { forRecipe: true });`);
setVal('#insumoName', 'Lenteja'); setVal('#insumoUnit', 'kg'); setVal('#insumoQty', '2'); setVal('#insumoMin', '1'); setVal('#insumoCost', '7000');
run('saveInsumo();');
const lenteja = get('state.insumos.find(i => i.name === "Lenteja")');
assert.deepStrictEqual([lenteja.qty, lenteja.unit], [2, 'kg'], 'se crea con su stock');
assert.deepStrictEqual(get('recipeDraft.map(l => [l.insumoId, l.qty, l.unit])'), [['ins_arroz', 150, 'g'], [lenteja.id, 0, 'g']], 'reemplaza la línea vacía, en gramos');
assert.match(get('toasts[toasts.length - 1]'), /Lenteja creado y agregado a la receta/);
run(`openInsumoDialog(null, { forRecipe: true });`);
setVal('#insumoName', 'Sal'); setVal('#insumoUnit', 'g'); setVal('#insumoQty', '500'); setVal('#insumoMin', '0'); setVal('#insumoCost', '5');
run(`recipeDraft[1].qty = 200; saveInsumo();`);
assert.strictEqual(get('recipeDraft.length'), 3, 'con todas las líneas llenas, agrega una nueva');
run(`openInsumoDialog(); document.querySelector('#insumoName').value = 'Ajo'; saveInsumo();`);
assert.strictEqual(get('recipeDraft.length'), 3, 'desde Inventario no toca la receta');
ok('Creado desde la receta queda en ella (reutiliza la línea vacía); desde Inventario no la toca');

console.log('\n=== TODAS LAS PRUEBAS DE INSUMOS PASARON ===');
