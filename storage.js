/* Brasa POS · almacenamiento y respaldos
   - IndexedDB como almacenamiento principal (mucho más espacio que localStorage).
   - Migra automáticamente los datos que estaban en localStorage.
   - En la app de Windows (Electron) además guarda un archivo espejo en disco y respalda a una carpeta.
   Se carga ANTES de modules.js y app.js: solo declaraciones, el arranque lo hace bootstrap() en app.js. */

// isDemoMode() vive en demo-mode.js (cargado antes en index.html); en Node (pruebas) se carga aquí.
if (typeof module !== 'undefined' && typeof globalThis.isDemoMode !== 'function') require('./demo-mode.js');

function getDbName() {
  return isDemoMode() ? 'nexopos_demo_db' : 'nexopos';
}
globalThis.getDbName = getDbName;

const DB_STORE = 'kv', DB_KEY = 'state', LEGACY_KEY = 'brasa-pos-v1', DEMO_FALLBACK_KEY = 'nexopos_demo_state';
const BACKUP_DEFAULTS = { onClose: true, daily: true, lastAt: null, lastReason: '', lastFile: '', lastWhere: '' };
globalThis.BACKUP_DEFAULTS = BACKUP_DEFAULTS;
let storageReady = false, storageMode = 'indexeddb', storageDb = null, storageOpening = null;
let saveTimer = null, mirrorTimer = null, saveChain = Promise.resolve(), lastSaveErrorToast = 0, storageInfoAt = 0;
const storageStatus = { lastSavedAt: null, error: null, migrated: false, restoredFromFile: false };

/* ---------- IndexedDB ----------
   Una sola conexión por pestaña (storageDb) y una sola apertura en curso (storageOpening). Safari iOS congela la
   página en el BFCache al pasar entre la app y el Modo Demo con «Atrás»: la conexión vieja queda huérfana y sus
   transacciones se cancelan («Transacción cancelada»). Por eso la conexión se suelta al ocultar la página o si otra
   pestaña la necesita, y cada operación la reabre y reintenta una vez si la encuentra muerta. */
function closeStorageDb() {
  const db = storageDb; storageDb = null;
  try { db?.close?.(); } catch { /* ya estaba cerrada */ }
}
const IDB_OPEN_TIMEOUT = 6000; // Safari iOS a veces deja indexedDB.open sin respuesta: se corta y se reintenta
function idbOpenOnce() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('Este navegador no tiene IndexedDB.'));
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('La base de datos no respondió.')); }, IDB_OPEN_TIMEOUT);
    const request = indexedDB.open(getDbName(), 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE); };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { try { db.close(); } catch { /* sin conexión */ } return; } // llegó tarde: ya se reintentó
      settled = true; clearTimeout(timer);
      // Otra pestaña pide una versión nueva: se cede la conexión; la próxima operación abre otra
      db.onversionchange = () => { db.close(); if (storageDb === db) storageDb = null; };
      // El navegador la cerró por su cuenta (WebKit lo hace al congelar o descartar la página)
      db.onclose = () => { if (storageDb === db) storageDb = null; };
      resolve(db);
    };
    request.onerror = () => { if (settled) return; settled = true; clearTimeout(timer); reject(request.error || new Error('No se pudo abrir la base de datos.')); };
    // Bloqueada por una conexión anterior: se cierra la propia; la petición sigue sola en cuanto se libere
    request.onblocked = () => closeStorageDb();
  });
}
// Singleton: si ya hay una apertura en curso se devuelve la misma promesa; si falla, un reintento limpio
function idbOpen() {
  if (storageDb) return Promise.resolve(storageDb);
  if (!storageOpening) {
    storageOpening = idbOpenOnce()
      .catch(() => { closeStorageDb(); return idbOpenOnce(); })
      .then(db => { storageDb = db; return db; })
      .finally(() => { storageOpening = null; });
  }
  return storageOpening;
}
function idbRequest(db, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode); let result;
    // action devuelve una petición (se resuelve su resultado) o una función que arma el resultado al terminar la transacción
    const request = action(tx.objectStore(DB_STORE));
    if (typeof request === 'function') result = request; else if (request) request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Transacción cancelada.'));
  });
}
// Con una conexión cerrada o huérfana la transacción falla: se descarta, se abre una nueva y se reintenta una vez
async function idbRun(mode, action) {
  try { return await idbRequest(await idbOpen(), mode, action); }
  catch { closeStorageDb(); return idbRequest(await idbOpen(), mode, action); }
}
const idbGet = key => idbRun('readonly', store => store.get(key));
const idbPut = (key, value) => idbRun('readwrite', store => store.put(value, key));
// Varias lecturas o escrituras en una sola transacción (todo o nada)
const idbGetVarios = claves => idbRun('readonly', store => { const out = {}; claves.forEach(k => { const rq = store.get(k); rq.onsuccess = () => { out[k] = rq.result; }; }); return () => out; });
const idbEscribirLote = (escrituras, borrados = []) => idbRun('readwrite', store => { escrituras.forEach(([k, v]) => store.put(v, k)); borrados.forEach(k => store.delete(k)); return null; });

