// scratch/test-pull-pagination.js
// Descarga desde Supabase con tablas grandes. El simulador corta en 1000 filas por consulta, como PostgREST.
// 1. Equipo nuevo: llegan las 2500 ventas, 1200 productos, 1500 gastos y 1100 mermas (antes llegaban 1000).
// 2. Equipo con historial: no se borra ninguna venta local (antes se borraban las que no venían en las 1000).
// 3. Segunda descarga: las ventas conocidas solo viajan como id; las filas completas, solo las nuevas.
// 4. Borrado remoto: se elimina localmente; una venta pendiente de subir se conserva.
// 5. Falla una página de ids: no se borra nada.
// 6. Otra caja inserta mientras se pagina: no se pierde ni se borra ninguna fila existente.
// 7. Equipo nuevo con 40.000 ventas: la mezcla usa índices por id (antes, find dentro del forEach congelaba la pestaña).
// 8. Ventana de 90 días (storage.js): solo se piden las ventas desde historialVentanaDesde(); las anteriores no se
//    descargan ni se borran del equipo.

const assert = require('assert');

console.log('=== PRUEBAS: DESCARGA PAGINADA DESDE SUPABASE ===\n');

global.window = global;
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, readyState: 'complete' };
global.navigator = { onLine: true };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.today = () => '2026-10-28';
global.showToast = () => {};
global.scheduleSave = () => {};
global.persistNow = () => Promise.resolve();
global.renderAll = () => {};
global.__FORCE_DEMO_MODE__ = false;

const BID = 'bar_grande';
const pad = n => String(n).padStart(5, '0');
const nube = {
  negocios: [{ id: BID, nombre: 'Bar Grande', telefono: '', configuracion: {} }],
  productos: Array.from({ length: 1200 }, (_, i) => ({ id: `prod-${pad(i)}`, business_id: BID, nombre: `Producto ${i}`, categoria: 'Cervezas', precio: 5000, costo: 2000, stock: 10, min_stock: 2, activo: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })),
  ventas: Array.from({ length: 2500 }, (_, i) => ({ id: `pay-${pad(i)}`, business_id: BID, order_id: `ord-${i}`, total: 10000, method: 'Efectivo', payments: [{ method: 'Efectivo', amount: 10000 }], items: [{ name: 'Cerveza', qty: 2, price: 5000 }], customer: 'Mesa 1', cashier: 'Ana', shift_id: 's1', fecha: '2026-10-01T20:00:00Z', created_at: '2026-10-01T20:00:00Z', updated_at: '2026-10-01T20:00:00Z' })),
  gastos: Array.from({ length: 1500 }, (_, i) => ({ id: `gas-${pad(i)}`, business_id: BID, categoria: 'Gasto operativo', descripcion: 'Hielo', monto: 1000, comprobante: '', proveedor_id: null, fecha: '2026-10-01', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })),
  proveedores: [],
  mermas: Array.from({ length: 1100 }, (_, i) => ({ id: `mer-${pad(i)}`, business_id: BID, producto_id: 'prod-00001', producto_nombre: 'Producto 1', cantidad: 1, motivo: 'Rotura / Merma', observacion: '', fecha: '2026-10-01T00:00:00Z' })),
  pedidos_activos: [],
  turnos_caja: []
};

// Simulador de PostgREST: filtros encadenables y tope de 1000 filas por respuesta
let log = [], fallar = null, alPaginar = null;
const mockSupabase = {
  from(table) {
    return {
      select(columns = '*') {
        const filtros = []; let orden = null, max = Infinity, gtId = null;
        const ejecutar = () => {
          const consulta = { table, columns, gtId };
          if (fallar && fallar(consulta)) return { data: null, error: { message: 'Fallo de red simulado' } };
          if (alPaginar) alPaginar(consulta);
          let filas = (nube[table] || []).filter(r => filtros.every(f => f(r)));
          if (orden) filas = [...filas].sort((a, b) => String(a[orden]).localeCompare(String(b[orden])));
          filas = filas.slice(0, Math.min(max, 1000));
          const data = columns === '*' ? filas : filas.map(r => Object.fromEntries(columns.split(',').map(c => [c, r[c]])));
          log.push({ table, columns, filas: data.length, bytes: JSON.stringify(data).length });
          return { data, error: null };
        };
        const q = {
          eq(c, v) { filtros.push(r => r[c] === v); return q; },
          gt(c, v) { gtId = v; filtros.push(r => String(r[c]) > String(v)); return q; },
          gte(c, v) { filtros.push(r => String(r[c]) >= String(v)); return q; },
          in(c, vs) { const set = new Set(vs); filtros.push(r => set.has(r[c])); return q; },
          order(c) { orden = c; return q; },
          limit(n) { max = n; return q; },
          maybeSingle: () => Promise.resolve({ data: ejecutar().data?.[0] || null, error: null }),
          then: (ok, ko) => Promise.resolve(ejecutar()).then(ok, ko)
        };
        return q;
      },
      upsert: rows => Promise.resolve({ data: rows, error: null }),
      delete: () => ({ in: () => Promise.resolve({ error: null }) })
    };
  }
};
global.supabase = { createClient: () => mockSupabase };
const NexoSync = require('../sync.js');
let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };
const resumen = tabla => log.filter(l => l.table === tabla).reduce((s, l) => ({ consultas: s.consultas + 1, filas: s.filas + l.filas, bytes: s.bytes + l.bytes, completas: s.completas + (l.columns === '*' ? l.filas : 0) }), { consultas: 0, filas: 0, bytes: 0, completas: 0 });

