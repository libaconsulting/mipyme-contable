const express = require('express');
const router = express.Router();
const c = require('../controllers/inventarios.controller');

router.get('/productos', c.listarProductos);
router.post('/productos', c.crearProducto);
router.get('/movimientos', c.listarMovimientos);
router.post('/entradas', c.registrarEntrada);
router.post('/salidas', c.registrarSalida);
router.post('/ajustes', c.registrarAjuste);

module.exports = router;
