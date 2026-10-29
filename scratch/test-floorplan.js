// scratch/test-floorplan.js
// Plano de mesas con el código REAL de app.js, modules.js y sync.js:
// disposición por defecto para datos sin coordenadas, vista operativa (tocar abre el pedido), diseñador con arrastre,
// guardado con validaciones, sincronización por negocios.configuracion.floorPlan y bloqueo de altas/bajas en demo.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: PLANO DE MESAS (código real) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {}, listeners = {};
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, closest: () => null, click() {}, scrollIntoView() {},
    querySelector: () => mockElement(), querySelectorAll: () => [], append() {}, appendChild() {}, matches: () => false,
    setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 })
  };
}
const document = {
  querySelector: sel => (els[sel] = els[sel] || mockElement()), querySelectorAll: () => [],
  addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
  createElement: () => mockElement(), body: mockElement(), documentElement: mockElement(), visibilityState: 'visible'
};
const memoryStorage = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const ctx = {
  console, document, window: { location: { search: '' }, addEventListener() {}, confirm: () => true }, navigator: { onLine: false },
  localStorage: memoryStorage(), sessionStorage: memoryStorage(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  structuredClone, Intl, crypto: globalThis.crypto, URLSearchParams, CSS: { escape: s => s }, __IS_NODE_TEST__: true
};
ctx.globalThis = ctx; ctx.window.document = document;
vm.createContext(ctx);
for (const file of ['demo-mode.js', 'planes.js', 'storage.js', 'modules.js', 'sync.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
const get = code => JSON.parse(run(`JSON.stringify(${code})`));
run(`var toasts = []; showToast = m => toasts.push(String(m)); can = () => true; logAudit = () => {};
  function fresh() {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [] });
    floorDraft = null; floorDirty = false; floorSelected = null; floorDrag = null; toasts.length = 0;
  }`);
const overlap = (a, b) => run(`floorOverlaps(${JSON.stringify(a)}, ${JSON.stringify(b)})`);

// --- A. Datos anteriores sin coordenadas: disposición ordenada por defecto ---
run('fresh();');
let tables = get('state.tables');
assert.strictEqual(tables.length, 10);
assert.deepStrictEqual(tables.filter(t => t.tipo === 'mostrador').map(t => t.id), ['b1', 'b2'], 'Las barras existentes (type: bar) pasan a mostrador');
for (const t of tables) {
  const s = get(`FLOOR_SIZE[${JSON.stringify(t.tipo)}]`);
  assert.ok(t.posX - s.w / 2 >= 0 && t.posX + s.w / 2 <= 100 && t.posY - s.h / 2 >= 0 && t.posY + s.h / 2 <= 100, `${t.name} queda dentro del lienzo`);
}
for (let i = 0; i < tables.length; i++) for (let j = i + 1; j < tables.length; j++) assert.ok(!overlap(tables[i], tables[j]), `${tables[i].name} y ${tables[j].name} no se tapan`);
console.log('   ✅ Las 10 mesas por defecto reciben tipo y posición, dentro del lienzo y sin superponerse.');

// --- B. Coordenadas guardadas se respetan; una mesa nueva sin coordenadas busca hueco ---
run(`state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [], tables: [
  { id: 'x1', name: 'Mesa A', zone: 'Salón', tipo: 'mesa', posX: 30, posY: 40 },
  { id: 'x2', name: 'Mesa B', zone: 'Salón' } ] });`);
tables = get('state.tables');
assert.deepStrictEqual([tables[0].posX, tables[0].posY], [30, 40]);
assert.ok(Number.isFinite(tables[1].posX) && !overlap(tables[0], tables[1]));
run(`state.tables = ensureTableLayout([{ id: 'z', name: 'Z', zone: 'Salón', tipo: 'mesa', posX: 150, posY: -20 }]);`);
assert.deepStrictEqual(get('[state.tables[0].posX, state.tables[0].posY]'), [93.5, 11], 'Coordenadas fuera de rango se ajustan al borde');
console.log('   ✅ Se conservan posiciones guardadas, las mesas sin coordenadas buscan un hueco libre y nada se sale del lienzo.');

// --- C. Vista operativa: plano y cuadrícula; tocar una mesa abre su pedido ---
run('fresh(); state.orders.push({ id: "o1", tableId: "m2", tableName: "Mesa 2", status: "open", createdAt: Date.now(), items: [{ productId: "p", name: "Cerveza", price: 8000, qty: 2 }] });');
run('setTableView("plano");');
let floor = els['#tableFloor'].innerHTML;
assert.strictEqual((floor.match(/class="floor-item /g) || []).length, 10);
assert.ok(/class="floor-item mostrador free" data-table="b1"/.test(floor), 'Barra 1 como mostrador disponible');
assert.ok(/class="floor-item mesa occupied" data-table="m2"/.test(floor) && floor.includes(run('money.format(16000)')), 'Mesa 2 ocupada con su saldo');
const m1 = get('state.tables.find(t => t.id === "m1")');
assert.ok(floor.includes(`data-table="m1" style="left:${m1.posX}%;top:${m1.posY}%"`), 'Se pinta en la posición guardada');
assert.strictEqual(els['#tableFloorWrap'].hidden, false); assert.strictEqual(els['#tableGrid'].hidden, true);
run('setTableView("grid");');
assert.ok(els['#tableGrid'].innerHTML.includes('class="table-card'), 'Cuadrícula compacta');
assert.strictEqual(els['#tableFloorWrap'].hidden, true);
assert.strictEqual(run('localStorage.getItem("nexopos-table-view")'), 'grid', 'La vista elegida se recuerda en el dispositivo');
run('setTableView("plano"); var opened = []; openOrder = id => opened.push(id);');
const tap = { dataset: { table: 'm1' }, id: '', textContent: '' };
listeners.click.forEach(fn => { try { fn({ target: { closest: sel => (sel === 'button' ? tap : null) }, preventDefault() {} }); } catch { /* otros manejadores de prueba */ } });
assert.deepStrictEqual(get('opened'), ['m1'], 'Tocar una mesa del plano abre su pedido');
console.log('   ✅ Salón: plano con posiciones guardadas, verde/rojo con saldo, cuadrícula alternativa y toque que abre la mesa.');

// --- D. Diseñador: agregar, arrastrar, cambiar tipo, renombrar y guardar ---
run('fresh();');
run('addFloorItem("mesa"); addFloorItem("mostrador");');
let draft = get('floorDraft');
assert.strictEqual(draft.length, 12); assert.strictEqual(get('state.tables.length'), 10, 'Nada cambia hasta guardar');
const newMesa = draft[10], newBar = draft[11];
assert.strictEqual(newMesa.name, 'Mesa 5'); assert.strictEqual(newBar.name, 'Barra 3'); assert.strictEqual(newBar.tipo, 'mostrador');
for (const t of draft.slice(0, 10)) assert.ok(!overlap(newMesa, t) && !overlap(newBar, t), 'Lo nuevo aparece en un hueco libre');
// Arrastre: 80 px a la derecha y 50 px abajo en un lienzo de 800×500 → +10 % y +10 %
run(`var item = { dataset: { floorItem: ${JSON.stringify(newMesa.id)} }, style: {}, classList: { add() {} }, setPointerCapture() {} };
  item.closest = sel => sel === '[data-floor-item]' ? item : (sel === '#floorplan-designer' || sel === '.floorplan-stage') ? els_canvas : null;
  var els_canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 }) };
  handleFloorPointerDown({ target: { closest: s => item.closest(s) }, button: 0, pointerId: 7, clientX: 100, clientY: 100, preventDefault() {} });
  handleFloorPointerMove({ pointerId: 7, clientX: 180, clientY: 150 });
  handleFloorPointerUp({ pointerId: 7 });`);
const moved = get(`floorDraft.find(t => t.id === ${JSON.stringify(newMesa.id)})`);
assert.deepStrictEqual([moved.posX, moved.posY], get(`[clampFloorPos("mesa", ${newMesa.posX} + 10, ${newMesa.posY} + 10).posX, clampFloorPos("mesa", ${newMesa.posX} + 10, ${newMesa.posY} + 10).posY]`));
assert.strictEqual(get('floorSelected'), newMesa.id); assert.strictEqual(get('floorDirty'), true);
// Un toque (sin moverse) solo selecciona
run(`floorSelected = null; handleFloorPointerDown({ target: { closest: s => item.closest(s) }, button: 0, pointerId: 8, clientX: 10, clientY: 10, preventDefault() {} }); handleFloorPointerMove({ pointerId: 8, clientX: 12, clientY: 11 }); handleFloorPointerUp({ pointerId: 8 });`);
assert.deepStrictEqual(get(`[floorDraft.find(t => t.id === ${JSON.stringify(newMesa.id)}).posX, floorSelected]`), [moved.posX, newMesa.id], 'Un toque de 2 px no mueve la mesa');
run('setFloorTipo("mostrador"); updateFloorSelected({ name: "  Barra VIP  ", zone: "VIP" });');
run('state.orders.push({ id: "o2", tableId: "m1", tableName: "Mesa 1", status: "open", createdAt: Date.now(), items: [{ name: "Agua", price: 3000, qty: 1 }] });');
run('beginFloorDraft().find(t => t.id === "m1").name = "Mesa Ventana";');
run('saveFloorLayout();');
const saved = get(`state.tables.find(t => t.id === ${JSON.stringify(newMesa.id)})`);
assert.deepStrictEqual([saved.name, saved.zone, saved.tipo, saved.type], ['Barra VIP', 'VIP', 'mostrador', 'bar']);
assert.strictEqual(get('state.tables.length'), 12);
assert.strictEqual(get('state.orders.find(o => o.id === "o2").tableName'), 'Mesa Ventana', 'Renombrar actualiza el pedido abierto');
const plan = get('state.profile.floorPlan');
assert.strictEqual(plan.tables.length, 12); assert.ok(plan.updatedAt > 0);
assert.strictEqual(get('state.profile.sync_status'), 'pending', 'Marca el negocio para subir a Supabase');
assert.ok(get('sanitizeNegocio(state.profile, "nexopos_default").configuracion.floorPlan.tables.length') === 12, 'El plano viaja en negocios.configuracion');
assert.strictEqual(get('floorDirty'), false);
console.log('   ✅ Diseñador: + Mesa / + Mostrador en hueco libre, arrastre en %, toque que solo selecciona, tipo, nombre, zona y guardado con sync.');

// --- E. Validaciones al guardar y al eliminar ---
run('fresh(); state.orders.push({ id: "o3", tableId: "m3", tableName: "Mesa 3", status: "open", createdAt: Date.now(), items: [{ name: "Agua", price: 3000, qty: 1 }] });');
run('beginFloorDraft(); floorSelected = "m3"; deleteFloorItem();');
assert.strictEqual(get('floorDraft.length'), 10); assert.ok(run('toasts[toasts.length - 1]').includes('pedido activo'));
run('floorSelected = "m4"; deleteFloorItem();');
assert.strictEqual(get('floorDraft.some(t => t.id === "m4")'), false, 'Una mesa vacía sí se elimina');
run('floorDraft.find(t => t.id === "m1").name = "mesa 2"; saveFloorLayout();');
assert.ok(run('toasts[toasts.length - 1]').includes('dos mesas'), 'Nombres repetidos se rechazan');
assert.strictEqual(get('state.tables.some(t => t.id === "m4")'), true, 'No se guardó nada');
run('discardFloorLayout();'); assert.strictEqual(get('floorDraft'), null);
console.log('   ✅ No se elimina una mesa con pedido abierto, se rechazan nombres repetidos y «Descartar» deshace el borrador.');

// --- F. Sincronización desde otra caja ---
run('fresh(); state.profile.floorPlan = { updatedAt: 1000, tables: [] };');
const remoteTables = [{ id: 'r1', name: 'Mesa Remota', zone: 'Salón', tipo: 'mesa', posX: 20, posY: 30 }];
assert.strictEqual(run(`applyRemoteFloorPlan({ updatedAt: 500, tables: ${JSON.stringify(remoteTables)} })`), false, 'Un plano remoto más viejo no se aplica');
assert.strictEqual(get('state.tables.length'), 10);
run('state.orders.push({ id: "o4", tableId: "m1", tableName: "Mesa 1", status: "open", createdAt: Date.now(), items: [{ name: "Agua", price: 3000, qty: 1 }] });');
assert.strictEqual(run(`applyRemoteFloorPlan({ updatedAt: 2000, tables: ${JSON.stringify(remoteTables)} })`), true);
assert.deepStrictEqual(get('state.tables.map(t => t.id)'), ['r1', 'm1'], 'Aplica el remoto y conserva la mesa local con pedido abierto');
assert.deepStrictEqual(get('[state.tables[0].posX, state.tables[0].posY]'), [20, 30]);
// En la descarga completa, la configuración remota pisa profile.floorPlan: si el local era más nuevo, se restaura
run('state.profile.floorPlan = { updatedAt: 9000, tables: [] }; var localPlan = state.profile.floorPlan; state.profile = { ...state.profile, floorPlan: { updatedAt: 3000, tables: [{ id: "q" }] } };');
assert.strictEqual(run('applyRemoteFloorPlan(state.profile.floorPlan, localPlan)'), false);
assert.strictEqual(get('state.profile.floorPlan.updatedAt'), 9000, 'El plano local más reciente no se pierde al descargar');
console.log('   ✅ Sync: solo se aplica un plano remoto más reciente, se conservan mesas con pedido y no se pierde el plano local más nuevo.');

// --- G. Modo demo: número de mesas fijo (normalizeState reinicia el demo si no hay 4) ---
run('globalThis.__FORCE_DEMO_MODE__ = true; fresh(); addFloorItem("mesa");');
assert.strictEqual(get('floorDraft'), null); assert.ok(run('toasts[toasts.length - 1]').includes('demo'));
assert.strictEqual(get('state.tables.length'), 4); assert.ok(get('state.tables.every(t => Number.isFinite(t.posX) && t.tipo === "mesa")'));
assert.strictEqual(run('applyRemoteFloorPlan({ updatedAt: 99999, tables: [{ id: "r" }] })'), false, 'El demo nunca aplica planos de la nube');
run('globalThis.__FORCE_DEMO_MODE__ = false;');
console.log('   ✅ Demo: se pueden mover las 4 mesas, pero no agregar ni eliminar, y no se aplican planos de la nube.');

console.log('\n✅ Todas las pruebas del plano de mesas pasaron.');
