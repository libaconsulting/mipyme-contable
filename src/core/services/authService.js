const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Op, fn, col, where } = require('sequelize');
const sequelize = require('../../config/database');
const Usuario = require('../models/Usuario');
const Empresa = require('../models/Empresa');
const auditoria = require('./auditoria');
const V = require('../utils/validacionUsuario');

// Mismo mensaje para "no existe" y "clave mala": no se revela qué correos están registrados.
const CREDENCIALES_INVALIDAS = 'Credenciales inválidas.';
const HASH_FALSO = bcrypt.hashSync('contraseña-que-nadie-tiene', 10);

async function iniciarSesion(email, password) {
  const correo = V.normalizarEmail(email);
  // Los correos anteriores a la normalización pueden estar guardados con mayúsculas: se compara sin distinguirlas.
  const usuario = correo ? await Usuario.findOne({ where: { [Op.and]: [where(fn('lower', col('email')), correo), { activo: true }] } }) : null;

  if (!usuario || typeof password !== 'string' || !password) {
    // Se gasta el mismo tiempo que con un usuario real para no delatar cuáles correos existen.
    await bcrypt.compare(String(password || ''), HASH_FALSO);
    throw new Error(CREDENCIALES_INVALIDAS);
  }

  const coincide = await bcrypt.compare(password, usuario.passwordHash);
  if (!coincide) throw new Error(CREDENCIALES_INVALIDAS);

  const token = jwt.sign(
    { id: usuario.id, empresaId: usuario.empresaId, rol: usuario.rol },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  return {
    token,
    usuario: { id: usuario.id, empresaId: usuario.empresaId, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
  };
}

async function correoLibre(email, transaction) {
  const existente = await Usuario.findOne({ where: where(fn('lower', col('email')), email), transaction });
  if (existente) throw new Error('Ya existe un usuario con ese correo.');
}

function datosUsuario({ nombre, email, password, rol }) {
  return {
    nombre: V.validarNombre(nombre),
    email: V.validarEmail(email),
    password: V.validarPassword(password),
    rol: V.validarRol(rol || 'auxiliar'),
  };
}

async function crearUsuario(empresaId, datos, transaction) {
  await correoLibre(datos.email, transaction);
  const passwordHash = await bcrypt.hash(datos.password, 10);
  const u = await Usuario.create({ id: uuidv4(), empresaId, nombre: datos.nombre, email: datos.email, passwordHash, rol: datos.rol }, { transaction });
  return { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, activo: u.activo };
}

// Alta de un usuario nuevo en la empresa de QUIEN LO CREA (nunca en otra): solo dueño o contador.
// El contador no puede crear dueños.
async function registrarUsuario(datos, actor) {
  if (!actor || !actor.empresaId) throw new Error('Necesitas iniciar sesión.');
  const limpio = datosUsuario(datos || {});
  if (!V.puedeAsignarRol(actor.rol, limpio.rol)) throw new Error('Tu rol no puede crear usuarios con ese rol.');
  const creado = await crearUsuario(actor.empresaId, limpio);
  await auditoria.registrar({ empresaId: actor.empresaId, usuarioId: actor.id, accion: 'usuario_creado', entidad: 'Usuario', entidadId: creado.id, detalle: `${creado.email} · ${creado.rol}` });
  return creado;
}

// Compara en tiempo constante, para no filtrar el código letra por letra por el tiempo de respuesta.
function codigoValido(recibido) {
  const esperado = process.env.CODIGO_REGISTRO;
  if (!esperado) return false;
  const a = crypto.createHash('sha256').update(String(recibido || '')).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

const CAMPOS_EMPRESA = [
  'nit', 'razonSocial', 'regimenTributario', 'responsableIva', 'email', 'telefono', 'direccion', 'departamento', 'municipio',
  'representanteLegalNombre', 'representanteLegalDocumento', 'actividadEconomicaCiiu', 'matriculaMercantil', 'logoBase64',
];

// Empresa nueva + su primer usuario (dueño o contador), en un solo paso y solo con el código de registro
// que entrega Libaniel Consulting (variable de entorno CODIGO_REGISTRO). Sin esa variable, queda cerrado.
async function registrarEmpresa({ empresa, usuario, codigoRegistro }) {
  if (!process.env.CODIGO_REGISTRO) {
    const e = new Error('El registro de empresas nuevas está cerrado. Pide a Libaniel Consulting que cree tu empresa.');
    e.status = 403;
    throw e;
  }
  if (!codigoValido(codigoRegistro)) {
    const e = new Error('El código de registro no es correcto.');
    e.status = 403;
    throw e;
  }
  const datosEmpresa = {};
  for (const c of CAMPOS_EMPRESA) if (empresa && empresa[c] !== undefined) datosEmpresa[c] = empresa[c];
  const limpio = datosUsuario({ ...(usuario || {}), rol: (usuario && usuario.rol) || 'dueño' });
  if (!['dueño', 'contador'].includes(limpio.rol)) throw new Error('El primer usuario de la empresa es el dueño o el contador.');

  const r = await sequelize.transaction(async (transaction) => {
    await correoLibre(limpio.email, transaction);
    const creada = await Empresa.create({
      id: uuidv4(),
      ...datosEmpresa,
      regimenTributario: datosEmpresa.regimenTributario || 'ordinario',
      responsableIva: !!datosEmpresa.responsableIva,
    }, { transaction });
    const creado = await crearUsuario(creada.id, limpio, transaction);
    return { empresa: { id: creada.id, razonSocial: creada.razonSocial, nit: creada.nit }, usuario: creado };
  });
  await auditoria.registrar({ empresaId: r.empresa.id, usuarioId: r.usuario.id, accion: 'empresa_creada', entidad: 'Empresa', entidadId: r.empresa.id, detalle: `${r.empresa.razonSocial} · ${r.usuario.email}` });
  return r;
}

module.exports = { iniciarSesion, registrarUsuario, registrarEmpresa, codigoValido };
