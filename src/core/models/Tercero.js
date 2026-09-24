const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Un solo maestro para cliente / proveedor / empleado, distinguido por "tipo".
// Evita triplicar validaciones de NIT/cédula.
const Tercero = sequelize.define('Tercero', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  tipo: {
    type: DataTypes.ENUM('cliente', 'proveedor', 'empleado', 'otro'),
    allowNull: false,
  },
  identificacion: { type: DataTypes.STRING(20), allowNull: false },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  regimenTributario: { type: DataTypes.STRING(50) },
  email: { type: DataTypes.STRING(150) },

  // Natural vs. jurídica — el formulario 350 de la DIAN (retención en la
  // fuente) trata distinto a cada uno.
  tipoPersona: {
    type: DataTypes.ENUM('natural', 'juridica'),
  },
  celular: { type: DataTypes.STRING(20) },
  direccion: { type: DataTypes.STRING(255) },
  departamento: { type: DataTypes.STRING(100) },
  municipio: { type: DataTypes.STRING(100) },

  regimenIva: {
    type: DataTypes.ENUM('responsable', 'no_responsable'),
  },
  // Códigos oficiales de responsabilidad tributaria de la DIAN (RUT).
  // Un mismo tercero puede tener más de uno a la vez (ej. O-15 y O-23
  // juntos), por eso es un arreglo, no un solo valor.
  // Valores válidos: O-13, O-15, O-23, O-47, R-99-PN
  responsabilidadesFiscales: { type: DataTypes.JSON },

  cuentaBancariaTipo: {
    type: DataTypes.ENUM('ahorros', 'corriente'),
  },
  cuentaBancariaBanco: { type: DataTypes.STRING(100) },
  cuentaBancariaNumero: { type: DataTypes.STRING(50) },
}, {
  tableName: 'terceros',
  indexes: [{ fields: ['empresa_id', 'identificacion'] }],
});

module.exports = Tercero;
