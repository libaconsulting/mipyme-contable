const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

const Asiento = sequelize.define('Asiento', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  periodoContableId: { type: DataTypes.UUID, allowNull: false },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  // origenModulo identifica quién generó el asiento: 'ventas', 'compras',
  // 'nomina', 'activos_fijos', 'tesoreria', o 'cierre_periodo' para el
  // asiento automático que traslada las cuentas nominales al cierre.
  origenModulo: { type: DataTypes.STRING(30), allowNull: false },
  origenId: { type: DataTypes.UUID }, // id del documento que originó el asiento
  estado: {
    type: DataTypes.ENUM('borrador', 'contabilizado', 'anulado'),
    allowNull: false,
    defaultValue: 'contabilizado',
  },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'asientos',
});

module.exports = Asiento;
