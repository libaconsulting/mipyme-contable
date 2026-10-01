#!/bin/bash
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  exit 1
fi

cat > src/core/services/consecutivos.js << 'SCRIPTEOF'
const { Op } = require('sequelize');
const sequelize = require('../../config/database');

// Genera un consecutivo legible tipo "COT-2026-0001", contando cuántos
// documentos de ese prefijo existen ya este año para la empresa.
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

// Genera el consecutivo y ejecuta TODA la creación (encabezado + ítems +
// lo que haga falta) dentro de una transacción real: o se guarda todo,
// o no se guarda nada — así nunca queda un encabezado "huérfano" con un
// consecutivo gastado si algo falla más adelante en el mismo proceso
// (por ejemplo, al crear un ítem). Además reintenta automáticamente si
// dos creaciones casi simultáneas chocan en el mismo número.
//
// `crear(consecutivo, transaction)` debe hacer TODO el trabajo —
// Cotizacion.create(..., { transaction }), CotizacionItem.create(...,
// { transaction }), etc. — pasando siempre esa misma transacción.
async function crearConSecutivoUnico(Modelo, empresaId, prefijo, crear) {
  const MAX_INTENTOS = 5;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    const consecutivo = await generarConsecutivo(empresaId, prefijo, Modelo);

    try {
      return await sequelize.transaction((transaction) => crear(consecutivo, transaction));
    } catch (error) {
      const chocoPorConsecutivo =
        error.name === 'SequelizeUniqueConstraintError' &&
        Array.isArray(error.errors) &&
        error.errors.some((e) => e.path === 'consecutivo');

      if (!chocoPorConsecutivo || intento === MAX_INTENTOS) {
        throw error;
      }
      // La transacción completa ya hizo rollback sola — no queda nada
      // huérfano. Se reintenta con el siguiente número, sin que el
      // usuario tenga que hacer nada.
    }
  }
}

module.exports = { generarConsecutivo, crearConSecutivoUnico };
SCRIPTEOF
echo "OK  src/core/services/consecutivos.js"

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
  consecutivo: { type: DataTypes.STRING(30) },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  formaPago: { type: DataTypes.TEXT },
  observaciones: { type: DataTypes.TEXT },
  contactoNombre: { type: DataTypes.TEXT },
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
  // El consecutivo es único DENTRO de cada empresa, no en toda la tabla
  // — dos empresas distintas pueden tener cada una su propia "COT-2026-0001".
  indexes: [{ unique: true, fields: ['empresa_id', 'consecutivo'] }],
});

module.exports = Cotizacion;
SCRIPTEOF
echo "OK  src/modules/ventas/models/Cotizacion.js"

