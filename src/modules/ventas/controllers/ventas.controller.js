const { mensajeError } = require('../../../core/utils/mensajeError');
const ventasService = require('../services/ventas.service');
const facturaVentaXmlService = require('../services/facturaVentaXml.service');

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

async function previsualizarFacturaVentaXml(req, res) {
  try {
    res.json(await facturaVentaXmlService.previsualizarFacturaVentaXml(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function registrarFacturaVentaXml(req, res) {
  try {
    res.status(201).json(await facturaVentaXmlService.registrarFacturaVentaXml(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function obtenerFactura(req, res) {
  try {
    const factura = await facturaVentaXmlService.obtenerFactura(req.params.id, req.usuario);
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada.' });
    res.json(factura);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function descargarXmlFactura(req, res) {
  try {
    const xml = await facturaVentaXmlService.obtenerXml(req.params.id, req.usuario);
    if (!xml) return res.status(404).json({ error: 'Esta factura no tiene un XML guardado.' });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${xml.nombre}"`);
    res.send(xml.contenido);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

module.exports = {
  previsualizarFacturaVentaXml,
  registrarFacturaVentaXml,
  obtenerFactura,
  descargarXmlFactura,
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
