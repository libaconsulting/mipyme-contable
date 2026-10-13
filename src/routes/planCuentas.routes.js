const express = require('express');
const router = express.Router();
const planCuentasService = require('../core/services/planCuentasService');
const { authorize } = require('../middleware/auth');
const { mensajeError } = require('../core/utils/mensajeError');

// Ver el plan: cualquier usuario con sesión. Modificarlo: contador o dueño.
const puedeModificar = authorize('contador', 'dueño');

// GET /api/plan-cuentas
router.get('/', async (req, res) => {
  try {
    res.json(await planCuentasService.listar(req.usuario.empresaId));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// GET /api/plan-cuentas/catalogo
router.get('/catalogo', async (req, res) => {
  try {
    res.json(await planCuentasService.catalogo(req.usuario.empresaId));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// POST /api/plan-cuentas  { codigo, nombre, paraCompra? }
router.post('/', puedeModificar, async (req, res) => {
  try {
    const r = await planCuentasService.crear(req.usuario.empresaId, req.usuario.id, req.body || {});
    res.status(201).json(r);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// POST /api/plan-cuentas/catalogo/activar  { codigos: [...] }
router.post('/catalogo/activar', puedeModificar, async (req, res) => {
  try {
    res.json(await planCuentasService.activarCatalogo(req.usuario.empresaId, req.usuario.id, (req.body || {}).codigos));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// PATCH /api/plan-cuentas/:id  { nombre?, activa? }
router.patch('/:id', puedeModificar, async (req, res) => {
  try {
    const r = await planCuentasService.actualizar(req.usuario.empresaId, req.usuario.id, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    res.json(r);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

module.exports = router;
