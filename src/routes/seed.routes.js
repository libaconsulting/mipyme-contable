const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { ejecutarSeed } = require('../core/services/seedService');

// POST /api/seed
// Requiere sesión con rol "contador" o "dueño" — reutiliza la
// autenticación ya construida en vez de inventar un mecanismo aparte.
// Seguro de correr más de una vez (ver nota en seedService.js).
router.post('/', authenticate, authorize('contador', 'dueño'), async (req, res) => {
  try {
    const resultado = await ejecutarSeed();
    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
