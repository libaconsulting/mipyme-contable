const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Ciclo de vida: borrador -> enviada -> (aceptada | rechazada | expirada)
// -> facturada. No genera asiento contable en ningún estado.
const Cotizacion = sequelize.define('Cotizacion', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false },
  vendedorId: { type: DataTypes.UUID },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  fechaVencimiento: { type: DataTypes.DATEONLY, allowNull: false },
  estado: {
    type: DataTypes.ENUM('borrador', 'enviada', 'aceptada', 'rechazada', 'expirada', 'facturada'),
    allowNull: false,
    defaultValue: 'borrador',
  },
  consecutivo: { type: DataTypes.STRING(30), unique: true },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  formaPago: { type: DataTypes.TEXT },
  observaciones: { type: DataTypes.TEXT },
  contactoNombre: { type: DataTypes.STRING(150) },
  contactoTelefono: { type: DataTypes.STRING(30) },
  // AIU: Administración, Imprevistos, Utilidad — habitual en contratos
  // de obra/servicios. Porcentajes sobre el subtotal; ver la nota de
  // cálculo en ventas.service.js (crearCotizacion).
  aplicaAiu: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  aiuAdministracion: { type: DataTypes.DECIMAL(5, 2) },
  aiuImprevistos: { type: DataTypes.DECIMAL(5, 2) },
  aiuUtilidad: { type: DataTypes.DECIMAL(5, 2) },
}, {
  tableName: 'cotizaciones',
});

module.exports = Cotizacion;
