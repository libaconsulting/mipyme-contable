const { mensajeError } = require('../../../core/utils/mensajeError');
const nominaService = require('../services/nomina.service');
const prestaciones = require('../services/prestaciones.service');

// Cada acción: llama al servicio con (req.body / params / query, req.usuario) y responde JSON.
function accion(fn, estado) {
  return async (req, res) => {
    try {
      const resultado = await fn(req);
      res.status(estado || 200).json(resultado);
    } catch (error) {
      res.status(400).json({ error: mensajeError(error) });
    }
  };
}

const u = (req) => req.usuario;

module.exports = {
  opciones: accion((req) => nominaService.opciones(u(req))),
  obtenerConfig: accion((req) => nominaService.obtenerConfig(u(req))),
  guardarConfig: accion((req) => nominaService.guardarConfig(req.body, u(req))),

  listarContratos: accion((req) => nominaService.listarContratos(u(req))),
  crearContrato: accion((req) => nominaService.crearContrato(req.body, u(req)), 201),
  actualizarContrato: accion((req) => nominaService.actualizarContrato(req.params.id, req.body, u(req))),

  listarAusencias: accion((req) => nominaService.listarAusencias(u(req))),
  crearAusencia: accion((req) => nominaService.crearAusencia(req.body, u(req)), 201),
  eliminarAusencia: accion((req) => nominaService.eliminarAusencia(req.params.id, u(req))),

  listarConceptos: accion((req) => nominaService.listarConceptos(u(req))),
  crearConcepto: accion((req) => nominaService.crearConcepto(req.body, u(req)), 201),
  eliminarConcepto: accion((req) => nominaService.eliminarConcepto(req.params.id, u(req))),

  listarPeriodos: accion((req) => nominaService.listarPeriodos(u(req))),
  crearPeriodo: accion((req) => nominaService.crearPeriodo(req.body, u(req)), 201),
  obtenerPeriodo: accion((req) => nominaService.detallePeriodo(req.params.id, u(req))),
  recalcularPeriodo: accion((req) => nominaService.preliquidar(req.params.id, u(req))),
  obtenerLiquidacion: accion((req) => nominaService.detalleLiquidacion(req.params.id, req.params.empleadoId, u(req))),
  contabilizarPeriodo: accion((req) => nominaService.contabilizarPeriodo(req.params.id, u(req))),
  reabrirPeriodo: accion((req) => nominaService.reabrirPeriodo(req.params.id, req.body, u(req))),
  registrarPago: accion((req) => nominaService.registrarPago(req.params.id, req.body || {}, u(req))),
  planillaAportes: accion((req) => nominaService.planillaAportes(req.params.id, u(req))),

  provisiones: accion((req) => nominaService.provisionesAcumuladas(u(req), req.query)),

  // Prestaciones sociales, vacaciones y liquidación final
  listarPrestaciones: accion((req) => prestaciones.listarPrestaciones(u(req), req.query)),
  crearPrestacionLote: accion((req) => prestaciones.crearLote(req.body || {}, u(req)), 201),
  crearVacaciones: accion((req) => prestaciones.crearVacaciones(req.body || {}, u(req)), 201),
  crearLiquidacion: accion((req) => prestaciones.crearLiquidacion(req.body || {}, u(req)), 201),
  obtenerPrestacion: accion((req) => prestaciones.obtener(req.params.id, u(req))),
  recalcularPrestacion: accion((req) => prestaciones.recalcular(req.params.id, req.body || {}, u(req))),
  pagarPrestacion: accion((req) => prestaciones.pagar(req.params.id, req.body || {}, u(req))),
  anularPrestacion: accion((req) => prestaciones.anular(req.params.id, req.body || {}, u(req))),
  eliminarPrestacion: accion((req) => prestaciones.eliminar(req.params.id, u(req))),
  comprobantePrestacion: accion((req) => prestaciones.comprobante(req.params.id, req.params.empleadoId, u(req))),
  resumenVacaciones: accion((req) => prestaciones.resumenVacaciones(u(req), req.query)),

  // Pago de la planilla PILA
  pagarPlanilla: accion((req) => prestaciones.pagarPlanilla(req.params.id, req.body || {}, u(req))),
  anularPagoPlanilla: accion((req) => prestaciones.anularPagoPlanilla(req.params.pagoId, req.body || {}, u(req))),

  async planillaCargueCsv(req, res) {
    try {
      const { nombre, contenido } = await prestaciones.planillaCargueCsv(req.params.id, u(req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.send(contenido);
    } catch (error) {
      res.status(400).json({ error: mensajeError(error) });
    }
  },

  async planillaCsv(req, res) {
    try {
      const { nombre, contenido } = await nominaService.planillaCsv(req.params.id, u(req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.send(contenido);
    } catch (error) {
      res.status(400).json({ error: mensajeError(error) });
    }
  },
};
