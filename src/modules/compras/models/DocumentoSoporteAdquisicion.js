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

  // --- Documento soporte expedido en otro sistema (Siigo) y registrado aquí ---
  // Siigo solo entrega el PDF (sin XML), así que los datos se digitan y el PDF
  // se guarda como soporte. 'emitido' = el flujo con proveedor tecnológico propio.
  origen: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'emitido' }, // 'emitido' | 'registrado'
  numero: { type: DataTypes.STRING(40) }, // ej. "DS 44"
  proveedorNit: { type: DataTypes.STRING(20) },
  proveedorNombre: { type: DataTypes.STRING(200) },
  formaPago: { type: DataTypes.STRING(20) }, // 'contado' | 'credito'
  fechaVencimiento: { type: DataTypes.DATEONLY },
  // Retención en la fuente que practicamos (foto al registrar), igual que en FacturaCompra.
  retencionModo: { type: DataTypes.STRING(20) },
  retencionMotivo: { type: DataTypes.STRING(200) },
  retenciones: { type: DataTypes.JSON },
  retencionValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  netoAPagar: { type: DataTypes.DECIMAL(15, 2) },
  detalle: { type: DataTypes.JSON },
  observaciones: { type: DataTypes.TEXT },
  asientoId: { type: DataTypes.UUID },
  proyectoId: { type: DataTypes.UUID },
  archivoNombre: { type: DataTypes.STRING(150) },
  archivoPdf: { type: DataTypes.TEXT('long') }, // PDF original en base64
}, {
  tableName: 'documentos_soporte_adquisicion',
  indexes: [{ fields: ['empresa_id', 'numero'] }],
});

module.exports = DocumentoSoporteAdquisicion;
