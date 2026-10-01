const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Cotizacion = require('../models/Cotizacion');
const CotizacionItem = require('../models/CotizacionItem');
const FacturaVenta = require('../models/FacturaVenta');
const facturacionAdapter = require('../../../integrations/adapters/facturacionAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { crearConSecutivoUnico } = require('../../../core/services/consecutivos');

// Crea una cotización nueva en estado "borrador". Si vienen "items"
// (arreglo de { concepto, cantidad, unidadMedida, valorUnitario,
// tipoImpuesto, impuestoPorcentaje }), se crean como CotizacionItem y
// el subtotal/impuesto/total se calculan solos — no se confía en un
// total mandado a mano. Si no vienen items (compatibilidad hacia
// atrás), se respeta el "total" que mande el cliente.
async function crearCotizacion(datos, usuario) {
  return crearConSecutivoUnico(Cotizacion, usuario.empresaId, 'COT', async (consecutivo, transaction) => {
    const cotizacion = await Cotizacion.create(
      {
        id: uuidv4(),
        empresaId: usuario.empresaId,
        terceroId: datos.terceroId,
        vendedorId: usuario.id,
        consecutivo,
        fecha: datos.fecha || new Date(),
        fechaVencimiento: datos.fechaVencimiento,
        formaPago: datos.formaPago,
        observaciones: datos.observaciones,
        contactoNombre: datos.contactoNombre,
        contactoTelefono: datos.contactoTelefono,
        aplicaAiu: !!datos.aplicaAiu,
        aiuAdministracion: datos.aiuAdministracion,
        aiuImprevistos: datos.aiuImprevistos,
        aiuUtilidad: datos.aiuUtilidad,
        estado: 'borrador',
        subtotal: 0,
        iva: 0,
        total: datos.total || 0,
      },
      { transaction }
    );

    if (Array.isArray(datos.items) && datos.items.length > 0) {
      let subtotal = 0;
      let impuestoTotal = 0;

      for (const item of datos.items) {
        const cantidad = Number(item.cantidad);
        const valorUnitario = Number(item.valorUnitario);
        const tipoImpuesto = item.tipoImpuesto || 'iva';
        const impuestoPorcentaje = item.impuestoPorcentaje ?? 19;
        const valorTotal = cantidad * valorUnitario;
        const impuestoValor = valorTotal * (impuestoPorcentaje / 100);

        await CotizacionItem.create(
          {
            id: uuidv4(),
            cotizacionId: cotizacion.id,
            concepto: item.concepto,
            cantidad,
            unidadMedida: item.unidadMedida || 'UND',
            valorUnitario,
            tipoImpuesto,
            impuestoPorcentaje,
            valorTotal,
            impuestoValor,
          },
          { transaction }
        );

        subtotal += valorTotal;
        impuestoTotal += impuestoValor;
      }

      // Si aplica AIU, el impuesto se recalcula al 19% sobre (subtotal +
      // AIU) en vez de sumar el impuesto real de cada ítem — es la
      // convención más común en contratos de obra/servicios, pero asume
      // IVA general y no contempla ítems con Impoconsumo o exentos
      // mezclados en la misma cotización con AIU. Validar contra el tipo
      // de contrato específico antes de confiar en esto a ciegas.
      let baseImpuesto = subtotal;
      let impuesto = impuestoTotal;
      if (cotizacion.aplicaAiu) {
        const admin = subtotal * (Number(datos.aiuAdministracion || 0) / 100);
        const imprevistos = subtotal * (Number(datos.aiuImprevistos || 0) / 100);
        const utilidad = subtotal * (Number(datos.aiuUtilidad || 0) / 100);
        baseImpuesto = subtotal + admin + imprevistos + utilidad;
        impuesto = baseImpuesto * 0.19;
      }
      const total = baseImpuesto + impuesto;

      await cotizacion.update({ subtotal, iva: impuesto, total }, { transaction });
    }

    return cotizacion;
  });
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

async function listarCotizaciones(usuario) {
  return Cotizacion.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

async function listarFacturas(usuario) {
  return FacturaVenta.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
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

// Cotización con sus ítems — para "Ver ítems" en el frontend y, más
// adelante, la plantilla imprimible.
async function obtenerCotizacion(id, usuario) {
  const cotizacion = await Cotizacion.findOne({
    where: { id, empresaId: usuario.empresaId },
  });
  if (!cotizacion) return null;

  const items = await CotizacionItem.findAll({ where: { cotizacionId: id } });
  return { ...cotizacion.toJSON(), items };
}

// Edita una cotización — solo mientras sigue en "borrador". Una vez
// enviada, aceptada o facturada, el cliente ya vio esos números; dejar
// que se editen por detrás generaría inconsistencias.
//
// Reemplaza TODOS los ítems con los que vengan en el body (se borran
// los viejos y se crean los nuevos) en vez de intentar diferenciar
// cuáles cambiaron — más simple y confiable para una tabla que solo
// tiene unos pocos renglones. Todo dentro de una transacción: o se
// actualiza completo, o no se actualiza nada.
async function actualizarCotizacion(id, datos, usuario) {
  const cotizacion = await Cotizacion.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!cotizacion) return null;

  if (cotizacion.estado !== 'borrador') {
    throw new Error('Solo se puede editar una cotización en estado "borrador".');
  }

  return sequelize.transaction(async (transaction) => {
    await cotizacion.update(
      {
        terceroId: datos.terceroId,
        fechaVencimiento: datos.fechaVencimiento,
        formaPago: datos.formaPago,
        observaciones: datos.observaciones,
        contactoNombre: datos.contactoNombre,
        contactoTelefono: datos.contactoTelefono,
        aplicaAiu: !!datos.aplicaAiu,
        aiuAdministracion: datos.aiuAdministracion,
        aiuImprevistos: datos.aiuImprevistos,
        aiuUtilidad: datos.aiuUtilidad,
      },
      { transaction }
    );

    await CotizacionItem.destroy({ where: { cotizacionId: id }, transaction });

    let subtotal = 0;
    let impuestoTotal = 0;

    for (const item of datos.items || []) {
      const cantidad = Number(item.cantidad);
      const valorUnitario = Number(item.valorUnitario);
      const tipoImpuesto = item.tipoImpuesto || 'iva';
      const impuestoPorcentaje = item.impuestoPorcentaje ?? 19;
      const valorTotal = cantidad * valorUnitario;
      const impuestoValor = valorTotal * (impuestoPorcentaje / 100);

      await CotizacionItem.create(
        {
          id: uuidv4(),
          cotizacionId: id,
          concepto: item.concepto,
          cantidad,
          unidadMedida: item.unidadMedida || 'UND',
          valorUnitario,
          tipoImpuesto,
          impuestoPorcentaje,
          valorTotal,
          impuestoValor,
        },
        { transaction }
      );

      subtotal += valorTotal;
      impuestoTotal += impuestoValor;
    }

    // Misma convención (y misma reserva) que en crearCotizacion: con
    // AIU, el impuesto se recalcula al 19% sobre (subtotal + AIU).
    let baseImpuesto = subtotal;
    let impuesto = impuestoTotal;
    if (cotizacion.aplicaAiu) {
      const admin = subtotal * (Number(datos.aiuAdministracion || 0) / 100);
      const imprevistos = subtotal * (Number(datos.aiuImprevistos || 0) / 100);
      const utilidad = subtotal * (Number(datos.aiuUtilidad || 0) / 100);
      baseImpuesto = subtotal + admin + imprevistos + utilidad;
      impuesto = baseImpuesto * 0.19;
    }
    const total = baseImpuesto + impuesto;

    await cotizacion.update({ subtotal, iva: impuesto, total }, { transaction });

    return cotizacion;
  });
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  listarCotizaciones,
  listarFacturas,
  obtenerCotizacion,
  actualizarCotizacion,
  convertirCotizacionEnFactura,
  confirmarFacturaAceptada,
};
