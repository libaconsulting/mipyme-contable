// Aportes de contratistas independientes (planilla Y de la PILA).
//
// La empresa acuerda con un contratista de prestación de servicios pagar sus aportes (salud, pensión y ARL)
// y se los descuenta de los honorarios (Resolución 467 de 2025 del Ministerio de Salud; cotizante 59,
// aportante 15). El cálculo y los asientos viven en public/contable/aportesContratistas.js.
//
// Flujo de cada mes:  borrador (se calcula) → contabilizada (causa el descuento a la cuenta por pagar del
// contratista contra 2370 / pensiones) → pagada (el pago de la planilla al operador salda el 2370).
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Tercero = require('../../../core/models/Tercero');
const Empresa = require('../../../core/models/Empresa');
const Asiento = require('../../../core/models/Asiento');
const PeriodoContable = require('../../../core/models/PeriodoContable');
const CuentaBancaria = require('../../tesoreria/models/CuentaBancaria');
const MovimientoBancario = require('../../tesoreria/models/MovimientoBancario');
const ContratoContratista = require('../models/ContratoContratista');
const AportesContratistas = require('../models/AportesContratistas');
const { contabilizarAsientoCompuesto } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const { asegurarCuentaContable } = require('../../tesoreria/services/contabilidadBancaria');
const auditoria = require('../../../core/services/auditoria');
const PL = require('../../../../public/contable/parametrosLaborales');
const AN = require('../../../../public/contable/asientoNomina');
const AC = require('../../../../public/contable/aportesContratistas');
const nominaService = require('./nomina.service');

const {
  obtenerConfigFila, fechaValida, hoyColombia, limpiarTexto, dinero, entero, mesTexto, plano,
  asegurarReglasNomina, enriquecerAsiento,
} = nominaService._interno;

const TIPOS_DOCUMENTO = ['CC', 'CE', 'TI', 'PA', 'CD', 'SC', 'PE', 'RC'];
const pesos = (x) => Math.round(Number(x) || 0);

// --- Contratos -------------------------------------------------------------------------------------
function numeros(c) {
  const x = plano(c);
  x.valorMensual = Number(x.valorMensual);
  return x;
}

async function conTercero(contratos) {
  const ids = Array.from(new Set(contratos.map((c) => c.terceroId)));
  const terceros = ids.length ? await Tercero.findAll({ where: { id: { [Op.in]: ids } } }) : [];
  const porId = Object.fromEntries(terceros.map((t) => [t.id, t]));
  return contratos.map((c) => {
    const x = numeros(c);
    const t = porId[x.terceroId];
    x.tercero = t ? { id: t.id, nombre: t.nombre, identificacion: t.identificacion } : null;
    return x;
  });
}

// Cuántos meses completos dura el contrato (para avisar si no supera 1 mes).
function superaUnMes(inicio, fin) {
  if (!fin) return true;
  const [a, m, d] = inicio.split('-').map(Number);
  const limite = new Date(Date.UTC(a, m, d)); // un mes después, mismo día
  return new Date(fin + 'T00:00:00Z').getTime() > limite.getTime();
}

