// scratch/test-stock-movimientos.js
// Stock por movimientos (supabase/sql/2026-10-28_stock_por_movimientos.sql): dos cajas reales (dos instancias de sync.js,
// cada una con su estado) contra una misma nube simulada con los triggers ventas_stock y movimientos_stock_aplicar.
// 1. Ventas cruzadas sin internet: 10 − 3 − 2 = 5 en la nube y en las dos cajas (antes ganaba la última: 8).
// 2. Compra, merma y venta simultáneas en cajas distintas: todas se suman.
// 3. Conteo físico (solo cambia el insumo de inventario): sube como movimiento.
// 4. Respuesta perdida al subir un movimiento o una venta: el reintento no suma dos veces.
// 5. Factura editada y factura borrada devolviendo stock.
// 6. Descargar con cambios locales sin subir no los pisa.
// 7. Producto nuevo con una venta antes de subirlo: stock absoluto una sola vez, sin doble descuento.
// 8. Vender de más deja stock negativo igual en la caja y en la nube (sin ajustes fantasma).
// 9. Sin la tabla (SQL sin aplicar): modo anterior, stock absoluto y ningún movimiento.

const assert = require('assert');
const { createMockSupabase } = require('./mock-supabase.js');

console.log('=== PRUEBAS: STOCK POR MOVIMIENTOS (DOS CAJAS) ===\n');

global.window = global;
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, readyState: 'complete' };
global.navigator = { onLine: true };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.today = () => '2026-10-28';
global.showToast = () => {};
global.scheduleSave = () => {};
global.renderAll = () => {};
global.__FORCE_DEMO_MODE__ = false;

const BID = 'bar_stock';
const producto = (id, stock) => ({ id, business_id: BID, nombre: `Producto ${id}`, categoria: 'Cervezas', precio: 5000, costo: 2000, stock, min_stock: 2, activo: true, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });

let seq = 0;
function nuevaCaja(nombre, sb) {
  delete require.cache[require.resolve('../sync.js')];
  global.supabase = { createClient: () => sb };
  const sync = require('../sync.js');
  const st = { profile: { syncId: BID, name: 'Bar' }, terminal: { businessId: BID }, products: [], inventory: [], categories: [], payments: [], expenses: [], purchases: [], suppliers: [], stockLog: [], orders: [] };
  const usar = () => { global.state = st; global.supabase = { createClient: () => sb }; };
  const prod = id => st.products.find(p => p.id === id);
  const insumo = id => st.inventory.find(i => i.id === (prod(id).inventoryId || `stock-${id}`));
  const fijar = (id, v) => { const p = prod(id); p.stock = Math.round(v * 1000) / 1000; insumo(id).qty = p.stock; };
  return {
    nombre, st, sync,
    async descargar() { usar(); const r = await sync.pullAllFromSupabase(BID); assert.strictEqual(r.ok, true, `${nombre}: descarga`); },
    async subir() { usar(); return sync.syncAll(); },
    stock: id => insumo(id).qty,
    // Como deductInventory (app.js): resta del producto y su insumo, sin tope en 0, y la venta guarda lo que la nube descontará
    vender(id, qty) {
      usar();
      const items = [{ productId: id, name: `Producto ${id}`, price: 5000, qty }];
      fijar(id, this.stock(id) - qty); prod(id).sync_status = 'pending';
      const venta = { id: `pay-${nombre}-${++seq}`, amount: 5000 * qty, method: 'Efectivo', payments: [], items, date: '2026-10-28', paidAt: Date.now(), sync_status: 'pending', pendingStock: sync.stockItemsQty(items) };
      st.payments.push(venta); return venta;
    },
    comprar(id, qty) { fijar(id, this.stock(id) + qty); prod(id).sync_status = 'pending'; },
    merma(id, qty) { fijar(id, this.stock(id) - qty); prod(id).sync_status = 'pending'; },
    contar(id, contado) { insumo(id).qty = contado; }, // applyCount: solo el insumo
    // Como la edición de facturas (modules.js): ajusta el stock local y la diferencia pendiente para la nube
    editarVenta(venta, nuevaQty) {
      usar();
      const id = venta.items[0].productId, delta = nuevaQty - venta.items[0].qty;
      fijar(id, this.stock(id) - delta); sync.addSaleStockDelta(venta, id, delta);
      venta.items = [{ ...venta.items[0], qty: nuevaQty }]; venta.sync_status = 'pending'; venta.editedAt = Date.now();
    },
    // Como confirmDeleteInvoice con «devolver inventario»
    borrarVenta(venta) {
      usar();
      fijar(venta.items[0].productId, this.stock(venta.items[0].productId) + venta.items[0].qty);
      sync.deleteSale(venta.id); st.payments = st.payments.filter(p => p !== venta);
    },
  };
}

