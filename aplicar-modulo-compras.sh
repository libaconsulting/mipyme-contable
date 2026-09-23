#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  echo "Ve primero a la carpeta mipyme-contable (cd mipyme-contable) y vuelve a correr este script."
  exit 1
fi

mkdir -p src/modules/compras/models src/modules/compras/services \
  src/modules/compras/controllers src/modules/compras/routes

cat > src/modules/compras/models/OrdenCompra.js << 'EOF'
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
  fechaRequerida: { type: DataTypes.DATEONLY },
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
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
}, {
  tableName: 'ordenes_compra',
});

module.exports = OrdenCompra;
EOF
echo "OK  src/modules/compras/models/OrdenCompra.js"

cat > src/modules/compras/models/FacturaCompra.js << 'EOF'
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
  estadoConciliacion: {
    type: DataTypes.ENUM('pendiente', 'contabilizada', 'objetada'),
    defaultValue: 'pendiente',
  },
}, {
  tableName: 'facturas_compra',
});

module.exports = FacturaCompra;
EOF
echo "OK  src/modules/compras/models/FacturaCompra.js"

cat > src/modules/compras/models/DocumentoSoporteAdquisicion.js << 'EOF'
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
EOF
echo "OK  src/modules/compras/models/DocumentoSoporteAdquisicion.js"

cat > src/integrations/adapters/documentoSoporteAdapter.js << 'EOF'
// Interfaz única hacia el proveedor tecnológico para EMITIR el
// documento soporte — aquí SOMOS nosotros quienes lo generan, igual que
// una factura de venta (ver la nota en el modelo
// DocumentoSoporteAdquisicion). Mismo patrón que facturacionAdapter.js.

require('dotenv').config();

async function emitirDocumentoSoporte(documento) {
  // TODO: mapear "documento" al formato que exige la API del proveedor
  // contratado (usar DOC_SOPORTE_API_URL / DOC_SOPORTE_API_KEY del .env)
  // y hacer el POST real, igual que en facturacionAdapter.emitirFactura.
  return { idTransaccionExterna: `PENDIENTE-${documento.id}` };
}

module.exports = { emitirDocumentoSoporte };
EOF
echo "OK  src/integrations/adapters/documentoSoporteAdapter.js"

cat > src/modules/compras/services/compras.service.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const OrdenCompra = require('../models/OrdenCompra');
const FacturaCompra = require('../models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const documentoSoporteAdapter = require('../../../integrations/adapters/documentoSoporteAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

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
  convertirOrdenEnFactura,
  registrarFacturaRecibida,
  emitirDocumentoSoporte,
  confirmarDocumentoSoporteEmitido,
};
EOF
echo "OK  src/modules/compras/services/compras.service.js"

cat > src/modules/compras/controllers/compras.controller.js << 'EOF'
const comprasService = require('../services/compras.service');