function normalizarContrato(d, actual) {
  const base = actual ? plano(actual) : {};
  const v = (k) => (d[k] !== undefined ? d[k] : base[k]);
  const fechaInicio = v('fechaInicio');
  if (!fechaValida(fechaInicio)) throw new Error('Escribe la fecha desde la que la empresa paga los aportes (AAAA-MM-DD).');
  const fechaFin = v('fechaFin') || null;
  if (fechaFin && !fechaValida(fechaFin)) throw new Error('La fecha de fin del contrato no es válida (AAAA-MM-DD).');
  if (fechaFin && fechaFin < fechaInicio) throw new Error('La fecha de fin no puede ser anterior al inicio.');
  const valorMensual = dinero(v('valorMensual'), 'El valor mensual del contrato', { obligatorio: true, positivo: true });
  const claseRiesgo = entero(v('claseRiesgo'), 'La clase de riesgo', { min: 1, max: 5, porDefecto: 1 });
  const areaGasto = v('areaGasto') || 'administracion';
  if (!AN.AREAS[areaGasto]) throw new Error('El área de gasto es administración o ventas.');
  const cuentaPorPagar = String(v('cuentaPorPagar') || '2335');
  if (!AC.CUENTAS_POR_PAGAR[cuentaPorPagar]) throw new Error('La cuenta por pagar al contratista es 2335 (documento soporte) o 2205 (factura).');
  const tipoDocumento = String(v('tipoDocumento') || 'CC').toUpperCase();
  if (!TIPOS_DOCUMENTO.includes(tipoDocumento)) throw new Error(`El tipo de documento no es válido (${TIPOS_DOCUMENTO.join(', ')}).`);
  const codigo = (x, n) => {
    const t = limpiarTexto(x, 20, n);
    if (t && !/^[A-Za-z0-9\-]+$/.test(t)) throw new Error(`${n} solo lleva letras, números y guion.`);
    return t;
  };
  return {
    descripcion: limpiarTexto(v('descripcion'), 255, 'El objeto del contrato'),
    fechaInicio, fechaFin, valorMensual, claseRiesgo, areaGasto, cuentaPorPagar, tipoDocumento,
    epsNombre: limpiarTexto(v('epsNombre'), 100, 'La EPS'), epsCodigo: codigo(v('epsCodigo'), 'El código de la EPS'),
    afpNombre: limpiarTexto(v('afpNombre'), 100, 'El fondo de pensiones'), afpCodigo: codigo(v('afpCodigo'), 'El código del fondo de pensiones'),
    activo: v('activo') === undefined ? true : !!v('activo'),
    observaciones: limpiarTexto(v('observaciones'), 500, 'Las observaciones'),
  };
}

function avisosContrato(c) {
  const a = [];
  if (!superaUnMes(c.fechaInicio, c.fechaFin)) a.push('El contrato dura un mes o menos: el tipo de cotizante 59 es para contratos de más de un mes.');
  return a;
}

async function opciones(usuario) {
  const empresaId = usuario.empresaId;
  const [terceros, bancos, config] = await Promise.all([
    Tercero.findAll({ where: { empresaId, tipo: { [Op.in]: ['proveedor', 'otro'] } }, order: [['nombre', 'ASC']] }),
    CuentaBancaria.findAll({ where: { empresaId } }),
    obtenerConfigFila(empresaId),
  ]);
  const hoy = hoyColombia();
  const P = PL.parametros(Number(hoy.slice(0, 4)));
  return {
    terceros: terceros.map((t) => ({ id: t.id, nombre: t.nombre, identificacion: t.identificacion, tipoPersona: t.tipoPersona || null })),
    cuentasBancarias: bancos.map((b) => ({ id: b.id, banco: b.banco, numero: String(b.numero).slice(-4), tipoCuenta: b.tipoCuenta })),
    operadorPila: config.operadorPila || '',
    clasesRiesgo: PL.CLASES_RIESGO,
    areas: AN.AREAS,
    cuentasPorPagar: AC.CUENTAS_POR_PAGAR,
    parametros: { anio: P.anio, smmlv: P.smmlv, tarifaSalud: AC.TARIFA_SALUD, tarifaPension: AC.TARIFA_PENSION, factorIbc: AC.FACTOR_IBC, estimado: P.estimado },
    hoy,
  };
}

async function listarContratos(usuario) {
  const lista = await ContratoContratista.findAll({ where: { empresaId: usuario.empresaId }, order: [['fechaInicio', 'DESC']] });
  return conTercero(lista);
}

