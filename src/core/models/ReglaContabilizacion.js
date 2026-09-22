const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// El corazón del motor: traduce un evento operativo en partida doble
// sin lógica fija en el código. Ver src/core/services/motorAsientos.js
const ReglaContabilizacion = sequelize.define('ReglaContabilizacion', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  eventoOrigen: { type: DataTypes.STRING(50), allowNull: false }, // ej: 'factura_venta_credito'
  condicion: { type: DataTypes.JSON }, // filtros opcionales (ej: tipo de producto)
  cuentaDebitoId: { type: DataTypes.UUID, allowNull: false },
  cuentaCreditoId: { type: DataTypes.UUID, allowNull: false },
  nivelAutomatizacion: {
    type: DataTypes.ENUM('automatico', 'asistido', 'manual'),
    allowNull: false,
    defaultValue: 'automatico',
  },
}, {
  tableName: 'reglas_contabilizacion',
});

module.exports = ReglaContabilizacion;
