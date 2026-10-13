const { mensajeError } = require('../../../core/utils/mensajeError');
const comprasService = require('../services/compras.service');
const facturaXmlService = require('../services/facturaXml.service');
const documentoSoporteService = require('../services/documentoSoporte.service');

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

async function previsualizarFacturaXml(req, res) {
  try {
    res.json(await facturaXmlService.previsualizarFacturaXml(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function registrarFacturaXml(req, res) {
  try {
    res.status(201).json(await facturaXmlService.registrarFacturaXml(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function obtenerFactura(req, res) {
  try {
    const factura = await facturaXmlService.obtenerFactura(req.params.id, req.usuario);
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada.' });
    res.json(factura);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function descargarXmlFactura(req, res) {
  try {
    const xml = await facturaXmlService.obtenerXml(req.params.id, req.usuario);
    if (!xml) return res.status(404).json({ error: 'Esta factura no tiene un XML guardado.' });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${xml.nombre}"`);
    res.send(xml.contenido);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function opcionesDocumentoSoporte(req, res) {
  try {
    res.json(await documentoSoporteService.opciones(req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function listarDocumentosSoporte(req, res) {
  try {
    res.json(await documentoSoporteService.listarDocumentosSoporte(req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function registrarDocumentoSoporte(req, res) {
  try {
    res.status(201).json(await documentoSoporteService.registrarDocumentoSoporte(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function obtenerDocumentoSoporte(req, res) {
  try {
    const doc = await documentoSoporteService.obtenerDocumentoSoporte(req.params.id, req.usuario);
    if (!doc) return res.status(404).json({ error: 'Documento soporte no encontrado.' });
    res.json(doc);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function descargarPdfDocumentoSoporte(req, res) {
  try {
    const pdf = await documentoSoporteService.obtenerPdf(req.params.id, req.usuario);
    if (!pdf) return res.status(404).json({ error: 'Este documento soporte no tiene un PDF guardado.' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${pdf.nombre.replace(/"/g, '')}"`);
    res.send(pdf.contenido);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

module.exports = {
  opcionesDocumentoSoporte,
  listarDocumentosSoporte,
  registrarDocumentoSoporte,
  obtenerDocumentoSoporte,
  descargarPdfDocumentoSoporte,
  previsualizarFacturaXml,
  registrarFacturaXml,
  obtenerFactura,
  descargarXmlFactura,
  crearOrden,
  aprobarOrden,
  convertirOrden,
  emitirDocumentoSoporte,
  listarOrdenes,
  listarFacturas,
  obtenerOrden,
  actualizarOrden,
};
