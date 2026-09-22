const express = require('express');
const router = express.Router();
const ventasService = require('../../modules/ventas/services/ventas.service');

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

// TODO: /webhooks/documento-soporte y /webhooks/nomina siguen el mismo patrón

module.exports = router;
