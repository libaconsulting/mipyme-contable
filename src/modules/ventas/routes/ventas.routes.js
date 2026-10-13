const express = require('express');
const router = express.Router();
const ventasController = require('../controllers/ventas.controller');

// GET /api/ventas/cotizaciones
router.get('/cotizaciones', ventasController.listarCotizaciones);

// GET /api/ventas/facturas
router.get('/facturas', ventasController.listarFacturas);

// Factura de venta emitida en otro sistema (Siigo): se carga su XML para contabilizarla
// POST /api/ventas/facturas/xml/previsualizar
router.post('/facturas/xml/previsualizar', ventasController.previsualizarFacturaVentaXml);

// POST /api/ventas/facturas/xml
router.post('/facturas/xml', ventasController.registrarFacturaVentaXml);

// GET /api/ventas/facturas/:id/xml
router.get('/facturas/:id/xml', ventasController.descargarXmlFactura);

// GET /api/ventas/facturas/:id
router.get('/facturas/:id', ventasController.obtenerFactura);

// GET /api/ventas/cotizaciones/:id (detalle con ítems)
router.get('/cotizaciones/:id', ventasController.obtenerCotizacion);

// PATCH /api/ventas/cotizaciones/:id (editar — solo en borrador)
router.patch('/cotizaciones/:id', ventasController.actualizarCotizacion);

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
