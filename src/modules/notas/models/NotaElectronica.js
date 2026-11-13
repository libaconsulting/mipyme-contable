const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Notas crédito y débito electrónicas cargadas desde su XML.
//  - lado 'compra': la expide el proveedor y modifica una factura de compra (baja o sube lo que se le debe).
//  - lado 'venta':  la expidió la empresa (en Siigo u otro proveedor tecnológico) y modifica una factura de venta.
// Si se pudo vincular con su factura, el saldo de esa factura en Tesorería cambia: la nota crédito lo baja y la débito
// lo sube (por `neto`). Anular la nota anula su asiento y devuelve el saldo.
const NotaElectronica = sequelize.define('NotaElectronica', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  lado: { type: DataTypes.STRING(10), allowNull: false }, // compra | venta
  tipo: { type: DataTypes.STRING(10), allowNull: false }, // credito | debito
  numero: { type: DataTypes.STRING(40) },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  cufe: { type: DataTypes.STRING(100) }, // CUDE de la nota
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor (compra) o cliente (venta)
  terceroNit: { type: DataTypes.STRING(30) },
  terceroNombre: { type: DataTypes.STRING(200) },
  // Factura que modifica (nulo si no está registrada en el sistema o la nota no la referencia).
  docTipo: { type: DataTypes.STRING(20) }, // factura_compra | factura_venta
  docId: { type: DataTypes.UUID },
  referenciaNumero: { type: DataTypes.STRING(40) }, // lo que dice el XML
  referenciaCufe: { type: DataTypes.STRING(100) },
  concepto: { type: DataTypes.STRING(10) }, // código DIAN del motivo (si el XML lo trae)
  motivo: { type: DataTypes.STRING(300) },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  impoconsumo: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  // Retenciones (y estampillas/tasas en ventas) de la factura que esta nota crédito reversa.
  reversa: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
  reversaTotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Efecto sobre la cartera: total − reversaTotal.
  neto: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  proyectoId: { type: DataTypes.UUID },
  asientoId: { type: DataTypes.UUID },
  detalle: { type: DataTypes.JSON },
  xmlContenido: { type: DataTypes.TEXT('long') },
  estado: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'activa' }, // activa | anulada
  motivoAnulacion: { type: DataTypes.STRING(250) },
  fechaAnulacion: { type: DataTypes.DATE },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'notas_electronicas',
  indexes: [
    { fields: ['empresa_id', 'cufe'] },
    { fields: ['empresa_id', 'doc_tipo', 'doc_id'] },
    { fields: ['empresa_id', 'fecha'] },
  ],
});

module.exports = NotaElectronica;
