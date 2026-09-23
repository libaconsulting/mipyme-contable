const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Trazabilidad de acciones sensibles: quién hizo qué, cuándo, y con qué
// justificación cuando aplica (ej. reapertura de periodo). Un registro
// de auditoría nunca se edita ni se borra — por eso updatedAt está
// desactivado más abajo.
const LogAuditoria = sequelize.define('LogAuditoria', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  usuarioId: { type: DataTypes.UUID, allowNull: false },
  accion: { type: DataTypes.STRING(100), allowNull: false }, // ej: 'reapertura_periodo'
  entidad: { type: DataTypes.STRING(50) },
  entidadId: { type: DataTypes.UUID },
  detalle: { type: DataTypes.TEXT },
}, {
  tableName: 'logs_auditoria',
  updatedAt: false,
});

module.exports = LogAuditoria;
