#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  echo "Ve primero a la carpeta mipyme-contable (cd mipyme-contable) y vuelve a correr este script."
  exit 1
fi

cat > src/core/services/consecutivos.js << 'SCRIPTEOF'
const { Op } = require('sequelize');

// Genera un consecutivo legible tipo "COT-2026-0001", contando cuántos
// documentos de ese prefijo existen ya este año para la empresa.
//
// LIMITACIÓN CONOCIDA: no usa bloqueo transaccional, así que dos
// creaciones en el mismo instante podrían, en teoría, generar el mismo
// número. Para el volumen actual no es un riesgo real; si el volumen de
// documentos crece, esto debería moverse a una tabla de secuencias con
// bloqueo (SELECT ... FOR UPDATE) en vez de un conteo simple.
async function generarConsecutivo(empresaId, prefijo, Modelo) {
  const anio = new Date().getFullYear();
  const conteo = await Modelo.count({
    where: {
      empresaId,
      consecutivo: { [Op.like]: `${prefijo}-${anio}-%` },
    },
  });
  const numero = String(conteo + 1).padStart(4, '0');
  return `${prefijo}-${anio}-${numero}`;
}

module.exports = { generarConsecutivo };
SCRIPTEOF
echo "OK  src/core/services/consecutivos.js"

cat > src/modules/ventas/models/CotizacionItem.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un renglón de una cotización. valorTotal e ivaValor se calculan en el
// servicio (cantidad × valorUnitario, y ese valor × ivaPorcentaje/100),
// no se confía en que el cliente los mande ya calculados.
const CotizacionItem = sequelize.define('CotizacionItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  cotizacionId: { type: DataTypes.UUID, allowNull: false },
  concepto: { type: DataTypes.STRING(255), allowNull: false },
  cantidad: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  unidadMedida: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UND' },
  valorUnitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  ivaPorcentaje: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 19 },
  valorTotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  ivaValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'cotizacion_items',
});

module.exports = CotizacionItem;
SCRIPTEOF
echo "OK  src/modules/ventas/models/CotizacionItem.js"

cat > src/modules/compras/models/OrdenCompraItem.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Mismo patrón que CotizacionItem — un renglón de una orden de
// adquisición (compra de bienes o servicios).
const OrdenCompraItem = sequelize.define('OrdenCompraItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  ordenCompraId: { type: DataTypes.UUID, allowNull: false },
  concepto: { type: DataTypes.STRING(255), allowNull: false },
  cantidad: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  unidadMedida: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'UND' },
  valorUnitario: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  ivaPorcentaje: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 19 },
  valorTotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  ivaValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'orden_compra_items',
});

module.exports = OrdenCompraItem;
SCRIPTEOF
echo "OK  src/modules/compras/models/OrdenCompraItem.js"

cat > src/core/models/Tercero.js << 'SCRIPTEOF'
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
SCRIPTEOF
echo "OK  src/core/models/Tercero.js"

cat > src/modules/ventas/models/Cotizacion.js << 'SCRIPTEOF'
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
  consecutivo: { type: DataTypes.STRING(30), unique: true },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  formaPago: { type: DataTypes.TEXT },
  observaciones: { type: DataTypes.TEXT },
  contactoNombre: { type: DataTypes.STRING(150) },
  contactoTelefono: { type: DataTypes.STRING(30) },
  // AIU: Administración, Imprevistos, Utilidad — habitual en contratos
  // de obra/servicios. Porcentajes sobre el subtotal; ver la nota de
  // cálculo en ventas.service.js (crearCotizacion).
  aplicaAiu: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  aiuAdministracion: { type: DataTypes.DECIMAL(5, 2) },
  aiuImprevistos: { type: DataTypes.DECIMAL(5, 2) },
  aiuUtilidad: { type: DataTypes.DECIMAL(5, 2) },
}, {
  tableName: 'cotizaciones',
});

module.exports = Cotizacion;
SCRIPTEOF
echo "OK  src/modules/ventas/models/Cotizacion.js"

cat > src/modules/compras/models/OrdenCompra.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Unifica orden de compra (bienes) y orden de servicio en una sola
// entidad, distinguida por "tipo" — comparten ciclo de vida y campos de
// cabecera; lo único que cambia es la plantilla de impresión y que en
// servicios el renglón suele llevar descripción libre en vez de producto_id.
//
// Ciclo de vida: borrador -> emitida -> aprobada -> recibida_parcial |
// recibida_total -> facturada, o rechazada / anulada en cualquier punto
// antes de facturada. No genera asiento contable en ningún estado.
const OrdenCompra = sequelize.define('OrdenCompra', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor
  tipo: {
    type: DataTypes.ENUM('bienes', 'servicios'),
    allowNull: false,
    defaultValue: 'bienes',
  },
  aprobadorId: { type: DataTypes.UUID },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  fechaRequerida: { type: DataTypes.DATEONLY }, // fecha de cumplimiento
  estado: {
    type: DataTypes.ENUM(
      'borrador',
      'emitida',
      'aprobada',
      'recibida_parcial',
      'recibida_total',
      'facturada',
      'rechazada',
      'anulada'
    ),
    allowNull: false,
    defaultValue: 'borrador',
  },
  consecutivo: { type: DataTypes.STRING(30), unique: true },
  // Proyecto o unidad de negocio al que pertenece — es, en la práctica,
  // el mismo concepto que centro de costo (todavía pendiente como
  // catálogo propio, ver README).
  proyecto: { type: DataTypes.STRING(150) },
  lugarEntrega: { type: DataTypes.STRING(255) },
  formaPago: { type: DataTypes.TEXT },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
}, {
  tableName: 'ordenes_compra',
});

module.exports = OrdenCompra;
SCRIPTEOF
echo "OK  src/modules/compras/models/OrdenCompra.js"

cat > src/modules/ventas/services/ventas.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const Cotizacion = require('../models/Cotizacion');
const CotizacionItem = require('../models/CotizacionItem');
const FacturaVenta = require('../models/FacturaVenta');
const facturacionAdapter = require('../../../integrations/adapters/facturacionAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { generarConsecutivo } = require('../../../core/services/consecutivos');

// Crea una cotización nueva en estado "borrador". Si vienen "items"
// (arreglo de { concepto, cantidad, unidadMedida, valorUnitario,
// ivaPorcentaje }), se crean como CotizacionItem y el subtotal/IVA/total
// se calculan solos — no se confía en un total mandado a mano.
// Si no vienen items (el formulario todavía no los arma), se respeta el
// "total" que mande el cliente, por compatibilidad hacia atrás.
async function crearCotizacion(datos, usuario) {
  const consecutivo = await generarConsecutivo(usuario.empresaId, 'COT', Cotizacion);

  const cotizacion = await Cotizacion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    vendedorId: usuario.id,
    consecutivo,
    fecha: datos.fecha || new Date(),
    fechaVencimiento: datos.fechaVencimiento,
    formaPago: datos.formaPago,
    observaciones: datos.observaciones,
    contactoNombre: datos.contactoNombre,
    contactoTelefono: datos.contactoTelefono,
    aplicaAiu: !!datos.aplicaAiu,
    aiuAdministracion: datos.aiuAdministracion,
    aiuImprevistos: datos.aiuImprevistos,
    aiuUtilidad: datos.aiuUtilidad,
    estado: 'borrador',
    subtotal: 0,
    iva: 0,
    total: datos.total || 0,
  });

  if (Array.isArray(datos.items) && datos.items.length > 0) {
    let subtotal = 0;

    for (const item of datos.items) {
      const cantidad = Number(item.cantidad);
      const valorUnitario = Number(item.valorUnitario);
      const ivaPorcentaje = item.ivaPorcentaje ?? 19;
      const valorTotal = cantidad * valorUnitario;
      const ivaValor = valorTotal * (ivaPorcentaje / 100);

      await CotizacionItem.create({
        id: uuidv4(),
        cotizacionId: cotizacion.id,
        concepto: item.concepto,
        cantidad,
        unidadMedida: item.unidadMedida || 'UND',
        valorUnitario,
        ivaPorcentaje,
        valorTotal,
        ivaValor,
      });

      subtotal += valorTotal;
    }

    // Si aplica AIU, el IVA se recalcula sobre (subtotal + AIU), no
    // sobre la suma de IVA por ítem — es la convención más común en
    // contratos de obra/servicios en Colombia. Validar contra el tipo
    // de contrato específico antes de confiar en esto a ciegas.
    let baseIva = subtotal;
    if (cotizacion.aplicaAiu) {
      const admin = subtotal * (Number(datos.aiuAdministracion || 0) / 100);
      const imprevistos = subtotal * (Number(datos.aiuImprevistos || 0) / 100);
      const utilidad = subtotal * (Number(datos.aiuUtilidad || 0) / 100);
      baseIva = subtotal + admin + imprevistos + utilidad;
    }
    const iva = baseIva * 0.19;
    const total = baseIva + iva;

    await cotizacion.update({ subtotal, iva, total });
  }

  return cotizacion;
}

