const test = require('node:test');
const assert = require('node:assert/strict');
const CA = require('../public/contable/cargueAsopagos');

const base = { tipoDocumento: 'CC', identificacion: '1234567', anio: 2017, mes: 4, dia: 1 };

// Cada caso es un ejemplo copiado del «Instructivo cargue masivo de novedades» de Asopagos.
test('novedad ING (ingreso normal) igual al ejemplo del instructivo', () => {
  const l = CA.lineaNovedad('ING', { ...base, mes: 8, salario: 800000, centroTrabajo: 1, tipoSalario: 'F', pagosNoSalariales: 415500, actividadEconomica: '1234567' });
  assert.equal(l, '1;CC;1234567;2017;08;01;800000;X;1;;;;;F;415500;1234567;');
});
test('ING de un contratista (59): sin tipo de salario ni pagos no salariales', () => {
  const l = CA.lineaNovedad('ING', { ...base, salario: 5000000, centroTrabajo: 3, actividadEconomica: '4711001' });
  assert.equal(l, '1;CC;1234567;2017;04;01;5000000;X;3;;;;;;;4711001;');
});
test('novedad RET', () => {
  assert.equal(CA.lineaNovedad('RET', { ...base, tipoRetiro: 'C' }), '2;CC;1234567;2017;04;01;C;');
  assert.equal(CA.lineaNovedad('RET', base), '2;CC;1234567;2017;04;01;N;');
  assert.throws(() => CA.lineaNovedad('RET', { ...base, tipoRetiro: 'T' }), /N, P, R o C/);
});
test('novedades VSP y VST', () => {
  assert.equal(CA.lineaNovedad('VSP', { ...base, variacion: 100000 }), '7;CC;1234567;2017;04;01;100000;');
  assert.equal(CA.lineaNovedad('VST', { ...base, variacion: 100000 }), '9;CC;1234567;2017;04;100000;');
});
test('novedad SLN', () => {
  const l = CA.lineaNovedad('SLN', { ...base, fechaFin: '2017-04-15', comisionServicios: 'S', porcentajeAporte: 'T', salarioAnterior: 100000, tarifaSalud: 0.085, tarifaPension: 0.12, dias: 15 });
  assert.equal(l, '10;CC;1234567;2017;04;01;2017-04-15;S;T;100000;0.085;0.12;15;');
});
test('novedad IGE con y sin ajuste de valor', () => {
  const d = { ...base, fechaFin: '2017-04-15', dias: 15, tarifaDosPrimerosDias: 1, tarifaDesdeTercerDia: 1 };
  assert.equal(CA.lineaNovedad('IGE', { ...d, ajustar: 'S', valor: 111114 }), '11;CC;1234567;2017;04;01;2017-04-15;1;1;S;111114;15;');
  assert.equal(CA.lineaNovedad('IGE', { ...d, ajustar: 'N' }), '11;CC;1234567;2017;04;01;2017-04-15;1;1;N;0;15;');
  assert.throws(() => CA.lineaNovedad('IGE', { ...d, tarifaDesdeTercerDia: 0.7 }), /1, 0.6666 o 0.5/);
});
test('novedad LMA, VAC e IRL', () => {
  assert.equal(CA.lineaNovedad('LMA', { ...base, fechaFin: '2017-04-15', dias: 15, ajustar: 'S', valor: 111114, tipoLma: 'X' }), '12;CC;1234567;2017;04;01;2017-04-15;15;S;111114;X;');
  assert.equal(CA.lineaNovedad('VAC', { ...base, fechaFin: '2017-04-15', salario: 800000, tipoNovedad: 'L', pagoAnticipado: 'S', dias: 15 }), '13;CC;1234567;2017;04;01;2017-04-15;800000;L;S;15;');
  assert.equal(CA.lineaNovedad('IRL', { ...base, fechaFin: '2017-04-15', dias: 15, ajustar: 'S', valor: 111114 }), '15;CC;1234567;2017;04;01;2017-04-15;15;S;111114;');
});
test('novedades AVP, VCT y cargues de ingresos y salarios', () => {
  assert.equal(CA.lineaNovedad('AVP', { ...base, aporteAportante: 150000, aporteAfiliado: 250000, valorNoRetenido: 5000 }), '14;CC;1234567;2017;04;150000;250000;5000;');
  assert.equal(CA.lineaNovedad('VCT', { ...base, centroTrabajo: 1, fechaFin: '2017-04-01', actividadEconomica: '1131201' }), '16;CC;1234567;2017;04;1;01;2017-04-01;1131201;');
  assert.equal(CA.lineaNovedad('OIP', { ...base, valor: 100000 }), '17;CC;1234567;2017;04;100000;');
  assert.equal(CA.lineaNovedad('IBC_PARAFISCALES', { ...base, ibc: 1000000 }), '19;CC;1234567;2017;04;1000000;');
  assert.equal(CA.lineaNovedad('SALARIO', { ...base, salario: 2780200 }), '20;CC;1234567;2780200;');
  assert.equal(CA.lineaNovedad('NO_SALARIAL', { ...base, anio: 2022, valor: 4155000 }), '21;CC;1234567;2022;04;4155000;');
});
test('validaciones de las novedades', () => {
  assert.throws(() => CA.lineaNovedad('RET', { ...base, dia: 31 }), /entre 1 y 30/);
  assert.throws(() => CA.lineaNovedad('RET', { ...base, mes: 13 }), /mes/);
  assert.throws(() => CA.lineaNovedad('RET', { ...base, tipoDocumento: 'XX' }), /Tipo de documento/);
  assert.throws(() => CA.lineaNovedad('VAC', { ...base, fechaFin: '2017-03-30', salario: 1, dias: 1 }), /anterior/);
  assert.throws(() => CA.lineaNovedad('VSP', { ...base, variacion: 1234567890 }), /9 dígitos/);
  assert.throws(() => CA.lineaNovedad('XXX', base), /desconocida/);
});

