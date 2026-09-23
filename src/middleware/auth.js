const jwt = require('jsonwebtoken');

// Verifica el token del header "Authorization: Bearer <token>" y deja
// disponible req.usuario = { id, empresaId, rol } para el resto de la
// petición. Toda ruta protegida pasa por aquí primero.
function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Falta el token de autenticación.' });
  }

  const token = header.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario = { id: payload.id, empresaId: payload.empresaId, rol: payload.rol };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
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
