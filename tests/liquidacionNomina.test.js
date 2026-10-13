// Ejecutar con: node --test tests/liquidacionNomina.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { liquidarEmpleado, calcularRetencion, resumenPlanilla, aMultiplo100 } = require('../public/contable/liquidacionNomina');

const SMMLV = 1750905;
const AUX = 249095;

function liquidar(contrato, extra) {
  return liquidarEmpleado(Object.assign({
    anio: 2026,
    mes: 10,
    contrato: Object.assign({ fechaIngreso: '2025-01-01', salarioBase: SMMLV, claseRiesgo: 1 }, contrato),
  }, extra || {}));
}

test('Empleado con salario mínimo, mes completo', () => {
  const l = liquidar({});
  assert.equal(l.dias.trabajados, 30);
  assert.equal(l.totales.sueldo, SMMLV);
  assert.equal(l.totales.auxilio, AUX);
  assert.equal(l.totales.devengado, 2000000);
  assert.equal(l.aportes.empleado.salud, 70036);
  assert.equal(l.aportes.empleado.pension, 70036);
  assert.equal(l.totales.neto, 2000000 - 140072);
  assert.equal(l.retencion.valor, 0);
  // Empleador: exonerado de salud, SENA e ICBF (art. 114-1)
  assert.equal(l.aportes.exonerado, true);
  assert.equal(l.aportes.empleador.salud, 0);
  assert.equal(l.aportes.empleador.pension, 210109);
  assert.equal(l.aportes.empleador.caja, 70036);
  assert.equal(l.aportes.empleador.sena, 0);
  assert.equal(l.aportes.empleador.icbf, 0);
  assert.equal(l.aportes.empleador.arl, 9140); // 0,522 % de 1.750.905
  // El auxilio no hace parte del IBC
  assert.equal(l.ibc.total, SMMLV);
});

test('Provisiones mensuales del empleado de mínimo', () => {
  const p = liquidar({}).provisiones;
  assert.equal(p.baseCesantias, 2000000, 'cesantías y prima incluyen el auxilio de transporte');
  assert.equal(p.cesantias, 166667);
  assert.equal(p.intereses, 20000);
  assert.equal(p.prima, 166667);
  assert.equal(p.baseVacaciones, SMMLV, 'vacaciones no incluyen el auxilio');
  assert.equal(p.vacaciones, 72954);
  assert.equal(p.total, 166667 + 20000 + 166667 + 72954);
});

test('Sin exoneración, el empleador paga salud, SENA e ICBF', () => {
  const l = liquidar({}, { empresa: { exoneraArt114: false } });
  assert.equal(l.aportes.empleador.salud, 148827); // 8,5 % de 1.750.905
  assert.equal(l.aportes.empleador.sena, 35018);
  assert.equal(l.aportes.empleador.icbf, 52527);
});

test('Quien devenga 10 SMMLV o más no está exonerado', () => {
  const l = liquidar({ salarioBase: 10 * SMMLV });
  assert.equal(l.aportes.exonerado, false);
  assert.equal(l.aportes.empleador.salud, Math.round(10 * SMMLV * 0.085));
  assert.equal(l.totales.auxilio, 0, 'más de 2 SMMLV: sin auxilio');
});

test('Ingreso a mitad de mes: 15 días, IBC mínimo proporcional y novedad ING', () => {
  const l = liquidar({ fechaIngreso: '2026-10-16' });
  assert.equal(l.dias.contrato, 15);
  assert.equal(l.totales.sueldo, 875453);
  assert.equal(l.totales.auxilio, 124548);
  assert.equal(l.pila.diasSalud, 15);
  assert.equal(l.ibc.total, 875453);
  assert.equal(l.pila.ingreso, true);
  assert.deepEqual(l.pila.novedades.map((n) => n.codigo), ['ING']);
});

test('Retiro a mitad de mes: días hasta la terminación y novedad RET', () => {
  const l = liquidar({ fechaTerminacion: '2026-10-10' });
  assert.equal(l.dias.contrato, 10);
  assert.equal(l.pila.retiro, true);
  assert.equal(l.pila.novedades.at(-1).codigo, 'RET');
});