const contratista = {
  tipoDocumento: 'CC', identificacion: '52.111.222', nombre: 'Marcela Rojas Pérez', tipoCotizante: 59, subtipo: 0, tipoSalario: '',
  salarioBasico: 5000000, baseCotizacion: 2000000, codigoArl: '14-11_ARL SURA', centroTrabajo: 3, departamento: '11', municipio: '001',
  exonerado: false, epsCodigo: 'EPS005_SANITAS', afpCodigo: '230301', ccfCodigo: '', tarifaPension: 0.16, tarifaSalud: 0.125,
  tarifaSena: 0, tarifaIcbf: 0, tarifaCcf: 0, fechaIngreso: '2026-01-01', correo: 'marcela@correo.co', actividadEconomica: '6920001',
};

test('cargue de cotizantes: 41 columnas en el orden del modelo de Asopagos', () => {
  assert.equal(CA.COLUMNAS_COTIZANTE.length, 41);
  const { fila, avisos } = CA.filaCotizante(contratista);
  assert.equal(fila.length, 41);
  assert.deepEqual(avisos, []);
  const por = (titulo) => fila[CA.COLUMNAS_COTIZANTE.findIndex((c) => c.trim().startsWith(titulo))];
  assert.equal(por('Número de identificación'), '52111222');
  assert.equal(por('Primer apellido'), 'ROJAS');
  assert.equal(por('Segundo apellido'), 'PEREZ');
  assert.equal(por('Primer nombre'), 'MARCELA');
  assert.equal(por('Tipo de cotizante'), 59);
  assert.equal(por('Salario básico'), 5000000);
  assert.equal(por('Base de Cotización'), 2000000);
  assert.equal(por('Código de administradora'), '14-11');
  assert.equal(por('EPS'), 'EPS005');
  assert.equal(por('Caja de compensación'), 'SINCCF');
  assert.equal(por('Tarifa pensión'), '0.16');
  assert.equal(por('Tarifa salud'), '0.125');
  assert.equal(por('Tarifa Sena'), '0');
  assert.equal(por('Fecha de ingreso'), '2026-01-01');
  assert.equal(por('Indique código el soporte'), 0);
  assert.equal(por('Actividad económica'), '6920001');
});
test('cargue de cotizantes: avisa lo que falta', () => {
  const { avisos } = CA.filaCotizante({ ...contratista, codigoArl: '', epsCodigo: '', departamento: '', actividadEconomica: '', fechaIngreso: '', nombre: 'Marcela' });
  const t = avisos.join('\n');
  for (const r of [/ARL/, /EPS/, /departamento/, /actividad económica/, /fecha de ingreso/, /primer nombre y primer apellido/]) assert.match(t, r);
});
test('CSV de cotizantes: título + una fila por cotizante, separado por punto y coma', () => {
  const csv = CA.cotizantesCsv([CA.filaCotizante(contratista).fila]);
  const lineas = csv.replace('﻿', '').trim().split('\r\n');
  assert.equal(lineas.length, 2);
  assert.equal(lineas[0].split(';').length, 41);
  assert.equal(lineas[1].split(';').length, 41);
  assert.match(lineas[1], /^CC;52111222;ROJAS;PEREZ;MARCELA;;59;0;N;N;;5000000;2000000;;14-11;3;11;001;N;;EPS005;230301;SINCCF/);
});
test('novedadesTxt une las líneas con CRLF', () => {
  assert.equal(CA.novedadesTxt(['a;', 'b;']), 'a;\r\nb;\r\n');
  assert.equal(CA.novedadesTxt([]), '');
});
