// Test script for Responsive Navigation, Product Cards, and Mobile Order Modal
const fs = require('fs');
const path = require('path');

console.log("=== INICIANDO PRUEBAS: TARJETAS RESPONSIVE, MENÚ HAMBURGUESA Y MODAL MÓVIL ===");

// 1. Verificación de CSS (styles.css)
console.log("\n1. Verificando reglas CSS en styles.css...");
const cssContent = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

// A. Product Grid
if (!cssContent.includes('repeat(auto-fill, minmax(150px, 1fr))')) {
  throw new Error("CSS Error: .product-grid no tiene 'repeat(auto-fill, minmax(150px, 1fr))'");
}
console.log("   ✅ .product-grid configurado con auto-fill minmax(150px, 1fr)");

// B. Product Card Layout
if (!cssContent.includes('min-height: 236px;') || !cssContent.includes('border-radius: 16px;') || !cssContent.includes('flex-direction: column;')) {
  throw new Error("CSS Error: .product o .product-card no tiene 'min-height: 236px;', 'border-radius: 16px;' o flex column");
}
console.log("   ✅ .product / .product-card vertical: min-height 236px, flex column y border-radius 16px");

// C. Product Title
if (!cssContent.includes('-webkit-line-clamp: 2;') || !cssContent.includes('font-weight: 600;')) {
  throw new Error("CSS Error: .product-title no tiene clamp de 2 líneas o font-weight: 600");
}
console.log("   ✅ .product-title configurado con -webkit-line-clamp: 2 y font-weight: 600");

// D. Product Footer Row
if (!cssContent.includes('.product-media {') || !cssContent.includes('height: 108px;') || !cssContent.includes('object-fit: contain;') || !cssContent.includes('.product-divider {')) {
  throw new Error("CSS Error: falta .product-media (108px, object-fit: contain) o .product-divider");
}
console.log("   ✅ .product-media de 108px con object-fit: contain y .product-divider");

// E. Mobile Breakpoint 768px
if (!cssContent.includes('@media (max-width: 768px)') && !cssContent.includes('@media(max-width:768px)')) {
  throw new Error("CSS Error: Falta media query @media (max-width: 768px)");
}
console.log("   ✅ Media query @media (max-width: 768px) definido correctamente");

// F. Mobile Drawer y Overlay CSS
if (!cssContent.includes('.mobile-drawer') || !cssContent.includes('.mobile-overlay') || !cssContent.includes('.mobile-menu-btn')) {
  throw new Error("CSS Error: Faltan estilos para .mobile-drawer, .mobile-overlay o .mobile-menu-btn");
}
if (!cssContent.includes('width: 85%;') || !cssContent.includes('max-width: 320px;') || !cssContent.includes('padding: 24px 18px;')) {
  throw new Error("CSS Error: .mobile-drawer no tiene width: 85%, max-width: 320px o padding: 24px 18px");
}
if (!cssContent.includes('white-space: nowrap;') || !cssContent.includes('gap: 14px;')) {
  throw new Error("CSS Error: .nav-link no tiene white-space: nowrap o gap: 14px");
}
if (!cssContent.includes('min-width: 24px;') || !cssContent.includes('flex-shrink: 0;')) {
  throw new Error("CSS Error: Los iconos del drawer no tienen min-width: 24px o flex-shrink: 0");
}
if (!cssContent.includes('margin-top: auto;') || !cssContent.includes('text-align: center;')) {
  throw new Error("CSS Error: .mobile-shift-bar no tiene margin-top: auto o text-align: center");
}
console.log("   ✅ Estilos de .mobile-drawer (85%, max-width: 320px, padding: 24px 18px, iconos 24px y botón caja) verificados");

// 2. Verificación de HTML (index.html)
console.log("\n2. Verificando estructura HTML en index.html...");
const htmlContent = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Botón hamburguesa
if (!htmlContent.includes('id="btn-mobile-menu"')) {
  throw new Error("HTML Error: Falta botón #btn-mobile-menu en topbar");
}
console.log("   ✅ Botón hamburguesa #btn-mobile-menu presente en el topbar");

