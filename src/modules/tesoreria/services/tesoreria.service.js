const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const CuentaBancaria = require('../models/CuentaBancaria');
const MovimientoBancario = require('../models/MovimientoBancario');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const { asegurarCuentaContable, terceroDelBanco } = require('./contabilidadBancaria');

const TIPOS_CUENTA = ['ahorros', 'corriente'];
const TIPOS_MOVIMIENTO = ['ingreso', 'egreso', 'comision'];

// Cuenta bancaria + su cuenta contable (auxiliar) para mostrar en pantalla.
async function conCuentaContable(lista) {
  const ids = lista.map((c) => c.cuentaContableId).filter(Boolean);
  const cuentas = ids.length ? await PlanCuentas.findAll({ where: { id: ids } }) : [];
  const porId = Object.fromEntries(cuentas.map((c) => [c.id, c]));
  return lista.map((c) => {
    const plano = c.toJSON();
    const cc = porId[c.cuentaContableId];
    plano.cuentaContable = cc ? { id: cc.id, codigo: cc.codigo, nombre: cc.nombre } : null;
    return plano;
  });
}

async function crearCuenta(datos, usuario) {
  const banco = String(datos.banco || '').replace(/\s+/g, ' ').trim();
  const numero = String(datos.numero || '').replace(/\s+/g, ' ').trim();
  if (banco.length < 2 || banco.length > 100) throw new Error('Escribe el nombre del banco.');
  if (numero.length < 3 || numero.length > 30 || !/^[\d\- ]+$/.test(numero)) {
    throw new Error('El número de cuenta solo lleva dígitos y guiones (entre 3 y 30 caracteres).');
  }
  const tipoCuenta = datos.tipoCuenta || 'corriente';
  if (!TIPOS_CUENTA.includes(tipoCuenta)) throw new Error('El tipo de cuenta es "ahorros" o "corriente".');
  const nit = datos.nitBanco ? String(datos.nitBanco).trim() : '';
  if (nit && !/^[\d.\-]{5,20}$/.test(nit)) throw new Error('El NIT del banco solo lleva números, puntos y guion.');

  const repetida = await CuentaBancaria.findOne({ where: { empresaId: usuario.empresaId, banco, numero } });
  if (repetida) throw new Error(`Ya registraste la cuenta ${numero} de ${banco}.`);

  // Una empresa nueva todavía puede no tener plan de cuentas.
  await aprovisionarContabilidadBase(usuario.empresaId);

  const creada = await sequelize.transaction(async (transaction) => {
    const tercero = await terceroDelBanco(usuario.empresaId, banco, nit, transaction);
    const cuenta = await CuentaBancaria.create(
      {
        id: uuidv4(),
        empresaId: usuario.empresaId,
        banco,
        numero,
        tipoCuenta,
        terceroId: tercero ? tercero.id : null,
        saldoContable: 0,
      },
      { transaction }
    );
    await asegurarCuentaContable(cuenta, transaction);
    return cuenta;
  });
  return (await conCuentaContable([creada]))[0];
}

// Las cuentas registradas antes de que existieran los auxiliares reciben el
// suyo la primera vez que se listan.
async function listarCuentas(usuario) {
  const cuentas = await CuentaBancaria.findAll({ where: { empresaId: usuario.empresaId }, order: [['createdAt', 'ASC']] });
  const pendientes = cuentas.filter((c) => !c.cuentaContableId);
  for (const c of pendientes) {
    try {
      await aprovisionarContabilidadBase(usuario.empresaId);
      await sequelize.transaction((transaction) => asegurarCuentaContable(c, transaction));
    } catch (error) {
      console.error('No se pudo crear el auxiliar de la cuenta bancaria', c.id, error.message);
    }
  }
  return conCuentaContable(cuentas);
}

// Registrar un movimiento NO lo contabiliza — queda pendiente de
// conciliar, igual que en la máquina de estados del cierre mensual
// (un movimiento sin conciliar bloquea el cierre, ver cierrePeriodo.js).
async function registrarMovimiento(datos, usuario) {
  const cuenta = await CuentaBancaria.findOne({ where: { id: datos.cuentaBancariaId || null, empresaId: usuario.empresaId } });
  if (!cuenta) throw new Error('Elige una cuenta bancaria de tu empresa.');
  if (!TIPOS_MOVIMIENTO.includes(datos.tipo)) throw new Error('El tipo de movimiento es ingreso, egreso o comisión.');
  const valor = Number(datos.valor);
  if (!(valor > 0)) throw new Error('El valor del movimiento debe ser mayor a cero.');
  return MovimientoBancario.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    cuentaBancariaId: cuenta.id,
    fecha: datos.fecha || new Date(),
    valor,
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
// (nivel 1), y lo hace contra el auxiliar de ESA cuenta bancaria y con el
// banco como tercero. Ingresos y egresos ligados a pagos de facturas/nómina
// específicas todavía no cruzan contra esos documentos — por ahora
// solo quedan marcados como conciliados. Ver pendientes en el README.
async function conciliarMovimiento(id, usuario) {
  const movimiento = await MovimientoBancario.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!movimiento) throw new Error('Movimiento bancario no encontrado.');

  if (movimiento.conciliado) {
    throw new Error('Este movimiento ya estaba conciliado.');
  }

  if (movimiento.tipo === 'comision') {
    const cuenta = await CuentaBancaria.findOne({ where: { id: movimiento.cuentaBancariaId, empresaId: usuario.empresaId } });
    const auxiliar = await sequelize.transaction((transaction) => asegurarCuentaContable(cuenta, transaction));
    // Primero se contabiliza: si falla (p. ej. no hay periodo abierto), el movimiento sigue pendiente.
    await contabilizarEvento({
      empresaId: usuario.empresaId,
      tipoEvento: 'gasto_bancario',
      origenModulo: 'tesoreria',
      origenId: movimiento.id,
      valor: movimiento.valor,
      cuentaCreditoId: auxiliar.id,
      terceroId: cuenta.terceroId || undefined,
      usuarioId: usuario.id,
    });
  }

  await movimiento.update({ conciliado: true });
  return movimiento;
}

module.exports = { crearCuenta, listarCuentas, registrarMovimiento, listarMovimientos, conciliarMovimiento };
