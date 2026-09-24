const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un renglón de una cotización. valorTotal e ivaValor se calculan en el
// servicio (cantidad × valorUnitario, y ese valor × ivaPorcentaje/100),
// no se confía en que el cliente los mande ya calculados.
const CotizacionItem = sequelize.define('CotizacionItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  cotizacionId: { type: DataTypes.UUID, allowNull: false },
  concepto: { type: DataTypes.STRING(255), allowNull: false },
  cantidad: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  unidadMedida: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UND' },
  valorUnitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  ivaPorcentaje: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 19 },
  valorTotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  ivaValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'cotizacion_items',
});

module.exports = CotizacionItem;