test('Febrero completo también son 30 días', () => {
  const l = liquidarEmpleado({ anio: 2026, mes: 2, contrato: { fechaIngreso: '2025-01-01', salarioBase: SMMLV } });
  assert.equal(l.dias.trabajados, 30);
  assert.equal(l.totales.sueldo, SMMLV);
});

test('Vacaciones: se pagan al salario, no llevan auxilio y entran al IBC', () => {
  const l = liquidar({ salarioBase: 3000000 }, { ausencias: [{ tipo: 'vacaciones', desde: '2026-10-01', hasta: '2026-10-15' }] });
  assert.equal(l.dias.vacaciones, 15);
  assert.equal(l.dias.trabajados, 15);
  assert.equal(l.totales.sueldo, 1500000);
  assert.equal(l.totales.vacaciones, 1500000);
  assert.equal(l.totales.auxilio, 124548, 'auxilio solo por los 15 días trabajados');
  assert.equal(l.ibc.total, 3000000);
  assert.equal(l.pila.novedades[0].codigo, 'VAC');
  assert.equal(l.pila.diasArl, 30);
});

test('Incapacidad general de 5 días: 66,67 %, 2 días a cargo del empleador y 3 de la EPS', () => {
  const l = liquidar({ salarioBase: 3000000 }, { ausencias: [{ tipo: 'incapacidad_general', desde: '2026-10-06', hasta: '2026-10-10' }] });
  assert.equal(l.incapacidades.pagoEmpleador, 133340);
  assert.equal(l.incapacidades.porCobrarEps, 200010);
  assert.equal(l.totales.incapacidadesYLicencias, 333350);
  assert.equal(l.dias.trabajados, 25);
  assert.equal(l.totales.sueldo, 2500000);
  assert.equal(l.totales.auxilio, Math.round((AUX * 25) / 30));
  // La seguridad social se paga sobre el 100 % del salario
  assert.equal(l.ibc.total, 3000000);
  assert.equal(l.pila.novedades[0].codigo, 'IGE');
  assert.equal(l.pila.diasArl, 25, 'sin ARL en los días de incapacidad');
});

test('Incapacidad con salario mínimo se paga al 100 % (piso de 1 SMMLV diario)', () => {
  const l = liquidar({}, { ausencias: [{ tipo: 'incapacidad_general', desde: '2026-10-01', hasta: '2026-10-04' }] });
  assert.equal(l.totales.incapacidadesYLicencias, Math.round((SMMLV / 30) * 4));
});

test('Incapacidad prorrogada: el tramo depende de los días previos', () => {
  const l = liquidar({ salarioBase: 3000000 }, { ausencias: [{ tipo: 'incapacidad_general', desde: '2026-10-01', hasta: '2026-10-03', diasPrevios: 89 }] });
  // día 90 (66,67 %), 91 y 92 (50 %)
  // el 50 % (50.000) queda por debajo del piso de 1 SMMLV diario (58.363,5), que es lo que se paga
  assert.equal(l.incapacidades.porCobrarEps, Math.round(66670 + 2 * (SMMLV / 30)));
  assert.equal(l.incapacidades.pagoEmpleador, 0);
});

test('Licencia de maternidad: 100 % a cargo de la EPS y sin retención sobre ese pago', () => {
  const l = liquidar({ salarioBase: 3000000 }, { ausencias: [{ tipo: 'licencia_maternidad', desde: '2026-10-01', hasta: '2026-10-30' }] });
  assert.equal(l.incapacidades.porCobrarEps, 3000000);
  assert.equal(l.totales.sueldo, 0);
  assert.equal(l.aportes.empleado.salud, 120000);
  assert.equal(l.retencion.ingresos, 0);
});

test('Licencia no remunerada: sin sueldo, sin aportes por esos días y novedad SLN', () => {
  const l = liquidar({ salarioBase: 3000000 }, { ausencias: [{ tipo: 'licencia_no_remunerada', desde: '2026-10-21', hasta: '2026-10-30' }] });
  assert.equal(l.dias.noRemunerados, 10);
  assert.equal(l.dias.cotizados, 20);
  assert.equal(l.totales.sueldo, 2000000);
  assert.equal(l.ibc.total, 2000000);
  assert.equal(l.pila.novedades[0].codigo, 'SLN');
});

