const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const Asiento = require('../models/Asiento');
const Movimiento = require('../models/Movimiento');
const ReglaContabilizacion = require('../models/ReglaContabilizacion');
const PeriodoContable = require('../models/PeriodoContable');
const PlanCuentas = require('../models/PlanCuentas');

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

// Cuenta alternativa que un módulo pide usar: debe ser de la misma empresa.
async function cuentaDeLaEmpresa(id, empresaId) {
  const cuenta = await PlanCuentas.findOne({ where: { id, empresaId } });
  if (!cuenta) throw new Error('La cuenta contable indicada no pertenece a la empresa.');
  return cuenta.id;
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
 * @param {string} [evento.cuentaDebitoId]  - cuenta distinta a la de la regla (ej. el auxiliar de un banco)
 * @param {string} [evento.cuentaCreditoId] - ídem para el crédito
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

  // La regla da las cuentas "por defecto"; un módulo puede afinar una de las dos
  // (ej. tesorería usa el auxiliar del banco en vez de 1110 Bancos).
  const cuentaDebitoId = evento.cuentaDebitoId ? await cuentaDeLaEmpresa(evento.cuentaDebitoId, evento.empresaId) : regla.cuentaDebitoId;
  const cuentaCreditoId = evento.cuentaCreditoId ? await cuentaDeLaEmpresa(evento.cuentaCreditoId, evento.empresaId) : regla.cuentaCreditoId;

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
      cuentaId: cuentaDebitoId,
      terceroId: evento.terceroId,
      debito: evento.valor,
      credito: 0,
    },
    {
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: cuentaCreditoId,
      terceroId: evento.terceroId,
      debito: 0,
      credito: evento.valor,
    },
  ]);

  return { requiereRevision: regla.nivelAutomatizacion === 'asistido', asiento };
}

const centavos = (n) => Math.round((Number(n) + Number.EPSILON) * 100);

// Periodo abierto que contiene la fecha del documento. Si no hay (la
// factura es de un mes ya cerrado o aún no creado), se usa el periodo
// vigente con fecha de hoy y se avisa con `ajustada: true`: nunca se
// escribe en un periodo cerrado.
async function resolverPeriodoParaFecha(empresaId, fecha, transaction) {
  if (fecha) {
    const exacto = await PeriodoContable.findOne({
      where: {
        empresaId,
        estado: { [Op.in]: ['abierto', 'en_cierre'] },
        fechaInicio: { [Op.lte]: fecha },
        fechaFin: { [Op.gte]: fecha },
      },
      transaction,
    });
    if (exacto) return { periodo: exacto, fecha, ajustada: false };
  }
  const vigente = await PeriodoContable.findOne({
    where: { empresaId, estado: { [Op.in]: ['abierto', 'en_cierre'] } },
    order: [['fechaInicio', 'DESC']],
    transaction,
  });
  if (!vigente) {
    throw new Error('No hay un periodo contable abierto para esta empresa. Crea uno antes de contabilizar.');
  }
  return { periodo: vigente, fecha: new Date().toISOString().slice(0, 10), ajustada: !!fecha };
}

// Definición de una cuenta que el sistema sabe crear sola: las del catálogo
// base (seedService.CUENTAS) y las de nómina (asientoNomina.CATALOGO, que
// incluye subcuentas de 6 dígitos con su cuenta padre).
function definicionCuentaBase(codigo) {
  // require diferido: seedService requiere modelos, no queremos ciclos al cargar.
  const base = require('./seedService').CUENTAS.find((c) => c.codigo === codigo);
  if (base) return { ...base, padre: null };
  return require('../../../public/contable/asientoNomina').CATALOGO.find((c) => c.codigo === codigo) || null;
}

// Cuentas por código. Si falta una de las cuentas base del sistema
// (empresas creadas antes de que existiera, ej. 2365 retención, o las de
// nómina), se crea al vuelo con su cuenta padre; cualquier otro código
// inexistente es un error.
async function cuentasPorCodigo(empresaId, codigos, transaction) {
  const unicos = Array.from(new Set(codigos));
  const existentes = await PlanCuentas.findAll({ where: { empresaId, codigo: { [Op.in]: unicos } }, transaction });
  const mapa = Object.fromEntries(existentes.map((c) => [c.codigo, c]));

  const asegurar = async (codigo) => {
    if (mapa[codigo]) return mapa[codigo];
    const base = definicionCuentaBase(codigo);
    if (!base) throw new Error(`La cuenta ${codigo} no existe en el plan de cuentas.`);
    let padre = null;
    if (base.padre) {
      padre = await PlanCuentas.findOne({ where: { empresaId, codigo: base.padre }, transaction });
      if (!padre) padre = await asegurar(base.padre);
    }
    mapa[codigo] = await PlanCuentas.create(
      {
        id: uuidv4(),
        empresaId,
        codigo: base.codigo,
        nombre: base.nombre,
        naturaleza: base.naturaleza,
        nivel: base.codigo.length === 8 ? 3 : base.codigo.length === 6 ? 2 : 1,
        cuentaPadreId: padre ? padre.id : null,
        elementoNiif: base.elementoNiif,
      },
      { transaction }
    );
    return mapa[codigo];
  };

  for (const codigo of unicos) await asegurar(codigo);
  return mapa;
}

