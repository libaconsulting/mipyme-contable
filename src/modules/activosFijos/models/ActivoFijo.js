const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

const ActivoFijo = sequelize.define('ActivoFijo', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID }, // proveedor, opcional
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  fechaAdquisicion: { type: DataTypes.DATEONLY, allowNull: false },
  costo: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  vidaUtilMeses: { type: DataTypes.INTEGER, allowNull: false },
  metodoDepreciacion: {
    type: DataTypes.ENUM('linea_recta'),
    allowNull: false,
    defaultValue: 'linea_recta',
  },
  valorDepreciadoAcumulado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  estado: {
    type: DataTypes.ENUM('activo', 'dado_de_baja'),
    allowNull: false,
    defaultValue: 'activo',
  },
}, {
  tableName: 'activos_fijos',
});

module.exports = ActivoFijo;