test('Dos ausencias que se cruzan generan error', () => {
  assert.throws(() => liquidar({}, { ausencias: [
    { tipo: 'vacaciones', desde: '2026-10-01', hasta: '2026-10-10' },
    { tipo: 'incapacidad_general', desde: '2026-10-08', hasta: '2026-10-12' },
  ] }), /se cruzan/);
});

test('Horas extras y recargos: valor de la hora con la jornada de 42 h', () => {
  const l = liquidar({ salarioBase: 2100000 }, { conceptos: [
    { codigo: 'hed', cantidad: 10 }, // 2.100.000 / 210 = 10.000 por hora; ×1,25
    { codigo: 'rdf', cantidad: 8 }, // recargo festivo 90 % (octubre de 2026)
    { codigo: 'rn', cantidad: 20 }, // 35 %
    { codigo: 'hedf', cantidad: 2 }, // 125 % + 90 %
  ] });
  const v = (c) => l.devengos.find((d) => d.codigo === c).valor;
  assert.equal(v('hed'), 125000);
  assert.equal(v('rdf'), 72000);
  assert.equal(v('rn'), 70000);
  assert.equal(v('hedf'), 43000);
  assert.equal(l.totales.horasExtrasYRecargos, 125000 + 43000, 'solo las extras (no los recargos) salen de la base de vacaciones');
  assert.equal(l.provisiones.baseVacaciones, 2100000 + 72000 + 70000);
  assert.equal(l.ibc.total, 2100000 + 125000 + 72000 + 70000 + 43000);
});

test('Comisiones y bonificaciones salariales entran al IBC y a las prestaciones', () => {
  const l = liquidar({ salarioBase: 2000000 }, { conceptos: [{ codigo: 'comision', valor: 500000 }] });
  assert.equal(l.ibc.total, 2500000);
  assert.equal(l.provisiones.baseCesantias, 2500000 + AUX);
});

test('Pagos no salariales: lo que pasa del 40 % de la remuneración entra al IBC', () => {
  const l = liquidar({ salarioBase: 2000000 }, { conceptos: [{ codigo: 'auxilio_no_salarial', valor: 2000000 }] });
  // total 4.000.000; 40 % = 1.600.000; exceso 400.000
  assert.equal(l.ibc.exceso40, 400000);
  assert.equal(l.ibc.total, 2400000);
  assert.ok(l.advertencias.some((a) => /40 %/.test(a)));
  // no entra a las prestaciones
  assert.equal(l.provisiones.baseCesantias, 2000000 + AUX);
});

test('Pagos no salariales por debajo del 40 % no cambian el IBC', () => {
  const l = liquidar({ salarioBase: 3000000 }, { conceptos: [{ codigo: 'bonificacion_no_salarial', valor: 500000 }] });
  assert.equal(l.ibc.exceso40, 0);
  assert.equal(l.ibc.total, 3000000);
});

test('IBC máximo de 25 SMMLV y fondo de solidaridad de 2 %', () => {
  const l = liquidar({ salarioBase: 50000000 });
  assert.equal(l.ibc.total, Math.round(25 * SMMLV));
  assert.equal(l.aportes.fspTarifa, 0.02);
  assert.equal(l.aportes.empleado.fspSolidaridad, Math.round(25 * SMMLV * 0.01));
  assert.equal(l.aportes.empleado.fspSubsistencia, Math.round(25 * SMMLV * 0.02) - Math.round(25 * SMMLV * 0.01));
});

test('Fondo de solidaridad desde 4 SMMLV: 1 %', () => {
  const l = liquidar({ salarioBase: 4 * SMMLV });
  assert.equal(l.aportes.fspTarifa, 0.01);
  assert.equal(l.aportes.empleado.fsp, Math.round(4 * SMMLV * 0.01));
  const justoAbajo = liquidar({ salarioBase: 4 * SMMLV - 1000 });
  assert.equal(justoAbajo.aportes.empleado.fsp, 0);
});

