// Genera XML de factura electrónica DIAN (UBL 2.1) de PRUEBA, con la misma
// estructura de nombres y espacios de nombres que usan los proveedores
// tecnológicos. Los datos (NIT, nombres, CUFE) son inventados.
const zlib = require('zlib');

const redondear = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const f = (n) => redondear(n).toFixed(2);

const CUFE_EJEMPLO = 'a'.repeat(95) + '1';

const EMISOR = {
  nit: '900555444',
  dv: '3',
  nombre: 'PROVEEDOR EJEMPLO S.A.S.',
  comercial: 'Proveedor Ejemplo',
  responsabilidades: 'O-13;O-15;O-23;O-47',
  tipoPersona: '1',
  email: 'facturacion@proveedor.test',
  telefono: '3001234567',
  direccion: 'CL 10 # 20-30',
  ciudad: 'Bogotá, D.C.',
  departamento: 'Bogotá',
};
const COMPRADOR = {
  nit: '900123456',
  dv: '1',
  nombre: 'Empresa de prueba S.A.S.',
  responsabilidades: 'O-13;O-15',
  tipoPersona: '1',
};

function parteXml(tag, p) {
  return `
  <cac:${tag}>
    <cbc:AdditionalAccountID>${p.tipoPersona || '1'}</cbc:AdditionalAccountID>
    <cac:Party>
      <cac:PartyName><cbc:Name>${p.comercial || p.nombre}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${p.nombre}</cbc:RegistrationName>
        <cbc:CompanyID schemeAgencyID="195" schemeAgencyName="CO, DIAN" schemeID="${p.dv}" schemeName="31">${p.nit}</cbc:CompanyID>
        <cbc:TaxLevelCode listName="48">${p.responsabilidades || 'O-48'}</cbc:TaxLevelCode>
        <cac:RegistrationAddress>
          <cbc:CityName>${p.ciudad || 'Bogotá, D.C.'}</cbc:CityName>
          <cbc:CountrySubentity>${p.departamento || 'Bogotá'}</cbc:CountrySubentity>
          <cac:AddressLine><cbc:Line>${p.direccion || 'CL 1 # 2-3'}</cbc:Line></cac:AddressLine>
        </cac:RegistrationAddress>
        <cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${p.nombre}</cbc:RegistrationName>
        <cbc:CompanyID schemeID="${p.dv}" schemeName="31">${p.nit}</cbc:CompanyID>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Telephone>${p.telefono || ''}</cbc:Telephone>
        <cbc:ElectronicMail>${p.email || ''}</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:${tag}>`;
}

function impuestoXml(codigo, nombre, base, pct, valor) {
  return `
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">${f(base)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">${f(valor)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>${f(pct)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>${codigo}</cbc:ID><cbc:Name>${nombre}</cbc:Name></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`;
}

