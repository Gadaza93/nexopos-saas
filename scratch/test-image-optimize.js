// scratch/test-image-optimize.js
// Carga de imágenes de producto/logo con el código REAL de app.js: límite de 5 MB, redimensión a máx. 600×600 en canvas,
// WebP/JPEG al 85 % bajando calidad hasta quedar bajo ~100 KB de base64, y validación con safeImageSrc.
// Image, FileReader y canvas se simulan: el «peso» del canvas es proporcional a ancho × alto × calidad.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== PRUEBAS: OPTIMIZACIÓN DE IMÁGENES (código real) ===\n');

const ROOT = path.join(__dirname, '..');
const els = {};
let webpSupported = true, canvasLog = [];
function mockElement() {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, style: {}, dataset: {}, checked: false, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, closest: () => null,
    querySelector: () => mockElement(), querySelectorAll: () => [], append() {}, appendChild() {}, matches: () => false
  };
}
function mockCanvas() {
  const canvas = { width: 0, height: 0 };
  canvas.getContext = () => ({ clearRect() {}, drawImage() {}, save() {}, restore() {}, fillRect() {}, globalCompositeOperation: '', fillStyle: '' });
  canvas.toDataURL = (type, quality) => {
    const fmt = type === 'image/webp' && !webpSupported ? 'image/png' : type;
    const chars = Math.round(canvas.width * canvas.height * quality * 0.5); // ~0,5 caracteres por píxel a calidad 1
    canvasLog.push({ fmt, w: canvas.width, h: canvas.height, quality });
    return `data:${fmt};base64,${'A'.repeat(Math.max(4, chars - (chars % 4)))}`;
  };
  return canvas;
}
const document = {
  querySelector: sel => (els[sel] = els[sel] || mockElement()), querySelectorAll: () => [], addEventListener() {},
  createElement: tag => (tag === 'canvas' ? mockCanvas() : mockElement()), body: mockElement(), documentElement: mockElement(), visibilityState: 'visible'
};
// Una «foto» simulada: { type, size, w, h }
class MockImage { set src(url) { const f = blobs.get(url); this.naturalWidth = f.w; this.naturalHeight = f.h; setImmediate(() => (f.broken ? this.onerror() : this.onload())); } }
class MockFileReader { readAsDataURL(f) { this.result = `data:${f.type};base64,${'B'.repeat(Math.ceil(f.size * 4 / 3 / 4) * 4)}`; setImmediate(() => this.onload()); } }
const blobs = new Map(); let blobN = 0;
const URLMock = { createObjectURL: f => { const u = `blob:${++blobN}`; blobs.set(u, f); return u; }, revokeObjectURL: u => blobs.delete(u) };
const memoryStorage = () => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; };
const ctx = {
  console, document, window: { location: { search: '' }, addEventListener() {}, confirm: () => true }, navigator: { onLine: false },
  localStorage: memoryStorage(), sessionStorage: memoryStorage(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  structuredClone, Intl, crypto: globalThis.crypto, URLSearchParams, __IS_NODE_TEST__: true,
  Image: MockImage, FileReader: MockFileReader, URL: URLMock
};
ctx.globalThis = ctx; ctx.window.document = document;
vm.createContext(ctx);
for (const file of ['demo-mode.js', 'storage.js', 'modules.js', 'print.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}
const run = code => vm.runInContext(code, ctx);
run('var toasts = []; showToast = m => toasts.push(String(m)); renderAll = () => {};');

// readLocalImage es asíncrono: devuelve lo que recibe onLoad (o null si se rechaza)
function load(file) {
  return new Promise(resolve => {
    const before = run('toasts.length');
    ctx.__done = resolve;
    run('readLocalImage(__file, img => __done(img))'.replace('__file', JSON.stringify(file)));
    const check = () => (run('toasts.length') > before ? resolve(null) : setTimeout(check, 5));
    setTimeout(check, 5);
  });
}
const LIMIT = 100 * 1024;

(async () => {
  // A. Más de 5 MB se rechaza; 4,8 MB se acepta
  canvasLog = [];
  assert.strictEqual(await load({ type: 'image/jpeg', size: 5.2 * 1024 * 1024, w: 4000, h: 3000 }), null);
  assert.ok(run('toasts[toasts.length - 1]').includes('5 MB'));
  const phone = await load({ type: 'image/jpeg', size: 4.8 * 1024 * 1024, w: 4032, h: 3024 });
  assert.ok(phone && phone.startsWith('data:image/webp;base64,'), 'Foto de celular de 4,8 MB → WebP');
  assert.ok(phone.length <= LIMIT, `base64 guardado ≤ 100 KB (fue ${phone.length})`);
  assert.deepStrictEqual([canvasLog[0].w, canvasLog[0].h, canvasLog[0].quality], [600, 450, 0.85], 'Lado mayor 600 px, proporción intacta, 85 %');
  assert.ok(run(`safeImageSrc(${JSON.stringify(phone)}) !== ''`), 'El resultado pasa safeImageSrc');
  console.log(`   ✅ Foto de 4,8 MB (4032×3024) → WebP 600×450 al 85 %, ${(phone.length / 1024).toFixed(0)} KB en base64. Más de 5 MB se rechaza.`);

  // B. Imagen grande que no cabe al 85 %: baja calidad y luego tamaño hasta quedar bajo el límite
  canvasLog = [];
  const square = await load({ type: 'image/png', size: 3 * 1024 * 1024, w: 3000, h: 3000 });
  assert.ok(square.length <= LIMIT, `cuadrada ≤ 100 KB (fue ${square.length})`);
  assert.ok(canvasLog.length > 1 && canvasLog.every(c => Math.max(c.w, c.h) <= 600));
  console.log(`   ✅ 3000×3000 se reduce por pasos (${canvasLog.map(c => `${c.w}px@${c.quality}`).join(' → ')}) hasta ${(square.length / 1024).toFixed(0)} KB.`);

  // C. Navegador sin codificador WebP: cae a JPEG
  webpSupported = false; canvasLog = [];
  const jpeg = await load({ type: 'image/jpeg', size: 2 * 1024 * 1024, w: 1200, h: 900 });
  assert.ok(jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length <= LIMIT);
  webpSupported = true;
  console.log('   ✅ Sin soporte WebP se guarda JPEG (fondo blanco para transparencias).');

  // D. Imagen ya pequeña (≤600 px y liviana): se guarda tal cual, sin pasar por canvas
  canvasLog = [];
  const small = await load({ type: 'image/png', size: 40 * 1024, w: 300, h: 300 });
  assert.ok(small.startsWith('data:image/png;base64,') && canvasLog.length === 0);
  console.log('   ✅ Un PNG de 300×300 y 40 KB se conserva sin recomprimir (mantiene transparencia).');

  // E. Archivos que no son imagen o imágenes corruptas
  assert.strictEqual(await load({ type: 'text/html', size: 100, w: 1, h: 1 }), null);
  assert.strictEqual(await load({ type: 'image/jpeg', size: 1000, w: 0, h: 0, broken: true }), null);
  assert.ok(run('toasts[toasts.length - 1]').includes('No se pudo'));
  console.log('   ✅ Archivos no imagen y fotos dañadas se rechazan con un aviso.');

  // F. safeImageSrc sigue bloqueando lo peligroso
  for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'https://evil.example/x.png', 'data:image/png;base64,AA" onerror="x']) {
    assert.strictEqual(run(`safeImageSrc(${JSON.stringify(bad)})`), '', bad);
  }
  console.log('   ✅ safeImageSrc sigue rechazando javascript:, data:text/html, URLs externas e inyección de atributos.');

  console.log('\n✅ Todas las pruebas de optimización de imágenes pasaron.');
})().catch(err => { console.error(err); process.exit(1); });
