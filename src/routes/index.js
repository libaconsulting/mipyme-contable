const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const seedRoutes = require('./seed.routes');
const tercerosRoutes = require('./terceros.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const comprasRoutes = require('../modules/compras/routes/compras.routes');
const nominaRoutes = require('../modules/nomina/routes/nomina.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro
router.use('/seed', seedRoutes); // el propio router exige authenticate + authorize

router.use('/terceros', authenticate, tercerosRoutes); // requiere sesión
router.use('/ventas', authenticate, ventasRoutes); // requiere sesión
router.use('/compras', authenticate, comprasRoutes); // requiere sesión
router.use('/nomina', authenticate, nominaRoutes); // requiere sesión

// TODO: montar aquí las rutas de inventarios, activosFijos y tesoreria
// siguiendo el mismo patrón (todas protegidas con authenticate).

module.exports = router;