cat > src/modules/ventas/services/ventas.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const Cotizacion = require('../models/Cotizacion');
const CotizacionItem = require('../models/CotizacionItem');
const FacturaVenta = require('../models/FacturaVenta');
const facturacionAdapter = require('../../../integrations/adapters/facturacionAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { crearConSecutivoUnico } = require('../../../core/services/consecutivos');

// Crea una cotización nueva en estado "borrador". Si vienen "items"
// (arreglo de { concepto, cantidad, unidadMedida, valorUnitario,
// tipoImpuesto, impuestoPorcentaje }), se crean como CotizacionItem y
// el subtotal/impuesto/total se calculan solos — no se confía en un
// total mandado a mano. Si no vienen items (compatibilidad hacia
// atrás), se respeta el "total" que mande el cliente.
async function crearCotizacion(datos, usuario) {
  return crearConSecutivoUnico(Cotizacion, usuario.empresaId, 'COT', async (consecutivo, transaction) => {
    const cotizacion = await Cotizacion.create(
      {
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
      },
      { transaction }
    );

    if (Array.isArray(datos.items) && datos.items.length > 0) {
      let subtotal = 0;
      let impuestoTotal = 0;

      for (const item of datos.items) {
        const cantidad = Number(item.cantidad);
        const valorUnitario = Number(item.valorUnitario);
        const tipoImpuesto = item.tipoImpuesto || 'iva';
        const impuestoPorcentaje = item.impuestoPorcentaje ?? 19;
        const valorTotal = cantidad * valorUnitario;
        const impuestoValor = valorTotal * (impuestoPorcentaje / 100);

        await CotizacionItem.create(
          {
            id: uuidv4(),
            cotizacionId: cotizacion.id,
            concepto: item.concepto,
            cantidad,
            unidadMedida: item.unidadMedida || 'UND',
            valorUnitario,
            tipoImpuesto,
            impuestoPorcentaje,
            valorTotal,
            impuestoValor,
          },
          { transaction }
        );

        subtotal += valorTotal;
        impuestoTotal += impuestoValor;
      }

      // Si aplica AIU, el impuesto se recalcula al 19% sobre (subtotal +
      // AIU) en vez de sumar el impuesto real de cada ítem — es la
      // convención más común en contratos de obra/servicios, pero asume
      // IVA general y no contempla ítems con Impoconsumo o exentos
      // mezclados en la misma cotización con AIU. Validar contra el tipo
      // de contrato específico antes de confiar en esto a ciegas.
      let baseImpuesto = subtotal;
      let impuesto = impuestoTotal;
      if (cotizacion.aplicaAiu) {
        const admin = subtotal * (Number(datos.aiuAdministracion || 0) / 100);
        const imprevistos = subtotal * (Number(datos.aiuImprevistos || 0) / 100);
        const utilidad = subtotal * (Number(datos.aiuUtilidad || 0) / 100);
        baseImpuesto = subtotal + admin + imprevistos + utilidad;
        impuesto = baseImpuesto * 0.19;
      }
      const total = baseImpuesto + impuesto;

      await cotizacion.update({ subtotal, iva: impuesto, total }, { transaction });
    }

    return cotizacion;
  });
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

// Cotización con sus ítems — para "Ver ítems" en el frontend y, más
// adelante, la plantilla imprimible.
async function obtenerCotizacion(id, usuario) {
  const cotizacion = await Cotizacion.findOne({
    where: { id, empresaId: usuario.empresaId },
  });
  if (!cotizacion) return null;

  const items = await CotizacionItem.findAll({ where: { cotizacionId: id } });
  return { ...cotizacion.toJSON(), items };
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  listarCotizaciones,
  listarFacturas,
  obtenerCotizacion,
  convertirCotizacionEnFactura,
  confirmarFacturaAceptada,
};
SCRIPTEOF
echo "OK  src/modules/ventas/services/ventas.service.js"

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
  consecutivo: { type: DataTypes.STRING(30) },
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
  indexes: [{ unique: true, fields: ['empresa_id', 'consecutivo'] }],
});

module.exports = OrdenCompra;
SCRIPTEOF
echo "OK  src/modules/compras/models/OrdenCompra.js"