// borrador -> enviada
async function enviarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'borrador') {
    throw new Error('Solo se puede enviar una cotización en estado "borrador".');
  }
  await cotizacion.update({ estado: 'enviada' });
  return cotizacion;
}

// enviada -> aceptada
async function aceptarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'enviada') {
    throw new Error('Solo se puede aceptar una cotización en estado "enviada".');
  }
  await cotizacion.update({ estado: 'aceptada' });
  return cotizacion;
}

// enviada -> rechazada
async function rechazarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'enviada') {
    throw new Error('Solo se puede rechazar una cotización en estado "enviada".');
  }
  await cotizacion.update({ estado: 'rechazada' });
  return cotizacion;
}

async function listarCotizaciones(usuario) {
  return Cotizacion.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

async function listarFacturas(usuario) {
  return FacturaVenta.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Copia los renglones de la cotización aceptada a una factura nueva,
// deja el vínculo de trazabilidad y marca la cotización como facturada.
async function convertirCotizacionEnFactura(cotizacionId, usuarioId) {
  const cotizacion = await Cotizacion.findByPk(cotizacionId);

  if (cotizacion.estado !== 'aceptada') {
    throw new Error('Solo se puede facturar una cotización en estado "aceptada".');
  }

  const factura = await FacturaVenta.create({
    id: uuidv4(),
    empresaId: cotizacion.empresaId,
    terceroId: cotizacion.terceroId,
    cotizacionOrigenId: cotizacion.id,
    fecha: new Date(),
    subtotal: cotizacion.total, // TODO: recalcular desde los ítems reales
    total: cotizacion.total,
    estadoSincronizacion: 'pendiente',
  });

  // TODO: copiar CotizacionItem -> FacturaVentaItem

  await cotizacion.update({ estado: 'facturada' });

  await emitirFacturaAnteProveedor(factura);

  return factura;
}

// Envía la factura al proveedor tecnológico acreditado; el motor de
// asientos solo se dispara cuando llega la confirmación (ver webhook).
async function emitirFacturaAnteProveedor(factura) {
  const respuesta = await facturacionAdapter.emitirFactura(factura);
  await factura.update({
    idTransaccionExterna: respuesta.idTransaccionExterna,
    estadoSincronizacion: 'enviado',
  });
  return respuesta;
}

// Llamado desde el webhook cuando el proveedor confirma "aceptada".
async function confirmarFacturaAceptada(facturaId, datosProveedor) {
  const factura = await FacturaVenta.findByPk(facturaId);

  await factura.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
    pdfUrl: datosProveedor.pdfUrl,
  });

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: 'factura_venta_credito', // o 'factura_venta_contado' según forma de pago
    origenModulo: 'ventas',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
  });

  return factura;
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  listarCotizaciones,
  listarFacturas,
  convertirCotizacionEnFactura,
  confirmarFacturaAceptada,
};
SCRIPTEOF
echo "OK  src/modules/ventas/services/ventas.service.js"

cat > src/modules/compras/services/compras.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const OrdenCompra = require('../models/OrdenCompra');
const OrdenCompraItem = require('../models/OrdenCompraItem');
const FacturaCompra = require('../models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const documentoSoporteAdapter = require('../../../integrations/adapters/documentoSoporteAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { generarConsecutivo } = require('../../../core/services/consecutivos');

// Crea una orden de adquisición (bienes o servicios) en "borrador". Si
// vienen "items", se crean como OrdenCompraItem y subtotal/IVA/total se
// calculan solos. Sin items, respeta el subtotal/iva/total a mano por
// compatibilidad con el formulario actual.
async function crearOrden(datos, usuario) {
  const consecutivo = await generarConsecutivo(usuario.empresaId, 'ODA', OrdenCompra);

  const orden = await OrdenCompra.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    tipo: datos.tipo || 'bienes',
    consecutivo,
    fecha: datos.fecha || new Date(),
    fechaRequerida: datos.fechaRequerida,
    proyecto: datos.proyecto,
    lugarEntrega: datos.lugarEntrega,
    formaPago: datos.formaPago,
    estado: 'borrador',
    subtotal: datos.subtotal || 0,
    iva: datos.iva || 0,
    total: datos.total || 0,
  });

  if (Array.isArray(datos.items) && datos.items.length > 0) {
    let subtotal = 0;
    let iva = 0;

    for (const item of datos.items) {
      const cantidad = Number(item.cantidad);
      const valorUnitario = Number(item.valorUnitario);
      const ivaPorcentaje = item.ivaPorcentaje ?? 19;
      const valorTotal = cantidad * valorUnitario;
      const ivaValor = valorTotal * (ivaPorcentaje / 100);

      await OrdenCompraItem.create({
        id: uuidv4(),
        ordenCompraId: orden.id,
        concepto: item.concepto,
        cantidad,
        unidadMedida: item.unidadMedida || 'UND',
        valorUnitario,
        ivaPorcentaje,
        valorTotal,
        ivaValor,
      });

      subtotal += valorTotal;
      iva += ivaValor;
    }

    await orden.update({ subtotal, iva, total: subtotal + iva });
  }

  return orden;
}

// borrador/emitida -> aprobada (aprobador interno, no el proveedor)
async function aprobarOrden(id, usuario) {
  const orden = await OrdenCompra.findByPk(id);
  if (!['borrador', 'emitida'].includes(orden.estado)) {
    throw new Error('Solo se puede aprobar una orden en estado "borrador" o "emitida".');
  }
  await orden.update({ estado: 'aprobada', aprobadorId: usuario.id });
  return orden;
}

async function listarOrdenes(usuario) {
  return OrdenCompra.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

async function listarFacturas(usuario) {
  return FacturaCompra.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Cierra manualmente una orden aprobada/recibida contra una factura que
// el usuario ya tiene en mano. Con orden de compra de por medio, el
// nivel de automatización es más alto (ver tabla de reglas del módulo).
async function convertirOrdenEnFactura(ordenId, usuario) {
  const orden = await OrdenCompra.findByPk(ordenId);

  if (!['aprobada', 'recibida_parcial', 'recibida_total'].includes(orden.estado)) {
    throw new Error('La orden debe estar aprobada o recibida para facturarse.');
  }

  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: orden.empresaId,
    terceroId: orden.terceroId,
    ordenCompraOrigenId: orden.id,
    fecha: new Date(),
    subtotal: orden.subtotal,
    iva: orden.iva,
    total: orden.total,
  });

  await orden.update({ estado: 'facturada' });

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: 'factura_compra_con_orden',
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
    usuarioId: usuario?.id,
  });

  return factura;
}

// Llamado desde el webhook cuando un proveedor que sí factura
// electrónicamente emite una factura a nuestro nombre y llega vía
// RADIAN o el proveedor tecnológico. Ya viene validada ante la DIAN,
// así que se contabiliza directo (sin pasar por estado "borrador").
//
// TODO: la mecánica exacta para RECIBIR facturas vía RADIAN (o si el
// proveedor tecnológico contratado lo resuelve por su cuenta y solo nos
// avisa por webhook) todavía hay que investigarla con el proveedor
// específico que se contrate — no está 100% definida.
async function registrarFacturaRecibida(datos) {
  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: datos.empresaId,
    terceroId: datos.terceroId,
    ordenCompraOrigenId: datos.ordenCompraOrigenId || null,
    fecha: datos.fecha || new Date(),
    subtotal: datos.subtotal,
    iva: datos.iva || 0,
    total: datos.total,
    cufe: datos.cufe,
    xmlUrl: datos.xmlUrl,
    estadoConciliacion: 'contabilizada',
  });

  // Sin orden de compra de por medio, nivel de automatización más bajo
  // (nivel 2: exige clasificar costo vs. gasto — ver tabla de reglas).
  const evento = factura.ordenCompraOrigenId
    ? 'factura_compra_con_orden'
    : 'factura_compra_sin_orden';

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: evento,
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
  });

  return factura;
}

