// Ejecutar con: node --test tests/parametrosLaborales.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const PL = require('../public/contable/parametrosLaborales');

test('Parámetros 2026: salario mínimo, auxilio y UVT', () => {
  const p = PL.parametros(2026);
  assert.equal(p.smmlv, 1750905);
  assert.equal(p.auxilioTransporte, 249095);
  assert.equal(p.uvt, 52374);
  assert.equal(p.estimado, false);
});

test('Un año sin parámetros usa el último conocido y lo avisa', () => {
  const p = PL.parametros(2030);
  assert.equal(p.estimado, true);
  assert.equal(p.smmlv, 1750905);
});

test('Festivos de Colombia 2026 (Ley Emiliani y Semana Santa)', () => {
  assert.deepEqual(PL.festivos(2026), [
    '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03', '2026-05-01', '2026-05-18',
    '2026-06-08', '2026-06-15', '2026-06-29', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12',
    '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25',
  ]);
  assert.equal(PL.pascua(2026), '2026-04-05');
  assert.equal(PL.esFestivo('2025-06-30'), true, 'San Pedro 2025 pasa del domingo 29 al lunes 30');
  assert.equal(PL.esDominicalOFestivo('2026-10-11'), true, 'domingo');
  assert.equal(PL.esDominicalOFestivo('2026-10-13'), false);
});

test('Recargo dominical y festivo sube por fechas (Ley 2466)', () => {
  assert.equal(PL.recargoDominicalFestivo('2025-06-30'), 0.75);
  assert.equal(PL.recargoDominicalFestivo('2025-07-01'), 0.8);
  assert.equal(PL.recargoDominicalFestivo('2026-06-30'), 0.8);
  assert.equal(PL.recargoDominicalFestivo('2026-07-01'), 0.9);
  assert.equal(PL.recargoDominicalFestivo('2027-07-01'), 1.0);
});

test('Jornada semanal baja por fechas (Ley 2101) y define las horas del mes', () => {
  assert.equal(PL.horasSemanales('2023-07-14'), 48);
  assert.equal(PL.horasSemanales('2024-07-15'), 46);
  assert.equal(PL.horasSemanales('2025-07-15'), 44);
  assert.equal(PL.horasSemanales('2026-07-15'), 42);
  assert.equal(PL.horasMensuales('2026-10-31'), 210);
  assert.equal(PL.horasMensuales('2025-08-31'), 220);
});

test('Días en base 30: todos los meses valen 30', () => {
  assert.equal(PL.dias360('2026-02-01', '2026-02-28'), 30);
  assert.equal(PL.dias360('2026-10-01', '2026-10-31'), 30);
  assert.equal(PL.dias360('2026-10-16', '2026-10-31'), 15);
  assert.equal(PL.dias360('2026-10-10', '2026-10-14'), 5);
});

test('Fondo de solidaridad pensional por rangos de SMMLV', () => {
  const s = 1000;
  assert.equal(PL.tarifaFsp(3.99 * s, s), 0);
  assert.equal(PL.tarifaFsp(4 * s, s), 0.01);
  assert.equal(PL.tarifaFsp(16 * s, s), 0.012);
  assert.equal(PL.tarifaFsp(19.5 * s, s), 0.018);
  assert.equal(PL.tarifaFsp(25 * s, s), 0.02);
});
