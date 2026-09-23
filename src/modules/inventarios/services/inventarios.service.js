const { v4: uuidv4 } = require('uuid');
const Producto = require('../models/Producto');
const MovimientoInventario = require('../models/MovimientoInventario');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

async function crearProducto(datos, usuario) {
  return Producto.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    nombre: datos.nombre,
    tipo: datos.tipo || 'bien',
    unidadMedida: datos.unidadMedida || 'unidad',
    costoPromedio: 0,
    cantidadDisponible: 0,
  });
}

async function listarProductos(usuario) {
  return Producto.findAll({ where: { empresaId: usuario.empresaId }, order: [['nombre', 'ASC']] });
}

async function listarMovimientos(usuario) {
  return MovimientoInventario.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Entrada por compra. NO dispara un evento contable propio — la compra
// (factura_compra_con_orden / sin_orden) ya debita 1435 Inventarios
// directamente. Esto solo actualiza el saldo físico y recalcula el
// costo promedio ponderado.
async function registrarEntrada(datos, usuario) {
  const producto = await Producto.findByPk(datos.productoId);
  const cantidad = Number(datos.cantidad);
  const costoUnitario = Number(datos.costoUnitario);

  const cantidadAnterior = Number(producto.cantidadDisponible);
  const costoAnterior = Number(producto.costoPromedio);
  const nuevaCantidad = cantidadAnterior + cantidad;
  const nuevoCostoPromedio =
    nuevaCantidad === 0
      ? 0
      : (cantidadAnterior * costoAnterior + cantidad * costoUnitario) / nuevaCantidad;

  await producto.update({ cantidadDisponible: nuevaCantidad, costoPromedio: nuevoCostoPromedio });

  return MovimientoInventario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    productoId: producto.id,
    tipo: 'entrada',
    cantidad,
    costoUnitario,
    fecha: datos.fecha || new Date(),
    documentoOrigen: datos.documentoOrigen,
  });
}

// Salida por venta: SÍ dispara el costo de ventas (nivel automático),
// valorado al costo promedio vigente del producto en este momento.
async function registrarSalida(datos, usuario) {
  const producto = await Producto.findByPk(datos.productoId);
  const cantidad = Number(datos.cantidad);

  if (Number(producto.cantidadDisponible) < cantidad) {
    throw new Error(`No hay suficiente inventario de "${producto.nombre}" para esta salida.`);
  }

  const costoUnitario = Number(producto.costoPromedio);
  const valorSalida = cantidad * costoUnitario;

  await producto.update({ cantidadDisponible: Number(producto.cantidadDisponible) - cantidad });

  const movimiento = await MovimientoInventario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    productoId: producto.id,
    tipo: 'salida',
    cantidad,
    costoUnitario,
    fecha: datos.fecha || new Date(),
    documentoOrigen: datos.documentoOrigen,
  });

  await contabilizarEvento({
    empresaId: usuario.empresaId,
    tipoEvento: 'salida_inventario_venta',
    origenModulo: 'inventarios',
    origenId: movimiento.id,
    valor: valorSalida,
  });

  return movimiento;
}

// Ajuste por faltante en toma física: nivel manual (3) — nunca se
// contabiliza solo, reconoce una pérdida y exige autorización expresa.
async function registrarAjuste(datos, usuario) {
  const producto = await Producto.findByPk(datos.productoId);
  const cantidad = Number(datos.cantidad);
  const costoUnitario = Number(producto.costoPromedio);
  const valorAjuste = cantidad * costoUnitario;

  await producto.update({ cantidadDisponible: Number(producto.cantidadDisponible) - cantidad });

  const movimiento = await MovimientoInventario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    productoId: producto.id,
    tipo: 'ajuste',
    cantidad,
    costoUnitario,
    fecha: datos.fecha || new Date(),
    observacion: datos.observacion,
  });

  const resultado = await contabilizarEvento({
    empresaId: usuario.empresaId,
    tipoEvento: 'ajuste_inventario',
    origenModulo: 'inventarios',
    origenId: movimiento.id,
    valor: valorAjuste,
  });

  return { movimiento, contabilizacion: resultado };
}

module.exports = {
  crearProducto,
  listarProductos,
  listarMovimientos,
  registrarEntrada,
  registrarSalida,
  registrarAjuste,
};
