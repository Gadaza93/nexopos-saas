// Test suite for Modo Demo Local (Sandbox)
const assert = require('assert');

console.log("=== INICIANDO PRUEBAS: MODO DEMO LOCAL (SANDBOX) Y PROTECCIÓN SUPABASE ===");

// 1. Simulación de entorno con mock de DOM
function createMockElement(initial = {}) {
  const listeners = {};
  const classes = new Set();
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    title: '',
    style: {},
    disabled: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c); else classes.add(c);
        } else if (force) classes.add(c); else classes.delete(c);
      },
      contains: (c) => classes.has(c)
    },
    addEventListener: (evt, fn) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    trigger: (evt, data) => {
      (listeners[evt] || []).forEach(fn => fn(data));
    },
    setAttribute: () => {},
    removeAttribute: () => {},
    querySelectorAll: () => [],
    ...initial
  };
}

const mockElements = {
  '#syncStatusIndicator': createMockElement(),
  '#syncLabel': createMockElement(),
  '#syncBadgeTopbar': createMockElement(),
  '#syncBadgeLabel': createMockElement(),
  '#sidebarPullButton': createMockElement(),
  '#btn-mobile-menu': createMockElement(),
  '#btn-close-drawer': createMockElement(),
  '#mobileMenuOverlay': createMockElement(),
  '#mobileDrawer': createMockElement(),
  '#mobileShiftBtn': createMockElement(),
  '#orderDialog': createMockElement({ showModal: () => {}, close: () => {} }),
  '#productGrid': createMockElement(),
  '#categoryTabs': createMockElement(),
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
  '#mobileOrderCount': createMockElement(),
  '#mobileBarCount': createMockElement(),
  '#mobileBarTotal': createMockElement(),
  '#mobileBarTicketBtn': createMockElement(),
  '#mobileBarChargeBtn': createMockElement(),
  '.catalog-panel': createMockElement(),
  '.ticket-panel': createMockElement()
};

global.document = {
  querySelector: (sel) => mockElements[sel] || createMockElement(),
  querySelectorAll: () => [],
  addEventListener: () => {}
};

// Objeto window simulado para pruebas de detección
global.window = {
  location: {
    hostname: 'nexopos.netlify.app',
    search: '',
    protocol: 'https:'
  },
  addEventListener: () => {},
  desktop: null
};

globalThis.__IS_NODE_TEST__ = true;

// Cargar módulos
delete require.cache[require.resolve('../storage.js')];
require('../storage.js');
delete require.cache[require.resolve('../modules.js')];
require('../modules.js');
delete require.cache[require.resolve('../sync.js')];
require('../sync.js');
delete require.cache[require.resolve('../app.js')];
require('../app.js');

const NexoSync = global.NexoSync || global.window?.NexoSync || globalThis.NexoSync;

