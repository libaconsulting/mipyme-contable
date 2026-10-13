// Lee el XML de una factura electrónica de venta de la DIAN (UBL 2.1) y lo
// convierte en un objeto plano con lo que necesita Compras para registrar
// y contabilizar la factura que EXPIDE EL PROVEEDOR.
//
// Entradas aceptadas (el usuario no tiene que saber cuál es cuál):
//   - el XML de la factura (<Invoice>)
//   - el "AttachedDocument" que envían la mayoría de proveedores
//     tecnológicos (trae la factura adentro, como texto, junto con la
//     respuesta de validación de la DIAN)
//   - un .zip que contenga cualquiera de los dos
//
// Este módulo NO toca la base de datos: recibe un Buffer y devuelve datos.
// Todo valor monetario sale como número con dos decimales.

const xml = require('./xmlMini');

const IMPUESTOS = {
  '01': 'IVA',
  '02': 'Impuesto al consumo departamental',
  '03': 'ICA',
  '04': 'Impoconsumo (INC)',
  '05': 'ReteIVA',
  '06': 'Retención en la fuente',
  '07': 'ReteICA',
  '08': 'Impuesto al consumo (porcentual)',
  '20': 'Fondo nacional del cacao/horticultura',
  '21': 'Timbre',
  '22': 'INC bolsas plásticas',
  '23': 'Impuesto nacional al carbono',
  '24': 'Impuesto nacional a los combustibles',
  '25': 'Sobretasa a los combustibles',
  '26': 'Contribución parafiscal',
  ZZ: 'Otro / no aplica',
};
const CODIGOS_RETENCION = ['05', '06', '07'];

// Tipo de documento según InvoiceTypeCode / elemento raíz.
const TIPOS_FACTURA = ['01', '03', '04']; // venta, contingencia, contingencia DIAN
const NOMBRES_TIPO = {
  '01': 'Factura electrónica de venta',
  '02': 'Factura de exportación',
  '03': 'Factura por contingencia',
  '04': 'Factura por contingencia DIAN',
  '05': 'Documento soporte en adquisiciones',
  '91': 'Nota crédito',
  '92': 'Nota débito',
};

