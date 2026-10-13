// Ejecutar con: node --test tests/asientoCompra.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { armarAsientoCompra, repartir } = require('../public/contable/asientoCompra');

const linea = (valorTotal, extra = {}) => ({ valorTotal, iva: 0, otrosImpuestos: 0, ...extra });
const cuenta = (r, codigo) => r.lineas.filter((l) => l.cuentaCodigo === codigo);

test('Servicio con IVA descontable, retefuente y ReteIVA', () => {
  const r = armarAsientoCompra({
    lineas: [linea(1000000, { iva: 190000 }), linea(500000, { iva: 95000 })],
    base: 1500000, iva: 285000, impoconsumo: 0, total: 1785000,
    ivaDescontable: true,
    cuentasLinea: ['5195', '5195'],
    retenciones: [{ sobre: 'base', valor: 60000 }, { sobre: 'iva', valor: 42750 }],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '5195').length, 1); // las dos líneas van a la misma cuenta -> un solo débito
  assert.equal(cuenta(r, '5195')[0].debito, 1500000);
  assert.equal(cuenta(r, '1355')[0].debito, 285000);
  assert.equal(cuenta(r, '2365')[0].credito, 60000);
  assert.equal(cuenta(r, '2367')[0].credito, 42750);
  assert.equal(cuenta(r, '2205')[0].credito, 1682250);
  assert.equal(r.netoAPagar, 1682250);
  assert.equal(r.totalDebito, 1785000);
});

test('Cada línea a su cuenta', () => {
  const r = armarAsientoCompra({
    lineas: [linea(300000), linea(200000)],
    base: 500000, iva: 0, impoconsumo: 0, total: 500000,
    ivaDescontable: true, cuentasLinea: ['1435', '5195'], retenciones: [],
  });
  assert.equal(cuenta(r, '1435')[0].debito, 300000);
  assert.equal(cuenta(r, '5195')[0].debito, 200000);
  assert.equal(cuenta(r, '2365').length, 0); // sin retención no hay línea 2365
  assert.equal(cuenta(r, '1355').length, 0); // sin IVA no hay línea 1355
});

test('Empresa no responsable de IVA: el IVA suma al gasto de su propia línea', () => {
  const r = armarAsientoCompra({
    lineas: [linea(100000, { iva: 19000 }), linea(100000)],
    base: 200000, iva: 19000, impoconsumo: 0, total: 219000,
    ivaDescontable: false, cuentasLinea: ['1435', '5195'], retenciones: [],
  });
  assert.equal(cuenta(r, '1435')[0].debito, 119000);
  assert.equal(cuenta(r, '5195')[0].debito, 100000);
  assert.equal(cuenta(r, '1355').length, 0);
  assert.equal(r.cuadra, true);
});

test('Impoconsumo va a la línea que lo causa', () => {
  const r = armarAsientoCompra({
    lineas: [linea(200000, { otrosImpuestos: 16000 }), linea(100000, { iva: 19000 })],
    base: 300000, iva: 19000, impoconsumo: 16000, total: 335000,
    ivaDescontable: true, cuentasLinea: ['5195', '1435'], retenciones: [],
  });
  assert.equal(cuenta(r, '5195')[0].debito, 216000);
  assert.equal(cuenta(r, '1435')[0].debito, 100000);
  assert.equal(cuenta(r, '1355')[0].debito, 19000);
});

test('Descuento global se reparte en proporción y siempre cuadra al centavo', () => {
  const r = armarAsientoCompra({
    lineas: [linea(99999.99), linea(77777.77), linea(8641.92)],
    base: 154086.35, iva: 0, impoconsumo: 0, total: 154086.35, // = suma de líneas - 32333,33
    ivaDescontable: true, cuentasLinea: ['5195', '1435', '5195'], retenciones: [],
  });
  assert.equal(r.cuadra, true);
  assert.equal(r.totalDebito, 154086.35);
});

test('Si el XML es incoherente, el proveedor se acredita por el total y el asiento cuadra', () => {
  // líneas suman 100.000 pero el total con impuestos del XML es 130.000 (IVA 19.000)
  const r = armarAsientoCompra({
    lineas: [linea(100000)],
    base: 111000, iva: 19000, impoconsumo: 0, total: 130000,
    ivaDescontable: true, cuentasLinea: ['5195'], retenciones: [],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '5195')[0].debito, 111000);
  assert.equal(cuenta(r, '2205')[0].credito, 130000);
});

test('Línea gratuita (valor 0) no rompe el reparto', () => {
  const r = armarAsientoCompra({
    lineas: [linea(0), linea(50000)],
    base: 55000, iva: 0, impoconsumo: 0, total: 55000,
    ivaDescontable: true, cuentasLinea: ['5195', '5195'], retenciones: [],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '5195')[0].debito, 55000);
});

test('Centro de costo solo en las líneas de gasto', () => {
  const r = armarAsientoCompra({
    lineas: [linea(100000)], base: 100000, iva: 0, impoconsumo: 0, total: 100000,
    ivaDescontable: true, cuentasLinea: ['5195'], retenciones: [], centroCosto: 'CO-2026-109-CP',
  });
  assert.equal(cuenta(r, '5195')[0].centroCosto, 'CO-2026-109-CP');
  assert.equal(cuenta(r, '2205')[0].centroCosto, undefined);
});

test('Falta la cuenta de alguna línea', () => {
  assert.throws(() => armarAsientoCompra({ lineas: [linea(1), linea(2)], cuentasLinea: ['5195'], base: 3, total: 3 }), /cuenta destino/);
});

test('repartir no pierde centavos (incluso con valores negativos)', () => {
  for (const total of [100, 101, -37, 0, 1]) {
    const r = repartir(total, [3, 5, 7]);
    assert.equal(r.reduce((a, b) => a + b, 0), total);
  }
  assert.deepEqual(repartir(50, [0, 0]), [50, 0]);
});
