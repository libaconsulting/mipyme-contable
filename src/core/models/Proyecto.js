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
  // ID del proyecto / centro de costo — el código corto que lo
  // identifica internamente (ej. "CO-2026-109-CP", "DACP-224-2026").
  codigo: { type: DataTypes.STRING(50) },
  // Objeto del proyecto — qué es, en términos contractuales (el mismo
  // lenguaje que usan las órdenes y cotizaciones reales de la firma).
  objeto: { type: DataTypes.TEXT },
  // Quién contrata/financia el proyecto — un Tercero (normalmente tipo
  // "cliente", pero no se restringe: igual que en cotizaciones/órdenes,
  // cualquier tercero puede ser contratante).
  contratanteId: { type: DataTypes.UUID },
  valorTotal: { type: DataTypes.DECIMAL(15, 2) },
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'proyectos',
});

module.exports = Proyecto;
