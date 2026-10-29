// scratch/audit-security-and-bugs.js
// Auditoría de seguridad, bugs y consistencia financiera sobre los módulos REALES de NexoPos.
// No es una prueba de regresión: cada vector reporta SEGURO o VULNERABLE con su gravedad. Sale con código 1 si hay
// hallazgos Críticos/Altos abiertos (útil para CI una vez corregidos). No toca Supabase ni archivos del usuario.
//
//   node scratch/audit-security-and-bugs.js
//
// Áreas: (1) Electron/escritorio · (2) Secretos y Supabase · (3) Integridad financiera y carreras de sincronización
//        (4) XSS en POS, facturas, tickets y panel admin.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const results = [];
const asyncChecks = []; // comprobaciones asíncronas: se ejecutan antes de imprimir el reporte
function check(area, severity, vector, vulnerable, detail = '') {
  results.push({ area, severity, vector, vulnerable: Boolean(vulnerable), detail });
}
function safely(fn) { try { return fn(); } catch (error) { return { __error: String(error && error.message || error) }; } }

/* =====================================================================================
   Entorno: los scripts reales cargados en un contexto vm con un DOM mínimo que guarda innerHTML
   ===================================================================================== */
function createEnv() {
  const els = {};
  const mk = sel => ({
    __sel: sel, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, getAttribute: () => null,
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, closest: () => null, select() {},
    querySelector: () => mk(sel + ' *'), querySelectorAll: () => [], append() {}, appendChild() {}, remove() {}, matches: () => false, insertAdjacentHTML(_p, html) { this.innerHTML += html; }
  });
  const document = {
    querySelector: sel => (els[sel] = els[sel] || mk(sel)), querySelectorAll: () => [], getElementById: id => (els['#' + id] = els['#' + id] || mk('#' + id)),
    addEventListener() {}, createElement: tag => mk('<' + tag + '>'), body: mk('body'), documentElement: mk('html'), visibilityState: 'visible',
    head: mk('head')
  };
  const mem = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} }, document, window: { location: { search: '' }, addEventListener() {}, confirm: () => true, open: () => null },
    navigator: { onLine: false }, localStorage: mem(), sessionStorage: mem(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    structuredClone, Intl, crypto: globalThis.crypto, URLSearchParams, URL, __IS_NODE_TEST__: true
  };
  ctx.globalThis = ctx; ctx.window.document = document;
  vm.createContext(ctx);
  for (const file of ['demo-mode.js', 'storage.js', 'modules.js', 'sync.js', 'print.js', 'app.js']) vm.runInContext(read(file), ctx, { filename: file });
  const run = code => vm.runInContext(code, ctx);
  const get = code => { const json = run(`JSON.stringify(${code})`); return json === undefined ? undefined : JSON.parse(json); };
  run(`var __toasts = []; showToast = m => __toasts.push(String(m)); renderAll = renderAll; saveState = () => {};
       globalThis.NexoSync = Object.assign(window.NexoSync || {}, { syncOrders: async () => {}, deleteActiveOrder: async () => {}, scheduleSync() {} });`);
  return { ctx, els, run, get };
}

/* =====================================================================================
   1. ELECTRON / ESCRITORIO
   ===================================================================================== */
