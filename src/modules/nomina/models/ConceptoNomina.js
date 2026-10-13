const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Novedades de devengo (horas extras, comisiones, bonos…) y de descuento
// (préstamo, libranza, embargo…). Dos formas:
//  - de UN mes: lleva anio y mes y solo cuenta en esa nómina.
//  - recurrente: sin mes; cuenta en todas las nóminas desde 'desdeAnio/desdeMes' hasta que se desactive.
const ConceptoNomina = sequelize.define('ConceptoNomina', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false },
  clase: { type: DataTypes.STRING(10), allowNull: false }, // devengo | descuento
  codigo: { type: DataTypes.STRING(40), allowNull: false }, // ver parametrosLaborales.DEVENGOS / DESCUENTOS
  cantidad: { type: DataTypes.DECIMAL(10, 2) }, // horas
  valor: { type: DataTypes.DECIMAL(15, 2) },
  descripcion: { type: DataTypes.STRING(150) },
  recurrente: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  anio: { type: DataTypes.INTEGER },
  mes: { type: DataTypes.INTEGER },
  desdeAnio: { type: DataTypes.INTEGER },
  desdeMes: { type: DataTypes.INTEGER },
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'nomina_conceptos',
  indexes: [{ fields: ['empresa_id', 'empleado_id'] }, { fields: ['empresa_id', 'anio', 'mes'] }],
});

module.exports = ConceptoNomina;
