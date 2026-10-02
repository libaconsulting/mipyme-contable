const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Empresa = require('../core/models/Empresa');

// TODO antes de producción: igual que /api/auth/registro, esto queda
// abierto solo para poder aprovisionar las primeras empresas a mano.
// Hoy no existe un rol "operador de la plataforma" separado de los
// roles por empresa — antes de tener más de un puñado de clientes,
// hay que diseñar ese control de acceso.

const CAMPOS_EMPRESA = [
  'nit',
  'razonSocial',
  'regimenTributario',
  'responsableIva',
  'email',
  'telefono',
  'direccion',
  'departamento',
  'municipio',
  'representanteLegalNombre',
  'representanteLegalDocumento',
  'actividadEconomicaCiiu',
  'matriculaMercantil',
  'logoBase64',
];

function extraerCampos(body) {
  const datos = {};
  for (const campo of CAMPOS_EMPRESA) {
    if (body[campo] !== undefined) datos[campo] = body[campo];
  }
  return datos;
}

// POST /api/empresas
router.post('/', async (req, res) => {
  try {
    const empresa = await Empresa.create({
      id: uuidv4(),
      ...extraerCampos(req.body),
      regimenTributario: req.body.regimenTributario || 'ordinario',
      responsableIva: !!req.body.responsableIva,
    });
    res.status(201).json(empresa);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/empresas
router.get('/', async (req, res) => {
  try {
    const empresas = await Empresa.findAll({ order: [['razonSocial', 'ASC']] });
    res.json(empresas);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PATCH /api/empresas/:id
router.patch('/:id', async (req, res) => {
  try {
    const empresa = await Empresa.findByPk(req.params.id);
    if (!empresa) {
      return res.status(404).json({ error: 'Empresa no encontrada.' });
    }
    await empresa.update(extraerCampos(req.body));
    res.json(empresa);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
