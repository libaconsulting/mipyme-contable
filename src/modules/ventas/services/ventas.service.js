const { v4: uuidv4 } = require('uuid');
const Cotizacion = require('../models/Cotizacion');
const FacturaVenta = require('../models/FacturaVenta');
const facturacionAdapter = require('../../../integrations/adapters/facturacionAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Crea una cotización nueva en estado "borrador".
async function crearCotizacion(datos, usuario) {
  const cotizacion = await Cotizacion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    vendedorId: usuario.id,
    fecha: datos.fecha || new Date(),
    fechaVencimiento: datos.fechaVencimiento,
    estado: 'borrador',
    total: datos.total,
  });
  return cotizacion;
}

// borrador -> enviada
async function enviarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'borrador') {
    throw new Error('Solo se puede enviar una cotización en estado "borrador".');
  }
  await cotizacion.update({ estado: 'enviada' });
  return cotizacion;
}

// enviada -> aceptada
async function aceptarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'enviada') {
    throw new Error('Solo se puede aceptar una cotización en estado "enviada".');
  }
  await cotizacion.update({ estado: 'aceptada' });
  return cotizacion;
}

// enviada -> rechazada
async function rechazarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'enviada') {
    throw new Error('Solo se puede rechazar una cotización en estado "enviada".');
  }
  await cotizacion.update({ estado: 'rechazada' });
  return cotizacion;
}

// Copia los renglones de la cotización aceptada a una factura nueva,
// deja el vínculo de trazabilidad y marca la cotización como facturada.
async function convertirCotizacionEnFactura(cotizacionId, usuarioId) {
  const cotizacion = await Cotizacion.findByPk(cotizacionId);

  if (cotizacion.estado !== 'aceptada') {
    throw new Error('Solo se puede facturar una cotización en estado "aceptada".');
  }

  const factura = await FacturaVenta.create({
    id: uuidv4(),
    empresaId: cotizacion.empresaId,
    terceroId: cotizacion.terceroId,
    cotizacionOrigenId: cotizacion.id,
    fecha: new Date(),
    subtotal: cotizacion.total, // TODO: recalcular desde los ítems reales
    total: cotizacion.total,
    estadoSincronizacion: 'pendiente',
  });

  // TODO: copiar CotizacionItem -> FacturaVentaItem

  await cotizacion.update({ estado: 'facturada' });

  await emitirFacturaAnteProveedor(factura);

  return factura;
}

// Envía la factura al proveedor tecnológico acreditado; el motor de
// asientos solo se dispara cuando llega la confirmación (ver webhook).
async function emitirFacturaAnteProveedor(factura) {
  const respuesta = await facturacionAdapter.emitirFactura(factura);
  await factura.update({
    idTransaccionExterna: respuesta.idTransaccionExterna,
    estadoSincronizacion: 'enviado',
  });
  return respuesta;
}

// Llamado desde el webhook cuando el proveedor confirma "aceptada".
async function confirmarFacturaAceptada(facturaId, datosProveedor) {
  const factura = await FacturaVenta.findByPk(facturaId);

  await factura.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
    pdfUrl: datosProveedor.pdfUrl,
  });

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: 'factura_venta_credito', // o 'factura_venta_contado' según forma de pago
    origenModulo: 'ventas',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
  });

  return factura;
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  convertirCotizacionEnFactura,
  confirmarFacturaAceptada,
};
