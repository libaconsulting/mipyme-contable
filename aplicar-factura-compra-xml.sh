#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
# Facturas de compra desde el XML del proveedor: ventana de carga (XML, AttachedDocument o ZIP),
# vista previa, proveedor por NIT, vínculo con la orden de adquisición, retención en la fuente,
# cuenta destino por línea y asiento contable de varias líneas (IVA descontable, retefuente, ReteIVA).
set -e
if [ ! -f "package.json" ]; then echo "ERROR: ve a la carpeta mipyme-contable primero."; exit 1; fi

mkdir -p  public/contable src/core/services src/integrations/dian src/modules/compras/controllers src/modules/compras/models src/modules/compras/routes src/modules/compras/services tests tests/helpers
cat > src/integrations/dian/xmlMini.js << 'SCRIPTEOF'
// Lector de XML mínimo y SIN dependencias, pensado para los documentos
// electrónicos de la DIAN (UBL 2.1).
//
// Por qué no una librería: (1) el archivo lo manda un tercero (el
// proveedor), así que se trata como NO confiable; este lector ignora por
// completo las declaraciones DOCTYPE/ENTITY (rechaza el documento), con
// lo que no hay ataques de entidades externas ni de expansión; (2) evita
// agregar una dependencia al despliegue de Hostinger.
//
// Además incluye un lector de ZIP (los proveedores suelen enviar el XML
// dentro de un .zip junto con el PDF), apoyado en zlib de Node.

const zlib = require('zlib');

const MAX_PROFUNDIDAD = 60;
const MAX_ZIP_SALIDA = 20 * 1024 * 1024; // protección contra "zip bombs"

const ENTIDADES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodificarEntidades(texto) {
  if (texto.indexOf('&') === -1) return texto;
  return texto.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const codigo = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(codigo);
      } catch (_) {
        return m;
      }
    }
    return ENTIDADES[e] !== undefined ? ENTIDADES[e] : m;
  });
}

// Quita el prefijo de espacio de nombres: "cbc:ID" -> "ID".
function local(nombre) {
  const i = nombre.indexOf(':');
  return i === -1 ? nombre : nombre.slice(i + 1);
}

function leerAtributos(cadena) {
  const atributos = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(cadena))) {
    const nombre = m[1];
    if (nombre === 'xmlns' || nombre.startsWith('xmlns:')) continue;
    atributos[local(nombre)] = decodificarEntidades(m[3] !== undefined ? m[3] : m[4]);
  }
  return atributos;
}

// Devuelve el nodo raíz: { nombre, atributos, hijos: [nodo], texto }.
function parsearXml(entrada) {
  let xml = String(entrada);
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);

  const raiz = { nombre: '#raiz', atributos: {}, hijos: [], texto: '', _partes: [] };
  const pila = [raiz];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    const actual = pila[pila.length - 1];

    if (lt === -1) {
      actual._partes.push(xml.slice(i));
      break;
    }
    if (lt > i) actual._partes.push(decodificarEntidades(xml.slice(i, lt)));

    if (xml.startsWith('<!--', lt)) {
      const fin = xml.indexOf('-->', lt + 4);
      if (fin === -1) throw new Error('XML mal formado: comentario sin cerrar.');
      i = fin + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const fin = xml.indexOf(']]>', lt + 9);
      if (fin === -1) throw new Error('XML mal formado: CDATA sin cerrar.');
      actual._partes.push(xml.slice(lt + 9, fin)); // el CDATA va tal cual
      i = fin + 3;
    } else if (xml.startsWith('<?', lt)) {
      const fin = xml.indexOf('?>', lt + 2);
      if (fin === -1) throw new Error('XML mal formado: instrucción sin cerrar.');
      i = fin + 2;
    } else if (xml.startsWith('<!', lt)) {
      // <!DOCTYPE ...>, <!ENTITY ...>: no se procesan, se rechaza.
      throw new Error('El XML contiene declaraciones DOCTYPE/ENTITY, que no se permiten.');
    } else if (xml[lt + 1] === '/') {
      const fin = xml.indexOf('>', lt + 2);
      if (fin === -1) throw new Error('XML mal formado: etiqueta de cierre sin terminar.');
      const nombre = local(xml.slice(lt + 2, fin).trim());
      const nodo = pila.pop();
      if (pila.length === 0 || nodo.nombre !== nombre) {
        throw new Error(`XML mal formado: se esperaba </${nodo ? nodo.nombre : '?'}> y llegó </${nombre}>.`);
      }
      cerrar(nodo);
      i = fin + 1;
    } else {
      // Etiqueta de apertura. Hay que respetar ">" dentro de valores entre comillas.
      let j = lt + 1;
      let comilla = null;
      while (j < n) {
        const c = xml[j];
        if (comilla) {
          if (c === comilla) comilla = null;
        } else if (c === '"' || c === "'") comilla = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= n) throw new Error('XML mal formado: etiqueta sin terminar.');
      let cuerpo = xml.slice(lt + 1, j);
      const autoCierre = cuerpo.endsWith('/');
      if (autoCierre) cuerpo = cuerpo.slice(0, -1);
      const espacio = cuerpo.search(/\s/);
      const nombreCrudo = espacio === -1 ? cuerpo : cuerpo.slice(0, espacio);
      if (!nombreCrudo) throw new Error('XML mal formado: etiqueta sin nombre.');
      const nodo = {
        nombre: local(nombreCrudo),
        atributos: espacio === -1 ? {} : leerAtributos(cuerpo.slice(espacio)),
        hijos: [],
        texto: '',
        _partes: [],
      };
      actual.hijos.push(nodo);
      if (autoCierre) cerrar(nodo);
      else {
        if (pila.length > MAX_PROFUNDIDAD) throw new Error('XML demasiado anidado.');
        pila.push(nodo);
      }
      i = j + 1;
    }
  }

  if (pila.length !== 1) throw new Error('XML mal formado: hay etiquetas sin cerrar.');
  if (raiz.hijos.length !== 1) throw new Error('XML inválido: debe tener un único elemento raíz.');
  return raiz.hijos[0];
}

function cerrar(nodo) {
  nodo.texto = nodo._partes.join('').trim();
  delete nodo._partes;
}

// --- Navegación ------------------------------------------------------

// Primer hijo directo con ese nombre.
function hijo(nodo, nombre) {
  return nodo ? nodo.hijos.find((h) => h.nombre === nombre) || null : null;
}

function hijosDe(nodo, nombre) {
  return nodo ? nodo.hijos.filter((h) => h.nombre === nombre) : [];
}

// Ruta "A/B/C" desde el nodo; devuelve el primer nodo que la cumple.
function ruta(nodo, camino) {
  let actual = nodo;
  for (const paso of camino.split('/')) {
    actual = hijo(actual, paso);
    if (!actual) return null;
  }
  return actual;
}

// Todos los nodos al final de la ruta (recorre todas las ramas).
function rutaTodos(nodo, camino) {
  let nivel = [nodo];
  for (const paso of camino.split('/')) {
    nivel = nivel.flatMap((x) => hijosDe(x, paso));
    if (nivel.length === 0) return [];
  }
  return nivel;
}

function texto(nodo, camino) {
  const x = camino ? ruta(nodo, camino) : nodo;
  return x ? x.texto : '';
}

function atributo(nodo, camino, nombre) {
  const x = camino ? ruta(nodo, camino) : nodo;
  return x && x.atributos[nombre] !== undefined ? x.atributos[nombre] : '';
}

// Primer descendiente (en cualquier nivel) con ese nombre.
function buscar(nodo, nombre) {
  if (!nodo) return null;
  for (const h of nodo.hijos) {
    if (h.nombre === nombre) return h;
    const dentro = buscar(h, nombre);
    if (dentro) return dentro;
  }
  return null;
}

// --- ZIP -------------------------------------------------------------

function esZip(buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

// Devuelve [{ nombre, datos: Buffer }] de los archivos del ZIP.
function leerZip(buffer) {
  // Fin del directorio central (EOCD): firma 0x06054b50, en los últimos 64 KB.
  let eocd = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 22 - 65535); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd === -1) throw new Error('El archivo ZIP está dañado o incompleto.');

  const total = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const archivos = [];
  let acumulado = 0;

  for (let k = 0; k < total; k++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('El archivo ZIP está dañado (directorio central).');
    }
    const metodo = buffer.readUInt16LE(p + 10);
    const tamComprimido = buffer.readUInt32LE(p + 20);
    const tamReal = buffer.readUInt32LE(p + 24);
    const largoNombre = buffer.readUInt16LE(p + 28);
    const largoExtra = buffer.readUInt16LE(p + 30);
    const largoComentario = buffer.readUInt16LE(p + 32);
    const posLocal = buffer.readUInt32LE(p + 42);
    const nombre = buffer.slice(p + 46, p + 46 + largoNombre).toString('utf8');
    p += 46 + largoNombre + largoExtra + largoComentario;

    if (nombre.endsWith('/')) continue; // carpeta
    if (!/\.xml$/i.test(nombre)) continue; // solo interesan los XML
    acumulado += tamReal;
    if (tamReal > MAX_ZIP_SALIDA || acumulado > MAX_ZIP_SALIDA) throw new Error('El contenido del ZIP es demasiado grande.');

    if (buffer.readUInt32LE(posLocal) !== 0x04034b50) throw new Error('El archivo ZIP está dañado (encabezado local).');
    const nLocal = buffer.readUInt16LE(posLocal + 26);
    const eLocal = buffer.readUInt16LE(posLocal + 28);
    const inicio = posLocal + 30 + nLocal + eLocal;
    const crudo = buffer.slice(inicio, inicio + tamComprimido);

    let datos;
    if (metodo === 0) datos = crudo;
    else if (metodo === 8) datos = zlib.inflateRawSync(crudo, { maxOutputLength: MAX_ZIP_SALIDA });
    else throw new Error('El ZIP usa un método de compresión no soportado.');
    archivos.push({ nombre, datos });
  }
  return archivos;
}

// Buffer -> texto, respetando la codificación declarada (casi siempre UTF-8).
function bufferATexto(buffer) {
  const inicio = buffer.slice(0, 200).toString('latin1');
  const m = /encoding\s*=\s*["']([^"']+)["']/i.exec(inicio);
  if (m && /iso-8859-1|latin1|windows-1252/i.test(m[1])) return buffer.toString('latin1');
  return buffer.toString('utf8');
}

module.exports = {
  parsearXml,
  hijo,
  hijosDe,
  ruta,
  rutaTodos,
  texto,
  atributo,
  buscar,
  esZip,
  leerZip,
  bufferATexto,
};
SCRIPTEOF
echo "OK  src/integrations/dian/xmlMini.js"

cat > src/integrations/dian/facturaElectronica.js << 'SCRIPTEOF'
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
SCRIPTEOF
echo "OK  src/integrations/dian/facturaElectronica.js"

cat > src/modules/compras/services/facturaXml.service.js << 'SCRIPTEOF'
// Factura de compra a partir del XML que expide el proveedor.
//
// Dos pasos, ambos con el archivo en la mano:
//   1) previsualizarFacturaXml: lee el XML, NO guarda nada, y devuelve lo
//      que hay que revisar (datos de la factura, proveedor, órdenes
//      candidatas, advertencias, cuentas posibles).
//   2) registrarFacturaXml: vuelve a leer el XML (nunca se confía en lo que
//      mande el navegador), valida, guarda la factura y la contabiliza en
//      un asiento de varias líneas, todo en una sola transacción.
//
// Asiento resultante (valores de ejemplo):
//   Db  Inventario / Gasto / Costo (cuenta elegida por línea)   base (+ impoconsumo)
//   Db  1355 IVA descontable (si la empresa es responsable de IVA)
//   Cr  2205 Proveedores nacionales                              total - retenciones
//   Cr  2365 Retención en la fuente por pagar
//   Cr  2367 ReteIVA por pagar

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Empresa = require('../../../core/models/Empresa');
const Tercero = require('../../../core/models/Tercero');
const Proyecto = require('../../../core/models/Proyecto');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Movimiento = require('../../../core/models/Movimiento');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const OrdenCompra = require('../models/OrdenCompra');
const FacturaCompra = require('../models/FacturaCompra');
const { contabilizarAsientoCompuesto } = require('../../../core/services/motorAsientos');
const { leerFacturaElectronica } = require('../../../integrations/dian/facturaElectronica');
const calcularOrden = require('../../../../public/contable/calculoOrden');
const { armarAsientoCompra, repartir } = require('../../../../public/contable/asientoCompra');
const retencionesCatalogo = require('../../../../public/contable/retencionesCatalogo');

const MAX_ARCHIVO_BYTES = 3.5 * 1024 * 1024; // el límite de JSON del servidor es 5 MB (base64 pesa ~33% más)
const ESTADOS_ORDEN_FACTURABLE = ['aprobada', 'recibida_parcial', 'recibida_total'];

// --- utilidades ------------------------------------------------------

const centavos = (n) => Math.round((Number(n) + Number.EPSILON) * 100);

// "900.123.456-1" -> { base: '900123456', tieneDv: true }
function partesNit(nit) {
  const crudo = String(nit || '').trim();
  const tieneDv = crudo.includes('-');
  const base = (tieneDv ? crudo.split('-')[0] : crudo).replace(/\D/g, '');
  return { base, tieneDv };
}

// Compara NITs aunque uno traiga el dígito de verificación pegado y el otro no.
function mismoNit(a, b) {
  const x = partesNit(a);
  const y = partesNit(b);
  if (!x.base || !y.base) return false;
  if (x.base === y.base) return true;
  if (!x.tieneDv && x.base.slice(0, -1) === y.base) return true;
  if (!y.tieneDv && y.base.slice(0, -1) === x.base) return true;
  return false;
}

function decodificarArchivo(archivoBase64) {
  if (typeof archivoBase64 !== 'string' || archivoBase64.length === 0) {
    throw new Error('Selecciona el archivo XML (o ZIP) de la factura.');
  }
  const limpio = archivoBase64.replace(/^data:[^,]*,/, '');
  const buffer = Buffer.from(limpio, 'base64');
  if (buffer.length === 0) throw new Error('El archivo está vacío.');
  if (buffer.length > MAX_ARCHIVO_BYTES) {
    throw new Error('El archivo es demasiado grande (máximo 3,5 MB). Sube solo el XML de la factura.');
  }
  return buffer;
}

// Las cuentas a las que se puede llevar el gasto/costo/activo de una compra.
function esCuentaDestino(c) {
  if (c.naturaleza !== 'debito') return false;
  if (['costo', 'gasto'].includes(c.elementoNiif)) return true;
  return /^(14|15|17)/.test(c.codigo) && !/^1592/.test(c.codigo);
}

async function cuentasDestinoDe(empresaId) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId }, order: [['codigo', 'ASC']] });
  return cuentas.filter(esCuentaDestino).map((c) => ({ codigo: c.codigo, nombre: c.nombre }));
}

// Cuenta de débito que hoy usan las reglas de compra (valor por defecto del destino).
async function destinosSugeridos(empresaId) {
  const resultado = { bienes: '1435', gasto: '5195' };
  for (const [clave, evento] of [
    ['bienes', 'factura_compra_con_orden'],
    ['gasto', 'factura_compra_sin_orden'],
  ]) {
    const regla = await ReglaContabilizacion.findOne({ where: { empresaId, eventoOrigen: evento } });
    if (!regla) continue;
    const cuenta = await PlanCuentas.findByPk(regla.cuentaDebitoId);
    if (cuenta) resultado[clave] = cuenta.codigo;
  }
  return resultado;
}

async function buscarProveedorPorNit(empresaId, nit) {
  const { base } = partesNit(nit);
  if (!base) return null;
  const candidatos = await Tercero.findAll({
    where: { empresaId, identificacion: { [Op.like]: `${base}%` } },
  });
  return candidatos.find((t) => mismoNit(t.identificacion, nit)) || null;
}

// Retención que se sugiere según lo que el propio XML dice del proveedor.
function sugerirRetencion(emisor) {
  if (emisor.esRegimenSimple) {
    return {
      modo: 'no_aplica',
      motivo: retencionesCatalogo.MOTIVOS_NO_APLICA[0],
      detalle: '',
      texto: 'El XML indica que el proveedor es del Régimen Simple de Tributación (O-47). Confirma que su certificado esté vigente.',
    };
  }
  if (emisor.esAutorretenedor) {
    return {
      modo: 'no_aplica',
      motivo: retencionesCatalogo.MOTIVOS_NO_APLICA[3],
      detalle: 'El proveedor es autorretenedor (O-15).',
      texto: 'El XML indica que el proveedor es autorretenedor (O-15): normalmente no se le practica retención.',
    };
  }
  return null;
}

// --- análisis común a vista previa y registro ------------------------

async function analizar(datos, usuario) {
  const buffer = decodificarArchivo(datos.archivoBase64);
  const factura = leerFacturaElectronica(buffer);
  const empresa = await Empresa.findByPk(usuario.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada.');

  const advertencias = [...factura.advertencias];

  if (!factura.esFactura) {
    const motivo =
      factura.elementoRaiz === 'CreditNote'
        ? 'Es una nota crédito: todavía no se pueden cargar notas crédito desde XML.'
        : factura.elementoRaiz === 'DebitNote'
        ? 'Es una nota débito: todavía no se pueden cargar notas débito desde XML.'
        : `Es un documento de tipo "${factura.tipoNombre}", que no se carga como factura de compra.`;
    advertencias.push({ nivel: 'bloqueo', texto: motivo });
  }

  // ¿Está a nombre de nuestra empresa?
  if (factura.receptor && factura.receptor.nit && !mismoNit(empresa.nit, factura.receptor.nit)) {
    advertencias.push({
      nivel: 'confirmar',
      texto:
        `La factura está a nombre de ${factura.receptor.nombre || 'otra persona'} (NIT ${factura.receptor.nit}), ` +
        `que no coincide con el NIT de tu empresa (${empresa.nit}).`,
    });
  }

  // ¿Ya la cargamos?
  if (factura.cufe) {
    const repetida = await FacturaCompra.findOne({ where: { empresaId: empresa.id, cufe: factura.cufe } });
    if (repetida) {
      advertencias.push({
        nivel: 'bloqueo',
        texto: `Esta factura ya está registrada (${repetida.numero || 'sin número'}, ${repetida.fecha}). No se puede cargar dos veces.`,
      });
    }
  }
  if (factura.emisor && factura.emisor.nit && factura.numero) {
    const mismaNumeracion = await FacturaCompra.findOne({
      where: { empresaId: empresa.id, numero: factura.numero, emisorNit: factura.emisor.nit },
    });
    if (mismaNumeracion && (!factura.cufe || mismaNumeracion.cufe !== factura.cufe)) {
      advertencias.push({
        nivel: 'bloqueo',
        texto: `Ya existe la factura ${factura.numero} de este proveedor registrada con otro CUFE.`,
      });
    }
  }

  const proveedor = factura.emisor && factura.emisor.nit ? await buscarProveedorPorNit(empresa.id, factura.emisor.nit) : null;

  // Órdenes de adquisición que podrían corresponder a esta factura.
  const filtroOrden = { empresaId: empresa.id, estado: { [Op.in]: ESTADOS_ORDEN_FACTURABLE } };
  if (proveedor) filtroOrden.terceroId = proveedor.id;
  const referencia = String(factura.ordenReferencia || '').trim().toUpperCase();
  let ordenes = [];
  if (proveedor) {
    ordenes = await OrdenCompra.findAll({ where: filtroOrden, order: [['fecha', 'DESC']], limit: 50 });
  } else if (referencia) {
    // Proveedor nuevo: solo tiene sentido buscar la orden que la propia factura cita.
    ordenes = await OrdenCompra.findAll({ where: { ...filtroOrden, consecutivo: referencia }, limit: 5 });
  }
  const candidatas = ordenes.map((o) => {
    const diferencia = Math.round((Number(o.total) - factura.totales.conImpuestos) * 100) / 100;
    const coincideReferencia = !!referencia && String(o.consecutivo || '').toUpperCase() === referencia;
    return {
      id: o.id,
      consecutivo: o.consecutivo,
      fecha: o.fecha,
      tipo: o.tipo,
      total: Number(o.total),
      proyectoId: o.proyectoId,
      diferencia,
      sugerida: coincideReferencia || Math.abs(diferencia) < 1,
      coincideReferencia,
      // Lo que la orden ya tenía decidido, para precargarlo en la factura.
      aiuTotal: o.aplicaAiu
        ? Math.round(Number(o.subtotal) * ((Number(o.aiuAdministracion) + Number(o.aiuImprevistos) + Number(o.aiuUtilidad)) / 100) * 100) / 100
        : 0,
      retencion: {
        modo: o.retencionModo,
        motivo: o.retencionMotivo || '',
        detalle: o.retencionDetalle || '',
        conceptos: (Array.isArray(o.retenciones) ? o.retenciones : []).map((r) => ({ codigo: r.codigo, tarifa: r.tarifa })),
      },
    };
  });
  candidatas.sort((a, b) => Number(b.sugerida) - Number(a.sugerida));

  // Orden elegida por el usuario (si ya eligió una).
  let orden = null;
  if (datos.ordenCompraId) {
    orden = await OrdenCompra.findOne({ where: { id: datos.ordenCompraId, empresaId: empresa.id } });
    if (!orden) {
      advertencias.push({ nivel: 'bloqueo', texto: 'La orden de adquisición elegida no existe.' });
    } else {
      if (!ESTADOS_ORDEN_FACTURABLE.includes(orden.estado)) {
        advertencias.push({ nivel: 'bloqueo', texto: `La orden ${orden.consecutivo} está en estado "${orden.estado}" y no se puede facturar.` });
      }
      if (proveedor && orden.terceroId !== proveedor.id) {
        advertencias.push({ nivel: 'bloqueo', texto: `La orden ${orden.consecutivo} es de otro proveedor.` });
      }
      const dif = Math.round((Number(orden.total) - factura.totales.conImpuestos) * 100) / 100;
      if (Math.abs(dif) >= 1) {
        advertencias.push({
          nivel: 'confirmar',
          texto: `La orden ${orden.consecutivo} es por ${Number(orden.total)} y la factura por ${factura.totales.conImpuestos} (diferencia ${dif}).`,
        });
      }
    }
  }

  return { buffer, factura, empresa, proveedor, candidatas, orden, advertencias };
}

// Valores con los que se contabiliza (coherentes aunque el XML no lo sea).
function valoresContables(factura) {
  const t = factura.totales;
  const total = t.conImpuestos;
  const base = Math.round((total - t.iva - t.impoconsumo) * 100) / 100;
  return { total, iva: t.iva, impoconsumo: t.impoconsumo, base };
}

// --- 1) vista previa -------------------------------------------------

async function previsualizarFacturaXml(datos, usuario) {
  const { factura, empresa, proveedor, candidatas, orden, advertencias } = await analizar(datos, usuario);
  delete factura.xmlOriginal; // pesado e innecesario para el navegador

  if (factura.emisor && !proveedor) {
    advertencias.push({
      nivel: 'info',
      texto: `El proveedor ${factura.emisor.nombre} (NIT ${factura.emisor.nit}) no está en Terceros. Se creará al registrar la factura.`,
    });
  }

  const contable = valoresContables(factura);
  return {
    factura,
    empresa: { nit: empresa.nit, razonSocial: empresa.razonSocial, responsableIva: !!empresa.responsableIva },
    proveedor: proveedor ? { id: proveedor.id, nombre: proveedor.nombre, identificacion: proveedor.identificacion, tipo: proveedor.tipo } : null,
    ordenesCandidatas: candidatas,
    ordenSeleccionada: orden ? { id: orden.id, consecutivo: orden.consecutivo, tipo: orden.tipo, proyectoId: orden.proyectoId } : null,
    contable: { ...contable, ivaDescontable: !!empresa.responsableIva },
    retencionSugerida: sugerirRetencion(factura.emisor || {}),
    cuentasDestino: await cuentasDestinoDe(empresa.id),
    destinosSugeridos: await destinosSugeridos(empresa.id),
    advertencias,
    verificacionDianUrl: factura.cufe ? `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${factura.cufe}` : null,
  };
}

// --- 2) registro + contabilización ------------------------------------

async function registrarFacturaXml(datos, usuario) {
  const { factura, empresa, proveedor, orden, advertencias } = await analizar(datos, usuario);

  const bloqueos = advertencias.filter((a) => a.nivel === 'bloqueo');
  if (bloqueos.length) throw new Error(bloqueos.map((b) => b.texto).join(' '));
  const porConfirmar = advertencias.filter((a) => a.nivel === 'confirmar');
  if (porConfirmar.length && !datos.aceptarAdvertencias) {
    throw new Error('Hay advertencias que debes revisar y aceptar antes de registrar: ' + porConfirmar.map((a) => a.texto).join(' '));
  }

  // --- proveedor
  let terceroId;
  let crearProveedor = false;
  if (datos.terceroId) {
    const elegido = await Tercero.findOne({ where: { id: datos.terceroId, empresaId: empresa.id } });
    if (!elegido) throw new Error('El proveedor elegido no existe.');
    if (!mismoNit(elegido.identificacion, factura.emisor.nit)) {
      throw new Error('El proveedor elegido no coincide con el NIT que trae la factura.');
    }
    terceroId = elegido.id;
  } else if (proveedor) {
    terceroId = proveedor.id;
  } else if (datos.crearProveedor) {
    crearProveedor = true;
  } else {
    throw new Error('El proveedor de la factura no está en Terceros. Acepta crearlo o créalo antes.');
  }
  if (orden && crearProveedor) {
    throw new Error('La orden elegida pertenece a un proveedor que ya existe; este proveedor es nuevo.');
  }
  if (orden && terceroId && orden.terceroId !== terceroId) {
    throw new Error(`La orden ${orden.consecutivo} es de otro proveedor.`);
  }

  const contable = valoresContables(factura);
  if (!(contable.base > 0)) throw new Error('La base de la factura no es positiva; revisa los totales del XML.');

  // --- retención (misma función y catálogo que la orden de adquisición)
  const modo = datos.retencionModo;
  if (!['aplica', 'no_aplica'].includes(modo)) {
    throw new Error('Decide la retención: elige "Aplicar retención" o "No aplica retención" (con su motivo).');
  }
  const especificadas =
    modo === 'aplica' ? (Array.isArray(datos.retenciones) ? datos.retenciones : []).map((e) => retencionesCatalogo.especificar(e)) : [];
  const ret = calcularOrden.calcularRetenciones({
    base: contable.base,
    iva: contable.iva,
    aiuTotal: Number(datos.aiuTotal) > 0 ? Number(datos.aiuTotal) : 0,
    retencionModo: modo,
    retencionMotivo: datos.retencionMotivo,
    retencionDetalle: datos.retencionDetalle,
    retenciones: especificadas,
  });
  const retencionCent = centavos(ret.retencionValor);
  if (retencionCent >= centavos(contable.total)) throw new Error('La retención no puede ser igual o mayor al total de la factura.');

  // --- cuentas por línea
  const permitidas = new Set((await cuentasDestinoDe(empresa.id)).map((c) => c.codigo));
  const sugeridos = await destinosSugeridos(empresa.id);
  const porDefecto = datos.cuentaDestino || (orden && orden.tipo === 'bienes' ? sugeridos.bienes : sugeridos.gasto);
  const cuentasLinea = factura.lineas.map((l, i) => {
    const elegida = (datos.cuentasLineas && (datos.cuentasLineas[i] || datos.cuentasLineas[String(i)])) || porDefecto;
    if (!permitidas.has(elegida)) {
      throw new Error(`La cuenta ${elegida} (línea ${i + 1}) no existe o no sirve como destino de una compra.`);
    }
    return elegida;
  });

  // --- proyecto / centro de costo
  const proyectoId = datos.proyectoId || (orden && orden.proyectoId) || null;
  let centroCosto = null;
  if (proyectoId) {
    const proyecto = await Proyecto.findOne({ where: { id: proyectoId, empresaId: empresa.id } });
    if (!proyecto) throw new Error('El proyecto elegido no existe.');
    centroCosto = String(proyecto.codigo || proyecto.nombre).slice(0, 50);
  }

  // --- armado del asiento (mismo módulo que usa la vista previa del navegador)
  const ivaDescontable = !!empresa.responsableIva;
  const asientoArmado = armarAsientoCompra({
    lineas: factura.lineas,
    base: contable.base,
    iva: contable.iva,
    impoconsumo: contable.impoconsumo,
    total: contable.total,
    ivaDescontable,
    cuentasLinea,
    retenciones: ret.retenciones,
    centroCosto,
  });
  if (!asientoArmado.cuadra) throw new Error('El asiento de la factura no cuadra; revisa los valores del XML.');
  const lineasAsiento = asientoArmado.lineas.map((l) => ({
    cuentaCodigo: l.cuentaCodigo,
    ...(l.debito ? { debito: l.debito } : { credito: l.credito }),
    ...(l.centroCosto ? { centroCosto: l.centroCosto } : {}),
  }));
  const netoAPagar = asientoArmado.netoAPagar;

  // --- guardado, todo o nada
  return sequelize.transaction(async (transaction) => {
    if (crearProveedor) {
      const e = factura.emisor;
      const nuevo = await Tercero.create(
        {
          id: uuidv4(),
          empresaId: empresa.id,
          tipo: 'proveedor',
          identificacion: e.dv ? `${e.nit}-${e.dv}` : e.nit,
          nombre: String(e.nombre || e.nombreComercial || e.nit).slice(0, 150),
          tipoPersona: e.tipoPersona || undefined,
          regimenIva: e.regimenIva || undefined,
          responsabilidadesFiscales: e.responsabilidades.length ? e.responsabilidades : undefined,
          email: e.email ? e.email.slice(0, 150) : undefined,
          celular: e.telefono ? e.telefono.slice(0, 20) : undefined,
          direccion: e.direccion ? e.direccion.slice(0, 255) : undefined,
          municipio: e.municipio ? e.municipio.slice(0, 100) : undefined,
          departamento: e.departamento ? e.departamento.slice(0, 100) : undefined,
        },
        { transaction }
      );
      terceroId = nuevo.id;
    }

    const creada = await FacturaCompra.create(
      {
        id: uuidv4(),
        empresaId: empresa.id,
        terceroId,
        ordenCompraOrigenId: orden ? orden.id : null,
        proyectoId,
        fecha: factura.fechaEmision,
        fechaVencimiento: factura.fechaVencimiento || null,
        formaPago: factura.formaPago,
        numero: factura.numero,
        subtotal: contable.base,
        iva: contable.iva,
        impoconsumo: contable.impoconsumo,
        total: contable.total,
        cufe: factura.cufe,
        retencionModo: ret.retencionModo,
        retencionMotivo: ret.retencionModo === 'no_aplica' ? [ret.retencionMotivo, ret.retencionDetalle].filter(Boolean).join(' — ').slice(0, 200) : null,
        retenciones: ret.retenciones,
        retencionValor: ret.retencionValor,
        netoAPagar,
        emisorNit: factura.emisor.nit,
        emisorNombre: String(factura.emisor.nombre || '').slice(0, 200),
        detalle: {
          lineas: factura.lineas.map((l, i) => ({
            numero: l.numero,
            descripcion: l.descripcion,
            cantidad: l.cantidad,
            unidad: l.unidad,
            valorUnitario: l.valorUnitario,
            valorTotal: l.valorTotal,
            iva: l.iva,
            ivaPorcentaje: l.ivaPorcentaje,
            cuentaCodigo: cuentasLinea[i],
          })),
          impuestos: factura.impuestos,
          retencionesEmisor: factura.retencionesEmisor,
          totales: factura.totales,
          validacionDian: factura.validacionDian,
          lineasAsiento,
        },
        xmlContenido: factura.xmlOriginal || null,
        estadoConciliacion: 'pendiente',
      },
      { transaction }
    );

    const resultado = await contabilizarAsientoCompuesto({
      empresaId: empresa.id,
      tipoEvento: orden ? 'factura_compra_con_orden' : 'factura_compra_sin_orden',
      origenModulo: 'compras',
      origenId: creada.id,
      fecha: factura.fechaEmision,
      terceroId,
      usuarioId: usuario.id,
      lineas: lineasAsiento,
      revisado: true, // el usuario revisó el desglose en la vista previa
      transaction,
    });

    await creada.update(
      {
        asientoId: resultado.asiento ? resultado.asiento.id : null,
        estadoConciliacion: resultado.asiento && resultado.asiento.estado === 'contabilizado' ? 'contabilizada' : 'pendiente',
      },
      { transaction }
    );
    if (orden) await orden.update({ estado: 'facturada' }, { transaction });

    return {
      factura: await sinXml(creada),
      lineasAsiento,
      contabilizada: !!(resultado.asiento && resultado.asiento.estado === 'contabilizado'),
      requiereRevision: resultado.requiereRevision,
      periodoAjustado: resultado.periodoAjustado,
    };
  });
}

function sinXml(registro) {
  const plano = registro.toJSON();
  delete plano.xmlContenido;
  return plano;
}

// --- consulta ----------------------------------------------------------

async function obtenerFactura(id, usuario) {
  const factura = await FacturaCompra.findOne({
    where: { id, empresaId: usuario.empresaId },
    attributes: { exclude: ['xmlContenido'] },
  });
  if (!factura) return null;

  let asiento = [];
  if (factura.asientoId) {
    const movimientos = await Movimiento.findAll({ where: { asientoId: factura.asientoId } });
    const cuentas = await PlanCuentas.findAll({ where: { id: { [Op.in]: movimientos.map((m) => m.cuentaId) } } });
    const porId = Object.fromEntries(cuentas.map((c) => [c.id, c]));
    asiento = movimientos.map((m) => ({
      cuentaCodigo: porId[m.cuentaId] ? porId[m.cuentaId].codigo : '',
      cuentaNombre: porId[m.cuentaId] ? porId[m.cuentaId].nombre : '',
      debito: Number(m.debito),
      credito: Number(m.credito),
      centroCosto: m.centroCosto,
    }));
    asiento.sort((a, b) => (b.debito > 0) - (a.debito > 0) || a.cuentaCodigo.localeCompare(b.cuentaCodigo));
  }
  return { ...factura.toJSON(), asiento };
}

async function obtenerXml(id, usuario) {
  const factura = await FacturaCompra.findOne({
    where: { id, empresaId: usuario.empresaId },
    attributes: ['id', 'numero', 'xmlContenido'],
  });
  if (!factura || !factura.xmlContenido) return null;
  return { nombre: `${(factura.numero || factura.id).replace(/[^\w.-]/g, '_')}.xml`, contenido: factura.xmlContenido };
}

module.exports = {
  previsualizarFacturaXml,
  registrarFacturaXml,
  obtenerFactura,
  obtenerXml,
  // exportadas para pruebas
  _mismoNit: mismoNit,
  _repartir: repartir,
};
SCRIPTEOF
echo "OK  src/modules/compras/services/facturaXml.service.js"

cat > src/modules/compras/services/compras.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const OrdenCompra = require('../models/OrdenCompra');
const OrdenCompraItem = require('../models/OrdenCompraItem');
const FacturaCompra = require('../models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const documentoSoporteAdapter = require('../../../integrations/adapters/documentoSoporteAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { crearConSecutivoUnico } = require('../../../core/services/consecutivos');
// Mismo archivo que usa el navegador: lo que se ve al digitar es lo que se guarda.
const calcularOrden = require('../../../../public/contable/calculoOrden');
const retencionesCatalogo = require('../../../../public/contable/retencionesCatalogo');

// Lo que llega del cliente por cada retención es solo {codigo, tarifa?}
// (tarifa solo para "Otro concepto"). Nombre, tarifa oficial, tope en UVT y
// base de cálculo se toman SIEMPRE del catálogo del servidor.
function prepararDatosOrden(datos) {
  if (datos.retencionModo !== 'aplica') return { ...datos, retenciones: [] };
  const entradas = Array.isArray(datos.retenciones) ? datos.retenciones : [];
  return { ...datos, retenciones: entradas.map((e) => retencionesCatalogo.especificar(e)) };
}

// Campos de cabecera derivados del cálculo (impuestos, AIU, retención).
function camposCalculados(cabecera, datos) {
  return {
    subtotal: cabecera.subtotal,
    iva: cabecera.iva,
    impoconsumo: cabecera.impoconsumo,
    total: cabecera.total,
    aplicaAiu: cabecera.aplicaAiu,
    aiuAdministracion: cabecera.aiuAdministracion,
    aiuImprevistos: cabecera.aiuImprevistos,
    aiuUtilidad: cabecera.aiuUtilidad,
    aiuBaseIva: cabecera.aiuBaseIva,
    retencionModo: cabecera.retencionModo,
    retencionMotivo: cabecera.retencionModo === 'no_aplica' ? cabecera.retencionMotivo : null,
    retencionDetalle: cabecera.retencionModo === 'no_aplica' ? cabecera.retencionDetalle || null : null,
    retenciones: cabecera.retenciones,
    retencionValor: cabecera.retencionValor,
  };
}

async function guardarItems(ordenId, lineas, transaction) {
  for (const l of lineas) {
    await OrdenCompraItem.create(
      {
        id: uuidv4(),
        ordenCompraId: ordenId,
        concepto: l.concepto,
        cantidad: l.cantidad,
        unidadMedida: l.unidadMedida || 'UND',
        valorUnitario: l.valorUnitario,
        tipoImpuesto: l.tipoImpuesto,
        impuestoPorcentaje: l.impuestoPorcentaje,
        valorTotal: l.valorTotal,
        impuestoValor: l.impuestoValor,
      },
      { transaction }
    );
  }
}

// Crea una orden de adquisición (bienes o servicios) en "borrador". Si
// vienen "items", se crean como OrdenCompraItem y todos los totales
// (subtotal, IVA, Impoconsumo, AIU, retención) se calculan en el
// servidor con calculoOrden.js — no se confía en totales mandados a
// mano. Sin items, respeta subtotal/iva/total por compatibilidad.
async function crearOrden(datos, usuario) {
  const hayItems = Array.isArray(datos.items) && datos.items.length > 0;
  // Se calcula (y valida) ANTES de abrir la transacción: si el
  // porcentaje de retención viene mal, falla sin consumir consecutivo.
  const calculo = hayItems ? calcularOrden(prepararDatosOrden(datos)) : null;

  return crearConSecutivoUnico(OrdenCompra, usuario.empresaId, 'ODA', async (consecutivo, transaction) => {
    const orden = await OrdenCompra.create(
      {
        id: uuidv4(),
        empresaId: usuario.empresaId,
        terceroId: datos.terceroId,
        tipo: datos.tipo || 'bienes',
        consecutivo,
        fecha: datos.fecha || new Date(),
        fechaRequerida: datos.fechaRequerida,
        proyectoId: datos.proyectoId || null,
        proyecto: datos.proyecto,
        lugarEntrega: datos.lugarEntrega,
        formaPago: datos.formaPago,
        estado: 'borrador',
        subtotal: datos.subtotal || 0,
        iva: datos.iva || 0,
        total: datos.total || 0,
        ...(calculo ? camposCalculados(calculo.cabecera, datos) : {}),
      },
      { transaction }
    );

    if (calculo) await guardarItems(orden.id, calculo.lineas, transaction);

    return orden;
  });
}

// borrador/emitida -> aprobada (aprobador interno, no el proveedor)
async function aprobarOrden(id, usuario) {
  const orden = await OrdenCompra.findByPk(id);
  if (!['borrador', 'emitida'].includes(orden.estado)) {
    throw new Error('Solo se puede aprobar una orden en estado "borrador" o "emitida".');
  }
  await orden.update({ estado: 'aprobada', aprobadorId: usuario.id });
  return orden;
}

async function listarOrdenes(usuario) {
  return OrdenCompra.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

async function listarFacturas(usuario) {
  return FacturaCompra.findAll({
    where: { empresaId: usuario.empresaId },
    // El XML y el desglose pesan; solo se piden en el detalle de cada factura.
    attributes: { exclude: ['xmlContenido', 'detalle'] },
    order: [['fecha', 'DESC']],
  });
}

// Cierra manualmente una orden aprobada/recibida contra una factura que
// el usuario ya tiene en mano. Con orden de compra de por medio, el
// nivel de automatización es más alto (ver tabla de reglas del módulo).
async function convertirOrdenEnFactura(ordenId, usuario) {
  const orden = await OrdenCompra.findByPk(ordenId);

  if (!['aprobada', 'recibida_parcial', 'recibida_total'].includes(orden.estado)) {
    throw new Error('La orden debe estar aprobada o recibida para facturarse.');
  }

  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: orden.empresaId,
    terceroId: orden.terceroId,
    ordenCompraOrigenId: orden.id,
    fecha: new Date(),
    // subtotal = todo lo que no es IVA: base (ítems + AIU) más el
    // Impoconsumo, que no es descontable y se lleva como mayor valor
    // del costo/gasto. Así subtotal + iva = total siempre cuadra.
    subtotal: Number(orden.total) - Number(orden.iva),
    iva: orden.iva,
    total: orden.total,
  });

  await orden.update({ estado: 'facturada' });

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: 'factura_compra_con_orden',
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
    usuarioId: usuario?.id,
  });

  return factura;
}

