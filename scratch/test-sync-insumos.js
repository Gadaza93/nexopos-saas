// scratch/test-sync-insumos.js
// Insumos, recetas y estaciones en la nube (supabase/migrations/20261029170000_insumos_y_recetas.sql): dos cajas reales
// (dos instancias de sync.js, cada una con su estado) contra una misma nube simulada con el trigger movimientos_insumos_aplicar.
// 1. Insumo nuevo: sube con su stock una vez y la otra caja lo descarga.
// 2. Venta y compra simultáneas en cajas distintas, sin internet: ambas se suman (no gana la última).
// 3. Respuesta perdida al subir un movimiento: el reintento no suma dos veces.
// 4. Descargar con cambios locales sin subir no los pisa; el catálogo editado aquí tampoco.
// 5. Borrar un insumo: queda inactivo en la nube y desaparece de la otra caja.
// 6. Plato preparado: tipo y receta viajan; la otra caja no le crea stock propio; venderlo no mueve stock de productos.
// 7. Estaciones de cocina: viajan en negocios.configuracion.
// 8. Proyecto sin la migración: no hay errores ni subidas de insumos.

const assert = require('assert');
const { createMockSupabase } = require('./mock-supabase.js');

console.log('=== PRUEBAS: INSUMOS Y RECETAS EN LA NUBE (DOS CAJAS) ===\n');

global.window = global;
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, readyState: 'complete' };
global.navigator = { onLine: true };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.today = () => '2026-10-29';
global.showToast = () => {};
global.scheduleSave = () => {};
global.renderAll = () => {};
global.__FORCE_DEMO_MODE__ = false;

const BID = 'rest_insumos';
const near = (a, b, msg) => assert(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

let seq = 0;
function nuevaCaja(nombre, sb) {
  delete require.cache[require.resolve('../sync.js')];
  global.supabase = { createClient: () => sb };
  const sync = require('../sync.js');
  const st = { profile: { syncId: BID, name: 'Restaurante', sync_status: 'synced' }, terminal: { businessId: BID }, products: [], inventory: [], insumos: [], categories: [], payments: [], expenses: [], purchases: [], suppliers: [], stockLog: [], orders: [] };
  const usar = () => { global.state = st; global.supabase = { createClient: () => sb }; };
  const ins = id => st.insumos.find(i => i.id === id);
  return {
    nombre, st, sync, ins,
    async descargar() { usar(); const r = await sync.pullAllFromSupabase(BID); assert.strictEqual(r.ok, true, `${nombre}: descarga`); },
    async subir() { usar(); return sync.syncAll(); },
    // Como saveInsumo (modules.js): nuevo y pendiente
    crearInsumo(id, name, unit, qty, cost) { st.insumos.push({ id, name, unit, qty, min: 1, cost, createdAt: Date.now(), updatedAt: Date.now(), sync_status: 'pending' }); },
    // Como consumeRecipe / savePurchase / saveWaste / applyCount: solo cambian qty (y la compra, el costo)
    mover(id, delta) { ins(id).qty = Math.round((ins(id).qty + delta) * 10000) / 10000; },
    comprar(id, qty, nuevoCosto) { this.mover(id, qty); Object.assign(ins(id), { cost: nuevoCosto, sync_status: 'pending', updatedAt: Date.now() }); },
    // Como deleteInsumo
    borrarInsumo(id) { const i = ins(id); st.insumos = st.insumos.filter(x => x !== i); if (Number.isFinite(i.qtySynced)) st.deletedInsumoIds = [...(st.deletedInsumoIds || []), id]; },
    venderPreparado(productId, qty) {
      usar();
      const items = [{ productId, name: 'Plato', price: 20000, qty, tipo: 'preparado', receta: [] }];
      st.payments.push({ id: `pay-${nombre}-${++seq}`, amount: 20000 * qty, method: 'Efectivo', payments: [], items, date: '2026-10-29', paidAt: Date.now(), sync_status: 'pending', pendingStock: sync.stockItemsQty(items) });
    }
  };
}

let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };
const nube = (sb, id) => sb.__tables.insumos.find(i => i.id === id);

