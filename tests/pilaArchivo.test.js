// Ejecutar con: node --test tests/pilaArchivo.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const PILA = require('../public/contable/pilaArchivo');
const { liquidarEmpleado, resumenPlanilla } = require('../public/contable/liquidacionNomina');

const SMMLV = 1750905;

function liquidar(contrato, extra) {
  return liquidarEmpleado(Object.assign({
    anio: 2026, mes: 10,
    contrato: Object.assign({ fechaIngreso: '2025-01-01', salarioBase: SMMLV, claseRiesgo: 1 }, contrato),
  }, extra || {}));
}
const empleado = (nombre, id, liquidacion, extra) => Object.assign({
  nombre, identificacion: id, epsCodigo: 'EPS037', afpCodigo: '230301', salarioBase: liquidacion.pila ? 0 : 0, tipoSalario: 'ordinario', liquidacion,
}, extra || {});
const BASE = {
  aportante: { razonSocial: 'Libaniel Consulting S.A.S.', nit: '900123456-8' },
  periodo: { anio: 2026, mes: 10 },
  config: { arlCodigo: '14-23', ccfCodigo: 'CCF22', codigoDepartamento: '11', codigoMunicipio: '001', centroTrabajo: 1 },
};
const armar = (empleados, extra) => PILA.construirArchivo(Object.assign({}, BASE, { empleados }, extra || {}));
// Texto de un campo (posiciones del anexo, base 1)
const en = (linea, ini, fin) => linea.slice(ini - 1, fin);

test('Longitudes y posiciones iniciales de los campos según el Anexo Técnico 2', () => {
  assert.equal(PILA.LONGITUD_ENCABEZADO, 359);
  assert.equal(PILA.LONGITUD_COTIZANTE, 686);
  assert.equal(PILA.COTIZANTE.length, 97);
  const ini = (defs) => { let p = 1; const m = {}; for (const c of defs) { m[c.n] = p; p += c.l; } return m; };
  const e = ini(PILA.ENCABEZADO);
  const c = ini(PILA.COTIZANTE);
  // Posiciones iniciales publicadas en el anexo
  assert.deepEqual([e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], e[12], e[13], e[14], e[15], e[16], e[17], e[18], e[19], e[20], e[21], e[22]],
    [8, 208, 210, 226, 227, 228, 238, 248, 249, 259, 299, 305, 312, 319, 329, 339, 344, 356, 358]);
  assert.deepEqual([c[3], c[4], c[5], c[9], c[11], c[15], c[30], c[31], c[36], c[40], c[41], c[42], c[46], c[47], c[54], c[57], c[61], c[63], c[64], c[74], c[76], c[77], c[80], c[89], c[94], c[95], c[96], c[97]],
    [8, 10, 26, 32, 37, 137, 152, 154, 184, 192, 201, 202, 238, 245, 308, 333, 381, 399, 408, 488, 506, 507, 515, 605, 655, 665, 674, 677]);
});

test('Formato: numéricos con ceros a la izquierda, alfanuméricos con espacios, tarifas con punto', () => {
  const d = (n) => PILA.COTIZANTE.find((x) => x.n === n);
  assert.equal(PILA.formatear(d(42), 1750905), '001750905');
  assert.equal(PILA.formatear(d(11), 'PEREZ'), 'PEREZ' + ' '.repeat(15));
  assert.equal(PILA.formatear(d(46), 0.16), '0.16000');
  assert.equal(PILA.formatear(d(61), 0.00522), '0.0052200');
  assert.throws(() => PILA.formatear(d(36), 100), /admite 2 dígitos/);
  assert.throws(() => PILA.formatear(d(11), 'X'.repeat(21)), /admite 20 caracteres/);
  assert.throws(() => PILA.formatear(d(42), -5), /positivo/);
});