// Llamado desde el webhook cuando un proveedor que sí factura
// electrónicamente emite una factura a nuestro nombre y llega vía
// RADIAN o el proveedor tecnológico. Ya viene validada ante la DIAN,
// así que se contabiliza directo (sin pasar por estado "borrador").
//
// TODO: la mecánica exacta para RECIBIR facturas vía RADIAN (o si el
// proveedor tecnológico contratado lo resuelve por su cuenta y solo nos
// avisa por webhook) todavía hay que investigarla con el proveedor
// específico que se contrate — no está 100% definida.
async function registrarFacturaRecibida(datos) {
  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: datos.empresaId,
    terceroId: datos.terceroId,
    ordenCompraOrigenId: datos.ordenCompraOrigenId || null,
    fecha: datos.fecha || new Date(),
    subtotal: datos.subtotal,
    iva: datos.iva || 0,
    total: datos.total,
    cufe: datos.cufe,
    xmlUrl: datos.xmlUrl,
    estadoConciliacion: 'contabilizada',
  });

  // Sin orden de compra de por medio, nivel de automatización más bajo
  // (nivel 2: exige clasificar costo vs. gasto — ver tabla de reglas).
  const evento = factura.ordenCompraOrigenId
    ? 'factura_compra_con_orden'
    : 'factura_compra_sin_orden';

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: evento,
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
  });

  return factura;
}

// El documento soporte lo EMITE el propio comprador (nuestro cliente),
// porque el proveedor no está obligado a facturar. Flujo simétrico al
// de ventas: se envía al proveedor tecnológico y solo se contabiliza
// cuando confirma (ver confirmarDocumentoSoporteEmitido).
async function emitirDocumentoSoporte(datos, usuario) {
  const documento = await DocumentoSoporteAdquisicion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    fecha: datos.fecha || new Date(),
    concepto: datos.concepto,
    valor: datos.valor,
    estadoSincronizacion: 'pendiente',
  });

  const respuesta = await documentoSoporteAdapter.emitirDocumentoSoporte(documento);

  await documento.update({
    idTransaccionExterna: respuesta.idTransaccionExterna,
    estadoSincronizacion: 'enviado',
  });

  return documento;
}

// Llamado desde el webhook cuando el proveedor tecnológico confirma que
// la DIAN validó nuestro documento soporte.
async function confirmarDocumentoSoporteEmitido(documentoId, datosProveedor) {
  const documento = await DocumentoSoporteAdquisicion.findByPk(documentoId);

  await documento.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
  });

  // La primera vez por proveedor exige clasificar la cuenta (nivel 2);
  // ver la regla 'documento_soporte_compra' y su memorización por tercero.
  await contabilizarEvento({
    empresaId: documento.empresaId,
    tipoEvento: 'documento_soporte_compra',
    origenModulo: 'compras',
    origenId: documento.id,
    valor: documento.valor,
    terceroId: documento.terceroId,
  });

  return documento;
}

// Orden con sus ítems — para "Ver ítems", "Editar" y el PDF.
async function obtenerOrden(id, usuario) {
  const orden = await OrdenCompra.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!orden) return null;

  const items = await OrdenCompraItem.findAll({ where: { ordenCompraId: id } });
  const datos = orden.toJSON();

  // Desglose listo para mostrar (valores del AIU en pesos, base,
  // retención y neto a pagar). Se recalcula con los mismos datos
  // guardados; "modo formulario" para no fallar con órdenes viejas que
  // no tienen nada de esto.
  // Las retenciones se calculan con la foto guardada (no con el catálogo
  // vigente), para que una orden vieja no cambie al actualizar tarifas.
  const { cabecera, netoAPagar } = calcularOrden(
    { ...datos, items: items.map((i) => i.toJSON()), retenciones: datos.retenciones || [] },
    { estricto: false }
  );
  // Órdenes anteriores a los ítems/AIU/retención conservan sus totales guardados.
  const calculo = items.length > 0 ? { ...cabecera, netoAPagar } : null;

  return { ...datos, items, calculo };
}

// Edita una orden — solo mientras sigue en "borrador", mismo criterio
// y misma mecánica (reemplaza todos los ítems dentro de una
// transacción) que actualizarCotizacion en ventas.service.js.
async function actualizarOrden(id, datos, usuario) {
  const orden = await OrdenCompra.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!orden) return null;

  if (orden.estado !== 'borrador') {
    throw new Error('Solo se puede editar una orden en estado "borrador".');
  }

  const calculo = calcularOrden(prepararDatosOrden(datos));

  return sequelize.transaction(async (transaction) => {
    await orden.update(
      {
        terceroId: datos.terceroId,
        tipo: datos.tipo || 'bienes',
        fechaRequerida: datos.fechaRequerida,
        proyectoId: datos.proyectoId || null,
        proyecto: datos.proyecto,
        lugarEntrega: datos.lugarEntrega,
        formaPago: datos.formaPago,
        ...camposCalculados(calculo.cabecera, datos),
      },
      { transaction }
    );

    await OrdenCompraItem.destroy({ where: { ordenCompraId: id }, transaction });
    await guardarItems(id, calculo.lineas, transaction);

    return orden;
  });
}

module.exports = {
  crearOrden,
  aprobarOrden,
  listarOrdenes,
  listarFacturas,
  obtenerOrden,
  actualizarOrden,
  convertirOrdenEnFactura,
  registrarFacturaRecibida,
  emitirDocumentoSoporte,
  confirmarDocumentoSoporteEmitido,
};
SCRIPTEOF
echo "OK  src/modules/compras/services/compras.service.js"

cat > src/modules/compras/controllers/compras.controller.js << 'SCRIPTEOF'
const { mensajeError } = require('../../../core/utils/mensajeError');
const comprasService = require('../services/compras.service');
const facturaXmlService = require('../services/facturaXml.service');

