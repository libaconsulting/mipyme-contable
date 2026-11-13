// Cargues masivos para Asopagos (operador de información de la PILA).
//
// Arma, con los datos que ya hay en la app, los dos archivos que Asopagos recibe:
//   · cotizantes(): cargue masivo de cotizantes (empleados o contratistas, cotizante 59 de la planilla Y).
//   · novedades(): cargue masivo de novedades del mes (ING, RET y ausencias de los empleados; ING y RET de los contratistas).
// Los formatos viven en public/contable/cargueAsopagos.js (copiados de los documentos de Asopagos).
const { Op } = require('sequelize');
const Tercero = require('../../../core/models/Tercero');
const Empresa = require('../../../core/models/Empresa');
const CentroTrabajo = require('../models/CentroTrabajo');
const ContratoLaboral = require('../models/ContratoLaboral');
const ContratoContratista = require('../models/ContratoContratista');
const AusenciaNomina = require('../models/AusenciaNomina');
const PL = require('../../../../public/contable/parametrosLaborales');
const AC = require('../../../../public/contable/aportesContratistas');
const CA = require('../../../../public/contable/cargueAsopagos');
const nominaService = require('./nomina.service');

const { obtenerConfigFila, mesTexto } = nominaService._interno;
const pesos = (x) => Math.round(Number(x) || 0);

function periodoDe(datos) {
  const anio = Number(datos.anio);
  const mes = Number(datos.mes);
  if (!(anio >= 2020 && anio <= 2100) || !(mes >= 1 && mes <= 12)) throw new Error('Elige el año y el mes del cargue.');
  const ultimo = PL.diasDelMes(anio, mes);
  return { anio, mes, inicio: PL.texto(anio, mes, 1), fin: PL.texto(anio, mes, ultimo), ultimo };
}

async function contexto(empresaId) {
  const [config, centros, empresa] = await Promise.all([
    obtenerConfigFila(empresaId),
    CentroTrabajo.findAll({ where: { empresaId } }),
    Empresa.findByPk(empresaId),
  ]);
  const principal = centros.find((x) => x.principal && x.activo) || centros.find((x) => x.principal) || null;
  const porId = Object.fromEntries(centros.map((x) => [x.id, x]));
  // El centro del contrato; si no tiene, el principal; si no hay centros, el valor heredado de la configuración.
  const centroDe = (id) => {
    const c = (id && porId[id]) || principal;
    return c ? { codigo: c.codigo, actividad: c.actividadEconomica || '' } : { codigo: Number(config.centroTrabajo) || 0, actividad: '' };
  };
  return { config, centros, empresa, centroDe };
}

async function tercerosPorId(empresaId, ids) {
  const lista = ids.length ? await Tercero.findAll({ where: { empresaId, id: { [Op.in]: ids } } }) : [];
  return Object.fromEntries(lista.map((t) => [t.id, t]));
}

// --- Contratos vigentes en el mes ---------------------------------------------------------------------
async function contratosLaborales(empresaId, p) {
  const todos = await ContratoLaboral.findAll({ where: { empresaId } });
  return todos.filter((c) => c.fechaIngreso <= p.fin && (!c.fechaTerminacion || c.fechaTerminacion >= p.inicio));
}

// Un contratista con varios contratos en el mes es un solo cotizante: se suman los valores y rige la clase más alta.
async function contratistasDelMes(empresaId, p) {
  const todos = await ContratoContratista.findAll({ where: { empresaId, activo: true } });
  const vigentes = todos.filter((c) => c.fechaInicio <= p.fin && (!c.fechaFin || c.fechaFin >= p.inicio));
  const grupos = new Map();
  for (const c of vigentes) {
    if (!grupos.has(c.terceroId)) grupos.set(c.terceroId, []);
    grupos.get(c.terceroId).push(c);
  }
  return Array.from(grupos.entries()).map(([terceroId, contratos]) => ({ terceroId, contratos }));
}

