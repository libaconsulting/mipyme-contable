const { v4: uuidv4 } = require('uuid');
const Asiento = require('../models/Asiento');
const Movimiento = require('../models/Movimiento');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');

/**
 * Punto de entrada único que usan TODOS los módulos operativos
 * (ventas, compras, nómina, activos fijos, tesorería) para contabilizar
 * un evento. Ningún módulo escribe asientos directamente.
 *
 * @param {Object} evento
 * @param {string} evento.empresaId
 * @param {string} evento.periodoContableId
 * @param {string} evento.tipoEvento     - ej: 'factura_venta_credito'
 * @param {string} evento.origenModulo   - 'ventas' | 'compras' | 'nomina' | ...
 * @param {string} evento.origenId       - id del documento que originó el evento
 * @param {number} evento.valor
 * @param {string} [evento.terceroId]
 * @param {string} [evento.usuarioId]
 */
async function contabilizarEvento(evento) {
  const regla = await ReglaContabilizacion.findOne({
    where: { empresaId: evento.empresaId, eventoOrigen: evento.tipoEvento },
  });

  if (!regla) {
    throw new Error(
      `No existe regla de contabilización para el evento "${evento.tipoEvento}". ` +
      `Configúrala en Plan de cuentas > Reglas antes de continuar.`
    );
  }

  // Nivel "manual" nunca se contabiliza solo: queda en cola para el contador.
  if (regla.nivelAutomatizacion === 'manual') {
    return { requiereRevision: true, regla };
  }

  const asiento = await Asiento.create({
    id: uuidv4(),
    empresaId: evento.empresaId,
    periodoContableId: evento.periodoContableId,
    fecha: evento.fecha || new Date(),
    origenModulo: evento.origenModulo,
    origenId: evento.origenId,
    estado: regla.nivelAutomatizacion === 'asistido' ? 'borrador' : 'contabilizado',
    usuarioId: evento.usuarioId,
  });

  await Movimiento.bulkCreate([
    {
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: regla.cuentaDebitoId,
      terceroId: evento.terceroId,
      debito: evento.valor,
      credito: 0,
    },
    {
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: regla.cuentaCreditoId,
      terceroId: evento.terceroId,
      debito: 0,
      credito: evento.valor,
    },
  ]);

  return { requiereRevision: regla.nivelAutomatizacion === 'asistido', asiento };
}

module.exports = { contabilizarEvento };
