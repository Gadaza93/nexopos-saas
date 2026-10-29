// scratch/test-idb-resilience.js
// Conexión de IndexedDB resistente al BFCache de Safari iOS (storage.js):
// 1. Singleton: aperturas simultáneas comparten una sola petición indexedDB.open.
// 2. Una transacción cancelada (conexión huérfana) se reintenta con una conexión nueva y storageInit no falla.
// 3. onversionchange cierra la conexión y la siguiente operación abre otra.
// 4. onblocked suelta la conexión propia y la apertura continúa.
// 5. pagehide guarda primero y después cierra la conexión; al volver del BFCache se reabre sola.
// 6. Un open sin respuesta se corta por tiempo y se reintenta.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('=== PRUEBAS: INDEXEDDB Y BFCACHE ===\n');

const listeners = {};
global.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
global.document = { addEventListener: () => {}, visibilityState: 'visible' };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.sessionStorage = global.localStorage;
global.navigator = {};
global.showToast = () => {};
global.__FORCE_DEMO_MODE__ = false;
require('../demo-mode.js');

// IndexedDB simulado: cada open crea una conexión; las transacciones pueden fallar a pedido
const idb = { opens: 0, connections: [], data: new Map(), abortNext: 0, blockNext: false, hangNext: false, puts: 0 };
function makeConnection() {
  const conn = {
    closed: false, onversionchange: null, onclose: null, objectStoreNames: { contains: () => true }, createObjectStore() {},
    close() { this.closed = true; },
    transaction() {
      if (conn.closed) { const e = new Error('The database connection is closing.'); e.name = 'InvalidStateError'; throw e; }
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      const abort = idb.abortNext > 0 && idb.abortNext--;
      tx.objectStore = () => ({
        get: key => { const req = { onsuccess: null, result: idb.data.get(key) }; setTimeout(() => { if (abort) return tx.onabort?.(); req.onsuccess?.(); tx.oncomplete?.(); }); return req; },
        put: (value, key) => { const req = { onsuccess: null }; setTimeout(() => { if (abort) return tx.onabort?.(); idb.data.set(key, value); idb.puts++; req.onsuccess?.(); tx.oncomplete?.(); }); return req; }
      });
      return tx;
    }
  };
  idb.connections.push(conn);
  return conn;
}
global.indexedDB = {
  open() {
    idb.opens++;
    const request = { result: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
    if (idb.hangNext) { idb.hangNext = false; return request; } // nunca responde
    const blocked = idb.blockNext; idb.blockNext = false;
    setTimeout(() => {
      if (blocked) request.onblocked?.();
      setTimeout(() => { request.result = makeConnection(); request.onsuccess?.(); }, blocked ? 5 : 0);
    });
    return request;
  }
};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../storage.js'), 'utf8'), { filename: 'storage.js' });
const get = expr => vm.runInThisContext(expr);
let passed = 0;
const ok = label => { passed++; console.log(`  ✓ ${label}`); };

(async () => {
  // 1. Singleton
  const [a, b, c] = await Promise.all([idbOpen(), idbOpen(), idbOpen()]);
  assert.strictEqual(idb.opens, 1); assert(a === b && b === c);
  ok('tres aperturas simultáneas comparten una sola conexión');

  // 2. Transacción cancelada al arrancar (conexión huérfana tras volver del Modo Demo)
  closeStorageDb(); idb.data.set('state', { products: [1, 2] }); idb.abortNext = 1;
  const saved = await storageInit();
  assert.deepStrictEqual(saved, { products: [1, 2] });
  assert.strictEqual(get('storageMode'), 'indexeddb');
  ok('storageInit se recupera de «Transacción cancelada» reabriendo la conexión');

  // 3. onversionchange
  const before = get('storageDb'); before.onversionchange();
  assert(before.closed && get('storageDb') === null);
  await idbPut('state', { v: 3 });
  assert(get('storageDb') && get('storageDb') !== before);
  ok('onversionchange cierra la conexión y la siguiente escritura abre otra');

  // 4. onblocked
  const held = get('storageDb'); idb.blockNext = true;
  const opened = await idbOpenOnce(); // apertura bloqueada mientras sigue viva la conexión anterior
  assert(held.closed && get('storageDb') === null, 'onblocked debe soltar la conexión propia');
  assert(opened && !opened.closed);
  vm.runInThisContext('storageDb = null'); opened.close();
  ok('una apertura bloqueada suelta la conexión propia y continúa');

  // 5. pagehide: guarda y después cierra
  await idbOpen();
  globalThis.state = { products: ['pagehide'] }; vm.runInThisContext('storageReady = true');
  const conn = get('storageDb'); const putsBefore = idb.puts;
  listeners.pagehide.forEach(fn => fn({ persisted: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(idb.puts, putsBefore + 1, 'el guardado debe completarse antes de cerrar');
  assert(conn.closed && get('storageDb') === null);
  await idbPut('state', { back: true });
  assert(get('storageDb') && !get('storageDb').closed);
  ok('pagehide guarda, cierra la conexión y al volver del BFCache se reabre');

  // 6. open sin respuesta
  closeStorageDb(); idb.hangNext = true; const opensBefore = idb.opens;
  const t0 = Date.now(); const db = await idbOpen();
  assert(db && idb.opens === opensBefore + 2 && Date.now() - t0 >= 5900);
  ok('un indexedDB.open que no responde se corta y se reintenta');

  console.log(`\n${passed} PRUEBAS SUPERADAS`);
})().catch(e => { console.error('✗', e); process.exit(1); });
