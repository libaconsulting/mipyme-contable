// Cruce de pagos en Tesorería: cada pago a un proveedor / recaudo de un cliente se aplica a la factura,
// documento soporte o factura de venta que cancela (en todo o en parte), y queda contabilizado:
//
//   Pago a proveedor   Dr 2205 / 2335 (tercero)    Cr banco (auxiliar 1110…) o caja 1105
//   Recaudo de cliente Dr banco o caja             Cr 1305 (tercero)
//
// El saldo de cada documento = lo que se debe (neto de retenciones) − las aplicaciones activas.
// Un "descuento" baja el saldo sin mover plata ni asiento (ej. los aportes que el contratista asume y que ya
// se causaron contra 2335 en la planilla Y).
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Tercero = require('../../../core/models/Tercero');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Asiento = require('../../../core/models/Asiento');
const PeriodoContable = require('../../../core/models/PeriodoContable');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const FacturaCompra = require('../../compras/models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../../compras/models/DocumentoSoporteAdquisicion');
const FacturaVenta = require('../../ventas/models/FacturaVenta');
const AportesContratistas = require('../../nomina/models/AportesContratistas');
const CuentaBancaria = require('../models/CuentaBancaria');
const MovimientoBancario = require('../models/MovimientoBancario');
const PagoTesoreria = require('../models/PagoTesoreria');
const PagoAplicacion = require('../models/PagoAplicacion');
const { contabilizarAsientoCompuesto, cuentasPorCodigo } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const { asegurarCuentaContable, nombreAuxiliar } = require('./contabilidadBancaria');
const auditoria = require('../../../core/services/auditoria');

// Cuenta contable y sentido de cada tipo de documento.
const DOCS = {
  factura_compra: { modelo: FacturaCompra, cuenta: '2205', sentido: 'pagar', etiqueta: 'Factura de compra' },
  documento_soporte: { modelo: DocumentoSoporteAdquisicion, cuenta: '2335', sentido: 'pagar', etiqueta: 'Documento soporte' },
  factura_venta: { modelo: FacturaVenta, cuenta: '1305', sentido: 'cobrar', etiqueta: 'Factura de venta' },
};
const TIPOS_PAGO = ['pago', 'recaudo'];
const MAX_VALOR = 100000000000;

// Retenciones que un cliente nos practica al pagar una factura de venta. Se llevan como activo
// (anticipo de impuestos, 1355) y se descuentan en las declaraciones de renta, IVA e ICA.
const RETENCIONES = [
  { campo: 'retefuente', cuenta: '135515', nombre: 'Retención en la fuente', etiqueta: 'ReteFuente' },
  { campo: 'reteiva', cuenta: '135517', nombre: 'Impuesto a las ventas retenido (ReteIVA)', etiqueta: 'ReteIVA' },
  { campo: 'reteica', cuenta: '135518', nombre: 'Impuesto de industria y comercio retenido (ReteICA)', etiqueta: 'ReteICA' },
];

// --- Utilidades -----------------------------------------------------------------
const aCentavos = (v) => Math.round(Number(v || 0) * 100);
const dePesos = (c) => c / 100;

function fechaValida(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f || ''))) return false;
  const d = new Date(f + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

function hoyColombia() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function texto(valor, max, nombre) {
  const t = String(valor == null ? '' : valor).replace(/\s+/g, ' ').trim();
  if (t.length > max) throw new Error(`${nombre} es muy largo (máximo ${max} caracteres).`);
  if (/[<>]/.test(t)) throw new Error(`${nombre} no puede llevar los símbolos < o >.`);
  return t || null;
}

function monto(valor, nombre) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_VALOR) throw new Error(`${nombre} debe ser un valor mayor a cero.`);
  const c = aCentavos(n);
  if (c <= 0) throw new Error(`${nombre} debe ser un valor mayor a cero.`);
  return c;
}

// Estampillas, tasas y contribuciones que una entidad (normalmente pública) descuenta al pagar, según el estatuto de
// rentas local. A diferencia de las retenciones NO se recuperan en ninguna declaración: son gasto o costo del contrato,
// se reconocen al cobrar y cada una lleva su concepto (texto libre) y la cuenta de gasto/costo donde se registra.
const MAX_OTROS_POR_DOCUMENTO = 10;
const CUENTA_OTROS_DEFECTO = '5195';

async function leerOtrosDescuentos(lista, rotulo, empresaId, transaction) {
  if (lista === undefined || lista === null || lista === '') return [];
  if (!Array.isArray(lista)) throw new Error(`${rotulo}: los otros descuentos no tienen el formato esperado.`);
  if (lista.length > MAX_OTROS_POR_DOCUMENTO) throw new Error(`${rotulo}: máximo ${MAX_OTROS_POR_DOCUMENTO} otros descuentos por factura.`);
  const resultado = [];
  for (const o of lista) {
    const concepto = texto(o && o.concepto, 120, 'El concepto del descuento');
    if (!concepto || concepto.length < 3) throw new Error(`${rotulo}: escribe el concepto de cada descuento (por ejemplo "Estampilla pro-cultura").`);
    const valor = monto(o.valor, `El valor de "${concepto}"`);
    let cuenta;
    if (o.cuentaId) {
      cuenta = await PlanCuentas.findOne({ where: { id: o.cuentaId, empresaId }, transaction });
      if (!cuenta || !cuenta.activa) throw new Error(`${rotulo}: la cuenta elegida para "${concepto}" no existe o está inactiva.`);
      if (!['gasto', 'costo'].includes(cuenta.elementoNiif) || cuenta.naturaleza !== 'debito') {
        throw new Error(`${rotulo}: "${concepto}" se registra en una cuenta de gasto o de costo (${cuenta.codigo} no lo es).`);
      }
    } else {
      cuenta = (await cuentasPorCodigo(empresaId, [CUENTA_OTROS_DEFECTO], transaction))[CUENTA_OTROS_DEFECTO];
    }
    resultado.push({ concepto, cuentaId: cuenta.id, cuentaCodigo: cuenta.codigo, cuentaNombre: cuenta.nombre, centavos: valor });
  }
  return resultado;
}

