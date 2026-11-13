const test = require('node:test');
const assert = require('node:assert/strict');
const { leerFacturaElectronica } = require('../src/integrations/dian/facturaElectronica');
const { construirNota, envolverAttachedDocument } = require('./helpers/facturaDian');
const { armarAsientoNota } = require('../public/contable/asientoNota');

const CUFE_FACTURA = 'a'.repeat(95) + '1';
const REF = { numero: 'SETP990000123', cufe: CUFE_FACTURA, fecha: '2026-10-05' };

// --- Lectura del XML -----------------------------------------------------------

test('nota crédito: se reconoce, con la factura que modifica y su motivo', () => {
  const { xml, total } = construirNota({ tipo: 'credito', referencia: REF, discrepancia: { codigo: 2, descripcion: 'Anulación de la factura' } });
  const d = leerFacturaElectronica(Buffer.from(xml));
  assert.equal(d.esNotaCredito, true);
  assert.equal(d.esNotaDebito, false);
  assert.equal(d.esFactura, false);
  assert.equal(d.tipoCodigo, '91');
  assert.equal(d.tipoOperacion, '20');
  assert.deepEqual(d.referencia, REF);
  assert.equal(d.discrepancia.codigo, '2');
  assert.equal(d.discrepancia.descripcion, 'Anulación de la factura');
  assert.equal(d.totales.conImpuestos, total);
  assert.equal(d.lineas.length, 2);
  assert.equal(d.lineas[1].cantidad, 2);
  assert.deepEqual(d.advertencias, []);
});

test('nota débito: usa RequestedMonetaryTotal y DebitedQuantity', () => {
  const { xml, total, iva } = construirNota({ tipo: 'debito', referencia: REF, discrepancia: { codigo: 1, descripcion: 'Intereses' } });
  const d = leerFacturaElectronica(Buffer.from(xml));
  assert.equal(d.esNotaDebito, true);
  assert.equal(d.tipoCodigo, '92');
  assert.equal(d.tipoOperacion, '30');
  assert.equal(d.totales.conImpuestos, total);
  assert.equal(d.totales.iva, iva);
  assert.equal(d.lineas[0].cantidad, 1);
});

test('nota sin referencia a factura: tipo de operación 22 y sin referencia', () => {
  const d = leerFacturaElectronica(Buffer.from(construirNota({ tipo: 'credito' }).xml));
  assert.equal(d.tipoOperacion, '22');
  assert.equal(d.referencia, null);
  assert.equal(d.discrepancia, null);
});

test('nota dentro de un AttachedDocument (como la entrega Siigo)', () => {
  const { xml } = construirNota({ tipo: 'credito', referencia: REF });
  const d = leerFacturaElectronica(Buffer.from(envolverAttachedDocument(xml)));
  assert.equal(d.esNotaCredito, true);
  assert.equal(d.vieneEnAdjunto, true);
  assert.equal(d.validacionDian.validada, true);
  assert.equal(d.referencia.numero, 'SETP990000123');
});

// --- Asiento de la nota -----------------------------------------------------------

const lineas = [{ valorTotal: 1000000, iva: 190000 }, { valorTotal: 500000, iva: 95000 }];
const base = { lineas, base: 1500000, iva: 285000, impoconsumo: 0, total: 1785000, ivaDescontable: true, cuentasLinea: ['5195', '5195'] };
const saldoCuenta = (asiento, codigo) => asiento.lineas.filter((l) => l.cuentaCodigo === codigo).reduce((s, l) => s + l.debito - l.credito, 0);

test('compra · nota crédito: es el espejo de la factura (Db proveedor, Cr gasto e IVA descontable)', () => {
  const a = armarAsientoNota({ lado: 'compra', tipo: 'credito', ...base });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '2205'), 1785000);
  assert.equal(saldoCuenta(a, '5195'), -1500000);
  assert.equal(saldoCuenta(a, '1355'), -285000);
  assert.equal(a.neto, 1785000);
});