// El documento soporte lo EMITE el propio comprador (nuestro cliente),
// porque el proveedor no está obligado a facturar. Flujo simétrico al
// de ventas: se envía al proveedor tecnológico y solo se contabiliza
// cuando confirma (ver confirmarDocumentoSoporteEmitido).
async function emitirDocumentoSoporte(datos, usuario) {
  const documento = await DocumentoSoporteAdquisicion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    fecha: datos.fecha || new Date(),
    concepto: datos.concepto,
    valor: datos.valor,
    estadoSincronizacion: 'pendiente',
  });

  const respuesta = await documentoSoporteAdapter.emitirDocumentoSoporte(documento);

  await documento.update({
    idTransaccionExterna: respuesta.idTransaccionExterna,
    estadoSincronizacion: 'enviado',
  });

  return documento;
}

// Llamado desde el webhook cuando el proveedor tecnológico confirma que
// la DIAN validó nuestro documento soporte.
async function confirmarDocumentoSoporteEmitido(documentoId, datosProveedor) {
  const documento = await DocumentoSoporteAdquisicion.findByPk(documentoId);

  await documento.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
  });

  // La primera vez por proveedor exige clasificar la cuenta (nivel 2);
  // ver la regla 'documento_soporte_compra' y su memorización por tercero.
  await contabilizarEvento({
    empresaId: documento.empresaId,
    tipoEvento: 'documento_soporte_compra',
    origenModulo: 'compras',
    origenId: documento.id,
    valor: documento.valor,
    terceroId: documento.terceroId,
  });

  return documento;
}

module.exports = {
  crearOrden,
  aprobarOrden,
  listarOrdenes,
  listarFacturas,
  convertirOrdenEnFactura,
  registrarFacturaRecibida,
  emitirDocumentoSoporte,
  confirmarDocumentoSoporteEmitido,
};
SCRIPTEOF
echo "OK  src/modules/compras/services/compras.service.js"

cat > src/core/models/index.js << 'SCRIPTEOF'
// Punto único donde se registran TODOS los modelos del núcleo contable.
// server.js importa este archivo antes de sincronizar la base de datos,
// así que ningún modelo se queda afuera por no estar "require"ado en
// alguna cadena de rutas activa. A medida que agreguemos modelos a los
// módulos operativos (compras, nómina, etc.), se suman aquí también.

const Empresa = require('./Empresa');
const Tercero = require('./Tercero');
const PlanCuentas = require('./PlanCuentas');
const Asiento = require('./Asiento');
const Movimiento = require('./Movimiento');
const PeriodoContable = require('./PeriodoContable');
const ReglaContabilizacion = require('./ReglaContabilizacion');
const ParametroTributario = require('./ParametroTributario');
const Usuario = require('./Usuario');
const LogAuditoria = require('./LogAuditoria');

// Modelos de módulos operativos ya construidos
const FacturaVenta = require('../../modules/ventas/models/FacturaVenta');
const Cotizacion = require('../../modules/ventas/models/Cotizacion');
const CotizacionItem = require('../../modules/ventas/models/CotizacionItem');
const OrdenCompra = require('../../modules/compras/models/OrdenCompra');
const OrdenCompraItem = require('../../modules/compras/models/OrdenCompraItem');
const FacturaCompra = require('../../modules/compras/models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../../modules/compras/models/DocumentoSoporteAdquisicion');
const PeriodoNomina = require('../../modules/nomina/models/PeriodoNomina');
const NominaEmpleado = require('../../modules/nomina/models/NominaEmpleado');
const NovedadNomina = require('../../modules/nomina/models/NovedadNomina');
const Producto = require('../../modules/inventarios/models/Producto');
const MovimientoInventario = require('../../modules/inventarios/models/MovimientoInventario');
const ActivoFijo = require('../../modules/activosFijos/models/ActivoFijo');
const CuentaBancaria = require('../../modules/tesoreria/models/CuentaBancaria');
const MovimientoBancario = require('../../modules/tesoreria/models/MovimientoBancario');

module.exports = {
  Empresa,
  Tercero,
  PlanCuentas,
  Asiento,
  Movimiento,
  PeriodoContable,
  ReglaContabilizacion,
  ParametroTributario,
  Usuario,
  LogAuditoria,
  FacturaVenta,
  Cotizacion,
  CotizacionItem,
  OrdenCompra,
  OrdenCompraItem,
  FacturaCompra,
  DocumentoSoporteAdquisicion,
  PeriodoNomina,
  NominaEmpleado,
  NovedadNomina,
  Producto,
  MovimientoInventario,
  ActivoFijo,
  CuentaBancaria,
  MovimientoBancario,
};
SCRIPTEOF
echo "OK  src/core/models/index.js"

cat > public/contable/index.html << 'SCRIPTEOF'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mipyme Contable</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/contable/style.css">
</head>
<body>

<div id="vista-login" class="pantalla-login">
  <div class="tarjeta-login">
    <h1 class="wordmark">Mipyme Contable</h1>
    <p class="subtitulo">Sistema contable para microempresas — NIIF Grupo 3</p>
    <form id="form-login">
      <label>Correo
        <input type="email" id="login-email" required autocomplete="username">
      </label>
      <label>Contraseña
        <input type="password" id="login-password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn-primario">Entrar</button>
      <p id="login-error" class="mensaje-error" hidden></p>
    </form>
  </div>
</div>

