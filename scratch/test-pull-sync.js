// Test Suite: Supabase Initial Pull / Hydration and Manual Restore
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- TEST SUITE: Supabase Pull / Hydration & Cloud Restore ---');

// 1. Verify zero '<' tokens in sync.js
const syncCode = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
assert.strictEqual(syncCode.includes('<'), false, 'sync.js must not contain any < characters');
console.log('✓ sync.js verified: 0 "<" characters found');

// Mock DOM & environment
global.window = global;
global.document = {
  querySelector: () => ({
    value: '',
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    close() {},
    showModal() {}
  }),
  querySelectorAll: () => [],
  addEventListener: () => {}
};
global.navigator = { onLine: true };
global.today = () => '2026-10-23';
global.money = { format: (n) => `$${n}` };
global.showToast = () => {};
global.scheduleSave = () => {};
global.persistNow = () => Promise.resolve();
global.renderAll = () => {};

// Cloud dataset mock in Supabase
const mockCloudData = {
  negocios: [
    {
      id: 'nexopos_cloud_bar',
      nombre: 'Bar Central de Prueba',
      telefono: '3109998877',
      configuracion: { nit: '901234567-8', address: 'Calle 10 # 20-30' },
      created_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-23T12:00:00.000Z'
    }
  ],
  productos: [
    {
      id: 'prod-cloud-1',
      business_id: 'nexopos_cloud_bar',
      nombre: 'Cerveza Artesanal IPA',
      categoria: 'Cervezas Especiales',
      precio: 14000,
      costo: 7500,
      stock: 35,
      min_stock: 8,
      activo: true,
      created_at: '2026-10-02T10:00:00.000Z',
      updated_at: '2026-10-23T12:00:00.000Z'
    },
    {
      id: 'prod-cloud-2',
      business_id: 'nexopos_cloud_bar',
      nombre: 'Gin Tonic Botánico',
      categoria: 'Cocteles',
      precio: 32000,
      costo: 12000,
      stock: 18,
      min_stock: 5,
      activo: true,
      created_at: '2026-10-02T11:00:00.000Z',
      updated_at: '2026-10-23T12:00:00.000Z'
    }
  ],
  ventas: [
    {
      id: 'pay-cloud-1',
      business_id: 'nexopos_cloud_bar',
      order_id: 'ord-cloud-1',
      total: 28000,
      method: 'Nequi',
      payments: [{ method: 'Nequi', amount: 28000 }],
      items: [{ productId: 'prod-cloud-1', name: 'Cerveza Artesanal IPA', price: 14000, qty: 2 }],
      customer: 'Mesa 4',
      cashier: 'Carlos Cajero',
      shift_id: 'shift-100',
      fecha: '2026-10-22T20:00:00.000Z',
      created_at: '2026-10-22T20:00:00.000Z',
      updated_at: '2026-10-22T20:00:00.000Z'
    }
  ],
  gastos: [
    {
      id: 'pur-cloud-1',
      business_id: 'nexopos_cloud_bar',
      categoria: 'Compra: Cervecería del Valle',
      descripcion: 'Compra factura FAC-908 · Cervecería del Valle',
      monto: 350000,
      comprobante: 'FAC-908',
      proveedor_id: 'prov-cloud-1',
      fecha: '2026-10-20T10:00:00.000Z',
      created_at: '2026-10-20T10:00:00.000Z',
      updated_at: '2026-10-20T10:00:00.000Z'
    },
    {
      id: 'exp-cloud-1',
      business_id: 'nexopos_cloud_bar',
      categoria: 'Servicios',
      descripcion: 'Pago de energía eléctrica local',
      monto: 120000,
      comprobante: '',
      proveedor_id: null,
      fecha: '2026-10-21T15:00:00.000Z',
      created_at: '2026-10-21T15:00:00.000Z',
      updated_at: '2026-10-21T15:00:00.000Z'
    }
  ],
  proveedores: [
    {
      id: 'prov-cloud-1',
      business_id: 'nexopos_cloud_bar',
      nombre: 'Cervecería del Valle',
      telefono: '3001112233',
      contacto: '900888777-1',
      direccion: 'Zona Industrial Lote 4',
      notas: 'Entrega los martes',
      email: 'ventas@vallebeer.com',
      created_at: '2026-10-01T08:00:00.000Z',
      updated_at: '2026-10-01T08:00:00.000Z'
    }
  ],
  mermas: [
    {
      id: 'merma-cloud-1',
      business_id: 'nexopos_cloud_bar',
      producto_id: 'stock-prod-cloud-1',
      producto_nombre: 'Cerveza Artesanal IPA',
      cantidad: 1,
      motivo: 'Rotura / Merma',
      observacion: 'Botella quebrada durante descarga',
      fecha: '2026-10-21T11:00:00.000Z',
      created_at: '2026-10-21T11:00:00.000Z',
      updated_at: '2026-10-21T11:00:00.000Z'
    }
  ]
};

