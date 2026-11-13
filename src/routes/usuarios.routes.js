const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const Usuario = require('../core/models/Usuario');
const auditoria = require('../core/services/auditoria');
const { authorize } = require('../middleware/auth');
const { mensajeError } = require('../core/utils/mensajeError');
const V = require('../core/utils/validacionUsuario');

// Administración de los usuarios de la empresa del que consulta (nunca de otra). Solo dueño o contador;
// el contador no toca al dueño. Crear usuarios: POST /api/auth/registro.
router.use(authorize('dueño', 'contador'));

function publico(u) {
  return { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, activo: u.activo, creadoEn: u.createdAt };
}

// GET /api/usuarios
router.get('/', async (req, res) => {
  try {
    const lista = await Usuario.findAll({ where: { empresaId: req.usuario.empresaId }, order: [['nombre', 'ASC']] });
    res.json(lista.map(publico));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// PATCH /api/usuarios/:id  { rol?, activo?, nombre?, password? }
router.patch('/:id', async (req, res) => {
  try {
    const actor = req.usuario;
    const u = await Usuario.findOne({ where: { id: req.params.id, empresaId: actor.empresaId } });
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (!V.puedeAdministrarA(actor.rol, u.rol)) return res.status(403).json({ error: 'Tu rol no puede modificar a este usuario.' });

    const cambios = {};
    const detalle = [];
    const b = req.body || {};
    if (b.nombre !== undefined) { cambios.nombre = V.validarNombre(b.nombre); detalle.push('nombre'); }
    if (b.rol !== undefined && b.rol !== u.rol) {
      V.validarRol(b.rol);
      if (u.id === actor.id) throw new Error('No puedes cambiar tu propio rol.');
      if (!V.puedeAsignarRol(actor.rol, b.rol)) throw new Error('Tu rol no puede asignar ese rol.');
      cambios.rol = b.rol;
      detalle.push(`rol ${u.rol} → ${b.rol}`);
    }
    if (b.activo !== undefined && !!b.activo !== u.activo) {
      if (u.id === actor.id && !b.activo) throw new Error('No puedes desactivarte a ti mismo.');
      cambios.activo = !!b.activo;
      detalle.push(b.activo ? 'activado' : 'desactivado');
    }
    if (b.password !== undefined && b.password !== '') {
      cambios.passwordHash = await bcrypt.hash(V.validarPassword(b.password), 10);
      detalle.push('contraseña restablecida');
    }
    if (!Object.keys(cambios).length) return res.json(publico(u));
    await u.update(cambios);
    await auditoria.registrar({ empresaId: actor.empresaId, usuarioId: actor.id, accion: 'usuario_modificado', entidad: 'Usuario', entidadId: u.id, detalle: `${u.email}: ${detalle.join(', ')}` });
    res.json(publico(u));
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

module.exports = router;
