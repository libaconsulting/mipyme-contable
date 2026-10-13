// Contabilidad de las cuentas bancarias, a la manera tradicional:
//
//   1110     Bancos                       (cuenta, 4 dígitos)
//   111005   Bancos moneda nacional       (subcuenta, 6 dígitos)
//   11100501 Bancolombia · Ahorros ****1234   (auxiliar, 8 dígitos: UNO por cuenta bancaria)
//   11100502 Davivienda · Corriente ****9876
//
// y el banco como tercero (por su NIT) en los movimientos, de modo que se
// puede sacar el auxiliar por cuenta y por banco, y conciliar cada cuenta
// contra su extracto.
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Tercero = require('../../../core/models/Tercero');
const { CUENTAS } = require('../../../core/services/seedService');

const CUENTA_BANCOS = '1110';
const SUBCUENTA_NACIONAL = '111005';
const ETIQUETA_TIPO = { ahorros: 'Ahorros', corriente: 'Corriente' };

// ****1234: nunca se escribe el número completo en el nombre de la cuenta.
function enmascarar(numero) {
  const digitos = String(numero || '').replace(/\D/g, '');
  if (!digitos) return String(numero || '').trim().slice(-4);
  return '****' + digitos.slice(-4);
}

function nombreAuxiliar(cuenta) {
  const tipo = ETIQUETA_TIPO[cuenta.tipoCuenta] ? ` ${ETIQUETA_TIPO[cuenta.tipoCuenta]}` : '';
  return `${cuenta.banco} ·${tipo} ${enmascarar(cuenta.numero)}`.replace(/\s+/g, ' ').trim().slice(0, 100);
}

// 1110 y 111005 (se crean si faltan; si estaban desactivadas, se reactivan).
async function asegurarCuentasPadre(empresaId, transaction) {
  let bancos = await PlanCuentas.findOne({ where: { empresaId, codigo: CUENTA_BANCOS }, transaction });
  if (!bancos) {
    const base = CUENTAS.find((c) => c.codigo === CUENTA_BANCOS);
    bancos = await PlanCuentas.create(
      { id: uuidv4(), empresaId, codigo: base.codigo, nombre: base.nombre, naturaleza: base.naturaleza, nivel: 1, elementoNiif: base.elementoNiif, origen: 'sistema' },
      { transaction }
    );
  } else if (!bancos.activa) {
    await bancos.update({ activa: true }, { transaction });
  }

  let sub = await PlanCuentas.findOne({ where: { empresaId, codigo: SUBCUENTA_NACIONAL }, transaction });
  if (!sub) {
    sub = await PlanCuentas.create(
      {
        id: uuidv4(),
        empresaId,
        codigo: SUBCUENTA_NACIONAL,
        nombre: 'Bancos moneda nacional',
        naturaleza: 'debito',
        nivel: 2,
        cuentaPadreId: bancos.id,
        elementoNiif: 'activo',
        origen: 'tesoreria',
      },
      { transaction }
    );
  } else if (!sub.activa) {
    await sub.update({ activa: true }, { transaction });
  }
  return sub;
}

// Siguiente auxiliar libre: 11100501, 11100502, ... hasta 11100599.
async function siguienteCodigo(empresaId, transaction) {
  const existentes = await PlanCuentas.findAll({
    where: { empresaId, codigo: { [Op.like]: SUBCUENTA_NACIONAL + '%' } },
    attributes: ['codigo'],
    transaction,
  });
  const usados = existentes.filter((c) => c.codigo.length === 8).map((c) => Number(c.codigo.slice(6)));
  const siguiente = (usados.length ? Math.max(...usados) : 0) + 1;
  if (siguiente > 99) throw new Error('Se alcanzó el máximo de 99 cuentas bancarias.');
  return SUBCUENTA_NACIONAL + String(siguiente).padStart(2, '0');
}

// Deja la CuentaBancaria con su auxiliar contable. Idempotente: si ya lo
// tiene (y existe), no hace nada.
async function asegurarCuentaContable(cuentaBancaria, transaction) {
  if (cuentaBancaria.cuentaContableId) {
    const ya = await PlanCuentas.findOne({ where: { id: cuentaBancaria.cuentaContableId, empresaId: cuentaBancaria.empresaId }, transaction });
    if (ya) {
      if (!ya.activa) await ya.update({ activa: true }, { transaction });
      return ya;
    }
  }
  const padre = await asegurarCuentasPadre(cuentaBancaria.empresaId, transaction);
  const codigo = await siguienteCodigo(cuentaBancaria.empresaId, transaction);
  const auxiliar = await PlanCuentas.create(
    {
      id: uuidv4(),
      empresaId: cuentaBancaria.empresaId,
      codigo,
      nombre: nombreAuxiliar(cuentaBancaria),
      naturaleza: 'debito',
      nivel: 3,
      cuentaPadreId: padre.id,
      elementoNiif: 'activo',
      origen: 'tesoreria',
    },
    { transaction }
  );
  await cuentaBancaria.update({ cuentaContableId: auxiliar.id }, { transaction });
  return auxiliar;
}

// El banco como tercero: se busca por NIT (con o sin dígito de verificación)
// y, si no está, se crea como tercero "otro".
async function terceroDelBanco(empresaId, banco, nit, transaction) {
  const limpio = String(nit || '').trim();
  if (!limpio) return null;
  const digitos = (t) => String(t || '').replace(/\D/g, '');
  // Con guion, lo de la izquierda es el NIT y lo de la derecha el DV.
  const base = limpio.includes('-') ? digitos(limpio.split('-')[0]) : digitos(limpio);
  const candidatos = await Tercero.findAll({ where: { empresaId, identificacion: { [Op.like]: `${base}%` } }, transaction });
  // Mismo NIT si es igual al base o al base + 1 dígito (el DV).
  const existente = candidatos.find((t) => {
    const d = digitos(t.identificacion.includes('-') ? t.identificacion.split('-')[0] : t.identificacion);
    return d === base || (!t.identificacion.includes('-') && !limpio.includes('-') && digitos(t.identificacion).length === base.length + 1 && digitos(t.identificacion).startsWith(base));
  });
  if (existente) return existente;
  return Tercero.create(
    { id: uuidv4(), empresaId, tipo: 'otro', identificacion: limpio.slice(0, 20), nombre: String(banco).slice(0, 150), tipoPersona: 'juridica' },
    { transaction }
  );
}

module.exports = { asegurarCuentaContable, terceroDelBanco, nombreAuxiliar, enmascarar, SUBCUENTA_NACIONAL };
