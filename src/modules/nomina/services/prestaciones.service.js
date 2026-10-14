// Prestaciones sociales, vacaciones en dinero y liquidación final del contrato.
//
// El cálculo vive en public/contable/prestacionesNomina.js y los asientos en
// public/contable/asientoNomina.js (los mismos archivos que usan las pruebas).
// Aquí se arma la entrada con lo guardado (contratos, ausencias, nóminas ya
// contabilizadas y el saldo contable de las provisiones), se guarda el
// resultado y se contabiliza con el motor de asientos.
//
// Documentos (NominaPrestacion):
//   prima · cesantías · intereses    para todos los empleados de un semestre o año
//   vacaciones                       días pagados en dinero a un empleado
//   liquidacion                      liquidación final de un contrato
// Estados: borrador (se recalcula) -> pagada (con asiento) -> anulada.

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Tercero = require('../../../core/models/Tercero');
const Empresa = require('../../../core/models/Empresa');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Asiento = require('../../../core/models/Asiento');
const Movimiento = require('../../../core/models/Movimiento');
const PeriodoContable = require('../../../core/models/PeriodoContable');
const CuentaBancaria = require('../../tesoreria/models/CuentaBancaria');
const MovimientoBancario = require('../../tesoreria/models/MovimientoBancario');
const ContratoLaboral = require('../models/ContratoLaboral');
const AusenciaNomina = require('../models/AusenciaNomina');
const ConceptoNomina = require('../models/ConceptoNomina');
const NominaPeriodo = require('../models/NominaPeriodo');
const NominaLiquidacion = require('../models/NominaLiquidacion');
const NominaPrestacion = require('../models/NominaPrestacion');
const NominaPrestacionLinea = require('../models/NominaPrestacionLinea');
const NominaPlanillaPago = require('../models/NominaPlanillaPago');
const { contabilizarAsientoCompuesto } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const auditoria = require('../../../core/services/auditoria');
const { asegurarCuentaContable } = require('../../tesoreria/services/contabilidadBancaria');
const PL = require('../../../../public/contable/parametrosLaborales');
const { liquidarEmpleado, aMultiplo100 } = require('../../../../public/contable/liquidacionNomina');
const AN = require('../../../../public/contable/asientoNomina');
const PN = require('../../../../public/contable/prestacionesNomina');
const nominaService = require('./nomina.service');

const {
  armarEntrada, obtenerConfigFila, fechaValida, hoyColombia, limpiarTexto, dinero, mesTexto, plano, empleadosDe,
  asegurarReglasNomina, enriquecerAsiento, nombresCuentas,
} = nominaService._interno;

const TIPOS_LOTE = ['prima', 'cesantias', 'intereses'];
const NOMBRES_TIPO = {
  prima: 'Prima de servicios', cesantias: 'Cesantías', intereses: 'Intereses sobre cesantías',
  vacaciones: 'Vacaciones en dinero', liquidacion: 'Liquidación final',
};
const MAX_FILAS_DESCUENTOS = 20;

const num = (x) => Number(x) || 0;
const pesos = (x) => Math.round(Number(x) || 0);
const suma = (lista, f) => lista.reduce((s, x) => s + f(x), 0);
const redondear2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// --- Contexto: todo lo guardado que hace falta para calcular --------------------------
async function cargarContexto(empresaId, empleadoIds) {
  const ids = Array.from(new Set(empleadoIds));
  const porEmpleado = ids.length ? { empleadoId: { [Op.in]: ids } } : { empleadoId: null };
  const [config, periodos, ausencias, conceptos] = await Promise.all([
    obtenerConfigFila(empresaId),
    NominaPeriodo.findAll({ where: { empresaId } }),
    AusenciaNomina.findAll({ where: { empresaId, ...porEmpleado } }),
    ConceptoNomina.findAll({ where: { empresaId, activo: true, ...porEmpleado } }),
  ]);
  const cerrados = periodos.filter((p) => ['contabilizada', 'pagada'].includes(p.estado));
  const liqs = cerrados.length && ids.length
    ? await NominaLiquidacion.findAll({ where: { periodoId: { [Op.in]: cerrados.map((p) => p.id) }, ...porEmpleado } })
    : [];
  return {
    empresaId,
    config,
    periodos,
    periodoPorMes: new Map(cerrados.map((p) => [`${p.anio}-${p.mes}`, p])),
    mesesAbiertos: new Map(periodos.filter((p) => p.estado === 'borrador').map((p) => [`${p.anio}-${p.mes}`, p])),
    liqPorClave: new Map(liqs.map((l) => [`${l.periodoId}|${l.empleadoId}`, l])),
    ausencias,
    conceptos,
  };
}

const ausenciasDe = (ctx, empleadoId) => ctx.ausencias.filter((a) => a.empleadoId === empleadoId);
const ausenciasMotor = (ctx, empleadoId) => ausenciasDe(ctx, empleadoId).map((a) => ({ tipo: a.tipo, desde: a.fechaInicio, hasta: a.fechaFin }));

// Liquidación del empleado en un mes: la guardada (nómina ya contabilizada) o, si no la hay,
// la que daría el motor hoy con los datos del contrato.
function liquidacionDeMes(ctx, contrato, anio, mes, forzarContrato) {
  const inicio = PL.texto(anio, mes, 1);
  const fin = PL.texto(anio, mes, PL.diasDelMes(anio, mes));
  if (contrato.fechaIngreso > fin) return null;
  if (contrato.fechaTerminacion && contrato.fechaTerminacion < inicio) return null;
  const periodo = ctx.periodoPorMes.get(`${anio}-${mes}`);
  const guardada = periodo && ctx.liqPorClave.get(`${periodo.id}|${contrato.empleadoId}`);
  if (!forzarContrato && guardada && !guardada.error && guardada.resultado && guardada.contratoId === contrato.id) {
    const sal = guardada.entrada && guardada.entrada.contrato ? num(guardada.entrada.contrato.salarioBase) : num(contrato.salarioBase);
    return { L: guardada.resultado, salarioBase: sal, estimado: false };
  }
  const ordenActual = anio * 12 + mes;
  const conceptosMes = ctx.conceptos.filter((c) => c.empleadoId === contrato.empleadoId && (c.recurrente
    ? c.desdeAnio * 12 + c.desdeMes <= ordenActual
    : c.anio === anio && c.mes === mes));
  try {
    const L = liquidarEmpleado(armarEntrada(contrato, ctx.config, ausenciasDe(ctx, contrato.empleadoId).filter((a) => a.fechaInicio <= fin && a.fechaFin >= inicio), conceptosMes, anio, mes));
    return { L, salarioBase: num(contrato.salarioBase), estimado: true };
  } catch (e) {
    return null;
  }
}

