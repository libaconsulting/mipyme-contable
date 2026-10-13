const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Incapacidades, licencias, vacaciones y suspensiones. Se registra el rango
// COMPLETO de fechas (puede cruzar meses); cada liquidación toma la parte
// que cae en su mes.
const AusenciaNomina = sequelize.define('AusenciaNomina', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false },
  // incapacidad_general | incapacidad_laboral | licencia_maternidad | licencia_paternidad |
  // vacaciones | licencia_no_remunerada | suspension
  tipo: { type: DataTypes.STRING(30), allowNull: false },
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
  // Incapacidad prorrogada: días de la misma incapacidad que ya habían pasado antes de fechaInicio
  diasPrevios: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  // Valor diario distinto al salario/30 (p. ej. vacaciones con promedio de variables)
  valorDiario: { type: DataTypes.DECIMAL(15, 2) },
  numeroDocumento: { type: DataTypes.STRING(50) }, // número de la incapacidad o de la resolución
  observacion: { type: DataTypes.STRING(255) },
}, {
  tableName: 'nomina_ausencias',
  indexes: [{ fields: ['empresa_id', 'empleado_id'] }],
});

module.exports = AusenciaNomina;
