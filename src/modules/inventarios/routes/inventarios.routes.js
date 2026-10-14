const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const c = require('../controllers/inventarios.controller');

// Ver: todos los roles. Registrar productos y movimientos: dueño, contador y auxiliar.
// Anular un movimiento: dueño y contador (el revisor solo mira).
const puedeRegistrar = authorize('contador', 'dueño', 'auxiliar');
const puedeAnular = authorize('contador', 'dueño');

router.get('/opciones', c.opciones);
router.get('/productos', c.listarProductos);
router.post('/productos', puedeRegistrar, c.crearProducto);
router.patch('/productos/:id', puedeRegistrar, c.actualizarProducto);
router.get('/productos/:id/kardex', c.kardex);
router.get('/productos/:id/kardex.csv', c.kardexCsv);
router.get('/movimientos', c.listarMovimientos);
router.post('/movimientos', puedeRegistrar, c.crearMovimiento);
router.post('/movimientos/:id/anular', puedeAnular, c.anularMovimiento);
router.get('/valoracion', c.valoracion);
router.get('/valoracion.csv', c.valoracionCsv);

module.exports = router;
