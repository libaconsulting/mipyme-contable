const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Raíz del modelo multi-tenant: toda entidad del sistema cuelga de empresa_id.
const Empresa = sequelize.define('Empresa', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  nit: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  razonSocial: { type: DataTypes.STRING(150), allowNull: false },
  regimenTributario: {
    type: DataTypes.ENUM('ordinario', 'rst'),
    allowNull: false,
    defaultValue: 'ordinario',
  },
  responsableIva: { type: DataTypes.BOOLEAN, defaultValue: false },
  resolucionFacturacion: { type: DataTypes.STRING(50) },
  periodoFiscalActualId: { type: DataTypes.UUID },
}, {
  tableName: 'empresas',
});

module.exports = Empresa;