// Meses de referencia (con los datos que usan las prestaciones) entre dos fechas.
function mesesDe(ctx, contrato, desde, hasta) {
  const lista = [];
  let a = Number(desde.slice(0, 4));
  let m = Number(desde.slice(5, 7));
  const fin = Number(hasta.slice(0, 4)) * 12 + Number(hasta.slice(5, 7));
  while (a * 12 + m <= fin) {
    const r = liquidacionDeMes(ctx, contrato, a, m);
    if (r) lista.push(PN.mesDeLiquidacion(r.L, { salarioBase: r.salarioBase, estimado: r.estimado }));
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return lista;
}

// Saldo (crédito − débito) de las cuentas de prestaciones de cada empleado hasta una fecha.
async function saldosProvision(empresaId, empleadoIds, hasta) {
  const resultado = {};
  for (const id of empleadoIds) resultado[id] = { 2510: 0, 2515: 0, 2520: 0, 2525: 0 };
  if (!empleadoIds.length) return resultado;
  const cuentas = await PlanCuentas.findAll({ where: { empresaId, codigo: { [Op.in]: ['2510', '2515', '2520', '2525'] } } });
  if (!cuentas.length) return resultado;
  const codigoPorId = Object.fromEntries(cuentas.map((c) => [c.id, c.codigo]));
  const movs = await Movimiento.findAll({ where: { cuentaId: { [Op.in]: cuentas.map((c) => c.id) }, terceroId: { [Op.in]: empleadoIds } } });
  if (!movs.length) return resultado;
  const asientos = await Asiento.findAll({
    where: { empresaId, estado: 'contabilizado', fecha: { [Op.lte]: hasta }, id: { [Op.in]: Array.from(new Set(movs.map((m) => m.asientoId))) } },
    attributes: ['id'],
  });
  const validos = new Set(asientos.map((a) => a.id));
  for (const mv of movs) {
    if (!validos.has(mv.asientoId)) continue;
    const fila = resultado[mv.terceroId];
    const cod = codigoPorId[mv.cuentaId];
    fila[cod] = pesos(fila[cod] + num(mv.credito) - num(mv.debito));
  }
  return resultado;
}

// Días hábiles de vacaciones ya usados: disfrutados (ausencias) y pagados en dinero (documentos).
async function vacacionesUsadas(ctx, empleadoId, corte, excluirPrestacionId) {
  const semana = ctx.config.semanaLaboral || 5;
  let tomados = 0;
  for (const a of ausenciasDe(ctx, empleadoId)) {
    if (a.tipo !== 'vacaciones' || a.fechaInicio > corte) continue;
    tomados += PN.diasHabiles(a.fechaInicio, a.fechaFin < corte ? a.fechaFin : corte, semana);
  }
  const docs = await NominaPrestacion.findAll({
    where: { empresaId: ctx.empresaId, tipo: { [Op.in]: ['vacaciones', 'liquidacion'] }, estado: 'pagada', ...(excluirPrestacionId ? { id: { [Op.ne]: excluirPrestacionId } } : {}) },
    attributes: ['id'],
  });
  let compensados = 0;
  if (docs.length) {
    const lineas = await NominaPrestacionLinea.findAll({ where: { prestacionId: { [Op.in]: docs.map((d) => d.id) }, empleadoId } });
    for (const l of lineas) {
      for (const c of l.componentes || []) if (c.concepto === 'vacaciones') compensados += num(c.dias);
    }
  }
  return { tomados: redondear2(tomados), compensados: redondear2(compensados) };
}

// --- Cálculo de una línea ---------------------------------------------------------------
function vacioLinea(contrato, extra) {
  return Object.assign({
    empleadoId: contrato.empleadoId, contratoId: contrato.id, areaGasto: contrato.areaGasto,
    devengado: 0, retencion: 0, descuentos: 0, neto: 0, componentes: [], descuentosDetalle: [], resultado: null, error: null, advertencias: [],
  }, extra || {});
}

function componenteDe(det, extra) {
  return Object.assign({
    concepto: det.concepto, nombre: PN.CONCEPTOS[det.concepto].nombre, valor: det.valor, dias: det.dias,
    desde: det.desde, hasta: det.hasta, base: det.base, metodo: det.metodo, liquidaTotal: true,
  }, extra || {});
}

function retencionPago(ctx, contrato, fechaPago, adicional) {
  const a = Number(fechaPago.slice(0, 4));
  const m = Number(fechaPago.slice(5, 7));
  const r = liquidacionDeMes(ctx, contrato, a, m, true);
  return PN.retencionAdicional({ anio: a, liquidacion: r ? r.L : null, contrato, adicional });
}

function calcularLineaLote(tipo, { ctx, contrato, anio, semestre, corte, fechaPago, saldo }) {
  const ausencias = ausenciasMotor(ctx, contrato.empleadoId);
  const inicioCes = PL.texto(anio, 1, 1);
  let det;
  if (tipo === 'prima') {
    const inicio = PL.texto(anio, semestre === 1 ? 1 : 7, 1);
    const meses = mesesDe(ctx, contrato, maxFecha(contrato.fechaIngreso, inicio), corte);
    det = PN.calcularPrima({ contrato, anio, semestre, corte, meses, ausencias });
  } else {
    const meses = mesesDe(ctx, contrato, maxFecha(contrato.fechaIngreso, inicioCes), corte);
    const ces = PN.calcularCesantias({ contrato, anio, corte, meses, ausencias });
    det = tipo === 'cesantias' ? ces : PN.calcularIntereses({ cesantias: ces });
    if (tipo === 'intereses') det.cesantias = ces.valor;
  }
  const advertencias = [...det.advertencias];
  const clave = PN.CONCEPTOS[tipo].pasivo;
  const comp = componenteDe(det, { saldoProvision: saldo[clave] });
  let retencion = 0;
  if (PN.CONCEPTOS[tipo].salario && det.valor > 0) {
    const r = retencionPago(ctx, contrato, fechaPago, det.valor);
    retencion = r.valor;
    if (r.modo === 'manual') advertencias.push('La retención de este contrato es un valor fijo mensual: no se calculó retención sobre la prima.');
    if (r.modo === 'sin_base') advertencias.push('No se pudo estimar la retención en la fuente de la prima.');
  }
  if (det.valor > 0 && Math.abs(saldo[clave]) > 0 && saldo[clave] < det.valor * 0.5) {
    advertencias.push(`El libro tiene causado ${pesos(saldo[clave]).toLocaleString('es-CO')} de ${PN.CONCEPTOS[tipo].nombre.toLowerCase()}; la diferencia va a gasto al pagar.`);
  }
  return vacioLinea(contrato, {
    devengado: det.valor, retencion, neto: det.valor - retencion,
    componentes: det.valor > 0 ? [comp] : [],
    resultado: { detalle: det, retencion },
    advertencias,
  });
}

function maxFecha(a, b) { return a > b ? a : b; }

async function calcularLineaVacaciones({ ctx, contrato, dias, corte, fechaPago, saldo, prestacionId }) {
  const usados = await vacacionesUsadas(ctx, contrato.empleadoId, corte, prestacionId);
  const meses = mesesDe(ctx, contrato, PL.sumarDias(corte, -365), corte);
  const det = PN.calcularVacacionesEnDinero({
    contrato, corte, ausencias: ausenciasMotor(ctx, contrato.empleadoId), tomados: usados.tomados, compensados: usados.compensados, meses, dias,
  });
  const advertencias = [...det.advertencias];
  if (det.dias > PN.DIAS_VACACIONES_ANIO / 2 + 1e-9) {
    advertencias.push('Lo normal es compensar hasta la mitad de las vacaciones de un año (CST art. 189); el resto se disfruta. Verifica que haya acuerdo y que sea por este saldo.');
  }
  const comp = componenteDe(det, { saldoProvision: saldo['2525'], liquidaTotal: false, dias: det.dias });
  const r = retencionPago(ctx, contrato, fechaPago, det.valor);
  if (r.modo === 'sin_base') advertencias.push('No se pudo estimar la retención en la fuente.');
  return vacioLinea(contrato, {
    devengado: det.valor, retencion: r.valor, neto: det.valor - r.valor,
    componentes: [comp], resultado: { detalle: det, retencion: r, usados }, advertencias,
  });
}

async function calcularLineaLiquidacion({ ctx, contrato, entrada, saldo, prestacionId }) {
  const retiro = entrada.fechaRetiro;
  const c = Object.assign({}, plano(contrato), { fechaTerminacion: retiro });
  const meses = mesesDe(ctx, c, PL.sumarDias(retiro, -365), retiro);
  const usados = await vacacionesUsadas(ctx, contrato.empleadoId, retiro, prestacionId);
  const forzado = liquidacionDeMes(ctx, c, Number(retiro.slice(0, 4)), Number(retiro.slice(5, 7)), true);
  const descuentos = (entrada.descuentos || []).map((d) => ({
    descripcion: d.descripcion || (PL.DESCUENTOS[d.codigo] ? PL.DESCUENTOS[d.codigo].nombre : 'Descuento'),
    valor: d.valor, codigo: d.codigo, cuenta: PL.DESCUENTOS[d.codigo].cuenta,
  }));
  const liq = PN.liquidarContrato({
    contrato: c, fechaRetiro: retiro, causa: entrada.causa, meses, ausencias: ausenciasMotor(ctx, contrato.empleadoId),
    vacaciones: usados, liquidacionMes: forzado ? forzado.L : null,
    indemnizacionDias: entrada.indemnizacionDias, otrosDevengos: entrada.otrosDevengos, descuentos,
  });
  const advertencias = [...liq.advertencias];
  const componentes = liq.componentes.map((x) => {
    const clave = PN.CONCEPTOS[x.concepto].pasivo;
    return clave ? Object.assign({}, x, { saldoProvision: saldo[clave] }) : x;
  });
  // Nómina del mes del retiro: ahí se paga el sueldo hasta la salida.
  const a = Number(retiro.slice(0, 4));
  const m = Number(retiro.slice(5, 7));
  const abierta = ctx.mesesAbiertos.get(`${a}-${m}`);
  if (abierta) advertencias.push(`Recalcula la nómina de ${mesTexto(a, m)} (está en borrador): ahí se paga el sueldo hasta el ${retiro}.`);
  if (!ctx.periodoPorMes.get(`${a}-${m}`) && !abierta) advertencias.push(`Falta crear la nómina de ${mesTexto(a, m)}: allí se liquida el sueldo y se causan las provisiones del mes hasta el retiro.`);
  if (contrato.fechaIngreso < PL.texto(a, 1, 1)) {
    advertencias.push(`Verifica que las cesantías de ${a - 1} y sus intereses ya se consignaron/pagaron; si no, súmalos en “Otros pagos”.`);
  }
  return vacioLinea(contrato, {
    devengado: liq.devengado, retencion: liq.retencion.valor, descuentos: liq.totalDescuentos, neto: liq.neto,
    componentes, descuentosDetalle: liq.descuentos,
    resultado: { liquidacion: Object.assign({}, liq, { componentes }), usados }, advertencias,
  });
}

// --- Documentos --------------------------------------------------------------------------
const FILA_DOC = ['totalDevengado', 'totalRetencion', 'totalDescuentos', 'totalNeto'];

function validarFechaPago(fecha, nombre) {
  if (!fechaValida(fecha)) throw new Error(`Escribe ${nombre} (AAAA-MM-DD).`);
}

function cortePorDefecto(tipo, anio, semestre) {
  if (tipo === 'prima') return semestre === 1 ? PL.texto(anio, 6, 30) : PL.texto(anio, 12, 31);
  return PL.texto(anio, 12, 31);
}

async function documentoDe(id, empresaId, transaction) {
  const doc = await NominaPrestacion.findOne({ where: { id, empresaId }, transaction });
  if (!doc) throw new Error('Documento de prestaciones no encontrado.');
  return doc;
}

// Contratos que entran a un documento por lote.
async function contratosDelLote(empresaId, doc) {
  const corte = doc.fechaCorte;
  const inicio = doc.tipo === 'prima' ? PL.texto(doc.anio, doc.semestre === 1 ? 1 : 7, 1) : PL.texto(doc.anio, 1, 1);
  const todos = await ContratoLaboral.findAll({
    where: { empresaId, fechaIngreso: { [Op.lte]: corte }, [Op.or]: [{ fechaTerminacion: null }, { fechaTerminacion: { [Op.gte]: inicio } }] },
    order: [['fechaIngreso', 'ASC']],
  });
  const incluidos = [];
  const omitidos = [];
  const liquidados = await NominaPrestacion.findAll({ where: { empresaId, tipo: 'liquidacion', estado: 'pagada', anio: doc.anio } });
  const lineasLiq = liquidados.length ? await NominaPrestacionLinea.findAll({ where: { prestacionId: { [Op.in]: liquidados.map((d) => d.id) } } }) : [];
  const contratosLiquidados = new Set(lineasLiq.map((l) => l.contratoId));
  for (const c of todos) {
    if (c.tipoSalario === 'integral') { omitidos.push({ contrato: c, motivo: 'salario integral (incluye prestaciones)' }); continue; }
    if (c.fechaTerminacion && c.fechaTerminacion <= corte) { omitidos.push({ contrato: c, motivo: 'contrato terminado: se liquida en la liquidación final' }); continue; }
    if (contratosLiquidados.has(c.id)) { omitidos.push({ contrato: c, motivo: 'ya tiene liquidación final' }); continue; }
    incluidos.push(c);
  }
  return { incluidos, omitidos };
}

// Calcula todas las líneas de un documento y las deja guardadas.
async function calcularYGuardar(doc, usuario, patch) {
  const empresaId = usuario.empresaId;
  const fechaPago = (patch && patch.fechaPago) || doc.fechaPago || hoyColombia();
  validarFechaPago(fechaPago, 'la fecha de pago');
  const advertenciasDoc = [];
  let filas = [];

  if (TIPOS_LOTE.includes(doc.tipo)) {
    const { incluidos, omitidos } = await contratosDelLote(empresaId, doc);
    const ids = incluidos.map((c) => c.empleadoId);
    const ctx = await cargarContexto(empresaId, ids);
    const saldos = await saldosProvision(empresaId, ids, PN.finDeMes(doc.fechaCorte));
    const vistos = new Set();
    for (const c of incluidos) {
      if (vistos.has(c.empleadoId)) { filas.push(vacioLinea(c, { error: 'El empleado tiene más de un contrato en el período; liquídalo por separado.' })); continue; }
      vistos.add(c.empleadoId);
      try {
        filas.push(calcularLineaLote(doc.tipo, { ctx, contrato: c, anio: doc.anio, semestre: doc.semestre, corte: doc.fechaCorte, fechaPago, saldo: saldos[c.empleadoId] }));
      } catch (e) {
        filas.push(vacioLinea(c, { error: String(e.message).slice(0, 500) }));
      }
    }
    if (omitidos.length) {
      const emp = await empleadosDe(empresaId, omitidos.map((o) => o.contrato.empleadoId));
      for (const o of omitidos) advertenciasDoc.push(`${emp[o.contrato.empleadoId] ? emp[o.contrato.empleadoId].nombre : 'Empleado'}: no entra (${o.motivo}).`);
    }
    filas = filas.filter((f) => f.error || f.componentes.length);
  } else {
    const previas = await NominaPrestacionLinea.findAll({ where: { prestacionId: doc.id } });
    const previa = previas[0];
    if (!previa) throw new Error('El documento no tiene empleado.');
    const contrato = await ContratoLaboral.findOne({ where: { id: previa.contratoId, empresaId } });
    if (!contrato) throw new Error('Contrato no encontrado.');
    const ctx = await cargarContexto(empresaId, [contrato.empleadoId]);
    const entrada = Object.assign({}, previa.entrada || {}, patch && patch.entrada ? patch.entrada : {});
    try {
      if (doc.tipo === 'vacaciones') {
        const saldos = await saldosProvision(empresaId, [contrato.empleadoId], PN.finDeMes(doc.fechaCorte));
        filas.push(Object.assign(await calcularLineaVacaciones({
          ctx, contrato, dias: entrada.dias, corte: doc.fechaCorte, fechaPago, saldo: saldos[contrato.empleadoId], prestacionId: doc.id,
        }), { entrada }));
      } else {
        const saldos = await saldosProvision(empresaId, [contrato.empleadoId], PN.finDeMes(entrada.fechaRetiro));
        filas.push(Object.assign(await calcularLineaLiquidacion({ ctx, contrato, entrada, saldo: saldos[contrato.empleadoId], prestacionId: doc.id }), { entrada }));
      }
    } catch (e) {
      filas.push(vacioLinea(contrato, { error: String(e.message).slice(0, 500), entrada }));
    }
  }

  const buenas = filas.filter((f) => !f.error);
  await sequelize.transaction(async (transaction) => {
    await NominaPrestacionLinea.destroy({ where: { prestacionId: doc.id }, transaction });
    for (const f of filas) {
      await NominaPrestacionLinea.create({
        id: uuidv4(), empresaId, prestacionId: doc.id, empleadoId: f.empleadoId, contratoId: f.contratoId, areaGasto: f.areaGasto || 'administracion',
        devengado: f.devengado, retencion: f.retencion, descuentos: f.descuentos, neto: f.neto,
        componentes: f.componentes, descuentosDetalle: f.descuentosDetalle, resultado: f.resultado ? Object.assign({}, f.resultado, { advertencias: f.advertencias }) : null,
        entrada: f.entrada || null, error: f.error || null,
      }, { transaction });
    }
    await doc.update({
      fechaPago,
      totalDevengado: suma(buenas, (f) => f.devengado), totalRetencion: suma(buenas, (f) => f.retencion),
      totalDescuentos: suma(buenas, (f) => f.descuentos), totalNeto: suma(buenas, (f) => f.neto),
    }, { transaction });
  });
  return advertenciasDoc;
}

async function detalleDocumento(id, usuario, extraAdvertencias) {
  const empresaId = usuario.empresaId;
  const doc = await documentoDe(id, empresaId);
  const lineas = await NominaPrestacionLinea.findAll({ where: { prestacionId: doc.id }, order: [['createdAt', 'ASC']] });
  const emp = await empleadosDe(empresaId, lineas.map((l) => l.empleadoId));
  const contratos = await ContratoLaboral.findAll({ where: { id: { [Op.in]: lineas.map((l) => l.contratoId) } } });
  const contratoPorId = Object.fromEntries(contratos.map((c) => [c.id, c]));

  const filas = lineas.map((l) => {
    const e = emp[l.empleadoId];
    const c = contratoPorId[l.contratoId];
    return {
      id: l.id, empleadoId: l.empleadoId, nombre: e ? e.nombre : '(empleado eliminado)', identificacion: e ? e.identificacion : '',
      cargo: c ? c.cargo || '' : '', areaGasto: l.areaGasto,
      devengado: num(l.devengado), retencion: num(l.retencion), descuentos: num(l.descuentos), neto: num(l.neto),
      componentes: l.componentes || [], descuentosDetalle: l.descuentosDetalle || [],
      entrada: l.entrada || null, error: l.error, advertencias: (l.resultado && l.resultado.advertencias) || [],
    };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  const nombresTerceros = Object.fromEntries(Object.entries(emp).map(([k, e]) => [k, e.nombre]));
  let asiento = null;
  if (doc.estado === 'pagada' && doc.asientoId) {
    asiento = await asientoGuardado(doc.asientoId, nombresTerceros);
  } else if (doc.estado === 'borrador' && filas.length && !filas.some((f) => f.error)) {
    try {
      const items = itemsDeAsiento(filas);
      asiento = enriquecerAsiento(AN.armarAsientoPrestaciones(items, '1110'), nombresTerceros);
      asiento.provisional = true;
    } catch (e) {
      asiento = { error: e.message };
    }
  }
  const x = plano(doc);
  for (const k of FILA_DOC) x[k] = num(x[k]);
  return {
    prestacion: x,
    nombreTipo: NOMBRES_TIPO[doc.tipo],
    lineas: filas,
    asiento,
    advertencias: Array.from(new Set([...(extraAdvertencias || []), ...filas.flatMap((f) => f.advertencias)])),
  };
}

function itemsDeAsiento(filas) {
  return filas.map((f) => ({
    terceroId: f.empleadoId, area: f.areaGasto, retencion: f.retencion,
    descuentos: (f.descuentosDetalle || []).map((d) => ({ cuenta: d.cuenta, valor: d.valor })),
    componentes: f.componentes,
  }));
}

async function asientoGuardado(asientoId, nombresTerceros) {
  const movs = await Movimiento.findAll({ where: { asientoId } });
  const cuentas = await PlanCuentas.findAll({ where: { id: { [Op.in]: movs.map((m) => m.cuentaId) } } });
  const porId = Object.fromEntries(cuentas.map((c) => [c.id, c]));
  const lineas = movs.map((m) => ({
    cuentaCodigo: porId[m.cuentaId] ? porId[m.cuentaId].codigo : '', cuentaNombre: porId[m.cuentaId] ? porId[m.cuentaId].nombre : '',
    terceroId: m.terceroId, terceroNombre: m.terceroId ? nombresTerceros[m.terceroId] || '' : '',
    debito: num(m.debito), credito: num(m.credito),
  })).sort((a, b) => (b.debito > 0) - (a.debito > 0) || (a.cuentaCodigo < b.cuentaCodigo ? -1 : 1));
  const totalDebito = suma(lineas, (l) => l.debito);
  const totalCredito = suma(lineas, (l) => l.credito);
  return { lineas, totalDebito, totalCredito, cuadra: Math.abs(totalDebito - totalCredito) < 0.005 };
}

async function listarPrestaciones(usuario, filtros) {
  const where = { empresaId: usuario.empresaId };
  if (filtros && filtros.tipo) where.tipo = filtros.tipo;
  if (filtros && filtros.anio) where.anio = Number(filtros.anio);
  const docs = await NominaPrestacion.findAll({ where, order: [['anio', 'DESC'], ['fechaCorte', 'DESC'], ['createdAt', 'DESC']] });
  const conteos = docs.length
    ? await NominaPrestacionLinea.findAll({
      attributes: ['prestacionId', [sequelize.fn('COUNT', sequelize.col('id')), 'empleados']],
      where: { prestacionId: { [Op.in]: docs.map((d) => d.id) } }, group: ['prestacionId'], raw: true,
    })
    : [];
  const porDoc = Object.fromEntries(conteos.map((c) => [c.prestacionId, Number(c.empleados)]));
  const primeras = docs.length ? await NominaPrestacionLinea.findAll({ where: { prestacionId: { [Op.in]: docs.filter((d) => ['vacaciones', 'liquidacion'].includes(d.tipo)).map((d) => d.id) } } }) : [];
  const emp = await empleadosDe(usuario.empresaId, primeras.map((l) => l.empleadoId));
  const empleadoDeDoc = Object.fromEntries(primeras.map((l) => [l.prestacionId, emp[l.empleadoId] ? emp[l.empleadoId].nombre : '']));
  return docs.map((d) => {
    const x = plano(d);
    for (const k of FILA_DOC) x[k] = num(x[k]);
    x.nombreTipo = NOMBRES_TIPO[d.tipo];
    x.empleados = porDoc[d.id] || 0;
    x.empleado = empleadoDeDoc[d.id] || null;
    return x;
  });
}

async function crearLote(datos, usuario) {
  const empresaId = usuario.empresaId;
  const tipo = datos.tipo;
  if (!TIPOS_LOTE.includes(tipo)) throw new Error('Elige prima, cesantías o intereses sobre cesantías.');
  const hoy = hoyColombia();
  const anio = Number(datos.anio);
  if (!Number.isInteger(anio) || anio < 2020 || anio > Number(hoy.slice(0, 4)) + 1) throw new Error('Escribe un año válido.');
  const semestre = tipo === 'prima' ? Number(datos.semestre) : null;
  if (tipo === 'prima' && ![1, 2].includes(semestre)) throw new Error('Elige el semestre de la prima (1 o 2).');
  const inicio = tipo === 'prima' ? PL.texto(anio, semestre === 1 ? 1 : 7, 1) : PL.texto(anio, 1, 1);
  if (inicio > hoy) throw new Error('Ese período todavía no ha empezado.');

  const repetido = await NominaPrestacion.findOne({ where: { empresaId, tipo, anio, semestre, estado: { [Op.ne]: 'anulada' } } });
  if (repetido) throw new Error(`Ya existe ${NOMBRES_TIPO[tipo].toLowerCase()} de ${tipo === 'prima' ? `${anio} (semestre ${semestre})` : anio} (${repetido.estado}). Ábrelo desde la lista.`);

  const doc = await NominaPrestacion.create({
    id: uuidv4(), empresaId, tipo, anio, semestre, fechaCorte: cortePorDefecto(tipo, anio, semestre),
    fechaPago: datos.fechaPago || hoy, estado: 'borrador', usuarioId: usuario.id,
  });
  let avisos;
  try {
    avisos = await calcularYGuardar(doc, usuario);
  } catch (e) {
    await doc.destroy();
    throw e;
  }
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_prestacion_creada', entidad: 'NominaPrestacion', entidadId: doc.id, detalle: `${tipo} ${anio}${semestre ? ' S' + semestre : ''}`,
  });
  return detalleDocumento(doc.id, usuario, avisos);
}

// Contrato vigente de un empleado en una fecha.
async function contratoVigente(empresaId, empleadoId, fecha) {
  const contratos = await ContratoLaboral.findAll({ where: { empresaId, empleadoId }, order: [['fechaIngreso', 'DESC']] });
  return contratos.find((c) => c.fechaIngreso <= fecha && (!c.fechaTerminacion || c.fechaTerminacion >= fecha)) || null;
}

async function crearVacaciones(datos, usuario) {
  const empresaId = usuario.empresaId;
  const hoy = hoyColombia();
  const fechaPago = datos.fechaPago || hoy;
  validarFechaPago(fechaPago, 'la fecha de pago');
  const empleado = await Tercero.findOne({ where: { id: datos.empleadoId || null, empresaId, tipo: 'empleado' } });
  if (!empleado) throw new Error('Elige un empleado de tu empresa.');
  const contrato = await contratoVigente(empresaId, empleado.id, fechaPago);
  if (!contrato) throw new Error('El empleado no tiene un contrato vigente en esa fecha.');
  const dias = redondear2(datos.dias);
  if (!(dias > 0) || dias > 90) throw new Error('Escribe los días hábiles de vacaciones que se pagan en dinero.');

  const doc = await NominaPrestacion.create({
    id: uuidv4(), empresaId, tipo: 'vacaciones', anio: Number(fechaPago.slice(0, 4)), fechaCorte: fechaPago, fechaPago, estado: 'borrador', usuarioId: usuario.id,
    observaciones: limpiarTexto(datos.observaciones, 255, 'La observación'),
  });
  try {
    await NominaPrestacionLinea.create({
      id: uuidv4(), empresaId, prestacionId: doc.id, empleadoId: empleado.id, contratoId: contrato.id, areaGasto: contrato.areaGasto, entrada: { dias },
    });
    await calcularYGuardar(doc, usuario);
    const lineas = await NominaPrestacionLinea.findAll({ where: { prestacionId: doc.id } });
    if (lineas[0] && lineas[0].error) throw new Error(lineas[0].error);
  } catch (e) {
    await NominaPrestacionLinea.destroy({ where: { prestacionId: doc.id } });
    await doc.destroy();
    throw e;
  }
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_vacaciones_creada', entidad: 'NominaPrestacion', entidadId: doc.id, detalle: `${dias} días · ${empleado.nombre}`,
  });
  return detalleDocumento(doc.id, usuario);
}

