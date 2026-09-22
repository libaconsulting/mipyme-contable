const express = require('express');
const router = express.Router();
const ventasController = require('../controllers/ventas.controller');

// POST /api/ventas/cotizaciones/:cotizacionId/convertir
router.post('/cotizaciones/:cotizacionId/convertir', ventasController.convertirCotizacion);

// TODO: CRUD completo de cotizaciones y facturas de venta siguiendo este patrón

module.exports = router;
