const { v4: uuidv4 } = require('uuid');
const CuentaBancaria = require('../models/CuentaBancaria');
const MovimientoBancario = require('../models/MovimientoBancario');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

async function crearCuenta(datos, usuario) {
  return CuentaBancaria.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    banco: datos.banco,
    numero: datos.numero,
    saldoContable: 0,
  });
}

async function listarCuentas(usuario) {
  return CuentaBancaria.findAll({ where: { empresaId: usuario.empresaId } });
}

// Registrar un movimiento NO lo contabiliza — queda pendiente de
// conciliar, igual que en la máquina de estados del cierre mensual
// (un movimiento sin conciliar bloquea el cierre, ver cierrePeriodo.js).
async function registrarMovimiento(datos, usuario) {
  return MovimientoBancario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    cuentaBancariaId: datos.cuentaBancariaId,
    fecha: datos.fecha || new Date(),
    valor: datos.valor,
    tipo: datos.tipo,
    descripcion: datos.descripcion,
    conciliado: false,
  });
}

async function listarMovimientos(usuario) {
  return MovimientoBancario.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Conciliar: solo el tipo "comision" se contabiliza automáticamente
// (nivel 1). Ingresos y egresos ligados a pagos de facturas/nómina
// específicas todavía no cruzan contra esos documentos — por ahora
// solo quedan marcados como conciliados. Ver pendientes en el README.
async function conciliarMovimiento(id, usuario) {
  const movimiento = await MovimientoBancario.findByPk(id);

  if (movimiento.conciliado) {
    throw new Error('Este movimiento ya estaba conciliado.');
  }

  await movimiento.update({ conciliado: true });

  if (movimiento.tipo === 'comision') {
    await contabilizarEvento({
      empresaId: usuario.empresaId,
      tipoEvento: 'gasto_bancario',
      origenModulo: 'tesoreria',
      origenId: movimiento.id,
      valor: movimiento.valor,
    });
  }

  return movimiento;
}

module.exports = { crearCuenta, listarCuentas, registrarMovimiento, listarMovimientos, conciliarMovimiento };