test('compra · nota crédito: reversa la retención que se practicó con la factura', () => {
  const a = armarAsientoNota({ lado: 'compra', tipo: 'credito', ...base, reversa: { retefuente: 52500, reteiva: 42750 } });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '2365'), 52500); // débito: baja la retención por pagar
  assert.equal(saldoCuenta(a, '2367'), 42750);
  assert.equal(saldoCuenta(a, '2205'), 1785000 - 52500 - 42750);
  assert.equal(a.reversaTotal, 95250);
  assert.equal(a.neto, 1785000 - 95250);
});

test('compra · nota débito: el mismo asiento de una factura (Db gasto e IVA, Cr proveedor) y no reversa retenciones', () => {
  const a = armarAsientoNota({ lado: 'compra', tipo: 'debito', ...base, reversa: { retefuente: 99999 } });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '5195'), 1500000);
  assert.equal(saldoCuenta(a, '1355'), 285000);
  assert.equal(saldoCuenta(a, '2205'), -1785000);
  assert.equal(a.reversaTotal, 0);
});

test('compra · si la empresa no es responsable de IVA, el IVA va al gasto', () => {
  const a = armarAsientoNota({ lado: 'compra', tipo: 'credito', ...base, ivaDescontable: false });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '1355'), 0);
  assert.equal(saldoCuenta(a, '5195'), -1785000);
});

test('venta · nota crédito: Db ingreso e IVA por pagar, Cr clientes', () => {
  const a = armarAsientoNota({ lado: 'venta', tipo: 'credito', ...base, cuentasLinea: ['4135', '4175'] });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '1305'), -1785000);
  assert.equal(saldoCuenta(a, '4135'), 1000000);
  assert.equal(saldoCuenta(a, '4175'), 500000);
  assert.equal(saldoCuenta(a, '2408'), 285000);
});

test('venta · nota crédito: reversa retenciones y estampillas que el cliente había descontado', () => {
  const a = armarAsientoNota({
    lado: 'venta', tipo: 'credito', ...base, cuentasLinea: ['4135', '4135'],
    reversa: { retenciones: [{ cuentaCodigo: '135515', valor: 52500 }], descuentos: [{ cuentaCodigo: '5195', valor: 15000 }] },
  });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '135515'), -52500); // crédito: se reconoce de nuevo el anticipo que ya no existe
  assert.equal(saldoCuenta(a, '5195'), -15000);
  assert.equal(saldoCuenta(a, '1305'), -(1785000 - 52500 - 15000));
  assert.equal(a.reversaTotal, 67500);
  assert.equal(a.neto, 1785000 - 67500);
});

test('venta · nota débito: Db clientes, Cr ingreso e IVA por pagar', () => {
  const a = armarAsientoNota({ lado: 'venta', tipo: 'debito', ...base, cuentasLinea: ['4135', '4135'] });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '1305'), 1785000);
  assert.equal(saldoCuenta(a, '4135'), -1500000);
  assert.equal(saldoCuenta(a, '2408'), -285000);
});

test('el asiento cuadra aunque la base del XML difiera de las líneas por centavos', () => {
  const a = armarAsientoNota({
    lado: 'compra', tipo: 'credito', lineas: [{ valorTotal: 447058.82, iva: 84941.18 }, { valorTotal: 3058823.53, iva: 581176.47 }, { valorTotal: 260504.19, iva: 49495.81 }],
    base: 3766386.55, iva: 715613.45, impoconsumo: 0, total: 4482000, ivaDescontable: true, cuentasLinea: ['5195', '5195', '5195'],
  });
  assert.equal(a.cuadra, true);
  assert.equal(saldoCuenta(a, '2205'), 4482000);
});

test('rechaza lado o tipo inválidos y retenciones negativas', () => {
  assert.throws(() => armarAsientoNota({ lado: 'otro', tipo: 'credito', ...base }), /compra o de venta/);
  assert.throws(() => armarAsientoNota({ lado: 'compra', tipo: 'otro', ...base }), /crédito o débito/);
  assert.throws(() => armarAsientoNota({ lado: 'compra', tipo: 'credito', ...base, reversa: { retefuente: -1 } }), /negativas/);
});