function dinero(valor) {
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function numero(valor) {
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// --- Entrada: Buffer -> nodo <Invoice> -------------------------------

function nodoDesdeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('El archivo está vacío.');

  let candidatos;
  if (xml.esZip(buffer)) {
    const archivos = xml.leerZip(buffer);
    if (archivos.length === 0) throw new Error('El ZIP no contiene ningún archivo XML.');
    candidatos = archivos.map((a) => ({ nombre: a.nombre, texto: xml.bufferATexto(a.datos) }));
  } else {
    candidatos = [{ nombre: 'factura.xml', texto: xml.bufferATexto(buffer) }];
  }

  const leidos = [];
  for (const c of candidatos) {
    try {
      leidos.push({ nombre: c.nombre, texto: c.texto, raiz: xml.parsearXml(c.texto) });
    } catch (e) {
      if (candidatos.length === 1) throw new Error(`No se pudo leer el XML: ${e.message}`);
      // en un ZIP con varios XML, uno dañado no debe tumbar a los demás
    }
  }
  if (leidos.length === 0) throw new Error('Ningún XML del ZIP se pudo leer.');

  // Preferencia: una factura directa; si no, un AttachedDocument con la factura adentro.
  const directa = leidos.find((l) => ['Invoice', 'CreditNote', 'DebitNote'].includes(l.raiz.nombre));
  if (directa) return { raiz: directa.raiz, adjunto: null, textoXml: directa.texto };

  const adjunto = leidos.find((l) => l.raiz.nombre === 'AttachedDocument');
  if (adjunto) {
    const interior = extraerDocumentoAdjunto(adjunto.raiz);
    if (!interior) throw new Error('El AttachedDocument no trae la factura adentro.');
    return { raiz: interior, adjunto: adjunto.raiz, textoXml: adjunto.texto };
  }

  throw new Error(`El XML no es una factura electrónica (elemento raíz "${leidos[0].raiz.nombre}").`);
}

// La factura va como texto (CDATA) dentro de
// AttachedDocument/Attachment/ExternalReference/Description.
function extraerDocumentoAdjunto(adjunto) {
  const descripcion = xml.ruta(adjunto, 'Attachment/ExternalReference/Description');
  if (descripcion && /<(\w+:)?(Invoice|CreditNote|DebitNote)[\s>]/.test(descripcion.texto)) {
    return xml.parsearXml(descripcion.texto);
  }
  // Algunos proveedores la ubican en otra rama: se busca cualquier Description con una factura.
  const pila = [adjunto];
  while (pila.length) {
    const x = pila.pop();
    if (x.nombre === 'Description' && /<(\w+:)?(Invoice|CreditNote|DebitNote)[\s>]/.test(x.texto)) {
      return xml.parsearXml(x.texto);
    }
    pila.push(...x.hijos);
  }
  return null;
}

// Respuesta de la DIAN que viaja en el AttachedDocument (si viene).
function leerValidacionDian(adjunto) {
  if (!adjunto) return { disponible: false, validada: null, mensaje: '' };
  let respuesta = null;
  const pila = [adjunto];
  while (pila.length) {
    const x = pila.pop();
    if (x.nombre === 'Description' && /<(\w+:)?ApplicationResponse[\s>]/.test(x.texto)) {
      try {
        respuesta = xml.parsearXml(x.texto);
      } catch (_) {
        /* se ignora */
      }
      break;
    }
    pila.push(...x.hijos);
  }
  if (!respuesta) return { disponible: false, validada: null, mensaje: '' };

  const codigo = xml.texto(respuesta, 'DocumentResponse/Response/ResponseCode');
  const descripcion = xml.texto(respuesta, 'DocumentResponse/Response/Description');
  return {
    disponible: true,
    // 02 = documento validado por la DIAN
    validada: codigo === '02' || /validad/i.test(descripcion),
    codigo,
    mensaje: descripcion,
  };
}

// --- Partes (emisor / receptor) --------------------------------------

function leerParte(contenedor) {
  const parte = xml.hijo(contenedor, 'Party');
  if (!parte) return null;

  const esquema = xml.hijo(parte, 'PartyTaxScheme');
  const legal = xml.hijo(parte, 'PartyLegalEntity');
  const idNodo = xml.ruta(esquema || legal || parte, 'CompanyID') || xml.ruta(legal || parte, 'CompanyID');

  const responsabilidades = xml
    .texto(esquema, 'TaxLevelCode')
    .split(/[;,\s]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const direccion = xml.hijo(esquema, 'RegistrationAddress') || xml.hijo(legal, 'RegistrationAddress') || xml.hijo(parte, 'PhysicalLocation');
  const lineaDireccion = xml.texto(direccion, 'AddressLine/Line');

  const tipoPersonaCodigo = xml.texto(contenedor, 'AdditionalAccountID'); // 1 jurídica, 2 natural

  const parteDatos = {
    nit: idNodo ? idNodo.texto.replace(/\D/g, '') : '',
    dv: idNodo ? idNodo.atributos.schemeID || '' : '',
    tipoDocumento: idNodo ? idNodo.atributos.schemeName || '' : '',
    nombre: xml.texto(esquema, 'RegistrationName') || xml.texto(legal, 'RegistrationName') || xml.texto(parte, 'PartyName/Name'),
    nombreComercial: xml.texto(parte, 'PartyName/Name'),
    tipoPersona: tipoPersonaCodigo === '2' ? 'natural' : tipoPersonaCodigo === '1' ? 'juridica' : null,
    responsabilidades,
    email: xml.texto(parte, 'Contact/ElectronicMail'),
    telefono: xml.texto(parte, 'Contact/Telephone'),
    direccion: lineaDireccion,
    municipio: xml.texto(direccion, 'CityName'),
    departamento: xml.texto(direccion, 'CountrySubentity'),
  };

  // Datos que sirven para sugerir el tratamiento de retención.
  parteDatos.esRegimenSimple = responsabilidades.includes('O-47');
  parteDatos.esAutorretenedor = responsabilidades.includes('O-15');
  parteDatos.esGranContribuyente = responsabilidades.includes('O-13');
  parteDatos.regimenIva = responsabilidades.includes('O-48')
    ? 'responsable'
    : responsabilidades.includes('O-49')
    ? 'no_responsable'
    : null;
  return parteDatos;
}

// --- Impuestos --------------------------------------------------------

// Lee los <TaxSubtotal> de un <TaxTotal>/<WithholdingTaxTotal>.
function leerSubtotales(totalNodo) {
  return xml.hijosDe(totalNodo, 'TaxSubtotal').map((s) => {
    const codigo = xml.texto(s, 'TaxCategory/TaxScheme/ID') || 'ZZ';
    return {
      codigo,
      nombre: IMPUESTOS[codigo] || xml.texto(s, 'TaxCategory/TaxScheme/Name') || codigo,
      base: dinero(xml.texto(s, 'TaxableAmount')),
      porcentaje: numero(xml.texto(s, 'TaxCategory/Percent')),
      valor: dinero(xml.texto(s, 'TaxAmount')),
    };
  });
}

function agruparPorCodigo(subtotales) {
  const mapa = new Map();
  for (const s of subtotales) {
    const previo = mapa.get(s.codigo);
    if (!previo) mapa.set(s.codigo, { ...s });
    else {
      previo.base = dinero(previo.base + s.base);
      previo.valor = dinero(previo.valor + s.valor);
      if (previo.porcentaje !== s.porcentaje) previo.porcentaje = null; // tarifas mezcladas
    }
  }
  return Array.from(mapa.values());
}

// --- Documento --------------------------------------------------------

function leerFacturaElectronica(buffer) {
  const { raiz, adjunto, textoXml } = nodoDesdeBuffer(buffer);
  const advertencias = [];

  const esNotaCredito = raiz.nombre === 'CreditNote';
  const esNotaDebito = raiz.nombre === 'DebitNote';
  const codigoTipo = xml.texto(raiz, 'InvoiceTypeCode') || (esNotaCredito ? '91' : esNotaDebito ? '92' : '');
  const lineaNombre = raiz.nombre === 'Invoice' ? 'InvoiceLine' : raiz.nombre === 'CreditNote' ? 'CreditNoteLine' : 'DebitNoteLine';
  const cantidadNombre = raiz.nombre === 'Invoice' ? 'InvoicedQuantity' : raiz.nombre === 'CreditNote' ? 'CreditedQuantity' : 'DebitedQuantity';

  const cufeNodo = xml.hijo(raiz, 'UUID');
  const cufe = cufeNodo ? cufeNodo.texto.toLowerCase() : '';
  const esquemaCufe = cufeNodo ? cufeNodo.atributos.schemeName || '' : '';

  const emisor = leerParte(xml.hijo(raiz, 'AccountingSupplierParty'));
  const receptor = leerParte(xml.hijo(raiz, 'AccountingCustomerParty'));

  // --- Líneas
  const lineas = xml.hijosDe(raiz, lineaNombre).map((l, i) => {
    const subtotalesLinea = xml.hijosDe(l, 'TaxTotal').flatMap(leerSubtotales);
    const cantidad = numero(xml.texto(l, cantidadNombre));
    const valorTotal = dinero(xml.texto(l, 'LineExtensionAmount'));
    const iva = subtotalesLinea.filter((s) => s.codigo === '01');
    const otros = subtotalesLinea.filter((s) => s.codigo !== '01' && !CODIGOS_RETENCION.includes(s.codigo) && s.codigo !== 'ZZ');
    const descuentos = xml
      .hijosDe(l, 'AllowanceCharge')
      .filter((a) => xml.texto(a, 'ChargeIndicator') === 'false')
      .reduce((s, a) => s + dinero(xml.texto(a, 'Amount')), 0);
    const descripcion = xml.texto(l, 'Item/Description') || xml.texto(l, 'Item/Name') || `Ítem ${i + 1}`;
    return {
      numero: xml.texto(l, 'ID') || String(i + 1),
      descripcion,
      codigo:
        xml.texto(l, 'Item/StandardItemIdentification/ID') ||
        xml.texto(l, 'Item/SellersItemIdentification/ID') ||
        '',
      cantidad,
      unidad: xml.atributo(l, cantidadNombre, 'unitCode'),
      valorUnitario: dinero(xml.texto(l, 'Price/PriceAmount')),
      descuento: dinero(descuentos),
      valorTotal,
      iva: dinero(iva.reduce((s, x) => s + x.valor, 0)),
      ivaPorcentaje: iva.length ? iva[0].porcentaje : 0,
      otrosImpuestos: dinero(otros.reduce((s, x) => s + x.valor, 0)),
      impuestos: subtotalesLinea,
      gratuita: valorTotal === 0,
    };
  });

  // --- Impuestos del documento y retenciones que declara el emisor
  const impuestos = agruparPorCodigo(
    xml.hijosDe(raiz, 'TaxTotal').flatMap(leerSubtotales).filter((s) => !CODIGOS_RETENCION.includes(s.codigo))
  );
  const retencionesEmisor = agruparPorCodigo(
    [
      ...xml.hijosDe(raiz, 'WithholdingTaxTotal').flatMap(leerSubtotales),
      ...xml.hijosDe(raiz, 'TaxTotal').flatMap(leerSubtotales).filter((s) => CODIGOS_RETENCION.includes(s.codigo)),
    ]
  );

  // Si el XML no trae el resumen a nivel de documento, se arma con el de las líneas.
  if (impuestos.length === 0) {
    impuestos.push(...agruparPorCodigo(lineas.flatMap((l) => l.impuestos).filter((s) => !CODIGOS_RETENCION.includes(s.codigo))));
  }
  const iva = dinero(impuestos.filter((s) => s.codigo === '01').reduce((s, x) => s + x.valor, 0));
  // Todo impuesto que no es IVA ni ZZ (impoconsumo, bolsas, etc.) sube el valor del gasto.
  const impoconsumo = dinero(impuestos.filter((s) => s.codigo !== '01' && s.codigo !== 'ZZ').reduce((s, x) => s + x.valor, 0));

  // --- Totales
  const monetarios = xml.hijo(raiz, 'LegalMonetaryTotal');
  const totales = {
    lineas: dinero(xml.texto(monetarios, 'LineExtensionAmount')),
    base: dinero(xml.texto(monetarios, 'TaxExclusiveAmount')),
    conImpuestos: dinero(xml.texto(monetarios, 'TaxInclusiveAmount')),
    descuentos: dinero(xml.texto(monetarios, 'AllowanceTotalAmount')),
    cargos: dinero(xml.texto(monetarios, 'ChargeTotalAmount')),
    anticipos: dinero(xml.texto(monetarios, 'PrepaidAmount')),
    aPagar: dinero(xml.texto(monetarios, 'PayableAmount')),
    iva,
    impoconsumo,
  };

  // --- Pago
  const medio = xml.hijo(raiz, 'PaymentMeans');
  const idPago = xml.texto(medio, 'ID'); // 1 = contado, 2 = crédito
  const fechaVencimiento = xml.texto(medio, 'PaymentDueDate') || xml.texto(raiz, 'DueDate') || null;

  const datos = {
    tipoCodigo: codigoTipo,
    tipoNombre: NOMBRES_TIPO[codigoTipo] || `Documento tipo ${codigoTipo || 'desconocido'}`,
    esFactura: raiz.nombre === 'Invoice' && TIPOS_FACTURA.includes(codigoTipo),
    elementoRaiz: raiz.nombre,
    numero: xml.texto(raiz, 'ID'),
    cufe,
    cufeAlgoritmo: esquemaCufe,
    fechaEmision: xml.texto(raiz, 'IssueDate'),
    horaEmision: xml.texto(raiz, 'IssueTime'),
    fechaVencimiento,
    moneda: xml.texto(raiz, 'DocumentCurrencyCode') || 'COP',
    formaPago: idPago === '2' ? 'credito' : idPago === '1' ? 'contado' : null,
    medioPagoCodigo: xml.texto(medio, 'PaymentMeansCode'),
    ordenReferencia: xml.texto(raiz, 'OrderReference/ID') || null,
    notas: xml.hijosDe(raiz, 'Note').map((n) => n.texto).filter(Boolean),
    emisor,
    receptor,
    lineas,
    impuestos,
    retencionesEmisor,
    totales,
    validacionDian: leerValidacionDian(adjunto),
    vieneEnAdjunto: !!adjunto,
    advertencias,
    // XML tal como llegó (para guardarlo como soporte). No se envía al navegador.
    xmlOriginal: textoXml,
  };

  validarCoherencia(datos);
  return datos;
}

// Revisa que el XML sea coherente consigo mismo. No bloquea: el
// llamador decide qué hacer con cada aviso.
function validarCoherencia(d) {
  const av = d.advertencias;
  const t = d.totales;

  if (!d.numero) av.push({ nivel: 'confirmar', texto: 'El XML no trae número de factura.' });
  if (!d.fechaEmision) av.push({ nivel: 'bloqueo', texto: 'El XML no trae fecha de emisión.' });
  if (!d.emisor || !d.emisor.nit) av.push({ nivel: 'bloqueo', texto: 'El XML no trae el NIT del proveedor.' });
  if (!d.cufe) av.push({ nivel: 'bloqueo', texto: 'El XML no trae CUFE: no es una factura electrónica válida.' });
  else if (!/^[0-9a-f]{96}$/.test(d.cufe)) {
    av.push({ nivel: 'confirmar', texto: 'El CUFE no tiene el formato esperado (96 caracteres hexadecimales).' });
  }
  if (d.moneda && d.moneda !== 'COP') {
    av.push({ nivel: 'bloqueo', texto: `La factura está en ${d.moneda}. Por ahora solo se contabilizan facturas en pesos (COP).` });
  }
  if (d.lineas.length === 0) av.push({ nivel: 'bloqueo', texto: 'La factura no trae líneas de detalle.' });
  if (t.conImpuestos <= 0) av.push({ nivel: 'bloqueo', texto: 'El total de la factura es cero o no se pudo leer.' });

  const sumaLineas = Math.round(d.lineas.reduce((s, l) => s + l.valorTotal, 0) * 100) / 100;
  if (t.lineas && Math.abs(sumaLineas - t.lineas) > 1) {
    av.push({ nivel: 'confirmar', texto: `La suma de las líneas (${sumaLineas}) no coincide con el total de líneas del XML (${t.lineas}).` });
  }
  const esperado = Math.round((t.base + t.iva + t.impoconsumo) * 100) / 100;
  if (t.base && Math.abs(esperado - t.conImpuestos) > 1) {
    av.push({
      nivel: 'confirmar',
      texto: `Base + impuestos (${esperado}) no coincide con el total con impuestos del XML (${t.conImpuestos}).`,
    });
  }
  if (t.anticipos > 0) {
    av.push({ nivel: 'confirmar', texto: 'La factura trae anticipos: se contabiliza el total completo; revisa el cruce de anticipos aparte.' });
  }
  if (d.vieneEnAdjunto && d.validacionDian.disponible && d.validacionDian.validada === false) {
    av.push({ nivel: 'bloqueo', texto: 'La respuesta de la DIAN en el archivo indica que el documento NO fue validado.' });
  }
}

module.exports = { leerFacturaElectronica, IMPUESTOS, NOMBRES_TIPO, TIPOS_FACTURA };
