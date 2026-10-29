// Test Turnos de Caja and Pedidos Activos with Supabase
const DEFAULT_BUSINESS_ID = "nexopos_default";
// Cliente Supabase simulado con RLS (sesión 'authenticated' del negocio): no toca la base real
const { createMockSupabase } = require("./mock-supabase.js");

async function runTests() {
  console.log("=== INICIANDO PRUEBAS: TURNOS DE CAJA Y PEDIDOS ACTIVOS EN SUPABASE ===");
  global.__IS_NODE_TEST__ = true;
  const sb = createMockSupabase({ businessId: DEFAULT_BUSINESS_ID });

  // 1. Mock DOM
  global.window = global;
  global.window.confirm = () => true;
  global.supabase = { createClient: () => sb };
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
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    addEventListener: () => {},
    showModal: () => {},
    close: () => {},
    ...props
  });

  const domElements = {
    '#todayLabel': createMockElement({ textContent: '' }),
    '#shiftStatusButton': createMockElement({ textContent: '' }),
    '#salesToday': createMockElement({ textContent: '' }),
    '#salesCount': createMockElement({ textContent: '' }),
    '#activeTables': createMockElement({ textContent: '0' }),
    '#activeItems': createMockElement({ textContent: '0 bebidas y snacks' }),
    '#openOrdersCount': createMockElement({ textContent: '0' }),
    '#cashExpected': createMockElement({ textContent: 'Caja cerrada' }),
    '#tableGrid': createMockElement({ innerHTML: '' }),
    '#customOrdersList': createMockElement({ innerHTML: '' }),
    '#closeDialog': createMockElement(),
    '#openShiftDialog': createMockElement(),
    '#orderDialog': createMockElement(),
    '#paymentDialog': createMockElement(),
    '#openingCash': createMockElement({ value: '80000' }),
    '#productsTable': createMockElement({ innerHTML: '' }),
    '#inventoryTable': createMockElement({ innerHTML: '' }),
    '#inventorySummary': createMockElement({ innerHTML: '' }),
    '#productGrid': createMockElement({ innerHTML: '' }),
    '#ticketItems': createMockElement({ innerHTML: '' }),
    '#orderTotal': createMockElement({ textContent: '' }),
    '#deleteOrderButton': createMockElement(),
    '#paidNote': createMockElement({ hidden: true }),
    '#categoryTabs': createMockElement({ innerHTML: '' }),
    '#orderZone': createMockElement({ textContent: '' }),
    '#orderTitle': createMockElement({ textContent: '' }),
    '#orderNote': createMockElement(),
    '#expectedCashInClose': createMockElement({ textContent: '$0' }),
    '#countedCash': createMockElement({ value: '0' }),
    '#closeSummary': createMockElement({ innerHTML: '' }),
    '#cashDifference': createMockElement({ textContent: '', className: '' })
  };

  global.document = {
    querySelector: (sel) => {
      if (!domElements[sel]) {
        domElements[sel] = createMockElement();
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
  // Desactivar debounce timers automáticos durante las pruebas para evitar carreras asíncronas
  if (NexoSync) {
    NexoSync.scheduleSync = () => {};
  }

  // PRUEBA 1: Limpieza de pedidos huérfanos / vacíos
  console.log("\n1. Probando cleanupOrphanOrders() y eliminación de órdenes huérfanas / vacías...");
  global.state.orders = [
    { id: "ord_empty_1", tableId: "m1", tableName: "Mesa 1", isCustom: false, items: [], status: "open" },
    { id: "ord_orphan_table", tableId: "m999", tableName: "Mesa Inexistente", isCustom: false, items: [{ productId: "p1", qty: 2, price: 10000 }], status: "open" },
    { id: "ord_valid_m1", tableId: "m1", tableName: "Mesa 1", isCustom: false, items: [{ productId: "p1", qty: 1, price: 15000 }], status: "open" },
    { id: "ord_valid_custom", tableId: "walkin", tableName: "Venta en barra", isCustom: false, items: [{ productId: "p2", qty: 3, price: 8000 }], status: "open" }
  ];

  console.log("   Órdenes antes de cleanupOrphanOrders():", global.state.orders.length);
  global.cleanupOrphanOrders();
  console.log("   Órdenes después de cleanupOrphanOrders():", global.state.orders.length);
  global.renderStats();
  console.log("   - Mesas activas:", domElements['#activeTables'].textContent);
  console.log("   - Pedidos abiertos:", domElements['#openOrdersCount'].textContent);

  if (global.state.orders.length !== 2) {
    throw new Error(`Se esperaban 2 órdenes válidas tras el cleanup, pero hay ${global.state.orders.length}`);
  }
  if (String(domElements['#activeTables'].textContent) !== '1') {
    throw new Error(`Se esperaba 1 mesa activa física (Mesa 1), pero hay ${domElements['#activeTables'].textContent}`);
  }
  if (String(domElements['#openOrdersCount'].textContent) !== '2') {
    throw new Error(`Se esperaban 2 pedidos abiertos en total, pero hay ${domElements['#openOrdersCount'].textContent}`);
  }
  console.log("   ✅ Órdenes vacías y huérfanas eliminadas exitosamente.");

  // PRUEBA 2: Sincronización de Apertura y Cierre de Caja con turnos_caja
  console.log("\n2. Probando sincronización de apertura y cierre de caja con 'turnos_caja' en Supabase...");
  // Limpieza inicial de turnos abiertos residuales en Supabase
  await sb.from("turnos_caja").update({ estado: "cerrado" }).eq("business_id", DEFAULT_BUSINESS_ID).eq("estado", "abierto");
  await sb.from("pedidos_activos").delete().eq("business_id", DEFAULT_BUSINESS_ID);

  // Abrir turno
  const testShiftId = `shift_${Date.now()}`;
  global.state.cashShift = {
    id: testShiftId,
    status: "open",
    date: global.today(),
    openedAt: Date.now(),
    openingCash: 80000
  };
  global.renderShiftStatus();
  global.renderStats();

  console.log("   Sincronizando apertura con Supabase...");
  const syncOpenRes = await NexoSync.syncCashShift(global.state.cashShift);
  if (!syncOpenRes.ok) throw new Error("Error en syncCashShift al abrir: " + syncOpenRes.error);

  // Verificar en Supabase tabla turnos_caja
  const expectedShiftUuid = NexoSync.toValidUuid(testShiftId);
  const { data: openShiftRows, error: openShiftErr } = await sb
    .from("turnos_caja")
    .select("*")
    .eq("business_id", DEFAULT_BUSINESS_ID)
    .eq("estado", "abierto");

  if (openShiftErr) throw new Error("Error al consultar turnos_caja en Supabase: " + openShiftErr.message);
  console.log("   Turnos abiertos en turnos_caja de Supabase:", openShiftRows?.length);
  const foundOpen = (openShiftRows || []).find(r => r.id === expectedShiftUuid);
  if (!foundOpen) {
    throw new Error(`No se encontró el turno con UUID ${expectedShiftUuid} en turnos_caja de Supabase.`);
  }
  if (Number(foundOpen.monto_apertura) !== 80000) {
    throw new Error(`El monto de apertura en Supabase no coincide. Esperado: 80000, recibido: ${foundOpen.monto_apertura}`);
  }
  console.log("   ✅ Turno de caja abierto verificado en Supabase ('turnos_caja'): estado 'abierto', monto $80.000.");

  // Cerrar turno forzadamente
  console.log("   Ejecutando forceResetShift() / cierre forzado...");
  await global.forceResetShift();

  console.log("   Estado de cashShift tras reset:", JSON.stringify(global.state.cashShift));
  if (global.state.cashShift.status !== "closed") {
    throw new Error("El estado local de cashShift debería ser 'closed'.");
  }
  if (global.expectedCash() !== 0) {
    throw new Error(`El saldo esperado debería ser $0 con caja cerrada, pero es ${global.expectedCash()}`);
  }

  // Verificar en Supabase que el turno ahora esté cerrado
  const { data: closedShiftRows, error: closedShiftErr } = await sb
    .from("turnos_caja")
    .select("*")
    .eq("business_id", DEFAULT_BUSINESS_ID)
    .eq("id", expectedShiftUuid);

  if (closedShiftErr) throw new Error("Error consultando turno cerrado: " + closedShiftErr.message);
  if (closedShiftRows[0]?.estado !== "cerrado") {
    throw new Error(`El estado del turno en Supabase debería ser 'cerrado', pero es ${closedShiftRows[0]?.estado}`);
  }
  console.log("   ✅ Turno de caja cerrado verificado en Supabase ('turnos_caja'): estado 'cerrado', saldo $0.");

  // PRUEBA 3: Sincronización de Pedidos Activos con pedidos_activos
  console.log("\n3. Probando replicación de pedidos activos en 'pedidos_activos' de Supabase...");
  // Limpiar cualquier orden previa en Supabase para aislamiento del test
  await sb.from("pedidos_activos").delete().eq("business_id", DEFAULT_BUSINESS_ID);
  global.state.orders = [];
  await NexoSync.syncOrders();

  const testOrderId = `ord_test_${Date.now()}`;
  const testOrderUuid = NexoSync.toValidUuid(testOrderId);
  const testActiveOrder = {
    id: testOrderId,
    tableId: "m2",
    tableName: "Mesa 2",
    isCustom: false,
    items: [
      { productId: "p_corona", name: "Corona", price: 12000, qty: 2 }
    ],
    status: "open",
    createdAt: Date.now(),
    sync_status: "pending"
  };

  global.state.orders = [testActiveOrder];
  console.log("   Ejecutando syncOrders()...");
  const syncOrderRes = await NexoSync.syncOrders();
  if (!syncOrderRes.ok) throw new Error("Error en syncOrders: " + syncOrderRes.error);

  // Verificar en Supabase tabla pedidos_activos
  const { data: activeRows, error: actErr } = await sb
    .from("pedidos_activos")
    .select("*")
    .eq("business_id", DEFAULT_BUSINESS_ID)
    .eq("id", testOrderUuid);

  if (actErr) throw new Error("Error consultando pedidos_activos en Supabase: " + actErr.message);
  if (!activeRows || activeRows.length === 0) {
    throw new Error(`No se encontró la orden activa con UUID ${testOrderUuid} en pedidos_activos.`);
  }
  console.log("   Orden encontrada en pedidos_activos:", activeRows[0].nombre_mesa, "Total:", activeRows[0].total);
  if (Number(activeRows[0].total) !== 24000) {
    throw new Error(`Total esperado: 24000, recibido: ${activeRows[0].total}`);
  }
  console.log("   ✅ Pedido activo verificado en Supabase ('pedidos_activos').");

  // Modificar orden (agregar producto)
  console.log("   Modificando orden (agregando 1 Gin Tonic por $20.000)...");
  testActiveOrder.items.push({ productId: "p_gin", name: "Gin Tonic", price: 20000, qty: 1 });
  await NexoSync.syncOrders();

  const { data: updatedRows } = await sb
    .from("pedidos_activos")
    .select("*")
    .eq("business_id", DEFAULT_BUSINESS_ID)
    .eq("id", testOrderUuid);

  if (Number(updatedRows[0].total) !== 44000) {
    throw new Error(`Total tras modificación esperado: 44000, recibido: ${updatedRows[0].total}`);
  }
  console.log("   ✅ Modificación de ítems y total reflejada en Supabase ('pedidos_activos'): $44.000.");

  // Descarga en segundo dispositivo
  console.log("   Simulando descarga (pullAllFromSupabase) en un segundo dispositivo...");
  const dev2State = { orders: [], tables: global.state.tables, cashShift: { status: 'closed' } };
  const prevOrders = global.state.orders;
  global.state.orders = []; // Simular dispositivo vacío
  global.renderStats();
  console.log("   Métricas en dispositivo 2 antes de pull: Mesas =", domElements['#activeTables'].textContent);

  await NexoSync.pullAllFromSupabase();
  global.renderStats();
  console.log("   Métricas en dispositivo 2 después de pull: Mesas =", domElements['#activeTables'].textContent, "Pedidos =", domElements['#openOrdersCount'].textContent);
  if (String(domElements['#activeTables'].textContent) !== '1') {
    throw new Error(`Se esperaba 1 mesa activa en dispositivo 2 tras pull, pero hay ${domElements['#activeTables'].textContent}`);
  }
  console.log("   ✅ Dispositivo 2 descargó el pedido activo de Supabase y actualizó el Dashboard.");

  // Cobrar / cancelar orden y verificar que se elimine de pedidos_activos
  console.log("   Cobrando/eliminando pedido activo...");
  await NexoSync.deleteActiveOrder(testOrderId);

  const { data: deletedRows } = await sb
    .from("pedidos_activos")
    .select("*")
    .eq("business_id", DEFAULT_BUSINESS_ID)
    .eq("id", testOrderUuid);

  if (deletedRows && deletedRows.length > 0) {
    throw new Error("El pedido activo no fue eliminado de pedidos_activos tras cobrar/eliminar.");
  }
  console.log("   ✅ Pedido cobrado eliminado inmediatamente de la tabla 'pedidos_activos'.");

  // Limpieza final
  global.state.orders = [];
  await NexoSync.syncOrders();
  global.cleanupOrphanOrders();
  global.renderStats();

  console.log("\n=== TODAS LAS PRUEBAS DE TURNOS_CAJA Y PEDIDOS_ACTIVOS PASARON EXITOSAMENTE ===");
  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ ERROR EN PRUEBAS:", err);
  process.exit(1);
});
