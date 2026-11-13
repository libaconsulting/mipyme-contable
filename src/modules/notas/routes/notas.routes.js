const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const c = require('../controllers/notas.controller');

// Cargar una nota: contador, dueño o auxiliar (como las facturas); anular: solo contador o dueño.
const puedeRegistrar = authorize('contador', 'dueño', 'auxiliar');
const puedeAnular = authorize('contador', 'dueño');

// GET /api/notas?lado=compra|venta&tipo=credito|debito&estado=activa|anulada
router.get('/', c.listar);

// POST /api/notas/xml/previsualizar  (lee el XML, no guarda nada)
router.post('/xml/previsualizar', puedeRegistrar, c.previsualizar);

// POST /api/notas/xml  (registra y contabiliza la nota)
router.post('/xml', puedeRegistrar, c.registrar);

// GET /api/notas/documento/:docTipo/:docId  (notas de una factura de compra o de venta)
router.get('/documento/:docTipo/:docId', c.deDocumento);

// GET /api/notas/:id/xml  (descarga el XML guardado)
router.get('/:id/xml', c.descargarXml);

// POST /api/notas/:id/anular
router.post('/:id/anular', puedeAnular, c.anular);

// GET /api/notas/:id  (detalle + asiento)
router.get('/:id', c.obtener);

module.exports = router;
