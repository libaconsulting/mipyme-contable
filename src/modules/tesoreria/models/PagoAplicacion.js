const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Qué documento paga (o descuenta) un PagoTesoreria, y por cuánto. Un pago puede cubrir varios documentos
// y un documento puede recibir varios pagos (abonos). El saldo de un documento es su neto menos la suma de
// las aplicaciones en estado "activa".
const PagoAplicacion = sequelize.define('PagoAplicacion', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  pagoId: { type: DataTypes.UUID, allowNull: false },
  docTipo: { type: DataTypes.STRING(20), allowNull: false }, // factura_compra | documento_soporte | factura_venta
  docId: { type: DataTypes.UUID, allowNull: false },
  // Lo que baja el saldo del documento (en un recaudo incluye lo que el cliente retuvo).
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  // Retenciones que el cliente practicó sobre este cobro (solo recaudos): van a 135515 / 135517 / 135518.
  retefuente: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  reteiva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  reteica: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Solo en descuentos: de dónde sale (ej. fuenteTipo 'aportes_contratistas', fuenteId = id del mes).
  fuenteTipo: { type: DataTypes.STRING(30) },
  fuenteId: { type: DataTypes.UUID },
  estado: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'activa' }, // activa | anulada
}, {
  tableName: 'tesoreria_pago_aplicaciones',
  indexes: [{ fields: ['empresa_id', 'doc_tipo', 'doc_id'] }, { fields: ['pago_id'] }],
});

module.exports = PagoAplicacion;
