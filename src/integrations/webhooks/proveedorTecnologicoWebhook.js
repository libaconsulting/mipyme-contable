const express = require('express');
const router = express.Router();
const ventasService = require('../../modules/ventas/services/ventas.service');
const comprasService = require('../../modules/compras/services/compras.service');

// El proveedor tecnológico llama esta URL cuando la DIAN valida (o rechaza)
// el documento. No requiere procesos en segundo plano: es una petición
// HTTP entrante normal, que corre perfectamente en hosting administrado.
//
// POST /webhooks/facturacion
router.post('/facturacion', async (req, res) => {
  try {
    const { facturaId, estado, cufe, xmlUrl, pdfUrl } = req.body;

    if (estado === 'aceptada') {
      await ventasService.confirmarFacturaAceptada(facturaId, { cufe, xmlUrl, pdfUrl });
    }
    // TODO: manejar estado === 'rechazada' (notificar al usuario, no contabilizar)

    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// El proveedor tecnológico (o RADIAN) avisa cuando llega una factura de
// un proveedor a nuestro nombre. Ver el TODO en compras.service.js sobre
// la mecánica exacta de recepción, pendiente de confirmar con el
// proveedor que se contrate.
//
// POST /webhooks/compras
router.post('/compras', async (req, res) => {
  try {
    await comprasService.registrarFacturaRecibida(req.body);
    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Confirmación de que la DIAN validó un documento soporte que NOSOTROS
// emitimos (compra a proveedor no obligado a facturar).
//
// POST /webhooks/documento-soporte
router.post('/documento-soporte', async (req, res) => {
  try {
    const { documentoId, estado, cufe, xmlUrl } = req.body;

    if (estado === 'aceptado') {
      await comprasService.confirmarDocumentoSoporteEmitido(documentoId, { cufe, xmlUrl });
    }

    res.status(200).json({ recibido: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// TODO: /webhooks/nomina sigue el mismo patrón que /webhooks/facturacion

module.exports = router;