// lineas: [{ descripcion, cantidad, valorUnitario, ivaPct (default 19), incPct, unidad }]
function construirFactura(opciones = {}) {
  const o = {
    numero: 'SETP990000123',
    cufe: CUFE_EJEMPLO,
    fecha: '2026-10-05',
    hora: '10:30:00-05:00',
    emisor: EMISOR,
    comprador: COMPRADOR,
    tipo: '01',
    credito: false,
    vence: '2026-11-04',
    ordenRef: null,
    descuentoGlobal: 0,
    moneda: 'COP',
    lineas: [
      { descripcion: 'Mantenimiento de equipos', cantidad: 1, valorUnitario: 1000000 },
      { descripcion: 'Repuestos', cantidad: 2, valorUnitario: 250000 },
    ],
    ...opciones,
  };

  let sumaLineas = 0;
  const porCodigo = {};
  const lineasXml = o.lineas
    .map((l, i) => {
      const valor = redondear(l.cantidad * l.valorUnitario);
      sumaLineas += valor;
      const ivaPct = l.ivaPct === undefined ? 19 : l.ivaPct;
      const iva = redondear((valor * ivaPct) / 100);
      let impuestos = '';
      if (l.incPct) {
        const inc = redondear((valor * l.incPct) / 100);
        porCodigo['04'] = porCodigo['04'] || { base: 0, valor: 0, pct: l.incPct, nombre: 'INC' };
        porCodigo['04'].base += valor;
        porCodigo['04'].valor += inc;
        impuestos += `<cac:TaxTotal><cbc:TaxAmount currencyID="COP">${f(inc)}</cbc:TaxAmount>${impuestoXml('04', 'INC', valor, l.incPct, inc)}</cac:TaxTotal>`;
      }
      if (ivaPct > 0) {
        porCodigo['01'] = porCodigo['01'] || { base: 0, valor: 0, pct: ivaPct, nombre: 'IVA' };
        porCodigo['01'].base += valor;
        porCodigo['01'].valor += iva;
        impuestos += `<cac:TaxTotal><cbc:TaxAmount currencyID="COP">${f(iva)}</cbc:TaxAmount>${impuestoXml('01', 'IVA', valor, ivaPct, iva)}</cac:TaxTotal>`;
      }
      return `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${l.unidad || 'EA'}">${l.cantidad}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">${f(valor)}</cbc:LineExtensionAmount>
    ${impuestos}
    <cac:Item>
      <cbc:Description>${l.descripcion}</cbc:Description>
      <cac:StandardItemIdentification><cbc:ID schemeID="999">${l.codigo || 'ITEM' + (i + 1)}</cbc:ID></cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="COP">${f(l.valorUnitario)}</cbc:PriceAmount><cbc:BaseQuantity unitCode="EA">1</cbc:BaseQuantity></cac:Price>
  </cac:InvoiceLine>`;
    })
    .join('');

  const base = redondear(sumaLineas - o.descuentoGlobal);
  const iva = porCodigo['01'] ? redondear(porCodigo['01'].valor) : 0;
  const inc = porCodigo['04'] ? redondear(porCodigo['04'].valor) : 0;
  // Con descuento global el IVA del XML se deja como lo calcularía el emisor (sobre las líneas).
  const total = redondear(base + iva + inc);

  const resumenImpuestos = Object.entries(porCodigo)
    .map(([codigo, x]) => impuestoXml(codigo, x.nombre, x.base, x.pct, x.valor))
    .join('');

  const descuentoXml = o.descuentoGlobal
    ? `<cac:AllowanceCharge><cbc:ID>1</cbc:ID><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>Descuento comercial</cbc:AllowanceChargeReason><cbc:Amount currencyID="COP">${f(o.descuentoGlobal)}</cbc:Amount></cac:AllowanceCharge>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1">
  <ext:UBLExtensions>
    <ext:UBLExtension><ext:ExtensionContent>
      <sts:DianExtensions>
        <sts:InvoiceControl><sts:InvoiceAuthorization>18760000001</sts:InvoiceAuthorization></sts:InvoiceControl>
        <sts:SoftwareProvider><sts:ProviderID schemeID="3" schemeName="31">900555444</sts:ProviderID></sts:SoftwareProvider>
      </sts:DianExtensions>
    </ext:ExtensionContent></ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>10</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1: Factura Electrónica de Venta</cbc:ProfileID>
  <cbc:ID>${o.numero}</cbc:ID>
  <cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${o.cufe}</cbc:UUID>
  <cbc:IssueDate>${o.fecha}</cbc:IssueDate>
  <cbc:IssueTime>${o.hora}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>${o.tipo}</cbc:InvoiceTypeCode>
  <cbc:Note>Factura de prueba &amp; datos ficticios</cbc:Note>
  <cbc:DocumentCurrencyCode>${o.moneda}</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${o.lineas.length}</cbc:LineCountNumeric>
  ${o.ordenRef ? `<cac:OrderReference><cbc:ID>${o.ordenRef}</cbc:ID></cac:OrderReference>` : ''}
  ${parteXml('AccountingSupplierParty', o.emisor)}
  ${parteXml('AccountingCustomerParty', o.comprador)}
  <cac:PaymentMeans>
    <cbc:ID>${o.credito ? '2' : '1'}</cbc:ID>
    <cbc:PaymentMeansCode>${o.credito ? 'ZZZ' : '10'}</cbc:PaymentMeansCode>
    ${o.credito ? `<cbc:PaymentDueDate>${o.vence}</cbc:PaymentDueDate>` : ''}
  </cac:PaymentMeans>
  ${descuentoXml}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="COP">${f(iva + inc)}</cbc:TaxAmount>
    ${resumenImpuestos}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">${f(sumaLineas)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="COP">${f(base)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="COP">${f(total)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="COP">${f(o.descuentoGlobal)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="COP">${f(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lineasXml}
</Invoice>`;

  return { xml, base, iva, inc, total, sumaLineas };
}

