// Ejecutar con: node --test tests/asientoNomina.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { liquidarEmpleado } = require('../public/contable/liquidacionNomina');
const A = require('../public/contable/asientoNomina');

const SMMLV = 1750905;
const liq = (contrato, extra) => liquidarEmpleado(Object.assign({
  anio: 2026, mes: 10,
  contrato: Object.assign({ fechaIngreso: '2025-01-01', salarioBase: SMMLV, claseRiesgo: 1 }, contrato),
}, extra || {}));

const suma = (r, codigo, lado) => r.lineas.filter((l) => l.cuentaCodigo === codigo).reduce((s, l) => s + l[lado], 0);

test('Asiento de un empleado de mínimo: cuadra y cada valor va a su cuenta', () => {
  const l = liq({});
  const r = A.armarAsientoLiquidacion([{ terceroId: 'e1', area: 'administracion', liquidacion: l }]);
  assert.equal(r.cuadra, true);
  assert.equal(suma(r, '510506', 'debito'), SMMLV);
  assert.equal(suma(r, '510527', 'debito'), 249095);
  assert.equal(suma(r, '510570', 'debito'), 210109, 'pensión del empleador');
  assert.equal(suma(r, '510572', 'debito'), 70036, 'caja de compensación');
  assert.equal(suma(r, '510568', 'debito'), 9140, 'ARL');
  assert.equal(suma(r, '2505', 'credito'), 2000000 - 140072, 'neto');
  assert.equal(suma(r, '237005', 'credito'), 70036, 'salud del empleado (el empleador está exonerado)');
  assert.equal(suma(r, '238030', 'credito'), 70036 + 210109);
  assert.equal(suma(r, '237006', 'credito'), 9140);
  assert.equal(suma(r, '237010', 'credito'), 70036);
  assert.equal(r.lineas.find((l) => l.cuentaCodigo === '2505').terceroId, 'e1');
});

test('Cuadra con un caso complejo: vacaciones, incapacidad, extras, descuentos, retención y varios empleados', () => {
  const a = liq({ salarioBase: 8000000, dependientes: 1 }, {
    ausencias: [{ tipo: 'vacaciones', desde: '2026-10-01', hasta: '2026-10-05' }, { tipo: 'incapacidad_general', desde: '2026-10-10', hasta: '2026-10-14' }],
    conceptos: [{ codigo: 'hed', cantidad: 10 }, { codigo: 'bonificacion_no_salarial', valor: 1000000 }],
    descuentos: [{ codigo: 'prestamo', valor: 300000 }, { codigo: 'libranza', valor: 200000 }, { codigo: 'embargo', valor: 100000 }],
  });
  const b = liq({ salarioBase: 2500000, aporteVoluntarioPension: 100000 }, { ausencias: [{ tipo: 'licencia_maternidad', desde: '2026-10-01', hasta: '2026-10-30' }] });
  const c = liq({ salarioBase: 30000000, tipoSalario: 'integral' });
  const items = [
    { terceroId: 'a', area: 'administracion', liquidacion: a },
    { terceroId: 'b', area: 'ventas', liquidacion: b },
    { terceroId: 'c', area: 'administracion', liquidacion: c },
  ];
  const r = A.armarAsientoLiquidacion(items);
  assert.equal(r.cuadra, true, `${r.totalDebito} vs ${r.totalCredito}`);
  assert.equal(suma(r, '2525', 'debito'), a.totales.vacaciones);
  assert.equal(suma(r, '138095', 'debito'), a.incapacidades.porCobrar + b.incapacidades.porCobrar);
  assert.equal(suma(r, '510524', 'debito'), a.incapacidades.pagoEmpleador, 'solo los 2 primeros días de la incapacidad son gasto');
  assert.equal(suma(r, '1365', 'credito'), 300000);
  assert.equal(suma(r, '237030', 'credito'), 200000);
  assert.equal(suma(r, '237025', 'credito'), 100000);
  assert.equal(suma(r, '237045', 'credito'), 100000, 'aporte voluntario');
  assert.equal(suma(r, '236505', 'credito'), a.retencion.valor + b.retencion.valor + c.retencion.valor);
  assert.equal(suma(r, '510503', 'debito'), 30000000, 'salario integral');
  // Total débitos = devengado + aportes del empleador
  const devengado = [a, b, c].reduce((s, l) => s + l.totales.devengado, 0);
  const aportesEmpleador = [a, b, c].reduce((s, l) => s + l.aportes.empleador.total, 0);
  assert.equal(r.totalDebito, devengado + aportesEmpleador);
});

test('Los gastos del área de ventas van a 5205', () => {
  const r = A.armarAsientoLiquidacion([{ terceroId: 'v', area: 'ventas', liquidacion: liq({}) }]);
  assert.equal(suma(r, '520506', 'debito'), SMMLV);
  assert.equal(suma(r, '510506', 'debito'), 0);
});

test('Neto negativo impide armar el asiento', () => {
  const l = liq({}, { descuentos: [{ codigo: 'embargo', valor: 9000000 }] });
  assert.throws(() => A.armarAsientoLiquidacion([{ terceroId: 'x', area: 'administracion', liquidacion: l }]), /negativo/);
});

test('Provisiones: gasto contra pasivos consolidados por empleado', () => {
  const l = liq({});
  const r = A.armarAsientoProvisiones([{ terceroId: 'e1', area: 'administracion', liquidacion: l }]);
  assert.equal(r.cuadra, true);
  assert.equal(suma(r, '510530', 'debito'), 166667);
  assert.equal(suma(r, '510533', 'debito'), 20000);
  assert.equal(suma(r, '510536', 'debito'), 166667);
  assert.equal(suma(r, '510539', 'debito'), 72954);
  assert.equal(suma(r, '2510', 'credito'), 166667);
  assert.equal(suma(r, '2515', 'credito'), 20000);
  assert.equal(suma(r, '2520', 'credito'), 166667);
  assert.equal(suma(r, '2525', 'credito'), 72954);
  assert.equal(r.lineas.find((x) => x.cuentaCodigo === '2510').terceroId, 'e1');
});

test('Pago de la nómina: Db salarios por pagar por empleado, Cr banco', () => {
  const r = A.armarAsientoPago([{ terceroId: 'a', valor: 1000000 }, { terceroId: 'b', valor: 2500000 }], '11100501');
  assert.equal(r.cuadra, true);
  assert.equal(r.totalDebito, 3500000);
  assert.equal(suma(r, '11100501', 'credito'), 3500000);
  assert.equal(r.lineas.filter((l) => l.cuentaCodigo === '2505').length, 2);
});

test('El catálogo trae cada subcuenta con su cuenta padre', () => {
  const por = Object.fromEntries(A.CATALOGO.map((c) => [c.codigo, c]));
  assert.equal(por['510506'].padre, '5105');
  assert.equal(por['520506'].padre, '5205');
  assert.equal(por['236505'].padre, '2365');
  assert.equal(por['138095'].padre, '1380');
  assert.equal(por['2525'].padre, null);
  for (const c of A.CATALOGO) if (c.padre) assert.ok(por[c.padre], `falta el padre ${c.padre}`);
});
