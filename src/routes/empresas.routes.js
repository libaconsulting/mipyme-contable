const express = require('express');
const router = express.Router();
const Empresa = require('../core/models/Empresa');
const auditoria = require('../core/services/auditoria');
const { authorize } = require('../middleware/auth');
const { mensajeError } = require('../core/utils/mensajeError');

// Todo este router va detrás de authenticate (ver routes/index.js): cada usuario ve y edita SOLO la empresa
// a la que pertenece. Las empresas nuevas se crean en POST /api/auth/registro-empresa (con código de registro).

const CAMPOS_EMPRESA = [
  'nit',
  'razonSocial',
  'regimenTributario',
  'responsableIva',
  'email',
  'telefono',
  'direccion',
  'departamento',
  'municipio',
  'representanteLegalNombre',
  'representanteLegalDocumento',
  'actividadEconomicaCiiu',
  'matriculaMercantil',
  'logoBase64',
];

function extraerCampos(body) {
  const datos = {};
  for (const campo of CAMPOS_EMPRESA) {
    if (body && body[campo] !== undefined) datos[campo] = body[campo];
  }
  return datos;
}

// GET /api/empresas  → solo la empresa del usuario (lista de uno, como antes)
router.get('/', async (req, res) => {
  try {
    const empresa = await Empresa.findByPk(req.usuario.empresaId);
    res.json(empresa ? [empresa] : []);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// PATCH /api/empresas/:id  → solo la propia, y solo dueño o contador
router.patch('/:id', authorize('dueño', 'contador'), async (req, res) => {
  try {
    if (req.params.id !== req.usuario.empresaId) {
      return res.status(403).json({ error: 'Solo puedes modificar los datos de tu propia empresa.' });
    }
    const empresa = await Empresa.findByPk(req.usuario.empresaId);
    if (!empresa) {
      return res.status(404).json({ error: 'Empresa no encontrada.' });
    }
    await empresa.update(extraerCampos(req.body));
    await auditoria.registrar({ empresaId: empresa.id, usuarioId: req.usuario.id, accion: 'empresa_actualizada', entidad: 'Empresa', entidadId: empresa.id, detalle: Object.keys(extraerCampos(req.body)).filter((c) => c !== 'logoBase64').join(', ') });
    res.json(empresa);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

module.exports = router;
