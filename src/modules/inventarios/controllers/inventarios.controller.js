const { mensajeError } = require('../../../core/utils/mensajeError');
const servicio = require('../services/inventarios.service');

function accion(fn, estado) {
  return async (req, res) => {
    try {
      res.status(estado || 200).json(await fn(req));
    } catch (error) {
      res.status(400).json({ error: mensajeError(error) });
    }
  };
}

function csv(fn) {
  return async (req, res) => {
    try {
      const r = await fn(req);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${r.nombre}"`);
      res.send(r.contenido);
    } catch (error) {
      res.status(400).json({ error: mensajeError(error) });
    }
  };
}

const u = (req) => req.usuario;

module.exports = {
  opciones: accion((req) => servicio.opciones(u(req))),
  listarProductos: accion((req) => servicio.listarProductos(u(req), req.query)),
  crearProducto: accion((req) => servicio.crearProducto(req.body || {}, u(req)), 201),
  actualizarProducto: accion((req) => servicio.actualizarProducto(req.params.id, req.body || {}, u(req))),
  kardex: accion((req) => servicio.kardexDeProducto(req.params.id, req.query, u(req))),
  kardexCsv: csv((req) => servicio.kardexCsv(req.params.id, req.query, u(req))),
  listarMovimientos: accion((req) => servicio.listarMovimientos(u(req), req.query)),
  crearMovimiento: accion((req) => servicio.crearMovimiento(req.body || {}, u(req)), 201),
  anularMovimiento: accion((req) => servicio.anularMovimiento(req.params.id, req.body || {}, u(req))),
  valoracion: accion((req) => servicio.valoracion(u(req), req.query)),
  valoracionCsv: csv((req) => servicio.valoracionCsv(u(req), req.query)),
};