test('Salario integral: IBC del 70 %, sin cesantías ni prima, sin exoneración', () => {
  const l = liquidar({ salarioBase: 25000000, tipoSalario: 'integral' });
  assert.equal(l.ibc.total, 17500000);
  assert.equal(l.totales.auxilio, 0);
  assert.equal(l.aportes.exonerado, false);
  assert.equal(l.aportes.empleador.salud, 1487500);
  assert.equal(l.aportes.empleador.sena, 350000);
  assert.equal(l.aportes.empleador.icbf, 525000);
  assert.equal(l.provisiones.cesantias, 0);
  assert.equal(l.provisiones.prima, 0);
  assert.equal(l.provisiones.intereses, 0);
  assert.equal(l.provisiones.vacaciones, Math.round(25000000 / 24));
});

test('Salario integral menor a 13 SMMLV genera advertencia', () => {
  const l = liquidar({ salarioBase: 12 * SMMLV, tipoSalario: 'integral' });
  assert.ok(l.advertencias.some((a) => /13 SMMLV/.test(a)));
});

test('El riesgo ARL cambia la tarifa', () => {
  const l = liquidar({ claseRiesgo: 5 });
  assert.equal(l.aportes.empleador.arl, Math.round(SMMLV * 0.0696));
});

test('Auxilio de transporte: no, sí forzado y conectividad', () => {
  assert.equal(liquidar({ auxilioTransporte: 'no' }).totales.auxilio, 0);
  const forzado = liquidar({ salarioBase: 5000000, auxilioTransporte: 'si' });
  assert.equal(forzado.totales.auxilio, AUX);
  assert.ok(forzado.advertencias.some((a) => /2 SMMLV/.test(a)));
  const conectividad = liquidar({ tipoAuxilio: 'conectividad' });
  assert.equal(conectividad.devengos.find((d) => d.auxilio).codigo, 'auxilio_conectividad');
});

test('Descuentos: préstamo y libranza bajan el neto', () => {
  const l = liquidar({ salarioBase: 3000000 }, { descuentos: [{ codigo: 'prestamo', valor: 200000 }, { codigo: 'libranza', valor: 150000 }] });
  assert.equal(l.deducciones.find((d) => d.codigo === 'prestamo').cuenta, '1365');
  const base = liquidar({ salarioBase: 3000000 });
  assert.equal(l.totales.neto, base.totales.neto - 350000);
});

test('Descuentos que superan lo devengado dejan advertencia de neto negativo', () => {
  const l = liquidar({}, { descuentos: [{ codigo: 'embargo', valor: 5000000 }] });
  assert.ok(l.totales.neto < 0);
  assert.ok(l.advertencias.some((a) => /negativo/.test(a)));
});

test('Retención en la fuente: cálculo con el art. 383 y renta exenta del 25 %', () => {
  const r = calcularRetencion({ anio: 2026, ingresos: 10000000, aportesObligatorios: 800000 });
  // neto 9.200.000; renta exenta 25 % = 2.300.000; base gravable 6.900.000 = 131,74 UVT
  assert.equal(r.ingresoNeto, 9200000);
  assert.equal(r.rentaExenta25, 2300000);
  assert.equal(r.baseGravable, 6900000);
  assert.equal(r.baseUvt, 131.74);
  assert.equal(r.valor, 366000); // (131,74 − 95) × 19 % × 52.374 = 365.656 → 366.000
});

test('Retención: por debajo de 95 UVT no se retiene', () => {
  const r = calcularRetencion({ anio: 2026, ingresos: 5000000, aportesObligatorios: 400000 });
  assert.equal(r.valor, 0);
});

test('Retención: dependientes, medicina prepagada e intereses de vivienda bajan la base', () => {
  const sin = calcularRetencion({ anio: 2026, ingresos: 12000000, aportesObligatorios: 960000 });
  const con = calcularRetencion({ anio: 2026, ingresos: 12000000, aportesObligatorios: 960000, dependientes: true, medicinaPrepagada: 500000, interesesVivienda: 1000000 });
  assert.ok(con.valor < sin.valor);
  assert.equal(con.dependientes, 1200000);
  assert.equal(con.medicinaPrepagada, 500000);
  assert.equal(con.vivienda, 1000000);
});

test('Retención: la renta exenta del 25 % se topa en 790 UVT al año', () => {
  const r = calcularRetencion({ anio: 2026, ingresos: 60000000, aportesObligatorios: 3000000 });
  assert.equal(r.rentaExenta25, Math.round((790 * 52374) / 12));
});

