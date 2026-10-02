const { mensajeError } = require('../../../core/utils/mensajeError');
const comprasService = require('../services/compras.service');

async function crearOrden(req, res) {
  try {
    const orden = await comprasService.crearOrden(req.body, req.usuario);
    res.status(201).json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function aprobarOrden(req, res) {
  try {
    const orden = await comprasService.aprobarOrden(req.params.id, req.usuario);
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function convertirOrden(req, res) {
  try {
    const factura = await comprasService.convertirOrdenEnFactura(
      req.params.ordenId,
      req.usuario
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function emitirDocumentoSoporte(req, res) {
  try {
    const documento = await comprasService.emitirDocumentoSoporte(req.body, req.usuario);
    res.status(201).json(documento);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function listarOrdenes(req, res) {
  try {
    const ordenes = await comprasService.listarOrdenes(req.usuario);
    res.json(ordenes);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function listarFacturas(req, res) {
  try {
    const facturas = await comprasService.listarFacturas(req.usuario);
    res.json(facturas);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function obtenerOrden(req, res) {
  try {
    const orden = await comprasService.obtenerOrden(req.params.id, req.usuario);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function actualizarOrden(req, res) {
  try {
    const orden = await comprasService.actualizarOrden(req.params.id, req.body, req.usuario);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

module.exports = {
  crearOrden,
  aprobarOrden,
  convertirOrden,
  emitirDocumentoSoporte,
  listarOrdenes,
  listarFacturas,
  obtenerOrden,
  actualizarOrden,
};
