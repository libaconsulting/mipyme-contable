const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Roles del sistema:
//  - dueño:     dueño del negocio. Puede certificar el cierre.
//  - contador:  control total, incluida la reapertura de periodos
//               certificados (la única acción reservada solo a él).
//  - auxiliar:  registra operaciones del día a día (ventas, compras,
//               nómina). No puede certificar ni reabrir periodos.
//  - revisor:   solo lectura. Pensado para revisor fiscal u otro
//               tercero de consulta.
const Usuario = sequelize.define('Usuario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  email: { type: DataTypes.STRING(150), allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING(255), allowNull: false },
  rol: {
    type: DataTypes.ENUM('dueño', 'contador', 'auxiliar', 'revisor'),
    allowNull: false,
    defaultValue: 'auxiliar',
  },
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'usuarios',
});

module.exports = Usuario;
