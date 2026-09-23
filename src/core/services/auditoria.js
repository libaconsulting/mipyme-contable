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