<div id="vista-dashboard" class="app" hidden>
  <aside class="barra-lateral">
    <h1 class="wordmark">Mipyme Contable</h1>
    <nav>
      <button class="nav-item activo" data-tab="terceros">Terceros</button>
      <button class="nav-item" data-tab="cotizaciones">Cotizaciones</button>
      <button class="nav-item" data-tab="facturas-venta">Facturas de venta</button>
      <button class="nav-item" data-tab="ordenes">Órdenes de adquisición</button>
      <button class="nav-item" data-tab="facturas-compra">Facturas de compra</button>
      <button class="nav-item" data-tab="nomina">Nómina</button>
      <button class="nav-item" data-tab="inventarios">Inventarios</button>
      <button class="nav-item" data-tab="activos-fijos">Activos fijos</button>
      <button class="nav-item" data-tab="tesoreria">Tesorería</button>
    </nav>
    <div class="usuario-actual">
      <p id="usuario-nombre"></p>
      <p id="usuario-rol" class="rol"></p>
      <button id="btn-salir">Cerrar sesión</button>
      <a href="/" class="enlace-sitio">← libanielconsulting.com</a>
    </div>
  </aside>

  <main class="contenido">
    <section id="panel-terceros" class="panel">
      <header class="panel-header">
        <h2>Terceros</h2>
        <button class="btn-primario" id="btn-nuevo-tercero">+ Nuevo tercero</button>
      </header>
      <form id="form-tercero" class="form-inline" hidden>
        <select id="tercero-tipo" required>
          <option value="cliente">Cliente</option>
          <option value="proveedor">Proveedor</option>
          <option value="empleado">Empleado</option>
          <option value="otro">Otro</option>
        </select>
        <select id="tercero-tipo-persona">
          <option value="">Tipo de persona...</option>
          <option value="natural">Natural</option>
          <option value="juridica">Jurídica</option>
        </select>
        <input type="text" id="tercero-identificacion" placeholder="Identificación" required>
        <input type="text" id="tercero-nombre" placeholder="Nombre" required>
        <input type="email" id="tercero-email" placeholder="Correo (opcional)">
        <input type="text" id="tercero-celular" placeholder="Celular (opcional)">
        <input type="text" id="tercero-direccion" placeholder="Dirección (opcional)">
        <input type="text" id="tercero-departamento" placeholder="Departamento (opcional)">
        <input type="text" id="tercero-municipio" placeholder="Municipio (opcional)">
        <select id="tercero-regimen-iva">
          <option value="">Régimen de IVA...</option>
          <option value="responsable">Responsable de IVA</option>
          <option value="no_responsable">No responsable de IVA</option>
        </select>
        <select id="tercero-cuenta-tipo">
          <option value="">Tipo de cuenta...</option>
          <option value="ahorros">Ahorros</option>
          <option value="corriente">Corriente</option>
        </select>
        <input type="text" id="tercero-cuenta-banco" placeholder="Banco (opcional)">
        <input type="text" id="tercero-cuenta-numero" placeholder="No. cuenta (opcional)">
        <fieldset class="fieldset-responsabilidades">
          <legend>Responsabilidad fiscal (marca las que apliquen)</legend>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-13"> O-13 Gran contribuyente</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-15"> O-15 Autorretenedor</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-23"> O-23 Agente de retención IVA</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-47"> O-47 Régimen simple de tributación</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="R-99-PN"> R-99-PN No aplica - Otros</label>
        </fieldset>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-tercero">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-terceros"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-cotizaciones" class="panel" hidden>
      <header class="panel-header">
        <h2>Cotizaciones</h2>
        <button class="btn-primario" id="btn-nueva-cotizacion">+ Nueva cotización</button>
      </header>
      <form id="form-cotizacion" class="form-inline" hidden>
        <select id="cotizacion-tercero" required></select>
        <input type="date" id="cotizacion-vencimiento" required title="Fecha de vencimiento">
        <input type="number" id="cotizacion-total" placeholder="Total" required min="0">
        <input type="text" id="cotizacion-forma-pago" placeholder="Forma de pago (opcional)">
        <input type="text" id="cotizacion-observaciones" placeholder="Observaciones (opcional)">
        <input type="text" id="cotizacion-contacto-nombre" placeholder="Persona de contacto (opcional)">
        <input type="text" id="cotizacion-contacto-telefono" placeholder="Teléfono de contacto (opcional)">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-cotizacion">Cancelar</button>
      </form>
      <p class="nota-panel">Los ítems línea por línea (con IVA y AIU) llegan en el siguiente ajuste — por ahora el total se escribe a mano.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-cotizaciones"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-venta" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de venta</h2></header>
      <p class="nota-panel">Se generan al convertir una cotización aceptada — no se crean directo aquí.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-venta"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-ordenes" class="panel" hidden>
      <header class="panel-header">
        <h2>Órdenes de adquisición</h2>
        <button class="btn-primario" id="btn-nueva-orden">+ Nueva orden</button>
      </header>
      <form id="form-orden" class="form-inline" hidden>
        <select id="orden-tercero" required></select>
        <select id="orden-tipo">
          <option value="bienes">Bienes</option>
          <option value="servicios">Servicios</option>
        </select>
        <input type="text" id="orden-proyecto" placeholder="Proyecto / unidad de negocio (opcional)">
        <input type="text" id="orden-lugar-entrega" placeholder="Lugar de entrega (opcional)">
        <input type="text" id="orden-forma-pago" placeholder="Forma de pago (opcional)">
        <input type="number" id="orden-subtotal" placeholder="Subtotal" required min="0">
        <input type="number" id="orden-iva" placeholder="IVA" min="0" value="0">
        <input type="number" id="orden-total" placeholder="Total" required min="0">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-orden">Cancelar</button>
      </form>
      <p class="nota-panel">Los ítems línea por línea llegan en el siguiente ajuste — por ahora subtotal/IVA/total se escriben a mano.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-ordenes"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-compra" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de compra</h2></header>
      <p class="nota-panel">Se generan al convertir una orden aprobada, o llegan por webhook del proveedor tecnológico.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-compra"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-nomina" class="panel" hidden>
      <header class="panel-header">
        <h2>Nómina</h2>
        <button class="btn-primario" id="btn-nuevo-periodo">+ Nuevo periodo</button>
      </header>
      <form id="form-periodo" class="form-inline" hidden>
        <input type="date" id="periodo-inicio" required title="Fecha de inicio">
        <input type="date" id="periodo-fin" required title="Fecha de fin">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-periodo">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-nomina"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-inventarios" class="panel" hidden>
      <header class="panel-header">
        <h2>Inventarios</h2>
        <button class="btn-primario" id="btn-nuevo-producto">+ Nuevo producto</button>
      </header>
      <form id="form-producto" class="form-inline" hidden>
        <input type="text" id="producto-nombre" placeholder="Nombre" required>
        <select id="producto-tipo">
          <option value="bien">Bien</option>
          <option value="servicio">Servicio</option>
        </select>
        <input type="text" id="producto-unidad" placeholder="Unidad" value="unidad">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-producto">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-productos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-activos-fijos" class="panel" hidden>
      <header class="panel-header">
        <h2>Activos fijos</h2>
        <div class="acciones-header">
          <button class="btn-secundario" id="btn-depreciar">Correr depreciación del mes</button>
          <button class="btn-primario" id="btn-nuevo-activo">+ Nuevo activo</button>
        </div>
      </header>
      <form id="form-activo" class="form-inline" hidden>
        <input type="text" id="activo-nombre" placeholder="Nombre" required>
        <input type="number" id="activo-costo" placeholder="Costo" required min="0">
        <input type="number" id="activo-vida-util" placeholder="Vida útil (meses)" required min="1">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-activo">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-activos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-tesoreria" class="panel" hidden>
      <header class="panel-header"><h2>Tesorería</h2></header>

      <div class="subseccion-header">
        <h3 class="subseccion">Cuentas bancarias</h3>
        <button class="btn-primario btn-chico" id="btn-nueva-cuenta">+ Nueva cuenta</button>
      </div>
      <form id="form-cuenta" class="form-inline" hidden>
        <input type="text" id="cuenta-banco" placeholder="Banco" required>
        <input type="text" id="cuenta-numero" placeholder="Número" required>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-cuenta">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-cuentas"><thead></thead><tbody></tbody></table>
      </div>

      <div class="subseccion-header">
        <h3 class="subseccion">Movimientos</h3>
        <button class="btn-primario btn-chico" id="btn-nuevo-movimiento">+ Nuevo movimiento</button>
      </div>
      <form id="form-movimiento" class="form-inline" hidden>
        <select id="movimiento-cuenta" required></select>
        <select id="movimiento-tipo">
          <option value="ingreso">Ingreso</option>
          <option value="egreso">Egreso</option>
          <option value="comision">Comisión</option>
        </select>
        <input type="number" id="movimiento-valor" placeholder="Valor" required min="0">
        <input type="text" id="movimiento-descripcion" placeholder="Descripción (opcional)">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-movimiento">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-movimientos-bancarios"><thead></thead><tbody></tbody></table>
      </div>
    </section>
  </main>
</div>

<script src="/contable/app.js"></script>
</body>
</html>
SCRIPTEOF
echo "OK  public/contable/index.html"

cat > public/contable/app.js << 'SCRIPTEOF'
const API = '/api';

let token = localStorage.getItem('token');
let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
let mapaTerceros = {};
let listaTerceros = [];

const vistaLogin = document.getElementById('vista-login');
const vistaDashboard = document.getElementById('vista-dashboard');

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    cerrarSesion('Tu sesión expiró. Inicia sesión de nuevo.');
    throw new Error('No autenticado');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

// Atajo para botones de acción: llama la API y recarga todo el tablero.
// Cualquier error se muestra en una alerta simple — es intencionalmente
// básico, para no construir un sistema de notificaciones todavía.
async function accion(path, options = {}) {
  try {
    await api(path, options);
    await cargarTodo();
  } catch (err) {
    alert(err.message);
  }
}

function formatoDinero(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });
}

function formatoFecha(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function nombreTercero(id) {
  return mapaTerceros[id] || id || '—';
}

function badge(estado) {
  if (!estado) return '—';
  return `<span class="badge ${estado}">${estado.replace(/_/g, ' ')}</span>`;
}

function tablaVacia(idTabla, colSpan, mensaje) {
  document.querySelector(`#${idTabla} tbody`).innerHTML =
    `<tr><td colspan="${colSpan}" class="vacio">${mensaje}</td></tr>`;
}

function botonAccion(texto, dataAttrs, destructivo) {
  const attrs = Object.entries(dataAttrs)
    .map(([k, v]) => `data-${k}="${v}"`)
    .join(' ');
  return `<button class="btn-accion${destructivo ? ' destructivo' : ''}" ${attrs}>${texto}</button>`;
}

// --- LOGIN ---
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');

    token = data.token;
    usuario = data.usuario;
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuario));
    mostrarDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

