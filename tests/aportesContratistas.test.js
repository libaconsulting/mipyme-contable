// Ejecutar con: node --test tests/aportesContratistas.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const AC = require('../public/contable/aportesContratistas');

const SMMLV = 1750905; // 2026
const liq = (contratos, anio = 2026, mes = 10) => AC.liquidarContratista({ anio, mes, contratos });
const c = (valorMensual, extra) => Object.assign({ id: 'c1', fechaInicio: '2026-01-01', fechaFin: null, valorMensual, claseRiesgo: 1 }, extra || {});

test('Mes completo: IBC = 40 % del valor mensualizado; salud, pensión y ARL I-III se descuentan', () => {
  const L = liq([c(5000000)]);
  assert.equal(L.dias, 30);
  assert.equal(L.ibc, 2000000);
  assert.equal(L.salud.valor, 250000);
  assert.equal(L.pension.valor, 320000);
  assert.equal(L.arl.valor, 10500); // 2.000.000 × 0,522 % = 10.440 → 10.500
  assert.equal(L.arl.aCargoDe, 'contratista');
  assert.equal(L.descuento, 580500);
  assert.equal(L.asumeEmpresa, 0);
  assert.equal(L.total, 580500);
  assert.equal(L.netoAntesDeImpuestos, 5000000 - 580500);
});

test('Si el 40 % no llega a 1 SMMLV se cotiza sobre el mínimo', () => {
  const L = liq([c(2000000)]);
  assert.equal(L.ibc, SMMLV);
  assert.equal(L.origenIbc, 'mínimo (1 SMMLV)');
  assert.equal(L.salud.valor, 218900);
  assert.equal(L.pension.valor, 280200);
  assert.equal(L.arl.valor, 9200);
  assert.ok(L.avisos.some((a) => /no alcanza 1 SMMLV/.test(a)));
});

test('Clases IV y V: la ARL la asume la empresa y no se descuenta', () => {
  const L = liq([c(6000000, { claseRiesgo: 4 })]);
  assert.equal(L.ibc, 2400000);
  assert.equal(L.arl.valor, 104400);
  assert.equal(L.arl.aCargoDe, 'empresa');
  assert.equal(L.descuento, 300000 + 384000);
  assert.equal(L.asumeEmpresa, 104400);
  assert.equal(L.total, 300000 + 384000 + 104400);
  const V = liq([c(6000000, { claseRiesgo: 5 })]);
  assert.equal(V.arl.valor, 167100); // 2.400.000 × 6,96 % = 167.040
  assert.equal(V.asumeEmpresa, V.arl.valor);
});

test('Contrato que empieza a mitad de mes: días comerciales y mínimo proporcional', () => {
  const L = liq([c(6000000, { fechaInicio: '2026-10-16' })]); // octubre tiene 31 días: del 16 al 30 comercial = 15 días
  assert.equal(L.dias, 15);
  assert.equal(L.valorDelMes, 3000000);
  assert.equal(L.ibc, 1200000);
  const bajo = liq([c(1000000, { fechaInicio: '2026-10-16' })]);
  assert.equal(bajo.ibc, Math.round(SMMLV * 15 / 30)); // mínimo proporcional
});

test('Contrato que termina dentro del mes: avisa la novedad RET-T', () => {
  const L = liq([c(6000000, { fechaFin: '2026-02-15' })], 2026, 2);
  assert.equal(L.dias, 15);
  assert.equal(L.terminaEnMes, true);
  assert.ok(L.avisos.some((a) => /RET-T/.test(a)));
  // Terminar el último día del mes (28 de febrero) cuenta el mes completo
  const F = liq([c(6000000, { fechaFin: '2026-02-28' })], 2026, 2);
  assert.equal(F.dias, 30);
});

test('Contratos fuera del mes no entran; fecha de inicio el día 31 cuenta un día', () => {
  assert.equal(liq([c(5000000, { fechaInicio: '2026-11-01' })]), null);
  assert.equal(liq([c(5000000, { fechaFin: '2026-09-30' })]), null);
  const L = liq([c(6000000, { fechaInicio: '2026-10-31' })]);
  assert.equal(L.dias, 1);
});

test('Varios contratos en el mes: se suman los valores y la ARL es la clase más alta', () => {
  const L = liq([c(3000000, { id: 'a', claseRiesgo: 1 }), c(4000000, { id: 'b', claseRiesgo: 4 })]);
  assert.equal(L.base40, 2800000);
  assert.equal(L.ibc, 2800000);
  assert.equal(L.arl.clase, 4);
  assert.equal(L.arl.aCargoDe, 'empresa');
  assert.equal(L.contratos.length, 2);
  // Contratos en días distintos: los días son la unión
  const U = liq([c(3000000, { id: 'a', fechaFin: '2026-10-10' }), c(3000000, { id: 'b', fechaInicio: '2026-10-06', fechaFin: '2026-10-20' })]);
  assert.equal(U.dias, 20);
});