function normalizarOtros(lista) {
  if (lista === undefined || lista === null) return [];
  if (!Array.isArray(lista) || lista.length > MAX_FILAS_DESCUENTOS) throw new Error('La lista de otros pagos no es válida.');
  return lista.filter((x) => x && (x.valor !== '' && x.valor !== undefined && x.valor !== null)).map((x) => ({
    descripcion: limpiarTexto(x.descripcion, 100, 'La descripción del pago') || 'Otro pago',
    valor: dinero(x.valor, 'El valor del pago', { positivo: true }),
  }));
}

function normalizarDescuentos(lista) {
  if (lista === undefined || lista === null) return [];
  if (!Array.isArray(lista) || lista.length > MAX_FILAS_DESCUENTOS) throw new Error('La lista de descuentos no es válida.');
  return lista.filter((x) => x && (x.valor !== '' && x.valor !== undefined && x.valor !== null)).map((x) => {
    const codigo = x.codigo || 'otro_descuento';
    if (!PL.DESCUENTOS[codigo]) throw new Error('Elige el tipo de descuento.');
    return {
      codigo, descripcion: limpiarTexto(x.descripcion, 100, 'La descripción del descuento'),
      valor: dinero(x.valor, 'El valor del descuento', { positivo: true }),
    };
  });
}