function cerrarSesion(mensaje) {
  token = null;
  usuario = null;
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  vistaDashboard.hidden = true;
  vistaLogin.hidden = false;
  if (mensaje) {
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = mensaje;
    errorEl.hidden = false;
  }
}

document.getElementById('btn-salir').addEventListener('click', () => cerrarSesion());

// --- DASHBOARD SHELL ---
function mostrarDashboard() {
  vistaLogin.hidden = true;
  vistaDashboard.hidden = false;
  document.getElementById('usuario-nombre').textContent = usuario.nombre;
  document.getElementById('usuario-rol').textContent = usuario.rol;
  cargarTodo();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activo'));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
    btn.classList.add('activo');
    document.getElementById('panel-' + btn.dataset.tab).hidden = false;
  });
});

// --- TOGGLE DE FORMULARIOS "+ Nuevo..." ---
function conectarToggle(botonId, formularioId, cancelarId) {
  const boton = document.getElementById(botonId);
  const formulario = document.getElementById(formularioId);
  boton.addEventListener('click', () => (formulario.hidden = !formulario.hidden));
  document.getElementById(cancelarId).addEventListener('click', () => {
    formulario.hidden = true;
    formulario.reset();
  });
}

conectarToggle('btn-nuevo-tercero', 'form-tercero', 'btn-cancelar-tercero');
conectarToggle('btn-nueva-cotizacion', 'form-cotizacion', 'btn-cancelar-cotizacion');
conectarToggle('btn-nueva-orden', 'form-orden', 'btn-cancelar-orden');
conectarToggle('btn-nuevo-periodo', 'form-periodo', 'btn-cancelar-periodo');
conectarToggle('btn-nuevo-producto', 'form-producto', 'btn-cancelar-producto');
conectarToggle('btn-nuevo-activo', 'form-activo', 'btn-cancelar-activo');
conectarToggle('btn-nueva-cuenta', 'form-cuenta', 'btn-cancelar-cuenta');
conectarToggle('btn-nuevo-movimiento', 'form-movimiento', 'btn-cancelar-movimiento');

// --- CARGA DE DATOS ---
async function cargarTodo() {
  try {
    const terceros = await api('/terceros');
    listaTerceros = terceros;
    mapaTerceros = Object.fromEntries(terceros.map((t) => [t.id, t.nombre]));
    renderTerceros(terceros);
    poblarSelectTerceros('cotizacion-tercero', 'cliente', 'Cliente');
    poblarSelectTerceros('orden-tercero', 'proveedor', 'Proveedor');

    const [cotizaciones, facturasVenta, ordenes, facturasCompra, periodos, productos, activos, cuentas, movBancarios] = await Promise.all([
      api('/ventas/cotizaciones'),
      api('/ventas/facturas'),
      api('/compras/ordenes'),
      api('/compras/facturas'),
      api('/nomina/periodos'),
      api('/inventarios/productos'),
      api('/activos-fijos'),
      api('/tesoreria/cuentas'),
      api('/tesoreria/movimientos'),
    ]);

    renderCotizaciones(cotizaciones);
    renderFacturasVenta(facturasVenta);
    renderOrdenes(ordenes);
    renderFacturasCompra(facturasCompra);
    renderNomina(periodos);
    renderProductos(productos);
    renderActivos(activos);
    renderCuentas(cuentas);
    poblarSelectCuentas(cuentas);
    renderMovimientosBancarios(movBancarios);
  } catch (err) {
    console.error(err);
  }
}

function poblarSelectTerceros(selectId, tipo, etiqueta) {
  const select = document.getElementById(selectId);
  const filtrados = listaTerceros.filter((t) => t.tipo === tipo);
  select.innerHTML =
    `<option value="">${etiqueta}...</option>` +
    filtrados.map((t) => `<option value="${t.id}">${t.nombre}</option>`).join('');
}

function poblarSelectCuentas(cuentas) {
  const select = document.getElementById('movimiento-cuenta');
  select.innerHTML =
    '<option value="">Cuenta bancaria...</option>' +
    cuentas.map((c) => `<option value="${c.id}">${c.banco} — ${c.numero}</option>`).join('');
}

// --- RENDER: TERCEROS ---
function renderTerceros(lista) {
  document.querySelector('#tabla-terceros thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th>Persona</th><th>Identificación</th><th>Celular</th><th>Correo</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-terceros', 6, 'Todavía no hay terceros. Crea el primero arriba.');
  document.querySelector('#tabla-terceros tbody').innerHTML = lista
    .map(
      (t) =>
        `<tr><td>${t.nombre}</td><td>${t.tipo}</td><td>${t.tipoPersona || '—'}</td><td>${
          t.identificacion
        }</td><td>${t.celular || '—'}</td><td>${t.email || '—'}</td></tr>`
    )
    .join('');
}

