// Ejecutar con: node --test tests/facturaElectronica.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { leerFacturaElectronica } = require('../src/integrations/dian/facturaElectronica');
const xmlMini = require('../src/integrations/dian/xmlMini');
const { construirFactura, envolverAttachedDocument, crearZip, EMISOR, CUFE_EJEMPLO } = require('./helpers/facturaDian');

const buf = (s) => Buffer.from(s, 'utf8');

test('Factura directa: encabezado, partes y totales', () => {
  const { xml, base, iva, total } = construirFactura();
  const d = leerFacturaElectronica(buf(xml));
  assert.equal(d.esFactura, true);
  assert.equal(d.numero, 'SETP990000123');
  assert.equal(d.cufe, CUFE_EJEMPLO);
  assert.equal(d.fechaEmision, '2026-10-05');
  assert.equal(d.formaPago, 'contado');
  assert.equal(d.emisor.nit, '900555444');
  assert.equal(d.emisor.dv, '3');
  assert.equal(d.emisor.nombre, 'PROVEEDOR EJEMPLO S.A.S.');
  assert.equal(d.emisor.tipoPersona, 'juridica');
  assert.equal(d.emisor.email, 'facturacion@proveedor.test');
  assert.equal(d.emisor.municipio, 'Bogotá, D.C.');
  assert.equal(d.emisor.esRegimenSimple, true); // O-47 en las responsabilidades
  assert.equal(d.emisor.esAutorretenedor, true);
  assert.equal(d.receptor.nit, '900123456');
  assert.equal(d.totales.base, base);
  assert.equal(d.totales.iva, iva);
  assert.equal(d.totales.conImpuestos, total);
  assert.equal(d.totales.conImpuestos, 1785000);
  assert.deepEqual(d.notas, ['Factura de prueba & datos ficticios']);
  assert.deepEqual(d.advertencias, []);
});

test('Líneas: cantidad, valor, IVA y descripción', () => {
  const d = leerFacturaElectronica(buf(construirFactura().xml));
  assert.equal(d.lineas.length, 2);
  assert.equal(d.lineas[0].descripcion, 'Mantenimiento de equipos');
  assert.equal(d.lineas[0].valorTotal, 1000000);
  assert.equal(d.lineas[0].iva, 190000);
  assert.equal(d.lineas[0].ivaPorcentaje, 19);
  assert.equal(d.lineas[1].cantidad, 2);
  assert.equal(d.lineas[1].valorUnitario, 250000);
  assert.equal(d.lineas[1].valorTotal, 500000);
  assert.equal(d.lineas[1].unidad, 'EA');
});

test('Crédito: forma de pago y fecha de vencimiento', () => {
  const d = leerFacturaElectronica(buf(construirFactura({ credito: true }).xml));
  assert.equal(d.formaPago, 'credito');
  assert.equal(d.fechaVencimiento, '2026-11-04');
});

test('Impoconsumo (INC 8%) se separa del IVA', () => {
  const { xml } = construirFactura({
    lineas: [{ descripcion: 'Almuerzo ejecutivo', cantidad: 10, valorUnitario: 20000, ivaPct: 0, incPct: 8 }],
  });
  const d = leerFacturaElectronica(buf(xml));
  assert.equal(d.totales.iva, 0);
  assert.equal(d.totales.impoconsumo, 16000);
  assert.equal(d.totales.conImpuestos, 216000);
  assert.deepEqual(d.advertencias, []);
});

test('Descuento global: base = líneas - descuento', () => {
  const { xml } = construirFactura({ descuentoGlobal: 100000 });
  const d = leerFacturaElectronica(buf(xml));
  assert.equal(d.totales.lineas, 1500000);
  assert.equal(d.totales.base, 1400000);
  assert.equal(d.totales.descuentos, 100000);
});

test('Referencia a la orden de compra', () => {
  const d = leerFacturaElectronica(buf(construirFactura({ ordenRef: 'ODA-2026-0007' }).xml));
  assert.equal(d.ordenReferencia, 'ODA-2026-0007');
});

test('AttachedDocument: extrae la factura y la respuesta de la DIAN', () => {
  const { xml } = construirFactura();
  const d = leerFacturaElectronica(buf(envolverAttachedDocument(xml)));
  assert.equal(d.vieneEnAdjunto, true);
  assert.equal(d.numero, 'SETP990000123');
  assert.equal(d.validacionDian.disponible, true);
  assert.equal(d.validacionDian.validada, true);
  assert.equal(d.totales.conImpuestos, 1785000);
  assert.ok(d.xmlOriginal.includes('AttachedDocument'));
});

test('AttachedDocument con rechazo de la DIAN queda bloqueado', () => {
  const { xml } = construirFactura();
  const d = leerFacturaElectronica(buf(envolverAttachedDocument(xml, { validada: false })));
  assert.equal(d.validacionDian.validada, false);
  assert.ok(d.advertencias.some((a) => a.nivel === 'bloqueo' && /NO fue validado/.test(a.texto)));
});

