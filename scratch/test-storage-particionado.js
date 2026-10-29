// scratch/test-storage-particionado.js
// Guardado del historial por mes en IndexedDB (storage.js):
// 1. El estado se guarda como núcleo + un registro por mes; al cargar se rearma completo.
// 2. Un guardado normal escribe el núcleo y los meses recientes; los meses viejos sin cambios no se tocan.
// 3. Altas, bajas, montos y cambios de sincronización en un mes viejo se detectan sin marcarlos.
// 4. Una edición en el lugar que no cambia el resumen se guarda si se marca o en la revisión completa.
// 5. Un mes que queda vacío se borra; un estado antiguo (sin partir) se carga y se parte al guardar.
// 6. Rendimiento con 55.000 ventas: cuánto se copia en cada guardado.
// 7. Ventana de 90 días: los meses viejos sin pendientes quedan solo en IndexedDB, nunca se borran, entran en los
//    respaldos y se traen al consultarlos o cuando les llega un registro; restaurar un respaldo los reemplaza.
// 8. Espejo de Windows por partes: solo lo que cambió, incluye los meses archivados y se rearma completo.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('=== PRUEBAS: HISTORIAL PARTICIONADO POR MES EN INDEXEDDB ===\n');

// IndexedDB en memoria: transacciones asíncronas, copia estructurada al escribir y registro de lo escrito
const db = new Map(); let lotes = [];
function crearConexion() {
  return {
    objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {}, onversionchange: null, onclose: null,
    transaction(_store, modo) {
      const tx = { oncomplete: null, onerror: null, onabort: null }, escritas = [], borradas = [];
      tx.objectStore = () => ({
        get(k) { const rq = { onsuccess: null }; setTimeout(() => { rq.result = db.has(k) ? structuredClone(db.get(k)) : undefined; rq.onsuccess?.(); }); return rq; },
        put(v, k) { const copia = structuredClone(v); escritas.push(k); setTimeout(() => db.set(k, copia)); return { onsuccess: null }; },
        delete(k) { borradas.push(k); setTimeout(() => db.delete(k)); return { onsuccess: null }; }
      });
      setTimeout(() => setTimeout(() => { if (modo === 'readwrite') lotes.push({ escritas, borradas }); tx.oncomplete?.(); }));
      return tx;
    }
  };
}
global.indexedDB = { open() { const rq = { onsuccess: null }; setTimeout(() => { rq.result = crearConexion(); rq.onsuccess?.(); }); return rq; } };
global.window = { addEventListener() {} };
global.document = { addEventListener() {}, visibilityState: 'visible' };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.sessionStorage = global.localStorage;
global.navigator = {};
global.showToast = () => {};
global.__FORCE_DEMO_MODE__ = false;
require('../demo-mode.js');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'storage.js'), 'utf8'), { filename: 'storage.js' });
const interno = expr => vm.runInThisContext(expr);
vm.runInThisContext('storageReady = true');
vm.runInThisContext('histVentanaDias = 100000'); // pruebas 1 a 6: todo el historial en memoria (la ventana se prueba en la 7)

const hoy = new Date(), mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
const venta = (id, date, extra = {}) => ({ id, date, amount: 10000, method: 'Efectivo', items: [{ name: 'Cerveza', qty: 2, price: 5000 }], sync_status: 'synced', ...extra });
const ultimoLote = () => lotes[lotes.length - 1];
let pasadas = 0;
const ok = msg => { pasadas++; console.log(`  ✓ ${msg}`); };

