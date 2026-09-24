const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Tercero = require('../core/models/Tercero');

// Campos editables/creables — se comparten entre crear y editar para
// no tener dos listas que se puedan desincronizar.
const CAMPOS_TERCERO = [
  'tipo',
  'tipoPersona',
  'identificacion',
  'nombre',
  'email',
  'celular',
  'direccion',
  'departamento',
  'municipio',
  'regimenIva',
  'responsabilidadesFiscales',
  'cuentaBancariaTipo',
  'cuentaBancariaBanco',
  'cuentaBancariaNumero',
];

function extraerCampos(body) {
  const datos = {};
  for (const campo of CAMPOS_TERCERO) {
    if (body[campo] !== undefined) datos[campo] = body[campo];
  }
  return datos;
}

// POST /api/terceros
router.post('/', async (req, res) => {
  try {
    const tercero = await Tercero.create({
      id: uuidv4(),
      empresaId: req.usuario.empresaId,
      ...extraerCampos(req.body),
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

// PATCH /api/terceros/:id
router.patch('/:id', async (req, res) => {
  try {
    const tercero = await Tercero.findOne({
      where: { id: req.params.id, empresaId: req.usuario.empresaId },
    });
    if (!tercero) {
      return res.status(404).json({ error: 'Tercero no encontrado.' });
    }
    await tercero.update(extraerCampos(req.body));
    res.json(tercero);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