function normalizarEntradaLiquidacion(datos, contrato) {
  const causa = datos.causa;
  if (!PN.CAUSAS_RETIRO[causa]) throw new Error('Elige la causa del retiro.');
  let fechaRetiro = datos.fechaRetiro || contrato.fechaTerminacion;
  if (contrato.fechaTerminacion) {
    if (datos.fechaRetiro && datos.fechaRetiro !== contrato.fechaTerminacion) {
      throw new Error(`El contrato ya tiene fecha de terminación (${contrato.fechaTerminacion}). Cámbiala en el contrato si es otra.`);
    }
    fechaRetiro = contrato.fechaTerminacion;
  }
  if (!fechaValida(fechaRetiro)) throw new Error('Escribe la fecha de retiro (AAAA-MM-DD).');
  if (fechaRetiro < contrato.fechaIngreso) throw new Error('La fecha de retiro no puede ser anterior al ingreso.');
  let indemnizacionDias = null;
  if (datos.indemnizacionDias !== undefined && datos.indemnizacionDias !== null && datos.indemnizacionDias !== '') {
    indemnizacionDias = redondear2(datos.indemnizacionDias);
    if (!(indemnizacionDias >= 0) || indemnizacionDias > 3000) throw new Error('Los días de indemnización no son válidos.');
  }
  return {
    fechaRetiro, causa, indemnizacionDias,
    otrosDevengos: normalizarOtros(datos.otrosDevengos),
    descuentos: normalizarDescuentos(datos.descuentos),
  };
}

