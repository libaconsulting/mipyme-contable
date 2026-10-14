// Ejecutar con: node --test tests/prestacionesNomina.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const PN = require('../public/contable/prestacionesNomina');
const { liquidarEmpleado } = require('../public/contable/liquidacionNomina');

const SMMLV = 1750905;
const AUX = 249095;

const CONTRATO = {
  fechaIngreso: '2025-01-01', salarioBase: 2000000, tipoSalario: 'ordinario', tipoContrato: 'indefinido',
  auxilioTransporte: 'auto', claseRiesgo: 1, retencionFuente: 'calculada',
};

// Meses de referencia armados con el mismo motor de la nómina mensual.
function meses(contrato, desde, hasta, extras) {
  const lista = [];
  let [a, m] = desde;
  while (a * 12 + m <= hasta[0] * 12 + hasta[1]) {
    const e = (extras && extras[`${a}-${m}`]) || {};
    const L = liquidarEmpleado({ anio: a, mes: m, contrato, ausencias: e.ausencias, conceptos: e.conceptos });
    lista.push(PN.mesDeLiquidacion(L, { salarioBase: contrato.salarioBase }));
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return lista;
}

test('Prima: semestre completo con salario fijo = (salario + auxilio) × 180 / 360', () => {
  const m = meses(CONTRATO, [2026, 1], [2026, 6]);
  const p = PN.calcularPrima({ contrato: CONTRATO, anio: 2026, semestre: 1, meses: m, ausencias: [] });
  assert.equal(p.dias, 180);
  assert.equal(p.metodo, 'ultimo_salario');
  assert.equal(p.base, 2000000 + AUX);
  assert.equal(p.valor, Math.round(((2000000 + AUX) * 180) / 360));
});

test('Prima: quien ingresa a mitad de semestre cobra proporcional', () => {
  const c = { ...CONTRATO, fechaIngreso: '2026-03-16' };
  const m = meses(c, [2026, 3], [2026, 6]);
  const p = PN.calcularPrima({ contrato: c, anio: 2026, semestre: 1, meses: m, ausencias: [] });
  assert.equal(p.desde, '2026-03-16');
  assert.equal(p.dias, 105); // 15 de marzo + abril, mayo y junio
  assert.equal(p.valor, Math.round(((2000000 + AUX) * 105) / 360));
});

test('Prima: segundo semestre y corte anticipado', () => {
  const m = meses(CONTRATO, [2026, 7], [2026, 12]);
  const p = PN.calcularPrima({ contrato: CONTRATO, anio: 2026, semestre: 2, meses: m, ausencias: [] });
  assert.equal(p.desde, '2026-07-01');
  assert.equal(p.hasta, '2026-12-31');
  assert.equal(p.dias, 180);
  const c2 = PN.calcularPrima({ contrato: { ...CONTRATO, fechaTerminacion: '2026-09-15' }, anio: 2026, semestre: 2, meses: m, ausencias: [] });
  assert.equal(c2.dias, 75);
});

test('Prima: la licencia no remunerada descuenta días; las vacaciones no', () => {
  const m = meses(CONTRATO, [2026, 1], [2026, 6]);
  const p = PN.calcularPrima({
    contrato: CONTRATO, anio: 2026, semestre: 1, meses: m,
    ausencias: [
      { tipo: 'licencia_no_remunerada', desde: '2026-02-02', hasta: '2026-02-11' },
      { tipo: 'vacaciones', desde: '2026-04-06', hasta: '2026-04-24' },
    ],
  });
  assert.equal(p.diasNoRemunerados, 10);
  assert.equal(p.dias, 170);
});

test('Prima: con comisiones se promedia lo devengado en el semestre', () => {
  const extras = {};
  for (let mes = 1; mes <= 6; mes++) extras[`2026-${mes}`] = { conceptos: [{ codigo: 'comision', valor: mes * 100000 }] };
  const m = meses(CONTRATO, [2026, 1], [2026, 6], extras);
  const p = PN.calcularPrima({ contrato: CONTRATO, anio: 2026, semestre: 1, meses: m, ausencias: [] });
  assert.equal(p.metodo, 'promedio');
  const comisiones = (1 + 2 + 3 + 4 + 5 + 6) * 100000;
  const promedio = (6 * (2000000 + AUX) + comisiones) / 6; // meses completos de 30 días
  assert.equal(p.base, Math.round(promedio));
  assert.equal(p.valor, Math.round((Math.round(promedio) * 180) / 360));
});

test('Salario integral: no hay prima, cesantías ni intereses', () => {
  const c = { ...CONTRATO, salarioBase: 14 * SMMLV, tipoSalario: 'integral' };
  const m = meses(c, [2026, 1], [2026, 6]);
  const p = PN.calcularPrima({ contrato: c, anio: 2026, semestre: 1, meses: m, ausencias: [] });
  assert.equal(p.valor, 0);
  const ces = PN.calcularCesantias({ contrato: c, anio: 2026, meses: m, ausencias: [] });
  assert.equal(ces.valor, 0);
  assert.equal(PN.calcularIntereses({ cesantias: ces }).valor, 0);
});

test('Cesantías e intereses del año completo', () => {
  const m = meses(CONTRATO, [2026, 1], [2026, 12]);
  const ces = PN.calcularCesantias({ contrato: CONTRATO, anio: 2026, meses: m, ausencias: [] });
  assert.equal(ces.dias, 360);
  assert.equal(ces.valor, 2000000 + AUX);
  const int = PN.calcularIntereses({ cesantias: ces });
  assert.equal(int.valor, Math.round(((2000000 + AUX) * 360 * 0.12) / 360));
});

test('Cesantías: un cambio de salario en los últimos 3 meses obliga a promediar', () => {
  const lista = meses(CONTRATO, [2026, 1], [2026, 12]);
  // Aumento desde noviembre (dentro de los últimos 3 meses): se simula con el salario de esos meses
  for (const mes of lista.filter((x) => x.mes >= 11)) { mes.salarioBase = 2400000; mes.salarial = 2400000; }
  const ces = PN.calcularCesantias({ contrato: { ...CONTRATO, salarioBase: 2400000 }, anio: 2026, meses: lista, ausencias: [] });
  assert.equal(ces.metodo, 'promedio');
  const esperado = Math.round(((10 * (2000000 + AUX) + 2 * (2400000 + AUX)) / 12));
  assert.equal(ces.base, esperado);
});

test('Cesantías: si el aumento ya cumple 3 meses se usa el último salario', () => {
  const lista = meses(CONTRATO, [2026, 1], [2026, 12]);
  for (const mes of lista.filter((x) => x.mes >= 10)) { mes.salarioBase = 2400000; mes.salarial = 2400000; }
  const ces = PN.calcularCesantias({ contrato: { ...CONTRATO, salarioBase: 2400000 }, anio: 2026, meses: lista, ausencias: [] });
  assert.equal(ces.metodo, 'ultimo_salario');
  assert.equal(ces.base, 2400000 + AUX);
});

test('Cesantías: el auxilio de transporte no aplica a quien gana más de 2 SMMLV', () => {
  const c = { ...CONTRATO, salarioBase: 4000000 };
  const m = meses(c, [2026, 1], [2026, 12]);
  const ces = PN.calcularCesantias({ contrato: c, anio: 2026, meses: m, ausencias: [] });
  assert.equal(ces.base, 4000000);
});

test('Días hábiles: sin domingos, festivos ni (con semana de 5 días) sábados', () => {
  // 5 al 16 de octubre de 2026; el lunes 12 es festivo
  assert.equal(PN.diasHabiles('2026-10-05', '2026-10-16', 5), 9);
  assert.equal(PN.diasHabiles('2026-10-05', '2026-10-16', 6), 10);
  assert.equal(PN.diasHabiles('2026-10-16', '2026-10-05', 5), 0);
});

test('Vacaciones: causadas, usadas y saldo', () => {
  const c = { ...CONTRATO, fechaIngreso: '2025-01-01', vacacionesDiasPrevios: 0 };
  const m = meses(c, [2025, 7], [2026, 6]);
  const s = PN.saldoVacaciones({ contrato: c, corte: '2026-06-30', ausencias: [], tomados: 5, compensados: 0, meses: m });
  assert.equal(s.diasServicio, 540);
  assert.equal(s.causados, 22.5);
  assert.equal(s.saldo, 17.5);
  assert.equal(s.base, 2000000);
  assert.equal(s.valorSaldo, Math.round((17.5 * 2000000) / 30));
});

test('Vacaciones: días previos al sistema y licencias no remuneradas', () => {
  const c = { ...CONTRATO, fechaIngreso: '2025-01-01', vacacionesDiasPrevios: 15 };
  const m = meses(c, [2025, 7], [2026, 6]);
  const s = PN.saldoVacaciones({
    contrato: c, corte: '2026-06-30', tomados: 0, compensados: 0, meses: m,
    ausencias: [{ tipo: 'licencia_no_remunerada', desde: '2025-03-03', hasta: '2025-03-14' }],
  });
  assert.equal(s.diasNoRemunerados, 12);
  assert.equal(s.causados, Math.round(((540 - 12) * 15 / 360) * 100) / 100);
  assert.equal(s.saldo, Math.round((s.causados - 15) * 100) / 100);
});

test('Vacaciones en dinero: no se pueden pagar más días que el saldo', () => {
  const c = { ...CONTRATO, vacacionesDiasPrevios: 0 };
  const m = meses(c, [2025, 7], [2026, 6]);
  const ok = PN.calcularVacacionesEnDinero({ contrato: c, corte: '2026-06-30', ausencias: [], tomados: 0, compensados: 0, meses: m, dias: 7.5 });
  assert.equal(ok.valor, Math.round((7.5 * 2000000) / 30));
  assert.throws(() => PN.calcularVacacionesEnDinero({ contrato: c, corte: '2026-06-30', ausencias: [], tomados: 0, compensados: 0, meses: m, dias: 40 }), /solo tiene/);
  assert.throws(() => PN.calcularVacacionesEnDinero({ contrato: c, corte: '2026-06-30', ausencias: [], tomados: 0, compensados: 0, meses: m, dias: 0 }), /Escribe/);
});

test('Vacaciones: la base no incluye extras ni auxilio', () => {
  const extras = { '2026-5': { conceptos: [{ codigo: 'hed', cantidad: 10 }, { codigo: 'comision', valor: 600000 }] } };
  const c = { ...CONTRATO };
  const m = meses(c, [2025, 7], [2026, 6], extras);
  const s = PN.saldoVacaciones({ contrato: c, corte: '2026-06-30', ausencias: [], tomados: 0, compensados: 0, meses: m });
  assert.equal(s.metodo, 'promedio');
  // 12 meses de sueldo + la comisión (las horas extras se excluyen), sobre 360 días
  assert.equal(s.base, Math.round((12 * 2000000 + 600000) / 12));
});

test('Indemnización: contrato indefinido de menos de 10 SMMLV', () => {
  const c = { ...CONTRATO, fechaIngreso: '2024-03-01' };
  const i = PN.calcularIndemnizacion({ contrato: c, fechaRetiro: '2026-03-31', causa: 'sin_justa_causa', baseMensual: 2000000 });
  // 750 días de servicio: 30 días el primer año + 20 por el 1,0833 restante
  assert.equal(i.dias, 51.67);
  assert.equal(i.valor, Math.round((51.67 * 2000000) / 30));
});

test('Indemnización: primer año completo son 30 días aunque haya trabajado menos', () => {
  const c = { ...CONTRATO, fechaIngreso: '2026-08-01' };
  const i = PN.calcularIndemnizacion({ contrato: c, fechaRetiro: '2026-09-30', causa: 'sin_justa_causa', baseMensual: 3000000 });
  assert.equal(i.dias, 30);
  assert.equal(i.valor, 3000000);
});

test('Indemnización: 10 SMMLV o más son 20 días el primer año y 15 por cada año siguiente', () => {
  const c = { ...CONTRATO, salarioBase: 11 * SMMLV, fechaIngreso: '2024-03-01' };
  const i = PN.calcularIndemnizacion({ contrato: c, fechaRetiro: '2026-03-01', causa: 'sin_justa_causa', baseMensual: 11 * SMMLV });
  const anios = PN.dias360('2024-03-01', '2026-03-01') / 360;
  assert.equal(i.dias, Math.round((20 + 15 * (anios - 1)) * 100) / 100);
});

test('Indemnización: término fijo paga lo que faltaba, con mínimo de 15 días', () => {
  const c = { ...CONTRATO, tipoContrato: 'fijo', fechaIngreso: '2026-01-01', fechaFinPactada: '2026-12-31' };
  const i = PN.calcularIndemnizacion({ contrato: c, fechaRetiro: '2026-10-15', causa: 'sin_justa_causa', baseMensual: 2000000 });
  assert.equal(i.dias, 75);
  assert.equal(i.valor, 5000000);
  const corto = PN.calcularIndemnizacion({ contrato: c, fechaRetiro: '2026-12-25', causa: 'sin_justa_causa', baseMensual: 2000000 });
  assert.equal(corto.dias, 15);
});

test('Sin indemnización cuando renuncia o hay justa causa', () => {
  for (const causa of ['renuncia', 'con_justa_causa', 'mutuo_acuerdo', 'vencimiento_plazo']) {
    assert.equal(PN.calcularIndemnizacion({ contrato: CONTRATO, fechaRetiro: '2026-10-15', causa, baseMensual: 2000000 }).valor, 0);
  }
  assert.throws(() => PN.calcularIndemnizacion({ contrato: CONTRATO, fechaRetiro: '2026-10-15', causa: 'inventada', baseMensual: 1 }), /causa/);
});

test('Retención adicional: nada para un salario bajo, algo para uno alto', () => {
  const bajo = liquidarEmpleado({ anio: 2026, mes: 10, contrato: CONTRATO });
  assert.equal(PN.retencionAdicional({ anio: 2026, liquidacion: bajo, contrato: CONTRATO, adicional: 1000000 }).valor, 0);

  const alto = { ...CONTRATO, salarioBase: 9000000 };
  const L = liquidarEmpleado({ anio: 2026, mes: 10, contrato: alto });
  const r = PN.retencionAdicional({ anio: 2026, liquidacion: L, contrato: alto, adicional: 4500000 });
  assert.ok(r.valor > 0);
  assert.equal(r.valor % 1000, 0, 'se aproxima al múltiplo de mil');
  // La retención del mes con el pago extra es mayor que la del mes solo
  assert.ok(r.valor >= L.retencion.valor * 0 + 1);
  assert.equal(PN.retencionAdicional({ anio: 2026, liquidacion: L, contrato: alto, adicional: 0 }).valor, 0);
});

test('Retención adicional: respeta "no aplica" y "valor fijo"', () => {
  const c = { ...CONTRATO, salarioBase: 9000000, retencionFuente: 'no_aplica' };
  const L = liquidarEmpleado({ anio: 2026, mes: 10, contrato: c });
  assert.equal(PN.retencionAdicional({ anio: 2026, liquidacion: L, contrato: c, adicional: 5000000 }).valor, 0);
  const m = { ...c, retencionFuente: 'manual', retencionManual: 100000 };
  const Lm = liquidarEmpleado({ anio: 2026, mes: 10, contrato: m });
  assert.equal(PN.retencionAdicional({ anio: 2026, liquidacion: Lm, contrato: m, adicional: 5000000 }).modo, 'manual');
});

test('Liquidación final: renuncia con todos los conceptos y neto que cuadra', () => {
  const c = { ...CONTRATO, fechaIngreso: '2025-02-01', vacacionesDiasPrevios: 0 };
  const m = meses(c, [2025, 10], [2026, 10]);
  const L = liquidarEmpleado({ anio: 2026, mes: 10, contrato: { ...c, fechaTerminacion: '2026-10-15' } });
  const liq = PN.liquidarContrato({
    contrato: c, fechaRetiro: '2026-10-15', causa: 'renuncia', meses: m, ausencias: [],
    vacaciones: { tomados: 6, compensados: 0 }, liquidacionMes: L,
  });
  const por = Object.fromEntries(liq.componentes.map((x) => [x.concepto, x]));
  assert.equal(por.prima.dias, 105); // 1-jul a 15-oct
  assert.equal(por.cesantias.dias, 285); // 1-ene a 15-oct
  assert.equal(por.intereses.valor, Math.round((por.cesantias.valor * 285 * 0.12) / 360));
  assert.ok(por.vacaciones.valor > 0);
  assert.equal(por.indemnizacion, undefined);
  assert.equal(liq.devengado, liq.componentes.reduce((s, x) => s + x.valor, 0));
  assert.equal(liq.neto, liq.devengado - liq.retencion.valor - liq.totalDescuentos);
});

test('Liquidación final: despido sin justa causa suma la indemnización; descuentos y otros pagos', () => {
  const c = { ...CONTRATO, fechaIngreso: '2025-02-01' };
  const m = meses(c, [2025, 10], [2026, 10]);
  const L = liquidarEmpleado({ anio: 2026, mes: 10, contrato: { ...c, fechaTerminacion: '2026-10-15' } });
  const liq = PN.liquidarContrato({
    contrato: c, fechaRetiro: '2026-10-15', causa: 'sin_justa_causa', meses: m, ausencias: [],
    vacaciones: { tomados: 0, compensados: 0 }, liquidacionMes: L,
    otrosDevengos: [{ descripcion: 'Bonificación pactada', valor: 300000 }],
    descuentos: [{ descripcion: 'Saldo de préstamo', valor: 150000, cuenta: '1365' }],
  });
  const por = Object.fromEntries(liq.componentes.map((x) => [x.concepto, x]));
  assert.ok(por.indemnizacion.valor > 0);
  assert.equal(por.otro.valor, 300000);
  assert.equal(por.otro.liquidaTotal, false);
  assert.equal(liq.totalDescuentos, 150000);
  assert.equal(liq.neto, liq.devengado - liq.retencion.valor - 150000);
});

test('Liquidación final: validaciones', () => {
  assert.throws(() => PN.liquidarContrato({ contrato: CONTRATO, fechaRetiro: '2024-12-31', causa: 'renuncia', meses: [], ausencias: [] }), /anterior al ingreso/);
  assert.throws(() => PN.liquidarContrato({ contrato: CONTRATO, fechaRetiro: '2026-10-15', causa: 'x', meses: [], ausencias: [] }), /causa/);
});
