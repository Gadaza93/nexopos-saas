// scratch/test-print-receipt.js
// Prueba del sistema unificado de impresión térmica:
// 1. HTML del comprobante de venta y del Ticket Z (print.js).
// 2. Motor printReceipt: escritorio (window.desktop.printReceipt) y web (iframe invisible).
// 3. Integración en app.js (ajustes de impresión, reimpresión, Ticket Z) y botón «Imprimir» en Facturas (modules.js).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: IMPRESIÓN DE TICKETS TÉRMICOS ===\n');

const print = require('../print.js');
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const profile = { name: 'Gastrobar La Estación', nit: '900.123.456-7', address: 'Cra 10 # 20-30', phone: '300 123 4567', image: LOGO };
const payment = {
  id: 'pay_1', invoiceNo: 'FAC-00042', paidAt: Date.parse('2026-10-27T21:15:00-05:00'), customer: 'Mesa 3',
  cashierName: 'Laura', waiterName: 'Andrés', amount: 57000, method: 'Efectivo',
  payments: [{ method: 'Efectivo', amount: 57000, received: 60000, change: 3000 }],
  items: [{ name: 'Cerveza Club Colombia', qty: 3, price: 6000 }, { name: 'Aguardiente Antioqueño 375ml', qty: 1, price: 39000 }]
};

