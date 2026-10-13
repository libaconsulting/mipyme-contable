// Ejecutar con: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const calcularOrden = require('../public/contable/calculoOrden');

const item = (valorUnitario, extra = {}) => ({ concepto: 'x', cantidad: 1, valorUnitario, ...extra });

test('ODA-016-2026: servicios, IVA 19% y retención 2,5%', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(906807)],
    aplicaRetencion: true,
    retencionPorcentaje: 2.5,
  });
  assert.equal(r.cabecera.subtotal, 906807);
  assert.equal(r.cabecera.iva, 172293.33);
  assert.equal(r.cabecera.total, 1079100.33);
  assert.equal(r.cabecera.retencionValor, 22670.18);
  assert.equal(r.netoAPagar, 1056430.15);
});

test('AIU 10/5/5 sobre 1.000.000 con IVA sobre el total', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
  });
  assert.equal(r.cabecera.aiuAdministracionValor, 100000);
  assert.equal(r.cabecera.aiuImprevistosValor, 50000);
  assert.equal(r.cabecera.aiuUtilidadValor, 50000);
  assert.equal(r.cabecera.base, 1200000);
  assert.equal(r.cabecera.iva, 228000);
  assert.equal(r.cabecera.total, 1428000);
});

test('AIU con IVA solo sobre la utilidad', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
    aiuBaseIva: 'utilidad',
  });
  assert.equal(r.cabecera.iva, 9500);
  assert.equal(r.cabecera.total, 1209500);
});

test('AIU se ignora en órdenes de bienes', () => {
  const r = calcularOrden({
    tipo: 'bienes',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
  });
  assert.equal(r.cabecera.aplicaAiu, false);
  assert.equal(r.cabecera.base, 1000000);
  assert.equal(r.cabecera.iva, 190000);
  assert.equal(r.cabecera.total, 1190000);
});

test('IVA, Impoconsumo y exento mezclados', () => {
  const r = calcularOrden({
    tipo: 'bienes',
    items: [
      item(100000, { tipoImpuesto: 'iva', impuestoPorcentaje: 19 }),
      item(100000, { tipoImpuesto: 'impoconsumo', impuestoPorcentaje: 8 }),
      item(50000, { tipoImpuesto: 'exento' }),
    ],
  });
  assert.equal(r.cabecera.subtotal, 250000);
  assert.equal(r.cabecera.iva, 19000);
  assert.equal(r.cabecera.impoconsumo, 8000);
  assert.equal(r.cabecera.total, 277000);
});

test('Retención sin porcentaje falla en modo estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(1000)], aplicaRetencion: true }), /retención/);
  assert.throws(
    () => calcularOrden({ items: [item(1000)], aplicaRetencion: true, retencionPorcentaje: 101 }),
    /retención/
  );
});

test('Retención sin porcentaje, en modo formulario, se calcula en cero', () => {
  const r = calcularOrden({ items: [item(1000)], aplicaRetencion: true }, { estricto: false });
  assert.equal(r.cabecera.retencionValor, 0);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('Retención con AIU se calcula sobre subtotal + AIU, no sobre el IVA', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
    aplicaRetencion: true,
    retencionPorcentaje: 4,
  });
  assert.equal(r.cabecera.retencionValor, 48000); // 1.200.000 × 4%
  assert.equal(r.netoAPagar, 1380000); // 1.428.000 − 48.000
});

test('Sin retención, el neto es igual al total', () => {
  const r = calcularOrden({ items: [item(1000)] });
  assert.equal(r.cabecera.aplicaRetencion, false);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('Valores negativos fallan en modo estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(-5)] }), /negativos/);
});