async function crearContrato(datos, usuario) {
  const empresaId = usuario.empresaId;
  const contrato = normalizarContrato(datos);
  let terceroId = datos.terceroId || null;
  let nuevo = null;
  if (terceroId) {
    const t = await Tercero.findOne({ where: { id: terceroId, empresaId } });
    if (!t) throw new Error('Elige un tercero de tu empresa.');
  } else {
    const n = datos.nuevoTercero || {};
    const identificacion = limpiarTexto(n.identificacion, 20, 'La cédula del contratista', true);
    if (!/^[\dA-Za-z.\-]{4,20}$/.test(identificacion)) throw new Error('La cédula solo lleva números (y puntos o guion).');
    const nombre = limpiarTexto(n.nombre, 150, 'El nombre del contratista', true);
    const existente = await Tercero.findOne({ where: { empresaId, identificacion, tipo: { [Op.in]: ['proveedor', 'otro'] } } });
    if (existente) terceroId = existente.id;
    else nuevo = { identificacion, nombre };
  }
  const creado = await sequelize.transaction(async (transaction) => {
    if (nuevo) {
      const t = await Tercero.create({ id: uuidv4(), empresaId, tipo: 'proveedor', tipoPersona: 'natural', identificacion: nuevo.identificacion, nombre: nuevo.nombre }, { transaction });
      terceroId = t.id;
    }
    return ContratoContratista.create({ id: uuidv4(), empresaId, terceroId, ...contrato }, { transaction });
  });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_contratista_creado', entidad: 'ContratoContratista', entidadId: creado.id, detalle: `${contrato.valorMensual}` });
  const [x] = await conTercero([creado]);
  x.avisos = avisosContrato(contrato);
  return x;
}

async function actualizarContrato(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const actual = await ContratoContratista.findOne({ where: { id, empresaId } });
  if (!actual) throw new Error('Contrato de contratista no encontrado.');
  const cambios = normalizarContrato(datos, actual);
  await actual.update(cambios);
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_contratista_actualizado', entidad: 'ContratoContratista', entidadId: actual.id, detalle: Object.keys(datos).join(', ').slice(0, 250) });
  const [x] = await conTercero([actual]);
  x.avisos = avisosContrato(cambios);
  return x;
}

async function eliminarContrato(id, usuario) {
  const empresaId = usuario.empresaId;
  const actual = await ContratoContratista.findOne({ where: { id, empresaId } });
  if (!actual) throw new Error('Contrato de contratista no encontrado.');
  const cerrados = await AportesContratistas.findAll({ where: { empresaId, estado: { [Op.in]: ['contabilizada', 'pagada'] } } });
  const usado = cerrados.find((p) => (p.lineas || []).some((l) => (l.contratos || []).some((c) => c.id === id)));
  if (usado) throw new Error(`Este contrato ya está en los aportes de ${mesTexto(usado.anio, usado.mes)}. Ponle fecha de fin o desactívalo en vez de eliminarlo.`);
  await actual.destroy();
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_contratista_eliminado', entidad: 'ContratoContratista', entidadId: id, detalle: '' });
  return { ok: true };
}

// --- Liquidación del mes ---------------------------------------------------------------------------
async function calcularLineas(empresaId, anio, mes) {
  const contratos = await ContratoContratista.findAll({ where: { empresaId, activo: true } });
  const ids = Array.from(new Set(contratos.map((c) => c.terceroId)));
  const terceros = ids.length ? await Tercero.findAll({ where: { id: { [Op.in]: ids } } }) : [];
  const tercero = Object.fromEntries(terceros.map((t) => [t.id, t]));
  const grupos = new Map();
  for (const c of contratos) {
    if (!grupos.has(c.terceroId)) grupos.set(c.terceroId, []);
    grupos.get(c.terceroId).push(c);
  }
  const contratistas = Array.from(grupos.entries()).map(([terceroId, lista]) => {
    const t = tercero[terceroId] || {};
    return {
      terceroId, nombre: t.nombre || '', identificacion: t.identificacion || '',
      contratos: lista.map((c) => ({ id: c.id, fechaInicio: c.fechaInicio, fechaFin: c.fechaFin, valorMensual: Number(c.valorMensual), claseRiesgo: c.claseRiesgo })),
      _filas: lista,
    };
  });
  const r = AC.liquidarPeriodo({ anio, mes, contratistas });
  // Datos para el asiento y el archivo: salen del contrato de mayor valor del contratista.
  const lineas = r.lineas.map((l) => {
    const origen = contratistas.find((c) => c.terceroId === l.terceroId)._filas
      .filter((c) => l.contratos.some((x) => x.id === c.id))
      .sort((a, b) => Number(b.valorMensual) - Number(a.valorMensual))[0];
    return Object.assign({}, l, {
      area: origen.areaGasto, cuentaPorPagar: origen.cuentaPorPagar, tipoDocumento: origen.tipoDocumento,
      epsNombre: origen.epsNombre || '', epsCodigo: origen.epsCodigo || '', afpNombre: origen.afpNombre || '', afpCodigo: origen.afpCodigo || '',
    });
  });
  return { lineas, totales: r.totales };
}

