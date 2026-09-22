const ventasService = require('../services/ventas.service');

async function convertirCotizacion(req, res) {
  try {
    const factura = await ventasService.convertirCotizacionEnFactura(
      req.params.cotizacionId,
      req.usuario?.id
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { convertirCotizacion };
