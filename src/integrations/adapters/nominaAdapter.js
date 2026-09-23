// Interfaz única hacia el proveedor tecnológico para EMITIR el
// documento soporte de nómina electrónica. Mismo patrón que
// facturacionAdapter.js y documentoSoporteAdapter.js.

require('dotenv').config();

async function emitirNomina(nominaEmpleado) {
  // TODO: mapear "nominaEmpleado" al formato que exige la API del
  // proveedor contratado (usar NOMINA_API_URL / NOMINA_API_KEY del .env)
  // y hacer el POST real.
  return { idTransaccionExterna: `PENDIENTE-${nominaEmpleado.id}` };
}

module.exports = { emitirNomina };