cat > src/modules/compras/services/compras.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const OrdenCompra = require('../models/OrdenCompra');
const OrdenCompraItem = require('../models/OrdenCompraItem');
const FacturaCompra = require('../models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const documentoSoporteAdapter = require('../../../integrations/adapters/documentoSoporteAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { crearConSecutivoUnico } = require('../../../core/services/consecutivos');

// Crea una orden de adquisición (bienes o servicios) en "borrador". Si
// vienen "items", se crean como OrdenCompraItem y subtotal/IVA/total se
// calculan solos. Sin items, respeta el subtotal/iva/total a mano por
// compatibilidad con el formulario actual.
async function crearOrden(datos, usuario) {
  return crearConSecutivoUnico(OrdenCompra, usuario.empresaId, 'ODA', async (consecutivo, transaction) => {
    const orden = await OrdenCompra.create(
      {
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
      },
      { transaction }
    );

    if (Array.isArray(datos.items) && datos.items.length > 0) {
      let subtotal = 0;
      let iva = 0;

      for (const item of datos.items) {
        const cantidad = Number(item.cantidad);
        const valorUnitario = Number(item.valorUnitario);
        const tipoImpuesto = item.tipoImpuesto || 'iva';
        const impuestoPorcentaje = item.impuestoPorcentaje ?? 19;
        const valorTotal = cantidad * valorUnitario;
        const impuestoValor = valorTotal * (impuestoPorcentaje / 100);

        await OrdenCompraItem.create(
          {
            id: uuidv4(),
            ordenCompraId: orden.id,
            concepto: item.concepto,
            cantidad,
            unidadMedida: item.unidadMedida || 'UND',
            valorUnitario,
            tipoImpuesto,
            impuestoPorcentaje,
            valorTotal,
            impuestoValor,
          },
          { transaction }
        );

        subtotal += valorTotal;
        iva += impuestoValor;
      }

      await orden.update({ subtotal, iva, total: subtotal + iva }, { transaction });
    }

    return orden;
  });
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

## Aprovisionar una empresa nueva

Desde la pantalla de login, "¿Primera vez? Crear empresa y usuario" abre
un flujo de dos pasos: `POST /api/empresas` crea la empresa (razón
social, NIT, régimen tributario —ordinario, RST o especial—,
responsable de IVA, correo, teléfono, dirección, departamento,
municipio, representante legal y su documento, código CIIU y matrícula
mercantil), luego `POST /api/auth/registro` crea su primer usuario (rol
`contador` o `dueño` recomendado). `PATCH /api/empresas/:id` permite
editar estos datos después. Los tres endpoints quedan abiertos por
ahora — ver el TODO en `src/routes/empresas.routes.js` antes de tener
más de un puñado de empresas reales.

Al iniciar sesión, el panel **Inicio** (pestaña por defecto, ya no
Terceros) saluda por nombre, muestra la razón social de la empresa, y
presenta los nueve módulos como tarjetas — clic en cualquiera navega
directo a esa sección.

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
- [ ] `DELETE` de terceros (crear, listar y editar ya existen; falta borrar)
- [ ] Vincular `MovimientoInventario` con los ítems reales de `FacturaVenta`/`FacturaCompra` — hoy las entradas y salidas se registran manualmente por API, no automático desde una venta
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Reemplazar los `prompt()` del navegador (agregar empleado a nómina, entradas/salidas/ajustes de inventario) por formularios modales propios en el frontend; agregar edición/borrado en general
- [ ] Confirmar que `www.libanielconsulting.com` resuelve al mismo sitio que `libanielconsulting.com` (revisar en hPanel → Dominios, o agregar la redirección si falta)
- [ ] Definir de verdad los servicios 02 y 03 de la página institucional (`public/index.html`) y reemplazar el `mailto:contacto@libanielconsulting.com` por el correo real de la firma
- [ ] **Fase 2 — ítems en el frontend, parte 2**: Cotizaciones ya tiene tabla dinámica de ítems (concepto, cantidad, UM, valor unitario, IVA), AIU y "Ver ítems" por fila. Falta replicar exactamente el mismo patrón en Órdenes de Adquisición (`OrdenCompraItem` ya existe en el backend, solo falta la UI)
- [ ] Aplicar `mensajeError()` (`src/core/utils/mensajeError.js`) en los demás controladores — hoy `ventas.controller.js` y `compras.controller.js` lo usan; nómina, inventarios, activos fijos y tesorería todavía devuelven el mensaje genérico de Sequelize
- [ ] La opción "Otro (definir %)" de impuesto en el ítem se guarda como `tipoImpuesto: 'iva'` con el porcentaje manual — no distingue si en realidad era un Impoconsumo con tarifa distinta a 4/8/16%. Si eso resulta ser un caso frecuente, vale la pena dejar elegir tipo Y porcentaje por separado en vez de un solo desplegable combinado
- [ ] El cálculo de IVA cuando `aplicaAiu = true` sigue asumiendo 19% general sobre (subtotal + AIU) sin importar el `tipoImpuesto` real de los ítems — no contempla todavía una cotización con AIU que mezcle ítems de Impoconsumo o exentos
- [ ] **Fase 3 — plantilla imprimible/PDF** de cotización y orden de adquisición, replicando el formato real de la firma (membrete, datos del cliente/proveedor, ítems, AIU cuando aplique, firmas)
- [ ] Validar con un caso real si el IVA de una cotización con AIU debe calcularse sobre (subtotal + AIU) como quedó programado, o de otra forma según el tipo de contrato — ver la nota en `crearCotizacion` (`ventas.service.js`)
- [ ] `GET /compras/ordenes/:id` con ítems (el de cotizaciones ya existe: `GET /ventas/cotizaciones/:id`) — necesario para "Ver ítems" y la Fase 3 en Órdenes
- [ ] Usar `Tercero.responsabilidadesFiscales` y `tipoPersona` para automatizar el cálculo de retención en la fuente (formulario 350) — hoy son solo datos capturados, no alimentan ningún cálculo todavía
- [ ] Consecutivos: ya son únicos por empresa (índice compuesto `empresa_id + consecutivo`, no `consecutivo` global) y toda la creación vive en una transacción real — un fallo a mitad de camino ya no deja un encabezado huérfano con el número gastado. Sigue sin bloqueo transaccional de secuencia bajo concurrencia muy alta (una tabla de secuencias con `SELECT ... FOR UPDATE` sería la solución definitiva si el volumen lo exige)
SCRIPTEOF
echo "OK  README.md"

echo ""
echo "Listo. Transaccion real + consecutivo unico por empresa (no global)."
echo "IMPORTANTE: despues de desplegar, corre el SQL que te doy en Supabase"
echo "para garantizar que la restriccion vieja (global) quede reemplazada."
echo "  git add ."
echo "  git commit -m \"Hacer consecutivo unico por empresa y envolver creacion en transaccion\""
echo "  git push"
