/* NexoPos · Impresión de tickets térmicos (rollos de 58 y 80 mm)
   - buildReceiptHtml / buildShiftZHtml: documento HTML completo del comprobante (sin scripts).
   - printReceipt(html): un solo motor de impresión.
       · Escritorio (Electron): window.desktop.printReceipt → ventana oculta en main.js + webContents.print().
       · Web (PWA): <iframe> invisible + contentWindow.print(); se elimina al terminar.
   Autónomo (no depende de app.js) para poder probarlo en Node. Se carga antes de app.js: solo declaraciones. */

// Ancho imprimible real de cada rollo (el cabezal no imprime los bordes)
const RECEIPT_WIDTHS = { 58: '48mm', 80: '72mm' };
const RECEIPT_DEMO_MARK = 'DOCUMENTO DE DEMOSTRACIÓN — NETXPREMIUM';
const receiptMoney = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const receiptQty = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

function receiptEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function receiptDateTime(ts) {
  return new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// Solo se acepta un logo en data URL de imagen (lo que guarda «Mi negocio»): nada de URLs externas en el ticket
function receiptLogo(image) {
  return typeof image === 'string' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(image)
    ? `<img class="logo" src="${image}" alt="" />` : '';
}
function receiptLocation(customer) {
  const name = String(customer || '').trim();
  return !name || /barra|mostrador/i.test(name) ? 'Barra' : name;
}

function receiptDocument(title, body, { paperWidth = 80 } = {}) {
  const width = RECEIPT_WIDTHS[paperWidth] || RECEIPT_WIDTHS[80], narrow = Number(paperWidth) === 58;
  return `<!DOCTYPE html>
<html lang="es-CO">
<head>
<meta charset="utf-8" />
<title>${receiptEscape(title)}</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { width: ${width}; padding: 3mm 0 8mm; margin: 0 auto; font-family: "Segoe UI", Arial, Helvetica, sans-serif; font-size: ${narrow ? 11 : 12}px; line-height: 1.35; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .center { text-align: center; }
  .logo { display: block; max-width: 70%; max-height: ${narrow ? 18 : 24}mm; margin: 0 auto 4px; object-fit: contain; filter: grayscale(1) contrast(1.4); }
  h1 { margin: 0 0 2px; font-size: ${narrow ? 14 : 16}px; font-weight: 800; text-transform: uppercase; letter-spacing: .02em; }
  .biz div { margin: 1px 0; }
  .title { margin-top: 5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; margin: 2px 0; }
  .row span:last-child { text-align: right; }
  .num { font-family: Consolas, "Courier New", monospace; white-space: nowrap; }
  .item { margin: 4px 0; }
  .item-name { font-weight: 700; overflow-wrap: anywhere; }
  .item .row { margin: 0; }
  .bold { font-weight: 800; }
  .total { font-size: ${narrow ? 15 : 17}px; font-weight: 900; }
  .legend { margin-top: 8px; font-size: 10px; text-align: center; text-transform: uppercase; letter-spacing: .05em; }
  .mark { margin: 6px 0; padding: 4px; border: 1.5px dashed #000; text-align: center; font-size: 10px; font-weight: 800; }
  .footer { margin-top: 10px; text-align: center; font-weight: 700; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function receiptHeader(profile, title) {
  const p = profile || {};
  return `<div class="center biz">
  ${receiptLogo(p.image)}
  <h1>${receiptEscape(p.name || 'NexoPos')}</h1>
  ${p.nit ? `<div>NIT: ${receiptEscape(p.nit)}</div>` : ''}
  ${p.address ? `<div>${receiptEscape(p.address)}</div>` : ''}
  ${p.phone ? `<div>Tel: ${receiptEscape(p.phone)}</div>` : ''}
  <div class="title">${receiptEscape(title)}</div>
</div>`;
}

// Comprobante de una venta (cobro o reimpresión desde Facturas)
function buildReceiptHtml(payment, { profile = {}, paperWidth = 80, demo = false, reprint = false, now = Date.now() } = {}) {
  const pay = payment || {}, items = Array.isArray(pay.items) ? pay.items : [];
  const tenders = Array.isArray(pay.payments) && pay.payments.length ? pay.payments : [{ method: pay.method || 'Efectivo', amount: pay.amount }];
  const paidAt = pay.paidAt || pay.createdAt || now;
  const mark = demo ? `<div class="mark">${RECEIPT_DEMO_MARK}</div>` : '';
  const itemsHtml = items.map(item => {
    const qty = Number(item.qty) || 0, price = Number(item.price) || 0;
    return `<div class="item"><div class="item-name">${receiptEscape(item.name)}</div><div class="row"><span class="num">${receiptQty.format(qty)} x ${receiptMoney.format(price)}</span><span class="num">${receiptMoney.format(Math.round(qty * price))}</span></div></div>`;
  }).join('');
  const tendersHtml = tenders.map(t => {
    const amount = Number(t.amount) || 0, received = Number(t.received) || 0;
    const cash = received > amount ? `<div class="row"><span>&nbsp;&nbsp;Recibido</span><span class="num">${receiptMoney.format(received)}</span></div><div class="row"><span>&nbsp;&nbsp;Cambio</span><span class="num">${receiptMoney.format(Number(t.change) || received - amount)}</span></div>` : '';
    return `<div class="row"><span>${receiptEscape(t.method || 'Pago')}</span><span class="num">${receiptMoney.format(amount)}</span></div>${cash}`;
  }).join('');
  const body = `${mark}
${receiptHeader(profile, 'Comprobante de venta')}
${reprint ? `<div class="center bold" style="margin-top:4px">*** REIMPRESIÓN · ${receiptEscape(receiptDateTime(now))} ***</div>` : ''}
<hr>
<div class="row"><span>Factura:</span><span class="bold">${receiptEscape(pay.invoiceNo || 'FAC')}</span></div>
<div class="row"><span>Fecha:</span><span>${receiptEscape(receiptDateTime(paidAt))}</span></div>
<div class="row"><span>Mesa / cuenta:</span><span>${receiptEscape(receiptLocation(pay.customer))}</span></div>
${pay.waiterName ? `<div class="row"><span>Atendió:</span><span>${receiptEscape(pay.waiterName)}</span></div>` : ''}
<div class="row"><span>Cajero:</span><span>${receiptEscape(pay.cashierName || 'Caja')}</span></div>
<hr>
${itemsHtml || '<div class="center">Sin productos</div>'}
<hr>
<div class="row total"><span>TOTAL</span><span class="num">${receiptMoney.format(Number(pay.amount) || 0)}</span></div>
<hr>
<div class="bold">Método de pago</div>
${tendersHtml}
${pay.editedAt ? `<div class="legend">Factura corregida el ${receiptEscape(receiptDateTime(pay.editedAt))}</div>` : ''}
<hr>
<div class="legend">Comprobante de venta interno</div>
${mark}
<div class="footer">¡Gracias por su visita!</div>`;
  return receiptDocument(`Ticket ${pay.invoiceNo || ''}`.trim(), body, { paperWidth });
}

// Comprobante de cierre de turno (Ticket Z)
function buildShiftZHtml(shift, { profile = {}, paperWidth = 80, demo = false, accounts = 0, totalSales = 0 } = {}) {
  const s = shift || {}, mark = demo ? `<div class="mark">${RECEIPT_DEMO_MARK}</div>` : '';
  const row = (label, value, bold = false) => `<div class="row${bold ? ' bold' : ''}"><span>${label}</span><span class="num">${value}</span></div>`;
  const diff = Number(s.difference) || 0;
  const body = `${mark}
${receiptHeader(profile, 'Comprobante de cierre (Ticket Z)')}
<hr>
<div class="row"><span>Fecha:</span><span>${receiptEscape(receiptDateTime(s.closedAt || Date.now()))}</span></div>
<div class="row"><span>Cajero:</span><span>${receiptEscape(s.closedBy || 'Cajero')}</span></div>
<div class="row"><span>Cuentas:</span><span>${Number(accounts) || 0}</span></div>
<hr>
${row('TOTAL VENTAS:', receiptMoney.format(Number(totalSales) || 0), true)}
${row('Ventas efectivo:', receiptMoney.format(Number(s.cashSales) || 0))}
${row('Otros medios:', receiptMoney.format(Number(s.otherSales) || 0))}
${row('Compras/Gastos:', `- ${receiptMoney.format(Number(s.cashExpenses) || 0)}`)}
<hr>
${row('Base inicial:', receiptMoney.format(Number(s.openingCash) || 0))}
${row('Efectivo esperado:', receiptMoney.format(Number(s.expected) || 0))}
${row('Efectivo contado:', receiptMoney.format(Number(s.counted) || 0), true)}
${row('Diferencia:', `${diff >= 0 ? '+' : ''}${receiptMoney.format(diff)}`, true)}
<hr>
${mark}
<div class="footer">*** NexoPos ***</div>`;
  return receiptDocument('Ticket Z - Cierre de turno', body, { paperWidth });
}

/* ---------- Motor de impresión ---------- */
// Web: iframe invisible; espera el logo antes de imprimir y se elimina después
function printViaIframe(html) {
  return new Promise(resolve => {
    let frame;
    try {
      frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
      Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
      document.body.appendChild(frame);
      const doc = frame.contentDocument || frame.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
      const images = Array.from(doc.images || []);
      Promise.all(images.map(img => (img.complete ? null : new Promise(done => { img.onload = img.onerror = done; })))).then(() => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); resolve({ ok: true }); }
        catch (error) { resolve({ ok: false, error: String(error?.message || error) }); }
        finally { setTimeout(() => frame.remove(), 1000); } // print() bloquea hasta cerrar el diálogo en la mayoría de navegadores
      });
    } catch (error) {
      if (frame) frame.remove();
      resolve({ ok: false, error: String(error?.message || error) });
    }
  });
}
// Punto único de impresión. Devuelve { ok, cancelled?, error? }; nunca lanza (no debe interrumpir una venta).
async function printReceipt(html, { silent = false, printerName = null } = {}) {
  if (typeof html !== 'string' || !html) return { ok: false, error: 'No hay contenido para imprimir.' };
  const bridge = globalThis.desktop;
  if (bridge && typeof bridge.printReceipt === 'function') {
    try { return (await bridge.printReceipt(html, Boolean(silent), printerName || null)) || { ok: false, error: 'Sin respuesta de la impresora.' }; }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return { ok: false, error: 'Impresión no disponible en este entorno.' };
  return printViaIframe(html);
}

globalThis.buildReceiptHtml = buildReceiptHtml;
globalThis.buildShiftZHtml = buildShiftZHtml;
globalThis.printReceipt = printReceipt;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildReceiptHtml, buildShiftZHtml, printReceipt, printViaIframe, receiptLocation, RECEIPT_WIDTHS, RECEIPT_DEMO_MARK };
}
