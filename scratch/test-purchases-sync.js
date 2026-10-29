// Automated test suite for Expense & Purchase Flow and Supabase Sync
const assert = require('assert');

console.log('--- TEST SUITE: Expense & Purchase Flow + Supabase Sync ---');

// Mock browser environment
const mockWindow = {
  addEventListener: () => {},
  document: {
    querySelector: (sel) => ({
      className: '',
      title: '',
      textContent: '',
      value: ''
    }),
    addEventListener: () => {},
    visibilityState: 'visible'
  },
  navigator: { onLine: true },
  supabase: {
    createClient: (url, key) => {
      const recordsByTable = {};
      return {
        url,
        key,
        from: (table) => ({
          upsert: async (rows) => {
            recordsByTable[table] = (recordsByTable[table] || []).concat(rows);
            return { data: rows, error: null };
          },
          select: () => ({
            eq: () => ({
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
              then: (cb) => cb({ data: [], error: null })
            }),
            then: (cb) => cb({ data: [], error: null })
          }),
          delete: () => ({
            in: async (col, vals) => ({ data: null, error: null })
          })
        }),
        channel: (chName) => ({
          on: function() { return this; },
          subscribe: () => ({})
        }),
        _getRecords: () => recordsByTable
      };
    }
  }
};

global.window = mockWindow;
global.document = mockWindow.document;
global.navigator = mockWindow.navigator;
global.supabase = mockWindow.supabase;

global.state = {
  profile: { name: 'NexoPos', syncId: 'nexopos_default', sync_status: 'synced' },
  products: [
    { id: 'p1', name: 'Cerveza Club', price: 9000, cost: 4500, stock: 10, inventoryId: 'inv-1', sync_status: 'synced' },
    { id: 'p2', name: 'Ron Medellín', price: 95000, cost: 50000, stock: 2, inventoryId: 'inv-2', sync_status: 'synced' }
  ],
  inventory: [
    { id: 'inv-1', name: 'Cerveza Club', qty: 10, min: 6, unit: 'und' },
    { id: 'inv-2', name: 'Ron Medellín', qty: 2, min: 2, unit: 'botellas' }
  ],
  payments: [],
  expenses: [],
  purchases: [],
  suppliers: [],
  stockLog: [],
  cashShift: { id: 'shift-1', status: 'open' }
};

global.scheduleSave = () => {};
global.renderAll = () => {};
global.showToast = () => {};

// Load sync.js
require('../sync.js');
const NexoSync = globalThis.NexoSync || global.NexoSync || mockWindow.NexoSync;

assert(NexoSync, 'NexoSync must be loaded');

// 1. Test purchase stock increase simulation
console.log('1. Testing Purchase Stock Increase...');
const productToBuy = global.state.products[0];
const initialStock = productToBuy.stock;
const purchaseQty = 24;

// Simulate purchase line processing (as in modules.js savePurchase)
const supply = global.state.inventory.find(i => i.id === productToBuy.inventoryId);
const newStock = Number((initialStock + purchaseQty).toFixed(2));
supply.qty = newStock;
productToBuy.stock = newStock;
productToBuy.updated_at = new Date().toISOString();
productToBuy.sync_status = 'pending';

assert.strictEqual(productToBuy.stock, 34, 'Product stock should be incremented by 24');
assert.strictEqual(supply.qty, 34, 'Inventory qty should match new stock');
assert.strictEqual(productToBuy.sync_status, 'pending');
assert(productToBuy.updated_at != null, 'updated_at must be populated');
console.log('✓ Product stock successfully incremented: 10 + 24 = 34 units');

// 2. Test recording purchase in state.purchases
global.state.purchases.push({
  id: 'buy-1',
  supplier: 'Cervecería Nacional',
  supplierId: 'sup-1',
  invoice: 'FAC-9988',
  date: '2026-10-23',
  method: 'Transferencia',
  lines: [{ productId: 'p1', qty: 24, unitCost: 4500, total: 108000 }],
  total: 108000,
  createdAt: Date.now(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  sync_status: 'pending'
});

// Also test recording expense in state.expenses
global.state.expenses.push({
  id: 'exp-1',
  category: 'Servicios públicos',
  description: 'Factura de energía',
  amount: 250000,
  method: 'Efectivo',
  date: '2026-10-23',
  createdAt: Date.now(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  sync_status: 'pending'
});

// 3. Test syncAll() execution
(async () => {
  console.log('2. Running NexoSync.syncAll()...');
  const results = await NexoSync.syncAll({ force: false });

  assert(results.productos.ok, 'Productos sync should succeed');
  assert.strictEqual(results.productos.count, 1, 'Should sync 1 modified product with updated stock');

  assert(results.gastos.ok, 'Gastos / Compras sync should succeed');
  assert.strictEqual(results.gastos.count, 2, 'Should sync 2 items (1 purchase + 1 expense) into gastos table');

  assert.strictEqual(productToBuy.sync_status, 'synced', 'Product should be marked synced');
  assert.strictEqual(global.state.purchases[0].sync_status, 'synced', 'Purchase should be marked synced');
  assert.strictEqual(global.state.expenses[0].sync_status, 'synced', 'Expense should be marked synced');

  console.log('✓ Both purchase and expense successfully synchronized to Supabase gastos table');
  console.log('✓ Product stock update synchronized to Supabase productos table');

  console.log('\nALL PURCHASE & EXPENSE SYNC TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
})();
