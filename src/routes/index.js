const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro

router.use('/ventas', authenticate, ventasRoutes); // requiere sesión

// TODO: montar aquí las rutas de compras, inventarios, nomina,
// activosFijos y tesoreria siguiendo el mismo patrón que ventas
// (todas protegidas con authenticate).

module.exports = router;
