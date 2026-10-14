const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Contrato de prestación de servicios de un contratista independiente (Tercero) cuyos aportes
// a seguridad social la empresa paga en la planilla Y de la PILA, por acuerdo con el contratista
// (Resolución 467 de 2025). Solo se registran los contratos con ese acuerdo.
const ContratoContratista = sequelize.define('ContratoContratista', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false },
  descripcion: { type: DataTypes.STRING(255) }, // objeto del contrato
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false }, // inicio del contrato o del acuerdo de pago de aportes
  fechaFin: { type: DataTypes.DATEONLY }, // fin pactado o terminación; vacío = sin fecha de fin
  valorMensual: { type: DataTypes.DECIMAL(15, 2), allowNull: false }, // valor MENSUALIZADO sin IVA
  claseRiesgo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  areaGasto: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'administracion' }, // administracion | ventas (ARL que asume la empresa)
  cuentaPorPagar: { type: DataTypes.STRING(4), allowNull: false, defaultValue: '2335' }, // 2335 documento soporte | 2205 factura
  tipoDocumento: { type: DataTypes.STRING(2), allowNull: false, defaultValue: 'CC' },
  epsNombre: { type: DataTypes.STRING(100) },
  epsCodigo: { type: DataTypes.STRING(20) },
  afpNombre: { type: DataTypes.STRING(100) },
  afpCodigo: { type: DataTypes.STRING(20) },
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  observaciones: { type: DataTypes.STRING(500) },
}, {
  tableName: 'nomina_contratistas',
  indexes: [{ fields: ['empresa_id', 'tercero_id'] }],
});

module.exports = ContratoContratista;
