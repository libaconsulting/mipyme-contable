const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Catálogo de productos. El saldo (cantidad y valor) vive aquí y se actualiza con cada
// movimiento del kardex; `costoPromedio` es solo valor / cantidad (derivado, 4 decimales).
// `valorInventario` es el dato que cuadra con la contabilidad: nulo en los productos
// creados antes del módulo completo (ahí se toma cantidad × costo promedio).
const Producto = sequelize.define('Producto', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  codigo: { type: DataTypes.STRING(50) },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  categoria: { type: DataTypes.STRING(60) },
  tipo: {
    type: DataTypes.ENUM('bien', 'servicio'),
    allowNull: false,
    defaultValue: 'bien',
  },
  unidadMedida: { type: DataTypes.STRING(20), defaultValue: 'unidad' },
  cantidadDisponible: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
  valorInventario: { type: DataTypes.DECIMAL(18, 2) },
  costoPromedio: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
  // Costo unitario de la última compra: con él se valora una venta que no alcanza las existencias.
  ultimoCosto: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
  cantidadMinima: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
  // Cuentas con que se contabiliza este producto (por defecto 1435 y 6135).
  cuentaInventario: { type: DataTypes.STRING(10), allowNull: false, defaultValue: '1435' },
  cuentaCosto: { type: DataTypes.STRING(10), allowNull: false, defaultValue: '6135' },
  // Cómo viene en las facturas (ver costeoInventario.clavesAlias): se aprende al enlazar a mano.
  alias: { type: DataTypes.JSON },
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  origen: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' }, // 'manual' | 'factura_compra'
}, {
  tableName: 'productos',
  indexes: [{ fields: ['empresa_id', 'codigo'] }],
});

module.exports = Producto;
