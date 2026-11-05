// scratch/test-ids-unicos.js
// Ningún id se repite en index.html ni en admin.html: con dos elementos del mismo id, querySelector('#id') devuelve
// el primero y la otra pantalla deja de funcionar (pasó con #productSearch: el buscador de Productos tapó al del pedido).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
for (const file of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const repetidos = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepStrictEqual(repetidos, [], `${file}: ids repetidos ${repetidos.join(', ')}`);
  console.log(`   ✅ ${file}: ${ids.length} ids, ninguno repetido`);
}
console.log('\n=== IDS ÚNICOS: OK ===');
