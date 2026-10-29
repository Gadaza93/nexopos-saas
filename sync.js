// Motor de sincronización NexoPos
// Proyecto de Supabase de NexoPos («Nexopos-saas»; esquema en supabase/migrations). Nunca el de NexoBar.
// La clave publicable va en el cliente a propósito: la seguridad la dan las políticas RLS.
// Las pruebas lo cambian por uno ficticio con globalThis.NEXO_SUPABASE_URL / NEXO_SUPABASE_ANON_KEY (scratch/setup-pruebas.js).
const SUPABASE_URL = globalThis.NEXO_SUPABASE_URL || "https://voesyutyotonbktndrum.supabase.co";
const SUPABASE_ANON_KEY = globalThis.NEXO_SUPABASE_ANON_KEY || "sb_publishable_FCYyjpjy8SOBzQkEcYAfjA_N6hzP3bh";
const DEFAULT_BUSINESS_ID = "nexopos_default";

let syncClient = null;
let isSyncing = false;
let syncDebounceTimer = null;
let pingTimer = null;
let realtimeChannel = null;
let deletedProductIds = [];
let deletedSaleIds = [];

function loadDeletedIds() {
  try {
    const rawProd = typeof localStorage !== "undefined" ? localStorage.getItem("nexopos_deleted_products") : null;
    if (rawProd) deletedProductIds = JSON.parse(rawProd);
    const rawSale = typeof localStorage !== "undefined" ? localStorage.getItem("nexopos_deleted_sales") : null;
    if (rawSale) deletedSaleIds = JSON.parse(rawSale);
  } catch (e) {
    /* ignore */
  }
}

function saveDeletedIds() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("nexopos_deleted_products", JSON.stringify(deletedProductIds));
      localStorage.setItem("nexopos_deleted_sales", JSON.stringify(deletedSaleIds));
    }
  } catch (e) {
    /* ignore */
  }
}

loadDeletedIds();

function isPendingSync(item) {
  if (!item) return false;
  return item.sync_status === "nuevo_local" || item.sync_status === "pending";
}

// Modo Demo Local (Sandbox): isDemoMode() vive en demo-mode.js; en Node (pruebas) se carga aquí.
if (typeof module !== "undefined" && typeof globalThis.isDemoMode !== "function") require("./demo-mode.js");

const syncState = {
  status: "offline",
  online: (typeof navigator !== "undefined" && navigator.onLine === false) ? false : true,
  lastSyncAt: null,
  pendingCount: 0,
  lastError: null
};

// 0. Helper UUID RFC4122 v4 determinista
function toValidUuid(str) {
  if (!str) return null;
  const s = String(str).trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(s)) return s.toLowerCase();

  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i !== s.length; i = i + 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822507);
    h4 = Math.imul(h4 ^ ch, 3266489909);
  }
  const toHex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  const hex = toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
  const p1 = hex.slice(0, 8);
  const p2 = hex.slice(8, 12);
  const p3 = "4" + hex.slice(13, 16);
  const p4 = "a" + hex.slice(17, 20);
  const p5 = hex.slice(20, 32);
  return (p1 + "-" + p2 + "-" + p3 + "-" + p4 + "-" + p5).toLowerCase();
}

// 1. Helper de fechas ISO 8601
function toIsoDate(val) {
  if (val === null || val === undefined || val === "") {
    return new Date().toISOString();
  }
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? new Date().toISOString() : val.toISOString();
  }
  if (typeof val === "number") {
    const num = Math.floor(val);
    const ms = String(num).length === 10 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d{10,15}$/.test(trimmed)) {
      const num = Number(trimmed);
      const ms = trimmed.length === 10 ? num * 1000 : num;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return `${trimmed}T12:00:00.000Z`;
    }
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  const fallback = Number(val);
  return new Date(Number.isNaN(fallback) || !fallback ? Date.now() : fallback).toISOString();
}

const toValidISOString = toIsoDate;

function getBusinessId() {
  try {
    // Terminal vinculada: su negocio manda siempre (el ID de «Mi negocio» queda bloqueado y no puede desviarlo)
    if (typeof state !== "undefined" && state?.terminal?.businessId && !isDemoMode()) {
      const linked = String(state.terminal.businessId).trim();
      if (linked) return linked;
    }
    if (typeof state !== "undefined" && state?.profile?.syncId) {
      const id = String(state.profile.syncId).trim();
      if (id) return id;
    }
    if (typeof state !== "undefined" && state?.profile?.nit) {
      const cleanNit = String(state.profile.nit).replace(/\D/g, "");
      if (cleanNit) return `bar_${cleanNit}`;
    }
  } catch (e) {
    /* ignore */
  }
  return DEFAULT_BUSINESS_ID;
}

// supabase-js va empaquetado en el proyecto (supabase.min.js, versión fija; ver CLAUDE.md), ya no desde un CDN:
// la CSP solo permite scripts propios. Si por algo no cargó, se reintenta desde el mismo archivo local.
const SUPABASE_LIB_URL = "./supabase.min.js";
let supabaseLibLoading = null;

function hasSupabaseLib() {
  const sb = (typeof window !== "undefined" && window.supabase) || (typeof globalThis !== "undefined" && globalThis.supabase);
  return Boolean(sb && typeof sb.createClient === "function");
}

function loadSupabaseLib() {
  if (hasSupabaseLib()) return Promise.resolve(true);
  if (typeof document === "undefined" || typeof document.createElement !== "function" || !document.head) return Promise.resolve(false);
  if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve(false);
  if (!supabaseLibLoading) {
    supabaseLibLoading = new Promise(resolve => {
      const script = document.createElement("script");
      script.src = SUPABASE_LIB_URL;
      script.async = true;
      script.onload = () => resolve(hasSupabaseLib());
      script.onerror = () => { script.remove(); resolve(false); };
      document.head.appendChild(script);
    }).then(ok => { supabaseLibLoading = null; return ok; });
  }
  return supabaseLibLoading;
}

function getClient() {
  if (isDemoMode()) return null;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (syncClient) return syncClient;
  try {
    const sbFactory = (typeof window !== "undefined" && window.supabase) || (typeof globalThis !== "undefined" && globalThis.supabase);
    if (sbFactory && typeof sbFactory.createClient === "function") {
      syncClient = sbFactory.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        // La sesión de la terminal persiste (storage.js) y se renueva sola: tras recargar, las consultas
        // siguen como 'authenticated' y el RLS filtra por app_metadata.business_id.
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storageKey: globalThis.AUTH_STORAGE_KEY || "nexopos-auth",
          ...(globalThis.authStorage ? { storage: globalThis.authStorage } : {})
        }
      });
    }
  } catch (err) {
    console.warn("[NexoSync] Error al crear cliente Supabase:", err);
    syncClient = null;
  }
  return syncClient;
}

// Activación de terminal: valida las credenciales maestras en Supabase Auth y devuelve el negocio vinculado.
// El business_id se lee SOLO de app_metadata (lo asigna el servidor); user_metadata lo puede editar el propio usuario.
async function activateTerminal(email, password) {
  if (isDemoMode()) return { ok: false, error: "El Modo Demo no se vincula a ningún negocio." };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, error: "Necesitas conexión a internet para vincular esta caja." };
  }
  if (!hasSupabaseLib()) await loadSupabaseLib();
  const sb = getClient();
  if (!sb || !sb.auth) return { ok: false, error: "No se pudo conectar con el servidor de NexoPos. Revisa tu conexión." };
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      const invalid = /invalid|credentials/i.test(error.message || "");
      return { ok: false, error: invalid ? "Correo o contraseña incorrectos." : `No se pudo vincular: ${error.message}` };
    }
    const user = data?.user;
    const bId = String(user?.app_metadata?.business_id || "").trim();
    if (!bId) return { ok: false, error: "Esta cuenta no tiene un negocio asignado. Contacta a soporte NexoPos." };
    // Cuenta nueva con contraseña temporal: la app pide la definitiva antes de vincular (el RLS no le da datos mientras tanto)
    return { ok: true, businessId: bId, email: user.email || email, mustChangePassword: user.app_metadata?.must_change_password === true };
  } catch (err) {
    console.warn("[NexoSync] Error al activar terminal:", err);
    return { ok: false, error: "No se pudo conectar con el servidor de NexoPos. Intenta de nuevo." };
  }
}

// Recuperación de la contraseña maestra (Edge Function recuperar-acceso, pública): pedir el código por correo y
// confirmarlo con la contraseña nueva. La función responde { ok, mensaje | error } también en los errores de negocio.
const RECUPERACION_SIN_CONEXION = "No se pudo conectar con el servidor de NexoPos. Revisa tu conexión e intenta de nuevo.";
async function recuperarAcceso(body) {
  if (isDemoMode()) return { ok: false, error: "El Modo Demo no tiene cuenta que recuperar." };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, error: "Necesitas conexión a internet para recuperar el acceso." };
  if (!hasSupabaseLib()) await loadSupabaseLib();
  const sb = getClient();
  if (!sb || !sb.functions) return { ok: false, error: RECUPERACION_SIN_CONEXION };
  try {
    const { data, error } = await sb.functions.invoke("recuperar-acceso", { body });
    if (data && typeof data === "object" && "ok" in data) return data;
    // Respuesta 500 de la función: el mensaje viene en el cuerpo
    const cuerpo = error?.context && typeof error.context.json === "function" ? await error.context.json().catch(() => null) : null;
    if (cuerpo && typeof cuerpo === "object" && "ok" in cuerpo) return cuerpo;
    return { ok: false, error: RECUPERACION_SIN_CONEXION };
  } catch (err) {
    console.warn("[NexoSync] Error en recuperar-acceso:", err);
    return { ok: false, error: RECUPERACION_SIN_CONEXION };
  }
}
// Contraseña temporal → definitiva: la cambia el propio usuario y marcar_contrasena_cambiada quita la marca. Luego se
// renueva la sesión, porque el token anterior todavía trae la marca y con ella get_business_id() no da ningún negocio.
async function changeTemporaryPassword(password) {
  if (isDemoMode()) return { ok: false, error: "El Modo Demo no tiene cuenta." };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, error: "Necesitas conexión a internet para crear tu contraseña." };
  const sb = getClient();
  if (!sb || !sb.auth) return { ok: false, error: RECUPERACION_SIN_CONEXION };
  try {
    const { error } = await sb.auth.updateUser({ password });
    // «debe ser distinta»: la app ya verificó que no es la temporal, así que es un reintento con la contraseña ya cambiada
    if (error && !/different|same/i.test(error.message || "")) {
      return { ok: false, error: /weak|short|characters|password/i.test(error.message || "") ? "Elige una contraseña más segura (letras y números, al menos 8 caracteres)." : `No se pudo cambiar la contraseña: ${error.message}` };
    }
    const { error: rpcError } = await sb.rpc("marcar_contrasena_cambiada");
    if (rpcError) return { ok: false, error: "La contraseña cambió, pero no se pudo confirmar en el servidor. Toca de nuevo «Guardar contraseña»." };
    const { data, error: refreshError } = await sb.auth.refreshSession();
    if (refreshError || !data?.session || data.session.user?.app_metadata?.must_change_password === true) {
      return { ok: false, error: "No se pudo renovar la sesión. Toca de nuevo «Guardar contraseña»." };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[NexoSync] Error al cambiar la contraseña temporal:", err);
    return { ok: false, error: RECUPERACION_SIN_CONEXION };
  }
}

const requestRecoveryCode = email => recuperarAcceso({ accion: "solicitar", email });
const confirmRecoveryCode = (email, codigo, password) => recuperarAcceso({ accion: "confirmar", email, codigo, password });

// ¿Hay sesión de Supabase Auth? Sin ella las consultas irían como 'anon': con RLS estricto el servidor
// devolvería listas vacías sin error y la descarga borraría el catálogo local. Por eso no se sincroniza.
async function hasAuthSession(sb = getClient()) {
  if (!sb || !sb.auth || typeof sb.auth.getSession !== "function") return false;
  try {
    const { data } = await sb.auth.getSession();
    // Con la contraseña temporal sin cambiar, el RLS devolvería listas vacías: como sin sesión, no se sincroniza
    return Boolean(data?.session) && data.session.user?.app_metadata?.must_change_password !== true;
  } catch (err) {
    return false;
  }
}

// Cierra la sesión solo en este equipo (no afecta otras cajas del mismo negocio).
async function signOutTerminal() {
  const sb = getClient();
  if (!sb || !sb.auth) return;
  try { await sb.auth.signOut({ scope: "local" }); } catch (err) { /* sin conexión: el token se descarta igual */ }
}

