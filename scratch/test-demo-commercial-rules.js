// scratch/test-demo-commercial-rules.js
// Prueba integral de las 3 reglas de control comercial en Modo Demo:
// 1. Límite de transacciones (Tope 10 pedidos/ventas, bloqueo en #11, modal obsidian y enlace a WhatsApp Netxpremium)
// 2. Reinicio periódico de datos (Reset automático en recarga o tras 2 horas de inactividad)
// 3. Marca de agua y protección de reportes (En pantalla, al imprimir y al descargar Excel)

const fs = require('fs');
const assert = require('assert');

console.log('=== INICIANDO PRUEBAS: REGLAS DE CONTROL COMERCIAL EN MODO DEMO ===\n');

// Mock simple de DOM para simular navegador
const mockStorage = {
  session: {},
  local: {}
};

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

function createMockElement(initial = {}) {
  const classes = new Set();
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    title: '',
    style: {},
    dataset: {},
    disabled: false,
    open: false,
    hidden: false,
    href: '',
    showModal() { this.open = true; },
    close() { this.open = false; },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (force) classes.add(c); else classes.delete(c);
      },
      contains: c => classes.has(c)
    },
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: sel => document.querySelector(sel),
    ...initial
  };
}

const mockElements = {};
global.document = {
  querySelector(sel) {
    if (!mockElements[sel]) {
      mockElements[sel] = createMockElement({ id: sel.replace(/[#.]/g, '') });
    }
    return mockElements[sel];
  },
  querySelectorAll() { return []; },
  addEventListener() {},
  visibilityState: 'visible'
};

global.window = {
  location: { search: '?demo=true', hostname: 'demo.nexopos.app', protocol: 'https:' },
  open: (url, target) => ({
    document: {
      write: (html) => { global.__lastPrintedHtml = html; },
      close: () => {}
    }
  }),
  print: () => { global.__windowPrintCalled = true; },
  addEventListener: () => {},
  desktop: null
};
global.navigator = { onLine: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
globalThis.__IS_NODE_TEST__ = true;

// Cargar index.html para verificar que los elementos del modal y marcas de agua existen
const indexHtml = fs.readFileSync('index.html', 'utf8');
const designCss = fs.readFileSync('design.css', 'utf8');

console.log('1. Verificando estructura HTML y CSS...');
assert(indexHtml.includes('id="demoLimitDialog"'), 'Falta dialog #demoLimitDialog en index.html');
assert(indexHtml.includes('obsidian-modal'), 'Falta clase obsidian-modal en index.html');
assert(indexHtml.includes('Has alcanzado el límite de prueba interactiva de NexoPos'), 'Falta mensaje exacto de límite en index.html');
assert(indexHtml.includes('id="demoWhatsappBtn"'), 'Falta botón de WhatsApp #demoWhatsappBtn en index.html');
assert(indexHtml.includes('Netxpremium'), 'Falta mención a Netxpremium en index.html');

// Marcas de agua en index.html
assert(indexHtml.includes('id="reportWatermarkTop"'), 'Falta #reportWatermarkTop en index.html');
assert(indexHtml.includes('id="reportWatermarkBottom"'), 'Falta #reportWatermarkBottom en index.html');
assert(indexHtml.includes('id="ticketWatermarkTop"'), 'Falta #ticketWatermarkTop en index.html');
assert(indexHtml.includes('id="ticketWatermarkBottom"'), 'Falta #ticketWatermarkBottom en index.html');
assert(indexHtml.includes('id="payWatermarkTop"'), 'Falta #payWatermarkTop en index.html');
assert(indexHtml.includes('id="payWatermarkBottom"'), 'Falta #payWatermarkBottom en index.html');
assert(indexHtml.includes('DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM'), 'Falta texto exacto de marca de agua en index.html');

// CSS obsidian y watermark
assert(designCss.includes('.obsidian-modal'), 'Falta estilo .obsidian-modal en design.css');
assert(designCss.includes('.obsidian-wa-btn'), 'Falta estilo .obsidian-wa-btn en design.css');
assert(designCss.includes('.demo-watermark-bar'), 'Falta estilo .demo-watermark-bar en design.css');
assert(designCss.includes('.demo-watermark-tag'), 'Falta estilo .demo-watermark-tag en design.css');
console.log('   ✅ Elementos HTML y estilos CSS Obsidian verificados con éxito.\n');

// Cargar scripts en orden estándar
delete require.cache[require.resolve('../storage.js')];
require('../storage.js');
delete require.cache[require.resolve('../modules.js')];
require('../modules.js');
delete require.cache[require.resolve('../sync.js')];
require('../sync.js');
delete require.cache[require.resolve('../print.js')];
require('../print.js');
delete require.cache[require.resolve('../app.js')];
require('../app.js');

console.log('2. Probando Regla 1: Límite de transacciones (Tope de prueba = 10)...');

// Forzar modo demo
assert.strictEqual(isDemoMode(), true, 'Debe estar en Modo Demo');
sessionStorage.clear();

// Inicializar datos demo
resetDemoData({ silent: true });
assert.strictEqual(state.products.length, 14, 'Deben existir 14 productos demo');
assert.strictEqual(getDemoTransactionCount(), 0, 'Contador de transacciones inicia en 0');
assert.strictEqual(isDemoLimitReached(), false, 'Límite no debe estar alcanzado al inicio');

// Abrir turno de caja
state.cashShift = { id: 'shift_demo_1', status: 'open', openingCash: 50000 };

// Simular 10 pedidos/transacciones
for (let i = 1; i <= 10; i++) {
  openOrder(`mesa_test_${i}`);
  assert.strictEqual(getDemoTransactionCount(), i, `Debe haber contado la transacción #${i}`);
}

assert.strictEqual(getDemoTransactionCount(), 10, 'Deben haberse registrado exactamente 10 transacciones');
assert.strictEqual(isDemoLimitReached(), true, 'isDemoLimitReached() debe ser true al alcanzar 10');

// Intentar registrar el pedido #11
const orderCountBefore = state.orders.length;
const demoDialog = document.querySelector('#demoLimitDialog');
demoDialog.open = false;

openOrder('mesa_test_11');

assert.strictEqual(state.orders.length, orderCountBefore, 'El pedido #11 NO debe haber sido creado en state.orders');
assert.strictEqual(demoDialog.open, true, 'El modal #demoLimitDialog debe haberse abierto');

const waBtn = document.querySelector('#demoWhatsappBtn');
assert(waBtn.href.includes('wa.me'), 'El enlace de WhatsApp debe apuntar a wa.me');
assert(waBtn.href.includes('Netxpremium'), 'El enlace debe incluir el mensaje comercial de Netxpremium');
console.log('   ✅ Transacciones 1 a 10 permitidas exitosamente.');
console.log('   ✅ Pedido #11 bloqueado y modal Obsidian desplegado con enlace a WhatsApp de Netxpremium.\n');

console.log('3. Probando Regla 2: Reinicio periódico de datos (Reset automático)...');
// Modificar datos para simular cambios de un visitante
state.products.push({ id: 'p_usuario_extra', name: 'Producto del visitante', price: 99999 });
state.tables.push({ id: 'mesa_extra', name: 'Mesa inventada' });
assert.strictEqual(state.products.length, 15, 'Hay 15 productos con el producto del visitante');

// A) Simular recarga de página (resetDemoData silencioso en bootstrap)
resetDemoData({ silent: true });
assert.strictEqual(state.products.length, 14, 'Se limpió el producto del visitante y volvieron los 14 originales');
assert.strictEqual(state.products.some(p => p.id === 'p_usuario_extra'), false, 'El producto del visitante fue eliminado');
assert.strictEqual(state.orders.length, 0, 'Las órdenes se reiniciaron a 0');
assert.strictEqual(state.tables.length, 4, 'Mesas restauradas a las 4 mesas demo');
console.log('   ✅ Recarga de página restaura los 14 productos y mesas por defecto.');

// B) Simular inactividad de más de 2 horas (7,200,000 ms)
state.products.push({ id: 'p_otro_cambio', name: 'Otro producto' });
assert.strictEqual(state.products.length, 15);

// Simular que la última actividad fue hace 2 horas y 1 minuto (7,260,000 ms atrás)
localStorage.setItem('nexopos_demo_last_activity', String(Date.now() - (2 * 60 * 60 * 1000 + 60000)));
checkDemoInactivity();

assert.strictEqual(state.products.length, 14, 'Inactividad > 2h restauró los 14 productos');
assert.strictEqual(state.products.some(p => p.id === 'p_otro_cambio'), false, 'Producto extra eliminado');
assert.strictEqual(sessionStorage.getItem('nexopos_demo_tx_count'), null, 'El contador de sesión fue reseteado tras 2 horas');
console.log('   ✅ Detección de 2 horas de inactividad restaura datos y reinicia sesión correctamente.\n');

console.log('4. Probando Regla 3: Marca de agua y protección de reportes...');
// A) En pantalla: renderOrderDialog() y openPayment()
const ticketWmTop = document.querySelector('#ticketWatermarkTop');
const ticketWmBottom = document.querySelector('#ticketWatermarkBottom');
state.currentOrderId = null;
openOrder('b1'); // Abre Barra 1
renderOrderDialog();
assert.strictEqual(ticketWmTop.hidden, false, '#ticketWatermarkTop debe ser visible en demo');
assert.strictEqual(ticketWmBottom.hidden, false, '#ticketWatermarkBottom debe ser visible en demo');

const payWmTop = document.querySelector('#payWatermarkTop');
const payWmBottom = document.querySelector('#payWatermarkBottom');
openPayment();
assert.strictEqual(payWmTop.hidden, false, '#payWatermarkTop debe ser visible en cobro');
assert.strictEqual(payWmBottom.hidden, false, '#payWatermarkBottom debe ser visible en cobro');

// B) Al imprimir Ticket Z: printShiftZ()
global.__lastPrintedHtml = '';
// El Ticket Z pasa por el motor unificado printReceipt (print.js): se captura el HTML enviado a imprimir
globalThis.printReceipt = async html => { global.__lastPrintedHtml = html; return { ok: true }; };
printShiftZ({
  id: 'shift_test',
  closedAt: Date.now(),
  closedBy: 'Cajero Demo',
  totalSales: 85000,
  cashSales: 50000,
  otherSales: 35000,
  cashExpenses: 0,
  openingCash: 50000,
  expected: 100000,
  counted: 100000,
  difference: 0
});

assert(global.__lastPrintedHtml.includes('DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM'), 'El Ticket Z impreso debe contener la marca de agua de demostración');
console.log('   ✅ Marcas de agua visibles en pantalla (Ticket y Cobro) y en impresión de Ticket Z.');

// C) Al descargar Excel y Reportes en pantalla/impresión (modules.js)
global.showToast = () => {};
global.can = () => true;
renderReports();
const repWmTop = document.querySelector('#reportWatermarkTop');
const repWmBottom = document.querySelector('#reportWatermarkBottom');
assert.strictEqual(repWmTop.hidden, false, '#reportWatermarkTop debe ser visible en reportes');
assert.strictEqual(repWmBottom.hidden, false, '#reportWatermarkBottom debe ser visible en reportes');

// Imprimir reporte
printReport();
const printHeader = document.querySelector('#printHeader');
const printFooter = document.querySelector('#printFooter');
assert(printHeader.textContent.includes('DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM'), 'Encabezado de impresión debe incluir marca');
assert(printFooter.textContent.includes('DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM'), 'Pie de página de impresión debe incluir marca');

// Exportar reporte Excel
const sheets = reportSheets();
assert(sheets.length > 0, 'Debe generar hojas de reporte');
sheets.forEach(s => {
  const firstRow = s.rows[0];
  const lastRow = s.rows[s.rows.length - 1];
  assert(firstRow.some(cell => (cell.v || cell) === 'DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM'), `Hoja ${s.name} debe tener marca en encabezado`);
  assert(lastRow.some(cell => (cell.v || cell) === 'DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM'), `Hoja ${s.name} debe tener marca en pie de página`);
});
console.log('   ✅ Reportes en pantalla, impresión PDF y hojas de Excel protegidas con marca de agua.\n');

console.log('=== TODAS LAS PRUEBAS DE CONTROL COMERCIAL PASARON CON ÉXITO ===');
