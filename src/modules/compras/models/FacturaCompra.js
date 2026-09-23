const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Facturas RECIBIDAS de proveedores que sí facturan electrónicamente.
// A diferencia de FacturaVenta (que nosotros emitimos), esta llega desde
// afuera — vía RADIAN o el proveedor tecnológico — ya validada ante la
// DIAN por quien la emitió. Ver src/integrations/webhooks para el
// detalle de cómo llega.
const FacturaCompra = sequelize.define('FacturaCompra', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor
  ordenCompraOrigenId: { type: DataTypes.UUID }, // nulo si no hubo orden previa
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  cufe: { type: DataTypes.STRING(100) },
  xmlUrl: { type: DataTypes.STRING(255) },
  estadoConciliacion: {
    type: DataTypes.ENUM('pendiente', 'contabilizada', 'objetada'),
    defaultValue: 'pendiente',
  },
}, {
  tableName: 'facturas_compra',
});

module.exports = FacturaCompra;