// Hora del servidor (función hora_servidor): base del reloj de la licencia (licenseClock en app.js).
// Sin la función (SQL sin aplicar) o con error devuelve null y la licencia sigue como antes.
async function fetchServerTime(sb) {
  try {
    const { data, error } = await sb.rpc("hora_servidor");
    const t = !error && data ? Date.parse(data) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch (err) {
    return null;
  }
}

// Licencia leída de la fila de negocios (activo, plan, fecha_vencimiento). Se guarda en el estado para
// que el bloqueo y los avisos sigan aunque la caja reinicie sin internet; solo una descarga la actualiza.
// Las columnas ausentes no cambian lo guardado.
function applySubscriptionStatus(negocio) {
  if (!negocio || typeof negocio !== "object" || typeof state === "undefined" || !state) return;
  const prev = state.subscription || {}, next = { ...prev };
  if (typeof negocio.activo === "boolean") next.active = negocio.activo;
  if (typeof negocio.plan === "string") next.plan = negocio.plan;
  if ("fecha_vencimiento" in negocio) next.expiresAt = negocio.fecha_vencimiento || null;
  if (next.active === prev.active && next.plan === prev.plan && next.expiresAt === prev.expiresAt) return;
  state.subscription = { ...next, checkedAt: Date.now() };
  if (typeof scheduleSave === "function") scheduleSave();
  if (typeof enforceSubscription === "function") {
    try { enforceSubscription(); } catch (e) { /* ignore */ }
  }
  if (typeof renderSubscription === "function") {
    try { renderSubscription(); } catch (e) { /* ignore */ }
  }
  // Cambio de plan (Básico / Pro): candados, vista de mesas y usuario en sesión (planes.js)
  if (next.plan !== prev.plan && typeof enforcePlanSession === "function") {
    try { enforcePlanSession(); } catch (e) { /* ignore */ }
  }
}

// 2. Sanitizadores previos antes de cada upsert
function sanitizeProducto(p, bId) {
  const inv = (typeof state !== "undefined" && state?.inventory?.find(i => i.id === p.inventoryId || i.id === `stock-${p.id}`)) || {};
  const currentStock = Number((p.stock != null ? p.stock : inv.qty) ?? 0);
  return {
    id: String(p.id || `prod_${Date.now()}`),
    business_id: String(bId || DEFAULT_BUSINESS_ID),
    nombre: p.name || p.nombre || "Producto",
    categoria: p.category || p.categoria || "Otros",
    precio: Number(p.price ?? p.precio ?? 0),
    costo: Number(p.cost ?? p.costo ?? 0),
    stock: currentStock,
    min_stock: Number(inv.min ?? p.min_stock ?? 5),
    activo: p.active !== false && p.activo !== false,
    // Plato preparado: sin stock propio (se descuentan sus insumos); la receta viaja con el producto
    tipo: p.tipo === "preparado" ? "preparado" : "reventa",
    receta: p.tipo === "preparado" && Array.isArray(p.receta) ? p.receta : null,
    created_at: toIsoDate(p.createdAt || p.created_at || Date.now()),
    updated_at: toIsoDate(p.updated_at || p.updatedAt || Date.now())
  };
}

/* ---------- Stock por movimientos (movimientos_stock + trigger ventas_stock en Supabase) ----------
   La nube suma y resta: las ventas las descuenta su trigger y todo lo demás (compras, mermas, ajustes, conteos, ficha
   del producto, importación, devolver stock al borrar una factura) sube como un movimiento con la diferencia. Cada
   producto guarda stockSynced: el stock que la nube ya conoce. Lo hecho en esta caja y aún no subido es
   stock local − stockSynced + lo vendido en ventas sin subir − movimientos sin subir; esa diferencia es el próximo
   movimiento, así ningún cambio local se pierde aunque la ruta que lo hizo no sepa de la nube. Un producto sin
   stockSynced (nuevo, o la primera vez en este modo) sube su stock absoluto una sola vez. Sin la tabla (SQL sin
   aplicar) se usa el modo anterior: el stock absoluto de cada producto. Prueba: scratch/test-stock-movimientos.js */
let stockMode = null;   // true: movimientos · false: stock absoluto (modo anterior) · null: sin decidir
let stockUploads = 0;   // subidas de ventas o movimientos en curso: mientras tanto el stock remoto no se aplica
const roundQty = n => Math.round(Number(n || 0) * 1000) / 1000;
async function usaStockMovimientos(sb) {
  if (stockMode !== null || !sb) return stockMode === true;
  try {
    const { error } = await sb.from("movimientos_stock").select("id").limit(1);
    if (!error) stockMode = true;
    else if (/movimientos_stock|relation|does not exist|schema cache/i.test(error.message || "")) stockMode = false;
    // Otro error (p. ej. sin red): no se decide todavía
  } catch (e) {
    stockMode = false;
  }
  return stockMode === true;
}
function stockSupply(p) {
  if (!p || typeof state === "undefined" || !Array.isArray(state?.inventory)) return null;
  const invId = p.inventoryId || `stock-${p.id}`;
  return state.inventory.find(i => i.id === invId) || null;
}
// Existencias locales: manda el insumo de inventario (el conteo físico y la ficha del producto solo cambian el insumo)
function localStock(p) {
  const inv = stockSupply(p), v = Number(inv ? inv.qty : p?.stock);
  return Number.isFinite(v) ? v : 0;
}
function setLocalStock(p, value) {
  p.stock = value;
  const inv = stockSupply(p);
  if (inv) inv.qty = value;
}
// Cantidades por producto de unos ítems: misma regla que ventas_cantidades en Supabase (productId o id)
function stockItemsQty(items) {
  const out = {};
  (Array.isArray(items) ? items : []).forEach(it => {
    const id = it && (it.productId || it.id), q = Number(it?.qty);
    if (it?.tipo === "preparado") return;
    if (id && Number.isFinite(q) && q) out[String(id)] = roundQty((out[String(id)] || 0) + q);
  });
  return out;
}
// Lo que la nube aún debe descontar por esta venta. Ventas sin subir de antes de este modo: sus ítems.
function saleStockEffect(sale) {
  if (sale?.pendingStock) return sale.pendingStock;
  return isPendingSync(sale) && !sale?.editedAt ? stockItemsQty(sale.items) : {};
}
// Factura editada: suma la diferencia de cantidades (vendido de más → positivo) a lo que la nube debe descontar
function addSaleStockDelta(sale, productId, soldDelta) {
  if (!sale || !productId || !soldDelta) return;
  const pending = { ...saleStockEffect(sale) }, id = String(productId);
  pending[id] = roundQty((pending[id] || 0) + soldDelta);
  if (!pending[id]) delete pending[id];
  sale.pendingStock = pending;
}
function pendingSoldByProduct() {
  const sold = new Map();
  ((typeof state !== "undefined" && state?.payments) || []).forEach(s => {
    if (!isPendingSync(s)) return;
    Object.entries(saleStockEffect(s)).forEach(([id, q]) => sold.set(id, roundQty((sold.get(id) || 0) + q)));
  });
  return sold;
}
const productById = id => ((typeof state !== "undefined" && state?.products) || []).find(p => String(p.id) === String(id));
// La venta llegó a la nube: su trigger ya descontó, así que la base del producto baja lo mismo
function markSaleUploaded(sale) {
  if (stockMode === true) {
    Object.entries(saleStockEffect(sale)).forEach(([id, q]) => {
      const p = productById(id);
      if (p && Number.isFinite(p.stockSynced)) p.stockSynced = roundQty(p.stockSynced - q);
    });
  }
  delete sale.pendingStock;
  sale.sync_status = "synced";
  sale.synced = true;
}
// Stock que llega de la nube (descarga o tiempo real). Con base conocida, el local se mueve lo mismo que cambió la
// nube (conserva lo hecho aquí y aún no subido); sin base, gana la nube como antes.
function remoteStock(p, cloud) {
  if (!p || !(stockMode === true || Number.isFinite(p.stockSynced))) return cloud;
  if (stockUploads > 0) return localStock(p); // la nube podría traer ya aplicada la subida en curso: la próxima descarga lo corrige
  if (!Number.isFinite(p.stockSynced)) { p.stockSynced = cloud; return cloud; }
  const next = roundQty(localStock(p) + cloud - p.stockSynced);
  p.stockSynced = cloud;
  return next;
}
// Producto de la nube: si es un plato preparado se queda sin stock propio ni artículo de inventario (si no,
// getPOSProducts lo duplicaría). Una receta editada aquí y aún no subida no se pisa. Devuelve true si es preparado.
function aplicarRecetaRemota(prod, row) {
  if (!prod || !row) return false;
  if (isPendingSync(prod)) return prod.tipo === "preparado";
  if (row.tipo === "preparado") {
    prod.tipo = "preparado";
    prod.receta = Array.isArray(row.receta) ? row.receta : [];
    if (prod.inventoryId && Array.isArray(state?.inventory)) state.inventory = state.inventory.filter(i => i.id !== prod.inventoryId);
    delete prod.inventoryId; delete prod.stock; delete prod.stockSynced;
    prod.recipe = {};
    return true;
  }
  if (prod.tipo === "preparado") { delete prod.tipo; delete prod.receta; }
  return false;
}
function stockMovementsList() {
  if (!Array.isArray(state.stockMovements)) state.stockMovements = [];
  return state.stockMovements;
}
// Un movimiento por cada producto con cambios locales que la nube aún no tiene
function recordStockMovements() {
  const sold = pendingSoldByProduct(), queued = new Map(), list = stockMovementsList();
  list.forEach(m => queued.set(m.productId, roundQty((queued.get(m.productId) || 0) + m.delta)));
  (state.products || []).forEach(p => {
    const id = String(p.id);
    if (!Number.isFinite(p.stockSynced) || deletedProductIds.includes(id) || p.tipo === "preparado") return;
    const delta = roundQty(localStock(p) - p.stockSynced + (sold.get(id) || 0) - (queued.get(id) || 0));
    if (delta) list.push({ id: `mov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, productId: id, delta, motivo: "ajuste", at: Date.now() });
  });
}
// Sube los movimientos pendientes. El id es la llave: un reintento tras una respuesta perdida no suma dos veces
async function syncStockMovements(sb, bId) {
  if (typeof state === "undefined" || !state || !(await usaStockMovimientos(sb))) return { ok: true, count: 0 };
  recordStockMovements();
  const pending = [...stockMovementsList()];
  if (!pending.length) return { ok: true, count: 0 };
  const rows = pending.map(m => ({ id: m.id, business_id: String(bId), producto_id: m.productId, delta: m.delta, motivo: m.motivo || "ajuste", created_at: toIsoDate(m.at) }));
  stockUploads++;
  try {
    const { error } = await sb.from("movimientos_stock").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (error) {
      console.warn("[NexoSync] ⚠️ Movimientos de stock:", error.message);
      return { ok: false, count: rows.length, error: error.message };
    }
    pending.forEach(m => { const p = productById(m.productId); if (p && Number.isFinite(p.stockSynced)) p.stockSynced = roundQty(p.stockSynced + m.delta); });
    state.stockMovements = stockMovementsList().filter(m => !pending.includes(m));
    if (typeof scheduleSave === "function") scheduleSave();
    console.log(`[NexoSync] ✅ Movimientos de stock: ${rows.length} subidos.`);
    return { ok: true, count: rows.length };
  } catch (err) {
    return { ok: false, count: rows.length, error: err.message };
  } finally {
    stockUploads--;
  }
}

/* ---------- Insumos (tablas insumos y movimientos_insumos) ----------
   Mismo principio que el stock de productos, pero sin trigger de ventas: cada insumo guarda qtySynced (lo que la nube
   ya conoce) y TODO lo hecho en esta caja (ventas, compras, mermas, ajustes, conteo) sube como la diferencia
   qty − qtySynced − movimientos en cola; el trigger movimientos_insumos_aplicar la suma al stock. Así ninguna ruta que
   cambie un insumo necesita avisar a la nube, y dos cajas que venden a la vez no se pisan. El catálogo (nombre, unidad,
   mínimo, costo) sube cuando el insumo está pendiente, sin la columna stock; solo un insumo nuevo sube su stock absoluto,
   una vez. Borrar un insumo lo deja inactivo en la nube. Prueba: scratch/test-sync-insumos.js */
let insumosMode = null;   // true: hay tablas de insumos · false: proyecto sin la migración · null: sin decidir
let insumoUploads = 0;    // subidas en curso: mientras tanto el stock remoto no se aplica
async function usaTablaInsumos(sb) {
  if (insumosMode !== null || !sb) return insumosMode === true;
  try {
    const { error } = await sb.from("insumos").select("id").limit(1);
    if (!error) insumosMode = true;
    else if (/insumos|relation|does not exist|schema cache/i.test(error.message || "")) insumosMode = false;
  } catch (e) {
    insumosMode = false;
  }
  return insumosMode === true;
}
const insumosLocales = () => ((typeof state !== "undefined" && Array.isArray(state?.insumos)) ? state.insumos : []);
const insumoLocal = id => insumosLocales().find(i => String(i.id) === String(id));
function insumoMovementsList() {
  if (!Array.isArray(state.insumoMovements)) state.insumoMovements = [];
  return state.insumoMovements;
}
function recordInsumoMovements() {
  const queued = new Map(), list = insumoMovementsList();
  list.forEach(m => queued.set(m.insumoId, roundQty((queued.get(m.insumoId) || 0) + m.delta)));
  insumosLocales().forEach(i => {
    if (!Number.isFinite(i.qtySynced)) return;
    const delta = roundQty((Number(i.qty) || 0) - i.qtySynced - (queued.get(i.id) || 0));
    if (delta) list.push({ id: `movins-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, insumoId: String(i.id), delta, motivo: "ajuste", at: Date.now() });
  });
}
function sanitizeInsumo(i, bId) {
  return {
    id: String(i.id),
    business_id: String(bId || DEFAULT_BUSINESS_ID),
    nombre: i.name || "Insumo",
    unidad: i.unit || "und",
    min_stock: Number(i.min) || 0,
    costo: Number(i.cost) || 0,
    costo_ultimo: Number.isFinite(Number(i.lastCost)) && i.lastCost != null ? Number(i.lastCost) : null,
    activo: true,
    created_at: toIsoDate(i.createdAt || Date.now()),
    updated_at: toIsoDate(i.updatedAt || Date.now())
  };
}
async function syncInsumos(sb, bId) {
  if (isDemoMode() || typeof state === "undefined" || !state || !(await usaTablaInsumos(sb))) return { ok: true, count: 0 };
  insumoUploads++;
  try {
    // 1. Borrados: quedan inactivos (los movimientos de la nube los siguen nombrando)
    const borrados = [...(state.deletedInsumoIds || [])];
    if (borrados.length) {
      const { error } = await sb.from("insumos").update({ activo: false, updated_at: new Date().toISOString() }).in("id", borrados).eq("business_id", bId);
      if (error) return { ok: false, error: error.message };
      state.deletedInsumoIds = (state.deletedInsumoIds || []).filter(id => !borrados.includes(id));
    }
    // 2. Nuevos: una sola vez con su stock absoluto (si ya existía por una respuesta perdida, no se toca)
    const nuevos = insumosLocales().filter(i => !Number.isFinite(i.qtySynced));
    if (nuevos.length) {
      const rows = nuevos.map(i => ({ ...sanitizeInsumo(i, bId), stock: roundQty(Number(i.qty) || 0) }));
      const { error } = await sb.from("insumos").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (error) { console.warn("[NexoSync] ⚠️ Insumos nuevos:", error.message); return { ok: false, error: error.message }; }
      nuevos.forEach((i, idx) => { i.qtySynced = rows[idx].stock; i.sync_status = "synced"; });
    }
    // 3. Catálogo editado (sin stock: lo cambian los movimientos)
    const editados = insumosLocales().filter(i => Number.isFinite(i.qtySynced) && isPendingSync(i));
    if (editados.length) {
      const { error } = await sb.from("insumos").upsert(editados.map(i => sanitizeInsumo(i, bId)), { onConflict: "id" });
      if (error) { console.warn("[NexoSync] ⚠️ Insumos:", error.message); return { ok: false, error: error.message }; }
      editados.forEach(i => { i.sync_status = "synced"; });
    }
    // 4. Movimientos: el id es la llave, un reintento no suma dos veces
    recordInsumoMovements();
    const pending = [...insumoMovementsList()];
    if (pending.length) {
      const rows = pending.map(m => ({ id: m.id, business_id: String(bId), insumo_id: m.insumoId, delta: m.delta, motivo: m.motivo || "ajuste", created_at: toIsoDate(m.at) }));
      const { error } = await sb.from("movimientos_insumos").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (error) { console.warn("[NexoSync] ⚠️ Movimientos de insumos:", error.message); return { ok: false, error: error.message }; }
      pending.forEach(m => { const i = insumoLocal(m.insumoId); if (i && Number.isFinite(i.qtySynced)) i.qtySynced = roundQty(i.qtySynced + m.delta); });
      state.insumoMovements = insumoMovementsList().filter(m => !pending.includes(m));
    }
    const count = borrados.length + nuevos.length + editados.length + pending.length;
    if (count) {
      if (typeof scheduleSave === "function") scheduleSave();
      console.log(`[NexoSync] ✅ Insumos: ${count} cambios subidos.`);
    }
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    insumoUploads--;
  }
}
// Insumo que llega de la nube (descarga o tiempo real). Inactivo = borrado. El stock local se mueve lo mismo que cambió
// la nube (conserva lo hecho aquí y aún no subido); el catálogo editado aquí y sin subir no se pisa.
function aplicarInsumoRemoto(row) {
  if (!row?.id || typeof state === "undefined" || !state) return;
  if (!Array.isArray(state.insumos)) state.insumos = [];
  const id = String(row.id), local = insumoLocal(id), cloud = Number(row.stock) || 0;
  if (row.activo === false) {
    if (local) state.insumos = state.insumos.filter(i => i !== local);
    return;
  }
  if ((state.deletedInsumoIds || []).includes(id)) return; // borrado aquí y aún no subido
  if (!local) {
    state.insumos.push({ id, name: row.nombre || "Insumo", unit: row.unidad || "und", qty: cloud, min: Number(row.min_stock) || 0, cost: Number(row.costo) || 0, ...(row.costo_ultimo != null ? { lastCost: Number(row.costo_ultimo) } : {}), qtySynced: cloud, createdAt: new Date(row.created_at || Date.now()).getTime(), updatedAt: new Date(row.updated_at || Date.now()).getTime(), sync_status: "synced" });
    return;
  }
  if (!isPendingSync(local)) Object.assign(local, { name: row.nombre || local.name, unit: row.unidad || local.unit, min: Number(row.min_stock) || 0, cost: Number(row.costo) || 0, ...(row.costo_ultimo != null ? { lastCost: Number(row.costo_ultimo) } : {}), sync_status: "synced" });
  if (insumoUploads > 0) return; // la nube podría traer ya aplicada la subida en curso: la próxima descarga lo corrige
  if (Number.isFinite(local.qtySynced)) local.qty = roundQty((Number(local.qty) || 0) + cloud - local.qtySynced);
  else local.qty = cloud;
  local.qtySynced = cloud;
}
async function pullInsumos(sb, bId) {
  if (isDemoMode() || !(await usaTablaInsumos(sb))) return 0;
  const { rows, complete, error } = await fetchAllRows(sb, "insumos", bId);
  if (error) console.warn("[NexoSync] Error descargando insumos:", error.message);
  if (!complete) return 0; // incompleto: no se borra nada local
  const remotos = new Set(rows.map(r => String(r.id)));
  // Ya no están en la nube: se quitan los que esta caja ya había subido (los nuevos sin subir se conservan)
  state.insumos = insumosLocales().filter(i => !Number.isFinite(i.qtySynced) || remotos.has(String(i.id)));
  rows.forEach(aplicarInsumoRemoto);
  if (typeof refreshPreparedCosts === "function") refreshPreparedCosts();
  return rows.length;
}

function sanitizeVenta(p, bId) {
  const pays = Array.isArray(p.payments) ? p.payments : [];
  const itemsList = Array.isArray(p.items) ? p.items : [];
  const primaryMethod = p.method || (pays.length > 0 ? pays.map(x => x.method).join(" + ") : "Efectivo");
  const cashierStr = String(p.cashierName || p.cashier || "");
  const orderIdStr = String(p.orderId || p.order_id || p.id);
  const shiftIdStr = String(p.shiftId || p.shift_id || "");
  const dateIso = toIsoDate(p.paidAt || p.createdAt || p.date || p.fecha);

  return {
    id: String(p.id || `pay_${Date.now()}`),
    business_id: String(bId || DEFAULT_BUSINESS_ID),
    order_id: orderIdStr,
    total: Number(p.amount ?? p.total ?? 0),
    method: primaryMethod,
    payments: pays,
    metodos_pago: pays,
    items: itemsList,
    customer: String(p.customer || ""),
    cashier: cashierStr,
    cajero: cashierStr,
    shift_id: shiftIdStr,
    fecha: dateIso,
    created_at: dateIso,
    updated_at: toIsoDate(p.updatedAt || p.updated_at || Date.now())
  };
}

function sanitizeGasto(g, bId) {
  const isCompra = Boolean(g.supplier || g.supplierId || g.lines);
  const cat = isCompra ? (g.category || g.categoria || `Compra: ${g.supplier || "Mercadería"}`) : (g.category || g.categoria || "Gasto operativo");
  const desc = isCompra ? (g.description || (g.invoice ? `Compra factura ${g.invoice} · ${g.supplier || "Proveedor"}` : "Compra de mercadería")) : (g.description || g.descripcion || "Gasto registrado");
  return {
    id: String(g.id || `gasto_${Date.now()}`),
    business_id: String(bId || DEFAULT_BUSINESS_ID),
    categoria: cat,
    descripcion: desc,
    monto: Number(g.amount ?? g.total ?? g.monto ?? 0),
    comprobante: String(g.invoice || g.receipt || g.comprobante || ""),
    proveedor_id: g.supplierId ? String(g.supplierId) : null,
    fecha: toIsoDate(g.date || g.fecha || g.createdAt),
    created_at: toIsoDate(g.createdAt || g.created_at || g.date || g.fecha),
    updated_at: toIsoDate(g.updatedAt || g.updated_at || Date.now())
  };
}

function sanitizeProveedor(s, bId) {
  return {
    id: String(s.id || `prov_${Date.now()}`),
    business_id: String(bId || DEFAULT_BUSINESS_ID),
    nombre: s.name || s.nombre || "Proveedor",
    telefono: s.phone || s.telefono || "",
    contacto: s.nit || s.contacto || "",
    direccion: s.address || s.direccion || "",
    notas: s.notes || s.notas || "",
    email: s.email || "",
    created_at: toIsoDate(s.createdAt || s.created_at || Date.now()),
    updated_at: toIsoDate(s.updatedAt || s.updated_at || Date.now())
  };
}

function sanitizeMerma(l, bId) {
  return {
    id: String(l.id || `merma_${Date.now()}`),
    business_id: String(bId || DEFAULT_BUSINESS_ID),
    producto_id: String(l.itemId || l.productId || l.producto_id || ""),
    producto_nombre: l.itemName || l.productName || l.producto_nombre || "Producto",
    cantidad: Math.abs(Number(l.delta ?? l.cantidad ?? 1)),
    motivo: l.reasonCategory || l.reason || l.motivo || "Rotura / Merma",
    observacion: l.note || l.observacion || "",
    fecha: toIsoDate(l.at || l.date || l.fecha || l.createdAt),
    created_at: toIsoDate(l.at || l.date || l.createdAt || l.created_at),
    updated_at: toIsoDate(l.updatedAt || l.updated_at || Date.now())
  };
}

/* ---------- Configuración del negocio (negocios.configuracion) ----------
   Una sola construcción para perfil, turno de caja y datos del PIN de administrador (antes el turno de caja la
   reescribía sin el PIN). Los pedidos solo se incluyen en el modo anterior: con la tabla de pedidos
   (usaTablaPedidos) cada pedido viaja en su propia fila y esta fila deja de reescribirse con cada comanda. */
function configuracionNegocio(prof, { orders, cashShift } = {}) {
  // Un perfil antiguo puede traer pedidos de una descarga y el PIN en texto plano: ninguno de los dos se sube
  const { orders: _pedidosAnteriores, admin_pin: _pinPlano, adminPin: _pinPlano2, ...perfil } = prof || {};
  const admin = (typeof state !== "undefined" && Array.isArray(state?.users)) ? state.users.find(u => u.role === "admin") : null;
  const pedidos = orders || ((typeof state !== "undefined" && Array.isArray(state?.orders)) ? state.orders : []);
  return {
    ...perfil,
    ...(ordersTableMode === true ? {} : { orders: pedidos }),
    cashShift: cashShift || ((typeof state !== "undefined" && state?.cashShift) ? state.cashShift : { status: "closed" }),
    // PIN de administrador: solo sal y hash, con la fecha del cambio para que las cajas no lo pisen con uno más viejo
    ...(admin ? { admin_salt: admin.salt, admin_hash: admin.pinHash, admin_pin_at: Number(admin.pinAt) || 0, mustChangePin: Boolean(admin.mustChangePin) } : {})
  };
}

/* Escritura de la fila del negocio. En Supabase las cajas solo pueden ACTUALIZAR `nombre` y `configuracion` (permisos
   por columna) y no pueden crear filas: así un negocio no puede tocar activo, plan ni fecha_vencimiento. La fila la crea el
   SuperAdmin (admin_create_negocio). Antes se usaba upsert con todas las columnas y Supabase lo rechazaba siempre (403). */
async function actualizarNegocio(sb, payload) {
  const { data, error } = await sb.from("negocios")
    .update({ nombre: payload.nombre, configuracion: payload.configuracion })
    .eq("id", String(payload.id))
    .select("id");
  if (error) return { error };
  if (!Array.isArray(data) || data.length === 0) return { error: { message: "El negocio no existe en Supabase o esta caja no tiene permiso sobre él." } };
  return { error: null };
}

function sanitizeNegocio(profile, bId) {
  const prof = profile || {};
  return {
    id: String(bId || DEFAULT_BUSINESS_ID),
    nombre: prof.name || prof.nombre || "NexoPos",
    telefono: prof.phone || prof.ownerPhone || prof.telefono || "",
    configuracion: configuracionNegocio(prof),
    created_at: toIsoDate(prof.createdAt || prof.created_at || Date.now()),
    updated_at: toIsoDate(prof.updatedAt || prof.updated_at || Date.now())
  };
}

function countPendingRecords() {
  if (typeof state === "undefined" || !state) return 0;
  let count = 0;
  try {
    if (Array.isArray(state.products)) {
      count += state.products.filter(isPendingSync).length;
    }
    if (Array.isArray(state.payments)) {
      count += state.payments.filter(isPendingSync).length;
    }
    if (Array.isArray(state.expenses)) {
      count += state.expenses.filter(isPendingSync).length;
    }
    if (Array.isArray(state.purchases)) {
      count += state.purchases.filter(isPendingSync).length;
    }
    if (Array.isArray(state.suppliers)) {
      count += state.suppliers.filter(isPendingSync).length;
    }
    if (Array.isArray(state.stockLog)) {
      count += state.stockLog.filter(isPendingSync).length;
    }
    if (Array.isArray(state.stockMovements)) {
      count += state.stockMovements.length;
    }
    if (Array.isArray(state.insumos)) {
      count += state.insumos.filter(isPendingSync).length; // un insumo nuevo nace pendiente
    }
    count += (state.insumoMovements || []).length + (state.deletedInsumoIds || []).length;
    if (Array.isArray(state.orders)) {
      count += state.orders.filter(isPendingSync).length;
    }
    if (state.profile && isPendingSync(state.profile)) {
      count += 1;
    }
    count += deletedProductIds.length;
    count += deletedSaleIds.length;
  } catch (e) {
    /* ignore */
  }
  return count;
}

// Ventas, gastos y compras que solo existen en este equipo (lo que se perdería si se borran los datos del
// navegador) y desde cuándo espera el más antiguo
function pendingSummary() {
  const out = { total: countPendingRecords(), registros: 0, desde: null };
  if (typeof state === "undefined" || !state) return out;
  for (const col of ["payments", "expenses", "purchases"]) {
    for (const r of (Array.isArray(state[col]) ? state[col] : [])) {
      if (!isPendingSync(r)) continue;
      out.registros++;
      const at = Number(r.createdAt || r.paidAt) || Date.parse(r.created_at || "") || null;
      if (at && (out.desde === null || out.desde > at)) out.desde = at;
    }
  }
  return out;
}

const PENDIENTE_VIEJO_MS = 24 * 3600 * 1000;
let avisoPendienteViejo = false; // un aviso por sesión
function updateIndicator(status) {
  if (isDemoMode()) {
    status = "demo";
  }
  syncState.status = status;
  syncState.pendingCount = countPendingRecords();
  const pendientes = status === "demo" ? { registros: 0, desde: null } : pendingSummary();

  const sidebarInd = document.querySelector("#syncStatusIndicator");
  const sidebarLabel = document.querySelector("#syncLabel");

  const topbarInd = document.querySelector("#syncBadgeTopbar");
  const topbarLabel = document.querySelector("#syncBadgeLabel");

  let labelText = "";
  let topbarText = "";
  let tooltip = "";
  let statusClass = "";

  if (status === "demo") {
    statusClass = "is-demo";
    labelText = "Modo Demo (Sandbox)";
    topbarText = "Modo Demo";
    tooltip = "Modo Demo Local (Sandbox): Opera 100% con datos locales. No altera la base de datos real de produccion.";
  } else if (status === "synced") {
    statusClass = "is-synced";
    labelText = "En línea / Sincronizado";
    topbarText = "En línea / Sincronizado";
    const timeStr = syncState.lastSyncAt ? new Date(syncState.lastSyncAt).toLocaleTimeString("es-CO") : "Reciente";
    tooltip = `Conexión activa con Supabase (${timeStr}). Sin cambios pendientes.`;
  } else if (status === "auth") {
    statusClass = "is-offline";
    labelText = "Sesión vencida";
    topbarText = "Sesión vencida";
    tooltip = "La caja sigue funcionando sin conexión. Toca aquí para volver a vincular la terminal y reanudar la sincronización.";
  } else if (status === "syncing") {
    statusClass = "is-syncing";
    labelText = "Sincronizando...";
    topbarText = "Sincronizando...";
    tooltip = `Sincronizando datos con la nube (${syncState.pendingCount} pendientes)...`;
  } else {
    statusClass = "is-offline";
    labelText = "Modo Offline";
    topbarText = "Modo Offline";
    tooltip = "Modo sin conexión. El sistema opera 100% local sin riesgo.";
  }
  // Sin conexión o sin sesión con registros por subir: cuántos y desde cuándo (si se borra el navegador se pierden)
  if ((status === "offline" || status === "auth") && pendientes.registros > 0) {
    const n = pendientes.registros, desde = pendientes.desde ? new Date(pendientes.desde).toLocaleString("es-CO") : "";
    labelText += ` · ${n} sin subir`;
    if (status === "offline") tooltip = "Modo sin conexión: la caja sigue vendiendo.";
    tooltip += ` ${n} ${n === 1 ? "registro está" : "registros están"} solo en este equipo${desde ? ` (el más antiguo desde ${desde})` : ""}. No borres los datos del navegador hasta que se suban.`;
    if (!avisoPendienteViejo && pendientes.desde && Date.now() - pendientes.desde > PENDIENTE_VIEJO_MS && typeof showToast === "function") {
      avisoPendienteViejo = true;
      showToast(`⚠ Hay ${n} ${n === 1 ? "registro" : "registros"} sin subir a la nube desde hace más de un día. Conecta la caja a internet o descarga un respaldo.`);
    }
  }

  if (sidebarInd) {
    sidebarInd.className = `sync-state ${statusClass}`;
    sidebarInd.title = tooltip;
  }
  if (sidebarLabel) {
    sidebarLabel.textContent = labelText;
  }

  if (topbarInd) {
    topbarInd.className = `sync-badge-topbar ${statusClass}`;
    topbarInd.title = tooltip;
  }
  if (topbarLabel) {
    topbarLabel.textContent = topbarText;
  }
}

async function checkInitialConnection() {
  if (isDemoMode()) {
    updateIndicator("demo");
    return true;
  }
  if (!hasSupabaseLib()) await loadSupabaseLib();
  const sb = getClient();
  if (!sb) {
    updateIndicator("offline");
    return false;
  }
  if (!(await hasAuthSession(sb))) {
    updateIndicator("auth");
    return false;
  }
  try {
    const { error } = await sb.from("productos").select("id", { count: "exact", head: true });
    if (!error) {
      syncState.online = true;
      syncState.lastSyncAt = Date.now();
      updateIndicator("synced");
      return true;
    }
    updateIndicator("offline");
    return false;
  } catch (err) {
    updateIndicator("offline");
    return false;
  }
}

// Terminal vinculada a un negocio (ver activación en app.js). Sin vínculo no se sube ni descarga nada.
function isTerminalLinked() {
  return typeof state !== "undefined" && Boolean(state?.terminal?.businessId);
}

function scheduleSync(delay = 1000) {
  if (!isTerminalLinked()) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    if (!(await hasAuthSession())) {
      updateIndicator("auth");
      return;
    }
    syncAll().catch(() => {});
  }, delay);
}

