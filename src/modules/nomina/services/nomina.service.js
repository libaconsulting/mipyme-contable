// Nómina mensual: contratos, ausencias, novedades, liquidación del mes,
// contabilización (liquidación + provisiones + pago) y planilla de aportes.
//
// El cálculo vive en public/contable/liquidacionNomina.js y los asientos en
// public/contable/asientoNomina.js, los mismos archivos que usa la pantalla
// para la vista previa. Aquí solo se arma la entrada del motor con lo que hay
// guardado, se guardan los resultados y se contabiliza con el motor de asientos.
//
// Flujo de un mes:  borrador (se recalcula cuantas veces haga falta)
//                   -> contabilizada (asiento de la liquidación + asiento de provisiones)
//                   -> pagada (asiento del pago de los salarios netos)

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Tercero = require('../../../core/models/Tercero');
const Empresa = require('../../../core/models/Empresa');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Asiento = require('../../../core/models/Asiento');
const PeriodoContable = require('../../../core/models/PeriodoContable');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const CuentaBancaria = require('../../tesoreria/models/CuentaBancaria');
const MovimientoBancario = require('../../tesoreria/models/MovimientoBancario');
const ConfigNomina = require('../models/ConfigNomina');
const ContratoLaboral = require('../models/ContratoLaboral');
const AusenciaNomina = require('../models/AusenciaNomina');
const ConceptoNomina = require('../models/ConceptoNomina');
const NominaPeriodo = require('../models/NominaPeriodo');
const NominaLiquidacion = require('../models/NominaLiquidacion');
const { contabilizarAsientoCompuesto, cuentasPorCodigo } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const auditoria = require('../../../core/services/auditoria');
const { asegurarCuentaContable } = require('../../tesoreria/services/contabilidadBancaria');
const PL = require('../../../../public/contable/parametrosLaborales');
const { liquidarEmpleado, resumenPlanilla } = require('../../../../public/contable/liquidacionNomina');
const AN = require('../../../../public/contable/asientoNomina');

const TIPOS_CONTRATO = ['indefinido', 'fijo', 'obra_labor'];
const TIPOS_SALARIO = ['ordinario', 'integral'];
const MODOS_AUXILIO = ['auto', 'si', 'no'];
const TIPOS_AUXILIO = ['transporte', 'conectividad'];
const MODOS_RETENCION = ['calculada', 'no_aplica', 'manual'];
const MAX_VALOR = 100000000000; // tope de cordura para un valor en pesos

// --- Utilidades -----------------------------------------------------------------
const nombresCuentas = Object.fromEntries(AN.CATALOGO.map((c) => [c.codigo, c.nombre]));

function fechaValida(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f || ''))) return false;
  const d = new Date(f + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

function hoyColombia() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function limpiarTexto(valor, max, nombre, obligatorio) {
  const t = String(valor == null ? '' : valor).replace(/\s+/g, ' ').trim();
  if (obligatorio && !t) throw new Error(`Falta ${nombre}.`);
  if (t.length > max) throw new Error(`${nombre} es muy largo (máximo ${max} caracteres).`);
  if (/[<>]/.test(t)) throw new Error(`${nombre} no puede llevar los símbolos < o >.`);
  return t || null;
}

function dinero(valor, nombre, { obligatorio = false, positivo = false } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obligatorio) throw new Error(`Falta ${nombre}.`);
    return 0;
  }
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0 || n > MAX_VALOR) throw new Error(`${nombre} no es un valor válido.`);
  if (positivo && n <= 0) throw new Error(`${nombre} debe ser mayor a cero.`);
  return Math.round(n * 100) / 100;
}