test('Utilidades: dígito de verificación, nombres y NIT', () => {
  assert.equal(PILA.digitoVerificacion('800197268'), 4);
  assert.equal(PILA.digitoVerificacion('899999068'), 1);
  assert.deepEqual(PILA.separarNit('900.123.456-8'), { numero: '900123456', dv: 8, calculado: 8, informado: true });
  assert.equal(PILA.separarNit('900123456').dv, 8);
  assert.equal(PILA.limpiarNombre('Ñandú Pérez-Gómez'), 'NANDU PEREZ GOMEZ');
  assert.deepEqual(PILA.partirNombre('María Fernanda López Díaz'), { n1: 'MARIA', n2: 'FERNANDA', a1: 'LOPEZ', a2: 'DIAZ' });
  assert.deepEqual(PILA.partirNombre('Ana Pérez Gómez'), { n1: 'ANA', n2: '', a1: 'PEREZ', a2: 'GOMEZ' });
});

test('Empleado de mes completo: encabezado y un registro con las cotizaciones de la planilla', () => {
  const L = liquidar({});
  const r = armar([empleado('Ana Pérez Gómez', '1020304050', L, { salarioBase: SMMLV })]);
  const lineas = r.contenido.split('\r\n');
  assert.equal(lineas.length, 3, 'encabezado + 1 registro + salto final');
  assert.equal(lineas[2], '');
  const h = lineas[0];
  assert.equal(h.length, 359);
  assert.equal(en(h, 1, 2), '01');
  assert.equal(en(h, 3, 3), '1');
  assert.equal(en(h, 8, 207).trim(), 'LIBANIEL CONSULTING S A S');
  assert.equal(en(h, 208, 209), 'NI');
  assert.equal(en(h, 210, 225).trim(), '900123456');
  assert.equal(en(h, 226, 226), '8');
  assert.equal(en(h, 227, 227), 'E');
  assert.equal(en(h, 248, 248), 'U');
  assert.equal(en(h, 299, 304).trim(), '14-23');
  assert.equal(en(h, 305, 311), '2026-10');
  assert.equal(en(h, 312, 318), '2026-11');
  assert.equal(en(h, 339, 343), '00001');
  assert.equal(en(h, 344, 355), '000001750905');
  assert.equal(en(h, 356, 357), '01');
  const x = lineas[1];
  assert.equal(x.length, 686);
  assert.equal(en(x, 1, 2), '02');
  assert.equal(en(x, 3, 7), '00001');
  assert.equal(en(x, 8, 9), 'CC');
  assert.equal(en(x, 10, 25).trim(), '1020304050');
  assert.equal(en(x, 26, 27), '01');
  assert.equal(en(x, 32, 33), '11');
  assert.equal(en(x, 34, 36).trim(), '001');
  assert.equal(en(x, 37, 56).trim(), 'PEREZ');
  assert.equal(en(x, 57, 86).trim(), 'GOMEZ');
  assert.equal(en(x, 87, 106).trim(), 'ANA');
  assert.equal(en(x, 137, 149), ' '.repeat(13), 'sin novedades');
  assert.equal(en(x, 154, 159), '230301');
  assert.equal(en(x, 166, 171), 'EPS037');
  assert.equal(en(x, 178, 183), 'CCF22 ');
  assert.equal(en(x, 184, 191), '30303030');
  assert.equal(en(x, 192, 200), '001750905');
  assert.equal(en(x, 202, 210), '001750905');
  assert.equal(en(x, 238, 244), '0.16000');
  assert.equal(en(x, 245, 253), '000280300'); // 70.036 -> 70.100 y 210.109 -> 210.200 (cada parte al múltiplo de 100)
  assert.equal(en(x, 308, 314), '0.04000');
  assert.equal(en(x, 315, 323), '000070100');
  assert.equal(en(x, 381, 389), '0.0052200');
  assert.equal(en(x, 399, 407), '000009200');
  assert.equal(en(x, 408, 414), '0.04000');
  assert.equal(en(x, 415, 423), '000070100');
  assert.equal(en(x, 424, 430), '0.00000'); // exonerado
  assert.equal(en(x, 506, 506), 'S');
  assert.equal(en(x, 507, 512).trim(), '14-23');
  assert.equal(en(x, 513, 513), '1');
  assert.equal(en(x, 665, 673), '001750905');
  // Los totales del archivo son los de la planilla del sistema
  const resumen = resumenPlanilla([{ empleado: { id: 1 }, entidades: {}, liquidacion: L }]);
  assert.equal(r.totales.total, resumen.totales.pila);
});

