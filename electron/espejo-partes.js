/* NexoPos · Archivo espejo por partes (proceso principal de Windows; lo usan main.js y electron/main.js).
   Las mismas partes que IndexedDB: datos\partes\state.json (núcleo) y un archivo por mes de historial
   (hist_payments_2026-05.json). indice.json guarda la firma de cada mes para que la app sepa qué tiene al día.
   La app manda primero los meses y al final el núcleo; cada archivo se escribe de forma atómica y, si el anterior
   tiene más de una hora, se copia antes a .bak. Para restaurar se rearma el estado entero (el formato del archivo
   único de siempre), así storage.js no cambia su forma de restaurar. */
const fs = require('fs');
const path = require('path');

const CLAVE_RE = /^(state|hist:(payments|expenses|purchases):(\d{4}-\d{2}|sin-fecha))$/;
const COLECCIONES = ['payments', 'expenses', 'purchases'];
const BAK_MS = 3600 * 1000;

const archivoDe = (dir, clave) => path.join(dir, `${clave.replace(/:/g, '_')}.json`);
const indiceDe = dir => path.join(dir, 'indice.json');

function escribirAtomico(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs > BAK_MS) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function leerIndice(dir) {
  try { const indice = JSON.parse(fs.readFileSync(indiceDe(dir), 'utf8')); return indice && typeof indice === 'object' ? indice : {}; } catch { return {}; }
}

// partes: [[clave, firma, json], ...] en el orden en que se escriben; borrar: claves de meses que ya no existen
function guardarPartes(dir, partes, borrar = []) {
  if (!Array.isArray(partes)) return false;
  const validas = partes.filter(p => Array.isArray(p) && CLAVE_RE.test(String(p[0])) && typeof p[2] === 'string');
  if (validas.length !== partes.length) return false;
  const indice = leerIndice(dir);
  for (const [clave, firma, json] of validas) {
    escribirAtomico(archivoDe(dir, clave), json);
    if (clave !== 'state') indice[clave] = String(firma || '');
  }
  for (const clave of Array.isArray(borrar) ? borrar : []) {
    if (!CLAVE_RE.test(String(clave)) || clave === 'state') continue;
    try { fs.unlinkSync(archivoDe(dir, clave)); } catch { /* ya no estaba */ }
    delete indice[clave];
  }
  escribirAtomico(indiceDe(dir), JSON.stringify(indice));
  return true;
}

function leerParte(dir, clave) {
  for (const file of [archivoDe(dir, clave), `${archivoDe(dir, clave)}.bak`]) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* probar la copia */ }
  }
  return null;
}

// Devuelve el estado completo como texto JSON, o null si no hay espejo por partes
function cargarPartes(dir) {
  const nucleo = leerParte(dir, 'state');
  if (!nucleo || typeof nucleo !== 'object') return null;
  const estado = { ...nucleo };
  delete estado.__historial; delete estado.__historialInfo;
  COLECCIONES.forEach(col => { estado[col] = Array.isArray(nucleo[col]) ? [...nucleo[col]] : []; });
  for (const clave of (Array.isArray(nucleo.__historial) ? [...nucleo.__historial].sort() : [])) {
    const col = String(clave).split(':')[1];
    if (!CLAVE_RE.test(String(clave)) || !COLECCIONES.includes(col)) continue;
    const parte = leerParte(dir, clave);
    if (parte && Array.isArray(parte.registros)) for (const r of parte.registros) estado[col].push(r);
  }
  return JSON.stringify(estado);
}

module.exports = { guardarPartes, cargarPartes, leerIndice, archivoDe };
