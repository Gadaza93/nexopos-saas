// Test Suite: Verify No Double Stock Deduction on Sales and Cloud Sync
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- TEST SUITE: Verify Single Stock Deduction (No Duplication) ---');

// Mock DOM
global.window = global;
global.document = {
  querySelector: () => ({
    value: '',
    textContent: '',
    classList: { add() {}, remove() {} },
    close() {},
    showModal() {}
  }),
  addEventListener: () => {}
};
global.navigator = { onLine: true };
global.today = () => new Date().toISOString().slice(0, 10);
global.money = { format: (n) => `$${n}` };
global.showToast = () => {};
global.scheduleSave = () => {};
global.renderAll = () => {};

// Supabase mock recorder
const supabaseUpserts = {};
const mockSupabase = {
  from(table) {
    return {
      upsert(records, opts) {
        supabaseUpserts[table] = (supabaseUpserts[table] || []).concat(records);
        return Promise.resolve({ data: records, error: null });
      },
      delete() {
        return {
          in: () => Promise.resolve({ error: null })
        };
      },
      select() {
        return Promise.resolve({ data: [], count: 0, error: null });
      }
    };
  }
};
global.supabase = {
  createClient: () => mockSupabase
};

// Require sync.js
require('../sync.js');

// Verify sync.js has no '<' tokens
const syncCode = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
assert.strictEqual(syncCode.includes('<'), false, 'sync.js must not contain any < characters');
console.log('✓ sync.js verified: 0 "<" characters found');

// Load deductInventory from app.js
const appCode = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const deductMatch = appCode.match(/function deductInventory\(order\) \{[\s\S]*?\n\}/);
assert.ok(deductMatch, 'deductInventory function must exist in app.js');
eval(deductMatch[0]);

// Test 1: Selling 1 unit (Initial stock: 10 -> Expected: 9, NOT 8)
console.log('\n1. Testing sale of 1 unit...');
global.state = {
  profile: { syncId: 'nexopos_test' },
  products: [
    {
      id: 'prod-beer-1',
      name: 'Cerveza Águila',
      category: 'Cervezas',
      price: 6000,
      stock: 10,
      inventoryId: 'inv-beer-1',
      recipe: { 'inv-beer-1': 1 }, // Recipe pointing to its own inventory (standard in NexoPos)
      sync_status: 'synced'
    }
  ],
  inventory: [
    {
      id: 'inv-beer-1',
      name: 'Cerveza Águila',
      unit: 'und',
      qty: 10,
      min: 5
    }
  ],
  payments: [],
  expenses: [],
  purchases: [],
  suppliers: [],
  stockLog: []
};

deductInventory({
  items: [
    {
      productId: 'prod-beer-1',
      name: 'Cerveza Águila',
      price: 6000,
      qty: 1,
      inventoryId: 'inv-beer-1',
      recipe: { 'inv-beer-1': 1 }
    }
  ]
});

assert.strictEqual(state.products[0].stock, 9, 'Stock must decrease by EXACTLY 1 (from 10 to 9, not 8)');
assert.strictEqual(state.inventory[0].qty, 9, 'Inventory qty must decrease by EXACTLY 1 (from 10 to 9, not 8)');
assert.strictEqual(state.products[0].sync_status, 'pending');
console.log(`✓ 1 unit sold: Stock correctly decreased from 10 to ${state.products[0].stock} (decreased by exactly 1)`);

// Test 2: Selling 8 units (Initial stock: 20 -> Expected: 12, NOT 4)
console.log('\n2. Testing sale of 8 units...');
global.state = {
  profile: { syncId: 'nexopos_test' },
  products: [
    {
      id: 'prod-corona-1',
      name: 'Cerveza Corona',
      category: 'Cervezas',
      price: 12000,
      stock: 20,
      inventoryId: 'inv-corona-1',
      recipe: { 'inv-corona-1': 1 },
      sync_status: 'synced'
    }
  ],
  inventory: [
    {
      id: 'inv-corona-1',
      name: 'Cerveza Corona',
      unit: 'und',
      qty: 20,
      min: 5
    }
  ],
  payments: [],
  expenses: [],
  purchases: [],
  suppliers: [],
  stockLog: []
};

deductInventory({
  items: [
    {
      productId: 'prod-corona-1',
      name: 'Cerveza Corona',
      price: 12000,
      qty: 8,
      inventoryId: 'inv-corona-1',
      recipe: { 'inv-corona-1': 1 }
    }
  ]
});

assert.strictEqual(state.products[0].stock, 12, 'Stock must decrease by EXACTLY 8 (from 20 to 12, not 4)');
assert.strictEqual(state.inventory[0].qty, 12, 'Inventory qty must decrease by EXACTLY 8 (from 20 to 12, not 4)');
assert.strictEqual(state.products[0].sync_status, 'pending');
console.log(`✓ 8 units sold: Stock correctly decreased from 20 to ${state.products[0].stock} (decreased by exactly 8)`);

// Test 3: Verify Supabase receives the EXACT final stock without recalculation
console.log('\n3. Testing Supabase sync sends exact remaining stock...');
state.payments.push({
  id: 'pay-test-1',
  orderId: 'order-1',
  amount: 96000,
  method: 'Efectivo',
  items: [{ productId: 'prod-corona-1', name: 'Cerveza Corona', price: 12000, qty: 8 }],
  sync_status: 'pending'
});

global.NexoSync.syncAll().then(results => {
  const syncedProduct = supabaseUpserts.productos.find(p => p.id === 'prod-corona-1');
  assert.ok(syncedProduct, 'Product must be in Supabase upsert');
  assert.strictEqual(syncedProduct.stock, 12, 'Supabase product stock must be EXACTLY 12');
  console.log(`✓ Supabase received product '${syncedProduct.nombre}' with exact stock: ${syncedProduct.stock}`);

  console.log('\nALL DUPLICATION BUG TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
