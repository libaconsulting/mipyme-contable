const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Usuario = require('../models/Usuario');
const Empresa = require('../models/Empresa');

async function iniciarSesion(email, password) {
  const usuario = await Usuario.findOne({ where: { email, activo: true } });

  if (!usuario) {
    throw new Error('Credenciales inválidas.');
  }

  const coincide = await bcrypt.compare(password, usuario.passwordHash);
  if (!coincide) {
    throw new Error('Credenciales inválidas.');
  }

  const token = jwt.sign(
    { id: usuario.id, empresaId: usuario.empresaId, rol: usuario.rol },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  return {
    token,
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: usuario.rol,
      empresaId: usuario.empresaId,
    },
  };
}

// TODO antes de producción: este registro queda abierto únicamente para
// poder crear el primer usuario de cada empresa. En cuanto exista al
// menos un usuario "dueño" o "contador", esta ruta debe protegerse con
// authenticate + authorize('dueño', 'contador') — nunca debe quedar
// abierta al público en un sistema con datos contables reales.
async function registrarUsuario({ empresaId, nombre, email, password, rol }) {
  const empresa = await Empresa.findByPk(empresaId);
  if (!empresa) {
    throw new Error('La empresa indicada no existe. Créala primero en "Nueva empresa".');
  }

  const existente = await Usuario.findOne({ where: { email } });
  if (existente) {
    throw new Error('Ya existe un usuario con ese correo.');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const usuario = await Usuario.create({
    id: uuidv4(),
    empresaId,
    nombre,
    email,
    passwordHash,
    rol: rol || 'auxiliar',
  });

  return { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol };
}

module.exports = { iniciarSesion, registrarUsuario };
