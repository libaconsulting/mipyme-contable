const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

const Movimiento = sequelize.define('Movimiento', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  asientoId: { type: DataTypes.UUID, allowNull: false },
  cuentaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID },
  debito: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  credito: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  centroCosto: { type: DataTypes.STRING(50) },
}, {
  tableName: 'movimientos',
});

module.exports = Movimiento;