async function crearOrden(req, res) {
  try {
    const orden = await comprasService.crearOrden(req.body, req.usuario);
    res.status(201).json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function aprobarOrden(req, res) {
  try {
    const orden = await comprasService.aprobarOrden(req.params.id, req.usuario);
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function convertirOrden(req, res) {
  try {
    const factura = await comprasService.convertirOrdenEnFactura(
      req.params.ordenId,
      req.usuario
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function emitirDocumentoSoporte(req, res) {
  try {
    const documento = await comprasService.emitirDocumentoSoporte(req.body, req.usuario);
    res.status(201).json(documento);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function listarOrdenes(req, res) {
  try {
    const ordenes = await comprasService.listarOrdenes(req.usuario);
    res.json(ordenes);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function listarFacturas(req, res) {
  try {
    const facturas = await comprasService.listarFacturas(req.usuario);
    res.json(facturas);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function obtenerOrden(req, res) {
  try {
    const orden = await comprasService.obtenerOrden(req.params.id, req.usuario);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function actualizarOrden(req, res) {
  try {
    const orden = await comprasService.actualizarOrden(req.params.id, req.body, req.usuario);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function previsualizarFacturaXml(req, res) {
  try {
    res.json(await facturaXmlService.previsualizarFacturaXml(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function registrarFacturaXml(req, res) {
  try {
    res.status(201).json(await facturaXmlService.registrarFacturaXml(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function obtenerFactura(req, res) {
  try {
    const factura = await facturaXmlService.obtenerFactura(req.params.id, req.usuario);
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada.' });
    res.json(factura);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function descargarXmlFactura(req, res) {
  try {
    const xml = await facturaXmlService.obtenerXml(req.params.id, req.usuario);
    if (!xml) return res.status(404).json({ error: 'Esta factura no tiene un XML guardado.' });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${xml.nombre}"`);
    res.send(xml.contenido);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

module.exports = {
  previsualizarFacturaXml,
  registrarFacturaXml,
  obtenerFactura,
  descargarXmlFactura,
  crearOrden,
  aprobarOrden,
  convertirOrden,
  emitirDocumentoSoporte,
  listarOrdenes,
  listarFacturas,
  obtenerOrden,
  actualizarOrden,
};
SCRIPTEOF
echo "OK  src/modules/compras/controllers/compras.controller.js"

cat > src/modules/compras/routes/compras.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const comprasController = require('../controllers/compras.controller');

// GET /api/compras/ordenes
router.get('/ordenes', comprasController.listarOrdenes);

// GET /api/compras/facturas
router.get('/facturas', comprasController.listarFacturas);

// POST /api/compras/facturas/xml/previsualizar  (lee el XML, no guarda nada)
router.post('/facturas/xml/previsualizar', comprasController.previsualizarFacturaXml);

// POST /api/compras/facturas/xml  (registra y contabiliza la factura del proveedor)
router.post('/facturas/xml', comprasController.registrarFacturaXml);

// GET /api/compras/facturas/:id  (detalle + asiento)
router.get('/facturas/:id', comprasController.obtenerFactura);

// GET /api/compras/facturas/:id/xml  (descarga el XML guardado)
router.get('/facturas/:id/xml', comprasController.descargarXmlFactura);

// POST /api/compras/ordenes
router.post('/ordenes', comprasController.crearOrden);

// GET /api/compras/ordenes/:id (detalle con ítems)
router.get('/ordenes/:id', comprasController.obtenerOrden);

// PATCH /api/compras/ordenes/:id (editar — solo en borrador)
router.patch('/ordenes/:id', comprasController.actualizarOrden);

// PATCH /api/compras/ordenes/:id/aprobar
router.patch('/ordenes/:id/aprobar', comprasController.aprobarOrden);

// POST /api/compras/ordenes/:ordenId/convertir
router.post('/ordenes/:ordenId/convertir', comprasController.convertirOrden);

// POST /api/compras/documento-soporte
router.post('/documento-soporte', comprasController.emitirDocumentoSoporte);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/compras/routes/compras.routes.js"

cat > src/modules/compras/models/FacturaCompra.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Facturas RECIBIDAS de proveedores que sí facturan electrónicamente.
// A diferencia de FacturaVenta (que nosotros emitimos), esta llega desde
// afuera — vía RADIAN o el proveedor tecnológico — ya validada ante la
// DIAN por quien la emitió. Ver src/integrations/webhooks para el
// detalle de cómo llega.
const FacturaCompra = sequelize.define('FacturaCompra', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor
  ordenCompraOrigenId: { type: DataTypes.UUID }, // nulo si no hubo orden previa
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  cufe: { type: DataTypes.STRING(100) },
  xmlUrl: { type: DataTypes.STRING(255) },

  // --- Factura cargada desde el XML del proveedor ---
  // Número impreso de la factura (prefijo + consecutivo, ej. "SETP990000123").
  numero: { type: DataTypes.STRING(40) },
  fechaVencimiento: { type: DataTypes.DATEONLY },
  formaPago: { type: DataTypes.STRING(20) }, // 'contado' | 'credito'
  // Impoconsumo y demás impuestos que no son IVA: mayor valor del gasto.
  impoconsumo: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Retención practicada por nosotros (foto al momento de registrar).
  retencionModo: { type: DataTypes.STRING(20) }, // 'aplica' | 'no_aplica'
  retencionMotivo: { type: DataTypes.STRING(200) },
  retenciones: { type: DataTypes.JSON },
  retencionValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Lo que realmente se le paga al proveedor: total - retenciones.
  netoAPagar: { type: DataTypes.DECIMAL(15, 2) },
  // Datos del emisor tal como venían en el XML (el tercero puede cambiar después).
  emisorNit: { type: DataTypes.STRING(20) },
  emisorNombre: { type: DataTypes.STRING(200) },
  // Desglose de la factura (líneas + cuenta a la que se llevó cada una).
  detalle: { type: DataTypes.JSON },
  asientoId: { type: DataTypes.UUID },
  proyectoId: { type: DataTypes.UUID },
  // El XML original queda guardado como soporte de la compra.
  xmlContenido: { type: DataTypes.TEXT('long') },
  estadoConciliacion: {
    type: DataTypes.ENUM('pendiente', 'contabilizada', 'objetada'),
    defaultValue: 'pendiente',
  },
}, {
  tableName: 'facturas_compra',
  indexes: [{ fields: ['empresa_id', 'cufe'] }],
});

module.exports = FacturaCompra;
SCRIPTEOF
echo "OK  src/modules/compras/models/FacturaCompra.js"

cat > src/core/services/motorAsientos.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const Asiento = require('../models/Asiento');
const Movimiento = require('../models/Movimiento');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');
const PeriodoContable = require('../models/PeriodoContable');
const PlanCuentas = require('../models/PlanCuentas');

// Resuelve el periodo contable vigente de la empresa (abierto o en_cierre)
// para que ningún módulo operativo tenga que averiguarlo por su cuenta.
// Requiere que exista al menos un PeriodoContable creado de antemano —
// sin eso, ningún evento se puede contabilizar (a propósito).
async function obtenerPeriodoVigente(empresaId) {
  const periodo = await PeriodoContable.findOne({
    where: { empresaId, estado: { [Op.in]: ['abierto', 'en_cierre'] } },
    order: [['fechaInicio', 'DESC']],
  });

  if (!periodo) {
    throw new Error(
      'No hay un periodo contable abierto para esta empresa. Crea uno antes de contabilizar.'
    );
  }

  return periodo;
}

/**
 * Punto de entrada único que usan TODOS los módulos operativos
 * (ventas, compras, nómina, activos fijos, tesorería) para contabilizar
 * un evento. Ningún módulo escribe asientos directamente.
 *
 * @param {Object} evento
 * @param {string} evento.empresaId
 * @param {string} [evento.periodoContableId] - si no se pasa, se resuelve solo
 * @param {string} evento.tipoEvento     - ej: 'factura_venta_credito'
 * @param {string} evento.origenModulo   - 'ventas' | 'compras' | 'nomina' | ...
 * @param {string} evento.origenId       - id del documento que originó el evento
 * @param {number} evento.valor
 * @param {string} [evento.terceroId]
 * @param {string} [evento.usuarioId]
 */
async function contabilizarEvento(evento) {
  const regla = await ReglaContabilizacion.findOne({
    where: { empresaId: evento.empresaId, eventoOrigen: evento.tipoEvento },
  });

  if (!regla) {
    throw new Error(
      `No existe regla de contabilización para el evento "${evento.tipoEvento}". ` +
      `Configúrala en Plan de cuentas > Reglas antes de continuar.`
    );
  }

  // Nivel "manual" nunca se contabiliza solo: queda en cola para el contador.
  if (regla.nivelAutomatizacion === 'manual') {
    return { requiereRevision: true, regla };
  }

  const periodoContableId =
    evento.periodoContableId || (await obtenerPeriodoVigente(evento.empresaId)).id;

  const asiento = await Asiento.create({
    id: uuidv4(),
    empresaId: evento.empresaId,
    periodoContableId,
    fecha: evento.fecha || new Date(),
    origenModulo: evento.origenModulo,
    origenId: evento.origenId,
    estado: regla.nivelAutomatizacion === 'asistido' ? 'borrador' : 'contabilizado',
    usuarioId: evento.usuarioId,
  });

  await Movimiento.bulkCreate([
    {
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: regla.cuentaDebitoId,
      terceroId: evento.terceroId,
      debito: evento.valor,
      credito: 0,
    },
    {
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: regla.cuentaCreditoId,
      terceroId: evento.terceroId,
      debito: 0,
      credito: evento.valor,
    },
  ]);

  return { requiereRevision: regla.nivelAutomatizacion === 'asistido', asiento };
}

const centavos = (n) => Math.round((Number(n) + Number.EPSILON) * 100);

// Periodo abierto que contiene la fecha del documento. Si no hay (la
// factura es de un mes ya cerrado o aún no creado), se usa el periodo
// vigente con fecha de hoy y se avisa con `ajustada: true`: nunca se
// escribe en un periodo cerrado.
async function resolverPeriodoParaFecha(empresaId, fecha, transaction) {
  if (fecha) {
    const exacto = await PeriodoContable.findOne({
      where: {
        empresaId,
        estado: { [Op.in]: ['abierto', 'en_cierre'] },
        fechaInicio: { [Op.lte]: fecha },
        fechaFin: { [Op.gte]: fecha },
      },
      transaction,
    });
    if (exacto) return { periodo: exacto, fecha, ajustada: false };
  }
  const vigente = await PeriodoContable.findOne({
    where: { empresaId, estado: { [Op.in]: ['abierto', 'en_cierre'] } },
    order: [['fechaInicio', 'DESC']],
    transaction,
  });
  if (!vigente) {
    throw new Error('No hay un periodo contable abierto para esta empresa. Crea uno antes de contabilizar.');
  }
  return { periodo: vigente, fecha: new Date().toISOString().slice(0, 10), ajustada: !!fecha };
}

// Cuentas por código. Si falta una de las cuentas base del sistema
// (empresas creadas antes de que existiera, ej. 2365 retención), se crea
// al vuelo; cualquier otro código inexistente es un error.
async function cuentasPorCodigo(empresaId, codigos, transaction) {
  const unicos = Array.from(new Set(codigos));
  const existentes = await PlanCuentas.findAll({ where: { empresaId, codigo: { [Op.in]: unicos } }, transaction });
  const mapa = Object.fromEntries(existentes.map((c) => [c.codigo, c]));

  for (const codigo of unicos) {
    if (mapa[codigo]) continue;
    // require diferido: seedService requiere modelos, no queremos ciclos al cargar.
    const base = require('./seedService').CUENTAS.find((c) => c.codigo === codigo);
    if (!base) throw new Error(`La cuenta ${codigo} no existe en el plan de cuentas.`);
    mapa[codigo] = await PlanCuentas.create(
      {
        id: uuidv4(),
        empresaId,
        codigo: base.codigo,
        nombre: base.nombre,
        naturaleza: base.naturaleza,
        nivel: 1,
        elementoNiif: base.elementoNiif,
      },
      { transaction }
    );
  }
  return mapa;
}

/**
 * Asiento de VARIAS líneas (a diferencia de contabilizarEvento, que solo
 * hace un débito y un crédito). Lo usan los documentos que ya traen su
 * desglose: una factura de compra con gasto + IVA descontable + proveedor
 * + retenciones, por ejemplo.
 *
 * La regla del evento sigue mandando sobre el nivel de automatización:
 *   - 'manual'    no se contabiliza; queda para el contador.
 *   - 'asistido'  el asiento queda en borrador, salvo que quien llama ya
 *                 revisó el desglose (`revisado: true`), como en la vista
 *                 previa de la factura XML.
 *   - 'automatico' se contabiliza.
 *
 * @param {Object} evento
 * @param {Array<{cuentaCodigo:string, debito?:number, credito?:number, terceroId?:string, centroCosto?:string}>} evento.lineas
 * @param {string} [evento.fecha]       'YYYY-MM-DD' del documento
 * @param {boolean} [evento.revisado]
 * @param {Object} [evento.transaction]
 */
async function contabilizarAsientoCompuesto(evento) {
  const { transaction } = evento;
  const regla = await ReglaContabilizacion.findOne({
    where: { empresaId: evento.empresaId, eventoOrigen: evento.tipoEvento },
    transaction,
  });
  if (!regla) {
    throw new Error(
      `No existe regla de contabilización para el evento "${evento.tipoEvento}". ` +
        `Configúrala en Plan de cuentas > Reglas antes de continuar.`
    );
  }
  if (regla.nivelAutomatizacion === 'manual') {
    return { requiereRevision: true, regla, asiento: null, periodoAjustado: false };
  }

  const lineas = (evento.lineas || [])
    .map((l) => ({ ...l, debito: centavos(l.debito || 0), credito: centavos(l.credito || 0) }))
    .filter((l) => l.debito !== 0 || l.credito !== 0);
  if (lineas.some((l) => l.debito < 0 || l.credito < 0 || (l.debito > 0 && l.credito > 0))) {
    throw new Error('Cada línea del asiento debe tener solo débito o solo crédito, y no negativos.');
  }
  const totalDebito = lineas.reduce((s, l) => s + l.debito, 0);
  const totalCredito = lineas.reduce((s, l) => s + l.credito, 0);
  if (lineas.length < 2 || totalDebito !== totalCredito) {
    throw new Error(
      `El asiento no cuadra: débitos ${(totalDebito / 100).toFixed(2)} vs créditos ${(totalCredito / 100).toFixed(2)}.`
    );
  }

  const cuentas = await cuentasPorCodigo(evento.empresaId, lineas.map((l) => l.cuentaCodigo), transaction);
  const { periodo, fecha, ajustada } = await resolverPeriodoParaFecha(evento.empresaId, evento.fecha, transaction);

  const asiento = await Asiento.create(
    {
      id: uuidv4(),
      empresaId: evento.empresaId,
      periodoContableId: periodo.id,
      fecha,
      origenModulo: evento.origenModulo,
      origenId: evento.origenId,
      estado: regla.nivelAutomatizacion === 'asistido' && !evento.revisado ? 'borrador' : 'contabilizado',
      usuarioId: evento.usuarioId,
    },
    { transaction }
  );

  await Movimiento.bulkCreate(
    lineas.map((l) => ({
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: cuentas[l.cuentaCodigo].id,
      terceroId: l.terceroId || evento.terceroId,
      debito: l.debito / 100,
      credito: l.credito / 100,
      centroCosto: l.centroCosto || null,
    })),
    { transaction }
  );

  return { requiereRevision: asiento.estado === 'borrador', regla, asiento, periodoAjustado: ajustada };
}

module.exports = { contabilizarEvento, contabilizarAsientoCompuesto };
SCRIPTEOF
echo "OK  src/core/services/motorAsientos.js"

cat > src/core/services/seedService.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const Empresa = require('../models/Empresa');
const PeriodoContable = require('../models/PeriodoContable');
const PlanCuentas = require('../models/PlanCuentas');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');

// Mismo id que ya usamos para crear el usuario de prueba — mantiene
// todo conectado sin tener que recrear nada de lo ya probado.
const EMPRESA_SEED_ID = '11111111-1111-1111-1111-111111111111';

// Catálogo mínimo de cuentas. Usa códigos de referencia del PUC
// (Decreto 2650) porque es lo que la mayoría del mercado colombiano
// reconoce, aunque el marco de Grupo 3 no exige este PUC específico.
const CUENTAS = [
  { codigo: '1105', nombre: 'Caja', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1110', nombre: 'Bancos', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1305', nombre: 'Clientes', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1355', nombre: 'IVA descontable', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1399', nombre: 'Deterioro acumulado de clientes', naturaleza: 'credito', elementoNiif: 'activo' },
  { codigo: '1435', nombre: 'Inventarios', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1524', nombre: 'Equipo de oficina', naturaleza: 'debito', elementoNiif: 'activo' },
  { codigo: '1592', nombre: 'Depreciación acumulada', naturaleza: 'credito', elementoNiif: 'activo' },
  { codigo: '2205', nombre: 'Proveedores nacionales', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2335', nombre: 'Costos y gastos por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2365', nombre: 'Retención en la fuente por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2367', nombre: 'Impuesto a las ventas retenido (ReteIVA) por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2370', nombre: 'Retenciones y aportes de nómina por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2408', nombre: 'IVA por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2505', nombre: 'Salarios por pagar', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '2610', nombre: 'Provisión para prestaciones sociales', naturaleza: 'credito', elementoNiif: 'pasivo' },
  { codigo: '3605', nombre: 'Utilidad del ejercicio', naturaleza: 'credito', elementoNiif: 'patrimonio' },
  { codigo: '4135', nombre: 'Comercio al por mayor y al por menor', naturaleza: 'credito', elementoNiif: 'ingreso' },
  { codigo: '5105', nombre: 'Gastos de personal', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5160', nombre: 'Depreciación', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5195', nombre: 'Diversos (administración)', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5199', nombre: 'Provisiones', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '5305', nombre: 'Gastos bancarios', naturaleza: 'debito', elementoNiif: 'gasto' },
  { codigo: '6135', nombre: 'Costo de ventas', naturaleza: 'debito', elementoNiif: 'costo' },
];

// Reglas por defecto para los eventos de los seis módulos operativos
// (Ventas, Compras, Nómina, Inventarios, Activos Fijos, Tesorería).
//
// NOTA: el motor de asientos hoy solo soporta un débito y un crédito
// por evento — por eso estas reglas no discriminan IVA por separado
// (ej. la venta debería tocar también 2408 IVA por pagar). Soportar
// múltiples líneas por evento queda como mejora pendiente.
const REGLAS = [
  { eventoOrigen: 'factura_venta_credito', debito: '1305', credito: '4135', nivel: 'automatico' },
  { eventoOrigen: 'factura_venta_contado', debito: '1110', credito: '4135', nivel: 'automatico' },
  { eventoOrigen: 'factura_compra_con_orden', debito: '1435', credito: '2205', nivel: 'automatico' },
  { eventoOrigen: 'factura_compra_sin_orden', debito: '5195', credito: '2205', nivel: 'asistido' },
  { eventoOrigen: 'documento_soporte_compra', debito: '5195', credito: '2335', nivel: 'asistido' },
  { eventoOrigen: 'nomina_devengado', debito: '5105', credito: '2505', nivel: 'automatico' },
  { eventoOrigen: 'provision_prestaciones', debito: '5105', credito: '2610', nivel: 'automatico' },
  { eventoOrigen: 'salida_inventario_venta', debito: '6135', credito: '1435', nivel: 'automatico' },
  { eventoOrigen: 'ajuste_inventario', debito: '5199', credito: '1435', nivel: 'manual' },
  { eventoOrigen: 'compra_activo_fijo', debito: '1524', credito: '2205', nivel: 'asistido' },
  { eventoOrigen: 'depreciacion_mensual', debito: '5160', credito: '1592', nivel: 'automatico' },
  { eventoOrigen: 'baja_activo_fijo', debito: '1592', credito: '1524', nivel: 'manual' },
  { eventoOrigen: 'gasto_bancario', debito: '5305', credito: '1110', nivel: 'automatico' },
];

// Seguro de correr más de una vez: usa findOrCreate en cada paso, así
// que repetirlo no duplica nada, solo confirma que todo sigue en su sitio.
async function ejecutarSeed() {
  const resultado = { empresaId: null, periodoId: null, cuentas: 0, reglas: 0 };

  const [empresa] = await Empresa.findOrCreate({
    where: { id: EMPRESA_SEED_ID },
    defaults: {
      id: EMPRESA_SEED_ID,
      nit: '900123456-1',
      razonSocial: 'Empresa de prueba S.A.S.',
      regimenTributario: 'ordinario',
      responsableIva: true,
    },
  });
  resultado.empresaId = empresa.id;

  const hoy = new Date();
  const fechaInicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fechaFin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);

  const [periodo] = await PeriodoContable.findOrCreate({
    where: { empresaId: empresa.id, fechaInicio },
    defaults: {
      id: uuidv4(),
      empresaId: empresa.id,
      fechaInicio,
      fechaFin,
      estado: 'abierto',
    },
  });
  resultado.periodoId = periodo.id;

  const cuentaIdPorCodigo = {};
  for (const c of CUENTAS) {
    const [cuenta] = await PlanCuentas.findOrCreate({
      where: { empresaId: empresa.id, codigo: c.codigo },
      defaults: {
        id: uuidv4(),
        empresaId: empresa.id,
        codigo: c.codigo,
        nombre: c.nombre,
        naturaleza: c.naturaleza,
        nivel: 1,
        elementoNiif: c.elementoNiif,
      },
    });
    cuentaIdPorCodigo[c.codigo] = cuenta.id;
    resultado.cuentas += 1;
  }

  for (const r of REGLAS) {
    await ReglaContabilizacion.findOrCreate({
      where: { empresaId: empresa.id, eventoOrigen: r.eventoOrigen },
      defaults: {
        id: uuidv4(),
        empresaId: empresa.id,
        eventoOrigen: r.eventoOrigen,
        cuentaDebitoId: cuentaIdPorCodigo[r.debito],
        cuentaCreditoId: cuentaIdPorCodigo[r.credito],
        nivelAutomatizacion: r.nivel,
      },
    });
    resultado.reglas += 1;
  }

  return resultado;
}

module.exports = { ejecutarSeed, EMPRESA_SEED_ID, CUENTAS };
SCRIPTEOF
echo "OK  src/core/services/seedService.js"

cat > public/contable/calculoOrden.js << 'SCRIPTEOF'
// Cálculo de totales de una orden de adquisición.
//
// UNA sola fuente de verdad: este mismo archivo lo usan
//   - el navegador (formulario de la orden y PDF), cargado con <script src>
//   - el backend (compras.service.js), con require()
// así lo que el usuario ve mientras digita es exactamente lo que se
// guarda. Vive en public/ para que el navegador pueda pedirlo; no
// depende de nada, ni de Node ni del DOM.
//
// Reglas:
//  - Subtotal = suma de (cantidad × valor unitario) de los ítems.
//  - AIU (Administración, Imprevistos, Utilidad): solo aplica en
//    órdenes de SERVICIOS. Cada porcentaje se calcula sobre el subtotal.
//  - IVA sin AIU: suma del IVA de cada ítem tipo "iva".
//  - IVA con AIU: 19% sobre (subtotal + AIU), o solo sobre la Utilidad
//    si aiuBaseIva === 'utilidad' (régimen especial de ciertos servicios).
//    Con AIU se ignora el IVA individual de los ítems (convención común
//    en contratos de obra/servicios).
//  - Impoconsumo: suma del impuesto de los ítems tipo "impoconsumo".
//  - Retención en la fuente: informativa para el proveedor. No se suma al
//    total: se resta para obtener el neto a pagar. Tres modos:
//      'ninguna'   no se menciona retención
//      'aplica'    una o varias líneas, cada una con su concepto ya
//                  "especificado" (ver retencionesCatalogo.especificar):
//                  tarifa, sobre qué se aplica (subtotal+AIU, solo AIU o el
//                  IVA) y tope mínimo en UVT. Si la base de la línea no
//                  alcanza el tope, esa línea no retiene (valor 0).
//      'no_aplica' el proveedor no está sujeto (Régimen Simple, tratamiento
//                  especial, bajo el tope...). Exige un motivo, que se imprime.
//    Este archivo NO conoce el catálogo de conceptos: recibe las líneas ya
//    resueltas, así una orden guardada no cambia si el catálogo se actualiza.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.calcularOrden = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const TARIFA_IVA_GENERAL = 19;

  function redondear(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  }

  // Retención en la fuente sobre una operación ya calculada. Se usa en la
  // orden de adquisición y también al registrar la factura del proveedor
  // (con los valores reales del XML), para que ambas apliquen exactamente
  // las mismas reglas.
  //   ctx.base      subtotal + AIU antes de impuestos
  //   ctx.iva       IVA de la operación (base de ReteIVA)
  //   ctx.aiuTotal  valor del AIU (base de los conceptos "sobre AIU")
  function calcularRetenciones(ctx, estricto) {
    if (estricto === undefined) estricto = true;
    const base = numero(ctx.base);
    const iva = numero(ctx.iva);
    const aiuTotal = numero(ctx.aiuTotal);

    const retencionModo = ['aplica', 'no_aplica'].includes(ctx.retencionModo) ? ctx.retencionModo : 'ninguna';
    const retencionMotivo = retencionModo === 'no_aplica' ? String(ctx.retencionMotivo || '').trim() : '';
    const retencionDetalle = retencionModo === 'no_aplica' ? String(ctx.retencionDetalle || '').trim() : '';

    if (estricto && retencionModo === 'no_aplica' && !retencionMotivo) {
      throw new Error('Indica el motivo por el cual no aplica la retención en la fuente.');
    }

    let retenciones = [];
    if (retencionModo === 'aplica') {
      const entradas = Array.isArray(ctx.retenciones) ? ctx.retenciones : [];
      if (estricto && entradas.length === 0) {
        throw new Error('Agrega al menos un concepto de retención, o elige "No aplica retención".');
      }
      retenciones = entradas.map((r) => {
        const tarifa = numero(r.tarifa);
        const uvt = numero(r.uvt);
        const uvtValor = numero(r.uvtValor);
        const sobre = ['aiu', 'iva'].includes(r.sobre) ? r.sobre : 'base';
        if (estricto && (!r.codigo || !(tarifa > 0 && tarifa <= 100))) {
          throw new Error('Cada retención necesita un concepto con tarifa mayor a 0 y máximo 100.');
        }

        // Valor sobre el que se aplica la tarifa de este concepto.
        const baseLinea = sobre === 'aiu' ? aiuTotal : sobre === 'iva' ? iva : base;
        // El tope (en UVT) siempre se mide contra la base de la operación
        // (subtotal + AIU antes de impuestos), también en ReteIVA.
        const baseMinima = redondear(uvt * uvtValor);
        const alcanzaTope = base >= baseMinima;

        let nota = '';
        if (!r.codigo) nota = '';
        else if (sobre === 'aiu' && aiuTotal === 0) nota = 'Este concepto se calcula sobre el AIU: discrimínalo en la orden.';
        else if (!alcanzaTope) nota = 'La base no alcanza el tope mínimo: no se practica esta retención.';

        const aplica = !!r.codigo && alcanzaTope && baseLinea > 0;
        return {
          codigo: r.codigo || '',
          nombre: r.nombre || '',
          tarifa,
          sobre,
          uvt,
          uvtValor,
          base: baseLinea,
          baseMinima,
          aplica,
          valor: aplica ? redondear(baseLinea * (tarifa / 100)) : 0,
          nota,
        };
      });
    }
    const retencionValor = redondear(retenciones.reduce((s, r) => s + r.valor, 0));
    return { retencionModo, retencionMotivo, retencionDetalle, retenciones, retencionValor };
  }

  // opciones.estricto (por defecto true): con true, datos inválidos
  // lanzan Error (lo que quiere el backend antes de guardar). Con false
  // se ignoran y se calcula con lo que haya (lo que quiere el formulario
  // mientras la persona todavía está digitando).
  function calcularOrden(datos, opciones) {
    const estricto = !opciones || opciones.estricto !== false;
    const tipo = datos.tipo || 'bienes';

    const lineas = (Array.isArray(datos.items) ? datos.items : []).map((item, i) => {
      const cantidad = numero(item.cantidad);
      const valorUnitario = numero(item.valorUnitario);
      if (estricto && (cantidad < 0 || valorUnitario < 0)) {
        throw new Error(`Ítem ${i + 1}: cantidad y valor unitario no pueden ser negativos.`);
      }
      const tipoImpuesto = item.tipoImpuesto || 'iva';
      const impuestoPorcentaje =
        tipoImpuesto === 'exento' ? 0 : numero(item.impuestoPorcentaje ?? TARIFA_IVA_GENERAL);
      const valorTotal = redondear(cantidad * valorUnitario);
      const impuestoValor = redondear(valorTotal * (impuestoPorcentaje / 100));
      return { ...item, cantidad, valorUnitario, tipoImpuesto, impuestoPorcentaje, valorTotal, impuestoValor };
    });

    const subtotal = redondear(lineas.reduce((s, l) => s + l.valorTotal, 0));

    // --- AIU (solo servicios) ---
    const aplicaAiu = tipo === 'servicios' && !!datos.aplicaAiu;
    const aiuAdministracion = aplicaAiu ? numero(datos.aiuAdministracion) : 0;
    const aiuImprevistos = aplicaAiu ? numero(datos.aiuImprevistos) : 0;
    const aiuUtilidad = aplicaAiu ? numero(datos.aiuUtilidad) : 0;
    if (estricto && [aiuAdministracion, aiuImprevistos, aiuUtilidad].some((p) => p < 0 || p > 100)) {
      throw new Error('Los porcentajes del AIU deben estar entre 0 y 100.');
    }
    const aiuAdministracionValor = redondear(subtotal * (aiuAdministracion / 100));
    const aiuImprevistosValor = redondear(subtotal * (aiuImprevistos / 100));
    const aiuUtilidadValor = redondear(subtotal * (aiuUtilidad / 100));
    const aiuBaseIva = datos.aiuBaseIva === 'utilidad' ? 'utilidad' : 'total';

    // Base antes de impuestos: subtotal + AIU (el AIU es 0 si no aplica).
    const base = redondear(subtotal + aiuAdministracionValor + aiuImprevistosValor + aiuUtilidadValor);

    // --- Impuestos ---
    let iva;
    if (aplicaAiu) {
      const baseIva = aiuBaseIva === 'utilidad' ? aiuUtilidadValor : base;
      iva = redondear(baseIva * (TARIFA_IVA_GENERAL / 100));
    } else {
      iva = redondear(lineas.filter((l) => l.tipoImpuesto === 'iva').reduce((s, l) => s + l.impuestoValor, 0));
    }
    const impoconsumo = redondear(
      lineas.filter((l) => l.tipoImpuesto === 'impoconsumo').reduce((s, l) => s + l.impuestoValor, 0)
    );

    const total = redondear(base + iva + impoconsumo);

    // --- Retención en la fuente ---
    const aiuTotal = redondear(aiuAdministracionValor + aiuImprevistosValor + aiuUtilidadValor);
    const ret = calcularRetenciones(
      {
        base,
        iva,
        aiuTotal,
        retencionModo: datos.retencionModo,
        retencionMotivo: datos.retencionMotivo,
        retencionDetalle: datos.retencionDetalle,
        retenciones: datos.retenciones,
      },
      estricto
    );
    const { retencionModo, retencionMotivo, retencionDetalle, retenciones, retencionValor } = ret;

    return {
      lineas,
      cabecera: {
        subtotal,
        iva,
        impoconsumo,
        total,
        aplicaAiu,
        aiuAdministracion,
        aiuImprevistos,
        aiuUtilidad,
        aiuAdministracionValor,
        aiuImprevistosValor,
        aiuUtilidadValor,
        aiuBaseIva,
        base,
        aiuTotal,
        retencionModo,
        retencionMotivo,
        retencionDetalle,
        retenciones,
        retencionValor,
      },
      netoAPagar: redondear(total - retencionValor),
    };
  }

  calcularOrden.calcularRetenciones = calcularRetenciones;
  return calcularOrden;
});
SCRIPTEOF
echo "OK  public/contable/calculoOrden.js"

cat > public/contable/asientoCompra.js << 'SCRIPTEOF'
// Asiento contable de una factura de compra.
//
// Igual que calculoOrden.js: UN solo archivo que usan el navegador (para
// mostrar el asiento antes de confirmar) y el backend (para guardarlo),
// de modo que lo que se ve es exactamente lo que se contabiliza. No
// depende de Node ni del DOM.
//
// Asiento:
//   Db  cuenta destino de cada línea (inventario / gasto / costo / activo)
//   Db  1355 IVA descontable      (si la empresa es responsable de IVA)
//   Cr  2365 Retención en la fuente por pagar
//   Cr  2367 ReteIVA por pagar
//   Cr  2205 Proveedores nacionales       total - retenciones
//
// Todo se calcula en centavos enteros para que el asiento cuadre siempre.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.asientoCompra = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const CUENTAS_FIJAS = {
    IVA_DESCONTABLE: '1355',
    PROVEEDORES: '2205',
    RETEFUENTE: '2365',
    RETEIVA: '2367',
  };

  const centavos = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100);
  const pesos = (c) => c / 100;

  // Reparte `total` (centavos, puede ser negativo) en proporción a `pesosLineas`
  // sin perder un centavo: el residuo va a la línea de mayor peso.
  function repartir(total, pesosLineas) {
    if (pesosLineas.length === 0) return [];
    const suma = pesosLineas.reduce((a, b) => a + b, 0);
    if (suma === 0) return pesosLineas.map((_, i) => (i === 0 ? total : 0));
    let asignado = 0;
    const partes = pesosLineas.map((p) => {
      const x = Math.round((total * p) / suma);
      asignado += x;
      return x;
    });
    partes[pesosLineas.indexOf(Math.max(...pesosLineas))] += total - asignado;
    return partes;
  }

  // datos:
  //   lineas        [{ valorTotal, iva, otrosImpuestos }]  de la factura
  //   base, iva, impoconsumo, total   valores contables de la factura
  //   ivaDescontable   true si la empresa es responsable de IVA
  //   cuentasLinea  [codigo]  cuenta destino de cada línea
  //   retenciones   [{ sobre: 'base'|'aiu'|'iva', valor }]  ya calculadas
  //   centroCosto   texto opcional (proyecto)
  function armarAsientoCompra(datos) {
    const lineas = datos.lineas || [];
    if (lineas.length !== (datos.cuentasLinea || []).length) {
      throw new Error('Falta la cuenta destino de alguna línea.');
    }
    const ivaDescontable = !!datos.ivaDescontable;
    const baseCent = centavos(datos.base);
    const ivaCent = centavos(datos.iva);
    const totalCent = centavos(datos.total);

    const pesosLineas = lineas.map((l) => Math.max(0, centavos(l.valorTotal)));
    const sumaLineas = pesosLineas.reduce((a, b) => a + b, 0);

    // Mayor valor del gasto: impoconsumo y demás impuestos que no son IVA (siempre) y el
    // IVA si la empresa no es responsable (no lo puede descontar). Cada línea carga con sus
    // propios impuestos; lo que quede sin asignar (descuentos o cargos a nivel de factura,
    // impuestos que el XML solo trae en el resumen, diferencias menores) se reparte en
    // proporción al valor de cada línea.
    const propios = lineas.map((l) => centavos(l.otrosImpuestos) + (ivaDescontable ? 0 : centavos(l.iva)));
    const ajusteTotal = baseCent - sumaLineas + centavos(datos.impoconsumo) + (ivaDescontable ? 0 : ivaCent);
    const sobrante = repartir(ajusteTotal - propios.reduce((a, b) => a + b, 0), pesosLineas);

    const porCuenta = new Map();
    lineas.forEach((_, i) => {
      const cuenta = datos.cuentasLinea[i];
      porCuenta.set(cuenta, (porCuenta.get(cuenta) || 0) + pesosLineas[i] + propios[i] + sobrante[i]);
    });

    const asiento = [];
    for (const [cuentaCodigo, cent] of porCuenta) {
      asiento.push({ cuentaCodigo, debito: pesos(cent), credito: 0, centroCosto: datos.centroCosto || null });
    }
    if (ivaDescontable && ivaCent > 0) {
      asiento.push({ cuentaCodigo: CUENTAS_FIJAS.IVA_DESCONTABLE, debito: pesos(ivaCent), credito: 0 });
    }

    const retenciones = datos.retenciones || [];
    const reteIva = retenciones.filter((r) => r.sobre === 'iva').reduce((s, r) => s + centavos(r.valor), 0);
    const retTotal = retenciones.reduce((s, r) => s + centavos(r.valor), 0);
    const reteFuente = retTotal - reteIva;
    if (reteFuente > 0) asiento.push({ cuentaCodigo: CUENTAS_FIJAS.RETEFUENTE, debito: 0, credito: pesos(reteFuente) });
    if (reteIva > 0) asiento.push({ cuentaCodigo: CUENTAS_FIJAS.RETEIVA, debito: 0, credito: pesos(reteIva) });
    asiento.push({ cuentaCodigo: CUENTAS_FIJAS.PROVEEDORES, debito: 0, credito: pesos(totalCent - retTotal) });

    const debitos = asiento.reduce((s, l) => s + centavos(l.debito), 0);
    const creditos = asiento.reduce((s, l) => s + centavos(l.credito), 0);
    return {
      lineas: asiento,
      totalDebito: pesos(debitos),
      totalCredito: pesos(creditos),
      cuadra: debitos === creditos,
      retencionTotal: pesos(retTotal),
      netoAPagar: pesos(totalCent - retTotal),
    };
  }

  return { armarAsientoCompra, repartir, CUENTAS_FIJAS };
});
SCRIPTEOF
echo "OK  public/contable/asientoCompra.js"

cat > public/contable/app.js << 'SCRIPTEOF'
const API = '/api';

let token = localStorage.getItem('token');
let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
let mapaTerceros = {};
let listaTerceros = [];
let mapaProyectos = {};
let listaProyectos = [];

const vistaLogin = document.getElementById('vista-login');
const vistaDashboard = document.getElementById('vista-dashboard');

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    cerrarSesion('Tu sesión expiró. Inicia sesión de nuevo.');
    throw new Error('No autenticado');
  }

  if (res.status === 413) {
    throw new Error('El archivo es demasiado grande para guardarlo. Intenta con una imagen más liviana.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

// Atajo para botones de acción: llama la API y recarga todo el tablero.
// Cualquier error se muestra en una alerta simple — es intencionalmente
// básico, para no construir un sistema de notificaciones todavía.
async function accion(path, options = {}) {
  try {
    await api(path, options);
    await cargarTodo();
  } catch (err) {
    alert(err.message);
  }
}

function formatoDinero(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });
}

function formatoFecha(valor) {
  if (!valor) return '—';
  // "2026-10-05" (fecha sin hora) se interpreta como día local; con new Date()
  // directo se tomaría como UTC y en Colombia se vería un día antes.
  const soloFecha = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor));
  const fecha = soloFecha ? new Date(Number(soloFecha[1]), Number(soloFecha[2]) - 1, Number(soloFecha[3])) : new Date(valor);
  return fecha.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const ETIQUETAS_IMPUESTO = { iva: 'IVA', impoconsumo: 'Impoconsumo', exento: 'Exento' };
function etiquetaImpuesto(tipoImpuesto, porcentaje) {
  const etiqueta = ETIQUETAS_IMPUESTO[tipoImpuesto] || 'IVA';
  return tipoImpuesto === 'exento' ? etiqueta : `${etiqueta} ${porcentaje}%`;
}

// Para totales de órdenes: el IVA del 19% casi siempre deja centavos, y
// redondearlos a peso entero haría que las líneas no sumen a la vista.
function formatoDineroDec(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function nombreTercero(id) {
  return mapaTerceros[id] || id || '—';
}

function badge(estado) {
  if (!estado) return '—';
  return `<span class="badge ${estado}">${estado.replace(/_/g, ' ')}</span>`;
}

function tablaVacia(idTabla, colSpan, mensaje) {
  document.querySelector(`#${idTabla} tbody`).innerHTML =
    `<tr><td colspan="${colSpan}" class="vacio">${mensaje}</td></tr>`;
}

function botonAccion(texto, dataAttrs, destructivo) {
  const attrs = Object.entries(dataAttrs)
    .map(([k, v]) => `data-${k}="${v}"`)
    .join(' ');
  return `<button class="btn-accion${destructivo ? ' destructivo' : ''}" ${attrs}>${texto}</button>`;
}

// --- LOGIN ---
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  errorEl.style.color = '';

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');

    token = data.token;
    usuario = data.usuario;
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuario));
    mostrarDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

function cerrarSesion(mensaje) {
  token = null;
  usuario = null;
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  vistaDashboard.hidden = true;
  vistaLogin.hidden = false;
  if (mensaje) {
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = mensaje;
    errorEl.hidden = false;
  }
}

document.getElementById('btn-salir').addEventListener('click', () => cerrarSesion());

// --- ONBOARDING: crear empresa nueva y su primer usuario, sin sesión ---
const tarjetaLoginPrincipal = document.getElementById('tarjeta-login-principal');
const tarjetaOnboarding = document.getElementById('tarjeta-onboarding');
let empresaNuevaId = null;

document.getElementById('btn-mostrar-onboarding').addEventListener('click', () => {
  tarjetaLoginPrincipal.hidden = true;
  tarjetaOnboarding.hidden = false;
});

function volverALogin() {
  tarjetaOnboarding.hidden = true;
  tarjetaLoginPrincipal.hidden = false;
  document.getElementById('form-empresa-nueva').hidden = false;
  document.getElementById('form-usuario-nuevo').hidden = true;
  document.getElementById('form-empresa-nueva').reset();
  document.getElementById('form-usuario-nuevo').reset();
  document.getElementById('onboarding-resultado').hidden = true;
  empresaNuevaId = null;
}

document.getElementById('btn-volver-login').addEventListener('click', volverALogin);

// Convierte el archivo elegido a un data URI (base64) — así se manda
// tal cual al backend, sin necesitar un endpoint de subida de archivos
// aparte. Límite de 2MB para no inflar la base de datos con un logo
// pesado por error.
function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error('El logo no debe pesar más de 2MB.'));
      return;
    }
    const lector = new FileReader();
    lector.onload = () => resolve(lector.result);
    lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    lector.readAsDataURL(file);
  });
}

document.getElementById('empresa-logo').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  const vistaPrevia = document.getElementById('empresa-logo-vista-previa');
  if (!archivo) {
    vistaPrevia.hidden = true;
    return;
  }
  try {
    vistaPrevia.src = await leerArchivoComoBase64(archivo);
    vistaPrevia.hidden = false;
  } catch (err) {
    alert(err.message);
    e.target.value = '';
  }
});

document.getElementById('form-empresa-nueva').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const archivoLogo = document.getElementById('empresa-logo').files[0];
    const logoBase64 = archivoLogo ? await leerArchivoComoBase64(archivoLogo) : undefined;

    const res = await fetch(API + '/empresas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razonSocial: document.getElementById('empresa-razon-social').value,
        nit: document.getElementById('empresa-nit').value,
        regimenTributario: document.getElementById('empresa-regimen').value,
        responsableIva: document.getElementById('empresa-responsable-iva').checked,
        email: document.getElementById('empresa-email').value || undefined,
        telefono: document.getElementById('empresa-telefono').value || undefined,
        direccion: document.getElementById('empresa-direccion').value || undefined,
        departamento: document.getElementById('empresa-departamento').value || undefined,
        municipio: document.getElementById('empresa-municipio').value || undefined,
        representanteLegalNombre: document.getElementById('empresa-representante-nombre').value || undefined,
        representanteLegalDocumento: document.getElementById('empresa-representante-documento').value || undefined,
        actividadEconomicaCiiu: document.getElementById('empresa-ciiu').value || undefined,
        matriculaMercantil: document.getElementById('empresa-matricula').value || undefined,
        logoBase64,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la empresa.');

    empresaNuevaId = data.id;
    document.getElementById('empresa-creada-mensaje').textContent =
      `Empresa "${data.razonSocial}" creada. Ahora crea su primer usuario:`;
    document.getElementById('form-empresa-nueva').hidden = true;
    document.getElementById('form-usuario-nuevo').hidden = false;
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('form-usuario-nuevo').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch(API + '/auth/registro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empresaId: empresaNuevaId,
        nombre: document.getElementById('usuario-nuevo-nombre').value,
        email: document.getElementById('usuario-nuevo-email').value,
        password: document.getElementById('usuario-nuevo-password').value,
        rol: document.getElementById('usuario-nuevo-rol').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear el usuario.');

    volverALogin();
    document.getElementById('login-email').value = data.email;
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = `Usuario "${data.email}" creado. Ya puedes iniciar sesión.`;
    errorEl.style.color = 'var(--accent)';
    errorEl.hidden = false;
  } catch (err) {
    alert(err.message);
  }
});

// --- DASHBOARD SHELL ---
function mostrarDashboard() {
  vistaLogin.hidden = true;
  vistaDashboard.hidden = false;
  document.getElementById('usuario-nombre').textContent = usuario.nombre;
  document.getElementById('usuario-rol').textContent = usuario.rol;
  document.getElementById('inicio-usuario-nombre').textContent = usuario.nombre;
  cargarTodo();
  cargarNombreEmpresa();
}

async function cargarNombreEmpresa() {
  if (!usuario.empresaId) return;
  try {
    const empresas = await api('/empresas');
    const miEmpresa = empresas.find((e) => e.id === usuario.empresaId);
    document.getElementById('inicio-empresa-nombre').textContent = miEmpresa ? miEmpresa.razonSocial : '—';
    if (miEmpresa) llenarFormularioMiEmpresa(miEmpresa);
  } catch (err) {
    console.error(err);
  }
}

function llenarFormularioMiEmpresa(empresa) {
  document.getElementById('miempresa-razon-social').value = empresa.razonSocial || '';
  document.getElementById('miempresa-nit').value = empresa.nit || '';
  document.getElementById('miempresa-regimen').value = empresa.regimenTributario || 'ordinario';
  document.getElementById('miempresa-responsable-iva').checked = !!empresa.responsableIva;
  document.getElementById('miempresa-email').value = empresa.email || '';
  document.getElementById('miempresa-telefono').value = empresa.telefono || '';
  document.getElementById('miempresa-direccion').value = empresa.direccion || '';
  document.getElementById('miempresa-departamento').value = empresa.departamento || '';
  document.getElementById('miempresa-municipio').value = empresa.municipio || '';
  document.getElementById('miempresa-representante-nombre').value = empresa.representanteLegalNombre || '';
  document.getElementById('miempresa-representante-documento').value = empresa.representanteLegalDocumento || '';
  document.getElementById('miempresa-ciiu').value = empresa.actividadEconomicaCiiu || '';
  document.getElementById('miempresa-matricula').value = empresa.matriculaMercantil || '';

  const vistaPrevia = document.getElementById('miempresa-logo-vista-previa');
  if (empresa.logoBase64) {
    vistaPrevia.src = empresa.logoBase64;
    vistaPrevia.hidden = false;
  } else {
    vistaPrevia.hidden = true;
  }
}

document.getElementById('miempresa-logo').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  const vistaPrevia = document.getElementById('miempresa-logo-vista-previa');
  if (!archivo) return; // sin archivo nuevo, se conserva el logo actual en la vista previa
  try {
    vistaPrevia.src = await leerArchivoComoBase64(archivo);
    vistaPrevia.hidden = false;
  } catch (err) {
    alert(err.message);
    e.target.value = '';
  }
});

document.getElementById('form-mi-empresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultado = document.getElementById('miempresa-resultado');
  resultado.hidden = true;
  try {
    const archivoLogo = document.getElementById('miempresa-logo').files[0];
    // Si no se eligió un archivo nuevo, no se manda logoBase64 — así el
    // backend conserva el logo que ya tenía en vez de borrarlo.
    const logoBase64 = archivoLogo ? await leerArchivoComoBase64(archivoLogo) : undefined;

    await api(`/empresas/${usuario.empresaId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        razonSocial: document.getElementById('miempresa-razon-social').value,
        nit: document.getElementById('miempresa-nit').value,
        regimenTributario: document.getElementById('miempresa-regimen').value,
        responsableIva: document.getElementById('miempresa-responsable-iva').checked,
        email: document.getElementById('miempresa-email').value || undefined,
        telefono: document.getElementById('miempresa-telefono').value || undefined,
        direccion: document.getElementById('miempresa-direccion').value || undefined,
        departamento: document.getElementById('miempresa-departamento').value || undefined,
        municipio: document.getElementById('miempresa-municipio').value || undefined,
        representanteLegalNombre: document.getElementById('miempresa-representante-nombre').value || undefined,
        representanteLegalDocumento: document.getElementById('miempresa-representante-documento').value || undefined,
        actividadEconomicaCiiu: document.getElementById('miempresa-ciiu').value || undefined,
        matriculaMercantil: document.getElementById('miempresa-matricula').value || undefined,
        logoBase64,
      }),
    });

    document.getElementById('miempresa-logo').value = '';
    resultado.textContent = 'Datos de la empresa actualizados.';
    resultado.hidden = false;
    cargarNombreEmpresa();
  } catch (err) {
    alert(err.message);
  }
});

// Cambia de pestaña — la usan tanto el menú lateral como las tarjetas
// del panel de Inicio, para no duplicar la lógica.
function irATab(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activo'));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
  const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (navItem) navItem.classList.add('activo');
  document.getElementById('panel-' + tab).hidden = false;
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => irATab(btn.dataset.tab));
});

document.querySelectorAll('.tarjeta-modulo').forEach((btn) => {
  btn.addEventListener('click', () => irATab(btn.dataset.irA));
});

// --- TOGGLE DE FORMULARIOS "+ Nuevo..." ---
function conectarToggle(botonId, formularioId, cancelarId) {
  const boton = document.getElementById(botonId);
  const formulario = document.getElementById(formularioId);
  boton.addEventListener('click', () => (formulario.hidden = !formulario.hidden));
  document.getElementById(cancelarId).addEventListener('click', () => {
    formulario.hidden = true;
    formulario.reset();
  });
}

conectarToggle('btn-nuevo-tercero', 'form-tercero', 'btn-cancelar-tercero');
document.getElementById('btn-nuevo-tercero').addEventListener('click', () => {
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});
conectarToggle('btn-nuevo-proyecto', 'form-proyecto', 'btn-cancelar-proyecto');
conectarToggle('btn-nueva-cotizacion', 'form-cotizacion', 'btn-cancelar-cotizacion');
conectarToggle('btn-nueva-orden', 'form-orden', 'btn-cancelar-orden');
conectarToggle('btn-nuevo-periodo', 'form-periodo', 'btn-cancelar-periodo');
conectarToggle('btn-nuevo-producto', 'form-producto', 'btn-cancelar-producto');
conectarToggle('btn-nuevo-activo', 'form-activo', 'btn-cancelar-activo');
conectarToggle('btn-nueva-cuenta', 'form-cuenta', 'btn-cancelar-cuenta');
conectarToggle('btn-nuevo-movimiento', 'form-movimiento', 'btn-cancelar-movimiento');

// --- CARGA DE DATOS ---
async function cargarTodo() {
  try {
    const terceros = await api('/terceros');
    listaTerceros = terceros;
    mapaTerceros = Object.fromEntries(terceros.map((t) => [t.id, t.nombre]));
    renderTerceros(terceros);
    poblarSelectTodosTerceros('cotizacion-tercero', 'Tercero');
    poblarSelectTodosTerceros('orden-tercero', 'Tercero');
    poblarSelectTodosTerceros('proyecto-contratante', 'Contratante');

    const proyectos = await api('/proyectos');
    listaProyectos = proyectos;
    mapaProyectos = Object.fromEntries(proyectos.map((p) => [p.id, etiquetaProyecto(p)]));
    renderProyectos(proyectos);
    poblarSelectProyectos(proyectos);

    const [cotizaciones, facturasVenta, ordenes, facturasCompra, periodos, productos, activos, cuentas, movBancarios] = await Promise.all([
      api('/ventas/cotizaciones'),
      api('/ventas/facturas'),
      api('/compras/ordenes'),
      api('/compras/facturas'),
      api('/nomina/periodos'),
      api('/inventarios/productos'),
      api('/activos-fijos'),
      api('/tesoreria/cuentas'),
      api('/tesoreria/movimientos'),
    ]);

    renderCotizaciones(cotizaciones);
    renderFacturasVenta(facturasVenta);
    renderOrdenes(ordenes);
    renderFacturasCompra(facturasCompra);
    renderNomina(periodos);
    renderProductos(productos);
    renderActivos(activos);
    renderCuentas(cuentas);
    poblarSelectCuentas(cuentas);
    renderMovimientosBancarios(movBancarios);
  } catch (err) {
    console.error(err);
  }
}

// Muestra TODOS los terceros sin filtrar por tipo — la categorización
// (cliente/proveedor/empleado/otro) es solo una referencia informativa,
// no una restricción. La única excepción real es Nómina, que sí exige
// tipo "empleado" (ver agregarEmpleadoAPeriodo), porque ahí sí importa
// no confundir un proveedor con alguien de la nómina.
function poblarSelectTodosTerceros(selectId, etiqueta) {
  const select = document.getElementById(selectId);
  select.innerHTML =
    `<option value="">${etiqueta}...</option>` +
    listaTerceros.map((t) => `<option value="${t.id}">${t.nombre} (${t.tipo})</option>`).join('');
}

function poblarSelectCuentas(cuentas) {
  const select = document.getElementById('movimiento-cuenta');
  select.innerHTML =
    '<option value="">Cuenta bancaria...</option>' +
    cuentas.map((c) => `<option value="${c.id}">${c.banco} — ${c.numero}</option>`).join('');
}

// "ID — nombre": el ID (centro de costo) va primero porque es lo que
// identifica el proyecto en los documentos; sin ID, solo el nombre.
function etiquetaProyecto(p) {
  return p.codigo ? `${p.codigo} — ${p.nombre}` : p.nombre;
}

function poblarSelectProyectos(proyectos) {
  const select = document.getElementById('orden-proyecto-id');
  select.innerHTML =
    '<option value="">Proyecto / Unidad de negocio (ID)...</option>' +
    proyectos
      .filter((p) => p.activo)
      .map((p) => `<option value="${p.id}">${etiquetaProyecto(p)}</option>`)
      .join('');
}

function nombreProyecto(id) {
  return id ? mapaProyectos[id] || id : '—';
}

// --- RENDER: PROYECTOS ---
function renderProyectos(lista) {
  document.querySelector('#tabla-proyectos thead').innerHTML =
    '<tr><th>ID (centro de costo)</th><th>Nombre</th><th>Contratante</th><th class="num">Valor total</th><th>Objeto</th><th>Estado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-proyectos', 7, 'Todavía no hay proyectos. Crea el primero arriba.');
  document.querySelector('#tabla-proyectos tbody').innerHTML = lista
    .map(
      (p) =>
        `<tr><td><strong>${p.codigo || '—'}</strong></td><td>${p.nombre}</td><td>${nombreTercero(
          p.contratanteId
        )}</td><td class="num">${p.valorTotal ? formatoDinero(p.valorTotal) : '—'}</td><td>${
          p.objeto || '—'
        }</td><td>${badge(p.activo ? 'activo' : 'inactivo')}</td><td class="acciones">${botonAccion('Editar', {
          accion: 'editar-proyecto',
          id: p.id,
        })}</td></tr>`
    )
    .join('');
}

// null = el formulario crea un proyecto nuevo; con un id, edita ese
// proyecto (mismo formulario para las dos cosas, como en Terceros).
let proyectoEditandoId = null;

function salirDeEdicionProyecto() {
  proyectoEditandoId = null;
  document.querySelector('#form-proyecto button[type="submit"]').textContent = 'Guardar';
}

function abrirEdicionProyecto(id) {
  const p = listaProyectos.find((x) => x.id === id);
  if (!p) return;

  proyectoEditandoId = id;
  document.getElementById('form-proyecto').hidden = false;
  document.getElementById('proyecto-nombre').value = p.nombre || '';
  document.getElementById('proyecto-codigo').value = p.codigo || '';
  document.getElementById('proyecto-contratante').value = p.contratanteId || '';
  document.getElementById('proyecto-valor-total').value = p.valorTotal ? Number(p.valorTotal) : '';
  document.getElementById('proyecto-objeto').value = p.objeto || '';
  document.getElementById('proyecto-activo').checked = !!p.activo;

  document.querySelector('#form-proyecto button[type="submit"]').textContent = 'Guardar cambios';
  document.getElementById('form-proyecto').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Si se estaba editando y se pulsa "+ Nuevo proyecto", el formulario
// vuelve en blanco y en modo creación (conectarToggle ya lo alternó).
document.getElementById('btn-nuevo-proyecto').addEventListener('click', () => {
  if (proyectoEditandoId) {
    salirDeEdicionProyecto();
    const form = document.getElementById('form-proyecto');
    form.reset();
    form.hidden = false;
  }
});
document.getElementById('btn-cancelar-proyecto').addEventListener('click', salirDeEdicionProyecto);

conectarFormulario('form-proyecto', async () => {
  const nombre = document.getElementById('proyecto-nombre').value;
  const codigo = document.getElementById('proyecto-codigo').value;
  const contratanteId = document.getElementById('proyecto-contratante').value;
  const valor = document.getElementById('proyecto-valor-total').value;
  const objeto = document.getElementById('proyecto-objeto').value;
  const activo = document.getElementById('proyecto-activo').checked;

  if (proyectoEditandoId) {
    // Al editar, un campo vacío se manda como null para poder BORRAR
    // un dato (con undefined el servidor lo ignoraría y quedaría el viejo).
    await api(`/proyectos/${proyectoEditandoId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        nombre,
        codigo: codigo || null,
        contratanteId: contratanteId || null,
        valorTotal: valor ? Number(valor) : null,
        objeto: objeto || null,
        activo,
      }),
    });
  } else {
    await api('/proyectos', {
      method: 'POST',
      body: JSON.stringify({
        nombre,
        codigo: codigo || undefined,
        contratanteId: contratanteId || undefined,
        valorTotal: valor ? Number(valor) : undefined,
        objeto: objeto || undefined,
        activo,
      }),
    });
  }

  // Solo se sale del modo edición si la llamada tuvo éxito.
  salirDeEdicionProyecto();
});

// --- RENDER: TERCEROS ---
function renderTerceros(lista) {
  document.querySelector('#tabla-terceros thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th>Persona</th><th>Identificación</th><th>Celular</th><th>Correo</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-terceros', 7, 'Todavía no hay terceros. Crea el primero arriba.');
  document.querySelector('#tabla-terceros tbody').innerHTML = lista
    .map(
      (t) =>
        `<tr><td>${t.nombre}</td><td>${t.tipo}</td><td>${t.tipoPersona || '—'}</td><td>${
          t.identificacion
        }</td><td>${t.celular || '—'}</td><td>${t.email || '—'}</td><td class="acciones">${botonAccion(
          'Editar',
          { accion: 'editar-tercero', id: t.id }
        )}</td></tr>`
    )
    .join('');
}

// --- RENDER: COTIZACIONES (con acciones según estado) ---
function renderCotizaciones(lista) {
  document.querySelector('#tabla-cotizaciones thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Vence</th><th>Cliente</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cotizaciones', 7, 'Todavía no hay cotizaciones.');
  document.querySelector('#tabla-cotizaciones tbody').innerHTML = lista
    .map((c) => {
      let acciones =
        botonAccion('Ver ítems', { accion: 'ver-items-cotizacion', id: c.id }) +
        botonAccion('Ver PDF', { accion: 'ver-pdf-cotizacion', id: c.id });
      if (c.estado === 'borrador')
        acciones +=
          botonAccion('Editar', { accion: 'editar-cotizacion', id: c.id }) +
          botonAccion('Enviar', { accion: 'enviar-cotizacion', id: c.id });
      else if (c.estado === 'enviada')
        acciones +=
          botonAccion('Aceptar', { accion: 'aceptar-cotizacion', id: c.id }) +
          botonAccion('Rechazar', { accion: 'rechazar-cotizacion', id: c.id }, true);
      else if (c.estado === 'aceptada') acciones += botonAccion('Convertir en factura', { accion: 'convertir-cotizacion', id: c.id });

      return `<tr data-fila-cotizacion="${c.id}"><td>${c.consecutivo || '—'}</td><td>${formatoFecha(
        c.fecha
      )}</td><td>${formatoFecha(c.fechaVencimiento)}</td><td>${nombreTercero(c.terceroId)}</td><td>${badge(
        c.estado
      )}</td><td class="num">${formatoDinero(c.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasVenta(lista) {
  document.querySelector('#tabla-facturas-venta thead').innerHTML =
    '<tr><th>Fecha</th><th>Cliente</th><th>DIAN</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-venta', 4, 'Todavía no hay facturas de venta.');
  document.querySelector('#tabla-facturas-venta tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoSincronizacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

// --- RENDER: ÓRDENES DE ADQUISICIÓN ---
function renderOrdenes(lista) {
  document.querySelector('#tabla-ordenes thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Proveedor</th><th>Proyecto</th><th>Tipo</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-ordenes', 8, 'Todavía no hay órdenes de adquisición.');
  document.querySelector('#tabla-ordenes tbody').innerHTML = lista
    .map((o) => {
      let acciones =
        botonAccion('Ver ítems', { accion: 'ver-items-orden', id: o.id }) +
        botonAccion('Ver PDF', { accion: 'ver-pdf-orden', id: o.id });

      if (['borrador', 'emitida'].includes(o.estado)) {
        if (o.estado === 'borrador') acciones += botonAccion('Editar', { accion: 'editar-orden', id: o.id });
        acciones += botonAccion('Aprobar', { accion: 'aprobar-orden', id: o.id });
      } else if (['aprobada', 'recibida_parcial', 'recibida_total'].includes(o.estado)) {
        acciones += botonAccion('Convertir en factura', { accion: 'convertir-orden', id: o.id });
      }

      const proyecto = o.proyectoId ? nombreProyecto(o.proyectoId) : o.proyecto || '—';

      return `<tr data-fila-orden="${o.id}"><td>${o.consecutivo || '—'}</td><td>${formatoFecha(
        o.fecha
      )}</td><td>${nombreTercero(o.terceroId)}</td><td>${proyecto}</td><td>${o.tipo}</td><td>${badge(
        o.estado
      )}</td><td class="num">${formatoDineroDec(o.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasCompra(lista) {
  document.querySelector('#tabla-facturas-compra thead').innerHTML =
    '<tr><th>Fecha</th><th>Número</th><th>Proveedor</th><th>Conciliación</th><th class="num">Total</th><th class="num">Retención</th><th class="num">A pagar</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-compra', 8, 'Todavía no hay facturas de compra. Carga el XML de la primera con el botón de arriba.');
  document.querySelector('#tabla-facturas-compra tbody').innerHTML = lista
    .map((f) => {
      const neto = f.netoAPagar === null || f.netoAPagar === undefined ? f.total : f.netoAPagar;
      return (
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${escHtml(f.numero || '—')}</td><td>${escHtml(nombreTercero(f.terceroId))}</td><td>${badge(f.estadoConciliacion)}</td>` +
        `<td class="num">${formatoDineroDec(f.total)}</td><td class="num">${Number(f.retencionValor) ? formatoDineroDec(f.retencionValor) : '—'}</td>` +
        `<td class="num">${formatoDineroDec(neto)}</td><td class="acciones">${botonAccion('Ver', { accion: 'ver-factura-compra', id: f.id })}${
          f.emisorNit ? botonAccion('XML', { accion: 'xml-factura-compra', id: f.id }) : ''
        }</td></tr>`
      );
    })
    .join('');
}

// --- RENDER: NÓMINA ---
function renderNomina(lista) {
  document.querySelector('#tabla-nomina thead').innerHTML = '<tr><th>Periodo</th><th>Estado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-nomina', 3, 'Todavía no hay periodos de nómina.');
  document.querySelector('#tabla-nomina tbody').innerHTML = lista
    .map((p) => {
      let acciones = '—';
      if (p.estado === 'borrador')
        acciones =
          botonAccion('Agregar empleado', { accion: 'agregar-empleado', id: p.id }) +
          botonAccion('Liquidar', { accion: 'liquidar-periodo', id: p.id });

      return `<tr><td>${formatoFecha(p.fechaInicio)} — ${formatoFecha(p.fechaFin)}</td><td>${badge(
        p.estado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: INVENTARIOS ---
function renderProductos(lista) {
  document.querySelector('#tabla-productos thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Costo promedio</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-productos', 5, 'Todavía no hay productos. Crea el primero arriba.');
  document.querySelector('#tabla-productos tbody').innerHTML = lista
    .map((p) => {
      const acciones =
        botonAccion('Entrada', { accion: 'entrada-inventario', id: p.id }) +
        botonAccion('Salida', { accion: 'salida-inventario', id: p.id }) +
        botonAccion('Ajuste', { accion: 'ajuste-inventario', id: p.id }, true);
      return `<tr><td>${p.nombre}</td><td>${p.tipo}</td><td class="num">${Number(p.cantidadDisponible).toLocaleString(
        'es-CO'
      )}</td><td class="num">${formatoDinero(p.costoPromedio)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: ACTIVOS FIJOS ---
function renderActivos(lista) {
  document.querySelector('#tabla-activos thead').innerHTML =
    '<tr><th>Nombre</th><th>Adquisición</th><th>Estado</th><th class="num">Costo</th><th class="num">Depreciado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-activos', 6, 'Todavía no hay activos fijos registrados.');
  document.querySelector('#tabla-activos tbody').innerHTML = lista
    .map((a) => {
      const acciones = a.estado === 'activo' ? botonAccion('Dar de baja', { accion: 'baja-activo', id: a.id }, true) : '—';
      return `<tr><td>${a.nombre}</td><td>${formatoFecha(a.fechaAdquisicion)}</td><td>${badge(
        a.estado
      )}</td><td class="num">${formatoDinero(a.costo)}</td><td class="num">${formatoDinero(
        a.valorDepreciadoAcumulado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: TESORERÍA ---
function renderCuentas(lista) {
  document.querySelector('#tabla-cuentas thead').innerHTML = '<tr><th>Banco</th><th>Número</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cuentas', 2, 'Todavía no hay cuentas bancarias registradas.');
  document.querySelector('#tabla-cuentas tbody').innerHTML = lista
    .map((c) => `<tr><td>${c.banco}</td><td>${c.numero}</td></tr>`)
    .join('');
}

function renderMovimientosBancarios(lista) {
  document.querySelector('#tabla-movimientos-bancarios thead').innerHTML =
    '<tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Conciliado</th><th class="num">Valor</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-movimientos-bancarios', 6, 'Todavía no hay movimientos bancarios registrados.');
  document.querySelector('#tabla-movimientos-bancarios tbody').innerHTML = lista
    .map((m) => {
      const acciones = m.conciliado ? '—' : botonAccion('Conciliar', { accion: 'conciliar-movimiento', id: m.id });
      return `<tr><td>${formatoFecha(m.fecha)}</td><td>${m.tipo}</td><td>${m.descripcion || '—'}</td><td>${
        m.conciliado ? badge('conciliado') : badge('pendiente')
      }</td><td class="num">${formatoDinero(m.valor)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- FORMULARIOS DE CREACIÓN ---
function conectarFormulario(formId, alEnviar) {
  const form = document.getElementById(formId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await alEnviar();
      form.reset();
      form.hidden = true;
      cargarTodo();
    } catch (err) {
      alert(err.message);
    }
  });
}

// null = el formulario está creando un tercero nuevo; con un id, está
// editando ese tercero existente (mismo formulario para las dos cosas).
let terceroEditandoId = null;

function abrirEdicionTercero(id) {
  const t = listaTerceros.find((x) => x.id === id);
  if (!t) return;

  terceroEditandoId = id;
  document.getElementById('form-tercero').hidden = false;
  document.getElementById('tercero-tipo').value = t.tipo || 'cliente';
  document.getElementById('tercero-tipo-persona').value = t.tipoPersona || '';
  document.getElementById('tercero-identificacion').value = t.identificacion || '';
  document.getElementById('tercero-nombre').value = t.nombre || '';
  document.getElementById('tercero-email').value = t.email || '';
  document.getElementById('tercero-celular').value = t.celular || '';
  document.getElementById('tercero-direccion').value = t.direccion || '';
  document.getElementById('tercero-departamento').value = t.departamento || '';
  document.getElementById('tercero-municipio').value = t.municipio || '';
  document.getElementById('tercero-regimen-iva').value = t.regimenIva || '';
  document.getElementById('tercero-cuenta-tipo').value = t.cuentaBancariaTipo || '';
  document.getElementById('tercero-cuenta-banco').value = t.cuentaBancariaBanco || '';
  document.getElementById('tercero-cuenta-numero').value = t.cuentaBancariaNumero || '';

  const responsabilidades = t.responsabilidadesFiscales || [];
  document.querySelectorAll('.chk-responsabilidad').forEach((chk) => {
    chk.checked = responsabilidades.includes(chk.value);
  });

  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar cambios';
  document.getElementById('form-tercero').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Cancelar también sale del modo edición, no solo limpia el formulario.
document.getElementById('btn-cancelar-tercero').addEventListener('click', () => {
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});

conectarFormulario('form-tercero', async () => {
  const responsabilidades = Array.from(document.querySelectorAll('.chk-responsabilidad:checked')).map((c) => c.value);
  const datos = {
    tipo: document.getElementById('tercero-tipo').value,
    tipoPersona: document.getElementById('tercero-tipo-persona').value || undefined,
    identificacion: document.getElementById('tercero-identificacion').value,
    nombre: document.getElementById('tercero-nombre').value,
    email: document.getElementById('tercero-email').value || undefined,
    celular: document.getElementById('tercero-celular').value || undefined,
    direccion: document.getElementById('tercero-direccion').value || undefined,
    departamento: document.getElementById('tercero-departamento').value || undefined,
    municipio: document.getElementById('tercero-municipio').value || undefined,
    regimenIva: document.getElementById('tercero-regimen-iva').value || undefined,
    cuentaBancariaTipo: document.getElementById('tercero-cuenta-tipo').value || undefined,
    cuentaBancariaBanco: document.getElementById('tercero-cuenta-banco').value || undefined,
    cuentaBancariaNumero: document.getElementById('tercero-cuenta-numero').value || undefined,
    responsabilidadesFiscales: responsabilidades.length > 0 ? responsabilidades : undefined,
  };

  if (terceroEditandoId) {
    await api(`/terceros/${terceroEditandoId}`, { method: 'PATCH', body: JSON.stringify(datos) });
  } else {
    await api('/terceros', { method: 'POST', body: JSON.stringify(datos) });
  }

  // Solo se limpia el modo edición si la llamada anterior tuvo éxito —
  // si falla, el formulario se queda abierto y editable para reintentar.
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});

// --- ÍTEMS DINÁMICOS DE COTIZACIÓN ---
const UNIDADES_MEDIDA = ['UND', 'KG', 'M', 'M2', 'M3', 'HR', 'DIA', 'MES', 'GLB', 'SERV', 'LT', 'GAL'];

// value = "tipoImpuesto-porcentaje". "otro" deja el % en blanco para
// que el usuario lo escriba a mano (ver el input que aparece al lado).
const OPCIONES_IMPUESTO = [
  { value: 'iva-19', texto: 'IVA 19%' },
  { value: 'iva-5', texto: 'IVA 5%' },
  { value: 'iva-0', texto: 'IVA 0%' },
  { value: 'impoconsumo-4', texto: 'Impoconsumo 4%' },
  { value: 'impoconsumo-8', texto: 'Impoconsumo 8%' },
  { value: 'impoconsumo-16', texto: 'Impoconsumo 16%' },
  { value: 'exento-0', texto: 'Exento' },
  { value: 'otro-', texto: 'Otro (definir %)' },
];

// Si se pasa "item", la fila nace precargada con sus datos — se usa
// tanto para "+ Agregar ítem" (sin argumento, fila en blanco) como para
// abrir una cotización existente en modo edición.
function crearFilaItemCotizacion(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="item-concepto" placeholder="Concepto" required></td>
    <td><input type="number" class="item-cantidad" placeholder="Cant." min="0" step="0.01" required></td>
    <td><select class="item-um">${UNIDADES_MEDIDA.map((u) => `<option value="${u}">${u}</option>`).join('')}</select></td>
    <td><input type="number" class="item-valor-unitario" placeholder="Valor unit." min="0" required></td>
    <td>
      <select class="item-tipo-impuesto">${OPCIONES_IMPUESTO.map((o) => `<option value="${o.value}">${o.texto}</option>`).join('')}</select>
      <input type="number" class="item-impuesto-manual" min="0" max="100" placeholder="%" hidden>
    </td>
    <td class="num item-total-texto">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-item">Quitar</button></td>
  `;
  tr.querySelectorAll('input').forEach((input) => input.addEventListener('input', recalcularTotalesCotizacion));
  tr.querySelector('.item-tipo-impuesto').addEventListener('change', (e) => {
    const manual = tr.querySelector('.item-impuesto-manual');
    manual.hidden = !e.target.value.startsWith('otro-');
    recalcularTotalesCotizacion();
  });
  tr.querySelector('.btn-quitar-item').addEventListener('click', () => {
    tr.remove();
    recalcularTotalesCotizacion();
  });

  if (item) {
    tr.querySelector('.item-concepto').value = item.concepto;
    tr.querySelector('.item-cantidad').value = item.cantidad;
    tr.querySelector('.item-um').value = item.unidadMedida;
    tr.querySelector('.item-valor-unitario').value = item.valorUnitario;

    const selectImpuesto = tr.querySelector('.item-tipo-impuesto');
    const valorCombinado = `${item.tipoImpuesto}-${item.impuestoPorcentaje}`;
    const coincide = Array.from(selectImpuesto.options).some((o) => o.value === valorCombinado);
    if (coincide) {
      selectImpuesto.value = valorCombinado;
    } else {
      // Porcentaje que no está en los presets (ej. 12%) — se guarda
      // igual, solo se muestra como "Otro" con el % manual visible.
      selectImpuesto.value = 'otro-';
      const manual = tr.querySelector('.item-impuesto-manual');
      manual.hidden = false;
      manual.value = item.impuestoPorcentaje;
    }
  }

  return tr;
}

document.getElementById('btn-agregar-item-cotizacion').addEventListener('click', () => {
  document.getElementById('items-cotizacion-tbody').appendChild(crearFilaItemCotizacion());
});

function leerImpuestoFila(fila) {
  const seleccion = fila.querySelector('.item-tipo-impuesto').value; // "tipo-porcentaje"
  const [tipoImpuesto, porcentajeTexto] = seleccion.split('-');
  if (tipoImpuesto === 'otro') {
    const manual = Number(fila.querySelector('.item-impuesto-manual').value || 0);
    return { tipoImpuesto: 'iva', impuestoPorcentaje: manual }; // "otro" se guarda como IVA con % manual
  }
  return { tipoImpuesto, impuestoPorcentaje: Number(porcentajeTexto) };
}

function leerItemsCotizacion() {
  const filas = document.querySelectorAll('#items-cotizacion-tbody tr');
  return Array.from(filas).map((fila) => {
    const cantidad = Number(fila.querySelector('.item-cantidad').value || 0);
    const valorUnitario = Number(fila.querySelector('.item-valor-unitario').value || 0);
    const { tipoImpuesto, impuestoPorcentaje } = leerImpuestoFila(fila);
    const valorTotal = cantidad * valorUnitario;
    fila.querySelector('.item-total-texto').textContent = formatoDinero(valorTotal);
    return {
      concepto: fila.querySelector('.item-concepto').value,
      cantidad,
      unidadMedida: fila.querySelector('.item-um').value,
      valorUnitario,
      tipoImpuesto,
      impuestoPorcentaje,
      valorTotal,
    };
  });
}

function recalcularTotalesCotizacion() {
  const items = leerItemsCotizacion();
  const subtotal = items.reduce((s, i) => s + i.valorTotal, 0);

  const aplicaAiu = document.getElementById('cotizacion-aplica-aiu').checked;
  let baseIva = subtotal;
  if (aplicaAiu) {
    const admin = subtotal * (Number(document.getElementById('cotizacion-aiu-administracion').value || 0) / 100);
    const imprevistos = subtotal * (Number(document.getElementById('cotizacion-aiu-imprevistos').value || 0) / 100);
    const utilidad = subtotal * (Number(document.getElementById('cotizacion-aiu-utilidad').value || 0) / 100);
    baseIva = subtotal + admin + imprevistos + utilidad;

    document.getElementById('valor-aiu-administracion').textContent = formatoDinero(admin);
    document.getElementById('valor-aiu-imprevistos').textContent = formatoDinero(imprevistos);
    document.getElementById('valor-aiu-utilidad').textContent = formatoDinero(utilidad);
  }
  const iva = baseIva * 0.19;
  const total = baseIva + iva;

  document.getElementById('resumen-subtotal').textContent = formatoDinero(subtotal);
  document.getElementById('resumen-iva').textContent = formatoDinero(iva);
  document.getElementById('resumen-total').textContent = formatoDinero(total);
}

document.getElementById('cotizacion-aplica-aiu').addEventListener('change', (e) => {
  document.getElementById('campos-aiu').hidden = !e.target.checked;
  recalcularTotalesCotizacion();
});
document.querySelectorAll('#campos-aiu input').forEach((el) => el.addEventListener('input', recalcularTotalesCotizacion));

function limpiarFormularioCotizacion() {
  document.getElementById('items-cotizacion-tbody').innerHTML = '';
  document.getElementById('campos-aiu').hidden = true;
  document.getElementById('cotizacion-aplica-aiu').checked = false;
  cotizacionEditandoId = null;
  document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar';
  recalcularTotalesCotizacion();
}

// null = el formulario está creando una cotización nueva; con un id,
// está editando esa cotización existente (mismo formulario, igual que
// con Terceros).
let cotizacionEditandoId = null;

async function abrirEdicionCotizacion(id) {
  try {
    const cotizacion = await api(`/ventas/cotizaciones/${id}`);
    if (cotizacion.estado !== 'borrador') {
      alert('Solo se puede editar una cotización en estado "borrador".');
      return;
    }

    cotizacionEditandoId = id;
    document.getElementById('form-cotizacion').hidden = false;
    document.getElementById('cotizacion-tercero').value = cotizacion.terceroId;
    document.getElementById('cotizacion-vencimiento').value = cotizacion.fechaVencimiento;
    document.getElementById('cotizacion-forma-pago').value = cotizacion.formaPago || '';
    document.getElementById('cotizacion-observaciones').value = cotizacion.observaciones || '';
    document.getElementById('cotizacion-contacto-nombre').value = cotizacion.contactoNombre || '';
    document.getElementById('cotizacion-contacto-telefono').value = cotizacion.contactoTelefono || '';

    document.getElementById('cotizacion-aplica-aiu').checked = cotizacion.aplicaAiu;
    document.getElementById('campos-aiu').hidden = !cotizacion.aplicaAiu;
    document.getElementById('cotizacion-aiu-administracion').value = cotizacion.aiuAdministracion || '';
    document.getElementById('cotizacion-aiu-imprevistos').value = cotizacion.aiuImprevistos || '';
    document.getElementById('cotizacion-aiu-utilidad').value = cotizacion.aiuUtilidad || '';

    const tbody = document.getElementById('items-cotizacion-tbody');
    tbody.innerHTML = '';
    const items = cotizacion.items || [];
    if (items.length > 0) items.forEach((item) => tbody.appendChild(crearFilaItemCotizacion(item)));
    else tbody.appendChild(crearFilaItemCotizacion());

    recalcularTotalesCotizacion();
    document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar cambios';
    document.getElementById('form-cotizacion').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert(err.message);
  }
}

// Empieza con un ítem en blanco listo para llenar, en vez de una tabla vacía.
document.getElementById('btn-nueva-cotizacion').addEventListener('click', () => {
  cotizacionEditandoId = null;
  document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar';
  if (document.getElementById('items-cotizacion-tbody').children.length === 0) {
    document.getElementById('items-cotizacion-tbody').appendChild(crearFilaItemCotizacion());
  }
});
document.getElementById('btn-cancelar-cotizacion').addEventListener('click', limpiarFormularioCotizacion);

conectarFormulario('form-cotizacion', async () => {
  const items = leerItemsCotizacion();
  if (items.length === 0 || items.some((i) => !i.concepto || i.cantidad <= 0)) {
    throw new Error('Agrega al menos un ítem con concepto y cantidad mayor a cero.');
  }

  const cuerpo = {
    terceroId: document.getElementById('cotizacion-tercero').value,
    fechaVencimiento: document.getElementById('cotizacion-vencimiento').value,
    formaPago: document.getElementById('cotizacion-forma-pago').value || undefined,
    observaciones: document.getElementById('cotizacion-observaciones').value || undefined,
    contactoNombre: document.getElementById('cotizacion-contacto-nombre').value || undefined,
    contactoTelefono: document.getElementById('cotizacion-contacto-telefono').value || undefined,
    aplicaAiu: document.getElementById('cotizacion-aplica-aiu').checked,
    aiuAdministracion: Number(document.getElementById('cotizacion-aiu-administracion').value || 0),
    aiuImprevistos: Number(document.getElementById('cotizacion-aiu-imprevistos').value || 0),
    aiuUtilidad: Number(document.getElementById('cotizacion-aiu-utilidad').value || 0),
    items,
  };

  if (cotizacionEditandoId) {
    await api(`/ventas/cotizaciones/${cotizacionEditandoId}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  } else {
    await api('/ventas/cotizaciones', { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  limpiarFormularioCotizacion();
  document.getElementById('form-cotizacion').hidden = true;
});

// --- VER ÍTEMS de una cotización existente (fila expandible) ---
async function verItemsCotizacion(id) {
  const filaDetalleExistente = document.getElementById('detalle-cotizacion-' + id);
  if (filaDetalleExistente) {
    filaDetalleExistente.remove();
    return;
  }

  try {
    const cotizacion = await api(`/ventas/cotizaciones/${id}`);
    const filaOriginal = document.querySelector(`tr[data-fila-cotizacion="${id}"]`);
    if (!filaOriginal) return;

    const itemsHtml = (cotizacion.items || [])
      .map(
        (it) =>
          `<tr><td>${it.concepto}</td><td class="num">${Number(it.cantidad).toLocaleString('es-CO')} ${
            it.unidadMedida
          }</td><td class="num">${formatoDinero(it.valorUnitario)}</td><td class="num">${etiquetaImpuesto(
            it.tipoImpuesto,
            it.impuestoPorcentaje
          )}</td><td class="num">${formatoDinero(it.valorTotal)}</td></tr>`
      )
      .join('');

    const tr = document.createElement('tr');
    tr.id = 'detalle-cotizacion-' + id;
    tr.innerHTML = `<td colspan="7"><div class="detalle-items">
      <table class="tabla-items-detalle">
        <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead>
        <tbody>${
          itemsHtml ||
          '<tr><td colspan="5" class="vacio">Esta cotización no tiene ítems registrados (se creó antes de esta función).</td></tr>'
        }</tbody>
      </table>
      ${
        cotizacion.aplicaAiu
          ? `<p class="nota-aiu">AIU aplicado — Administración ${cotizacion.aiuAdministracion}% · Imprevistos ${cotizacion.aiuImprevistos}% · Utilidad ${cotizacion.aiuUtilidad}%</p>`
          : ''
      }
    </div></td>`;
    filaOriginal.after(tr);
  } catch (err) {
    alert(err.message);
  }
}

// --- ÍTEMS DINÁMICOS DE ORDEN (mismo patrón que cotización) ---
// Reutiliza UNIDADES_MEDIDA, OPCIONES_IMPUESTO y etiquetaImpuesto, que
// ya están definidos más arriba para los ítems de cotización.
function crearFilaItemOrden(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="item-concepto" placeholder="Concepto" required></td>
    <td><input type="number" class="item-cantidad" placeholder="Cant." min="0" step="0.01" required></td>
    <td><select class="item-um">${UNIDADES_MEDIDA.map((u) => `<option value="${u}">${u}</option>`).join('')}</select></td>
    <td><input type="number" class="item-valor-unitario" placeholder="Valor unit." min="0" required></td>
    <td>
      <select class="item-tipo-impuesto">${OPCIONES_IMPUESTO.map((o) => `<option value="${o.value}">${o.texto}</option>`).join('')}</select>
      <input type="number" class="item-impuesto-manual" min="0" max="100" placeholder="%" hidden>
    </td>
    <td class="num item-total-texto">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-item">Quitar</button></td>
  `;
  tr.querySelectorAll('input').forEach((input) => input.addEventListener('input', recalcularTotalesOrden));
  tr.querySelector('.item-tipo-impuesto').addEventListener('change', (e) => {
    const manual = tr.querySelector('.item-impuesto-manual');
    manual.hidden = !e.target.value.startsWith('otro-');
    recalcularTotalesOrden();
  });
  tr.querySelector('.btn-quitar-item').addEventListener('click', () => {
    tr.remove();
    recalcularTotalesOrden();
  });

  if (item) {
    tr.querySelector('.item-concepto').value = item.concepto;
    tr.querySelector('.item-cantidad').value = item.cantidad;
    tr.querySelector('.item-um').value = item.unidadMedida;
    tr.querySelector('.item-valor-unitario').value = item.valorUnitario;

    const selectImpuesto = tr.querySelector('.item-tipo-impuesto');
    const valorCombinado = `${item.tipoImpuesto}-${item.impuestoPorcentaje}`;
    const coincide = Array.from(selectImpuesto.options).some((o) => o.value === valorCombinado);
    if (coincide) {
      selectImpuesto.value = valorCombinado;
    } else {
      selectImpuesto.value = 'otro-';
      const manual = tr.querySelector('.item-impuesto-manual');
      manual.hidden = false;
      manual.value = item.impuestoPorcentaje;
    }
  }

  return tr;
}

document.getElementById('btn-agregar-item-orden').addEventListener('click', () => {
  document.getElementById('items-orden-tbody').appendChild(crearFilaItemOrden());
});

function leerItemsOrden() {
  const filas = document.querySelectorAll('#items-orden-tbody tr');
  return Array.from(filas).map((fila) => {
    const cantidad = Number(fila.querySelector('.item-cantidad').value || 0);
    const valorUnitario = Number(fila.querySelector('.item-valor-unitario').value || 0);
    const seleccion = fila.querySelector('.item-tipo-impuesto').value;
    const [tipoBruto, porcentajeTexto] = seleccion.split('-');
    let tipoImpuesto = tipoBruto;
    let impuestoPorcentaje = Number(porcentajeTexto);
    if (tipoBruto === 'otro') {
      tipoImpuesto = 'iva';
      impuestoPorcentaje = Number(fila.querySelector('.item-impuesto-manual').value || 0);
    }
    const valorTotal = cantidad * valorUnitario;
    fila.querySelector('.item-total-texto').textContent = formatoDinero(valorTotal);
    return {
      concepto: fila.querySelector('.item-concepto').value,
      cantidad,
      unidadMedida: fila.querySelector('.item-um').value,
      valorUnitario,
      tipoImpuesto,
      impuestoPorcentaje,
      valorTotal,
    };
  });
}

// --- RETENCIÓN EN LA FUENTE (catálogo 2026, ver retencionesCatalogo.js) ---
// Desplegable de conceptos agrupado por categoría.
function opcionesConceptoRetencionHtml() {
  const cat = retencionesCatalogo;
  const grupos = {};
  cat.CONCEPTOS.forEach((c) => (grupos[c.categoria] = grupos[c.categoria] || []).push(c));
  const porGrupo = Object.entries(grupos)
    .map(
      ([nombre, lista]) =>
        `<optgroup label="${nombre}">` +
        lista
          .map(
            (c) =>
              `<option value="${c.codigo}" title="${(c.detalle || c.nombre).replace(/"/g, '&quot;')}">${c.nombre} — ${c.tarifa.toLocaleString('es-CO')}%</option>`
          )
          .join('') +
        '</optgroup>'
    )
    .join('');
  return `<option value="">Elegir concepto...</option>${porGrupo}<option value="${cat.CONCEPTO_MANUAL.codigo}">${cat.CONCEPTO_MANUAL.nombre}</option>`;
}

function crearFilaRetencion(linea, alCambiar) {
  const avisar = alCambiar || recalcularTotalesOrden;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="item-ret-concepto">${opcionesConceptoRetencionHtml()}</select>
      <span class="ret-nota" hidden></span>
    </td>
    <td><input type="number" class="item-ret-tarifa" min="0" max="100" step="0.01" placeholder="%" readonly> %</td>
    <td class="num ret-base">—</td>
    <td class="num ret-tope">—</td>
    <td class="num ret-valor">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-retencion">Quitar</button></td>
  `;
  const select = tr.querySelector('.item-ret-concepto');
  const tarifa = tr.querySelector('.item-ret-tarifa');
  select.addEventListener('change', () => {
    const concepto = retencionesCatalogo.porCodigo(select.value);
    // La tarifa sale del catálogo; solo "Otro concepto" se digita a mano.
    tarifa.readOnly = !(concepto && concepto.manual);
    tarifa.value = concepto ? (concepto.manual ? '' : concepto.tarifa) : '';
    avisar();
  });
  tarifa.addEventListener('input', avisar);
  tr.querySelector('.btn-quitar-retencion').addEventListener('click', () => {
    tr.remove();
    avisar();
  });

  if (linea) {
    select.value = linea.codigo || '';
    const concepto = retencionesCatalogo.porCodigo(select.value);
    tarifa.readOnly = !(concepto && concepto.manual);
    tarifa.value = linea.tarifa !== undefined && linea.tarifa !== null ? Number(linea.tarifa) : '';
  }
  return tr;
}

function modoRetencionOrden() {
  return document.querySelector('input[name="orden-retencion-modo"]:checked').value;
}

// Lo que se manda al servidor por cada retención: solo el código (y la
// tarifa si es "Otro concepto"). El servidor toma lo demás del catálogo.
function leerRetencionesOrden(idTbody) {
  return Array.from(document.querySelectorAll('#' + (idTbody || 'retenciones-orden-tbody') + ' tr')).map((tr) => {
    const codigo = tr.querySelector('.item-ret-concepto').value;
    const concepto = retencionesCatalogo.porCodigo(codigo);
    return {
      codigo,
      tarifa: concepto && concepto.manual ? Number(tr.querySelector('.item-ret-tarifa').value || 0) : undefined,
    };
  });
}

// Junta lo que hay en el formulario con la forma que espera
// calcularOrden() (el mismo cálculo que corre el servidor al guardar).
function leerDatosOrden() {
  const tipo = document.getElementById('orden-tipo').value;
  const aplicaAiu = tipo === 'servicios' && document.getElementById('orden-aplica-aiu').checked;
  const retencionModo = modoRetencionOrden();

  return {
    tipo,
    items: leerItemsOrden(),
    aplicaAiu,
    aiuAdministracion: Number(document.getElementById('orden-aiu-administracion').value || 0),
    aiuImprevistos: Number(document.getElementById('orden-aiu-imprevistos').value || 0),
    aiuUtilidad: Number(document.getElementById('orden-aiu-utilidad').value || 0),
    aiuBaseIva: document.getElementById('orden-aiu-base-iva').value,
    retencionModo,
    retencionMotivo: document.getElementById('orden-retencion-motivo').value,
    retencionDetalle: document.getElementById('orden-retencion-detalle').value,
    // Una especificación por fila (aunque esté a medias, queda en cero)
    // para poder pintar cada resultado en su propia fila.
    retenciones:
      retencionModo === 'aplica'
        ? leerRetencionesOrden().map((r) => retencionesCatalogo.especificar(r, { estricto: false }))
        : [],
  };
}

function recalcularTotalesOrden() {
  // estricto:false → mientras se digita no se lanzan errores (ej.
  // retención sin concepto todavía); el servidor sí valida al guardar.
  const datos = leerDatosOrden();
  const { cabecera: c, netoAPagar } = calcularOrden(datos, { estricto: false });

  document.getElementById('valor-orden-aiu-administracion').textContent = formatoDineroDec(c.aiuAdministracionValor);
  document.getElementById('valor-orden-aiu-imprevistos').textContent = formatoDineroDec(c.aiuImprevistosValor);
  document.getElementById('valor-orden-aiu-utilidad').textContent = formatoDineroDec(c.aiuUtilidadValor);

  // Cada fila de retención muestra su base, su tope y su valor.
  document.querySelectorAll('#retenciones-orden-tbody tr').forEach((tr, i) => {
    const l = c.retenciones[i];
    if (!l) return;
    tr.querySelector('.ret-base').textContent = l.codigo ? formatoDineroDec(l.base) : '—';
    tr.querySelector('.ret-tope').textContent = l.codigo ? (l.baseMinima > 0 ? formatoDineroDec(l.baseMinima) : 'Sin tope') : '—';
    const valor = tr.querySelector('.ret-valor');
    valor.textContent = formatoDineroDec(l.valor);
    valor.classList.toggle('ret-sin-efecto', l.valor === 0);
    const nota = tr.querySelector('.ret-nota');
    nota.textContent = l.nota;
    nota.hidden = !l.nota;
  });

  document.getElementById('resumen-subtotal-orden').textContent = formatoDineroDec(c.subtotal);
  document.getElementById('resumen-aiu-orden').textContent = formatoDineroDec(c.aiuTotal);
  document.getElementById('resumen-aiu-orden-fila').hidden = !c.aplicaAiu;
  document.getElementById('resumen-iva-orden').textContent = formatoDineroDec(c.iva);
  document.getElementById('resumen-impoconsumo-orden').textContent = formatoDineroDec(c.impoconsumo);
  document.getElementById('resumen-total-orden').textContent = formatoDineroDec(c.total);

  const aplica = c.retencionModo === 'aplica';
  const noAplica = c.retencionModo === 'no_aplica';
  document.getElementById('resumen-retencion-orden').textContent = noAplica
    ? 'No aplica' + (c.retencionMotivo ? ' — ' + c.retencionMotivo : '')
    : '− ' + formatoDineroDec(c.retencionValor);
  document.getElementById('resumen-retencion-orden-fila').hidden = !(aplica || noAplica);
  document.getElementById('resumen-neto-orden').textContent = formatoDineroDec(netoAPagar);
  document.getElementById('resumen-neto-orden-fila').hidden = !(aplica || noAplica);

  document.getElementById('nota-retencion-orden').textContent =
    `Conceptos y tarifas ${retencionesCatalogo.ANIO} (UVT ${formatoDineroDec(retencionesCatalogo.UVT_VALOR)}). ` +
    'Elige el concepto según el bien o servicio de la orden. La base se mide antes de impuestos; si no alcanza el tope mínimo, esa retención no se practica. ' +
    'Si el proveedor no está sujeto (Régimen Simple, tratamiento especial), usa "No aplica retención".';
}

// Muestra/oculta los bloques según el tipo de orden y las opciones.
// El AIU solo existe en compra de SERVICIOS; al pasar a "bienes" se
// apaga para que no quede un AIU "fantasma" afectando el total.
function actualizarVisibilidadOrden() {
  const esServicios = document.getElementById('orden-tipo').value === 'servicios';
  document.getElementById('bloque-aiu-orden').hidden = !esServicios;
  if (!esServicios) document.getElementById('orden-aplica-aiu').checked = false;

  document.getElementById('campos-aiu-orden').hidden = !document.getElementById('orden-aplica-aiu').checked;

  const modo = modoRetencionOrden();
  document.getElementById('retencion-aplica-orden').hidden = modo !== 'aplica';
  document.getElementById('retencion-no-aplica-orden').hidden = modo !== 'no_aplica';
  // Al elegir "Aplicar" aparece ya la primera fila para elegir concepto.
  const tbody = document.getElementById('retenciones-orden-tbody');
  if (modo === 'aplica' && tbody.children.length === 0) tbody.appendChild(crearFilaRetencion());
}

document.getElementById('orden-tipo').addEventListener('change', () => {
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
});
document.getElementById('orden-aplica-aiu').addEventListener('change', () => {
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
});
document.querySelectorAll('input[name="orden-retencion-modo"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    actualizarVisibilidadOrden();
    recalcularTotalesOrden();
  })
);
document.getElementById('btn-agregar-retencion-orden').addEventListener('click', () => {
  document.getElementById('retenciones-orden-tbody').appendChild(crearFilaRetencion());
});
document.getElementById('orden-retencion-motivo').innerHTML =
  '<option value="">Elegir motivo...</option>' +
  retencionesCatalogo.MOTIVOS_NO_APLICA.map((m) => `<option value="${m}">${m}</option>`).join('');
document
  .querySelectorAll('#campos-aiu-orden input, #campos-aiu-orden select, #orden-retencion-motivo, #orden-retencion-detalle')
  .forEach((el) => {
    el.addEventListener('input', recalcularTotalesOrden);
    el.addEventListener('change', recalcularTotalesOrden);
  });

function limpiarFormularioOrden() {
  document.getElementById('items-orden-tbody').innerHTML = '';
  ordenEditandoId = null;
  document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar';

  document.getElementById('orden-aplica-aiu').checked = false;
  ['administracion', 'imprevistos', 'utilidad'].forEach((n) => (document.getElementById('orden-aiu-' + n).value = ''));
  document.getElementById('orden-aiu-base-iva').value = 'total';

  document.querySelector('input[name="orden-retencion-modo"][value="ninguna"]').checked = true;
  document.getElementById('retenciones-orden-tbody').innerHTML = '';
  document.getElementById('orden-retencion-motivo').value = '';
  document.getElementById('orden-retencion-detalle').value = '';
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
}

// null = creando una orden nueva; con un id, editando esa orden
// existente — mismo patrón que cotizaciones.
let ordenEditandoId = null;

async function abrirEdicionOrden(id) {
  try {
    const orden = await api(`/compras/ordenes/${id}`);
    if (orden.estado !== 'borrador') {
      alert('Solo se puede editar una orden en estado "borrador".');
      return;
    }

    ordenEditandoId = id;
    document.getElementById('form-orden').hidden = false;
    document.getElementById('orden-tercero').value = orden.terceroId;
    document.getElementById('orden-tipo').value = orden.tipo;
    document.getElementById('orden-proyecto-id').value = orden.proyectoId || '';
    document.getElementById('orden-lugar-entrega').value = orden.lugarEntrega || '';
    document.getElementById('orden-forma-pago').value = orden.formaPago || '';

    // Un proyecto desactivado ya no está en el selector; se agrega solo
    // para que la orden no pierda su proyecto al editarla.
    const selectProyecto = document.getElementById('orden-proyecto-id');
    if (orden.proyectoId && !Array.from(selectProyecto.options).some((o) => o.value === orden.proyectoId)) {
      selectProyecto.add(new Option(nombreProyecto(orden.proyectoId) + ' (inactivo)', orden.proyectoId));
    }
    selectProyecto.value = orden.proyectoId || '';

    document.getElementById('orden-aplica-aiu').checked = !!orden.aplicaAiu;
    document.getElementById('orden-aiu-administracion').value = Number(orden.aiuAdministracion) || '';
    document.getElementById('orden-aiu-imprevistos').value = Number(orden.aiuImprevistos) || '';
    document.getElementById('orden-aiu-utilidad').value = Number(orden.aiuUtilidad) || '';
    document.getElementById('orden-aiu-base-iva').value = orden.aiuBaseIva || 'total';

    // Retención: se recrean las filas desde la foto guardada en la orden.
    const modo = orden.retencionModo || 'ninguna';
    document.querySelector(`input[name="orden-retencion-modo"][value="${modo}"]`).checked = true;
    const tbodyRet = document.getElementById('retenciones-orden-tbody');
    tbodyRet.innerHTML = '';
    if (modo === 'aplica') (orden.retenciones || []).forEach((l) => tbodyRet.appendChild(crearFilaRetencion(l)));
    document.getElementById('orden-retencion-motivo').value = orden.retencionMotivo || '';
    document.getElementById('orden-retencion-detalle').value = orden.retencionDetalle || '';
    actualizarVisibilidadOrden();

    const tbody = document.getElementById('items-orden-tbody');
    tbody.innerHTML = '';
    const items = orden.items || [];
    if (items.length > 0) items.forEach((item) => tbody.appendChild(crearFilaItemOrden(item)));
    else tbody.appendChild(crearFilaItemOrden());

    recalcularTotalesOrden();
    document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar cambios';
    document.getElementById('form-orden').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('btn-nueva-orden').addEventListener('click', () => {
  ordenEditandoId = null;
  document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar';
  actualizarVisibilidadOrden();
  if (document.getElementById('items-orden-tbody').children.length === 0) {
    document.getElementById('items-orden-tbody').appendChild(crearFilaItemOrden());
  }
});
document.getElementById('btn-cancelar-orden').addEventListener('click', limpiarFormularioOrden);

conectarFormulario('form-orden', async () => {
  const datosCalculo = leerDatosOrden();
  const items = datosCalculo.items;
  if (items.length === 0 || items.some((i) => !i.concepto || i.cantidad <= 0)) {
    throw new Error('Agrega al menos un ítem con concepto y cantidad mayor a cero.');
  }
  if (datosCalculo.retencionModo === 'aplica') {
    const filas = leerRetencionesOrden();
    if (filas.length === 0 || filas.some((r) => !r.codigo)) {
      throw new Error('Elige el concepto de cada retención, o cambia a "No aplica retención".');
    }
    if (filas.some((r) => r.codigo === retencionesCatalogo.CONCEPTO_MANUAL.codigo && !(r.tarifa > 0))) {
      throw new Error('En "Otro concepto" digita la tarifa de la retención.');
    }
  }
  if (datosCalculo.retencionModo === 'no_aplica' && !datosCalculo.retencionMotivo) {
    throw new Error('Elige el motivo por el cual no aplica la retención en la fuente.');
  }

  const cuerpo = {
    terceroId: document.getElementById('orden-tercero').value,
    tipo: document.getElementById('orden-tipo').value,
    proyectoId: document.getElementById('orden-proyecto-id').value || undefined,
    lugarEntrega: document.getElementById('orden-lugar-entrega').value || undefined,
    formaPago: document.getElementById('orden-forma-pago').value || undefined,
    items,
    // AIU y retención: mismos datos que alimentan la vista previa de totales.
    aplicaAiu: datosCalculo.aplicaAiu,
    aiuAdministracion: datosCalculo.aiuAdministracion,
    aiuImprevistos: datosCalculo.aiuImprevistos,
    aiuUtilidad: datosCalculo.aiuUtilidad,
    aiuBaseIva: datosCalculo.aiuBaseIva,
    retencionModo: datosCalculo.retencionModo,
    retenciones: datosCalculo.retencionModo === 'aplica' ? leerRetencionesOrden() : [],
    retencionMotivo: datosCalculo.retencionModo === 'no_aplica' ? datosCalculo.retencionMotivo : undefined,
    retencionDetalle: datosCalculo.retencionModo === 'no_aplica' ? datosCalculo.retencionDetalle || undefined : undefined,
  };

  if (ordenEditandoId) {
    await api(`/compras/ordenes/${ordenEditandoId}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  } else {
    await api('/compras/ordenes', { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  limpiarFormularioOrden();
  document.getElementById('form-orden').hidden = true;
});

// --- VER ÍTEMS de una orden existente (fila expandible, mismo patrón que cotización) ---
async function verItemsOrden(id) {
  const filaDetalleExistente = document.getElementById('detalle-orden-' + id);
  if (filaDetalleExistente) {
    filaDetalleExistente.remove();
    return;
  }

  try {
    const orden = await api(`/compras/ordenes/${id}`);
    const filaOriginal = document.querySelector(`tr[data-fila-orden="${id}"]`);
    if (!filaOriginal) return;

    const itemsHtml = (orden.items || [])
      .map(
        (it) =>
          `<tr><td>${it.concepto}</td><td class="num">${Number(it.cantidad).toLocaleString('es-CO')} ${
            it.unidadMedida
          }</td><td class="num">${formatoDinero(it.valorUnitario)}</td><td class="num">${etiquetaImpuesto(
            it.tipoImpuesto,
            it.impuestoPorcentaje
          )}</td><td class="num">${formatoDinero(it.valorTotal)}</td></tr>`
      )
      .join('');

    const tr = document.createElement('tr');
    tr.id = 'detalle-orden-' + id;
    tr.innerHTML = `<td colspan="8"><div class="detalle-items">
      <table class="tabla-items-detalle">
        <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead>
        <tbody>${
          itemsHtml ||
          '<tr><td colspan="5" class="vacio">Esta orden no tiene ítems registrados (se creó antes de esta función).</td></tr>'
        }</tbody>
      </table>
      ${resumenTotalesOrdenHtml(orden)}
    </div></td>`;
    filaOriginal.after(tr);
  } catch (err) {
    alert(err.message);
  }
}

// Desglose en texto bajo los ítems: AIU, impuestos, retención y neto.
function resumenTotalesOrdenHtml(orden) {
  const c = orden.calculo;
  if (!c) return '';
  const partes = [`Subtotal ${formatoDineroDec(c.subtotal)}`];
  if (c.aplicaAiu) {
    partes.push(
      `AIU: Administración ${c.aiuAdministracion}% (${formatoDineroDec(c.aiuAdministracionValor)}) · Imprevistos ${
        c.aiuImprevistos
      }% (${formatoDineroDec(c.aiuImprevistosValor)}) · Utilidad ${c.aiuUtilidad}% (${formatoDineroDec(
        c.aiuUtilidadValor
      )}) — IVA sobre ${c.aiuBaseIva === 'utilidad' ? 'la Utilidad' : 'subtotal + AIU'}`
    );
  }
  partes.push(`IVA ${formatoDineroDec(c.iva)}`);
  if (c.impoconsumo > 0) partes.push(`Impoconsumo ${formatoDineroDec(c.impoconsumo)}`);
  partes.push(`<strong>Total ${formatoDineroDec(c.total)}</strong>`);
  if (c.retencionModo === 'aplica') {
    c.retenciones.forEach((l) => {
      partes.push(
        `Retención: ${l.nombre} ${l.tarifa}% sobre ${formatoDineroDec(l.base)} → ` +
          (l.aplica ? `− ${formatoDineroDec(l.valor)}` : 'no se practica (no alcanza el tope)')
      );
    });
    partes.push(`<strong>A consignar al proveedor ${formatoDineroDec(c.netoAPagar)}</strong>`);
  } else if (c.retencionModo === 'no_aplica') {
    partes.push(`No aplica retención en la fuente: ${c.retencionMotivo}${c.retencionDetalle ? ' (' + c.retencionDetalle + ')' : ''}`);
  }
  return `<p class="nota-aiu">${partes.join(' · ')}</p>`;
}

conectarFormulario('form-periodo', () =>
  api('/nomina/periodos', {
    method: 'POST',
    body: JSON.stringify({
      fechaInicio: document.getElementById('periodo-inicio').value,
      fechaFin: document.getElementById('periodo-fin').value,
    }),
  })
);

conectarFormulario('form-producto', () =>
  api('/inventarios/productos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('producto-nombre').value,
      tipo: document.getElementById('producto-tipo').value,
      unidadMedida: document.getElementById('producto-unidad').value || 'unidad',
    }),
  })
);

conectarFormulario('form-activo', () =>
  api('/activos-fijos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('activo-nombre').value,
      costo: Number(document.getElementById('activo-costo').value),
      vidaUtilMeses: Number(document.getElementById('activo-vida-util').value),
    }),
  })
);

conectarFormulario('form-cuenta', () =>
  api('/tesoreria/cuentas', {
    method: 'POST',
    body: JSON.stringify({
      banco: document.getElementById('cuenta-banco').value,
      numero: document.getElementById('cuenta-numero').value,
    }),
  })
);

conectarFormulario('form-movimiento', () =>
  api('/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      cuentaBancariaId: document.getElementById('movimiento-cuenta').value,
      tipo: document.getElementById('movimiento-tipo').value,
      valor: Number(document.getElementById('movimiento-valor').value),
      descripcion: document.getElementById('movimiento-descripcion').value || undefined,
    }),
  })
);

// --- BOTÓN GENERAL: correr depreciación del mes ---
document.getElementById('btn-depreciar').addEventListener('click', async () => {
  if (!confirm('¿Correr la depreciación mensual de todos los activos fijos activos?')) return;
  await accion('/activos-fijos/depreciar', { method: 'POST' });
});

// --- FACTURAS DE COMPRA: CARGA DEL XML DEL PROVEEDOR ---
// Flujo: elegir archivo -> el servidor lo lee (sin guardar nada) -> se revisa
// en pantalla (proveedor, orden, cuentas, retención, asiento) -> confirmar.
// El servidor vuelve a leer el XML al registrar: nada de lo que se ve aquí
// se toma como verdad, solo las decisiones de la persona.

function escHtml(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NOMBRES_CUENTAS_FIJAS = {
  1355: 'IVA descontable',
  2205: 'Proveedores nacionales',
  2365: 'Retención en la fuente por pagar',
  2367: 'ReteIVA por pagar',
};
const TAMANO_MAX_XML = 3.5 * 1024 * 1024;

const fx = {
  base64: null,
  nombre: '',
  preview: null,
  ordenId: '',
  tocado: { cuentas: new Set(), proyecto: false, retencion: false },
  enviando: false,
};

const dialogoFx = document.getElementById('dialogo-factura-xml');

function fxReiniciar() {
  fx.base64 = null;
  fx.nombre = '';
  fx.preview = null;
  fx.ordenId = '';
  fx.tocado = { cuentas: new Set(), proyecto: false, retencion: false };
  fx.enviando = false;
  document.getElementById('fx-archivo').value = '';
  document.getElementById('fx-paso-archivo').hidden = false;
  document.getElementById('fx-revision').hidden = true;
  document.getElementById('fx-estado-lectura').textContent = '';
  document.getElementById('fx-estado-lectura').classList.remove('error');
  document.getElementById('fx-zona-archivo').classList.remove('error', 'arrastrando');
  document.getElementById('fx-error').hidden = true;
  document.getElementById('fx-ayuda').textContent = '';
  document.getElementById('btn-registrar-factura-xml').disabled = true;
  document.getElementById('fx-retenciones-tbody').innerHTML = '';
  document.getElementById('fx-aceptar').checked = false;
  document.getElementById('fx-aiu').value = '';
  document.querySelectorAll('input[name="fx-retencion-modo"]').forEach((r) => (r.checked = false));
}

function abrirDialogoFacturaXml() {
  fxReiniciar();
  if (typeof dialogoFx.showModal === 'function') dialogoFx.showModal();
  else dialogoFx.setAttribute('open', '');
}

function cerrarDialogoFacturaXml() {
  if (fx.enviando) return;
  dialogoFx.close();
}

function archivoABase64(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split(',')[1] || '');
    lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    lector.readAsDataURL(archivo);
  });
}

function fxMostrarEstado(texto, esError) {
  const el = document.getElementById('fx-estado-lectura');
  el.textContent = texto;
  el.classList.toggle('error', !!esError);
  document.getElementById('fx-zona-archivo').classList.toggle('error', !!esError);
}

async function procesarArchivoFactura(archivo) {
  if (!archivo) return;
  if (archivo.size > TAMANO_MAX_XML) {
    fxMostrarEstado('El archivo pesa demasiado (máximo 3,5 MB). Sube solo el XML de la factura.', true);
    return;
  }
  fxMostrarEstado('Leyendo la factura...');
  try {
    fx.base64 = await archivoABase64(archivo);
    fx.nombre = archivo.name;
    fx.preview = await api('/compras/facturas/xml/previsualizar', {
      method: 'POST',
      body: JSON.stringify({ archivoBase64: fx.base64 }),
    });
    fxMostrarRevision();
  } catch (err) {
    fx.base64 = null;
    fx.preview = null;
    fxMostrarEstado(err.message, true);
  }
}

// Orden candidata elegida actualmente (o null).
function fxOrdenElegida() {
  if (!fx.preview || !fx.ordenId) return null;
  return fx.preview.ordenesCandidatas.find((o) => o.id === fx.ordenId) || null;
}

function fxCuentaPorDefecto() {
  const orden = fxOrdenElegida();
  const sug = fx.preview.destinosSugeridos;
  return orden && orden.tipo === 'bienes' ? sug.bienes : sug.gasto;
}

function fxOpcionesCuentas(seleccionada) {
  return fx.preview.cuentasDestino
    .map((c) => `<option value="${escHtml(c.codigo)}"${c.codigo === seleccionada ? ' selected' : ''}>${escHtml(c.codigo)} — ${escHtml(c.nombre)}</option>`)
    .join('');
}

function fxRenderAdvertencias() {
  const lista = fx.preview.advertencias;
  const etiqueta = { bloqueo: 'No se puede registrar', confirmar: 'Revisa', info: 'Aviso' };
  document.getElementById('fx-advertencias').innerHTML = lista
    .map((a) => `<div class="fx-aviso ${a.nivel}"><strong>${etiqueta[a.nivel] || ''}:</strong> ${escHtml(a.texto)}</div>`)
    .join('');
  const hayConfirmar = lista.some((a) => a.nivel === 'confirmar');
  document.getElementById('fx-aceptar-fila').hidden = !hayConfirmar;
  if (!hayConfirmar) document.getElementById('fx-aceptar').checked = false;
}

function fxRenderResumen() {
  const p = fx.preview;
  const f = p.factura;
  const dian = f.validacionDian.disponible
    ? f.validacionDian.validada
      ? '<span class="badge libre aceptada">Validada por la DIAN</span>'
      : '<span class="badge libre rechazada">No validada</span>'
    : '<span class="badge libre pendiente">Sin respuesta de la DIAN en el archivo</span>';
  const filas = [
    ['Documento', `${escHtml(f.tipoNombre)} <strong>${escHtml(f.numero || '—')}</strong>`],
    ['Fecha de emisión', escHtml(formatoFecha(f.fechaEmision))],
    ['Forma de pago', f.formaPago === 'credito' ? `Crédito${f.fechaVencimiento ? ' · vence ' + escHtml(formatoFecha(f.fechaVencimiento)) : ''}` : f.formaPago === 'contado' ? 'Contado' : '—'],
    ['Emisor', `${escHtml(f.emisor.nombre)}<br>NIT ${escHtml(f.emisor.nit)}${f.emisor.dv ? '-' + escHtml(f.emisor.dv) : ''}`],
    ['Total factura', `<strong>${escHtml(formatoDineroDec(f.totales.conImpuestos))}</strong>`],
    ['Validación', dian],
    [
      'CUFE',
      `<span class="mono" title="${escHtml(f.cufe)}">${escHtml(f.cufe.slice(0, 18))}…${escHtml(f.cufe.slice(-8))}</span>` +
        (p.verificacionDianUrl ? `<br><a href="${escHtml(p.verificacionDianUrl)}" target="_blank" rel="noopener noreferrer">Verificar en la DIAN</a>` : ''),
    ],
    ['Archivo', `${escHtml(fx.nombre)}<br><a href="#" id="fx-otro-archivo">Cargar otro archivo</a>`],
  ];
  document.getElementById('fx-resumen').innerHTML = filas.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function fxRenderProveedor() {
  const p = fx.preview;
  const e = p.factura.emisor;
  const el = document.getElementById('fx-proveedor');
  const fila = document.getElementById('fx-crear-proveedor-fila');
  if (p.proveedor) {
    el.innerHTML = `✔ <strong>${escHtml(p.proveedor.nombre)}</strong> (${escHtml(p.proveedor.identificacion)}) ya está en Terceros.`;
    fila.hidden = true;
  } else {
    el.innerHTML = `<strong>${escHtml(e.nombre)}</strong> · NIT ${escHtml(e.nit)}${e.dv ? '-' + escHtml(e.dv) : ''} no está en Terceros.`;
    fila.hidden = false;
  }
}

function fxRenderOrdenes() {
  const p = fx.preview;
  const sel = document.getElementById('fx-orden');
  sel.innerHTML =
    '<option value="">Sin orden (compra directa)</option>' +
    p.ordenesCandidatas
      .map(
        (o) =>
          `<option value="${escHtml(o.id)}"${o.id === fx.ordenId ? ' selected' : ''}>${escHtml(o.consecutivo)} · ${escHtml(o.tipo)} · ${escHtml(
            formatoDineroDec(o.total)
          )}${o.coincideReferencia ? ' · citada' : o.sugerida ? ' · mismo valor' : ''}</option>`
      )
      .join('');
  document.getElementById('fx-orden-nota').textContent = p.ordenesCandidatas.length
    ? 'Vincula la factura a la orden aprobada: queda “facturada” y hereda proyecto y retención.'
    : p.proveedor
    ? 'Este proveedor no tiene órdenes aprobadas pendientes de facturar.'
    : '';
}

function fxRenderProyectos() {
  const sel = document.getElementById('fx-proyecto');
  sel.innerHTML =
    '<option value="">Sin proyecto</option>' +
    listaProyectos.filter((x) => x.activo).map((x) => `<option value="${escHtml(x.id)}">${escHtml(etiquetaProyecto(x))}</option>`).join('');
}

function fxRenderLineas() {
  const p = fx.preview;
  const defecto = fxCuentaPorDefecto();
  document.querySelector('#fx-tabla-lineas tbody').innerHTML = p.factura.lineas
    .map(
      (l, i) =>
        `<tr><td>${escHtml(l.numero)}</td><td>${escHtml(l.descripcion)}${l.gratuita ? ' <span class="badge">sin costo</span>' : ''}</td>` +
        `<td class="num">${escHtml(l.cantidad)}</td><td class="num">${escHtml(formatoDineroDec(l.valorTotal))}</td>` +
        `<td class="num">${escHtml(formatoDineroDec(l.iva))}</td>` +
        `<td><select class="fx-cuenta-linea" data-linea="${i}">${fxOpcionesCuentas(defecto)}</select></td></tr>`
    )
    .join('');
  document.getElementById('fx-cuenta-todas').innerHTML = '<option value="">Elegir...</option>' + fxOpcionesCuentas('');
}

// Retención inicial: la de la orden si hay una; si no, lo que sugiere el XML.
function fxPrecargarRetencion() {
  const p = fx.preview;
  const orden = fxOrdenElegida();
  const sugerenciaEl = document.getElementById('fx-retencion-sugerencia');
  let carga = null;
  let texto = '';

  if (orden && orden.retencion && ['aplica', 'no_aplica'].includes(orden.retencion.modo)) {
    carga = orden.retencion;
    texto = `Precargada desde la orden ${orden.consecutivo}. Se recalcula con los valores reales de la factura.`;
  } else if (p.retencionSugerida) {
    carga = { modo: p.retencionSugerida.modo, motivo: p.retencionSugerida.motivo, detalle: p.retencionSugerida.detalle, conceptos: [] };
    texto = p.retencionSugerida.texto;
  }

  const tbody = document.getElementById('fx-retenciones-tbody');
  tbody.innerHTML = '';
  document.querySelectorAll('input[name="fx-retencion-modo"]').forEach((r) => (r.checked = !!carga && r.value === carga.modo));
  document.getElementById('fx-retencion-motivo').value = carga ? carga.motivo : '';
  document.getElementById('fx-retencion-detalle').value = carga ? carga.detalle : '';
  if (carga && carga.modo === 'aplica') {
    carga.conceptos.forEach((c) => tbody.appendChild(crearFilaRetencion(c, fxAlCambiarRetencion)));
  }
  if (orden && orden.aiuTotal > 0) document.getElementById('fx-aiu').value = orden.aiuTotal;

  sugerenciaEl.textContent = texto;
  sugerenciaEl.hidden = !texto;
}

function fxAlCambiarRetencion() {
  fx.tocado.retencion = true;
  recalcularFactura();
}

function fxModoRetencion() {
  const marcado = document.querySelector('input[name="fx-retencion-modo"]:checked');
  return marcado ? marcado.value : '';
}

function fxMostrarRevision() {
  document.getElementById('fx-paso-archivo').hidden = true;
  document.getElementById('fx-revision').hidden = false;
  document.getElementById('fx-error').hidden = true;
  const p = fx.preview;

  // Si hay una orden claramente emparejada (la factura la cita, o mismo valor), se propone.
  const sugerida = p.ordenesCandidatas.find((o) => o.sugerida);
  fx.ordenId = sugerida ? sugerida.id : '';
  fx.tocado = { cuentas: new Set(), proyecto: false, retencion: false };

  fxRenderResumen();
  fxRenderProveedor();
  fxRenderOrdenes();
  fxRenderProyectos();
  fxRenderLineas();
  document.getElementById('fx-retencion-motivo').innerHTML =
    '<option value="">Elegir motivo...</option>' + retencionesCatalogo.MOTIVOS_NO_APLICA.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  fxAplicarOrden(true);
}

// Aplica lo que hereda de la orden elegida (proyecto, cuentas, retención) y
// refresca las advertencias (las del valor de la orden dependen de cuál se elija).
async function fxAplicarOrden(inicial) {
  const orden = fxOrdenElegida();
  if (!inicial) {
    try {
      const nuevo = await api('/compras/facturas/xml/previsualizar', {
        method: 'POST',
        body: JSON.stringify({ archivoBase64: fx.base64, ordenCompraId: fx.ordenId || undefined }),
      });
      fx.preview.advertencias = nuevo.advertencias;
    } catch (err) {
      document.getElementById('fx-error').textContent = err.message;
      document.getElementById('fx-error').hidden = false;
    }
  }
  fxRenderAdvertencias();

  if (!fx.tocado.proyecto) document.getElementById('fx-proyecto').value = orden && orden.proyectoId ? orden.proyectoId : '';
  const defecto = fxCuentaPorDefecto();
  document.querySelectorAll('.fx-cuenta-linea').forEach((sel) => {
    if (!fx.tocado.cuentas.has(Number(sel.dataset.linea))) sel.value = defecto;
  });
  if (!fx.tocado.retencion) fxPrecargarRetencion();
  recalcularFactura();
}

function fxLeerCuentasLineas() {
  const cuentas = {};
  document.querySelectorAll('.fx-cuenta-linea').forEach((sel) => (cuentas[Number(sel.dataset.linea)] = sel.value));
  return cuentas;
}

function fxNombreCuenta(codigo) {
  const c = fx.preview.cuentasDestino.find((x) => x.codigo === codigo);
  return c ? c.nombre : NOMBRES_CUENTAS_FIJAS[codigo] || '';
}

// Recalcula retención, asiento y totales con lo que hay en pantalla y
// decide si ya se puede registrar.
function recalcularFactura() {
  if (!fx.preview) return;
  const p = fx.preview;
  const c = p.contable;
  const modo = fxModoRetencion();

  document.getElementById('fx-retencion-aplica').hidden = modo !== 'aplica';
  document.getElementById('fx-retencion-no-aplica').hidden = modo !== 'no_aplica';
  if (modo === 'aplica' && document.getElementById('fx-retenciones-tbody').children.length === 0) {
    document.getElementById('fx-retenciones-tbody').appendChild(crearFilaRetencion(null, fxAlCambiarRetencion));
  }

  const entradas = modo === 'aplica' ? leerRetencionesOrden('fx-retenciones-tbody') : [];
  const hayConceptoSobreAiu = entradas.some((e) => {
    const k = retencionesCatalogo.porCodigo(e.codigo);
    return k && k.sobre === 'aiu';
  });
  document.getElementById('fx-aiu-fila').hidden = !hayConceptoSobreAiu;

  const ret = calcularOrden.calcularRetenciones(
    {
      base: c.base,
      iva: c.iva,
      aiuTotal: hayConceptoSobreAiu ? Number(document.getElementById('fx-aiu').value || 0) : 0,
      retencionModo: modo,
      retencionMotivo: document.getElementById('fx-retencion-motivo').value,
      retencionDetalle: document.getElementById('fx-retencion-detalle').value,
      retenciones: entradas.map((e) => retencionesCatalogo.especificar(e, { estricto: false })),
    },
    false
  );

  document.querySelectorAll('#fx-retenciones-tbody tr').forEach((tr, i) => {
    const l = ret.retenciones[i];
    if (!l) return;
    tr.querySelector('.ret-base').textContent = l.codigo ? formatoDineroDec(l.base) : '—';
    tr.querySelector('.ret-tope').textContent = l.codigo ? (l.baseMinima > 0 ? formatoDineroDec(l.baseMinima) : 'Sin tope') : '—';
    const valor = tr.querySelector('.ret-valor');
    valor.textContent = formatoDineroDec(l.valor);
    valor.classList.toggle('ret-sin-efecto', l.valor === 0);
    const nota = tr.querySelector('.ret-nota');
    nota.textContent = l.nota;
    nota.hidden = !l.nota;
  });
  document.getElementById('fx-nota-retencion').textContent =
    `Conceptos y tarifas ${retencionesCatalogo.ANIO} (UVT ${formatoDineroDec(retencionesCatalogo.UVT_VALOR)}). La base se mide antes de impuestos (${formatoDineroDec(c.base)}); ` +
    'si no alcanza el tope mínimo, esa retención no se practica.';

  // Asiento
  const proyectoSel = document.getElementById('fx-proyecto');
  const proyecto = listaProyectos.find((x) => x.id === proyectoSel.value);
  const cuentasPorLinea = fxLeerCuentasLineas();
  let asiento;
  try {
    asiento = asientoCompra.armarAsientoCompra({
      lineas: p.factura.lineas,
      base: c.base,
      iva: c.iva,
      impoconsumo: c.impoconsumo,
      total: c.total,
      ivaDescontable: c.ivaDescontable,
      cuentasLinea: p.factura.lineas.map((_, i) => cuentasPorLinea[i]),
      retenciones: ret.retenciones,
      centroCosto: proyecto ? proyecto.codigo || proyecto.nombre : null,
    });
  } catch (_) {
    asiento = null;
  }
  const tbody = document.querySelector('#fx-tabla-asiento tbody');
  const tfoot = document.querySelector('#fx-tabla-asiento tfoot');
  if (asiento) {
    tbody.innerHTML = asiento.lineas
      .map(
        (l) =>
          `<tr><td class="${l.credito ? 'indentar' : ''}">${escHtml(l.cuentaCodigo)} <span class="cuenta-nombre">${escHtml(fxNombreCuenta(l.cuentaCodigo))}</span>${
            l.centroCosto ? ` <span class="badge">${escHtml(l.centroCosto)}</span>` : ''
          }</td><td class="num">${l.debito ? escHtml(formatoDineroDec(l.debito)) : ''}</td><td class="num">${l.credito ? escHtml(formatoDineroDec(l.credito)) : ''}</td></tr>`
      )
      .join('');
    tfoot.innerHTML = `<tr><td>Sumas iguales${asiento.cuadra ? '' : ' — NO CUADRA'}</td><td class="num">${escHtml(formatoDineroDec(asiento.totalDebito))}</td><td class="num">${escHtml(
      formatoDineroDec(asiento.totalCredito)
    )}</td></tr>`;
  } else {
    tbody.innerHTML = '<tr><td colspan="3" class="vacio">Elige la cuenta de cada línea.</td></tr>';
    tfoot.innerHTML = '';
  }

  const neto = asiento ? asiento.netoAPagar : c.total - ret.retencionValor;
  document.getElementById('fx-totales').innerHTML =
    `<span>Base: <strong>${escHtml(formatoDineroDec(c.base))}</strong></span>` +
    `<span>IVA${c.ivaDescontable ? '' : ' (al gasto)'}: <strong>${escHtml(formatoDineroDec(c.iva))}</strong></span>` +
    (c.impoconsumo ? `<span>Impoconsumo: <strong>${escHtml(formatoDineroDec(c.impoconsumo))}</strong></span>` : '') +
    `<span>Total: <strong>${escHtml(formatoDineroDec(c.total))}</strong></span>` +
    `<span>Retención: <strong>− ${escHtml(formatoDineroDec(ret.retencionValor))}</strong></span>` +
    `<span>A pagar al proveedor: <strong class="neto">${escHtml(formatoDineroDec(neto))}</strong></span>`;

  // ¿Ya se puede registrar?
  const pendientes = [];
  if (p.advertencias.some((a) => a.nivel === 'bloqueo')) pendientes.push('La factura tiene errores que impiden registrarla.');
  if (!p.proveedor && !document.getElementById('fx-crear-proveedor').checked) pendientes.push('Marca “Crear este proveedor” (o créalo antes en Terceros).');
  if (!modo) pendientes.push('Decide la retención: aplicar o no aplicar.');
  if (modo === 'aplica' && (entradas.length === 0 || entradas.some((e) => !e.codigo))) pendientes.push('Elige el concepto de la retención.');
  if (modo === 'aplica' && entradas.some((e) => e.codigo === retencionesCatalogo.CONCEPTO_MANUAL.codigo && !(e.tarifa > 0))) pendientes.push('Escribe la tarifa del “Otro concepto”.');
  if (modo === 'no_aplica' && !document.getElementById('fx-retencion-motivo').value) pendientes.push('Elige el motivo por el que no aplica la retención.');
  if (p.advertencias.some((a) => a.nivel === 'confirmar') && !document.getElementById('fx-aceptar').checked) pendientes.push('Acepta las advertencias para continuar.');
  if (asiento && !asiento.cuadra) pendientes.push('El asiento no cuadra.');

  document.getElementById('fx-ayuda').textContent = pendientes[0] || 'Todo listo para contabilizar.';
  document.getElementById('btn-registrar-factura-xml').disabled = pendientes.length > 0 || fx.enviando;
  return { modo, ret, entradas };
}

async function registrarFacturaXml() {
  if (fx.enviando) return;
  const estado = recalcularFactura();
  const p = fx.preview;
  const errorEl = document.getElementById('fx-error');
  errorEl.hidden = true;

  const cargaRetenciones = estado.modo === 'aplica' ? estado.entradas.map((e) => ({ codigo: e.codigo, tarifa: e.tarifa })) : [];
  const cuerpo = {
    archivoBase64: fx.base64,
    ordenCompraId: fx.ordenId || undefined,
    terceroId: p.proveedor ? p.proveedor.id : undefined,
    crearProveedor: !p.proveedor && document.getElementById('fx-crear-proveedor').checked,
    proyectoId: document.getElementById('fx-proyecto').value || undefined,
    cuentasLineas: fxLeerCuentasLineas(),
    retencionModo: estado.modo,
    retencionMotivo: document.getElementById('fx-retencion-motivo').value,
    retencionDetalle: document.getElementById('fx-retencion-detalle').value,
    retenciones: cargaRetenciones,
    aiuTotal: Number(document.getElementById('fx-aiu').value || 0),
    aceptarAdvertencias: document.getElementById('fx-aceptar').checked,
  };

  const boton = document.getElementById('btn-registrar-factura-xml');
  fx.enviando = true;
  boton.disabled = true;
  boton.textContent = 'Registrando...';
  try {
    const resultado = await api('/compras/facturas/xml', { method: 'POST', body: JSON.stringify(cuerpo) });
    fx.enviando = false;
    dialogoFx.close();
    await cargarTodo();
    const avisos = [];
    if (!resultado.contabilizada) avisos.push('La factura quedó registrada, pero SIN asiento: la regla contable de este evento está en nivel manual. Contabilízala desde el módulo contable.');
    if (resultado.periodoAjustado) avisos.push('La fecha de la factura no cae en un periodo contable abierto; el asiento quedó con la fecha de hoy en el periodo vigente.');
    await abrirDetalleFactura(resultado.factura.id, avisos, 'Factura registrada y contabilizada.');
  } catch (err) {
    fx.enviando = false;
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    boton.textContent = 'Registrar y contabilizar';
    if (fx.preview) recalcularFactura();
  }
}

// --- Eventos de la ventana ---
document.getElementById('btn-cargar-factura-xml').addEventListener('click', abrirDialogoFacturaXml);
document.getElementById('btn-cerrar-factura-xml').addEventListener('click', cerrarDialogoFacturaXml);
document.getElementById('btn-cancelar-factura-xml').addEventListener('click', cerrarDialogoFacturaXml);
document.getElementById('btn-registrar-factura-xml').addEventListener('click', registrarFacturaXml);
dialogoFx.addEventListener('cancel', (e) => {
  if (fx.enviando) e.preventDefault();
});

const zonaArchivoFx = document.getElementById('fx-zona-archivo');
document.getElementById('fx-archivo').addEventListener('change', (e) => procesarArchivoFactura(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) =>
  zonaArchivoFx.addEventListener(ev, (e) => {
    e.preventDefault();
    zonaArchivoFx.classList.add('arrastrando');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  zonaArchivoFx.addEventListener(ev, (e) => {
    e.preventDefault();
    zonaArchivoFx.classList.remove('arrastrando');
  })
);
zonaArchivoFx.addEventListener('drop', (e) => procesarArchivoFactura(e.dataTransfer.files[0]));

document.getElementById('fx-resumen').addEventListener('click', (e) => {
  if (e.target.id !== 'fx-otro-archivo') return;
  e.preventDefault();
  fxReiniciar();
});

document.getElementById('fx-orden').addEventListener('change', (e) => {
  fx.ordenId = e.target.value;
  fxAplicarOrden(false);
});
document.getElementById('fx-proyecto').addEventListener('change', () => {
  fx.tocado.proyecto = true;
  recalcularFactura();
});
document.getElementById('fx-crear-proveedor').addEventListener('change', recalcularFactura);
document.getElementById('fx-aceptar').addEventListener('change', recalcularFactura);
document.getElementById('fx-tabla-lineas').addEventListener('change', (e) => {
  if (!e.target.classList.contains('fx-cuenta-linea')) return;
  fx.tocado.cuentas.add(Number(e.target.dataset.linea));
  recalcularFactura();
});
document.getElementById('fx-cuenta-todas').addEventListener('change', (e) => {
  if (!e.target.value) return;
  document.querySelectorAll('.fx-cuenta-linea').forEach((sel) => {
    sel.value = e.target.value;
    fx.tocado.cuentas.add(Number(sel.dataset.linea));
  });
  e.target.value = '';
  recalcularFactura();
});
document.querySelectorAll('input[name="fx-retencion-modo"]').forEach((radio) => radio.addEventListener('change', fxAlCambiarRetencion));
document.getElementById('btn-agregar-retencion-fx').addEventListener('click', () => {
  document.getElementById('fx-retenciones-tbody').appendChild(crearFilaRetencion(null, fxAlCambiarRetencion));
  fx.tocado.retencion = true;
});
['fx-retencion-motivo', 'fx-retencion-detalle', 'fx-aiu'].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener('input', fxAlCambiarRetencion);
  el.addEventListener('change', fxAlCambiarRetencion);
});

// --- Detalle de una factura registrada ---
const dialogoDetalle = document.getElementById('dialogo-factura-detalle');
let facturaDetalleId = null;

async function abrirDetalleFactura(id, avisos, mensajeOk) {
  try {
    const f = await api(`/compras/facturas/${id}`);
    facturaDetalleId = id;
    const det = f.detalle || {};
    const lineas = det.lineas || [];
    const retenciones = Array.isArray(f.retenciones) ? f.retenciones : [];
    const cuentaTxt = (codigo, nombre) => `${escHtml(codigo)} <span class="cuenta-nombre">${escHtml(nombre || '')}</span>`;

    document.getElementById('titulo-factura-detalle').textContent = `Factura de compra ${f.numero || ''}`.trim();
    document.getElementById('btn-xml-factura-detalle').hidden = !f.emisorNit;
    document.getElementById('fd-cuerpo').innerHTML =
      (mensajeOk ? `<div class="fd-aviso">${escHtml(mensajeOk)}</div>` : '') +
      (avisos || []).map((a) => `<div class="fd-aviso alerta">${escHtml(a)}</div>`).join('') +
      `<dl class="fx-resumen">` +
      [
        ['Proveedor', `${escHtml(f.emisorNombre || nombreTercero(f.terceroId))}${f.emisorNit ? '<br>NIT ' + escHtml(f.emisorNit) : ''}`],
        ['Fecha', escHtml(formatoFecha(f.fecha))],
        ['Forma de pago', f.formaPago === 'credito' ? `Crédito${f.fechaVencimiento ? ' · vence ' + escHtml(formatoFecha(f.fechaVencimiento)) : ''}` : f.formaPago === 'contado' ? 'Contado' : '—'],
        ['Orden de adquisición', f.ordenCompraOrigenId ? 'Vinculada' : 'Compra directa'],
        ['Proyecto', escHtml(nombreProyecto(f.proyectoId))],
        ['Estado', badge(f.estadoConciliacion)],
        ['Total', `<strong>${escHtml(formatoDineroDec(f.total))}</strong>`],
        ['Retención', escHtml(formatoDineroDec(f.retencionValor))],
        ['A pagar al proveedor', `<strong>${escHtml(formatoDineroDec(f.netoAPagar === null || f.netoAPagar === undefined ? f.total : f.netoAPagar))}</strong>`],
        ['CUFE', f.cufe ? `<span class="mono" title="${escHtml(f.cufe)}">${escHtml(f.cufe.slice(0, 18))}…${escHtml(f.cufe.slice(-8))}</span>` : '—'],
      ]
        .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
        .join('') +
      `</dl>` +
      (lineas.length
        ? `<h4>Detalle</h4><table class="tabla-items-detalle"><thead><tr><th>#</th><th>Descripción</th><th class="num">Cant.</th><th class="num">Valor</th><th class="num">IVA</th><th>Cuenta</th></tr></thead><tbody>` +
          lineas
            .map(
              (l) =>
                `<tr><td>${escHtml(l.numero)}</td><td>${escHtml(l.descripcion)}</td><td class="num">${escHtml(l.cantidad)}</td><td class="num">${escHtml(formatoDineroDec(l.valorTotal))}</td><td class="num">${escHtml(
                  formatoDineroDec(l.iva)
                )}</td><td>${escHtml(l.cuentaCodigo)}</td></tr>`
            )
            .join('') +
          `</tbody></table>`
        : '') +
      (f.retencionModo === 'aplica' && retenciones.length
        ? `<h4>Retenciones practicadas</h4><table class="tabla-items-detalle"><thead><tr><th>Concepto</th><th class="num">Tarifa</th><th class="num">Base</th><th class="num">Valor</th></tr></thead><tbody>` +
          retenciones
            .map((r) => `<tr><td>${escHtml(r.nombre)}</td><td class="num">${escHtml(r.tarifa)}%</td><td class="num">${escHtml(formatoDineroDec(r.base))}</td><td class="num">${escHtml(formatoDineroDec(r.valor))}</td></tr>`)
            .join('') +
          `</tbody></table>`
        : f.retencionModo === 'no_aplica'
        ? `<h4>Retención</h4><p class="fx-texto">No aplica — ${escHtml(f.retencionMotivo || '')}</p>`
        : '') +
      `<h4>Asiento contable</h4>` +
      (f.asiento && f.asiento.length
        ? `<table class="tabla-items-detalle"><thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead><tbody>` +
          f.asiento
            .map(
              (m) =>
                `<tr><td class="${m.credito ? 'indentar' : ''}">${cuentaTxt(m.cuentaCodigo, m.cuentaNombre)}${m.centroCosto ? ` <span class="badge">${escHtml(m.centroCosto)}</span>` : ''}</td><td class="num">${
                  m.debito ? escHtml(formatoDineroDec(m.debito)) : ''
                }</td><td class="num">${m.credito ? escHtml(formatoDineroDec(m.credito)) : ''}</td></tr>`
            )
            .join('') +
          `</tbody></table>`
        : '<p class="fx-texto">Esta factura no tiene asiento (se generó antes del cargue por XML o está pendiente de contabilizar).</p>');

    if (typeof dialogoDetalle.showModal === 'function') dialogoDetalle.showModal();
    else dialogoDetalle.setAttribute('open', '');
  } catch (err) {
    alert(err.message);
  }
}

async function descargarXmlFactura(id) {
  try {
    const res = await fetch(`${API}/compras/facturas/${id}/xml`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo descargar el XML.');
    }
    const blob = await res.blob();
    const nombre = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = nombre ? nombre[1] : 'factura.xml';
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(enlace.href), 2000);
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('btn-cerrar-factura-detalle').addEventListener('click', () => dialogoDetalle.close());
document.getElementById('btn-listo-factura-detalle').addEventListener('click', () => dialogoDetalle.close());
document.getElementById('btn-xml-factura-detalle').addEventListener('click', () => facturaDetalleId && descargarXmlFactura(facturaDetalleId));

// --- ACCIONES POR FILA (delegación de eventos sobre todo el tablero) ---
document.getElementById('vista-dashboard').addEventListener('click', async (e) => {
  const boton = e.target.closest('.btn-accion');
  if (!boton) return;

  const { accion: tipoAccion, id } = boton.dataset;

  switch (tipoAccion) {
    case 'editar-tercero':
      return abrirEdicionTercero(id);

    case 'editar-proyecto':
      return abrirEdicionProyecto(id);

    case 'ver-factura-compra':
      return abrirDetalleFactura(id);

    case 'xml-factura-compra':
      return descargarXmlFactura(id);

    case 'ver-items-cotizacion':
      return verItemsCotizacion(id);

    case 'ver-pdf-cotizacion':
      window.open(`/contable/cotizacion-imprimir.html?id=${id}`, '_blank');
      return;

    case 'editar-cotizacion':
      return abrirEdicionCotizacion(id);

    case 'enviar-cotizacion':
      if (
        confirm(
          'Esto solo marca la cotización como "enviada" en el sistema — no manda ningún correo ni mensaje por sí solo.\n\nPara hacérsela llegar al cliente de verdad, usa "Ver PDF" y compártela tú mismo (correo, WhatsApp, etc.).\n\n¿Marcar como enviada?'
        )
      )
        return accion(`/ventas/cotizaciones/${id}/enviar`, { method: 'PATCH' });
      return;
    case 'aceptar-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/aceptar`, { method: 'PATCH' });
    case 'rechazar-cotizacion':
      if (confirm('¿Rechazar esta cotización?')) return accion(`/ventas/cotizaciones/${id}/rechazar`, { method: 'PATCH' });
      return;
    case 'convertir-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/convertir`, { method: 'POST' });

    case 'ver-items-orden':
      return verItemsOrden(id);
    case 'ver-pdf-orden':
      window.open(`/contable/orden-imprimir.html?id=${id}`, '_blank');
      return;
    case 'editar-orden':
      return abrirEdicionOrden(id);
    case 'aprobar-orden':
      return accion(`/compras/ordenes/${id}/aprobar`, { method: 'PATCH' });
    case 'convertir-orden':
      return accion(`/compras/ordenes/${id}/convertir`, { method: 'POST' });

    case 'agregar-empleado':
      return agregarEmpleadoAPeriodo(id);
    case 'liquidar-periodo':
      if (confirm('¿Liquidar este periodo? Se emitirá el documento soporte de cada empleado agregado.'))
        return accion(`/nomina/periodos/${id}/liquidar`, { method: 'POST' });
      return;

    case 'entrada-inventario':
      return movimientoInventario('entradas', id, true);
    case 'salida-inventario':
      return movimientoInventario('salidas', id, false);
    case 'ajuste-inventario':
      return movimientoInventario('ajustes', id, false, true);

    case 'baja-activo':
      if (confirm('¿Dar de baja este activo? Esta acción queda pendiente de revisión del contador.'))
        return accion(`/activos-fijos/${id}/baja`, { method: 'POST' });
      return;

    case 'conciliar-movimiento':
      return accion(`/tesoreria/movimientos/${id}/conciliar`, { method: 'POST' });
  }
});

// Prompts sencillos para acciones que necesitan un dato adicional puntual.
// Es deliberadamente básico — reemplazar por un formulario modal real
// queda como mejora pendiente, ver README.

async function agregarEmpleadoAPeriodo(periodoId) {
  const empleados = listaTerceros.filter((t) => t.tipo === 'empleado');
  if (empleados.length === 0) {
    alert('Primero crea un tercero de tipo "empleado" en la pestaña Terceros.');
    return;
  }
  const opciones = empleados.map((e, i) => `${i + 1}. ${e.nombre}`).join('\n');
  const seleccion = prompt(`¿Qué empleado? Escribe el número:\n${opciones}`);
  const empleado = empleados[Number(seleccion) - 1];
  if (!empleado) return;

  const devengado = prompt(`Devengado de ${empleado.nombre} ($):`);
  if (!devengado) return;
  const deducciones = prompt('Deducciones ($) — Enter para 0:') || '0';

  await accion(`/nomina/periodos/${periodoId}/empleados`, {
    method: 'POST',
    body: JSON.stringify({ empleadoId: empleado.id, devengado: Number(devengado), deducciones: Number(deducciones) }),
  });
}

async function movimientoInventario(tipo, productoId, pideCosto, pideObservacion) {
  const cantidad = prompt('Cantidad:');
  if (!cantidad) return;

  const body = { productoId, cantidad: Number(cantidad) };

  if (pideCosto) {
    const costo = prompt('Costo unitario ($):');
    if (!costo) return;
    body.costoUnitario = Number(costo);
  }

  if (pideObservacion) {
    body.observacion = prompt('Motivo del ajuste:') || '';
  }

  await accion(`/inventarios/${tipo}`, { method: 'POST', body: JSON.stringify(body) });
}

// --- INICIO ---
if (token && usuario) {
  mostrarDashboard();
}
SCRIPTEOF
echo "OK  public/contable/app.js"

cat > public/contable/index.html << 'SCRIPTEOF'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mipyme Contable</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/contable/style.css?v=20261012-4">
</head>
<body>

<div id="vista-login" class="pantalla-login">
  <div class="tarjeta-login" id="tarjeta-login-principal">
    <h1 class="wordmark">Mipyme Contable</h1>
    <p class="subtitulo">Sistema contable para microempresas — NIIF Grupo 3</p>
    <form id="form-login">
      <label>Correo
        <input type="email" id="login-email" required autocomplete="username">
      </label>
      <label>Contraseña
        <input type="password" id="login-password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn-primario">Entrar</button>
      <p id="login-error" class="mensaje-error" hidden></p>
    </form>
    <button type="button" id="btn-mostrar-onboarding" class="enlace-onboarding">¿Primera vez? Crear empresa y usuario →</button>
  </div>

  <div class="tarjeta-login tarjeta-onboarding" id="tarjeta-onboarding" hidden>
    <h1 class="wordmark">Nueva empresa</h1>
    <p class="subtitulo">Dos pasos: primero la empresa, luego su primer usuario.</p>

    <form id="form-empresa-nueva">
      <label>Razón social
        <input type="text" id="empresa-razon-social" required>
      </label>
      <label>NIT
        <input type="text" id="empresa-nit" required>
      </label>
      <label>Régimen tributario
        <select id="empresa-regimen">
          <option value="ordinario">Ordinario</option>
          <option value="rst">Régimen Simple (RST)</option>
          <option value="especial">Régimen Tributario Especial (ESAL, cooperativas)</option>
        </select>
      </label>
      <label class="check-inline">
        <input type="checkbox" id="empresa-responsable-iva"> Responsable de IVA
      </label>
      <label>Correo electrónico
        <input type="email" id="empresa-email">
      </label>
      <label>Teléfono de contacto
        <input type="text" id="empresa-telefono">
      </label>
      <label>Dirección
        <input type="text" id="empresa-direccion">
      </label>
      <label>Departamento
        <input type="text" id="empresa-departamento">
      </label>
      <label>Municipio
        <input type="text" id="empresa-municipio">
      </label>
      <label>Representante legal
        <input type="text" id="empresa-representante-nombre">
      </label>
      <label>Documento del representante legal
        <input type="text" id="empresa-representante-documento">
      </label>
      <label>Código CIIU (actividad económica)
        <input type="text" id="empresa-ciiu">
      </label>
      <label>Matrícula mercantil
        <input type="text" id="empresa-matricula">
      </label>
      <label>Logo (opcional — aparecerá en cotizaciones y órdenes)
        <input type="file" id="empresa-logo" accept="image/png, image/jpeg, image/svg+xml">
        <img id="empresa-logo-vista-previa" class="logo-vista-previa" hidden>
      </label>
      <button type="submit" class="btn-primario">Crear empresa</button>
    </form>

    <form id="form-usuario-nuevo" hidden>
      <p id="empresa-creada-mensaje" class="mensaje-exito"></p>
      <label>Nombre del usuario
        <input type="text" id="usuario-nuevo-nombre" required>
      </label>
      <label>Correo
        <input type="email" id="usuario-nuevo-email" required>
      </label>
      <label>Contraseña
        <input type="password" id="usuario-nuevo-password" required>
      </label>
      <label>Rol
        <select id="usuario-nuevo-rol">
          <option value="contador">Contador</option>
          <option value="dueño">Dueño</option>
          <option value="auxiliar">Auxiliar</option>
          <option value="revisor">Revisor</option>
        </select>
      </label>
      <button type="submit" class="btn-primario">Crear usuario</button>
    </form>

    <p id="onboarding-resultado" class="mensaje-exito" hidden></p>
    <button type="button" id="btn-volver-login" class="enlace-onboarding">← Volver a iniciar sesión</button>
  </div>
</div>

<div id="vista-dashboard" class="app" hidden>
  <aside class="barra-lateral">
    <h1 class="wordmark">Mipyme Contable</h1>
    <nav>
      <button class="nav-item activo" data-tab="inicio">Inicio</button>
      <button class="nav-item" data-tab="terceros">Terceros</button>
      <button class="nav-item" data-tab="proyectos">Proyectos</button>
      <button class="nav-item" data-tab="cotizaciones">Cotizaciones</button>
      <button class="nav-item" data-tab="facturas-venta">Facturas de venta</button>
      <button class="nav-item" data-tab="ordenes">Órdenes de adquisición</button>
      <button class="nav-item" data-tab="facturas-compra">Facturas de compra</button>
      <button class="nav-item" data-tab="nomina">Nómina</button>
      <button class="nav-item" data-tab="inventarios">Inventarios</button>
      <button class="nav-item" data-tab="activos-fijos">Activos fijos</button>
      <button class="nav-item" data-tab="tesoreria">Tesorería</button>
      <button class="nav-item" data-tab="mi-empresa">Mi Empresa</button>
    </nav>
    <div class="usuario-actual">
      <p id="usuario-nombre"></p>
      <p id="usuario-rol" class="rol"></p>
      <button id="btn-salir">Cerrar sesión</button>
      <a href="/" class="enlace-sitio">← libanielconsulting.com</a>
    </div>
  </aside>

  <main class="contenido">
    <section id="panel-inicio" class="panel">
      <header class="panel-header"><h2>Inicio</h2></header>
      <p class="bienvenida">Bienvenido, <span id="inicio-usuario-nombre"></span> — trabajando en <strong id="inicio-empresa-nombre">—</strong>.</p>
      <div class="grid-modulos">
        <button class="tarjeta-modulo" data-ir-a="terceros">
          <span class="numero-modulo">01</span>
          <h3>Terceros</h3>
          <p>Clientes, proveedores y empleados</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="cotizaciones">
          <span class="numero-modulo">02</span>
          <h3>Cotizaciones</h3>
          <p>Cotiza y da seguimiento a tus ventas</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="facturas-venta">
          <span class="numero-modulo">03</span>
          <h3>Facturas de venta</h3>
          <p>Facturación electrónica</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="ordenes">
          <span class="numero-modulo">04</span>
          <h3>Órdenes de Adquisición</h3>
          <p>Compras de bienes y servicios</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="facturas-compra">
          <span class="numero-modulo">05</span>
          <h3>Facturas de compra</h3>
          <p>Facturas recibidas y documento soporte</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="nomina">
          <span class="numero-modulo">06</span>
          <h3>Nómina</h3>
          <p>Liquidación de empleados</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="inventarios">
          <span class="numero-modulo">07</span>
          <h3>Inventarios</h3>
          <p>Control de existencias</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="activos-fijos">
          <span class="numero-modulo">08</span>
          <h3>Activos fijos</h3>
          <p>Depreciación y activos</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="tesoreria">
          <span class="numero-modulo">09</span>
          <h3>Tesorería</h3>
          <p>Cuentas y movimientos bancarios</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="proyectos">
          <span class="numero-modulo">10</span>
          <h3>Proyectos</h3>
          <p>Contratos y negocios — futuro centro de costo</p>
        </button>
      </div>
    </section>

    <section id="panel-terceros" class="panel" hidden>
      <header class="panel-header">
        <h2>Terceros</h2>
        <button class="btn-primario" id="btn-nuevo-tercero">+ Nuevo tercero</button>
      </header>
      <form id="form-tercero" class="form-inline" hidden>
        <select id="tercero-tipo" required>
          <option value="cliente">Cliente</option>
          <option value="proveedor">Proveedor</option>
          <option value="empleado">Empleado</option>
          <option value="otro">Otro</option>
        </select>
        <select id="tercero-tipo-persona">
          <option value="">Tipo de persona...</option>
          <option value="natural">Natural</option>
          <option value="juridica">Jurídica</option>
        </select>
        <input type="text" id="tercero-identificacion" placeholder="Identificación" required>
        <input type="text" id="tercero-nombre" placeholder="Nombre" required>
        <input type="email" id="tercero-email" placeholder="Correo (opcional)">
        <input type="text" id="tercero-celular" placeholder="Celular (opcional)">
        <input type="text" id="tercero-direccion" placeholder="Dirección (opcional)">
        <input type="text" id="tercero-departamento" placeholder="Departamento (opcional)">
        <input type="text" id="tercero-municipio" placeholder="Municipio (opcional)">
        <select id="tercero-regimen-iva">
          <option value="">Régimen de IVA...</option>
          <option value="responsable">Responsable de IVA</option>
          <option value="no_responsable">No responsable de IVA</option>
        </select>
        <select id="tercero-cuenta-tipo">
          <option value="">Tipo de cuenta...</option>
          <option value="ahorros">Ahorros</option>
          <option value="corriente">Corriente</option>
        </select>
        <input type="text" id="tercero-cuenta-banco" placeholder="Banco (opcional)">
        <input type="text" id="tercero-cuenta-numero" placeholder="No. cuenta (opcional)">
        <fieldset class="fieldset-responsabilidades">
          <legend>Responsabilidad fiscal (marca las que apliquen)</legend>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-13"> O-13 Gran contribuyente</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-15"> O-15 Autorretenedor</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-23"> O-23 Agente de retención IVA</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-47"> O-47 Régimen simple de tributación</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="R-99-PN"> R-99-PN No aplica - Otros</label>
        </fieldset>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-tercero">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-terceros"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-proyectos" class="panel" hidden>
      <header class="panel-header">
        <h2>Proyectos</h2>
        <button class="btn-primario" id="btn-nuevo-proyecto">+ Nuevo proyecto</button>
      </header>
      <p class="nota-panel">Contratos, negocios o proyectos de la empresa — se usan como "Proyecto / Unidad de Negocio" en Órdenes de Adquisición, y están pensados para servir como centro de costo contable más adelante.</p>
      <form id="form-proyecto" class="form-inline" hidden>
        <input type="text" id="proyecto-nombre" placeholder="Nombre del proyecto/contrato" required>
        <input type="text" id="proyecto-codigo" placeholder="ID del proyecto (centro de costo)">
        <select id="proyecto-contratante"></select>
        <input type="number" id="proyecto-valor-total" placeholder="Valor total" min="0">
        <input type="text" id="proyecto-objeto" placeholder="Objeto del proyecto (opcional)">
        <label class="check-aiu">
          <input type="checkbox" id="proyecto-activo" checked> Activo (aparece en el selector de las órdenes)
        </label>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-proyecto">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-proyectos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-cotizaciones" class="panel" hidden>
      <header class="panel-header">
        <h2>Cotizaciones</h2>
        <button class="btn-primario" id="btn-nueva-cotizacion">+ Nueva cotización</button>
      </header>
      <form id="form-cotizacion" class="form-grande" hidden>
        <div class="fila-campos">
          <select id="cotizacion-tercero" required></select>
          <label class="campo-etiquetado">
            <span>Vigente hasta</span>
            <input type="date" id="cotizacion-vencimiento" required>
          </label>
          <input type="text" id="cotizacion-forma-pago" placeholder="Forma de pago (opcional)">
          <input type="text" id="cotizacion-observaciones" placeholder="Observaciones (opcional)">
          <input type="text" id="cotizacion-contacto-nombre" placeholder="Persona de contacto (opcional)">
          <input type="text" id="cotizacion-contacto-telefono" placeholder="Teléfono de contacto (opcional)">
        </div>

        <div class="bloque-items">
          <div class="bloque-items-header">
            <h4>Ítems cotizados</h4>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-item-cotizacion">+ Agregar ítem</button>
          </div>
          <table class="tabla-items">
            <thead>
              <tr><th>Concepto</th><th>Cantidad</th><th>UM</th><th class="num">Valor unitario</th><th>Impuesto</th><th class="num">Total</th><th></th></tr>
            </thead>
            <tbody id="items-cotizacion-tbody"></tbody>
          </table>
        </div>

        <label class="check-aiu">
          <input type="checkbox" id="cotizacion-aplica-aiu"> ¿Aplica AIU? (Administración, Imprevistos, Utilidad — contratos de obra/servicios)
        </label>
        <div class="fila-campos" id="campos-aiu" hidden>
          <label class="campo-aiu">
            <span>Administración %</span>
            <input type="number" id="cotizacion-aiu-administracion" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-administracion">$0</span>
          </label>
          <label class="campo-aiu">
            <span>Imprevistos %</span>
            <input type="number" id="cotizacion-aiu-imprevistos" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-imprevistos">$0</span>
          </label>
          <label class="campo-aiu">
            <span>Utilidad %</span>
            <input type="number" id="cotizacion-aiu-utilidad" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-utilidad">$0</span>
          </label>
        </div>

        <div class="resumen-totales">
          <span>Subtotal: <strong id="resumen-subtotal">$0</strong></span>
          <span>IVA: <strong id="resumen-iva">$0</strong></span>
          <span>Total: <strong id="resumen-total">$0</strong></span>
        </div>

        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar</button>
          <button type="button" class="btn-secundario" id="btn-cancelar-cotizacion">Cancelar</button>
        </div>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-cotizaciones"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-venta" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de venta</h2></header>
      <p class="nota-panel">Se generan al convertir una cotización aceptada — no se crean directo aquí.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-venta"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-ordenes" class="panel" hidden>
      <header class="panel-header">
        <h2>Órdenes de adquisición</h2>
        <button class="btn-primario" id="btn-nueva-orden">+ Nueva orden</button>
      </header>
      <form id="form-orden" class="form-grande" hidden>
        <div class="fila-campos">
          <select id="orden-tercero" required></select>
          <select id="orden-tipo">
            <option value="bienes">Bienes</option>
            <option value="servicios">Servicios</option>
          </select>
          <select id="orden-proyecto-id">
            <option value="">Proyecto / Unidad de negocio (ID)...</option>
          </select>
          <input type="text" id="orden-lugar-entrega" placeholder="Lugar de entrega (opcional)">
          <input type="text" id="orden-forma-pago" placeholder="Forma de pago (opcional)">
        </div>

        <div class="bloque-items">
          <div class="bloque-items-header">
            <h4>Ítems de la orden</h4>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-item-orden">+ Agregar ítem</button>
          </div>
          <table class="tabla-items">
            <thead>
              <tr><th>Concepto</th><th>Cantidad</th><th>UM</th><th class="num">Valor unitario</th><th>Impuesto</th><th class="num">Total</th><th></th></tr>
            </thead>
            <tbody id="items-orden-tbody"></tbody>
          </table>
        </div>

        <div id="bloque-aiu-orden" hidden>
          <label class="check-aiu">
            <input type="checkbox" id="orden-aplica-aiu"> Discriminar AIU (Administración, Imprevistos, Utilidad) — solo compra de servicios
          </label>
          <div class="fila-campos" id="campos-aiu-orden" hidden>
            <label class="campo-aiu">
              <span>Administración %</span>
              <input type="number" id="orden-aiu-administracion" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-administracion">$0</span>
            </label>
            <label class="campo-aiu">
              <span>Imprevistos %</span>
              <input type="number" id="orden-aiu-imprevistos" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-imprevistos">$0</span>
            </label>
            <label class="campo-aiu">
              <span>Utilidad %</span>
              <input type="number" id="orden-aiu-utilidad" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-utilidad">$0</span>
            </label>
            <label class="campo-aiu">
              <span>IVA se calcula sobre</span>
              <select id="orden-aiu-base-iva">
                <option value="total">Subtotal + AIU</option>
                <option value="utilidad">Solo la Utilidad</option>
              </select>
            </label>
          </div>
        </div>

        <fieldset class="bloque-retencion" id="bloque-retencion-orden">
          <legend>Retención en la fuente (informativa para el proveedor)</legend>
          <div class="opciones-retencion">
            <label><input type="radio" name="orden-retencion-modo" value="ninguna" checked> No indicar retención</label>
            <label><input type="radio" name="orden-retencion-modo" value="aplica"> Aplicar retención</label>
            <label><input type="radio" name="orden-retencion-modo" value="no_aplica"> No aplica retención</label>
          </div>

          <div id="retencion-aplica-orden" hidden>
            <table class="tabla-items">
              <thead>
                <tr><th>Concepto (tipo de bien o servicio)</th><th>Tarifa</th><th class="num">Base</th><th class="num">Tope mínimo</th><th class="num">Retención</th><th></th></tr>
              </thead>
              <tbody id="retenciones-orden-tbody"></tbody>
            </table>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-retencion-orden">+ Agregar concepto de retención</button>
            <p class="nota-aiu" id="nota-retencion-orden"></p>
          </div>

          <div id="retencion-no-aplica-orden" class="fila-campos" hidden>
            <label class="campo-aiu">
              <span>Motivo</span>
              <select id="orden-retencion-motivo"></select>
            </label>
            <label class="campo-aiu campo-ancho">
              <span>Detalle (opcional)</span>
              <input type="text" id="orden-retencion-detalle" maxlength="255" placeholder="Ej.: certificado RST vigente, resolución, etc.">
            </label>
          </div>
        </fieldset>

        <div class="resumen-totales">
          <span>Subtotal: <strong id="resumen-subtotal-orden">$0</strong></span>
          <span id="resumen-aiu-orden-fila" hidden>AIU: <strong id="resumen-aiu-orden">$0</strong></span>
          <span>IVA: <strong id="resumen-iva-orden">$0</strong></span>
          <span>Impoconsumo: <strong id="resumen-impoconsumo-orden">$0</strong></span>
          <span>Total: <strong id="resumen-total-orden">$0</strong></span>
          <span id="resumen-retencion-orden-fila" hidden>Retención en la fuente: <strong id="resumen-retencion-orden">$0</strong></span>
          <span id="resumen-neto-orden-fila" hidden>Valor a consignar al proveedor: <strong id="resumen-neto-orden">$0</strong></span>
        </div>

        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar</button>
          <button type="button" class="btn-secundario" id="btn-cancelar-orden">Cancelar</button>
        </div>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-ordenes"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-compra" class="panel" hidden>
      <header class="panel-header">
        <h2>Facturas de compra</h2>
        <button class="btn-primario" id="btn-cargar-factura-xml">+ Cargar factura (XML)</button>
      </header>
      <p class="nota-panel">Carga el XML que te envía el proveedor (o el .zip completo): se lee, se revisa y recién ahí se contabiliza. También se generan al convertir una orden aprobada o llegan por webhook del proveedor tecnológico.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-compra"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-nomina" class="panel" hidden>
      <header class="panel-header">
        <h2>Nómina</h2>
        <button class="btn-primario" id="btn-nuevo-periodo">+ Nuevo periodo</button>
      </header>
      <form id="form-periodo" class="form-inline" hidden>
        <input type="date" id="periodo-inicio" required title="Fecha de inicio">
        <input type="date" id="periodo-fin" required title="Fecha de fin">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-periodo">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-nomina"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-inventarios" class="panel" hidden>
      <header class="panel-header">
        <h2>Inventarios</h2>
        <button class="btn-primario" id="btn-nuevo-producto">+ Nuevo producto</button>
      </header>
      <form id="form-producto" class="form-inline" hidden>
        <input type="text" id="producto-nombre" placeholder="Nombre" required>
        <select id="producto-tipo">
          <option value="bien">Bien</option>
          <option value="servicio">Servicio</option>
        </select>
        <input type="text" id="producto-unidad" placeholder="Unidad" value="unidad">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-producto">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-productos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-activos-fijos" class="panel" hidden>
      <header class="panel-header">
        <h2>Activos fijos</h2>
        <div class="acciones-header">
          <button class="btn-secundario" id="btn-depreciar">Correr depreciación del mes</button>
          <button class="btn-primario" id="btn-nuevo-activo">+ Nuevo activo</button>
        </div>
      </header>
      <form id="form-activo" class="form-inline" hidden>
        <input type="text" id="activo-nombre" placeholder="Nombre" required>
        <input type="number" id="activo-costo" placeholder="Costo" required min="0">
        <input type="number" id="activo-vida-util" placeholder="Vida útil (meses)" required min="1">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-activo">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-activos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-tesoreria" class="panel" hidden>
      <header class="panel-header"><h2>Tesorería</h2></header>

      <div class="subseccion-header">
        <h3 class="subseccion">Cuentas bancarias</h3>
        <button class="btn-primario btn-chico" id="btn-nueva-cuenta">+ Nueva cuenta</button>
      </div>
      <form id="form-cuenta" class="form-inline" hidden>
        <input type="text" id="cuenta-banco" placeholder="Banco" required>
        <input type="text" id="cuenta-numero" placeholder="Número" required>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-cuenta">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-cuentas"><thead></thead><tbody></tbody></table>
      </div>

      <div class="subseccion-header">
        <h3 class="subseccion">Movimientos</h3>
        <button class="btn-primario btn-chico" id="btn-nuevo-movimiento">+ Nuevo movimiento</button>
      </div>
      <form id="form-movimiento" class="form-inline" hidden>
        <select id="movimiento-cuenta" required></select>
        <select id="movimiento-tipo">
          <option value="ingreso">Ingreso</option>
          <option value="egreso">Egreso</option>
          <option value="comision">Comisión</option>
        </select>
        <input type="number" id="movimiento-valor" placeholder="Valor" required min="0">
        <input type="text" id="movimiento-descripcion" placeholder="Descripción (opcional)">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-movimiento">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-movimientos-bancarios"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-mi-empresa" class="panel" hidden>
      <header class="panel-header"><h2>Mi Empresa</h2></header>
      <p class="nota-panel">Estos datos aparecen en el encabezado de las cotizaciones y órdenes de adquisición en PDF.</p>
      <form id="form-mi-empresa" class="form-grande">
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Razón social</span>
            <input type="text" id="miempresa-razon-social" required>
          </label>
          <label class="campo-etiquetado">
            <span>NIT</span>
            <input type="text" id="miempresa-nit" required>
          </label>
          <label class="campo-etiquetado">
            <span>Régimen tributario</span>
            <select id="miempresa-regimen">
              <option value="ordinario">Ordinario</option>
              <option value="rst">Régimen Simple (RST)</option>
              <option value="especial">Régimen Tributario Especial</option>
            </select>
          </label>
          <label class="check-aiu">
            <input type="checkbox" id="miempresa-responsable-iva"> Responsable de IVA
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Correo electrónico</span>
            <input type="email" id="miempresa-email">
          </label>
          <label class="campo-etiquetado">
            <span>Teléfono de contacto</span>
            <input type="text" id="miempresa-telefono">
          </label>
          <label class="campo-etiquetado">
            <span>Dirección</span>
            <input type="text" id="miempresa-direccion">
          </label>
          <label class="campo-etiquetado">
            <span>Departamento</span>
            <input type="text" id="miempresa-departamento">
          </label>
          <label class="campo-etiquetado">
            <span>Municipio</span>
            <input type="text" id="miempresa-municipio">
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Representante legal</span>
            <input type="text" id="miempresa-representante-nombre">
          </label>
          <label class="campo-etiquetado">
            <span>Documento del representante legal</span>
            <input type="text" id="miempresa-representante-documento">
          </label>
          <label class="campo-etiquetado">
            <span>Código CIIU</span>
            <input type="text" id="miempresa-ciiu">
          </label>
          <label class="campo-etiquetado">
            <span>Matrícula mercantil</span>
            <input type="text" id="miempresa-matricula">
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Logo</span>
            <input type="file" id="miempresa-logo" accept="image/png, image/jpeg, image/svg+xml">
          </label>
          <img id="miempresa-logo-vista-previa" class="logo-vista-previa" hidden>
        </div>
        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar cambios</button>
        </div>
        <p id="miempresa-resultado" class="mensaje-exito" hidden></p>
      </form>
    </section>
  </main>

  <!-- Carga de la factura de compra desde el XML del proveedor -->
  <dialog id="dialogo-factura-xml" class="dialogo-factura" aria-labelledby="titulo-factura-xml">
    <div class="dialogo-cabecera">
      <h3 id="titulo-factura-xml">Cargar factura de compra (XML)</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-factura-xml" aria-label="Cerrar">×</button>
    </div>

    <div class="dialogo-cuerpo">
      <div id="fx-paso-archivo">
        <label class="zona-archivo" id="fx-zona-archivo">
          <input type="file" id="fx-archivo" accept=".xml,.zip,application/xml,text/xml,application/zip">
          <strong>Elige el XML de la factura</strong>
          <span>o arrástralo hasta aquí. También sirve el .zip que envía el proveedor.</span>
        </label>
        <p class="nota-aiu" id="fx-estado-lectura"></p>
      </div>

      <div id="fx-revision" hidden>
        <div id="fx-advertencias"></div>

        <div id="fx-resumen" class="fx-resumen"></div>

        <div class="fx-rejilla">
          <div class="fx-bloque">
            <h4>Proveedor</h4>
            <p id="fx-proveedor" class="fx-texto"></p>
            <label id="fx-crear-proveedor-fila" class="fx-check" hidden>
              <input type="checkbox" id="fx-crear-proveedor" checked>
              <span>Crear este proveedor en Terceros con los datos del XML</span>
            </label>
          </div>
          <div class="fx-bloque">
            <h4>Orden de adquisición</h4>
            <select id="fx-orden"></select>
            <p class="nota-aiu" id="fx-orden-nota"></p>
          </div>
          <div class="fx-bloque">
            <h4>Proyecto / centro de costo</h4>
            <select id="fx-proyecto"></select>
          </div>
        </div>

        <div class="fx-bloque fx-ancho">
          <div class="fx-titulo-con-accion">
            <h4>Detalle y destino contable</h4>
            <label class="fx-todas">
              <span>Llevar todo a:</span>
              <select id="fx-cuenta-todas"></select>
            </label>
          </div>
          <div class="tabla-envoltorio">
            <table class="tabla-items-detalle" id="fx-tabla-lineas">
              <thead>
                <tr><th>#</th><th>Descripción</th><th class="num">Cant.</th><th class="num">Valor</th><th class="num">IVA</th><th>Cuenta destino</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>

        <fieldset class="bloque-retencion" id="fx-bloque-retencion">
          <legend>Retención en la fuente que practicas</legend>
          <p class="nota-aiu" id="fx-retencion-sugerencia" hidden></p>
          <div class="opciones-retencion">
            <label><input type="radio" name="fx-retencion-modo" value="aplica"> Aplicar retención</label>
            <label><input type="radio" name="fx-retencion-modo" value="no_aplica"> No aplica retención</label>
          </div>

          <div id="fx-retencion-aplica" hidden>
            <table class="tabla-items">
              <thead>
                <tr><th>Concepto (tipo de bien o servicio)</th><th>Tarifa</th><th class="num">Base</th><th class="num">Tope mínimo</th><th class="num">Retención</th><th></th></tr>
              </thead>
              <tbody id="fx-retenciones-tbody"></tbody>
            </table>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-retencion-fx">+ Agregar concepto de retención</button>
            <label class="campo-aiu fx-aiu" id="fx-aiu-fila" hidden>
              <span>Valor del AIU de la factura (para conceptos calculados sobre el AIU)</span>
              <input type="number" id="fx-aiu" min="0" step="0.01" placeholder="0">
            </label>
            <p class="nota-aiu" id="fx-nota-retencion"></p>
          </div>

          <div id="fx-retencion-no-aplica" class="fila-campos" hidden>
            <label class="campo-aiu">
              <span>Motivo</span>
              <select id="fx-retencion-motivo"></select>
            </label>
            <label class="campo-aiu campo-ancho">
              <span>Detalle (opcional)</span>
              <input type="text" id="fx-retencion-detalle" maxlength="255" placeholder="Ej.: certificado RST vigente, resolución, etc.">
            </label>
          </div>
        </fieldset>

        <div class="fx-bloque fx-ancho">
          <h4>Asiento que se va a contabilizar</h4>
          <div class="tabla-envoltorio">
            <table class="tabla-items-detalle" id="fx-tabla-asiento">
              <thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead>
              <tbody></tbody>
              <tfoot></tfoot>
            </table>
          </div>
          <div class="resumen-totales" id="fx-totales"></div>
        </div>

        <label id="fx-aceptar-fila" class="fx-check fx-aceptar" hidden>
          <input type="checkbox" id="fx-aceptar">
          <span>Revisé las advertencias de arriba y quiero registrar la factura de todos modos</span>
        </label>
      </div>
    </div>

    <div class="dialogo-pie">
      <p class="fx-error" id="fx-error" hidden></p>
      <span class="fx-ayuda" id="fx-ayuda"></span>
      <button type="button" class="btn-secundario" id="btn-cancelar-factura-xml">Cancelar</button>
      <button type="button" class="btn-primario" id="btn-registrar-factura-xml" disabled>Registrar y contabilizar</button>
    </div>
  </dialog>

  <!-- Detalle de una factura de compra ya registrada -->
  <dialog id="dialogo-factura-detalle" class="dialogo-factura" aria-labelledby="titulo-factura-detalle">
    <div class="dialogo-cabecera">
      <h3 id="titulo-factura-detalle">Factura de compra</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-factura-detalle" aria-label="Cerrar">×</button>
    </div>
    <div class="dialogo-cuerpo" id="fd-cuerpo"></div>
    <div class="dialogo-pie">
      <button type="button" class="btn-secundario" id="btn-xml-factura-detalle" hidden>Descargar XML</button>
      <button type="button" class="btn-primario" id="btn-listo-factura-detalle">Cerrar</button>
    </div>
  </dialog>
</div>

<!-- ?v=... evita que el navegador o el CDN sirvan una copia vieja de estos archivos: subir el valor cada vez que cambie alguno (ver README, "Caché de archivos estáticos") -->
<script src="/contable/retencionesCatalogo.js?v=20261012-4"></script>
<script src="/contable/calculoOrden.js?v=20261012-4"></script>
<script src="/contable/asientoCompra.js?v=20261012-4"></script>
<script src="/contable/app.js?v=20261012-4"></script>
</body>
</html>
SCRIPTEOF
echo "OK  public/contable/index.html"

cat > public/contable/style.css << 'SCRIPTEOF'
:root {
  --paper: #F6F8F4;
  --surface: #FFFFFF;
  --ink: #1C2A24;
  --ink-soft: #56655C;
  --rule: #CBD6CE;
  --rule-strong: #9FAFA4;
  --accent: #2F6B4F;
  --accent-hover: #275940;
  --accent-ink: #FFFFFF;
  --danger: #A6432E;
  --warn: #B8863A;
  --font-serif: 'IBM Plex Serif', Georgia, serif;
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
}

* { box-sizing: border-box; }

/* El atributo hidden debe ganar siempre, incluso sobre elementos con
   display: grid/flex por clase (.app, .pantalla-login, etc.) — sin
   esto, el navegador puede dejar visible un elemento "oculto". */
[hidden] { display: none !important; }

body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--paper);
}

.wordmark {
  font-family: var(--font-serif);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

button { font-family: var(--font-sans); cursor: pointer; }

.btn-primario {
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
}
.btn-primario:hover { background: var(--accent-hover); }

.btn-secundario {
  background: transparent;
  color: var(--ink-soft);
  border: 1px solid var(--rule-strong);
  padding: 10px 18px;
  font-size: 14px;
}

/* LOGIN */
.pantalla-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.tarjeta-login {
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border-top: 3px solid var(--accent);
  padding: 40px 32px;
}

.tarjeta-login .wordmark { font-size: 22px; margin-bottom: 4px; }

.subtitulo {
  color: var(--ink-soft);
  font-size: 13px;
  margin: 0 0 28px;
  line-height: 1.5;
}

#form-login label {
  display: block;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 16px;
}

#form-login input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}

#form-login input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

#form-login .btn-primario {
  width: 100%;
  padding: 12px;
  margin-top: 8px;
}

.mensaje-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 12px;
}

.mensaje-exito {
  color: var(--accent);
  font-size: 13px;
  margin: 0 0 14px;
}

.enlace-onboarding {
  display: block;
  width: 100%;
  text-align: center;
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  margin-top: 20px;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}
.enlace-onboarding:hover { color: var(--accent); }

.tarjeta-onboarding { max-width: 420px; }
.tarjeta-onboarding label { display: block; font-size: 13px; color: var(--ink-soft); margin-bottom: 14px; }
.tarjeta-onboarding input, .tarjeta-onboarding select {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}
.tarjeta-onboarding .btn-primario { width: 100%; padding: 12px; margin-top: 4px; }

.logo-vista-previa {
  display: block;
  max-width: 140px;
  max-height: 80px;
  margin-top: 8px;
  border: 1px solid var(--rule-strong);
  padding: 6px;
}

.tarjeta-onboarding .check-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.tarjeta-onboarding .check-inline input[type="checkbox"] {
  width: auto;
  margin: 0;
}

/* PANEL DE INICIO */
.bienvenida {
  color: var(--ink-soft);
  font-size: 14px;
  margin: -10px 0 28px;
}

.grid-modulos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.tarjeta-modulo {
  text-align: left;
  background: var(--surface);
  border: none;
  border-top: 3px solid var(--accent);
  padding: 20px 18px;
  cursor: pointer;
  font-family: var(--font-sans);
}
.tarjeta-modulo:hover { background: var(--paper); }

.numero-modulo {
  display: block;
  font-family: var(--font-serif);
  font-size: 13px;
  color: var(--rule-strong);
  font-weight: 600;
  margin-bottom: 8px;
}

.tarjeta-modulo h3 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 16px;
  margin: 0 0 6px;
  color: var(--ink);
}

.tarjeta-modulo p {
  font-size: 13px;
  color: var(--ink-soft);
  margin: 0;
  line-height: 1.4;
}

@media (max-width: 720px) {
  .grid-modulos { grid-template-columns: 1fr; }
}

/* APP SHELL */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.barra-lateral {
  background: var(--surface);
  border-right: 1px solid var(--rule);
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
}

.barra-lateral .wordmark { font-size: 17px; margin-bottom: 28px; }

.barra-lateral nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding: 9px 10px;
  font-size: 14px;
  color: var(--ink-soft);
}

.nav-item:hover { color: var(--ink); background: var(--paper); }

.nav-item.activo {
  color: var(--ink);
  border-left-color: var(--accent);
  background: var(--paper);
  font-weight: 500;
}

.usuario-actual {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-top: 16px;
}

.usuario-actual p { margin: 0; font-size: 13px; }
.usuario-actual .rol {
  color: var(--ink-soft);
  text-transform: capitalize;
  margin-bottom: 10px;
}

#btn-salir {
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  padding: 0;
  text-decoration: underline;
}

.enlace-sitio {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-top: 8px;
}

.contenido { padding: 32px 40px; max-width: 1000px; }

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}

.panel-header h2 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 24px;
  margin: 0;
}

.subseccion {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 15px;
  color: var(--ink-soft);
  margin: 0;
}

.subseccion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 24px 0 10px;
}
.subseccion-header:first-of-type { margin-top: 0; }

.acciones-header {
  display: flex;
  gap: 10px;
  align-items: center;
}

.nota-panel {
  color: var(--ink-soft);
  font-size: 13px;
  margin: -8px 0 16px;
}

.btn-chico {
  padding: 6px 12px;
  font-size: 13px;
}

.btn-accion {
  background: none;
  border: 1px solid var(--rule-strong);
  color: var(--ink);
  padding: 4px 10px;
  font-size: 12px;
  margin-right: 6px;
  white-space: nowrap;
}
.btn-accion:hover { background: var(--paper); }
.btn-accion.destructivo { border-color: var(--danger); color: var(--danger); }
.btn-accion.destructivo:hover { background: #fbeae6; }

td.acciones { white-space: nowrap; }

.form-inline {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 16px;
  margin-bottom: 20px;
}

.form-inline input, .form-inline select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

.fieldset-responsabilidades {
  border: 1px solid var(--rule-strong);
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  width: 100%;
}
.fieldset-responsabilidades legend {
  font-size: 12px;
  color: var(--ink-soft);
  padding: 0 4px;
}
.fieldset-responsabilidades label {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

/* Formularios más grandes (cotización, orden) con ítems dinámicos */
.form-grande {
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 20px;
  margin-bottom: 20px;
}

.fila-campos {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.fila-campos input, .fila-campos select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

.campo-etiquetado {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-soft);
}

.bloque-items {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-bottom: 16px;
}
.bloque-items-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.bloque-items-header h4 {
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--ink-soft);
}

.tabla-items { width: 100%; border-collapse: collapse; font-size: 13px; }
.tabla-items thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 11px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--rule-strong);
}
.tabla-items td { padding: 4px 6px; }
.tabla-items input, .tabla-items select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 13px;
  background: var(--paper);
}
.tabla-items .num { text-align: right; font-family: var(--font-mono); white-space: nowrap; }
.tabla-items .item-total-texto { font-family: var(--font-mono); }

.check-aiu {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 12px;
}

.campo-aiu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-soft);
}
.campo-aiu .valor-aiu {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink);
}

.resumen-totales {
  display: flex;
  gap: 24px;
  justify-content: flex-end;
  border-top: 1px solid var(--rule);
  padding-top: 12px;
  margin-bottom: 16px;
  font-size: 14px;
}
.resumen-totales strong { font-family: var(--font-mono); }

.fila-botones { display: flex; gap: 10px; }

.tabla-items-detalle { width: 100%; border-collapse: collapse; font-size: 13px; margin: 10px 0; }
.tabla-items-detalle th {
  text-align: left;
  font-size: 11px;
  color: var(--ink-soft);
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule-strong);
}
.tabla-items-detalle td { padding: 6px 10px; border-bottom: 1px solid var(--rule); }
.tabla-items-detalle .num { text-align: right; font-family: var(--font-mono); }
.detalle-items { background: var(--paper); padding: 14px 16px; }
.nota-aiu { font-size: 12px; color: var(--ink-soft); margin: 8px 0 0; }

/* TABLAS: estilo libro contable — solo reglas horizontales */
.tabla-envoltorio {
  background: var(--surface);
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--rule-strong);
  white-space: nowrap;
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}

tbody tr:last-child td { border-bottom: none; }

td.num, th.num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  text-transform: capitalize;
}
.badge.aceptada, .badge.aceptado, .badge.contabilizado, .badge.liquidada, .badge.aprobada, .badge.conciliado { border-color: var(--accent); color: var(--accent); }
.badge.rechazada, .badge.rechazado, .badge.objetada { border-color: var(--danger); color: var(--danger); }
.badge.pendiente, .badge.borrador, .badge.enviada, .badge.enviado { border-color: var(--warn); color: var(--warn); }

