const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Centro de trabajo de la ARL. Una empresa puede tener varios (por ejemplo uno por línea de
// negocio o por sede): la ARL asigna el código y la clase de riesgo de cada uno. Cada contrato
// elige el suyo y ese código va en el campo 62 del archivo plano de la PILA.
const CentroTrabajo = sequelize.define('CentroTrabajo', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  codigo: { type: DataTypes.INTEGER, allowNull: false }, // el que asigna la ARL
  nombre: { type: DataTypes.STRING(100), allowNull: false }, // línea de negocio o sede
  claseRiesgo: { type: DataTypes.INTEGER }, // 1 a 5; sirve de sugerencia al elegirlo en un contrato
  principal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // el de los contratos que no eligen
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'nomina_centros_trabajo',
  indexes: [{ unique: true, fields: ['empresa_id', 'codigo'] }],
});

module.exports = CentroTrabajo;