async function deleteProduct(productId) {
  if (!productId) return { ok: false, error: "ID de producto vacio" };
  const cleanId = String(productId);
  if (isDemoMode()) {
    console.log(`[NexoSync] 🧪 Modo Demo: Borrado de producto '${cleanId}' ejecutado solo localmente.`);
    return { ok: true, id: cleanId, demo: true };
  }
  if (!deletedProductIds.includes(cleanId)) {
    deletedProductIds.push(cleanId);
    saveDeletedIds();
  }

  const sb = getClient();
  const isOff = typeof navigator !== "undefined" && navigator.onLine === false;
  if (sb && !isOff && syncState.online !== false) {
    try {
      // Defensa en profundidad: además del RLS, el borrado se limita al negocio de esta caja
      const { error: delErr } = await sb.from("productos").delete().eq("id", cleanId).eq("business_id", getBusinessId());
      if (!delErr) {
        deletedProductIds = deletedProductIds.filter(id => id !== cleanId);
        saveDeletedIds();
        console.log(`[NexoSync] ✅ Producto '${cleanId}' eliminado de inmediato en Supabase.`);
        updateIndicator(syncState.status);
        return { ok: true, id: cleanId };
      }
      console.warn(`[NexoSync] ⚠️ Error al eliminar producto en Supabase:`, delErr.message);
    } catch (err) {
      console.warn(`[NexoSync] ⚠️ Excepcion al eliminar producto en Supabase:`, err.message);
    }
  }

  scheduleSync(500);
  return { ok: true, queued: true, id: cleanId };
}

function trackProductDeletion(productId) {
  deleteProduct(productId).catch(() => {});
}

async function deleteSale(saleId) {
  if (!saleId) return { ok: false, error: "ID de venta vacio" };
  const cleanId = String(saleId);
  if (isDemoMode()) {
    console.log(`[NexoSync] 🧪 Modo Demo: Borrado de venta '${cleanId}' ejecutado solo localmente.`);
    return { ok: true, id: cleanId, demo: true };
  }
  if (!deletedSaleIds.includes(cleanId)) {
    deletedSaleIds.push(cleanId);
    saveDeletedIds();
  }

  const sb = getClient();
  const isOff = typeof navigator !== "undefined" && navigator.onLine === false;
  if (sb && !isOff && syncState.online !== false) {
    try {
      const { error: delErr } = await sb.from("ventas").delete().eq("id", cleanId).eq("business_id", getBusinessId());
      if (!delErr) {
        deletedSaleIds = deletedSaleIds.filter(id => id !== cleanId);
        saveDeletedIds();
        console.log(`[NexoSync] ✅ Venta '${cleanId}' eliminada de inmediato en Supabase.`);
        updateIndicator(syncState.status);
        return { ok: true, id: cleanId };
      }
      console.warn(`[NexoSync] ⚠️ Error al eliminar venta en Supabase:`, delErr.message);
    } catch (err) {
      console.warn(`[NexoSync] ⚠️ Excepcion al eliminar venta en Supabase:`, err.message);
    }
  }

  scheduleSync(500);
  return { ok: true, queued: true, id: cleanId };
}

