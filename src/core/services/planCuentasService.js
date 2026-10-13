// Plan de cuentas de la empresa: listar, crear, activar del catálogo,
// renombrar y desactivar. Las reglas del código (tipo, naturaleza, largo)
// viven en public/contable/planCuentas.js, compartido con el navegador.
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../config/database');
const PlanCuentas = require('../models/PlanCuentas');
const Movimiento = require('../models/Movimiento');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');
const auditoria = require('./auditoria');
const reglas = require('../../../public/contable/planCuentas');

async function conteoMovimientos(ids) {
  if (!ids.length) return {};
  const filas = await Movimiento.findAll({
    attributes: ['cuentaId', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
    where: { cuentaId: { [Op.in]: ids } },
    group: ['cuentaId'],
    raw: true,
  });
  return Object.fromEntries(filas.map((f) => [f.cuentaId, Number(f.n)]));
}

// Cuentas bancarias que usan cada cuenta contable (id -> ['Banco · número']).
async function bancosPorCuenta(empresaId) {
  const CuentaBancaria = require('../../modules/tesoreria/models/CuentaBancaria'); // diferido: evita ciclos al cargar
  const lista = await CuentaBancaria.findAll({ where: { empresaId } });
  const mapa = {};
  for (const b of lista) {
    if (!b.cuentaContableId) continue;
    (mapa[b.cuentaContableId] = mapa[b.cuentaContableId] || []).push(`${b.banco} ${b.numero}`);
  }
  return mapa;
}

// Reglas de contabilización que usan cada cuenta (id -> [eventoOrigen]).
async function reglasPorCuenta(empresaId) {
  const lista = await ReglaContabilizacion.findAll({ where: { empresaId } });
  const mapa = {};
  for (const r of lista) {
    for (const id of [r.cuentaDebitoId, r.cuentaCreditoId]) {
      if (!id) continue;
      (mapa[id] = mapa[id] || []).push(r.eventoOrigen);
    }
  }
  return mapa;
}

function resumen(c, movs, usosRegla, bancos) {
  const esencial = reglas.CUENTAS_ESENCIALES.includes(c.codigo);
  const reglasUsadas = Array.from(new Set(usosRegla || []));
  const bancosUsados = bancos || [];
  const bloqueo = esencial
    ? 'La usa el sistema en las compras (IVA, retenciones, proveedores).'
    : reglasUsadas.length
    ? 'La usan las reglas de contabilización: ' + reglasUsadas.join(', ')
    : bancosUsados.length
    ? 'Es la cuenta contable de la cuenta bancaria: ' + bancosUsados.join(', ')
    : '';
  return {
    id: c.id,
    codigo: c.codigo,
    nombre: c.nombre,
    naturaleza: c.naturaleza,
    elementoNiif: c.elementoNiif,
    nivel: c.nivel,
    cuentaPadreId: c.cuentaPadreId || null,
    activa: !!c.activa,
    origen: c.origen,
    movimientos: movs || 0,
    esencial,
    reglas: reglasUsadas,
    bancos: bancosUsados,
    bloqueo,
    sePuedeDesactivar: !bloqueo,
  };
}

async function listar(empresaId) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId }, order: [['codigo', 'ASC']] });
  const [movs, usos, bancos] = await Promise.all([conteoMovimientos(cuentas.map((c) => c.id)), reglasPorCuenta(empresaId), bancosPorCuenta(empresaId)]);
  return cuentas.map((c) => resumen(c, movs[c.id], usos[c.id], bancos[c.id]));
}

// Catálogo + estado de cada entrada en el plan de la empresa.
async function catalogo(empresaId) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId } });
  const porCodigo = Object.fromEntries(cuentas.map((c) => [c.codigo, c]));
  return {
    grupos: reglas.GRUPOS_CATALOGO,
    cuentas: reglas.CATALOGO.map((c) => {
      const existente = porCodigo[c.codigo];
      return {
        ...c,
        estado: !existente ? 'disponible' : existente.activa ? 'activa' : 'inactiva',
        destinoCompra: reglas.esDestinoCompra(reglas.datosDeCatalogo(c)),
      };
    }),
  };
}