async function crearLiquidacion(datos, usuario) {
  const empresaId = usuario.empresaId;
  const contrato = await ContratoLaboral.findOne({ where: { id: datos.contratoId || null, empresaId } });
  if (!contrato) throw new Error('Elige el contrato que se liquida.');
  const existente = await NominaPrestacionLinea.findAll({ where: { contratoId: contrato.id } });
  if (existente.length) {
    const docs = await NominaPrestacion.findAll({ where: { id: { [Op.in]: existente.map((l) => l.prestacionId) }, tipo: 'liquidacion', estado: { [Op.ne]: 'anulada' } } });
    if (docs.length) throw new Error(`Este contrato ya tiene una liquidación final (${docs[0].estado}). Ábrela desde la lista.`);
  }
  const entrada = normalizarEntradaLiquidacion(datos, contrato);
  entrada.contratoId = contrato.id;
  const fechaPago = datos.fechaPago || (entrada.fechaRetiro > hoyColombia() ? entrada.fechaRetiro : hoyColombia());

  const doc = await NominaPrestacion.create({
    id: uuidv4(), empresaId, tipo: 'liquidacion', anio: Number(entrada.fechaRetiro.slice(0, 4)), fechaCorte: entrada.fechaRetiro,
    fechaPago, estado: 'borrador', usuarioId: usuario.id, observaciones: limpiarTexto(datos.observaciones, 255, 'La observación'),
  });
  try {
    await NominaPrestacionLinea.create({
      id: uuidv4(), empresaId, prestacionId: doc.id, empleadoId: contrato.empleadoId, contratoId: contrato.id, areaGasto: contrato.areaGasto, entrada,
    });
    await calcularYGuardar(doc, usuario);
    const lineas = await NominaPrestacionLinea.findAll({ where: { prestacionId: doc.id } });
    if (lineas[0] && lineas[0].error) throw new Error(lineas[0].error);
  } catch (e) {
    await NominaPrestacionLinea.destroy({ where: { prestacionId: doc.id } });
    await doc.destroy();
    throw e;
  }
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_liquidacion_creada', entidad: 'NominaPrestacion', entidadId: doc.id, detalle: `retiro ${entrada.fechaRetiro} · ${entrada.causa}`,
  });
  return detalleDocumento(doc.id, usuario);
}

async function recalcular(id, datos, usuario) {
  const doc = await documentoDe(id, usuario.empresaId);
  if (doc.estado !== 'borrador') throw new Error(`Este documento ya está ${doc.estado}; no se puede recalcular.`);
  const patch = { fechaPago: datos && datos.fechaPago };
  if (doc.tipo === 'liquidacion' && datos && (datos.causa !== undefined || datos.otrosDevengos !== undefined || datos.descuentos !== undefined || datos.indemnizacionDias !== undefined || datos.fechaRetiro !== undefined)) {
    const previa = await NominaPrestacionLinea.findOne({ where: { prestacionId: doc.id } });
    const contrato = await ContratoLaboral.findOne({ where: { id: previa.contratoId, empresaId: usuario.empresaId } });
    const base = previa.entrada || {};
    const cambios = Object.assign({}, base);
    for (const k of ['causa', 'otrosDevengos', 'descuentos', 'indemnizacionDias', 'fechaRetiro']) if (datos[k] !== undefined) cambios[k] = datos[k];
    patch.entrada = normalizarEntradaLiquidacion(cambios, contrato);
    patch.entrada.contratoId = contrato.id;
    await doc.update({ fechaCorte: patch.entrada.fechaRetiro, anio: Number(patch.entrada.fechaRetiro.slice(0, 4)) });
  }
  if (doc.tipo === 'vacaciones' && datos && datos.dias !== undefined) {
    const dias = redondear2(datos.dias);
    if (!(dias > 0) || dias > 90) throw new Error('Escribe los días hábiles de vacaciones que se pagan en dinero.');
    patch.entrada = { dias };
  }
  if (patch.fechaPago) validarFechaPago(patch.fechaPago, 'la fecha de pago');
  const avisos = await calcularYGuardar(doc, usuario, patch);
  return detalleDocumento(doc.id, usuario, avisos);
}