(async () => {
  // 1. Guardar y volver a cargar
  global.state = {
    profile: { name: 'Bar' }, products: [{ id: 'p1' }], orders: [],
    payments: [venta('v1', '2025-11-03'), venta('v2', '2025-11-20'), venta('v3', '2026-01-05'), venta('v4', `${mesActual}-01`)],
    expenses: [{ id: 'g1', date: '2025-11-04', amount: 5000, sync_status: 'synced' }], purchases: []
  };
  await interno('persistNow')();
  assert.deepStrictEqual(db.get('state').payments, [], 'el núcleo no lleva el historial');
  assert.deepStrictEqual([...db.get('state').__historial].sort(), ['hist:expenses:2025-11', 'hist:payments:2025-11', `hist:payments:${mesActual}`, 'hist:payments:2026-01'].sort());
  const cargado = await interno('storageInit')();
  assert.deepStrictEqual(cargado.payments.map(p => p.id).sort(), ['v1', 'v2', 'v3', 'v4']);
  assert.strictEqual(cargado.expenses.length, 1); assert.strictEqual(cargado.profile.name, 'Bar'); assert(!('__historial' in cargado));
  global.state = cargado;
  ok('se guarda como núcleo + un registro por mes y al cargar se rearma completo');

  // 2. Guardado normal: núcleo + mes actual; los meses viejos no se tocan
  state.payments.push(venta('v5', `${mesActual}-02`, { sync_status: 'pending' }));
  await interno('persistNow')();
  assert.deepStrictEqual(ultimoLote().escritas, ['state', `hist:payments:${mesActual}`], JSON.stringify(ultimoLote()));
  await interno('persistNow')();
  assert.deepStrictEqual(ultimoLote().escritas, ['state'], 'sin cambios: solo el núcleo (el mes actual se compara y no se reescribe)');
  ok('un guardado normal escribe el núcleo y el mes actual; los meses viejos sin cambios no se escriben');

  // 3. Cambios en un mes viejo detectados por el resumen
  state.payments = state.payments.filter(p => p.id !== 'v1'); // factura anulada
  await interno('persistNow')();
  assert(ultimoLote().escritas.includes('hist:payments:2025-11'), 'baja en mes viejo');
  state.payments.find(p => p.id === 'v3').sync_status = 'pending'; // corrección pendiente de subir
  await interno('persistNow')();
  assert(ultimoLote().escritas.includes('hist:payments:2026-01'), 'cambio de sincronización en mes viejo');
  state.payments.find(p => p.id === 'v3').amount = 12000;
  await interno('persistNow')();
  assert(ultimoLote().escritas.includes('hist:payments:2026-01'), 'cambio de monto en mes viejo');
  ok('bajas, montos y estado de sincronización en meses viejos se detectan sin marcarlos');

  // 4. Edición en el lugar que no cambia el resumen
  state.payments.find(p => p.id === 'v2').customer = 'Mesa 9';
  await interno('persistNow')();
  assert(!ultimoLote().escritas.includes('hist:payments:2025-11'), 'la revisión rápida no la ve');
  await interno('flushAll')(); // al ocultar o cerrar la app: revisión completa
  assert(ultimoLote().escritas.includes('hist:payments:2025-11'), 'la revisión completa la guarda');
  state.payments.find(p => p.id === 'v2').customer = 'Mesa 10';
  interno('marcarHistorialModificado')('payments', state.payments.find(p => p.id === 'v2'));
  await interno('persistNow')();
  assert(ultimoLote().escritas.includes('hist:payments:2025-11'), 'marcada: se guarda en el siguiente guardado');
  vm.runInThisContext('histUltimaRevision = Date.now() - HIST_REVISION_MS - 1');
  state.payments.find(p => p.id === 'v2').customer = 'Mesa 11';
  await interno('persistNow')();
  assert(ultimoLote().escritas.includes('hist:payments:2025-11'), 'pasados 10 minutos, el guardado normal hace la revisión completa');
  const recargado = await interno('storageInit')();
  assert.strictEqual(recargado.payments.find(p => p.id === 'v2').customer, 'Mesa 11');
  assert.strictEqual(recargado.payments.find(p => p.id === 'v3').amount, 12000);
  global.state = recargado;
  ok('una edición en el lugar se guarda si se marca, al cerrar u ocultar la app, o en la revisión cada 10 minutos');

  // 5. Mes vacío y estado antiguo
  state.expenses = [];
  await interno('persistNow')();
  assert(ultimoLote().borradas.includes('hist:expenses:2025-11') && !db.has('hist:expenses:2025-11'));
  db.clear();
  db.set('state', { profile: { name: 'Antiguo' }, payments: [venta('a1', '2025-06-01'), venta('a2', `${mesActual}-03`)], expenses: [], purchases: [] });
  vm.runInThisContext('histGuardado = {}');
  global.state = await interno('storageInit')();
  assert.strictEqual(state.payments.length, 2);
  await interno('persistNow')();
  assert(db.has('hist:payments:2025-06') && db.get('state').payments.length === 0, 'se parte en el primer guardado');
  global.state = await interno('storageInit')();
  assert.deepStrictEqual(state.payments.map(p => p.id).sort(), ['a1', 'a2']);
  ok('un mes vacío se borra; un estado antiguo sin partir se carga igual y se parte al guardar');

  // 6. Rendimiento con un año de un bar con mucho movimiento
  const n = 55000, meses = 12, base = new Date(hoy.getFullYear(), hoy.getMonth() - (meses - 1), 1);
  state.payments = Array.from({ length: n }, (_, i) => { const d = new Date(base.getFullYear(), base.getMonth() + Math.floor(i * meses / n), 1 + (i % 28)); return venta(`y${i}`, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); });
  await interno('persistNow')(); // primera vez: escribe todos los meses
  state.payments.push(venta('nueva', `${mesActual}-04`));
  const copiado = () => ultimoLote().escritas.filter(k => k.startsWith('hist:')).reduce((s, k) => s + JSON.stringify(db.get(k)).length, JSON.stringify(db.get('state')).length);
  let t = performance.now(); await interno('persistNow')(); const ms = performance.now() - t;
  const parcial = copiado(), completo = JSON.stringify(state).length;
  assert(parcial * 5 < completo, `cada guardado copia mucho menos que el estado entero (${parcial} vs ${completo})`);
  t = performance.now(); structuredClone(state); const msAntes = performance.now() - t;
  ok(`55.000 ventas: cada guardado copia ${(parcial / 1048576).toFixed(1)} MB de ${(completo / 1048576).toFixed(1)} MB (antes: copia completa, ${msAntes.toFixed(0)} ms aquí; ahora ${ms.toFixed(0)} ms con la revisión de resúmenes)`);

  // 7. Ventana de 90 días
  vm.runInThisContext('histVentanaDias = 90');
  const mesHace = n => { const d = new Date(hoy.getFullYear(), hoy.getMonth() - n, 10); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const viejo = mesHace(8), viejoPend = mesHace(6), reciente = mesHace(1);
  db.clear(); vm.runInThisContext('histGuardado = {}; histArchivo = {}');
  global.state = {
    profile: { name: 'Bar' }, products: [], orders: [], expenses: [{ id: 'gv', date: `${viejo}-02`, amount: 1, sync_status: 'synced' }], purchases: [],
    payments: [venta('o1', `${viejo}-03`), venta('o2', `${viejo}-04`), venta('p1', `${viejoPend}-05`, { sync_status: 'pending' }), venta('r1', `${reciente}-06`), venta('h1', `${mesActual}-01`)]
  };
  await interno('persistNow')();
  global.state = await interno('storageInit')();
  assert.deepStrictEqual(state.payments.map(p => p.id).sort(), ['h1', 'p1', 'r1'], 'el mes viejo sin pendientes queda fuera; el que tiene una venta sin subir se carga');
  assert.strictEqual(state.expenses.length, 1, 'los gastos no se archivan');
  assert.strictEqual(interno('historialArchivado')(), true);
  assert(interno('historialVentanaDesde')() > `${viejo}-31`);
  await interno('persistNow')();
  assert(db.has(`hist:payments:${viejo}`) && db.get('state').__historial.includes(`hist:payments:${viejo}`), 'el mes archivado no se borra ni sale del núcleo');
  assert(!ultimoLote().escritas.includes(`hist:payments:${viejo}`), 'ni se reescribe');
  const respaldo = await interno('estadoCompleto')();
  assert.deepStrictEqual(respaldo.payments.map(p => p.id), ['o1', 'o2', 'p1', 'r1', 'h1'], 'el respaldo lleva todo, en orden');
  assert.strictEqual(state.payments.length, 3, 'el respaldo no deja lo viejo en memoria');
  assert.strictEqual(await interno('asegurarHistorial')(`${reciente}-01`), 0, 'una fecha dentro de la ventana no trae nada');
  assert.strictEqual(await interno('asegurarHistorial')(`${viejo}-15`), 2, 'una fecha vieja trae su mes');
  assert.deepStrictEqual(state.payments.map(p => p.id), ['o1', 'o2', 'p1', 'r1', 'h1']);
  assert.strictEqual(interno('historialArchivado')(), false);
  assert.strictEqual(await interno('asegurarHistorial')(''), 0, 'sin meses archivados no hace nada');
  ok('ventana de 90 días: lo viejo queda en el equipo, entra en los respaldos y se trae al consultarlo');

  global.state = await interno('storageInit')();
  state.payments.push(venta('o3', `${viejo}-20`)); // llega por tiempo real una venta editada de un mes archivado
  await interno('persistNow')();
  assert.deepStrictEqual(db.get(`hist:payments:${viejo}`).registros.map(p => p.id).sort(), ['o1', 'o2', 'o3'], 'el mes se trae entero antes de guardarlo: no se pierde lo archivado');
  global.state = await interno('storageInit')();
  assert(interno('historialArchivado')(), 'sin pendientes, el mes vuelve al archivo en el siguiente arranque');
  interno('descartarArchivoHistorial')(); // restaurar un respaldo que no trae los meses viejos
  global.state = { ...state, payments: state.payments.filter(p => p.date >= `${reciente}-01`) };
  await interno('persistNow')();
  assert(!db.has(`hist:payments:${viejo}`) && !db.has(`hist:payments:${viejoPend}`), 'restaurar un respaldo reemplaza también lo archivado');
  ok('un registro que llega a un mes archivado lo trae entero; restaurar un respaldo reemplaza lo archivado');

  // 8. Espejo de Windows por partes
  const os = require('os'), espejo = require('../electron/espejo-partes.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexopos-espejo-'));
  let llamadas = [];
  global.desktop = {
    saveMirror: async json => { llamadas.push(['completo', JSON.parse(json)]); return true; },
    saveMirrorParts: async (partes, borrar) => { llamadas.push(['partes', partes.map(p => p[0]), borrar]); return espejo.guardarPartes(dir, structuredClone(partes), borrar); },
    mirrorIndex: async () => espejo.leerIndice(dir)
  };
  db.clear(); vm.runInThisContext('histGuardado = {}; histArchivo = {}; mirrorIndice = null; mirrorPendiente.clear(); mirrorBorrar.clear()');
  global.state = { profile: { name: 'Bar' }, products: [], orders: [], expenses: [], purchases: [], payments: [venta('o1', `${viejo}-03`), venta('r1', `${reciente}-06`), venta('h1', `${mesActual}-01`)] };
  await interno('persistNow')();
  global.state = await interno('storageInit')(); // o1 queda archivado
  vm.runInThisContext('mirrorIndice = null; mirrorPendiente.clear()'); // primera escritura del espejo en esta sesión
  await interno('flushAll')();
  const primera = llamadas.filter(l => l[0] === 'partes').pop();
  assert.deepStrictEqual([...primera[1]].sort(), ['state', `hist:payments:${viejo}`, `hist:payments:${reciente}`, `hist:payments:${mesActual}`].sort(), 'la primera vez completa el disco, también lo archivado');
  assert.strictEqual(primera[1][primera[1].length - 1], 'state', 'el núcleo va al final');
  llamadas = [];
  state.payments.push(venta('h2', `${mesActual}-02`));
  await interno('flushAll')();
  assert.deepStrictEqual(llamadas.filter(l => l[0] === 'partes').pop()[1], [`hist:payments:${mesActual}`, 'state'], 'después solo lo que cambió');
  assert(!llamadas.some(l => l[0] === 'completo'), 'ya no serializa el estado entero');
  const rearmado = JSON.parse(espejo.cargarPartes(dir));
  assert.deepStrictEqual(rearmado.payments.map(p => p.id), ['o1', 'r1', 'h1', 'h2'], 'se rearma completo para restaurar');
  assert(!('__historial' in rearmado) && rearmado.profile.name === 'Bar');
  interno('descartarArchivoHistorial')();
  state.payments = state.payments.filter(p => p.date >= `${mesActual}-01`);
  await interno('flushAll')();
  assert(!fs.existsSync(espejo.archivoDe(dir, `hist:payments:${reciente}`)), 'un mes borrado también se borra del espejo');
  delete global.desktop.saveMirrorParts; llamadas = [];
  await interno('flushAll')();
  assert.strictEqual(llamadas[0][0], 'completo', 'con un preload anterior se escribe el archivo único');
  delete global.desktop;
  fs.rmSync(dir, { recursive: true, force: true });
  ok('espejo de Windows por partes: completa lo que falta, luego solo lo que cambió, y se rearma completo');

  console.log(`\n${pasadas} PRUEBAS SUPERADAS`);
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