test('Retención: deducciones y rentas exentas juntas no pasan de 1.340 UVT al año', () => {
  const r = calcularRetencion({ anio: 2026, ingresos: 60000000, aportesObligatorios: 3000000, interesesVivienda: 9000000, medicinaPrepagada: 2000000 });
  assert.equal(r.vivienda, 100 * 52374, 'intereses de vivienda: tope de 100 UVT al mes');
  assert.equal(r.medicinaPrepagada, 16 * 52374, 'medicina prepagada: tope de 16 UVT al mes');
  assert.equal(r.limite, Math.round((1340 * 52374) / 12));
  assert.equal(r.beneficiosAplicados, r.limite);
});

test('Retención automática en la liquidación y manual', () => {
  const auto = liquidar({ salarioBase: 10000000 });
  assert.ok(auto.retencion.valor > 0);
  assert.equal(auto.deducciones.find((d) => d.codigo === 'retencion_fuente').valor, auto.retencion.valor);
  const manual = liquidar({ salarioBase: 10000000, retencionFuente: 'manual', retencionManual: 123000 });
  assert.equal(manual.retencion.valor, 123000);
  const ninguna = liquidar({ salarioBase: 10000000, retencionFuente: 'no_aplica' });
  assert.equal(ninguna.retencion.valor, 0);
});

test('Año sin parámetros avisa que se usaron los del último año', () => {
  const l = liquidarEmpleado({ anio: 2030, mes: 1, contrato: { fechaIngreso: '2029-01-01', salarioBase: SMMLV } });
  assert.ok(l.advertencias.some((a) => /No hay parámetros cargados para 2030/.test(a)));
});

test('Contrato inválido: sin salario, ingreso futuro o terminado', () => {
  assert.throws(() => liquidar({ salarioBase: 0 }), /no tiene salario/);
  assert.throws(() => liquidar({ fechaIngreso: '2026-11-01' }), /ingresó después/);
  assert.throws(() => liquidar({ fechaTerminacion: '2026-09-30' }), /terminó antes/);
});

test('Neto = devengado − deducciones, y todo en pesos enteros', () => {
  const l = liquidar({ salarioBase: 4321987 }, { conceptos: [{ codigo: 'hed', cantidad: 7 }, { codigo: 'comision', valor: 333333 }] });
  assert.equal(l.totales.neto, l.totales.devengado - l.totales.deducciones);
  assert.equal(l.totales.devengado, l.devengos.reduce((s, d) => s + d.valor, 0));
  for (const d of [...l.devengos, ...l.deducciones]) assert.ok(Number.isInteger(d.valor), `${d.codigo} entero`);
  for (const v of Object.values(l.provisiones)) assert.ok(Number.isInteger(v));
});

test('Planilla: cada aporte se aproxima al siguiente múltiplo de 100 (PILA)', () => {
  assert.equal(aMultiplo100(70036), 70100);
  assert.equal(aMultiplo100(70100), 70100);
  assert.equal(aMultiplo100(0), 0);
  const l = liquidar({});
  const res = resumenPlanilla([{
    empleado: { id: 'e1', nombre: 'Ana', identificacion: '1' },
    entidades: { eps: 'EPS1', epsNombre: 'Sanitas', afp: 'AFP1', afpNombre: 'Porvenir', arl: 'ARL1', arlNombre: 'Sura', ccf: 'CCF1', ccfNombre: 'Compensar' },
    liquidacion: l,
  }]);
  const fila = res.filas[0];
  assert.equal(fila.salud, 70100);
  assert.equal(fila.pension, 70100 + 210200);
  assert.equal(fila.arl, 9200);
  assert.equal(fila.caja, 70100);
  assert.equal(fila.pila, 70100 + 280300 + 9200 + 70100);
  assert.equal(res.totales.liquidado, l.aportes.totalSeguridadSocial);
  assert.equal(res.totales.ajusteAproximacion, res.totales.pila - res.totales.liquidado);
  const tipos = res.porEntidad.map((e) => e.tipo);
  assert.deepEqual(tipos, ['AFP', 'ARL', 'CCF', 'EPS']);
  assert.equal(res.porEntidad.find((e) => e.tipo === 'AFP').liquidado, 70036 + 210109);
});
