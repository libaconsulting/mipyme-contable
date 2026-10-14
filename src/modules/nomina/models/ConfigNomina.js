const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Parámetros de nómina de la EMPRESA (uno por empresa): lo que es igual para
// todos los empleados. Lo propio de cada persona vive en ContratoLaboral.
const ConfigNomina = sequelize.define('ConfigNomina', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  // Art. 114-1 E.T.: exoneración de salud del empleador, SENA e ICBF por quienes
  // devengan menos de 10 SMMLV. Aplica a personas jurídicas y a naturales con 2 o más trabajadores.
  exoneraArt114: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  areaGastoPorDefecto: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'administracion' },
  // Entidades del empleador en la PILA (lo normal es una sola ARL y una sola caja para toda la empresa)
  arlNombre: { type: DataTypes.STRING(100) },
  arlCodigo: { type: DataTypes.STRING(20) },
  ccfNombre: { type: DataTypes.STRING(100) },
  ccfCodigo: { type: DataTypes.STRING(20) },
  operadorPila: { type: DataTypes.STRING(100) },
  // Archivo plano de la PILA: ubicación laboral (códigos DANE/DIVIPOLA) y centro de trabajo de la ARL.
  codigoDepartamento: { type: DataTypes.STRING(2) },
  codigoMunicipio: { type: DataTypes.STRING(3) },
  centroTrabajo: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  // Días que se trabajan a la semana (5: lunes a viernes, 6: con sábado). Define qué
  // días son hábiles al descontar vacaciones.
  semanaLaboral: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
}, {
  tableName: 'nomina_config',
  indexes: [{ unique: true, fields: ['empresa_id'] }],
});

module.exports = ConfigNomina;
