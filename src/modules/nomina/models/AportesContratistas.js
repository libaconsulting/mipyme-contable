const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Aportes de los contratistas de un mes (planilla Y): liquidación, causación del descuento y pago.
// `lineas` guarda la foto del cálculo de cada contratista al contabilizar, así un cambio posterior en los
// contratos no altera un mes ya contabilizado.
const AportesContratistas = sequelize.define('AportesContratistas', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  anio: { type: DataTypes.INTEGER, allowNull: false },
  mes: { type: DataTypes.INTEGER, allowNull: false },
  estado: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'borrador' }, // borrador | contabilizada | pagada
  lineas: { type: DataTypes.JSON },
  totales: { type: DataTypes.JSON },
  fechaContabilizacion: { type: DataTypes.DATEONLY },
  asientoId: { type: DataTypes.UUID }, // causación del descuento
  // Pago de la planilla Y al operador
  fechaPago: { type: DataTypes.DATEONLY },
  numeroPlanilla: { type: DataTypes.STRING(30) },
  operador: { type: DataTypes.STRING(100) },
  mora: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  totalPagado: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  asientoPagoId: { type: DataTypes.UUID },
  cuentaBancariaId: { type: DataTypes.UUID },
  movimientoBancarioId: { type: DataTypes.UUID },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'nomina_aportes_contratistas',
  indexes: [{ unique: true, fields: ['empresa_id', 'anio', 'mes'] }],
});

module.exports = AportesContratistas;