/* ---------- Historial particionado por mes ----------
   Ventas, gastos y compras siguen completos en memoria (reportes, facturas, respaldos y sincronización no cambian),
   pero en IndexedDB se guardan aparte por mes ('hist:payments:2026-05'). Antes, cada guardado copiaba el estado entero:
   con un año de ventas (~55.000) eran ~220 ms por guardado en un PC y varias veces más en una tablet.
   Ahora cada guardado escribe el núcleo y los meses recientes; un mes viejo solo se reescribe si cambia su resumen
   (cantidad, total, pendientes de subir, ids) o si se marcó con marcarHistorialModificado(). Como red de seguridad,
   cada HIST_REVISION_MS y al ocultar la página se compara el contenido completo de cada mes.
   Ventana en memoria: al arrancar, los meses de ventas anteriores a los últimos histVentanaDias (sin nada pendiente de
   subir) se quedan solo en IndexedDB (histArchivo). Nunca se borran: el núcleo los sigue listando, los respaldos los
   incluyen (estadoCompleto) y asegurarHistorial() los trae cuando un filtro pide una fecha anterior. Si llega a memoria
   un registro de un mes archivado (tiempo real, edición), el mes se trae entero antes de guardar. */
const HIST_COLECCIONES = ['payments', 'expenses', 'purchases'];
const HIST_ARCHIVABLES = ['payments']; // gastos y compras son pocos: siempre completos en memoria
const HIST_DIAS_RECIENTES = 35; // meses que se revisan en cada guardado: el actual y, al inicio de mes, el anterior
const HIST_REVISION_MS = 10 * 60 * 1000;
let histVentanaDias = 90; // let: las pruebas la cambian
let histGuardado = {}; // clave → { resumen, firma } de lo que hay en IndexedDB y en memoria
let histArchivo = {}; // clave → { resumen, firma } de los meses que están solo en IndexedDB
const histMarcados = new Set();
let histUltimaRevision = Date.now();