(async () => {
  // --- 1. Comprobante de venta ---
  const html = print.buildReceiptHtml(payment, { profile, paperWidth: 80 });
  for (const text of ['Gastrobar La Estación', 'NIT: 900.123.456-7', 'Cra 10 # 20-30', 'Tel: 300 123 4567', 'FAC-00042', 'Mesa 3', 'Laura', 'Andrés',
    'Cerveza Club Colombia', 'Aguardiente Antioqueño 375ml', 'Comprobante de venta interno', 'Efectivo', 'Recibido', 'Cambio']) {
    assert.ok(html.includes(text), `El ticket debe incluir «${text}»`);
  }
  assert.ok(html.includes(`src="${LOGO}"`), 'El ticket debe incluir el logo de Mi negocio');
  assert.match(html, /3 x \$\s?6\.000/); assert.match(html, /\$\s?18\.000/); // cantidad × precio y subtotal
  assert.match(html, /TOTAL<\/span><span class="num">\$\s?57\.000/);
  assert.match(html, /27\/10\/2026/);
  assert.match(html, /@page \{ margin: 0; \}/);
  assert.match(html, /width: 72mm/);
  assert.doesNotMatch(html, /<script/i);
  console.log('   ✅ Comprobante: logo, negocio, factura, fecha, mesa, cajero, productos, total, pago y leyenda.');

  assert.match(print.buildReceiptHtml(payment, { profile, paperWidth: 58 }), /width: 48mm/);
  assert.strictEqual(print.receiptLocation('Venta en mostrador'), 'Mostrador');
  assert.strictEqual(print.receiptLocation(''), 'Mostrador');
  assert.strictEqual(print.receiptLocation('Venta en barra'), 'Mostrador', 'la etiqueta antigua de venta rápida');
  assert.strictEqual(print.receiptLocation('Barra 2'), 'Barra', 'las barras del plano siguen como Barra');
  assert.strictEqual(print.receiptLocation('Mesa 3 · Fracción 1/2'), 'Mesa 3 · Fracción 1/2');
  console.log('   ✅ Rollos de 58 mm (48 mm útiles) y 80 mm (72 mm útiles); ventas de mostrador se rotulan «Mostrador».');

  const hostile = print.buildReceiptHtml({ ...payment, customer: '<img src=x onerror=alert(1)>', items: [{ name: '<script>x</script>', qty: 1, price: 1 }] }, { profile: { ...profile, image: 'https://evil.example/logo.png' } });
  assert.doesNotMatch(hostile, /<img src=x|<script>x/);
  assert.doesNotMatch(hostile, /evil\.example/);
  assert.ok(!print.buildReceiptHtml(payment, { profile: { ...profile, image: null } }).includes('class="logo"'));
  console.log('   ✅ Texto escapado y solo se acepta el logo como data URL de imagen (sin URLs externas).');

  const demo = print.buildReceiptHtml(payment, { profile, demo: true });
  assert.strictEqual(demo.split(print.RECEIPT_DEMO_MARK).length - 1, 2);
  const reprint = print.buildReceiptHtml(payment, { profile, reprint: true, now: Date.parse('2026-10-28T10:00:00-05:00') });
  assert.match(reprint, /REIMPRESIÓN · 28\/10\/2026/);
  assert.ok(!html.includes('REIMPRESIÓN'));
  console.log('   ✅ Marca de demostración arriba y abajo; las reimpresiones se rotulan con su fecha.');

  // --- 2. Ticket Z ---
  const z = print.buildShiftZHtml({ closedAt: Date.now(), closedBy: 'Laura', cashSales: 50000, otherSales: 35000, cashExpenses: 10000, openingCash: 100000, expected: 140000, counted: 139000, difference: -1000 }, { profile, accounts: 7, totalSales: 85000 });
  for (const text of ['Ticket Z', 'Laura', 'TOTAL VENTAS:', 'Efectivo contado:', 'Diferencia:']) assert.ok(z.includes(text), `El Ticket Z debe incluir «${text}»`);
  assert.match(z, /\$\s?85\.000/); assert.match(z, /-\$\s?1\.000|\$\s?-1\.000|-\s?\$\s?1\.000/);
  assert.ok(z.includes(`src="${LOGO}"`));
  console.log('   ✅ Ticket Z con el mismo formato térmico y el logo del negocio.');

  // --- 3. Motor printReceipt ---
  let desktopCall = null;
  globalThis.desktop = { printReceipt: async (h, silent, printerName) => { desktopCall = { h, silent, printerName }; return { ok: true }; } };
  assert.deepStrictEqual(await print.printReceipt(html, { silent: true, printerName: 'POS-80' }), { ok: true });
  assert.deepStrictEqual(desktopCall, { h: html, silent: true, printerName: 'POS-80' });
  globalThis.desktop = { printReceipt: async () => { throw new Error('IPC caído'); } };
  assert.deepStrictEqual(await print.printReceipt(html), { ok: false, error: 'IPC caído' });
  delete globalThis.desktop;
  assert.strictEqual((await print.printReceipt('')).ok, false);
  console.log('   ✅ Escritorio: desktop.printReceipt(html, silent, printerName); los errores no lanzan excepciones.');

  // Web: iframe invisible que imprime y se elimina
  const events = [];
  const frame = {
    style: {}, setAttribute() {}, tabIndex: 0,
    contentDocument: { open: () => events.push('open'), write: h => events.push(`write:${h.length}`), close: () => events.push('close'), images: [] },
    contentWindow: { focus() {}, print: () => events.push('print') },
    remove: () => events.push('remove')
  };
  globalThis.document = { createElement: tag => { events.push(`create:${tag}`); return frame; }, body: { appendChild: () => events.push('append') } };
  assert.deepStrictEqual(await print.printReceipt(html), { ok: true });
  await new Promise(r => setTimeout(r, 1100));
  assert.deepStrictEqual(events, ['create:iframe', 'append', 'open', `write:${html.length}`, 'close', 'print', 'remove']);
  assert.strictEqual(frame.style.width, '0');
  delete globalThis.document;
  console.log('   ✅ Web: crea un iframe invisible, escribe el ticket, imprime y lo elimina.');

  // --- 4. Integración en app.js (ajustes y envío a la impresora) ---
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const block = appSrc.slice(appSrc.indexOf('const PRINT_DEFAULTS'), appSrc.indexOf('globalThis.printPaymentReceipt'));
  const zBlock = appSrc.slice(appSrc.indexOf('function printShiftZ('), appSrc.indexOf('globalThis.printShiftZ'));
  const sent = [], toasts = [];
  const ctx = {
    state: { profile, payments: [payment], closedShifts: [], printSettings: { paperWidth: 58, silent: true, printerName: 'POS-58' } },
    defaultState: { profile: {} }, lastClosedShift: null, globalThis: {},
    isDemoMode: () => false, showToast: msg => toasts.push(msg), saveState() {}, actor: () => ({ userName: 'Laura' }), escapeHtml: s => s,
    document: { querySelector: () => null }, Promise, Boolean, Number,
    buildReceiptHtml: print.buildReceiptHtml, buildShiftZHtml: print.buildShiftZHtml,
    printReceipt: async (h, opts) => { sent.push({ h, opts }); return { ok: true }; }
  };
  vm.createContext(ctx); vm.runInContext(block + zBlock, ctx);

  await ctx.printPaymentReceipt('pay_1', { reprint: true });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].h, /FAC-00042/); assert.match(sent[0].h, /REIMPRESIÓN/); assert.match(sent[0].h, /width: 48mm/);
  assert.deepStrictEqual({ ...sent[0].opts }, { silent: false, printerName: 'POS-58' }); // en web nunca es silenciosa
  ctx.globalThis.desktop = { printReceipt() {} };
  await ctx.printPaymentReceipt('pay_1');
  assert.deepStrictEqual({ ...sent[1].opts }, { silent: true, printerName: 'POS-58' });
  assert.ok(toasts.some(t => t.includes('enviado a la impresora')));
  console.log('   ✅ Reimpresión usa el ancho, la impresora y la impresión directa guardados (directa solo en escritorio).');

  sent.length = 0;
  await ctx.printShiftZ({ id: 's1', closedAt: Date.now(), closedBy: 'Laura', totalSales: 85000, difference: 0 });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].h, /Ticket Z/);
  assert.doesNotMatch(zBlock, /window\.open|window\.print/);
  console.log('   ✅ Ticket Z va por printReceipt (ya no por window.open, bloqueado en Electron).');

  ctx.printReceipt = async () => ({ ok: false, error: 'Impresora sin papel' });
  toasts.length = 0; await ctx.printPaymentReceipt('pay_1');
  assert.ok(toasts.some(t => t.includes('Impresora sin papel')));
  ctx.printReceipt = async () => ({ ok: false, cancelled: true }); toasts.length = 0; await ctx.printPaymentReceipt('pay_1');
  assert.strictEqual(toasts.length, 0);
  toasts.length = 0; await ctx.printPaymentReceipt('no_existe');
  assert.ok(toasts.includes('No se encontró la factura.'));
  console.log('   ✅ Errores de impresora se avisan; cancelar el diálogo no muestra error.');

  // --- 5. Botón «Imprimir» en Facturas (modules.js) ---
  const modSrc = fs.readFileSync(path.join(__dirname, '..', 'modules.js'), 'utf8');
  const cardFn = modSrc.slice(modSrc.indexOf('function invoiceCardMarkup('), modSrc.indexOf('function renderRecentInvoices('));
  const mctx = { escapeHtml: s => String(s), fmtDateTime: () => '', paymentTimestamp: p => p.paidAt, money: { format: n => `$${n}` }, invoiceItemsMarkup: () => '', canEdit: false };
  mctx.can = perm => perm === 'invoiceEdit' ? mctx.canEdit : true;
  vm.createContext(mctx); vm.runInContext(cardFn, mctx);
  let card = mctx.invoiceCardMarkup(payment, { actions: true });
  assert.match(card, /data-print-invoice="pay_1"/);
  assert.doesNotMatch(card, /data-edit-invoice/);
  mctx.canEdit = true; card = mctx.invoiceCardMarkup(payment, { actions: true });
  assert.match(card, /data-print-invoice="pay_1"[\s\S]*data-edit-invoice="pay_1"/);
  assert.doesNotMatch(mctx.invoiceCardMarkup(payment), /data-print-invoice/);
  assert.match(modSrc, /if \(d\.printInvoice\) return printPaymentReceipt\(d\.printInvoice, \{ reprint: true \}\);/);
  console.log('   ✅ Facturas: «Imprimir» para quien ve facturas; Editar/Eliminar siguen requiriendo permiso.');

  // --- 6. Cableado de Electron (estático) ---
  for (const file of ['main.js', 'electron/main.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(src, /ipcMain\.handle\('print:receipt'/, `${file}: falta el canal print:receipt`);
    assert.match(src, /webContents\.print\(\{ silent, printBackground: true, margins: \{ marginType: 'none' \}/, `${file}: print() sin márgenes`);
    assert.match(src, /javascript: false/, `${file}: la ventana del ticket no debe ejecutar scripts`);
    assert.match(src, /printWin\.destroy\(\)/, `${file}: debe destruir la ventana temporal`);
  }
  // Única excepción al bloqueo de ventanas: enlaces https://wa.me (botón de WhatsApp del cierre de turno)
  for (const file of ['main.js', 'electron/main.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const fn = src.slice(src.indexOf('function isWhatsAppUrl('), src.indexOf('function createWindow('));
    const wctx = { URL }; vm.createContext(wctx); vm.runInContext(fn, wctx);
    assert.strictEqual(wctx.isWhatsAppUrl('https://wa.me/573001234567?text=Cierre'), true, `${file}: wa.me debe abrirse`);
    for (const bad of ['https://evil.example/x', 'https://wa.me.evil.com/x', 'https://wa.me@evil.com/', 'http://wa.me/57300', 'javascript:alert(1)', 'no es url']) {
      assert.strictEqual(wctx.isWhatsAppUrl(bad), false, `${file}: «${bad}» debe seguir bloqueada`);
    }
    assert.match(src, /setWindowOpenHandler\(\(\{ url \}\) => \{ if \(isWhatsAppUrl\(url\)\) openWhatsApp\(url\); return \{ action: 'deny' \}; \}\)/, `${file}: la ventana principal debe seguir denegando`);
    assert.match(src, /function openWhatsApp\(url\) \{ shell\.openExternal\(new URL\(url\)\.href\); \}/, `${file}: WhatsApp se abre con la URL normalizada`);
  }
  for (const file of ['preload.js', 'electron/preload.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /printReceipt: \(html, silent = false, printerName = null\) => ipcRenderer\.invoke\('print:receipt'/, `${file}: falta printReceipt`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('print.js'), 'print.js debe entrar al instalador');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8'), /'\.\/print\.js'/);
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(indexHtml.indexOf('src="./print.js"') < indexHtml.indexOf('src="./app.js"'), 'print.js debe cargarse antes de app.js');
  console.log('   ✅ IPC print:receipt en ambos main.js/preload.js; print.js en instalador, service worker e index.html.');
  console.log('   ✅ Solo https://wa.me se abre fuera de la app; el resto de ventanas sigue bloqueado.');

  console.log('\n=== TODAS LAS PRUEBAS DE IMPRESIÓN PASARON ===');
  process.exit(0);
})().catch(err => { console.error('❌', err); process.exit(1); });
