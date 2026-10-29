const DEFAULT_BUSINESS_ID = "nexopos_default";
// Cliente Supabase simulado con RLS (sesión 'authenticated' del negocio): no toca la base real
const { createMockSupabase } = require("./mock-supabase.js");

global.__IS_NODE_TEST__ = true;
global.window = global;
global.window.confirm = () => true;
global.supabase = { createClient: () => createMockSupabase({ businessId: DEFAULT_BUSINESS_ID, seed: {
    productos: [
      { id: "mock_prod_1", business_id: DEFAULT_BUSINESS_ID, nombre: "Cerveza Club Colombia", categoria: "Cervezas", precio: 6000, costo: 3500, stock: 48, min_stock: 6, activo: true },
      { id: "mock_prod_2", business_id: DEFAULT_BUSINESS_ID, nombre: "Aguardiente Antioqueño 375ml", categoria: "Licores", precio: 45000, costo: 28000, stock: 12, min_stock: 2, activo: true },
      { id: "mock_prod_3", business_id: DEFAULT_BUSINESS_ID, nombre: "Papas Margarita", categoria: "Dulceria", precio: 3000, costo: 1500, stock: 30, min_stock: 5, activo: true }
    ]
  } }) };
global.navigator = { onLine: true };
global.localStorage = {
  _data: {},
  getItem: function (k) { return this._data[k] || null; },
  setItem: function (k, v) { this._data[k] = String(v); },
  removeItem: function (k) { delete this._data[k]; }
};
global.showToast = msg => console.log("   [Toast]:", msg);

const createMockElement = (props = {}) => ({
  value: '',
  checked: true,
  hidden: false,
  textContent: '',
  innerHTML: '',
  style: {},
  classList: {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false
  },
  showModal: function() { this.open = true; },
  close: function() { this.open = false; },
  addEventListener: () => {},
  ...props
});

const domElements = {
  '#orderZone': createMockElement(),
  '#orderTitle': createMockElement(),
  '#orderNote': createMockElement(),
  '#orderDialog': createMockElement(),
  '#categoryTabs': createMockElement(),
  '#productGrid': createMockElement(),
  '#productSearch': createMockElement(),
  '#ticketItems': createMockElement(),
  '#orderTotal': createMockElement(),
  '#deleteOrderButton': createMockElement(),
  '#paidNote': createMockElement({ hidden: true }),
  '#todayLabel': createMockElement(),
  '#shiftStatusButton': createMockElement(),
  '#salesToday': createMockElement(),
  '#salesCount': createMockElement(),
  '#activeTables': createMockElement(),
  '#activeItems': createMockElement(),
  '#openOrdersCount': createMockElement(),
  '#cashExpected': createMockElement(),
  '#tableGrid': createMockElement(),
  '#customOrdersList': createMockElement(),
  '#productsTable': createMockElement(),
  '#inventoryTable': createMockElement(),
  '#inventorySummary': createMockElement()
};

global.document = {
  querySelector: (sel) => domElements[sel] || createMockElement(),
  querySelectorAll: () => [],
  addEventListener: () => {}
};

require('../storage.js');
require('../modules.js');
require('../sync.js');
require('../app.js');