// Valor opcional (vacío = 0), nunca negativo.
function montoOpcional(valor, nombre) {
  if (valor === undefined || valor === null || valor === '') return 0;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0 || n > MAX_VALOR) throw new Error(`${nombre} no es un valor válido.`);
  return aCentavos(n);
}

function diasEntre(desde, hasta) {
  return Math.round((new Date(hasta + 'T00:00:00Z') - new Date(desde + 'T00:00:00Z')) / 86400000);
}

// Lo que se debe por el documento, en centavos.
function netoDelDocumento(tipo, d) {
  if (tipo === 'factura_compra') {
    return d.netoAPagar != null ? aCentavos(d.netoAPagar) : aCentavos(d.total) - aCentavos(d.retencionValor);
  }
  if (tipo === 'documento_soporte') {
    return d.netoAPagar != null ? aCentavos(d.netoAPagar) : aCentavos(d.valor);
  }
  return aCentavos(d.total);
}

function numeroDelDocumento(tipo, d) {
  const n = d.numero ? String(d.numero) : '';
  return n || `${DOCS[tipo].etiqueta} ${String(d.id).slice(0, 8)}`;
}

// Eventos del motor que usa el cruce (se crean la primera vez, como en nómina).
async function asegurarReglasCruce(empresaId, transaction) {
  const reglas = [
    { evento: 'tesoreria_pago_proveedor', debito: '2205', credito: '1110' },
    { evento: 'tesoreria_recaudo_cliente', debito: '1110', credito: '1305' },
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

// Las subcuentas de 1355 para las retenciones sufridas se crean la primera vez que se usan.
async function asegurarCuentasRetencion(empresaId, transaction) {
  const [padre] = Object.values(await cuentasPorCodigo(empresaId, ['1355'], transaction));
  for (const r of RETENCIONES) {
    const existe = await PlanCuentas.findOne({ where: { empresaId, codigo: r.cuenta }, transaction });
    if (!existe) {
      await PlanCuentas.create({
        id: uuidv4(), empresaId, codigo: r.cuenta, nombre: r.nombre, naturaleza: 'debito', nivel: 2,
        cuentaPadreId: padre.id, elementoNiif: 'activo', origen: 'tesoreria',
      }, { transaction });
    } else if (!existe.activa) {
      await existe.update({ activa: true }, { transaction });
    }
  }
}

async function anularAsiento(asientoId, empresaId, transaction) {
  const a = asientoId ? await Asiento.findOne({ where: { id: asientoId, empresaId }, transaction }) : null;
  if (!a) return;
  const pc = await PeriodoContable.findByPk(a.periodoContableId, { transaction });
  if (pc && !['abierto', 'en_cierre'].includes(pc.estado)) throw new Error('El período contable de este pago ya está cerrado; no se puede anular.');
  await a.update({ estado: 'anulado' }, { transaction });
}

// --- Saldos ---------------------------------------------------------------------
// Suma (en centavos) de las aplicaciones activas, por documento.
async function aplicadoPorDocumento(empresaId, docTipo, transaction) {
  const filas = await PagoAplicacion.findAll({ where: { empresaId, docTipo, estado: 'activa' }, transaction });
  const mapa = {};
  for (const f of filas) mapa[f.docId] = (mapa[f.docId] || 0) + aCentavos(f.valor);
  return mapa;
}

async function documentoDe(empresaId, docTipo, docId, transaction) {
  const def = DOCS[docTipo];
  if (!def) throw new Error('Tipo de documento no válido (factura_compra, documento_soporte o factura_venta).');
  const opciones = { where: { id: docId || null, empresaId }, transaction };
  if (transaction && sequelize.getDialect() === 'postgres') opciones.lock = transaction.LOCK.UPDATE;
  const d = await def.modelo.findOne(opciones);
  if (!d) throw new Error(`No se encontró el documento (${def.etiqueta.toLowerCase()}) en tu empresa.`);
  return d;
}

// ¿Se puede pagar? Debe estar contabilizado (si quedó en borrador no existe todavía la cuenta por pagar).
async function estadoContable(d, transaction) {
  if (!d.asientoId) return 'Aún no está contabilizado.';
  const a = await Asiento.findOne({ where: { id: d.asientoId }, transaction });
  if (!a || a.estado !== 'contabilizado') return 'Su asiento está en borrador o anulado; revísalo en Contabilidad.';
  if (d.estadoConciliacion === 'objetada') return 'La factura está objetada.';
  return null;
}

async function saldoDe(empresaId, docTipo, d, transaction) {
  const aplicado = (await aplicadoPorDocumento(empresaId, docTipo, transaction))[d.id] || 0;
  const neto = netoDelDocumento(docTipo, d);
  return { neto, aplicado, saldo: neto - aplicado };
}

// --- Cartera --------------------------------------------------------------------
// tipo: 'pagar' (facturas de compra + documentos soporte) | 'cobrar' (facturas de venta)
async function cartera(datos, usuario) {
  const empresaId = usuario.empresaId;
  const sentido = datos && datos.tipo === 'cobrar' ? 'cobrar' : 'pagar';
  const todos = datos && (datos.todos === true || datos.todos === 'true' || datos.todos === '1');
  const hoy = hoyColombia();
  const tipos = Object.keys(DOCS).filter((t) => DOCS[t].sentido === sentido);
  const filas = [];
  for (const docTipo of tipos) {
    const docs = await DOCS[docTipo].modelo.findAll({ where: { empresaId }, order: [['fecha', 'ASC']] });
    if (!docs.length) continue;
    const aplicado = await aplicadoPorDocumento(empresaId, docTipo);
    const asientos = await Asiento.findAll({ where: { id: docs.map((d) => d.asientoId).filter(Boolean) } });
    const asientoPorId = Object.fromEntries(asientos.map((a) => [a.id, a]));
    const terceros = await Tercero.findAll({ where: { id: [...new Set(docs.map((d) => d.terceroId))], empresaId } });
    const terceroPorId = Object.fromEntries(terceros.map((t) => [t.id, t]));
    for (const d of docs) {
      const neto = netoDelDocumento(docTipo, d);
      const pagado = aplicado[d.id] || 0;
      const saldo = neto - pagado;
      if (!todos && saldo <= 0) continue;
      const a = d.asientoId ? asientoPorId[d.asientoId] : null;
      let motivoNoPagable = null;
      if (!a) motivoNoPagable = 'Aún no está contabilizado.';
      else if (a.estado !== 'contabilizado') motivoNoPagable = 'Su asiento está en borrador o anulado.';
      else if (d.estadoConciliacion === 'objetada') motivoNoPagable = 'La factura está objetada.';
      const vence = d.fechaVencimiento || d.fecha;
      const diasVencido = saldo > 0 ? diasEntre(vence, hoy) : 0;
      const t = terceroPorId[d.terceroId];
      filas.push({
        docTipo,
        docId: d.id,
        etiqueta: DOCS[docTipo].etiqueta,
        numero: numeroDelDocumento(docTipo, d),
        terceroId: d.terceroId,
        terceroNombre: t ? t.nombre : (d.emisorNombre || d.proveedorNombre || d.receptorNombre || ''),
        terceroIdentificacion: t ? t.identificacion : '',
        fecha: d.fecha,
        fechaVencimiento: vence,
        neto: dePesos(neto),
        pagado: dePesos(pagado),
        saldo: dePesos(saldo),
        diasVencido,
        vencida: saldo > 0 && diasVencido > 0,
        pagable: !motivoNoPagable && saldo > 0,
        motivoNoPagable,
      });
    }
  }
  filas.sort((x, y) => (x.fechaVencimiento < y.fechaVencimiento ? -1 : x.fechaVencimiento > y.fechaVencimiento ? 1 : 0));
  const pend = filas.filter((f) => f.saldo > 0);
  const suma = (lista) => lista.reduce((s, f) => s + aCentavos(f.saldo), 0) / 100;
  const resumen = {
    total: suma(pend),
    vencido: suma(pend.filter((f) => f.vencida)),
    porVencer: suma(pend.filter((f) => !f.vencida)),
    documentos: pend.length,
    edades: {
      alDia: suma(pend.filter((f) => !f.vencida)),
      de1a30: suma(pend.filter((f) => f.diasVencido >= 1 && f.diasVencido <= 30)),
      de31a60: suma(pend.filter((f) => f.diasVencido >= 31 && f.diasVencido <= 60)),
      de61a90: suma(pend.filter((f) => f.diasVencido >= 61 && f.diasVencido <= 90)),
      masDe90: suma(pend.filter((f) => f.diasVencido > 90)),
    },
  };
  return { tipo: sentido, hoy, resumen, documentos: filas };
}

// --- Registrar un pago / recaudo -------------------------------------------------
async function registrarPago(datos, usuario) {
  const empresaId = usuario.empresaId;
  const tipo = datos.tipo;
  if (!TIPOS_PAGO.includes(tipo)) throw new Error('El tipo es "pago" (a un proveedor) o "recaudo" (de un cliente).');
  const sentido = tipo === 'pago' ? 'pagar' : 'cobrar';
  const tercero = await Tercero.findOne({ where: { id: datos.terceroId || null, empresaId } });
  if (!tercero) throw new Error(`Elige ${tipo === 'pago' ? 'el proveedor' : 'el cliente'}.`);
  const aplicaciones = Array.isArray(datos.aplicaciones) ? datos.aplicaciones : [];
  if (!aplicaciones.length) throw new Error('Elige al menos un documento y el valor que se le aplica.');
  if (aplicaciones.length > 100) throw new Error('Demasiados documentos en un solo pago (máximo 100).');
  const repetidos = new Set();
  for (const ap of aplicaciones) {
    if (!DOCS[ap.docTipo]) throw new Error('Tipo de documento no válido.');
    if (DOCS[ap.docTipo].sentido !== sentido) {
      throw new Error(tipo === 'pago' ? 'Un pago solo cubre facturas de compra y documentos soporte.' : 'Un recaudo solo cubre facturas de venta.');
    }
    const clave = `${ap.docTipo}:${ap.docId}`;
    if (repetidos.has(clave)) throw new Error('Un mismo documento aparece dos veces en el pago.');
    repetidos.add(clave);
  }

  const medio = datos.medio === 'caja' ? 'caja' : 'banco';
  let cuenta = null;
  let movimientoExistente = null;
  if (medio === 'banco') {
    cuenta = await CuentaBancaria.findOne({ where: { id: datos.cuentaBancariaId || null, empresaId } });
    if (!cuenta) throw new Error('Elige la cuenta bancaria, o marca efectivo (caja).');
  }
  if (datos.movimientoBancarioId) {
    if (medio !== 'banco') throw new Error('Un movimiento bancario solo se enlaza a un pago por banco.');
    movimientoExistente = await MovimientoBancario.findOne({ where: { id: datos.movimientoBancarioId, empresaId } });
    if (!movimientoExistente) throw new Error('No se encontró el movimiento bancario.');
    if (movimientoExistente.cuentaBancariaId !== cuenta.id) throw new Error('El movimiento es de otra cuenta bancaria.');
    if (movimientoExistente.tipo !== (tipo === 'pago' ? 'egreso' : 'ingreso')) {
      throw new Error(`Un ${tipo} se enlaza con un movimiento de tipo ${tipo === 'pago' ? 'egreso' : 'ingreso'}.`);
    }
    if (movimientoExistente.origenModulo) throw new Error('Ese movimiento ya está ligado a otra operación.');
  }

  let fecha = datos.fecha || (movimientoExistente ? movimientoExistente.fecha : hoyColombia());
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha del pago (AAAA-MM-DD).');
  const referencia = texto(datos.referencia, 60, 'La referencia');
  const observaciones = texto(datos.observaciones, 250, 'Las observaciones');

  await aprovisionarContabilidadBase(empresaId);
  const creado = await sequelize.transaction(async (transaction) => {
    await asegurarReglasCruce(empresaId, transaction);
    // Cada documento se valida y se bloquea dentro de la transacción: el saldo se mira aquí, no antes.
    const aplicado = [];
    let totalCent = 0; // lo que se aplica a los documentos (con retenciones)
    let retTotal = 0;
    let otrosTotal = 0;
    const otrosPorCuenta = {};
    const retPorCuenta = {};
    const porCuenta = {};
    const nombres = [];
    for (const ap of aplicaciones) {
      const d = await documentoDe(empresaId, ap.docTipo, ap.docId, transaction);
      if (d.terceroId !== tercero.id) throw new Error(`El documento ${numeroDelDocumento(ap.docTipo, d)} es de otro tercero.`);
      const nopaga = await estadoContable(d, transaction);
      if (nopaga) throw new Error(`${numeroDelDocumento(ap.docTipo, d)}: ${nopaga}`);
      if (fecha < d.fecha) throw new Error(`El pago (${fecha}) no puede ser anterior al documento ${numeroDelDocumento(ap.docTipo, d)} (${d.fecha}).`);
      const v = monto(ap.valor, `El valor aplicado a ${numeroDelDocumento(ap.docTipo, d)}`);
      const s = await saldoDe(empresaId, ap.docTipo, d, transaction);
      if (v > s.saldo) {
        throw new Error(`${numeroDelDocumento(ap.docTipo, d)}: el valor (${dePesos(v)}) supera el saldo pendiente (${dePesos(s.saldo)}).`);
      }
      const ret = {};
      let retDoc = 0;
      for (const r of RETENCIONES) {
        ret[r.campo] = montoOpcional(ap[r.campo], `${r.etiqueta} de ${numeroDelDocumento(ap.docTipo, d)}`);
        retDoc += ret[r.campo];
      }
      if (retDoc > 0 && tipo !== 'recaudo') {
        throw new Error('Las retenciones se registran al cobrar a un cliente; al proveedor se le practican al causar la factura.');
      }
      const otros = await leerOtrosDescuentos(ap.otros, numeroDelDocumento(ap.docTipo, d), empresaId, transaction);
      if (otros.length && tipo !== 'recaudo') {
        throw new Error('Las estampillas, tasas y contribuciones se descuentan al cobrar a un cliente; en un pago a proveedor no aplican.');
      }
      const otrosDoc = otros.reduce((t, o) => t + o.centavos, 0);
      if (retDoc + otrosDoc >= v) {
        throw new Error(`${numeroDelDocumento(ap.docTipo, d)}: las retenciones y descuentos (${dePesos(retDoc + otrosDoc)}) deben ser menores que el valor cobrado (${dePesos(v)}).`);
      }
      for (const r of RETENCIONES) if (ret[r.campo]) retPorCuenta[r.cuenta] = (retPorCuenta[r.cuenta] || 0) + ret[r.campo];
      for (const o of otros) otrosPorCuenta[o.cuentaCodigo] = (otrosPorCuenta[o.cuentaCodigo] || 0) + o.centavos;
      retTotal += retDoc;
      otrosTotal += otrosDoc;
      aplicado.push({ ap, d, v, ret, otros });
      totalCent += v;
      porCuenta[DOCS[ap.docTipo].cuenta] = (porCuenta[DOCS[ap.docTipo].cuenta] || 0) + v;
      nombres.push(numeroDelDocumento(ap.docTipo, d));
    }
    // Lo que realmente entra o sale de la caja o el banco: lo aplicado menos lo que el cliente retuvo o descontó.
    const efectivoCent = totalCent - retTotal - otrosTotal;
    const textoRet = (retTotal || otrosTotal) ? ` (${dePesos(totalCent)} aplicados menos ${dePesos(retTotal + otrosTotal)} de retenciones y descuentos)` : '';
    if (movimientoExistente && aCentavos(movimientoExistente.valor) !== efectivoCent) {
      throw new Error(`El movimiento del banco es de ${movimientoExistente.valor} y lo que se recibe suma ${dePesos(efectivoCent)}${textoRet}: deben ser iguales.`);
    }
    if (datos.valor !== undefined && datos.valor !== null && datos.valor !== '' && aCentavos(datos.valor) !== efectivoCent) {
      throw new Error(`El valor del pago (${datos.valor}) no coincide con lo que suman los documentos (${dePesos(efectivoCent)})${textoRet}.`);
    }
    if (retTotal) await asegurarCuentasRetencion(empresaId, transaction);

    let codigoBanco = '1105';
    if (cuenta) codigoBanco = (await asegurarCuentaContable(cuenta, transaction)).codigo;
    const lineas = [];
    if (tipo === 'pago') {
      for (const [codigo, v] of Object.entries(porCuenta)) lineas.push({ cuentaCodigo: codigo, debito: dePesos(v), credito: 0, terceroId: tercero.id });
      lineas.push({ cuentaCodigo: codigoBanco, debito: 0, credito: dePesos(totalCent), terceroId: (cuenta && cuenta.terceroId) || tercero.id });
    } else {
      lineas.push({ cuentaCodigo: codigoBanco, debito: dePesos(efectivoCent), credito: 0, terceroId: (cuenta && cuenta.terceroId) || tercero.id });
      for (const [codigo, v] of Object.entries(retPorCuenta)) lineas.push({ cuentaCodigo: codigo, debito: dePesos(v), credito: 0, terceroId: tercero.id });
      for (const [codigo, v] of Object.entries(otrosPorCuenta)) lineas.push({ cuentaCodigo: codigo, debito: dePesos(v), credito: 0, terceroId: tercero.id });
      for (const [codigo, v] of Object.entries(porCuenta)) lineas.push({ cuentaCodigo: codigo, debito: 0, credito: dePesos(v), terceroId: tercero.id });
    }

    const pagoId = uuidv4();
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: tipo === 'pago' ? 'tesoreria_pago_proveedor' : 'tesoreria_recaudo_cliente',
      origenModulo: 'tesoreria', origenId: pagoId, fecha, lineas, usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha del pago está cerrado o no existe.');

    let movimientoId = null;
    let movimientoCreado = false;
    if (cuenta) {
      if (movimientoExistente) {
        movimientoId = movimientoExistente.id;
        await movimientoExistente.update({ conciliado: true, origenModulo: 'tesoreria', origenId: pagoId }, { transaction });
      } else {
        movimientoId = uuidv4();
        movimientoCreado = true;
        const resumenDocs = nombres.length > 3 ? `${nombres.slice(0, 3).join(', ')} y ${nombres.length - 3} más` : nombres.join(', ');
        await MovimientoBancario.create({
          id: movimientoId, empresaId, cuentaBancariaId: cuenta.id, fecha, valor: dePesos(efectivoCent),
          tipo: tipo === 'pago' ? 'egreso' : 'ingreso',
          descripcion: `${tipo === 'pago' ? 'Pago a' : 'Recaudo de'} ${tercero.nombre} · ${resumenDocs}`.slice(0, 255),
          conciliado: false, origenModulo: 'tesoreria', origenId: pagoId,
        }, { transaction });
      }
    }

    const pago = await PagoTesoreria.create({
      id: pagoId, empresaId, tipo, fecha, terceroId: tercero.id, valor: dePesos(efectivoCent), retenciones: dePesos(retTotal), otrosDescuentos: dePesos(otrosTotal), medio,
      cuentaBancariaId: cuenta ? cuenta.id : null, movimientoBancarioId: movimientoId, movimientoCreado,
      asientoId: r.asiento.id, referencia, observaciones, estado: 'activo', usuarioId: usuario.id,
    }, { transaction });
    for (const a of aplicado) {
      await PagoAplicacion.create({
        id: uuidv4(), empresaId, pagoId, docTipo: a.ap.docTipo, docId: a.d.id, valor: dePesos(a.v), estado: 'activa',
        retefuente: dePesos(a.ret.retefuente), reteiva: dePesos(a.ret.reteiva), reteica: dePesos(a.ret.reteica),
        otrosDescuentos: a.otros.map((o) => ({ concepto: o.concepto, cuentaId: o.cuentaId, cuentaCodigo: o.cuentaCodigo, cuentaNombre: o.cuentaNombre, valor: dePesos(o.centavos) })),
      }, { transaction });
    }
    return pago;
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: tipo === 'pago' ? 'tesoreria_pago_registrado' : 'tesoreria_recaudo_registrado',
    entidad: 'PagoTesoreria', entidadId: creado.id, detalle: `${tercero.nombre} · ${creado.valor}`,
  });
  return detallePago(creado.id, usuario);
}

// --- Descuentos de aportes de contratistas ---------------------------------------
// Meses de aportes de contratistas ya causados cuyo descuento (lo que el contratista asume de salud, pensión
// y ARL) se puede aplicar a un documento del contratista.
async function descuentosDisponibles(terceroId, usuario) {
  const empresaId = usuario.empresaId;
  const tercero = await Tercero.findOne({ where: { id: terceroId || null, empresaId } });
  if (!tercero) throw new Error('Elige el contratista.');
  const meses = await AportesContratistas.findAll({
    where: { empresaId, estado: { [Op.in]: ['contabilizada', 'pagada'] } },
    order: [['anio', 'DESC'], ['mes', 'DESC']],
  });
  // Lo ya aplicado de este contratista (una planilla trae varios contratistas: se cuenta solo el suyo).
  const pagosDescuento = await PagoTesoreria.findAll({ where: { empresaId, tipo: 'descuento', terceroId: tercero.id, estado: 'activo' } });
  const ids = pagosDescuento.map((p) => p.id);
  const aplicadas = ids.length ? await PagoAplicacion.findAll({ where: { empresaId, pagoId: ids, fuenteTipo: 'aportes_contratistas', estado: 'activa' } }) : [];
  const resultado = [];
  for (const m of meses) {
    const linea = (m.lineas || []).find((l) => l.terceroId === tercero.id);
    if (!linea) continue;
    const total = aCentavos(linea.descuento);
    if (total <= 0) continue;
    const usado = aplicadas.filter((a) => a.fuenteId === m.id).reduce((x, a) => x + aCentavos(a.valor), 0);
    if (total - usado <= 0) continue;
    resultado.push({
      fuenteTipo: 'aportes_contratistas', fuenteId: m.id, anio: m.anio, mes: m.mes, cuentaPorPagar: linea.cuentaPorPagar || '2335',
      descuento: dePesos(total), usado: dePesos(usado), disponible: dePesos(total - usado), terceroId: tercero.id,
    });
  }
  return resultado;
}

async function aplicarDescuento(datos, usuario) {
  const empresaId = usuario.empresaId;
  const tercero = await Tercero.findOne({ where: { id: datos.terceroId || null, empresaId } });
  if (!tercero) throw new Error('Elige el contratista.');
  if (!DOCS[datos.docTipo] || DOCS[datos.docTipo].sentido !== 'pagar') throw new Error('El descuento se aplica a una factura de compra o a un documento soporte.');
  const fecha = datos.fecha || hoyColombia();
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha (AAAA-MM-DD).');
  const mes = await AportesContratistas.findOne({ where: { id: datos.fuenteId || null, empresaId } });
  if (!mes || !['contabilizada', 'pagada'].includes(mes.estado)) throw new Error('Elige un mes de aportes de contratistas ya contabilizado.');
  const linea = (mes.lineas || []).find((l) => l.terceroId === tercero.id);
  if (!linea || !(aCentavos(linea.descuento) > 0)) throw new Error('Ese mes no tiene descuento de aportes para este contratista.');
  const cuentaLinea = linea.cuentaPorPagar || '2335';
  const observaciones = texto(datos.observaciones, 250, 'Las observaciones');

  const pago = await sequelize.transaction(async (transaction) => {
    const d = await documentoDe(empresaId, datos.docTipo, datos.docId, transaction);
    if (d.terceroId !== tercero.id) throw new Error('El documento es de otro tercero.');
    if (DOCS[datos.docTipo].cuenta !== cuentaLinea) {
      throw new Error(`El descuento de ese mes se causó contra ${cuentaLinea}; aplícalo a ${cuentaLinea === '2205' ? 'una factura de compra' : 'un documento soporte'}.`);
    }
    const nopaga = await estadoContable(d, transaction);
    if (nopaga) throw new Error(`${numeroDelDocumento(datos.docTipo, d)}: ${nopaga}`);
    const s = await saldoDe(empresaId, datos.docTipo, d, transaction);
    const previas = await PagoAplicacion.findAll({
      where: { empresaId, fuenteTipo: 'aportes_contratistas', fuenteId: mes.id, estado: 'activa' }, transaction,
    });
    const pagosPrevios = previas.length ? await PagoTesoreria.findAll({ where: { id: previas.map((a) => a.pagoId), terceroId: tercero.id, empresaId }, transaction }) : [];
    const idsDelTercero = new Set(pagosPrevios.map((p) => p.id));
    const usado = previas.filter((a) => idsDelTercero.has(a.pagoId)).reduce((x, a) => x + aCentavos(a.valor), 0);
    const disponible = aCentavos(linea.descuento) - usado;
    if (disponible <= 0) throw new Error('El descuento de ese mes ya se aplicó completo.');
    const v = datos.valor === undefined || datos.valor === null || datos.valor === '' ? Math.min(disponible, s.saldo) : monto(datos.valor, 'El valor del descuento');
    if (v <= 0) throw new Error('El documento no tiene saldo para descontar.');
    if (v > disponible) throw new Error(`El descuento disponible de ese mes es ${dePesos(disponible)}.`);
    if (v > s.saldo) throw new Error(`El valor supera el saldo del documento (${dePesos(s.saldo)}).`);
    if (fecha < d.fecha) throw new Error('La fecha no puede ser anterior al documento.');
    const creado = await PagoTesoreria.create({
      id: uuidv4(), empresaId, tipo: 'descuento', fecha, terceroId: tercero.id, valor: dePesos(v), medio: null,
      referencia: `Aportes ${String(mes.mes).padStart(2, '0')}/${mes.anio}`, observaciones, estado: 'activo', usuarioId: usuario.id,
    }, { transaction });
    await PagoAplicacion.create({
      id: uuidv4(), empresaId, pagoId: creado.id, docTipo: datos.docTipo, docId: d.id, valor: dePesos(v),
      fuenteTipo: 'aportes_contratistas', fuenteId: mes.id, estado: 'activa',
    }, { transaction });
    return creado;
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'tesoreria_descuento_aplicado', entidad: 'PagoTesoreria', entidadId: pago.id,
    detalle: `${tercero.nombre} · ${pago.valor} · ${pago.referencia}`,
  });
  return detallePago(pago.id, usuario);
}

// --- Consultas ------------------------------------------------------------------
async function detallePago(id, usuario) {
  const empresaId = usuario.empresaId;
  const pago = await PagoTesoreria.findOne({ where: { id, empresaId } });
  if (!pago) throw new Error('Pago no encontrado.');
  return (await enriquecer([pago], empresaId))[0];
}

async function enriquecer(pagos, empresaId) {
  if (!pagos.length) return [];
  const aps = await PagoAplicacion.findAll({ where: { empresaId, pagoId: pagos.map((p) => p.id) } });
  const terceros = await Tercero.findAll({ where: { id: [...new Set(pagos.map((p) => p.terceroId))], empresaId } });
  const terceroPorId = Object.fromEntries(terceros.map((t) => [t.id, t]));
  const cuentasIds = [...new Set(pagos.map((p) => p.cuentaBancariaId).filter(Boolean))];
  const cuentas = cuentasIds.length ? await CuentaBancaria.findAll({ where: { id: cuentasIds, empresaId } }) : [];
  const cuentaPorId = Object.fromEntries(cuentas.map((c) => [c.id, c]));
  const docsPorTipo = {};
  for (const tipo of Object.keys(DOCS)) {
    const ids = [...new Set(aps.filter((a) => a.docTipo === tipo).map((a) => a.docId))];
    docsPorTipo[tipo] = ids.length ? Object.fromEntries((await DOCS[tipo].modelo.findAll({ where: { id: ids, empresaId } })).map((d) => [d.id, d])) : {};
  }
  return pagos.map((p) => {
    const t = terceroPorId[p.terceroId];
    const c = p.cuentaBancariaId ? cuentaPorId[p.cuentaBancariaId] : null;
    return {
      id: p.id, tipo: p.tipo, fecha: p.fecha, valor: Number(p.valor), retenciones: Number(p.retenciones || 0), otrosDescuentos: Number(p.otrosDescuentos || 0), medio: p.medio, estado: p.estado,
      terceroId: p.terceroId, terceroNombre: t ? t.nombre : '', terceroIdentificacion: t ? t.identificacion : '',
      cuentaBancariaId: p.cuentaBancariaId, cuentaTexto: c ? nombreAuxiliar(c) : (p.medio === 'caja' ? 'Efectivo (caja)' : ''),
      movimientoBancarioId: p.movimientoBancarioId, asientoId: p.asientoId,
      referencia: p.referencia, observaciones: p.observaciones, motivoAnulacion: p.motivoAnulacion,
      aplicaciones: aps.filter((a) => a.pagoId === p.id).map((a) => {
        const d = docsPorTipo[a.docTipo][a.docId];
        return {
          id: a.id, docTipo: a.docTipo, docId: a.docId, etiqueta: DOCS[a.docTipo].etiqueta,
          numero: d ? numeroDelDocumento(a.docTipo, d) : '(documento no disponible)', valor: Number(a.valor),
          retefuente: Number(a.retefuente || 0), reteiva: Number(a.reteiva || 0), reteica: Number(a.reteica || 0),
          otrosDescuentos: Array.isArray(a.otrosDescuentos) ? a.otrosDescuentos : [],
          estado: a.estado, fuenteTipo: a.fuenteTipo, fuenteId: a.fuenteId,
        };
      }),
    };
  });
}

async function listarPagos(datos, usuario) {
  const empresaId = usuario.empresaId;
  const where = { empresaId };
  if (datos && TIPOS_PAGO.concat('descuento').includes(datos.tipo)) where.tipo = datos.tipo;
  if (datos && datos.terceroId) where.terceroId = datos.terceroId;
  if (datos && datos.estado && ['activo', 'anulado'].includes(datos.estado)) where.estado = datos.estado;
  const pagos = await PagoTesoreria.findAll({ where, order: [['fecha', 'DESC'], ['createdAt', 'DESC']], limit: 300 });
  return enriquecer(pagos, empresaId);
}

async function pagosDeDocumento(docTipo, docId, usuario) {
  const empresaId = usuario.empresaId;
  const d = await documentoDe(empresaId, docTipo, docId);
  const aps = await PagoAplicacion.findAll({ where: { empresaId, docTipo, docId: d.id } });
  const pagos = aps.length ? await PagoTesoreria.findAll({ where: { id: [...new Set(aps.map((a) => a.pagoId))], empresaId }, order: [['fecha', 'ASC']] }) : [];
  const s = await saldoDe(empresaId, docTipo, d);
  return {
    docTipo, docId: d.id, numero: numeroDelDocumento(docTipo, d), neto: dePesos(s.neto), pagado: dePesos(s.aplicado), saldo: dePesos(s.saldo),
    pagos: await enriquecer(pagos, empresaId),
  };
}

// Retenciones que nos practicaron los clientes en un rango de fechas de pago (para las declaraciones y los
// certificados de retención). Solo cuentan los recaudos activos.
async function retencionesSufridas(datos, usuario) {
  const empresaId = usuario.empresaId;
  const desde = datos && datos.desde ? datos.desde : null;
  const hasta = datos && datos.hasta ? datos.hasta : null;
  if ((desde && !fechaValida(desde)) || (hasta && !fechaValida(hasta))) throw new Error('Las fechas van como AAAA-MM-DD.');
  const donde = { empresaId, tipo: 'recaudo', estado: 'activo' };
  if (desde || hasta) donde.fecha = Object.assign({}, desde ? { [Op.gte]: desde } : {}, hasta ? { [Op.lte]: hasta } : {});
  const pagos = await PagoTesoreria.findAll({ where: donde, order: [['fecha', 'ASC']] });
  const aps = pagos.length ? await PagoAplicacion.findAll({ where: { empresaId, pagoId: pagos.map((p) => p.id), estado: 'activa' } }) : [];
  const terceros = await Tercero.findAll({ where: { id: [...new Set(pagos.map((p) => p.terceroId))], empresaId } });
  const terceroPorId = Object.fromEntries(terceros.map((t) => [t.id, t]));
  const facturas = aps.length ? await FacturaVenta.findAll({ where: { id: [...new Set(aps.map((a) => a.docId))], empresaId } }) : [];
  const facturaPorId = Object.fromEntries(facturas.map((f) => [f.id, f]));
  const pagoPorId = Object.fromEntries(pagos.map((p) => [p.id, p]));
  const filas = [];
  const otros = [];
  const totales = { retefuente: 0, reteiva: 0, reteica: 0, total: 0 };
  let otrosTotal = 0;
  for (const a of aps) {
    const p = pagoPorId[a.pagoId];
    const t = terceroPorId[p.terceroId];
    const numeroFactura = facturaPorId[a.docId] ? numeroDelDocumento('factura_venta', facturaPorId[a.docId]) : '';
    for (const o of (Array.isArray(a.otrosDescuentos) ? a.otrosDescuentos : [])) {
      otros.push({
        fecha: p.fecha, terceroNombre: t ? t.nombre : '', terceroIdentificacion: t ? t.identificacion : '', factura: numeroFactura,
        concepto: o.concepto, cuentaCodigo: o.cuentaCodigo, cuentaNombre: o.cuentaNombre, valor: Number(o.valor),
      });
      otrosTotal += aCentavos(o.valor);
    }
    const rf = aCentavos(a.retefuente); const ri = aCentavos(a.reteiva); const rc = aCentavos(a.reteica);
    if (!rf && !ri && !rc) continue;
    filas.push({
      fecha: p.fecha, terceroNombre: t ? t.nombre : '', terceroIdentificacion: t ? t.identificacion : '',
      factura: facturaPorId[a.docId] ? numeroDelDocumento('factura_venta', facturaPorId[a.docId]) : '', referencia: p.referencia || '',
      baseCobrada: Number(a.valor), retefuente: dePesos(rf), reteiva: dePesos(ri), reteica: dePesos(rc), total: dePesos(rf + ri + rc),
    });
    totales.retefuente += rf; totales.reteiva += ri; totales.reteica += rc; totales.total += rf + ri + rc;
  }
  const porFecha = (x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0);
  filas.sort(porFecha);
  otros.sort(porFecha);
  for (const k of Object.keys(totales)) totales[k] = dePesos(totales[k]);
  // `otros`: estampillas, tasas y contribuciones descontadas (no son anticipo de impuestos: son gasto o costo).
  return { desde, hasta, filas, totales, otros: { filas: otros, total: dePesos(otrosTotal) } };
}

// Movimientos del banco sin ligar a ninguna operación, que se pueden cruzar con un documento.
async function movimientosLibres(usuario) {
  const movs = await MovimientoBancario.findAll({
    where: { empresaId: usuario.empresaId, tipo: { [Op.in]: ['ingreso', 'egreso'] }, origenModulo: null },
    order: [['fecha', 'DESC']],
    limit: 200,
  });
  return movs;
}

// --- Anular ---------------------------------------------------------------------
async function anularPago(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const pago = await PagoTesoreria.findOne({ where: { id, empresaId } });
  if (!pago) throw new Error('Pago no encontrado.');
  if (pago.estado === 'anulado') throw new Error('Este pago ya está anulado.');
  const motivo = texto(datos && datos.motivo, 250, 'El motivo');
  if (!motivo || motivo.length < 10) throw new Error('Escribe el motivo de la anulación (mínimo 10 letras).');
  const mov = pago.movimientoBancarioId ? await MovimientoBancario.findOne({ where: { id: pago.movimientoBancarioId, empresaId } }) : null;
  if (mov && pago.movimientoCreado && mov.conciliado) {
    throw new Error('El movimiento de este pago ya está conciliado con el extracto; quita la conciliación antes de anular.');
  }
  await sequelize.transaction(async (transaction) => {
    await anularAsiento(pago.asientoId, empresaId, transaction);
    if (mov) {
      if (pago.movimientoCreado) await mov.destroy({ transaction });
      else await mov.update({ conciliado: false, origenModulo: null, origenId: null }, { transaction });
    }
    await PagoAplicacion.update({ estado: 'anulada' }, { where: { pagoId: pago.id, empresaId }, transaction });
    await pago.update({
      estado: 'anulado', motivoAnulacion: motivo, fechaAnulacion: new Date(), asientoId: pago.asientoId,
      movimientoBancarioId: pago.movimientoCreado ? null : pago.movimientoBancarioId,
    }, { transaction });
  });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'tesoreria_pago_anulado', entidad: 'PagoTesoreria', entidadId: pago.id, detalle: motivo });
  return detallePago(pago.id, usuario);
}

module.exports = {
  cartera, registrarPago, retencionesSufridas, aplicarDescuento, descuentosDisponibles, listarPagos, detallePago, pagosDeDocumento,
  movimientosLibres, anularPago, netoDelDocumento, DOCS,
};
