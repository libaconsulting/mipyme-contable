const comprasService = require('../services/compras.service');

async function convertirOrden(req, res) {
  try {
    const factura = await comprasService.convertirOrdenEnFactura(
      req.params.ordenId,
      req.usuario
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function emitirDocumentoSoporte(req, res) {
  try {
    const documento = await comprasService.emitirDocumentoSoporte(req.body, req.usuario);
    res.status(201).json(documento);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { convertirOrden, emitirDocumentoSoporte };
