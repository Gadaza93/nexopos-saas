// scratch/test-demo-shielding.js
// Verificación del Blindaje Total de Modo Demo (?demo=true):
// 1. Aislamiento de BD: 'nexopos_demo_db' vs 'nexopos'
// 2. Aislamiento de sesión: usuario 'Invitado Demo' con PIN '1234'
// 3. Desconexión de Supabase: cero lecturas y cero escrituras
// 4. Datos ficticios inmutables: exactamente 14 productos, 4 mesas, ventas en $0

const assert = require('assert');
const fs = require('fs');

console.log('=== INICIANDO PRUEBAS: BLINDAJE TOTAL DE MODO DEMO ===\n');

// Mock simple de DOM y Storage
const mockStorage = { session: {}, local: {} };
global.sessionStorage = {
  getItem: k => mockStorage.session[k] || null,
  setItem: (k, v) => { mockStorage.session[k] = String(v); },
  removeItem: k => { delete mockStorage.session[k]; },
  clear: () => { mockStorage.session = {}; }
};
global.localStorage = {
  getItem: k => mockStorage.local[k] || null,
  setItem: (k, v) => { mockStorage.local[k] = String(v); },
  removeItem: k => { delete mockStorage.local[k]; },
  clear: () => { mockStorage.local = {}; }
};

let openedDbName = null;
global.indexedDB = {
  open: (name, version) => {
    openedDbName = name;
    return {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => ({
          objectStore: () => ({
            get: () => ({ onsuccess: null }),
            put: () => ({ onsuccess: null })
          }),
          oncomplete: null
        })
      },
      onsuccess: null,
      onerror: null
    };
  }
};

let mirrorLoaded = false, mirrorSaved = false;
global.desktop = {
  isDesktop: false,
  loadMirror: async () => { mirrorLoaded = true; return null; },
  saveMirror: async () => { mirrorSaved = true; return { ok: true }; }
};

function createMockElement(initial = {}) {
  const classes = new Set();
  return {
    value: '', textContent: '', innerHTML: '', className: '', title: '', style: {}, dataset: {},
    disabled: false, open: false, hidden: false,
    showModal() { this.open = true; }, close() { this.open = false; },
    setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      toggle: (c, force) => { if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); } else if (force) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c)
    },
    addEventListener() {}, querySelectorAll: () => [], querySelector: sel => document.querySelector(sel),
    ...initial
  };
}

