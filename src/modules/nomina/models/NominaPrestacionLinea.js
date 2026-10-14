const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Lo que se le liquida a UN empleado en un documento de prestaciones.
// Guarda los componentes (con el saldo de provisión que había en el libro) y el
// detalle completo del cálculo, para poder explicarlo después.
const NominaPrestacionLinea = sequelize.define('NominaPrestacionLinea', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  prestacionId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false },
  contratoId: { type: DataTypes.UUID, allowNull: false },
  areaGasto: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'administracion' },
  devengado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  retencion: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  descuentos: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  neto: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  componentes: { type: DataTypes.JSON },
  descuentosDetalle: { type: DataTypes.JSON },
  resultado: { type: DataTypes.JSON },
  entrada: { type: DataTypes.JSON },
  error: { type: DataTypes.STRING(500) },
}, {
  tableName: 'nomina_prestacion_lineas',
  indexes: [{ fields: ['prestacion_id'] }, { fields: ['empresa_id', 'empleado_id'] }],
});

module.exports = NominaPrestacionLinea;
