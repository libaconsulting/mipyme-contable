const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Kardex simplificado: cada entrada, salida o ajuste queda registrado
// aquí, y el saldo/costo promedio vive en Producto.
const MovimientoInventario = sequelize.define('MovimientoInventario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  productoId: { type: DataTypes.UUID, allowNull: false },
  tipo: {
    type: DataTypes.ENUM('entrada', 'salida', 'ajuste'),
    allowNull: false,
  },
  cantidad: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  costoUnitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  documentoOrigen: { type: DataTypes.STRING(100) },
  observacion: { type: DataTypes.TEXT },
}, {
  tableName: 'movimientos_inventario',
});

module.exports = MovimientoInventario;
