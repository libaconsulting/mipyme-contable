const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Registro simple de novedades (incapacidad, vacaciones, licencia).
// TODO: todavía no ajusta automáticamente el devengado calculado en
// NominaEmpleado — por ahora es solo trazabilidad/consulta manual.
const NovedadNomina = sequelize.define('NovedadNomina', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false },
  tipo: {
    type: DataTypes.ENUM('incapacidad', 'vacaciones', 'licencia', 'otro'),
    allowNull: false,
  },
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
  observacion: { type: DataTypes.TEXT },
}, {
  tableName: 'novedades_nomina',
});

module.exports = NovedadNomina;
