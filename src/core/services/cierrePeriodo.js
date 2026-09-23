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
