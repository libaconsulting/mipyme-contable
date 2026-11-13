const tesoreriaService = require('../services/tesoreria.service');
const cruces = require('../services/cruces.service');
const anticipos = require('../services/anticipos.service');

async function crearCuenta(req, res) {
  try {
    res.status(201).json(await tesoreriaService.crearCuenta(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarCuentas(req, res) {
  try {
    res.json(await tesoreriaService.listarCuentas(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarMovimiento(req, res) {
  try {
    res.status(201).json(await tesoreriaService.registrarMovimiento(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarMovimientos(req, res) {
  try {
    res.json(await tesoreriaService.listarMovimientos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function conciliarMovimiento(req, res) {
  try {
    res.json(await tesoreriaService.conciliarMovimiento(req.params.id, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

// Cruce de pagos: cada handler recibe el servicio ya resuelto y responde 400 con el mensaje del error.
function manejar(fn, estado) {
  return async (req, res) => {
    try {
      res.status(estado || 200).json(await fn(req));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  };
}

const cartera = manejar((req) => cruces.cartera(req.query, req.usuario));
const listarPagos = manejar((req) => cruces.listarPagos(req.query, req.usuario));
const detallePago = manejar((req) => cruces.detallePago(req.params.id, req.usuario));
const registrarPago = manejar((req) => cruces.registrarPago(req.body || {}, req.usuario), 201);
const anularPago = manejar((req) => cruces.anularPago(req.params.id, req.body || {}, req.usuario));
const pagosDeDocumento = manejar((req) => cruces.pagosDeDocumento(req.params.docTipo, req.params.docId, req.usuario));
const movimientosLibres = manejar((req) => cruces.movimientosLibres(req.usuario));
const descuentosDisponibles = manejar((req) => cruces.descuentosDisponibles(req.query.terceroId, req.usuario));
const retencionesSufridas = manejar((req) => cruces.retencionesSufridas(req.query, req.usuario));
const aplicarDescuento = manejar((req) => cruces.aplicarDescuento(req.body || {}, req.usuario), 201);

// Anticipos de clientes y a proveedores
const listarAnticipos = manejar((req) => anticipos.listarAnticipos(req.query, req.usuario));
const detalleAnticipo = manejar((req) => anticipos.detalleAnticipo(req.params.id, req.usuario));
const registrarAnticipo = manejar((req) => anticipos.registrarAnticipo(req.body || {}, req.usuario), 201);
const aplicarAnticipo = manejar((req) => anticipos.aplicarAnticipo(req.params.id, req.body || {}, req.usuario), 201);
const devolverAnticipo = manejar((req) => anticipos.devolverAnticipo(req.params.id, req.body || {}, req.usuario), 201);

module.exports = {
  crearCuenta, listarCuentas, registrarMovimiento, listarMovimientos, conciliarMovimiento,
  cartera, listarPagos, detallePago, registrarPago, anularPago, pagosDeDocumento, movimientosLibres, descuentosDisponibles, aplicarDescuento, retencionesSufridas,
  listarAnticipos, detalleAnticipo, registrarAnticipo, aplicarAnticipo, devolverAnticipo,
};
