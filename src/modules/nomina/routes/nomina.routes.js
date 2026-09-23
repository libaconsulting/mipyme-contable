const express = require('express');
const router = express.Router();
const nominaController = require('../controllers/nomina.controller');

// POST /api/nomina/periodos
router.post('/periodos', nominaController.crearPeriodo);

// POST /api/nomina/periodos/:periodoId/empleados
router.post('/periodos/:periodoId/empleados', nominaController.agregarEmpleado);

// POST /api/nomina/periodos/:periodoId/liquidar
router.post('/periodos/:periodoId/liquidar', nominaController.liquidar);

// POST /api/nomina/novedades
router.post('/novedades', nominaController.crearNovedad);

module.exports = router;