(async () => {
  const sb = createMockSupabase({ businessId: BID, stockMovimientos: true, insumos: true, seed: { negocios: [{ id: BID, nombre: 'Restaurante', configuracion: {}, activo: true }] } });
  const A = nuevaCaja('A', sb), B = nuevaCaja('B', sb);

  // 1. Insumo nuevo
  A.crearInsumo('ins_arroz', 'Arroz', 'kg', 10, 4000);
  let r = await A.subir();
  assert.strictEqual(r.insumos.ok, true, r.insumos.error);
  assert.deepStrictEqual([nube(sb, 'ins_arroz').stock, nube(sb, 'ins_arroz').unidad, nube(sb, 'ins_arroz').costo], [10, 'kg', 4000]);
  assert.strictEqual(A.ins('ins_arroz').qtySynced, 10);
  assert.strictEqual(A.ins('ins_arroz').sync_status, 'synced');
  assert.strictEqual(A.sync.getPendingCount(), 0, 'nada pendiente después de subir');
  await B.descargar();
  assert.deepStrictEqual([B.ins('ins_arroz').qty, B.ins('ins_arroz').unit, B.ins('ins_arroz').cost, B.ins('ins_arroz').qtySynced], [10, 'kg', 4000, 10]);
  ok('Insumo nuevo sube con su stock (10 kg) y la caja B lo descarga');

  // 2. Venta en A y compra en B sin internet
  A.mover('ins_arroz', -0.3);           // 2 bandejas de 150 g
  B.comprar('ins_arroz', 5, 4200);      // bulto de 5 kg, costo promedio nuevo
  await A.subir(); await B.subir();
  near(nube(sb, 'ins_arroz').stock, 14.7, 'nube suma venta y compra');
  assert.strictEqual(nube(sb, 'ins_arroz').costo, 4200, 'el costo editado sube');
  assert.strictEqual(sb.__tables.movimientos_insumos.length, 2);
  await A.descargar(); await B.descargar();
  near(A.ins('ins_arroz').qty, 14.7, 'caja A'); near(B.ins('ins_arroz').qty, 14.7, 'caja B');
  assert.strictEqual(A.ins('ins_arroz').cost, 4200, 'A recibe el costo nuevo');
  ok('Venta (−0,3 kg) en A y compra (+5 kg) en B: 14,7 kg en la nube y en las dos cajas');

  // 3. Respuesta perdida
  A.mover('ins_arroz', -1);
  A.st.insumoMovements = []; global.state = A.st;
  r = await A.subir();
  const enviado = sb.__tables.movimientos_insumos.slice(-1)[0];
  // Como si la respuesta no hubiera llegado: el movimiento sigue en cola y la base no se movió
  A.st.insumoMovements = [{ id: enviado.id, insumoId: 'ins_arroz', delta: enviado.delta, motivo: 'ajuste', at: Date.now() }];
  A.ins('ins_arroz').qtySynced = Math.round((A.ins('ins_arroz').qtySynced - enviado.delta) * 1000) / 1000;
  await A.subir();
  near(nube(sb, 'ins_arroz').stock, 13.7, 'el reintento no descuenta dos veces');
  near(A.ins('ins_arroz').qty, 13.7, 'caja A');
  assert.strictEqual((A.st.insumoMovements || []).length, 0);
  ok('Respuesta perdida: el reintento usa el mismo id y no suma dos veces (13,7 kg)');

  // 4. Descargar con cambios locales sin subir
  A.mover('ins_arroz', -2);                                   // sin subir
  A.ins('ins_arroz').name = 'Arroz blanco'; A.ins('ins_arroz').sync_status = 'pending';
  B.mover('ins_arroz', 3); await B.subir();                   // nube 16,7
  await A.descargar();
  near(A.ins('ins_arroz').qty, 14.7, 'conserva lo no subido: 16,7 − 2');
  assert.strictEqual(A.ins('ins_arroz').name, 'Arroz blanco', 'el nombre editado aquí no se pisa');
  await A.subir(); await B.descargar();
  near(nube(sb, 'ins_arroz').stock, 14.7, 'nube'); near(B.ins('ins_arroz').qty, 14.7, 'caja B');
  assert.strictEqual(B.ins('ins_arroz').name, 'Arroz blanco');
  ok('Descargar no pisa movimientos ni catálogo sin subir; al subir, todo cuadra (14,7 kg)');

  // 5. Borrar
  B.crearInsumo('ins_sal', 'Sal', 'g', 500, 5); await B.subir(); await A.descargar();
  assert(A.ins('ins_sal'), 'A tiene la sal');
  A.borrarInsumo('ins_sal'); await A.subir();
  assert.strictEqual(nube(sb, 'ins_sal').activo, false, 'inactivo en la nube');
  await B.descargar();
  assert.strictEqual(B.ins('ins_sal'), undefined, 'B ya no lo tiene');
  await A.descargar();
  assert.strictEqual(A.ins('ins_sal'), undefined, 'no reaparece en A');
  ok('Borrar un insumo lo deja inactivo en la nube y lo quita de la otra caja');

  // 6. Plato preparado
  const receta = [{ insumoId: 'ins_arroz', qty: 150, unit: 'g' }];
  A.st.products.push({ id: 'p_bandeja', name: 'Bandeja', category: 'Platos fuertes', price: 30000, cost: 600, tipo: 'preparado', receta, recipe: {}, sync_status: 'pending' });
  await A.subir();
  const fila = sb.__tables.productos.find(p => p.id === 'p_bandeja');
  assert.deepStrictEqual([fila.tipo, fila.receta], ['preparado', receta]);
  A.venderPreparado('p_bandeja', 2);
  assert.deepStrictEqual(A.sync.stockItemsQty(A.st.payments[0].items), {}, 'un preparado no cuenta para el stock de productos');
  await A.subir();
  assert.strictEqual(sb.__tables.movimientos_stock.filter(m => m.producto_id === 'p_bandeja').length, 0, 'la venta no mueve stock del plato');
  await B.descargar();
  const enB = B.st.products.find(p => p.id === 'p_bandeja');
  assert.deepStrictEqual([enB.tipo, enB.receta], ['preparado', receta]);
  assert.strictEqual(enB.inventoryId, undefined, 'sin stock propio en B');
  assert.strictEqual(B.st.inventory.length, 0, 'sin artículo de inventario fantasma');
  // Vuelve a reventa en la nube: B lo recibe como producto con stock
  fila.tipo = 'reventa'; fila.receta = null;
  await B.descargar();
  assert.strictEqual(B.st.products.find(p => p.id === 'p_bandeja').tipo, undefined);
  ok('Plato preparado: tipo y receta viajan, B no le crea stock y su venta no mueve stock de productos');

  // 7. Estaciones de cocina
  A.st.profile = { ...A.st.profile, kitchenStations: { Bebidas: 'ninguna', Postres: 'barra' }, sync_status: 'pending' };
  await A.subir();
  assert.deepStrictEqual(sb.__tables.negocios.find(n => n.id === BID).configuracion.kitchenStations, { Bebidas: 'ninguna', Postres: 'barra' });
  await B.descargar();
  assert.deepStrictEqual(B.st.profile.kitchenStations, { Bebidas: 'ninguna', Postres: 'barra' });
  ok('Estaciones de cocina viajan en negocios.configuracion');

  // 8. Sin la migración
  const viejo = createMockSupabase({ businessId: BID, stockMovimientos: true, seed: { negocios: [{ id: BID, nombre: 'Restaurante', configuracion: {}, activo: true }] } });
  const C = nuevaCaja('C', viejo);
  C.crearInsumo('ins_x', 'X', 'kg', 1, 100);
  r = await C.subir();
  assert.deepStrictEqual(r.insumos, { ok: true, count: 0 });
  assert.strictEqual(viejo.__tables.insumos, undefined, 'no intenta escribir');
  await C.descargar();
  assert(C.ins('ins_x'), 'el insumo local se conserva');
  ok('Proyecto sin la migración: sin errores y sin subidas de insumos');

  console.log(`\n=== ${pasadas} PRUEBAS DE INSUMOS EN LA NUBE PASARON ===`);
  process.exit(0); // sync.js deja temporizadores de reconexión vivos
})().catch(err => { console.error('❌', err); process.exit(1); });
