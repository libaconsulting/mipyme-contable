// Ejecutar con: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const calcularOrden = require('../public/contable/calculoOrden');
const cat = require('../public/contable/retencionesCatalogo');

// Línea de retención ya "especificada" a partir del catálogo.
const ret = (codigo, tarifa) => cat.especificar({ codigo, tarifa });

const item = (valorUnitario, extra = {}) => ({ concepto: 'x', cantidad: 1, valorUnitario, ...extra });

test('ODA-016-2026: servicios, IVA 19% y retención 2,5%', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(906807)],
    retencionModo: 'aplica',
    retenciones: [ret('RF-01')], // Compras generales (declarantes) 2,5%
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

test('Retención con AIU se calcula sobre subtotal + AIU, no sobre el IVA', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
    retencionModo: 'aplica',
    retenciones: [ret('RF-14')], // Servicios generales (declarantes) 4%
  });
  assert.equal(r.cabecera.retenciones[0].base, 1200000);
  assert.equal(r.cabecera.retencionValor, 48000); // 1.200.000 × 4%
  assert.equal(r.netoAPagar, 1380000); // 1.428.000 − 48.000
});

test('Retefuente + ReteIVA en la misma orden', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(906807)],
    retencionModo: 'aplica',
    retenciones: [ret('RF-14'), ret('RF-41')], // 4% sobre la base + 15% sobre el IVA
  });
  assert.equal(r.cabecera.retenciones[0].valor, 36272.28); // 906.807 × 4%
  assert.equal(r.cabecera.retenciones[1].base, 172293.33);
  assert.equal(r.cabecera.retenciones[1].valor, 25844); // 172.293,33 × 15%
  assert.equal(r.cabecera.retencionValor, 62116.28);
  assert.equal(r.netoAPagar, 1016984.05); // 1.079.100,33 − 62.116,28
});

test('Concepto sobre AIU (vigilancia y aseo) retiene solo sobre el AIU', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(10000000)],
    aplicaAiu: true,
    aiuAdministracion: 8,
    aiuImprevistos: 2,
    aiuUtilidad: 5,
    retencionModo: 'aplica',
    retenciones: [ret('RF-23')], // 2% sobre AIU
  });
  assert.equal(r.cabecera.aiuTotal, 1500000);
  assert.equal(r.cabecera.retenciones[0].base, 1500000);
  assert.equal(r.cabecera.retencionValor, 30000);
});

test('Concepto sobre AIU sin AIU discriminado: no retiene y avisa', () => {
  const r = calcularOrden(
    { tipo: 'servicios', items: [item(10000000)], retencionModo: 'aplica', retenciones: [ret('RF-23')] }
  );
  assert.equal(r.cabecera.retencionValor, 0);
  assert.match(r.cabecera.retenciones[0].nota, /AIU/);
});

test('Base por debajo del tope en UVT: la línea no retiene', () => {
  // Servicios: tope 2 UVT = 104.748. Base de 100.000 no lo alcanza.
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(100000)],
    retencionModo: 'aplica',
    retenciones: [ret('RF-14')],
  });
  const l = r.cabecera.retenciones[0];
  assert.equal(l.baseMinima, 104748);
  assert.equal(l.aplica, false);
  assert.equal(l.valor, 0);
  assert.match(l.nota, /tope/);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('Base exactamente en el tope sí retiene', () => {
  const r = calcularOrden({ tipo: 'servicios', items: [item(104748)], retencionModo: 'aplica', retenciones: [ret('RF-14')] });
  assert.equal(r.cabecera.retenciones[0].aplica, true);
});

test('Concepto sin tope (honorarios) retiene desde el primer peso', () => {
  const r = calcularOrden({ tipo: 'servicios', items: [item(10000)], retencionModo: 'aplica', retenciones: [ret('RF-32')] });
  assert.equal(r.cabecera.retencionValor, 1100); // 11%
});

test('"Otro concepto" usa la tarifa digitada', () => {
  const r = calcularOrden({ items: [item(1000000)], retencionModo: 'aplica', retenciones: [ret('OTRO', 3)] });
  assert.equal(r.cabecera.retencionValor, 30000);
  assert.throws(() => ret('OTRO', 0), /tarifa/);
});

test('Modo "aplica" sin líneas falla en estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(1000)], retencionModo: 'aplica', retenciones: [] }), /concepto de retención/);
});

test('Concepto desconocido falla al especificar', () => {
  assert.throws(() => cat.especificar({ codigo: 'RF-99' }), /no reconocido/);
});

test('Formulario a medias (modo aplica, línea vacía) se calcula en cero sin lanzar error', () => {
  const lineaVacia = cat.especificar({ codigo: '' }, { estricto: false });
  const r = calcularOrden(
    { items: [item(1000)], retencionModo: 'aplica', retenciones: [lineaVacia] },
    { estricto: false }
  );
  assert.equal(r.cabecera.retencionValor, 0);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('"No aplica retención" guarda el motivo y no retiene', () => {
  const r = calcularOrden({
    items: [item(5000000)],
    retencionModo: 'no_aplica',
    retencionMotivo: 'Proveedor en Régimen Simple de Tributación (RST)',
    retencionDetalle: 'Certificado RST 2026',
    retenciones: [ret('RF-01')], // se ignora
  });
  assert.equal(r.cabecera.retencionModo, 'no_aplica');
  assert.equal(r.cabecera.retencionMotivo, 'Proveedor en Régimen Simple de Tributación (RST)');
  assert.equal(r.cabecera.retenciones.length, 0);
  assert.equal(r.cabecera.retencionValor, 0);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('"No aplica retención" sin motivo falla en estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(1000)], retencionModo: 'no_aplica' }), /motivo/);
});

test('Sin retención (modo ninguna), el neto es igual al total', () => {
  const r = calcularOrden({ items: [item(1000)] });
  assert.equal(r.cabecera.retencionModo, 'ninguna');
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('Catálogo: 48 conceptos con tarifa válida y códigos únicos', () => {
  assert.equal(cat.CONCEPTOS.length, 48);
  assert.equal(new Set(cat.CONCEPTOS.map((c) => c.codigo)).size, 48);
  for (const c of cat.CONCEPTOS) assert.ok(c.tarifa > 0 && c.tarifa <= 100, c.codigo);
  assert.equal(cat.UVT_VALOR, 52374);
});

test('Valores negativos fallan en modo estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(-5)] }), /negativos/);
});
