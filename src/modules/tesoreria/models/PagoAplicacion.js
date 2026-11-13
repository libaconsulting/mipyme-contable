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
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  // Solo en descuentos: de dónde sale (ej. fuenteTipo 'aportes_contratistas', fuenteId = id del mes).
  fuenteTipo: { type: DataTypes.STRING(30) },
  fuenteId: { type: DataTypes.UUID },
  estado: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'activa' }, // activa | anulada
}, {
  tableName: 'tesoreria_pago_aplicaciones',
  indexes: [{ fields: ['empresa_id', 'doc_tipo', 'doc_id'] }, { fields: ['pago_id'] }],
});

module.exports = PagoAplicacion;
