const express = require('express');
const router = express.Router();
const c = require('../controllers/tesoreria.controller');

router.get('/cuentas', c.listarCuentas);
router.post('/cuentas', c.crearCuenta);
router.get('/movimientos', c.listarMovimientos);
router.post('/movimientos', c.registrarMovimiento);
router.post('/movimientos/:id/conciliar', c.conciliarMovimiento);

module.exports = router;
