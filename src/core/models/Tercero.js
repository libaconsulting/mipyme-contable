const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Un solo maestro para cliente / proveedor / empleado, distinguido por "tipo".
// Evita triplicar validaciones de NIT/cédula.
const Tercero = sequelize.define('Tercero', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  tipo: {
    type: DataTypes.ENUM('cliente', 'proveedor', 'empleado', 'otro'),
    allowNull: false,
  },
  identificacion: { type: DataTypes.STRING(20), allowNull: false },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  regimenTributario: { type: DataTypes.STRING(50) },
  email: { type: DataTypes.STRING(150) },
}, {
  tableName: 'terceros',
  indexes: [{ fields: ['empresa_id', 'identificacion'] }],
});

module.exports = Tercero;
