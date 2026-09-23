#!/bin/bash
# Ejecutar este script DESDE DENTRO de la carpeta mipyme-contable
# (la que clonaste con git clone). Crea/actualiza los 10 archivos
# del middleware de autenticación y roles.
set -e

echo "Verificando que estás en la carpeta correcta..."
if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  echo "Ve primero a la carpeta mipyme-contable (cd mipyme-contable) y vuelve a correr este script."
  exit 1
fi

cat > src/core/models/Usuario.js << 'EOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Roles del sistema:
//  - dueño:     dueño del negocio. Puede certificar el cierre.
//  - contador:  control total, incluida la reapertura de periodos
//               certificados (la única acción reservada solo a él).
//  - auxiliar:  registra operaciones del día a día (ventas, compras,
//               nómina). No puede certificar ni reabrir periodos.
//  - revisor:   solo lectura. Pensado para revisor fiscal u otro
//               tercero de consulta.
const Usuario = sequelize.define('Usuario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  nombre: { type: DataTypes.STRING(150), allowNull: false },
  email: { type: DataTypes.STRING(150), allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING(255), allowNull: false },
  rol: {
    type: DataTypes.ENUM('dueño', 'contador', 'auxiliar', 'revisor'),
    allowNull: false,
    defaultValue: 'auxiliar',
  },
  activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'usuarios',
});

module.exports = Usuario;
EOF
echo "OK  src/core/models/Usuario.js"

cat > src/core/models/LogAuditoria.js << 'EOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

// Trazabilidad de acciones sensibles: quién hizo qué, cuándo, y con qué
// justificación cuando aplica (ej. reapertura de periodo). Un registro
// de auditoría nunca se edita ni se borra — por eso updatedAt está
// desactivado más abajo.
const LogAuditoria = sequelize.define('LogAuditoria', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  usuarioId: { type: DataTypes.UUID, allowNull: false },
  accion: { type: DataTypes.STRING(100), allowNull: false }, // ej: 'reapertura_periodo'
  entidad: { type: DataTypes.STRING(50) },
  entidadId: { type: DataTypes.UUID },
  detalle: { type: DataTypes.TEXT },
}, {
  tableName: 'logs_auditoria',
  updatedAt: false,
});

module.exports = LogAuditoria;
EOF
echo "OK  src/core/models/LogAuditoria.js"

cat > src/middleware/auth.js << 'EOF'
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
EOF
echo "OK  src/middleware/auth.js"

cat > src/core/services/authService.js << 'EOF'
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Usuario = require('../models/Usuario');

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
    usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
  };
}

