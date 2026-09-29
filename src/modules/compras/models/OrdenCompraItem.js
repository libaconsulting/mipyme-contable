const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Mismo patrón que CotizacionItem — un renglón de una orden de
// adquisición (compra de bienes o servicios), con tipoImpuesto para
// distinguir IVA de Impoconsumo.
const OrdenCompraItem = sequelize.define('OrdenCompraItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  ordenCompraId: { type: DataTypes.UUID, allowNull: false },
  concepto: { type: DataTypes.STRING(255), allowNull: false },
  cantidad: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  unidadMedida: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UND' },
  valorUnitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  tipoImpuesto: {
    type: DataTypes.ENUM('iva', 'impoconsumo', 'exento'),
    allowNull: false,
    defaultValue: 'iva',
  },
  impuestoPorcentaje: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 19 },
  valorTotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  impuestoValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'orden_compra_items',
});

module.exports = OrdenCompraItem;