async function runDemoTests() {
  console.log("\n1. Probando lógica de detección de Modo Demo vs Producción...");

  // Caso 1.A: En Netlify (web pública) sin ?demo=true -> Producción real
  global.window.desktop = null;
  global.window.location.hostname = 'nexopos.netlify.app';
  global.window.location.search = '';
  assert.strictEqual(NexoSync.isDemoMode(), false, "La URL normal de netlify.app debe abrir producción");
  console.log("   ✅ La URL normal de Netlify abre el POS en producción.");

  // Caso 1.A2: Netlify con ?demo=true -> Demo
  global.window.location.search = '?demo=true';
  assert.strictEqual(NexoSync.isDemoMode(), true, "Debe ser true en netlify.app con ?demo=true");
  console.log("   ✅ Netlify con ?demo=true activa el Modo Demo.");

  // Caso 1.B: Con parámetro ?demo=true en cualquier host -> Debe ser Demo
  global.window.location.hostname = 'localhost';
  global.window.location.search = '?demo=true';
  assert.strictEqual(NexoSync.isDemoMode(), true, "Debe ser true con ?demo=true");
  console.log("   ✅ Detecta ?demo=true como Modo Demo.");

  // Caso 1.C: En app de escritorio Electron (.exe) -> NO debe ser Demo (Producción)
  global.window.desktop = { isDesktop: true };
  global.window.location.search = '';
  assert.strictEqual(NexoSync.isDemoMode(), false, "En .exe con desktop.isDesktop debe ser false");
  console.log("   ✅ Detecta app instalada .exe (desktop.isDesktop) como Producción real.");

  // Caso 1.D: Con parámetro explícito ?demo=false -> NO debe ser Demo
  global.window.desktop = null;
  global.window.location.hostname = 'nexopos.netlify.app';
  global.window.location.search = '?demo=false';
  assert.strictEqual(NexoSync.isDemoMode(), false, "Debe ser false con ?demo=false");
  console.log("   ✅ Respeta ?demo=false en la web.");

  // Activar Modo Demo para las siguientes pruebas
  console.log("\n2. Probando desactivación de llamadas de escritura a Supabase en Modo Demo...");
  global.window.location.search = '?demo=true';
  global.window.desktop = null;
  assert.strictEqual(NexoSync.isDemoMode(), true);

  // A. syncSale
  const testSale = { id: 'v_demo_1', total: 14000, method: 'Efectivo', items: [{ id: 'p1', qty: 2 }] };
  const resSale = await NexoSync.syncSale(testSale);
  assert.strictEqual(resSale.ok, true);
  assert.strictEqual(resSale.demo, true);
  assert.strictEqual(testSale.sync_status, 'synced');
  console.log("   ✅ syncSale(): Bloquea llamada a Supabase y marca localmente como synced.");

  // B. syncOrders
  global.state.orders = [{ id: 'ord_demo_1', tableName: 'Mesa 1', status: 'open', items: [{ productId: 'p1', qty: 1 }] }];
  const resOrders = await NexoSync.syncOrders();
  assert.strictEqual(resOrders.ok, true);
  assert.strictEqual(resOrders.demo, true);
  assert.strictEqual(global.state.orders[0].sync_status, 'synced');
  console.log("   ✅ syncOrders(): Bloquea llamada a Supabase y mantiene ordenes en IndexedDB.");

  // C. deleteActiveOrder
  const resDelOrder = await NexoSync.deleteActiveOrder('ord_demo_1');
  assert.strictEqual(resDelOrder.ok, true);
  assert.strictEqual(resDelOrder.demo, true);
  console.log("   ✅ deleteActiveOrder(): Bloquea borrado remoto en Supabase.");

  // D. syncCashShift
  const testShift = { id: 'shift_demo', status: 'open', openingCash: 50000 };
  const resShift = await NexoSync.syncCashShift(testShift);
  assert.strictEqual(resShift.ok, true);
  assert.strictEqual(resShift.demo, true);
  console.log("   ✅ syncCashShift(): Bloquea escritura a turnos_caja en Supabase.");

  // E. deleteProduct y deleteSale
  const resDelProd = await NexoSync.deleteProduct('p_demo_1');
  assert.strictEqual(resDelProd.ok, true);
  assert.strictEqual(resDelProd.demo, true);
  const resDelSale = await NexoSync.deleteSale('v_demo_1');
  assert.strictEqual(resDelSale.ok, true);
  assert.strictEqual(resDelSale.demo, true);
  console.log("   ✅ deleteProduct() y deleteSale(): Bloquean borrados en Supabase.");

  // F. syncAdminPin
  const resPin = await NexoSync.syncAdminPin('4321');
  assert.strictEqual(resPin.ok, true);
  assert.strictEqual(resPin.demo, true);
  assert.strictEqual(resPin.pin, '4321');
  console.log("   ✅ syncAdminPin(): Aplica PIN solo localmente sin alterar Supabase.");

  // G. pullAllFromSupabase
  const resPull = await NexoSync.pullAllFromSupabase();
  assert.strictEqual(resPull.ok, true);
  assert.strictEqual(resPull.demo, true);
  assert.strictEqual(resPull.count, 0);
  console.log("   ✅ pullAllFromSupabase(): Omite descarga remota para no pisar datos locales.");

  // H. syncAll
  const resSyncAll = await NexoSync.syncAll();
  assert.strictEqual(resSyncAll.ok, true);
  assert.strictEqual(resSyncAll.demo, true);
  console.log("   ✅ syncAll(): No realiza peticiones hacia Supabase.");

  console.log("\n3. Probando inicialización de catálogo demo (Sandbox) si la base local está vacía...");
  global.state.products.length = 0;
  global.state.inventory.length = 0;
  global.initDemoDataIfNeeded();

  assert.strictEqual(global.state.products.length > 0, true, "Debe tener productos sembrados");
  assert.strictEqual(global.state.inventory.length > 0, true, "Debe tener inventario sembrado");
  console.log(`   - Productos sembrados en demo: ${global.state.products.length}`);
  console.log(`   - Insumos de inventario sembrados: ${global.state.inventory.length}`);
  const firstP = global.state.products[0];
  console.log(`   - Primer producto demo: ${firstP.name} | Precio: ${firstP.price} | Stock: ${firstP.stock}`);
  assert.strictEqual(firstP.stock > 0, true);
  console.log("   ✅ initDemoDataIfNeeded(): Sembró catálogo completo listo para operar.");

  console.log("\n4. Probando resetDemoData()...");
  global.state.orders = [{ id: 'some_order', items: [] }];
  global.resetDemoData();
  assert.strictEqual(global.state.orders.length, 0, "Órdenes deben limpiarse");
  assert.strictEqual(global.state.products.length, global.DEMO_PRODUCTS.length);
  console.log("   ✅ resetDemoData(): Reinicia datos de prueba limpiamente.");

  console.log("\n=== TODAS LAS PRUEBAS DE MODO DEMO PASARON CON ÉXITO ===");
}

runDemoTests().catch(err => {
  console.error("❌ Error en pruebas:", err);
  process.exit(1);
});
