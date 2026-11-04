// scratch/test-miles-montos.js
// Campos de dinero con punto de miles (modules.js): formatMoneyInput, moneyInputValue/moneyDigits y el
// reformateo en vivo (formatMoneyField) que deja el cursor detrás de la misma cifra.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = { console, __IS_NODE_TEST__: true };
ctx.globalThis = ctx;
vm.createContext(ctx);
const src = fs.readFileSync(path.join(__dirname, '..', 'modules.js'), 'utf8');
const ini = src.indexOf('// Campos de dinero:'), fin = src.indexOf('function fmtDateTime(ts)');
assert.ok(ini > 0 && fin > ini, 'Bloque de campos de dinero en modules.js');
vm.runInContext(src.slice(ini, fin), ctx);
const { formatMoneyInput, moneyInputValue, moneyDigits, formatMoneyField } = ctx;

assert.strictEqual(formatMoneyInput(70000), '70.000');
assert.strictEqual(formatMoneyInput(7000), '7.000');
assert.strictEqual(formatMoneyInput(1250000), '1.250.000');
assert.strictEqual(formatMoneyInput(999), '999');
assert.strictEqual(formatMoneyInput(0), '0');
assert.strictEqual(formatMoneyInput(''), '');
assert.strictEqual(formatMoneyInput(undefined), '');
assert.strictEqual(formatMoneyInput(3333.6), '3.334', 'Pesos sin decimales');
assert.strictEqual(moneyInputValue('70.000'), 70000);
assert.strictEqual(moneyInputValue('$ 1.250.000'), 1250000);
assert.strictEqual(moneyInputValue(''), 0);
assert.strictEqual(moneyInputValue('5000'), 5000, 'Un valor sin puntos se sigue leyendo igual');
assert.strictEqual(moneyDigits(''), '', 'Vacío se distingue de 0');
console.log('   ✅ formato y lectura');

function campo(value, caret = value.length) { return { value, selectionStart: caret, setSelectionRange(a) { this.caret = a; } }; }
let c = campo('70000'); formatMoneyField(c); assert.strictEqual(c.value, '70.000'); assert.strictEqual(c.caret, 6);
c = campo('7.0000'); formatMoneyField(c); assert.strictEqual(c.value, '70.000', 'Al seguir tecleando se reubica el punto');
c = campo('15000', 2); formatMoneyField(c); assert.strictEqual(c.value, '15.000'); assert.strictEqual(c.caret, 2, 'Cursor detrás del 5');
c = campo('1.000'); c.value = '1.00'; formatMoneyField(c); assert.strictEqual(c.value, '100', 'Al borrar se quita el punto');
c = campo('abc'); formatMoneyField(c); assert.strictEqual(c.value, '', 'Solo cifras');
c = campo('007'); formatMoneyField(c); assert.strictEqual(c.value, '7');
console.log('   ✅ reformateo mientras se escribe');
console.log('\n=== CAMPOS DE DINERO CON PUNTO DE MILES: OK ===');
