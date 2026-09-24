const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Unifica orden de compra (bienes) y orden de servicio en una sola
// entidad, distinguida por "tipo" — comparten ciclo de vida y campos de
// cabecera; lo único que cambia es la plantilla de impresión y que en
// servicios el renglón suele llevar descripción libre en vez de producto_id.
//
// Ciclo de vida: borrador -> emitida -> aprobada -> recibida_parcial |
// recibida_total -> facturada, o rechazada / anulada en cualquier punto
// antes de facturada. No genera asiento contable en ningún estado.
const OrdenCompra = sequelize.define('OrdenCompra', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor
  tipo: {
    type: DataTypes.ENUM('bienes', 'servicios'),
    allowNull: false,
    defaultValue: 'bienes',
  },
  aprobadorId: { type: DataTypes.UUID },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  fechaRequerida: { type: DataTypes.DATEONLY }, // fecha de cumplimiento
  estado: {
    type: DataTypes.ENUM(
      'borrador',
      'emitida',
      'aprobada',
      'recibida_parcial',
      'recibida_total',
      'facturada',
      'rechazada',
      'anulada'
    ),
    allowNull: false,
    defaultValue: 'borrador',
  },
  consecutivo: { type: DataTypes.STRING(30), unique: true },
  // Proyecto o unidad de negocio al que pertenece — es, en la práctica,
  // el mismo concepto que centro de costo (todavía pendiente como
  // catálogo propio, ver README).
  proyecto: { type: DataTypes.STRING(150) },
  lugarEntrega: { type: DataTypes.STRING(255) },
  formaPago: { type: DataTypes.TEXT },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
}, {
  tableName: 'ordenes_compra',
});

module.exports = OrdenCompra;
