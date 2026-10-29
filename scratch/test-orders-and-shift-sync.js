// Test Realtime Orders & Cash Shift Synchronization
const DEFAULT_BUSINESS_ID = "nexopos_default";
// Cliente Supabase simulado con RLS (sesión 'authenticated' del negocio): no toca la base real
const { createMockSupabase } = require("./mock-supabase.js");

async function runTests() {
  console.log("=== INICIANDO PRUEBAS: SINCRONIZACIÓN DE MESAS, COMANDAS Y TURNOS DE CAJA ===");
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
    '#todayLabel': { textContent: '' },
    '#shiftStatusButton': { textContent: '', classList: { add: () => {}, remove: () => {} } },
    '#salesToday': { textContent: '' },
    '#salesCount': { textContent: '' },
    '#activeTables': { textContent: '0' },
    '#activeItems': { textContent: '0 bebidas y snacks' },
    '#openOrdersCount': { textContent: '0' },
    '#cashExpected': { textContent: 'Caja cerrada' },
    '#tableGrid': { innerHTML: '' },
    '#productsTable': { innerHTML: '', addEventListener: () => {} },
    '#inventoryTable': { innerHTML: '', addEventListener: () => {} },
    '#inventorySummary': { innerHTML: '' },
    '#productGrid': { innerHTML: '', addEventListener: () => {} },
    '#ticketItems': { innerHTML: '', addEventListener: () => {} },
    '#orderTotal': { textContent: '', addEventListener: () => {} },
    '#deleteOrderButton': { style: {}, addEventListener: () => {} },
    '#paidNote': { hidden: true, textContent: '', addEventListener: () => {} },
    '#categoryTabs': { innerHTML: '', addEventListener: () => {} },
    '#customOrdersList': { innerHTML: '' },
    '#orderZone': { textContent: '' },
    '#orderTitle': { textContent: '' },
    '#orderNote': { value: '', addEventListener: () => {} },
    '#orderDialog': { showModal: () => {}, close: () => {} },
    '#customOrderDialog': { showModal: () => {}, close: () => {} },
    '#customOrderName': { value: '' }
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
      return domElements[sel];
    },
    querySelectorAll: () => [],
    addEventListener: () => {}
  };

  // Cargar módulos
  delete require.cache[require.resolve('../storage.js')];
  require('../storage.js');
  delete require.cache[require.resolve('../modules.js')];
  require('../modules.js');
  delete require.cache[require.resolve('../sync.js')];
  require('../sync.js');
  delete require.cache[require.resolve('../app.js')];
  require('../app.js');

  const NexoSync = global.NexoSync;

  // Limpieza inicial para aislamiento de pruebas
  await sb.from("pedidos_activos").delete().eq("business_id", DEFAULT_BUSINESS_ID);
  global.state.orders = [];
  await NexoSync.syncOrders();

  // PRUEBA 1: Verificar syncOrders() y replicación en Supabase
  console.log("\n1. Probando creación de orden activa y sincronización hacia Supabase...");
  global.state.cashShift = { id: "shift_test_1", status: "open", openingCash: 100000, date: "2026-10-23" };
  const testOrderId = `ord_test_${Date.now()}`;
  const testOrder = {
    id: testOrderId,
    tableId: "m1",
    tableName: "Mesa 1",
    isCustom: false,
    items: [
      { productId: "p_test", name: "Cerveza Corona", price: 12000, qty: 2 }
    ],
    note: "Sin limón",
    status: "open",
    createdAt: Date.now(),
    shiftId: "shift_test_1",
    sync_status: "pending"
  };

  global.state.orders = [testOrder];

  // Renderizar estadísticas localmente
  global.renderStats();
  global.renderTables();
  console.log("   Métricas locales antes de subir:");
  console.log("   - Mesas activas:", domElements['#activeTables'].textContent);
  console.log("   - Pedidos abiertos:", domElements['#openOrdersCount'].textContent);

  if (String(domElements['#activeTables'].textContent) !== '1') {
    throw new Error(`Se esperaba 1 mesa activa, pero se obtuvo ${domElements['#activeTables'].textContent}`);
  }

  // Sincronizar hacia Supabase
  console.log("   Ejecutando syncOrders()...");
  const syncOrderRes = await NexoSync.syncOrders();
  console.log("   Resultado syncOrders:", syncOrderRes);

  if (!syncOrderRes.ok) {
    throw new Error(`Error en syncOrders: ${syncOrderRes.error}`);
  }

  // Verificar en Supabase directamente (en negocios.configuracion.orders)
  console.log("   Consultando negocios.configuracion en Supabase...");
  const { data: negData } = await sb.from("negocios").select("*").eq("id", DEFAULT_BUSINESS_ID).maybeSingle();
  const remoteOrders = negData?.configuracion?.orders;
  console.log(`   Órdenes en negocios.configuracion en Supabase: ${remoteOrders?.length || 0}`);

  const foundRemote = remoteOrders?.find(o => o.id === testOrderId);
  if (!foundRemote) {
    throw new Error(`La comanda ${testOrderId} no se encontró en Supabase negocios.configuracion.orders`);
  }
  console.log("   ✅ Comanda verificada en Supabase:", foundRemote.tableName, "-", foundRemote.items.length, "items");

  // PRUEBA 2: Simular un segundo dispositivo (ej. la versión Web) que descarga (pull)
  console.log("\n2. Probando descarga (pull) en un segundo dispositivo / navegador...");
  // Limpiar órdenes en el estado local simulando un navegador que inicia en 0
  global.state.orders = [];
  global.renderStats();
  global.renderTables();
  console.log("   Métricas en 2do dispositivo antes de pull: Mesas activas =", domElements['#activeTables'].textContent);

  if (String(domElements['#activeTables'].textContent) !== '0') {
    throw new Error("El 2do dispositivo no inició en 0 mesas");
  }

  // Ejecutar pullAllFromSupabase
  console.log("   Ejecutando pullAllFromSupabase() en el 2do dispositivo...");
  const pullRes = await NexoSync.pullAllFromSupabase();
  console.log("   Resultado pullAllFromSupabase:", pullRes);

  // Verificar que el 2do dispositivo ahora tiene la mesa activa
  console.log("   Métricas en 2do dispositivo tras pull:");
  console.log("   - Mesas activas:", domElements['#activeTables'].textContent);
  console.log("   - Pedidos abiertos:", domElements['#openOrdersCount'].textContent);

  if (String(domElements['#activeTables'].textContent) !== '1') {
    throw new Error(`Tras pull, se esperaba 1 mesa activa, pero hay ${domElements['#activeTables'].textContent}`);
  }
  console.log("   ✅ El 2do dispositivo descargó la comanda y actualizó las métricas a 1 mesa activa.");

  // PRUEBA 3: Cobrar / Cerrar la cuenta y verificar sincronización de estado cerrado
  console.log("\n3. Probando cobro de la comanda y actualización de estado a cerrada...");
  const orderToPay = global.state.orders.find(o => o.id === testOrderId);
  orderToPay.status = "paid";
  orderToPay.paidAt = Date.now();
  global.renderStats();
  global.renderTables();
  console.log("   Métricas locales tras cobrar: Mesas activas =", domElements['#activeTables'].textContent);

  if (String(domElements['#activeTables'].textContent) !== '0') {
    throw new Error(`Tras cobrar, se esperaba 0 mesas activas, pero hay ${domElements['#activeTables'].textContent}`);
  }

  // Sincronizar comanda cerrada
  await NexoSync.syncOrders();

  // Verificar en Supabase que el estado se actualizó a 'paid'
  const { data: negDataAfterPay } = await sb.from("negocios").select("*").eq("id", DEFAULT_BUSINESS_ID).maybeSingle();
  const remoteOrderAfterPay = negDataAfterPay?.configuracion?.orders?.find(o => o.id === testOrderId);
  console.log("   Estado de la orden en Supabase tras cobro:", remoteOrderAfterPay?.status);

  if (remoteOrderAfterPay?.status !== "paid") {
    throw new Error(`El estado en Supabase debió ser 'paid', pero es ${remoteOrderAfterPay?.status}`);
  }
  console.log("   ✅ Comanda cerrada reflejada exitosamente en Supabase.");

  // PRUEBA 4: Sincronización del turno de caja
  console.log("\n4. Probando sincronización del turno de caja...");
  const testShift = {
    id: `shift_${Date.now()}`,
    status: "open",
    openingCash: 75000,
    openedAt: Date.now(),
    date: "2026-10-23"
  };

  const shiftRes = await NexoSync.syncCashShift(testShift);
  console.log("   Resultado syncCashShift:", shiftRes);

  if (!shiftRes.ok) throw new Error("syncCashShift fallo");

  const { data: negDataShift } = await sb.from("negocios").select("*").eq("id", DEFAULT_BUSINESS_ID).maybeSingle();
  console.log("   cashShift en Supabase:", negDataShift?.configuracion?.cashShift?.status, "monto:", negDataShift?.configuracion?.cashShift?.openingCash);

  if (negDataShift?.configuracion?.cashShift?.status !== "open" || negDataShift?.configuracion?.cashShift?.openingCash !== 75000) {
    throw new Error("El turno de caja no se sincronizó correctamente en Supabase");
  }
  console.log("   ✅ Turno de caja abierto verificado en Supabase ('negocios').");

  // Dejar caja cerrada para pruebas limpias
  await NexoSync.syncCashShift({ status: "closed", lastClosedAt: Date.now() });
  console.log("   ✅ Turno de caja devuelto a estado 'closed'.");

  console.log("\n=== TODAS LAS PRUEBAS DE COMANDAS Y TURNOS PASARON EXITOSAMENTE ===");
  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ ERROR EN PRUEBAS:", err);
  process.exit(1);
});