async function obtener(id, usuario) {
  return detalleDocumento(id, usuario);
}

async function eliminar(id, usuario) {
  const doc = await documentoDe(id, usuario.empresaId);
  if (doc.estado !== 'borrador') throw new Error('Solo se elimina un documento en borrador. Los pagados se anulan.');
  await sequelize.transaction(async (transaction) => {
    await NominaPrestacionLinea.destroy({ where: { prestacionId: doc.id }, transaction });
    await doc.destroy({ transaction });
  });
  await auditoria.registrar({
    empresaId: usuario.empresaId, usuarioId: usuario.id, accion: 'nomina_prestacion_eliminada', entidad: 'NominaPrestacion', entidadId: id, detalle: doc.tipo,
  });
  return { eliminada: true };
}

// --- Pago -------------------------------------------------------------------------------------
async function cuentaDePago(empresaId, datos) {
  if (datos.cuentaBancariaId) {
    const cb = await CuentaBancaria.findOne({ where: { id: datos.cuentaBancariaId, empresaId } });
    if (!cb) throw new Error('Elige una cuenta bancaria de tu empresa o paga en efectivo.');
    return cb;
  }
  if (datos.medio !== 'caja') throw new Error('Elige la cuenta bancaria desde la que se pagó, o marca pago en efectivo.');
  return null;
}

// Una liquidación final solo se puede pagar si las nóminas del empleado cuadran con la fecha de retiro.
async function validarNominasFrenteAlRetiro(empresaId, contrato, fechaRetiro) {
  const cerrados = await NominaPeriodo.findAll({ where: { empresaId, estado: { [Op.in]: ['contabilizada', 'pagada'] }, fechaFin: { [Op.gte]: fechaRetiro } } });
  if (!cerrados.length) return;
  const liqs = await NominaLiquidacion.findAll({ where: { periodoId: { [Op.in]: cerrados.map((p) => p.id) }, empleadoId: contrato.empleadoId } });
  for (const l of liqs) {
    const p = cerrados.find((x) => x.id === l.periodoId);
    const term = l.entrada && l.entrada.contrato ? l.entrada.contrato.fechaTerminacion : null;
    if (term !== fechaRetiro) {
      throw new Error(`La nómina de ${mesTexto(p.anio, p.mes)} ya está ${p.estado} sin la fecha de retiro (${fechaRetiro}). Reábrela y recalcúlala antes de pagar la liquidación.`);
    }
  }
}

async function pagar(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const doc = await documentoDe(id, empresaId);
  if (doc.estado === 'pagada') throw new Error('Este documento ya está pagado.');
  if (doc.estado !== 'borrador') throw new Error(`Este documento está ${doc.estado}.`);
  const fecha = datos.fecha || hoyColombia();
  validarFechaPago(fecha, 'la fecha del pago');
  if (fecha < PL.texto(doc.anio, 1, 1)) throw new Error('El pago no puede ser anterior al año del documento.');
  if (doc.tipo === 'liquidacion' && fecha < doc.fechaCorte) throw new Error('La liquidación no se puede pagar antes de la fecha de retiro.');
  const cuentaBancaria = await cuentaDePago(empresaId, datos);

  // Se recalcula con la fecha real del pago (cambia la retención y el saldo de las provisiones).
  await calcularYGuardar(doc, usuario, { fechaPago: fecha });
  const lineas = await NominaPrestacionLinea.findAll({ where: { prestacionId: doc.id } });
  if (!lineas.length) throw new Error('No hay nada que pagar en este documento.');
  const conError = lineas.filter((l) => l.error);
  if (conError.length) {
    const emp = await empleadosDe(empresaId, conError.map((l) => l.empleadoId));
    throw new Error(`Corrige antes de pagar: ${conError.map((l) => `${emp[l.empleadoId] ? emp[l.empleadoId].nombre : 'empleado'} (${l.error})`).join('; ')}`);
  }
  const filas = lineas.map((l) => ({
    empleadoId: l.empleadoId, areaGasto: l.areaGasto, retencion: num(l.retencion), descuentosDetalle: l.descuentosDetalle || [], componentes: l.componentes || [],
  }));
  const items = itemsDeAsiento(filas);
  const total = suma(lineas, (l) => pesos(l.neto));
  if (!(total > 0)) throw new Error('El neto a pagar es cero; no hay nada que registrar.');

  let contratoRetiro = null;
  if (doc.tipo === 'liquidacion') {
    contratoRetiro = await ContratoLaboral.findOne({ where: { id: lineas[0].contratoId, empresaId } });
    await validarNominasFrenteAlRetiro(empresaId, contratoRetiro, doc.fechaCorte);
    const posteriores = await NominaPeriodo.findAll({ where: { empresaId, estado: { [Op.in]: ['contabilizada', 'pagada'] }, fechaInicio: { [Op.gt]: doc.fechaCorte } } });
    if (posteriores.length) throw new Error(`Hay nóminas contabilizadas posteriores al retiro (${mesTexto(posteriores[0].anio, posteriores[0].mes)}). Reábrelas antes de pagar la liquidación.`);
  }

  await aprovisionarContabilidadBase(empresaId);
  const resultado = await sequelize.transaction(async (transaction) => {
    await asegurarReglasNomina(empresaId, transaction);
    let codigoPago = '1105';
    if (cuentaBancaria) codigoPago = (await asegurarCuentaContable(cuentaBancaria, transaction)).codigo;
    const asiento = AN.armarAsientoPrestaciones(items, codigoPago);
    if (!asiento.cuadra) throw new Error('El asiento del pago no cuadra; no se registró nada.');
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: 'nomina_prestaciones', origenModulo: 'nomina', origenId: doc.id, fecha,
      lineas: asiento.lineas, usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha del pago está cerrado o no existe.');
    let movimientoId = null;
    if (cuentaBancaria) {
      movimientoId = uuidv4();
      await MovimientoBancario.create({
        id: movimientoId, empresaId, cuentaBancariaId: cuentaBancaria.id, fecha, valor: total, tipo: 'egreso',
        descripcion: `${NOMBRES_TIPO[doc.tipo]}${doc.tipo === 'prima' ? ` ${doc.anio} S${doc.semestre}` : ` ${doc.anio}`}`, conciliado: false,
      }, { transaction });
    }
    if (contratoRetiro) {
      const previa = contratoRetiro.fechaTerminacion;
      if (previa !== doc.fechaCorte) {
        await NominaPrestacionLinea.update({ entrada: Object.assign({}, lineas[0].entrada, { terminacionAnterior: previa || null }) }, { where: { id: lineas[0].id }, transaction });
        await contratoRetiro.update({ fechaTerminacion: doc.fechaCorte }, { transaction });
      }
    }
    await doc.update({
      estado: 'pagada', fechaPago: fecha, asientoId: r.asiento.id, movimientoBancarioId: movimientoId, cuentaBancariaPagoId: cuentaBancaria ? cuentaBancaria.id : null,
    }, { transaction });
    return r.asiento.id;
  });

  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_prestacion_pagada', entidad: 'NominaPrestacion', entidadId: doc.id, detalle: `${doc.tipo} · ${total}`,
  });
  const detalle = await detalleDocumento(doc.id, usuario);
  detalle.asientoId = resultado;
  return detalle;
}

