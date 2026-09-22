const express = require('express');
const router = express.Router();

const ventasRoutes = require('../modules/ventas/routes/ventas.routes');

router.use('/ventas', ventasRoutes);

// TODO: montar aquí las rutas de compras, inventarios, nomina,
// activosFijos y tesoreria siguiendo el mismo patrón que ventas.

module.exports = router;