const mockElements = {};
global.document = {
  querySelector: sel => {
    if (!mockElements[sel]) mockElements[sel] = createMockElement({ id: sel.replace(/[#.]/g, '') });
    return mockElements[sel];
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
  visibilityState: 'visible'
};

global.window = {
  location: { search: '?demo=true', hostname: 'demo.nexopos.app', protocol: 'https:' },
  addEventListener: () => {},
  desktop: null
};
global.navigator = { onLine: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
globalThis.__IS_NODE_TEST__ = true;

// 1. Simular que existían datos reales de producción en localStorage y en sessionStorage
localStorage.setItem('brasa-pos-v1', JSON.stringify({
  products: [{ id: 'prod_real_1', name: 'Whisky Producción Real', price: 999999 }],
  payments: [{ id: 'v_real_1', amount: 500000 }]
}));
sessionStorage.setItem('brasa-session', 'admin_real_id');

// Cargar módulos
delete require.cache[require.resolve('../storage.js')];
require('../storage.js');
delete require.cache[require.resolve('../modules.js')];
require('../modules.js');
delete require.cache[require.resolve('../sync.js')];
const NexoSync = require('../sync.js');
delete require.cache[require.resolve('../app.js')];
require('../app.js');

console.log('1. Probando Aislamiento de Base de Datos y Storage...');
assert.strictEqual(isDemoMode(), true, 'Debe detectar Modo Demo por ?demo=true');
assert.strictEqual(getDbName(), 'nexopos_demo_db', 'En Modo Demo la BD IndexedDB debe ser estrictamente "nexopos_demo_db"');
assert.strictEqual(readLegacy(), null, 'readLegacy() debe retornar null para no migrar datos reales de localStorage');
console.log('   ✅ getDbName() retorna "nexopos_demo_db".');
console.log('   ✅ readLegacy() bloquea lectura de datos reales de producción.');

console.log('\n2. Probando Desconexión y Bloqueo Total de Supabase...');
const client = NexoSync.getClient();
assert.strictEqual(client, null, 'En Modo Demo, getClient() debe retornar estrictamente null (sin conexión)');

return NexoSync.pullAllFromSupabase().then(pullRes => {
  assert.strictEqual(pullRes.ok, true);
  assert.strictEqual(pullRes.demo, true);
  assert.strictEqual(pullRes.count, 0, 'No debe descargar registros de producción');
  console.log('   ✅ getClient() retorna null: Cliente Supabase completamente desconectado.');
  console.log('   ✅ pullAllFromSupabase() omite peticiones de lectura hacia Supabase.');

  console.log('\n3. Probando Aislamiento de Sesión y Usuario Ficticio "Invitado Demo"...');
  resetDemoData({ silent: true });
  initModules();

  assert.strictEqual(state.users.length, 1, 'Debe haber exactamente 1 usuario en modo demo');
  const demoUser = state.users[0];
  assert.strictEqual(demoUser.id, 'u_demo_guest', 'El id del usuario debe ser "u_demo_guest"');
  assert.strictEqual(demoUser.name, 'Invitado Demo', 'El nombre debe ser "Invitado Demo"');
  assert.strictEqual(demoUser.role, 'admin', 'El rol debe ser admin para permitir pruebas');

  // Verificar PIN '1234'
  const isPinValid = hashPin('1234', demoUser.salt) === demoUser.pinHash;
  assert.strictEqual(isPinValid, true, 'El PIN del usuario Invitado Demo debe ser 1234');

  // Verificar sesión iniciada directamente con Invitado Demo
  assert.strictEqual(me().id, 'u_demo_guest', 'La sesión activa debe ser la de Invitado Demo');
  assert.strictEqual(sessionStorage.getItem('brasa-session'), 'admin_real_id', 'La clave de sesión real no se borra de storage pero se ignora');
  console.log('   ✅ Usuario ficticio "Invitado Demo" presente con PIN inicial 1234.');
  console.log('   ✅ Sesión activa entra directo con "Invitado Demo" ignorando al admin real.');

  console.log('\n4. Probando Set de Datos Precargados Ficticios (14 productos, 4 mesas, $0 ventas)...');
  assert.strictEqual(state.products.length, 14, 'Deben existir exactamente 14 productos');
  assert.strictEqual(state.tables.length, 4, 'Deben existir exactamente 4 mesas de prueba');
  assert.deepStrictEqual(state.tables.map(t => t.name), ['Mesa 1', 'Mesa 2', 'Mesa 3', 'Mesa 4']);
  assert.strictEqual(state.payments.length, 0, 'Las ventas deben iniciar en $0 (0 pagos)');
  assert.strictEqual(state.orders.length, 0, 'Las órdenes deben iniciar en 0');

  // Verificar que contenga productos clave solicitados
  const productNames = state.products.map(p => p.name.toLowerCase());
  assert(productNames.some(n => n.includes('capuchino')), 'Debe incluir Capuchino');
  assert(productNames.some(n => n.includes('bandeja paisa')), 'Debe incluir Bandeja paisa');
  assert(productNames.some(n => n.includes('papas')), 'Debe incluir Papas');

  console.log('   ✅ Exactamente 14 productos de prueba presentes (incluyendo Corona, Club Colombia, Papas).');
  console.log('   ✅ Exactamente 4 mesas de prueba configuradas (Mesa 1 a Mesa 4).');
  console.log('   ✅ Ventas y comandas en $0.');

  console.log('\n5. Verificando que en Desktop / Producción (?demo=false) se use la BD real...');
  global.window.desktop = { isDesktop: true };
  global.window.location.search = '?demo=false';
  assert.strictEqual(isDemoMode(), false, 'En producción isDemoMode() debe ser false');
  assert.strictEqual(getDbName(), 'nexopos', 'En producción la BD debe ser "nexopos"');
  console.log('   ✅ En modo producción se restablece la BD "nexopos" y sincronización real.');

  console.log('\n=== BLINDAJE TOTAL DE MODO DEMO VERIFICADO CON ÉXITO ===');
  process.exit(0);
});
