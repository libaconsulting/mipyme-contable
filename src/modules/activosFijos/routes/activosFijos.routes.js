const express = require('express');
const router = express.Router();
const c = require('../controllers/activosFijos.controller');

router.get('/', c.listarActivos);
router.post('/', c.registrarActivo);
router.post('/depreciar', c.depreciar);
router.post('/:id/baja', c.darDeBaja);

module.exports = router;
