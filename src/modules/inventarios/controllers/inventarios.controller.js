const inventariosService = require('../services/inventarios.service');

async function crearProducto(req, res) {
  try {
    res.status(201).json(await inventariosService.crearProducto(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarProductos(req, res) {
  try {
    res.json(await inventariosService.listarProductos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarMovimientos(req, res) {
  try {
    res.json(await inventariosService.listarMovimientos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarEntrada(req, res) {
  try {
    res.status(201).json(await inventariosService.registrarEntrada(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarSalida(req, res) {
  try {
    res.status(201).json(await inventariosService.registrarSalida(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarAjuste(req, res) {
  try {
    res.status(201).json(await inventariosService.registrarAjuste(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = {
  crearProducto,
  listarProductos,
  listarMovimientos,
  registrarEntrada,
  registrarSalida,
  registrarAjuste,
};
