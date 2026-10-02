const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Proyecto = require('../core/models/Proyecto');
const { mensajeError } = require('../core/utils/mensajeError');

const CAMPOS_PROYECTO = ['nombre', 'codigo', 'descripcion', 'activo'];

function extraerCampos(body) {
  const datos = {};
  for (const campo of CAMPOS_PROYECTO) {
    if (body[campo] !== undefined) datos[campo] = body[campo];
  }
  return datos;
}

// POST /api/proyectos
router.post('/', async (req, res) => {
  try {
    const proyecto = await Proyecto.create({
      id: uuidv4(),
      empresaId: req.usuario.empresaId,
      ...extraerCampos(req.body),
    });
    res.status(201).json(proyecto);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// GET /api/proyectos
router.get('/', async (req, res) => {
  try {
    const proyectos = await Proyecto.findAll({
      where: { empresaId: req.usuario.empresaId },
      order: [['nombre', 'ASC']],
    });
    res.json(proyectos);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// PATCH /api/proyectos/:id
router.patch('/:id', async (req, res) => {
  try {
    const proyecto = await Proyecto.findOne({
      where: { id: req.params.id, empresaId: req.usuario.empresaId },
    });
    if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado.' });
    await proyecto.update(extraerCampos(req.body));
    res.json(proyecto);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

module.exports = router;