// --- RENDER: COTIZACIONES (con acciones según estado) ---
function renderCotizaciones(lista) {
  document.querySelector('#tabla-cotizaciones thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Cliente</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cotizaciones', 6, 'Todavía no hay cotizaciones.');
  document.querySelector('#tabla-cotizaciones tbody').innerHTML = lista
    .map((c) => {
      let acciones = '—';
      if (c.estado === 'borrador') acciones = botonAccion('Enviar', { accion: 'enviar-cotizacion', id: c.id });
      else if (c.estado === 'enviada')
        acciones =
          botonAccion('Aceptar', { accion: 'aceptar-cotizacion', id: c.id }) +
          botonAccion('Rechazar', { accion: 'rechazar-cotizacion', id: c.id }, true);
      else if (c.estado === 'aceptada') acciones = botonAccion('Convertir en factura', { accion: 'convertir-cotizacion', id: c.id });

      return `<tr><td>${c.consecutivo || '—'}</td><td>${formatoFecha(c.fecha)}</td><td>${nombreTercero(
        c.terceroId
      )}</td><td>${badge(c.estado)}</td><td class="num">${formatoDinero(c.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasVenta(lista) {
  document.querySelector('#tabla-facturas-venta thead').innerHTML =
    '<tr><th>Fecha</th><th>Cliente</th><th>DIAN</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-venta', 4, 'Todavía no hay facturas de venta.');
  document.querySelector('#tabla-facturas-venta tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoSincronizacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

// --- RENDER: ÓRDENES DE ADQUISICIÓN ---
function renderOrdenes(lista) {
  document.querySelector('#tabla-ordenes thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Proveedor</th><th>Proyecto</th><th>Tipo</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-ordenes', 8, 'Todavía no hay órdenes de adquisición.');
  document.querySelector('#tabla-ordenes tbody').innerHTML = lista
    .map((o) => {
      let acciones = '—';
      if (['borrador', 'emitida'].includes(o.estado)) acciones = botonAccion('Aprobar', { accion: 'aprobar-orden', id: o.id });
      else if (['aprobada', 'recibida_parcial', 'recibida_total'].includes(o.estado))
        acciones = botonAccion('Convertir en factura', { accion: 'convertir-orden', id: o.id });

      return `<tr><td>${o.consecutivo || '—'}</td><td>${formatoFecha(o.fecha)}</td><td>${nombreTercero(
        o.terceroId
      )}</td><td>${o.proyecto || '—'}</td><td>${o.tipo}</td><td>${badge(
        o.estado
      )}</td><td class="num">${formatoDinero(o.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasCompra(lista) {
  document.querySelector('#tabla-facturas-compra thead').innerHTML =
    '<tr><th>Fecha</th><th>Proveedor</th><th>Conciliación</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-compra', 4, 'Todavía no hay facturas de compra.');
  document.querySelector('#tabla-facturas-compra tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoConciliacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

// --- RENDER: NÓMINA ---
function renderNomina(lista) {
  document.querySelector('#tabla-nomina thead').innerHTML = '<tr><th>Periodo</th><th>Estado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-nomina', 3, 'Todavía no hay periodos de nómina.');
  document.querySelector('#tabla-nomina tbody').innerHTML = lista
    .map((p) => {
      let acciones = '—';
      if (p.estado === 'borrador')
        acciones =
          botonAccion('Agregar empleado', { accion: 'agregar-empleado', id: p.id }) +
          botonAccion('Liquidar', { accion: 'liquidar-periodo', id: p.id });

      return `<tr><td>${formatoFecha(p.fechaInicio)} — ${formatoFecha(p.fechaFin)}</td><td>${badge(
        p.estado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: INVENTARIOS ---
function renderProductos(lista) {
  document.querySelector('#tabla-productos thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Costo promedio</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-productos', 5, 'Todavía no hay productos. Crea el primero arriba.');
  document.querySelector('#tabla-productos tbody').innerHTML = lista
    .map((p) => {
      const acciones =
        botonAccion('Entrada', { accion: 'entrada-inventario', id: p.id }) +
        botonAccion('Salida', { accion: 'salida-inventario', id: p.id }) +
        botonAccion('Ajuste', { accion: 'ajuste-inventario', id: p.id }, true);
      return `<tr><td>${p.nombre}</td><td>${p.tipo}</td><td class="num">${Number(p.cantidadDisponible).toLocaleString(
        'es-CO'
      )}</td><td class="num">${formatoDinero(p.costoPromedio)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: ACTIVOS FIJOS ---
function renderActivos(lista) {
  document.querySelector('#tabla-activos thead').innerHTML =
    '<tr><th>Nombre</th><th>Adquisición</th><th>Estado</th><th class="num">Costo</th><th class="num">Depreciado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-activos', 6, 'Todavía no hay activos fijos registrados.');
  document.querySelector('#tabla-activos tbody').innerHTML = lista
    .map((a) => {
      const acciones = a.estado === 'activo' ? botonAccion('Dar de baja', { accion: 'baja-activo', id: a.id }, true) : '—';
      return `<tr><td>${a.nombre}</td><td>${formatoFecha(a.fechaAdquisicion)}</td><td>${badge(
        a.estado
      )}</td><td class="num">${formatoDinero(a.costo)}</td><td class="num">${formatoDinero(
        a.valorDepreciadoAcumulado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: TESORERÍA ---
function renderCuentas(lista) {
  document.querySelector('#tabla-cuentas thead').innerHTML = '<tr><th>Banco</th><th>Número</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cuentas', 2, 'Todavía no hay cuentas bancarias registradas.');
  document.querySelector('#tabla-cuentas tbody').innerHTML = lista
    .map((c) => `<tr><td>${c.banco}</td><td>${c.numero}</td></tr>`)
    .join('');
}

function renderMovimientosBancarios(lista) {
  document.querySelector('#tabla-movimientos-bancarios thead').innerHTML =
    '<tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Conciliado</th><th class="num">Valor</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-movimientos-bancarios', 6, 'Todavía no hay movimientos bancarios registrados.');
  document.querySelector('#tabla-movimientos-bancarios tbody').innerHTML = lista
    .map((m) => {
      const acciones = m.conciliado ? '—' : botonAccion('Conciliar', { accion: 'conciliar-movimiento', id: m.id });
      return `<tr><td>${formatoFecha(m.fecha)}</td><td>${m.tipo}</td><td>${m.descripcion || '—'}</td><td>${
        m.conciliado ? badge('conciliado') : badge('pendiente')
      }</td><td class="num">${formatoDinero(m.valor)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- FORMULARIOS DE CREACIÓN ---
function conectarFormulario(formId, alEnviar) {
  const form = document.getElementById(formId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await alEnviar();
      form.reset();
      form.hidden = true;
      cargarTodo();
    } catch (err) {
      alert(err.message);
    }
  });
}

conectarFormulario('form-tercero', () => {
  const responsabilidades = Array.from(document.querySelectorAll('.chk-responsabilidad:checked')).map((c) => c.value);
  return api('/terceros', {
    method: 'POST',
    body: JSON.stringify({
      tipo: document.getElementById('tercero-tipo').value,
      tipoPersona: document.getElementById('tercero-tipo-persona').value || undefined,
      identificacion: document.getElementById('tercero-identificacion').value,
      nombre: document.getElementById('tercero-nombre').value,
      email: document.getElementById('tercero-email').value || undefined,
      celular: document.getElementById('tercero-celular').value || undefined,
      direccion: document.getElementById('tercero-direccion').value || undefined,
      departamento: document.getElementById('tercero-departamento').value || undefined,
      municipio: document.getElementById('tercero-municipio').value || undefined,
      regimenIva: document.getElementById('tercero-regimen-iva').value || undefined,
      cuentaBancariaTipo: document.getElementById('tercero-cuenta-tipo').value || undefined,
      cuentaBancariaBanco: document.getElementById('tercero-cuenta-banco').value || undefined,
      cuentaBancariaNumero: document.getElementById('tercero-cuenta-numero').value || undefined,
      responsabilidadesFiscales: responsabilidades.length > 0 ? responsabilidades : undefined,
    }),
  });
});

conectarFormulario('form-cotizacion', () =>
  api('/ventas/cotizaciones', {
    method: 'POST',
    body: JSON.stringify({
      terceroId: document.getElementById('cotizacion-tercero').value,
      fechaVencimiento: document.getElementById('cotizacion-vencimiento').value,
      total: Number(document.getElementById('cotizacion-total').value),
      formaPago: document.getElementById('cotizacion-forma-pago').value || undefined,
      observaciones: document.getElementById('cotizacion-observaciones').value || undefined,
      contactoNombre: document.getElementById('cotizacion-contacto-nombre').value || undefined,
      contactoTelefono: document.getElementById('cotizacion-contacto-telefono').value || undefined,
    }),
  })
);

conectarFormulario('form-orden', () =>
  api('/compras/ordenes', {
    method: 'POST',
    body: JSON.stringify({
      terceroId: document.getElementById('orden-tercero').value,
      tipo: document.getElementById('orden-tipo').value,
      proyecto: document.getElementById('orden-proyecto').value || undefined,
      lugarEntrega: document.getElementById('orden-lugar-entrega').value || undefined,
      formaPago: document.getElementById('orden-forma-pago').value || undefined,
      subtotal: Number(document.getElementById('orden-subtotal').value),
      iva: Number(document.getElementById('orden-iva').value || 0),
      total: Number(document.getElementById('orden-total').value),
    }),
  })
);

conectarFormulario('form-periodo', () =>
  api('/nomina/periodos', {
    method: 'POST',
    body: JSON.stringify({
      fechaInicio: document.getElementById('periodo-inicio').value,
      fechaFin: document.getElementById('periodo-fin').value,
    }),
  })
);

conectarFormulario('form-producto', () =>
  api('/inventarios/productos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('producto-nombre').value,
      tipo: document.getElementById('producto-tipo').value,
      unidadMedida: document.getElementById('producto-unidad').value || 'unidad',
    }),
  })
);

conectarFormulario('form-activo', () =>
  api('/activos-fijos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('activo-nombre').value,
      costo: Number(document.getElementById('activo-costo').value),
      vidaUtilMeses: Number(document.getElementById('activo-vida-util').value),
    }),
  })
);

conectarFormulario('form-cuenta', () =>
  api('/tesoreria/cuentas', {
    method: 'POST',
    body: JSON.stringify({
      banco: document.getElementById('cuenta-banco').value,
      numero: document.getElementById('cuenta-numero').value,
    }),
  })
);

conectarFormulario('form-movimiento', () =>
  api('/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      cuentaBancariaId: document.getElementById('movimiento-cuenta').value,
      tipo: document.getElementById('movimiento-tipo').value,
      valor: Number(document.getElementById('movimiento-valor').value),
      descripcion: document.getElementById('movimiento-descripcion').value || undefined,
    }),
  })
);

// --- BOTÓN GENERAL: correr depreciación del mes ---
document.getElementById('btn-depreciar').addEventListener('click', async () => {
  if (!confirm('¿Correr la depreciación mensual de todos los activos fijos activos?')) return;
  await accion('/activos-fijos/depreciar', { method: 'POST' });
});

// --- ACCIONES POR FILA (delegación de eventos sobre todo el tablero) ---
document.getElementById('vista-dashboard').addEventListener('click', async (e) => {
  const boton = e.target.closest('.btn-accion');
  if (!boton) return;

  const { accion: tipoAccion, id } = boton.dataset;

  switch (tipoAccion) {
    case 'enviar-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/enviar`, { method: 'PATCH' });
    case 'aceptar-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/aceptar`, { method: 'PATCH' });
    case 'rechazar-cotizacion':
      if (confirm('¿Rechazar esta cotización?')) return accion(`/ventas/cotizaciones/${id}/rechazar`, { method: 'PATCH' });
      return;
    case 'convertir-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/convertir`, { method: 'POST' });

    case 'aprobar-orden':
      return accion(`/compras/ordenes/${id}/aprobar`, { method: 'PATCH' });
    case 'convertir-orden':
      return accion(`/compras/ordenes/${id}/convertir`, { method: 'POST' });

    case 'agregar-empleado':
      return agregarEmpleadoAPeriodo(id);
    case 'liquidar-periodo':
      if (confirm('¿Liquidar este periodo? Se emitirá el documento soporte de cada empleado agregado.'))
        return accion(`/nomina/periodos/${id}/liquidar`, { method: 'POST' });
      return;

    case 'entrada-inventario':
      return movimientoInventario('entradas', id, true);
    case 'salida-inventario':
      return movimientoInventario('salidas', id, false);
    case 'ajuste-inventario':
      return movimientoInventario('ajustes', id, false, true);

    case 'baja-activo':
      if (confirm('¿Dar de baja este activo? Esta acción queda pendiente de revisión del contador.'))
        return accion(`/activos-fijos/${id}/baja`, { method: 'POST' });
      return;

    case 'conciliar-movimiento':
      return accion(`/tesoreria/movimientos/${id}/conciliar`, { method: 'POST' });
  }
});

// Prompts sencillos para acciones que necesitan un dato adicional puntual.
// Es deliberadamente básico — reemplazar por un formulario modal real
// queda como mejora pendiente, ver README.

async function agregarEmpleadoAPeriodo(periodoId) {
  const empleados = listaTerceros.filter((t) => t.tipo === 'empleado');
  if (empleados.length === 0) {
    alert('Primero crea un tercero de tipo "empleado" en la pestaña Terceros.');
    return;
  }
  const opciones = empleados.map((e, i) => `${i + 1}. ${e.nombre}`).join('\n');
  const seleccion = prompt(`¿Qué empleado? Escribe el número:\n${opciones}`);
  const empleado = empleados[Number(seleccion) - 1];
  if (!empleado) return;

  const devengado = prompt(`Devengado de ${empleado.nombre} ($):`);
  if (!devengado) return;
  const deducciones = prompt('Deducciones ($) — Enter para 0:') || '0';

  await accion(`/nomina/periodos/${periodoId}/empleados`, {
    method: 'POST',
    body: JSON.stringify({ empleadoId: empleado.id, devengado: Number(devengado), deducciones: Number(deducciones) }),
  });
}

async function movimientoInventario(tipo, productoId, pideCosto, pideObservacion) {
  const cantidad = prompt('Cantidad:');
  if (!cantidad) return;

  const body = { productoId, cantidad: Number(cantidad) };

  if (pideCosto) {
    const costo = prompt('Costo unitario ($):');
    if (!costo) return;
    body.costoUnitario = Number(costo);
  }

  if (pideObservacion) {
    body.observacion = prompt('Motivo del ajuste:') || '';
  }

  await accion(`/inventarios/${tipo}`, { method: 'POST', body: JSON.stringify(body) });
}

// --- INICIO ---
if (token && usuario) {
  mostrarDashboard();
}
SCRIPTEOF
echo "OK  public/contable/app.js"

cat > public/contable/style.css << 'SCRIPTEOF'
:root {
  --paper: #F6F8F4;
  --surface: #FFFFFF;
  --ink: #1C2A24;
  --ink-soft: #56655C;
  --rule: #CBD6CE;
  --rule-strong: #9FAFA4;
  --accent: #2F6B4F;
  --accent-hover: #275940;
  --accent-ink: #FFFFFF;
  --danger: #A6432E;
  --warn: #B8863A;
  --font-serif: 'IBM Plex Serif', Georgia, serif;
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--paper);
}