// --- Cargue de cotizantes ---------------------------------------------------------------------------------
async function cotizantes(datos, usuario) {
  const empresaId = usuario.empresaId;
  const p = periodoDe(datos);
  const tipo = datos.tipo === 'contratistas' ? 'contratistas' : 'empleados';
  const { config, centroDe } = await contexto(empresaId);
  const P = PL.parametros(p.anio);
  const T = PL.TARIFAS;
  const filas = [];
  const avisos = [];
  const base = { codigoArl: config.arlCodigo, ccfCodigo: config.ccfCodigo, departamento: config.codigoDepartamento, municipio: config.codigoMunicipio };

  if (tipo === 'empleados') {
    const contratos = await contratosLaborales(empresaId, p);
    const emp = await tercerosPorId(empresaId, Array.from(new Set(contratos.map((c) => c.empleadoId))));
    if (!config.ccfCodigo) avisos.push('No hay caja de compensación en Nómina → Configuración: la columna sale como SINCCF y los empleados la necesitan.');
    for (const c of contratos) {
      const e = emp[c.empleadoId] || {};
      const integral = c.tipoSalario === 'integral';
      const salario = pesos(c.salarioBase);
      const exonerado = config.exoneraArt114 !== false && !integral && salario < P.limites.exoneracionSmmlv * P.smmlv;
      const centro = centroDe(c.centroTrabajoId);
      const r = CA.filaCotizante({
        ...base, tipoDocumento: c.tipoDocumento, identificacion: e.identificacion, nombre: e.nombre, tipoCotizante: 1, subtipo: 0,
        tipoSalario: integral ? 'X' : 'F', salarioBasico: salario, centroTrabajo: centro.codigo, exonerado,
        epsCodigo: c.epsCodigo, afpCodigo: c.afpCodigo,
        tarifaPension: T.pensionEmpleado + T.pensionEmpleador, tarifaSalud: T.saludEmpleado + (exonerado ? 0 : T.saludEmpleador),
        tarifaSena: exonerado ? 0 : T.sena, tarifaIcbf: exonerado ? 0 : T.icbf, tarifaCcf: T.cajaCompensacion,
        fechaIngreso: c.fechaIngreso, correo: e.email, actividadEconomica: centro.actividad,
      });
      filas.push(r.fila);
      avisos.push(...r.avisos);
    }
  } else {
    const grupos = await contratistasDelMes(empresaId, p);
    const ter = await tercerosPorId(empresaId, grupos.map((g) => g.terceroId));
    for (const g of grupos) {
      const t = ter[g.terceroId] || {};
      const primero = g.contratos.slice().sort((a, b) => (a.fechaInicio < b.fechaInicio ? -1 : 1))[0];
      const valor = g.contratos.reduce((s, c) => s + Number(c.valorMensual), 0);
      const clase = Math.max(...g.contratos.map((c) => c.claseRiesgo));
      // IBC de un mes completo con las reglas de la planilla Y (40 % del valor, entre 1 y 25 SMMLV).
      const liq = AC.liquidarContratista({
        anio: p.anio, mes: p.mes,
        contratos: g.contratos.map((c) => ({ id: c.id, fechaInicio: p.inicio, fechaFin: null, valorMensual: Number(c.valorMensual), claseRiesgo: c.claseRiesgo })),
      });
      const centro = centroDe(primero.centroTrabajoId);
      const r = CA.filaCotizante({
        ...base, ccfCodigo: '', tipoDocumento: primero.tipoDocumento, identificacion: t.identificacion, nombre: t.nombre, tipoCotizante: 59, subtipo: 0,
        tipoSalario: '', salarioBasico: valor, baseCotizacion: liq ? liq.ibc : 0, centroTrabajo: centro.codigo, exonerado: false,
        epsCodigo: primero.epsCodigo, afpCodigo: primero.afpCodigo, tarifaPension: AC.TARIFA_PENSION, tarifaSalud: AC.TARIFA_SALUD,
        tarifaSena: 0, tarifaIcbf: 0, tarifaCcf: 0, fechaIngreso: primero.fechaInicio, correo: t.email, actividadEconomica: centro.actividad,
      });
      if (g.contratos.length > 1) avisos.push(`${t.nombre}: tiene ${g.contratos.length} contratos en el mes; se carga como un solo cotizante con la suma de los valores y la clase de riesgo ${clase}.`);
      filas.push(r.fila);
      avisos.push(...r.avisos);
    }
  }
  if (!filas.length) avisos.push(tipo === 'empleados' ? 'No hay contratos laborales vigentes en ese mes.' : 'No hay contratistas con acuerdo de pago de aportes vigentes en ese mes.');
  return {
    nombre: `asopagos-cotizantes-${tipo}-${mesTexto(p.anio, p.mes)}.csv`,
    contenido: CA.cotizantesCsv(filas),
    resumen: { tipo, cotizantes: filas.length, avisos: Array.from(new Set(avisos)) },
  };
}

// --- Cargue de novedades -------------------------------------------------------------------------------------
const DIAS_UNICO = (d) => Number(d.slice(8, 10));

