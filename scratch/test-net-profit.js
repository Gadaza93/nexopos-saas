// scratch/test-net-profit.js
// Utilidad neta (Reportes → Utilidad neta) con el código REAL de app.js y modules.js:
// ventas netas − costo de ventas − gastos (caja menor + fijos) por rango de fechas, agrupación de gastos
// y que una cuenta dividida en partes iguales no duplique ventas ni costos.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: UTILIDAD NETA (código real) ===\n');

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
for (const file of ['demo-mode.js', 'planes.js', 'storage.js', 'modules.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
const get = code => JSON.parse(run(`JSON.stringify(${code})`));

// Fechas relativas a hoy para que la prueba no dependa del día en que corre
run(`
  renderAll = () => {}; renderOrderDialog = () => {}; showToast = () => {};
  var T = today(), base = parseISO(T);
  var day = n => { const d = new Date(base); d.setDate(d.getDate() + n); return localISO(d); };
  var firstOfMonth = localISO(new Date(base.getFullYear(), base.getMonth(), 1));
  var lastMonthDay = localISO(new Date(base.getFullYear(), base.getMonth() - 1, 15));
  state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [], expenses: [] });
  state.products = [{ id: 'p1', name: 'Cerveza', category: 'Cervezas', price: 6000, cost: 3000 }];
  var sale = (id, date, qty) => ({ id, date, createdAt: Date.now(), amount: 6000 * qty, method: 'Efectivo', items: [{ productId: 'p1', name: 'Cerveza', price: 6000, cost: 3000, qty }] });
  state.payments = [sale('hoy', T, 10), sale('mesPasado', lastMonthDay, 4)];
  // Cuenta dividida: abono hoy ($30.000) + factura que salda ($60.000 = 15 cervezas − ajuste de abonos)
  state.payments.push({ id: 'abono', date: T, createdAt: Date.now(), amount: 30000, method: 'Nequi', items: [{ name: 'Parte 1 de 3 · Mesa 1', qty: 1, price: 30000, splitLine: 'abono' }] });
  state.payments.push({ id: 'salda', date: T, createdAt: Date.now(), amount: 60000, method: 'Efectivo', items: [{ productId: 'p1', name: 'Cerveza', price: 6000, cost: 3000, qty: 15 }, { name: 'Abonos anteriores (cuenta dividida)', qty: 1, price: -30000, splitLine: 'ajuste' }] });
  var exp = (category, description, amount, date, method = 'Transferencia', shiftId = 'shift_x') => ({ id: uid('expense'), category, description, amount, method, date, shiftId });
  state.expenses = [
    exp('Arriendo', 'Arriendo local', 50000, T),
    exp('Servicios públicos', 'Internet', 10000, T),
    exp('Otros gastos', 'Pago DJ viernes', 20000, T),
    exp('Otros gastos', 'Hielo y limones', 5000, T, 'Efectivo'),
    exp('Marketing', 'Volantes', 3000, T),
    exp('Arriendo', 'Arriendo mes pasado', 999000, lastMonthDay),
  ];
`);

// --- A. Hoy: ventas, costo, gastos, utilidad y margen ---
let d = get('netProfitDataset(T, T)');
assert.strictEqual(d.sales, 60000 + 90000, 'Venta del día + cuenta dividida completa, sin duplicar el abono');
assert.strictEqual(d.cogs, 30000 + 45000, 'Costo de 25 cervezas; abono y ajuste no tienen costo');
assert.strictEqual(d.gross, 75000);
assert.strictEqual(d.expenses, 88000);
assert.strictEqual(d.net, -13000);
assert.ok(Math.abs(d.netMargin - (-13000 / 150000 * 100)) < 1e-9);
assert.strictEqual(d.fromDrawer, 5000, 'Solo el gasto en efectivo del turno sale del cajón');
console.log('   ✅ Hoy: ventas $150.000 − costo $75.000 − gastos $88.000 = −$13.000 (margen −8,7%).');

// --- B. Agrupación por categoría ---
const groups = Object.fromEntries(Object.entries(d.groups).map(([k, g]) => [k, g.total]));
assert.deepStrictEqual(groups, { Arriendo: 50000, Servicios: 10000, 'Personal': 20000, 'Insumos / caja menor': 5000, Otros: 3000 });
console.log('   ✅ Gastos agrupados: Arriendo, Servicios, Personal (por descripción), Insumos / caja menor y Otros.');

// --- C. Rangos: el mes pasado no se mezcla con este mes ---
run('netRange = "lastMonth";'); const lm = get('netBounds()'); d = get('netProfitDataset(netBounds().from, netBounds().to)');
assert.ok(lm.from.endsWith('-01') && lm.to < run('firstOfMonth'));
assert.strictEqual(d.sales, 24000); assert.strictEqual(d.expenses, 999000); assert.strictEqual(d.net, 12000 - 999000);
run('netRange = "month";'); d = get('netProfitDataset(netBounds().from, netBounds().to)');
assert.strictEqual(get('netBounds().from'), run('firstOfMonth'));
assert.strictEqual(d.expenses, 88000, 'El arriendo del mes pasado no entra en este mes');
run('netRange = "week";'); const wk = get('netBounds()');
assert.strictEqual(run(`parseISO(${JSON.stringify(wk.from)}).getDay()`), 1, 'La semana empieza el lunes');
assert.strictEqual(wk.to, run('T'));
run('netRange = "custom"; netFrom = T; netTo = day(-3);'); assert.deepStrictEqual(get('netBounds()'), { from: run('day(-3)'), to: run('T') }, 'Rango invertido se corrige');
console.log('   ✅ Rangos Hoy / Esta semana (desde el lunes) / Este mes / Mes pasado / Personalizado.');

// --- D. Render: tarjetas y estado de pérdida ---
run('netRange = "today"; renderNetProfit();');
assert.strictEqual(els['#netSales'].textContent, run('money.format(150000)'));
assert.ok(els['#netProfit'].textContent.startsWith('−'));
assert.ok(els['#netVerdict'].className.includes('loss'));
assert.ok(els['#netExpenseGroups'].innerHTML.includes('<details class="net-group">'));
assert.ok(!els['#netExpenseGroups'].innerHTML.includes('999.000'), 'No muestra gastos fuera del rango');
console.log('   ✅ Render: KPIs, veredicto en rojo por pérdida y desglose colapsable por categoría.');

// --- E. Excel de Utilidad neta: encabezado con el período, KPIs y gastos por categoría ---
run('netRange = "lastMonth";');
let sheets = get('netProfitSheets()');
const cells = row => row.map(c => (c && typeof c === 'object' ? c.v : c));
let rows = sheets[0].rows.map(cells);
assert.ok(String(rows[0][0]).startsWith('Utilidad Neta - Mes pasado'));
const kpi = label => rows.find(r => r[0] === label)?.[1];
assert.strictEqual(kpi('Ventas netas'), 24000); assert.strictEqual(kpi('Costo de mercancía vendida'), 12000);
assert.strictEqual(kpi('Gastos totales'), 999000); assert.strictEqual(kpi('Utilidad neta'), -987000);
assert.strictEqual(kpi('Margen neto'), Number((-987000 / 24000 * 100).toFixed(1)));
assert.deepStrictEqual(rows.find(r => r[0] === 'Arriendo'), ['Arriendo', 1, 999000, 100]);
assert.strictEqual(sheets[1].rows.length, 2, 'Detalle: encabezado + 1 gasto del mes pasado');
console.log('   ✅ Excel de utilidad neta: «Utilidad Neta - Mes pasado», KPIs y gastos por categoría.');

// --- F. Valoración de inventario ---
run(`
  state.products = [
    { id: 'p1', name: 'Cerveza', category: 'Cervezas', price: 6000, cost: 3000, inventoryId: 'stock-p1' },
    { id: 'p2', name: 'Ron', category: 'Licores', price: 90000, cost: 50000, inventoryId: 'stock-p2' },
    { id: 'p3', name: 'Agua', category: 'Bebidas', price: 3000, cost: 1000, inventoryId: 'stock-p3' },
  ];
  state.inventory = [{ id: 'stock-p1', qty: 24, unit: 'und' }, { id: 'stock-p2', qty: 3, unit: 'bot' }, { id: 'stock-p3', qty: -2, unit: 'und' }];
`);
const v = get('inventoryValuation()');
assert.strictEqual(v.capital, 24 * 3000 + 3 * 50000, 'El stock negativo se valoriza en 0');
assert.strictEqual(v.commercial, 24 * 6000 + 3 * 90000);
assert.strictEqual(v.profit, v.commercial - v.capital);
assert.ok(Math.abs(v.margin - v.profit / v.commercial * 100) < 1e-9);
assert.strictEqual(v.negative, 1);
assert.deepStrictEqual(v.rows.map(r => r.name), ['Ron', 'Cerveza', 'Agua'], 'Ordenado por capital invertido');
run('renderInventoryValue();');
assert.strictEqual(els['#invCapital'].textContent, run('money.format(222000)'));
assert.ok(els['#inventoryValueTable'].innerHTML.includes('Ron'));
rows = get('inventoryValueSheets()')[0].rows.map(cells);
assert.strictEqual(rows[0][0].startsWith('Inventario Valorizado'), true);
assert.deepStrictEqual(rows.find(r => r[0] === 'Ron'), ['Ron', 'Licores', 3, 'bot', 50000, 150000, 90000, 270000, 120000]);
assert.deepStrictEqual(rows.find(r => r[0] === 'Total').filter(x => x !== ''), ['Total', 222000, 414000, 192000]);
console.log('   ✅ Valoración de inventario: capital, valor comercial, ganancia, margen y Excel «Inventario Valorizado».');

// --- G. El botón Excel del encabezado exporta la sub-pestaña activa ---
run('var downloads = []; can = () => true; buildXlsx = s => s; downloadBlob = (b, name) => downloads.push(name);');
run('reportTab = "net"; netRange = "today"; exportReportXlsx(); reportTab = "inventory"; exportReportXlsx();');
const names = get('downloads');
assert.ok(names[0].startsWith('utilidad-neta-') && names[1].startsWith('inventario-valorizado-'), names.join(', '));
console.log('   ✅ Exportar Excel descarga utilidad neta o inventario según la sub-pestaña.');

console.log('\n✅ Todas las pruebas de utilidad neta y valoración de inventario pasaron.');
