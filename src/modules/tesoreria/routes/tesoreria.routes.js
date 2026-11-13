const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const c = require('../controllers/tesoreria.controller');

// Pagar, recaudar y descontar: contador, dueño o auxiliar; anular: solo contador o dueño.
const puedeRegistrar = authorize('contador', 'dueño', 'auxiliar');
const puedeAnular = authorize('contador', 'dueño');

router.get('/cuentas', c.listarCuentas);
router.post('/cuentas', c.crearCuenta);
router.get('/movimientos', c.listarMovimientos);
router.post('/movimientos', c.registrarMovimiento);
router.post('/movimientos/:id/conciliar', c.conciliarMovimiento);

// Cruce de pagos con facturas, documentos soporte y nómina
router.get('/cartera', c.cartera); // ?tipo=pagar|cobrar&todos=1
router.get('/movimientos-libres', c.movimientosLibres);
router.get('/pagos', c.listarPagos);
router.get('/pagos/:id', c.detallePago);
router.post('/pagos', puedeRegistrar, c.registrarPago);
router.post('/pagos/:id/anular', puedeAnular, c.anularPago);
router.get('/documentos/:docTipo/:docId/pagos', c.pagosDeDocumento);
router.get('/retenciones-sufridas', c.retencionesSufridas); // ?desde=&hasta=
router.get('/descuentos-aportes', c.descuentosDisponibles); // ?terceroId=
router.post('/descuentos', puedeRegistrar, c.aplicarDescuento);

// Anticipos de clientes y a proveedores (se anulan con POST /pagos/:id/anular)
router.get('/anticipos', c.listarAnticipos); // ?sentido=cliente|proveedor&terceroId=&todos=1
router.post('/anticipos', puedeRegistrar, c.registrarAnticipo);
router.get('/anticipos/:id', c.detalleAnticipo);
router.post('/anticipos/:id/aplicar', puedeRegistrar, c.aplicarAnticipo);
router.post('/anticipos/:id/devolver', puedeRegistrar, c.devolverAnticipo);

module.exports = router;
