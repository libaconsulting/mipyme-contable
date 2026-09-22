const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Estados: abierto -> en_cierre -> (bloqueado -> vuelve a abierto) | cerrado_preliminar
//          -> cerrado_certificado -> (excepcional) reabierto -> en_cierre
const PeriodoContable = sequelize.define('PeriodoContable', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  fechaInicio: { type: DataTypes.DATEONLY, allowNull: false },
  fechaFin: { type: DataTypes.DATEONLY, allowNull: false },
  estado: {
    type: DataTypes.ENUM(
      'abierto',
      'en_cierre',
      'cerrado_preliminar',
      'cerrado_certificado',
      'reabierto'
    ),
    allowNull: false,
    defaultValue: 'abierto',
  },
  cerradoPor: { type: DataTypes.UUID },
  fechaCertificacion: { type: DataTypes.DATE },
  motivoReapertura: { type: DataTypes.TEXT },
}, {
  tableName: 'periodos_contables',
});

module.exports = PeriodoContable;