// Supabase Mock: consulta encadenable como supabase-js (select/eq/gt/in/order/limit/maybeSingle/then)
const mockSupabase = {
  from(table) {
    return {
      select(columns = '*') {
        const filters = []; let orderCol = null, max = Infinity;
        const run = () => {
          let rows = (mockCloudData[table] || []).filter(r => filters.every(f => f(r)));
          if (orderCol) rows = [...rows].sort((a, b) => String(a[orderCol]).localeCompare(String(b[orderCol])));
          rows = rows.slice(0, max);
          return columns === '*' ? rows : rows.map(r => Object.fromEntries(columns.split(',').map(c => [c, r[c]])));
        };
        const q = {
          eq(col, val) { filters.push(r => r[col] === val); return q; },
          gt(col, val) { filters.push(r => String(r[col]) > String(val)); return q; },
          in(col, vals) { filters.push(r => vals.includes(r[col])); return q; },
          order(col) { orderCol = col; return q; },
          limit(n) { max = n; return q; },
          maybeSingle: () => Promise.resolve({ data: run()[0] || null, error: null }),
          then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject)
        };
        return q;
      },
      upsert(records) {
        return Promise.resolve({ data: records, error: null });
      },
      delete() {
        return { in: () => Promise.resolve({ error: null }) };
      }
    };
  }
};
global.supabase = {
  createClient: () => mockSupabase
};

// Load sync.js
require('../sync.js');

// Initialize fresh empty state (simulating fresh install in Netlify or mobile browser)
global.state = {
  profile: { name: 'Mi Bar', syncId: 'nexopos_cloud_bar' },
  products: [
    { id: 'p1', name: 'Demo 1' },
    { id: 'p2', name: 'Demo 2' }
  ],
  inventory: [
    { id: 'stock-p1', name: 'Demo 1', qty: 10, min: 5 }
  ],
  categories: ['Todos'],
  payments: [],
  purchases: [],
  expenses: [],
  suppliers: [],
  stockLog: []
};

// 2. Test NexoSync.pullAllFromSupabase
console.log('\n2. Testing NexoSync.pullAllFromSupabase("nexopos_cloud_bar")...');
assert.strictEqual(typeof NexoSync.pullAllFromSupabase, 'function', 'pullAllFromSupabase must be a function in NexoSync');

NexoSync.pullAllFromSupabase('nexopos_cloud_bar').then(res => {
  assert.strictEqual(res.ok, true, 'pullAllFromSupabase should succeed');
  assert.strictEqual(res.count, 8, 'Should have downloaded 1 business + 2 products + 1 sale + 2 expenses + 1 supplier + 1 merma = 8 total');
  console.log(`✓ pullAllFromSupabase completed: ${res.count} records downloaded`);

  // Verify Profile
  assert.strictEqual(state.profile.name, 'Bar Central de Prueba');
  assert.strictEqual(state.profile.sync_status, 'synced');
  console.log(`✓ Profile hydrated: '${state.profile.name}', NIT: ${state.profile.nit}`);

  // Verify Products & Inventory
  assert.strictEqual(state.products.length, 2, 'Demo products should be replaced by the 2 cloud products');
  assert.strictEqual(state.products[0].name, 'Cerveza Artesanal IPA');
  assert.strictEqual(state.products[0].stock, 35);
  assert.strictEqual(state.products[0].sync_status, 'synced');
  assert.strictEqual(state.products[1].name, 'Gin Tonic Botánico');
  assert.strictEqual(state.products[1].stock, 18);

  // Verify inventory item
  const inv1 = state.inventory.find(i => i.id === 'stock-prod-cloud-1');
  assert.ok(inv1, 'Inventory item stock-prod-cloud-1 should exist');
  assert.strictEqual(inv1.qty, 35);
  console.log(`✓ Products & Inventory hydrated: ${state.products.length} products with matching stock`);

  // Verify Sales (Payments)
  assert.strictEqual(state.payments.length, 1);
  assert.strictEqual(state.payments[0].amount, 28000);
  assert.strictEqual(state.payments[0].method, 'Nequi');
  assert.strictEqual(state.payments[0].sync_status, 'synced');
  console.log(`✓ Sales hydrated: 1 payment (${money.format(state.payments[0].amount)} - ${state.payments[0].method})`);

  // Verify Purchases & Expenses
  assert.strictEqual(state.purchases.length, 1);
  assert.strictEqual(state.purchases[0].invoice, 'FAC-908');
  assert.strictEqual(state.purchases[0].total, 350000);
  assert.strictEqual(state.purchases[0].sync_status, 'synced');

  assert.strictEqual(state.expenses.length, 1);
  assert.strictEqual(state.expenses[0].category, 'Servicios');
  assert.strictEqual(state.expenses[0].amount, 120000);
  assert.strictEqual(state.expenses[0].sync_status, 'synced');
  console.log(`✓ Expenses & Purchases separated: 1 purchase ($350,000) and 1 expense ($120,000)`);

  // Verify Suppliers
  assert.strictEqual(state.suppliers.length, 1);
  assert.strictEqual(state.suppliers[0].name, 'Cervecería del Valle');
  assert.strictEqual(state.suppliers[0].sync_status, 'synced');
  console.log(`✓ Supplier hydrated: '${state.suppliers[0].name}'`);

  // Verify Mermas
  assert.strictEqual(state.stockLog.length, 1);
  assert.strictEqual(state.stockLog[0].type, 'merma');
  assert.strictEqual(state.stockLog[0].delta, -1);
  assert.strictEqual(state.stockLog[0].sync_status, 'synced');
  console.log(`✓ Mermas hydrated: 1 record (${state.stockLog[0].itemName}, delta ${state.stockLog[0].delta})`);

  // 3. Verify that NONE of the hydrated records are marked pending
  const pendingCount = NexoSync.getPendingCount();
  assert.strictEqual(pendingCount, 0, 'No pulled records should be marked as pending');
  console.log('✓ Verified: 0 pending records (no push loop)');

  console.log('\nALL PULL / HYDRATION & CLOUD RESTORE TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