async function periodoDe(id, empresaId, transaction) {
  const p = await AportesContratistas.findOne({ where: { id, empresaId }, transaction });
  if (!p) throw new Error('Liquidación de aportes de contratistas no encontrada.');
  return p;
}

function filaPeriodo(p) {
  const x = plano(p);
  x.mora = Number(x.mora);
  x.totalPagado = Number(x.totalPagado);
  return x;
}

function itemsDeAsiento(lineas) {
  return (lineas || []).map((l) => ({ terceroId: l.terceroId, area: l.area, cuentaPorPagar: l.cuentaPorPagar, liquidacion: l }));
}

async function listarPeriodos(usuario) {
  const lista = await AportesContratistas.findAll({ where: { empresaId: usuario.empresaId }, order: [['anio', 'DESC'], ['mes', 'DESC']] });
  return lista.map((p) => {
    const x = filaPeriodo(p);
    delete x.lineas;
    return x;
  });
}

async function detalle(id, usuario) {
  const empresaId = usuario.empresaId;
  const p = await periodoDe(id, empresaId);
  const lineas = p.lineas || [];
  const nombres = Object.fromEntries(lineas.map((l) => [l.terceroId, l.nombre]));
  const items = itemsDeAsiento(lineas);
  let vistaPrevia = null;
  if (lineas.length) {
    const causacion = enriquecerAsiento(AC.armarAsientoCausacion(items), nombres);
    vistaPrevia = { causacion, pago: enriquecerAsiento(AC.armarAsientoPago(items, Number(p.mora) || 0, '1110'), nombres) };
  }
  return { periodo: filaPeriodo(p), lineas, totales: p.totales || {}, vistaPrevia, avisos: Array.from(new Set(lineas.flatMap((l) => l.avisos || []))) };
}

async function crearPeriodo(datos, usuario) {
  const empresaId = usuario.empresaId;
  const anio = entero(datos.anio, 'El año', { min: 2020, max: 2100, porDefecto: 0 });
  const mes = entero(datos.mes, 'El mes', { min: 1, max: 12, porDefecto: 0 });
  if (!anio || !mes) throw new Error('Elige el año y el mes.');
  if (await AportesContratistas.findOne({ where: { empresaId, anio, mes } })) throw new Error(`Ya existe la liquidación de aportes de contratistas de ${mesTexto(anio, mes)}.`);
  const { lineas, totales } = await calcularLineas(empresaId, anio, mes);
  if (!lineas.length) throw new Error(`No hay contratistas con contrato vigente en ${mesTexto(anio, mes)}. Registra el contrato en la pestaña Contratistas.`);
  const p = await AportesContratistas.create({ id: uuidv4(), empresaId, anio, mes, estado: 'borrador', lineas, totales, usuarioId: usuario.id });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_aportes_contratistas_creado', entidad: 'AportesContratistas', entidadId: p.id, detalle: mesTexto(anio, mes) });
  return detalle(p.id, usuario);
}

