// Ejecutar con: node --test tests/asientoVenta.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { armarAsientoVenta, CUENTAS_FIJAS } = require('../public/contable/asientoVenta');

const cuenta = (r, codigo) => r.lineas.filter((l) => l.cuentaCodigo === codigo);

test('Venta de servicios con IVA: Db clientes, Cr ingreso e IVA por pagar', () => {
  const r = armarAsientoVenta({
    lineas: [{ valorTotal: 1000000 }, { valorTotal: 500000 }],
    base: 1500000, iva: 285000, total: 1785000,
    cuentasLinea: ['4135', '4135'],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, CUENTAS_FIJAS.CLIENTES)[0].debito, 1785000);
  assert.equal(cuenta(r, '4135').length, 1, 'mismas cuentas se agrupan');
  assert.equal(cuenta(r, '4135')[0].credito, 1500000);
  assert.equal(cuenta(r, CUENTAS_FIJAS.IVA_POR_PAGAR)[0].credito, 285000);
});

test('Cada línea puede ir a una cuenta de ingreso distinta', () => {
  const r = armarAsientoVenta({
    lineas: [{ valorTotal: 800000 }, { valorTotal: 200000 }],
    base: 1000000, iva: 190000, total: 1190000,
    cuentasLinea: ['4135', '4155'],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '4135')[0].credito, 800000);
  assert.equal(cuenta(r, '4155')[0].credito, 200000);
});

test('Sin IVA no hay línea de IVA', () => {
  const r = armarAsientoVenta({ lineas: [{ valorTotal: 100000 }], base: 100000, iva: 0, total: 100000, cuentasLinea: ['4135'] });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '2408').length, 0);
});

test('Descuento a nivel de factura se reparte entre las líneas y cuadra', () => {
  // líneas suman 1.000.000 pero la base real es 900.000 (descuento global)
  const r = armarAsientoVenta({
    lineas: [{ valorTotal: 600000 }, { valorTotal: 400000 }],
    base: 900000, iva: 171000, total: 1071000,
    cuentasLinea: ['4135', '4155'],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '4135')[0].credito, 540000);
  assert.equal(cuenta(r, '4155')[0].credito, 360000);
});

test('Centavos: siempre cuadra', () => {
  const r = armarAsientoVenta({
    lineas: [{ valorTotal: 33.33 }, { valorTotal: 33.33 }, { valorTotal: 33.34 }],
    base: 100, iva: 19, total: 119, cuentasLinea: ['4135', '4135', '4155'],
  });
  assert.equal(r.cuadra, true);
});

test('El centro de costo va en las líneas de ingreso', () => {
  const r = armarAsientoVenta({ lineas: [{ valorTotal: 100 }], base: 100, iva: 0, total: 100, cuentasLinea: ['4135'], centroCosto: 'P-1' });
  assert.equal(cuenta(r, '4135')[0].centroCosto, 'P-1');
});

test('Errores: sin líneas o sin cuenta de alguna línea', () => {
  assert.throws(() => armarAsientoVenta({ lineas: [], base: 0, iva: 0, total: 0, cuentasLinea: [] }), /no tiene líneas/);
  assert.throws(() => armarAsientoVenta({ lineas: [{ valorTotal: 1 }], base: 1, iva: 0, total: 1, cuentasLinea: [] }), /Falta la cuenta/);
});
