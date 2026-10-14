const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Contrato de un empleado (Tercero con tipo 'empleado'). El salario y las
// condiciones que afectan la liquidación viven aquí; cada mes se toma una
// "foto" de estos datos dentro de NominaLiquidacion, así una liquidación ya
// hecha no cambia si después se actualiza el contrato.
const ContratoLaboral = sequelize.define('ContratoLaboral', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false },
  cargo: { type: DataTypes.STRING(100) },
  tipoContrato: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'indefinido' }, // indefinido | fijo | obra_labor
  fechaIngreso: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFinPactada: { type: DataTypes.DATEONLY }, // contrato a término fijo
  fechaTerminacion: { type: DataTypes.DATEONLY },
  salarioBase: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  tipoSalario: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'ordinario' }, // ordinario | integral
  auxilioTransporte: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'auto' }, // auto | si | no
  tipoAuxilio: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'transporte' }, // transporte | conectividad
  claseRiesgo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  horasSemanales: { type: DataTypes.INTEGER }, // solo si es jornada distinta a la máxima legal
  areaGasto: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'administracion' }, // administracion | ventas
  // Retención en la fuente
  retencionFuente: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'calculada' }, // calculada | no_aplica | manual
  retencionManual: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  dependientes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  interesesVivienda: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  medicinaPrepagada: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  aporteVoluntarioPension: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  aporteAfc: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Entidades de seguridad social del empleado (nombre y código PILA)
  epsNombre: { type: DataTypes.STRING(100) },
  epsCodigo: { type: DataTypes.STRING(20) },
  afpNombre: { type: DataTypes.STRING(100) },
  afpCodigo: { type: DataTypes.STRING(20) },
  fondoCesantiasNombre: { type: DataTypes.STRING(100) },
  fondoCesantiasCodigo: { type: DataTypes.STRING(20) },
  // Vacaciones: días HÁBILES ya disfrutados o pagados en dinero antes de usar el sistema
  // (acumulado desde el ingreso). Con esto el saldo de vacaciones arranca bien.
  vacacionesDiasPrevios: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
  observaciones: { type: DataTypes.TEXT },
}, {
  tableName: 'nomina_contratos',
  indexes: [{ fields: ['empresa_id', 'empleado_id'] }],
});

module.exports = ContratoLaboral;
