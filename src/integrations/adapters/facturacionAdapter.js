// Interfaz interna estándar. Nuestros módulos solo conocen estas dos
// funciones; el detalle de qué proveedor tecnológico hay detrás
// (Factus, u otro acreditado por la DIAN) vive únicamente aquí.
// Cambiar de proveedor el día de mañana no debería tocar nada fuera
// de este archivo.

require('dotenv').config();

async function emitirFactura(factura) {
  // TODO: mapear "factura" al formato que exige la API del proveedor
  // contratado y hacer el POST real. Ejemplo de forma esperada:
  //
  // const response = await fetch(`${process.env.FACTURACION_API_URL}/invoices`, {
  //   method: 'POST',
  //   headers: {
  //     'Authorization': `Bearer ${process.env.FACTURACION_API_KEY}`,
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify(mapearFacturaAlFormatoDelProveedor(factura)),
  // });
  // const data = await response.json();
  // return { idTransaccionExterna: data.id, ... };

  return { idTransaccionExterna: `PENDIENTE-${factura.id}` };
}

// Llamada desde src/integrations/webhooks cuando el proveedor confirma
// la validación ante la DIAN (aceptada/rechazada).
async function consultarEstado(idTransaccionExterna) {
  // TODO: GET al endpoint de estado del proveedor.
  return { estado: 'pendiente' };
}

module.exports = { emitirFactura, consultarEstado };
