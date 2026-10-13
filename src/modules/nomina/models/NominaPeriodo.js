const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un mes de nómina de la empresa.
//   borrador       se puede recalcular cuantas veces haga falta
//   contabilizada  la liquidación y las provisiones ya tienen asiento; no se recalcula
//   pagada         se registró el pago de los salarios netos
const NominaPeriodo = sequelize.define('NominaPeriodo', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  anio: { type: DataTypes.INTEGER, allowNull: false },
  mes: { type: DataTypes.INTEGER, allowNull: false },
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
  estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'borrador' },
  fechaContabilizacion: { type: DataTypes.DATEONLY },
  fechaPago: { type: DataTypes.DATEONLY },
  asientoId: { type: DataTypes.UUID }, // liquidación
  asientoProvisionesId: { type: DataTypes.UUID },
  asientoPagoId: { type: DataTypes.UUID },
  cuentaBancariaPagoId: { type: DataTypes.UUID },
  totalDevengado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalDeducciones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalNeto: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalAportesEmpleador: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalProvisiones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  observaciones: { type: DataTypes.STRING(255) },
}, {
  tableName: 'nomina_periodos',
  indexes: [{ unique: true, fields: ['empresa_id', 'anio', 'mes'] }],
});

module.exports = NominaPeriodo;
