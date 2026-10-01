const { mensajeError } = require('../../../core/utils/mensajeError');
const ventasService = require('../services/ventas.service');

async function crearCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.crearCotizacion(req.body, req.usuario);
    res.status(201).json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function enviarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.enviarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function aceptarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.aceptarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function rechazarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.rechazarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function convertirCotizacion(req, res) {
  try {
    const factura = await ventasService.convertirCotizacionEnFactura(
      req.params.cotizacionId,
      req.usuario?.id
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function listarCotizaciones(req, res) {
  try {
    const cotizaciones = await ventasService.listarCotizaciones(req.usuario);
    res.json(cotizaciones);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function listarFacturas(req, res) {
  try {
    const facturas = await ventasService.listarFacturas(req.usuario);
    res.json(facturas);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function obtenerCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.obtenerCotizacion(req.params.id, req.usuario);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada.' });
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function actualizarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.actualizarCotizacion(req.params.id, req.body, req.usuario);
    if (!cotizacion) return res.status(404).json({ error: 'Cotización no encontrada.' });
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  convertirCotizacion,
  listarCotizaciones,
  listarFacturas,
  obtenerCotizacion,
  actualizarCotizacion,
};