(async () => {
  // 1. Equipo nuevo
  global.state = { profile: { name: 'Bar Grande', syncId: BID }, terminal: { businessId: BID }, products: [], inventory: [], categories: [], payments: [], expenses: [], purchases: [], suppliers: [], stockLog: [], orders: [] };
  log = [];
  let r = await NexoSync.pullAllFromSupabase(BID);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.payments.length, 2500, `ventas: ${state.payments.length}`);
  assert.strictEqual(state.products.length, 1200, `productos: ${state.products.length}`);
  assert.strictEqual(state.expenses.length, 1500, `gastos: ${state.expenses.length}`);
  assert.strictEqual(state.stockLog.length, 1100, `mermas: ${state.stockLog.length}`);
  assert.strictEqual(new Set(state.payments.map(p => p.id)).size, 2500, 'sin duplicados');
  const primera = resumen('ventas');
  ok(`equipo nuevo: 2500 ventas, 1200 productos, 1500 gastos y 1100 mermas (antes se cortaba en 1000) · ventas en ${primera.consultas} consultas`);

  // 2 y 3. Segunda descarga con el historial ya en el equipo
  log = [];
  r = await NexoSync.pullAllFromSupabase(BID);
  assert.strictEqual(state.payments.length, 2500, 'no se borra ninguna venta local');
  const segunda = resumen('ventas');
  assert.strictEqual(segunda.completas, 0, 'las ventas conocidas no se descargan completas');
  assert(segunda.bytes * 5 < primera.bytes, `la segunda descarga pesa mucho menos (${segunda.bytes} vs ${primera.bytes} bytes)`);
  ok(`segunda descarga: 0 ventas completas, solo ids (${(segunda.bytes / 1024).toFixed(0)} KB frente a ${(primera.bytes / 1024).toFixed(0)} KB), ninguna venta borrada`);

  // Una venta nueva en otra caja: solo esa viaja completa
  nube.ventas.push({ ...nube.ventas[0], id: 'pay-99999', order_id: 'ord-nueva' });
  log = [];
  await NexoSync.pullAllFromSupabase(BID);
  assert.strictEqual(state.payments.length, 2501);
  assert.strictEqual(resumen('ventas').completas, 1, 'solo la venta nueva viaja completa');
  ok('venta nueva en otra caja: se descarga solo esa fila completa');

  // 4. Borrado remoto y venta local pendiente
  nube.ventas = nube.ventas.filter(v => v.id !== 'pay-00007');
  state.payments.push({ id: 'pay-local-pendiente', amount: 5000, date: '2026-10-28', sync_status: 'pending', items: [], payments: [] });
  await NexoSync.pullAllFromSupabase(BID);
  assert(!state.payments.some(p => p.id === 'pay-00007'), 'la venta borrada en la nube se elimina');
  assert(state.payments.some(p => p.id === 'pay-local-pendiente'), 'la venta pendiente de subir se conserva');
  assert.strictEqual(state.payments.length, 2501);
  ok('borrado remoto se aplica; la venta pendiente de subir se conserva');

  // 5. Falla la segunda página de ids de ventas: no se borra nada
  const antes = state.payments.length;
  nube.ventas = nube.ventas.filter(v => v.id !== 'pay-00008'); // borrado remoto que no se podrá confirmar
  fallar = q => q.table === 'ventas' && q.columns === 'id' && q.gtId !== null; // falla cualquier página después de la primera
  r = await NexoSync.pullAllFromSupabase(BID);
  fallar = null;
  assert.strictEqual(r.ok, true, 'la descarga sigue con las demás tablas');
  assert.strictEqual(state.payments.length, antes, 'con la lista de ids incompleta no se borra ninguna venta');
  assert.strictEqual(state.products.length, 1200);
  ok('si falla una página de ids, no se borra ninguna venta y el resto de tablas sigue');

  // 6. Otra caja inserta ventas mientras se pagina (ids antes y después del cursor)
  let insertado = false;
  alPaginar = q => {
    if (!insertado && q.table === 'ventas' && q.columns === 'id' && q.gtId !== null) {
      insertado = true;
      nube.ventas.push({ ...nube.ventas[0], id: 'pay-00000a' }, { ...nube.ventas[0], id: 'pay-zz-final' });
    }
  };
  await NexoSync.pullAllFromSupabase(BID);
  alPaginar = null;
  const ids = new Set(state.payments.map(p => p.id));
  assert(nube.ventas.filter(v => v.id !== 'pay-00000a').every(v => ids.has(v.id)), 'ninguna venta existente se pierde');
  assert(!ids.has('pay-00008'), 'el borrado pendiente del paso 5 se aplica ahora');
  assert(ids.has('pay-zz-final'), 'la inserción posterior al cursor llega en esta misma descarga');
  await NexoSync.pullAllFromSupabase(BID);
  assert(state.payments.some(p => p.id === 'pay-00000a'), 'la inserción anterior al cursor llega en la siguiente descarga');
  ok('inserciones durante la paginación: no se pierde ni se borra nada; lo nuevo llega en esta o en la siguiente descarga');

  // 7. Equipo nuevo con historial grande
  nube.ventas = Array.from({ length: 40000 }, (_, i) => ({ ...nube.ventas[0], id: `big-${String(i).padStart(6, '0')}`, order_id: `ord-big-${i}` }));
  global.state = { profile: { name: 'Bar Grande', syncId: BID }, terminal: { businessId: BID }, products: [], inventory: [], categories: [], payments: [], expenses: [], purchases: [], suppliers: [], stockLog: [], orders: [] };
  const t0 = Date.now();
  r = await NexoSync.pullAllFromSupabase(BID);
  const ms = Date.now() - t0;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.payments.length, 40000, `ventas: ${state.payments.length}`);
  assert.strictEqual(new Set(state.payments.map(p => p.id)).size, 40000, 'sin duplicados');
  assert(ms < 3000, `la descarga de 40.000 ventas tardó ${ms} ms`);
  ok(`equipo nuevo con 40.000 ventas: descargadas y mezcladas sin duplicados en ${(ms / 1000).toFixed(1)} s`);

  // 8. Ventana de 90 días
  global.historialVentanaDesde = () => '2026-08-01';
  nube.ventas = [
    ...Array.from({ length: 30 }, (_, i) => ({ ...nube.ventas[0], id: `old-${pad(i)}`, fecha: '2026-03-15T20:00:00Z' })),
    ...Array.from({ length: 20 }, (_, i) => ({ ...nube.ventas[0], id: `new-${pad(i)}`, fecha: '2026-10-15T20:00:00Z' }))
  ];
  global.state = { profile: { name: 'Bar Grande', syncId: BID }, terminal: { businessId: BID }, products: [], inventory: [], categories: [], expenses: [], purchases: [], suppliers: [], stockLog: [], orders: [],
    payments: [{ id: 'archivada-local', amount: 1000, date: '2026-03-10', sync_status: 'synced', items: [], payments: [] }] };
  log = [];
  r = await NexoSync.pullAllFromSupabase(BID);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(state.payments.map(p => p.id).filter(id => !id.startsWith('new-')), ['archivada-local'], 'ni se baja lo viejo ni se borra la venta vieja local');
  assert.strictEqual(state.payments.filter(p => p.id.startsWith('new-')).length, 20);
  assert.strictEqual(resumen('ventas').filas, 40, 'solo viajan los 20 ids y las 20 filas de la ventana');
  delete global.historialVentanaDesde;
  ok('ventana de 90 días: solo se descargan las ventas recientes y las viejas del equipo no se borran');

  console.log(`\n${pasadas} PRUEBAS SUPERADAS`);
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