const mainFiles = ['main.js', 'electron/main.js'];
for (const file of mainFiles) {
  const src = read(file);
  const mainPrefs = src.slice(src.indexOf('function createWindow'));
  check('Electron', 'Crítica', `${file}: contextIsolation/sandbox/nodeIntegration en la ventana principal`,
    !/contextIsolation: true/.test(mainPrefs) || !/sandbox: true/.test(mainPrefs) || !/nodeIntegration: false/.test(mainPrefs));
  check('Electron', 'Crítica', `${file}: webSecurity desactivado o contenido inseguro permitido`, /webSecurity:\s*false|allowRunningInsecureContent:\s*true|webviewTag:\s*true/.test(src));
  check('Electron', 'Media', `${file}: sin manejador de permisos (cámara, micrófono, ubicación, notificaciones se conceden por defecto)`, !/setPermissionRequestHandler/.test(src));
  const printHandler = src.slice(src.indexOf("ipcMain.handle('print:receipt'"), src.indexOf("ipcMain.handle('print:listPrinters'"));
  check('Electron', 'Baja', `${file}: nombre del archivo temporal del ticket con Math.random (predecible) y escritura sin 'wx' (sigue enlaces/sobrescribe)`,
    /Math\.random\(\)/.test(printHandler) && !/flag:\s*'wx'|mkdtemp|randomUUID|randomBytes/.test(printHandler));
  check('Electron', 'Media', `${file}: impresión sin tiempo límite (si el controlador nunca responde, la ventana oculta y la petición IPC quedan colgadas)`,
    !/setTimeout|timeout/i.test(printHandler));
  const senderGuard = /function fromMainWindow|const fromMainWindow = event =>[^\n]*event\.sender === win\.webContents/.test(src) && /if \(!fromMainWindow\(event\)\)/.test(printHandler);
  check('Electron', 'Baja', `${file}: el canal print:receipt no valida el remitente (solo la ventana principal puede imprimir)`, !senderGuard && !/senderFrame|sender\.id|event\.sender/.test(printHandler));
  // Invariante: openExternal solo dentro de openWhatsApp (o tras isWhatsAppUrl en la misma línea), y openWhatsApp solo tras isWhatsAppUrl
  const externalCalls = src.split('\n').filter(l => /shell\.openExternal\(/.test(l));
  const unguardedExternal = externalCalls.filter(l => !/^function openWhatsApp\(/.test(l.trim()) && !/isWhatsAppUrl\(url\)\) shell\.openExternal\(/.test(l));
  const unguardedOpenWa = src.split('\n').filter(l => /openWhatsApp\(/.test(l) && !/^function openWhatsApp\(/.test(l.trim()) && !/isWhatsAppUrl\(url\)\) openWhatsApp\(url\)/.test(l));
  check('Electron', 'Alta', `${file}: shell.openExternal fuera de la regla isWhatsAppUrl`, unguardedExternal.length > 0 || unguardedOpenWa.length > 0,
    [...unguardedExternal, ...unguardedOpenWa].map(l => l.trim().slice(0, 80)).join(' | '));
  // isWhatsAppUrl con URLs adversarias
  const fnSrc = src.slice(src.indexOf('function isWhatsAppUrl('), src.indexOf('function createWindow('));
  const wctx = { URL }; vm.createContext(wctx); vm.runInContext(fnSrc, wctx);
  const evil = ['file:///C:/Windows/System32/cmd.exe', 'cmd:calc', 'ms-msdt:/id', 'javascript:alert(1)', 'http://wa.me/57300', 'https://wa.me.evil.com/x', 'https://wa.me@evil.com/', 'https://evil.com/?https://wa.me/',
    'https://wa.me:443@evil.com', 'https://WA.ME.evil.com', 'https://xn--wa-me.com', 'smb://evil/share', 'data:text/html,<script>1</script>', '\\\\evil\\share\\x.exe'];
  const accepted = evil.filter(u => wctx.isWhatsAppUrl(u));
  check('Electron', 'Crítica', `${file}: isWhatsAppUrl rechaza ${evil.length} URLs/esquemas adversarios (file:, cmd:, ms-msdt:, javascript:, smb:, dominios parecidos…)`, accepted.length > 0, accepted.join(' '));
  // 'https://wa.me\\@evil.com' NO es un hallazgo: con barra invertida el host real es wa.me (WHATWG trata «\» como «/»).
  // Endurecimiento: abrir la URL normalizada en lugar de la cadena original.
  check('Electron', 'Baja', `${file}: shell.openExternal recibe la URL original en vez de la normalizada (new URL(url).href)`, /shell\.openExternal\(url\)/.test(src));
  check('Electron', 'Media', `${file}: will-navigate bloquea toda navegación, incluido el «Probar Modo Demo» de la activación (location.assign → ?demo=true)`,
    /will-navigate', \(event, url\) => \{ event\.preventDefault\(\);/.test(src) && /location\.assign\(url\.href\)/.test(read('app.js')));
}
for (const file of ['preload.js', 'electron/preload.js']) {
  const src = read(file);
  check('Electron', 'Alta', `${file}: expone ipcRenderer o require completos al renderer`, /exposeInMainWorld\([^)]*ipcRenderer\s*[,)]|ipcRenderer:\s*ipcRenderer|require:\s*require/.test(src));
}
const indexHtml = read('index.html'), adminHtml = read('admin.html');
const remoteScripts = [indexHtml, adminHtml].flatMap(h => h.match(/<script[^>]+src="https?:[^"]*"/gi) || []);
const vendored = fs.existsSync(path.join(ROOT, 'supabase.min.js')) && /^var supabase=/.test(read('supabase.min.js').slice(0, 20));
const swSrc = read('service-worker.js'), buildFiles = JSON.parse(read('package.json')).build.files;
check('Electron/Web', 'Alta', 'supabase-js empaquetado localmente con versión fija (sin <script> remotos ni carga dinámica desde CDN; incluido en service worker e instalador)',
  remoteScripts.length > 0 || /cdn\.jsdelivr|unpkg\.com/.test(read('sync.js')) || !vendored || !swSrc.includes("'./supabase.min.js'") || !buildFiles.includes('supabase.min.js'),
  [remoteScripts.join(' '), !vendored && 'falta supabase.min.js', !swSrc.includes("'./supabase.min.js'") && 'no está en ASSETS', !buildFiles.includes('supabase.min.js') && 'no está en build.files'].filter(Boolean).join(' · '));
const cspOf = html => (html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i) || [])[1] || '';
const cspIssues = [['index.html', indexHtml], ['admin.html', adminHtml]].flatMap(([name, html]) => {
  const csp = cspOf(html), script = (csp.match(/script-src([^;]*)/) || [])[1] || '';
  if (!csp) return [`${name}: sin CSP`];
  return [
    /'unsafe-inline'|'unsafe-eval'/.test(script) && `${name}: script-src permite inline/eval`,
    /https?:|\*/.test(script) && `${name}: script-src permite hosts externos`,
    !/object-src 'none'/.test(csp) && `${name}: falta object-src 'none'`,
    !/default-src 'self'/.test(csp) && `${name}: falta default-src 'self'`,
    html.indexOf('Content-Security-Policy') > html.indexOf('<script') && `${name}: la CSP va después de un script`
  ].filter(Boolean);
});
check('Electron/Web', 'Media', 'index.html/admin.html: Content-Security-Policy estricta (scripts solo propios, sin inline/eval, object-src none) antes de cualquier script',
  cspIssues.length > 0, cspIssues.join(' · '));
// Fuses: el gancho afterPack debe apagarlos y, si hay un ejecutable compilado, se leen los grabados en NexoPos.exe
const pkgBuild = JSON.parse(read('package.json')).build || {};
const fuseHookPath = pkgBuild.afterPack ? path.join(ROOT, pkgBuild.afterPack) : '';
const fuseHook = fuseHookPath && fs.existsSync(fuseHookPath) ? fs.readFileSync(fuseHookPath, 'utf8') : '';
const hookOk = /FuseV1Options\.RunAsNode\]: false/.test(fuseHook) && /FuseV1Options\.EnableNodeOptionsEnvironmentVariable\]: false/.test(fuseHook);
asyncChecks.push(async () => {
  const exe = path.join(ROOT, 'dist', 'win-unpacked', 'NexoPos.exe');
  let wireDetail = 'sin ejecutable compilado: solo se revisó la configuración', wireOk = true;
  if (fs.existsSync(exe)) {
    const { getCurrentFuseWire, FuseV1Options, FuseState } = require(require.resolve('@electron/fuses', { paths: [ROOT] }));
    const wire = await getCurrentFuseWire(exe), state = o => (wire[o] === FuseState.ENABLE ? 'on' : wire[o] === FuseState.DISABLE ? 'off' : String(wire[o]));
    const want = { RunAsNode: 'off', EnableNodeOptionsEnvironmentVariable: 'off', EnableNodeCliInspectArguments: 'off', OnlyLoadAppFromAsar: 'on', EnableEmbeddedAsarIntegrityValidation: 'on' };
    const got = Object.fromEntries(Object.keys(want).map(k => [k, state(FuseV1Options[k])]));
    wireOk = Object.keys(want).every(k => got[k] === want[k]);
    wireDetail = `NexoPos.exe: ${Object.entries(got).map(([k, v]) => `${k}=${v}`).join(', ')}`;
  }
  check('Electron', 'Baja', 'Fuses de Electron: RunAsNode, NODE_OPTIONS e --inspect desactivados; solo app.asar con integridad (configuración y NexoPos.exe compilado)',
    !hookOk || !wireOk, wireDetail);
});

// Desinfección del HTML del ticket (print.js)
const print = require(path.join(ROOT, 'print.js'));
const XSS = '<img src=x onerror=alert(1)>';
const ticket = print.buildReceiptHtml({ invoiceNo: XSS, customer: XSS, cashierName: XSS, waiterName: XSS, method: XSS, amount: 1000,
  payments: [{ method: XSS, amount: 1000 }], items: [{ name: XSS, qty: 1, price: 1000 }] }, { profile: { name: XSS, nit: XSS, address: XSS, phone: XSS, image: 'javascript:alert(1)' } });
const z = print.buildShiftZHtml({ closedBy: XSS }, { profile: { name: XSS, image: 'x" onerror="alert(1)' } });
check('Tickets', 'Alta', 'print.js: texto del negocio, cliente, cajero, productos y medios de pago escapado en ticket y Ticket Z',
  [ticket, z].some(h => h.includes('<img src=x') || /onerror="alert/.test(h) || h.includes('javascript:')));

/* =====================================================================================
   2. SECRETOS Y SUPABASE
   ===================================================================================== */
const SECRET = /service_role|sb_secret_[A-Za-z0-9_-]+|eyJhbGciOi[A-Za-z0-9_.-]{20,}/;
const clientFiles = ['app.js', 'modules.js', 'sync.js', 'storage.js', 'print.js', 'admin.js', 'index.html', 'admin.html', 'main.js', 'preload.js', 'electron/main.js', 'electron/preload.js', 'package.json'];
check('Supabase', 'Crítica', 'Clave service_role / secreta / JWT incrustada en archivos del cliente', clientFiles.some(f => SECRET.test(read(f))),
  clientFiles.filter(f => SECRET.test(read(f))).join(', '));
const asarPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (fs.existsSync(asarPath)) {
  const asar = require(require.resolve('@electron/asar', { paths: [ROOT] }));
  const files = asar.listPackage(asarPath).map(f => f.split(path.sep).join('/').replace(/^\//, '')).filter(f => /\.(js|html|json)$/.test(f) && !f.includes('node_modules'));
  const leaked = files.filter(f => SECRET.test(asar.extractFile(asarPath, f).toString()));
  check('Supabase', 'Crítica', `Clave privilegiada dentro del instalador (dist/…/app.asar, ${files.length} archivos)`, leaked.length > 0, leaked.join(', '));
  check('Supabase', 'Crítica', 'Panel SuperAdmin (admin.*) empaquetado en el instalador', files.some(f => /^admin\./.test(f)));
}
const syncSrc = read('sync.js');
const unscopedWrites = (syncSrc.match(/\.from\("[a-z_]+"\)\.delete\(\)\.(eq|in)\("id",[^;]*;/g) || []).filter(s => !s.includes('business_id'));
check('Supabase', 'Media', `sync.js: ${unscopedWrites.length} borrados por id sin filtro business_id (dependen solo del RLS; defensa en profundidad)`, unscopedWrites.length > 0,
  unscopedWrites.map(s => s.slice(0, 60)).join(' | '));
check('Supabase', 'Media', 'La sesión de la terminal (refresh token) vive en localStorage: un XSS puede robarla', /localStorage\.setItem\(key, value\)/.test(read('storage.js')));
check('Supabase', 'Media', 'admin_create_negocio recibe la contraseña en claro como argumento de una función SQL (puede quedar en logs de PostgREST/Postgres)', /p_password/.test(read('admin.js')));
const adminSrc = read('admin.js');
check('Supabase', 'Alta', 'admin.js: el rol SuperAdmin se lee de app_metadata (no editable por el usuario)', !/app_metadata\?\.role === 'superadmin'/.test(adminSrc) || /user_metadata\?\.role/.test(adminSrc));

/* =====================================================================================
   3. INTEGRIDAD FINANCIERA Y CARRERAS DE SINCRONIZACIÓN (código real)
   ===================================================================================== */
const fin = createEnv();
fin.run(`
  function freshState(qty = 15, price = 6000) {
    state = normalizeState({ ...structuredClone(defaultState), orders: [], payments: [], expenses: [] });
    state.cashShift = { id: 'shift_a', status: 'open', openingCash: 0, openedAt: Date.now() };
    state.tables = [{ id: 't1', name: 'Mesa 1', zone: 'Salón' }, { id: 't2', name: 'Mesa 2', zone: 'Salón' }, { id: 't3', name: 'Mesa 3', zone: 'Salón' }];
    state.products = [{ id: 'prod_audit_1', name: 'Cerveza', category: 'Cervezas', price, cost: 3000, stock: 1000, inventoryId: 'inv1' }];
    state.inventory = [{ id: 'inv1', name: 'Cerveza', qty: 1000, min: 5, unit: 'und' }];
    state.orders = [{ id: 'o1', tableId: 't1', tableName: 'Mesa 1', status: 'open', createdAt: Date.now(), sync_status: 'synced', items: [{ productId: 'prod_audit_1', name: 'Cerveza', price, qty, inventoryId: 'inv1' }] }];
    state.currentOrderId = 'o1'; splitBillData.people = 2; splitBillData.mode = 'equal'; __toasts.length = 0;
    renderOrderDialog = () => {};
  }
  function payPart(part, people) { openSplitBill(); if (people) setSplitPeopleExact(people); chargeEqualPart(part); confirmPayment(); }
`);

// 3.1 Doble clic en «Finalizar cobro»
fin.run('freshState(5); openPayment(); confirmPayment(); confirmPayment();');
check('Finanzas', 'Crítica', 'Doble clic en «Finalizar cobro» genera un solo pago', fin.get('state.payments.length') !== 1, `pagos: ${fin.get('state.payments.length')}`);

// 3.2 Fuzz de cobros en partes iguales: siempre se recauda exactamente el total
let fuzzFail = null;
let seed = 1234567;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let iter = 0; iter < 300 && !fuzzFail; iter++) {
  const qty = 1 + rnd(40), price = 500 + rnd(80) * 137, people = 2 + rnd(7);
  const order = Array.from({ length: people }, (_, i) => i + 1).sort(() => rnd(3) - 1);
  fin.run(`freshState(${qty}, ${price});`);
  const total = qty * price, reloadAt = rnd(people), fullAt = rnd(4) === 0 ? 1 + rnd(people - 1) : -1;
  for (let k = 0; k < order.length; k++) {
    if (fin.get('getOrder("o1").status') === 'paid') break;
    if (k === reloadAt) fin.run('state = normalizeState(JSON.parse(JSON.stringify(state)));');
    if (k === fullAt) { fin.run('openPayment(); confirmPayment();'); break; }
    fin.run(`payPart(${order[k]}, ${k === 0 ? people : 'null'});`);
  }
  const res = fin.get(`({ collected: state.payments.reduce((s, p) => s + p.amount, 0), status: getOrder('o1').status, stock: state.inventory[0].qty,
    bad: state.payments.filter(p => p.items.reduce((s, i) => s + i.price * i.qty, 0) !== p.amount || p.items.some(i => !Number.isInteger(i.qty))).length })`);
  if (res.collected !== total || res.status !== 'paid' || res.stock !== 1000 - qty || res.bad) fuzzFail = { qty, price, people, order, ...res, total };
}
check('Finanzas', 'Crítica', '300 cobros en partes iguales aleatorios (2–8 personas, orden aleatorio, recargas, «Cobrar» a mitad): recaudo exacto, inventario único, facturas cuadradas',
  Boolean(fuzzFail), fuzzFail ? JSON.stringify(fuzzFail) : '');

// 3.3 Eliminar la factura de una parte con el reparto a medias
fin.run('freshState(); payPart(1, 3); can = () => true; logAudit = () => {};');
const pendingBefore = fin.get('orderPending(getOrder("o1"))');
fin.run(`openInvoiceDelete(state.payments[0].id); document.querySelector('#invoiceDeleteReason').value = 'Error de cobro'; document.querySelector('#invoiceDeleteRestore') && (document.querySelector('#invoiceDeleteRestore').checked = true); confirmDeleteInvoice();`);
const delState = fin.get('({ payments: state.payments.length, pending: orderPending(getOrder("o1")), paidParts: (getOrder("o1").equalSplit?.paid || []).length })');
check('Finanzas', 'Alta', 'Eliminar la factura de una parte con el reparto a medias devuelve ese monto al saldo pendiente de la mesa',
  !(delState.payments === 0 && delState.pending === 90000 && delState.paidParts === 0),
  `tras eliminar: ${delState.payments} factura(s), ${delState.paidParts} parte(s) cobrada(s), saldo ${delState.pending} (antes ${pendingBefore}; debería volver a 90000)`);

// 3.4 Entradas negativas
fin.run(`freshState(); document.querySelector('#expenseCategory').value = 'Otros'; document.querySelector('#expenseDescription').value = 'Prueba';
  document.querySelector('#expenseAmount').value = '-50000'; document.querySelector('#expenseMethod').value = 'Efectivo'; document.querySelector('#expenseDate').value = today(); saveExpense();`);
check('Finanzas', 'Media', 'Gasto con valor negativo (-$50.000) es rechazado', fin.get('state.expenses.some(e => e.amount < 0)'), 'se guardó un gasto negativo: altera el efectivo esperado y la utilidad');
fin.run('freshState(5); openPayment(); document.querySelector("#amountReceived").value = "-1000"; addPaymentTender();');
check('Finanzas', 'Alta', 'Abono con monto negativo es rechazado', fin.get('currentTenders.some(t => t.amount < 0)'));
fin.run('confirmPayment(); can = () => true; logAudit = () => {}; openInvoiceEdit(state.payments[0].id); invoiceDraft.items[0].price = -6000; document.querySelector("#invoiceReason").value = "x prueba"; saveInvoiceEdit();');
check('Finanzas', 'Alta', 'Corrección de factura con precio negativo es rechazada', fin.get('state.payments[0].amount < 0'));
const importSrc = read('import-products.js');
check('Finanzas', 'Baja', 'Importación Excel: rechaza precio $0 y nunca deja existencias negativas (mismas reglas que el formulario manual)',
  !/if \(!\(price > 0\)\)/.test(importSrc) || /adjustNegative/.test(importSrc) || !/Math\.max\(0, Number\(item\.stock\)/.test(importSrc));
fin.run(`freshState(); document.querySelector('#countedCash').value = '-20000'; confirmClose();`);
check('Finanzas', 'Baja', 'Cierre de caja con efectivo contado negativo (-$20.000) es rechazado', fin.get('state.cashShift.status') !== 'open', `estado del turno tras el intento: ${fin.get('state.cashShift.status')}`);

// 3.5 Carreras de sincronización: una copia remota desactualizada pisa cambios locales pendientes de subir
const races = [];
fin.run(`freshState(3); getOrder('o1').items[0].qty = 5; getOrder('o1').sync_status = 'pending';
  mergeRemoteOrders([{ id: 'o1', tableId: 't1', tableName: 'Mesa 1', status: 'open', items: [{ productId: 'prod_audit_1', name: 'Cerveza', price: 6000, qty: 3 }] }]);`);
races.push(['productos agregados sin subir (5 → 3 cervezas)', fin.get('getOrder("o1").items[0].qty') !== 5]);
fin.run(`freshState(3); openPayment(); confirmPayment();
  mergeRemoteOrders([{ id: 'o1', tableId: 't1', tableName: 'Mesa 1', status: 'open', items: [{ productId: 'prod_audit_1', name: 'Cerveza', price: 6000, qty: 3 }] }]);`);
races.push(['mesa cobrada se reabre con su consumo (riesgo de doble cobro)', Boolean(fin.get('activeOrderForTable("t1")'))]);
fin.run(`freshState(3); moveOrderToTable('o1', 't3');
  mergeRemoteOrders([{ id: 'o1', tableId: 't1', tableName: 'Mesa 1', status: 'open', items: [{ productId: 'prod_audit_1', name: 'Cerveza', price: 6000, qty: 3 }] }]);`);
races.push(['traslado de mesa se revierte', fin.get('getOrder("o1").tableId') !== 't3']);
fin.run(`freshState(3); state.orders.push({ id: 'o2', tableId: 't2', tableName: 'Mesa 2', status: 'open', createdAt: Date.now(), sync_status: 'synced', items: [{ productId: 'prod_audit_1', name: 'Cerveza', price: 6000, qty: 2 }] });
  moveOrderToTable('o1', 't2', { confirmMerge: () => true });
  mergeRemoteOrders([{ id: 'o1', tableId: 't1', tableName: 'Mesa 1', status: 'open', items: [{ productId: 'prod_audit_1', name: 'Cerveza', price: 6000, qty: 3 }] },
                     { id: 'o2', tableId: 't2', tableName: 'Mesa 2', status: 'open', items: [{ productId: 'prod_audit_1', name: 'Cerveza', price: 6000, qty: 2 }] }]);`);
races.push(['unión de mesas: la cuenta de origen resucita y la de destino pierde lo unido', fin.get('Boolean(activeOrderForTable("t1")) || orderTotal(activeOrderForTable("t2")) !== 30000')]);
const lost = races.filter(([, bad]) => bad);
check('Finanzas/Sync', 'Alta', 'mergeRemoteOrders respeta cambios locales pendientes de subir (sync_status: pending) ante una copia remota desactualizada',
  lost.length > 0, lost.map(([name]) => name).join(' · '));
// Arranque (bootstrap → syncOnStartup): se registra el orden real de subida y descarga en tres escenarios
asyncChecks.push(async () => {
  const appSrc = read('app.js');
  const usesStartup = /await syncOnStartup\(\)/.test(appSrc.slice(appSrc.indexOf('async function bootstrap()')));
  const scenario = async (setup, pushOk) => {
    fin.run(`freshState(3); ${setup}; var __calls = [];
      globalThis.NexoSync = Object.assign(globalThis.NexoSync, {
        getPendingCount: () => 0,
        syncAll: async () => { __calls.push('push'); if (${pushOk}) state.orders.forEach(o => { o.sync_status = 'synced'; }); return { pedidos: { ok: ${pushOk} } }; },
        pullAllFromSupabase: async () => { __calls.push('pull'); return { ok: true, count: 0 }; } });`);
    if (typeof fin.ctx.syncOnStartup !== 'function') return 'sin syncOnStartup';
    await fin.run('syncOnStartup()');
    return fin.get('__calls').join('→') || 'nada';
  };
  const withPending = await scenario(`getOrder('o1').sync_status = 'pending'`, true);
  const pushFails = await scenario(`getOrder('o1').sync_status = 'pending'`, false);
  const emptyQueue = await scenario(`getOrder('o1').sync_status = 'synced'`, true);
  check('Finanzas/Sync', 'Alta', 'Arranque: con cambios pendientes sube primero y solo después descarga; si la subida falla no descarga; con la cola vacía no sube nada',
    !(usesStartup && withPending === 'push→pull' && pushFails === 'push' && emptyQueue === 'pull'),
    `bootstrap usa syncOnStartup: ${usesStartup} · con pendientes: ${withPending} · subida fallida: ${pushFails} · cola vacía: ${emptyQueue}`);
});

// 3.6 ID de sincronización editable después de vincular la terminal
fin.run(`freshState(); state.terminal = { businessId: 'bar_central_01' }; state.profile.syncId = 'bar_central_01'; can = () => true;
  document.querySelector('#businessName').value = 'Bar'; document.querySelector('#businessSyncId').value = 'bar_norte_02'; saveProfile();`);
fin.run(`renderProfile();`);
const syncLocked = fin.run(`document.querySelector('#businessSyncId').readOnly`);
fin.run(`state.profile.syncId = 'bar_norte_02';`); // aunque algo forzara otro ID en el perfil…
const usedId = fin.get('getBusinessId()');
check('Supabase', 'Media', '«Mi negocio» no permite cambiar el ID de sincronización de una terminal vinculada y getBusinessId() usa siempre terminal.businessId',
  fin.get('state.terminal.businessId') !== 'bar_central_01' || !syncLocked || usedId !== 'bar_central_01',
  `campo bloqueado: ${syncLocked} · getBusinessId(): ${usedId} · terminal: bar_central_01`);

/* =====================================================================================
   4. XSS: cadenas maliciosas en todos los datos que escribe el usuario o llegan de la nube
   ===================================================================================== */
const xss = createEnv();
const P = XSS, ATTR = 'x" onerror="alert(1)';
xss.run(`
  state = normalizeState({ ...structuredClone(defaultState) });
  state.cashShift = { id: 'sx', status: 'open', openingCash: 0, openedAt: Date.now() };
  state.profile = { ...state.profile, name: ${JSON.stringify(P)}, address: ${JSON.stringify(P)}, nit: ${JSON.stringify(P)}, phone: ${JSON.stringify(P)} };
  state.categories = [${JSON.stringify(P)}];
  state.products = [{ id: 'prod_audit_x', name: ${JSON.stringify(P)}, category: ${JSON.stringify(P)}, price: 5000, cost: 2000, stock: 3, inventoryId: 'ix', icon: ${JSON.stringify(P)} }];
  state.inventory = [{ id: 'ix', name: ${JSON.stringify(P)}, unit: ${JSON.stringify(P)}, qty: 3, min: 5 }];
  state.tables = [{ id: 'tx', name: ${JSON.stringify(P)}, zone: ${JSON.stringify(P)} }];
  state.orders = [{ id: 'ox', tableId: 'tx', tableName: ${JSON.stringify(P)}, note: ${JSON.stringify(P)}, status: 'open', createdAt: Date.now(), items: [{ productId: 'prod_audit_x', name: ${JSON.stringify(P)}, category: ${JSON.stringify(P)}, price: 5000, qty: 1 }] },
                  { id: 'oc', tableId: 'custom_x', isCustom: true, tableName: ${JSON.stringify(P)}, status: 'open', createdAt: Date.now(), items: [{ productId: 'prod_audit_x', name: ${JSON.stringify(P)}, price: 5000, qty: 1 }] }];
  state.payments = [{ id: 'payx', invoiceNo: ${JSON.stringify(P)}, date: today(), paidAt: Date.now(), customer: ${JSON.stringify(P)}, cashierName: ${JSON.stringify(P)}, waiterName: ${JSON.stringify(P)},
                      amount: 5000, method: ${JSON.stringify(P)}, payments: [{ method: ${JSON.stringify(P)}, amount: 5000 }], items: [{ productId: 'prod_audit_x', name: ${JSON.stringify(P)}, price: 5000, qty: 1 }], shiftId: 'sx' }];
  state.expenses = [{ id: 'ex', date: today(), createdAt: Date.now(), category: ${JSON.stringify(P)}, description: ${JSON.stringify(P)}, amount: 100, method: ${JSON.stringify(P)} }];
  state.purchases = [{ id: 'pu', date: today(), createdAt: Date.now(), invoice: ${JSON.stringify(P)}, supplier: ${JSON.stringify(P)}, method: ${JSON.stringify(P)}, total: 100, lines: [{ productId: 'prod_audit_x', name: ${JSON.stringify(P)}, qty: 1, unitCost: 100 }] }];
  state.users = [{ id: 'ux', name: ${JSON.stringify(P)}, role: ${JSON.stringify(P)}, active: true, salt: 's', pinHash: 'h' }];
  state.audit = [{ at: Date.now(), user: ${JSON.stringify(P)}, action: ${JSON.stringify(P)}, detail: ${JSON.stringify(P)}, reason: ${JSON.stringify(P)} }];
  state.currentOrderId = 'ox'; can = () => true; me = () => state.users[0]; reportRange = 'today';
`);
// Gravedad según el origen real del dato: nube/Excel (Alta) · entrada local del administrador (Media) · solo respaldo manipulado (Baja)
const SEVERITY = {
  'openInventoryDialog — nombre/unidad de insumo (llega de Supabase y del Excel importado)': 'Alta',
  'renderProducts — unidad del producto (texto libre del Excel importado)': 'Alta',
  'renderZones — nombre de zona de mesa (lo escribe el administrador)': 'Media',
  'setImagePreview — imagen de logo/producto (respaldo .json importado)': 'Media',
  'productVisual — imagen de producto (respaldo .json importado)': 'Media',
  'renderLogin / equipo — rol de usuario (solo con respaldo manipulado)': 'Baja'
};
const ISOLATED = ['#productsTable', '#zoneFilter', '#teamTable', '#loginUsers', '#inventorySelect']; // se evalúan en su propio vector
const sinks = {
  'renderAll (mesas, cuentas abiertas, facturas, compras, reportes)': `renderAll(); ${JSON.stringify(ISOLATED)}.forEach(k => { document.querySelector(k).innerHTML = ''; })`,
  'renderZones — nombre de zona de mesa (lo escribe el administrador)': 'renderZones()',
  'openInventoryDialog — nombre/unidad de insumo (llega de Supabase y del Excel importado)': 'openInventoryDialog()',
  'renderProducts — unidad del producto (texto libre del Excel importado)': 'renderProducts()',
  'openOrder + renderOrderDialog (catálogo y cuenta)': 'openOrder("tx"); renderOrderDialog()',
  'renderCustomOrders (cuentas personalizadas)': 'renderCustomOrders()',
  'renderInvoices / renderRecentInvoices': 'renderInvoices(); renderRecentInvoices()',
  'renderLogin / equipo — rol de usuario (solo con respaldo manipulado)': 'renderLogin(); renderTeam()',
  'openMoveOrderDialog (mover / unir)': 'state.tables.push({ id: "t9", name: ' + JSON.stringify(P) + ', zone: "z" }); openMoveOrderDialog()',
  'setImagePreview — imagen de logo/producto (respaldo .json importado)': `setImagePreview(document.querySelector('#auditImg'), ${JSON.stringify(ATTR)}, 'N')`,
  'productVisual — imagen de producto (respaldo .json importado)': `document.querySelector('#auditVisual').innerHTML = productVisual({ name: 'a', image: ${JSON.stringify(ATTR)} })`
};
const sinkFindings = [];
for (const [label, code] of Object.entries(sinks)) {
  for (const k of Object.keys(xss.els)) xss.els[k].innerHTML = '';
  const out = safely(() => xss.run(code));
  const dirty = Object.values(xss.els).filter(e => typeof e.innerHTML === 'string' && (e.innerHTML.includes('<img src=x onerror=alert(1)>') || e.innerHTML.includes('onerror="alert(1)"'))).map(e => e.__sel);
  if (out && out.__error && !dirty.length) sinkFindings.push(`${label}: no evaluable (${out.__error.slice(0, 60)})`);
  check('XSS', SEVERITY[label] || 'Alta', `${label}`, dirty.length > 0, dirty.join(', '));
}
const adm = require(path.join(ROOT, 'admin.js'));
check('XSS', 'Alta', 'admin.js: escapeAdminHtml en tabla de negocios y credenciales', adm.escapeAdminHtml(P).includes('<img'));

/* =====================================================================================
   Reporte (después de las comprobaciones asíncronas)
   ===================================================================================== */
(async () => {
for (const run of asyncChecks) await run();
const ORDER = { 'Crítica': 0, 'Alta': 1, 'Media': 2, 'Baja': 3 };
const open = results.filter(r => r.vulnerable).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
console.log('=== AUDITORÍA DE SEGURIDAD, BUGS Y CONSISTENCIA FINANCIERA · NexoPos ===\n');
for (const area of [...new Set(results.map(r => r.area))]) {
  console.log(`■ ${area}`);
  for (const r of results.filter(x => x.area === area)) {
    console.log(`  ${r.vulnerable ? '✗ VULNERABLE' : '✓ SEGURO    '} [${r.severity}] ${r.vector}${r.vulnerable && r.detail ? `\n      → ${r.detail}` : ''}`);
  }
}
if (sinkFindings.length) console.log('\nNo evaluables en este entorno:\n  ' + sinkFindings.join('\n  '));
const count = sev => open.filter(r => r.severity === sev).length;
console.log(`\nVectores evaluados: ${results.length} · Vulnerables: ${open.length} (Crítica ${count('Crítica')}, Alta ${count('Alta')}, Media ${count('Media')}, Baja ${count('Baja')})`);
process.exit(count('Crítica') + count('Alta') > 0 ? 1 : 0);
})().catch(error => { console.error('La auditoría no pudo completarse:', error); process.exit(2); });
