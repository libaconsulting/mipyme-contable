const jwt = require('jsonwebtoken');
const Usuario = require('../core/models/Usuario');

// Verifica el token del header "Authorization: Bearer <token>" y deja
// disponible req.usuario = { id, empresaId, rol } para el resto de la
// petición. Toda ruta protegida pasa por aquí primero.
async function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Falta el token de autenticación.' });
  }

  const token = header.split(' ')[1];

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }

  // El token solo prueba quién es; el rol y si sigue activo se leen de la base en cada petición, para que
  // desactivar a alguien o cambiarle el rol surta efecto de inmediato y no cuando venza su token.
  try {
    const u = await Usuario.findByPk(payload.id, { attributes: ['id', 'empresaId', 'rol', 'activo'] });
    if (!u || !u.activo) return res.status(401).json({ error: 'Tu usuario ya no está activo. Inicia sesión de nuevo.' });
    req.usuario = { id: u.id, empresaId: u.empresaId, rol: u.rol };
    next();
  } catch (error) {
    console.error('No se pudo verificar el usuario:', error.message);
    return res.status(500).json({ error: 'No se pudo verificar tu sesión. Intenta de nuevo.' });
  }
}

// Middleware de autorización por rol. Uso: authorize('contador', 'dueño')
// Debe ir siempre DESPUÉS de authenticate en la cadena de middlewares.
function authorize(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.usuario) {
      return res.status(401).json({ error: 'No autenticado.' });
    }
    if (!rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({
        error: `Esta acción requiere alguno de estos roles: ${rolesPermitidos.join(', ')}.`,
      });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
