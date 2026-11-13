// Reglas de usuarios y contraseñas: funciones puras, sin base de datos, para probarlas aparte.
const ROLES = ['dueño', 'contador', 'auxiliar', 'revisor'];
const ETIQUETA_ROL = { dueño: 'Dueño', contador: 'Contador', auxiliar: 'Auxiliar', revisor: 'Revisor' };

function normalizarEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

function validarEmail(email) {
  const e = normalizarEmail(email);
  if (e.length < 5 || e.length > 150 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(e)) {
    throw new Error('Escribe un correo electrónico válido.');
  }
  return e;
}

// Mínimo 8 caracteres, con letras y números. Máximo 72: bcrypt ignora lo que pase de ahí.
function validarPassword(password) {
  const p = String(password == null ? '' : password);
  if (p.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
  if (p.length > 72) throw new Error('La contraseña no puede pasar de 72 caracteres.');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw new Error('La contraseña debe combinar letras y números.');
  return p;
}

function validarNombre(nombre) {
  const n = String(nombre == null ? '' : nombre).replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 150) throw new Error('Escribe el nombre de la persona (entre 2 y 150 letras).');
  if (/[<>]/.test(n)) throw new Error('El nombre no puede llevar los símbolos < o >.');
  return n;
}

function validarRol(rol) {
  if (!ROLES.includes(rol)) throw new Error('El rol es dueño, contador, auxiliar o revisor.');
  return rol;
}

// Quién puede dar de alta o cambiar a quién: el dueño a todos; el contador a todos menos al dueño.
function puedeAsignarRol(rolActor, rolNuevo) {
  if (rolActor === 'dueño') return ROLES.includes(rolNuevo);
  if (rolActor === 'contador') return ROLES.includes(rolNuevo) && rolNuevo !== 'dueño';
  return false;
}

function puedeAdministrarA(rolActor, rolObjetivo) {
  if (rolActor === 'dueño') return true;
  if (rolActor === 'contador') return rolObjetivo !== 'dueño';
  return false;
}

module.exports = { ROLES, ETIQUETA_ROL, normalizarEmail, validarEmail, validarPassword, validarNombre, validarRol, puedeAsignarRol, puedeAdministrarA };
