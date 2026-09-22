const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Nunca hardcodear UVT, tarifas de retefuente, RST o ICA en el código:
// cambian cada año gravable y este es el único lugar donde deben vivir.
const ParametroTributario = sequelize.define('ParametroTributario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  anioGravable: { type: DataTypes.INTEGER, allowNull: false },
  uvt: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  tarifasRetefuente: { type: DataTypes.JSON }, // { concepto: tarifa }
  tarifasRst: { type: DataTypes.JSON },        // { actividad: [{ desde, hasta, tarifa }] }
  tarifasIcaPorMunicipio: { type: DataTypes.JSON },
}, {
  tableName: 'parametros_tributarios',
  indexes: [{ unique: true, fields: ['anio_gravable'] }],
});

module.exports = ParametroTributario;