.wordmark {
  font-family: var(--font-serif);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

button { font-family: var(--font-sans); cursor: pointer; }

.btn-primario {
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
}
.btn-primario:hover { background: var(--accent-hover); }

.btn-secundario {
  background: transparent;
  color: var(--ink-soft);
  border: 1px solid var(--rule-strong);
  padding: 10px 18px;
  font-size: 14px;
}

/* LOGIN */
.pantalla-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.tarjeta-login {
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border-top: 3px solid var(--accent);
  padding: 40px 32px;
}

.tarjeta-login .wordmark { font-size: 22px; margin-bottom: 4px; }

.subtitulo {
  color: var(--ink-soft);
  font-size: 13px;
  margin: 0 0 28px;
  line-height: 1.5;
}

#form-login label {
  display: block;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 16px;
}

#form-login input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}

#form-login input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

#form-login .btn-primario {
  width: 100%;
  padding: 12px;
  margin-top: 8px;
}

.mensaje-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 12px;
}

/* APP SHELL */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.barra-lateral {
  background: var(--surface);
  border-right: 1px solid var(--rule);
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
}

.barra-lateral .wordmark { font-size: 17px; margin-bottom: 28px; }

.barra-lateral nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding: 9px 10px;
  font-size: 14px;
  color: var(--ink-soft);
}

.nav-item:hover { color: var(--ink); background: var(--paper); }

.nav-item.activo {
  color: var(--ink);
  border-left-color: var(--accent);
  background: var(--paper);
  font-weight: 500;
}

.usuario-actual {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-top: 16px;
}

.usuario-actual p { margin: 0; font-size: 13px; }
.usuario-actual .rol {
  color: var(--ink-soft);
  text-transform: capitalize;
  margin-bottom: 10px;
}

#btn-salir {
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  padding: 0;
  text-decoration: underline;
}

.enlace-sitio {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-top: 8px;
}

.contenido { padding: 32px 40px; max-width: 1000px; }

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}

.panel-header h2 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 24px;
  margin: 0;
}

.subseccion {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 15px;
  color: var(--ink-soft);
  margin: 0;
}

.subseccion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 24px 0 10px;
}
.subseccion-header:first-of-type { margin-top: 0; }

.acciones-header {
  display: flex;
  gap: 10px;
  align-items: center;
}

.nota-panel {
  color: var(--ink-soft);
  font-size: 13px;
  margin: -8px 0 16px;
}

.btn-chico {
  padding: 6px 12px;
  font-size: 13px;
}

.btn-accion {
  background: none;
  border: 1px solid var(--rule-strong);
  color: var(--ink);
  padding: 4px 10px;
  font-size: 12px;
  margin-right: 6px;
  white-space: nowrap;
}
.btn-accion:hover { background: var(--paper); }
.btn-accion.destructivo { border-color: var(--danger); color: var(--danger); }
.btn-accion.destructivo:hover { background: #fbeae6; }

td.acciones { white-space: nowrap; }

.form-inline {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 16px;
  margin-bottom: 20px;
}

.form-inline input, .form-inline select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

.fieldset-responsabilidades {
  border: 1px solid var(--rule-strong);
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  width: 100%;
}
.fieldset-responsabilidades legend {
  font-size: 12px;
  color: var(--ink-soft);
  padding: 0 4px;
}
.fieldset-responsabilidades label {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

/* TABLAS: estilo libro contable — solo reglas horizontales */
.tabla-envoltorio {
  background: var(--surface);
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--rule-strong);
  white-space: nowrap;
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}

tbody tr:last-child td { border-bottom: none; }

td.num, th.num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  text-transform: capitalize;
}
.badge.aceptada, .badge.aceptado, .badge.contabilizado, .badge.liquidada, .badge.aprobada, .badge.conciliado { border-color: var(--accent); color: var(--accent); }
.badge.rechazada, .badge.rechazado, .badge.objetada { border-color: var(--danger); color: var(--danger); }
.badge.pendiente, .badge.borrador, .badge.enviada, .badge.enviado { border-color: var(--warn); color: var(--warn); }