async function recalcular(id, usuario) {
  const p = await periodoDe(id, usuario.empresaId);
  if (p.estado !== 'borrador') throw new Error(`Los aportes de ${mesTexto(p.anio, p.mes)} ya están ${p.estado}; ábrelos de nuevo para recalcular.`);
  const { lineas, totales } = await calcularLineas(usuario.empresaId, p.anio, p.mes);
  if (!lineas.length) throw new Error(`Ya no hay contratistas con contrato vigente en ${mesTexto(p.anio, p.mes)}. Si no aplica, elimina esta liquidación.`);
  await p.update({ lineas, totales });
  return detalle(p.id, usuario);
}

async function eliminar(id, usuario) {
  const p = await periodoDe(id, usuario.empresaId);
  if (p.estado !== 'borrador') throw new Error('Solo se elimina una liquidación en borrador.');
  await p.destroy();
  await auditoria.registrar({ empresaId: usuario.empresaId, usuarioId: usuario.id, accion: 'nomina_aportes_contratistas_eliminado', entidad: 'AportesContratistas', entidadId: id, detalle: mesTexto(p.anio, p.mes) });
  return { ok: true };
}

async function contabilizar(id, usuario) {
  const empresaId = usuario.empresaId;
  let p = await periodoDe(id, empresaId);
  if (p.estado !== 'borrador') throw new Error(`Los aportes de ${mesTexto(p.anio, p.mes)} ya están ${p.estado}.`);
  // Se recalcula justo antes, por si cambió algo en los contratos.
  const { lineas, totales } = await calcularLineas(empresaId, p.anio, p.mes);
  if (!lineas.length) throw new Error('No hay contratistas con contrato vigente en este mes.');
  const asiento = AC.armarAsientoCausacion(itemsDeAsiento(lineas));
  if (!asiento.cuadra) throw new Error('El asiento de los aportes no cuadra; no se contabilizó nada.');
  const fecha = PL.texto(p.anio, p.mes, PL.diasDelMes(p.anio, p.mes));

  await aprovisionarContabilidadBase(empresaId);
  await sequelize.transaction(async (transaction) => {
    await asegurarReglasNomina(empresaId, transaction);
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: 'nomina_aportes_contratistas', origenModulo: 'nomina', origenId: p.id, fecha,
      lineas: asiento.lineas, usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error(`El período contable de ${mesTexto(p.anio, p.mes)} está cerrado o no existe; ábrelo o créalo antes de contabilizar.`);
    await p.update({ estado: 'contabilizada', lineas, totales, fechaContabilizacion: hoyColombia(), asientoId: r.asiento.id }, { transaction });
  });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_aportes_contratistas_contabilizado', entidad: 'AportesContratistas', entidadId: p.id, detalle: `${mesTexto(p.anio, p.mes)} · ${totales.total}` });
  p = await periodoDe(id, empresaId);
  return detalle(p.id, usuario);
}

async function anularAsiento(asientoId, empresaId, transaction) {
  const a = asientoId ? await Asiento.findOne({ where: { id: asientoId, empresaId }, transaction }) : null;
  if (!a) return;
  const pc = await PeriodoContable.findByPk(a.periodoContableId, { transaction });
  if (pc && !['abierto', 'en_cierre'].includes(pc.estado)) throw new Error('El período contable de este asiento ya está cerrado; no se puede anular.');
  await a.update({ estado: 'anulado' }, { transaction });
}

async function reabrir(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const p = await periodoDe(id, empresaId);
  if (p.estado === 'pagada') throw new Error('La planilla ya está pagada; anula primero el pago.');
  if (p.estado !== 'contabilizada') throw new Error('Solo se reabre una liquidación contabilizada.');
  const motivo = limpiarTexto(datos && datos.motivo, 250, 'El motivo', true);
  if (motivo.length < 10) throw new Error('Escribe el motivo de la reapertura (mínimo 10 letras).');
  await sequelize.transaction(async (transaction) => {
    await anularAsiento(p.asientoId, empresaId, transaction);
    await p.update({ estado: 'borrador', asientoId: null, fechaContabilizacion: null }, { transaction });
  });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_aportes_contratistas_reabierto', entidad: 'AportesContratistas', entidadId: p.id, detalle: motivo });
  return detalle(p.id, usuario);
}