async function anular(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const doc = await documentoDe(id, empresaId);
  if (doc.estado !== 'pagada') throw new Error('Solo se anula un documento pagado.');
  const motivo = limpiarTexto(datos && datos.motivo, 250, 'El motivo', true);
  if (motivo.length < 10) throw new Error('Escribe el motivo de la anulación (mínimo 10 letras).');

  const mov = doc.movimientoBancarioId ? await MovimientoBancario.findOne({ where: { id: doc.movimientoBancarioId, empresaId } }) : null;
  if (mov && mov.conciliado) throw new Error('El egreso de este pago ya está conciliado con el extracto; quita la conciliación antes de anular.');
  const lineas = await NominaPrestacionLinea.findAll({ where: { prestacionId: doc.id } });

  await sequelize.transaction(async (transaction) => {
    const asiento = await Asiento.findOne({ where: { id: doc.asientoId, empresaId }, transaction });
    if (asiento) {
      const pc = await PeriodoContable.findByPk(asiento.periodoContableId, { transaction });
      if (pc && !['abierto', 'en_cierre'].includes(pc.estado)) throw new Error('El período contable de este pago ya está cerrado; no se puede anular su asiento.');
      await asiento.update({ estado: 'anulado' }, { transaction });
    }
    if (mov) await mov.destroy({ transaction });
    if (doc.tipo === 'liquidacion' && lineas[0]) {
      const contrato = await ContratoLaboral.findOne({ where: { id: lineas[0].contratoId, empresaId }, transaction });
      const entrada = lineas[0].entrada || {};
      if (contrato && contrato.fechaTerminacion === doc.fechaCorte && Object.prototype.hasOwnProperty.call(entrada, 'terminacionAnterior')) {
        await contrato.update({ fechaTerminacion: entrada.terminacionAnterior }, { transaction });
      }
    }
    await doc.update({ estado: 'anulada', motivoAnulacion: motivo, asientoId: null, movimientoBancarioId: null }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_prestacion_anulada', entidad: 'NominaPrestacion', entidadId: doc.id, detalle: motivo,
  });
  return detalleDocumento(doc.id, usuario);
}

// Comprobante imprimible de un empleado dentro de un documento.
async function comprobante(id, empleadoId, usuario) {
  const empresaId = usuario.empresaId;
  const doc = await documentoDe(id, empresaId);
  const linea = await NominaPrestacionLinea.findOne({ where: { prestacionId: doc.id, empleadoId } });
  if (!linea) throw new Error('El empleado no está en este documento.');
  const [empleado, contrato, empresa] = await Promise.all([
    Tercero.findByPk(empleadoId), ContratoLaboral.findByPk(linea.contratoId), Empresa.findByPk(empresaId),
  ]);
  return {
    prestacion: { id: doc.id, tipo: doc.tipo, nombreTipo: NOMBRES_TIPO[doc.tipo], anio: doc.anio, semestre: doc.semestre, fechaCorte: doc.fechaCorte, fechaPago: doc.fechaPago, estado: doc.estado },
    empresa: empresa ? { razonSocial: empresa.razonSocial, nit: empresa.nit } : null,
    empleado: empleado ? { id: empleado.id, nombre: empleado.nombre, identificacion: empleado.identificacion } : null,
    contrato: contrato ? { cargo: contrato.cargo, tipoContrato: contrato.tipoContrato, fechaIngreso: contrato.fechaIngreso, fechaTerminacion: contrato.fechaTerminacion, salarioBase: num(contrato.salarioBase) } : null,
    linea: {
      devengado: num(linea.devengado), retencion: num(linea.retencion), descuentos: num(linea.descuentos), neto: num(linea.neto),
      componentes: linea.componentes || [], descuentosDetalle: linea.descuentosDetalle || [],
      causa: linea.entrada && linea.entrada.causa ? (PN.CAUSAS_RETIRO[linea.entrada.causa] || {}).nombre : null,
      fechaRetiro: linea.entrada ? linea.entrada.fechaRetiro : null,
    },
  };
}

// --- Vacaciones: saldo por empleado --------------------------------------------------------------
async function resumenVacaciones(usuario, filtros) {
  const empresaId = usuario.empresaId;
  const corte = (filtros && filtros.corte) || hoyColombia();
  if (!fechaValida(corte)) throw new Error('La fecha de corte no es válida.');
  const contratos = await ContratoLaboral.findAll({
    where: { empresaId, fechaIngreso: { [Op.lte]: corte }, [Op.or]: [{ fechaTerminacion: null }, { fechaTerminacion: { [Op.gte]: corte } }] },
    order: [['fechaIngreso', 'ASC']],
  });
  const ids = contratos.map((c) => c.empleadoId);
  const ctx = await cargarContexto(empresaId, ids);
  const saldos = await saldosProvision(empresaId, ids, corte);
  const emp = await empleadosDe(empresaId, ids);
  const filas = [];
  for (const c of contratos) {
    const usados = await vacacionesUsadas(ctx, c.empleadoId, corte);
    const meses = mesesDe(ctx, c, PL.sumarDias(corte, -365), corte);
    const s = PN.saldoVacaciones({
      contrato: plano(c), corte, ausencias: ausenciasMotor(ctx, c.empleadoId), tomados: usados.tomados, compensados: usados.compensados, meses,
    });
    const provision = saldos[c.empleadoId]['2525'];
    filas.push({
      empleadoId: c.empleadoId, nombre: emp[c.empleadoId] ? emp[c.empleadoId].nombre : '(empleado eliminado)',
      identificacion: emp[c.empleadoId] ? emp[c.empleadoId].identificacion : '', cargo: c.cargo || '', fechaIngreso: c.fechaIngreso,
      causados: s.causados, previos: s.previos, tomados: s.tomados, compensados: s.compensados, saldo: s.saldo,
      base: s.base, valorDia: s.valorDia, valorSaldo: s.valorSaldo, provision, diferencia: pesos(s.valorSaldo - provision), metodo: s.metodo,
    });
  }
  filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return {
    corte,
    semanaLaboral: ctx.config.semanaLaboral || 5,
    filas,
    totales: { valorSaldo: suma(filas, (f) => f.valorSaldo), provision: suma(filas, (f) => f.provision) },
    nota: 'Se causan 15 días hábiles por cada 360 días de servicio. El saldo descuenta los días ya disfrutados (ausencias de vacaciones), los pagados en dinero y los que indiques como “días ya tomados antes de usar el sistema” en el contrato. La provisión es lo que el libro tiene en la cuenta 2525 para el empleado.',
  };
}

// --- Pago de la planilla (PILA) -----------------------------------------------------------------------
function agruparPlanilla(resumen) {
  const g = { salud: 0, pension: 0, arl: 0, parafiscales: 0 };
  for (const e of resumen.porEntidad) {
    const c = e.conceptos;
    g.salud += c.Salud || 0;
    g.pension += (c['Pensión'] || 0) + (c['Fondo de solidaridad'] || 0);
    g.arl += c['Riesgos laborales'] || 0;
    g.parafiscales += (c['Caja de compensación'] || 0) + (c.SENA || 0) + (c.ICBF || 0);
  }
  return g;
}

async function estadoPagoPlanilla(periodoId, empresaId) {
  const pagos = await NominaPlanillaPago.findAll({ where: { periodoId, empresaId }, order: [['createdAt', 'DESC']] });
  return pagos.map((p) => {
    const x = plano(p);
    for (const k of ['valorLiquidado', 'valorPila', 'mora', 'total']) x[k] = num(x[k]);
    return x;
  });
}

async function pagarPlanilla(periodoId, datos, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await nominaService._interno.periodoDe(periodoId, empresaId);
  if (!['contabilizada', 'pagada'].includes(periodo.estado)) throw new Error('Contabiliza la nómina del mes antes de pagar su planilla.');
  const vigente = await NominaPlanillaPago.findOne({ where: { periodoId, empresaId, estado: 'pagada' } });
  if (vigente) throw new Error('La planilla de este mes ya está pagada. Si te equivocaste, anula el pago y regístralo de nuevo.');
  const fecha = datos.fecha || hoyColombia();
  validarFechaPago(fecha, 'la fecha del pago');
  if (fecha < periodo.fechaFin) throw new Error('La planilla no se puede pagar antes de terminar el mes de la nómina.');
  const cuentaBancaria = await cuentaDePago(empresaId, datos);
  const mora = dinero(datos.mora, 'Los intereses de mora');
  const numeroPlanilla = limpiarTexto(datos.numeroPlanilla, 30, 'El número de la planilla');

  const planilla = await nominaService.planillaAportes(periodoId, usuario);
  const liquidado = agruparPlanilla(planilla);
  const valorPila = planilla.totales.pila;
  if (!(valorPila > 0)) throw new Error('La planilla no tiene valores a pagar.');
  const config = await obtenerConfigFila(empresaId);

  await aprovisionarContabilidadBase(empresaId);
  const pago = await sequelize.transaction(async (transaction) => {
    await asegurarReglasNomina(empresaId, transaction);
    let codigoPago = '1105';
    if (cuentaBancaria) codigoPago = (await asegurarCuentaContable(cuentaBancaria, transaction)).codigo;
    const asiento = AN.armarAsientoPagoPlanilla({ liquidado, valorPila, mora, area: config.areaGastoPorDefecto }, codigoPago);
    if (!asiento.cuadra) throw new Error('El asiento del pago no cuadra; no se registró nada.');
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: 'nomina_planilla_pago', origenModulo: 'nomina', origenId: periodo.id, fecha,
      lineas: asiento.lineas, usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha del pago está cerrado o no existe.');
    const total = valorPila + mora;
    let movimientoId = null;
    if (cuentaBancaria) {
      movimientoId = uuidv4();
      await MovimientoBancario.create({
        id: movimientoId, empresaId, cuentaBancariaId: cuentaBancaria.id, fecha, valor: total, tipo: 'egreso',
        descripcion: `Planilla PILA ${mesTexto(periodo.anio, periodo.mes)}${numeroPlanilla ? ` · ${numeroPlanilla}` : ''}`, conciliado: false,
      }, { transaction });
    }
    return NominaPlanillaPago.create({
      id: uuidv4(), empresaId, periodoId, fechaPago: fecha, numeroPlanilla, operador: config.operadorPila || null,
      valorLiquidado: planilla.totales.liquidado, valorPila, mora, total, estado: 'pagada', asientoId: r.asiento.id,
      cuentaBancariaId: cuentaBancaria ? cuentaBancaria.id : null, movimientoBancarioId: movimientoId, detalle: liquidado, usuarioId: usuario.id,
    }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_planilla_pagada', entidad: 'NominaPlanillaPago', entidadId: pago.id,
    detalle: `${mesTexto(periodo.anio, periodo.mes)} · ${valorPila + mora}`,
  });
  return nominaService.planillaAportes(periodoId, usuario);
}

async function anularPagoPlanilla(pagoId, datos, usuario) {
  const empresaId = usuario.empresaId;
  const pago = await NominaPlanillaPago.findOne({ where: { id: pagoId, empresaId } });
  if (!pago) throw new Error('Pago de planilla no encontrado.');
  if (pago.estado !== 'pagada') throw new Error('Este pago ya está anulado.');
  const motivo = limpiarTexto(datos && datos.motivo, 250, 'El motivo', true);
  if (motivo.length < 10) throw new Error('Escribe el motivo de la anulación (mínimo 10 letras).');
  const mov = pago.movimientoBancarioId ? await MovimientoBancario.findOne({ where: { id: pago.movimientoBancarioId, empresaId } }) : null;
  if (mov && mov.conciliado) throw new Error('El egreso de este pago ya está conciliado con el extracto; quita la conciliación antes de anular.');
  await sequelize.transaction(async (transaction) => {
    const asiento = await Asiento.findOne({ where: { id: pago.asientoId, empresaId }, transaction });
    if (asiento) {
      const pc = await PeriodoContable.findByPk(asiento.periodoContableId, { transaction });
      if (pc && !['abierto', 'en_cierre'].includes(pc.estado)) throw new Error('El período contable de este pago ya está cerrado; no se puede anular su asiento.');
      await asiento.update({ estado: 'anulado' }, { transaction });
    }
    if (mov) await mov.destroy({ transaction });
    await pago.update({ estado: 'anulada', motivoAnulacion: motivo, asientoId: null, movimientoBancarioId: null }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_planilla_anulada', entidad: 'NominaPlanillaPago', entidadId: pago.id, detalle: motivo,
  });
  return nominaService.planillaAportes(pago.periodoId, usuario);
}

// CSV de cargue: una fila por cotizante con los campos de la PILA (para digitar o importar en el operador).
function celdaCsv(v) {
  let t = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",;\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function partirNombre(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length >= 4) return { n1: partes[0], n2: partes[1], a1: partes[2], a2: partes.slice(3).join(' ') };
  if (partes.length === 3) return { n1: partes[0], n2: '', a1: partes[1], a2: partes[2] };
  if (partes.length === 2) return { n1: partes[0], n2: '', a1: partes[1], a2: '' };
  return { n1: partes[0] || '', n2: '', a1: '', a2: '' };
}

async function planillaCargueCsv(periodoId, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await nominaService._interno.periodoDe(periodoId, empresaId);
  const config = await obtenerConfigFila(empresaId);
  const empresa = await Empresa.findByPk(empresaId);
  const liquidaciones = (await NominaLiquidacion.findAll({ where: { periodoId: periodo.id } })).filter((l) => !l.error && l.resultado);
  const emp = await empleadosDe(empresaId, liquidaciones.map((l) => l.empleadoId));
  const contratos = await ContratoLaboral.findAll({ where: { id: { [Op.in]: liquidaciones.map((l) => l.contratoId) } } });
  const contratoPorId = Object.fromEntries(contratos.map((c) => [c.id, c]));
  const T = PL.TARIFAS;
  const x100 = aMultiplo100;

  const cab = ['Tipo documento', 'Identificación', 'Primer apellido', 'Segundo apellido', 'Primer nombre', 'Segundo nombre', 'Tipo cotizante', 'Subtipo',
    'Novedades (código y fechas)', 'Código EPS', 'EPS', 'Código AFP', 'AFP', 'Código CCF', 'Caja', 'ARL', 'Clase de riesgo',
    'Días pensión', 'Días salud', 'Días ARL', 'Días CCF', 'Salario básico', 'IBC pensión', 'IBC salud', 'IBC ARL', 'IBC CCF',
    'Tarifa pensión', 'Cotización pensión', 'Fondo solidaridad', 'Fondo subsistencia', 'Tarifa salud', 'Cotización salud',
    'Tarifa ARL', 'Cotización ARL', 'Tarifa CCF', 'Cotización CCF', 'Tarifa SENA', 'Cotización SENA', 'Tarifa ICBF', 'Cotización ICBF', 'Exonerado art. 114-1'];
  const filas = liquidaciones.map((l) => {
    const L = l.resultado;
    const c = contratoPorId[l.contratoId] || {};
    const e = emp[l.empleadoId] || {};
    const n = partirNombre(e.nombre);
    const ap = L.aportes;
    const p = L.pila;
    const novedades = p.novedades.map((v) => `${v.codigo}${v.desde ? ' ' + v.desde + (v.hasta && v.hasta !== v.desde ? '/' + v.hasta : '') : ''}`).join(' | ');
    const salud = x100(ap.empleado.salud) + x100(ap.empleador.salud);
    const pension = x100(ap.empleado.pension) + x100(ap.empleador.pension);
    return [
      'CC', e.identificacion, n.a1, n.a2, n.n1, n.n2, '01', '00', novedades, c.epsCodigo || '', c.epsNombre || '', c.afpCodigo || '', c.afpNombre || '',
      config.ccfCodigo || '', config.ccfNombre || '', config.arlNombre || '', p.claseRiesgo,
      p.diasPension, p.diasSalud, p.diasArl, p.diasCcf, pesos(c.salarioBase), p.ibcPension, p.ibcSalud, p.ibcArl, p.ibcCcf,
      (T.pensionEmpleado + T.pensionEmpleador).toFixed(5), pension, x100(ap.empleado.fspSolidaridad), x100(ap.empleado.fspSubsistencia),
      (T.saludEmpleado + (p.exonerado ? 0 : T.saludEmpleador)).toFixed(5), salud,
      p.tarifaArl.toFixed(5), x100(ap.empleador.arl), T.cajaCompensacion.toFixed(5), x100(ap.empleador.caja),
      (p.exonerado ? 0 : T.sena).toFixed(5), x100(ap.empleador.sena), (p.exonerado ? 0 : T.icbf).toFixed(5), x100(ap.empleador.icbf), p.exonerado ? 'SI' : 'NO',
    ];
  });
  const encabezado = [`Aportante;${empresa ? empresa.razonSocial : ''};NIT;${empresa ? empresa.nit : ''};Período;${mesTexto(periodo.anio, periodo.mes)}`];
  const texto = [encabezado.join('\r\n'), [cab, ...filas].map((fila) => fila.map(celdaCsv).join(';')).join('\r\n')].join('\r\n');
  return { nombre: `pila-cargue-${mesTexto(periodo.anio, periodo.mes)}.csv`, contenido: '﻿' + texto };
}

module.exports = {
  listarPrestaciones, crearLote, crearVacaciones, crearLiquidacion, obtener, recalcular, eliminar, pagar, anular, comprobante,
  resumenVacaciones, pagarPlanilla, anularPagoPlanilla, estadoPagoPlanilla, agruparPlanilla, planillaCargueCsv,
  _prueba: { saldosProvision, cargarContexto, mesesDe },
};
