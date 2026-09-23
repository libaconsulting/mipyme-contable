const express = require('express');
const router = express.Router();
const comprasController = require('../controllers/compras.controller');

// GET /api/compras/ordenes
router.get('/ordenes', comprasController.listarOrdenes);

// GET /api/compras/facturas
router.get('/facturas', comprasController.listarFacturas);

// POST /api/compras/ordenes
router.post('/ordenes', comprasController.crearOrden);

// PATCH /api/compras/ordenes/:id/aprobar
router.patch('/ordenes/:id/aprobar', comprasController.aprobarOrden);

// POST /api/compras/ordenes/:ordenId/convertir
router.post('/ordenes/:ordenId/convertir', comprasController.convertirOrden);

// POST /api/compras/documento-soporte
router.post('/documento-soporte', comprasController.emitirDocumentoSoporte);

module.exports = router;
