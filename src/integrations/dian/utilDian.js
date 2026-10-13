// Utilidades comunes a la carga de documentos electrónicos (XML) de compras y ventas.

const MAX_ARCHIVO_BYTES = 3.5 * 1024 * 1024; // el límite de JSON del servidor es 5 MB (base64 pesa ~33% más)

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

module.exports = { MAX_ARCHIVO_BYTES, partesNit, mismoNit, decodificarArchivo };
