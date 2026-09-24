const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Empresa = require('../core/models/Empresa');

// TODO antes de producción: igual que /api/auth/registro, esto queda
// abierto solo para poder aprovisionar las primeras empresas a mano.
// Hoy no existe un rol "operador de la plataforma" separado de los
// roles por empresa — antes de tener más de un puñado de clientes,
// hay que diseñar ese control de acceso.

// POST /api/empresas
router.post('/', async (req, res) => {
  try {
    const { nit, razonSocial, regimenTributario, responsableIva } = req.body;
    const empresa = await Empresa.create({
      id: uuidv4(),
      nit,
      razonSocial,
      regimenTributario: regimenTributario || 'ordinario',
      responsableIva: !!responsableIva,
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

module.exports = router;
