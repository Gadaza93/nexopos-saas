// Auditoría del esquema Supabase contra lo que espera sync.js.
// Uso: node scratch/audit-supabase-schema.js [--solo-lectura]
//
// - Lee SUPABASE_URL y SUPABASE_ANON_KEY directamente de sync.js.
// - Comprueba conexión, existencia de cada tabla y de cada columna (vía PostgREST).
// - Sin --solo-lectura, verifica permisos RLS con una fila de prueba
//   (business_id "__nexopos_audit__") que se inserta, actualiza, lee y elimina.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const syncSrc = fs.readFileSync(path.join(__dirname, "..", "sync.js"), "utf8");
const SUPABASE_URL = syncSrc.match(/const SUPABASE_URL = "([^"]+)"/)[1];
const SUPABASE_KEY = syncSrc.match(/const SUPABASE_ANON_KEY = "([^"]+)"/)[1];
const READ_ONLY = process.argv.includes("--solo-lectura");
const AUDIT_BID = "__nexopos_audit__";
const now = new Date().toISOString();

// Columnas que envía/lee sync.js por tabla. "opcional": sync.js ignora errores de esa tabla.
const PROBE_PRODUCT_ID = `audit_prod_${Date.now()}`;
const TABLES = {
  negocios: {
    required: true,
    cols: ["id", "nombre", "telefono", "configuracion", "created_at", "updated_at"],
    optionalCols: ["admin_pin"],
    sample: () => ({ id: AUDIT_BID, nombre: "Auditoría", telefono: "", configuracion: { orders: [], cashShift: { status: "closed" } }, created_at: now, updated_at: now }),
    key: "id",
    scoped: false
  },
  productos: {
    required: true,
    cols: ["id", "business_id", "nombre", "categoria", "precio", "costo", "stock", "min_stock", "activo", "created_at", "updated_at"],
    sample: () => ({ id: PROBE_PRODUCT_ID, business_id: AUDIT_BID, nombre: "Prueba", categoria: "Otros", precio: 1000, costo: 500, stock: 1, min_stock: 5, activo: true, created_at: now, updated_at: now })
  },
  ventas: {
    required: true,
    cols: ["id", "business_id", "order_id", "total", "method", "payments", "metodos_pago", "items", "customer", "cashier", "cajero", "shift_id", "fecha", "created_at", "updated_at"],
    sample: () => {
      const pays = [{ method: "Efectivo", amount: 1000 }];
      return { id: `audit_pay_${Date.now()}`, business_id: AUDIT_BID, order_id: "audit_order", total: 1000, method: "Efectivo", payments: pays, metodos_pago: pays, items: [{ name: "Prueba", qty: 1, price: 1000 }], customer: "", cashier: "Auditoría", cajero: "Auditoría", shift_id: "", fecha: now, created_at: now, updated_at: now };
    }
  },
  gastos: {
    required: true,
    cols: ["id", "business_id", "categoria", "descripcion", "monto", "comprobante", "proveedor_id", "fecha", "created_at", "updated_at"],
    sample: () => ({ id: `audit_gasto_${Date.now()}`, business_id: AUDIT_BID, categoria: "Gasto operativo", descripcion: "Prueba", monto: 1000, comprobante: "", proveedor_id: null, fecha: now, created_at: now, updated_at: now })
  },
  proveedores: {
    required: true,
    cols: ["id", "business_id", "nombre", "telefono", "contacto", "direccion", "notas", "email", "created_at", "updated_at"],
    sample: () => ({ id: `audit_prov_${Date.now()}`, business_id: AUDIT_BID, nombre: "Prueba", telefono: "", contacto: "", direccion: "", notas: "", email: "", created_at: now, updated_at: now })
  },
  mermas: {
    required: true,
    cols: ["id", "business_id", "producto_id", "producto_nombre", "cantidad", "motivo", "observacion", "fecha", "created_at", "updated_at"],
    sample: () => ({ id: `audit_merma_${Date.now()}`, business_id: AUDIT_BID, producto_id: PROBE_PRODUCT_ID, producto_nombre: "Prueba", cantidad: 1, motivo: "Rotura / Merma", observacion: "", fecha: now, created_at: now, updated_at: now })
  },
  turnos_caja: {
    required: false,
    cols: ["id", "business_id", "usuario_id", "monto_apertura", "monto_cierre", "total_efectivo", "total_ventas", "diferencia", "estado", "fecha_apertura", "fecha_cierre", "created_at"],
    sample: () => ({ id: crypto.randomUUID(), business_id: AUDIT_BID, usuario_id: null, monto_apertura: 0, monto_cierre: null, total_efectivo: 0, total_ventas: 0, diferencia: 0, estado: "abierto", fecha_apertura: now, fecha_cierre: null, created_at: now }),
    patch: { estado: "cerrado", fecha_cierre: now }
  },
  pedidos_activos: {
    required: false,
    cols: ["id", "business_id", "mesa_id", "nombre_mesa", "cliente", "items", "subtotal", "total", "estado", "tipo", "created_at", "updated_at"],
    sample: () => ({ id: crypto.randomUUID(), business_id: AUDIT_BID, mesa_id: "walkin", nombre_mesa: "Venta en barra", cliente: "", items: [{ name: "Prueba", qty: 1, price: 1000 }], subtotal: 1000, total: 1000, estado: "abierto", tipo: "barra", created_at: now, updated_at: now })
  }
};

const baseHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

async function rest(method, pathAndQuery, { body, prefer } = {}) {
  const headers = { ...baseHeaders };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, ok: res.ok, data: json };
}

const errMsg = r => (r.data && (r.data.message || r.data.hint)) || `HTTP ${r.status}`;
const isMissingTable = r => r.data && (r.data.code === "PGRST205" || r.data.code === "42P01");
const isMissingColumn = r => r.data && (r.data.code === "42703" || r.data.code === "PGRST204");
const isRlsDenied = r => r.data && (r.data.code === "42501" || /row-level security|permission denied/i.test(r.data.message || ""));

async function checkConnection() {
  try {
    const r = await rest("GET", "productos?select=id&limit=1");
    return { ok: r.ok || isMissingTable(r), detail: r.ok ? `HTTP ${r.status}` : errMsg(r) };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function auditTable(name, def) {
  const out = { name, required: def.required, exists: false, missingCols: [], missingOptional: [], rows: null, rls: {}, notes: [] };
  const probe = await rest("GET", `${name}?select=*&limit=0`, { prefer: "count=exact" });
  if (isMissingTable(probe)) { out.notes.push("La tabla no existe"); return out; }
  if (!probe.ok) { out.notes.push(`SELECT denegado: ${errMsg(probe)}`); out.rls.select = false; return out; }
  out.exists = true;
  out.rls.select = true;

  const scopeFilter = def.scoped === false ? "" : `&business_id=eq.nexopos_default`;
  const cnt = await rest("GET", `${name}?select=id${scopeFilter}&limit=1`, { prefer: "count=exact" });
  if (cnt.ok) out.rows = Array.isArray(cnt.data) ? cnt.data.length : 0;

  for (const col of [...def.cols, ...(def.optionalCols || [])]) {
    const r = await rest("GET", `${name}?select=${col}&limit=0`);
    if (!r.ok) {
      if (def.cols.includes(col)) out.missingCols.push(col);
      else out.missingOptional.push(col);
    }
  }
  return out;
}

async function auditWrites(name, def, result) {
  if (!result.exists || result.missingCols.length) return;
  const key = def.key || "id";
  const row = def.sample();
  const idQ = `${key}=eq.${encodeURIComponent(row[key])}`;

  // INSERT (upsert de fila nueva, igual que sync.js)
  const ins = await rest("POST", `${name}?on_conflict=${key}`, { body: [row], prefer: "resolution=merge-duplicates,return=representation" });
  result.rls.insert = ins.ok;
  if (!ins.ok) {
    result.notes.push(`INSERT: ${isRlsDenied(ins) ? "bloqueado por RLS" : errMsg(ins)}`);
    return;
  }
  if (Array.isArray(ins.data) && ins.data.length === 0) result.notes.push("INSERT ok pero la fila no es visible (política SELECT restringida)");

  // UPSERT sobre fila existente (ruta ON CONFLICT DO UPDATE)
  const ups = await rest("POST", `${name}?on_conflict=${key}`, { body: [{ ...row, ...(def.patch || {}) }], prefer: "resolution=merge-duplicates,return=representation" });
  result.rls.upsert = ups.ok && !(Array.isArray(ups.data) && ups.data.length === 0);
  if (!ups.ok) result.notes.push(`UPSERT: ${isRlsDenied(ups) ? "bloqueado por RLS (falta política UPDATE)" : errMsg(ups)}`);

  // UPDATE directo (sync.js lo usa en turnos_caja)
  if (def.patch) {
    const upd = await rest("PATCH", `${name}?${idQ}`, { body: def.patch, prefer: "return=representation" });
    result.rls.update = upd.ok && Array.isArray(upd.data) && upd.data.length > 0;
    if (!result.rls.update) result.notes.push(`UPDATE: ${upd.ok ? "0 filas afectadas (RLS)" : errMsg(upd)}`);
  }

  // DELETE (sync.js borra productos, ventas y pedidos_activos)
  const del = await rest("DELETE", `${name}?${idQ}`, { prefer: "return=representation" });
  result.rls.delete = del.ok && Array.isArray(del.data) && del.data.length > 0;
  if (!result.rls.delete) {
    result.notes.push(`DELETE: ${del.ok ? "0 filas borradas (RLS) — queda fila de prueba" : errMsg(del)} [${key}=${row[key]}]`);
  }
}

const mark = v => (v === true ? "✔" : v === false ? "✘" : "·");

(async () => {
  console.log(`\nAuditoría Supabase · ${SUPABASE_URL}`);
  console.log(`Modo: ${READ_ONLY ? "solo lectura" : "lectura + escritura con fila de prueba"}\n`);

  const conn = await checkConnection();
  console.log(`Conexión: ${conn.ok ? "OK" : "FALLÓ"} (${conn.detail})`);
  if (!conn.ok) process.exit(1);

  const results = [];
  // productos antes que mermas (posible FK producto_id)
  for (const [name, def] of Object.entries(TABLES)) {
    const r = await auditTable(name, def);
    if (!READ_ONLY) await auditWrites(name, def, r);
    results.push(r);
  }
  // Limpieza del negocio de prueba al final (por si otras tablas lo referencian)
  if (!READ_ONLY) await rest("DELETE", `negocios?id=eq.${AUDIT_BID}`);

  console.log("\nTabla              Tipo       Existe  Columnas         SEL INS UPS UPD DEL  Filas(nexopos_default)");
  console.log("─".repeat(100));
  for (const r of results) {
    const cols = !r.exists ? "—" : r.missingCols.length ? `faltan ${r.missingCols.length}` : "completas";
    console.log(
      `${r.name.padEnd(18)} ${(r.required ? "requerida" : "opcional").padEnd(10)} ${(r.exists ? "sí" : "NO").padEnd(7)} ${cols.padEnd(16)} ` +
      ` ${mark(r.rls.select)}   ${mark(r.rls.insert)}   ${mark(r.rls.upsert)}   ${mark(r.rls.update)}   ${mark(r.rls.delete)}   ${r.rows == null ? "—" : r.rows ? "≥1" : "0"}`
    );
  }

  console.log("\nDetalles:");
  let issues = 0;
  for (const r of results) {
    const lines = [];
    if (r.missingCols.length) lines.push(`columnas faltantes: ${r.missingCols.join(", ")}`);
    if (r.missingOptional.length) lines.push(`columnas opcionales ausentes: ${r.missingOptional.join(", ")}`);
    lines.push(...r.notes);
    if (lines.length) {
      issues += r.required || r.exists ? lines.length : 0;
      console.log(`  • ${r.name}${r.required ? "" : " (opcional)"}: ${lines.join(" | ")}`);
    }
  }
  if (!issues) console.log("  Sin problemas.");
  console.log("\nLeyenda: ✔ permitido · ✘ denegado/falló · · no probado");
})();