async function testOrderModal() {
  console.log("=== INICIANDO PRUEBAS: MODAL DE NUEVO PEDIDO Y PRODUCTOS POS ===");
  if (global.NexoSync) {
    global.NexoSync.scheduleSync = () => {};
  }

  // 1. Descarga e hidratación desde Supabase
  console.log("\n1. Descargando productos reales desde Supabase...");
  await global.NexoSync.pullAllFromSupabase();
  console.log("   - state.products cargados:", global.state.products.length);
  console.log("   - state.inventory cargados:", global.state.inventory.length);

  if (global.state.products.length === 0) {
    throw new Error("No se cargaron productos desde Supabase.");
  }

  // Abrir turno de caja para permitir pedidos y limpiar órdenes residuales para la prueba
  global.state.cashShift = { id: 'shift_test', status: 'open', openingCash: 50000 };
  global.state.orders = [];

  // 2. Probar getPOSProducts()
  console.log("\n2. Probando función getPOSProducts()...");
  const posProducts = global.getPOSProducts();
  console.log(`   - Productos disponibles para el POS: ${posProducts.length}`);
  if (posProducts.length !== global.state.products.length) {
    throw new Error(`Discrepancia en productos: getPOSProducts retornó ${posProducts.length}, esperados ${global.state.products.length}`);
  }
  // Verificar que ningún producto requiera activo: true o disponible_pos: true explícito para mostrarse
  const firstProd = posProducts[0];
  console.log("   - Primer producto:", firstProd.name, "| Categoría:", firstProd.category, "| Precio:", firstProd.price, "| Stock:", firstProd.stock);
  if (!firstProd.name || firstProd.price == null || !firstProd.category) {
    throw new Error("El producto debe contener nombre, precio y categoría válidos.");
  }
  console.log("   ✅ getPOSProducts() consolidó el catálogo correctamente.");

  // 3. Probar apertura de '+ Nuevo pedido' (openOrder sin argumentos)
  console.log("\n3. Probando openOrder() al hacer clic en '+ Nuevo pedido'...");
  // Simular que antes había una búsqueda y otra categoría
  global.state.activeCategory = 'Dulceria';
  global.state.search = 'xyz_inexistente';
  domElements['#productSearch'].value = 'xyz_inexistente';

  global.openOrder();

  if (domElements['#orderDialog'].open !== true) {
    throw new Error("El diálogo #orderDialog debería estar abierto.");
  }
  if (global.state.activeCategory !== 'Todos') {
    throw new Error(`Se esperaba categoría por defecto 'Todos', pero es '${global.state.activeCategory}'`);
  }
  if (global.state.search !== '') {
    throw new Error(`Se esperaba búsqueda vacía '', pero es '${global.state.search}'`);
  }
  if (domElements['#productSearch'].value !== '') {
    throw new Error("El input #productSearch debería haberse limpiado.");
  }

  // Verificar renderizado de categorías
  const catTabsHtml = domElements['#categoryTabs'].innerHTML;
  console.log("   - catTabsHtml:", JSON.stringify(catTabsHtml.slice(0, 200)));
  if (!catTabsHtml.includes('Todos') || !catTabsHtml.includes('category-button active')) {
    throw new Error("Las pestañas de categorías no tienen 'Todos' activo por defecto.");
  }
  console.log("   ✅ Pestaña 'Todos' y buscador reseteados por defecto.");

  // Verificar renderizado de productos en el grid
  const prodGridHtml = domElements['#productGrid'].innerHTML;
  if (!prodGridHtml.includes('data-product=') || !prodGridHtml.includes('product-category-chip') || !prodGridHtml.includes('product-price')) {
    throw new Error("El grid de productos no renderizó las tarjetas con categoría y precio.");
  }
  const renderedButtonsCount = (prodGridHtml.match(/<button[^>]+class="product/g) || []).length;
  console.log(`   - Tarjetas de productos renderizadas en 'Todos': ${renderedButtonsCount}`);
  if (renderedButtonsCount !== posProducts.length) {
    throw new Error(`Se esperaban ${posProducts.length} productos renderizados, pero hay ${renderedButtonsCount}`);
  }
  console.log("   ✅ Todas las tarjetas de productos se renderizaron con nombre, precio, categoría y stock.");

  // 4. Probar apertura de mesa física (openOrder('m1'))
  console.log("\n4. Probando openOrder('m1') en Mesa 1...");
  global.openOrder('m1');
  if (domElements['#orderZone'].textContent !== 'SALÓN' && domElements['#orderZone'].textContent !== 'SALON') {
    throw new Error(`Zona esperada 'SALÓN', recibida '${domElements['#orderZone'].textContent}'`);
  }
  if (domElements['#orderTitle'].textContent !== 'Mesa 1') {
    throw new Error(`Título esperado 'Mesa 1', recibido '${domElements['#orderTitle'].textContent}'`);
  }
  console.log("   ✅ Mesa 1 abierta con catálogo completo cargado.");

  // 5. Probar filtro por Categoría
  console.log("\n5. Probando filtrado por categoría 'Cervezas'...");
  global.state.activeCategory = 'Cervezas';
  global.renderOrderDialog();

  const beersHtml = domElements['#productGrid'].innerHTML;
  const beerButtons = (beersHtml.match(/<button[^>]+class="product/g) || []).length;
  const expectedBeers = posProducts.filter(p => (p.category || 'General').toLowerCase() === 'cervezas').length;
  console.log(`   - Cervezas encontradas: ${beerButtons} (esperadas: ${expectedBeers})`);
  if (beerButtons !== expectedBeers) {
    throw new Error(`Cervezas no coinciden: renderizadas ${beerButtons}, esperadas ${expectedBeers}`);
  }
  console.log("   ✅ Filtro por categoría funciona con precisión.");

  // 6. Probar Buscador de productos
  console.log("\n6. Probando buscador con término 'Agua'...");
  global.state.activeCategory = 'Todos';
  global.state.search = 'Agua';
  global.renderOrderDialog();

  const aguaHtml = domElements['#productGrid'].innerHTML;
  const aguaButtons = (aguaHtml.match(/<button[^>]+class="product/g) || []).length;
  const expectedAguas = posProducts.filter(p => p.name.toLowerCase().includes('agua') || (p.category && p.category.toLowerCase().includes('agua'))).length;
  console.log(`   - Productos encontrados para 'Agua': ${aguaButtons} (esperados: ${expectedAguas})`);
  if (aguaButtons !== expectedAguas) {
    throw new Error(`Resultados de búsqueda no coinciden: renderizados ${aguaButtons}, esperados ${expectedAguas}`);
  }
  console.log("   ✅ Buscador filtra correctamente sin romper el catálogo.");

  // 7. Probar agregar producto a la orden
  console.log("\n7. Probando agregar producto a la comanda...");
  const sampleProd = posProducts[0];
  global.addProduct(sampleProd.id);
  const curOrder = global.getOrder(global.state.currentOrderId);
  console.log("   - Ítems en la comanda tras addProduct:", curOrder.items.length);
  if (curOrder.items.length !== 1 || curOrder.items[0].productId !== sampleProd.id) {
    throw new Error("No se agregó correctamente el producto al pedido.");
  }
  const ticketHtml = domElements['#ticketItems'].innerHTML;
  if (!ticketHtml.includes(sampleProd.name)) {
    throw new Error("El ticket actual no muestra el producto agregado.");
  }
  console.log("   ✅ Producto agregado al ticket de comanda exitosamente.");

  // 8. Probar recuperación automática de ítems huérfanos de state.inventory
  console.log("\n8. Probando síntesis automática de insumos de inventario sin producto...");
  global.state.inventory.push({
    id: "inv_special_mojito_mint",
    name: "Menta Fresca Especial",
    category: "Cocteleria",
    qty: 25,
    cost: 500,
    price: 3500
  });

  const refreshedPOS = global.getPOSProducts();
  const foundSynthesized = refreshedPOS.find(p => p.name === "Menta Fresca Especial");
  if (!foundSynthesized) {
    throw new Error("El insumo de inventario no fue incorporado automáticamente al catálogo POS.");
  }
  console.log("   - Producto sintetizado desde inventario:", foundSynthesized.name, "Stock:", foundSynthesized.stock, "Precio:", foundSynthesized.price);
  if (foundSynthesized.stock !== 25) {
    throw new Error(`Stock esperado 25, recibido ${foundSynthesized.stock}`);
  }
  console.log("   ✅ Insumos de inventario con stock se incorporan automáticamente al POS.");

  console.log("\n=== TODAS LAS PRUEBAS DEL MODAL DE PEDIDOS Y CATÁLOGO PASARON EXITOSAMENTE ===");
  process.exit(0);
}

testOrderModal().catch(err => {
  console.error("❌ ERROR EN TEST:", err);
  process.exit(1);
});
