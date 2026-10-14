const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un documento de pago de prestaciones sociales o de liquidación de contrato.
//   prima          prima de servicios de un semestre (todos los empleados)
//   cesantias      cesantías de un año (todos los empleados)
//   intereses      intereses sobre cesantías de un año (todos los empleados)
//   vacaciones     vacaciones pagadas en dinero a UN empleado
//   liquidacion    liquidación final del contrato de UN empleado
//
// Estados:  borrador (se recalcula) -> pagada (con su asiento) -> anulada
const NominaPrestacion = sequelize.define('NominaPrestacion', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  tipo: { type: DataTypes.STRING(15), allowNull: false },
  anio: { type: DataTypes.INTEGER, allowNull: false },
  semestre: { type: DataTypes.INTEGER }, // solo la prima: 1 o 2
  // Fecha hasta la que se liquida (fin del semestre o del año, o el día del retiro)
  fechaCorte: { type: DataTypes.DATEONLY, allowNull: false },
  fechaPago: { type: DataTypes.DATEONLY },
  estado: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'borrador' },
  asientoId: { type: DataTypes.UUID },
  cuentaBancariaPagoId: { type: DataTypes.UUID },
  movimientoBancarioId: { type: DataTypes.UUID },
  totalDevengado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalRetencion: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalDescuentos: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalNeto: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  motivoAnulacion: { type: DataTypes.STRING(255) },
  observaciones: { type: DataTypes.STRING(255) },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'nomina_prestaciones',
  indexes: [{ fields: ['empresa_id', 'tipo', 'anio'] }],
});

module.exports = NominaPrestacion;
