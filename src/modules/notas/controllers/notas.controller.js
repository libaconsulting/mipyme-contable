const { mensajeError } = require('../../../core/utils/mensajeError');
const notas = require('../services/notas.service');

function atender(fn, estado) {
  return async (req, res) => {
    try {
      res.status(estado || 200).json(await fn(req));
    } catch (error) {
      res.status(400).json({ error: mensajeError(error) });
    }
  };
}

const previsualizar = atender((req) => notas.previsualizarNotaXml(req.body, req.usuario));
const registrar = atender((req) => notas.registrarNotaXml(req.body, req.usuario), 201);
const listar = atender((req) => notas.listarNotas(req.query, req.usuario));
const anular = atender((req) => notas.anularNota(req.params.id, req.body, req.usuario));
const deDocumento = atender((req) => notas.notasDeDocumento(req.params.docTipo, req.params.docId, req.usuario));

async function obtener(req, res) {
  try {
    const nota = await notas.obtenerNota(req.params.id, req.usuario);
    if (!nota) return res.status(404).json({ error: 'Nota no encontrada.' });
    res.json(nota);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

async function descargarXml(req, res) {
  try {
    const xml = await notas.obtenerXml(req.params.id, req.usuario);
    if (!xml) return res.status(404).json({ error: 'Esta nota no tiene un XML guardado.' });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${xml.nombre}"`);
    res.send(xml.contenido);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
}

module.exports = { previsualizar, registrar, listar, obtener, descargarXml, anular, deDocumento };
