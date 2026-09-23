const express = require('express');
const router = express.Router();
const authService = require('../core/services/authService');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const resultado = await authService.iniciarSesion(email, password);
    res.json(resultado);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// POST /api/auth/registro
// Ver el TODO en authService.registrarUsuario antes de pasar a producción.
router.post('/registro', async (req, res) => {
  try {
    const usuario = await authService.registrarUsuario(req.body);
    res.status(201).json(usuario);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
