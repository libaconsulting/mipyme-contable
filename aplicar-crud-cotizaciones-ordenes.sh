#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  echo "Ve primero a la carpeta mipyme-contable (cd mipyme-contable) y vuelve a correr este script."
  exit 1
fi

cat > src/routes/terceros.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Tercero = require('../core/models/Tercero');

// POST /api/terceros
router.post('/', async (req, res) => {
  try {
    const { tipo, identificacion, nombre, regimenTributario, email } = req.body;
    const tercero = await Tercero.create({
      id: uuidv4(),
      empresaId: req.usuario.empresaId,
      tipo,
      identificacion,
      nombre,
      regimenTributario,
      email,
    });
    res.status(201).json(tercero);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/terceros (opcionalmente filtrado por ?tipo=cliente|proveedor|empleado|otro)
router.get('/', async (req, res) => {
  try {
    const where = { empresaId: req.usuario.empresaId };
    if (req.query.tipo) where.tipo = req.query.tipo;
    const terceros = await Tercero.findAll({ where });
    res.json(terceros);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
EOF
echo "OK  src/routes/terceros.routes.js"

cat > src/modules/ventas/services/ventas.service.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const Cotizacion = require('../models/Cotizacion');
const FacturaVenta = require('../models/FacturaVenta');
const facturacionAdapter = require('../../../integrations/adapters/facturacionAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Crea una cotización nueva en estado "borrador".
async function crearCotizacion(datos, usuario) {
  const cotizacion = await Cotizacion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    vendedorId: usuario.id,
    fecha: datos.fecha || new Date(),
    fechaVencimiento: datos.fechaVencimiento,
    estado: 'borrador',
    total: datos.total,
  });
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
  convertirCotizacionEnFactura,
  confirmarFacturaAceptada,
};
EOF
echo "OK  src/modules/ventas/services/ventas.service.js"

cat > src/modules/ventas/controllers/ventas.controller.js << 'EOF'
const ventasService = require('../services/ventas.service');

async function crearCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.crearCotizacion(req.body, req.usuario);
    res.status(201).json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function enviarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.enviarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function aceptarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.aceptarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function rechazarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.rechazarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function convertirCotizacion(req, res) {
  try {
    const factura = await ventasService.convertirCotizacionEnFactura(
      req.params.cotizacionId,
      req.usuario?.id
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  convertirCotizacion,
};
EOF
echo "OK  src/modules/ventas/controllers/ventas.controller.js"

cat > src/modules/ventas/routes/ventas.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const ventasController = require('../controllers/ventas.controller');

// POST /api/ventas/cotizaciones
router.post('/cotizaciones', ventasController.crearCotizacion);

// PATCH /api/ventas/cotizaciones/:id/enviar
router.patch('/cotizaciones/:id/enviar', ventasController.enviarCotizacion);

// PATCH /api/ventas/cotizaciones/:id/aceptar
router.patch('/cotizaciones/:id/aceptar', ventasController.aceptarCotizacion);

// PATCH /api/ventas/cotizaciones/:id/rechazar
router.patch('/cotizaciones/:id/rechazar', ventasController.rechazarCotizacion);

// POST /api/ventas/cotizaciones/:cotizacionId/convertir
router.post('/cotizaciones/:cotizacionId/convertir', ventasController.convertirCotizacion);

module.exports = router;
EOF
echo "OK  src/modules/ventas/routes/ventas.routes.js"

cat > src/modules/compras/services/compras.service.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const OrdenCompra = require('../models/OrdenCompra');
const FacturaCompra = require('../models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const documentoSoporteAdapter = require('../../../integrations/adapters/documentoSoporteAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Crea una orden de compra/servicio nueva en estado "borrador".
async function crearOrden(datos, usuario) {
  const orden = await OrdenCompra.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    tipo: datos.tipo || 'bienes',
    fecha: datos.fecha || new Date(),
    fechaRequerida: datos.fechaRequerida,
    estado: 'borrador',
    subtotal: datos.subtotal,
    iva: datos.iva || 0,
    total: datos.total,
  });
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
  convertirOrdenEnFactura,
  registrarFacturaRecibida,
  emitirDocumentoSoporte,
  confirmarDocumentoSoporteEmitido,
};
EOF
echo "OK  src/modules/compras/services/compras.service.js"

cat > src/modules/compras/controllers/compras.controller.js << 'EOF'
const comprasService = require('../services/compras.service');

async function crearOrden(req, res) {
  try {
    const orden = await comprasService.crearOrden(req.body, req.usuario);
    res.status(201).json(orden);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function aprobarOrden(req, res) {
  try {
    const orden = await comprasService.aprobarOrden(req.params.id, req.usuario);
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

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

module.exports = { crearOrden, aprobarOrden, convertirOrden, emitirDocumentoSoporte };
EOF
echo "OK  src/modules/compras/controllers/compras.controller.js"

cat > src/modules/compras/routes/compras.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const comprasController = require('../controllers/compras.controller');

// POST /api/compras/ordenes
router.post('/ordenes', comprasController.crearOrden);

// PATCH /api/compras/ordenes/:id/aprobar
router.patch('/ordenes/:id/aprobar', comprasController.aprobarOrden);

// POST /api/compras/ordenes/:ordenId/convertir
router.post('/ordenes/:ordenId/convertir', comprasController.convertirOrden);

// POST /api/compras/documento-soporte
router.post('/documento-soporte', comprasController.emitirDocumentoSoporte);

module.exports = router;
EOF
echo "OK  src/modules/compras/routes/compras.routes.js"

cat > src/routes/index.js << 'EOF'
const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const seedRoutes = require('./seed.routes');
const tercerosRoutes = require('./terceros.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const comprasRoutes = require('../modules/compras/routes/compras.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro
router.use('/seed', seedRoutes); // el propio router exige authenticate + authorize

router.use('/terceros', authenticate, tercerosRoutes); // requiere sesión
router.use('/ventas', authenticate, ventasRoutes); // requiere sesión
router.use('/compras', authenticate, comprasRoutes); // requiere sesión

// TODO: montar aquí las rutas de inventarios, nomina, activosFijos y
// tesoreria siguiendo el mismo patrón (todas protegidas con authenticate).

module.exports = router;
EOF
echo "OK  src/routes/index.js"

echo ""
echo "Listo. CRUD de terceros, cotizaciones y órdenes de compra creado/actualizado."
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Agregar CRUD de terceros, cotizaciones y ordenes de compra\""
echo "  git push"
