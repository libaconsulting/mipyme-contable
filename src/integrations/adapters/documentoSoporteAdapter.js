// Interfaz única hacia el proveedor tecnológico para EMITIR el
// documento soporte — aquí SOMOS nosotros quienes lo generan, igual que
// una factura de venta (ver la nota en el modelo
// DocumentoSoporteAdquisicion). Mismo patrón que facturacionAdapter.js.

require('dotenv').config();

async function emitirDocumentoSoporte(documento) {
  // TODO: mapear "documento" al formato que exige la API del proveedor
  // contratado (usar DOC_SOPORTE_API_URL / DOC_SOPORTE_API_KEY del .env)
  // y hacer el POST real, igual que en facturacionAdapter.emitirFactura.
  return { idTransaccionExterna: `PENDIENTE-${documento.id}` };
}

module.exports = { emitirDocumentoSoporte };
