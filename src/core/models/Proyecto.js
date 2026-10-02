const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Un Proyecto es un contrato, negocio o proyecto de la empresa —
// doble función: (1) se referencia desde Órdenes de Adquisición para
// saber a qué pertenece una compra, y (2) está pensado para servir
// como centro de costo en la parte contable (Movimiento.centroCosto
// hoy es solo texto libre; cuando se conecte de verdad con este
// catálogo, cada asiento podrá segmentarse por proyecto).
const Proyecto = sequelize.define('Proyecto', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  nombre: { type: DataTypes.STRING(200), allowNull: false },
  codigo: { type: DataTypes.STRING(50) },
  descripcion: { type: DataTypes.TEXT },
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'proyectos',
});

module.exports = Proyecto;
