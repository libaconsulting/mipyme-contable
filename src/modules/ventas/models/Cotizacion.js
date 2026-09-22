const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Ciclo de vida: borrador -> enviada -> (aceptada | rechazada | expirada)
// -> facturada. No genera asiento contable en ningún estado.
const Cotizacion = sequelize.define('Cotizacion', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false },
  vendedorId: { type: DataTypes.UUID },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  fechaVencimiento: { type: DataTypes.DATEONLY, allowNull: false },
  estado: {
    type: DataTypes.ENUM('borrador', 'enviada', 'aceptada', 'rechazada', 'expirada', 'facturada'),
    allowNull: false,
    defaultValue: 'borrador',
  },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
}, {
  tableName: 'cotizaciones',
});

module.exports = Cotizacion;
