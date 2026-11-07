// scratch/test-fecha-local.js
// Las ventas que se descargan de la nube toman su día LOCAL (Colombia), no el día UTC. Antes se cortaba el texto de la
// marca de tiempo (slice(0, 10)): desde las 7 p. m. eso ya es el día siguiente y un equipo que bajaba las ventas
// (07-11-2026, un celular) sumaba en «Ventas hoy» las de la noche anterior ($ 364.200 en vez de $ 13.000).
process.env.TZ = 'America/Bogota';
const assert = require('assert');
const { createMockSupabase } = require('./mock-supabase.js');

global.window = global;
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, readyState: 'complete' };
global.navigator = { onLine: true };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.today = () => '2026-11-07';
global.showToast = () => {}; global.scheduleSave = () => {}; global.renderAll = () => {};
global.__FORCE_DEMO_MODE__ = false;
const marcados = []; global.marcarHistorialModificado = (col, r) => marcados.push(`${col}:${r.date}`);

const BID = 'bar_fechas';
const venta = (id, fecha) => ({ id, business_id: BID, order_id: id, total: 1000, method: 'Efectivo', payments: [], items: [], fecha, created_at: fecha });

(async () => {
  const sb = createMockSupabase({ businessId: BID, seed: { ventas: [
    venta('noche', '2026-11-07T02:30:00.000Z'),   // 6 nov, 9:30 p. m. en Colombia
    venta('tarde', '2026-11-07T18:10:00.000Z'),   // 7 nov, 1:10 p. m.
    venta('vieja', '2026-11-05T00:00:00+00:00'),  // solo día (versiones sin hora): se respeta tal cual
  ] } });
  global.supabase = { createClient: () => sb };
  const sync = require('../sync.js');
  global.state = { profile: { syncId: BID }, terminal: { businessId: BID }, products: [], inventory: [], categories: [], payments: [], expenses: [], purchases: [], suppliers: [], stockLog: [], orders: [] };
  // Una venta bajada antes con el día UTC (versión anterior): la descarga la corrige
  state.payments.push({ id: 'noche', amount: 1000, date: '2026-11-07', paidAt: Date.parse('2026-11-07T02:30:00Z'), sync_status: 'synced' });

  assert.strictEqual(sync.fechaLocalDe('2026-11-07T02:30:00.000Z'), '2026-11-06', '9:30 p. m. del 6 es el 6');
  assert.strictEqual(sync.fechaLocalDe('2026-11-07T18:10:00+00:00'), '2026-11-07');
  assert.strictEqual(sync.fechaLocalDe('2026-11-05T00:00:00+00:00'), '2026-11-05', 'medianoche UTC exacta = solo día');
  console.log('   ✅ fechaLocalDe: día local, y medianoche UTC exacta como solo día');

  const r = await sync.pullAllFromSupabase(BID);
  assert.strictEqual(r.ok, true);
  const dia = id => state.payments.find(p => p.id === id).date;
  assert.strictEqual(dia('noche'), '2026-11-06', 'la venta de la noche ya bajada se corrige al 6');
  assert.strictEqual(dia('tarde'), '2026-11-07');
  assert.strictEqual(dia('vieja'), '2026-11-05');
  assert.ok(marcados.includes('payments:2026-11-07') && marcados.includes('payments:2026-11-06'), 'se reescriben el mes viejo y el nuevo');
  assert.strictEqual(state.payments.filter(p => p.date === '2026-11-07').length, 1, '«Ventas hoy» solo cuenta la de hoy');
  console.log('   ✅ descarga: ventas de la noche en su día y corrección de las ya bajadas');
  console.log('\n=== FECHAS LOCALES DE LAS VENTAS: OK ===');
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