// Drawer y overlay
if (!htmlContent.includes('id="mobileDrawer"') || !htmlContent.includes('id="mobileMenuOverlay"')) {
  throw new Error("HTML Error: Falta #mobileDrawer o #mobileMenuOverlay");
}
console.log("   ✅ Drawer #mobileDrawer y overlay #mobileMenuOverlay presentes");

// Enlaces requeridos en el drawer
const requiredViews = [
  { view: 'pos', text: 'Punto de venta' },
  { view: 'invoices', text: 'Facturas' },
  { view: 'products', text: 'Productos' },
  { view: 'inventory', text: 'Inventario' },
  { view: 'purchases', text: 'Compras y gastos' },
  { view: 'reports', text: 'Reportes' },
  { view: 'profile', text: 'Mi negocio' },
  { view: 'team', text: 'Equipo' }
];

requiredViews.forEach(({ view, text }) => {
  const match = htmlContent.includes(`data-view="${view}"`);
  if (!match) throw new Error(`HTML Error: Falta enlace a vista '${view}' (${text}) en el menú`);
  console.log(`   ✅ Enlace a '${text}' (data-view="${view}") presente en el drawer`);
});

// Pestañas y barra flotante en el modal de comanda
if (!htmlContent.includes('id="orderTabsMobile"') || !htmlContent.includes('id="mobileOrderBar"')) {
  throw new Error("HTML Error: Falta #orderTabsMobile o #mobileOrderBar en el modal de pedido");
}
if (!htmlContent.includes('id="mobileBarTicketBtn"') || !htmlContent.includes('id="mobileBarChargeBtn"')) {
  throw new Error("HTML Error: Faltan botones 'Ver comanda' (#mobileBarTicketBtn) o 'Cobrar' (#mobileBarChargeBtn) en la barra flotante");
}
console.log("   ✅ Pestañas móviles (#orderTabsMobile) y barra flotante con botones presentes en el modal de comanda");

// 3. Verificación funcional en JS (app.js)
console.log("\n3. Verificando lógica JS en app.js...");

// Mock DOM
function createMockElement(initial = {}) {
  const listeners = {};
  const classes = new Set();
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    disabled: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c); else classes.add(c);
        } else if (force) classes.add(c); else classes.delete(c);
      },
      contains: (c) => classes.has(c)
    },
    addEventListener: (evt, fn) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    trigger: (evt, data) => {
      (listeners[evt] || []).forEach(fn => fn(data));
    },
    setAttribute: () => {},
    removeAttribute: () => {},
    querySelectorAll: () => [],
    ...initial
  };
}

const mockElements = {
  '#btn-mobile-menu': createMockElement(),
  '#btn-close-drawer': createMockElement(),
  '#mobileMenuOverlay': createMockElement(),
  '#mobileDrawer': createMockElement(),
  '#mobileShiftBtn': createMockElement(),
  '#brandLabel': createMockElement({ textContent: 'NexoPos' }),
  '#mobileDrawerBrand': createMockElement(),
  '#orderTabsMobile': createMockElement(),
  '#orderTabProducts': createMockElement(),
  '#orderTabTicket': createMockElement(),
  '#mobileOrderCount': createMockElement(),
  '#mobileOrderBar': createMockElement(),
  '#mobileBarCount': createMockElement(),
  '#mobileBarTotal': createMockElement(),
  '#mobileBarTicketBtn': createMockElement(),
  '#mobileBarChargeBtn': createMockElement(),
  '.catalog-panel': createMockElement(),
  '.ticket-panel': createMockElement(),
  '#orderDialog': createMockElement({ showModal: () => {}, close: () => {} }),
  '#orderZone': createMockElement(),
  '#orderTitle': createMockElement(),
  '#orderNote': createMockElement(),
  '#categoryTabs': createMockElement(),
  '#productGrid': createMockElement(),
  '#ticketItems': createMockElement(),
  '#orderTotal': createMockElement(),
  '#deleteOrderButton': createMockElement(),
  '#paidNote': createMockElement({ hidden: true }),
  '#todayLabel': createMockElement(),
  '#shiftStatusButton': createMockElement(),
  '#salesToday': createMockElement(),
  '#salesCount': createMockElement(),
  '#activeTables': createMockElement(),
  '#activeItems': createMockElement(),
  '#openOrdersCount': createMockElement(),
  '#cashExpected': createMockElement(),
  '#tableGrid': createMockElement(),
  '#customOrdersList': createMockElement()
};

