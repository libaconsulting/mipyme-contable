const express = require('express');
const router = express.Router();
const comprasController = require('../controllers/compras.controller');

// GET /api/compras/ordenes
router.get('/ordenes', comprasController.listarOrdenes);

// GET /api/compras/facturas
router.get('/facturas', comprasController.listarFacturas);

// POST /api/compras/facturas/xml/previsualizar  (lee el XML, no guarda nada)
router.post('/facturas/xml/previsualizar', comprasController.previsualizarFacturaXml);

// POST /api/compras/facturas/xml  (registra y contabiliza la factura del proveedor)
router.post('/facturas/xml', comprasController.registrarFacturaXml);

// GET /api/compras/facturas/:id  (detalle + asiento)
router.get('/facturas/:id', comprasController.obtenerFactura);

// GET /api/compras/facturas/:id/xml  (descarga el XML guardado)
router.get('/facturas/:id/xml', comprasController.descargarXmlFactura);

// POST /api/compras/ordenes
router.post('/ordenes', comprasController.crearOrden);

// GET /api/compras/ordenes/:id (detalle con ítems)
router.get('/ordenes/:id', comprasController.obtenerOrden);

// PATCH /api/compras/ordenes/:id (editar — solo en borrador)
router.patch('/ordenes/:id', comprasController.actualizarOrden);

// PATCH /api/compras/ordenes/:id/aprobar
router.patch('/ordenes/:id/aprobar', comprasController.aprobarOrden);

// POST /api/compras/ordenes/:ordenId/convertir
router.post('/ordenes/:ordenId/convertir', comprasController.convertirOrden);

// Documento soporte expedido en Siigo (solo entrega PDF): se digita aquí y se contabiliza
// GET /api/compras/documentos-soporte/opciones  (cuentas de gasto disponibles)
router.get('/documentos-soporte/opciones', comprasController.opcionesDocumentoSoporte);

// GET /api/compras/documentos-soporte
router.get('/documentos-soporte', comprasController.listarDocumentosSoporte);

// POST /api/compras/documentos-soporte
router.post('/documentos-soporte', comprasController.registrarDocumentoSoporte);

// GET /api/compras/documentos-soporte/:id/pdf
router.get('/documentos-soporte/:id/pdf', comprasController.descargarPdfDocumentoSoporte);

// GET /api/compras/documentos-soporte/:id
router.get('/documentos-soporte/:id', comprasController.obtenerDocumentoSoporte);

// POST /api/compras/documento-soporte
router.post('/documento-soporte', comprasController.emitirDocumentoSoporte);

module.exports = router;
