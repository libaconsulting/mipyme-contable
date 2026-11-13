const express = require('express');
const router = express.Router();
const authService = require('../core/services/authService');
const { authenticate, authorize } = require('../middleware/auth');
const { crearLimitador, porIp } = require('../middleware/limitador');
const { mensajeError } = require('../core/utils/mensajeError');
const { normalizarEmail } = require('../core/utils/validacionUsuario');

const QUINCE_MIN = 15 * 60 * 1000;
// Fuerza bruta: 30 intentos por IP cada 15 min, y 8 fallos seguidos por correo (se reinicia al entrar bien).
const limitePorIp = crearLimitador({ ventanaMs: QUINCE_MIN, max: 30 });
const fallosPorCorreo = crearLimitador({ ventanaMs: QUINCE_MIN, max: 8 });
const limiteRegistroEmpresa = crearLimitador({ ventanaMs: 60 * 60 * 1000, max: 10 });

// POST /api/auth/login
router.post('/login', porIp(limitePorIp, 'Demasiados intentos de inicio de sesión.'), async (req, res) => {
  const { email, password } = req.body || {};
  const clave = normalizarEmail(email);
  if (clave && !fallosPorCorreo.permitido(clave)) {
    return res.status(429).json({ error: `Demasiados intentos fallidos con este correo. Intenta de nuevo en ${fallosPorCorreo.minutosRestantes(clave)} minuto(s).` });
  }
  try {
    const resultado = await authService.iniciarSesion(email, password);
    fallosPorCorreo.reiniciar(clave);
    res.json(resultado);
  } catch (error) {
    if (clave) fallosPorCorreo.registrar(clave);
    res.status(401).json({ error: error.message });
  }
});

// POST /api/auth/registro
// Alta de un usuario en la empresa de quien lo crea. Solo dueño o contador, con sesión.
router.post('/registro', authenticate, authorize('dueño', 'contador'), async (req, res) => {
  try {
    const usuario = await authService.registrarUsuario(req.body, req.usuario);
    res.status(201).json(usuario);
  } catch (error) {
    res.status(400).json({ error: mensajeError(error) });
  }
});

// POST /api/auth/registro-empresa
// Empresa nueva + su primer usuario. Público, pero exige el código de registro (CODIGO_REGISTRO).
router.post('/registro-empresa', porIp(limiteRegistroEmpresa, 'Demasiados intentos de registro.'), async (req, res) => {
  try {
    const { empresa, usuario, codigoRegistro } = req.body || {};
    res.status(201).json(await authService.registrarEmpresa({ empresa, usuario, codigoRegistro }));
  } catch (error) {
    res.status(error.status || 400).json({ error: mensajeError(error) });
  }
});

module.exports = router;