test('ZIP con AttachedDocument y un PDF: toma el XML', () => {
  const { xml } = construirFactura();
  const zip = crearZip([
    { nombre: 'ad0900555444.xml', datos: envolverAttachedDocument(xml) },
    { nombre: 'factura.pdf', datos: Buffer.from('%PDF-1.4 falso') },
  ]);
  assert.ok(xmlMini.esZip(zip));
  const d = leerFacturaElectronica(zip);
  assert.equal(d.numero, 'SETP990000123');
  assert.equal(d.totales.iva, 285000);
});

test('ZIP con archivo sin comprimir', () => {
  const zip = crearZip([{ nombre: 'f.xml', datos: construirFactura().xml, sinComprimir: true }]);
  assert.equal(leerFacturaElectronica(zip).emisor.nit, '900555444');
});

test('ZIP dañado o vacío da un mensaje claro', () => {
  assert.throws(() => leerFacturaElectronica(Buffer.from('PK\x03\x04basura')), /ZIP/);
  assert.throws(() => leerFacturaElectronica(Buffer.alloc(0)), /vacío/);
});

test('Nota crédito se reconoce y no es "factura"', () => {
  const nc = construirFactura().xml.replace(/Invoice/g, 'CreditNote').replace(/CreditNoteLine/g, 'CreditNoteLine');
  // El constructor usa InvoiceLine/InvoicedQuantity; basta con que el raíz sea CreditNote.
  const d = leerFacturaElectronica(buf(nc));
  assert.equal(d.esFactura, false);
  assert.equal(d.elementoRaiz, 'CreditNote');
});

test('Un XML que no es factura se rechaza', () => {
  assert.throws(() => leerFacturaElectronica(buf('<Otro><a/></Otro>')), /no es una factura/);
  assert.throws(() => leerFacturaElectronica(buf('esto no es xml')), /XML/);
});

test('DOCTYPE/ENTITY se rechaza (seguridad)', () => {
  const malo = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Invoice><ID>&a;</ID></Invoice>';
  assert.throws(() => leerFacturaElectronica(buf(malo)), /DOCTYPE/);
});

test('Incoherencias del XML generan advertencias', () => {
  let { xml } = construirFactura();
  xml = xml.replace(/<cbc:TaxInclusiveAmount currencyID="COP">[\d.]+/, '<cbc:TaxInclusiveAmount currencyID="COP">1999999.00');
  const d = leerFacturaElectronica(buf(xml));
  assert.ok(d.advertencias.some((a) => a.nivel === 'confirmar' && /Base \+ impuestos/.test(a.texto)));
});

test('CUFE faltante o mal formado', () => {
  const sin = construirFactura({ cufe: '' }).xml;
  assert.ok(leerFacturaElectronica(buf(sin)).advertencias.some((a) => a.nivel === 'bloqueo' && /CUFE/.test(a.texto)));
  const corto = construirFactura({ cufe: 'abc123' }).xml;
  assert.ok(leerFacturaElectronica(buf(corto)).advertencias.some((a) => a.nivel === 'confirmar' && /CUFE/.test(a.texto)));
});

test('Moneda distinta de COP bloquea', () => {
  const d = leerFacturaElectronica(buf(construirFactura({ moneda: 'USD' }).xml));
  assert.ok(d.advertencias.some((a) => a.nivel === 'bloqueo' && /USD/.test(a.texto)));
});

test('Proveedor responsable de IVA (O-48) sin régimen simple', () => {
  const emisor = { ...EMISOR, responsabilidades: 'O-48' };
  const d = leerFacturaElectronica(buf(construirFactura({ emisor }).xml));
  assert.equal(d.emisor.regimenIva, 'responsable');
  assert.equal(d.emisor.esRegimenSimple, false);
});

test('Codificación ISO-8859-1 declarada', () => {
  const { xml } = construirFactura({ lineas: [{ descripcion: 'Reparación', cantidad: 1, valorUnitario: 100000 }] });
  const latin = Buffer.from(xml.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), 'latin1');
  assert.equal(leerFacturaElectronica(latin).lineas[0].descripcion, 'Reparación');
});

test('Lector XML: entidades, CDATA y espacios de nombres', () => {
  const r = xmlMini.parsearXml('<a:R xmlns:a="u"><a:B x="1&amp;2">h&#233;&lt;</a:B><a:C><![CDATA[<z/>]]></a:C></a:R>');
  assert.equal(xmlMini.texto(r, 'B'), 'hé<');
  assert.equal(xmlMini.atributo(r, 'B', 'x'), '1&2');
  assert.equal(xmlMini.texto(r, 'C'), '<z/>');
});