test('Fondo de solidaridad pensional desde 4 SMMLV de IBC y tope de 25 SMMLV', () => {
  const sin = liq([c(10000000)]); // IBC 4.000.000 < 4 SMMLV (7.003.620)
  assert.equal(sin.fsp.valor, 0);
  const A = liq([c(20000000)]); // IBC 8.000.000: 1 %
  assert.equal(A.fsp.solidaridad, 80000);
  assert.equal(A.fsp.subsistencia, 0);
  const B = liq([c(71000000)]); // IBC 28.400.000 ≥ 16 SMMLV: 1,2 %
  assert.equal(B.fsp.solidaridad, 284000);
  assert.equal(B.fsp.subsistencia, 56800);
  const M = liq([c(200000000)]);
  assert.equal(M.ibc, 25 * SMMLV);
  assert.equal(M.origenIbc, 'máximo (25 SMMLV)');
});

test('Planilla del mes: totales y contratistas sin contrato vigente fuera', () => {
  const r = AC.liquidarPeriodo({ anio: 2026, mes: 10, contratistas: [
    { terceroId: 't1', nombre: 'Ana', identificacion: '1', contratos: [c(5000000)] },
    { terceroId: 't2', nombre: 'Luis', identificacion: '2', contratos: [c(6000000, { claseRiesgo: 5 })] },
    { terceroId: 't3', nombre: 'Fuera', identificacion: '3', contratos: [c(6000000, { fechaFin: '2026-08-31' })] },
  ] });
  assert.equal(r.lineas.length, 2);
  assert.equal(r.totales.contratistas, 2);
  assert.equal(r.totales.total, r.lineas[0].total + r.lineas[1].total);
  assert.equal(r.totales.total, r.totales.salud + r.totales.pension + r.totales.arl);
  assert.equal(r.totales.descuento + r.totales.asumeEmpresa, r.totales.total);
});

test('Asiento de causación: descuento a la cuenta por pagar del contratista y ARL de la empresa al gasto', () => {
  const r = AC.liquidarPeriodo({ anio: 2026, mes: 10, contratistas: [
    { terceroId: 't1', contratos: [c(5000000)] },
    { terceroId: 't2', contratos: [c(6000000, { claseRiesgo: 4 })] },
  ] });
  const items = [
    { terceroId: 't1', area: 'administracion', cuentaPorPagar: '2335', liquidacion: r.lineas[0] },
    { terceroId: 't2', area: 'ventas', cuentaPorPagar: '2205', liquidacion: r.lineas[1] },
  ];
  const a = AC.armarAsientoCausacion(items);
  assert.equal(a.cuadra, true);
  assert.equal(a.totalCredito, r.totales.total);
  const lin = (cuenta, t) => a.lineas.find((l) => l.cuentaCodigo === cuenta && l.terceroId === t);
  assert.equal(lin('2335', 't1').debito, 580500);
  assert.equal(lin('2205', 't2').debito, 684000);
  assert.equal(lin('520568', 't2').debito, 104400);
  assert.equal(lin('237005', 't1').credito, 250000);
  assert.equal(lin('238030', 't2').credito, 384000);
  assert.equal(lin('237006', 't2').credito, 104400);
});

test('Asiento del pago de la planilla: salda lo causado, con mora y banco', () => {
  const r = AC.liquidarPeriodo({ anio: 2026, mes: 10, contratistas: [{ terceroId: 't1', contratos: [c(5000000)] }] });
  const a = AC.armarAsientoPago([{ terceroId: 't1', liquidacion: r.lineas[0] }], 12000, '111005');
  assert.equal(a.cuadra, true);
  assert.equal(a.totalDebito, 580500 + 12000);
  assert.equal(a.lineas.find((l) => l.cuentaCodigo === '111005').credito, 592500);
  assert.equal(a.lineas.find((l) => l.cuentaCodigo === '530520').debito, 12000);
  // Lo causado y lo pagado se compensan por cuenta y tercero
  const caus = AC.armarAsientoCausacion([{ terceroId: 't1', area: 'administracion', cuentaPorPagar: '2335', liquidacion: r.lineas[0] }]);
  for (const cuenta of ['237005', '238030', '237006']) {
    assert.equal(caus.lineas.find((l) => l.cuentaCodigo === cuenta).credito, a.lineas.find((l) => l.cuentaCodigo === cuenta).debito);
  }
});