let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };
const nubeStock = (sb, id) => sb.__tables.productos.find(p => p.id === id).stock;

(async () => {
  const sb = createMockSupabase({ businessId: BID, stockMovimientos: true, seed: { negocios: [{ id: BID, nombre: 'Bar', configuracion: {}, activo: true }], productos: [producto('cerveza', 10), producto('ron', 4)] } });
  const A = nuevaCaja('A', sb), B = nuevaCaja('B', sb);
  await A.descargar(); await B.descargar();
  assert.strictEqual(A.stock('cerveza'), 10); assert.strictEqual(B.stock('cerveza'), 10);
  assert.strictEqual(A.st.products.find(p => p.id === 'cerveza').stockSynced, 10, 'base conocida al descargar');

  // 1. Ventas cruzadas sin internet
  A.vender('cerveza', 3); B.vender('cerveza', 2);
  await A.subir(); await B.subir();
  assert.strictEqual(nubeStock(sb, 'cerveza'), 5, `nube: ${nubeStock(sb, 'cerveza')} (antes ganaba la última caja: 8)`);
  await A.descargar(); await B.descargar();
  assert.strictEqual(A.stock('cerveza'), 5); assert.strictEqual(B.stock('cerveza'), 5);
  assert.strictEqual(sb.__tables.movimientos_stock.filter(m => m.motivo === 'ajuste').length, 0, 'las ventas no generan ajustes');
  ok('ventas cruzadas sin internet: 10 − 3 − 2 = 5 en la nube y en las dos cajas (antes quedaba 8)');

  // 2. Compra en A; merma y venta en B, a la vez
  A.comprar('cerveza', 12); B.merma('cerveza', 1); B.vender('cerveza', 1);
  await B.subir(); await A.subir(); await A.descargar(); await B.descargar();
  assert.strictEqual(nubeStock(sb, 'cerveza'), 15);
  assert.strictEqual(A.stock('cerveza'), 15); assert.strictEqual(B.stock('cerveza'), 15);
  ok('compra (+12), merma (−1) y venta (−1) simultáneas en cajas distintas: 15 en todas partes');

  // 3. Conteo físico
  A.contar('cerveza', 20);
  await A.subir(); await B.descargar();
  assert.strictEqual(nubeStock(sb, 'cerveza'), 20); assert.strictEqual(B.stock('cerveza'), 20);
  const conteo = sb.__tables.movimientos_stock.at(-1);
  assert.strictEqual(conteo.delta, 5); assert.strictEqual(conteo.motivo, 'ajuste');
  ok('conteo físico (solo cambia el insumo): sube como movimiento de +5 y llega a la otra caja');

  // 4. Respuestas perdidas: la nube aplicó, la caja vio un error
  const fromReal = sb.from;
  let perder = null;
  sb.from = table => {
    const q = fromReal(table);
    if (table !== perder) return q;
    const upsert = q.upsert;
    q.upsert = (...args) => { upsert(...args); const thenReal = q.then; q.then = (res, rej) => thenReal.call(q, () => { perder = null; return { data: null, error: { message: 'Failed to fetch' } }; }).then(res, rej); return q; };
    return q;
  };
  A.comprar('ron', 6); perder = 'movimientos_stock';
  let r = await A.subir();
  assert.strictEqual(r.stock.ok, false, 'la caja ve el error');
  assert.strictEqual(nubeStock(sb, 'ron'), 10, 'pero la nube sí lo aplicó');
  await A.subir();
  assert.strictEqual(nubeStock(sb, 'ron'), 10, 'el reintento no suma dos veces');
  assert.strictEqual(A.st.stockMovements.length, 0);
  B.vender('ron', 2); perder = 'ventas';
  await B.subir();
  assert.strictEqual(nubeStock(sb, 'ron'), 8);
  await B.subir();
  assert.strictEqual(nubeStock(sb, 'ron'), 8, 'reintentar la venta no descuenta otra vez');
  await A.descargar(); await B.descargar();
  assert.strictEqual(A.stock('ron'), 8); assert.strictEqual(B.stock('ron'), 8);
  sb.from = fromReal;
  ok('respuesta perdida al subir un movimiento o una venta: el reintento no suma ni descuenta dos veces');

  // 5. Factura editada (3 → 5) y factura borrada devolviendo stock
  const venta = A.vender('ron', 3);
  await A.subir();
  assert.strictEqual(nubeStock(sb, 'ron'), 5);
  A.editarVenta(venta, 5);
  await A.subir(); await B.descargar();
  assert.strictEqual(nubeStock(sb, 'ron'), 3); assert.strictEqual(A.stock('ron'), 3); assert.strictEqual(B.stock('ron'), 3);
  A.borrarVenta(venta);
  await A.subir(); await B.descargar();
  assert.strictEqual(nubeStock(sb, 'ron'), 8); assert.strictEqual(A.stock('ron'), 8); assert.strictEqual(B.stock('ron'), 8);
  ok('factura editada (3 → 5) descuenta 2 más; borrarla devolviendo stock suma las 5: igual en las dos cajas');

  // 6. Descargar con cambios locales sin subir
  B.vender('cerveza', 4); B.comprar('ron', 1);
  A.vender('cerveza', 1); await A.subir();
  await B.descargar(); // sin subir antes
  assert.strictEqual(B.stock('cerveza'), 15, '20 − 1 (de A) − 4 (de B, sin subir)');
  assert.strictEqual(B.stock('ron'), 9, 'la compra sin subir se conserva');
  await B.subir(); await A.descargar(); await B.descargar();
  assert.strictEqual(nubeStock(sb, 'cerveza'), 15); assert.strictEqual(nubeStock(sb, 'ron'), 9);
  assert.strictEqual(A.stock('cerveza'), 15); assert.strictEqual(B.stock('cerveza'), 15);
  ok('descargar con ventas y compras locales sin subir no las pisa; al subir, todo cuadra');

  // 7. Producto nuevo con una venta antes de subirlo
  A.st.products.push({ id: 'nachos', name: 'Nachos', category: 'Comidas', price: 18000, cost: 7000, stock: 8, inventoryId: 'inv-nachos', recipe: { 'inv-nachos': 1 }, sync_status: 'pending' });
  A.st.inventory.push({ id: 'inv-nachos', name: 'Nachos', unit: 'und', qty: 8, min: 2 });
  A.vender('nachos', 2);
  await A.subir();
  assert.strictEqual(nubeStock(sb, 'nachos'), 6, `nube: ${nubeStock(sb, 'nachos')} (el alta sube 8 y la venta descuenta 2)`);
  await A.descargar(); await B.descargar();
  assert.strictEqual(A.stock('nachos'), 6); assert.strictEqual(B.stock('nachos'), 6);
  await A.subir();
  assert.strictEqual(nubeStock(sb, 'nachos'), 6, 'sin movimientos fantasma después');
  ok('producto nuevo con una venta antes de subirlo: 8 − 2 = 6, sin doble descuento');

  // 8. Vender de más
  A.vender('nachos', 4); B.vender('nachos', 4);
  await A.subir(); await B.subir(); await A.descargar(); await B.descargar();
  assert.strictEqual(nubeStock(sb, 'nachos'), -2);
  assert.strictEqual(A.stock('nachos'), -2); assert.strictEqual(B.stock('nachos'), -2);
  await A.subir(); await B.subir();
  assert.strictEqual(nubeStock(sb, 'nachos'), -2, 'sin ajustes fantasma');
  ok('vender de más entre dos cajas deja −2 en la nube y en las cajas (se ve el faltante, sin ajustes fantasma)');

  // 9. Sin la tabla: modo anterior
  const viejo = createMockSupabase({ businessId: BID, seed: { negocios: [{ id: BID, nombre: 'Bar', configuracion: {}, activo: true }], productos: [producto('cerveza', 10)] } });
  const C = nuevaCaja('C', viejo);
  await C.descargar();
  assert.strictEqual(C.st.products[0].stockSynced, undefined, 'sin base en el modo anterior');
  C.vender('cerveza', 3); C.comprar('cerveza', 1);
  r = await C.subir();
  assert.strictEqual(nubeStock(viejo, 'cerveza'), 8, 'sube el stock absoluto');
  assert.strictEqual(r.stock.count, 0);
  assert.strictEqual(viejo.__tables.movimientos_stock, undefined, 'no toca la tabla inexistente');
  ok('sin la tabla (SQL sin aplicar): modo anterior, stock absoluto y ningún movimiento');

  console.log(`\n${pasadas} PRUEBAS SUPERADAS`);
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
