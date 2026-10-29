// scratch/test-pedidos-tabla.js
// Pedidos en su propia tabla (pedidos_activos con columna meta) en vez de dentro de negocios.configuracion:
// 1. Detección: con la columna meta se usa la tabla; sin ella, todo sigue como antes (negocios.configuracion.orders).
// 2. syncOrders sube solo los pedidos con cambios, con nota, abonos y cobro en partes en meta, y no toca negocios.
// 3. Cobrados, vaciados y retirados (tumbas) se borran de la tabla.
// 4. La configuración del negocio ya no lleva pedidos (ni los viejos del perfil) y conserva el PIN de administrador.
// 5. La descarga ignora configuracion.orders viejos y recupera meta de cada fila.
// 6. Tiempo real: alta, cambio y borrado de un pedido suelto, sin dar por cobradas las demás mesas.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMockSupabase } = require('./mock-supabase.js');

console.log('=== PRUEBAS: PEDIDOS EN TABLA PROPIA (pedidos_activos) ===\n');

const BID = 'bar_tabla';
let sb = createMockSupabase({ businessId: BID, pedidosConMeta: true });
global.__IS_NODE_TEST__ = true;
global.window = global;
global.supabase = { createClient: () => sb };
global.navigator = { onLine: true };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, readyState: 'loading' };
global.showToast = () => {};
global.scheduleSave = () => {};
global.persistNow = () => Promise.resolve();
global.renderAll = () => {};
global.__FORCE_DEMO_MODE__ = false;
require('../demo-mode.js');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8'), { filename: 'sync.js' });
const interno = expr => vm.runInThisContext(expr);

// Espía de escrituras por tabla
const escrituras = [];
const envolver = cliente => { const original = cliente.from; cliente.from = table => { const b = original(table); for (const m of ['upsert', 'delete']) { const f = b[m]; b[m] = (...a) => { escrituras.push(`${table}.${m}`); return f(...a); }; } return b; }; return cliente; };
envolver(sb);
const uuid = id => interno('toValidUuid')(id);
const filas = () => sb.__tables.pedidos_activos || [];
let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };

const admin = { id: 'u1', role: 'admin', salt: 'sal', pinHash: 'hash-admin', mustChangePin: false };
const pedido = (id, extra = {}) => ({ id, tableId: `t-${id}`, tableName: `Mesa ${id}`, isCustom: false, items: [{ productId: 'p1', name: 'Cerveza', qty: 2, price: 5000 }], status: 'open', createdAt: 1000, updatedAt: 2000, sync_status: 'pending', ...extra });