test('Salario integral y sin exoneración: tarifas completas y marca de integral', () => {
  const L = liquidar({ salarioBase: 25000000, tipoSalario: 'integral' });
  const r = armar([empleado('Diana Torres Ruiz', '52333444', L, { salarioBase: 25000000, tipoSalario: 'integral' })]);
  const x = r.registros[0];
  assert.equal(en(x, 201, 201), 'X');
  assert.equal(en(x, 192, 200), '025000000');
  assert.equal(en(x, 506, 506), 'N', 'ganar 10 SMMLV o más no exonera');
  assert.equal(en(x, 308, 314), '0.12500');
  assert.equal(en(x, 424, 430), '0.02000');
  assert.equal(en(x, 440, 446), '0.03000');
  assert.equal(r.totales.total, resumenPlanilla([{ empleado: { id: 1 }, entidades: {}, liquidacion: L }]).totales.pila);
});

test('Ingreso y retiro en el mes: marcas y fechas, y menos de 30 días', () => {
  const L = liquidar({ fechaIngreso: '2026-10-11', fechaTerminacion: '2026-10-25' });
  const r = armar([empleado('Luis Mora Cano', '80123123', L, { salarioBase: SMMLV })]);
  const x = r.registros[0];
  assert.equal(en(x, 137, 138), 'XX');
  assert.equal(en(x, 184, 185), '15');
  assert.equal(en(x, 515, 524), '2026-10-11');
  assert.equal(en(x, 525, 534), '2026-10-25');
});

test('Vacaciones: una línea por la novedad y otra con los días ordinarios, sumando lo mismo que la planilla', () => {
  const L = liquidar({ salarioBase: 3000000 }, { ausencias: [{ tipo: 'vacaciones', desde: '2026-10-05', hasta: '2026-10-09' }] });
  const r = armar([empleado('Carlos Ruiz Soto', '79111222', L, { salarioBase: 3000000 })]);
  assert.equal(r.registros.length, 2);
  const [vac, ord] = r.registros;
  assert.equal(en(vac, 149, 149), 'X');
  assert.equal(en(vac, 605, 614), '2026-10-05');
  assert.equal(en(vac, 615, 624), '2026-10-09');
  assert.equal(en(vac, 184, 185), '05');
  assert.equal(en(ord, 149, 149), ' ');
  assert.equal(en(ord, 184, 185), '25');
  assert.equal(en(vac, 3, 7), '00001');
  assert.equal(en(ord, 3, 7), '00002');
  assert.equal(r.cotizantes, 1, 'un solo cotizante aunque tenga dos líneas');
  assert.equal(en(r.encabezado, 339, 343), '00001');
  const resumen = resumenPlanilla([{ empleado: { id: 1 }, entidades: {}, liquidacion: L }]);
  assert.equal(r.totales.total, resumen.totales.pila);
  const ibc = Number(en(vac, 202, 210)) + Number(en(ord, 202, 210));
  assert.equal(ibc, L.pila.ibcPension);
});

