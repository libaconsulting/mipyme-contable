const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Pago de la planilla de aportes (PILA) de un mes de nómina al operador de información.
const NominaPlanillaPago = sequelize.define('NominaPlanillaPago', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  periodoId: { type: DataTypes.UUID, allowNull: false },
  fechaPago: { type: DataTypes.DATEONLY, allowNull: false },
  numeroPlanilla: { type: DataTypes.STRING(30) },
  operador: { type: DataTypes.STRING(100) },
  valorLiquidado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  valorPila: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  mora: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  estado: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'pagada' }, // pagada | anulada
  asientoId: { type: DataTypes.UUID },
  cuentaBancariaId: { type: DataTypes.UUID },
  movimientoBancarioId: { type: DataTypes.UUID },
  detalle: { type: DataTypes.JSON }, // por grupo: salud, pensión, ARL, parafiscales
  motivoAnulacion: { type: DataTypes.STRING(255) },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'nomina_planilla_pagos',
  indexes: [{ fields: ['empresa_id', 'periodo_id'] }],
});

module.exports = NominaPlanillaPago;
