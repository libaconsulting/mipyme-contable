const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Facturas RECIBIDAS de proveedores que sí facturan electrónicamente.
// A diferencia de FacturaVenta (que nosotros emitimos), esta llega desde
// afuera — vía RADIAN o el proveedor tecnológico — ya validada ante la
// DIAN por quien la emitió. Ver src/integrations/webhooks para el
// detalle de cómo llega.
const FacturaCompra = sequelize.define('FacturaCompra', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor
  ordenCompraOrigenId: { type: DataTypes.UUID }, // nulo si no hubo orden previa
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  cufe: { type: DataTypes.STRING(100) },
  xmlUrl: { type: DataTypes.STRING(255) },

  // --- Factura cargada desde el XML del proveedor ---
  // Número impreso de la factura (prefijo + consecutivo, ej. "SETP990000123").
  numero: { type: DataTypes.STRING(40) },
  fechaVencimiento: { type: DataTypes.DATEONLY },
  formaPago: { type: DataTypes.STRING(20) }, // 'contado' | 'credito'
  // Impoconsumo y demás impuestos que no son IVA: mayor valor del gasto.
  impoconsumo: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Retención practicada por nosotros (foto al momento de registrar).
  retencionModo: { type: DataTypes.STRING(20) }, // 'aplica' | 'no_aplica'
  retencionMotivo: { type: DataTypes.STRING(200) },
  retenciones: { type: DataTypes.JSON },
  retencionValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Lo que realmente se le paga al proveedor: total - retenciones.
  netoAPagar: { type: DataTypes.DECIMAL(15, 2) },
  // Datos del emisor tal como venían en el XML (el tercero puede cambiar después).
  emisorNit: { type: DataTypes.STRING(20) },
  emisorNombre: { type: DataTypes.STRING(200) },
  // Desglose de la factura (líneas + cuenta a la que se llevó cada una).
  detalle: { type: DataTypes.JSON },
  asientoId: { type: DataTypes.UUID },
  proyectoId: { type: DataTypes.UUID },
  // El XML original queda guardado como soporte de la compra.
  xmlContenido: { type: DataTypes.TEXT('long') },
  estadoConciliacion: {
    type: DataTypes.ENUM('pendiente', 'contabilizada', 'objetada'),
    defaultValue: 'pendiente',
  },
}, {
  tableName: 'facturas_compra',
  indexes: [{ fields: ['empresa_id', 'cufe'] }],
});

module.exports = FacturaCompra;