// Sincronización dedicada de productos e inventario con Supabase
async function syncProductos(options = {}) {
  if (isDemoMode()) {
    const rawProds = (typeof state !== "undefined" && Array.isArray(state.products)) ? state.products : [];
    rawProds.forEach(p => { p.sync_status = "synced"; });
    return { ok: true, demo: true, count: 0 };
  }
  const sb = getClient();
  if (!sb) {
    console.warn("[NexoSync] syncProductos: Cliente Supabase no inicializado.");
    return { ok: false, error: "Cliente no inicializado" };
  }
  const bId = getBusinessId();
  try {
    // 1. Replicar eliminaciones de productos pendientes hacia Supabase primero
    if (deletedProductIds.length > 0) {
      try {
        const idsToDelete = [...deletedProductIds];
        const { error: delErr } = await sb.from("productos").delete().in("id", idsToDelete).eq("business_id", bId);
        if (!delErr) {
          deletedProductIds = deletedProductIds.filter(id => !idsToDelete.includes(id));
          saveDeletedIds();
          console.log(`[NexoSync] ✅ Eliminaciones de productos procesadas: ${idsToDelete.length} en Supabase.`);
        }
      } catch (e) {
        /* ignore */
      }
    }

    // 2. Filtrar únicamente productos locales marcados como nuevo_local o pending
    const rawProds = (typeof state !== "undefined" && Array.isArray(state.products)) ? state.products : [];
    const prods = rawProds.filter(p => options.force || isPendingSync(p));
    if (prods.length > 0) {
      const records = prods.map(p => sanitizeProducto(p, bId));
      // Modo movimientos: sin base, el stock va absoluto (más lo vendido en ventas sin subir, que su trigger descontará);
      // con base, no viaja (lo cambian los movimientos). Dos lotes: un upsert no puede omitir la columna solo en algunas filas.
      const deltas = await usaStockMovimientos(sb);
      const firstStock = new Map();
      if (deltas) {
        const sold = pendingSoldByProduct();
        prods.forEach((p, i) => {
          if (Number.isFinite(p.stockSynced)) delete records[i].stock;
          else { records[i].stock = roundQty(localStock(p) + (sold.get(String(p.id)) || 0)); firstStock.set(p, records[i].stock); }
        });
      }
      const batches = deltas ? [records.filter(r => "stock" in r), records.filter(r => !("stock" in r))] : [records];
      for (const batch of batches.filter(b => b.length)) {
        const { error: prodErr } = await sb.from("productos").upsert(batch, { onConflict: "id" });
        if (prodErr) {
          console.warn("[NexoSync] ⚠️ Productos:", prodErr.message);
          return { ok: false, count: prods.length, error: prodErr.message };
        }
      }
      prods.forEach(p => { p.sync_status = "synced"; if (firstStock.has(p)) p.stockSynced = firstStock.get(p); });
      console.log(`[NexoSync] ✅ Productos: ${records.length} sincronizados.`);
      return { ok: true, count: records.length };
    }
    console.log("[NexoSync] ℹ️ Productos: 0 pendientes.");
    return { ok: true, count: 0 };
  } catch (err) {
    console.warn("[NexoSync] ⚠️ Productos excepción:", err.message);
    return { ok: false, error: err.message };
  }
}

// Sincronización inmediata de una venta individual y actualización de stock de sus productos en Supabase
async function syncSale(sale) {
  if (isDemoMode()) {
    if (sale) {
      sale.sync_status = "synced";
      sale.synced = true;
    }
    console.log("[NexoSync] 🧪 Modo Demo: Venta registrada 100% en almacenamiento local (Supabase protegido).");
    return { ok: true, demo: true };
  }
  const sb = getClient();
  if (!sb || !sale) return { ok: false, error: "Cliente no inicializado o venta vacía" };
  const bId = getBusinessId();
  try {
    const deltas = await usaStockMovimientos(sb);
    const saleRecord = sanitizeVenta(sale, bId);
    stockUploads++;
    let saleErr;
    try { ({ error: saleErr } = await sb.from("ventas").upsert(saleRecord, { onConflict: "id" })); } finally { stockUploads--; }
    if (saleErr) {
      console.error(`[NexoSync] ❌ Error exacto al subir venta '${sale.id}':`, saleErr.message || saleErr, saleRecord);
      return { ok: false, error: saleErr.message };
    }
    markSaleUploaded(sale);

    // Modo anterior: subir de inmediato el stock absoluto de los productos vendidos (en modo movimientos lo descuenta el trigger)
    if (!deltas && Array.isArray(sale.items) && sale.items.length > 0 && typeof state !== "undefined" && Array.isArray(state.products)) {
      const pIds = new Set();
      sale.items.forEach(it => {
        const id = it.productId || it.id;
        if (id) pIds.add(String(id));
      });
      const affectedProds = state.products.filter(p => pIds.has(String(p.id)));
      if (affectedProds.length > 0) {
        const prodRecords = affectedProds.map(p => sanitizeProducto(p, bId));
        const { error: prodErr } = await sb.from("productos").upsert(prodRecords, { onConflict: "id" });
        if (prodErr) {
          console.warn("[NexoSync] ⚠️ Error actualizando stock tras syncSale:", prodErr.message);
        } else {
          affectedProds.forEach(p => { p.sync_status = "synced"; p.synced = true; });
          console.log(`[NexoSync] ✅ Stock en Supabase actualizado para ${prodRecords.length} productos tras venta.`);
        }
      }
    }

    if (typeof scheduleSave === "function") scheduleSave();
    updateIndicator("synced");
    return { ok: true };
  } catch (err) {
    console.error("[NexoSync] ❌ syncSale excepción:", err.message);
    return { ok: false, error: err.message };
  }
}

/* ---------- Pedidos en su propia tabla (pedidos_activos) ----------
   Modo anterior: cada cambio de una comanda reescribía la fila completa de negocios (perfil, logo, plano, turno y todos
   los pedidos) y el tiempo real la reenviaba entera a cada caja. Con la migración de Supabase (columna meta en
   pedidos_activos y la tabla en la publicación de tiempo real; ver CLAUDE.md) cada pedido viaja como su propia fila.
   Se detecta sola: si la columna meta no existe, todo sigue como antes. */
let ordersTableMode = null; // null = sin comprobar · true = tabla de pedidos · false = modo anterior

async function usaTablaPedidos(sb) {
  if (ordersTableMode !== null || !sb) return ordersTableMode === true;
  try {
    const { error } = await sb.from("pedidos_activos").select("id,meta").limit(1);
    if (!error) ordersTableMode = true;
    else if (/meta|column|relation|does not exist|schema cache/i.test(error.message || "")) ordersTableMode = false;
    // Otro error (p. ej. sin red): no se decide todavía; esta vez se usa el modo anterior
  } catch (e) {
    ordersTableMode = false; // cliente sin soporte de la consulta
  }
  return ordersTableMode === true;
}

const isClosedStatus = o => ["paid", "closed", "cerrada", "cancelada"].includes(String(o?.status || "").toLowerCase());
const hasItems = o => Array.isArray(o?.items) && o.items.some(i => (Number(i.qty) || 0) > 0);

// Pedido → fila de pedidos_activos. meta lleva el pedido completo (nota, abonos, cobro en partes, cliente…)
function pedidoAFila(o, bId) {
  const { sync_status: _estadoSync, items, ...meta } = o;
  const total = Number((items || []).reduce((s, i) => s + (Number(i.price || 0) * Number(i.qty || 1)), 0) || 0);
  return {
    id: toValidUuid(o.id),
    business_id: String(bId || DEFAULT_BUSINESS_ID),
    mesa_id: String(o.tableId || "walkin"),
    nombre_mesa: String(o.tableName || (o.tableId === "walkin" ? "Venta en mostrador" : "Mesa")),
    cliente: String(o.customer || (o.isCustom ? o.tableName : "") || ""),
    items: Array.isArray(items) ? items : [],
    subtotal: total,
    total,
    estado: "abierto",
    tipo: o.isCustom ? "personalizada" : (o.tableId === "walkin" ? "barra" : "mesa"),
    meta,
    created_at: toIsoDate(o.createdAt || Date.now()),
    updated_at: new Date().toISOString()
  };
}

// Fila de pedidos_activos → pedido. Las filas sin meta (escritas por versiones anteriores) se reconstruyen igual que antes
function filaAPedido(row) {
  const meta = (row?.meta && typeof row.meta === "object") ? row.meta : {};
  return {
    ...meta,
    id: String(meta.id || row.id),
    tableId: meta.tableId || row.mesa_id || "walkin",
    tableName: meta.tableName || row.nombre_mesa || (row.tipo === "barra" ? "Venta en mostrador" : "Mesa"),
    customer: meta.customer ?? row.cliente ?? "",
    isCustom: meta.isCustom ?? row.tipo === "personalizada",
    items: Array.isArray(row.items) ? row.items : [],
    note: meta.note ?? row.nota ?? "",
    status: (row.estado === "abierto" || row.estado === "open") ? "open" : "paid",
    createdAt: meta.createdAt || new Date(row.created_at || Date.now()).getTime(),
    updatedAt: meta.updatedAt || new Date(row.updated_at || Date.now()).getTime(),
    sync_status: "synced"
  };
}

// Modo tabla: sube solo los pedidos con cambios y borra de la tabla los que ya no están abiertos en esta caja.
// No toca la fila de negocios.
async function syncOrdersTabla(sb, bId) {
  const orders = (typeof state !== "undefined" && Array.isArray(state?.orders)) ? state.orders : [];
  const pendientes = orders.filter(o => o && o.sync_status !== "synced" && !isClosedStatus(o) && hasItems(o));
  if (pendientes.length > 0) {
    const { error } = await sb.from("pedidos_activos").upsert(pendientes.map(o => pedidoAFila(o, bId)), { onConflict: "id" });
    if (error) {
      console.warn("[NexoSync] ⚠️ Error sincronizando pedidos en 'pedidos_activos':", error.message);
      return { ok: false, error: error.message };
    }
    pendientes.forEach(o => { o.sync_status = "synced"; });
  }
  // Fuera de la tabla: cobrados o cerrados, abiertos que quedaron vacíos y los retirados en esta caja (unidos, eliminados)
  const retirados = Object.keys((typeof state !== "undefined" && state?.deleted_order_ids && typeof state.deleted_order_ids === "object") ? state.deleted_order_ids : {});
  const fuera = [...orders.filter(o => o && (isClosedStatus(o) || !hasItems(o))).map(o => o.id), ...retirados]
    .map(id => toValidUuid(id)).filter(Boolean);
  if (fuera.length > 0) {
    const unicos = [...new Set(fuera)];
    for (let i = 0; unicos.length > i; i += PULL_IN_CHUNK) {
      await sb.from("pedidos_activos").delete().in("id", unicos.slice(i, i + PULL_IN_CHUNK)).eq("business_id", bId);
    }
    orders.forEach(o => { if (isClosedStatus(o)) o.sync_status = "synced"; });
  }
  return { ok: true, count: pendientes.length, modo: "tabla" };
}

// Sincronización bidireccional de comandas / pedidos activos con Supabase
async function syncOrders(options = {}) {
  if (isDemoMode()) {
    if (typeof state !== "undefined" && Array.isArray(state?.orders)) {
      state.orders.forEach(o => { o.sync_status = "synced"; });
    }
    console.log("[NexoSync] 🧪 Modo Demo: Comandas registradas 100% en almacenamiento local.");
    return { ok: true, demo: true };
  }
  const sb = getClient();
  if (!sb) {
    console.warn("[NexoSync] syncOrders: Cliente Supabase no inicializado.");
    return { ok: false, error: "Cliente no inicializado" };
  }
  const bId = getBusinessId();
  if (!bId) return { ok: false, error: "Negocio no identificado" };

  try {
    if (await usaTablaPedidos(sb)) return await syncOrdersTabla(sb, bId);

    const rawOrders = (typeof state !== "undefined" && Array.isArray(state?.orders)) ? state.orders : [];
    const currentOrders = rawOrders.filter(o => {
      if (!o) return false;
      const st = String(o.status || "").toLowerCase();
      const isPaid = st === "paid" || st === "closed" || st === "cerrada" || st === "cancelada";
      if (isPaid) return true;
      return Array.isArray(o.items) && o.items.length > 0 && o.items.some(i => (Number(i.qty) || 0) > 0);
    });
    const prof = (typeof state !== "undefined" && state?.profile) ? state.profile : {};

    // 1. Modo anterior: guardar de forma garantizada en negocios.configuracion.orders
    const businessPayload = {
      id: String(bId || DEFAULT_BUSINESS_ID),
      nombre: prof.name || prof.nombre || "NexoPos",
      telefono: prof.phone || prof.ownerPhone || prof.telefono || "",
      configuracion: configuracionNegocio(prof, { orders: currentOrders }),
      updated_at: new Date().toISOString()
    };

    const { error: negErr } = await actualizarNegocio(sb, businessPayload);
    if (negErr) {
      console.warn("[NexoSync] ⚠️ Error sincronizando comandas en negocios:", negErr.message);
    } else {
      console.log(`[NexoSync] ✅ Comandas / pedidos sincronizados en Supabase ('negocios'): ${currentOrders.length} ordenes.`);
      if (Array.isArray(state?.orders)) {
        state.orders.forEach(o => { o.sync_status = "synced"; });
      }
    }

    // 2. Soporte prioritario para tabla 'pedidos_activos' en Supabase
    try {
      const activeOrdersList = currentOrders.filter(o => {
        if (!o) return false;
        const st = String(o.status || "").toLowerCase();
        const isPaid = (st === "paid" || st === "closed" || st === "cerrada" || st === "cancelada");
        if (isPaid) return false;
        return Array.isArray(o.items) && o.items.length > 0 && o.items.some(i => (Number(i.qty) || 0) > 0);
      });

      if (activeOrdersList.length > 0) {
        const activeRows = activeOrdersList.map(o => {
          const orderTotalAmount = Number(o.items?.reduce((s, i) => s + (Number(i.price || 0) * Number(i.qty || 1)), 0) || 0);
          return {
            id: toValidUuid(o.id),
            business_id: String(bId || DEFAULT_BUSINESS_ID),
            mesa_id: String(o.tableId || "walkin"),
            nombre_mesa: String(o.tableName || (o.tableId === "walkin" ? "Venta en mostrador" : "Mesa")),
            cliente: String(o.customer || (o.isCustom ? o.tableName : "") || ""),
            items: Array.isArray(o.items) ? o.items : [],
            subtotal: orderTotalAmount,
            total: orderTotalAmount,
            estado: "abierto",
            tipo: o.isCustom ? "personalizada" : (o.tableId === "walkin" ? "barra" : "mesa"),
            created_at: toIsoDate(o.createdAt || Date.now()),
            updated_at: new Date().toISOString()
          };
        });
        const { error: paErr } = await sb.from("pedidos_activos").upsert(activeRows, { onConflict: "id" });
        if (!paErr) {
          console.log(`[NexoSync] ✅ ${activeRows.length} pedidos sincronizados en tabla 'pedidos_activos'.`);
        }
      }

      // Eliminar pedidos cobrados o cerrados de 'pedidos_activos'
      const closedOrderUuids = rawOrders.filter(o => {
        if (!o) return false;
        const st = String(o.status || "").toLowerCase();
        return (st === "paid" || st === "closed" || st === "cerrada" || st === "cancelada");
      }).map(o => toValidUuid(o.id)).filter(Boolean);

      if (closedOrderUuids.length > 0) {
        await sb.from("pedidos_activos").delete().in("id", closedOrderUuids).eq("business_id", bId);
      }
    } catch (e) {
      /* ignore si la tabla opcional pedidos_activos no existe */
    }

    return { ok: true, count: currentOrders.length };
  } catch (err) {
    console.warn("[NexoSync] ⚠️ syncOrders excepcion:", err.message);
    return { ok: false, error: err.message };
  }
}