.vacio {
  padding: 32px 16px;
  color: var(--ink-soft);
  font-size: 14px;
  text-align: center;
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .barra-lateral {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
  .barra-lateral nav { flex-direction: row; flex-wrap: wrap; }
  .contenido { padding: 20px; }
}

/* Orden de adquisición: totales con varias líneas (AIU, Impoconsumo,
   retención, neto). Se permite pasar a otra línea en pantallas angostas. */
.resumen-totales { flex-wrap: wrap; row-gap: 6px; }
.resumen-totales .neto-pagar, #resumen-neto-orden-fila { font-weight: 600; }
.fila-campos .nota-aiu { flex-basis: 100%; margin: 0; }

/* Retención en la fuente de la orden */
.bloque-retencion {
  border: 1px solid var(--rule);
  padding: 12px 16px 14px;
  margin: 0 0 16px;
}
.bloque-retencion legend {
  font-family: var(--font-serif);
  font-size: 13px;
  padding: 0 6px;
  color: var(--ink-soft);
}
.opciones-retencion { display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px; margin-bottom: 10px; }
.opciones-retencion label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.bloque-retencion select, .bloque-retencion input[type="text"], .bloque-retencion input[type="number"] {
  padding: 7px 9px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 13px;
  background: var(--paper);
}
.bloque-retencion .item-ret-concepto { width: 100%; min-width: 260px; }
.bloque-retencion .item-ret-tarifa { width: 70px; }
.bloque-retencion .campo-ancho { flex: 1; min-width: 240px; }
.bloque-retencion .campo-ancho input { width: 100%; }
.bloque-retencion .ret-nota { display: block; font-size: 11px; color: #9A5B13; margin-top: 3px; }
.bloque-retencion .ret-sin-efecto { color: var(--ink-soft); }
.bloque-retencion td:nth-child(2) { white-space: nowrap; }

/* ---------- Facturas de compra desde XML (ventanas) ---------- */
.dialogo-factura {
  width: min(1060px, 96vw);
  max-height: 94vh;
  padding: 0;
  border: 1px solid var(--rule-strong);
  background: var(--surface);
  color: var(--ink);
}
.dialogo-factura[open] { display: flex; flex-direction: column; }
.dialogo-factura::backdrop { background: rgba(28, 42, 36, 0.45); }

.dialogo-cabecera {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--rule);
}
.dialogo-cabecera h3 { font-family: var(--font-serif); font-size: 18px; margin: 0; }
.btn-cerrar-dialogo { border: none; background: none; font-size: 26px; line-height: 1; color: var(--ink-soft); padding: 0 4px; }
.btn-cerrar-dialogo:hover { color: var(--ink); }
.dialogo-cuerpo { padding: 18px 20px; overflow-y: auto; flex: 1; }
.dialogo-pie {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  padding: 12px 20px;
  border-top: 1px solid var(--rule);
}
.dialogo-pie .btn-primario:disabled { opacity: 0.45; cursor: not-allowed; }
.fx-ayuda { margin-right: auto; font-size: 12px; color: var(--ink-soft); }
.fx-error { flex-basis: 100%; margin: 0; font-size: 13px; color: var(--danger); }

.zona-archivo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  border: 2px dashed var(--rule-strong);
  background: var(--paper);
  cursor: pointer;
  text-align: center;
  font-size: 14px;
}
.zona-archivo span { color: var(--ink-soft); font-size: 13px; }
.zona-archivo.arrastrando { border-color: var(--accent); background: #EAF2EC; }
.zona-archivo.error { border-color: var(--danger); }
#fx-estado-lectura.error { color: var(--danger); }

/* Avisos de la factura */
.fx-aviso { padding: 8px 12px; margin: 0 0 8px; font-size: 13px; border-left: 4px solid var(--rule-strong); background: var(--paper); }
.fx-aviso.bloqueo { border-left-color: var(--danger); background: #FBEFEC; color: #7A2D1D; }
.fx-aviso.confirmar { border-left-color: var(--warn); background: #FBF4E6; color: #6E4E14; }
.fx-aviso.info { border-left-color: var(--accent); background: #EDF4EF; }

.fx-resumen {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px 20px;
  margin: 12px 0 16px;
  padding: 12px 14px;
  background: var(--paper);
  border: 1px solid var(--rule);
  font-size: 13px;
}
.fx-resumen dt { font-size: 11px; color: var(--ink-soft); margin: 0 0 2px; }
.fx-resumen dd { margin: 0; word-break: break-word; }
.fx-resumen .mono { font-family: var(--font-mono); font-size: 12px; }
.fx-resumen a { color: var(--accent); }

.fx-rejilla { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-bottom: 14px; }
.fx-bloque h4 { font-family: var(--font-serif); font-size: 14px; margin: 0 0 8px; }
.fx-bloque select, .dialogo-factura .bloque-retencion select { max-width: 100%; }
.fx-bloque select { width: 100%; padding: 7px 9px; border: 1px solid var(--rule-strong); font-family: var(--font-sans); font-size: 13px; background: var(--paper); }
.fx-ancho { margin-bottom: 16px; }
.fx-texto { margin: 0 0 8px; font-size: 13px; }
.fx-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
.fx-aceptar { padding: 10px 12px; border: 1px solid var(--warn); background: #FBF4E6; }
.fx-titulo-con-accion { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.fx-titulo-con-accion h4 { margin: 0; }
.fx-todas { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-soft); }
.fx-todas select { width: auto; min-width: 220px; }
#fx-tabla-lineas select { width: 100%; min-width: 200px; padding: 5px 7px; font-size: 12px; border: 1px solid var(--rule-strong); background: var(--paper); }
#fx-tabla-lineas td, #fx-tabla-asiento td, #fx-tabla-asiento th, #fx-tabla-lineas th { vertical-align: top; }
#fx-tabla-asiento tfoot td { font-weight: 600; border-top: 1px solid var(--rule-strong); }
#fx-tabla-asiento .cuenta-nombre { color: var(--ink-soft); }
#fx-tabla-asiento .indentar { padding-left: 28px; }
.fx-aiu { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; max-width: 360px; }
.fx-aiu input { padding: 7px 9px; border: 1px solid var(--rule-strong); background: var(--paper); font-size: 13px; }
#fx-totales strong.neto { color: var(--accent); }

.fd-aviso { padding: 10px 12px; margin-bottom: 12px; font-size: 13px; border-left: 4px solid var(--accent); background: #EDF4EF; }
.fd-aviso.alerta { border-left-color: var(--warn); background: #FBF4E6; }

.badge.libre { text-transform: none; }
SCRIPTEOF
echo "OK  public/contable/style.css"

cat > tests/helpers/facturaDian.js << 'SCRIPTEOF'
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
SCRIPTEOF
echo "OK  tests/helpers/facturaDian.js"

cat > tests/facturaElectronica.test.js << 'SCRIPTEOF'
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
SCRIPTEOF
echo "OK  tests/facturaElectronica.test.js"

cat > tests/asientoCompra.test.js << 'SCRIPTEOF'
// Ejecutar con: node --test tests/asientoCompra.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { armarAsientoCompra, repartir } = require('../public/contable/asientoCompra');

const linea = (valorTotal, extra = {}) => ({ valorTotal, iva: 0, otrosImpuestos: 0, ...extra });
const cuenta = (r, codigo) => r.lineas.filter((l) => l.cuentaCodigo === codigo);

test('Servicio con IVA descontable, retefuente y ReteIVA', () => {
  const r = armarAsientoCompra({
    lineas: [linea(1000000, { iva: 190000 }), linea(500000, { iva: 95000 })],
    base: 1500000, iva: 285000, impoconsumo: 0, total: 1785000,
    ivaDescontable: true,
    cuentasLinea: ['5195', '5195'],
    retenciones: [{ sobre: 'base', valor: 60000 }, { sobre: 'iva', valor: 42750 }],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '5195').length, 1); // las dos líneas van a la misma cuenta -> un solo débito
  assert.equal(cuenta(r, '5195')[0].debito, 1500000);
  assert.equal(cuenta(r, '1355')[0].debito, 285000);
  assert.equal(cuenta(r, '2365')[0].credito, 60000);
  assert.equal(cuenta(r, '2367')[0].credito, 42750);
  assert.equal(cuenta(r, '2205')[0].credito, 1682250);
  assert.equal(r.netoAPagar, 1682250);
  assert.equal(r.totalDebito, 1785000);
});

test('Cada línea a su cuenta', () => {
  const r = armarAsientoCompra({
    lineas: [linea(300000), linea(200000)],
    base: 500000, iva: 0, impoconsumo: 0, total: 500000,
    ivaDescontable: true, cuentasLinea: ['1435', '5195'], retenciones: [],
  });
  assert.equal(cuenta(r, '1435')[0].debito, 300000);
  assert.equal(cuenta(r, '5195')[0].debito, 200000);
  assert.equal(cuenta(r, '2365').length, 0); // sin retención no hay línea 2365
  assert.equal(cuenta(r, '1355').length, 0); // sin IVA no hay línea 1355
});

test('Empresa no responsable de IVA: el IVA suma al gasto de su propia línea', () => {
  const r = armarAsientoCompra({
    lineas: [linea(100000, { iva: 19000 }), linea(100000)],
    base: 200000, iva: 19000, impoconsumo: 0, total: 219000,
    ivaDescontable: false, cuentasLinea: ['1435', '5195'], retenciones: [],
  });
  assert.equal(cuenta(r, '1435')[0].debito, 119000);
  assert.equal(cuenta(r, '5195')[0].debito, 100000);
  assert.equal(cuenta(r, '1355').length, 0);
  assert.equal(r.cuadra, true);
});

test('Impoconsumo va a la línea que lo causa', () => {
  const r = armarAsientoCompra({
    lineas: [linea(200000, { otrosImpuestos: 16000 }), linea(100000, { iva: 19000 })],
    base: 300000, iva: 19000, impoconsumo: 16000, total: 335000,
    ivaDescontable: true, cuentasLinea: ['5195', '1435'], retenciones: [],
  });
  assert.equal(cuenta(r, '5195')[0].debito, 216000);
  assert.equal(cuenta(r, '1435')[0].debito, 100000);
  assert.equal(cuenta(r, '1355')[0].debito, 19000);
});

test('Descuento global se reparte en proporción y siempre cuadra al centavo', () => {
  const r = armarAsientoCompra({
    lineas: [linea(99999.99), linea(77777.77), linea(8641.92)],
    base: 154086.35, iva: 0, impoconsumo: 0, total: 154086.35, // = suma de líneas - 32333,33
    ivaDescontable: true, cuentasLinea: ['5195', '1435', '5195'], retenciones: [],
  });
  assert.equal(r.cuadra, true);
  assert.equal(r.totalDebito, 154086.35);
});

test('Si el XML es incoherente, el proveedor se acredita por el total y el asiento cuadra', () => {
  // líneas suman 100.000 pero el total con impuestos del XML es 130.000 (IVA 19.000)
  const r = armarAsientoCompra({
    lineas: [linea(100000)],
    base: 111000, iva: 19000, impoconsumo: 0, total: 130000,
    ivaDescontable: true, cuentasLinea: ['5195'], retenciones: [],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '5195')[0].debito, 111000);
  assert.equal(cuenta(r, '2205')[0].credito, 130000);
});

test('Línea gratuita (valor 0) no rompe el reparto', () => {
  const r = armarAsientoCompra({
    lineas: [linea(0), linea(50000)],
    base: 55000, iva: 0, impoconsumo: 0, total: 55000,
    ivaDescontable: true, cuentasLinea: ['5195', '5195'], retenciones: [],
  });
  assert.equal(r.cuadra, true);
  assert.equal(cuenta(r, '5195')[0].debito, 55000);
});

test('Centro de costo solo en las líneas de gasto', () => {
  const r = armarAsientoCompra({
    lineas: [linea(100000)], base: 100000, iva: 0, impoconsumo: 0, total: 100000,
    ivaDescontable: true, cuentasLinea: ['5195'], retenciones: [], centroCosto: 'CO-2026-109-CP',
  });
  assert.equal(cuenta(r, '5195')[0].centroCosto, 'CO-2026-109-CP');
  assert.equal(cuenta(r, '2205')[0].centroCosto, undefined);
});

test('Falta la cuenta de alguna línea', () => {
  assert.throws(() => armarAsientoCompra({ lineas: [linea(1), linea(2)], cuentasLinea: ['5195'], base: 3, total: 3 }), /cuenta destino/);
});

test('repartir no pierde centavos (incluso con valores negativos)', () => {
  for (const total of [100, 101, -37, 0, 1]) {
    const r = repartir(total, [3, 5, 7]);
    assert.equal(r.reduce((a, b) => a + b, 0), total);
  }
  assert.deepEqual(repartir(50, [0, 0]), [50, 0]);
});
SCRIPTEOF
echo "OK  tests/asientoCompra.test.js"

cat > README.md << 'SCRIPTEOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
PostgreSQL en Supabase).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Página institucional de Libaniel Consulting (raíz del dominio)
├── style.css                  Estilos del sitio institucional
└── contable/                  El software contable en sí, en /contable
    ├── index.html                Login + tablero con pestañas por módulo
    ├── style.css                 Estética de libro contable (IBM Plex, reglas horizontales)
    └── app.js                    Login, consumo de la API, formularios y acciones por rol
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa (con logo), Tercero (persona natural/
│   │                           jurídica, ubicación, régimen y responsabilidades
│   │                           DIAN, cuenta bancaria), Proyecto (futuro centro
│   │                           de costo), PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario, Usuario, LogAuditoria
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       ├── cierrePeriodo.js    Máquina de estados del cierre mensual
│       ├── authService.js      Login y registro de usuarios
│       ├── auditoria.js        Registro de acciones sensibles
│       ├── seedService.js      Datos base: empresa, periodo, cuentas, reglas
│       └── consecutivos.js     Numeración legible tipo COT-2026-0001 / ODA-2026-0001
├── modules/                  # Módulos operativos (capa transaccional) — TODOS completos
│   ├── ventas/                 Cotización → factura, patrón de referencia
│   ├── compras/                Factura recibida + documento soporte, orden de compra
│   ├── nomina/                 Periodo → empleados → liquidar → documento soporte
│   ├── inventarios/            Kardex simplificado: entradas, salidas, ajustes
│   ├── activosFijos/           Registro, depreciación mensual (cron), baja
│   └── tesoreria/               Cuentas bancarias, movimientos, conciliación
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
│   ├── depreciacionMensual.js  Implementado — recorre todas las empresas
│   └── vencimientoCotizaciones.js
├── middleware/                # authenticate + authorize por rol
└── routes/                   # Router raíz (auth, seed, terceros, y los 6 módulos)
```

## Aprovisionar una empresa nueva

Desde la pantalla de login, "¿Primera vez? Crear empresa y usuario" abre
un flujo de dos pasos: `POST /api/empresas` crea la empresa (razón
social, NIT, régimen tributario —ordinario, RST o especial—,
responsable de IVA, correo, teléfono, dirección, departamento,
municipio, representante legal y su documento, código CIIU y matrícula
mercantil), luego `POST /api/auth/registro` crea su primer usuario (rol
`contador` o `dueño` recomendado). `PATCH /api/empresas/:id` permite
editar estos datos después. Los tres endpoints quedan abiertos por
ahora — ver el TODO en `src/routes/empresas.routes.js` antes de tener
más de un puñado de empresas reales.

Al iniciar sesión, el panel **Inicio** (pestaña por defecto, ya no
Terceros) saluda por nombre, muestra la razón social de la empresa, y
presenta los nueve módulos como tarjetas — clic en cualquiera navega
directo a esa sección.

## Límite de tamaño del body JSON

`express.json()` ahora acepta hasta 5mb (antes, el default de Express
es 100kb). Lo necesita el logo de empresa, que se manda como base64
dentro del JSON — sin este cambio, cualquier imagen un poco pesada
hacía que la petición se rechazara antes de llegar a nuestro código,
con un error genérico ("Error inesperado") que no decía qué había
pasado de verdad. `api()` en el frontend ahora también reconoce un 413
específicamente y muestra un mensaje claro.

## Caché de archivos estáticos

`express.static` ahora manda `Cache-Control: no-cache` en todo lo que
sirve desde `public/` (HTML, CSS, JS). Antes de esto, durante una
etapa con despliegues tan frecuentes, era fácil que el navegador (o el
CDN de Hostinger) se quedara sirviendo una versión vieja de `app.js`
mientras el HTML ya estaba actualizado — un botón nuevo aparecía en
pantalla pero no hacía nada, porque el JavaScript que lo conectaba
seguía siendo el de antes. Si algo similar vuelve a pasar (un botón
nuevo no responde, pero el código se ve bien), lo primero a probar es
una recarga forzada (Ctrl+Shift+R) o una ventana de incógnito antes de
asumir que el código tiene un error real.

**Versión en la URL de los archivos (`?v=`)**: aun con `Cache-Control: no-cache`, el CDN de Hostinger o el
navegador pueden seguir entregando un `app.js` o `style.css` viejo con un `index.html` nuevo (pasó el
12/oct/2026: el formulario mostraba el bloque nuevo de retención pero el JS era el anterior, así que la
retención "no hacía nada"). Por eso `public/contable/index.html` pide los archivos con `?v=AAAAMMDD-n`.
**Cada vez que cambie `app.js`, `style.css`, `calculoOrden.js`, `asientoCompra.js` o `retencionesCatalogo.js`, subir ese valor
en `index.html`.** Para comprobar qué versión está sirviendo producción, abrir
`/contable/app.js?v=<valor>` y buscar un texto que solo exista en la versión nueva.

## Mi Empresa

Pestaña nueva en el tablero (al final del menú, como una sección de
configuración) donde se edita el perfil completo de la empresa —todos
los campos que ya existían en el registro inicial, incluido el logo—
usando `PATCH /api/empresas/:id`. Si no se elige un archivo nuevo al
guardar, el logo actual se conserva (no se borra por accidente).

## Logo de empresa

`Empresa.logoBase64` guarda el logo como data URI (base64) directo en
la base de datos, no como archivo en disco — en el hosting de Node de
Hostinger un archivo subido podría perderse en un redeploy, así que
esto evita esa dependencia. Límite de 2MB desde el frontend. Aparece en
el encabezado de `cotizacion-imprimir.html` y `orden-imprimir.html`
cuando existe.

## Proyectos (futuro centro de costo)

Catálogo nuevo (`Proyecto`: nombre, código/ID del centro de costo,
objeto, contratante —referencia a Tercero—, valor total, activo) para
los contratos/negocios/proyectos de la empresa. Hoy se usa desde
Órdenes de Adquisición (`OrdenCompra.proyectoId`, con el campo de texto
viejo `proyecto` conservado solo por compatibilidad con órdenes
anteriores al catálogo). Pendiente real: conectarlo con
`Movimiento.centroCosto` (hoy sigue siendo texto libre) para que la
segmentación contable por proyecto sea automática, no solo informativa
en las órdenes.

## Orden de adquisición: impuestos, AIU y retención

El cálculo de totales vive en **un solo archivo**, `public/contable/calculoOrden.js`,
que usan tanto el navegador (vista previa mientras se digita y PDF) como el
backend (`compras.service.js`, con `require`). El servidor siempre recalcula al
guardar; nunca confía en totales que lleguen del cliente. Pruebas:
`node --test tests/calculoOrden.test.js` (incluye el caso real ODA-016-2026).

- **IVA e Impoconsumo** se discriminan por separado (`OrdenCompra.iva` / `.impoconsumo`).
- **AIU** (Administración, Imprevistos, Utilidad): solo en órdenes de *servicios*; cada % se
  calcula sobre el subtotal. IVA 19% sobre (subtotal + AIU), o solo sobre la Utilidad
  (`aiuBaseIva = 'utilidad'`). Con AIU se ignora el IVA individual de los ítems.
- **Retención en la fuente** (informativa para el proveedor; no se suma al total, se resta para
  dar el **neto a pagar**). Tres opciones por orden: *No indicar*, *Aplicar* o *No aplica*.
  - *Aplicar*: una o varias líneas; cada una se elige **manualmente** del catálogo 2026
    (`public/contable/retencionesCatalogo.js`, 48 conceptos tomados del Excel de la firma: tarifa,
    tope en UVT y sobre qué se aplica). Se puede combinar, p. ej., retefuente de servicios + ReteIVA.
    La base es subtotal + AIU antes de impuestos; los conceptos "sobre AIU" (temporales, vigilancia y
    aseo) usan solo el AIU y ReteIVA usa el valor del IVA. Si la base no alcanza el tope en UVT
    (medido por orden), esa línea no retiene. "Otro concepto" permite digitar la tarifa.
  - *No aplica*: exige motivo (Régimen Simple, tratamiento especial, no supera el tope, otro) y
    detalle opcional; se imprime en el PDF.
  - El servidor toma tarifas y topes **del catálogo** (el cliente solo manda el código) y guarda una
    **foto** de las líneas calculadas (`OrdenCompra.retenciones`), para que una orden vieja no
    cambie cuando se actualice el catálogo en otro año. Para cambiar de año: editar `ANIO`,
    `UVT_VALOR` y el arreglo de conceptos.
  - **Proyección de pago** en el PDF: valor total de la orden (impuestos incluidos), cada retención
    descontada con su tarifa y base, y el **valor que recibirá el proveedor en su cuenta**
    (con su cuenta bancaria si está registrada). Es solo informativa: la orden no genera asientos
    contables; el único asiento ocurre al convertirla en factura de compra y hoy usa el total
    bruto (la retención aún no se contabiliza).
  - UVT 2026 = $52.374 (Res. DIAN 000238/2025). El Excel traía la columna VALOR con 52.400; el
    sistema usa la oficial.
- Al convertir la orden en factura de compra, `subtotal = total − iva`, de modo que el
  Impoconsumo (no descontable) queda como mayor valor del costo y `subtotal + iva = total`.

## Factura de compra desde el XML del proveedor

En **Facturas de compra → "+ Cargar factura (XML)"** se abre una ventana para subir el archivo que envía
el proveedor. Acepta tres formas (la persona no tiene que saber cuál es cuál): el XML de la factura
(`<Invoice>`), el `AttachedDocument` que mandan la mayoría de proveedores tecnológicos (trae la factura
adentro más la respuesta de la DIAN) o el **.zip** completo. También se puede arrastrar el archivo.

Son dos pasos y **nada se guarda hasta confirmar**:

1. **Vista previa** — `POST /api/compras/facturas/xml/previsualizar`. El servidor lee el XML y devuelve
   lo que hay que revisar: número, fecha, CUFE (con enlace "Verificar en la DIAN"), proveedor, líneas,
   IVA/Impoconsumo, totales, si la DIAN la validó, las órdenes de adquisición candidatas y las advertencias.
2. **Registro** — `POST /api/compras/facturas/xml`. El servidor **vuelve a leer el XML** (no confía en lo que
   muestre el navegador), valida, guarda la factura y el asiento en **una sola transacción**.

Qué hace al leerla / registrarla:

- **Proveedor por NIT** (ignora el dígito de verificación). Si no existe en Terceros se crea con los datos
  del XML (nombre, tipo de persona, régimen de IVA, responsabilidades RUT, correo, teléfono, dirección).
- **Orden de adquisición**: propone las del proveedor aprobadas o recibidas (marca la que la factura cita en
  `OrderReference` o la que tiene el mismo valor). Al vincularla la orden pasa a `facturada`, hereda el
  proyecto (centro de costo) y precarga su retención; si el valor difiere, pide aceptar la advertencia.
- **Retención**: la decide la persona (no se toma del XML), con el mismo catálogo 2026 y las mismas reglas
  (topes en UVT, ReteIVA, "No aplica" con motivo) de la orden — comparten `calcularRetenciones` en
  `calculoOrden.js`. Es obligatorio decidir. Si el XML dice que el proveedor es de Régimen Simple (O-47) o
  autorretenedor (O-15) se **sugiere** "No aplica" con su motivo. La base es el valor antes de impuestos de la
  factura real, no el de la orden.
- **Cuenta destino por línea** (inventario, gasto, costo, activo). Por defecto: orden de bienes → cuenta de
  débito de la regla `factura_compra_con_orden` (1435); servicios o sin orden → la de `factura_compra_sin_orden`
  (5195). "Llevar todo a" aplica una cuenta a todas las líneas.
- **Asiento de varias líneas**, mostrado antes de confirmar y guardado idéntico (módulo compartido
  `public/contable/asientoCompra.js`, en centavos enteros para que cuadre siempre):

  ```
  Db  cuenta destino de cada línea (+ Impoconsumo y otros impuestos que no son IVA)
  Db  1355 IVA descontable        (solo si la empresa es responsable de IVA; si no, va al gasto)
  Cr  2365 Retención en la fuente por pagar
  Cr  2367 ReteIVA por pagar
  Cr  2205 Proveedores nacionales   = total − retenciones   (= "valor a pagar")
  ```
  Descuentos o cargos globales de la factura se reparten entre las líneas en proporción a su valor.
  Si la factura tiene proyecto, las líneas de débito llevan `Movimiento.centroCosto` = código del proyecto.
- El motor (`motorAsientos.contabilizarAsientoCompuesto`) respeta la **regla** del evento: `manual` registra la
  factura **sin** asiento (queda `pendiente`); `asistido` se contabiliza porque la vista previa ya es la
  revisión humana; `automatico` también. Si la fecha de la factura no cae en un periodo abierto, el asiento
  va al periodo vigente con la fecha de hoy y se avisa — nunca escribe en un periodo cerrado.
  Las cuentas 2365 y 2367 se crean solas si la empresa no las tiene (se agregaron al seed).
- **Bloqueos** (no deja registrar): CUFE ya registrado, mismo número del mismo proveedor con otro CUFE, nota
  crédito/débito o documento soporte, moneda distinta de COP, sin CUFE/fecha/NIT, la DIAN no la validó.
  **Por confirmar** (checkbox): factura a nombre de otro NIT, total que no coincide con la orden, XML con
  totales incoherentes, anticipos, CUFE con formato raro.
- El **XML original** queda guardado en `facturas_compra.xml_contenido` y se descarga desde el detalle
  (`GET /api/compras/facturas/:id/xml`). El listado no lo trae (pesa); el detalle
  (`GET /api/compras/facturas/:id`) devuelve el desglose y el asiento.

Seguridad: el archivo viene de un tercero. El lector (`src/integrations/dian/xmlMini.js`) no tiene
dependencias y **rechaza cualquier DOCTYPE/ENTITY** (sin XXE ni expansión de entidades), limita la
profundidad, limita el tamaño descomprimido de un ZIP, y el navegador escapa todo texto del XML antes de
mostrarlo. Pruebas: `node --test tests/facturaElectronica.test.js` (lector y datos), `tests/asientoCompra.test.js`
(asiento). Los archivos de ejemplo se generan con `tests/helpers/facturaDian.js` (datos ficticios).

Lo que **no** hace todavía: notas crédito/débito, facturas en moneda extranjera, cruce de anticipos, ni los
eventos RADIAN (acuse de recibo, recibo del bien, aceptación expresa) — ver pendientes.

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).

La raíz del dominio (`/`) es la página institucional de **Libaniel
Consulting**, pensada para ofrecer varios servicios de la firma — hoy
solo el software contable es real, los otros dos son marcadores de
posición con un `mailto:` genérico (`contacto@libanielconsulting.com`)
hasta que se definan de verdad.

El software contable en sí vive en **`/contable`** — mismo backend,
solo un subdirectorio distinto en `public/`. Cubre creación y las
transiciones de estado principales de los seis módulos (formularios
inline + botones de acción por fila según el estado del registro). Dos
simplificaciones deliberadas por ahora:
acciones que piden un solo dato adicional puntual (agregar empleado a
un periodo, entradas/salidas/ajustes de inventario) usan `prompt()` del
navegador en vez de un formulario modal propio; y no hay edición ni
borrado de nada, solo creación y transiciones hacia adelante.

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa y resuelve solo el periodo
   contable vigente si no se le pasa explícito.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).
6. **Un movimiento bancario sin conciliar bloquea el cierre del periodo**
   (ver `cierrePeriodo.validarPeriodo`).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de la base de datos y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Sitios web → Apps Node.js → conectar el repositorio de GitHub.
2. Base de datos: PostgreSQL vía Supabase (host, puerto, nombre, usuario y
   contraseña como `DB_*` en las variables de entorno de la app).
3. hPanel → Avanzado → Cron Jobs → programar:
   - `node src/jobs/depreciacionMensual.js` — día 1 de cada mes
   - `node src/jobs/vencimientoCotizaciones.js` — diario

## Roles y autenticación

Cuatro roles, controlados por `src/middleware/auth.js` (`authenticate` +
`authorize(...roles)`):

| Rol | Puede |
|---|---|
| `dueño` | Operar el sistema, certificar el cierre mensual |
| `contador` | Todo lo anterior + reabrir un periodo certificado |
| `auxiliar` | Registrar operaciones del día a día (ventas, compras, nómina) |
| `revisor` | Solo lectura (pendiente de aplicar en cada ruta) |

`POST /api/auth/login` y `POST /api/auth/registro` son las únicas rutas
públicas. Todas las demás requieren `Authorization: Bearer <token>`.

## Datos base (seed)

`POST /api/seed` (requiere sesión con rol `contador` o `dueño`) crea:
una empresa de prueba, el periodo contable del mes en curso, un plan de
24 cuentas, y 13 reglas de contabilización — una por cada
evento que disparan los seis módulos operativos. Seguro de correr más
de una vez — no duplica nada. Sin esto, `motorAsientos` no tiene con
qué contabilizar.

## Pendientes inmediatos

- [ ] **Retención en la fuente en órdenes es solo informativa**. Al registrar la factura desde XML la retención **sí** se contabiliza (2365/2367 al causar la factura), pero `convertirOrdenEnFactura` (cierre manual de una orden sin XML) sigue contabilizando el total bruto sin retención ni IVA aparte. Falta unificarlo, y decidir qué hace Tesorería al pagar (el neto a pagar ya queda en `facturas_compra.neto_a_pagar`)
- [ ] Retención: el concepto se elige a mano en cada orden; no se deriva automáticamente de `Tercero.tipoPersona` / `responsabilidadesFiscales` (declarante / no declarante, RST). El tope en UVT se mide **por orden**, sin acumular los pagos del mes o del año al mismo proveedor. Validar los conceptos y tarifas del catálogo con el contador
- [ ] AIU en órdenes: igual que en cotizaciones, no admite mezclar ítems exentos/Impoconsumo con IVA sobre la base AIU (el Impoconsumo de los ítems se suma aparte; el IVA individual de los ítems se ignora)
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` usan `<script>` y `<style>` en línea, y `server.js` define una CSP `script-src 'self'` / `style-src 'self'`. Un navegador que respete esa CSP los bloquea (probado en un entorno local sin proxy). Si en algún momento las páginas de impresión dejan de cargar, mover ese JS/CSS a archivos externos

- [ ] Facturas de compra desde XML: notas crédito/débito de proveedores (descuentos y devoluciones posteriores), documento soporte recibido, facturas en moneda extranjera y cruce de anticipos
- [ ] RADIAN: enviar los eventos del comprador (acuse de recibo, recibo del bien o servicio, aceptación expresa) a la DIAN a través del proveedor tecnológico; hoy solo se lee el XML. Tampoco se consulta a la DIAN para comprobar el CUFE (hay un enlace para hacerlo a mano)
- [ ] Facturas de compra: el control de duplicados (CUFE) es una consulta previa, no un índice único; dos cargas simultáneas idénticas podrían pasar. Considerar índice único `(empresa_id, cufe)` al migrar a `sequelize-cli`
- [ ] Facturas de compra: aprobar/anular un asiento en `borrador` y anular una factura registrada por error (hoy no hay forma de revertirla desde la pantalla)
- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] **Migraciones de Sequelize (`sequelize-cli`)** en vez de `sync({ alter: true })` — ya tenemos evidencia concreta de por qué importa: con cada redeploy que tocó el modelo, Sequelize fue acumulando una restricción única duplicada sobre `consecutivo` en vez de reconocer que ya existía una (llegaron a existir 23 restricciones idénticas en `ordenes_compra`, ver corrección en Supabase del 30/sep/2026). `alter: true` es cómodo para esta etapa pero no es confiable para cambios de índices/restricciones a largo plazo
- [ ] Reemplazar `FACTOR_PRESTACIONES` (21.83% fijo) en `nomina.service.js` por el cálculo exacto de cesantías, intereses, prima y vacaciones según la normativa laboral vigente y el tipo de contrato
- [ ] Integrar `NovedadNomina` con el cálculo del devengado (hoy es solo un registro informativo, no ajusta nada automáticamente)
- [ ] Tesorería: cruzar movimientos de tipo ingreso/egreso contra la factura, orden o nómina específica que pagan (hoy solo "comisión" se contabiliza sola al conciliar; el resto solo queda marcado como conciliado, sin generar el asiento de pago)
- [ ] Mapear cada `CuentaBancaria` a su propia subcuenta contable — hoy todas comparten el código 1110 Bancos
- [ ] Múltiples líneas por evento en `motorAsientos`: ya existe `contabilizarAsientoCompuesto` (lo usa la factura de compra desde XML), pero `contabilizarEvento` sigue siendo de un débito y un crédito — las ventas no discriminan IVA por pagar en un renglón aparte, ni la nómina ni los activos fijos
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `DELETE` de terceros (crear, listar y editar ya existen; falta borrar)
- [ ] Vincular `MovimientoInventario` con los ítems reales de `FacturaVenta`/`FacturaCompra` — hoy las entradas y salidas se registran manualmente por API, no automático desde una venta
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Reemplazar los `prompt()` del navegador (agregar empleado a nómina, entradas/salidas/ajustes de inventario) por formularios modales propios en el frontend; agregar edición/borrado en general
- [ ] Confirmar que `www.libanielconsulting.com` resuelve al mismo sitio que `libanielconsulting.com` (revisar en hPanel → Dominios, o agregar la redirección si falta)
- [ ] Definir de verdad los servicios 02 y 03 de la página institucional (`public/index.html`) y reemplazar el `mailto:contacto@libanielconsulting.com` por el correo real de la firma
- [x] ~~Fase 2, parte 2~~ — Órdenes de Adquisición ya tiene ítems dinámicos, "Ver ítems" y "Editar" (solo en borrador), igual que Cotizaciones
- [ ] Aplicar `mensajeError()` (`src/core/utils/mensajeError.js`) en los demás controladores — hoy `ventas.controller.js` y `compras.controller.js` lo usan; nómina, inventarios, activos fijos y tesorería todavía devuelven el mensaje genérico de Sequelize
- [ ] La opción "Otro (definir %)" de impuesto en el ítem se guarda como `tipoImpuesto: 'iva'` con el porcentaje manual — no distingue si en realidad era un Impoconsumo con tarifa distinta a 4/8/16%. Si eso resulta ser un caso frecuente, vale la pena dejar elegir tipo Y porcentaje por separado en vez de un solo desplegable combinado
- [ ] El cálculo de IVA cuando `aplicaAiu = true` sigue asumiendo 19% general sobre (subtotal + AIU) sin importar el `tipoImpuesto` real de los ítems — no contempla todavía una cotización con AIU que mezcle ítems de Impoconsumo o exentos
- [x] ~~Fase 3, parte 2~~ — `orden-imprimir.html` ya existe: mismo patrón que cotización, con los datos del proveedor (incluida su cuenta bancaria) en vez del cliente, y el proyecto resuelto desde el catálogo
- [ ] Validar con un caso real si el IVA de una cotización con AIU debe calcularse sobre (subtotal + AIU) como quedó programado, o de otra forma según el tipo de contrato — ver la nota en `crearCotizacion` (`ventas.service.js`)
- [ ] `GET /compras/ordenes/:id` con ítems (el de cotizaciones ya existe: `GET /ventas/cotizaciones/:id`) — necesario para "Ver ítems" y la Fase 3 en Órdenes
- [ ] "Enviar" (cotización) sigue siendo solo un cambio de estado — no manda correo ni WhatsApp automáticamente, el botón ahora lo aclara con un `confirm()`. El envío real de verdad (correo con el PDF adjunto, por ejemplo) requeriría configurar un proveedor de correo transaccional, que todavía no existe en el proyecto
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` generan el PDF usando "Imprimir" del navegador (`window.print()`), no una librería de generación de PDF en el servidor — evita agregar una dependencia pesada (ej. Puppeteer) que podría no funcionar bien en el hosting de Node de Hostinger. Si el formato de impresión del navegador resulta insuficiente, esto es lo primero a reconsiderar
- [ ] Conectar `Proyecto` con `Movimiento.centroCosto` para que la contabilidad se segmente por proyecto de verdad (hoy el catálogo solo se usa desde Órdenes de Adquisición)
- [x] ~~Editar un `Proyecto` desde la interfaz~~ — ya existe el botón "Editar" (mismo formulario que crear, incluye activar/desactivar y permite borrar datos opcionales). Falta solo **eliminar** (hoy se desactiva)
- [ ] Migrar las órdenes viejas que tienen `proyecto` (texto libre) pero no `proyectoId`, para que puedan filtrarse/agruparse igual que las nuevas
- [ ] Usar `Tercero.responsabilidadesFiscales` y `tipoPersona` para automatizar el cálculo de retención en la fuente (formulario 350) — hoy son solo datos capturados, no alimentan ningún cálculo todavía
- [ ] Consecutivos: ya son únicos por empresa (índice compuesto `empresa_id + consecutivo`, no `consecutivo` global) y toda la creación vive en una transacción real — un fallo a mitad de camino ya no deja un encabezado huérfano con el número gastado. Sigue sin bloqueo transaccional de secuencia bajo concurrencia muy alta (una tabla de secuencias con `SELECT ... FOR UPDATE` sería la solución definitiva si el volumen lo exige)
SCRIPTEOF
echo "OK  README.md"

echo ""
echo "Listo. Facturas de compra desde XML instaladas."
echo "Las columnas nuevas de facturas_compra (número, retención, neto a pagar, XML, asiento...) se crean solas al reiniciar el servidor."
echo "Las cuentas 2365 (retención) y 2367 (ReteIVA) se crean solas la primera vez que se contabiliza una factura."
echo "Pruebas opcionales:"
echo "  node --test tests/facturaElectronica.test.js"
echo "  node --test tests/asientoCompra.test.js"
echo "  node --test tests/calculoOrden.test.js"
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Facturas de compra: carga del XML del proveedor, vista previa y contabilización con retenciones\""
echo "  git push"
echo ""
echo "Después del despliegue abre /contable con Ctrl+F5."
