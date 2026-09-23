const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// El renglón de nómina de UN empleado dentro de un periodo. Igual que
// FacturaVenta, nosotros EMITIMOS el documento soporte de nómina ante
// el proveedor tecnológico — por eso lleva los mismos campos de
// integración (estadoSincronizacion, cufe, xmlUrl).
const NominaEmpleado = sequelize.define('NominaEmpleado', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  periodoNominaId: { type: DataTypes.UUID, allowNull: false },
  empleadoId: { type: DataTypes.UUID, allowNull: false }, // Tercero con tipo='empleado'
  devengado: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  deducciones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  netoPagar: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  proveedorTecnologicoId: { type: DataTypes.UUID },
  idTransaccionExterna: { type: DataTypes.STRING(100) },
  cufe: { type: DataTypes.STRING(100) },
  estadoSincronizacion: {
    type: DataTypes.ENUM('pendiente', 'enviado', 'aceptado', 'rechazado'),
    defaultValue: 'pendiente',
  },
  xmlUrl: { type: DataTypes.STRING(255) },
}, {
  tableName: 'nomina_empleados',
});

module.exports = NominaEmpleado;
