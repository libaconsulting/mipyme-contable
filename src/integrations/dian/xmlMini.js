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
