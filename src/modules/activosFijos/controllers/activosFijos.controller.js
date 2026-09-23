const activosFijosService = require('../services/activosFijos.service');

async function registrarActivo(req, res) {
  try {
    res.status(201).json(await activosFijosService.registrarActivo(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarActivos(req, res) {
  try {
    res.json(await activosFijosService.listarActivos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

// Endpoint manual, además del cron job, útil para pruebas.
async function depreciar(req, res) {
  try {
    res.json(await activosFijosService.calcularDepreciacionMensual(req.usuario.empresaId));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function darDeBaja(req, res) {
  try {
    res.json(await activosFijosService.darDeBaja(req.params.id, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { registrarActivo, listarActivos, depreciar, darDeBaja };
