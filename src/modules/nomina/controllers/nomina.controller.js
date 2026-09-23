const nominaService = require('../services/nomina.service');

async function crearPeriodo(req, res) {
  try {
    const periodo = await nominaService.crearPeriodoNomina(req.body, req.usuario);
    res.status(201).json(periodo);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function agregarEmpleado(req, res) {
  try {
    const nomina = await nominaService.agregarEmpleadoANomina(
      req.params.periodoId,
      req.body,
      req.usuario
    );
    res.status(201).json(nomina);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function liquidar(req, res) {
  try {
    const periodo = await nominaService.liquidarPeriodo(req.params.periodoId, req.usuario);
    res.json(periodo);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function crearNovedad(req, res) {
  try {
    const novedad = await nominaService.registrarNovedad(req.body, req.usuario);
    res.status(201).json(novedad);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarPeriodos(req, res) {
  try {
    const periodos = await nominaService.listarPeriodos(req.usuario);
    res.json(periodos);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { crearPeriodo, agregarEmpleado, liquidar, crearNovedad, listarPeriodos };