/**
 * Asiento de VARIAS líneas (a diferencia de contabilizarEvento, que solo
 * hace un débito y un crédito). Lo usan los documentos que ya traen su
 * desglose: una factura de compra con gasto + IVA descontable + proveedor
 * + retenciones, por ejemplo.
 *
 * La regla del evento sigue mandando sobre el nivel de automatización:
 *   - 'manual'    no se contabiliza; queda para el contador.
 *   - 'asistido'  el asiento queda en borrador, salvo que quien llama ya
 *                 revisó el desglose (`revisado: true`), como en la vista
 *                 previa de la factura XML.
 *   - 'automatico' se contabiliza.
 *
 * @param {Object} evento
 * @param {Array<{cuentaCodigo:string, debito?:number, credito?:number, terceroId?:string, centroCosto?:string}>} evento.lineas
 * @param {string} [evento.fecha]       'YYYY-MM-DD' del documento
 * @param {boolean} [evento.revisado]
 * @param {Object} [evento.transaction]
 */
async function contabilizarAsientoCompuesto(evento) {
  const { transaction } = evento;
  const regla = await ReglaContabilizacion.findOne({
    where: { empresaId: evento.empresaId, eventoOrigen: evento.tipoEvento },
    transaction,
  });
  if (!regla) {
    throw new Error(
      `No existe regla de contabilización para el evento "${evento.tipoEvento}". ` +
        `Configúrala en Plan de cuentas > Reglas antes de continuar.`
    );
  }
  if (regla.nivelAutomatizacion === 'manual') {
    return { requiereRevision: true, regla, asiento: null, periodoAjustado: false };
  }

  const lineas = (evento.lineas || [])
    .map((l) => ({ ...l, debito: centavos(l.debito || 0), credito: centavos(l.credito || 0) }))
    .filter((l) => l.debito !== 0 || l.credito !== 0);
  if (lineas.some((l) => l.debito < 0 || l.credito < 0 || (l.debito > 0 && l.credito > 0))) {
    throw new Error('Cada línea del asiento debe tener solo débito o solo crédito, y no negativos.');
  }
  const totalDebito = lineas.reduce((s, l) => s + l.debito, 0);
  const totalCredito = lineas.reduce((s, l) => s + l.credito, 0);
  if (lineas.length < 2 || totalDebito !== totalCredito) {
    throw new Error(
      `El asiento no cuadra: débitos ${(totalDebito / 100).toFixed(2)} vs créditos ${(totalCredito / 100).toFixed(2)}.`
    );
  }

  const cuentas = await cuentasPorCodigo(evento.empresaId, lineas.map((l) => l.cuentaCodigo), transaction);
  const { periodo, fecha, ajustada } = await resolverPeriodoParaFecha(evento.empresaId, evento.fecha, transaction);

  const asiento = await Asiento.create(
    {
      id: uuidv4(),
      empresaId: evento.empresaId,
      periodoContableId: periodo.id,
      fecha,
      origenModulo: evento.origenModulo,
      origenId: evento.origenId,
      estado: regla.nivelAutomatizacion === 'asistido' && !evento.revisado ? 'borrador' : 'contabilizado',
      usuarioId: evento.usuarioId,
    },
    { transaction }
  );

  await Movimiento.bulkCreate(
    lineas.map((l) => ({
      id: uuidv4(),
      asientoId: asiento.id,
      cuentaId: cuentas[l.cuentaCodigo].id,
      terceroId: l.terceroId || evento.terceroId,
      debito: l.debito / 100,
      credito: l.credito / 100,
      centroCosto: l.centroCosto || null,
    })),
    { transaction }
  );

  return { requiereRevision: asiento.estado === 'borrador', regla, asiento, periodoAjustado: ajustada };
}

module.exports = { contabilizarEvento, contabilizarAsientoCompuesto, cuentasPorCodigo };
