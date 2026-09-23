const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const Asiento = require('../models/Asiento');
const Movimiento = require('../models/Movimiento');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');
const PeriodoContable = require('../models/PeriodoContable');

// Resuelve el periodo contable vigente de la empresa (abierto o en_cierre)
// para que ningún módulo operativo tenga que averiguarlo por su cuenta.
// Requiere que exista al menos un PeriodoContable creado de antemano —
// sin eso, ningún evento se puede contabilizar (a propósito).
async function obtenerPeriodoVigente(empresaId) {
  const periodo = await PeriodoContable.findOne({
    where: { empresaId, estado: { [Op.in]: ['abierto', 'en_cierre'] } },
    order: [['fechaInicio', 'DESC']],
  });

  if (!periodo) {
    throw new Error(
      'No hay un periodo contable abierto para esta empresa. Crea uno antes de contabilizar.'
    );
  }

  return periodo;
}

/**
 * Punto de entrada único que usan TODOS los módulos operativos
 * (ventas, compras, nómina, activos fijos, tesorería) para contabilizar
 * un evento. Ningún módulo escribe asientos directamente.
 *
 * @param {Object} evento
 * @param {string} evento.empresaId
 * @param {string} [evento.periodoContableId] - si no se pasa, se resuelve solo
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

  const periodoContableId =
    evento.periodoContableId || (await obtenerPeriodoVigente(evento.empresaId)).id;

  const asiento = await Asiento.create({
    id: uuidv4(),
    empresaId: evento.empresaId,
    periodoContableId,
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
