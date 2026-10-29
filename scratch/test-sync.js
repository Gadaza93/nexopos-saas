// Automated test suite for NexoPos Cloud Sync (Supabase Offline-First)
const assert = require('assert');
const fs = require('fs');

console.log('--- TEST SUITE: NexoPos Cloud Sync Architecture ---');

// 1. Verify index.html script tags and UI elements
const indexHtml = fs.readFileSync('index.html', 'utf8');
// supabase-js va empaquetado localmente (la CSP solo permite scripts propios): en <head>, antes de sync.js, sin CDN
assert(indexHtml.includes('<script src="./supabase.min.js" defer></script>'), 'index.html must load the vendored supabase.min.js (defer)');
assert(indexHtml.indexOf('supabase.min.js') < indexHtml.indexOf('</head>'), 'supabase.min.js must load in <head>');
assert(!/cdn\.jsdelivr|unpkg\.com/.test(indexHtml), 'index.html must not load scripts from a CDN');
assert(indexHtml.includes('<script src="sync.js" defer></script>') || indexHtml.includes('<script src="./sync.js" defer></script>'), 'index.html must load sync.js (defer)');
assert(indexHtml.indexOf('sync.js') < indexHtml.indexOf('app.js'), 'sync.js must load before app.js');
assert(indexHtml.includes('id="syncStatusIndicator"'), 'index.html must include #syncStatusIndicator');
assert(indexHtml.includes('id="syncBadgeTopbar"'), 'index.html must include #syncBadgeTopbar in header');
assert(indexHtml.includes('id="businessSyncId"'), 'index.html must include #businessSyncId in profile');
console.log('✓ index.html structure and scripts verified');

// 2. Load sync.js in a mocked browser environment
const mockWindow = {
  addEventListener: () => {},
  document: {
    querySelector: (sel) => ({
      className: '',
      title: '',
      textContent: ''
    }),
    addEventListener: () => {},
    visibilityState: 'visible'
  },
  navigator: { onLine: true },
  supabase: {
    createClient: (url, key) => {
      return {
        url,
        key,
        from: (table) => ({
          upsert: async (rows) => ({ data: rows, error: null }),
          // negocios se actualiza (no upsert): devuelve la fila existente, como Supabase
          update: (fields) => ({ eq: (col, val) => ({ select: async () => ({ data: [{ [col]: val, ...fields }], error: null }) }) }),
          select: () => ({
            eq: () => ({
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
              then: (cb) => cb({ data: [], error: null })
            })
          }),
          delete: () => ({
            in: async (col, vals) => ({ data: null, error: null })
          })
        }),
        channel: (chName) => ({
          on: function() { return this; },
          subscribe: () => ({})
        })
      };
    }
  }
};

global.window = mockWindow;
global.document = mockWindow.document;
global.navigator = mockWindow.navigator;
global.supabase = mockWindow.supabase;
global.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({}) });

// Mock global state
global.state = {
  profile: {
    name: 'Mi Bar',
    nit: '901.123.456-7',
    syncId: 'nexopos_sede1',
    sync_status: 'pending'
  },
  products: [
    { id: 'p1', name: 'Cerveza Club', price: 9000, cost: 4500, inventoryId: 'inv-1', sync_status: 'pending' },
    { id: 'p2', name: 'Ron Medellín', price: 95000, cost: 50000, inventoryId: 'inv-2', sync_status: 'synced' }
  ],
  inventory: [
    { id: 'inv-1', name: 'Cerveza Club', qty: 24, min: 6, unit: 'und' },
    { id: 'inv-2', name: 'Ron Medellín', qty: 3, min: 2, unit: 'botellas' }
  ],
  payments: [
    { id: 'pay-1', amount: 45000, method: 'Efectivo', sync_status: 'pending' },
    { id: 'pay-2', amount: 95000, method: 'Nequi', sync_status: 'synced' }
  ],
  expenses: [
    { id: 'exp-1', category: 'Servicios', amount: 150000, sync_status: 'pending' }
  ],
  purchases: [],
  suppliers: [
    { id: 'sup-1', name: 'Distribuidora Licores', phone: '3001234567', sync_status: 'pending' }
  ],
  stockLog: [
    { id: 'stk-1', delta: -2, reason: 'Rotura / Merma', itemId: 'inv-1', sync_status: 'pending' }
  ],
  categories: ['Cervezas', 'Licores']
};

