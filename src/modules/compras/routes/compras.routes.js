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
