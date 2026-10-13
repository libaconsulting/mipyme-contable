const { mensajeError } = require('../../../core/utils/mensajeError');
const nominaService = require('../services/nomina.service');

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
