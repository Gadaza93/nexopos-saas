// Test Dashboard Metrics Validation & Shift Force Reset
const DEFAULT_BUSINESS_ID = "nexopos_default";
// Cliente Supabase simulado con RLS (sesión 'authenticated' del negocio): no toca la base real
const { createMockSupabase } = require("./mock-supabase.js");

async function runTests() {
  console.log("=== INICIANDO PRUEBAS: VALIDACIÓN DE PEDIDOS ABIERTOS Y RESET DE CAJA ===");
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

  // PRUEBA 1: Orden huérfana vacía (0 productos) no debe sumar a mesas activas ni pedidos abiertos
  console.log("\n1. Verificando que órdenes con 0 ítems no se contabilicen como activas...");
  global.state.orders = [
    {
      id: "ord_empty_walkin",
      tableId: "walkin",
      tableName: "Venta en barra",
      status: "open",
      items: [], // 0 productos
      createdAt: Date.now()
    },
    {
      id: "ord_empty_m1",
      tableId: "m1",
      tableName: "Mesa 1",
      status: "open",
      items: [], // 0 productos
      createdAt: Date.now()
    }
  ];

  global.renderStats();
  global.renderTables();
  global.renderCustomOrders();

  console.log("   Métricas con 2 órdenes vacías (0 productos):");
  console.log("   - Mesas activas:", domElements['#activeTables'].textContent);
  console.log("   - Pedidos abiertos:", domElements['#openOrdersCount'].textContent);

  if (String(domElements['#activeTables'].textContent) !== '0') {
    throw new Error(`Se esperaba 0 mesas activas para órdenes vacías, pero se obtuvo ${domElements['#activeTables'].textContent}`);
  }
  if (String(domElements['#openOrdersCount'].textContent) !== '0') {
    throw new Error(`Se esperaba 0 pedidos abiertos para órdenes vacías, pero se obtuvo ${domElements['#openOrdersCount'].textContent}`);
  }
  console.log("   ✅ Las órdenes vacías (0 productos) fueron ignoradas correctamente en las métricas.");

  // PRUEBA 2: Cuenta personalizada con productos se muestra en "Cuentas abiertas"
  console.log("\n2. Probando cuenta personalizada o en barra con productos...");
  global.state.orders = [
    {
      id: "ord_custom_juan",
      tableId: "walkin",
      tableName: "Cuenta Juan Barra",
      isCustom: true,
      status: "open",
      items: [{ productId: "p1", name: "Cerveza", price: 10000, qty: 2 }],
      createdAt: Date.now()
    }
  ];

  global.renderStats();
  global.renderTables();
  global.renderCustomOrders();

  console.log("   Métricas con 1 cuenta personalizada en barra:");
  console.log("   - Mesas activas:", domElements['#activeTables'].textContent);
  console.log("   - Pedidos abiertos:", domElements['#openOrdersCount'].textContent);
  console.log("   - Contenido renderizado en #customOrdersList:", domElements['#customOrdersList'].innerHTML);

  if (String(domElements['#activeTables'].textContent) !== '0') {
    throw new Error(`Una cuenta de barra/personalizada no debe contar como mesa física activa. Obtuvo: ${domElements['#activeTables'].textContent}`);
  }
  if (String(domElements['#openOrdersCount'].textContent) !== '1') {
    throw new Error(`Se esperaba 1 pedido abierto en total, pero se obtuvo ${domElements['#openOrdersCount'].textContent}`);
  }
  if (!domElements['#customOrdersList'].innerHTML.includes("Cuenta Juan Barra") || !domElements['#customOrdersList'].innerHTML.includes("Cobrar")) {
    throw new Error("La cuenta personalizada no se renderizó con sus opciones en #customOrdersList");
  }
  console.log("   ✅ La cuenta personalizada se visualiza claramente en 'Cuentas abiertas' con acciones.");

  // PRUEBA 3: Mesa física activa
  console.log("\n3. Probando mesa física (Mesa 1) con productos...");
  global.state.orders.push({
    id: "ord_m1",
    tableId: "m1",
    tableName: "Mesa 1",
    isCustom: false,
    status: "open",
    items: [{ productId: "p2", name: "Coctel Margarita", price: 25000, qty: 1 }],
    createdAt: Date.now()
  });

  global.renderStats();
  global.renderTables();

  console.log("   Métricas con 1 mesa física y 1 cuenta personalizada:");
  console.log("   - Mesas activas:", domElements['#activeTables'].textContent);
  console.log("   - Pedidos abiertos:", domElements['#openOrdersCount'].textContent);

  if (String(domElements['#activeTables'].textContent) !== '1') {
    throw new Error(`Se esperaba 1 mesa activa física, pero se obtuvo ${domElements['#activeTables'].textContent}`);
  }
  if (String(domElements['#openOrdersCount'].textContent) !== '2') {
    throw new Error(`Se esperaba 2 pedidos abiertos en total, pero se obtuvo ${domElements['#openOrdersCount'].textContent}`);
  }
  console.log("   ✅ Mesas físicas y cuentas personalizadas discriminadas exactamente.");

  // PRUEBA 4: Forzar cierre de turno de caja y reiniciar saldo a $0
  console.log("\n4. Probando forzar cierre de turno y reiniciar saldo a $0...");
  global.state.cashShift = {
    id: "shift_stale_70k",
    status: "open",
    openingCash: 70000,
    date: "2026-10-23"
  };

  global.renderStats();
  console.log("   Saldo antes del reset:", domElements['#cashExpected'].textContent);

  // Ejecutar forceResetShift
  await global.forceResetShift();

  global.renderStats();
  console.log("   Estado de cashShift tras reset:", global.state.cashShift.status);
  console.log("   Saldo en pantalla tras reset:", domElements['#cashExpected'].textContent);

  if (global.state.cashShift.status !== "closed") {
    throw new Error("El turno de caja no quedó cerrado tras forceResetShift");
  }
  if (domElements['#cashExpected'].textContent !== "Caja cerrada") {
    throw new Error(`Se esperaba 'Caja cerrada', pero se obtuvo ${domElements['#cashExpected'].textContent}`);
  }
  console.log("   ✅ Turno de caja forzado a cerrado y saldo reiniciado a $0.");

  // PRUEBA 5: Sincronizar hacia Supabase para limpiar órdenes huérfanas en la nube
  console.log("\n5. Limpiando y sincronizando estado limpio con Supabase...");
  // Dejar únicamente la mesa 1 o lista vacía
  global.state.orders = [];
  await NexoSync.syncOrders();
  await NexoSync.syncCashShift({ status: "closed", lastClosedAt: Date.now() });

  // Consultar Supabase directamente
  const { data: negClean } = await sb.from("negocios").select("*").eq("id", DEFAULT_BUSINESS_ID).maybeSingle();
  const cloudOrders = negClean?.configuracion?.orders || [];
  const cloudShift = negClean?.configuracion?.cashShift;

  console.log("   Órdenes en Supabase tras limpieza:", cloudOrders.length);
  console.log("   cashShift en Supabase tras limpieza:", cloudShift?.status);

  if (cloudOrders.length > 0 && cloudOrders.some(o => o.items.length === 0)) {
    throw new Error("Aún quedan órdenes vacías en Supabase");
  }
  if (cloudShift?.status !== "closed") {
    throw new Error("El turno de caja en Supabase no quedó cerrado");
  }
  console.log("   ✅ Base de datos en Supabase purgada y sincronizada limpiamente.");

  console.log("\n=== TODAS LAS PRUEBAS PASARON EXITOSAMENTE ===");
  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ ERROR EN PRUEBAS:", err);
  process.exit(1);
});
