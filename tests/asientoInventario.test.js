// Ejecutar con: node --test tests/asientoInventario.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../public/contable/asientoInventario');

test('Costo de ventas: agrupa por cuenta y cuadra', () => {
  const r = A.armarAsientoCostoVenta([
    { cuentaInventario: '1435', cuentaCosto: '6135', valor: 550 },
    { cuentaInventario: '1435', cuentaCosto: '6135', valor: 33.33 },
    { cuentaInventario: '1430', cuentaCosto: '6120', valor: 100 },
  ], { centroCosto: 'OBRA-1' });
  assert.equal(r.cuadra, true);
  const l = (c) => r.lineas.find((x) => x.cuentaCodigo === c);
  assert.equal(l('6135').debito, 583.33);
  assert.equal(l('6135').centroCosto, 'OBRA-1');
  assert.equal(l('1435').credito, 583.33);
  assert.equal(l('6120').debito, 100);
  assert.equal(l('1430').credito, 100);
});

test('Costo cero: no genera líneas', () => {
  const r = A.armarAsientoCostoVenta([{ valor: 0 }]);
  assert.equal(r.lineas.length, 0);
  assert.equal(r.cuadra, false);
});

test('Entrada manual: Db inventario / Cr contrapartida', () => {
  const r = A.armarAsientoMovimiento({ tipo: 'entrada', valor: 1000, cuentaInventario: '1435', contrapartida: '4295' });
  assert.equal(r.cuadra, true);
  assert.deepEqual(r.lineas.map((x) => [x.cuentaCodigo, x.debito, x.credito]), [['1435', 1000, 0], ['4295', 0, 1000]]);
});

test('Salida manual: Db gasto / Cr inventario, con tercero en devolución a proveedor', () => {
  const r = A.armarAsientoMovimiento({ tipo: 'salida', valor: 250.5, cuentaInventario: '1435', contrapartida: '2205', terceroId: 't1' });
  assert.equal(r.cuadra, true);
  assert.deepEqual(r.lineas.map((x) => [x.cuentaCodigo, x.debito, x.credito]), [['2205', 250.5, 0], ['1435', 0, 250.5]]);
  assert.equal(r.lineas[0].terceroId, 't1');
});

test('Conceptos y catálogo', () => {
  assert.equal(A.CONCEPTOS.saldo_inicial.sinAsiento, true);
  assert.equal(A.CONCEPTOS.faltante.tipo, 'salida');
  assert.ok(A.CUENTAS_INVENTARIO.includes('1435') && A.CUENTAS_INVENTARIO.includes('1430'));
  assert.ok(A.CUENTAS_COSTO.includes('6135'));
});