(async () => {
  global.state = {
    profile: { name: 'Bar Tabla', syncId: BID, image: 'data:image/webp;base64,AAAA', orders: [pedido('viejo-en-perfil')] },
    terminal: { businessId: BID }, users: [admin], cashShift: { status: 'open', id: 's1' }, deleted_order_ids: {},
    orders: [pedido('A', { note: 'sin hielo', paidAmount: 4000, equalSplit: { parts: 2, paid: [1] } }), pedido('B', { sync_status: 'synced' })]
  };

  // 1. Detección
  assert.strictEqual(await interno('usaTablaPedidos')(sb), true);
  ok('con la columna meta se activa el modo tabla');

  // 2. Solo sube los pedidos con cambios, con meta, sin tocar negocios
  escrituras.length = 0;
  let r = await NexoSync.syncOrders();
  assert.strictEqual(r.modo, 'tabla');
  assert(!escrituras.includes('negocios.upsert'), 'no reescribe la fila de negocios');
  assert.strictEqual(filas().length, 1, 'solo sube el pedido con cambios (A)');
  const filaA = filas()[0];
  assert.strictEqual(filaA.id, uuid('A'));
  assert.deepStrictEqual([filaA.meta.note, filaA.meta.paidAmount, filaA.meta.equalSplit.parts, filaA.meta.id], ['sin hielo', 4000, 2, 'A']);
  assert(!('items' in filaA.meta) && !('sync_status' in filaA.meta), 'meta no duplica items ni el estado local');
  assert.strictEqual(state.orders[0].sync_status, 'synced');
  escrituras.length = 0;
  await NexoSync.syncOrders();
  assert(!escrituras.includes('pedidos_activos.upsert'), 'sin cambios no vuelve a subir nada');
  ok('syncOrders sube solo los pedidos con cambios (nota, abono y cobro en partes en meta) y no toca negocios');

  // 3. Cobrado, vaciado y retirado
  state.orders.push(pedido('C')); state.orders.push(pedido('D'));
  await NexoSync.syncOrders();
  assert.strictEqual(filas().length, 3);
  const A = state.orders.find(o => o.id === 'A'); A.status = 'paid'; A.sync_status = 'pending';
  const C = state.orders.find(o => o.id === 'C'); C.items = []; C.sync_status = 'pending';
  state.orders = state.orders.filter(o => o.id !== 'D'); state.deleted_order_ids = { D: Date.now() };
  await NexoSync.syncOrders();
  assert.deepStrictEqual(filas().map(f => f.id), [], 'A (cobrado), C (vaciado) y D (unido/retirado) salen de la tabla');
  ok('cobrados, vaciados y retirados se borran de pedidos_activos');

  // 4. Configuración del negocio
  const conf = interno('sanitizeNegocio')(state.profile, BID).configuracion;
  assert(!('orders' in conf), 'ni los pedidos actuales ni los viejos del perfil');
  assert.strictEqual(conf.admin_hash, 'hash-admin'); assert.strictEqual(conf.cashShift.status, 'open');
  escrituras.length = 0;
  await NexoSync.syncCashShift({ status: 'closed', lastClosedAt: Date.now() });
  const negocio = sb.__tables.negocios.find(n => n.id === BID);
  assert(!('orders' in negocio.configuracion) && negocio.configuracion.admin_hash === 'hash-admin', 'abrir o cerrar caja ya no borra el PIN de la nube');
  ok('negocios.configuracion sin pedidos; el turno de caja conserva los datos del PIN de administrador');

  // 5. Descarga: ignora configuracion.orders viejos y recupera meta
  negocio.configuracion.orders = [pedido('X', { sync_status: 'synced' })]; // copia vieja de una versión anterior
  sb.__tables.pedidos_activos.push(interno('pedidoAFila')(pedido('Y', { note: 'cuenta aparte', paidAmount: 10000 }), BID));
  state.orders = [];
  await NexoSync.pullAllFromSupabase(BID);
  assert(!state.orders.some(o => o.id === 'X'), 'la copia vieja de configuracion.orders no resucita la mesa X');
  const Y = state.orders.find(o => o.id === 'Y');
  assert(Y && Y.note === 'cuenta aparte' && Y.paidAmount === 10000 && Y.status === 'open', JSON.stringify(Y));
  assert(!('orders' in state.profile), 'los pedidos no se copian al perfil');
  ok('la descarga ignora configuracion.orders viejos y recupera nota y abonos desde meta');

  // 6. Tiempo real de un pedido suelto
  interno('setupRealtime')();
  state.orders.push({ ...pedido('Z0'), sync_status: 'synced' }); // otra mesa abierta y sincronizada en esta caja
  sb.__emitir('pedidos_activos', 'INSERT', { new: interno('pedidoAFila')(pedido('W'), BID) });
  assert(state.orders.some(o => o.id === 'W' && o.status === 'open'), 'alta en vivo');
  assert.strictEqual(state.orders.find(o => o.id === 'Z0').status, 'open', 'un pedido suelto no da por cobradas las demás mesas');
  sb.__emitir('pedidos_activos', 'UPDATE', { new: interno('pedidoAFila')(pedido('Y', { items: [{ productId: 'p2', name: 'Picada', qty: 1, price: 42000 }], note: 'cuenta aparte', updatedAt: 9e12 }), BID) });
  assert.strictEqual(state.orders.find(o => o.id === 'Y').items[0].name, 'Picada', 'cambio en vivo');
  sb.__emitir('pedidos_activos', 'DELETE', { old: { id: uuid('Y') } });
  assert.strictEqual(state.orders.find(o => o.id === 'Y').status, 'paid', 'borrado en vivo: cobrado en otra caja');
  state.orders.push(pedido('P', { sync_status: 'pending' }));
  sb.__emitir('pedidos_activos', 'DELETE', { old: { id: uuid('P') } });
  assert.strictEqual(state.orders.find(o => o.id === 'P').status, 'open', 'un pedido con cambios sin subir se conserva');
  sb.__emitir('pedidos_activos', 'DELETE', { old: { id: '00000000-0000-4000-8000-000000000000' } }); // de otro negocio: se ignora
  sb.__emitir('negocios', 'UPDATE', { new: { id: BID, configuracion: { orders: [] } } });
  assert.strictEqual(state.orders.find(o => o.id === 'Z0').status, 'open', 'en modo tabla el evento de negocios no toca los pedidos');
  ok('tiempo real: alta, cambio y borrado de un pedido suelto; las demás mesas no se tocan; negocios ya no manda en los pedidos');

  // 7. Sin la migración: modo anterior intacto
  sb = envolver(createMockSupabase({ businessId: BID }));
  interno('syncClient = null; ordersTableMode = null');
  state.orders = [pedido('L')];
  escrituras.length = 0;
  r = await NexoSync.syncOrders();
  assert.notStrictEqual(r.modo, 'tabla');
  assert.strictEqual(await interno('usaTablaPedidos')(sb), false);
  const negocioL = sb.__tables.negocios.find(n => n.id === BID);
  assert(negocioL && negocioL.configuracion.orders.some(o => o.id === 'L'), 'los pedidos siguen viajando en negocios.configuracion.orders');
  ok('sin la columna meta todo sigue como antes (negocios.configuracion.orders)');

  console.log(`\n${pasadas} PRUEBAS SUPERADAS`);
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