// Primer día del mes más antiguo que se mantiene en memoria ('2026-08-01'); sync.js descarga ventas desde ahí
function historialVentanaDesde(ahora = Date.now()) { const d = new Date(ahora - histVentanaDias * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }
const pendientesDeResumen = resumen => Number(String(resumen || '').split('|')[2]);
globalThis.historialVentanaDesde = historialVentanaDesde;

function mesDeRegistro(r) { const f = String(r?.date || r?.fecha || '').slice(0, 7); return /^\d{4}-\d{2}$/.test(f) ? f : 'sin-fecha'; }
// Cambios que la revisión rápida detecta sin serializar: altas, bajas, montos, estado de sincronización y orden
function resumenHistorial(lista) {
  let suma = 0, pendientes = 0, h = 0;
  for (const r of lista) {
    suma += Number(r?.amount ?? r?.total ?? 0) || 0;
    if (r?.sync_status && r.sync_status !== 'synced') pendientes++;
    const id = String(r?.id); for (let i = 0; id.length > i; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return `${lista.length}|${suma}|${pendientes}|${h}`;
}
function firmaHistorial(lista) { const s = JSON.stringify(lista); let h = 2166136261; for (let i = 0; s.length > i; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return `${s.length}:${h >>> 0}`; }
// Marca el mes de un registro editado en su lugar (p. ej. una factura antigua) para guardarlo en el siguiente guardado
function marcarHistorialModificado(coleccion, registro) { if (HIST_COLECCIONES.includes(coleccion)) histMarcados.add(`hist:${coleccion}:${mesDeRegistro(registro)}`); }
globalThis.marcarHistorialModificado = marcarHistorialModificado;

function agruparPorMes(estado) {
  const meses = {};
  for (const col of HIST_COLECCIONES) for (const r of (Array.isArray(estado?.[col]) ? estado[col] : [])) (meses[`hist:${col}:${mesDeRegistro(r)}`] ||= []).push(r);
  return meses;
}
// El núcleo lista todos los meses (también los archivados) con su resumen y firma: así, al arrancar, se sabe qué
// mes se puede dejar fuera de memoria sin leerlo, y el espejo de Windows sabe qué partes tiene al día.
function armarNucleo(estado, info) {
  const nucleo = { ...estado, __historial: Object.keys(info), __historialInfo: info };
  HIST_COLECCIONES.forEach(col => { nucleo[col] = []; });
  return nucleo;
}

// Trae a memoria meses archivados (sin duplicar lo que ya está). Los más viejos van primero, como al cargar.
async function traerDelArchivo(estado, claves) {
  if (!claves.length) return 0;
  const partes = await idbGetVarios(claves);
  let traidos = 0;
  for (const clave of [...claves].sort().reverse()) {
    const parte = partes[clave], col = clave.split(':')[1];
    if (!parte || !Array.isArray(parte.registros)) throw new Error(`Falta la parte ${clave} del historial guardado.`);
    if (!Array.isArray(estado[col])) estado[col] = [];
    const ids = new Set(estado[col].map(r => String(r?.id)));
    const faltan = parte.registros.filter(r => !ids.has(String(r?.id)));
    estado[col] = faltan.concat(estado[col]);
    traidos += faltan.length;
    histGuardado[clave] = { resumen: resumenHistorial(parte.registros), firma: parte.firma };
    delete histArchivo[clave];
  }
  return traidos;
}

async function guardarParticionado(estado, { profunda = false } = {}) {
  let meses = agruparPorMes(estado);
  const tocados = Object.keys(histArchivo).filter(k => k in meses);
  if (tocados.length) { await traerDelArchivo(estado, tocados); meses = agruparPorMes(estado); }

  const d = new Date(Date.now() - HIST_DIAS_RECIENTES * 86400000);
  const limite = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const escrituras = [], nuevo = {};
  for (const [clave, lista] of Object.entries(meses)) {
    const mes = clave.split(':')[2], previo = histGuardado[clave], resumen = resumenHistorial(lista);
    const revisar = profunda || !previo || mes === 'sin-fecha' || mes >= limite || histMarcados.has(clave) || previo.resumen !== resumen;
    if (!revisar) { nuevo[clave] = previo; continue; }
    const firma = firmaHistorial(lista);
    if (!previo || previo.firma !== firma) escrituras.push([clave, { firma, registros: lista }]);
    nuevo[clave] = { resumen, firma };
  }
  escrituras.unshift([DB_KEY, armarNucleo(estado, { ...histArchivo, ...nuevo })]);
  const borrados = Object.keys(histGuardado).filter(k => !(k in meses));
  await idbEscribirLote(escrituras, borrados);
  histGuardado = nuevo; histMarcados.clear();
  if (profunda) histUltimaRevision = Date.now();
  return { escritas: escrituras.map(([k]) => k), borradas: borrados };
}

// Rearma el estado: el núcleo trae la lista de meses (__historial) y cada mes sus registros. Los meses de ventas
// fuera de la ventana y sin pendientes no se leen (quedan en histArchivo); un núcleo sin __historialInfo (versión
// anterior) se carga completo y el siguiente guardado ya lo trae.
async function cargarParticionado(nucleo) {
  if (!nucleo || !Array.isArray(nucleo.__historial)) return nucleo;
  const info = nucleo.__historialInfo || {}, ventanaMes = historialVentanaDesde().slice(0, 7);
  const archivo = {}, aCargar = [];
  for (const clave of nucleo.__historial) {
    const [, col, mes] = clave.split(':'), i = info[clave];
    if (HIST_ARCHIVABLES.includes(col) && mes !== 'sin-fecha' && ventanaMes > mes && i?.firma && pendientesDeResumen(i.resumen) === 0) archivo[clave] = { resumen: i.resumen, firma: i.firma };
    else aCargar.push(clave);
  }
  const partes = await idbGetVarios(aCargar);
  const estado = { ...nucleo };
  delete estado.__historial; delete estado.__historialInfo;
  HIST_COLECCIONES.forEach(col => { estado[col] = []; });
  histGuardado = {}; histArchivo = archivo;
  for (const clave of aCargar.sort()) {
    const parte = partes[clave];
    if (!parte || !Array.isArray(parte.registros)) throw new Error(`Falta la parte ${clave} del historial guardado.`);
    const col = clave.split(':')[1];
    if (HIST_COLECCIONES.includes(col)) for (const r of parte.registros) estado[col].push(r);
    histGuardado[clave] = { resumen: resumenHistorial(parte.registros), firma: parte.firma };
  }
  return estado;
}

// Trae a memoria los meses archivados desde la fecha pedida ('' = todos). Devuelve cuántos registros llegaron:
// quien llama vuelve a dibujar solo si llegó algo. Va en la cola de guardado para no cruzarse con uno en curso.
function asegurarHistorial(desde = '') {
  const mes = String(desde || '').slice(0, 7);
  const claves = Object.keys(histArchivo).filter(k => k.split(':')[2] >= mes);
  if (!claves.length || storageMode !== 'indexeddb') return Promise.resolve(0);
  const tarea = saveChain.then(() => traerDelArchivo(state, Object.keys(histArchivo).filter(k => k.split(':')[2] >= mes)));
  saveChain = tarea.catch(() => {});
  return tarea.catch(error => { console.warn('[NexoPos] No se pudo leer el historial archivado:', error); return 0; });
}
const historialArchivado = () => Object.keys(histArchivo).length > 0;
globalThis.asegurarHistorial = asegurarHistorial;
globalThis.historialArchivado = historialArchivado;

// Estado con todo el historial (memoria + meses archivados) para respaldos: los meses viejos no se quedan en memoria
async function estadoCompleto() {
  const claves = Object.keys(histArchivo).sort();
  if (!claves.length || storageMode !== 'indexeddb') return state;
  const partes = await idbGetVarios(claves), copia = { ...state };
  for (const col of HIST_ARCHIVABLES) {
    const enMemoria = new Set((state[col] || []).map(r => String(r?.id))), viejos = [];
    for (const clave of claves) {
      if (clave.split(':')[1] !== col) continue;
      const parte = partes[clave];
      if (!parte || !Array.isArray(parte.registros)) throw new Error(`Falta la parte ${clave} del historial guardado.`);
      for (const r of parte.registros) if (!enMemoria.has(String(r?.id))) viejos.push(r);
    }
    copia[col] = viejos.concat(state[col] || []);
  }
  return copia;
}
globalThis.estadoCompleto = estadoCompleto;

// Al restaurar un respaldo el estado se reemplaza entero: los meses archivados dejan de serlo, así el siguiente
// guardado reescribe los que trae el respaldo y borra los que no (igual que con el historial en memoria).
function descartarArchivoHistorial() {
  Object.entries(histArchivo).forEach(([clave, v]) => { histGuardado[clave] = { resumen: '', firma: v.firma }; });
  histArchivo = {};
}
globalThis.descartarArchivoHistorial = descartarArchivoHistorial;

function readLegacy() {
  if (isDemoMode()) return null;
  try { const raw = localStorage.getItem(LEGACY_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
globalThis.readLegacy = readLegacy;

/* Devuelve los datos guardados (o null si es la primera vez). */
async function storageInit() {
  let saved = null;
  try { await idbOpen(); storageMode = 'indexeddb'; } catch (error) { closeStorageDb(); storageMode = 'localstorage'; storageStatus.error = String(error.message || error); }
  if (storageMode === 'indexeddb') {
    saved = (await cargarParticionado(await idbGet(DB_KEY))) ?? null;
    if (!isDemoMode()) {
      if (!saved && globalThis.desktop?.loadMirror) { // IndexedDB vacío pero existe el archivo espejo del escritorio
        try { const raw = await desktop.loadMirror(); if (raw) { saved = JSON.parse(raw); storageStatus.restoredFromFile = true; await idbPut(DB_KEY, saved); } } catch { saved = null; }
      }
      if (!saved) { // migración desde localStorage (versiones anteriores)
        const legacy = readLegacy();
        if (legacy) {
          await idbPut(DB_KEY, legacy); const check = await idbGet(DB_KEY);
          if (check && JSON.stringify(check).length === JSON.stringify(legacy).length) { saved = check; storageStatus.migrated = true; try { localStorage.removeItem(LEGACY_KEY); } catch { /* sin permiso: se deja */ } } else saved = legacy;
        }
      }
    }
  } else {
    if (isDemoMode()) {
      try { const raw = sessionStorage.getItem(DEMO_FALLBACK_KEY); saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
    } else {
      saved = readLegacy();
    }
  }
  // Almacenamiento persistente: sin él, el navegador puede borrar IndexedDB si falta espacio (ventas sin subir incluidas)
  try {
    const st = navigator.storage;
    if (st?.persisted) st.persisted().then(si => si || st.persist?.()).then(si => { storageStatus.persistente = Boolean(si); }).catch(() => {});
  } catch { /* opcional */ }
  // Navegador: avisa antes de cerrar o recargar si hay ventas, gastos o compras que solo están en este equipo.
  // En Windows no: el cierre ya espera el guardado y el espejo, y cancelar beforeunload ahí impediría cerrar.
  if (!isDemoMode() && !globalThis.desktop) window.addEventListener('beforeunload', event => {
    if (!(globalThis.NexoSync?.pendingSummary?.().registros > 0)) return;
    event.preventDefault(); event.returnValue = '';
  });
  if (!isDemoMode() && globalThis.desktop?.onFlushRequest) desktop.onFlushRequest(async () => { await flushAll(); desktop.flushDone(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
  // Al salir o entrar al BFCache se guarda y luego se suelta la conexión (cerrarla antes cancelaría el guardado).
  // Si la página vuelve del BFCache, la siguiente operación abre una conexión nueva.
  window.addEventListener('pagehide', () => { flushAll().finally(() => { if (storageMode === 'indexeddb') closeStorageDb(); }); });
  return saved;
}

/* ---------- Sesión de Supabase Auth ----------
   El token de la terminal vinculada se guarda en localStorage con clave propia para que, al recargar o
   reiniciar la app, las consultas sigan como 'authenticated'. NO va dentro de `state`: así no viaja al
   archivo espejo ni a los respaldos. Sin localStorage (Node, modo privado) queda solo en memoria. */
const AUTH_STORAGE_KEY = 'nexopos-auth';
const authMemory = {};
const authStorage = {
  getItem(key) { try { const value = localStorage.getItem(key); return value ?? authMemory[key] ?? null; } catch { return authMemory[key] ?? null; } },
  setItem(key, value) { authMemory[key] = value; try { localStorage.setItem(key, value); } catch { /* queda en memoria */ } },
  removeItem(key) { delete authMemory[key]; try { localStorage.removeItem(key); } catch { /* sin permiso */ } }
};
globalThis.AUTH_STORAGE_KEY = AUTH_STORAGE_KEY;
globalThis.authStorage = authStorage;

/* ---------- Guardado (agrupa cambios seguidos) ---------- */
function scheduleSave() { if (!storageReady) return; clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveChain = saveChain.then(() => persistNow()).catch(() => {}); }, 250); }
async function persistNow(opciones) {
  try {
    if (storageMode === 'indexeddb') {
      const profunda = Boolean(opciones?.profunda) || Date.now() - histUltimaRevision > HIST_REVISION_MS;
      const { escritas, borradas } = await guardarParticionado(state, { profunda });
      escritas.forEach(k => { mirrorBorrar.delete(k); mirrorPendiente.add(k); });
      borradas.forEach(k => { mirrorPendiente.delete(k); mirrorBorrar.add(k); });
    } else if (isDemoMode()) {
      sessionStorage.setItem(DEMO_FALLBACK_KEY, JSON.stringify(state));
    } else {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(state));
    }
    storageStatus.lastSavedAt = Date.now(); storageStatus.error = null;
    if (!isDemoMode()) scheduleMirror();
  } catch (error) {
    storageStatus.error = String(error.message || error);
    if (Date.now() - lastSaveErrorToast > 60000) { lastSaveErrorToast = Date.now(); showToast('⚠ No se pudo guardar en el equipo. Descarga un respaldo ahora.'); }
  }
}
/* ---------- Archivo espejo (Windows) por partes ----------
   Las mismas partes que IndexedDB (núcleo + un archivo por mes) en %APPDATA%\NexoPos\datos\partes. Solo se escriben
   las que cambiaron: con un año de ventas ya no se serializa el estado entero cada 20 s. Al primer espejo de la
   sesión se compara la firma de cada mes con el índice del disco (mirrorIndice) y se completa lo que falte, incluidos
   los meses archivados. Con un preload anterior (sin saveMirrorParts) se escribe el archivo único como antes. */
const MIRROR_INTERVALO = 20000;
const mirrorPendiente = new Set(), mirrorBorrar = new Set();
let mirrorIndice = null; // clave → firma de lo que hay en el disco (null: aún no se ha leído)
function scheduleMirror() {
  if (isDemoMode()) return;
  if (!globalThis.desktop?.saveMirror) return;
  if (mirrorTimer) return;
  mirrorTimer = setTimeout(() => { mirrorTimer = null; saveChain = saveChain.then(() => escribirEspejo()).catch(() => {}); }, MIRROR_INTERVALO);
}
async function escribirEspejo() {
  if (isDemoMode() || !globalThis.desktop?.saveMirror) return;
  if (!desktop.saveMirrorParts || storageMode !== 'indexeddb') { await desktop.saveMirror(JSON.stringify(await estadoCompleto())); return; }
  if (!mirrorIndice) mirrorIndice = (await desktop.mirrorIndex()) || {};
  const firmas = { ...histArchivo, ...histGuardado };
  const claves = Object.keys(firmas).filter(k => mirrorPendiente.has(k) || mirrorIndice[k] !== firmas[k].firma);
  const meses = agruparPorMes(state), archivados = claves.filter(k => !(k in meses) && k in histArchivo);
  const delArchivo = archivados.length ? await idbGetVarios(archivados) : {};
  // Primero los meses y al final el núcleo: si se corta a mitad, el núcleo anterior sigue apuntando a partes completas
  const partes = [];
  for (const k of claves) {
    const registros = meses[k] || delArchivo[k]?.registros;
    if (Array.isArray(registros)) partes.push([k, firmas[k].firma, JSON.stringify({ firma: firmas[k].firma, registros })]);
  }
  partes.push([DB_KEY, '', JSON.stringify(armarNucleo(state, firmas))]);
  const borrar = [...mirrorBorrar].filter(k => !(k in firmas));
  mirrorPendiente.clear(); mirrorBorrar.clear();
  let ok = false;
  try { ok = await desktop.saveMirrorParts(partes, borrar); } catch { ok = false; }
  if (!ok) { claves.forEach(k => mirrorPendiente.add(k)); borrar.forEach(k => mirrorBorrar.add(k)); return; }
  partes.forEach(([k, firma]) => { if (k !== DB_KEY) mirrorIndice[k] = firma; });
  borrar.forEach(k => { delete mirrorIndice[k]; });
}
async function flushAll() {
  clearTimeout(saveTimer); clearTimeout(mirrorTimer); mirrorTimer = null; if (!storageReady) return;
  // Al cerrar u ocultar la app: revisión completa del historial, por si algún cambio no se detectó
  saveChain = saveChain.then(() => persistNow({ profunda: true })).catch(() => {}); await saveChain;
  clearTimeout(mirrorTimer); mirrorTimer = null;
  if (!isDemoMode() && globalThis.desktop?.saveMirror) { saveChain = saveChain.then(() => escribirEspejo()).catch(() => {}); await saveChain; }
}

/* ---------- Respaldos ---------- */
function backupSettings() { state.backupSettings = { ...BACKUP_DEFAULTS, ...(state.backupSettings || {}) }; return state.backupSettings; }
function backupFileName(slug) { const d = new Date(), pad = n => String(n).padStart(2, '0'); return `nexopos-respaldo-${today()}_${pad(d.getHours())}${pad(d.getMinutes())}-${slug}.json`; }
async function runBackup(reason = 'Manual', slug = 'manual', delayToast = false) {
  let completo = state;
  try { completo = await estadoCompleto(); } catch (error) { console.warn('[NexoPos] Respaldo sin el historial archivado:', error); }
  const settings = backupSettings(), json = JSON.stringify(completo), name = backupFileName(slug);
  let ok = true, where = 'Carpeta de descargas del navegador';
  if (!isDemoMode() && globalThis.desktop?.saveBackup) { try { const result = await desktop.saveBackup(name, json); ok = !!result.ok; where = result.ok ? result.path : (result.error || 'Error al guardar'); } catch (error) { ok = false; where = String(error.message || error); } }
  else { try { downloadBlob(new Blob([json], { type: 'application/json' }), isDemoMode() ? `nexopos-respaldo-DEMO-${today()}.json` : name); } catch (error) { ok = false; where = String(error.message || error); } }
  const at = Date.now();
  if (ok) Object.assign(settings, { lastAt: at, lastReason: reason, lastFile: name, lastWhere: where });
  state.backupLog = [...(state.backupLog || []), { at, reason, file: name, where, bytes: json.length, ok }].slice(-30);
  saveState(); renderBackupCard(true);
  const message = ok ? (globalThis.desktop ? `Respaldo guardado en ${where}` : `Respaldo descargado: ${name}`) : '⚠ No se pudo crear el respaldo. Revisa la carpeta de respaldos.';
  if (delayToast) setTimeout(() => showToast(message), 2000); else showToast(message);
  return ok;
}
function checkDailyBackup() {
  if (!storageReady || !globalThis.desktop?.saveBackup || !backupSettings().daily) return;
  const last = backupSettings().lastAt; if (!last || localISO(new Date(last)) !== today()) runBackup('Respaldo diario automático', 'diario');
}
function startBackupSchedule() { if (!globalThis.desktop?.saveBackup) return; checkDailyBackup(); setInterval(checkDailyBackup, 30 * 60 * 1000); }

async function refreshStorageInfo(force = false) {
  const el = document.querySelector('#storageInfo'); if (!el || (!force && Date.now() - storageInfoAt < 60000)) return; storageInfoAt = Date.now();
  let text = storageMode === 'indexeddb' ? 'Almacenamiento: IndexedDB del equipo' : 'Almacenamiento: localStorage (este navegador no permite IndexedDB)';
  try { const estimate = await navigator.storage?.estimate?.(); if (estimate?.usage != null) text += ` · ${(estimate.usage / 1048576).toFixed(1)} MB en uso`; } catch { /* opcional */ }
  const syncInfo = globalThis.NexoSync?.getStatus?.();
  if (syncInfo) {
    const syncText = syncInfo.status === 'synced' ? 'Nube conectada (Sincronizado)' : syncInfo.status === 'syncing' ? 'Sincronizando con Supabase...' : 'Modo Offline (Almacenamiento 100% local)';
    text += `<br><small>Sincronización en la nube: <b>${syncText}</b></small>`;
  }
  if (globalThis.desktop?.info) { try { const info = await desktop.info(); text += `<br><small>Datos en disco: ${escapeHtml(info.dataFile)}<br>Carpeta de respaldos: ${escapeHtml(info.backupDir)}</small>`; } catch { /* opcional */ } }
  const pend = globalThis.NexoSync?.pendingSummary?.();
  if (pend?.registros > 0) text += `<br><small class="warn-text">${pend.registros} ${pend.registros === 1 ? 'registro guardado' : 'registros guardados'} solo en este equipo${pend.desde ? ` (desde ${escapeHtml(fmtDateTime(pend.desde))})` : ''}. No borres los datos del navegador hasta que se suban.</small>`;
  if (!globalThis.desktop && storageStatus.persistente === false) text += '<br><small class="warn-text">Este navegador puede borrar los datos de la caja si le falta espacio. Instala la app (Agregar a la pantalla de inicio) y descarga respaldos con frecuencia.</small>';
  if (historialArchivado()) text += `<br><small>Ventas anteriores al ${escapeHtml(shortDate(historialVentanaDesde(), true))}: guardadas en el equipo, se cargan al consultarlas.</small>`;
  if (storageStatus.error) text += `<br><small class="warn-text">Aviso: ${escapeHtml(storageStatus.error)}</small>`;
  el.innerHTML = text;
}
function renderBackupCard(forceInfo = false) {
  const status = document.querySelector('#backupStatus'); if (!status || !state) return;
  const settings = backupSettings(), stale = !settings.lastAt || Date.now() - settings.lastAt > 26 * 3600 * 1000;
  status.className = `backup-status ${stale ? 'stale' : 'fresh'}`;
  status.innerHTML = settings.lastAt ? `<strong>Último respaldo:</strong> ${fmtDateTime(settings.lastAt)} · ${escapeHtml(settings.lastReason)}<br><small>${escapeHtml(settings.lastWhere)}</small>${stale ? '<br><small>Han pasado más de 24 horas sin respaldar.</small>' : ''}` : '<strong>Aún no hay respaldos.</strong> Haz el primero con «Respaldar ahora».';
  document.querySelector('#backupOnClose').checked = !!settings.onClose; document.querySelector('#backupDaily').checked = !!settings.daily;
  document.querySelectorAll('[data-desktop-only]').forEach(el => { el.hidden = !globalThis.desktop; });
  document.querySelector('#backupLog').innerHTML = [...(state.backupLog || [])].reverse().slice(0, 5).map(e => `<div class="report-row"><span>${fmtDateTime(e.at)} · ${escapeHtml(e.reason)}</span><b>${e.ok ? `${Math.max(1, Math.round(e.bytes / 1024))} KB` : 'Error'}</b></div>`).join('') || '<p class="muted">Sin historial todavía.</p>';
  refreshStorageInfo(forceInfo);
}

globalThis.storageInit = storageInit;
globalThis.scheduleSave = scheduleSave;
globalThis.persistNow = persistNow;
globalThis.flushAll = flushAll;
globalThis.runBackup = runBackup;
globalThis.checkDailyBackup = checkDailyBackup;
globalThis.startBackupSchedule = startBackupSchedule;
globalThis.refreshStorageInfo = refreshStorageInfo;
globalThis.renderBackupCard = renderBackupCard;
globalThis.backupSettings = backupSettings;
