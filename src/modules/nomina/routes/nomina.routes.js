const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const c = require('../controllers/nomina.controller');

// Los sueldos son información sensible: el auxiliar no entra a nómina.
// Leer: dueño, contador y revisor. Modificar: dueño y contador.
const puedeVer = authorize('contador', 'dueño', 'revisor');
const puedeModificar = authorize('contador', 'dueño');

// Datos para las pantallas (empleados, bancos, parámetros del año, catálogos)
router.get('/opciones', puedeVer, c.opciones);

// Configuración de la empresa (ARL, caja, exoneración art. 114-1)
router.get('/config', puedeVer, c.obtenerConfig);
router.put('/config', puedeModificar, c.guardarConfig);

// Contratos
router.get('/contratos', puedeVer, c.listarContratos);
router.post('/contratos', puedeModificar, c.crearContrato);
router.patch('/contratos/:id', puedeModificar, c.actualizarContrato);

// Incapacidades, licencias, vacaciones
router.get('/ausencias', puedeVer, c.listarAusencias);
router.post('/ausencias', puedeModificar, c.crearAusencia);
router.delete('/ausencias/:id', puedeModificar, c.eliminarAusencia);

// Novedades de devengo y descuento
router.get('/conceptos', puedeVer, c.listarConceptos);
router.post('/conceptos', puedeModificar, c.crearConcepto);
router.delete('/conceptos/:id', puedeModificar, c.eliminarConcepto);

// Nómina mensual
router.get('/periodos', puedeVer, c.listarPeriodos);
router.post('/periodos', puedeModificar, c.crearPeriodo);
router.get('/periodos/:id', puedeVer, c.obtenerPeriodo);
router.post('/periodos/:id/recalcular', puedeModificar, c.recalcularPeriodo);
router.post('/periodos/:id/contabilizar', puedeModificar, c.contabilizarPeriodo);
router.post('/periodos/:id/reabrir', puedeModificar, c.reabrirPeriodo);
router.post('/periodos/:id/pago', puedeModificar, c.registrarPago);
router.get('/periodos/:id/empleados/:empleadoId', puedeVer, c.obtenerLiquidacion);

// Planilla de aportes a la seguridad social
router.get('/periodos/:id/planilla', puedeVer, c.planillaAportes);
router.get('/periodos/:id/planilla.csv', puedeVer, c.planillaCsv);

// Provisiones acumuladas por empleado
router.get('/provisiones', puedeVer, c.provisiones);

module.exports = router;