.vacio {
  padding: 32px 16px;
  color: var(--ink-soft);
  font-size: 14px;
  text-align: center;
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .barra-lateral {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
  .barra-lateral nav { flex-direction: row; flex-wrap: wrap; }
  .contenido { padding: 20px; }
}
SCRIPTEOF
echo "OK  public/contable/style.css"

cat > README.md << 'SCRIPTEOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
PostgreSQL en Supabase).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Página institucional de Libaniel Consulting (raíz del dominio)
├── style.css                  Estilos del sitio institucional
└── contable/                  El software contable en sí, en /contable
    ├── index.html                Login + tablero con pestañas por módulo
    ├── style.css                 Estética de libro contable (IBM Plex, reglas horizontales)
    └── app.js                    Login, consumo de la API, formularios y acciones por rol
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa, Tercero (persona natural/jurídica,
│   │                           ubicación, régimen y responsabilidades DIAN,
│   │                           cuenta bancaria), PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario, Usuario, LogAuditoria
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       ├── cierrePeriodo.js    Máquina de estados del cierre mensual
│       ├── authService.js      Login y registro de usuarios
│       ├── auditoria.js        Registro de acciones sensibles
│       ├── seedService.js      Datos base: empresa, periodo, cuentas, reglas
│       └── consecutivos.js     Numeración legible tipo COT-2026-0001 / ODA-2026-0001
├── modules/                  # Módulos operativos (capa transaccional) — TODOS completos
│   ├── ventas/                 Cotización → factura, patrón de referencia
│   ├── compras/                Factura recibida + documento soporte, orden de compra
│   ├── nomina/                 Periodo → empleados → liquidar → documento soporte
│   ├── inventarios/            Kardex simplificado: entradas, salidas, ajustes
│   ├── activosFijos/           Registro, depreciación mensual (cron), baja
│   └── tesoreria/               Cuentas bancarias, movimientos, conciliación
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
│   ├── depreciacionMensual.js  Implementado — recorre todas las empresas
│   └── vencimientoCotizaciones.js
├── middleware/                # authenticate + authorize por rol
└── routes/                   # Router raíz (auth, seed, terceros, y los 6 módulos)
```

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).

La raíz del dominio (`/`) es la página institucional de **Libaniel
Consulting**, pensada para ofrecer varios servicios de la firma — hoy
solo el software contable es real, los otros dos son marcadores de
posición con un `mailto:` genérico (`contacto@libanielconsulting.com`)
hasta que se definan de verdad.

El software contable en sí vive en **`/contable`** — mismo backend,
solo un subdirectorio distinto en `public/`. Cubre creación y las
transiciones de estado principales de los seis módulos (formularios
inline + botones de acción por fila según el estado del registro). Dos
simplificaciones deliberadas por ahora:
acciones que piden un solo dato adicional puntual (agregar empleado a
un periodo, entradas/salidas/ajustes de inventario) usan `prompt()` del
navegador en vez de un formulario modal propio; y no hay edición ni
borrado de nada, solo creación y transiciones hacia adelante.

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa y resuelve solo el periodo
   contable vigente si no se le pasa explícito.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).
6. **Un movimiento bancario sin conciliar bloquea el cierre del periodo**
   (ver `cierrePeriodo.validarPeriodo`).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de la base de datos y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Sitios web → Apps Node.js → conectar el repositorio de GitHub.
2. Base de datos: PostgreSQL vía Supabase (host, puerto, nombre, usuario y
   contraseña como `DB_*` en las variables de entorno de la app).
3. hPanel → Avanzado → Cron Jobs → programar:
   - `node src/jobs/depreciacionMensual.js` — día 1 de cada mes
   - `node src/jobs/vencimientoCotizaciones.js` — diario

## Roles y autenticación

Cuatro roles, controlados por `src/middleware/auth.js` (`authenticate` +
`authorize(...roles)`):

| Rol | Puede |
|---|---|
| `dueño` | Operar el sistema, certificar el cierre mensual |
| `contador` | Todo lo anterior + reabrir un periodo certificado |
| `auxiliar` | Registrar operaciones del día a día (ventas, compras, nómina) |
| `revisor` | Solo lectura (pendiente de aplicar en cada ruta) |

`POST /api/auth/login` y `POST /api/auth/registro` son las únicas rutas
públicas. Todas las demás requieren `Authorization: Bearer <token>`.

## Datos base (seed)

`POST /api/seed` (requiere sesión con rol `contador` o `dueño`) crea:
una empresa de prueba, el periodo contable del mes en curso, un plan de
cuentas de 22 cuentas, y 13 reglas de contabilización — una por cada
evento que disparan los seis módulos operativos. Seguro de correr más
de una vez — no duplica nada. Sin esto, `motorAsientos` no tiene con
qué contabilizar.

## Pendientes inmediatos

- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] Migraciones de Sequelize (`sequelize-cli`) para las tablas ya modeladas
- [ ] Reemplazar `FACTOR_PRESTACIONES` (21.83% fijo) en `nomina.service.js` por el cálculo exacto de cesantías, intereses, prima y vacaciones según la normativa laboral vigente y el tipo de contrato
- [ ] Integrar `NovedadNomina` con el cálculo del devengado (hoy es solo un registro informativo, no ajusta nada automáticamente)
- [ ] Tesorería: cruzar movimientos de tipo ingreso/egreso contra la factura, orden o nómina específica que pagan (hoy solo "comisión" se contabiliza sola al conciliar; el resto solo queda marcado como conciliado, sin generar el asiento de pago)
- [ ] Mapear cada `CuentaBancaria` a su propia subcuenta contable — hoy todas comparten el código 1110 Bancos
- [ ] Soportar múltiples líneas (débito/crédito) por evento en `motorAsientos` — hoy una venta no discrimina el IVA en un renglón aparte
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `GET/PATCH/DELETE` de terceros (hoy `terceros.routes.js` solo tiene crear y listar)
- [ ] Vincular `MovimientoInventario` con los ítems reales de `FacturaVenta`/`FacturaCompra` — hoy las entradas y salidas se registran manualmente por API, no automático desde una venta
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Reemplazar los `prompt()` del navegador (agregar empleado a nómina, entradas/salidas/ajustes de inventario) por formularios modales propios en el frontend; agregar edición/borrado en general
- [ ] Confirmar que `www.libanielconsulting.com` resuelve al mismo sitio que `libanielconsulting.com` (revisar en hPanel → Dominios, o agregar la redirección si falta)
- [ ] Definir de verdad los servicios 02 y 03 de la página institucional (`public/index.html`) y reemplazar el `mailto:contacto@libanielconsulting.com` por el correo real de la firma
- [ ] **Fase 2 — ítems de cotización/orden en el frontend**: tabla dinámica para agregar renglones (concepto, cantidad, UM con lista desplegable, valor unitario, IVA) en vez del campo de total a mano; el backend ya soporta `items[]` en `POST /ventas/cotizaciones` y `POST /compras/ordenes`, ver `CotizacionItem`/`OrdenCompraItem`
- [ ] **Fase 3 — plantilla imprimible/PDF** de cotización y orden de adquisición, replicando el formato real de la firma (membrete, datos del cliente/proveedor, ítems, AIU cuando aplique, firmas)
- [ ] Validar con un caso real si el IVA de una cotización con AIU debe calcularse sobre (subtotal + AIU) como quedó programado, o de otra forma según el tipo de contrato — ver la nota en `crearCotizacion` (`ventas.service.js`)
- [ ] `GET` de detalle con ítems para cotización y orden (hoy el listado no trae los renglones, solo la cabecera) — necesario para la Fase 2 y 3
- [ ] Usar `Tercero.responsabilidadesFiscales` y `tipoPersona` para automatizar el cálculo de retención en la fuente (formulario 350) — hoy son solo datos capturados, no alimentan ningún cálculo todavía
- [ ] Consecutivos (`generarConsecutivo`): reemplazar el conteo simple por una tabla de secuencias con bloqueo transaccional antes de tener varios usuarios creando documentos al mismo tiempo
SCRIPTEOF
echo "OK  README.md"

echo ""
echo "Listo. Campos nuevos de Terceros, Cotizaciones y Ordenes de Adquisicion aplicados."
echo "IMPORTANTE: como hay tablas nuevas (cotizacion_items, orden_compra_items) y columnas"
echo "nuevas en terceros/cotizaciones/ordenes_compra, verifica que NODE_ENV=development"
echo "siga activo para que Sequelize las cree solas al reiniciar."
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Ampliar Terceros, Cotizaciones y Ordenes de Adquisicion con campos reales\""
echo "  git push"