global.document = {
  querySelector: (sel) => mockElements[sel] || createMockElement(),
  querySelectorAll: () => [],
  addEventListener: () => {}
};

require('../storage.js');
require('../modules.js');
require('../sync.js');
require('../app.js');

// Probar switchOrderTab('ticket') y switchOrderTab('products')
if (typeof globalThis.switchOrderTab !== 'function') {
  throw new Error("JS Error: globalThis.switchOrderTab no está definida");
}

console.log("   Probando switchOrderTab('ticket')...");
globalThis.switchOrderTab('ticket');
if (!mockElements['.catalog-panel'].classList.contains('tab-hidden')) {
  throw new Error(".catalog-panel no recibió clase .tab-hidden al cambiar a tab ticket");
}
if (!mockElements['.ticket-panel'].classList.contains('tab-visible')) {
  throw new Error(".ticket-panel no recibió clase .tab-visible al cambiar a tab ticket");
}
if (!mockElements['#mobileOrderBar'].classList.contains('tab-hidden')) {
  throw new Error("#mobileOrderBar no recibió clase .tab-hidden al cambiar a tab ticket");
}
console.log("   ✅ switchOrderTab('ticket') oculta catálogo y muestra comanda");

console.log("   Probando switchOrderTab('products')...");
globalThis.switchOrderTab('products');
if (mockElements['.catalog-panel'].classList.contains('tab-hidden')) {
  throw new Error(".catalog-panel mantuvo clase .tab-hidden al volver a tab products");
}
if (mockElements['.ticket-panel'].classList.contains('tab-visible')) {
  throw new Error(".ticket-panel mantuvo clase .tab-visible al volver a tab products");
}
if (mockElements['#mobileOrderBar'].classList.contains('tab-hidden')) {
  throw new Error("#mobileOrderBar mantuvo clase .tab-hidden al volver a tab products");
}
console.log("   ✅ switchOrderTab('products') restaura catálogo y barra flotante");

// Probar updateMobileOrderBar() con comanda de prueba
console.log("   Probando updateMobileOrderBar()...");
global.state.orders = [{
  id: 'ord_test_mobile',
  items: [
    { productId: 'p1', name: 'Cerveza Club Colombia', price: 6000, qty: 2 },
    { productId: 'p2', name: 'Agua Manantial', price: 3000, qty: 1 }
  ],
  status: 'open'
}];
global.state.currentOrderId = 'ord_test_mobile';

globalThis.updateMobileOrderBar();

const badgeCount = mockElements['#mobileOrderCount'].textContent;
const barCountText = mockElements['#mobileBarCount'].textContent;
const barTotalText = mockElements['#mobileBarTotal'].textContent;
const ticketBtnDisabled = mockElements['#mobileBarTicketBtn'].disabled;
const chargeBtnDisabled = mockElements['#mobileBarChargeBtn'].disabled;

console.log("   - Badge contador:", badgeCount);
console.log("   - Barra texto:", barCountText, "| Total:", barTotalText);
console.log("   - Botón ticket deshabilitado:", ticketBtnDisabled);
console.log("   - Botón cobrar deshabilitado:", chargeBtnDisabled);

if (Number(badgeCount) !== 3) {
  throw new Error(`Contador de ítems esperado: 3, obtenido: ${badgeCount}`);
}
if (ticketBtnDisabled || chargeBtnDisabled) {
  throw new Error("Los botones de la comanda móvil no deben estar deshabilitados si hay ítems");
}
console.log("   ✅ Barra flotante y badge móvil actualizados correctamente con ítems y montos");

console.log("\n=== TODAS LAS PRUEBAS DE TARJETAS Y VISTA MÓVIL PASARON CON ÉXITO ===");
