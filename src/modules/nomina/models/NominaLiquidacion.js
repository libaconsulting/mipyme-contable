const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// La liquidación de UN empleado en UN mes. Guarda el resultado completo del
// motor (resultado) y la "foto" de los datos con que se calculó (entrada),
// para poder auditar o reproducir el cálculo aunque después cambie el contrato.
const NominaLiquidacion = sequelize.define('NominaLiquidacion', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  periodoId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false },
  contratoId: { type: DataTypes.UUID, allowNull: false },
  areaGasto: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'administracion' },
  diasTrabajados: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  devengado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  deducciones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  neto: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  aportesEmpleador: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  provisiones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  ibc: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  pagado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  error: { type: DataTypes.STRING(500) }, // si el motor no pudo liquidar a este empleado
  entrada: { type: DataTypes.JSON },
  resultado: { type: DataTypes.JSON },
}, {
  tableName: 'nomina_liquidaciones',
  indexes: [{ unique: true, fields: ['periodo_id', 'empleado_id'] }, { fields: ['empresa_id', 'empleado_id'] }],
});

module.exports = NominaLiquidacion;
