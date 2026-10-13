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
  tipoCuenta: { type: DataTypes.ENUM('ahorros', 'corriente') },
  // Auxiliar del plan de cuentas (11100501...) donde se contabiliza esta cuenta
  cuentaContableId: { type: DataTypes.UUID },
  // El banco como tercero (si se dio su NIT), para el auxiliar por banco
  terceroId: { type: DataTypes.UUID },
  saldoContable: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'cuentas_bancarias',
});

module.exports = CuentaBancaria;