// Subcuenta (6) cuelga de una cuenta (4); auxiliar (8) cuelga de una subcuenta (6).
async function buscarPadre(empresaId, codigo) {
  if (codigo.length !== 6 && codigo.length !== 8) return null;
  const prefijo = codigo.slice(0, codigo.length - 2);
  const nombrePadre = codigo.length === 6 ? 'cuenta' : 'subcuenta';
  const digitos = codigo.length === 6 ? 4 : 6;
  const padre = await PlanCuentas.findOne({ where: { empresaId, codigo: prefijo } });
  if (!padre) {
    throw new Error(`Para crear ${codigo} primero necesitas la ${nombrePadre} ${prefijo} (${digitos} dígitos). Créala o actívala antes.`);
  }
  if (!padre.activa) throw new Error(`La ${nombrePadre} ${prefijo}, de la que depende ${codigo}, está inactiva. Actívala primero.`);
  return padre;
}

async function crear(empresaId, usuarioId, datos) {
  const nom = reglas.validarNombre(datos.nombre);
  if (!nom.ok) throw new Error(nom.error);
  const codigoNormal = reglas.normalizarCodigo(datos.codigo);
  const padre = await buscarPadre(empresaId, codigoNormal).catch((e) => {
    // Solo se busca padre si el código ya es válido; si no, el error de formato es más claro.
    if (reglas.clasificarCodigo(codigoNormal).ok) throw e;
    return null;
  });
  const tipo = reglas.clasificarCodigo(codigoNormal, padre);
  if (!tipo.ok) throw new Error(tipo.error);

  if (datos.paraCompra && !reglas.esDestinoCompra({ codigo: tipo.codigo, naturaleza: tipo.naturaleza, elementoNiif: tipo.elementoNiif })) {
    throw new Error('Para contabilizar una compra elige una cuenta de costo o gasto (clases 5, 6 o 7), de inventarios (14), activos fijos (15), intangibles (16) o diferidos (17).');
  }

  const repetida = await PlanCuentas.findOne({ where: { empresaId, codigo: tipo.codigo } });
  if (repetida) {
    throw new Error(
      repetida.activa
        ? `Ya existe la cuenta ${tipo.codigo} (${repetida.nombre}).`
        : `Ya existe la cuenta ${tipo.codigo} (${repetida.nombre}) pero está inactiva. Actívala en lugar de crearla de nuevo.`
    );
  }

  const cuenta = await PlanCuentas.create({
    id: uuidv4(),
    empresaId,
    codigo: tipo.codigo,
    nombre: nom.nombre,
    naturaleza: tipo.naturaleza,
    nivel: tipo.nivel,
    cuentaPadreId: padre ? padre.id : null,
    elementoNiif: tipo.elementoNiif,
    activa: true,
    origen: 'usuario',
  });
  await auditoria.registrar({
    empresaId,
    usuarioId,
    accion: 'cuenta_creada',
    entidad: 'plan_cuentas',
    entidadId: cuenta.id,
    detalle: `${cuenta.codigo} ${cuenta.nombre}`,
  });
  return { cuenta: resumen(cuenta, 0, []), aviso: tipo.aviso };
}