function entero(valor, nombre, { min = 0, max = 1000000, porDefecto = 0 } = {}) {
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nombre} debe ser un número entero entre ${min} y ${max}.`);
  return n;
}

function codigoEntidad(valor, nombre) {
  const t = limpiarTexto(valor, 20, nombre);
  if (t && !/^[A-Za-z0-9\-]+$/.test(t)) throw new Error(`${nombre} solo lleva letras, números y guion.`);
  return t;
}

const plano = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const mesTexto = (anio, mes) => `${anio}-${String(mes).padStart(2, '0')}`;

// --- Configuración -------------------------------------------------------------
async function obtenerConfigFila(empresaId, transaction) {
  const [cfg] = await ConfigNomina.findOrCreate({
    where: { empresaId },
    defaults: { id: uuidv4(), empresaId },
    transaction,
  });
  return cfg;
}

async function obtenerConfig(usuario) {
  return plano(await obtenerConfigFila(usuario.empresaId));
}

async function guardarConfig(datos, usuario) {
  const cfg = await obtenerConfigFila(usuario.empresaId);
  const cambios = {};
  if (datos.exoneraArt114 !== undefined) cambios.exoneraArt114 = !!datos.exoneraArt114;
  if (datos.areaGastoPorDefecto !== undefined) {
    if (!AN.AREAS[datos.areaGastoPorDefecto]) throw new Error('El área de gasto es administración o ventas.');
    cambios.areaGastoPorDefecto = datos.areaGastoPorDefecto;
  }
  if (datos.arlNombre !== undefined) cambios.arlNombre = limpiarTexto(datos.arlNombre, 100, 'El nombre de la ARL');
  if (datos.arlCodigo !== undefined) cambios.arlCodigo = codigoEntidad(datos.arlCodigo, 'El código de la ARL');
  if (datos.ccfNombre !== undefined) cambios.ccfNombre = limpiarTexto(datos.ccfNombre, 100, 'El nombre de la caja de compensación');
  if (datos.ccfCodigo !== undefined) cambios.ccfCodigo = codigoEntidad(datos.ccfCodigo, 'El código de la caja de compensación');
  if (datos.operadorPila !== undefined) cambios.operadorPila = limpiarTexto(datos.operadorPila, 100, 'El operador de PILA');
  await cfg.update(cambios);
  await auditoria.registrar({
    empresaId: usuario.empresaId,
    usuarioId: usuario.id,
    accion: 'nomina_configuracion',
    entidad: 'ConfigNomina',
    entidadId: cfg.id,
    detalle: Object.keys(cambios).join(', '),
  });
  return plano(cfg);
}

// Datos que necesita la pantalla antes de digitar.
async function opciones(usuario) {
  const empresaId = usuario.empresaId;
  const hoy = hoyColombia();
  const anio = Number(hoy.slice(0, 4));
  const P = PL.parametros(anio);
  const [empleados, bancos, cfg] = await Promise.all([
    Tercero.findAll({ where: { empresaId, tipo: 'empleado' }, order: [['nombre', 'ASC']] }),
    CuentaBancaria.findAll({ where: { empresaId }, order: [['createdAt', 'ASC']] }),
    obtenerConfigFila(empresaId),
  ]);
  return {
    config: plano(cfg),
    empleados: empleados.map((e) => ({ id: e.id, nombre: e.nombre, identificacion: e.identificacion })),
    cuentasBancarias: bancos.map((b) => ({ id: b.id, banco: b.banco, numero: String(b.numero).slice(-4), tipoCuenta: b.tipoCuenta })),
    parametros: { anio, smmlv: P.smmlv, auxilioTransporte: P.auxilioTransporte, uvt: P.uvt, estimado: P.estimado },
    ausencias: Object.entries(PL.AUSENCIAS).map(([codigo, d]) => ({ codigo, nombre: d.nombre, remunerada: d.remunerada })),
    devengos: Object.entries(PL.DEVENGOS).map(([codigo, d]) => ({ codigo, nombre: d.nombre, horas: !!d.horas, salarial: d.salarial })),
    descuentos: Object.entries(PL.DESCUENTOS).map(([codigo, d]) => ({ codigo, nombre: d.nombre })),
    clasesRiesgo: PL.CLASES_RIESGO,
    areas: AN.AREAS,
    hoy,
  };
}

// --- Contratos ------------------------------------------------------------------
function conEmpleado(contrato, empleadosPorId) {
  const p = plano(contrato);
  const e = empleadosPorId[p.empleadoId];
  p.empleado = e ? { id: e.id, nombre: e.nombre, identificacion: e.identificacion } : null;
  for (const k of ['salarioBase', 'retencionManual', 'interesesVivienda', 'medicinaPrepagada', 'aporteVoluntarioPension', 'aporteAfc']) {
    p[k] = Number(p[k]);
  }
  return p;
}

async function empleadosDe(empresaId, ids) {
  const lista = ids.length ? await Tercero.findAll({ where: { empresaId, id: { [Op.in]: ids } } }) : [];
  return Object.fromEntries(lista.map((e) => [e.id, e]));
}

async function listarContratos(usuario) {
  const contratos = await ContratoLaboral.findAll({ where: { empresaId: usuario.empresaId }, order: [['fechaIngreso', 'DESC']] });
  const emp = await empleadosDe(usuario.empresaId, Array.from(new Set(contratos.map((c) => c.empleadoId))));
  return contratos.map((c) => conEmpleado(c, emp));
}

function normalizarContrato(d, actual) {
  const base = actual ? plano(actual) : {};
  const v = (k) => (d[k] !== undefined ? d[k] : base[k]);

  const tipoContrato = v('tipoContrato') || 'indefinido';
  if (!TIPOS_CONTRATO.includes(tipoContrato)) throw new Error('El tipo de contrato es indefinido, a término fijo o por obra o labor.');
  const tipoSalario = v('tipoSalario') || 'ordinario';
  if (!TIPOS_SALARIO.includes(tipoSalario)) throw new Error('El tipo de salario es ordinario o integral.');
  const auxilioTransporte = v('auxilioTransporte') || 'auto';
  if (!MODOS_AUXILIO.includes(auxilioTransporte)) throw new Error('El auxilio de transporte es automático, sí o no.');
  const tipoAuxilio = v('tipoAuxilio') || 'transporte';
  if (!TIPOS_AUXILIO.includes(tipoAuxilio)) throw new Error('El auxilio es de transporte o de conectividad.');
  const retencionFuente = v('retencionFuente') || 'calculada';
  if (!MODOS_RETENCION.includes(retencionFuente)) throw new Error('La retención en la fuente es calculada, no aplica o manual.');
  const areaGasto = v('areaGasto') || 'administracion';
  if (!AN.AREAS[areaGasto]) throw new Error('El área de gasto es administración o ventas.');

  const fechaIngreso = v('fechaIngreso');
  if (!fechaValida(fechaIngreso)) throw new Error('Escribe la fecha de ingreso (AAAA-MM-DD).');
  const opcional = (k, nombre) => {
    const f = v(k);
    if (f === null || f === undefined || f === '') return null;
    if (!fechaValida(f)) throw new Error(`${nombre} no es una fecha válida.`);
    return f;
  };
  const fechaFinPactada = opcional('fechaFinPactada', 'La fecha de terminación pactada');
  const fechaTerminacion = opcional('fechaTerminacion', 'La fecha de terminación');
  if (fechaTerminacion && fechaTerminacion < fechaIngreso) throw new Error('La terminación no puede ser antes del ingreso.');
  if (tipoContrato === 'fijo' && !fechaFinPactada) throw new Error('El contrato a término fijo necesita la fecha en que termina.');
  if (fechaFinPactada && fechaFinPactada < fechaIngreso) throw new Error('La fecha pactada de terminación no puede ser antes del ingreso.');

  const salarioBase = dinero(v('salarioBase'), 'El salario', { obligatorio: true, positivo: true });
  const claseRiesgo = entero(v('claseRiesgo'), 'La clase de riesgo', { min: 1, max: 5, porDefecto: 1 });
  const horasSemanales = v('horasSemanales') === null || v('horasSemanales') === '' || v('horasSemanales') === undefined
    ? null
    : entero(v('horasSemanales'), 'Las horas semanales', { min: 1, max: 48 });

  return {
    cargo: limpiarTexto(v('cargo'), 100, 'El cargo'),
    tipoContrato,
    fechaIngreso,
    fechaFinPactada,
    fechaTerminacion,
    salarioBase,
    tipoSalario,
    auxilioTransporte,
    tipoAuxilio,
    claseRiesgo,
    horasSemanales,
    areaGasto,
    retencionFuente,
    retencionManual: dinero(v('retencionManual'), 'La retención manual'),
    dependientes: entero(v('dependientes'), 'Los dependientes', { min: 0, max: 20 }),
    interesesVivienda: dinero(v('interesesVivienda'), 'Los intereses de vivienda'),
    medicinaPrepagada: dinero(v('medicinaPrepagada'), 'La medicina prepagada'),
    aporteVoluntarioPension: dinero(v('aporteVoluntarioPension'), 'El aporte voluntario a pensión'),
    aporteAfc: dinero(v('aporteAfc'), 'El aporte a AFC'),
    epsNombre: limpiarTexto(v('epsNombre'), 100, 'El nombre de la EPS'),
    epsCodigo: codigoEntidad(v('epsCodigo'), 'El código de la EPS'),
    afpNombre: limpiarTexto(v('afpNombre'), 100, 'El nombre del fondo de pensiones'),
    afpCodigo: codigoEntidad(v('afpCodigo'), 'El código del fondo de pensiones'),
    fondoCesantiasNombre: limpiarTexto(v('fondoCesantiasNombre'), 100, 'El nombre del fondo de cesantías'),
    fondoCesantiasCodigo: codigoEntidad(v('fondoCesantiasCodigo'), 'El código del fondo de cesantías'),
    observaciones: limpiarTexto(v('observaciones'), 1000, 'Las observaciones'),
  };
}

async function periodosContabilizadosQueTocan(empresaId, desde, hasta, transaction) {
  return NominaPeriodo.findAll({
    where: {
      empresaId,
      estado: { [Op.in]: ['contabilizada', 'pagada'] },
      fechaInicio: { [Op.lte]: hasta || '9999-12-31' },
      fechaFin: { [Op.gte]: desde },
    },
    order: [['fechaInicio', 'ASC']],
    transaction,
  });
}

async function validarSinCruce(empresaId, empleadoId, ingreso, terminacion, excluirId) {
  const otros = await ContratoLaboral.findAll({ where: { empresaId, empleadoId, ...(excluirId ? { id: { [Op.ne]: excluirId } } : {}) } });
  for (const o of otros) {
    const finO = o.fechaTerminacion || '9999-12-31';
    const fin = terminacion || '9999-12-31';
    if (ingreso <= finO && o.fechaIngreso <= fin) {
      throw new Error(`Este empleado ya tiene un contrato vigente entre ${o.fechaIngreso} y ${o.fechaTerminacion || 'hoy'}. Termina ese contrato antes de crear otro.`);
    }
  }
}

async function crearContrato(datos, usuario) {
  const empresaId = usuario.empresaId;
  const empleadoExistente = datos.empleadoId || null;
  const contrato = normalizarContrato(datos);

  // Todas las validaciones (lecturas) antes de abrir la transacción.
  let nuevo = null;
  if (empleadoExistente) {
    const e = await Tercero.findOne({ where: { id: empleadoExistente, empresaId, tipo: 'empleado' } });
    if (!e) throw new Error('Elige un empleado de tu empresa.');
    await validarSinCruce(empresaId, empleadoExistente, contrato.fechaIngreso, contrato.fechaTerminacion);
  } else {
    const n = datos.nuevoEmpleado || {};
    const identificacion = limpiarTexto(n.identificacion, 20, 'La cédula del empleado', true);
    if (!/^[\dA-Za-z.\-]{4,20}$/.test(identificacion)) throw new Error('La cédula solo lleva números (y puntos o guion).');
    const nombre = limpiarTexto(n.nombre, 150, 'El nombre del empleado', true);
    const repetido = await Tercero.findOne({ where: { empresaId, identificacion, tipo: 'empleado' } });
    if (repetido) throw new Error(`Ya existe un empleado con la cédula ${identificacion} (${repetido.nombre}). Elígelo de la lista.`);
    nuevo = { identificacion, nombre, email: limpiarTexto(n.email, 150, 'El correo'), celular: limpiarTexto(n.celular, 20, 'El celular') };
  }
  const bloqueados = await periodosContabilizadosQueTocan(empresaId, contrato.fechaIngreso, contrato.fechaTerminacion);
  if (bloqueados.length) {
    const p = bloqueados[0];
    throw new Error(`El contrato empezaría en ${mesTexto(p.anio, p.mes)}, que ya está contabilizado. Pon la fecha de ingreso en un mes por liquidar.`);
  }

  const creado = await sequelize.transaction(async (transaction) => {
    let empleadoId = empleadoExistente;
    if (!empleadoId) {
      const tercero = await Tercero.create({ id: uuidv4(), empresaId, tipo: 'empleado', tipoPersona: 'natural', ...nuevo }, { transaction });
      empleadoId = tercero.id;
    }
    return ContratoLaboral.create({ id: uuidv4(), empresaId, empleadoId, ...contrato }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_contrato_creado', entidad: 'ContratoLaboral', entidadId: creado.id,
    detalle: `ingreso ${contrato.fechaIngreso}`,
  });
  const emp = await empleadosDe(empresaId, [creado.empleadoId]);
  return conEmpleado(creado, emp);
}

async function actualizarContrato(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const actual = await ContratoLaboral.findOne({ where: { id, empresaId } });
  if (!actual) throw new Error('Contrato no encontrado.');
  const cambios = normalizarContrato(datos, actual);

  const cerrados = await NominaPeriodo.findAll({ where: { empresaId, estado: { [Op.in]: ['contabilizada', 'pagada'] } }, attributes: ['id'] });
  const usado = cerrados.length
    ? await NominaLiquidacion.count({ where: { contratoId: actual.id, periodoId: { [Op.in]: cerrados.map((p) => p.id) } } })
    : 0;
  if (usado > 0 && cambios.fechaIngreso !== actual.fechaIngreso) {
    throw new Error('No puedes cambiar la fecha de ingreso: el contrato ya tiene nóminas contabilizadas.');
  }
  await validarSinCruce(empresaId, actual.empleadoId, cambios.fechaIngreso, cambios.fechaTerminacion, actual.id);

  await actual.update(cambios);
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_contrato_actualizado', entidad: 'ContratoLaboral', entidadId: actual.id,
    detalle: Object.keys(datos).join(', ').slice(0, 250),
  });
  const emp = await empleadosDe(empresaId, [actual.empleadoId]);
  return conEmpleado(actual, emp);
}

// --- Ausencias -------------------------------------------------------------------
async function listarAusencias(usuario) {
  const lista = await AusenciaNomina.findAll({ where: { empresaId: usuario.empresaId }, order: [['fechaInicio', 'DESC']] });
  const emp = await empleadosDe(usuario.empresaId, Array.from(new Set(lista.map((a) => a.empleadoId))));
  return lista.map((a) => {
    const p = plano(a);
    p.empleado = emp[a.empleadoId] ? { id: a.empleadoId, nombre: emp[a.empleadoId].nombre } : null;
    p.nombreTipo = PL.AUSENCIAS[a.tipo] ? PL.AUSENCIAS[a.tipo].nombre : a.tipo;
    p.dias = PL.dias360(a.fechaInicio, a.fechaFin);
    return p;
  });
}

async function validarAusenciaFueraDeMesesCerrados(empresaId, desde, hasta) {
  const cerrados = await periodosContabilizadosQueTocan(empresaId, desde, hasta);
  if (cerrados.length) {
    const p = cerrados[0];
    throw new Error(`El rango toca ${mesTexto(p.anio, p.mes)}, que ya está contabilizado y no se recalcula. Si es una novedad atrasada, regístrala en el mes en curso como ajuste.`);
  }
}

async function crearAusencia(datos, usuario) {
  const empresaId = usuario.empresaId;
  if (!PL.AUSENCIAS[datos.tipo]) throw new Error('Elige el tipo de ausencia.');
  const empleado = await Tercero.findOne({ where: { id: datos.empleadoId || null, empresaId, tipo: 'empleado' } });
  if (!empleado) throw new Error('Elige un empleado de tu empresa.');
  if (!fechaValida(datos.fechaInicio) || !fechaValida(datos.fechaFin)) throw new Error('Escribe las fechas de inicio y de fin (AAAA-MM-DD).');
  if (datos.fechaFin < datos.fechaInicio) throw new Error('La ausencia no puede terminar antes de empezar.');
  if (PL.diferenciaDias(datos.fechaInicio, datos.fechaFin) > 800) throw new Error('El rango de la ausencia es demasiado largo.');

  const contratos = await ContratoLaboral.findAll({ where: { empresaId, empleadoId: empleado.id } });
  const cubierto = contratos.some((c) => c.fechaIngreso <= datos.fechaInicio && (!c.fechaTerminacion || c.fechaTerminacion >= datos.fechaFin));
  if (!cubierto) throw new Error('Las fechas deben quedar dentro de un contrato del empleado.');

  const cruce = await AusenciaNomina.findOne({
    where: { empresaId, empleadoId: empleado.id, fechaInicio: { [Op.lte]: datos.fechaFin }, fechaFin: { [Op.gte]: datos.fechaInicio } },
  });
  if (cruce) throw new Error(`Se cruza con otra ausencia del empleado (${cruce.fechaInicio} a ${cruce.fechaFin}).`);
  await validarAusenciaFueraDeMesesCerrados(empresaId, datos.fechaInicio, datos.fechaFin);

  const diasPrevios = datos.tipo === 'incapacidad_general' ? entero(datos.diasPrevios, 'Los días previos de la incapacidad', { min: 0, max: 540 }) : 0;
  const valorDiario = datos.valorDiario === undefined || datos.valorDiario === null || datos.valorDiario === ''
    ? null
    : dinero(datos.valorDiario, 'El valor diario', { positivo: true });

  const creada = await AusenciaNomina.create({
    id: uuidv4(), empresaId, empleadoId: empleado.id, tipo: datos.tipo,
    fechaInicio: datos.fechaInicio, fechaFin: datos.fechaFin, diasPrevios, valorDiario,
    numeroDocumento: limpiarTexto(datos.numeroDocumento, 50, 'El número del documento'),
    observacion: limpiarTexto(datos.observacion, 255, 'La observación'),
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_ausencia_creada', entidad: 'AusenciaNomina', entidadId: creada.id,
    detalle: `${datos.tipo} ${datos.fechaInicio} a ${datos.fechaFin}`,
  });
  return plano(creada);
}

async function eliminarAusencia(id, usuario) {
  const a = await AusenciaNomina.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!a) throw new Error('Ausencia no encontrada.');
  await validarAusenciaFueraDeMesesCerrados(usuario.empresaId, a.fechaInicio, a.fechaFin);
  await a.destroy();
  await auditoria.registrar({
    empresaId: usuario.empresaId, usuarioId: usuario.id, accion: 'nomina_ausencia_eliminada', entidad: 'AusenciaNomina', entidadId: id,
    detalle: `${a.tipo} ${a.fechaInicio} a ${a.fechaFin}`,
  });
  return { eliminada: true };
}

// --- Novedades de devengo y descuento ---------------------------------------------
async function listarConceptos(usuario) {
  const lista = await ConceptoNomina.findAll({ where: { empresaId: usuario.empresaId, activo: true }, order: [['createdAt', 'DESC']] });
  const emp = await empleadosDe(usuario.empresaId, Array.from(new Set(lista.map((c) => c.empleadoId))));
  return lista.map((c) => {
    const p = plano(c);
    p.empleado = emp[c.empleadoId] ? { id: c.empleadoId, nombre: emp[c.empleadoId].nombre } : null;
    const def = c.clase === 'devengo' ? PL.DEVENGOS[c.codigo] : PL.DESCUENTOS[c.codigo];
    p.nombreConcepto = def ? def.nombre : c.codigo;
    p.cantidad = p.cantidad === null ? null : Number(p.cantidad);
    p.valor = p.valor === null ? null : Number(p.valor);
    return p;
  });
}

async function crearConcepto(datos, usuario) {
  const empresaId = usuario.empresaId;
  const clase = datos.clase;
  if (!['devengo', 'descuento'].includes(clase)) throw new Error('La novedad es un devengo o un descuento.');
  const def = clase === 'devengo' ? PL.DEVENGOS[datos.codigo] : PL.DESCUENTOS[datos.codigo];
  if (!def) throw new Error('Elige el concepto.');
  const empleado = await Tercero.findOne({ where: { id: datos.empleadoId || null, empresaId, tipo: 'empleado' } });
  if (!empleado) throw new Error('Elige un empleado de tu empresa.');

  const recurrente = !!datos.recurrente;
  const anio = entero(datos.anio, 'El año', { min: 2020, max: 2100, porDefecto: null });
  const mes = entero(datos.mes, 'El mes', { min: 1, max: 12, porDefecto: null });
  if (!anio || !mes) throw new Error(recurrente ? 'Indica desde qué mes aplica.' : 'Indica el mes de la novedad.');

  const horas = !!def.horas;
  const cantidad = horas ? dinero(datos.cantidad, 'Las horas') : null;
  const valor = datos.valor === undefined || datos.valor === '' || datos.valor === null ? null : dinero(datos.valor, 'El valor');
  if (horas && !(cantidad > 0) && !(valor > 0)) throw new Error('Escribe las horas.');
  if (!horas && !(valor > 0)) throw new Error('Escribe el valor.');

  const periodo = await NominaPeriodo.findOne({ where: { empresaId, anio, mes } });
  if (periodo && periodo.estado !== 'borrador' && !recurrente) {
    throw new Error(`La nómina de ${mesTexto(anio, mes)} ya está ${periodo.estado}; no admite más novedades.`);
  }

  const creado = await ConceptoNomina.create({
    id: uuidv4(), empresaId, empleadoId: empleado.id, clase, codigo: datos.codigo,
    cantidad, valor, descripcion: limpiarTexto(datos.descripcion, 150, 'La descripción'),
    recurrente,
    anio: recurrente ? null : anio, mes: recurrente ? null : mes,
    desdeAnio: recurrente ? anio : null, desdeMes: recurrente ? mes : null,
    activo: true,
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_novedad_creada', entidad: 'ConceptoNomina', entidadId: creado.id,
    detalle: `${clase} ${datos.codigo}${recurrente ? ' (recurrente)' : ''}`,
  });
  return plano(creado);
}

async function eliminarConcepto(id, usuario) {
  const c = await ConceptoNomina.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!c) throw new Error('Novedad no encontrada.');
  if (!c.recurrente) {
    const periodo = await NominaPeriodo.findOne({ where: { empresaId: usuario.empresaId, anio: c.anio, mes: c.mes } });
    if (periodo && periodo.estado !== 'borrador') throw new Error(`La nómina de ${mesTexto(c.anio, c.mes)} ya está ${periodo.estado}; la novedad no se puede quitar.`);
    await c.destroy();
  } else {
    await c.update({ activo: false }); // una novedad recurrente se desactiva: las nóminas ya hechas la conservan
  }
  await auditoria.registrar({
    empresaId: usuario.empresaId, usuarioId: usuario.id, accion: 'nomina_novedad_eliminada', entidad: 'ConceptoNomina', entidadId: id,
    detalle: `${c.clase} ${c.codigo}`,
  });
  return { eliminada: true };
}

// --- Períodos y liquidación ----------------------------------------------------------
async function periodoDe(id, empresaId, transaction) {
  const p = await NominaPeriodo.findOne({ where: { id, empresaId }, transaction });
  if (!p) throw new Error('Período de nómina no encontrado.');
  return p;
}

async function listarPeriodos(usuario) {
  const periodos = await NominaPeriodo.findAll({ where: { empresaId: usuario.empresaId }, order: [['anio', 'DESC'], ['mes', 'DESC']] });
  const conteos = await NominaLiquidacion.findAll({
    attributes: ['periodoId', [sequelize.fn('COUNT', sequelize.col('id')), 'empleados']],
    where: { empresaId: usuario.empresaId },
    group: ['periodoId'],
    raw: true,
  });
  const porPeriodo = Object.fromEntries(conteos.map((c) => [c.periodoId, Number(c.empleados)]));
  return periodos.map((p) => {
    const x = plano(p);
    for (const k of ['totalDevengado', 'totalDeducciones', 'totalNeto', 'totalAportesEmpleador', 'totalProvisiones']) x[k] = Number(x[k]);
    x.empleados = porPeriodo[p.id] || 0;
    return x;
  });
}

async function crearPeriodo(datos, usuario) {
  const anio = entero(datos.anio, 'El año', { min: 2020, max: 2100, porDefecto: null });
  const mes = entero(datos.mes, 'El mes', { min: 1, max: 12, porDefecto: null });
  if (!anio || !mes) throw new Error('Elige el año y el mes de la nómina.');
  const hoy = hoyColombia();
  if (anio * 12 + mes > Number(hoy.slice(0, 4)) * 12 + Number(hoy.slice(5, 7)) + 1) {
    throw new Error('No puedes liquidar una nómina de más de un mes adelante.');
  }
  const repetido = await NominaPeriodo.findOne({ where: { empresaId: usuario.empresaId, anio, mes } });
  if (repetido) throw new Error(`Ya existe la nómina de ${mesTexto(anio, mes)}.`);

  const periodo = await NominaPeriodo.create({
    id: uuidv4(), empresaId: usuario.empresaId, anio, mes,
    fechaInicio: PL.texto(anio, mes, 1), fechaFin: PL.texto(anio, mes, PL.diasDelMes(anio, mes)),
    estado: 'borrador',
  });
  await auditoria.registrar({
    empresaId: usuario.empresaId, usuarioId: usuario.id, accion: 'nomina_periodo_creado', entidad: 'NominaPeriodo', entidadId: periodo.id,
    detalle: mesTexto(anio, mes),
  });
  return preliquidar(periodo.id, usuario);
}

// Entrada del motor con lo guardado de un contrato en un mes.
function armarEntrada(contrato, config, ausencias, conceptos, anio, mes) {
  const n = (x) => Number(x) || 0;
  return {
    anio,
    mes,
    empresa: { exoneraArt114: config.exoneraArt114 },
    contrato: {
      fechaIngreso: contrato.fechaIngreso,
      fechaTerminacion: contrato.fechaTerminacion || null,
      salarioBase: n(contrato.salarioBase),
      tipoSalario: contrato.tipoSalario,
      auxilioTransporte: contrato.auxilioTransporte,
      tipoAuxilio: contrato.tipoAuxilio,
      claseRiesgo: contrato.claseRiesgo,
      horasSemanales: contrato.horasSemanales || null,
      dependientes: contrato.dependientes,
      interesesVivienda: n(contrato.interesesVivienda),
      medicinaPrepagada: n(contrato.medicinaPrepagada),
      aporteVoluntarioPension: n(contrato.aporteVoluntarioPension),
      aporteAfc: n(contrato.aporteAfc),
      retencionFuente: contrato.retencionFuente,
      retencionManual: n(contrato.retencionManual),
    },
    ausencias: ausencias.map((a) => ({
      tipo: a.tipo, desde: a.fechaInicio, hasta: a.fechaFin, diasPrevios: a.diasPrevios,
      valorDiario: a.valorDiario === null ? null : Number(a.valorDiario),
    })),
    conceptos: conceptos.filter((c) => c.clase === 'devengo').map((c) => ({
      codigo: c.codigo, cantidad: c.cantidad === null ? null : Number(c.cantidad), valor: c.valor === null ? null : Number(c.valor), descripcion: c.descripcion || '',
    })),
    descuentos: conceptos.filter((c) => c.clase === 'descuento').map((c) => ({ codigo: c.codigo, valor: Number(c.valor), descripcion: c.descripcion || '' })),
  };
}

// Calcula (o recalcula) la nómina de todos los empleados con contrato en el mes.
// Solo en borrador. Si el motor no puede liquidar a alguien, queda anotado el motivo.
async function preliquidar(periodoId, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await periodoDe(periodoId, empresaId);
  if (periodo.estado !== 'borrador') throw new Error(`La nómina de ${mesTexto(periodo.anio, periodo.mes)} ya está ${periodo.estado}; no se puede recalcular.`);

  const config = await obtenerConfigFila(empresaId);
  const contratos = await ContratoLaboral.findAll({
    where: {
      empresaId,
      fechaIngreso: { [Op.lte]: periodo.fechaFin },
      [Op.or]: [{ fechaTerminacion: null }, { fechaTerminacion: { [Op.gte]: periodo.fechaInicio } }],
    },
    order: [['fechaIngreso', 'ASC']],
  });
  const ausencias = await AusenciaNomina.findAll({
    where: { empresaId, fechaInicio: { [Op.lte]: periodo.fechaFin }, fechaFin: { [Op.gte]: periodo.fechaInicio } },
  });
  const ordenActual = periodo.anio * 12 + periodo.mes;
  const todos = await ConceptoNomina.findAll({ where: { empresaId, activo: true } });
  const conceptosDelMes = todos.filter((c) => (c.recurrente
    ? c.desdeAnio * 12 + c.desdeMes <= ordenActual
    : c.anio === periodo.anio && c.mes === periodo.mes));

  const vistos = new Set();
  const filas = [];
  for (const c of contratos) {
    let fila;
    if (vistos.has(c.empleadoId)) {
      fila = { empleadoId: c.empleadoId, contratoId: c.id, error: 'El empleado tiene más de un contrato en el mismo mes; esta nómina no lo soporta todavía.' };
    } else {
      vistos.add(c.empleadoId);
      const entrada = armarEntrada(
        c, config,
        ausencias.filter((a) => a.empleadoId === c.empleadoId),
        conceptosDelMes.filter((x) => x.empleadoId === c.empleadoId),
        periodo.anio, periodo.mes
      );
      try {
        const L = liquidarEmpleado(entrada);
        fila = {
          empleadoId: c.empleadoId, contratoId: c.id, areaGasto: c.areaGasto,
          diasTrabajados: L.dias.trabajados, devengado: L.totales.devengado, deducciones: L.totales.deducciones, neto: L.totales.neto,
          aportesEmpleador: L.aportes.empleador.total, provisiones: L.provisiones.total, ibc: L.ibc.total,
          error: null, entrada, resultado: L,
        };
      } catch (e) {
        fila = { empleadoId: c.empleadoId, contratoId: c.id, areaGasto: c.areaGasto, error: String(e.message).slice(0, 500), entrada };
      }
    }
    filas.push(fila);
  }

  await sequelize.transaction(async (transaction) => {
    await NominaLiquidacion.destroy({ where: { periodoId: periodo.id }, transaction });
    for (const f of filas) {
      await NominaLiquidacion.create({
        id: uuidv4(), empresaId, periodoId: periodo.id,
        empleadoId: f.empleadoId, contratoId: f.contratoId, areaGasto: f.areaGasto || 'administracion',
        diasTrabajados: f.diasTrabajados || 0, devengado: f.devengado || 0, deducciones: f.deducciones || 0, neto: f.neto || 0,
        aportesEmpleador: f.aportesEmpleador || 0, provisiones: f.provisiones || 0, ibc: f.ibc || 0,
        pagado: false, error: f.error || null, entrada: f.entrada || null, resultado: f.resultado || null,
      }, { transaction });
    }
    const buenas = filas.filter((f) => !f.error);
    const suma = (k) => buenas.reduce((s, f) => s + (f[k] || 0), 0);
    await periodo.update({
      totalDevengado: suma('devengado'), totalDeducciones: suma('deducciones'), totalNeto: suma('neto'),
      totalAportesEmpleador: suma('aportesEmpleador'), totalProvisiones: suma('provisiones'),
    }, { transaction });
  });

  return detallePeriodo(periodo.id, usuario);
}

function enriquecerAsiento(asiento, nombresTerceros) {
  return {
    ...asiento,
    lineas: asiento.lineas.map((l) => ({
      ...l,
      cuentaNombre: nombresCuentas[l.cuentaCodigo] || '',
      terceroNombre: l.terceroId ? nombresTerceros[l.terceroId] || '' : '',
    })),
  };
}

function itemsDeAsiento(liquidaciones) {
  return liquidaciones
    .filter((l) => !l.error && l.resultado)
    .map((l) => ({ terceroId: l.empleadoId, area: l.areaGasto, liquidacion: l.resultado }));
}

async function detallePeriodo(periodoId, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await periodoDe(periodoId, empresaId);
  const liquidaciones = await NominaLiquidacion.findAll({ where: { periodoId: periodo.id }, order: [['createdAt', 'ASC']] });
  const emp = await empleadosDe(empresaId, liquidaciones.map((l) => l.empleadoId));
  const contratos = await ContratoLaboral.findAll({ where: { id: { [Op.in]: liquidaciones.map((l) => l.contratoId) } } });
  const cargoPorContrato = Object.fromEntries(contratos.map((c) => [c.id, c.cargo]));

  const filas = liquidaciones
    .map((l) => {
      const e = emp[l.empleadoId];
      const r = l.resultado;
      return {
        id: l.id,
        empleadoId: l.empleadoId,
        nombre: e ? e.nombre : '(empleado eliminado)',
        identificacion: e ? e.identificacion : '',
        cargo: cargoPorContrato[l.contratoId] || '',
        areaGasto: l.areaGasto,
        diasTrabajados: l.diasTrabajados,
        devengado: Number(l.devengado),
        deducciones: Number(l.deducciones),
        neto: Number(l.neto),
        aportesEmpleador: Number(l.aportesEmpleador),
        provisiones: Number(l.provisiones),
        ibc: Number(l.ibc),
        pagado: l.pagado,
        error: l.error,
        advertencias: r ? r.advertencias : [],
        retencion: r ? r.retencion.valor : 0,
      };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  const nombresTerceros = Object.fromEntries(Object.entries(emp).map(([id, e]) => [id, e.nombre]));
  let vistaPrevia = null;
  const items = itemsDeAsiento(liquidaciones);
  if (items.length && !liquidaciones.some((l) => l.error)) {
    try {
      vistaPrevia = {
        liquidacion: enriquecerAsiento(AN.armarAsientoLiquidacion(items), nombresTerceros),
        provisiones: enriquecerAsiento(AN.armarAsientoProvisiones(items), nombresTerceros),
      };
    } catch (e) {
      vistaPrevia = { error: e.message };
    }
  }

  const x = plano(periodo);
  for (const k of ['totalDevengado', 'totalDeducciones', 'totalNeto', 'totalAportesEmpleador', 'totalProvisiones']) x[k] = Number(x[k]);
  const P = PL.parametros(periodo.anio);
  return {
    periodo: x,
    parametros: { smmlv: P.smmlv, auxilioTransporte: P.auxilioTransporte, uvt: P.uvt, estimado: P.estimado },
    liquidaciones: filas,
    vistaPrevia,
    advertencias: Array.from(new Set(filas.flatMap((f) => f.advertencias))),
  };
}

async function detalleLiquidacion(periodoId, empleadoId, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await periodoDe(periodoId, empresaId);
  const liq = await NominaLiquidacion.findOne({ where: { periodoId: periodo.id, empleadoId } });
  if (!liq) throw new Error('El empleado no está en esta nómina.');
  const [empleado, contrato, empresa] = await Promise.all([
    Tercero.findByPk(empleadoId),
    ContratoLaboral.findByPk(liq.contratoId),
    Empresa.findByPk(empresaId),
  ]);
  return {
    periodo: { id: periodo.id, anio: periodo.anio, mes: periodo.mes, estado: periodo.estado, fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin, fechaPago: periodo.fechaPago },
    empresa: empresa ? { razonSocial: empresa.razonSocial, nit: empresa.nit } : null,
    empleado: empleado ? { id: empleado.id, nombre: empleado.nombre, identificacion: empleado.identificacion } : null,
    contrato: contrato ? { cargo: contrato.cargo, tipoContrato: contrato.tipoContrato, fechaIngreso: contrato.fechaIngreso, salarioBase: Number(contrato.salarioBase), tipoSalario: contrato.tipoSalario } : null,
    error: liq.error,
    pagado: liq.pagado,
    resultado: liq.resultado,
  };
}

// --- Contabilización -----------------------------------------------------------------
// Reglas que el motor de asientos exige para cada evento de nómina. Se crean aquí
// (con sus cuentas) la primera vez que la empresa contabiliza nómina.
async function asegurarReglasNomina(empresaId, transaction) {
  const reglas = [
    { evento: 'nomina_liquidacion', debito: '510506', credito: '2505' },
    { evento: 'nomina_provisiones', debito: '510530', credito: '2510' },
    { evento: 'nomina_pago', debito: '2505', credito: '1110' },
  ];
  const cuentas = await cuentasPorCodigo(empresaId, reglas.flatMap((r) => [r.debito, r.credito]), transaction);
  for (const r of reglas) {
    await ReglaContabilizacion.findOrCreate({
      where: { empresaId, eventoOrigen: r.evento },
      defaults: {
        id: uuidv4(), empresaId, eventoOrigen: r.evento,
        cuentaDebitoId: cuentas[r.debito].id, cuentaCreditoId: cuentas[r.credito].id, nivelAutomatizacion: 'automatico',
      },
      transaction,
    });
  }
}

async function contabilizarPeriodo(periodoId, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await periodoDe(periodoId, empresaId);
  if (periodo.estado !== 'borrador') throw new Error(`La nómina de ${mesTexto(periodo.anio, periodo.mes)} ya está ${periodo.estado}.`);

  // Se recalcula justo antes, por si cambió algo desde la última vez que se miró.
  await preliquidar(periodo.id, usuario);
  const liquidaciones = await NominaLiquidacion.findAll({ where: { periodoId: periodo.id } });
  if (liquidaciones.length === 0) throw new Error('No hay empleados con contrato vigente en este mes.');
  const conError = liquidaciones.filter((l) => l.error);
  if (conError.length) {
    const emp = await empleadosDe(empresaId, conError.map((l) => l.empleadoId));
    throw new Error(`Corrige antes de contabilizar: ${conError.map((l) => `${emp[l.empleadoId] ? emp[l.empleadoId].nombre : 'empleado'} (${l.error})`).join('; ')}`);
  }
  const items = itemsDeAsiento(liquidaciones);
  const liquidacion = AN.armarAsientoLiquidacion(items);
  const provisiones = AN.armarAsientoProvisiones(items);
  if (!liquidacion.cuadra || !provisiones.cuadra) throw new Error('Los asientos de la nómina no cuadran; no se contabilizó nada.');

  await aprovisionarContabilidadBase(empresaId);

  const resultado = await sequelize.transaction(async (transaction) => {
    await asegurarReglasNomina(empresaId, transaction);
    const nombreMes = mesTexto(periodo.anio, periodo.mes);
    const base = { empresaId, origenModulo: 'nomina', origenId: periodo.id, fecha: periodo.fechaFin, usuarioId: usuario.id, revisado: true, transaction };

    const a1 = await contabilizarAsientoCompuesto({ ...base, tipoEvento: 'nomina_liquidacion', lineas: liquidacion.lineas });
    const a2 = await contabilizarAsientoCompuesto({ ...base, tipoEvento: 'nomina_provisiones', lineas: provisiones.lineas });
    if (a1.periodoAjustado || a2.periodoAjustado) {
      throw new Error(`El período contable de ${nombreMes} está cerrado o no existe; ábrelo o créalo antes de contabilizar la nómina.`);
    }
    await periodo.update({
      estado: 'contabilizada', fechaContabilizacion: hoyColombia(), asientoId: a1.asiento.id, asientoProvisionesId: a2.asiento.id,
    }, { transaction });
    return { liquidacion: a1.asiento, provisiones: a2.asiento };
  });

  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_contabilizada', entidad: 'NominaPeriodo', entidadId: periodo.id,
    detalle: `${mesTexto(periodo.anio, periodo.mes)} · devengado ${liquidacion.lineas.length} líneas`,
  });
  const detalle = await detallePeriodo(periodo.id, usuario);
  detalle.asientos = { liquidacionId: resultado.liquidacion.id, provisionesId: resultado.provisiones.id };
  return detalle;
}

// Anula los asientos de un mes contabilizado y deja la nómina otra vez en borrador.
// No se permite si ya se pagó (primero habría que reversar el pago).
async function reabrirPeriodo(periodoId, datos, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await periodoDe(periodoId, empresaId);
  if (periodo.estado === 'pagada') throw new Error('La nómina ya está pagada; no se puede reabrir.');
  if (periodo.estado !== 'contabilizada') throw new Error('Solo se reabre una nómina contabilizada.');
  const motivo = limpiarTexto(datos && datos.motivo, 250, 'El motivo', true);
  if (motivo.length < 10) throw new Error('Escribe el motivo de la reapertura (mínimo 10 letras).');

  await sequelize.transaction(async (transaction) => {
    const asientos = await Asiento.findAll({ where: { id: { [Op.in]: [periodo.asientoId, periodo.asientoProvisionesId].filter(Boolean) }, empresaId }, transaction });
    for (const a of asientos) {
      const pc = await PeriodoContable.findByPk(a.periodoContableId, { transaction });
      if (pc && !['abierto', 'en_cierre'].includes(pc.estado)) {
        throw new Error('El período contable de esta nómina ya está cerrado; no se puede anular su asiento.');
      }
      await a.update({ estado: 'anulado' }, { transaction });
    }
    await periodo.update({ estado: 'borrador', asientoId: null, asientoProvisionesId: null, fechaContabilizacion: null }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_reabierta', entidad: 'NominaPeriodo', entidadId: periodo.id, detalle: motivo,
  });
  return detallePeriodo(periodo.id, usuario);
}

async function registrarPago(periodoId, datos, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await periodoDe(periodoId, empresaId);
  if (periodo.estado === 'pagada') throw new Error('Esta nómina ya está pagada.');
  if (periodo.estado !== 'contabilizada') throw new Error('Contabiliza la nómina antes de registrar el pago.');
  const fecha = datos.fecha || hoyColombia();
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha del pago (AAAA-MM-DD).');
  if (fecha < periodo.fechaInicio) throw new Error('El pago no puede ser anterior al mes de la nómina.');

  const liquidaciones = await NominaLiquidacion.findAll({ where: { periodoId: periodo.id, pagado: false } });
  const pagos = liquidaciones.filter((l) => Number(l.neto) > 0).map((l) => ({ terceroId: l.empleadoId, valor: Number(l.neto) }));
  if (!pagos.length) throw new Error('No hay salarios por pagar en esta nómina.');
  const total = pagos.reduce((s, p) => s + p.valor, 0);

  let cuentaBancaria = null;
  if (datos.cuentaBancariaId) {
    cuentaBancaria = await CuentaBancaria.findOne({ where: { id: datos.cuentaBancariaId, empresaId } });
    if (!cuentaBancaria) throw new Error('Elige una cuenta bancaria de tu empresa o paga en efectivo.');
  } else if (datos.medio !== 'caja') {
    throw new Error('Elige la cuenta bancaria desde la que se pagó, o marca pago en efectivo.');
  }

  await aprovisionarContabilidadBase(empresaId);
  const asientoId = await sequelize.transaction(async (transaction) => {
    await asegurarReglasNomina(empresaId, transaction);
    let codigoPago = '1105';
    if (cuentaBancaria) {
      const auxiliar = await asegurarCuentaContable(cuentaBancaria, transaction);
      codigoPago = auxiliar.codigo;
    }
    const asiento = AN.armarAsientoPago(pagos, codigoPago);
    if (!asiento.cuadra) throw new Error('El asiento del pago no cuadra.');
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: 'nomina_pago', origenModulo: 'nomina', origenId: periodo.id, fecha,
      lineas: asiento.lineas, usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha del pago está cerrado o no existe.');
    if (cuentaBancaria) {
      await MovimientoBancario.create({
        id: uuidv4(), empresaId, cuentaBancariaId: cuentaBancaria.id, fecha, valor: total, tipo: 'egreso',
        descripcion: `Pago de nómina ${mesTexto(periodo.anio, periodo.mes)}`, conciliado: false,
      }, { transaction });
    }
    await NominaLiquidacion.update({ pagado: true }, { where: { periodoId: periodo.id }, transaction });
    await periodo.update({ estado: 'pagada', fechaPago: fecha, asientoPagoId: r.asiento.id, cuentaBancariaPagoId: cuentaBancaria ? cuentaBancaria.id : null }, { transaction });
    return r.asiento.id;
  });

  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'nomina_pagada', entidad: 'NominaPeriodo', entidadId: periodo.id,
    detalle: `${mesTexto(periodo.anio, periodo.mes)} · ${total}`,
  });
  const detalle = await detallePeriodo(periodo.id, usuario);
  detalle.asientos = { pagoId: asientoId };
  return detalle;
}

// --- Provisiones acumuladas ------------------------------------------------------------
// Lo causado por cada empleado (cesantías, intereses, prima y vacaciones) en las
// nóminas contabilizadas, y las vacaciones ya disfrutadas.
async function provisionesAcumuladas(usuario, filtros) {
  const empresaId = usuario.empresaId;
  const where = { empresaId, estado: { [Op.in]: ['contabilizada', 'pagada'] } };
  const anio = filtros && filtros.anio ? Number(filtros.anio) : null;
  if (anio) where.anio = anio;
  const periodos = await NominaPeriodo.findAll({ where, order: [['anio', 'ASC'], ['mes', 'ASC']] });
  const ids = periodos.map((p) => p.id);
  const liquidaciones = ids.length ? await NominaLiquidacion.findAll({ where: { periodoId: { [Op.in]: ids } } }) : [];
  const emp = await empleadosDe(empresaId, Array.from(new Set(liquidaciones.map((l) => l.empleadoId))));

  const porEmpleado = new Map();
  for (const l of liquidaciones) {
    if (!l.resultado) continue;
    const p = l.resultado.provisiones;
    if (!porEmpleado.has(l.empleadoId)) {
      const e = emp[l.empleadoId];
      porEmpleado.set(l.empleadoId, {
        empleadoId: l.empleadoId, nombre: e ? e.nombre : '(empleado eliminado)', identificacion: e ? e.identificacion : '',
        meses: 0, cesantias: 0, intereses: 0, prima: 0, vacaciones: 0, vacacionesDisfrutadas: 0,
      });
    }
    const f = porEmpleado.get(l.empleadoId);
    f.meses += 1;
    f.cesantias += p.cesantias;
    f.intereses += p.intereses;
    f.prima += p.prima;
    f.vacaciones += p.vacaciones;
    f.vacacionesDisfrutadas += l.resultado.totales.vacaciones;
  }
  const filas = Array.from(porEmpleado.values()).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  for (const f of filas) {
    f.vacacionesSaldo = f.vacaciones - f.vacacionesDisfrutadas;
    f.total = f.cesantias + f.intereses + f.prima + f.vacacionesSaldo;
  }
  const suma = (k) => filas.reduce((s, f) => s + f[k], 0);
  return {
    anio,
    meses: periodos.map((p) => mesTexto(p.anio, p.mes)),
    filas,
    totales: { cesantias: suma('cesantias'), intereses: suma('intereses'), prima: suma('prima'), vacaciones: suma('vacaciones'), vacacionesDisfrutadas: suma('vacacionesDisfrutadas'), vacacionesSaldo: suma('vacacionesSaldo'), total: suma('total') },
    nota: 'Es lo causado en las nóminas contabilizadas desde que se usa este módulo. Los pagos de prima, cesantías e intereses se registran en la siguiente etapa.',
  };
}

// --- Planilla de aportes (PILA) ------------------------------------------------------------
async function planillaAportes(periodoId, usuario) {
  const empresaId = usuario.empresaId;
  const periodo = await periodoDe(periodoId, empresaId);
  const config = await obtenerConfigFila(empresaId);
  const empresa = await Empresa.findByPk(empresaId);
  const liquidaciones = (await NominaLiquidacion.findAll({ where: { periodoId: periodo.id } })).filter((l) => !l.error && l.resultado);
  const emp = await empleadosDe(empresaId, liquidaciones.map((l) => l.empleadoId));
  const contratos = await ContratoLaboral.findAll({ where: { id: { [Op.in]: liquidaciones.map((l) => l.contratoId) } } });
  const contratoPorId = Object.fromEntries(contratos.map((c) => [c.id, c]));

  const avisos = [];
  const items = liquidaciones.map((l) => {
    const c = contratoPorId[l.contratoId] || {};
    const e = emp[l.empleadoId] || {};
    const faltantes = [];
    if (!c.epsNombre) faltantes.push('EPS');
    if (!c.afpNombre) faltantes.push('fondo de pensiones');
    if (faltantes.length) avisos.push(`${e.nombre || 'Empleado'}: falta ${faltantes.join(' y ')}.`);
    return {
      empleado: { id: l.empleadoId, nombre: e.nombre, identificacion: e.identificacion },
      entidades: {
        eps: c.epsCodigo || c.epsNombre, epsNombre: c.epsNombre,
        afp: c.afpCodigo || c.afpNombre, afpNombre: c.afpNombre,
        arl: config.arlCodigo || config.arlNombre, arlNombre: config.arlNombre,
        ccf: config.ccfCodigo || config.ccfNombre, ccfNombre: config.ccfNombre,
      },
      liquidacion: l.resultado,
    };
  });
  if (!config.arlNombre) avisos.push('Falta la ARL de la empresa (Nómina > Configuración).');
  if (!config.ccfNombre) avisos.push('Falta la caja de compensación de la empresa (Nómina > Configuración).');

  const resumen = resumenPlanilla(items);
  return {
    periodo: { id: periodo.id, anio: periodo.anio, mes: periodo.mes, estado: periodo.estado, fechaInicio: periodo.fechaInicio, fechaFin: periodo.fechaFin },
    // La PILA del mes se paga el mes siguiente.
    aportante: { razonSocial: empresa ? empresa.razonSocial : '', nit: empresa ? empresa.nit : '', arl: config.arlNombre, ccf: config.ccfNombre, operador: config.operadorPila },
    exoneraArt114: config.exoneraArt114,
    ...resumen,
    avisos,
  };
}

function celdaCsv(v) {
  const t = String(v == null ? '' : v);
  return /[",;\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

async function planillaCsv(periodoId, usuario) {
  const p = await planillaAportes(periodoId, usuario);
  const cab = ['Identificación', 'Nombre', 'Días salud', 'Días pensión', 'Días ARL', 'Días CCF', 'IBC', 'IBC ARL', 'IBC CCF', 'Novedades', 'Salud', 'Pensión', 'Fondo de solidaridad', 'ARL', 'Caja de compensación', 'SENA', 'ICBF', 'Total PILA'];
  const filas = p.filas.map((f) => [f.identificacion, f.nombre, f.diasSalud, f.diasPension, f.diasArl, f.diasCcf, f.ibc, f.ibcArl, f.ibcCcf, f.novedades, f.salud, f.pension, f.fsp, f.arl, f.caja, f.sena, f.icbf, f.pila]);
  filas.push(['', 'TOTAL', '', '', '', '', '', '', '', '', ...['salud', 'pension', 'fsp', 'arl', 'caja', 'sena', 'icbf', 'pila'].map((k) => p.filas.reduce((s, f) => s + f[k], 0))]);
  const texto = [cab, ...filas].map((fila) => fila.map(celdaCsv).join(';')).join('\r\n');
  return { nombre: `planilla-aportes-${mesTexto(p.periodo.anio, p.periodo.mes)}.csv`, contenido: '﻿' + texto };
}

module.exports = {
  obtenerConfig, guardarConfig, opciones,
  listarContratos, crearContrato, actualizarContrato,
  listarAusencias, crearAusencia, eliminarAusencia,
  listarConceptos, crearConcepto, eliminarConcepto,
  listarPeriodos, crearPeriodo, preliquidar, detallePeriodo, detalleLiquidacion,
  contabilizarPeriodo, reabrirPeriodo, registrarPago,
  provisionesAcumuladas, planillaAportes, planillaCsv,
};