async function cuentaDePago(empresaId, datos) {
  if (datos.cuentaBancariaId) {
    const cb = await CuentaBancaria.findOne({ where: { id: datos.cuentaBancariaId, empresaId } });
    if (!cb) throw new Error('Elige una cuenta bancaria de tu empresa o paga en efectivo.');
    return cb;
  }
  if (datos.medio !== 'caja') throw new Error('Elige la cuenta bancaria desde la que se pagó, o marca pago en efectivo.');
  return null;
}

async function pagar(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const p = await periodoDe(id, empresaId);
  if (p.estado === 'pagada') throw new Error('La planilla de este mes ya está pagada. Si te equivocaste, anula el pago y regístralo de nuevo.');
  if (p.estado !== 'contabilizada') throw new Error('Contabiliza los aportes del mes antes de registrar el pago de la planilla.');
  const fecha = datos.fecha || hoyColombia();
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha del pago (AAAA-MM-DD).');
  if (fecha < PL.texto(p.anio, p.mes, PL.diasDelMes(p.anio, p.mes))) throw new Error('La planilla no se puede pagar antes de terminar el mes.');
  const cuentaBancaria = await cuentaDePago(empresaId, datos);
  const mora = dinero(datos.mora, 'Los intereses de mora');
  const numeroPlanilla = limpiarTexto(datos.numeroPlanilla, 30, 'El número de la planilla');
  const config = await obtenerConfigFila(empresaId);
  const operador = limpiarTexto(datos.operador, 100, 'El operador') || config.operadorPila || null;
  const lineas = p.lineas || [];
  const total = (p.totales && p.totales.total) || 0;
  if (!(total > 0)) throw new Error('La planilla no tiene valores a pagar.');

  await aprovisionarContabilidadBase(empresaId);
  await sequelize.transaction(async (transaction) => {
    await asegurarReglasNomina(empresaId, transaction);
    let codigoPago = '1105';
    if (cuentaBancaria) codigoPago = (await asegurarCuentaContable(cuentaBancaria, transaction)).codigo;
    const asiento = AC.armarAsientoPago(itemsDeAsiento(lineas), mora, codigoPago);
    if (!asiento.cuadra) throw new Error('El asiento del pago no cuadra; no se registró nada.');
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: 'nomina_aportes_contratistas_pago', origenModulo: 'nomina', origenId: p.id, fecha,
      lineas: asiento.lineas, usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha del pago está cerrado o no existe.');
    const totalPagado = total + mora;
    let movimientoId = null;
    if (cuentaBancaria) {
      movimientoId = uuidv4();
      await MovimientoBancario.create({
        id: movimientoId, empresaId, cuentaBancariaId: cuentaBancaria.id, fecha, valor: totalPagado, tipo: 'egreso',
        descripcion: `Planilla Y contratistas ${mesTexto(p.anio, p.mes)}${numeroPlanilla ? ` · ${numeroPlanilla}` : ''}`, conciliado: false,
      }, { transaction });
    }
    await p.update({
      estado: 'pagada', fechaPago: fecha, numeroPlanilla, operador, mora, totalPagado, asientoPagoId: r.asiento.id,
      cuentaBancariaId: cuentaBancaria ? cuentaBancaria.id : null, movimientoBancarioId: movimientoId,
    }, { transaction });
  });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_aportes_contratistas_pagado', entidad: 'AportesContratistas', entidadId: p.id, detalle: `${mesTexto(p.anio, p.mes)} · ${total + mora}` });
  return detalle(p.id, usuario);
}

