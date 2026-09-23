const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Documento soporte por compras a proveedores NO obligados a facturar
// electrónicamente. A diferencia de FacturaCompra, aquí el flujo se
// invierte: el comprador (nuestro cliente) es quien debe GENERAR y
// emitir este documento ante la DIAN, igual que con una factura de
// venta — por eso lleva los mismos campos de integración.
const DocumentoSoporteAdquisicion = sequelize.define('DocumentoSoporteAdquisicion', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor no obligado
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  concepto: { type: DataTypes.STRING(255), allowNull: false },
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  proveedorTecnologicoId: { type: DataTypes.UUID },
  idTransaccionExterna: { type: DataTypes.STRING(100) },
  cufe: { type: DataTypes.STRING(100) },
  estadoSincronizacion: {
    type: DataTypes.ENUM('pendiente', 'enviado', 'aceptado', 'rechazado'),
    defaultValue: 'pendiente',
  },
  xmlUrl: { type: DataTypes.STRING(255) },
}, {
  tableName: 'documentos_soporte_adquisicion',
});

module.exports = DocumentoSoporteAdquisicion;