test('Incapacidad general y licencia no remunerada: marcas, fechas y días por línea', () => {
  const L = liquidar({ salarioBase: 3000000 }, { ausencias: [
    { tipo: 'incapacidad_general', desde: '2026-10-02', hasta: '2026-10-04' },
    { tipo: 'licencia_no_remunerada', desde: '2026-10-20', hasta: '2026-10-21' },
  ] });
  const r = armar([empleado('Marta Gil Ríos', '52111000', L, { salarioBase: 3000000 })]);
  assert.equal(r.registros.length, 3);
  const [ige, sln, ord] = r.registros;
  assert.equal(en(ige, 147, 147), 'X');
  assert.equal(en(ige, 565, 574), '2026-10-02');
  assert.equal(en(ige, 575, 584), '2026-10-04');
  assert.equal(en(sln, 146, 146), 'X');
  assert.equal(en(sln, 545, 554), '2026-10-20');
  assert.equal(en(sln, 555, 564), '2026-10-21');
  assert.equal(en(sln, 202, 210), '000000000', 'la suspensión no cotiza');
  assert.equal(en(ord, 184, 185), '25');
  assert.ok(r.avisos.some((a) => /suspensión/.test(a)));
  const dias = r.registros.reduce((s, x) => s + Number(en(x, 184, 185)), 0);
  assert.equal(dias, 30);
});

test('Incapacidad laboral (IRL): días en el campo 30 y en riesgos laborales', () => {
  const L = liquidar({}, { ausencias: [{ tipo: 'incapacidad_laboral', desde: '2026-10-10', hasta: '2026-10-14' }] });
  const r = armar([empleado('Pedro Soto Vela', '1010101010', L, { salarioBase: SMMLV })]);
  const irl = r.registros[0];
  assert.equal(en(irl, 152, 153), '05');
  assert.equal(en(irl, 188, 189), '05');
  assert.equal(en(irl, 645, 654), '2026-10-10');
  assert.equal(en(irl, 655, 664), '2026-10-14');
});

test('Varios empleados: secuencia, cotizantes únicos y valor de la nómina', () => {
  const L1 = liquidar({});
  const L2 = liquidar({ salarioBase: 4000000 });
  const r = armar([empleado('Ana Pérez Gómez', '1020304050', L1, { salarioBase: SMMLV }), empleado('Luis Mora Cano', '80123123', L2, { salarioBase: 4000000 })]);
  assert.equal(r.registros.length, 2);
  assert.equal(en(r.registros[1], 3, 7), '00002');
  assert.equal(en(r.encabezado, 339, 343), '00002');
  assert.equal(Number(en(r.encabezado, 344, 355)), L1.pila.ibcCcf + L2.pila.ibcCcf);
  assert.equal(r.nombre, 'PILA-E-2026-10.txt');
});

test('Datos que faltan: se listan todos juntos y no se genera el archivo', () => {
  const L = liquidar({});
  assert.throws(() => PILA.construirArchivo({
    aportante: { razonSocial: 'X S.A.S.', nit: '900123456-1' }, periodo: { anio: 2026, mes: 10 },
    config: { arlCodigo: '', ccfCodigo: 'CCF2233445', codigoDepartamento: '', codigoMunicipio: '12' },
    empleados: [{ nombre: 'Solo', identificacion: '12A', epsCodigo: '', afpCodigo: 'AFPMUYLARGO', liquidacion: L }],
  }), (err) => {
    assert.ok(Array.isArray(err.faltantes));
    const t = err.faltantes.join('\n');
    for (const re of [/dígito de verificación/, /departamento/, /municipio/, /código de la ARL/, /caja de compensación admite máximo 6/, /primer nombre y primer apellido/, /numérica/, /código de la EPS/, /fondo de pensiones admite máximo 6/]) assert.match(t, re);
    return true;
  });
});

test('Línea de un empleado sin novedades: IBC mensual con ceros a la izquierda y sin campos desbordados', () => {
  const L = liquidar({ salarioBase: 12345678 });
  const r = armar([empleado('Juan Pablo Martínez de la Torre Quintero', '1234567', L, { salarioBase: 12345678 })]);
  assert.equal(r.registros[0].length, 686);
  assert.equal(en(r.registros[0], 37, 56).trim(), 'MARTINEZ');
  assert.equal(en(r.registros[0], 57, 86).trim(), 'DE LA TORRE QUINTERO'.slice(0, 30));
});
