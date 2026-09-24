const express = require('express');
const router = express.Router();
const ventasController = require('../controllers/ventas.controller');

// GET /api/ventas/cotizaciones
router.get('/cotizaciones', ventasController.listarCotizaciones);

// GET /api/ventas/facturas
router.get('/facturas', ventasController.listarFacturas);

// GET /api/ventas/cotizaciones/:id (detalle con ítems)
router.get('/cotizaciones/:id', ventasController.obtenerCotizacion);

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
