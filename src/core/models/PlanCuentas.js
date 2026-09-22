const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

const PlanCuentas = sequelize.define('PlanCuentas', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  codigo: { type: DataTypes.STRING(20), allowNull: false },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  naturaleza: { type: DataTypes.ENUM('debito', 'credito'), allowNull: false },
  nivel: { type: DataTypes.INTEGER, allowNull: false },
  cuentaPadreId: { type: DataTypes.UUID },
  elementoNiif: {
    type: DataTypes.ENUM('activo', 'pasivo', 'patrimonio', 'ingreso', 'costo', 'gasto'),
    allowNull: false,
  },
}, {
  tableName: 'plan_cuentas',
  indexes: [{ unique: true, fields: ['empresa_id', 'codigo'] }],
});

module.exports = PlanCuentas;