global.scheduleSave = () => {};
global.renderAll = () => {};

// Evaluate sync.js
require('../sync.js');
const NexoSync = globalThis.NexoSync || global.NexoSync || mockWindow.NexoSync;

assert(NexoSync, 'NexoSync must be globally exported');
assert.strictEqual(NexoSync.SUPABASE_URL, globalThis.NEXO_SUPABASE_URL);
assert.strictEqual(NexoSync.SUPABASE_KEY, globalThis.NEXO_SUPABASE_ANON_KEY);
console.log('✓ NexoSync initialization and credentials verified');

// 3. Test Business ID resolution
assert.strictEqual(NexoSync.getBusinessId(), 'nexopos_sede1');
global.state.profile.syncId = '';
assert.strictEqual(NexoSync.getBusinessId(), 'bar_9011234567');
global.state.profile.nit = '';
assert.strictEqual(NexoSync.getBusinessId(), 'nexopos_default');
console.log('✓ Business ID resolution logic verified');

// Reset syncId
global.state.profile.syncId = 'nexopos_test';

// 4. Test Pending Records Counter
// 1 pending product (p1) + 1 pending payment (pay-1) + 1 pending expense (exp-1) + 1 pending supplier (sup-1) + 1 pending stockLog (stk-1) + 1 pending profile = 6
assert.strictEqual(NexoSync.getPendingCount(), 6, 'Should count 6 pending records');
console.log('✓ Pending records counter verified (6 pending records)');

// 5. Test Track Product Deletion
NexoSync.trackProductDeletion('p-deleted-99');
assert.strictEqual(NexoSync.getPendingCount(), 7, 'Should include deleted product in pending count');
console.log('✓ Product deletion queueing verified');

// 6. Test toIsoDate Helper
assert(typeof NexoSync.toIsoDate === 'function', 'toIsoDate must be a function');
assert.strictEqual(NexoSync.toIsoDate(1792783583257), new Date(1792783583257).toISOString());
assert.strictEqual(NexoSync.toIsoDate('1792783583257'), new Date(1792783583257).toISOString());
assert.strictEqual(NexoSync.toIsoDate('2026-10-23'), '2026-10-23T12:00:00.000Z');
console.log('✓ toIsoDate helper verified with numbers and strings');

// 7. Test syncAll() complete module synchronization
(async () => {
  global.state.payments[0].paidAt = 1792783583257; // Numeric millisecond timestamp
  assert(typeof NexoSync.syncAll === 'function', 'NexoSync.syncAll must be exported');
  const results = await NexoSync.syncAll({ force: true });

  assert.strictEqual(global.state.profile.sync_status, 'synced');
  assert.strictEqual(global.state.products[0].sync_status, 'synced');
  assert.strictEqual(global.state.payments[0].sync_status, 'synced');
  assert.strictEqual(global.state.expenses[0].sync_status, 'synced');
  assert.strictEqual(global.state.suppliers[0].sync_status, 'synced');
  assert.strictEqual(global.state.stockLog[0].sync_status, 'synced');
  console.log('✓ syncAll() successfully synchronized all 5 modules (Productos, Ventas, Gastos, Proveedores, Mermas)');

  // Verify status
  const status = NexoSync.getStatus();
  assert(status.lastSyncAt != null, 'lastSyncAt should be updated');
  console.log('✓ NexoSync status reporting verified');

  console.log('\nALL 7 SYNC TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
})();