async function convertirOrden(req, res) {
  try {
    const factura = await comprasService.convertirOrdenEnFactura(
      req.params.ordenId,
      req.usuario
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function emitirDocumentoSoporte(req, res) {
  try {
    const documento = await comprasService.emitirDocumentoSoporte(req.body, req.usuario);
    res.status(201).json(documento);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { convertirOrden, emitirDocumentoSoporte };
EOF
echo "OK  src/modules/compras/controllers/compras.controller.js"

cat > src/modules/compras/routes/compras.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const comprasController = require('../controllers/compras.controller');

// POST /api/compras/ordenes/:ordenId/convertir
router.post('/ordenes/:ordenId/convertir', comprasController.convertirOrden);

// POST /api/compras/documento-soporte
router.post('/documento-soporte', comprasController.emitirDocumentoSoporte);

// TODO: CRUD completo de órdenes de compra/servicio y facturas de
// compra, siguiendo este mismo patrón.

module.exports = router;
EOF
echo "OK  src/modules/compras/routes/compras.routes.js"

cat > src/modules/compras/README.md << 'EOF'
# Módulo: compras

Construido, siguiendo el mismo patrón que `ventas`. Dos flujos distintos
conviven aquí — no los confundas al extenderlo:

- **Factura recibida** (`FacturaCompra`): el proveedor SÍ factura
  electrónicamente. El documento llega desde afuera ya validado (webhook
  `/webhooks/compras`) y se contabiliza directo.
- **Documento soporte** (`DocumentoSoporteAdquisicion`): el proveedor NO
  factura. Aquí SOMOS nosotros quienes generamos y emitimos el
  documento, igual que una factura de venta (`documentoSoporteAdapter.js`
  → webhook `/webhooks/documento-soporte`).

`OrdenCompra` es pre-transaccional (no genera asiento) hasta que se
convierte en `FacturaCompra`, igual que `Cotizacion` en ventas.

Pendiente: CRUD completo de órdenes, y confirmar con el proveedor
tecnológico que se contrate la mecánica exacta para RECIBIR facturas
(RADIAN vs. notificación directa del proveedor).
EOF
echo "OK  src/modules/compras/README.md"

cat > src/core/services/motorAsientos.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const Asiento = require('../models/Asiento');
const Movimiento = require('../models/Movimiento');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');
const PeriodoContable = require('../models/PeriodoContable');

// Resuelve el periodo contable vigente de la empresa (abierto o en_cierre)
// para que ningún módulo operativo tenga que averiguarlo por su cuenta.
// Requiere que exista al menos un PeriodoContable creado de antemano —
// sin eso, ningún evento se puede contabilizar (a propósito).
async function obtenerPeriodoVigente(empresaId) {
  const periodo = await PeriodoContable.findOne({
    where: { empresaId, estado: { [Op.in]: ['abierto', 'en_cierre'] } },
    order: [['fechaInicio', 'DESC']],
  });

  if (!periodo) {
    throw new Error(
      'No hay un periodo contable abierto para esta empresa. Crea uno antes de contabilizar.'
    );
  }

  return periodo;
}

/**
 * Punto de entrada único que usan TODOS los módulos operativos
 * (ventas, compras, nómina, activos fijos, tesorería) para contabilizar
 * un evento. Ningún módulo escribe asientos directamente.
 *
 * @param {Object} evento
 * @param {string} evento.empresaId
 * @param {string} [evento.periodoContableId] - si no se pasa, se resuelve solo
 * @param {string} evento.tipoEvento     - ej: 'factura_venta_credito'
 * @param {string} evento.origenModulo   - 'ventas' | 'compras' | 'nomina' | ...
 * @param {string} evento.origenId       - id del documento que originó el evento
 * @param {number} evento.valor
 * @param {string} [evento.terceroId]
 * @param {string} [evento.usuarioId]
 */
async function contabilizarEvento(evento) {
  const regla = await ReglaContabilizacion.findOne({
    where: { empresaId: evento.empresaId, eventoOrigen: evento.tipoEvento },
  });

  if (!regla) {
    throw new Error(
      `No existe regla de contabilización para el evento "${evento.tipoEvento}". ` +
      `Configúrala en Plan de cuentas > Reglas antes de continuar.`
    );
  }

  // Nivel "manual" nunca se contabiliza solo: queda en cola para el contador.
  if (regla.nivelAutomatizacion === 'manual') {
    return { requiereRevision: true, regla };
  }

  const periodoContableId =
    evento.periodoContableId || (await obtenerPeriodoVigente(evento.empresaId)).id;

  const asiento = await Asiento.create({
    id: uuidv4(),
    empresaId: evento.empresaId,
    periodoContableId,
    fecha: evento.fecha || new Date(),
    origenModulo: evento.origenModulo,
    origenId: evento.origenId,
    estado: regla.nivelAutomatizacion === 'asistido' ? 'borrador' : 'contabilizado',
    usuarioId: evento.usuarioId,
  });

  await Movimiento.bulkCreate([
    {
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: regla.cuentaDebitoId,
      terceroId: evento.terceroId,
      debito: evento.valor,
      credito: 0,
    },
    {
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: regla.cuentaCreditoId,
      terceroId: evento.terceroId,
      debito: 0,
      credito: evento.valor,
    },
  ]);

  return { requiereRevision: regla.nivelAutomatizacion === 'asistido', asiento };
}

module.exports = { contabilizarEvento };
EOF
echo "OK  src/core/services/motorAsientos.js"

cat > src/modules/ventas/services/ventas.service.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const Cotizacion = require('../models/Cotizacion');
const FacturaVenta = require('../models/FacturaVenta');
const facturacionAdapter = require('../../../integrations/adapters/facturacionAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

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

module.exports = { convertirCotizacionEnFactura, confirmarFacturaAceptada };
EOF
echo "OK  src/modules/ventas/services/ventas.service.js"

cat > src/core/models/index.js << 'EOF'
// Punto único donde se registran TODOS los modelos del núcleo contable.
// server.js importa este archivo antes de sincronizar la base de datos,
// así que ningún modelo se queda afuera por no estar "require"ado en
// alguna cadena de rutas activa. A medida que agreguemos modelos a los
// módulos operativos (nómina, etc.), se suman aquí también.

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
const OrdenCompra = require('../../modules/compras/models/OrdenCompra');
const FacturaCompra = require('../../modules/compras/models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../../modules/compras/models/DocumentoSoporteAdquisicion');

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
  OrdenCompra,
  FacturaCompra,
  DocumentoSoporteAdquisicion,
};
EOF
echo "OK  src/core/models/index.js"

cat > src/routes/index.js << 'EOF'
const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const comprasRoutes = require('../modules/compras/routes/compras.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro

router.use('/ventas', authenticate, ventasRoutes); // requiere sesión
router.use('/compras', authenticate, comprasRoutes); // requiere sesión

// TODO: montar aquí las rutas de inventarios, nomina, activosFijos y
// tesoreria siguiendo el mismo patrón (todas protegidas con authenticate).

module.exports = router;
EOF
echo "OK  src/routes/index.js"

cat > src/integrations/webhooks/proveedorTecnologicoWebhook.js << 'EOF'
const express = require('express');
const router = express.Router();
const ventasService = require('../../modules/ventas/services/ventas.service');
const comprasService = require('../../modules/compras/services/compras.service');

// El proveedor tecnológico llama esta URL cuando la DIAN valida (o rechaza)
// el documento. No requiere procesos en segundo plano: es una petición
// HTTP entrante normal, que corre perfectamente en hosting administrado.
//
// POST /webhooks/facturacion
router.post('/facturacion', async (req, res) => {
  try {
    const { facturaId, estado, cufe, xmlUrl, pdfUrl } = req.body;

    if (estado === 'aceptada') {
      await ventasService.confirmarFacturaAceptada(facturaId, { cufe, xmlUrl, pdfUrl });
    }
    // TODO: manejar estado === 'rechazada' (notificar al usuario, no contabilizar)

    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// El proveedor tecnológico (o RADIAN) avisa cuando llega una factura de
// un proveedor a nuestro nombre. Ver el TODO en compras.service.js sobre
// la mecánica exacta de recepción, pendiente de confirmar con el
// proveedor que se contrate.
//
// POST /webhooks/compras
router.post('/compras', async (req, res) => {
  try {
    await comprasService.registrarFacturaRecibida(req.body);
    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Confirmación de que la DIAN validó un documento soporte que NOSOTROS
// emitimos (compra a proveedor no obligado a facturar).
//
// POST /webhooks/documento-soporte
router.post('/documento-soporte', async (req, res) => {
  try {
    const { documentoId, estado, cufe, xmlUrl } = req.body;

    if (estado === 'aceptado') {
      await comprasService.confirmarDocumentoSoporteEmitido(documentoId, { cufe, xmlUrl });
    }

    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// TODO: /webhooks/nomina sigue el mismo patrón que /webhooks/facturacion

module.exports = router;
EOF
echo "OK  src/integrations/webhooks/proveedorTecnologicoWebhook.js"

cat > README.md << 'EOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
MySQL/MariaDB).

## Arquitectura

```
src/
├── server.js                 # Punto de entrada
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa, Tercero, PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       └── cierrePeriodo.js    Máquina de estados del cierre mensual
├── modules/                  # Módulos operativos (capa transaccional)
│   ├── ventas/                 Completo — patrón de referencia
│   ├── compras/                Completo — mismo patrón que ventas
│   ├── inventarios/            Pendiente
│   ├── nomina/                 Pendiente
│   ├── activosFijos/           Pendiente
│   └── tesoreria/              Pendiente
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
├── middleware/                # Auth, manejo de errores (pendiente)
└── routes/                   # Router raíz
```

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de MySQL y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Hosting de apps web → Node.js → conectar el repositorio de GitHub.
2. hPanel → Bases de datos MySQL → crear la base y el usuario, y completar `.env`.
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

## Pendientes inmediatos

- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] Migraciones de Sequelize (`sequelize-cli`) para las tablas ya modeladas
- [ ] Completar los módulos de inventarios, nómina, activos fijos y tesorería (protegidos con `authenticate`, igual que ventas y compras)
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] Seed de: al menos una `Empresa`, un `PeriodoContable` abierto, `PlanCuentas` y `ReglaContabilizacion` por defecto — sin esto, `motorAsientos` no tiene con qué contabilizar
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
EOF
echo "OK  README.md"

echo ""
echo "Listo. Todos los archivos del módulo de Compras y el README quedaron creados/actualizados."
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Agregar modulo de compras y corregir motor de asientos\""
echo "  git push"
