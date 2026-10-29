// scratch/test-negocios-permisos.js
// Escritura de negocios con los permisos reales de Supabase (las cajas solo actualizan nombre y configuracion; no crean filas):
// 1. Perfil, turno de caja y PIN se guardan con update de nombre + configuracion (antes: upsert rechazado con 403).
// 2. El PIN de administrador viaja solo como sal + hash + fecha; el texto plano de perfiles viejos se borra y no se sube.
// 3. Un PIN cambiado en esta caja después del de la nube no se pisa al descargar; uno más nuevo de la nube sí se aplica.
// 4. Tiempo real: una venta de otra caja no descuenta stock; el stock lo fija el evento de productos.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMockSupabase } = require('./mock-supabase.js');

console.log('=== PRUEBAS: NEGOCIOS CON PERMISOS POR COLUMNA Y PIN SIN TEXTO PLANO ===\n');

const BID = 'bar_permisos';
const sb = createMockSupabase({ businessId: BID });
global.__IS_NODE_TEST__ = true;
global.window = global;
global.supabase = { createClient: () => sb };
global.navigator = { onLine: true };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, readyState: 'loading' };
global.showToast = () => {};
global.scheduleSave = () => {};
global.saveState = () => {};
global.persistNow = () => Promise.resolve();
global.renderAll = () => {};
global.__FORCE_DEMO_MODE__ = false;
require('../demo-mode.js');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8'), { filename: 'sync.js' });
const interno = expr => vm.runInThisContext(expr);
const hash = (pin, salt) => interno('toCyrb53Hash')(`${salt}:${pin}`);
const fila = () => sb.__tables.negocios.find(n => n.id === BID);
let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };

(async () => {
  global.state = {
    profile: { name: 'Bar Permisos', phone: '3001112233', syncId: BID, sync_status: 'pending', admin_pin: '2013', adminPin: '2013' },
    terminal: { businessId: BID }, cashShift: { status: 'closed' }, orders: [], payments: [], products: [], expenses: [], purchases: [], suppliers: [], stockLog: [],
    users: [{ id: 'u1', role: 'admin', salt: 'salA', pinHash: hash('5555', 'salA'), pinAt: 1000, mustChangePin: false }]
  };

  // 1. Perfil y turno de caja
  let r = await NexoSync.syncAll({ force: true });
  assert.deepStrictEqual(r.negocios, { ok: true }, JSON.stringify(r.negocios));
  assert.strictEqual(state.profile.sync_status, 'synced');
  assert.strictEqual(fila().nombre, 'Bar Permisos');
  assert.strictEqual(fila().configuracion.phone, '3001112233', 'el teléfono viaja dentro de configuracion');
  assert.strictEqual(fila().activo, true, 'activo no se toca');
  await NexoSync.syncCashShift({ status: 'open', id: 's1', openedAt: Date.now(), openingCash: 50000 });
  assert.strictEqual(fila().configuracion.cashShift.status, 'open');
  ok('perfil y turno de caja se guardan con update de nombre + configuracion (el upsert anterior daba 403)');

  // 2. PIN sin texto plano
  const cfg = fila().configuracion;
  assert(!('admin_pin' in cfg) && !('adminPin' in cfg), 'sin PIN en texto plano');
  assert.deepStrictEqual([cfg.admin_salt, cfg.admin_hash, cfg.admin_pin_at], ['salA', hash('5555', 'salA'), 1000]);
  ok('el PIN viaja solo como sal + hash + fecha; el texto plano del perfil viejo no se sube');

  // 3. PIN más reciente gana
  fila().configuracion = { ...fila().configuracion, admin_pin: '2013', admin_salt: 'salVieja', admin_hash: hash('2013', 'salVieja'), admin_pin_at: 500 }; // fila antigua
  await NexoSync.pullAllFromSupabase(BID);
  const admin = state.users.find(u => u.role === 'admin');
  assert.strictEqual(admin.pinHash, hash('5555', 'salA'), 'el PIN local (más reciente) no se reemplaza por el de la nube');
  assert(!('admin_pin' in state.profile) && !('adminPin' in state.profile), 'el texto plano no queda en el perfil local');
  fila().configuracion = { ...fila().configuracion, admin_salt: 'salNueva', admin_hash: hash('7777', 'salNueva'), admin_pin_at: 99999 };
  delete fila().configuracion.admin_pin;
  await NexoSync.pullAllFromSupabase(BID);
  assert.strictEqual(admin.pinHash, hash('7777', 'salNueva'), 'un PIN más nuevo en la nube sí se aplica, sin texto plano');
  assert.strictEqual(admin.pinAt, 99999);
  ok('al descargar gana el PIN más reciente: el local no se pisa con uno viejo y el nuevo de otra caja se aplica');

  // 4. Venta en vivo de otra caja: sin descuento doble de stock
  state.products = [{ id: 'p1', name: 'Cerveza', price: 5000, stock: 20, inventoryId: 'stock-p1', sync_status: 'synced' }];
  state.inventory = [{ id: 'stock-p1', name: 'Cerveza', qty: 20, min: 5 }];
  interno('setupRealtime')();
  sb.__emitir('productos', 'UPDATE', { new: { id: 'p1', business_id: BID, nombre: 'Cerveza', precio: 5000, stock: 18, activo: true } }); // llega primero
  sb.__emitir('ventas', 'INSERT', { new: { id: 'v-otra', business_id: BID, total: 10000, items: [{ productId: 'p1', qty: 2, price: 5000 }], created_at: new Date().toISOString() } });
  assert.strictEqual(state.products[0].stock, 18, 'el stock queda en el valor que subió la otra caja (antes: 16)');
  assert(state.payments.some(p => p.id === 'v-otra'), 'la venta sí aparece');
  ok('venta en vivo de otra caja: aparece la venta y el stock no se descuenta dos veces');

  console.log(`\n${pasadas} PRUEBAS SUPERADAS`);
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
