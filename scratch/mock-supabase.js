// scratch/mock-supabase.js
// Cliente Supabase simulado en memoria para las pruebas de scratch/ (no toca la base real).
// Imita la API de supabase-js que usa sync.js (from/select/eq/in/order/limit/single/maybeSingle,
// insert/upsert/update/delete, auth, rpc, channel) y el RLS de producción:
//   - Sin sesión (rol 'anon')  → "permission denied for table X" (42501).
//   - Con sesión 'authenticated' → solo ve y escribe filas de su app_metadata.business_id
//     (columna `id` en negocios, `business_id` en el resto).
//
// Uso:
//   const { createMockSupabase } = require('./mock-supabase.js');
//   const sb = createMockSupabase({ businessId: 'nexopos_default', seed: { productos: [...] } });
//   pedidosConMeta: true simula la migración de pedidos_activos (columna meta). Sin ella, como el esquema actual,
//   leer o escribir una columna inexistente de pedidos_activos devuelve el error de PostgREST.
//   stockMovimientos: true simula supabase/sql/2026-10-28_stock_por_movimientos.sql (tabla movimientos_stock y los
//   triggers ventas_stock y movimientos_stock_aplicar). Sin ella la tabla no existe, como antes de aplicar el SQL.
//   global.supabase = { createClient: () => sb };

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const scopeColumn = table => (table === 'negocios' ? 'id' : 'business_id');
const denied = table => ({ code: '42501', message: `permission denied for table ${table}`, details: null, hint: null });
// negocios como en producción: las cajas no crean filas y solo actualizan nombre y configuracion (permisos por columna)
const NEGOCIOS_ACTUALIZABLES = ['nombre', 'configuracion'];
const sinPermiso = table => ({ code: '42501', message: `permission denied for table ${table}`, details: null, hint: null });
// Columnas conocidas por tabla (solo se valida pedidos_activos, la que cambia con la migración)
const PEDIDOS_COLS = ['id', 'business_id', 'mesa_id', 'nombre_mesa', 'cliente', 'items', 'subtotal', 'total', 'estado', 'tipo', 'created_at', 'updated_at'];
const rlsViolation = table => ({ code: '42501', message: `new row violates row-level security policy for table "${table}"`, details: null, hint: null });

// Cantidades por producto de los ítems de una venta (igual que ventas_cantidades en SQL: productId o id; qty no numérica = 0)
function cantidadesVenta(items) {
  const out = {};
  (Array.isArray(items) ? items : []).forEach(it => {
    const id = it && (it.productId ?? it.id);
    const q = typeof it?.qty === 'number' ? it.qty : /^-?[0-9]+(\.[0-9]+)?$/.test(String(it?.qty)) ? Number(it.qty) : 0;
    if (id != null) out[id] = (out[id] || 0) + q;
  });
  return out;
}

