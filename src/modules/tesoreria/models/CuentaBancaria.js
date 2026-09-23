const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

const CuentaBancaria = sequelize.define('CuentaBancaria', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  banco: { type: DataTypes.STRING(100), allowNull: false },
  numero: { type: DataTypes.STRING(50), allowNull: false },
  saldoContable: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'cuentas_bancarias',
});

module.exports = CuentaBancaria;
