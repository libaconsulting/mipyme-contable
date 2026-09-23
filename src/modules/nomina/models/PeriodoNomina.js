const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un periodo de nómina agrupa los registros de NominaEmpleado que se
// liquidan y emiten juntos. borrador -> liquidada -> pagada (el pago
// en sí depende del módulo de Tesorería, todavía no construido).
const PeriodoNomina = sequelize.define('PeriodoNomina', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
  estado: {
    type: DataTypes.ENUM('borrador', 'liquidada', 'pagada'),
    allowNull: false,
    defaultValue: 'borrador',
  },
}, {
  tableName: 'periodos_nomina',
});

module.exports = PeriodoNomina;
