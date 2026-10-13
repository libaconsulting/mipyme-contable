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
  // --- Factura emitida por un proveedor tecnológico (Siigo, etc.) y cargada con su XML ---
  origen: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'interno' }, // 'interno' | 'xml'
  numero: { type: DataTypes.STRING(40) },
  fechaVencimiento: { type: DataTypes.DATEONLY },
  formaPago: { type: DataTypes.STRING(20) },
  receptorNit: { type: DataTypes.STRING(30) },
  receptorNombre: { type: DataTypes.STRING(200) },
  proyectoId: { type: DataTypes.UUID },
  asientoId: { type: DataTypes.UUID },
  detalle: { type: DataTypes.JSON },
  xmlContenido: { type: DataTypes.TEXT('long') },
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
  indexes: [{ fields: ['empresa_id', 'cufe'] }],
});

module.exports = FacturaVenta;