function createMockSupabase({ businessId = 'nexopos_default', authenticated = true, seed = {}, rpc = {}, pedidosConMeta = false, stockMovimientos = false } = {}) {
  const tables = {};
  const esquema = { pedidos_activos: pedidosConMeta ? [...PEDIDOS_COLS, 'meta'] : PEDIDOS_COLS };
  const columnaInexistente = (table, cols) => (esquema[table] ? cols.find(c => !esquema[table].includes(c)) : null);
  for (const [name, rows] of Object.entries(seed)) tables[name] = clone(rows);
  // Como en producción, la fila del negocio de la sesión ya existe (la crea el SuperAdmin con admin_create_negocio)
  if (businessId && !(tables.negocios || []).some(n => String(n.id) === String(businessId))) (tables.negocios = tables.negocios || []).push({ id: businessId, nombre: 'Negocio', telefono: '', configuracion: {}, activo: true });
  const tableRows = name => (tables[name] = tables[name] || []);

  let session = authenticated ? makeSession(businessId) : null;
  function makeSession(bId) {
    return { access_token: `mock-jwt-${bId}`, token_type: 'bearer', user: { id: `user-${bId}`, email: `${bId}@test.local`, app_metadata: { business_id: bId }, user_metadata: {} } };
  }
  const currentBusiness = () => session?.user?.app_metadata?.business_id || null;

  // Triggers de stock (solo con stockMovimientos)
  let movSeq = 0;
  function aplicarMovimiento(mov) { // movimientos_stock_aplicar
    const p = tableRows('productos').find(r => String(r.id) === String(mov.producto_id) && String(r.business_id) === String(mov.business_id));
    if (p) p.stock = Math.round((Number(p.stock || 0) + Number(mov.delta)) * 1000) / 1000;
  }
  function ventasStock(venta, itemsAnteriores) { // ventas_stock
    const nuevos = cantidadesVenta(venta.items), viejos = cantidadesVenta(itemsAnteriores);
    new Set([...Object.keys(nuevos), ...Object.keys(viejos)]).forEach(id => {
      const delta = (viejos[id] || 0) - (nuevos[id] || 0);
      if (!delta || !tableRows('productos').some(p => String(p.id) === id && String(p.business_id) === String(venta.business_id))) return;
      const mov = { id: `venta:${venta.id}:${id}:${++movSeq}`, business_id: venta.business_id, producto_id: id, delta, motivo: itemsAnteriores ? 'venta editada' : 'venta' };
      tableRows('movimientos_stock').push(mov); aplicarMovimiento(mov);
    });
  }

  function query(table) {
    const state = { action: 'select', filters: [], order: null, limit: null, single: null, head: false, count: null, returning: false, payload: null, onConflict: 'id', ignoreDuplicates: false, columns: '*' };
    const matches = row => state.filters.every(([op, col, val]) => {
      const cell = row[col];
      switch (op) {
        case 'eq': return String(cell) === String(val);
        case 'neq': return String(cell) !== String(val);
        case 'in': return val.map(String).includes(String(cell));
        case 'is': return cell === val || (val === null && cell == null);
        case 'gt': return cell > val;
        case 'gte': return cell >= val;
        case 'lt': return cell < val;
        case 'lte': return cell <= val;
        default: return true;
      }
    });

    function execute() {
      const bId = currentBusiness();
      if (!bId) return { data: null, error: denied(table), count: null };
      if (table === 'movimientos_stock' && !stockMovimientos) return { data: null, error: { code: '42P01', message: 'relation "public.movimientos_stock" does not exist' }, count: null };
      if (table === 'movimientos_stock' && (state.action === 'update' || state.action === 'delete')) return { data: null, error: denied(table), count: null };
      const col = scopeColumn(table), rows = tableRows(table);
      const visible = rows.filter(row => String(row[col]) === String(bId));

      if (table === 'negocios' && (state.action === 'upsert' || state.action === 'insert')) return { data: null, error: sinPermiso(table), count: null };
      if (table === 'negocios' && state.action === 'update' && Object.keys(state.payload || {}).some(k => !NEGOCIOS_ACTUALIZABLES.includes(k))) return { data: null, error: sinPermiso(table), count: null };
      if (state.action === 'upsert' || state.action === 'insert') {
        const records = Array.isArray(state.payload) ? state.payload : [state.payload];
        const falta = columnaInexistente(table, [...new Set(records.flatMap(r => Object.keys(r || {})))]);
        if (falta) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${falta}' column of '${table}' in the schema cache` }, count: null };
        if (records.some(r => String(r[col]) !== String(bId))) return { data: null, error: rlsViolation(table), count: null };
        const written = records.map(record => {
          const key = state.onConflict;
          const existing = state.action === 'upsert' ? rows.find(row => String(row[key]) === String(record[key])) : null;
          if (existing && String(existing[col]) !== String(bId)) return null; // fila de otro negocio: invisible
          if (existing && state.ignoreDuplicates) return existing; // on conflict do nothing: el trigger no se repite
          const anteriores = existing ? clone(existing.items) : undefined;
          let row;
          if (existing) { Object.assign(existing, clone(record)); row = existing; } else { row = clone(record); rows.push(row); }
          if (stockMovimientos && table === 'ventas' && (!existing || 'items' in record)) ventasStock(row, existing ? anteriores || [] : undefined);
          if (stockMovimientos && table === 'movimientos_stock' && !existing) aplicarMovimiento(row);
          return row;
        });
        if (written.includes(null)) return { data: null, error: rlsViolation(table), count: null };
        return { data: state.returning ? clone(written) : null, error: null, count: null };
      }
      if (state.action === 'update') {
        if (state.payload && col in state.payload && String(state.payload[col]) !== String(bId)) return { data: null, error: rlsViolation(table), count: null };
        const updated = visible.filter(matches);
        updated.forEach(row => Object.assign(row, clone(state.payload)));
        return { data: state.returning ? clone(updated) : null, error: null, count: null };
      }
      if (state.action === 'delete') {
        const removed = visible.filter(matches);
        tables[table] = rows.filter(row => !removed.includes(row));
        return { data: state.returning ? clone(removed) : null, error: null, count: null };
      }

      // select
      const faltaSel = state.columns === '*' ? null : columnaInexistente(table, state.columns.split(',').map(s => s.trim()));
      if (faltaSel) return { data: null, error: { code: '42703', message: `column ${table}.${faltaSel} does not exist` }, count: null };
      let result = visible.filter(matches);
      if (state.order) {
        const { col: orderCol, ascending } = state.order;
        result = [...result].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : a[orderCol] < b[orderCol] ? -1 : 0) * (ascending ? 1 : -1));
      }
      if (state.limit != null) result = result.slice(0, state.limit);
      const count = state.count ? result.length : null;
      if (state.head) return { data: null, error: null, count };
      if (state.single) {
        if (result.length === 1) return { data: clone(result[0]), error: null, count };
        if (result.length === 0 && state.single === 'maybe') return { data: null, error: null, count };
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, count };
      }
      return { data: clone(result), error: null, count };
    }

    const builder = {
      select(cols = '*', opts = {}) {
        if (state.action === 'select') { state.head = Boolean(opts.head); state.count = opts.count || null; state.columns = cols; } else state.returning = true;
        return builder;
      },
      insert(payload) { state.action = 'insert'; state.payload = payload; return builder; },
      upsert(payload, opts = {}) { state.action = 'upsert'; state.payload = payload; state.onConflict = opts.onConflict || 'id'; state.ignoreDuplicates = Boolean(opts.ignoreDuplicates); return builder; },
      update(payload) { state.action = 'update'; state.payload = payload; return builder; },
      delete() { state.action = 'delete'; return builder; },
      eq(col, val) { state.filters.push(['eq', col, val]); return builder; },
      neq(col, val) { state.filters.push(['neq', col, val]); return builder; },
      in(col, vals) { state.filters.push(['in', col, vals || []]); return builder; },
      is(col, val) { state.filters.push(['is', col, val]); return builder; },
      gt(col, val) { state.filters.push(['gt', col, val]); return builder; },
      gte(col, val) { state.filters.push(['gte', col, val]); return builder; },
      lt(col, val) { state.filters.push(['lt', col, val]); return builder; },
      lte(col, val) { state.filters.push(['lte', col, val]); return builder; },
      order(col, opts = {}) { state.order = { col, ascending: opts.ascending !== false }; return builder; },
      limit(n) { state.limit = n; return builder; },
      single() { state.single = 'one'; return Promise.resolve(execute()); },
      maybeSingle() { state.single = 'maybe'; return Promise.resolve(execute()); },
      then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); }
    };
    return builder;
  }

  // Tiempo real: guarda los manejadores para que las pruebas emitan eventos con __emitir(tabla, evento, payload)
  const manejadores = [];
  const channel = { on(_tipo, filtro, cb) { manejadores.push({ filtro: filtro || {}, cb }); return channel; }, subscribe(cb) { if (typeof cb === 'function') cb('SUBSCRIBED'); return channel; }, unsubscribe() { return Promise.resolve('ok'); } };

  return {
    from: query,
    rpc: async (name, params) => (rpc[name] ? rpc[name](params, { session, tables }) : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } }),
    channel: () => channel,
    removeChannel: async () => 'ok',
    auth: {
      getSession: async () => ({ data: { session: clone(session) }, error: null }),
      getUser: async () => ({ data: { user: clone(session?.user) || null }, error: null }),
      signInWithPassword: async () => ({ data: { user: clone(session?.user) || null, session: clone(session) }, error: session ? null : { message: 'Invalid login credentials' } }),
      signOut: async () => { session = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    // Ayudas solo para pruebas
    __tables: tables,
    __setSession(bId) { session = bId ? makeSession(bId) : null; },
    __emitir(table, eventType, payload) {
      manejadores.filter(m => m.filtro.table === table && (m.filtro.event === '*' || m.filtro.event === eventType)).forEach(m => m.cb({ eventType, ...payload }));
    },
    __manejadores: manejadores
  };
}

module.exports = { createMockSupabase };