// Activa (o crea, si no existe) cuentas del catálogo.
async function activarCatalogo(empresaId, usuarioId, codigos) {
  if (!Array.isArray(codigos) || codigos.length === 0) throw new Error('Marca al menos una cuenta del catálogo.');
  if (codigos.length > 100) throw new Error('Son demasiadas cuentas de una vez.');
  const resultado = { creadas: [], reactivadas: [], yaActivas: [] };
  const entradas = [];
  for (const crudo of Array.from(new Set(codigos.map(reglas.normalizarCodigo)))) {
    const entrada = reglas.CATALOGO.find((c) => c.codigo === crudo);
    if (!entrada) throw new Error(`La cuenta ${crudo} no está en el catálogo.`);
    entradas.push(entrada);
  }

  await sequelize.transaction(async (transaction) => {
    for (const entrada of entradas) {
      const existente = await PlanCuentas.findOne({ where: { empresaId, codigo: entrada.codigo }, transaction });
      if (existente) {
        if (existente.activa) {
          resultado.yaActivas.push(entrada.codigo);
        } else {
          await existente.update({ activa: true }, { transaction });
          resultado.reactivadas.push(entrada.codigo);
        }
        continue;
      }
      const d = reglas.datosDeCatalogo(entrada);
      await PlanCuentas.create(
        { id: uuidv4(), empresaId, codigo: d.codigo, nombre: d.nombre, naturaleza: d.naturaleza, nivel: 1, elementoNiif: d.elementoNiif, activa: true, origen: 'catalogo' },
        { transaction }
      );
      resultado.creadas.push(entrada.codigo);
    }
  });
  if (resultado.creadas.length || resultado.reactivadas.length) {
    await auditoria.registrar({
      empresaId,
      usuarioId,
      accion: 'catalogo_cuentas_activado',
      entidad: 'plan_cuentas',
      detalle: `creadas: ${resultado.creadas.join(',') || '-'}; reactivadas: ${resultado.reactivadas.join(',') || '-'}`,
    });
  }
  return resultado;
}

// Cambia el nombre y/o activa o desactiva. El código no se cambia nunca.
async function actualizar(empresaId, usuarioId, id, datos) {
  const cuenta = await PlanCuentas.findOne({ where: { id, empresaId } });
  if (!cuenta) return null;
  const cambios = {};

  if (datos.nombre !== undefined) {
    const nom = reglas.validarNombre(datos.nombre);
    if (!nom.ok) throw new Error(nom.error);
    cambios.nombre = nom.nombre;
  }

  if (datos.activa !== undefined && !!datos.activa !== !!cuenta.activa) {
    if (datos.activa === false) {
      if (reglas.CUENTAS_ESENCIALES.includes(cuenta.codigo)) {
        throw new Error(`La cuenta ${cuenta.codigo} la usa el sistema en las compras (IVA, retenciones, proveedores); no se puede desactivar.`);
      }
      const usos = (await reglasPorCuenta(empresaId))[cuenta.id];
      if (usos && usos.length) {
        throw new Error(`La cuenta ${cuenta.codigo} la usan las reglas de contabilización: ${Array.from(new Set(usos)).join(', ')}. Cambia esas reglas antes de desactivarla.`);
      }
      const bancos = (await bancosPorCuenta(empresaId))[cuenta.id];
      if (bancos && bancos.length) {
        throw new Error(`La cuenta ${cuenta.codigo} es la cuenta contable de la cuenta bancaria ${bancos.join(', ')}; no se puede desactivar.`);
      }
      const hijas = await PlanCuentas.count({ where: { empresaId, cuentaPadreId: cuenta.id, activa: true } });
      if (hijas > 0) throw new Error(`La cuenta ${cuenta.codigo} tiene subcuentas activas. Desactívalas primero.`);
      cambios.activa = false;
    } else {
      if (cuenta.cuentaPadreId) {
        const padre = await PlanCuentas.findByPk(cuenta.cuentaPadreId);
        if (padre && !padre.activa) throw new Error(`Activa primero la cuenta ${padre.codigo}, de la que depende esta subcuenta.`);
      }
      cambios.activa = true;
    }
  }

  if (Object.keys(cambios).length === 0) return resumen(cuenta, 0, []);
  await cuenta.update(cambios);
  await auditoria.registrar({
    empresaId,
    usuarioId,
    accion: cambios.activa === undefined ? 'cuenta_renombrada' : cambios.activa ? 'cuenta_activada' : 'cuenta_desactivada',
    entidad: 'plan_cuentas',
    entidadId: cuenta.id,
    detalle: `${cuenta.codigo} ${cuenta.nombre}`,
  });
  const [movs, usos, bancos] = await Promise.all([conteoMovimientos([cuenta.id]), reglasPorCuenta(empresaId), bancosPorCuenta(empresaId)]);
  return resumen(cuenta, movs[cuenta.id], usos[cuenta.id], bancos[cuenta.id]);
}

module.exports = { listar, catalogo, crear, activarCatalogo, actualizar };
