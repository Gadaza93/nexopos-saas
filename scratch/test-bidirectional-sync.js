// Test Bidirectional Sync & Force Re-Sync with Supabase using native fetch (Node 24)
const DEFAULT_BUSINESS_ID = "nexopos_default";
// Cliente Supabase simulado con RLS (sesión 'authenticated' del negocio): no toca la base real
const { createMockSupabase } = require("./mock-supabase.js");

async function runTests() {
  console.log("=== INICIANDO PRUEBAS DE FORZAR RE-SINCRONIZACIÓN Y SUBIDA DE VENTAS ===");
  const sb = createMockSupabase({ businessId: DEFAULT_BUSINESS_ID });

  // 1. Mock global
  global.window = global;
  global.supabase = { createClient: () => sb };
  global.document = {
    querySelector: () => ({
      classList: { add: () => {}, remove: () => {} },
      textContent: '',
      title: '',
      className: ''
    }),
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  global.navigator = { onLine: true };
  global.showToast = msg => console.log("   [Toast]:", msg);

  delete require.cache[require.resolve('../sync.js')];
  require('../sync.js');
  const NexoSync = global.NexoSync;

  console.log("1. Verificando funciones requeridas en NexoSync...");
  if (typeof NexoSync.syncSales !== 'function') throw new Error("syncSales no está expuesto");
  if (typeof NexoSync.pushSales !== 'function') throw new Error("pushSales no está expuesto");
  if (typeof NexoSync.forceSyncAll !== 'function') throw new Error("forceSyncAll no está expuesto");
  if (typeof NexoSync.syncCashShift !== 'function') throw new Error("syncCashShift no está expuesto");
  console.log("   ✅ Todas las funciones expuestas en NexoSync.");

  // 2. Probar que syncSales detecta ventas locales que no están en Supabase
  console.log("\n2. Probando detección y subida de ventas locales faltantes...");
  const testSaleId = `pay_diag_${Date.now()}`;
  const mockSale = {
    id: testSaleId,
    orderId: `ord_diag_${Date.now()}`,
    amount: 25000,
    method: "Nequi",
    payments: [{ method: "Nequi", amount: 25000 }],
    items: [{ productId: "p7", id: "p7", name: "Aguardiente (media)", qty: 1, price: 25000 }],
    customer: "Mesa 4 Test",
    cashierName: "Administrador",
    shiftId: "shift_test_diag",
    created_at: new Date().toISOString(),
    // Simulamos que localmente estaba marcada como synced, pero en Supabase no existe aún
    synced: false,
    sync_status: "pending"
  };

  global.state = {
    profile: { syncId: DEFAULT_BUSINESS_ID, name: "NexoPos Test" },
    cashShift: { id: "shift_test_diag", status: "open", openingCash: 95000 },
    products: [{ id: "p7", name: "Aguardiente", stock: 10, sync_status: "synced" }],
    payments: [mockSale]
  };

  const salesPushRes = await NexoSync.syncSales();
  console.log("   Resultado syncSales:", salesPushRes);
  if (!salesPushRes.ok) throw new Error("syncSales falló");
  if (mockSale.synced !== true || mockSale.sync_status !== "synced") {
    throw new Error("La venta no fue marcada como synced = true");
  }
  console.log("   ✅ Venta subida y marcada con synced = true y sync_status = 'synced'.");

  // Verificar en Supabase
  const { data: cloudSale } = await sb.from("ventas").select("*").eq("id", testSaleId).single();
  if (!cloudSale) throw new Error("La venta no se encuentra en Supabase");
  console.log("   ✅ Venta confirmada en Supabase:", cloudSale.id, "Monto:", cloudSale.total);

  // 3. Probar forceSyncAll
  console.log("\n3. Probando forceSyncAll (Forzar re-sincronización total)...");
  let shiftStatusCalled = false;
  global.renderShiftStatus = () => { shiftStatusCalled = true; };
  global.renderAll = () => {};

  const forceRes = await NexoSync.forceSyncAll();
  console.log("   Resultado forceSyncAll:", forceRes);
  if (!forceRes.ok) throw new Error("forceSyncAll falló");
  console.log("   ✅ forceSyncAll ejecutado exitosamente.");

  // Limpiar venta de prueba en Supabase
  await sb.from("ventas").delete().eq("id", testSaleId);
  console.log("   (Limpieza completada)");

  console.log("\n=== TODAS LAS PRUEBAS PASARON EXITOSAMENTE ===");
  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ ERROR EN PRUEBAS:", err);
  process.exit(1);
});