async function anularPago(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const p = await periodoDe(id, empresaId);
  if (p.estado !== 'pagada') throw new Error('Este mes no tiene un pago registrado.');
  const motivo = limpiarTexto(datos && datos.motivo, 250, 'El motivo', true);
  if (motivo.length < 10) throw new Error('Escribe el motivo de la anulación (mínimo 10 letras).');
  const mov = p.movimientoBancarioId ? await MovimientoBancario.findOne({ where: { id: p.movimientoBancarioId, empresaId } }) : null;
  if (mov && mov.conciliado) throw new Error('El egreso de este pago ya está conciliado con el extracto; quita la conciliación antes de anular.');
  await sequelize.transaction(async (transaction) => {
    await anularAsiento(p.asientoPagoId, empresaId, transaction);
    if (mov) await mov.destroy({ transaction });
    await p.update({
      estado: 'contabilizada', fechaPago: null, numeroPlanilla: null, operador: null, mora: 0, totalPagado: 0,
      asientoPagoId: null, cuentaBancariaId: null, movimientoBancarioId: null,
    }, { transaction });
  });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nomina_aportes_contratistas_pago_anulado', entidad: 'AportesContratistas', entidadId: p.id, detalle: motivo });
  return detalle(p.id, usuario);
}

// --- CSV de cargue (para digitar o importar la planilla Y en el operador) -------------------------------
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

async function cargueCsv(id, usuario) {
  const empresaId = usuario.empresaId;
  const p = await periodoDe(id, empresaId);
  const empresa = await Empresa.findByPk(empresaId);
  const cab = ['Tipo documento', 'Identificación', 'Primer apellido', 'Segundo apellido', 'Primer nombre', 'Segundo nombre',
    'Tipo cotizante', 'Tipo planilla', 'Tipo aportante', 'Código EPS', 'EPS', 'Código AFP', 'AFP', 'Clase de riesgo', 'Días', 'IBC',
    'Tarifa salud', 'Cotización salud', 'Tarifa pensión', 'Cotización pensión', 'Fondo solidaridad', 'Fondo subsistencia',
    'Tarifa ARL', 'Cotización ARL', 'ARL a cargo de', 'Total aportes', 'Se descuenta al contratista', 'Asume la empresa', 'Novedad'];
  const filas = (p.lineas || []).map((l) => {
    const n = partirNombre(l.nombre);
    return [l.tipoDocumento || 'CC', l.identificacion, n.a1, n.a2, n.n1, n.n2, 59, 'Y', 15, l.epsCodigo, l.epsNombre, l.afpCodigo, l.afpNombre,
      l.arl.clase, l.dias, l.ibc, l.salud.tarifa.toFixed(5), l.salud.valor, l.pension.tarifa.toFixed(5), l.pension.valor,
      l.fsp.solidaridad, l.fsp.subsistencia, l.arl.tarifa.toFixed(5), l.arl.valor, l.arl.aCargoDe === 'empresa' ? 'Empresa' : 'Contratista',
      l.total, l.descuento, l.asumeEmpresa, l.terminaEnMes ? 'RET-T (termina el contrato)' : ''];
  });
  const encabezado = `Aportante;${empresa ? empresa.razonSocial : ''};NIT;${empresa ? empresa.nit : ''};Período;${mesTexto(p.anio, p.mes)};Planilla;Y - Independientes empresas`;
  const texto = [encabezado, [cab, ...filas].map((f) => f.map(celdaCsv).join(';')).join('\r\n')].join('\r\n');
  return { nombre: `planilla-y-cargue-${mesTexto(p.anio, p.mes)}.csv`, contenido: '﻿' + texto };
}

module.exports = {
  opciones, listarContratos, crearContrato, actualizarContrato, eliminarContrato,
  listarPeriodos, detalle, crearPeriodo, recalcular, eliminar, contabilizar, reabrir, pagar, anularPago, cargueCsv,
};
