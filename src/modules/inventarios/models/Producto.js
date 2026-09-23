const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

const Producto = sequelize.define('Producto', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  tipo: {
    type: DataTypes.ENUM('bien', 'servicio'),
    allowNull: false,
    defaultValue: 'bien',
  },
  unidadMedida: { type: DataTypes.STRING(20), defaultValue: 'unidad' },
  costoPromedio: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  cantidadDisponible: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'productos',
});

module.exports = Producto;