// TODO antes de producción: este registro queda abierto únicamente para
// poder crear el primer usuario de cada empresa. En cuanto exista al
// menos un usuario "dueño" o "contador", esta ruta debe protegerse con
// authenticate + authorize('dueño', 'contador') — nunca debe quedar
// abierta al público en un sistema con datos contables reales.
async function registrarUsuario({ empresaId, nombre, email, password, rol }) {
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
EOF
echo "OK  src/core/services/authService.js"

cat > src/core/services/auditoria.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const LogAuditoria = require('../models/LogAuditoria');

// Registra una acción sensible. Si esto falla, la operación que lo llamó
// también debe fallar — una acción sensible sin registro de auditoría
// no debería quedar aceptada.
async function registrar({ empresaId, usuarioId, accion, entidad, entidadId, detalle }) {
  return LogAuditoria.create({
    id: uuidv4(),
    empresaId,
    usuarioId,
    accion,
    entidad,
    entidadId,
    detalle,
  });
}

module.exports = { registrar };
EOF
echo "OK  src/core/services/auditoria.js"

cat > src/routes/auth.routes.js << 'EOF'
const express = require('express');
const router = express.Router();
const authService = require('../core/services/authService');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const resultado = await authService.iniciarSesion(email, password);
    res.json(resultado);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// POST /api/auth/registro
// Ver el TODO en authService.registrarUsuario antes de pasar a producción.
router.post('/registro', async (req, res) => {
  try {
    const usuario = await authService.registrarUsuario(req.body);
    res.status(201).json(usuario);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
EOF
echo "OK  src/routes/auth.routes.js"

cat > src/core/models/index.js << 'EOF'
// Punto único donde se registran TODOS los modelos del núcleo contable.
// server.js importa este archivo antes de sincronizar la base de datos,
// así que ningún modelo se queda afuera por no estar "require"ado en
// alguna cadena de rutas activa. A medida que agreguemos modelos a los
// módulos operativos (compras, nómina, etc.), se suman aquí también.

const Empresa = require('./Empresa');
const Tercero = require('./Tercero');
const PlanCuentas = require('./PlanCuentas');
const Asiento = require('./Asiento');
const Movimiento = require('./Movimiento');
const PeriodoContable = require('./PeriodoContable');
const ReglaContabilizacion = require('./ReglaContabilizacion');
const ParametroTributario = require('./ParametroTributario');
const Usuario = require('./Usuario');
const LogAuditoria = require('./LogAuditoria');

// Modelos de módulos operativos ya construidos
const FacturaVenta = require('../../modules/ventas/models/FacturaVenta');
const Cotizacion = require('../../modules/ventas/models/Cotizacion');

module.exports = {
  Empresa,
  Tercero,
  PlanCuentas,
  Asiento,
  Movimiento,
  PeriodoContable,
  ReglaContabilizacion,
  ParametroTributario,
  Usuario,
  LogAuditoria,
  FacturaVenta,
  Cotizacion,
};
EOF
echo "OK  src/core/models/index.js"

cat > src/routes/index.js << 'EOF'
const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const ventasRoutes = require('../modules/ventas/routes/ventas.routes');
const { authenticate } = require('../middleware/auth');

router.use('/auth', authRoutes); // público: login y registro

router.use('/ventas', authenticate, ventasRoutes); // requiere sesión

// TODO: montar aquí las rutas de compras, inventarios, nomina,
// activosFijos y tesoreria siguiendo el mismo patrón que ventas
// (todas protegidas con authenticate).

module.exports = router;
EOF
echo "OK  src/routes/index.js"

cat > src/core/services/cierrePeriodo.js << 'EOF'
const { v4: uuidv4 } = require('uuid');
const PeriodoContable = require('../models/PeriodoContable');
const Asiento = require('../models/Asiento');
const Movimiento = require('../models/Movimiento');
const auditoria = require('./auditoria');

/**
 * Máquina de estados del cierre mensual:
 *   abierto -> en_cierre -> (bloqueado -> abierto) | cerrado_preliminar
 *           -> cerrado_certificado -> (excepcional) reabierto -> en_cierre
 */

// Paso 1: abierto -> en_cierre. Corre las validaciones y devuelve
// los pendientes encontrados (si hay alguno, el periodo NO avanza).
async function iniciarCierre(periodoContableId) {
  const pendientes = await validarPeriodo(periodoContableId);

  if (pendientes.length > 0) {
    // Se queda en "en_cierre" para que el usuario vea el detalle,
    // pero funcionalmente el periodo sigue bloqueado para cerrar.
    return { estado: 'bloqueado', pendientes };
  }

  await generarAsientoDeCierre(periodoContableId);

  const periodo = await PeriodoContable.findByPk(periodoContableId);
  await periodo.update({ estado: 'cerrado_preliminar' });

  return { estado: 'cerrado_preliminar', pendientes: [] };
}

// Validaciones bloqueantes: ver la tabla de reglas de contabilización,
// nivel 3 (requiere criterio del contador).
async function validarPeriodo(periodoContableId) {
  const pendientes = [];

  // TODO: implementar cada verificación real contra la base de datos:
  // 1. Movimientos bancarios sin clasificar
  // 2. Facturas/documentos soporte en borrador sin emitir
  // 3. Cuadre global de débitos vs. créditos del periodo
  // La depreciación y la provisión de prestaciones NO bloquean:
  // se calculan automáticamente si no se han corrido (nivel 1).

  return pendientes;
}

// Asiento especial que traslada el saldo de las cuentas nominales
// (ingresos, costos, gastos) contra el resultado del ejercicio.
async function generarAsientoDeCierre(periodoContableId) {
  const periodo = await PeriodoContable.findByPk(periodoContableId);

  const asiento = await Asiento.create({
    id: uuidv4(),
    empresaId: periodo.empresaId,
    periodoContableId,
    fecha: periodo.fechaFin,
    origenModulo: 'cierre_periodo',
    estado: 'contabilizado',
  });

  // TODO: calcular saldos de cuentas clase 4/5/6/7 y generar los
  // movimientos correspondientes contra la cuenta de resultado del ejercicio.

  return asiento;
}

// Paso 2: cerrado_preliminar -> cerrado_certificado.
// Solo lo puede ejecutar el rol "dueño" (representante legal) o "contador".
async function certificarCierre(periodoContableId, usuario) {
  if (!['dueño', 'contador'].includes(usuario.rol)) {
    throw new Error('Solo el dueño o el contador pueden certificar el cierre.');
  }

  const periodo = await PeriodoContable.findByPk(periodoContableId);

  if (periodo.estado !== 'cerrado_preliminar') {
    throw new Error('Solo se puede certificar un periodo en estado "cerrado_preliminar".');
  }

  await periodo.update({
    estado: 'cerrado_certificado',
    cerradoPor: usuario.id,
    fechaCertificacion: new Date(),
  });

  await auditoria.registrar({
    empresaId: periodo.empresaId,
    usuarioId: usuario.id,
    accion: 'certificacion_periodo',
    entidad: 'PeriodoContable',
    entidadId: periodo.id,
  });

  return periodo;
}

// Excepción controlada: cerrado_certificado -> reabierto -> en_cierre.
// Requiere justificación y el rol "contador" exclusivamente — ni el
// dueño ni el auxiliar pueden reabrir un periodo ya certificado.
async function reabrirPeriodo(periodoContableId, motivo, usuario) {
  if (usuario.rol !== 'contador') {
    throw new Error('Solo el rol "contador" puede reabrir un periodo certificado.');
  }

  if (!motivo || motivo.trim().length < 10) {
    throw new Error('La reapertura de un periodo certificado exige una justificación.');
  }

  const periodo = await PeriodoContable.findByPk(periodoContableId);

  if (periodo.estado !== 'cerrado_certificado') {
    throw new Error('Solo se puede reabrir un periodo en estado "cerrado_certificado".');
  }

  await periodo.update({
    estado: 'en_cierre', // vuelve a validación, no directo a "abierto"
    motivoReapertura: motivo,
  });

  await auditoria.registrar({
    empresaId: periodo.empresaId,
    usuarioId: usuario.id,
    accion: 'reapertura_periodo',
    entidad: 'PeriodoContable',
    entidadId: periodo.id,
    detalle: motivo,
  });

  return periodo;
}

module.exports = { iniciarCierre, certificarCierre, reabrirPeriodo, validarPeriodo };
EOF
echo "OK  src/core/services/cierrePeriodo.js"

echo ""
echo "Listo. Los 9 archivos quedaron creados/actualizados."
echo "Siguiente paso: revisa 'git status', y si todo se ve bien:"
echo "  git add ."
echo "  git commit -m \"Agregar middleware de autenticacion y roles\""
echo "  git push"
