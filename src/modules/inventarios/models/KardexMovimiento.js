const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Kardex: una fila por cada entrada o salida de un producto, con el saldo que dejó.
// Los movimientos no se editan: un error se corrige con otro movimiento, o (si es el
// último del producto y fue manual) se anula y el saldo vuelve al de la fila anterior.
const KardexMovimiento = sequelize.define('KardexMovimiento', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  productoId: { type: DataTypes.UUID, allowNull: false },
  // Orden del movimiento dentro del producto (se asigna al registrar).
  secuencia: { type: DataTypes.INTEGER, allowNull: false },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  tipo: { type: DataTypes.STRING(10), allowNull: false }, // 'entrada' | 'salida'
  concepto: { type: DataTypes.STRING(30), allowNull: false }, // compra, venta, consumo, faltante, saldo_inicial…
  cantidad: { type: DataTypes.DECIMAL(18, 4), allowNull: false }, // siempre positiva
  valor: { type: DataTypes.DECIMAL(18, 2), allowNull: false }, // siempre positivo
  costoUnitario: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
  // Saldo del producto DESPUÉS de este movimiento.
  saldoCantidad: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
  saldoValor: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  saldoCosto: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
  origenTipo: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' }, // manual | factura_compra | factura_venta
  origenId: { type: DataTypes.UUID },
  documento: { type: DataTypes.STRING(60) }, // número visible de la factura u otro soporte
  terceroId: { type: DataTypes.UUID },
  asientoId: { type: DataTypes.UUID },
  contrapartida: { type: DataTypes.STRING(10) },
  observacion: { type: DataTypes.STRING(250) },
  sinExistencias: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  anulado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  motivoAnulacion: { type: DataTypes.STRING(250) },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'inventario_kardex',
  indexes: [{ fields: ['empresa_id', 'producto_id', 'secuencia'] }, { fields: ['empresa_id', 'fecha'] }],
});

module.exports = KardexMovimiento;
