const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

const FacturaVenta = sequelize.define('FacturaVenta', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false },
  cotizacionOrigenId: { type: DataTypes.UUID }, // nulo si se facturó directo
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  // --- Campos de integración con el proveedor tecnológico (capa adaptadora) ---
  proveedorTecnologicoId: { type: DataTypes.UUID },
  idTransaccionExterna: { type: DataTypes.STRING(100) },
  cufe: { type: DataTypes.STRING(100) },
  estadoSincronizacion: {
    type: DataTypes.ENUM('pendiente', 'enviado', 'aceptado', 'rechazado'),
    defaultValue: 'pendiente',
  },
  xmlUrl: { type: DataTypes.STRING(255) },
  pdfUrl: { type: DataTypes.STRING(255) },
}, {
  tableName: 'facturas_venta',
});

module.exports = FacturaVenta;