// Sobre "AttachedDocument" como lo envían los proveedores tecnológicos:
// la factura va como texto (CDATA) y viene la respuesta de la DIAN.
function envolverAttachedDocument(xmlFactura, { validada = true } = {}) {
  const respuesta = `<?xml version="1.0" encoding="UTF-8"?>
<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ResponseCode>${validada ? '02' : '04'}</cbc:ResponseCode>
      <cbc:Description>${validada ? 'Documento validado por la DIAN' : 'Documento rechazado por la DIAN'}</cbc:Description>
    </cac:Response>
  </cac:DocumentResponse>
</ApplicationResponse>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:ID>9999</cbc:ID>
  <cbc:ParentDocumentID>SETP990000123</cbc:ParentDocumentID>
  <cac:Attachment>
    <cac:ExternalReference>
      <cbc:MimeCode>text/xml</cbc:MimeCode>
      <cbc:Description><![CDATA[${xmlFactura}]]></cbc:Description>
    </cac:ExternalReference>
  </cac:Attachment>
  <cac:ParentDocumentLineReference>
    <cbc:LineID>1</cbc:LineID>
    <cac:DocumentReference>
      <cbc:ID>SETP990000123</cbc:ID>
      <cac:Attachment>
        <cac:ExternalReference>
          <cbc:MimeCode>text/xml</cbc:MimeCode>
          <cbc:Description><![CDATA[${respuesta}]]></cbc:Description>
        </cac:ExternalReference>
      </cac:Attachment>
    </cac:DocumentReference>
  </cac:ParentDocumentLineReference>
</AttachedDocument>`;
}

// ZIP mínimo (un archivo por entrada, deflate) para probar la carga de .zip.
function crearZip(archivos) {
  const partes = [];
  const central = [];
  let desplazamiento = 0;
  for (const { nombre, datos, sinComprimir } of archivos) {
    const crudo = Buffer.isBuffer(datos) ? datos : Buffer.from(datos, 'utf8');
    const comprimido = sinComprimir ? crudo : zlib.deflateRawSync(crudo);
    const nombreBuf = Buffer.from(nombre, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(sinComprimir ? 0 : 8, 8);
    local.writeUInt32LE(0, 14); // CRC no se verifica en el lector
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(crudo.length, 22);
    local.writeUInt16LE(nombreBuf.length, 26);
    partes.push(local, nombreBuf, comprimido);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(sinComprimir ? 0 : 8, 10);
    dir.writeUInt32LE(comprimido.length, 20);
    dir.writeUInt32LE(crudo.length, 24);
    dir.writeUInt16LE(nombreBuf.length, 28);
    dir.writeUInt32LE(desplazamiento, 42);
    central.push(dir, nombreBuf);
    desplazamiento += 30 + nombreBuf.length + comprimido.length;
  }
  const centralBuf = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(centralBuf.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...partes, centralBuf, fin]);
}

module.exports = { construirFactura, envolverAttachedDocument, crearZip, EMISOR, COMPRADOR, CUFE_EJEMPLO };
