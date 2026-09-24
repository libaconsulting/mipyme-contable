const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const seedRoutes = require('./seed.routes');
const empresasRoutes = require('./empresas.routes');
const tercerosRoutes = require('./terceros.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const comprasRoutes = require('../modules/compras/routes/compras.routes');
const nominaRoutes = require('../modules/nomina/routes/nomina.routes');
const inventariosRoutes = require('../modules/inventarios/routes/inventarios.routes');
const activosFijosRoutes = require('../modules/activosFijos/routes/activosFijos.routes');
const tesoreriaRoutes = require('../modules/tesoreria/routes/tesoreria.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro
router.use('/seed', seedRoutes); // el propio router exige authenticate + authorize
router.use('/empresas', empresasRoutes); // público por ahora, ver TODO en el archivo

router.use('/terceros', authenticate, tercerosRoutes); // requiere sesión
router.use('/ventas', authenticate, ventasRoutes); // requiere sesión
router.use('/compras', authenticate, comprasRoutes); // requiere sesión
router.use('/nomina', authenticate, nominaRoutes); // requiere sesión
router.use('/inventarios', authenticate, inventariosRoutes); // requiere sesión
router.use('/activos-fijos', authenticate, activosFijosRoutes); // requiere sesión
router.use('/tesoreria', authenticate, tesoreriaRoutes); // requiere sesión

module.exports = router;
