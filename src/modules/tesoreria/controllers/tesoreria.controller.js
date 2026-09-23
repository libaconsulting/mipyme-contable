const tesoreriaService = require('../services/tesoreria.service');

async function crearCuenta(req, res) {
  try {
    res.status(201).json(await tesoreriaService.crearCuenta(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarCuentas(req, res) {
  try {
    res.json(await tesoreriaService.listarCuentas(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarMovimiento(req, res) {
  try {
    res.status(201).json(await tesoreriaService.registrarMovimiento(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarMovimientos(req, res) {
  try {
    res.json(await tesoreriaService.listarMovimientos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function conciliarMovimiento(req, res) {
  try {
    res.json(await tesoreriaService.conciliarMovimiento(req.params.id, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { crearCuenta, listarCuentas, registrarMovimiento, listarMovimientos, conciliarMovimiento };