// Elimina inmediatamente una orden de 'pedidos_activos' al cobrar o cancelar
async function deleteActiveOrder(orderId) {
  if (isDemoMode()) {
    return { ok: true, demo: true };
  }
  const sb = getClient();
  if (!sb || !orderId) return { ok: false };
  const bId = getBusinessId();
  try {
    const uuid = toValidUuid(orderId);
    await sb.from("pedidos_activos").delete().eq("id", uuid).eq("business_id", bId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Fusión inteligente de pedidos remotos sin pisar datos locales.
// completa=true: remoteOrders es la lista entera de pedidos abiertos, y un pedido local sincronizado que no aparece
// se da por cobrado en otra caja. completa=false: llega un pedido suelto (tiempo real de pedidos_activos).
function mergeRemoteOrders(remoteOrders, { completa = true } = {}) {
  if (!Array.isArray(remoteOrders) || typeof state === "undefined" || !state) return;
  if (!Array.isArray(state.orders)) state.orders = [];

  // Purgar localmente órdenes abiertas vacías o huérfanas
  state.orders = state.orders.filter(lo => {
    if (!lo) return false;
    const st = String(lo.status || "").toLowerCase();
    const isPaid = st === "paid" || st === "closed" || st === "cerrada" || st === "cancelada";
    if (isPaid) return true;
    return Array.isArray(lo.items) && lo.items.length > 0 && lo.items.some(i => (Number(i.qty) || 0) > 0);
  });

  // Pedidos retirados en esta caja (cobrados, eliminados o unidos): una copia remota nunca los resucita
  const removedMap = (state.deleted_order_ids && typeof state.deleted_order_ids === "object") ? state.deleted_order_ids : {};
  const removedKeys = new Set();
  Object.keys(removedMap).forEach(id => { removedKeys.add(String(id)); const u = toValidUuid(id); if (u) removedKeys.add(u); });
  const isRemovedLocally = ro => removedKeys.has(String(ro.id)) || removedKeys.has(toValidUuid(ro.id));
  const isClosedOrder = o => ["paid", "closed", "cerrada", "cancelada"].includes(String(o?.status || "").toLowerCase());
  // Prioridad offline: un cambio local aún no subido solo cede ante una versión remota POSTERIOR a ese cambio
  const lastLocalChange = o => Math.max(Number(o.updatedAt) || 0, Number(o.paidAt) || 0, Number(o.createdAt) || 0);
  const keepLocal = (lo, ro) => lo.sync_status === "pending" && !(Number(ro.updatedAt) > lastLocalChange(lo));

  const validRemoteOrders = (remoteOrders || []).filter(ro => {
    if (!ro || !ro.id) return false;
    if (isRemovedLocally(ro)) return false;
    const st = String(ro.status || "").toLowerCase();
    const isPaid = st === "paid" || st === "closed" || st === "cerrada" || st === "cancelada";
    if (isPaid) return true;
    return Array.isArray(ro.items) && ro.items.length > 0 && ro.items.some(i => (Number(i.qty) || 0) > 0);
  });

  const remoteMap = new Map();
  validRemoteOrders.forEach(ro => {
    remoteMap.set(String(ro.id), ro);
    const roUuid = toValidUuid(ro.id);
    if (roUuid) remoteMap.set(roUuid, ro);
  });

  // 1. Actualizar órdenes locales existentes
  state.orders.forEach(lo => {
    const loUuid = toValidUuid(lo.id);
    const ro = remoteMap.get(String(lo.id)) || (loUuid ? remoteMap.get(loUuid) : null);
    if (ro) {
      if (isClosedOrder(lo) && !isClosedOrder(ro)) return; // una mesa cobrada aquí nunca se reabre desde la nube
      if (keepLocal(lo, ro)) return;                       // cambio local pendiente de subir: gana sobre la copia remota
      lo.status = ro.status || lo.status;
      if (Array.isArray(ro.items)) lo.items = ro.items;
      if (ro.note !== undefined) lo.note = ro.note;
      if (ro.tableName) lo.tableName = ro.tableName;
      if (ro.tableId) lo.tableId = ro.tableId;
      if (ro.paidAmount !== undefined) lo.paidAmount = ro.paidAmount;
      if (ro.paidAt !== undefined) lo.paidAt = ro.paidAt;
      if (ro.equalSplit !== undefined) lo.equalSplit = ro.equalSplit; // cobro en partes de otra caja (configuracion.orders lo trae)
      if (ro.updatedAt !== undefined) lo.updatedAt = ro.updatedAt;
      lo.sync_status = "synced";
    } else if (completa) {
      if (lo.sync_status === "synced" && lo.status !== "paid") {
        lo.status = "paid";
      }
    }
  });

  // 2. Insertar órdenes remotas válidas que no existen en local
  const localIds = new Set();
  state.orders.forEach(o => {
    localIds.add(String(o.id));
    const u = toValidUuid(o.id);
    if (u) localIds.add(u);
  });

  validRemoteOrders.forEach(ro => {
    const roUuid = toValidUuid(ro.id);
    const alreadyExists = localIds.has(String(ro.id)) || (roUuid ? localIds.has(roUuid) : false);
    if (ro && ro.id && !alreadyExists) {
      const sameTableLocal = (!ro.isCustom && ro.tableId !== "walkin") ? state.orders.find(o => o.tableId === ro.tableId && !o.isCustom && o.status === "open") : null;
      if (sameTableLocal) {
        if (keepLocal(sameTableLocal, ro)) return; // el pedido local de esa mesa tiene cambios sin subir
        sameTableLocal.items = ro.items || sameTableLocal.items;
        sameTableLocal.status = ro.status || sameTableLocal.status;
        sameTableLocal.sync_status = "synced";
      } else {
        state.orders.push({
          id: String(ro.id),
          tableId: ro.tableId || "walkin",
          tableName: ro.tableName || "Venta en mostrador",
          isCustom: Boolean(ro.isCustom),
          items: Array.isArray(ro.items) ? ro.items : [],
          note: ro.note || "",
          status: ro.status || "open",
          createdAt: ro.createdAt || Date.now(),
          shiftId: ro.shiftId || state.cashShift?.id || null,
          paidAmount: ro.paidAmount || 0,
          paidAt: ro.paidAt || null,
          sync_status: "synced"
        });
      }
    }
  });
}

// Tiempo real de pedidos_activos: un pedido por evento, en ambos modos (en el modo anterior la lista completa sigue
// llegando además con negocios)
function refrescarPedidos() {
  if (typeof scheduleSave === "function") scheduleSave();
  if (typeof renderTables === "function") try { renderTables(); } catch (e) { /* ignore */ }
  if (typeof renderStats === "function") try { renderStats(); } catch (e) { /* ignore */ }
  if (typeof renderCustomOrders === "function") try { renderCustomOrders(); } catch (e) { /* ignore */ }
  if (typeof renderAll === "function") try { renderAll(); } catch (e) { /* ignore */ }
}
function aplicarPedidoEnVivo(payload) {
  if (!payload?.new) return;
  mergeRemoteOrders([filaAPedido(payload.new)], { completa: false });
  refrescarPedidos();
}
// Pedido quitado de la tabla en otra caja (cobrado, unido o vaciado): igual que en la fusión completa, un pedido
// local ya sincronizado se da por cobrado; uno con cambios sin subir se conserva
function retirarPedidoEnVivo(id) {
  if (!id || typeof state === "undefined" || !Array.isArray(state?.orders)) return;
  const local = state.orders.find(o => String(o.id) === String(id) || toValidUuid(o.id) === String(id));
  if (!local || local.sync_status !== "synced" || local.status === "paid") return;
  local.status = "paid";
  refrescarPedidos();
}

// Sincronización del estado de apertura / cierre de caja con Supabase (negocios, turnos_caja)
async function syncCashShift(shift, closedData = null) {
  const currentShift = shift || ((typeof state !== "undefined" && state?.cashShift) ? state.cashShift : { status: "closed" });
  if (isDemoMode()) {
    console.log(`[NexoSync] 🧪 Modo Demo: Turno de caja '${currentShift.status}' gestionado 100% localmente.`);
    return { ok: true, demo: true, status: currentShift.status };
  }
  const sb = getClient();
  if (!sb) {
    console.warn("[NexoSync] syncCashShift: Cliente Supabase no inicializado.");
    return { ok: false, error: "Cliente no inicializado" };
  }
  const bId = getBusinessId();
  const isShiftOpenStatus = (currentShift.status === "open" || currentShift.status === "abierto");

  try {
    // 1. Persistir de forma segura en 'negocios' (configuracion.cashShift JSONB)
    const prof = (typeof state !== "undefined" && state?.profile) ? state.profile : {};
    await usaTablaPedidos(sb); // decide si los pedidos van en esta fila (modo anterior) o en pedidos_activos
    const businessPayload = {
      id: String(bId || DEFAULT_BUSINESS_ID),
      nombre: prof.name || prof.nombre || "NexoPos",
      telefono: prof.phone || prof.ownerPhone || prof.telefono || "",
      configuracion: configuracionNegocio(prof, { cashShift: currentShift }),
      updated_at: new Date().toISOString()
    };

    const { error: negErr } = await actualizarNegocio(sb, businessPayload);
    if (negErr) {
      console.warn("[NexoSync] ⚠️ Error sincronizando cashShift en negocios:", negErr.message);
    } else {
      console.log(`[NexoSync] ✅ Turno de caja sincronizado en Supabase ('negocios'): ${currentShift.status}`);
    }

    // 2. Soporte prioritario para tabla 'turnos_caja' con columnas business_id, estado, monto_apertura, fecha_apertura
    try {
      const shiftUuid = toValidUuid(currentShift.id || closedData?.id || (typeof state !== "undefined" && state?.cashShift?.id) || `shift_${Date.now()}`);
      const shiftRecord = {
        id: shiftUuid,
        business_id: String(bId || DEFAULT_BUSINESS_ID),
        usuario_id: (typeof me === "function" ? me()?.id : null) || null,
        monto_apertura: Number(closedData?.openingCash ?? currentShift.openingCash ?? 0),
        monto_cierre: isShiftOpenStatus ? null : Number(closedData?.counted ?? currentShift.counted ?? 0),
        total_efectivo: Number(closedData?.cashSales ?? currentShift.cashSales ?? 0),
        total_ventas: Number(closedData?.totalSales ?? currentShift.totalSales ?? 0),
        diferencia: Number(closedData?.difference ?? currentShift.difference ?? 0),
        estado: isShiftOpenStatus ? "abierto" : "cerrado",
        fecha_apertura: toIsoDate(closedData?.openedAt || currentShift.openedAt || Date.now()),
        fecha_cierre: isShiftOpenStatus ? null : toIsoDate(closedData?.closedAt || currentShift.lastClosedAt || currentShift.closedAt || Date.now()),
        created_at: toIsoDate(closedData?.openedAt || currentShift.openedAt || Date.now())
      };
      const { error: tcErr } = await sb.from("turnos_caja").upsert(shiftRecord, { onConflict: "id" });
      if (!tcErr) {
        console.log(`[NexoSync] ✅ Turno de caja registrado en tabla 'turnos_caja': ${shiftRecord.estado}.`);
      } else {
        console.warn("[NexoSync] ⚠️ Error en turnos_caja upsert:", tcErr.message);
      }

      // Si se cerró la caja, garantizar que cualquier turno abierto previo quede marcado como cerrado
      if (!isShiftOpenStatus) {
        await sb.from("turnos_caja").update({
          estado: "cerrado",
          fecha_cierre: toIsoDate(closedData?.closedAt || currentShift.lastClosedAt || currentShift.closedAt || Date.now())
        }).eq("business_id", bId).eq("estado", "abierto");
      }
    } catch (e) {
      /* ignore si la tabla opcional turnos_caja no existe */
    }

    return { ok: true, status: currentShift.status };
  } catch (err) {
    console.warn("[NexoSync] ⚠️ syncCashShift excepción:", err.message);
    return { ok: false, error: err.message };
  }
}

// Algoritmo hash compatible cyrb53 sin caracteres menor que
function toCyrb53Hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; str.length > i; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Actualizar el PIN de administrador en la memoria local y cache sin alterar el flujo offline
// PIN de administrador que llega de la nube (negocios.configuracion). Se aplica con la sal y el hash: el PIN en texto
// plano solo llega de filas antiguas y ya no se guarda ni se sube. Si el PIN local se cambió después (pinAt), gana el local:
// antes cada descarga devolvía el PIN de la caja al que hubiera en la nube.
function applyAdminPinLocally(pin, salt, hash, at = 0) {
  if (typeof state === "undefined" || !state) return;
  const cleanPin = pin ? String(pin).trim() : "";
  if (!cleanPin && !(salt && hash)) return;
  if (!Array.isArray(state.users)) state.users = [];

  let admin = state.users.find(u => u.role === "admin");
  if (!admin) {
    admin = {
      id: `usr_${Date.now()}`,
      name: "Administrador",
      role: "admin",
      active: true,
      createdAt: Date.now()
    };
    state.users.push(admin);
  }
  if (state.profile) { delete state.profile.admin_pin; delete state.profile.adminPin; }

  const remotoAt = Number(at) || 0;
  if ((Number(admin.pinAt) || 0) > remotoAt) return; // el PIN de esta caja es más reciente que el de la nube
  const s = salt || admin.salt || Math.random().toString(36).slice(2, 10);
  const h = (salt && hash) ? hash : toCyrb53Hash(`${s}:${cleanPin}`);
  if (admin.salt === s && admin.pinHash === h && !admin.mustChangePin) return; // sin cambios

  admin.salt = s;
  admin.pinHash = h;
  admin.mustChangePin = false;
  if (remotoAt) admin.pinAt = remotoAt;

  const pinDlg = typeof document !== "undefined" ? document.querySelector("#pinDialog") : null;
  if (pinDlg && pinDlg.open && typeof forcedPinChange !== "undefined" && !forcedPinChange) {
    try { pinDlg.close(); } catch (e) { /* ignore */ }
  }

  if (typeof renderLogin === "function") {
    try { renderLogin(); } catch (e) { /* ignore */ }
  }
  if (typeof saveState === "function") saveState();
  if (typeof scheduleSave === "function") scheduleSave();
}

// Sincronización del PIN de Administrador con Supabase (negocios.configuracion: admin_salt, admin_hash, admin_pin_at)
async function syncAdminPin(pin, user) {
  const cleanPin = String(pin || "").trim();
  const u = user || ((typeof state !== "undefined" && Array.isArray(state.users)) ? state.users.find(x => x.role === "admin") : null);
  const salt = u?.salt || Math.random().toString(36).slice(2, 10);
  const hash = toCyrb53Hash(`${salt}:${cleanPin}`);
  // setUserPin (modules.js) normalmente ya lo dejó aplicado; si no, se aplica aquí con la fecha del cambio
  if (!u || u.pinHash !== hash || u.salt !== salt) applyAdminPinLocally(cleanPin, salt, hash, Date.now());
  else if (!(Number(u.pinAt) > 0)) u.pinAt = Date.now(); // syncAdminPin solo se llama justo después de cambiar el PIN
  if (isDemoMode()) {
    console.log("[NexoSync] 🧪 Modo Demo: PIN actualizado solo localmente.");
    return { ok: true, demo: true, pin: cleanPin };
  }
  const sb = getClient();
  if (!sb || !pin) return { ok: false, error: "Cliente Supabase no disponible o PIN vacío" };
  const bId = getBusinessId();

  try {
    const prof = (typeof state !== "undefined" && state?.profile) ? state.profile : {};
    const currentShift = (typeof state !== "undefined" && state?.cashShift) ? state.cashShift : { status: "closed" };
    // configuracionNegocio: en el modo anterior conserva los pedidos actuales (antes esta escritura los borraba de la
    // nube y las otras cajas daban por cobradas sus mesas); en modo tabla no los incluye
    const updatedConfig = {
      ...configuracionNegocio(prof, { cashShift: currentShift }), // ya lleva admin_salt, admin_hash y admin_pin_at
      mustChangePin: false,
      cashShift: currentShift
    };

    const businessPayload = {
      id: String(bId || DEFAULT_BUSINESS_ID),
      nombre: prof.name || prof.nombre || "NexoPos",
      telefono: prof.phone || prof.ownerPhone || prof.telefono || "",
      configuracion: updatedConfig,
      updated_at: new Date().toISOString()
    };

    // 2. Persistir en la columna JSONB 'configuracion' (siempre compatible)
    const { error: negErr } = await actualizarNegocio(sb, businessPayload);
    if (negErr) {
      console.warn("[NexoSync] ⚠️ Error sincronizando admin_pin en negocios:", negErr.message);
      return { ok: false, error: negErr.message };
    }

    console.log("[NexoSync] ✅ PIN de administración sincronizado exitosamente en Supabase ('negocios').");
    return { ok: true, pin: cleanPin };
  } catch (err) {
    console.warn("[NexoSync] ⚠️ syncAdminPin excepción:", err.message);
    return { ok: false, error: err.message };
  }
}

// Sincronización dedicada de ventas (pushSales): contrasta ventas locales con Supabase y sube las pendientes
async function syncSales(options = {}) {
  if (isDemoMode()) {
    return { ok: true, demo: true, count: 0 };
  }
  const sb = getClient();
  if (!sb) {
    console.warn("[NexoSync] syncSales: Cliente Supabase no inicializado.");
    return { ok: false, error: "Cliente no inicializado" };
  }
  const bId = getBusinessId();
  try {
    // 1. Replicar eliminaciones de ventas pendientes hacia Supabase primero
    if (deletedSaleIds.length > 0) {
      try {
        const idsToDelete = [...deletedSaleIds];
        const { error: delErr } = await sb.from("ventas").delete().in("id", idsToDelete).eq("business_id", bId);
        if (!delErr) {
          deletedSaleIds = deletedSaleIds.filter(id => !idsToDelete.includes(id));
          saveDeletedIds();
          console.log(`[NexoSync] ✅ Eliminaciones de ventas procesadas: ${idsToDelete.length} en Supabase.`);
        }
      } catch (e) {
        /* ignore */
      }
    }

    // 2. Tomar únicamente ventas locales marcadas como nuevo_local o pending
    const rawSales = (typeof state !== "undefined" && Array.isArray(state.payments)) ? state.payments : [];
    const sales = rawSales.filter(p => options.force || isPendingSync(p));

    if (sales.length > 0) {
      console.log(`[NexoSync] 📤 Subiendo ${sales.length} ventas locales hacia Supabase...`);
      const records = sales.map(p => sanitizeVenta(p, bId));
      const deltas = await usaStockMovimientos(sb);
      stockUploads++;
      try {

      // Intento por lote primero
      const { error: saleErr } = await sb.from("ventas").upsert(records, { onConflict: "id" });

      if (!saleErr) {
        sales.forEach(markSaleUploaded);
        console.log(`[NexoSync] ✅ Ventas: ${records.length} sincronizadas por lote.`);
      } else {
        console.warn("[NexoSync] ⚠️ Error en subida por lote de ventas:", saleErr.message || saleErr);
        console.log("[NexoSync] 🔁 Reintentando subida individual para depurar cada venta...");

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; sales.length > i; i++) {
          const saleItem = sales[i];
          const singleRecord = sanitizeVenta(saleItem, bId);
          try {
            const { error: singleErr } = await sb.from("ventas").upsert(singleRecord, { onConflict: "id" });
            if (singleErr) {
              console.error(`[NexoSync] ❌ Error exacto al subir venta ID '${saleItem.id}':`, singleErr.message || singleErr, singleRecord);
              failCount++;
            } else {
              markSaleUploaded(saleItem);
              successCount++;
            }
          } catch (ex) {
            console.error(`[NexoSync] ❌ Excepción al subir venta ID '${saleItem.id}':`, ex.message, singleRecord);
            failCount++;
          }
        }

        console.log(`[NexoSync] 📊 Resultado individual: ${successCount} exitosas, ${failCount} con error.`);
        if (0 >= successCount && failCount > 0) {
          return { ok: false, count: 0, failed: failCount, error: saleErr.message };
        }
      }

      } finally {
        stockUploads--;
      }

      // Modo anterior: subir el stock absoluto de los productos incluidos en las ventas sincronizadas
      const affectedProductIds = new Set();
      sales.forEach(s => {
        if (s.sync_status === "synced" && Array.isArray(s.items)) {
          s.items.forEach(it => {
            const pid = it.productId || it.id;
            if (pid) affectedProductIds.add(String(pid));
          });
        }
      });

      if (!deltas && affectedProductIds.size > 0 && typeof state !== "undefined" && Array.isArray(state.products)) {
        const prodsToUpsert = state.products.filter(p => affectedProductIds.has(String(p.id)));
        if (prodsToUpsert.length > 0) {
          const prodRecords = prodsToUpsert.map(p => sanitizeProducto(p, bId));
          const { error: pErr } = await sb.from("productos").upsert(prodRecords, { onConflict: "id" });
          if (!pErr) {
            prodsToUpsert.forEach(p => { p.sync_status = "synced"; p.synced = true; });
            console.log(`[NexoSync] ✅ Stock en Supabase actualizado para ${prodRecords.length} productos vendidos.`);
          } else {
            console.warn("[NexoSync] ⚠️ Error actualizando stock de productos tras ventas:", pErr.message);
          }
        }
      }

      const totalOk = sales.filter(s => s.sync_status === "synced").length;
      return { ok: true, count: totalOk };
    }

    console.log("[NexoSync] ℹ️ Ventas: 0 pendientes.");
    return { ok: true, count: 0 };
  } catch (err) {
    console.warn("[NexoSync] ⚠️ Ventas excepción:", err.message);
    return { ok: false, error: err.message };
  }
}

const pushSales = syncSales;

// 4. Método global syncAll(): sincronización secuencial de todas las colecciones con console.log de resultados
async function syncAll(options = {}) {
  if (isDemoMode()) {
    updateIndicator("demo");
    return { ok: true, demo: true, synced: 0 };
  }
  if (isSyncing) return { ok: false, error: "Sync already in progress" };
  const sb = getClient();
  if (!sb) {
    console.error("[NexoSync] Error: Cliente Supabase no inicializado.");
    updateIndicator("offline");
    return { ok: false, error: "Cliente no inicializado" };
  }

  isSyncing = true;
  updateIndicator("syncing");
  const bId = getBusinessId();
  const results = {};

  console.log(`[NexoSync] 🚀 Iniciando sincronización completa para negocio: '${bId}'...`);

  // --- 0. PEDIDOS / COMANDAS Y MESAS ACTIVAS ---
  results.pedidos = await syncOrders(options);

  // --- 1. NEGOCIOS ---
  try {
    if (typeof state !== "undefined" && state?.profile && (options.force || state.profile.sync_status === "pending" || !state.profile.sync_status)) {
      const payload = sanitizeNegocio(state.profile, bId);
      const { error: profErr } = await actualizarNegocio(sb, payload);
      if (profErr) {
        console.warn("[NexoSync] ⚠️ Negocios:", profErr.message);
        results.negocios = { ok: false, error: profErr.message };
      } else {
        if (state?.profile) state.profile.sync_status = "synced";
        console.log("[NexoSync] ✅ Negocios: Sincronizado.");
        results.negocios = { ok: true };
      }
    } else {
      results.negocios = { ok: true, count: 0 };
    }
  } catch (err) {
    console.warn("[NexoSync] ⚠️ Negocios excepción:", err.message);
    results.negocios = { ok: false, error: err.message };
  }

  // --- 2. PRODUCTOS ---
  results.productos = await syncProductos(options);

  // --- 3. VENTAS (syncSales / pushSales) ---
  results.ventas = await syncSales(options);

  // --- 3b. MOVIMIENTOS DE STOCK (compras, mermas, ajustes, conteos…: la diferencia que la nube aún no tiene) ---
  results.stock = await syncStockMovements(sb, bId);

  // --- INSUMOS (catálogo, borrados y movimientos) ---
  results.insumos = await syncInsumos(sb, bId);

  // --- 4. GASTOS / COMPRAS ---
  try {
    const expensesList = (typeof state !== "undefined" && Array.isArray(state.expenses)) ? state.expenses : [];
    const purchasesList = (typeof state !== "undefined" && Array.isArray(state.purchases)) ? state.purchases : [];
    const rawExpenses = [...expensesList, ...purchasesList];
    const pendingExpenses = rawExpenses.filter(g => options.force || isPendingSync(g));
    if (pendingExpenses.length > 0) {
      const records = pendingExpenses.map(g => sanitizeGasto(g, bId));
      const { error: gastoErr } = await sb.from("gastos").upsert(records, { onConflict: "id" });
      if (gastoErr) {
        console.warn("[NexoSync] ⚠️ Gastos / Compras:", gastoErr.message);
        results.gastos = { ok: false, count: pendingExpenses.length, error: gastoErr.message };
      } else {
        pendingExpenses.forEach(g => { g.sync_status = "synced"; });
        console.log(`[NexoSync] ✅ Gastos / Compras: ${records.length} sincronizados.`);
        results.gastos = { ok: true, count: records.length };
      }
    } else {
      console.log("[NexoSync] ℹ️ Gastos / Compras: 0 pendientes.");
      results.gastos = { ok: true, count: 0 };
    }
  } catch (err) {
    console.warn("[NexoSync] ⚠️ Gastos / Compras excepción:", err.message);
    results.gastos = { ok: false, error: err.message };
  }

  // --- 5. PROVEEDORES ---
  try {
    const rawSups = (typeof state !== "undefined" && Array.isArray(state.suppliers)) ? state.suppliers : [];
    const sups = rawSups.filter(s => options.force || isPendingSync(s));
    if (sups.length > 0) {
      const records = sups.map(s => sanitizeProveedor(s, bId));
      const { error: supErr } = await sb.from("proveedores").upsert(records, { onConflict: "id" });
      if (supErr) {
        console.warn("[NexoSync] ⚠️ Proveedores:", supErr.message);
        results.proveedores = { ok: false, count: sups.length, error: supErr.message };
      } else {
        sups.forEach(s => { s.sync_status = "synced"; });
        console.log(`[NexoSync] ✅ Proveedores: ${records.length} sincronizados.`);
        results.proveedores = { ok: true, count: records.length };
      }
    } else {
      console.log("[NexoSync] ℹ️ Proveedores: 0 pendientes.");
      results.proveedores = { ok: true, count: 0 };
    }
  } catch (err) {
    console.warn("[NexoSync] ⚠️ Proveedores excepción:", err.message);
    results.proveedores = { ok: false, error: err.message };
  }

  // --- 6. MERMAS ---
  try {
    const stockLogs = (typeof state !== "undefined" && Array.isArray(state.stockLog)) ? state.stockLog : [];
    const rawMermas = stockLogs.filter(l => l.delta && String(l.delta).startsWith("-"));
    const pendingMermas = rawMermas.filter(l => options.force || isPendingSync(l));
    if (pendingMermas.length > 0) {
      const records = pendingMermas.map(l => sanitizeMerma(l, bId));
      const { error: mermaErr } = await sb.from("mermas").upsert(records, { onConflict: "id" });
      if (mermaErr) {
        console.warn("[NexoSync] ⚠️ Mermas:", mermaErr.message);
        results.mermas = { ok: false, count: pendingMermas.length, error: mermaErr.message };
      } else {
        pendingMermas.forEach(l => { l.sync_status = "synced"; });
        console.log(`[NexoSync] ✅ Mermas: ${records.length} sincronizadas.`);
        results.mermas = { ok: true, count: records.length };
      }
    } else {
      console.log("[NexoSync] ℹ️ Mermas: 0 pendientes.");
      results.mermas = { ok: true, count: 0 };
    }
  } catch (err) {
    console.warn("[NexoSync] ⚠️ Mermas excepción:", err.message);
    results.mermas = { ok: false, error: err.message };
  }

  syncState.lastSyncAt = Date.now();
  syncState.lastError = null;
  isSyncing = false;
  updateIndicator("synced");

  if (typeof scheduleSave === "function") scheduleSave();
  return results;
}

const syncData = syncAll;

// 5. Descarga e hidratación completa desde Supabase (Initial Pull / Hydration)
/* ---------- Descarga paginada ----------
   PostgREST devuelve como máximo 1000 filas por consulta. Sin paginar, una tabla grande llegaba truncada y la
   limpieza de borrados remotos eliminaba localmente lo que no vino. Se pagina por clave (id mayor que el último
   recibido), que es estable aunque otra caja inserte filas durante la descarga. */
const PULL_PAGE_SIZE = 1000;
const PULL_IN_CHUNK = 150; // ids por consulta .in(): mantiene la URL corta

async function fetchAllRows(sb, table, bId, columns = "*", desde = null) {
  const rows = [];
  let lastId = null;
  for (;;) {
    let query = sb.from(table).select(columns).eq("business_id", bId);
    if (desde) query = query.gte("fecha", desde);
    if (lastId !== null) query = query.gt("id", lastId);
    const { data, error } = await query.order("id", { ascending: true }).limit(PULL_PAGE_SIZE);
    if (error || !Array.isArray(data)) return { rows, complete: false, error: error || new Error("Respuesta inválida") };
    rows.push(...data);
    if (PULL_PAGE_SIZE > data.length) return { rows, complete: true };
    lastId = data[data.length - 1].id;
  }
}

async function fetchRowsByIds(sb, table, bId, ids) {
  const rows = [];
  for (let i = 0; ids.length > i; i += PULL_IN_CHUNK) {
    const { data, error } = await sb.from(table).select("*").eq("business_id", bId).in("id", ids.slice(i, i + PULL_IN_CHUNK));
    if (error || !Array.isArray(data)) return { rows, complete: false, error: error || new Error("Respuesta inválida") };
    rows.push(...data);
  }
  return { rows, complete: true };
}

// Tablas que crecen sin parar (ventas, gastos, mermas): primero solo la lista de ids y después, completas,
// únicamente las filas que este equipo no tiene. No depende de los relojes de las cajas.
// remoteIds solo viene si la lista de ids llegó completa: sin ella no se debe borrar nada localmente.
// desde ('AAAA-MM-DD'): solo las filas con fecha desde ese día (las ventas viejas quedan en la nube y en el archivo local).
async function fetchMissingRows(sb, table, bId, knownIds, desde = null) {
  const manifest = await fetchAllRows(sb, table, bId, "id", desde);
  if (!manifest.complete) return { rows: [], remoteIds: null, error: manifest.error };
  const remoteIds = manifest.rows.map(r => String(r.id));
  const fetched = await fetchRowsByIds(sb, table, bId, remoteIds.filter(id => !knownIds.has(id)));
  return { rows: fetched.rows, remoteIds: new Set(remoteIds), error: fetched.error };
}

async function pullAllFromSupabase(businessId) {
  if (isDemoMode()) {
    console.log("[NexoSync] 🧪 Modo Demo (Sandbox): Descarga omitida para operar 100% con datos locales.");
    updateIndicator("demo");
    return { ok: true, demo: true, count: 0 };
  }
  const sb = getClient();
  if (!sb) {
    console.warn("[NexoSync] pullAllFromSupabase: Cliente Supabase no inicializado.");
    return { ok: false, error: "Cliente no inicializado" };
  }
  const bId = businessId || getBusinessId() || DEFAULT_BUSINESS_ID;
  console.log(`[NexoSync] 📥 Iniciando descarga (pull) desde Supabase para negocio: '${bId}'...`);
  updateIndicator("syncing");

  const results = {
    negocios: 0,
    productos: 0,
    ventas: 0,
    gastos: 0,
    proveedores: 0,
    mermas: 0,
    pedidos: 0
  };
  const st = (typeof state !== "undefined" && state) ? state : null; // en pruebas de Node puede no existir

  try {
    // 1. Negocios
    try {
      const tablaPedidos = await usaTablaPedidos(sb);
      await usaStockMovimientos(sb); // antes de mezclar el stock de los productos
      const { data: negData, error: negErr } = await sb.from("negocios").select("*").eq("id", bId).maybeSingle();
      if (!negErr && negData) {
        applySubscriptionStatus(negData);
        const serverNow = await fetchServerTime(sb);
        if (serverNow && typeof registerLicenseCheck === "function") registerLicenseCheck(serverNow);
        if (typeof state !== "undefined" && state) {
          const localFloorPlan = state.profile?.floorPlan; // antes de mezclar: la configuración remota trae su propio floorPlan
          const { orders: _pedidosEnConfig, ...configSinPedidos } = negData.configuracion || {}; // los pedidos no van al perfil
          state.profile = {
            ...state.profile,
            ...configSinPedidos,
            name: negData.nombre || state.profile?.name || "NexoPos",
            phone: negData.telefono || state.profile?.phone || "",
            syncId: bId,
            sync_status: "synced"
          };
          delete state.profile.orders; // copia de pedidos que versiones anteriores dejaban en el perfil local

          // Plano de mesas: se aplica solo si el remoto es más reciente; si no, se conserva el local
          if (typeof applyRemoteFloorPlan === "function") {
            try { if (applyRemoteFloorPlan(negData.configuracion?.floorPlan, localFloorPlan) && typeof renderTables === "function") renderTables(); } catch (e) { /* ignore */ }
          }

          // Hidratar estado de apertura / cierre de caja desde la configuración remota
          if (negData.configuracion && typeof negData.configuracion.cashShift === "object" && negData.configuracion.cashShift !== null) {
            state.cashShift = negData.configuracion.cashShift;
            if (typeof renderShiftStatus === "function") {
              try { renderShiftStatus(); } catch (e) { /* ignore */ }
            }
          }

          // Hidratar comandas / pedidos activos desde la configuración remota (solo en el modo anterior: con la tabla de
          // pedidos, lo que quede en configuracion.orders es una copia vieja y podría resucitar mesas ya cobradas)
          if (!tablaPedidos && negData.configuracion && Array.isArray(negData.configuracion.orders)) {
            mergeRemoteOrders(negData.configuracion.orders);
            results.pedidos = negData.configuracion.orders.length;
          }

          // Centralización y descarga del PIN de Administrador desde Supabase
          const cfgPin = negData.configuracion || {};
          const remotePin = negData.admin_pin || cfgPin.admin_pin || cfgPin.adminPin; // solo filas antiguas
          if (remotePin || (cfgPin.admin_salt && cfgPin.admin_hash)) {
            applyAdminPinLocally(remotePin, cfgPin.admin_salt, cfgPin.admin_hash, cfgPin.admin_pin_at);
          }

          results.negocios = 1;
        }
      }

      // Consulta prioritaria a tabla turnos_caja en Supabase
      try {
        const { data: openShiftRows, error: sErr } = await sb
          .from("turnos_caja")
          .select("*")
          .eq("business_id", bId)
          .eq("estado", "abierto")
          .order("created_at", { ascending: false })
          .limit(1);

        if (!sErr && typeof state !== "undefined" && state) {
          if (Array.isArray(openShiftRows) && openShiftRows.length > 0) {
            const latestShift = openShiftRows[0];
            const shiftOpenedAt = new Date(latestShift.fecha_apertura || latestShift.created_at || Date.now()).getTime();
            const localClosedAt = Number(state.cashShift?.lastClosedAt || 0);
            if (state.cashShift?.status === "closed" && localClosedAt >= shiftOpenedAt) {
              // El cierre local es más reciente que la apertura remota: mantener caja cerrada
            } else {
              state.cashShift = {
                id: latestShift.id,
                status: "open",
                openingCash: Number(latestShift.monto_apertura ?? latestShift.opening_cash ?? 0),
                openedAt: shiftOpenedAt,
                date: (latestShift.fecha_apertura || latestShift.created_at || new Date().toISOString()).slice(0, 10)
              };
            }
          } else {
            // Si no hay un turno abierto en Supabase para el negocio, el estado debe ser 'Caja cerrada'
            state.cashShift = { status: "closed", lastClosedAt: Date.now() };
          }
          if (typeof renderShiftStatus === "function") {
            try { renderShiftStatus(); } catch (e) { /* ignore */ }
          }
          if (typeof renderStats === "function") {
            try { renderStats(); } catch (e) { /* ignore */ }
          }
        }
      } catch (e) {
        /* ignore si la tabla opcional turnos_caja no existe */
      }

      // Consulta prioritaria a tabla pedidos_activos en Supabase
      try {
        const { data: actRows, error: actErr } = await sb.from("pedidos_activos").select("*").eq("business_id", bId);
        if (!actErr && Array.isArray(actRows)) {
          const mappedOrders = actRows.map(filaAPedido);
          mergeRemoteOrders(mappedOrders);
          results.pedidos = Math.max(Number(results.pedidos || 0), mappedOrders.length);
        }
      } catch (e) {
        /* ignore si no existe tabla pedidos_activos */
      }
    } catch (e) {
      console.warn("[NexoSync] Error descargando negocio:", e.message);
    }

    // 2. Productos
    try {
      // Catálogo completo (tabla pequeña), paginado: si no llega entero no se toca, para no borrar productos locales
      const { rows: prodData, complete: prodComplete, error: prodErr } = await fetchAllRows(sb, "productos", bId);
      if (prodErr) console.warn("[NexoSync] Error descargando productos:", prodErr.message);
      if (prodComplete) {
        if (typeof state !== "undefined" && state) {
          if (!Array.isArray(state.products)) state.products = [];
          if (!Array.isArray(state.inventory)) state.inventory = [];
          if (!Array.isArray(state.categories)) state.categories = [];

          // Limpiar productos demo antiguos si existen
          const isLegacyDemo = state.products.length > 0 &&
            state.products.every(p => p.id && String(p.id).startsWith("p") && 5 > String(p.id).length) &&
            (!state.payments || state.payments.length === 0) &&
            (!state.purchases || state.purchases.length === 0);

          if (isLegacyDemo) {
            state.products = [];
            state.inventory = [];
          }

          // Eliminar localmente los productos que fueron borrados en Supabase (si no estan pendientes de subida)
          const remoteProdIds = new Set(prodData.map(p => String(p.id)));
          state.products = state.products.filter(p => isPendingSync(p) || remoteProdIds.has(String(p.id)));
          const validInvIds = new Set(state.products.map(p => p.inventoryId).filter(Boolean));
          state.inventory = state.inventory.filter(i => validInvIds.has(i.id));

          prodData.forEach(p => {
            if (deletedProductIds.includes(String(p.id))) {
              return; // Ignorar producto eliminado localmente
            }
            const cloudStock = Number(p.stock ?? 0);
            const invId = `stock-${p.id}`;
            const existingProd = state.products.find(x => x.id === p.id);
            const currentStock = existingProd ? remoteStock(existingProd, cloudStock) : cloudStock;

            if (existingProd) {
              existingProd.name = p.nombre || existingProd.name;
              existingProd.category = p.categoria || existingProd.category;
              existingProd.price = Number(p.precio ?? existingProd.price ?? 0);
              existingProd.cost = Number(p.costo ?? existingProd.cost ?? 0);
              existingProd.stock = currentStock;
              existingProd.active = p.activo !== false;
              existingProd.updated_at = toIsoDate(p.updated_at);
              existingProd.sync_status = "synced";
            } else {
              state.products.push({
                id: String(p.id),
                name: p.nombre || "Producto",
                category: p.categoria || "Otros",
                price: Number(p.precio ?? 0),
                cost: Number(p.costo ?? 0),
                stock: currentStock,
                icon: "🍺",
                image: null,
                inventoryId: invId,
                recipe: { [invId]: 1 },
                active: p.activo !== false,
                createdAt: toIsoDate(p.created_at),
                created_at: toIsoDate(p.created_at),
                updated_at: toIsoDate(p.updated_at),
                ...(stockMode === true ? { stockSynced: cloudStock } : {}),
                sync_status: "synced"
              });
            }

            if (aplicarRecetaRemota(existingProd || state.products.find(x => x.id === String(p.id)), p)) {
              if (p.categoria && !state.categories.includes(p.categoria)) state.categories.push(p.categoria);
              return;
            }

            // Sincronizar insumo de inventario local correspondiente
            let invItem = state.inventory.find(i => i.id === (existingProd?.inventoryId || invId)) || state.inventory.find(i => i.id === invId);
            if (invItem) {
              invItem.name = p.nombre || invItem.name;
              invItem.qty = currentStock;
              invItem.min = Number(p.min_stock ?? invItem.min ?? 5);
            } else {
              state.inventory.push({
                id: invId,
                name: p.nombre || "Producto",
                unit: "und",
                qty: currentStock,
                min: Number(p.min_stock ?? 5)
              });
            }

            if (p.categoria && !state.categories.includes(p.categoria)) {
              state.categories.push(p.categoria);
            }
          });
          results.productos = prodData.length;
        }
      }
    } catch (e) {
      console.warn("[NexoSync] Error descargando productos:", e.message);
    }

    // 2b. Insumos (catálogo y stock)
    try {
      results.insumos = await pullInsumos(sb, bId);
    } catch (e) {
      console.warn("[NexoSync] Error descargando insumos:", e.message);
    }

    // 3. Ventas
    try {
      if (typeof state !== "undefined" && state && !Array.isArray(state.payments)) state.payments = [];
      const knownSaleIds = new Set([...(st?.payments || []).map(p => String(p.id)), ...deletedSaleIds.map(String)]);
      // Solo la ventana que la caja mantiene en memoria (storage.js): las ventas anteriores ya están en el archivo
      // local o, en un equipo nuevo, se quedan en la nube. Sin storage.js (pruebas de Node) se descarga todo.
      const ventanaVentas = typeof historialVentanaDesde === "function" ? historialVentanaDesde() : null;
      const { rows: salesData, remoteIds: remoteSaleIds, error: salesErr } = await fetchMissingRows(sb, "ventas", bId, knownSaleIds, ventanaVentas);
      if (salesErr) console.warn("[NexoSync] Error descargando ventas:", salesErr.message);
      if (remoteSaleIds) {
        if (typeof state !== "undefined" && state) {
          // Eliminar localmente las ventas que fueron borradas en Supabase (si no estan pendientes).
          // Solo con la lista de ids completa: una lista parcial borraría ventas que sí existen.
          // Una venta anterior a la ventana no viene en la lista: no se toca
          state.payments = state.payments.filter(p => isPendingSync(p) || remoteSaleIds.has(String(p.id)) || (ventanaVentas && !(p.date >= ventanaVentas)));
          state.payments.forEach(p => {
            if (remoteSaleIds.has(String(p.id))) { p.sync_status = "synced"; p.synced = true; }
          });

          // Índices por id: con miles de ventas, buscar con find/includes dentro del forEach congela la pestaña
          const deletedSales = new Set(deletedSaleIds.map(String));
          const salesById = new Map(state.payments.map(p => [String(p.id), p]));
          salesData.forEach(v => {
            if (deletedSales.has(String(v.id))) {
              return; // Ignorar venta eliminada localmente
            }
            const existingSale = salesById.get(String(v.id));
            if (existingSale) {
              existingSale.sync_status = "synced";
              existingSale.synced = true;
            } else {
              const parsedDate = v.fecha ? String(v.fecha).slice(0, 10) : (typeof today === "function" ? today() : new Date().toISOString().slice(0, 10));
              state.payments.push({
                id: String(v.id),
                orderId: String(v.order_id || v.id),
                amount: Number(v.total ?? 0),
                method: v.method || "Efectivo",
                payments: Array.isArray(v.payments) ? v.payments : [],
                items: Array.isArray(v.items) ? v.items : [],
                customer: v.customer || "",
                cashierName: v.cashier || "",
                shiftId: String(v.shift_id || ""),
                date: parsedDate,
                paidAt: new Date(v.created_at || v.fecha || Date.now()).getTime(),
                createdAt: new Date(v.created_at || v.fecha || Date.now()).getTime(),
                created_at: toIsoDate(v.created_at || v.fecha),
                updated_at: toIsoDate(v.updated_at),
                sync_status: "synced",
                synced: true
              });
              salesById.set(String(v.id), state.payments[state.payments.length - 1]);
            }
          });
          results.ventas = salesData.length; // filas nuevas descargadas (las ya conocidas solo viajan como id)
        }
      }
    } catch (e) {
      console.warn("[NexoSync] Error descargando ventas:", e.message);
    }

    // 4. Gastos / Compras
    try {
      const knownGastoIds = new Set([...(st?.expenses || []), ...(st?.purchases || [])].map(g => String(g.id)));
      const { rows: gastosData, error: gastosErr } = await fetchMissingRows(sb, "gastos", bId, knownGastoIds);
      if (gastosErr) console.warn("[NexoSync] Error descargando gastos:", gastosErr.message);
      if (gastosData.length > 0) {
        if (typeof state !== "undefined" && state) {
          if (!Array.isArray(state.expenses)) state.expenses = [];
          if (!Array.isArray(state.purchases)) state.purchases = [];

          const purchaseIds = new Set(state.purchases.map(p => String(p.id)));
          const expenseIds = new Set(state.expenses.map(e => String(e.id)));
          gastosData.forEach(g => {
            const isPurchase = Boolean(g.proveedor_id || String(g.id).startsWith("pur-") || String(g.categoria).startsWith("Compra"));
            const parsedDate = g.fecha ? String(g.fecha).slice(0, 10) : (typeof today === "function" ? today() : new Date().toISOString().slice(0, 10));

            if (isPurchase) {
              if (!purchaseIds.has(String(g.id))) {
                purchaseIds.add(String(g.id));
                state.purchases.push({
                  id: String(g.id),
                  invoice: String(g.comprobante || ""),
                  supplier: String(g.descripcion || "Proveedor"),
                  supplierId: g.proveedor_id ? String(g.proveedor_id) : null,
                  date: parsedDate,
                  method: "Efectivo",
                  lines: [],
                  total: Number(g.monto ?? 0),
                  createdAt: new Date(g.created_at || g.fecha || Date.now()).getTime(),
                  created_at: toIsoDate(g.created_at || g.fecha),
                  updated_at: toIsoDate(g.updated_at),
                  sync_status: "synced"
                });
              }
            } else {
              if (!expenseIds.has(String(g.id))) {
                expenseIds.add(String(g.id));
                state.expenses.push({
                  id: String(g.id),
                  category: String(g.categoria || "Gasto operativo"),
                  description: String(g.descripcion || "Gasto registrado"),
                  amount: Number(g.monto ?? 0),
                  method: "Efectivo",
                  date: parsedDate,
                  createdAt: new Date(g.created_at || g.fecha || Date.now()).getTime(),
                  created_at: toIsoDate(g.created_at || g.fecha),
                  updated_at: toIsoDate(g.updated_at),
                  sync_status: "synced"
                });
              }
            }
          });
          results.gastos = gastosData.length;
        }
      }
    } catch (e) {
      console.warn("[NexoSync] Error descargando gastos:", e.message);
    }

    // 5. Proveedores
    try {
      const { rows: provData, error: provErr } = await fetchAllRows(sb, "proveedores", bId);
      if (provErr) console.warn("[NexoSync] Error descargando proveedores:", provErr.message);
      if (provData.length > 0) {
        if (typeof state !== "undefined" && state) {
          if (!Array.isArray(state.suppliers)) state.suppliers = [];
          provData.forEach(s => {
            const existing = state.suppliers.find(x => x.id === s.id);
            if (existing) {
              existing.name = s.nombre || existing.name;
              existing.phone = s.telefono || existing.phone;
              existing.nit = s.contacto || existing.nit;
              existing.address = s.direccion || existing.address;
              existing.notes = s.notas || existing.notes;
              existing.email = s.email || existing.email;
              existing.sync_status = "synced";
            } else {
              state.suppliers.push({
                id: String(s.id),
                name: s.nombre || "Proveedor",
                phone: s.telefono || "",
                nit: s.contacto || "",
                address: s.direccion || "",
                notes: s.notas || "",
                email: s.email || "",
                createdAt: toIsoDate(s.created_at),
                created_at: toIsoDate(s.created_at),
                updated_at: toIsoDate(s.updated_at),
                sync_status: "synced"
              });
            }
          });
          results.proveedores = provData.length;
        }
      }
    } catch (e) {
      console.warn("[NexoSync] Error descargando proveedores:", e.message);
    }

    // 6. Mermas
    try {
      const knownMermaIds = new Set((st?.stockLog || []).map(l => String(l.id)));
      const { rows: mermaData, error: mermaErr } = await fetchMissingRows(sb, "mermas", bId, knownMermaIds);
      if (mermaErr) console.warn("[NexoSync] Error descargando mermas:", mermaErr.message);
      if (mermaData.length > 0) {
        if (typeof state !== "undefined" && state) {
          if (!Array.isArray(state.stockLog)) state.stockLog = [];
          const stockLogIds = new Set(state.stockLog.map(l => String(l.id)));
          mermaData.forEach(m => {
            if (!stockLogIds.has(String(m.id))) {
              stockLogIds.add(String(m.id));
              const parsedDate = m.fecha ? String(m.fecha).slice(0, 10) : (typeof today === "function" ? today() : new Date().toISOString().slice(0, 10));
              state.stockLog.push({
                id: String(m.id),
                at: new Date(m.fecha || m.created_at || Date.now()).getTime(),
                date: parsedDate,
                type: "merma",
                reasonCategory: m.motivo || "Rotura / Merma",
                reason: m.motivo || "Rotura / Merma",
                itemId: String(m.producto_id || ""),
                itemName: String(m.producto_nombre || "Producto"),
                delta: -Math.abs(Number(m.cantidad || 1)),
                note: String(m.observacion || ""),
                sync_status: "synced"
              });
            }
          });
          results.mermas = mermaData.length;
        }
      }
    } catch (e) {
      console.warn("[NexoSync] Error descargando mermas:", e.message);
    }

    // Persistir estado en IndexedDB / localStorage inmediatamente
    if (typeof scheduleSave === "function") scheduleSave();
    if (typeof persistNow === "function") {
      try { await persistNow(); } catch (e) { /* ignore */ }
    }

    syncState.lastSyncAt = Date.now();
    syncState.lastError = null;
    updateIndicator("synced");

    const totalCount = results.negocios + results.productos + results.ventas + results.gastos + results.proveedores + results.mermas + (results.pedidos || 0);
    console.log(`[NexoSync] 📥 Descarga completada: ${totalCount} registros procesados.`, results);

    if (typeof renderShiftStatus === "function") {
      try { renderShiftStatus(); } catch (e) { /* ignore */ }
    }
    if (typeof renderTables === "function") {
      try { renderTables(); } catch (e) { /* ignore */ }
    }
    if (typeof renderStats === "function") {
      try { renderStats(); } catch (e) { /* ignore */ }
    }
    if (typeof renderAll === "function") {
      try { renderAll(); } catch (e) { /* ignore */ }
    }

    return { ok: true, count: totalCount, details: results };
  } catch (err) {
    console.error("[NexoSync] Error en pullAllFromSupabase:", err);
    updateIndicator("offline");
    return { ok: false, error: err.message };
  }
}

function setupRealtime() {
  if (isDemoMode()) return;
  const sb = getClient();
  if (!sb || typeof sb.channel !== "function") return;
  try {
    if (realtimeChannel) {
      sb.removeChannel(realtimeChannel);
    }
    const bId = getBusinessId();
    realtimeChannel = sb.channel(`nexopos_rt_${bId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ventas", filter: `business_id=eq.${bId}` }, payload => {
        if (payload?.new) {
          const sale = payload.new;
          if (typeof state !== "undefined" && Array.isArray(state.payments)) {
            if (!state.payments.some(p => p.id === sale.id)) {
              state.payments.unshift({
                id: sale.id,
                orderId: sale.order_id,
                amount: sale.total,
                method: sale.method,
                payments: sale.payments || [],
                items: sale.items || [],
                customer: sale.customer,
                cashierName: sale.cashier,
                shiftId: sale.shift_id,
                paidAt: new Date(sale.created_at || Date.now()).getTime(),
                createdAt: new Date(sale.created_at || Date.now()).getTime(),
                date: sale.fecha ? String(sale.fecha).slice(0, 10) : new Date().toISOString().slice(0, 10),
                sync_status: "synced"
              });

              // El stock no se descuenta aquí: la caja que vendió sube el stock final de cada producto y llega en el evento
              // de productos (descontar también aquí lo restaba dos veces si ese evento llegaba primero)

              if (typeof scheduleSave === "function") scheduleSave();
              if (typeof renderAll === "function") renderAll();
              if (typeof showToast === "function") {
                const moneyFmt = typeof money !== "undefined" ? money.format(sale.total) : `$${sale.total}`;
                showToast(`🔔 Venta registrada en vivo: ${moneyFmt}`);
              }
            }
          }
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "insumos", filter: `business_id=eq.${bId}` }, payload => {
        if (!payload?.new?.id) return;
        aplicarInsumoRemoto(payload.new);
        if (typeof refreshPreparedCosts === "function") refreshPreparedCosts();
        if (typeof scheduleSave === "function") scheduleSave();
        if (typeof renderAll === "function") renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "productos", filter: `business_id=eq.${bId}` }, payload => {
        if (payload?.new) {
          const p = payload.new;
          if (typeof state !== "undefined" && Array.isArray(state.products)) {
            const existing = state.products.find(x => x.id === p.id);
            const cloudStock = Number(p.stock ?? 0);
            const currentStock = existing ? remoteStock(existing, cloudStock) : cloudStock;
            const invId = `stock-${p.id}`;

            if (existing) {
              existing.name = p.nombre || existing.name;
              existing.category = p.categoria || existing.category;
              existing.price = Number(p.precio ?? existing.price ?? 0);
              existing.cost = Number(p.costo ?? existing.cost ?? 0);
              existing.stock = currentStock;
              existing.active = p.activo !== false;
              existing.updated_at = toIsoDate(p.updated_at);
              existing.sync_status = "synced";
            } else {
              state.products.push({
                id: String(p.id),
                name: p.nombre || "Producto",
                category: p.categoria || "Otros",
                price: Number(p.precio ?? 0),
                cost: Number(p.costo ?? 0),
                stock: currentStock,
                icon: "🍺",
                image: null,
                inventoryId: invId,
                recipe: { [invId]: 1 },
                active: p.activo !== false,
                createdAt: toIsoDate(p.created_at),
                created_at: toIsoDate(p.created_at),
                updated_at: toIsoDate(p.updated_at),
                ...(stockMode === true ? { stockSynced: cloudStock } : {}),
                sync_status: "synced"
              });
            }

            const preparado = aplicarRecetaRemota(existing || state.products.find(x => x.id === String(p.id)), p);
            if (!preparado && Array.isArray(state.inventory)) {
              let invItem = state.inventory.find(i => i.id === (existing?.inventoryId || invId)) || state.inventory.find(i => i.id === invId);
              if (invItem) {
                invItem.name = p.nombre || invItem.name;
                invItem.qty = currentStock;
                invItem.min = Number(p.min_stock ?? invItem.min ?? 5);
              } else {
                state.inventory.push({
                  id: invId,
                  name: p.nombre || "Producto",
                  unit: "und",
                  qty: currentStock,
                  min: Number(p.min_stock ?? 5)
                });
              }
            }

            if (typeof scheduleSave === "function") scheduleSave();
            if (typeof renderAll === "function") renderAll();
          }
        } else if (payload?.eventType === "DELETE" && payload?.old?.id) {
          if (typeof state !== "undefined" && Array.isArray(state.products)) {
            state.products = state.products.filter(x => x.id !== payload.old.id);
            if (typeof scheduleSave === "function") scheduleSave();
            if (typeof renderAll === "function") renderAll();
          }
        } else {
          pullAllFromSupabase();
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "negocios", filter: `id=eq.${bId}` }, payload => {
        if (payload?.new) {
          const row = payload.new;
          if (typeof state !== "undefined" && state) {
            if (row.nombre && state.profile) state.profile.name = row.nombre;
            if (row.telefono && state.profile) state.profile.phone = row.telefono;
            // Licencia en vivo: el superadmin suspendió, renovó o cambió el plan
            applySubscriptionStatus(row);

            // Sincronización en vivo del PIN de administración
            const cfgPin = row.configuracion || {};
            const newAdminPin = row.admin_pin || cfgPin.admin_pin || cfgPin.adminPin; // solo filas antiguas
            if (newAdminPin || (cfgPin.admin_salt && cfgPin.admin_hash)) {
              applyAdminPinLocally(newAdminPin, cfgPin.admin_salt, cfgPin.admin_hash, cfgPin.admin_pin_at);
            }

            const remoteShift = row.configuracion?.cashShift;
            if (remoteShift && typeof remoteShift === "object") {
              state.cashShift = remoteShift;
              if (typeof renderShiftStatus === "function") {
                try { renderShiftStatus(); } catch (e) { /* ignore */ }
              }
              if (typeof renderStats === "function") {
                try { renderStats(); } catch (e) { /* ignore */ }
              }
              if (typeof renderAll === "function") {
                try { renderAll(); } catch (e) { /* ignore */ }
              }
              if (typeof scheduleSave === "function") scheduleSave();
              if (typeof showToast === "function") {
                const isOpen = remoteShift.status === "open";
                showToast(isOpen ? "🟢 Turno de caja abierto en vivo" : "🔴 Turno de caja cerrado en vivo");
              }
            }

            // Plano de mesas editado en otra caja
            if (typeof applyRemoteFloorPlan === "function" && row.configuracion?.floorPlan) {
              try {
                if (applyRemoteFloorPlan(row.configuracion.floorPlan)) {
                  if (typeof scheduleSave === "function") scheduleSave();
                  if (typeof renderAll === "function") renderAll();
                }
              } catch (e) { /* ignore */ }
            }

            // Sincronización en vivo de comandas y mesas activas (modo anterior; con la tabla de pedidos llegan por pedidos_activos)
            const remoteOrders = row.configuracion?.orders;
            if (ordersTableMode !== true && Array.isArray(remoteOrders)) {
              mergeRemoteOrders(remoteOrders);
              if (typeof scheduleSave === "function") scheduleSave();
              if (typeof renderTables === "function") try { renderTables(); } catch (e) {}
              if (typeof renderStats === "function") try { renderStats(); } catch (e) {}
              if (typeof renderAll === "function") try { renderAll(); } catch (e) {}
            }
          }
        }
      })
      // Pedidos en vivo: cada evento trae un solo pedido. (El manejador anterior lo fusionaba como si fuera la lista
      // completa y daba por cobradas todas las demás mesas abiertas de esta caja.)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "pedidos_activos", filter: `business_id=eq.${bId}` }, payload => aplicarPedidoEnVivo(payload))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pedidos_activos", filter: `business_id=eq.${bId}` }, payload => aplicarPedidoEnVivo(payload))
      // Supabase no filtra los DELETE: llegan solo con el id (con RLS) y se ignoran si no son de esta caja
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "pedidos_activos" }, payload => retirarPedidoEnVivo(payload?.old?.id))
      .on("postgres_changes", { event: "*", schema: "public", table: "turnos_caja", filter: `business_id=eq.${bId}` }, payload => {
        if (typeof state !== "undefined" && state) {
          if (payload?.eventType === "DELETE" || (!payload?.new && payload?.old)) {
            state.cashShift = { status: "closed", lastClosedAt: Date.now() };
          } else if (payload?.new) {
            const row = payload.new;
            const st = String(row.estado || row.status || "closed").toLowerCase();
            const isOpen = (st === "abierto" || st === "open");
            state.cashShift = {
              id: row.id,
              status: isOpen ? "open" : "closed",
              openingCash: Number(row.monto_apertura ?? row.opening_cash ?? 0),
              openedAt: new Date(row.fecha_apertura || row.created_at || Date.now()).getTime(),
              closedAt: row.fecha_cierre ? new Date(row.fecha_cierre).getTime() : null,
              date: (row.fecha_apertura || row.created_at || new Date().toISOString()).slice(0, 10)
            };
          }
          if (typeof scheduleSave === "function") scheduleSave();
          if (typeof renderShiftStatus === "function") renderShiftStatus();
          if (typeof renderStats === "function") renderStats();
          if (typeof renderAll === "function") renderAll();
        }
      })
      .subscribe();
  } catch (e) {
    console.debug("[NexoSync] Realtime no disponible:", e.message);
  }
}

// 6. Forzar re-sincronización total: contrasta todas las ventas locales con Supabase y sube de inmediato las faltantes
async function forceSyncAll() {
  console.log("[NexoSync] 🔄 Iniciando Forzar Re-sincronización Total...");
  if (typeof showToast === "function") {
    showToast("Revisando ventas locales y contrastando con Supabase...");
  }
  const ok = await checkInitialConnection();
  if (!ok) {
    if (typeof showToast === "function") {
      showToast("⚠️ Modo Offline: sin conexión a Supabase.");
    }
    return { ok: false, error: "Sin conexión" };
  }

  // 1. Marcar registros locales para forzar revisión y subida
  if (typeof state !== "undefined" && state) {
    if (Array.isArray(state.payments)) {
      state.payments.forEach(p => { p.sync_status = "pending"; p.synced = false; });
    }
    if (Array.isArray(state.products)) {
      state.products.forEach(p => { p.sync_status = "pending"; p.synced = false; });
    }
    if (Array.isArray(state.expenses)) {
      state.expenses.forEach(e => { e.sync_status = "pending"; e.synced = false; });
    }
    if (Array.isArray(state.purchases)) {
      state.purchases.forEach(pur => { pur.sync_status = "pending"; pur.synced = false; });
    }
  }

  // 2. Subida forzada completa (Push): syncAll({ force: true }) contrasta IDs y sube todas las ventas pendientes
  const pushRes = await syncAll({ force: true });

  // 3. Sincronizar inmediatamente el estado actual de la caja
  if (typeof state !== "undefined" && state?.cashShift) {
    await syncCashShift(state.cashShift);
  }

  // 4. Descargar últimos cambios remotos (Pull)
  const pullRes = await pullAllFromSupabase();

  const totalVentas = (typeof state !== "undefined" && Array.isArray(state.payments)) ? state.payments.length : 0;
  const pushedVentas = pushRes?.ventas?.count ?? 0;
  console.log(`[NexoSync] 🏁 Re-sincronización completada. Ventas locales: ${totalVentas}, ventas subidas: ${pushedVentas}.`);

  if (typeof showToast === "function") {
    showToast(`✅ Re-sincronización total lista: ${totalVentas} ventas verificadas, ${pullRes?.count ?? 0} registros en total.`);
  }

  return { ok: true, pushedVentas, pullCount: pullRes?.count ?? 0 };
}

const triggerBidirectionalSync = forceSyncAll;

function init() {
  if (isDemoMode()) {
    updateIndicator("demo");
    console.log("[NexoSync] 🧪 Modo Demo Local (Sandbox) activado. Base de datos de produccion protegida contra escrituras.");
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("click", (e) => {
        if (e.target.closest("#syncStatusIndicator") || e.target.closest("#syncBadgeTopbar") || e.target.closest("#syncNowButton")) {
          e.preventDefault();
          if (typeof showToast === "function") {
            showToast("Modo Demo activo: Opera 100% en este navegador para proteger el sistema real.");
          }
        }
        if (e.target.closest("#pullFromCloudButton") || e.target.closest("#sidebarPullButton")) {
          e.preventDefault();
          if (typeof showToast === "function") {
            showToast("Modo Demo activo: Las funciones en la nube estan desactivadas en esta version web.");
          }
        }
      });
    }
    return;
  }
  // Sin terminal vinculada no arranca el ciclo. La llamada automática de DOMContentLoaded llega antes de que
  // bootstrap() cargue el estado y se omite; bootstrap() vuelve a llamar a init() tras cargar/activar.
  if (!isTerminalLinked()) {
    updateIndicator("offline");
    return;
  }
  updateIndicator(typeof navigator !== "undefined" && navigator.onLine ? "syncing" : "offline");

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", () => {
      syncState.online = true;
      updateIndicator("syncing");
      checkInitialConnection().then(ok => {
        if (ok) {
          scheduleSync(300);
          setupRealtime();
        }
      });
    });

    window.addEventListener("offline", () => {
      syncState.online = false;
      updateIndicator("offline");
    });
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", async (e) => {
      // Sin sesión (vencida o caja vinculada antes de Supabase Auth): en vez de sincronizar como 'anon',
      // el indicador y los botones de nube piden volver a vincular la terminal.
      const cloudTarget = e.target.closest("#syncStatusIndicator, #syncBadgeTopbar, #syncNowButton, #pullFromCloudButton, #sidebarPullButton");
      if (cloudTarget && !(await hasAuthSession())) {
        e.preventDefault();
        updateIndicator("auth");
        if (typeof relinkTerminal === "function") relinkTerminal();
        return;
      }
      if (e.target.closest("#syncStatusIndicator") || e.target.closest("#syncBadgeTopbar") || e.target.closest("#syncNowButton")) {
        e.preventDefault();
        const btn = e.target.closest("button") || e.target.closest("div");
        if (btn) btn.classList.add("is-syncing");
        try {
          await forceSyncAll();
        } finally {
          if (btn) btn.classList.remove("is-syncing");
        }
      }
      if (e.target.closest("#pullFromCloudButton") || e.target.closest("#sidebarPullButton")) {
        e.preventDefault();
        const btn = e.target.closest("button");
        if (btn) btn.disabled = true;
        if (typeof showToast === "function") {
          showToast("Descargando datos desde Supabase...");
        }
        try {
          const res = await pullAllFromSupabase();
          if (res?.ok) {
            if (typeof showToast === "function") {
              showToast(`✅ Descarga completada: ${res.count} registros.`);
            }
            const statusEl = document.querySelector("#cloudSyncStatus");
            if (statusEl) {
              statusEl.textContent = `Última descarga: ${new Date().toLocaleTimeString("es-CO")} (${res.count} registros sincronizados).`;
            }
          } else {
            if (typeof showToast === "function") {
              showToast("⚠️ Error al descargar: " + (res?.error || "Revisa tu conexión"));
            }
          }
        } catch (err) {
          if (typeof showToast === "function") {
            showToast("Error en descarga: " + err.message);
          }
        } finally {
          if (btn) btn.disabled = false;
        }
      }
    });
  }

  // Sondeo periódico cada 30 segundos (Push de pendientes + Pull de cambios remotos)
  clearInterval(pingTimer);
  pingTimer = setInterval(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      const ok = await checkInitialConnection();
      if (ok) {
        if (countPendingRecords() > 0) {
          await syncAll();
        }
        await pullAllFromSupabase();
      }
    }
  }, 30000);

  // Inicialización y descarga al arrancar la aplicación
  setTimeout(async () => {
    const ok = await checkInitialConnection();
    if (ok) {
      // (Ya no se sube el PIN al arrancar: reescribía la configuración de la nube con la de esta caja antes de descargar
      // los cambios de las demás. El PIN se sube al cambiarlo, en syncAdminPin.)
      if (countPendingRecords() > 0) {
        await syncAll();
      }
      await pullAllFromSupabase();
      setupRealtime();
    }
  }, 300);
}

// Inicialización segura al cargar. Con los scripts en defer el estado ya es "interactive" pero DOMContentLoaded aún no
// se disparó: se espera igual al evento para que init() corra después de app.js y no dos veces (bootstrap la repite)
if (typeof document !== "undefined") {
  if (document.readyState !== "complete") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 100);
  }
}

// Exportación global en window y globalThis
const rootScope = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this);
rootScope.NexoSync = {
  isDemoMode: () => globalThis.isDemoMode(),
  getClient,
  activateTerminal,
  requestRecoveryCode,
  changeTemporaryPassword,
  confirmRecoveryCode,
  isTerminalLinked,
  hasAuthSession,
  signOutTerminal,
  applySubscriptionStatus,
  init,
  syncAll,
  syncData,
  syncSale,
  syncSales,
  pushSales,
  syncOrders,
  deleteActiveOrder,
  toValidUuid,
  mergeRemoteOrders,
  syncCashShift,
  syncAdminPin,
  applyAdminPinLocally,
  syncProductos,
  pullAllFromSupabase,
  forceSyncAll,
  triggerBidirectionalSync,
  scheduleSync,
  checkInitialConnection,
  toIsoDate,
  toValidISOString,
  trackProductDeletion,
  deleteProduct,
  deleteSale,
  getBusinessId,
  getStatus: () => ({ ...syncState }),
  getPendingCount: countPendingRecords,
  pendingSummary,
  stockItemsQty,
  addSaleStockDelta,
  syncStockMovements,
  remoteStock,
  syncInsumos,
  pullInsumos,
  aplicarInsumoRemoto,
  aplicarRecetaRemota,
  SUPABASE_URL,
  SUPABASE_KEY: SUPABASE_ANON_KEY,
  SUPABASE_ANON_KEY
};
if (typeof module !== "undefined" && module.exports) {
  module.exports = rootScope.NexoSync;
}
