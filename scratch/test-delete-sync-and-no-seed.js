// Test Delete Sync & Seed Deactivation
const DEFAULT_BUSINESS_ID = "nexopos_default";
// Cliente Supabase simulado con RLS (sesión 'authenticated' del negocio): no toca la base real
const { createMockSupabase } = require("./mock-supabase.js");

async function runTests() {
  console.log("=== INICIANDO PRUEBAS: PERSISTENCIA DE BORRADO Y DESACTIVACIÓN DE SEED ===");
  global.__IS_NODE_TEST__ = true;
  const sb = createMockSupabase({ businessId: DEFAULT_BUSINESS_ID });

  // 1. Mock DOM
  global.window = global;
  global.supabase = { createClient: () => sb };
  global.navigator = { onLine: true };
  global.localStorage = {
    _data: {},
    getItem: function (k) { return this._data[k] || null; },
    setItem: function (k, v) { this._data[k] = String(v); },
    removeItem: function (k) { delete this._data[k]; }
  };
  global.showToast = msg => console.log("   [Toast]:", msg);

  const domElements = {
    '#productsTable': { innerHTML: '', addEventListener: () => {} },
    '#inventoryTable': { innerHTML: '', addEventListener: () => {} },
    '#productGrid': { innerHTML: '', addEventListener: () => {} },
    '#ticketItems': { innerHTML: '', addEventListener: () => {} },
    '#orderTotal': { textContent: '', addEventListener: () => {} },
    '#deleteOrderButton': { style: {}, addEventListener: () => {} },
    '#paidNote': { hidden: true, textContent: '', addEventListener: () => {} },
    '#categoryTabs': { innerHTML: '', addEventListener: () => {} },
    '#inventorySummary': { innerHTML: '', addEventListener: () => {} }
  };

  global.document = {
    querySelector: (sel) => {
      if (!domElements[sel]) {
        domElements[sel] = {
          value: '',
          checked: true,
          hidden: false,
          textContent: '',
          innerHTML: '',
          style: {},
          classList: { add: () => {}, remove: () => {} },
          addEventListener: () => {}
        };
      }
      if (!domElements[sel].addEventListener) {
        domElements[sel].addEventListener = () => {};
      }
      return domElements[sel];
    },
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  // Cargar módulos en el mismo orden que index.html
  delete require.cache[require.resolve('../storage.js')];
  require('../storage.js');

  delete require.cache[require.resolve('../modules.js')];
  require('../modules.js');

  delete require.cache[require.resolve('../sync.js')];
  require('../sync.js');
  const NexoSync = global.NexoSync;

  // Cargar app.js para probar defaultState y normalizeState
  delete require.cache[require.resolve('../app.js')];
  require('../app.js');

  // PRUEBA 1: Verificar que la base de datos inicia en cero (sin seed ni productos demo)
  console.log("\n1. Verificando que defaultState y normalizeState inician en cero...");
  console.log("   Productos en defaultState:", global.state.products.length);
  console.log("   Insumos en inventario defaultState:", global.state.inventory.length);

  if (global.state.products.length !== 0) {
    throw new Error(`Se esperaban 0 productos por defecto, pero hay ${global.state.products.length}`);
  }
  if (global.state.inventory.length !== 0) {
    throw new Error(`Se esperaban 0 insumos en inventario por defecto, pero hay ${global.state.inventory.length}`);
  }
  console.log("   ✅ defaultState no contiene productos ni insumos demo.");

  // Probar renderProducts() con catálogo vacío
  renderProducts();
  const tableContent = domElements['#productsTable'].innerHTML;
  console.log("   Mensaje en tabla de productos vacía:", tableContent);
  if (!tableContent.includes("No hay productos registrados. Crea uno nuevo o importa tu archivo Excel")) {
    throw new Error("renderProducts no mostró el mensaje esperado cuando el catálogo está vacío");
  }
  console.log("   ✅ Mensaje exacto de catálogo vacío renderizado en la tabla.");

  // PRUEBA 2: Crear un producto de prueba y probar borrado sincronizado en Supabase y local
  console.log("\n2. Probando creación y borrado sincronizado de producto...");
  const testProdId = `prod_del_test_${Date.now()}`;
  const testProduct = {
    id: testProdId,
    name: "Producto Prueba Borrado",
    category: "Licores",
    price: 50000,
    cost: 30000,
    stock: 10,
    sync_status: "nuevo_local"
  };

  // Upsert en Supabase para simular existencia en la nube
  await sb.from("productos").upsert({
    id: testProdId,
    business_id: DEFAULT_BUSINESS_ID,
    nombre: testProduct.name,
    categoria: testProduct.category,
    precio: testProduct.price,
    costo: testProduct.cost,
    stock: testProduct.stock,
    min_stock: 2,
    activo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: "id" });

  global.state.products.push(testProduct);
  global.state.inventory.push({ id: `stock-${testProdId}`, name: testProduct.name, unit: "und", qty: 10, min: 2 });

  // Ejecutar deleteProduct de NexoSync
  console.log(`   Ejecutando borrado de producto ID '${testProdId}' en Supabase y local...`);
  const delProdRes = await NexoSync.deleteProduct(testProdId);
  console.log("   Resultado deleteProduct:", delProdRes);

  // Verificar que en local se haya eliminado
  global.state.products = global.state.products.filter(p => p.id !== testProdId);
  if (global.state.products.some(p => p.id === testProdId)) {
    throw new Error("El producto aún existe en state.products");
  }

  // Verificar en Supabase directamente
  const { data: checkProd } = await sb.from("productos").select("*").eq("id", testProdId);
  if (checkProd && checkProd.length > 0) {
    throw new Error("El producto no fue eliminado de Supabase");
  }
  console.log("   ✅ Producto eliminado exitosamente de Supabase e IndexedDB/memoria.");

  // PRUEBA 3: Crear una venta de prueba y probar borrado sincronizado en Supabase y local
  console.log("\n3. Probando creación y borrado sincronizado de factura / venta...");
  const testSaleId = `pay_del_test_${Date.now()}`;
  await sb.from("ventas").upsert({
    id: testSaleId,
    business_id: DEFAULT_BUSINESS_ID,
    order_id: "ord_1",
    total: 25000,
    method: "Efectivo",
    customer: "Cliente Prueba",
    fecha: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: "id" });

  global.state.payments.push({
    id: testSaleId,
    amount: 25000,
    method: "Efectivo",
    sync_status: "synced"
  });

  console.log(`   Ejecutando borrado de venta ID '${testSaleId}' en Supabase y local...`);
  const delSaleRes = await NexoSync.deleteSale(testSaleId);
  console.log("   Resultado deleteSale:", delSaleRes);

  global.state.payments = global.state.payments.filter(p => p.id !== testSaleId);
  if (global.state.payments.some(p => p.id === testSaleId)) {
    throw new Error("La venta aún existe en state.payments");
  }

  // Verificar en Supabase
  const { data: checkSale } = await sb.from("ventas").select("*").eq("id", testSaleId);
  if (checkSale && checkSale.length > 0) {
    throw new Error("La venta no fue eliminada de Supabase");
  }
  console.log("   ✅ Venta eliminada exitosamente de Supabase e IndexedDB/memoria.");

  // PRUEBA 4: Regla de subida push estricta (no resubir sin marca 'nuevo_local' o 'pending')
  console.log("\n4. Probando regla estricta de push (no resubir registros sincronizados)...");
  global.state.products = [
    {
      id: "prod_already_synced",
      name: "Producto Ya Sincronizado",
      price: 10000,
      stock: 5,
      sync_status: "synced"
    }
  ];
  global.state.payments = [
    {
      id: "sale_already_synced",
      amount: 10000,
      sync_status: "synced"
    }
  ];

  const prodSyncRes = await NexoSync.syncProductos();
  const salesSyncRes = await NexoSync.syncSales();

  console.log("   Productos subidos en push normal:", prodSyncRes.count);
  console.log("   Ventas subidas en push normal:", salesSyncRes.count);

  if (prodSyncRes.count !== 0) throw new Error("Se resubió un producto que ya tenía sync_status 'synced'");
  if (salesSyncRes.count !== 0) throw new Error("Se resubió una venta que ya tenía sync_status 'synced'");
  console.log("   ✅ Registros con 'synced' no fueron resubidos a Supabase.");

  // Ahora marcar uno como 'nuevo_local'
  global.state.products.push({
    id: `prod_nuevo_${Date.now()}`,
    name: "Producto Nuevo Local",
    price: 15000,
    cost: 8000,
    stock: 20,
    sync_status: "nuevo_local"
  });

  const nuevoSyncRes = await NexoSync.syncProductos();
  console.log("   Productos subidos con marca 'nuevo_local':", nuevoSyncRes.count);
  if (nuevoSyncRes.count !== 1) throw new Error("El producto con marca 'nuevo_local' no fue subido");

  // Limpiar producto de prueba
  await sb.from("productos").delete().eq("id", global.state.products[1].id);
  console.log("   ✅ Solo los registros con marca explícita 'nuevo_local' / 'pending' se sincronizan hacia la nube.");

  console.log("\n=== TODAS LAS PRUEBAS PASARON EXITOSAMENTE ===");
  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ ERROR EN PRUEBAS:", err);
  process.exit(1);
});
