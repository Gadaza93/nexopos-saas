// Test Suite: Sales Stock Deduction and Cloud Synchronization
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- TEST SUITE: Sales Checkout Inventory Deduction & Supabase Sync ---');

// Mock browser/DOM environment
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

// Mock Supabase client to record payloads sent
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

// Load sync.js
require('../sync.js');

// 1. Initial State definition
const testProductId = 'prod-test-beer-1';
const testInventoryId = 'stock-prod-test-beer-1';

global.state = {
  profile: { name: 'Bar El Portal', syncId: 'nexopos_test_sale' },
  products: [
    {
      id: testProductId,
      name: 'Cerveza Club Colombia',
      category: 'Cervezas',
      price: 8000,
      cost: 4500,
      stock: 25,
      inventoryId: testInventoryId,
      sync_status: 'synced',
      updated_at: '2026-10-01T12:00:00.000Z'
    }
  ],
  inventory: [
    {
      id: testInventoryId,
      name: 'Cerveza Club Colombia',
      unit: 'und',
      qty: 25,
      min: 5
    }
  ],
  orders: [],
  payments: [],
  expenses: [],
  purchases: [],
  suppliers: [],
  stockLog: [],
  cashShift: { id: 'shift-test-1', status: 'open' }
};

// 2. Simulate deductInventory logic from app.js
function testDeductInventory(order) {
  const nowIso = new Date().toISOString();
  order.items.forEach(item => {
    const qtySold = Number(item.qty || 0);
    const prodId = item.productId || item.id;
    const product = state.products.find(p => p.id === prodId || (item.inventoryId && p.inventoryId === item.inventoryId));
    const supply = state.inventory.find(i => i.id === (item.inventoryId || product?.inventoryId || `stock-${prodId}`));

    if (supply) {
      supply.qty = Math.max(0, Number((supply.qty - qtySold).toFixed(2)));
    }

    if (product) {
      const currentStock = supply ? supply.qty : Math.max(0, Number(((product.stock != null ? product.stock : 0) - qtySold).toFixed(2)));
      product.stock = currentStock;
      product.updated_at = nowIso;
      product.sync_status = 'pending';
    }

    if (item.recipe && Object.keys(item.recipe).length > 0) {
      Object.entries(item.recipe).forEach(([id, amount]) => {
        const sup = state.inventory.find(i => i.id === id);
        if (sup) {
          sup.qty = Math.max(0, Number((sup.qty - amount * qtySold).toFixed(2)));
          const relatedProd = state.products.find(p => p.inventoryId === id || p.id === id);
          if (relatedProd) {
            relatedProd.stock = sup.qty;
            relatedProd.updated_at = nowIso;
            relatedProd.sync_status = 'pending';
          }
        }
      });
    }
  });
}

// Execute sale checkout
console.log('1. Simulating sale checkout of 4 beers...');
const initialStock = state.products[0].stock;
const soldQty = 4;

testDeductInventory({
  items: [
    {
      productId: testProductId,
      name: 'Cerveza Club Colombia',
      price: 8000,
      qty: soldQty
    }
  ]
});

const updatedProduct = state.products[0];
const updatedSupply = state.inventory[0];

// Assertions on local state
assert.strictEqual(updatedProduct.stock, initialStock - soldQty, 'Product stock should be deducted');
assert.strictEqual(updatedSupply.qty, initialStock - soldQty, 'Inventory supply qty should be deducted');
assert.strictEqual(updatedProduct.sync_status, 'pending', 'Product should be marked pending sync');
assert.ok(Date.now() - new Date(updatedProduct.updated_at).getTime() < 5000, 'updated_at should be recent ISO string');
console.log(`✓ Local product stock correctly deducted: ${initialStock} -> ${updatedProduct.stock}`);
console.log(`✓ Product updated_at set to ISO: ${updatedProduct.updated_at}`);
console.log(`✓ Product marked sync_status: ${updatedProduct.sync_status}`);

// Simulate payment registration
const paymentRecord = {
  id: 'pay-test-sale-1',
  orderId: 'order-test-1',
  amount: 32000,
  method: 'Efectivo',
  items: [{ productId: testProductId, name: 'Cerveza Club Colombia', price: 8000, qty: soldQty }],
  shiftId: 'shift-test-1',
  sync_status: 'pending'
};
state.payments.push(paymentRecord);

// 3. Test NexoSync.syncAll() execution
console.log('2. Running NexoSync.syncAll()...');
global.NexoSync.syncAll().then(results => {
  // Check that both ventas and productos were upserted
  assert.ok(supabaseUpserts.ventas && supabaseUpserts.ventas.length > 0, 'Ventas should be upserted to Supabase');
  assert.ok(supabaseUpserts.productos && supabaseUpserts.productos.length > 0, 'Productos should be upserted to Supabase');

  const syncedProduct = supabaseUpserts.productos.find(p => p.id === testProductId);
  assert.ok(syncedProduct, 'Synced product should be present in Supabase upsert payload');
  assert.strictEqual(syncedProduct.stock, 21, 'Supabase product stock should equal 21');
  assert.strictEqual(syncedProduct.updated_at, updatedProduct.updated_at, 'Supabase updated_at should match product');

  console.log(`✓ Supabase received sale: total $${supabaseUpserts.ventas[0].total}`);
  console.log(`✓ Supabase received updated product: '${syncedProduct.nombre}' stock = ${syncedProduct.stock}`);
  assert.strictEqual(updatedProduct.sync_status, 'synced', 'Product status should be transitioned to synced');
  assert.strictEqual(paymentRecord.sync_status, 'synced', 'Payment status should be transitioned to synced');

  // 4. Test NexoSync.syncProductos() standalone
  console.log('3. Testing standalone NexoSync.syncProductos()...');
  assert.strictEqual(typeof global.NexoSync.syncProductos, 'function', 'NexoSync.syncProductos must be a function');
  
  // Alter product stock again
  updatedProduct.stock = 15;
  updatedProduct.sync_status = 'pending';
  updatedProduct.updated_at = new Date().toISOString();

  return global.NexoSync.syncProductos().then(prodRes => {
    assert.strictEqual(prodRes.ok, true, 'syncProductos should return ok: true');
    const lastProductUpsert = supabaseUpserts.productos[supabaseUpserts.productos.length - 1];
    assert.strictEqual(lastProductUpsert.stock, 15, 'Standalone syncProductos should update stock to 15 in Supabase');
    assert.strictEqual(updatedProduct.sync_status, 'synced', 'Product should be marked synced');
    console.log(`✓ Standalone syncProductos() confirmed: updated stock = ${lastProductUpsert.stock}`);

    console.log('\nALL SALES INVENTORY DEDUCTION & SYNC TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  });
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
