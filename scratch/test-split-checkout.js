const fs = require('fs');

// Mock localStorage and browser objects
globalThis.localStorage = {
  data: {},
  getItem(k) { return this.data[k] || null; },
  setItem(k, v) { this.data[k] = String(v); },
  removeItem(k) { delete this.data[k]; }
};

// Test 1: Validate split tender math and data shape
console.log('--- TEST 1: Split Tender Payments Record ---');
const payment = {
  id: 'pay-1',
  amount: 80000,
  method: 'Efectivo + Nequi',
  payments: [
    { method: 'Efectivo', amount: 50000, received: 60000, change: 10000 },
    { method: 'Nequi', amount: 30000, received: 30000, change: 0 }
  ],
  shiftId: 'shift-1'
};

const payments = [payment];
function cashSalesToday() {
  return payments.reduce((sum, p) => {
    if (Array.isArray(p.payments) && p.payments.length > 0) {
      return sum + p.payments.filter(t => t.method === 'Efectivo').reduce((s, t) => s + t.amount, 0);
    }
    return sum + (p.method === 'Efectivo' ? p.amount : 0);
  }, 0);
}
function otherSalesToday() {
  return payments.reduce((sum, p) => {
    if (Array.isArray(p.payments) && p.payments.length > 0) {
      return sum + p.payments.filter(t => t.method !== 'Efectivo').reduce((s, t) => s + t.amount, 0);
    }
    return sum + (p.method !== 'Efectivo' ? p.amount : 0);
  }, 0);
}

const cash = cashSalesToday();
const other = otherSalesToday();
console.log('Cash sales:', cash, '(expected: 50000)');
console.log('Other sales:', other, '(expected: 30000)');
if (cash !== 50000 || other !== 30000) throw new Error('Cash/Other sales split failed');

// Test 2: Inventory deduction 1:1 on item split
console.log('\n--- TEST 2: Item Split & 1:1 Inventory Deduction ---');
const inventory = [
  { id: 'inv-cerveza', name: 'Cerveza', qty: 10, min: 2, unit: 'und' },
  { id: 'inv-ron', name: 'Ron', qty: 5, min: 1, unit: 'botella' }
];

function deductInventory(items) {
  items.forEach(item => {
    const supply = inventory.find(i => i.id === item.inventoryId);
    if (supply) {
      supply.qty = Math.max(0, Number((supply.qty - item.qty).toFixed(2)));
    }
  });
}

const order = {
  id: 'ord-1',
  tableId: 't-1',
  tableName: 'Mesa 1',
  status: 'open',
  items: [
    { productId: 'p-cerveza', name: 'Cerveza', price: 10000, qty: 3, inventoryId: 'inv-cerveza' },
    { productId: 'p-ron', name: 'Ron', price: 50000, qty: 1, inventoryId: 'inv-ron' }
  ]
};

// Charge 2 cervezas first
const chargeSelection1 = [{ productId: 'p-cerveza', name: 'Cerveza', price: 10000, qty: 2, inventoryId: 'inv-cerveza' }];
deductInventory(chargeSelection1);
chargeSelection1.forEach(selItem => {
  const oi = order.items.find(i => i.productId === selItem.productId);
  if (oi) oi.qty -= selItem.qty;
});
order.items = order.items.filter(i => i.qty > 0);
if (order.items.length === 0) order.status = 'paid';

console.log('Inventory cervezas after 2 sold:', inventory.find(i => i.id === 'inv-cerveza').qty, '(expected: 8)');
console.log('Order status after partial split:', order.status, '(expected: open)');
console.log('Order items remaining:', order.items.map(i => `${i.name} x${i.qty}`));

// Now charge the rest (1 cerveza + 1 ron)
const chargeSelection2 = order.items.map(i => ({ ...i }));
deductInventory(chargeSelection2);
chargeSelection2.forEach(selItem => {
  const oi = order.items.find(i => i.productId === selItem.productId);
  if (oi) oi.qty -= selItem.qty;
});
order.items = order.items.filter(i => i.qty > 0);
if (order.items.length === 0) order.status = 'paid';

console.log('Inventory cervezas after all sold:', inventory.find(i => i.id === 'inv-cerveza').qty, '(expected: 7)');
console.log('Inventory ron after all sold:', inventory.find(i => i.id === 'inv-ron').qty, '(expected: 4)');
console.log('Order status after full settlement:', order.status, '(expected: paid)');
if (order.status !== 'paid') throw new Error('Order should be paid');

// Test 3: Equal Split Fractions (Partes iguales)
console.log('\n--- TEST 3: Equal Split Fractions ---');
const eqOrder = {
  id: 'ord-2',
  tableId: 't-2',
  tableName: 'Mesa 2',
  status: 'open',
  items: [
    { productId: 'p-beer', name: 'Cerveza', price: 10000, qty: 6, inventoryId: 'inv-beer' }
  ]
};
const eqInventory = [{ id: 'inv-beer', name: 'Cerveza', qty: 20, min: 2, unit: 'und' }];

function deductEqInventory(items) {
  items.forEach(item => {
    const supply = eqInventory.find(i => i.id === item.inventoryId);
    if (supply) {
      supply.qty = Math.max(0, Number((supply.qty - item.qty).toFixed(2)));
    }
  });
}

// Total $60.000 divided by 3 people = $20.000 each (2 beers each)
const nPeople = 3;
let paidIndices = [];

for (let part = 1; part <= nPeople; part++) {
  const isLast = (paidIndices.length + 1 >= nPeople) || part === nPeople;
  const remainingFractions = Math.max(1, nPeople - paidIndices.length);
  const factor = 1 / remainingFractions;
  
  const fracItems = eqOrder.items.map(item => ({
    ...item,
    qty: isLast ? item.qty : Number((item.qty * factor).toFixed(2))
  }));

  deductEqInventory(fracItems);

  if (isLast) {
    eqOrder.items = [];
    eqOrder.status = 'paid';
  } else {
    fracItems.forEach(fi => {
      const oi = eqOrder.items.find(i => i.productId === fi.productId);
      if (oi) oi.qty = Number((oi.qty - fi.qty).toFixed(2));
    });
    eqOrder.items = eqOrder.items.filter(i => i.qty > 0);
  }
  paidIndices.push(part);
  console.log(`Part ${part} charged. Order status: ${eqOrder.status}. Remaining items:`, eqOrder.items.length);
}

console.log('Remaining inventory beer:', eqInventory[0].qty, '(expected: 14)');
if (eqInventory[0].qty !== 14 || eqOrder.status !== 'paid') {
  throw new Error('Equal split calculation mismatch');
}

console.log('\nAll tests passed successfully!');
