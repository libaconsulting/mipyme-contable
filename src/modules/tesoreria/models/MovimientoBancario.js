const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Cada CuentaBancaria tiene su propio auxiliar contable (11100501...),
// ver tesoreria/services/contabilidadBancaria.js.
const MovimientoBancario = sequelize.define('MovimientoBancario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  cuentaBancariaId: { type: DataTypes.UUID, allowNull: false },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  tipo: {
    type: DataTypes.ENUM('ingreso', 'egreso', 'comision'),
    allowNull: false,
  },
  descripcion: { type: DataTypes.STRING(255) },
  conciliado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'movimientos_bancarios',
});

module.exports = MovimientoBancario;