async function novedades(datos, usuario) {
  const empresaId = usuario.empresaId;
  const p = periodoDe(datos);
  const { centroDe } = await contexto(empresaId);
  const lineas = [];
  const avisos = [];
  const agregar = (quien, codigo, d) => {
    try {
      lineas.push({ quien, codigo, linea: CA.lineaNovedad(codigo, { anio: p.anio, mes: p.mes, ...d }) });
    } catch (err) {
      avisos.push(`${quien} (${codigo}): ${err.message}`);
    }
  };
  const dentro = (f) => f >= p.inicio && f <= p.fin;

  // Empleados
  const contratos = await contratosLaborales(empresaId, p);
  const emp = await tercerosPorId(empresaId, Array.from(new Set(contratos.map((c) => c.empleadoId))));
  const contratoDe = {};
  for (const c of contratos) contratoDe[c.empleadoId] = c;
  for (const c of contratos) {
    const e = emp[c.empleadoId] || {};
    const id = { tipoDocumento: c.tipoDocumento, identificacion: e.identificacion };
    const quien = e.nombre || e.identificacion || 'Empleado';
    if (dentro(c.fechaIngreso)) {
      const centro = centroDe(c.centroTrabajoId);
      agregar(quien, 'ING', { ...id, dia: DIAS_UNICO(c.fechaIngreso), salario: pesos(c.salarioBase), centroTrabajo: centro.codigo, tipoSalario: c.tipoSalario === 'integral' ? 'X' : 'F', actividadEconomica: centro.actividad });
    }
    if (c.fechaTerminacion && dentro(c.fechaTerminacion)) agregar(quien, 'RET', { ...id, dia: DIAS_UNICO(c.fechaTerminacion), tipoRetiro: 'N' });
  }
  const ausencias = await AusenciaNomina.findAll({ where: { empresaId, empleadoId: { [Op.in]: Object.keys(contratoDe) } }, order: [['fechaInicio', 'ASC']] });
  for (const a of ausencias) {
    const def = PL.AUSENCIAS[a.tipo];
    if (!def || a.fechaFin < p.inicio || a.fechaInicio > p.fin) continue;
    const c = contratoDe[a.empleadoId];
    const e = emp[a.empleadoId] || {};
    const desde = a.fechaInicio > p.inicio ? a.fechaInicio : p.inicio;
    const hasta = a.fechaFin < p.fin ? a.fechaFin : p.fin;
    const dias = PL.dias360(desde, hasta);
    if (dias <= 0) continue;
    const comun = { tipoDocumento: c.tipoDocumento, identificacion: e.identificacion, dia: DIAS_UNICO(desde), fechaFin: hasta, dias };
    const quien = `${e.nombre || e.identificacion || 'Empleado'} · ${def.nombre}`;
    const salario = pesos(c.salarioBase);
    if (def.pila === 'VAC') agregar(quien, 'VAC', { ...comun, salario, tipoNovedad: 'X', pagoAnticipado: 'N' });
    else if (def.pila === 'LMA') agregar(quien, 'LMA', { ...comun, ajustar: 'N' });
    else if (def.pila === 'IRL') agregar(quien, 'IRL', { ...comun, ajustar: 'N' });
    else if (def.pila === 'IGE') {
      agregar(quien, 'IGE', { ...comun, tarifaDosPrimerosDias: 1, tarifaDesdeTercerDia: 0.6666, ajustar: 'N' });
      avisos.push(`${quien}: se usaron las tarifas 1 (dos primeros días) y 0.6666 (desde el tercero). Si la incapacidad ya pasó de 90 días (0.5) o el empleador la paga completa (1), corrígelas antes de cargar.`);
    } else if (def.pila === 'SLN') {
      agregar(quien, 'SLN', { ...comun, comisionServicios: 'N', porcentajeAporte: 'T', salarioAnterior: salario, tarifaSalud: PL.TARIFAS.saludEmpleado + PL.TARIFAS.saludEmpleador, tarifaPension: PL.TARIFAS.pensionEmpleado + PL.TARIFAS.pensionEmpleador });
      avisos.push(`${quien}: SLN con aporte total (T) y tarifas de salud 12.5 % y pensión 16 %; confirma con Asopagos cómo quieres cotizar la suspensión.`);
    }
  }

  // Contratistas (cotizante 59): ingreso y retiro del contrato
  const grupos = await contratistasDelMes(empresaId, p);
  const ter = await tercerosPorId(empresaId, grupos.map((g) => g.terceroId));
  for (const g of grupos) {
    const t = ter[g.terceroId] || {};
    const quien = `${t.nombre || t.identificacion || 'Contratista'} (contratista)`;
    const valor = g.contratos.reduce((s, c) => s + Number(c.valorMensual), 0);
    const primero = g.contratos.slice().sort((a, b) => (a.fechaInicio < b.fechaInicio ? -1 : 1))[0];
    const id = { tipoDocumento: primero.tipoDocumento, identificacion: t.identificacion };
    const centro = centroDe(primero.centroTrabajoId);
    if (g.contratos.every((c) => dentro(c.fechaInicio) || c.fechaInicio > p.fin) && dentro(primero.fechaInicio)) {
      agregar(quien, 'ING', { ...id, dia: DIAS_UNICO(primero.fechaInicio), salario: pesos(valor), centroTrabajo: centro.codigo, tipoSalario: '', actividadEconomica: centro.actividad });
    }
    const terminan = g.contratos.length && g.contratos.every((c) => c.fechaFin && dentro(c.fechaFin));
    if (terminan) {
      const fin = g.contratos.map((c) => c.fechaFin).sort().pop();
      agregar(quien, 'RET', { ...id, dia: DIAS_UNICO(fin), tipoRetiro: 'N' });
      avisos.push(`${quien}: el retiro del contratista se carga como RET tipo N. Si Asopagos pide un tipo distinto para el cotizante 59 (RET-T de la Resolución 467), cámbialo.`);
    }
  }

  if (!lineas.length) avisos.push('No hay ingresos, retiros ni ausencias en ese mes.');
  return {
    nombre: `asopagos-novedades-${mesTexto(p.anio, p.mes)}.txt`,
    contenido: CA.novedadesTxt(lineas.map((l) => l.linea)),
    resumen: { novedades: lineas.length, detalle: lineas, avisos: Array.from(new Set(avisos)) },
  };
}

module.exports = { cotizantes, novedades };
