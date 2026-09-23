const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Tercero = require('../core/models/Tercero');

// POST /api/terceros
router.post('/', async (req, res) => {
  try {
    const { tipo, identificacion, nombre, regimenTributario, email } = req.body;
    const tercero = await Tercero.create({
      id: uuidv4(),
      empresaId: req.usuario.empresaId,
      tipo,
      identificacion,
      nombre,
      regimenTributario,
      email,
    });
    res.status(201).json(tercero);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/terceros (opcionalmente filtrado por ?tipo=cliente|proveedor|empleado|otro)
router.get('/', async (req, res) => {
  try {
    const where = { empresaId: req.usuario.empresaId };
    if (req.query.tipo) where.tipo = req.query.tipo;
    const terceros = await Tercero.findAll({ where });
    res.json(terceros);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
