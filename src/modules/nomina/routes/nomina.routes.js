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

// Centros de trabajo de la ARL (varios por empresa)
router.get('/centros-trabajo', puedeVer, c.listarCentros);
router.post('/centros-trabajo', puedeModificar, c.crearCentro);
router.patch('/centros-trabajo/:id', puedeModificar, c.actualizarCentro);
router.delete('/centros-trabajo/:id', puedeModificar, c.eliminarCentro);

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

// Pago de la planilla (PILA) y archivo de cargue
router.post('/periodos/:id/planilla-pago', puedeModificar, c.pagarPlanilla);
router.post('/planilla-pagos/:pagoId/anular', puedeModificar, c.anularPagoPlanilla);
router.get('/periodos/:id/planilla-cargue.csv', puedeVer, c.planillaCargueCsv);
router.get('/periodos/:id/planilla-pila.txt', puedeVer, c.planillaArchivoPila);

// Vacaciones: saldo por empleado
router.get('/vacaciones', puedeVer, c.resumenVacaciones);

// Prestaciones sociales (prima, cesantías, intereses), vacaciones en dinero y liquidación final
router.get('/prestaciones', puedeVer, c.listarPrestaciones);
router.post('/prestaciones', puedeModificar, c.crearPrestacionLote);
router.post('/prestaciones/vacaciones', puedeModificar, c.crearVacaciones);
router.post('/prestaciones/liquidacion', puedeModificar, c.crearLiquidacion);
router.get('/prestaciones/:id', puedeVer, c.obtenerPrestacion);
router.get('/prestaciones/:id/empleados/:empleadoId', puedeVer, c.comprobantePrestacion);
router.post('/prestaciones/:id/recalcular', puedeModificar, c.recalcularPrestacion);
router.post('/prestaciones/:id/pagar', puedeModificar, c.pagarPrestacion);
router.post('/prestaciones/:id/anular', puedeModificar, c.anularPrestacion);
router.delete('/prestaciones/:id', puedeModificar, c.eliminarPrestacion);

module.exports = router;
