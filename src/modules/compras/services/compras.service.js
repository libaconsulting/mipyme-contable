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
    aplicaRetencion: cabecera.aplicaRetencion,
    retencionConcepto: cabecera.aplicaRetencion ? datos.retencionConcepto || null : null,
    retencionPorcentaje: cabecera.retencionPorcentaje,
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
  const calculo = hayItems ? calcularOrden(datos) : null;

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
  const { cabecera, netoAPagar } = calcularOrden({ ...datos, items: items.map((i) => i.toJSON()) }, { estricto: false });
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

  const calculo = calcularOrden(datos);

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
