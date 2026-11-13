#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable. Requiere haber aplicado antes aplicar-tesoreria-cruce-pagos.sh.
# TESORERÍA · RETENCIONES, ESTAMPILLAS, TASAS Y CONTRIBUCIONES QUE DESCUENTAN LOS CLIENTES.
#  - Al registrar un recaudo, cada factura admite ReteFuente, ReteIVA y ReteICA: el banco o la caja reciben el valor menos lo
#    retenido y la factura queda saldada por el valor completo.
#  - Asiento: Db banco/caja + Db 135515 / 135517 / 135518 (anticipo de impuestos, con el cliente) / Cr 1305.
#  - Estampillas, tasas y contribuciones que descuenta una entidad pública: se anotan por factura con concepto libre y cuenta de
#    gasto/costo (no son anticipo de impuestos; por defecto 5195).
#  - Nueva pestaña Tesorería > Retenciones sufridas: reporte por fechas con totales y descarga CSV (retenciones y estampillas aparte).
set -e
if [ ! -f "package.json" ]; then echo "ERROR: ve a la carpeta mipyme-contable primero."; exit 1; fi
if [ ! -f "src/modules/tesoreria/services/cruces.service.js" ]; then echo "ERROR: primero aplica aplicar-tesoreria-cruce-pagos.sh (este script va después)."; exit 1; fi
if [ ! -f "public/contable/usuarios.js" ]; then echo "ERROR: primero aplica aplicar-seguridad.sh (este script va después)."; exit 1; fi

mkdir -p public/contable src/modules/tesoreria/controllers src/modules/tesoreria/models src/modules/tesoreria/routes src/modules/tesoreria/services

cat > src/modules/tesoreria/services/cruces.service.js << 'SCRIPTEOF'
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
SCRIPTEOF
echo "OK  src/modules/tesoreria/services/cruces.service.js"

cat > src/modules/tesoreria/models/PagoTesoreria.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un pago a proveedores, un recaudo de clientes o un descuento que cruza documentos por pagar / por cobrar.
//  - pago:      sale plata (banco o caja) y baja facturas de compra / documentos soporte (2205 / 2335).
//  - recaudo:   entra plata (banco o caja) y baja facturas de venta (1305).
//  - descuento: baja el saldo de un documento sin mover plata (ej. aportes de seguridad social que el
//               contratista asume: ya se causaron contra 2335 en la planilla Y, aquí solo se aplican).
// Lo que cada pago cubre está en PagoAplicacion.
const PagoTesoreria = sequelize.define('PagoTesoreria', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  tipo: { type: DataTypes.STRING(10), allowNull: false }, // pago | recaudo | descuento
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false },
  // Lo que realmente entró o salió de caja o banco. En un recaudo con retenciones es lo aplicado a las facturas menos lo retenido.
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  retenciones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 }, // total retenido por el cliente (solo recaudos)
  otrosDescuentos: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 }, // estampillas, tasas y contribuciones descontadas (solo recaudos)
  medio: { type: DataTypes.STRING(10) }, // banco | caja (nulo en descuentos)
  cuentaBancariaId: { type: DataTypes.UUID },
  movimientoBancarioId: { type: DataTypes.UUID },
  // true si el movimiento lo creó este pago (se borra al anular); false si ya existía en el extracto y se enlazó.
  movimientoCreado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  asientoId: { type: DataTypes.UUID },
  referencia: { type: DataTypes.STRING(60) }, // número de transferencia, cheque, consignación...
  observaciones: { type: DataTypes.STRING(250) },
  estado: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'activo' }, // activo | anulado
  motivoAnulacion: { type: DataTypes.STRING(250) },
  fechaAnulacion: { type: DataTypes.DATE },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'tesoreria_pagos',
  indexes: [{ fields: ['empresa_id', 'tercero_id'] }, { fields: ['empresa_id', 'fecha'] }],
});

module.exports = PagoTesoreria;
SCRIPTEOF
echo "OK  src/modules/tesoreria/models/PagoTesoreria.js"

cat > src/modules/tesoreria/models/PagoAplicacion.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Qué documento paga (o descuenta) un PagoTesoreria, y por cuánto. Un pago puede cubrir varios documentos
// y un documento puede recibir varios pagos (abonos). El saldo de un documento es su neto menos la suma de
// las aplicaciones en estado "activa".
const PagoAplicacion = sequelize.define('PagoAplicacion', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  pagoId: { type: DataTypes.UUID, allowNull: false },
  docTipo: { type: DataTypes.STRING(20), allowNull: false }, // factura_compra | documento_soporte | factura_venta
  docId: { type: DataTypes.UUID, allowNull: false },
  // Lo que baja el saldo del documento (en un recaudo incluye lo que el cliente retuvo).
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  // Retenciones que el cliente practicó sobre este cobro (solo recaudos): van a 135515 / 135517 / 135518.
  retefuente: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  reteiva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  reteica: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Estampillas, tasas y contribuciones que la entidad descontó: [{ concepto, cuentaId, cuentaCodigo, cuentaNombre, valor }]. Son gasto o costo.
  otrosDescuentos: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
  // Solo en descuentos: de dónde sale (ej. fuenteTipo 'aportes_contratistas', fuenteId = id del mes).
  fuenteTipo: { type: DataTypes.STRING(30) },
  fuenteId: { type: DataTypes.UUID },
  estado: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'activa' }, // activa | anulada
}, {
  tableName: 'tesoreria_pago_aplicaciones',
  indexes: [{ fields: ['empresa_id', 'doc_tipo', 'doc_id'] }, { fields: ['pago_id'] }],
});

module.exports = PagoAplicacion;
SCRIPTEOF
echo "OK  src/modules/tesoreria/models/PagoAplicacion.js"

cat > src/modules/tesoreria/controllers/tesoreria.controller.js << 'SCRIPTEOF'
const tesoreriaService = require('../services/tesoreria.service');
const cruces = require('../services/cruces.service');

async function crearCuenta(req, res) {
  try {
    res.status(201).json(await tesoreriaService.crearCuenta(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarCuentas(req, res) {
  try {
    res.json(await tesoreriaService.listarCuentas(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function registrarMovimiento(req, res) {
  try {
    res.status(201).json(await tesoreriaService.registrarMovimiento(req.body, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarMovimientos(req, res) {
  try {
    res.json(await tesoreriaService.listarMovimientos(req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function conciliarMovimiento(req, res) {
  try {
    res.json(await tesoreriaService.conciliarMovimiento(req.params.id, req.usuario));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

// Cruce de pagos: cada handler recibe el servicio ya resuelto y responde 400 con el mensaje del error.
function manejar(fn, estado) {
  return async (req, res) => {
    try {
      res.status(estado || 200).json(await fn(req));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  };
}

const cartera = manejar((req) => cruces.cartera(req.query, req.usuario));
const listarPagos = manejar((req) => cruces.listarPagos(req.query, req.usuario));
const detallePago = manejar((req) => cruces.detallePago(req.params.id, req.usuario));
const registrarPago = manejar((req) => cruces.registrarPago(req.body || {}, req.usuario), 201);
const anularPago = manejar((req) => cruces.anularPago(req.params.id, req.body || {}, req.usuario));
const pagosDeDocumento = manejar((req) => cruces.pagosDeDocumento(req.params.docTipo, req.params.docId, req.usuario));
const movimientosLibres = manejar((req) => cruces.movimientosLibres(req.usuario));
const descuentosDisponibles = manejar((req) => cruces.descuentosDisponibles(req.query.terceroId, req.usuario));
const retencionesSufridas = manejar((req) => cruces.retencionesSufridas(req.query, req.usuario));
const aplicarDescuento = manejar((req) => cruces.aplicarDescuento(req.body || {}, req.usuario), 201);

module.exports = {
  crearCuenta, listarCuentas, registrarMovimiento, listarMovimientos, conciliarMovimiento,
  cartera, listarPagos, detallePago, registrarPago, anularPago, pagosDeDocumento, movimientosLibres, descuentosDisponibles, aplicarDescuento, retencionesSufridas,
};
SCRIPTEOF
echo "OK  src/modules/tesoreria/controllers/tesoreria.controller.js"

cat > src/modules/tesoreria/routes/tesoreria.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const c = require('../controllers/tesoreria.controller');

// Pagar, recaudar y descontar: contador, dueño o auxiliar; anular: solo contador o dueño.
const puedeRegistrar = authorize('contador', 'dueño', 'auxiliar');
const puedeAnular = authorize('contador', 'dueño');

router.get('/cuentas', c.listarCuentas);
router.post('/cuentas', c.crearCuenta);
router.get('/movimientos', c.listarMovimientos);
router.post('/movimientos', c.registrarMovimiento);
router.post('/movimientos/:id/conciliar', c.conciliarMovimiento);

// Cruce de pagos con facturas, documentos soporte y nómina
router.get('/cartera', c.cartera); // ?tipo=pagar|cobrar&todos=1
router.get('/movimientos-libres', c.movimientosLibres);
router.get('/pagos', c.listarPagos);
router.get('/pagos/:id', c.detallePago);
router.post('/pagos', puedeRegistrar, c.registrarPago);
router.post('/pagos/:id/anular', puedeAnular, c.anularPago);
router.get('/documentos/:docTipo/:docId/pagos', c.pagosDeDocumento);
router.get('/retenciones-sufridas', c.retencionesSufridas); // ?desde=&hasta=
router.get('/descuentos-aportes', c.descuentosDisponibles); // ?terceroId=
router.post('/descuentos', puedeRegistrar, c.aplicarDescuento);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/tesoreria/routes/tesoreria.routes.js"

cat > public/contable/tesoreriaCruce.js << 'SCRIPTEOF'
// Tesorería · Cruce de pagos.
//
// Va en su propio archivo y se carga DESPUÉS de app.js: usa sus ayudas globales (api, usuario,
// escHtml, formatoDineroDec, formatoFecha, cargarTodo).
//
// Qué hace: muestra la cartera por pagar (facturas de compra y documentos soporte) y por cobrar
// (facturas de venta) con su saldo y vencimiento, y permite registrar el pago o el recaudo contra cada
// documento (completo o por abonos, uno o varios a la vez). Cada pago se contabiliza (Dr 2205/2335 –
// Cr banco; Dr banco – Cr 1305), crea o enlaza el movimiento bancario y queda cruzado con el documento.
// También aplica el descuento de aportes de un contratista y deja anular un pago con su motivo.
// Al cobrar una factura de venta se anotan las retenciones que el cliente practicó (ReteFuente, ReteIVA,
// ReteICA): el banco recibe el valor menos lo retenido, y la pestaña «Retenciones sufridas» las resume por
// cliente para las declaraciones. Las estampillas, tasas y contribuciones que descuenta una entidad pública (según el
// estatuto de rentas local) se anotan aparte en cada factura: no son anticipo de impuestos sino gasto o costo, y van a
// la cuenta que elijas (por defecto 5195).
(function () {
  if (!document.getElementById('panel-tesoreria')) return;
  const SUBS = [['pagar', 'Por pagar'], ['cobrar', 'Por cobrar'], ['historial', 'Pagos y recaudos'], ['retenciones', 'Retenciones sufridas']];
  const RETENCIONES = [['retefuente', 'ReteFuente'], ['reteiva', 'ReteIVA'], ['reteica', 'ReteICA']];
  const TIPO_PAGO = { pago: 'Pago', recaudo: 'Recaudo', descuento: 'Descuento' };
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  const T = { sub: 'pagar', cartera: {}, buscar: '', todos: false, pagos: [], filtro: { tipo: '', estado: '' }, cuentas: null, ret: { desde: '', hasta: '', datos: null } };

  const $ = (id) => document.getElementById(id);
  const esc = (x) => escHtml(x);
  const dinero = (x) => formatoDineroDec(x);
  const puedeRegistrar = () => !!usuario && ['contador', 'dueño', 'auxiliar'].includes(usuario.rol);
  const puedeAnular = () => !!usuario && ['contador', 'dueño'].includes(usuario.rol);
  const aviso = (tipo, texto) => `<p class="fx-aviso ${tipo}">${texto}</p>`;
  const mostrarError = (err) => alert(err && err.message ? err.message : String(err));
  const redondear = (n) => Math.round(Number(n || 0) * 100) / 100;
  const campo = (etiqueta, html, clase) => `<label class="campo-etiquetado ${clase || ''}"><span>${etiqueta}</span>${html}</label>`;
  const opcionesSelect = (pares, elegido) => pares.map(([val, txt]) => `<option value="${esc(val)}"${String(val) === String(elegido) ? ' selected' : ''}>${esc(txt)}</option>`).join('');
  const v = (id) => ($(id) ? $(id).value : '');
  const num = (valor) => {
    const n = Number(String(valor == null ? '' : valor).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  function boton(texto, nombre, datos, clase) {
    const attrs = Object.entries(datos || {}).map(([k, val]) => `data-${k}="${esc(val)}"`).join(' ');
    return `<button type="button" class="${clase || 'btn-accion'}" data-tes="${nombre}" ${attrs}>${texto}</button>`;
  }
  const contenido = () => $('tes-contenido');
  const fecha = (f) => (f ? formatoFecha(f) : '—');

  // --- Diálogo genérico ----------------------------------------------------------
  let dialogoActual = null;
  function abrirDialogo({ titulo, cuerpo, guardar, ancho }) {
    const dlg = $('dialogo-tes');
    $('titulo-tes').textContent = titulo;
    $('tes-dialogo-cuerpo').innerHTML = cuerpo;
    $('tes-dialogo-error').hidden = true;
    $('tes-dialogo-cuerpo').onchange = null;
    $('tes-dialogo-cuerpo').oninput = null;
    $('tes-dialogo-cuerpo').onclick = null;
    dlg.classList.toggle('dialogo-chico', !ancho);
    const btn = $('btn-tes-guardar');
    btn.hidden = !guardar;
    btn.disabled = false;
    btn.textContent = guardar ? guardar.texto : 'Guardar';
    dialogoActual = { guardar };
    if (!dlg.open) dlg.showModal();
  }
  function cerrarDialogo() {
    const dlg = $('dialogo-tes');
    if (dlg.open) dlg.close();
    dialogoActual = null;
  }
  function errorDialogo(mensaje) {
    const el = $('tes-dialogo-error');
    el.textContent = mensaje;
    el.hidden = !mensaje;
  }
  $('btn-cerrar-tes').addEventListener('click', cerrarDialogo);
  $('btn-tes-cancelar').addEventListener('click', cerrarDialogo);
  $('btn-tes-guardar').addEventListener('click', async () => {
    if (!dialogoActual || !dialogoActual.guardar) return;
    const btn = $('btn-tes-guardar');
    btn.disabled = true;
    errorDialogo('');
    try {
      const cerrar = await dialogoActual.guardar.fn();
      if (cerrar !== false) cerrarDialogo();
    } catch (err) {
      errorDialogo(err.message || String(err));
    } finally {
      btn.disabled = false;
    }
  });

  // --- Carga ----------------------------------------------------------------------
  async function cargarCartera(tipo) {
    T.cartera[tipo] = await api(`/tesoreria/cartera?tipo=${tipo}${T.todos ? '&todos=1' : ''}`);
    return T.cartera[tipo];
  }

  async function mostrarSub(sub) {
    T.sub = sub;
    document.querySelectorAll('#tes-subtabs button').forEach((b) => b.classList.toggle('activo', b.dataset.sub === sub));
    try {
      if (sub === 'historial') {
        const q = ['tipo', 'estado'].filter((k) => T.filtro[k]).map((k) => `${k}=${encodeURIComponent(T.filtro[k])}`).join('&');
        T.pagos = await api('/tesoreria/pagos' + (q ? '?' + q : ''));
        return renderHistorial();
      }
      if (sub === 'retenciones') return await cargarRetenciones();
      await cargarCartera(sub);
      renderCartera(sub);
    } catch (err) {
      contenido().innerHTML = aviso('bloqueo', esc(err.message || err));
    }
  }

  // ===================================================================================
  // CARTERA
  // ===================================================================================
  function renderCartera(sub) {
    const c = T.cartera[sub];
    const r = c.resumen;
    const porPagar = sub === 'pagar';
    let html = `<div class="inv-tarjetas">
      <div class="inv-tarjeta destacada"><span>${porPagar ? 'Total por pagar' : 'Total por cobrar'}</span><strong>${dinero(r.total)}</strong></div>
      <div class="inv-tarjeta${r.vencido ? ' alerta' : ''}"><span>Vencido</span><strong>${dinero(r.vencido)}</strong></div>
      <div class="inv-tarjeta"><span>Al día</span><strong>${dinero(r.porVencer)}</strong></div>
      <div class="inv-tarjeta"><span>Documentos con saldo</span><strong>${r.documentos}</strong></div></div>`;
    html += `<p class="nota-panel">Vencido por edad: 1–30 días <strong>${dinero(r.edades.de1a30)}</strong> · 31–60 días <strong>${dinero(r.edades.de31a60)}</strong> · 61–90 días <strong>${dinero(r.edades.de61a90)}</strong> · más de 90 días <strong>${dinero(r.edades.masDe90)}</strong>.</p>`;
    html += `<div class="inv-barra">
      <input type="search" id="tes-buscar" placeholder="Buscar por tercero o número" value="${esc(T.buscar)}">
      <label class="fx-check"><input type="checkbox" id="tes-todos"${T.todos ? ' checked' : ''}> Incluir los ya pagados</label>
      ${puedeRegistrar() ? boton(porPagar ? '+ Registrar pago' : '+ Registrar recaudo', 'nuevo-pago', {}, 'btn-primario') : ''}
    </div>`;
    html += '<div id="tes-tabla-cartera"></div>';
    contenido().innerHTML = html;
    renderTablaCartera(sub);
  }

  function renderTablaCartera(sub) {
    const c = T.cartera[sub];
    const q = T.buscar.trim().toLowerCase();
    const filas = c.documentos.filter((d) => !q || `${d.terceroNombre} ${d.terceroIdentificacion} ${d.numero}`.toLowerCase().includes(q));
    const porPagar = sub === 'pagar';
    if (!filas.length) {
      $('tes-tabla-cartera').innerHTML = `<p class="vacio">${c.documentos.length ? 'Ningún documento coincide con la búsqueda.' : (porPagar ? 'No hay facturas ni documentos soporte con saldo por pagar.' : 'No hay facturas de venta con saldo por cobrar.')}</p>`;
      return;
    }
    $('tes-tabla-cartera').innerHTML = `<div class="tabla-envoltorio"><table><thead><tr><th>Documento</th><th>${porPagar ? 'Proveedor' : 'Cliente'}</th><th>Fecha</th><th>Vence</th><th class="num">Valor</th><th class="num">${porPagar ? 'Pagado' : 'Cobrado'}</th><th class="num">Saldo</th><th></th></tr></thead><tbody>
      ${filas.map((d) => {
        const vence = d.saldo > 0 && d.vencida ? `${esc(fecha(d.fechaVencimiento))}<br><span class="badge rechazado">vencida ${d.diasVencido} d</span>` : esc(fecha(d.fechaVencimiento));
        const acc = [];
        if (puedeRegistrar() && d.pagable) {
          acc.push(boton(porPagar ? 'Pagar' : 'Cobrar', 'pagar-doc', { tipo: d.docTipo, id: d.docId }));
          if (porPagar) acc.push(boton('Descuento de aportes', 'descuento-doc', { tipo: d.docTipo, id: d.docId }));
        } else if (d.saldo > 0 && d.motivoNoPagable) {
          acc.push(`<span class="texto-suave">${esc(d.motivoNoPagable)}</span>`);
        }
        if (d.pagado > 0) acc.push(boton('Ver pagos', 'ver-pagos-doc', { tipo: d.docTipo, id: d.docId }));
        return `<tr><td><strong>${esc(d.numero)}</strong><br><span class="texto-suave">${esc(d.etiqueta)}</span></td>
          <td>${esc(d.terceroNombre)}<br><span class="texto-suave">${esc(d.terceroIdentificacion)}</span></td>
          <td>${esc(fecha(d.fecha))}</td><td>${vence}</td><td class="num">${dinero(d.neto)}</td><td class="num">${dinero(d.pagado)}</td>
          <td class="num"><strong>${dinero(d.saldo)}</strong></td><td class="acciones">${acc.join(' ')}</td></tr>`;
      }).join('')}
    </tbody></table></div>`;
  }

  // ===================================================================================
  // HISTORIAL
  // ===================================================================================
  // " · ReteFuente $70.000 · ReteICA $7.000" de una aplicación (vacío si no hay retenciones).
  function textoRetenciones(a) {
    const otros = (a.otrosDescuentos || []).map((o) => ` · ${o.concepto} ${dinero(o.valor)}`).join('');
    return RETENCIONES.filter(([k]) => a[k] > 0).map(([k, t]) => ` · ${t} ${dinero(a[k])}`).join('') + otros;
  }

  function textoMedio(p) {
    if (p.tipo === 'descuento') return 'Sin movimiento de dinero';
    return p.medio === 'caja' ? 'Efectivo (caja)' : esc(p.cuentaTexto || 'Banco');
  }

  function renderHistorial() {
    let html = `<div class="inv-barra">
      <select id="tes-f-tipo" aria-label="Tipo">${opcionesSelect([['', 'Todos los tipos'], ['pago', 'Pagos'], ['recaudo', 'Recaudos'], ['descuento', 'Descuentos']], T.filtro.tipo)}</select>
      <select id="tes-f-estado" aria-label="Estado">${opcionesSelect([['', 'Activos y anulados'], ['activo', 'Solo activos'], ['anulado', 'Solo anulados']], T.filtro.estado)}</select>
    </div>`;
    if (!T.pagos.length) {
      html += '<p class="vacio">Todavía no hay pagos ni recaudos cruzados con documentos.</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Tercero</th><th>Documentos</th><th>Medio</th><th>Referencia</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>
      ${T.pagos.map((p) => `<tr><td>${esc(fecha(p.fecha))}</td><td>${TIPO_PAGO[p.tipo] || esc(p.tipo)}</td><td>${esc(p.terceroNombre)}</td>
        <td>${p.aplicaciones.map((a) => `${esc(a.numero)} <span class="texto-suave">${dinero(a.valor)}${textoRetenciones(a)}</span>`).join('<br>')}</td>
        <td>${textoMedio(p)}</td><td>${esc(p.referencia || '—')}</td><td class="num">${dinero(p.valor)}${p.retenciones > 0 ? `<br><span class="texto-suave">+ ${dinero(p.retenciones)} retenido</span>` : ''}${p.otrosDescuentos > 0 ? `<br><span class="texto-suave">+ ${dinero(p.otrosDescuentos)} en estampillas y tasas</span>` : ''}</td>
        <td>${p.estado === 'anulado' ? `<span class="badge rechazado">anulado</span><br><span class="texto-suave">${esc(p.motivoAnulacion || '')}</span>` : '<span class="badge conciliado">activo</span>'}</td>
        <td class="acciones">${p.estado === 'activo' && puedeAnular() ? boton('Anular', 'anular-pago', { id: p.id }, 'btn-accion destructivo') : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    }
    contenido().innerHTML = html;
  }

  // ===================================================================================
  // REGISTRAR PAGO / RECAUDO
  // ===================================================================================
  // opciones: { sub, terceroId, docId, movimiento }
  async function dialogoPago(opciones) {
    const sub = opciones.sub;
    const porPagar = sub === 'pagar';
    const tipoMov = porPagar ? 'egreso' : 'ingreso';
    const [cartera, libres, cuentas, plan] = await Promise.all([
      cargarCartera(sub), api('/tesoreria/movimientos-libres'), api('/tesoreria/cuentas'), porPagar ? Promise.resolve([]) : api('/plan-cuentas'),
    ]);
    T.cuentas = cuentas;
    // Cuentas donde pueden registrarse estampillas, tasas y contribuciones: gasto o costo, activas y que no sean "padre" de otras.
    const padres = new Set(plan.map((c) => c.cuentaPadreId).filter(Boolean));
    const cuentasOtros = plan.filter((c) => c.activa && c.naturaleza === 'debito' && ['gasto', 'costo'].includes(c.elementoNiif) && !padres.has(c.id));
    const cuenta5195 = plan.find((c) => c.codigo === '5195');
    const opcionesOtros = `<option value="">${cuenta5195 ? esc(`${cuenta5195.codigo} · ${cuenta5195.nombre}`) : '5195 · Diversos (administración)'}</option>`
      + cuentasOtros.filter((c) => c.codigo !== '5195').map((c) => `<option value="${esc(c.id)}">${esc(c.codigo)} · ${esc(c.nombre)}</option>`).join('');
    const pagables = cartera.documentos.filter((d) => d.pagable);
    const mov = opciones.movimiento ? libres.find((m) => m.id === opciones.movimiento) : null;
    if (opciones.movimiento && !mov) throw new Error('Ese movimiento ya no está disponible para cruzar.');
    if (!pagables.length) throw new Error(porPagar ? 'No hay facturas ni documentos soporte con saldo para pagar.' : 'No hay facturas de venta con saldo para cobrar.');
    const terceros = [];
    for (const d of pagables) if (!terceros.some((t) => t[0] === d.terceroId)) terceros.push([d.terceroId, `${d.terceroNombre}${d.terceroIdentificacion ? ' · ' + d.terceroIdentificacion : ''}`]);
    terceros.sort((a, b) => a[1].localeCompare(b[1], 'es'));
    let terceroId = opciones.terceroId || (opciones.docId ? (pagables.find((d) => d.docId === opciones.docId) || {}).terceroId : '') || '';
    const cuentaInicial = mov ? mov.cuentaBancariaId : (cuentas[0] ? cuentas[0].id : '');
    const medioInicial = mov || cuentas.length ? 'banco' : 'caja';

    const cuerpo = `
      ${campo(porPagar ? 'Proveedor' : 'Cliente', `<select id="tp-tercero"><option value="">Elige…</option>${opcionesSelect(terceros, terceroId)}</select>`)}
      <div class="fila-campos">
        ${campo('Fecha', `<input type="date" id="tp-fecha" value="${esc(mov ? mov.fecha : cartera.hoy)}" max="2099-12-31">`)}
        ${campo(porPagar ? 'Sale de' : 'Entra a', `<select id="tp-medio">${opcionesSelect([['banco', 'Cuenta bancaria'], ['caja', 'Efectivo (caja)']], medioInicial)}</select>`)}
        ${campo('Cuenta bancaria', `<select id="tp-cuenta">${opcionesSelect(cuentas.map((c) => [c.id, `${c.banco} · ${c.numero}`]), cuentaInicial)}</select>`, 'tp-banco')}
      </div>
      ${campo('Movimiento del banco', '<select id="tp-movimiento"></select>', 'tp-banco')}
      <div class="fila-campos">
        ${campo('Referencia (opcional)', '<input type="text" id="tp-referencia" maxlength="60" placeholder="Nº de transferencia, cheque…" autocomplete="off">')}
        ${campo('Observaciones (opcional)', '<input type="text" id="tp-observaciones" maxlength="250" autocomplete="off">', 'dc-nombre')}
      </div>
      <h4 class="inv-sec-titulo">Documentos que ${porPagar ? 'paga' : 'cobra'}</h4>
      <div id="tp-docs"></div>
      <p id="tp-total" class="nota-aiu"></p>`;

    abrirDialogo({
      titulo: porPagar ? 'Registrar pago a proveedor' : 'Registrar recaudo de cliente', cuerpo, ancho: true,
      guardar: {
        texto: porPagar ? 'Registrar pago' : 'Registrar recaudo',
        fn: async () => {
          const aplicaciones = [...document.querySelectorAll('#tp-docs input[data-doc]:checked')].map((chk) => {
            const ap = { docTipo: chk.dataset.tipo, docId: chk.dataset.doc, valor: num(document.querySelector(`#tp-docs input[data-valor="${chk.dataset.doc}"]`).value) };
            if (!porPagar) {
              for (const [k] of RETENCIONES) ap[k] = num(retInput(chk.dataset.doc, k).value);
              ap.otros = [...document.querySelectorAll(`#tp-docs .tp-otro[data-doc-otro="${chk.dataset.doc}"]`)].map((f) => ({
                concepto: f.querySelector('[data-otro="concepto"]').value, cuentaId: f.querySelector('[data-otro="cuenta"]').value || null,
                valor: num(f.querySelector('[data-otro="valor"]').value),
              }));
            }
            return ap;
          });
          const banco = v('tp-medio') === 'banco';
          await api('/tesoreria/pagos', {
            method: 'POST',
            body: JSON.stringify({
              tipo: porPagar ? 'pago' : 'recaudo', terceroId: v('tp-tercero'), fecha: v('tp-fecha'), medio: v('tp-medio'),
              cuentaBancariaId: banco ? v('tp-cuenta') : null, movimientoBancarioId: banco && v('tp-movimiento') ? v('tp-movimiento') : null,
              referencia: v('tp-referencia'), observaciones: v('tp-observaciones'), aplicaciones,
            }),
          });
          await refrescarTodo();
        },
      },
    });

    const retInput = (docId, k) => document.querySelector(`#tp-docs input[data-ret="${k}"][data-doc-ret="${docId}"]`);
    const movimientoElegido = () => libres.find((m) => m.id === v('tp-movimiento')) || null;

    function pintarMovimientos() {
      const cuentaId = v('tp-cuenta');
      const candidatos = libres.filter((m) => m.tipo === tipoMov && m.cuentaBancariaId === cuentaId);
      const previo = mov && mov.cuentaBancariaId === cuentaId ? mov.id : '';
      $('tp-movimiento').innerHTML = `<option value="">Crear el movimiento al guardar</option>` + candidatos.map((m) => `<option value="${esc(m.id)}"${m.id === previo ? ' selected' : ''}>${esc(fecha(m.fecha))} · ${esc(dinero(m.valor))} · ${esc(m.descripcion || 'sin descripción')}</option>`).join('');
    }

    function pintarBanco() {
      const banco = v('tp-medio') === 'banco';
      document.querySelectorAll('#dialogo-tes .tp-banco').forEach((el) => { el.hidden = !banco; });
    }

    function pintarDocs() {
      const tid = v('tp-tercero');
      const docs = pagables.filter((d) => d.terceroId === tid);
      if (!tid) { $('tp-docs').innerHTML = '<p class="texto-suave">Elige primero el tercero.</p>'; return totalizar(); }
      $('tp-docs').innerHTML = `<div class="tabla-envoltorio"><table><thead><tr><th></th><th>Documento</th><th>Vence</th><th class="num">Saldo</th><th class="num">Valor a aplicar</th>${porPagar ? '' : RETENCIONES.map(([, t]) => `<th class="num">${t}</th>`).join('')}</tr></thead><tbody>
        ${docs.map((d) => {
          const marcado = opciones.docId === d.docId;
          return `<tr><td><input type="checkbox" data-doc="${esc(d.docId)}" data-tipo="${esc(d.docTipo)}" data-saldo="${d.saldo}" aria-label="Incluir ${esc(d.numero)}"${marcado ? ' checked' : ''}></td>
          <td>${esc(d.numero)}<br><span class="texto-suave">${esc(d.etiqueta)}</span></td><td>${esc(fecha(d.fechaVencimiento))}${d.vencida ? ` <span class="badge rechazado">${d.diasVencido} d</span>` : ''}</td>
          <td class="num">${dinero(d.saldo)}</td>
          <td class="num"><input type="number" min="0" step="0.01" data-valor="${esc(d.docId)}" value="${marcado ? d.saldo : ''}" ${marcado ? '' : 'disabled'} aria-label="Valor a aplicar a ${esc(d.numero)}"></td>
          ${porPagar ? '' : RETENCIONES.map(([k, t]) => `<td class="num"><input type="number" class="tp-ret" min="0" step="0.01" data-ret="${k}" data-doc-ret="${esc(d.docId)}" placeholder="0" ${marcado ? '' : 'disabled'} aria-label="${t} de ${esc(d.numero)}"></td>`).join('')}</tr>
          ${porPagar ? '' : `<tr class="tp-otros-fila" data-otros-de="${esc(d.docId)}"${marcado ? '' : ' hidden'}><td></td><td colspan="${3 + RETENCIONES.length + 1}">
            <div class="tp-otros-lista" data-lista-de="${esc(d.docId)}"></div>
            ${boton('+ Estampilla, tasa o contribución', 'otro-agregar', { doc: d.docId })}</td></tr>`}`;
        }).join('')}
      </tbody></table></div>`;
      // Si viene de un movimiento del banco y un solo documento tiene justo ese saldo, se deja marcado.
      const m = movimientoElegido();
      if (m && !document.querySelector('#tp-docs input[data-doc]:checked')) {
        const igual = docs.filter((d) => redondear(d.saldo) === redondear(m.valor));
        if (igual.length === 1) {
          const chk = document.querySelector(`#tp-docs input[data-doc="${igual[0].docId}"]`);
          chk.checked = true;
          const inp = document.querySelector(`#tp-docs input[data-valor="${igual[0].docId}"]`);
          inp.disabled = false;
          inp.value = igual[0].saldo;
          document.querySelectorAll(`#tp-docs input[data-doc-ret="${igual[0].docId}"]`).forEach((r) => { r.disabled = false; });
          const filaOtros = document.querySelector(`#tp-docs tr[data-otros-de="${igual[0].docId}"]`);
          if (filaOtros) filaOtros.hidden = false;
        }
      }
      totalizar();
    }

    function totalizar() {
      let bruto = 0;
      let retenido = 0;
      let otrosDesc = 0;
      let n = 0;
      document.querySelectorAll('#tp-docs input[data-doc]:checked').forEach((chk) => {
        bruto += num(document.querySelector(`#tp-docs input[data-valor="${chk.dataset.doc}"]`).value);
        if (!porPagar) {
          for (const [k] of RETENCIONES) retenido += num(retInput(chk.dataset.doc, k).value);
          document.querySelectorAll(`#tp-docs .tp-otro[data-doc-otro="${chk.dataset.doc}"] [data-otro="valor"]`).forEach((i) => { otrosDesc += num(i.value); });
        }
        n += 1;
      });
      bruto = redondear(bruto);
      retenido = redondear(retenido);
      otrosDesc = redondear(otrosDesc);
      const descuentos = redondear(retenido + otrosDesc);
      const total = redondear(bruto - descuentos); // lo que realmente entra o sale del banco o la caja
      let html = n ? `Total ${porPagar ? 'a pagar' : 'a cobrar'}: <strong>${dinero(bruto)}</strong> en ${n} documento${n === 1 ? '' : 's'}.` : 'Marca los documentos y el valor de cada uno (puede ser un abono).';
      if (n && descuentos > 0) {
        html += ` ${retenido > 0 ? `Retenciones: <strong>${dinero(retenido)}</strong> · ` : ''}${otrosDesc > 0 ? `Estampillas, tasas y contribuciones: <strong>${dinero(otrosDesc)}</strong> · ` : ''}Dinero que recibes: <strong>${dinero(total)}</strong>.`;
      }
      if (n && descuentos >= bruto && descuentos > 0) html += ' <strong>Las retenciones y descuentos deben ser menores que el valor cobrado.</strong>';
      const m = v('tp-medio') === 'banco' ? movimientoElegido() : null;
      if (m && n) {
        html += redondear(m.valor) === total
          ? ' <strong>Coincide con el movimiento del banco.</strong>'
          : ` <strong>El movimiento del banco es de ${dinero(m.valor)}: ${descuentos > 0 ? 'el dinero que recibes' : 'el total'} debe sumar lo mismo.</strong>`;
      }
      $('tp-total').innerHTML = html;
    }

    pintarBanco();
    pintarMovimientos();
    pintarDocs();
    const cuerpoEl = $('tes-dialogo-cuerpo');
    cuerpoEl.onchange = (e) => {
      const id = e.target.id;
      if (id === 'tp-tercero') return pintarDocs();
      if (id === 'tp-medio') { pintarBanco(); return totalizar(); }
      if (id === 'tp-cuenta') { pintarMovimientos(); return totalizar(); }
      if (id === 'tp-movimiento') {
        const m = movimientoElegido();
        if (m) $('tp-fecha').value = m.fecha;
        return pintarDocs();
      }
      if (e.target.dataset && e.target.dataset.doc) {
        const inp = document.querySelector(`#tp-docs input[data-valor="${e.target.dataset.doc}"]`);
        inp.disabled = !e.target.checked;
        inp.value = e.target.checked ? e.target.dataset.saldo : '';
        const filaOtros = document.querySelector(`#tp-docs tr[data-otros-de="${e.target.dataset.doc}"]`);
        if (filaOtros) {
          filaOtros.hidden = !e.target.checked;
          if (!e.target.checked) filaOtros.querySelector('.tp-otros-lista').innerHTML = '';
        }
        document.querySelectorAll(`#tp-docs input[data-doc-ret="${e.target.dataset.doc}"]`).forEach((r) => { r.disabled = !e.target.checked; r.value = ''; });
        totalizar();
      }
    };
    cuerpoEl.onclick = (e) => {
      const b = e.target.closest('[data-tes="otro-agregar"], [data-tes="otro-quitar"]');
      if (!b) return;
      if (b.dataset.tes === 'otro-quitar') {
        b.closest('.tp-otro').remove();
        return totalizar();
      }
      const lista = document.querySelector(`#tp-docs .tp-otros-lista[data-lista-de="${b.dataset.doc}"]`);
      if (lista.children.length >= 10) return;
      lista.insertAdjacentHTML('beforeend', `<div class="tp-otro" data-doc-otro="${esc(b.dataset.doc)}">
        <input type="text" data-otro="concepto" maxlength="120" placeholder="Concepto (ej. Estampilla pro-cultura 1,5 %)" aria-label="Concepto del descuento">
        <select data-otro="cuenta" aria-label="Cuenta de gasto o costo">${opcionesOtros}</select>
        <input type="number" min="0" step="0.01" data-otro="valor" placeholder="Valor" aria-label="Valor del descuento">
        ${boton('Quitar', 'otro-quitar', {}, 'btn-accion destructivo')}</div>`);
      lista.lastElementChild.querySelector('[data-otro="concepto"]').focus();
    };
    cuerpoEl.oninput = (e) => { if (e.target.dataset && (e.target.dataset.valor || e.target.dataset.ret || e.target.dataset.otro === 'valor')) totalizar(); };
  }

  // ===================================================================================
  // RETENCIONES SUFRIDAS (las que los clientes nos practicaron al pagar)
  // ===================================================================================
  async function cargarRetenciones() {
    const q = ['desde', 'hasta'].filter((k) => T.ret[k]).map((k) => `${k}=${encodeURIComponent(T.ret[k])}`).join('&');
    T.ret.datos = await api('/tesoreria/retenciones-sufridas' + (q ? '?' + q : ''));
    renderRetenciones();
  }

  function renderRetenciones() {
    const r = T.ret.datos;
    const t = r.totales;
    let html = `<div class="inv-barra">
      ${campo('Desde', `<input type="date" id="tes-r-desde" value="${esc(T.ret.desde)}">`)}
      ${campo('Hasta', `<input type="date" id="tes-r-hasta" value="${esc(T.ret.hasta)}">`)}
      ${r.filas.length ? boton('Descargar CSV de retenciones', 'csv-retenciones', {}, 'btn-primario') : ''}
      ${r.otros.filas.length ? boton('Descargar CSV de estampillas y tasas', 'csv-otros', {}, 'btn-accion') : ''}
    </div>
    <div class="inv-tarjetas">
      <div class="inv-tarjeta destacada"><span>Total retenido</span><strong>${dinero(t.total)}</strong></div>
      <div class="inv-tarjeta"><span>ReteFuente</span><strong>${dinero(t.retefuente)}</strong></div>
      <div class="inv-tarjeta"><span>ReteIVA</span><strong>${dinero(t.reteiva)}</strong></div>
      <div class="inv-tarjeta"><span>ReteICA</span><strong>${dinero(t.reteica)}</strong></div>
      <div class="inv-tarjeta"><span>Estampillas, tasas y contribuciones</span><strong>${dinero(r.otros.total)}</strong></div></div>
    <p class="nota-panel">Retenciones que los clientes practicaron al pagar las facturas (cuentas 135515, 135517 y 135518). Son un anticipo: se descuentan en las declaraciones de renta, IVA e ICA. Compáralas con los certificados de retención que te entrega cada cliente. Los recaudos anulados no cuentan.</p>`;
    if (!r.filas.length && !r.otros.filas.length) {
      html += '<p class="vacio">No hay retenciones ni descuentos registrados en este rango. Se anotan al registrar un recaudo en «Por cobrar».</p>';
    } else if (r.filas.length) {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Factura</th><th class="num">Valor cobrado</th><th class="num">ReteFuente</th><th class="num">ReteIVA</th><th class="num">ReteICA</th><th class="num">Total</th></tr></thead><tbody>
      ${r.filas.map((f) => `<tr><td>${esc(fecha(f.fecha))}</td><td>${esc(f.terceroNombre)}<br><span class="texto-suave">${esc(f.terceroIdentificacion)}</span></td><td>${esc(f.factura)}</td>
        <td class="num">${dinero(f.baseCobrada)}</td><td class="num">${dinero(f.retefuente)}</td><td class="num">${dinero(f.reteiva)}</td><td class="num">${dinero(f.reteica)}</td><td class="num"><strong>${dinero(f.total)}</strong></td></tr>`).join('')}
      </tbody><tfoot><tr><th colspan="4">Totales</th><th class="num">${dinero(t.retefuente)}</th><th class="num">${dinero(t.reteiva)}</th><th class="num">${dinero(t.reteica)}</th><th class="num">${dinero(t.total)}</th></tr></tfoot></table></div>`;
    }
    if (r.otros.filas.length) {
      html += `<h4 class="inv-sec-titulo">Estampillas, tasas y contribuciones descontadas por las entidades</h4>
      <p class="nota-panel">No son anticipo de impuestos: no se descuentan en ninguna declaración. Se registran como gasto o costo en la cuenta elegida al cobrar.</p>
      <div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Factura</th><th>Concepto</th><th>Cuenta</th><th class="num">Valor</th></tr></thead><tbody>
      ${r.otros.filas.map((f) => `<tr><td>${esc(fecha(f.fecha))}</td><td>${esc(f.terceroNombre)}<br><span class="texto-suave">${esc(f.terceroIdentificacion)}</span></td><td>${esc(f.factura)}</td>
        <td>${esc(f.concepto)}</td><td>${esc(f.cuentaCodigo)} · ${esc(f.cuentaNombre)}</td><td class="num">${dinero(f.valor)}</td></tr>`).join('')}
      </tbody><tfoot><tr><th colspan="5">Total</th><th class="num">${dinero(r.otros.total)}</th></tr></tfoot></table></div>`;
    }
    contenido().innerHTML = html;
  }

  function descargarCsv(nombre, filas) {
    const celda = (x) => {
      let t = String(x == null ? '' : x);
      if (typeof x === 'string' && /^[=+\-@]/.test(t)) t = "'" + t; // evita que Excel lo tome como fórmula
      return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = '\ufeff' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${nombre}${T.ret.desde ? '-desde-' + T.ret.desde : ''}${T.ret.hasta ? '-hasta-' + T.ret.hasta : ''}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function descargarCsvRetenciones() {
    const r = T.ret.datos;
    if (!r || !r.filas.length) return;
    descargarCsv('retenciones-sufridas', [['Fecha', 'Cliente', 'Identificación', 'Factura', 'Valor cobrado', 'ReteFuente', 'ReteIVA', 'ReteICA', 'Total retenido']]
      .concat(r.filas.map((f) => [f.fecha, f.terceroNombre, f.terceroIdentificacion, f.factura, f.baseCobrada, f.retefuente, f.reteiva, f.reteica, f.total])));
  }

  function descargarCsvOtros() {
    const r = T.ret.datos;
    if (!r || !r.otros.filas.length) return;
    descargarCsv('estampillas-y-tasas', [['Fecha', 'Cliente', 'Identificación', 'Factura', 'Concepto', 'Cuenta', 'Valor']]
      .concat(r.otros.filas.map((f) => [f.fecha, f.terceroNombre, f.terceroIdentificacion, f.factura, f.concepto, `${f.cuentaCodigo} ${f.cuentaNombre}`, f.valor])));
  }

  // ===================================================================================
  // DESCUENTO DE APORTES DE UN CONTRATISTA
  // ===================================================================================
  async function dialogoDescuento(docTipo, docId) {
    const d = T.cartera.pagar.documentos.find((x) => x.docId === docId);
    if (!d) return;
    const cuentaDoc = docTipo === 'documento_soporte' ? '2335' : '2205';
    const meses = (await api(`/tesoreria/descuentos-aportes?terceroId=${encodeURIComponent(d.terceroId)}`)).filter((m) => m.cuentaPorPagar === cuentaDoc);
    if (!meses.length) {
      throw new Error(`${d.terceroNombre} no tiene aportes de contratista pendientes por descontar en este tipo de documento. Se generan al contabilizar el mes en Nómina › Contratistas.`);
    }
    const nombreMes = (m) => `${MESES[m.mes - 1]} de ${m.anio}`;
    const cuerpo = `
      ${aviso('info', `Los aportes de seguridad social que el contratista asume ya se descontaron contra la cuenta por pagar al contabilizar el mes. Aquí se aplican al documento <strong>${esc(d.numero)}</strong> (saldo ${esc(dinero(d.saldo))}) para que el saldo refleje lo que realmente se le debe. No mueve dinero ni crea otro asiento.`)}
      ${campo('Mes de aportes', `<select id="td-mes">${opcionesSelect(meses.map((m) => [m.fuenteId, `${nombreMes(m)} · disponible ${dinero(m.disponible)}`]), meses[0].fuenteId)}</select>`)}
      <div class="fila-campos">
        ${campo('Valor a descontar', `<input type="number" id="td-valor" min="0" step="0.01" value="${Math.min(meses[0].disponible, d.saldo)}">`)}
        ${campo('Fecha', `<input type="date" id="td-fecha" value="${esc(T.cartera.pagar.hoy)}">`)}
      </div>
      ${campo('Observaciones (opcional)', '<input type="text" id="td-observaciones" maxlength="250" autocomplete="off">')}`;
    abrirDialogo({
      titulo: 'Aplicar descuento de aportes', cuerpo,
      guardar: {
        texto: 'Aplicar descuento',
        fn: async () => {
          await api('/tesoreria/descuentos', {
            method: 'POST',
            body: JSON.stringify({ terceroId: d.terceroId, docTipo, docId, fuenteId: v('td-mes'), valor: num(v('td-valor')), fecha: v('td-fecha'), observaciones: v('td-observaciones') }),
          });
          await refrescarTodo();
        },
      },
    });
    $('tes-dialogo-cuerpo').onchange = (e) => {
      if (e.target.id !== 'td-mes') return;
      const m = meses.find((x) => x.fuenteId === e.target.value);
      if (m) $('td-valor').value = Math.min(m.disponible, d.saldo);
    };
  }

  // ===================================================================================
  // PAGOS DE UN DOCUMENTO Y ANULACIÓN
  // ===================================================================================
  async function dialogoPagosDoc(docTipo, docId) {
    const r = await api(`/tesoreria/documentos/${docTipo}/${docId}/pagos`);
    const filas = r.pagos.map((p) => {
      const aplicado = p.aplicaciones.filter((a) => a.docId === docId && a.estado === 'activa').reduce((s, a) => s + a.valor, 0);
      const retenido = p.aplicaciones.filter((a) => a.docId === docId).map(textoRetenciones).join('');
      const anulado = p.estado === 'anulado';
      return `<tr><td>${esc(fecha(p.fecha))}</td><td>${TIPO_PAGO[p.tipo] || esc(p.tipo)}</td><td>${textoMedio(p)}</td><td>${esc(p.referencia || '—')}</td>
        <td class="num">${dinero(anulado ? p.aplicaciones.filter((a) => a.docId === docId).reduce((s, a) => s + a.valor, 0) : aplicado)}${retenido ? `<br><span class="texto-suave">${esc(retenido.replace(/^ · /, ''))}</span>` : ''}</td>
        <td>${anulado ? `<span class="badge rechazado">anulado</span>` : '<span class="badge conciliado">activo</span>'}</td>
        <td class="acciones">${!anulado && puedeAnular() ? boton('Anular', 'anular-pago', { id: p.id }, 'btn-accion destructivo') : ''}</td></tr>`;
    }).join('');
    abrirDialogo({
      titulo: `Pagos de ${r.numero}`, ancho: true,
      cuerpo: `<p class="nota-panel">Valor <strong>${dinero(r.neto)}</strong> · aplicado <strong>${dinero(r.pagado)}</strong> · saldo <strong>${dinero(r.saldo)}</strong></p>
        <div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Medio</th><th>Referencia</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>${filas || '<tr><td colspan="7" class="vacio">Sin pagos.</td></tr>'}</tbody></table></div>`,
    });
  }

  function dialogoAnular(id) {
    abrirDialogo({
      titulo: 'Anular pago',
      cuerpo: `${aviso('confirmar', 'Se anula el asiento contable, el movimiento bancario que creó este pago (o se libera el que ya existía en el extracto) y los documentos recuperan su saldo.')}
        ${campo('Motivo (mínimo 10 letras)', '<input type="text" id="ta-motivo" maxlength="250" autocomplete="off">')}`,
      guardar: {
        texto: 'Anular pago',
        fn: async () => {
          await api(`/tesoreria/pagos/${id}/anular`, { method: 'POST', body: JSON.stringify({ motivo: v('ta-motivo') }) });
          await refrescarTodo();
        },
      },
    });
  }

  async function refrescarTodo() {
    T.cartera = {};
    await mostrarSub(T.sub);
    if (typeof cargarTodo === 'function') await cargarTodo();
  }

  // ===================================================================================
  // Eventos
  // ===================================================================================
  $('tes-subtabs').innerHTML = SUBS.map(([k, t]) => `<button type="button" data-sub="${k}">${t}</button>`).join('');
  $('tes-subtabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (b) mostrarSub(b.dataset.sub);
  });

  let temporizador = null;
  $('tes-cruce').addEventListener('input', (e) => {
    if (e.target.id !== 'tes-buscar') return;
    T.buscar = e.target.value;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => renderTablaCartera(T.sub), 150);
  });
  $('tes-cruce').addEventListener('change', async (e) => {
    if (e.target.id === 'tes-todos') {
      T.todos = e.target.checked;
      return mostrarSub(T.sub);
    }
    if (e.target.id === 'tes-r-desde' || e.target.id === 'tes-r-hasta') {
      T.ret.desde = v('tes-r-desde');
      T.ret.hasta = v('tes-r-hasta');
      return mostrarSub('retenciones');
    }
    if (e.target.id === 'tes-f-tipo' || e.target.id === 'tes-f-estado') {
      T.filtro = { tipo: v('tes-f-tipo'), estado: v('tes-f-estado') };
      return mostrarSub('historial');
    }
  });

  async function alClic(e) {
    const b = e.target.closest('[data-tes]');
    if (!b) return;
    try {
      switch (b.dataset.tes) {
        case 'nuevo-pago': return await dialogoPago({ sub: T.sub });
        case 'pagar-doc': return await dialogoPago({ sub: T.sub, docId: b.dataset.id });
        case 'descuento-doc': return await dialogoDescuento(b.dataset.tipo, b.dataset.id);
        case 'ver-pagos-doc': return await dialogoPagosDoc(b.dataset.tipo, b.dataset.id);
        case 'anular-pago': return dialogoAnular(b.dataset.id);
        case 'csv-retenciones': return descargarCsvRetenciones();
        case 'csv-otros': return descargarCsvOtros();
      }
    } catch (err) {
      mostrarError(err);
    }
  }
  $('tes-cruce').addEventListener('click', alClic);
  $('tes-dialogo-cuerpo').addEventListener('click', alClic);

  // Lo llama app.js al abrir la pestaña Tesorería.
  window.tesoreriaAlMostrar = function () {
    mostrarSub(T.sub);
  };

  // Desde la tabla de movimientos: cruzar un movimiento del extracto con las facturas que paga.
  window.tesoreriaCruzarMovimiento = async function (id) {
    try {
      const movs = await api('/tesoreria/movimientos-libres');
      const m = movs.find((x) => x.id === id);
      if (!m) throw new Error('Ese movimiento ya está ligado a otra operación.');
      T.sub = m.tipo === 'egreso' ? 'pagar' : 'cobrar';
      document.querySelectorAll('#tes-subtabs button').forEach((b) => b.classList.toggle('activo', b.dataset.sub === T.sub));
      await dialogoPago({ sub: T.sub, movimiento: id });
    } catch (err) {
      mostrarError(err);
    }
  };
})();
SCRIPTEOF
echo "OK  public/contable/tesoreriaCruce.js"

cat > public/contable/style.css << 'SCRIPTEOF'
:root {
  --paper: #F6F8F4;
  --surface: #FFFFFF;
  --ink: #1C2A24;
  --ink-soft: #56655C;
  --rule: #CBD6CE;
  --rule-strong: #9FAFA4;
  --accent: #2F6B4F;
  --accent-hover: #275940;
  --accent-ink: #FFFFFF;
  --danger: #A6432E;
  --warn: #B8863A;
  --font-serif: 'IBM Plex Serif', Georgia, serif;
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
}

* { box-sizing: border-box; }

/* El atributo hidden debe ganar siempre, incluso sobre elementos con
   display: grid/flex por clase (.app, .pantalla-login, etc.) — sin
   esto, el navegador puede dejar visible un elemento "oculto". */
[hidden] { display: none !important; }

body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--paper);
}

.wordmark {
  font-family: var(--font-serif);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

button { font-family: var(--font-sans); cursor: pointer; }

.btn-primario {
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
}
.btn-primario:hover { background: var(--accent-hover); }

.btn-secundario {
  background: transparent;
  color: var(--ink-soft);
  border: 1px solid var(--rule-strong);
  padding: 10px 18px;
  font-size: 14px;
}

/* LOGIN */
.pantalla-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.tarjeta-login {
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border-top: 3px solid var(--accent);
  padding: 40px 32px;
}

.tarjeta-login .wordmark { font-size: 22px; margin-bottom: 4px; }

.subtitulo {
  color: var(--ink-soft);
  font-size: 13px;
  margin: 0 0 28px;
  line-height: 1.5;
}

#form-login label {
  display: block;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 16px;
}

#form-login input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}

#form-login input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

#form-login .btn-primario {
  width: 100%;
  padding: 12px;
  margin-top: 8px;
}

.mensaje-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 12px;
}

.mensaje-exito {
  color: var(--accent);
  font-size: 13px;
  margin: 0 0 14px;
}

.enlace-onboarding {
  display: block;
  width: 100%;
  text-align: center;
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  margin-top: 20px;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}
.enlace-onboarding:hover { color: var(--accent); }

.tarjeta-onboarding { max-width: 420px; }
.tarjeta-onboarding label { display: block; font-size: 13px; color: var(--ink-soft); margin-bottom: 14px; }
.tarjeta-onboarding input, .tarjeta-onboarding select {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}
.tarjeta-onboarding .btn-primario { width: 100%; padding: 12px; margin-top: 4px; }

.logo-vista-previa {
  display: block;
  max-width: 140px;
  max-height: 80px;
  margin-top: 8px;
  border: 1px solid var(--rule-strong);
  padding: 6px;
}

.tarjeta-onboarding .check-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.tarjeta-onboarding .check-inline input[type="checkbox"] {
  width: auto;
  margin: 0;
}

/* PANEL DE INICIO */
.bienvenida {
  color: var(--ink-soft);
  font-size: 14px;
  margin: -10px 0 28px;
}

.grid-modulos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.tarjeta-modulo {
  text-align: left;
  background: var(--surface);
  border: none;
  border-top: 3px solid var(--accent);
  padding: 20px 18px;
  cursor: pointer;
  font-family: var(--font-sans);
}
.tarjeta-modulo:hover { background: var(--paper); }

.numero-modulo {
  display: block;
  font-family: var(--font-serif);
  font-size: 13px;
  color: var(--rule-strong);
  font-weight: 600;
  margin-bottom: 8px;
}

.tarjeta-modulo h3 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 16px;
  margin: 0 0 6px;
  color: var(--ink);
}

.tarjeta-modulo p {
  font-size: 13px;
  color: var(--ink-soft);
  margin: 0;
  line-height: 1.4;
}

@media (max-width: 720px) {
  .grid-modulos { grid-template-columns: 1fr; }
}

/* APP SHELL */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.barra-lateral {
  background: var(--surface);
  border-right: 1px solid var(--rule);
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
}

.barra-lateral .wordmark { font-size: 17px; margin-bottom: 28px; }

.barra-lateral nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding: 9px 10px;
  font-size: 14px;
  color: var(--ink-soft);
}

.nav-item:hover { color: var(--ink); background: var(--paper); }

.nav-item.activo {
  color: var(--ink);
  border-left-color: var(--accent);
  background: var(--paper);
  font-weight: 500;
}

.usuario-actual {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-top: 16px;
}

.usuario-actual p { margin: 0; font-size: 13px; }
.usuario-actual .rol {
  color: var(--ink-soft);
  text-transform: capitalize;
  margin-bottom: 10px;
}

#btn-salir {
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  padding: 0;
  text-decoration: underline;
}

.enlace-sitio {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-top: 8px;
}

.contenido { padding: 32px 40px; max-width: 1000px; }

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}

.panel-header h2 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 24px;
  margin: 0;
}

.subseccion {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 15px;
  color: var(--ink-soft);
  margin: 0;
}

.subseccion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 24px 0 10px;
}
.subseccion-header:first-of-type { margin-top: 0; }

.acciones-header {
  display: flex;
  gap: 10px;
  align-items: center;
}

.nota-panel {
  color: var(--ink-soft);
  font-size: 13px;
  margin: -8px 0 16px;
}

.btn-chico {
  padding: 6px 12px;
  font-size: 13px;
}

.btn-accion {
  background: none;
  border: 1px solid var(--rule-strong);
  color: var(--ink);
  padding: 4px 10px;
  font-size: 12px;
  margin-right: 6px;
  white-space: nowrap;
}
.btn-accion:hover { background: var(--paper); }
.btn-accion.destructivo { border-color: var(--danger); color: var(--danger); }
.btn-accion.destructivo:hover { background: #fbeae6; }

td.acciones { white-space: nowrap; }

.form-inline {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 16px;
  margin-bottom: 20px;
}

.form-inline input, .form-inline select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

.fieldset-responsabilidades {
  border: 1px solid var(--rule-strong);
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  width: 100%;
}
.fieldset-responsabilidades legend {
  font-size: 12px;
  color: var(--ink-soft);
  padding: 0 4px;
}
.fieldset-responsabilidades label {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

/* Formularios más grandes (cotización, orden) con ítems dinámicos */
.form-grande {
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 20px;
  margin-bottom: 20px;
}

.fila-campos {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.fila-campos input, .fila-campos select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

.campo-etiquetado {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-soft);
}

.bloque-items {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-bottom: 16px;
}
.bloque-items-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.bloque-items-header h4 {
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--ink-soft);
}

.tabla-items { width: 100%; border-collapse: collapse; font-size: 13px; }
.tabla-items thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 11px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--rule-strong);
}
.tabla-items td { padding: 4px 6px; }
.tabla-items input, .tabla-items select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 13px;
  background: var(--paper);
}
.tabla-items .num { text-align: right; font-family: var(--font-mono); white-space: nowrap; }
.tabla-items .item-total-texto { font-family: var(--font-mono); }

.check-aiu {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 12px;
}

.campo-aiu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-soft);
}
.campo-aiu .valor-aiu {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink);
}

.resumen-totales {
  display: flex;
  gap: 24px;
  justify-content: flex-end;
  border-top: 1px solid var(--rule);
  padding-top: 12px;
  margin-bottom: 16px;
  font-size: 14px;
}
.resumen-totales strong { font-family: var(--font-mono); }

.fila-botones { display: flex; gap: 10px; }

.tabla-items-detalle { width: 100%; border-collapse: collapse; font-size: 13px; margin: 10px 0; }
.tabla-items-detalle th {
  text-align: left;
  font-size: 11px;
  color: var(--ink-soft);
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule-strong);
}
.tabla-items-detalle td { padding: 6px 10px; border-bottom: 1px solid var(--rule); }
.tabla-items-detalle .num { text-align: right; font-family: var(--font-mono); }
.detalle-items { background: var(--paper); padding: 14px 16px; }
.nota-aiu { font-size: 12px; color: var(--ink-soft); margin: 8px 0 0; }

/* TABLAS: estilo libro contable — solo reglas horizontales */
.tabla-envoltorio {
  background: var(--surface);
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--rule-strong);
  white-space: nowrap;
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}

tbody tr:last-child td { border-bottom: none; }

td.num, th.num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  text-transform: capitalize;
}
.badge.aceptada, .badge.aceptado, .badge.contabilizado, .badge.contabilizada, .badge.pagada, .badge.liquidada, .badge.aprobada, .badge.conciliado { border-color: var(--accent); color: var(--accent); }
.badge.rechazada, .badge.rechazado, .badge.objetada { border-color: var(--danger); color: var(--danger); }
.badge.pendiente, .badge.borrador, .badge.enviada, .badge.enviado { border-color: var(--warn); color: var(--warn); }

.vacio {
  padding: 32px 16px;
  color: var(--ink-soft);
  font-size: 14px;
  text-align: center;
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .barra-lateral {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
  .barra-lateral nav { flex-direction: row; flex-wrap: wrap; }
  .contenido { padding: 20px; }
}

/* Orden de adquisición: totales con varias líneas (AIU, Impoconsumo,
   retención, neto). Se permite pasar a otra línea en pantallas angostas. */
.resumen-totales { flex-wrap: wrap; row-gap: 6px; }
.resumen-totales .neto-pagar, #resumen-neto-orden-fila { font-weight: 600; }
.fila-campos .nota-aiu { flex-basis: 100%; margin: 0; }

/* Retención en la fuente de la orden */
.bloque-retencion {
  border: 1px solid var(--rule);
  padding: 12px 16px 14px;
  margin: 0 0 16px;
}
.bloque-retencion legend {
  font-family: var(--font-serif);
  font-size: 13px;
  padding: 0 6px;
  color: var(--ink-soft);
}
.opciones-retencion { display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px; margin-bottom: 10px; }
.opciones-retencion label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.bloque-retencion select, .bloque-retencion input[type="text"], .bloque-retencion input[type="number"] {
  padding: 7px 9px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 13px;
  background: var(--paper);
}
.bloque-retencion .item-ret-concepto { width: 100%; min-width: 260px; }
.bloque-retencion .item-ret-tarifa { width: 70px; }
.bloque-retencion .campo-ancho { flex: 1; min-width: 240px; }
.bloque-retencion .campo-ancho input { width: 100%; }
.bloque-retencion .ret-nota { display: block; font-size: 11px; color: #9A5B13; margin-top: 3px; }
.bloque-retencion .ret-sin-efecto { color: var(--ink-soft); }
.bloque-retencion td:nth-child(2) { white-space: nowrap; }

/* ---------- Facturas de compra desde XML (ventanas) ---------- */
.dialogo-factura {
  width: min(1060px, 96vw);
  max-height: 94vh;
  padding: 0;
  border: 1px solid var(--rule-strong);
  background: var(--surface);
  color: var(--ink);
}
.dialogo-factura[open] { display: flex; flex-direction: column; }
.dialogo-factura::backdrop { background: rgba(28, 42, 36, 0.45); }

.dialogo-cabecera {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--rule);
}
.dialogo-cabecera h3 { font-family: var(--font-serif); font-size: 18px; margin: 0; }
.btn-cerrar-dialogo { border: none; background: none; font-size: 26px; line-height: 1; color: var(--ink-soft); padding: 0 4px; }
.btn-cerrar-dialogo:hover { color: var(--ink); }
.dialogo-cuerpo { padding: 18px 20px; overflow-y: auto; flex: 1; }
.dialogo-pie {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  padding: 12px 20px;
  border-top: 1px solid var(--rule);
}
.dialogo-pie .btn-primario:disabled { opacity: 0.45; cursor: not-allowed; }
.fx-ayuda { margin-right: auto; font-size: 12px; color: var(--ink-soft); }
.fx-error { flex-basis: 100%; margin: 0; font-size: 13px; color: var(--danger); }

.zona-archivo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  border: 2px dashed var(--rule-strong);
  background: var(--paper);
  cursor: pointer;
  text-align: center;
  font-size: 14px;
}
.zona-archivo span { color: var(--ink-soft); font-size: 13px; }
.zona-archivo.arrastrando { border-color: var(--accent); background: #EAF2EC; }
.zona-archivo.error { border-color: var(--danger); }
#fx-estado-lectura.error { color: var(--danger); }

/* Avisos de la factura */
.fx-aviso { padding: 8px 12px; margin: 0 0 8px; font-size: 13px; border-left: 4px solid var(--rule-strong); background: var(--paper); }
.fx-aviso.bloqueo { border-left-color: var(--danger); background: #FBEFEC; color: #7A2D1D; }
.fx-aviso.confirmar { border-left-color: var(--warn); background: #FBF4E6; color: #6E4E14; }
.fx-aviso.info { border-left-color: var(--accent); background: #EDF4EF; }

.fx-resumen {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px 20px;
  margin: 12px 0 16px;
  padding: 12px 14px;
  background: var(--paper);
  border: 1px solid var(--rule);
  font-size: 13px;
}
.fx-resumen dt { font-size: 11px; color: var(--ink-soft); margin: 0 0 2px; }
.fx-resumen dd { margin: 0; word-break: break-word; }
.fx-resumen .mono { font-family: var(--font-mono); font-size: 12px; }
.fx-resumen a { color: var(--accent); }

.fx-rejilla { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-bottom: 14px; }
.fx-bloque h4 { font-family: var(--font-serif); font-size: 14px; margin: 0 0 8px; }
.fx-bloque select, .dialogo-factura .bloque-retencion select { max-width: 100%; }
.fx-bloque select { width: 100%; padding: 7px 9px; border: 1px solid var(--rule-strong); font-family: var(--font-sans); font-size: 13px; background: var(--paper); }
.fx-ancho { margin-bottom: 16px; }
.fx-texto { margin: 0 0 8px; font-size: 13px; }
.fx-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
.fx-aceptar { padding: 10px 12px; border: 1px solid var(--warn); background: #FBF4E6; }
.fx-titulo-con-accion { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.fx-titulo-con-accion h4 { margin: 0; }
.fx-todas { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-soft); }
.fx-todas select { width: auto; min-width: 220px; }
#fx-tabla-lineas select { width: 100%; min-width: 200px; padding: 5px 7px; font-size: 12px; border: 1px solid var(--rule-strong); background: var(--paper); }
#fx-tabla-lineas td, #fx-tabla-asiento td, #fx-tabla-asiento th, #fx-tabla-lineas th { vertical-align: top; }
#fx-tabla-asiento tfoot td { font-weight: 600; border-top: 1px solid var(--rule-strong); }
#fx-tabla-asiento .cuenta-nombre { color: var(--ink-soft); }
#fx-tabla-asiento .cuenta-falta { color: var(--danger, #b42318); font-style: italic; }
#fx-tabla-asiento .indentar { padding-left: 28px; }
.fx-aiu { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; max-width: 360px; }
.fx-aiu input { padding: 7px 9px; border: 1px solid var(--rule-strong); background: var(--paper); font-size: 13px; }
#fx-totales strong.neto { color: var(--accent); }

.fd-aviso { padding: 10px 12px; margin-bottom: 12px; font-size: 13px; border-left: 4px solid var(--accent); background: #EDF4EF; }
.fd-aviso.alerta { border-left-color: var(--warn); background: #FBF4E6; }

.badge.libre { text-transform: none; }

/* ---------- Mi Empresa: subpestañas y plan de cuentas ---------- */
.subtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--rule); margin: 0 0 16px; }
.subtab {
  border: none;
  background: none;
  padding: 9px 16px;
  font: inherit;
  color: var(--ink-soft);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
}
.subtab:hover { color: var(--ink); }
.subtab.activo { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }

.plan-barra { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 12px; }
.plan-barra input[type="search"] { min-width: 240px; flex: 1; max-width: 360px; }
#tabla-plan-cuentas td.num, #tabla-plan-cuentas th.num { text-align: right; }
#tabla-plan-cuentas td:first-child { font-variant-numeric: tabular-nums; white-space: nowrap; }
#tabla-plan-cuentas tr.sub td:nth-child(2) { padding-left: 28px; }
#tabla-plan-cuentas tr.inactiva td { color: var(--ink-soft); }
#tabla-plan-cuentas .plan-acciones { white-space: nowrap; text-align: right; }
.plan-motivo { font-size: 11px; color: var(--ink-soft); display: block; }

.plan-catalogo {
  border: 1px solid var(--rule-strong);
  background: var(--surface);
  padding: 14px 16px;
  margin: 0 0 16px;
}
.plan-catalogo-cab h3 { font-family: var(--font-serif); font-size: 17px; margin: 0 0 4px; }
.plan-catalogo-cab p { margin: 0 0 10px; font-size: 13px; color: var(--ink-soft); }
.plan-grupo { border: none; border-top: 1px solid var(--rule); margin: 12px 0 0; padding: 8px 0 0; }
.plan-grupo legend { font-weight: 600; font-size: 13px; padding: 0 8px 0 0; }
.plan-item { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0; font-size: 13px; }
.plan-item input { margin-top: 3px; }
.plan-item .plan-item-uso { display: block; color: var(--ink-soft); font-size: 12px; }
.plan-item .plan-item-codigo { font-variant-numeric: tabular-nums; font-weight: 600; }
.plan-item.ya-activa { opacity: 0.6; }

/* Diálogo para crear una cuenta */
.dialogo-chico { width: min(560px, 96vw); }
.dialogo-chico form { display: flex; flex-direction: column; min-height: 0; }
.dialogo-chico .fila-campos { display: flex; gap: 12px; flex-wrap: wrap; }
.dialogo-chico .fila-campos .campo-etiquetado { flex: 0 0 120px; }
.dialogo-chico .fila-campos .dc-nombre { flex: 1 1 240px; }
.dialogo-chico .campo-etiquetado + .fila-campos, .dialogo-chico .campo-etiquetado { margin-bottom: 10px; }
.dc-tipo { margin: 0 0 8px; font-size: 13px; min-height: 18px; }
.dc-tipo.ok { color: var(--accent); }
.dc-tipo.mal { color: var(--danger); }
.dc-tipo.aviso { color: #9A5B13; }
.mensaje-exito.error { color: var(--danger); }
.btn-accion:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-accion:disabled:hover { background: none; }
#tabla-plan-cuentas th:nth-child(5) { text-align: right; }
#tabla-plan-cuentas tr.aux td:nth-child(2) { padding-left: 52px; }
.mono { font-family: var(--font-mono); }

/* Texto de ayuda dentro de una celda de acciones (ej.: cotización aceptada) */
.texto-suave { color: #6b7280; font-size: 0.85em; }

/* Documento soporte: campos dentro del diálogo */
.fx-bloque .campo-etiquetado { display: block; margin-bottom: 8px; }
.fx-bloque .campo-etiquetado span { display: block; font-size: 12px; margin-bottom: 3px; }
.fx-bloque .campo-etiquetado input, .fx-bloque input[type="file"], #ds-tabla-lineas input, #ds-tabla-lineas select {
  width: 100%; padding: 7px 9px; border: 1px solid var(--rule-strong); font-family: var(--font-sans); font-size: 13px; background: var(--paper); box-sizing: border-box;
}
#ds-tabla-lineas input[type="number"] { text-align: right; }
#ds-tabla-lineas .ds-desc { min-width: 220px; }
#ds-tabla-lineas .ds-cant { min-width: 70px; }
#ds-tabla-lineas .ds-unit { min-width: 120px; }
.fx-bloque input[type="file"] { margin-bottom: 6px; }

/* --- Nómina --- */
.subtabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 18px;
  border-bottom: 1px solid var(--rule);
}
.subtabs button {
  background: none;
  border: 0;
  border-bottom: 3px solid transparent;
  padding: 9px 14px;
  font-size: 14px;
  color: var(--ink-soft);
  margin-bottom: -1px;
}
.subtabs button:hover { color: var(--ink); }
.subtabs button.activo { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

.nom-barra { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin-bottom: 14px; }
.nom-barra h3 { font-family: var(--font-serif); font-size: 20px; margin: 0; }
.nom-barra .nota-panel { flex: 1 1 420px; margin: 0; }

.nom-tarjetas { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 0 0 16px; }
.nom-tarjeta { background: var(--surface); border: 1px solid var(--rule); padding: 10px 14px; display: flex; flex-direction: column; gap: 4px; }
.nom-tarjeta span { font-size: 12px; color: var(--ink-soft); }
.nom-tarjeta strong { font-family: var(--font-mono); font-size: 16px; font-variant-numeric: tabular-nums; }
.nom-tarjeta.destacada { border-color: var(--accent); }
.nom-tarjeta.destacada strong { color: var(--accent); }

.nom-acciones { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.nom-detalles { margin: 10px 0; border: 1px solid var(--rule); background: var(--surface); padding: 8px 14px; }
.nom-detalles summary { cursor: pointer; font-weight: 600; font-size: 14px; }
.nom-simulacion .tabla-items-detalle { margin: 0 0 8px; }
.nom-anio { max-width: 200px; }
.nom-lista { padding-left: 18px; font-size: 13px; line-height: 1.5; color: var(--ink-soft); }
.nom-lista li { margin-bottom: 6px; }
.fila-error td { background: #FBEFEC; }
.check-linea { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; font-size: 13px; }
.check-linea input { margin-top: 3px; }
#nom-dialogo-extra { display: inline-flex; gap: 8px; }
.nom-titulo-sep { margin-top: 22px; }

/* --- Inventarios --- */
.inv-barra { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-bottom: 14px; }
.inv-barra .nota-panel { flex: 1 1 360px; margin: 0; }
.inv-barra input, .inv-barra select { font: inherit; padding: 6px 8px; border: 1px solid var(--rule-strong); background: var(--surface); }
.inv-barra input[type="search"] { min-width: 220px; }
.inv-tarjetas { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 0 0 16px; }
.inv-tarjeta { background: var(--surface); border: 1px solid var(--rule); padding: 10px 14px; display: flex; flex-direction: column; gap: 4px; }
.inv-tarjeta span { font-size: 12px; color: var(--ink-soft); }
.inv-tarjeta strong { font-family: var(--font-mono); font-size: 16px; font-variant-numeric: tabular-nums; }
.inv-tarjeta.alerta { border-color: #b4701f; }
.inv-linea { margin-top: 6px; }
.inv-linea small { display: block; font-size: 11px; color: var(--ink-soft); margin-bottom: 2px; }
.inv-linea select { width: 100%; }
.inv-sec-titulo { font-family: var(--font-serif); font-size: 15px; margin: 14px 0 6px; border-bottom: 1px solid var(--rule); padding-bottom: 3px; }
.inv-dif-ok { color: var(--accent); font-weight: 600; }
.inv-dif-mal { color: #a33; font-weight: 600; }
.inv-anulado td { color: var(--ink-soft); text-decoration: line-through; }
#inv-dialogo-extra { display: inline-flex; gap: 8px; }
#dialogo-inv .campo-etiquetado { margin-bottom: 12px; }
#dialogo-inv .campo-etiquetado input:not([type="checkbox"]), #dialogo-inv .campo-etiquetado select {
  padding: 8px 10px; border: 1px solid var(--rule-strong); font-family: var(--font-sans); font-size: 14px; background: var(--paper); box-sizing: border-box; width: 100%;
}
#dialogo-inv .fila-campos { margin-bottom: 0; }
#dialogo-inv .fila-campos .campo-etiquetado { flex: 1 1 150px; }
#dialogo-inv .fila-campos .dc-nombre { flex: 2 1 280px; }
#dialogo-inv .fx-check { display: block; margin: 4px 0 12px; font-size: 13px; }
#dialogo-inv .inv-barra { margin-bottom: 12px; }
.inv-linea select { max-width: 100%; }

/* Nómina · prestaciones: un concepto por renglón dentro de la tabla de empleados */
.nom-comp { white-space: nowrap; padding: 1px 0; }

/* Selector de departamento y municipio (búsqueda por nombre) */
.combo { position: relative; }
.combo-entrada { width: 100%; box-sizing: border-box; }
.combo-entrada.combo-invalido { border-color: var(--danger); }
.combo-lista {
  position: absolute; z-index: 30; left: 0; right: 0; top: 100%; margin: 2px 0 0; padding: 0; list-style: none;
  max-height: 220px; overflow-y: auto; background: var(--paper); border: 1px solid var(--rule-strong);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
.combo-lista[hidden] { display: none; }
.combo-lista li { padding: 6px 9px; font-size: 13px; cursor: pointer; display: flex; justify-content: space-between; gap: 10px; }
.combo-lista li small { color: #6b7280; font-size: 11px; }
.combo-lista li.activo, .combo-lista li[data-i]:hover { background: var(--accent-soft, #e8efe9); }
.combo-lista li.combo-mas { cursor: default; color: #6b7280; font-size: 12px; }
.combo-codigo { min-height: 14px; font-size: 11px; color: #6b7280; }

/* Tesorería · cruce de pagos */
#dialogo-tes .campo-etiquetado { margin-bottom: 12px; }
#dialogo-tes .campo-etiquetado input:not([type="checkbox"]), #dialogo-tes .campo-etiquetado select {
  padding: 8px 10px; border: 1px solid var(--rule-strong); font-family: var(--font-sans); font-size: 14px; background: var(--paper); box-sizing: border-box; width: 100%;
}
#dialogo-tes .fila-campos { margin-bottom: 0; }
#dialogo-tes .fila-campos .campo-etiquetado { flex: 1 1 150px; }
#dialogo-tes .fila-campos .dc-nombre { flex: 2 1 280px; }
#dialogo-tes td input[type="number"] { width: 130px; padding: 6px 8px; border: 1px solid var(--rule-strong); font: inherit; text-align: right; background: var(--paper); }
#dialogo-tes td input[type="number"]:disabled { background: transparent; border-color: transparent; }
#tes-cruce .inv-tarjetas { margin-top: 8px; }
/* Tesorería · retenciones que practican los clientes al cobrar */
#dialogo-tes td input.tp-ret { width: 96px; }
#tes-contenido tfoot th { border-top: 2px solid var(--rule-strong); text-align: left; }
#tes-contenido tfoot th.num { text-align: right; }
#tes-contenido .inv-barra .campo-etiquetado { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
#dialogo-tes .tp-otros-fila td { border-top: none; padding-top: 0; }
#dialogo-tes .tp-otro { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin-bottom: 6px; }
#dialogo-tes .tp-otro input[type="text"] { flex: 2 1 220px; padding: 6px 8px; border: 1px solid var(--rule-strong); font: inherit; background: var(--paper); }
#dialogo-tes .tp-otro select { flex: 2 1 200px; padding: 6px 8px; border: 1px solid var(--rule-strong); font: inherit; background: var(--paper); }
#dialogo-tes .tp-otro input[type="number"] { flex: 0 0 120px; width: 120px; }
SCRIPTEOF
echo "OK  public/contable/style.css"

cat > public/contable/index.html << 'SCRIPTEOF'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mipyme Contable</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/contable/style.css?v=20261113-3">
</head>
<body>

<div id="vista-login" class="pantalla-login">
  <div class="tarjeta-login" id="tarjeta-login-principal">
    <h1 class="wordmark">Mipyme Contable</h1>
    <p class="subtitulo">Sistema contable para microempresas — NIIF Grupo 3</p>
    <form id="form-login">
      <label>Correo
        <input type="email" id="login-email" required autocomplete="username">
      </label>
      <label>Contraseña
        <input type="password" id="login-password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn-primario">Entrar</button>
      <p id="login-error" class="mensaje-error" hidden></p>
    </form>
    <button type="button" id="btn-mostrar-onboarding" class="enlace-onboarding">¿Primera vez? Crear empresa y usuario →</button>
  </div>

  <div class="tarjeta-login tarjeta-onboarding" id="tarjeta-onboarding" hidden>
    <h1 class="wordmark">Nueva empresa</h1>
    <p class="subtitulo">Dos pasos: primero los datos de la empresa, luego su primer usuario con el código de registro que te entregó Libaniel Consulting.</p>

    <form id="form-empresa-nueva">
      <label>Razón social
        <input type="text" id="empresa-razon-social" required>
      </label>
      <label>NIT
        <input type="text" id="empresa-nit" required>
      </label>
      <label>Régimen tributario
        <select id="empresa-regimen">
          <option value="ordinario">Ordinario</option>
          <option value="rst">Régimen Simple (RST)</option>
          <option value="especial">Régimen Tributario Especial (ESAL, cooperativas)</option>
        </select>
      </label>
      <label class="check-inline">
        <input type="checkbox" id="empresa-responsable-iva"> Responsable de IVA
      </label>
      <label>Correo electrónico
        <input type="email" id="empresa-email">
      </label>
      <label>Teléfono de contacto
        <input type="text" id="empresa-telefono">
      </label>
      <label>Dirección
        <input type="text" id="empresa-direccion">
      </label>
      <label>Departamento
        <input type="text" id="empresa-departamento">
      </label>
      <label>Municipio
        <input type="text" id="empresa-municipio">
      </label>
      <label>Representante legal
        <input type="text" id="empresa-representante-nombre">
      </label>
      <label>Documento del representante legal
        <input type="text" id="empresa-representante-documento">
      </label>
      <label>Código CIIU (actividad económica)
        <input type="text" id="empresa-ciiu">
      </label>
      <label>Matrícula mercantil
        <input type="text" id="empresa-matricula">
      </label>
      <label>Logo (opcional — aparecerá en cotizaciones y órdenes)
        <input type="file" id="empresa-logo" accept="image/png, image/jpeg, image/svg+xml">
        <img id="empresa-logo-vista-previa" class="logo-vista-previa" hidden>
      </label>
      <button type="submit" class="btn-primario">Continuar</button>
    </form>

    <form id="form-usuario-nuevo" hidden>
      <p id="empresa-creada-mensaje" class="mensaje-exito"></p>
      <label>Nombre del usuario
        <input type="text" id="usuario-nuevo-nombre" required>
      </label>
      <label>Correo
        <input type="email" id="usuario-nuevo-email" required>
      </label>
      <label>Contraseña (mínimo 8 caracteres, con letras y números)
        <input type="password" id="usuario-nuevo-password" required minlength="8" autocomplete="new-password">
      </label>
      <label>Rol
        <select id="usuario-nuevo-rol">
          <option value="dueño">Dueño</option>
          <option value="contador">Contador</option>
        </select>
      </label>
      <label>Código de registro
        <input type="password" id="usuario-nuevo-codigo" required autocomplete="off">
      </label>
      <button type="submit" class="btn-primario">Crear empresa y usuario</button>
      <button type="button" class="btn-secundario" id="btn-onboarding-atras">← Volver a los datos de la empresa</button>
    </form>

    <p id="onboarding-resultado" class="mensaje-exito" hidden></p>
    <button type="button" id="btn-volver-login" class="enlace-onboarding">← Volver a iniciar sesión</button>
  </div>
</div>

<div id="vista-dashboard" class="app" hidden>
  <aside class="barra-lateral">
    <h1 class="wordmark">Mipyme Contable</h1>
    <nav>
      <button class="nav-item activo" data-tab="inicio">Inicio</button>
      <button class="nav-item" data-tab="terceros">Terceros</button>
      <button class="nav-item" data-tab="proyectos">Proyectos</button>
      <button class="nav-item" data-tab="cotizaciones">Cotizaciones</button>
      <button class="nav-item" data-tab="facturas-venta">Facturas de venta</button>
      <button class="nav-item" data-tab="ordenes">Órdenes de adquisición</button>
      <button class="nav-item" data-tab="facturas-compra">Facturas de compra</button>
      <button class="nav-item" data-tab="documentos-soporte">Documentos soporte</button>
      <button class="nav-item" data-tab="nomina">Nómina</button>
      <button class="nav-item" data-tab="inventarios">Inventarios</button>
      <button class="nav-item" data-tab="activos-fijos">Activos fijos</button>
      <button class="nav-item" data-tab="tesoreria">Tesorería</button>
      <button class="nav-item" data-tab="mi-empresa">Mi Empresa</button>
    </nav>
    <div class="usuario-actual">
      <p id="usuario-nombre"></p>
      <p id="usuario-rol" class="rol"></p>
      <button id="btn-salir">Cerrar sesión</button>
      <a href="/" class="enlace-sitio">← libanielconsulting.com</a>
    </div>
  </aside>

  <main class="contenido">
    <section id="panel-inicio" class="panel">
      <header class="panel-header"><h2>Inicio</h2></header>
      <p class="bienvenida">Bienvenido, <span id="inicio-usuario-nombre"></span> — trabajando en <strong id="inicio-empresa-nombre">—</strong>.</p>
      <div class="grid-modulos">
        <button class="tarjeta-modulo" data-ir-a="terceros">
          <span class="numero-modulo">01</span>
          <h3>Terceros</h3>
          <p>Clientes, proveedores y empleados</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="cotizaciones">
          <span class="numero-modulo">02</span>
          <h3>Cotizaciones</h3>
          <p>Cotiza y da seguimiento a tus ventas</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="facturas-venta">
          <span class="numero-modulo">03</span>
          <h3>Facturas de venta</h3>
          <p>Facturación electrónica</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="ordenes">
          <span class="numero-modulo">04</span>
          <h3>Órdenes de Adquisición</h3>
          <p>Compras de bienes y servicios</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="facturas-compra">
          <span class="numero-modulo">05</span>
          <h3>Facturas de compra</h3>
          <p>Facturas recibidas y documento soporte</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="nomina">
          <span class="numero-modulo">06</span>
          <h3>Nómina</h3>
          <p>Liquidación de empleados</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="inventarios">
          <span class="numero-modulo">07</span>
          <h3>Inventarios</h3>
          <p>Control de existencias</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="activos-fijos">
          <span class="numero-modulo">08</span>
          <h3>Activos fijos</h3>
          <p>Depreciación y activos</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="tesoreria">
          <span class="numero-modulo">09</span>
          <h3>Tesorería</h3>
          <p>Cuentas y movimientos bancarios</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="proyectos">
          <span class="numero-modulo">10</span>
          <h3>Proyectos</h3>
          <p>Contratos y negocios — futuro centro de costo</p>
        </button>
      </div>
    </section>

    <section id="panel-terceros" class="panel" hidden>
      <header class="panel-header">
        <h2>Terceros</h2>
        <button class="btn-primario" id="btn-nuevo-tercero">+ Nuevo tercero</button>
      </header>
      <form id="form-tercero" class="form-inline" hidden>
        <select id="tercero-tipo" required>
          <option value="cliente">Cliente</option>
          <option value="proveedor">Proveedor</option>
          <option value="empleado">Empleado</option>
          <option value="otro">Otro</option>
        </select>
        <select id="tercero-tipo-persona">
          <option value="">Tipo de persona...</option>
          <option value="natural">Natural</option>
          <option value="juridica">Jurídica</option>
        </select>
        <input type="text" id="tercero-identificacion" placeholder="Identificación" required>
        <input type="text" id="tercero-nombre" placeholder="Nombre" required>
        <input type="email" id="tercero-email" placeholder="Correo (opcional)">
        <input type="text" id="tercero-celular" placeholder="Celular (opcional)">
        <input type="text" id="tercero-direccion" placeholder="Dirección (opcional)">
        <input type="text" id="tercero-departamento" placeholder="Departamento (opcional)">
        <input type="text" id="tercero-municipio" placeholder="Municipio (opcional)">
        <select id="tercero-regimen-iva">
          <option value="">Régimen de IVA...</option>
          <option value="responsable">Responsable de IVA</option>
          <option value="no_responsable">No responsable de IVA</option>
        </select>
        <select id="tercero-cuenta-tipo">
          <option value="">Tipo de cuenta...</option>
          <option value="ahorros">Ahorros</option>
          <option value="corriente">Corriente</option>
        </select>
        <input type="text" id="tercero-cuenta-banco" placeholder="Banco (opcional)">
        <input type="text" id="tercero-cuenta-numero" placeholder="No. cuenta (opcional)">
        <fieldset class="fieldset-responsabilidades">
          <legend>Responsabilidad fiscal (marca las que apliquen)</legend>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-13"> O-13 Gran contribuyente</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-15"> O-15 Autorretenedor</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-23"> O-23 Agente de retención IVA</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-47"> O-47 Régimen simple de tributación</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="R-99-PN"> R-99-PN No aplica - Otros</label>
        </fieldset>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-tercero">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-terceros"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-proyectos" class="panel" hidden>
      <header class="panel-header">
        <h2>Proyectos</h2>
        <button class="btn-primario" id="btn-nuevo-proyecto">+ Nuevo proyecto</button>
      </header>
      <p class="nota-panel">Contratos, negocios o proyectos de la empresa — se usan como "Proyecto / Unidad de Negocio" en Órdenes de Adquisición, y están pensados para servir como centro de costo contable más adelante.</p>
      <form id="form-proyecto" class="form-inline" hidden>
        <input type="text" id="proyecto-nombre" placeholder="Nombre del proyecto/contrato" required>
        <input type="text" id="proyecto-codigo" placeholder="ID del proyecto (centro de costo)">
        <select id="proyecto-contratante"></select>
        <input type="number" id="proyecto-valor-total" placeholder="Valor total" min="0">
        <input type="text" id="proyecto-objeto" placeholder="Objeto del proyecto (opcional)">
        <label class="check-aiu">
          <input type="checkbox" id="proyecto-activo" checked> Activo (aparece en el selector de las órdenes)
        </label>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-proyecto">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-proyectos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-cotizaciones" class="panel" hidden>
      <header class="panel-header">
        <h2>Cotizaciones</h2>
        <button class="btn-primario" id="btn-nueva-cotizacion">+ Nueva cotización</button>
      </header>
      <form id="form-cotizacion" class="form-grande" hidden>
        <div class="fila-campos">
          <select id="cotizacion-tercero" required></select>
          <label class="campo-etiquetado">
            <span>Vigente hasta</span>
            <input type="date" id="cotizacion-vencimiento" required>
          </label>
          <input type="text" id="cotizacion-forma-pago" placeholder="Forma de pago (opcional)">
          <input type="text" id="cotizacion-observaciones" placeholder="Observaciones (opcional)">
          <input type="text" id="cotizacion-contacto-nombre" placeholder="Persona de contacto (opcional)">
          <input type="text" id="cotizacion-contacto-telefono" placeholder="Teléfono de contacto (opcional)">
        </div>

        <div class="bloque-items">
          <div class="bloque-items-header">
            <h4>Ítems cotizados</h4>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-item-cotizacion">+ Agregar ítem</button>
          </div>
          <table class="tabla-items">
            <thead>
              <tr><th>Concepto</th><th>Cantidad</th><th>UM</th><th class="num">Valor unitario</th><th>Impuesto</th><th class="num">Total</th><th></th></tr>
            </thead>
            <tbody id="items-cotizacion-tbody"></tbody>
          </table>
        </div>

        <label class="check-aiu">
          <input type="checkbox" id="cotizacion-aplica-aiu"> ¿Aplica AIU? (Administración, Imprevistos, Utilidad — contratos de obra/servicios)
        </label>
        <div class="fila-campos" id="campos-aiu" hidden>
          <label class="campo-aiu">
            <span>Administración %</span>
            <input type="number" id="cotizacion-aiu-administracion" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-administracion">$0</span>
          </label>
          <label class="campo-aiu">
            <span>Imprevistos %</span>
            <input type="number" id="cotizacion-aiu-imprevistos" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-imprevistos">$0</span>
          </label>
          <label class="campo-aiu">
            <span>Utilidad %</span>
            <input type="number" id="cotizacion-aiu-utilidad" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-utilidad">$0</span>
          </label>
        </div>

        <div class="resumen-totales">
          <span>Subtotal: <strong id="resumen-subtotal">$0</strong></span>
          <span>IVA: <strong id="resumen-iva">$0</strong></span>
          <span>Total: <strong id="resumen-total">$0</strong></span>
        </div>

        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar</button>
          <button type="button" class="btn-secundario" id="btn-cancelar-cotizacion">Cancelar</button>
        </div>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-cotizaciones"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-venta" class="panel" hidden>
      <header class="panel-header">
        <h2>Facturas de venta</h2>
        <button class="btn-primario" id="btn-cargar-venta-xml">+ Cargar factura emitida (XML)</button>
      </header>
      <p class="nota-panel">Las facturas se expiden en Siigo. Aquí cargas el XML (o el .zip) que te entrega Siigo: se lee, se revisa y recién ahí se contabiliza. Si el cliente tenía una cotización aceptada, la factura se vincula y la cotización queda “facturada”.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-venta"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-ordenes" class="panel" hidden>
      <header class="panel-header">
        <h2>Órdenes de adquisición</h2>
        <button class="btn-primario" id="btn-nueva-orden">+ Nueva orden</button>
      </header>
      <form id="form-orden" class="form-grande" hidden>
        <div class="fila-campos">
          <select id="orden-tercero" required></select>
          <select id="orden-tipo">
            <option value="bienes">Bienes</option>
            <option value="servicios">Servicios</option>
          </select>
          <select id="orden-proyecto-id">
            <option value="">Proyecto / Unidad de negocio (ID)...</option>
          </select>
          <input type="text" id="orden-lugar-entrega" placeholder="Lugar de entrega (opcional)">
          <input type="text" id="orden-forma-pago" placeholder="Forma de pago (opcional)">
        </div>

        <div class="bloque-items">
          <div class="bloque-items-header">
            <h4>Ítems de la orden</h4>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-item-orden">+ Agregar ítem</button>
          </div>
          <table class="tabla-items">
            <thead>
              <tr><th>Concepto</th><th>Cantidad</th><th>UM</th><th class="num">Valor unitario</th><th>Impuesto</th><th class="num">Total</th><th></th></tr>
            </thead>
            <tbody id="items-orden-tbody"></tbody>
          </table>
        </div>

        <div id="bloque-aiu-orden" hidden>
          <label class="check-aiu">
            <input type="checkbox" id="orden-aplica-aiu"> Discriminar AIU (Administración, Imprevistos, Utilidad) — solo compra de servicios
          </label>
          <div class="fila-campos" id="campos-aiu-orden" hidden>
            <label class="campo-aiu">
              <span>Administración %</span>
              <input type="number" id="orden-aiu-administracion" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-administracion">$0</span>
            </label>
            <label class="campo-aiu">
              <span>Imprevistos %</span>
              <input type="number" id="orden-aiu-imprevistos" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-imprevistos">$0</span>
            </label>
            <label class="campo-aiu">
              <span>Utilidad %</span>
              <input type="number" id="orden-aiu-utilidad" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-utilidad">$0</span>
            </label>
            <label class="campo-aiu">
              <span>IVA se calcula sobre</span>
              <select id="orden-aiu-base-iva">
                <option value="total">Subtotal + AIU</option>
                <option value="utilidad">Solo la Utilidad</option>
              </select>
            </label>
          </div>
        </div>

        <fieldset class="bloque-retencion" id="bloque-retencion-orden">
          <legend>Retención en la fuente (informativa para el proveedor)</legend>
          <div class="opciones-retencion">
            <label><input type="radio" name="orden-retencion-modo" value="ninguna" checked> No indicar retención</label>
            <label><input type="radio" name="orden-retencion-modo" value="aplica"> Aplicar retención</label>
            <label><input type="radio" name="orden-retencion-modo" value="no_aplica"> No aplica retención</label>
          </div>

          <div id="retencion-aplica-orden" hidden>
            <table class="tabla-items">
              <thead>
                <tr><th>Concepto (tipo de bien o servicio)</th><th>Tarifa</th><th class="num">Base</th><th class="num">Tope mínimo</th><th class="num">Retención</th><th></th></tr>
              </thead>
              <tbody id="retenciones-orden-tbody"></tbody>
            </table>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-retencion-orden">+ Agregar concepto de retención</button>
            <p class="nota-aiu" id="nota-retencion-orden"></p>
          </div>

          <div id="retencion-no-aplica-orden" class="fila-campos" hidden>
            <label class="campo-aiu">
              <span>Motivo</span>
              <select id="orden-retencion-motivo"></select>
            </label>
            <label class="campo-aiu campo-ancho">
              <span>Detalle (opcional)</span>
              <input type="text" id="orden-retencion-detalle" maxlength="255" placeholder="Ej.: certificado RST vigente, resolución, etc.">
            </label>
          </div>
        </fieldset>

        <div class="resumen-totales">
          <span>Subtotal: <strong id="resumen-subtotal-orden">$0</strong></span>
          <span id="resumen-aiu-orden-fila" hidden>AIU: <strong id="resumen-aiu-orden">$0</strong></span>
          <span>IVA: <strong id="resumen-iva-orden">$0</strong></span>
          <span>Impoconsumo: <strong id="resumen-impoconsumo-orden">$0</strong></span>
          <span>Total: <strong id="resumen-total-orden">$0</strong></span>
          <span id="resumen-retencion-orden-fila" hidden>Retención en la fuente: <strong id="resumen-retencion-orden">$0</strong></span>
          <span id="resumen-neto-orden-fila" hidden>Valor a consignar al proveedor: <strong id="resumen-neto-orden">$0</strong></span>
        </div>

        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar</button>
          <button type="button" class="btn-secundario" id="btn-cancelar-orden">Cancelar</button>
        </div>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-ordenes"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-compra" class="panel" hidden>
      <header class="panel-header">
        <h2>Facturas de compra</h2>
        <button class="btn-primario" id="btn-cargar-factura-xml">+ Cargar factura (XML)</button>
      </header>
      <p class="nota-panel">Carga el XML que te envía el proveedor (o el .zip completo): se lee, se revisa y recién ahí se contabiliza. También se generan al convertir una orden aprobada o llegan por webhook del proveedor tecnológico.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-compra"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-documentos-soporte" class="panel" hidden>
      <header class="panel-header">
        <h2>Documentos soporte</h2>
        <button class="btn-primario" id="btn-registrar-ds">+ Registrar documento soporte</button>
      </header>
      <p class="nota-panel">Compras a personas o empresas que no están obligadas a facturar. El documento se expide en Siigo (que solo entrega el PDF): aquí lo registras con sus datos y el PDF queda como soporte; se contabiliza con la retención en la fuente que practicaste.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-documentos-soporte"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-nomina" class="panel" hidden>
      <header class="panel-header">
        <h2>Nómina</h2>
      </header>
      <nav id="nom-subtabs" class="subtabs" aria-label="Secciones de nómina"></nav>
      <div id="nom-contenido"></div>
    </section>

    <section id="panel-inventarios" class="panel" hidden>
      <header class="panel-header">
        <h2>Inventarios</h2>
      </header>
      <nav id="inv-subtabs" class="subtabs" aria-label="Secciones de inventarios"></nav>
      <div id="inv-contenido"></div>
    </section>

    <section id="panel-activos-fijos" class="panel" hidden>
      <header class="panel-header">
        <h2>Activos fijos</h2>
        <div class="acciones-header">
          <button class="btn-secundario" id="btn-depreciar">Correr depreciación del mes</button>
          <button class="btn-primario" id="btn-nuevo-activo">+ Nuevo activo</button>
        </div>
      </header>
      <form id="form-activo" class="form-inline" hidden>
        <input type="text" id="activo-nombre" placeholder="Nombre" required>
        <input type="number" id="activo-costo" placeholder="Costo" required min="0">
        <input type="number" id="activo-vida-util" placeholder="Vida útil (meses)" required min="1">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-activo">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-activos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-tesoreria" class="panel" hidden>
      <header class="panel-header"><h2>Tesorería</h2></header>

      <div class="subseccion-header">
        <h3 class="subseccion">Cruce de pagos</h3>
      </div>
      <p class="nota-panel">Cartera por pagar y por cobrar: registra cada pago o recaudo contra la factura, el documento soporte o la factura de venta que cancela (completo o por abonos). Queda contabilizado, con su movimiento bancario, y el saldo de cada documento se actualiza.</p>
      <div id="tes-cruce">
        <nav id="tes-subtabs" class="subtabs" aria-label="Secciones del cruce de pagos"></nav>
        <div id="tes-contenido"></div>
      </div>

      <div class="subseccion-header">
        <h3 class="subseccion">Cuentas bancarias</h3>
        <button class="btn-primario btn-chico" id="btn-nueva-cuenta">+ Nueva cuenta</button>
      </div>
      <p class="nota-panel">Cada cuenta bancaria se contabiliza en su propio auxiliar del plan de cuentas (11100501, 11100502…), dentro de 1110 Bancos. Con el NIT del banco queda además como tercero en los movimientos.</p>
      <form id="form-cuenta" class="form-inline" hidden>
        <input type="text" id="cuenta-banco" placeholder="Banco" required maxlength="100">
        <select id="cuenta-tipo" aria-label="Tipo de cuenta">
          <option value="corriente">Corriente</option>
          <option value="ahorros">Ahorros</option>
        </select>
        <input type="text" id="cuenta-numero" placeholder="Número de cuenta" required maxlength="30">
        <input type="text" id="cuenta-nit" placeholder="NIT del banco (opcional)" maxlength="20">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-cuenta">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-cuentas"><thead></thead><tbody></tbody></table>
      </div>

      <div class="subseccion-header">
        <h3 class="subseccion">Movimientos</h3>
        <button class="btn-primario btn-chico" id="btn-nuevo-movimiento">+ Nuevo movimiento</button>
      </div>
      <form id="form-movimiento" class="form-inline" hidden>
        <select id="movimiento-cuenta" required></select>
        <select id="movimiento-tipo">
          <option value="ingreso">Ingreso</option>
          <option value="egreso">Egreso</option>
          <option value="comision">Comisión</option>
        </select>
        <input type="number" id="movimiento-valor" placeholder="Valor" required min="0">
        <input type="text" id="movimiento-descripcion" placeholder="Descripción (opcional)">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-movimiento">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-movimientos-bancarios"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-mi-empresa" class="panel" hidden>
      <header class="panel-header"><h2>Mi Empresa</h2></header>
      <div class="subtabs" role="tablist" aria-label="Configuración de la empresa">
        <button type="button" class="subtab activo" role="tab" data-subtab="datos" aria-selected="true">Datos de la empresa</button>
        <button type="button" class="subtab" role="tab" data-subtab="plan" aria-selected="false">Plan de cuentas</button>
        <button type="button" class="subtab" role="tab" data-subtab="usuarios" aria-selected="false" id="subtab-usuarios" hidden>Usuarios</button>
      </div>

      <div id="mi-empresa-sub-datos">
      <p class="nota-panel">Estos datos aparecen en el encabezado de las cotizaciones y órdenes de adquisición en PDF.</p>
      <form id="form-mi-empresa" class="form-grande">
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Razón social</span>
            <input type="text" id="miempresa-razon-social" required>
          </label>
          <label class="campo-etiquetado">
            <span>NIT</span>
            <input type="text" id="miempresa-nit" required>
          </label>
          <label class="campo-etiquetado">
            <span>Régimen tributario</span>
            <select id="miempresa-regimen">
              <option value="ordinario">Ordinario</option>
              <option value="rst">Régimen Simple (RST)</option>
              <option value="especial">Régimen Tributario Especial</option>
            </select>
          </label>
          <label class="check-aiu">
            <input type="checkbox" id="miempresa-responsable-iva"> Responsable de IVA
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Correo electrónico</span>
            <input type="email" id="miempresa-email">
          </label>
          <label class="campo-etiquetado">
            <span>Teléfono de contacto</span>
            <input type="text" id="miempresa-telefono">
          </label>
          <label class="campo-etiquetado">
            <span>Dirección</span>
            <input type="text" id="miempresa-direccion">
          </label>
          <label class="campo-etiquetado">
            <span>Departamento</span>
            <input type="text" id="miempresa-departamento">
          </label>
          <label class="campo-etiquetado">
            <span>Municipio</span>
            <input type="text" id="miempresa-municipio">
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Representante legal</span>
            <input type="text" id="miempresa-representante-nombre">
          </label>
          <label class="campo-etiquetado">
            <span>Documento del representante legal</span>
            <input type="text" id="miempresa-representante-documento">
          </label>
          <label class="campo-etiquetado">
            <span>Código CIIU</span>
            <input type="text" id="miempresa-ciiu">
          </label>
          <label class="campo-etiquetado">
            <span>Matrícula mercantil</span>
            <input type="text" id="miempresa-matricula">
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Logo</span>
            <input type="file" id="miempresa-logo" accept="image/png, image/jpeg, image/svg+xml">
          </label>
          <img id="miempresa-logo-vista-previa" class="logo-vista-previa" hidden>
        </div>
        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar cambios</button>
        </div>
        <p id="miempresa-resultado" class="mensaje-exito" hidden></p>
      </form>
      </div>

      <div id="mi-empresa-sub-usuarios" hidden>
        <p class="nota-panel">Las personas que entran a la empresa y lo que pueden hacer. <strong>Dueño</strong> y <strong>contador</strong> administran todo (el contador no modifica al dueño); el <strong>auxiliar</strong> registra operaciones del día a día (no ve la nómina ni anula); el <strong>revisor</strong> solo consulta. Quien deja de trabajar con ustedes se desactiva: no se borra, para conservar el rastro de lo que hizo.</p>
        <div class="subseccion-header">
          <h3 class="subseccion">Usuarios</h3>
          <button type="button" class="btn-primario btn-chico" id="btn-usuario-nuevo">+ Nuevo usuario</button>
        </div>
        <div class="tabla-envoltorio">
          <table id="tabla-usuarios"><thead></thead><tbody></tbody></table>
        </div>
      </div>

      <div id="mi-empresa-sub-plan" hidden>
        <p class="nota-panel">
          Las cuentas donde se contabilizan tus compras, ventas y demás operaciones. Usamos los códigos del PUC
          (4 dígitos para la cuenta, 6 para una subcuenta, 8 para un auxiliar), que son los que reconocen contadores, bancos y la DIAN.
          Una cuenta que ya tiene movimientos no se borra: se desactiva.
        </p>
        <div class="plan-barra">
          <button type="button" class="btn-primario" id="btn-plan-nueva">+ Crear cuenta</button>
          <button type="button" class="btn-secundario" id="btn-plan-catalogo">Catálogo de cuentas comunes</button>
          <input type="search" id="plan-filtro" placeholder="Buscar por código o nombre" aria-label="Buscar cuenta">
          <label class="check-aiu"><input type="checkbox" id="plan-ver-inactivas"> Mostrar inactivas</label>
        </div>
        <p id="plan-resultado" class="mensaje-exito" hidden></p>

        <div id="plan-catalogo" class="plan-catalogo" hidden>
          <div class="plan-catalogo-cab">
            <h3>Catálogo de cuentas comunes</h3>
            <p>Pocas cuentas, las que usa una mipyme de servicios o comercio. Marca las que necesites y actívalas; es una guía, confirma con tu contador la cuenta que corresponde a tu actividad.</p>
            <div class="fila-botones">
              <button type="button" class="btn-secundario" id="btn-plan-recomendadas">Marcar las recomendadas</button>
              <button type="button" class="btn-primario" id="btn-plan-activar" disabled>Activar seleccionadas</button>
              <button type="button" class="btn-secundario" id="btn-plan-cerrar-catalogo">Cerrar</button>
            </div>
          </div>
          <div id="plan-catalogo-lista"></div>
        </div>

        <div class="tabla-envoltorio">
          <table id="tabla-plan-cuentas">
            <thead><tr><th>Código</th><th>Nombre</th><th>Tipo</th><th>Origen</th><th>Movimientos</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <!-- Carga de la factura de compra desde el XML del proveedor -->
  <dialog id="dialogo-factura-xml" class="dialogo-factura" aria-labelledby="titulo-factura-xml">
    <div class="dialogo-cabecera">
      <h3 id="titulo-factura-xml">Cargar factura de compra (XML)</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-factura-xml" aria-label="Cerrar">×</button>
    </div>

    <div class="dialogo-cuerpo">
      <div id="fx-paso-archivo">
        <label class="zona-archivo" id="fx-zona-archivo">
          <input type="file" id="fx-archivo" accept=".xml,.zip,application/xml,text/xml,application/zip">
          <strong>Elige el XML de la factura</strong>
          <span>o arrástralo hasta aquí. También sirve el .zip que envía el proveedor.</span>
        </label>
        <p class="nota-aiu" id="fx-estado-lectura"></p>
      </div>

      <div id="fx-revision" hidden>
        <div id="fx-advertencias"></div>

        <div id="fx-resumen" class="fx-resumen"></div>

        <div class="fx-rejilla">
          <div class="fx-bloque">
            <h4>Proveedor</h4>
            <p id="fx-proveedor" class="fx-texto"></p>
            <label id="fx-crear-proveedor-fila" class="fx-check" hidden>
              <input type="checkbox" id="fx-crear-proveedor" checked>
              <span>Crear este proveedor en Terceros con los datos del XML</span>
            </label>
          </div>
          <div class="fx-bloque">
            <h4>Orden de adquisición</h4>
            <select id="fx-orden"></select>
            <p class="nota-aiu" id="fx-orden-nota"></p>
          </div>
          <div class="fx-bloque">
            <h4>Proyecto / centro de costo</h4>
            <select id="fx-proyecto"></select>
          </div>
        </div>

        <div class="fx-bloque fx-ancho">
          <div class="fx-titulo-con-accion">
            <h4>Detalle y destino contable</h4>
            <label class="fx-todas">
              <span>Llevar todo a:</span>
              <select id="fx-cuenta-todas"></select>
            </label>
          </div>
          <div class="tabla-envoltorio">
            <table class="tabla-items-detalle" id="fx-tabla-lineas">
              <thead>
                <tr><th>#</th><th>Descripción</th><th class="num">Cant.</th><th class="num">Valor</th><th class="num">IVA</th><th>Cuenta destino</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>

        <fieldset class="bloque-retencion" id="fx-bloque-retencion">
          <legend>Retención en la fuente que practicas</legend>
          <p class="nota-aiu" id="fx-retencion-sugerencia" hidden></p>
          <div class="opciones-retencion">
            <label><input type="radio" name="fx-retencion-modo" value="aplica"> Aplicar retención</label>
            <label><input type="radio" name="fx-retencion-modo" value="no_aplica"> No aplica retención</label>
          </div>

          <div id="fx-retencion-aplica" hidden>
            <table class="tabla-items">
              <thead>
                <tr><th>Concepto (tipo de bien o servicio)</th><th>Tarifa</th><th class="num">Base</th><th class="num">Tope mínimo</th><th class="num">Retención</th><th></th></tr>
              </thead>
              <tbody id="fx-retenciones-tbody"></tbody>
            </table>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-retencion-fx">+ Agregar concepto de retención</button>
            <label class="campo-aiu fx-aiu" id="fx-aiu-fila" hidden>
              <span>Valor del AIU de la factura (para conceptos calculados sobre el AIU)</span>
              <input type="number" id="fx-aiu" min="0" step="0.01" placeholder="0">
            </label>
            <p class="nota-aiu" id="fx-nota-retencion"></p>
          </div>

          <div id="fx-retencion-no-aplica" class="fila-campos" hidden>
            <label class="campo-aiu">
              <span>Motivo</span>
              <select id="fx-retencion-motivo"></select>
            </label>
            <label class="campo-aiu campo-ancho">
              <span>Detalle (opcional)</span>
              <input type="text" id="fx-retencion-detalle" maxlength="255" placeholder="Ej.: certificado RST vigente, resolución, etc.">
            </label>
          </div>
        </fieldset>

        <div class="fx-bloque fx-ancho">
          <h4>Asiento que se va a contabilizar</h4>
          <div class="tabla-envoltorio">
            <table class="tabla-items-detalle" id="fx-tabla-asiento">
              <thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead>
              <tbody></tbody>
              <tfoot></tfoot>
            </table>
          </div>
          <div class="resumen-totales" id="fx-totales"></div>
        </div>

        <label id="fx-aceptar-fila" class="fx-check fx-aceptar" hidden>
          <input type="checkbox" id="fx-aceptar">
          <span>Revisé las advertencias de arriba y quiero registrar la factura de todos modos</span>
        </label>
      </div>
    </div>

    <div class="dialogo-pie">
      <p class="fx-error" id="fx-error" hidden></p>
      <span class="fx-ayuda" id="fx-ayuda"></span>
      <button type="button" class="btn-secundario" id="btn-cancelar-factura-xml">Cancelar</button>
      <button type="button" class="btn-primario" id="btn-registrar-factura-xml" disabled>Registrar y contabilizar</button>
    </div>
  </dialog>

  <!-- Carga de una factura de venta desde el XML que expide Siigo -->
  <dialog id="dialogo-venta-xml" class="dialogo-factura" aria-labelledby="titulo-venta-xml">
    <div class="dialogo-cabecera">
      <h3 id="titulo-venta-xml">Cargar factura de venta (XML)</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-venta-xml" aria-label="Cerrar">×</button>
    </div>

    <div class="dialogo-cuerpo">
      <div id="vx-paso-archivo">
        <label class="zona-archivo" id="vx-zona-archivo">
          <input type="file" id="vx-archivo" accept=".xml,.zip,application/xml,text/xml,application/zip">
          <strong>Elige el XML de la factura</strong>
          <span>o arrástralo hasta aquí. También sirve el .zip que descargas de Siigo.</span>
        </label>
        <p class="nota-aiu" id="vx-estado-lectura"></p>
      </div>

      <div id="vx-revision" hidden>
        <div id="vx-advertencias"></div>

        <div id="vx-resumen" class="fx-resumen"></div>

        <div class="fx-rejilla">
          <div class="fx-bloque">
            <h4>Cliente</h4>
            <p id="vx-cliente" class="fx-texto"></p>
            <label id="vx-crear-cliente-fila" class="fx-check" hidden>
              <input type="checkbox" id="vx-crear-cliente" checked>
              <span>Crear este cliente en Terceros con los datos del XML</span>
            </label>
          </div>
          <div class="fx-bloque">
            <h4>Cotización</h4>
            <select id="vx-cotizacion"></select>
            <p class="nota-aiu" id="vx-cotizacion-nota"></p>
          </div>
          <div class="fx-bloque">
            <h4>Proyecto / centro de costo</h4>
            <select id="vx-proyecto"></select>
          </div>
        </div>

        <div class="fx-bloque fx-ancho">
          <div class="fx-titulo-con-accion">
            <h4>Detalle y cuenta de ingreso</h4>
            <label class="fx-todas">
              <span>Llevar todo a:</span>
              <select id="vx-cuenta-todas"></select>
            </label>
          </div>
          <div class="tabla-envoltorio">
            <table class="tabla-items-detalle" id="vx-tabla-lineas">
              <thead>
                <tr><th>#</th><th>Descripción</th><th class="num">Cant.</th><th class="num">Valor</th><th class="num">IVA</th><th>Cuenta de ingreso</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>

        <div class="fx-bloque fx-ancho">
          <h4>Asiento que se va a contabilizar</h4>
          <div class="tabla-envoltorio">
            <table class="tabla-items-detalle" id="vx-tabla-asiento">
              <thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead>
              <tbody></tbody>
              <tfoot></tfoot>
            </table>
          </div>
          <div class="resumen-totales" id="vx-totales"></div>
          <p class="nota-aiu">Las retenciones que te practique el cliente se registran al recibir el pago.</p>
        </div>

        <label id="vx-aceptar-fila" class="fx-check fx-aceptar" hidden>
          <input type="checkbox" id="vx-aceptar">
          <span>Revisé las advertencias de arriba y quiero registrar la factura de todos modos</span>
        </label>
      </div>
    </div>

    <div class="dialogo-pie">
      <p class="fx-error" id="vx-error" hidden></p>
      <span class="fx-ayuda" id="vx-ayuda"></span>
      <button type="button" class="btn-secundario" id="btn-cancelar-venta-xml">Cancelar</button>
      <button type="button" class="btn-primario" id="btn-registrar-venta-xml" disabled>Registrar y contabilizar</button>
    </div>
  </dialog>

  <!-- Registro de un documento soporte expedido en Siigo (solo PDF) -->
  <dialog id="dialogo-ds" class="dialogo-factura" aria-labelledby="titulo-ds">
    <div class="dialogo-cabecera">
      <h3 id="titulo-ds">Registrar documento soporte</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-ds" aria-label="Cerrar">×</button>
    </div>

    <div class="dialogo-cuerpo">
      <div class="fila-campos">
        <label class="campo-etiquetado">
          <span>Número (como sale en Siigo)</span>
          <input type="text" id="ds-numero" maxlength="40" autocomplete="off" placeholder="Ej.: DS 44">
        </label>
        <label class="campo-etiquetado">
          <span>Fecha de compra</span>
          <input type="date" id="ds-fecha">
        </label>
        <label class="campo-etiquetado">
          <span>Condición de pago</span>
          <select id="ds-forma-pago">
            <option value="contado">Contado</option>
            <option value="credito">Crédito</option>
          </select>
        </label>
      </div>

      <div class="fx-rejilla">
        <div class="fx-bloque">
          <h4>Proveedor (no obligado a facturar)</h4>
          <label class="campo-etiquetado">
            <span>Cédula o NIT (con dígito de verificación si lo trae)</span>
            <input type="text" id="ds-nit" maxlength="20" autocomplete="off" placeholder="Ej.: 1.120.353.382-1">
          </label>
          <label class="campo-etiquetado">
            <span>Nombre</span>
            <input type="text" id="ds-nombre" maxlength="150" autocomplete="off">
          </label>
          <p class="nota-aiu" id="ds-proveedor-nota"></p>
        </div>
        <div class="fx-bloque">
          <h4>Proyecto / centro de costo</h4>
          <select id="ds-proyecto"></select>
          <h4>Soporte (PDF de Siigo)</h4>
          <input type="file" id="ds-pdf" accept=".pdf,application/pdf">
          <p class="nota-aiu" id="ds-pdf-nota">Opcional, pero recomendado: queda guardado con el documento.</p>
        </div>
      </div>

      <div class="fx-bloque fx-ancho">
        <div class="fx-titulo-con-accion">
          <h4>Lo que se compró</h4>
          <button type="button" class="btn-secundario btn-chico" id="btn-ds-agregar-linea">+ Agregar línea</button>
        </div>
        <div class="tabla-envoltorio">
          <table class="tabla-items-detalle" id="ds-tabla-lineas">
            <thead>
              <tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Vr. unitario</th><th class="num">Vr. total</th><th>Cuenta de gasto</th><th></th></tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <p class="nota-aiu">Un documento soporte no lleva IVA. Escribe el valor bruto, antes de la retención.</p>
      </div>

      <fieldset class="bloque-retencion">
        <legend>Retención en la fuente que practicas</legend>
        <div class="opciones-retencion">
          <label><input type="radio" name="ds-retencion-modo" value="aplica"> Aplicar retención</label>
          <label><input type="radio" name="ds-retencion-modo" value="no_aplica"> No aplica retención</label>
        </div>

        <div id="ds-retencion-aplica" hidden>
          <table class="tabla-items">
            <thead>
              <tr><th>Concepto (tipo de bien o servicio)</th><th>Tarifa</th><th class="num">Base</th><th class="num">Tope mínimo</th><th class="num">Retención</th><th></th></tr>
            </thead>
            <tbody id="ds-retenciones-tbody"></tbody>
          </table>
          <button type="button" class="btn-secundario btn-chico" id="btn-ds-agregar-retencion">+ Agregar concepto de retención</button>
          <p class="nota-aiu" id="ds-nota-retencion"></p>
        </div>

        <div id="ds-retencion-no-aplica" class="fila-campos" hidden>
          <label class="campo-aiu">
            <span>Motivo</span>
            <select id="ds-retencion-motivo"></select>
          </label>
          <label class="campo-aiu campo-ancho">
            <span>Detalle (opcional)</span>
            <input type="text" id="ds-retencion-detalle" maxlength="255" placeholder="Ej.: certificado RST vigente, resolución, etc.">
          </label>
        </div>
      </fieldset>

      <div class="fx-bloque fx-ancho">
        <h4>Asiento que se va a contabilizar</h4>
        <div class="tabla-envoltorio">
          <table class="tabla-items-detalle" id="ds-tabla-asiento">
            <thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead>
            <tbody></tbody>
            <tfoot></tfoot>
          </table>
        </div>
        <div class="resumen-totales" id="ds-totales"></div>
      </div>

      <label class="campo-etiquetado">
        <span>Observaciones (opcional)</span>
        <input type="text" id="ds-observaciones" maxlength="1000" autocomplete="off">
      </label>
    </div>

    <div class="dialogo-pie">
      <p class="fx-error" id="ds-error" hidden></p>
      <span class="fx-ayuda" id="ds-ayuda"></span>
      <button type="button" class="btn-secundario" id="btn-cancelar-ds">Cancelar</button>
      <button type="button" class="btn-primario" id="btn-guardar-ds" disabled>Registrar y contabilizar</button>
    </div>
  </dialog>

  <!-- Detalle de una factura de compra ya registrada -->
  <dialog id="dialogo-factura-detalle" class="dialogo-factura" aria-labelledby="titulo-factura-detalle">
    <div class="dialogo-cabecera">
      <h3 id="titulo-factura-detalle">Factura</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-factura-detalle" aria-label="Cerrar">×</button>
    </div>
    <div class="dialogo-cuerpo" id="fd-cuerpo"></div>
    <div class="dialogo-pie">
      <button type="button" class="btn-secundario" id="btn-xml-factura-detalle" hidden>Descargar XML</button>
      <button type="button" class="btn-primario" id="btn-listo-factura-detalle">Cerrar</button>
    </div>
  </dialog>

  <!-- Crear o renombrar una cuenta del plan -->
  <dialog id="dialogo-cuenta" class="dialogo-factura dialogo-chico" aria-labelledby="titulo-cuenta">
    <form id="form-dialogo-cuenta" novalidate>
      <div class="dialogo-cabecera">
        <h3 id="titulo-cuenta">Crear cuenta</h3>
        <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-cuenta" aria-label="Cerrar">×</button>
      </div>
      <div class="dialogo-cuerpo">
        <label class="campo-etiquetado" id="dc-catalogo-fila">
          <span>Elegir del catálogo (opcional)</span>
          <select id="dc-catalogo"></select>
        </label>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Código</span>
            <input type="text" id="dc-codigo" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="Ej.: 5135">
          </label>
          <label class="campo-etiquetado dc-nombre">
            <span>Nombre</span>
            <input type="text" id="dc-nombre" maxlength="100" autocomplete="off" placeholder="Ej.: Servicios públicos">
          </label>
        </div>
        <p id="dc-tipo" class="dc-tipo"></p>
        <p class="nota-aiu" id="dc-ayuda">4 dígitos para una cuenta (5135), 6 para una subcuenta (513525) y 8 para un auxiliar (51352505); cada nivel cuelga del anterior. El primer dígito define el tipo: 1 activo, 2 pasivo, 3 patrimonio, 4 ingreso, 5 gasto, 6 y 7 costos.</p>
      </div>
      <div class="dialogo-pie">
        <p class="fx-error" id="dc-error" hidden></p>
        <button type="button" class="btn-secundario" id="btn-dc-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario" id="btn-guardar-cuenta">Crear cuenta</button>
      </div>
    </form>
  </dialog>
  <!-- Diálogo genérico de nómina (contratos, novedades, pagos, desprendibles) -->
  <dialog id="dialogo-nom" class="dialogo-factura" aria-labelledby="titulo-nom">
    <div class="dialogo-cabecera">
      <h3 id="titulo-nom">Nómina</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-nom" aria-label="Cerrar">×</button>
    </div>
    <div class="dialogo-cuerpo" id="nom-dialogo-cuerpo"></div>
    <div class="dialogo-pie">
      <p class="fx-error" id="nom-dialogo-error" hidden></p>
      <span class="fx-ayuda" id="nom-dialogo-ayuda"></span>
      <span id="nom-dialogo-extra"></span>
      <button type="button" class="btn-secundario" id="btn-nom-cancelar">Cerrar</button>
      <button type="button" class="btn-primario" id="btn-nom-guardar">Guardar</button>
    </div>
  </dialog>
  <!-- Usuarios de la empresa: crear y restablecer contraseña -->
  <dialog id="dialogo-usuario" class="dialogo-factura dialogo-chico" aria-labelledby="titulo-usuario">
    <form id="form-dialogo-usuario" novalidate>
      <div class="dialogo-cabecera">
        <h3 id="titulo-usuario">Nuevo usuario</h3>
        <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-usuario" aria-label="Cerrar">×</button>
      </div>
      <div class="dialogo-cuerpo" id="usuario-dialogo-cuerpo"></div>
      <div class="dialogo-pie">
        <p class="fx-error" id="usuario-dialogo-error" hidden></p>
        <button type="button" class="btn-secundario" id="btn-usuario-cancelar">Cancelar</button>
        <button type="submit" class="btn-primario" id="btn-usuario-guardar">Guardar</button>
      </div>
    </form>
  </dialog>
  <!-- Diálogo del cruce de pagos de Tesorería -->
  <dialog id="dialogo-tes" class="dialogo-factura" aria-labelledby="titulo-tes">
    <div class="dialogo-cabecera">
      <h3 id="titulo-tes">Tesorería</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-tes" aria-label="Cerrar">×</button>
    </div>
    <div class="dialogo-cuerpo" id="tes-dialogo-cuerpo"></div>
    <div class="dialogo-pie">
      <p class="fx-error" id="tes-dialogo-error" hidden></p>
      <button type="button" class="btn-secundario" id="btn-tes-cancelar">Cerrar</button>
      <button type="button" class="btn-primario" id="btn-tes-guardar">Guardar</button>
    </div>
  </dialog>
  <!-- Diálogo genérico de inventarios (productos, movimientos, kardex) -->
  <dialog id="dialogo-inv" class="dialogo-factura" aria-labelledby="titulo-inv">
    <div class="dialogo-cabecera">
      <h3 id="titulo-inv">Inventarios</h3>
      <button type="button" class="btn-cerrar-dialogo" id="btn-cerrar-inv" aria-label="Cerrar">×</button>
    </div>
    <div class="dialogo-cuerpo" id="inv-dialogo-cuerpo"></div>
    <div class="dialogo-pie">
      <p class="fx-error" id="inv-dialogo-error" hidden></p>
      <span class="fx-ayuda" id="inv-dialogo-ayuda"></span>
      <span id="inv-dialogo-extra"></span>
      <button type="button" class="btn-secundario" id="btn-inv-cancelar">Cerrar</button>
      <button type="button" class="btn-primario" id="btn-inv-guardar">Guardar</button>
    </div>
  </dialog>
</div>

<!-- ?v=... evita que el navegador o el CDN sirvan una copia vieja de estos archivos: subir el valor cada vez que cambie alguno (ver README, "Caché de archivos estáticos") -->
<script src="/contable/retencionesCatalogo.js?v=20261113-3"></script>
<script src="/contable/calculoOrden.js?v=20261113-3"></script>
<script src="/contable/asientoCompra.js?v=20261113-3"></script>
<script src="/contable/asientoVenta.js?v=20261113-3"></script>
<script src="/contable/planCuentas.js?v=20261113-3"></script>
<script src="/contable/parametrosLaborales.js?v=20261113-3"></script>
<script src="/contable/liquidacionNomina.js?v=20261113-3"></script>
<script src="/contable/costeoInventario.js?v=20261113-3"></script>
<script src="/contable/asientoInventario.js?v=20261113-3"></script>
<script src="/contable/app.js?v=20261113-3"></script>
<script src="/contable/divipola.js?v=20261113-3"></script>
<script src="/contable/selectorLugar.js?v=20261113-3"></script>
<script src="/contable/nomina.js?v=20261113-3"></script>
<script src="/contable/nominaPrestaciones.js?v=20261113-3"></script>
<script src="/contable/asientoNomina.js?v=20261113-3"></script>
<script src="/contable/aportesContratistas.js?v=20261113-3"></script>
<script src="/contable/nominaContratistas.js?v=20261113-3"></script>
<script src="/contable/nominaAsopagos.js?v=20261113-3"></script>
<script src="/contable/inventarios.js?v=20261113-3"></script>
<script src="/contable/tesoreriaCruce.js?v=20261113-3"></script>
<script src="/contable/usuarios.js?v=20261113-3"></script>
</body>
</html>
SCRIPTEOF
echo "OK  public/contable/index.html"

cat > README.md << 'SCRIPTEOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
PostgreSQL en Supabase).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Página institucional de Libaniel Consulting (raíz del dominio)
├── style.css                  Estilos del sitio institucional
└── contable/                  El software contable en sí, en /contable
    ├── index.html                Login + tablero con pestañas por módulo
    ├── style.css                 Estética de libro contable (IBM Plex, reglas horizontales)
    └── app.js                    Login, consumo de la API, formularios y acciones por rol
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa (con logo), Tercero (persona natural/
│   │                           jurídica, ubicación, régimen y responsabilidades
│   │                           DIAN, cuenta bancaria), Proyecto (futuro centro
│   │                           de costo), PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario, Usuario, LogAuditoria
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       ├── cierrePeriodo.js    Máquina de estados del cierre mensual
│       ├── authService.js      Login, alta de usuarios y registro de empresas
│       ├── auditoria.js        Registro de acciones sensibles
│       ├── seedService.js      Datos base: empresa, periodo, cuentas, reglas
│       └── consecutivos.js     Numeración legible tipo COT-2026-0001 / ODA-2026-0001
├── modules/                  # Módulos operativos (capa transaccional) — TODOS completos
│   ├── ventas/                 Cotización → factura, patrón de referencia
│   ├── compras/                Factura recibida + documento soporte, orden de compra
│   ├── nomina/                 Contratos → liquidación mensual → contabilizar → pagar → planilla de aportes
│   ├── inventarios/            Productos, kardex a costo promedio, valoración; entradas/salidas desde las facturas
│   ├── activosFijos/           Registro, depreciación mensual (cron), baja
│   └── tesoreria/               Cuentas bancarias, movimientos, conciliación, cruce de pagos (cartera)
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
│   ├── depreciacionMensual.js  Implementado — recorre todas las empresas
│   └── vencimientoCotizaciones.js
├── middleware/                # authenticate + authorize por rol
└── routes/                   # Router raíz (auth, seed, terceros, y los 6 módulos)
```

## Aprovisionar una empresa nueva

Desde la pantalla de login, "¿Primera vez? Crear empresa y usuario" abre
un flujo de dos pasos: primero los datos de la empresa (razón social, NIT, régimen
tributario —ordinario, RST o especial—, responsable de IVA, correo, teléfono, dirección,
departamento, municipio, representante legal y su documento, código CIIU, matrícula
mercantil y logo) y luego su primer usuario (dueño o contador) con el **código de registro**.
Los dos se crean juntos en `POST /api/auth/registro-empresa`. `PATCH /api/empresas/:id` permite
editar estos datos después (solo dueño o contador, y solo la empresa propia). Ver «Roles y autenticación».

**Contabilidad base.** Una empresa recién creada no trae plan de cuentas,
reglas ni periodo contable. La primera vez que se carga una factura de
compra desde XML, el sistema le crea (solo si no tiene ninguna cuenta) las
24 cuentas base, las 13 reglas de contabilización y el periodo del mes en
curso, y lo avisa en la vista previa. Si la empresa ya tiene plan de
cuentas pero no un periodo abierto, solo se crea el periodo. Nunca se
modifica un plan ya armado. (`aprovisionarContabilidadBase` en
`seedService.js`.)

Al iniciar sesión, el panel **Inicio** (pestaña por defecto, ya no
Terceros) saluda por nombre, muestra la razón social de la empresa, y
presenta los nueve módulos como tarjetas — clic en cualquiera navega
directo a esa sección.

## Límite de tamaño del body JSON

`express.json()` ahora acepta hasta 5mb (antes, el default de Express
es 100kb). Lo necesita el logo de empresa, que se manda como base64
dentro del JSON — sin este cambio, cualquier imagen un poco pesada
hacía que la petición se rechazara antes de llegar a nuestro código,
con un error genérico ("Error inesperado") que no decía qué había
pasado de verdad. `api()` en el frontend ahora también reconoce un 413
específicamente y muestra un mensaje claro.

## Caché de archivos estáticos

`express.static` ahora manda `Cache-Control: no-cache` en todo lo que
sirve desde `public/` (HTML, CSS, JS). Antes de esto, durante una
etapa con despliegues tan frecuentes, era fácil que el navegador (o el
CDN de Hostinger) se quedara sirviendo una versión vieja de `app.js`
mientras el HTML ya estaba actualizado — un botón nuevo aparecía en
pantalla pero no hacía nada, porque el JavaScript que lo conectaba
seguía siendo el de antes. Si algo similar vuelve a pasar (un botón
nuevo no responde, pero el código se ve bien), lo primero a probar es
una recarga forzada (Ctrl+Shift+R) o una ventana de incógnito antes de
asumir que el código tiene un error real.

**Versión en la URL de los archivos (`?v=`)**: aun con `Cache-Control: no-cache`, el CDN de Hostinger o el
navegador pueden seguir entregando un `app.js` o `style.css` viejo con un `index.html` nuevo (pasó el
12/oct/2026: el formulario mostraba el bloque nuevo de retención pero el JS era el anterior, así que la
retención "no hacía nada"). Por eso `public/contable/index.html` pide los archivos con `?v=AAAAMMDD-n`.
**Cada vez que cambie `app.js`, `style.css`, `calculoOrden.js`, `asientoCompra.js`, `planCuentas.js` o `retencionesCatalogo.js`, subir ese valor
en `index.html`.** Para comprobar qué versión está sirviendo producción, abrir
`/contable/app.js?v=<valor>` y buscar un texto que solo exista en la versión nueva.

## Mi Empresa

Pestaña nueva en el tablero (al final del menú, como una sección de
configuración) donde se edita el perfil completo de la empresa —todos
los campos que ya existían en el registro inicial, incluido el logo—
usando `PATCH /api/empresas/:id`. Si no se elige un archivo nuevo al
guardar, el logo actual se conserva (no se borra por accidente).

### Plan de cuentas (subpestaña de Mi Empresa)

Mi Empresa tiene dos subpestañas: **Datos de la empresa** y **Plan de cuentas**.
La segunda lista las cuentas de la empresa (código, nombre, tipo, origen y
cantidad de movimientos) y permite:

- **Crear una cuenta** (`POST /api/plan-cuentas`): código de 4 dígitos (cuenta), 6
  (subcuenta) u 8 (auxiliar) y nombre. Cada nivel cuelga del anterior (el auxiliar
  51352505 necesita la subcuenta 513525, y esta la cuenta 5135). El tipo y la naturaleza se deducen del primer dígito
  (1 activo, 2 pasivo, 3 patrimonio, 4 ingreso, 5 gasto, 6 y 7 costos; 8 y 9 no
  se admiten). Las cuentas que restan del activo (1399, 1499, 1592, 1599, 1698,
  1699) son de naturaleza crédito, y una subcuenta o auxiliar hereda la de su padre
  (que debe existir y estar activo). El código no se cambia nunca.
- **Catálogo de cuentas comunes** (`GET /api/plan-cuentas/catalogo`,
  `POST /api/plan-cuentas/catalogo/activar`): unas 50 cuentas del PUC que usa una
  mipyme (gastos de administración y ventas, financieros, costos, inventarios y
  activos, ingresos, ICA/renta por pagar), con casillas y un botón "Marcar las
  recomendadas". Es una guía: la cuenta que corresponde a cada gasto depende de la
  actividad; confirmarla con el contador. Los nombres y códigos siguen el PUC
  (Decreto 2650 de 1993); el marco NIIF Grupo 3 no lo obliga, pero es el que
  reconocen contadores, bancos y la DIAN, y facilita la información exógena.
- **Renombrar, desactivar y reactivar** (`PATCH /api/plan-cuentas/:id`). Nada se
  borra. No se puede desactivar una cuenta esencial del sistema (1355, 2205, 2365,
  2367), una que use una regla de contabilización, la de una cuenta bancaria, ni una con subcuentas activas.
  Las cuentas inactivas no se ofrecen como destino de una compra.
- Solo **contador** y **dueño** pueden modificar el plan; los demás roles lo ven
  en solo lectura (el API responde 403). Cada cambio queda en `logs_auditoria`.

Desde la ventana de **factura de compra (XML)**, cada selector de "Cuenta destino"
(y "Llevar todo a") termina en **+ Crear cuenta nueva…**: abre el mismo diálogo (con
el catálogo de cuentas válidas para una compra) y deja la cuenta elegida en la
línea. Si se cancela, el selector vuelve a lo que tenía. Una cuenta que no sirve
como destino de compra (por ejemplo un pasivo) se rechaza.

Reglas compartidas navegador/backend en `public/contable/planCuentas.js`;
servicio en `src/core/services/planCuentasService.js`; rutas en
`src/routes/planCuentas.routes.js`. Las columnas nuevas `plan_cuentas.activa` y
`plan_cuentas.origen` ('sistema' | 'catalogo' | 'usuario') se crean solas con
`sync({ alter: true })`; las cuentas existentes quedan activas y con origen 'sistema'.

### Bancos: un auxiliar contable por cuenta bancaria

Como en los programas contables tradicionales, cada cuenta bancaria de Tesorería
tiene su propio auxiliar dentro de `1110 Bancos`:

```
1110      Bancos
 111005   Bancos moneda nacional        (subcuenta, se crea sola)
  11100501 Bancolombia · Ahorros ****8901   (auxiliar: uno por cuenta bancaria)
  11100502 Davivienda · Corriente ****5566
```

- Al registrar la cuenta bancaria (`POST /api/tesoreria/cuentas`: banco, tipo,
  número y, opcional, NIT del banco) se crea el auxiliar con el siguiente código
  libre (01 a 99). El número completo nunca va en el nombre: solo `****` y los
  últimos 4 dígitos.
- Con el NIT, el banco queda como **tercero** (tipo "otro"; si ya existe uno con ese
  NIT, con o sin dígito de verificación, se reutiliza) y se anota en los movimientos
  contables, para sacar el auxiliar por banco y por cuenta.
- La **comisión bancaria** conciliada se contabiliza `Db 5305 Gastos bancarios / Cr`
  auxiliar de ESA cuenta (el motor acepta `cuentaDebitoId`/`cuentaCreditoId`
  alternativas a las de la regla). Si no se puede contabilizar (por ejemplo no hay
  periodo abierto), el movimiento sigue pendiente de conciliar.
- Las cuentas bancarias registradas antes de este cambio reciben su auxiliar la primera
  vez que se listan. Los movimientos antiguos que ya estaban en 1110 no se reclasifican.
- El auxiliar de una cuenta bancaria no se puede desactivar mientras esa cuenta exista;
  sí se puede renombrar.
- Los pagos y recaudos que se cruzan con una factura (ver «Tesorería: cruce de pagos») y los pagos de
  nómina, prestaciones y planillas PILA se contabilizan contra el auxiliar de la cuenta elegida.
  Los movimientos que se digitan a mano y solo se «conciliar» siguen sin asiento (salvo la comisión);
  para contabilizarlos se cruzan con la factura que pagan. Ventas de contado siguen contra la regla genérica 1110.
  Código en `src/modules/tesoreria/services/contabilidadBancaria.js`.

### Tesorería: cruce de pagos

Cada pago a un proveedor y cada recaudo de un cliente se aplica a la factura, documento soporte o factura de
venta que cancela. Pestaña **Tesorería › Cruce de pagos** (`public/contable/tesoreriaCruce.js`).

- **Cartera:** *Por pagar* (facturas de compra, neto de retenciones, y documentos soporte, sobre 2205 / 2335) y
  *Por cobrar* (facturas de venta, sobre 1305), con valor, pagado, saldo, vencimiento, días vencidos y totales por
  edad (1–30, 31–60, 61–90, más de 90). Solo se puede pagar un documento con asiento contabilizado.
- **Pago / recaudo:** uno o varios documentos del mismo tercero a la vez, completo o por abonos. Asiento
  `Db 2205/2335 (tercero) / Cr banco (auxiliar de la cuenta) o caja 1105`; el recaudo es `Db banco o caja / Cr 1305`.
  Reglas `tesoreria_pago_proveedor` y `tesoreria_recaudo_cliente` (se crean al primer uso). Por banco crea el
  movimiento bancario (egreso/ingreso) o, si ya lo digitaste, **se enlaza uno existente** de la misma cuenta, tipo y
  valor (queda conciliado y cruzado). Botón «Cruzar con factura» en la tabla de movimientos.
- **Retenciones que nos practican los clientes:** al registrar un *recaudo* cada factura admite ReteFuente, ReteIVA y
  ReteICA (se digitan del certificado o del soporte de pago del cliente). El valor aplicado a la factura es el bruto
  (baja el saldo completo) y el banco o la caja reciben el bruto menos lo retenido. Asiento:
  `Db banco o caja (lo recibido) / Db 135515 ReteFuente / Db 135517 ReteIVA / Db 135518 ReteICA (con el cliente) / Cr 1305`.
  Las subcuentas 135515/135517/135518 se crean bajo 1355 la primera vez que se usan. Las retenciones deben ser menores que
  el valor cobrado; si el recaudo se cruza con un movimiento ya digitado, éste debe ser igual a lo recibido (no al bruto).
  Los pagos a proveedores no las aceptan (al proveedor se le retiene al causar la factura). Pestaña
  **Retenciones sufridas**: reporte por rango de fechas con totales y descarga CSV (`GET /api/tesoreria/retenciones-sufridas?desde&hasta`),
  sin contar recaudos anulados. SQL: `sql-retenciones-sufridas.sql` (columnas `retenciones` en `tesoreria_pagos` y
  `retefuente`/`reteiva`/`reteica` en `tesoreria_pago_aplicaciones`).
- **Estampillas, tasas y contribuciones de entidades públicas:** al cobrar a una entidad que descuenta
  estampillas (pro-cultura, pro-adulto mayor…), tasas o la contribución del 5 % de obra pública (según el estatuto de
  rentas local), cada factura admite «+ Estampilla, tasa o contribución»: concepto libre, valor y la cuenta de **gasto o
  costo** donde se registra (por defecto 5195; para la contribución de obra suele ser una cuenta de costo del contrato).
  **No son anticipo de impuestos** (no se descuentan en ninguna declaración), por eso no van a 1355: se reconocen al
  cobrar con `Db gasto/costo (con el cliente)` junto al resto del asiento del recaudo. Se guardan en
  `tesoreria_pago_aplicaciones.otros_descuentos` (JSON) y `tesoreria_pagos.otros_descuentos` (total); la pestaña
  **Retenciones sufridas** los muestra en tabla aparte con su propio CSV (`otros` en la respuesta del reporte). Solo en recaudos,
  máximo 10 por factura. Retenciones + descuentos deben ser menores que el valor cobrado.
- **Descuento de aportes de contratistas:** lo que el contratista asume de salud, pensión y ARL ya se causó contra
  2335/2205 al contabilizar el mes (Nómina › Contratistas); «Descuento de aportes» lo aplica al documento del
  contratista sin mover dinero ni crear otro asiento. Un mes con descuento aplicado no se puede reabrir hasta anularlo.
- **Anular** (contador o dueño, motivo de 10+ letras): anula el asiento, borra el movimiento que creó el pago (o
  libera el enlazado) y el documento recupera el saldo. No se anula si el movimiento ya está conciliado con el extracto
  ni si el período contable está cerrado.
- Tablas `tesoreria_pagos` y `tesoreria_pago_aplicaciones`; `movimientos_bancarios` gana `origen_modulo` /
  `origen_id` (nómina, prestaciones, PILA y planilla Y los llenan; nulo = digitado a mano). SQL: `sql-cruce-pagos-tesoreria.sql`.
- API (`/api/tesoreria`): `GET cartera?tipo=pagar|cobrar&todos=1`, `GET movimientos-libres`, `GET/POST pagos`,
  `POST pagos/:id/anular`, `GET documentos/:tipo/:id/pagos`, `GET descuentos-aportes?terceroId=`, `POST descuentos`.
- **Aún no:** anticipos a proveedores y de clientes, notas crédito y
  débito, pago de nómina/prestaciones desde aquí (siguen en su módulo), diferencias en cambio.

## Logo de empresa

`Empresa.logoBase64` guarda el logo como data URI (base64) directo en
la base de datos, no como archivo en disco — en el hosting de Node de
Hostinger un archivo subido podría perderse en un redeploy, así que
esto evita esa dependencia. Límite de 2MB desde el frontend. Aparece en
el encabezado de `cotizacion-imprimir.html` y `orden-imprimir.html`
cuando existe.

## Proyectos (futuro centro de costo)

Catálogo nuevo (`Proyecto`: nombre, código/ID del centro de costo,
objeto, contratante —referencia a Tercero—, valor total, activo) para
los contratos/negocios/proyectos de la empresa. Hoy se usa desde
Órdenes de Adquisición (`OrdenCompra.proyectoId`, con el campo de texto
viejo `proyecto` conservado solo por compatibilidad con órdenes
anteriores al catálogo). Pendiente real: conectarlo con
`Movimiento.centroCosto` (hoy sigue siendo texto libre) para que la
segmentación contable por proyecto sea automática, no solo informativa
en las órdenes.

## Orden de adquisición: impuestos, AIU y retención

El cálculo de totales vive en **un solo archivo**, `public/contable/calculoOrden.js`,
que usan tanto el navegador (vista previa mientras se digita y PDF) como el
backend (`compras.service.js`, con `require`). El servidor siempre recalcula al
guardar; nunca confía en totales que lleguen del cliente. Pruebas:
`node --test tests/calculoOrden.test.js` (incluye el caso real ODA-016-2026).

- **IVA e Impoconsumo** se discriminan por separado (`OrdenCompra.iva` / `.impoconsumo`).
- **AIU** (Administración, Imprevistos, Utilidad): solo en órdenes de *servicios*; cada % se
  calcula sobre el subtotal. IVA 19% sobre (subtotal + AIU), o solo sobre la Utilidad
  (`aiuBaseIva = 'utilidad'`). Con AIU se ignora el IVA individual de los ítems.
- **Retención en la fuente** (informativa para el proveedor; no se suma al total, se resta para
  dar el **neto a pagar**). Tres opciones por orden: *No indicar*, *Aplicar* o *No aplica*.
  - *Aplicar*: una o varias líneas; cada una se elige **manualmente** del catálogo 2026
    (`public/contable/retencionesCatalogo.js`, 48 conceptos tomados del Excel de la firma: tarifa,
    tope en UVT y sobre qué se aplica). Se puede combinar, p. ej., retefuente de servicios + ReteIVA.
    La base es subtotal + AIU antes de impuestos; los conceptos "sobre AIU" (temporales, vigilancia y
    aseo) usan solo el AIU y ReteIVA usa el valor del IVA. Si la base no alcanza el tope en UVT
    (medido por orden), esa línea no retiene. "Otro concepto" permite digitar la tarifa.
  - *No aplica*: exige motivo (Régimen Simple, tratamiento especial, no supera el tope, otro) y
    detalle opcional; se imprime en el PDF.
  - El servidor toma tarifas y topes **del catálogo** (el cliente solo manda el código) y guarda una
    **foto** de las líneas calculadas (`OrdenCompra.retenciones`), para que una orden vieja no
    cambie cuando se actualice el catálogo en otro año. Para cambiar de año: editar `ANIO`,
    `UVT_VALOR` y el arreglo de conceptos.
  - **Proyección de pago** en el PDF: valor total de la orden (impuestos incluidos), cada retención
    descontada con su tarifa y base, y el **valor que recibirá el proveedor en su cuenta**
    (con su cuenta bancaria si está registrada). Es solo informativa: la orden no genera asientos
    contables; el único asiento ocurre al convertirla en factura de compra y hoy usa el total
    bruto (la retención aún no se contabiliza).
  - UVT 2026 = $52.374 (Res. DIAN 000238/2025). El Excel traía la columna VALOR con 52.400; el
    sistema usa la oficial.
- Al convertir la orden en factura de compra, `subtotal = total − iva`, de modo que el
  Impoconsumo (no descontable) queda como mayor valor del costo y `subtotal + iva = total`.

## Factura de compra desde el XML del proveedor

En **Facturas de compra → "+ Cargar factura (XML)"** se abre una ventana para subir el archivo que envía
el proveedor. Acepta tres formas (la persona no tiene que saber cuál es cuál): el XML de la factura
(`<Invoice>`), el `AttachedDocument` que mandan la mayoría de proveedores tecnológicos (trae la factura
adentro más la respuesta de la DIAN) o el **.zip** completo. También se puede arrastrar el archivo.

Son dos pasos y **nada se guarda hasta confirmar**:

1. **Vista previa** — `POST /api/compras/facturas/xml/previsualizar`. El servidor lee el XML y devuelve
   lo que hay que revisar: número, fecha, CUFE (con enlace "Verificar en la DIAN"), proveedor, líneas,
   IVA/Impoconsumo, totales, si la DIAN la validó, las órdenes de adquisición candidatas y las advertencias.
2. **Registro** — `POST /api/compras/facturas/xml`. El servidor **vuelve a leer el XML** (no confía en lo que
   muestre el navegador), valida, guarda la factura y el asiento en **una sola transacción**.

Qué hace al leerla / registrarla:

- **Proveedor por NIT** (ignora el dígito de verificación). Si no existe en Terceros se crea con los datos
  del XML (nombre, tipo de persona, régimen de IVA, responsabilidades RUT, correo, teléfono, dirección).
- **Orden de adquisición**: propone las del proveedor aprobadas o recibidas (marca la que la factura cita en
  `OrderReference` o la que tiene el mismo valor). Al vincularla la orden pasa a `facturada`, hereda el
  proyecto (centro de costo) y precarga su retención; si el valor difiere, pide aceptar la advertencia.
- **Retención**: la decide la persona (no se toma del XML), con el mismo catálogo 2026 y las mismas reglas
  (topes en UVT, ReteIVA, "No aplica" con motivo) de la orden — comparten `calcularRetenciones` en
  `calculoOrden.js`. Es obligatorio decidir. Si el XML dice que el proveedor es de Régimen Simple (O-47) o
  autorretenedor (O-15) se **sugiere** "No aplica" con su motivo. La base es el valor antes de impuestos de la
  factura real, no el de la orden.
- **Cuenta destino por línea** (inventario, gasto, costo, activo). Por defecto: orden de bienes → cuenta de
  débito de la regla `factura_compra_con_orden` (1435); servicios o sin orden → la de `factura_compra_sin_orden`
  (5195). "Llevar todo a" aplica una cuenta a todas las líneas.
- **Asiento de varias líneas**, mostrado antes de confirmar y guardado idéntico (módulo compartido
  `public/contable/asientoCompra.js`, en centavos enteros para que cuadre siempre):

  ```
  Db  cuenta destino de cada línea (+ Impoconsumo y otros impuestos que no son IVA)
  Db  1355 IVA descontable        (solo si la empresa es responsable de IVA; si no, va al gasto)
  Cr  2365 Retención en la fuente por pagar
  Cr  2367 ReteIVA por pagar
  Cr  2205 Proveedores nacionales   = total − retenciones   (= "valor a pagar")
  ```
  Descuentos o cargos globales de la factura se reparten entre las líneas en proporción a su valor.
  Si la factura tiene proyecto, las líneas de débito llevan `Movimiento.centroCosto` = código del proyecto.
- El motor (`motorAsientos.contabilizarAsientoCompuesto`) respeta la **regla** del evento: `manual` registra la
  factura **sin** asiento (queda `pendiente`); `asistido` se contabiliza porque la vista previa ya es la
  revisión humana; `automatico` también. Si la fecha de la factura no cae en un periodo abierto, el asiento
  va al periodo vigente con la fecha de hoy y se avisa — nunca escribe en un periodo cerrado.
  Las cuentas 2365 y 2367 se crean solas si la empresa no las tiene (se agregaron al seed).
- **Bloqueos** (no deja registrar): CUFE ya registrado, mismo número del mismo proveedor con otro CUFE, nota
  crédito/débito o documento soporte, moneda distinta de COP, sin CUFE/fecha/NIT, la DIAN no la validó.
  **Por confirmar** (checkbox): factura a nombre de otro NIT, total que no coincide con la orden, XML con
  totales incoherentes, anticipos, CUFE con formato raro.
- El **XML original** queda guardado en `facturas_compra.xml_contenido` y se descarga desde el detalle
  (`GET /api/compras/facturas/:id/xml`). El listado no lo trae (pesa); el detalle
  (`GET /api/compras/facturas/:id`) devuelve el desglose y el asiento.

Seguridad: el archivo viene de un tercero. El lector (`src/integrations/dian/xmlMini.js`) no tiene
dependencias y **rechaza cualquier DOCTYPE/ENTITY** (sin XXE ni expansión de entidades), limita la
profundidad, limita el tamaño descomprimido de un ZIP, y el navegador escapa todo texto del XML antes de
mostrarlo. Pruebas: `node --test tests/facturaElectronica.test.js` (lector y datos), `tests/asientoCompra.test.js`
(asiento). Los archivos de ejemplo se generan con `tests/helpers/facturaDian.js` (datos ficticios).

Lo que **no** hace todavía: notas crédito/débito, facturas en moneda extranjera, cruce de anticipos, ni los
eventos RADIAN (acuse de recibo, recibo del bien, aceptación expresa) — ver pendientes.

### Facturas con AIU (Administración, Imprevistos, Utilidad)

En un contrato AIU el IVA se liquida solo sobre la Utilidad, así que la base gravable del XML es menor que el valor de las
líneas y «base + IVA» ya no da el total: el total es valor de las líneas + IVA. El lector
(`src/integrations/dian/facturaElectronica.js`) acepta los dos cuadres (ya no avisa un descuadre falso), detecta el AIU por el
tipo de operación 09 o por líneas llamadas Administración / Imprevistos / Utilidad, y lo explica con un aviso informativo y en
el resumen (contrato AIU, base gravable del IVA). El valor contable no cambia (base = total − IVA). Si el XML trae líneas A/I/U,
la suma de A+I+U precarga el campo «AIU» de la retención. Vale para la carga de facturas de compra y de venta.

## Factura de venta desde el XML de Siigo

Mientras no tengamos integración directa ni proveedor tecnológico propio, las facturas de venta se expiden
en **Siigo** (o el proveedor que tenga contratado la empresa) y aquí solo se **cargan y contabilizan**.
Facturas de venta → **+ Cargar factura emitida (XML)**: sirve el `.xml` o el `.zip` que descarga Siigo
(trae el `AttachedDocument` con la factura y la respuesta de la DIAN; se probó con una factura real).

- Dos pasos, como en compras: `POST /api/ventas/facturas/xml/previsualizar` (lee, no guarda) y
  `POST /api/ventas/facturas/xml` (vuelve a leer el archivo, valida, guarda y contabiliza en una
  transacción). Detalle: `GET /api/ventas/facturas/:id`; XML guardado: `GET /api/ventas/facturas/:id/xml`.
  Código: `src/modules/ventas/services/facturaVentaXml.service.js`; asiento compartido con el navegador en
  `public/contable/asientoVenta.js`.
- **Asiento**: Db 1305 Clientes (total) / Cr cuenta de ingreso por línea (base; por defecto la de la regla
  `factura_venta_credito`, se puede cambiar por línea o crear una nueva con "+ Crear cuenta nueva…") /
  Cr 2408 IVA por pagar. Siempre a crédito (1305): el recaudo se registra en Tesorería.
- **Cliente**: se busca por NIT en Terceros; si no existe se crea con los datos del XML (casilla de la pantalla).
- **Cotizaciones**: ya no se convierten en factura desde aquí (se quitó el botón). Al cargar el XML se puede
  vincular una cotización **aceptada** del mismo cliente (se sugiere la citada en el XML o la del mismo valor);
  queda `facturada`. Si el total difiere hay que confirmar.
- **Se bloquea** (con mensaje claro): que el emisor no sea la propia empresa (si es una factura de compra se
  indica que va en Facturas de compra; y al revés, Facturas de compra rechaza facturas propias), CUFE o número
  ya cargados, notas crédito/débito, e impuesto al consumo/otros impuestos distintos de IVA. Pide confirmar si
  la factura trae IVA y la empresa figura como no responsable de IVA.
- Empresa nueva sin plan de cuentas: se aprovisiona la contabilidad base igual que en compras.
- Pruebas: `node --test tests/asientoVenta.test.js`.

Lo que **no** hace todavía: retenciones que practica el cliente (se registrarán al recibir el pago, en
Tesorería), notas crédito/débito, impoconsumo en ventas, ni el
**documento soporte** (Siigo no entrega XML: se registra a mano, ver la sección siguiente).

## Documento soporte (compras a no obligados a facturar), expedido en Siigo

Siigo **solo entrega el PDF** del documento soporte (no hay XML), así que no se "carga": se **registra**.
Pestaña **Documentos soporte → + Registrar documento soporte**: se digita lo que dice el PDF (número como
sale en Siigo, fecha de compra, cédula/NIT y nombre del proveedor, qué se compró y cuánto, cuenta de gasto,
retención en la fuente) y se adjunta el PDF como soporte (opcional, hasta 3,5 MB; se valida que sea PDF).

- Código: `src/modules/compras/services/documentoSoporte.service.js`; rutas bajo `/api/compras/documentos-soporte`
  (`GET /opciones`, `GET /`, `POST /`, `GET /:id`, `GET /:id/pdf`). La tabla `documentos_soporte_adquisicion`
  (la misma del flujo de emisión con proveedor tecnológico) ganó columnas; `origen = 'registrado'` distingue estos.
- **Asiento** (mismo `asientoCompra.js` que la factura de compra, con `cuentaPorPagar: '2335'`):
  Db gasto/costo por línea (bruto) / Cr 2365 retención en la fuente / Cr **2335 Costos y gastos por pagar**
  (bruto − retención). Sin IVA. Ejemplo real (DS 44): 4.530.000 / 271.800 (6 %, servicios no declarantes) / 4.258.200.
- El proveedor se busca por cédula/NIT en Terceros (con o sin puntos y dígito de verificación); si no existe se
  crea como proveedor. El número del documento es único por empresa. No puede ser tu propia empresa ni tener fecha futura.
- Retención: mismo catálogo y reglas de tope en UVT que órdenes y facturas de compra. Solo conceptos sobre la base
  (no ReteIVA ni AIU). El concepto lo elige la persona; no se deduce solo de si el proveedor es declarante.
- Pruebas: `node --test tests/asientoCompra.test.js` (caso DS 44 incluido).

Lo que **no** hace todavía: leer el PDF automáticamente (se digita), IVA teórico/mayor valor, notas de ajuste
al documento soporte, ni retenciones o anticipos. El pago se registra en Tesorería › Cruce de pagos (Db 2335 / Cr banco o caja).
Cuando haya proveedor tecnológico propio, el flujo `POST /api/compras/documento-soporte` (emisión) sigue disponible.

## Nómina (NIIF Grupo 3, Colombia)

Pestaña **Nómina**: contratos, novedades, liquidación mensual, deducciones, provisiones de prestaciones,
contabilización, pago de salarios, planilla de aportes a seguridad social y (fase 2) prestaciones, vacaciones y liquidación final. La **nómina electrónica la sigue
emitiendo Siigo**; este módulo calcula, contabiliza y organiza lo de seguridad social (por eso se eliminó el
webhook/adaptador de nómina del proveedor tecnológico).

**Flujo:** Configuración (ARL, caja, exoneración art. 114-1) → Empleados y contratos → Novedades (ausencias y
conceptos del mes) → Liquidación mensual (borrador, recalculable) → **Contabilizar** (asientos de liquidación y
provisiones, fechados fin de mes) → **Pagar** (salarios por caja o banco) → Planilla de aportes (resumen + CSV).
Una nómina contabilizada puede **reabrirse** (solo si el período contable sigue abierto, con motivo; los asientos quedan `anulado`).

**Código:** cálculo en archivos compartidos navegador/servidor (`public/contable/`): `parametrosLaborales.js`
(parámetros 2023–2026, tarifas, festivos, jornada), `liquidacionNomina.js` (motor), `asientoNomina.js` (asientos).
Servicio en `src/modules/nomina/services/nomina.service.js`; rutas bajo `/api/nomina`. Pesos enteros; mes comercial de 30 días.
Pruebas: `node --test tests/parametrosLaborales.test.js tests/liquidacionNomina.test.js tests/asientoNomina.test.js`.

**Qué calcula:** sueldo por días; auxilio de transporte/conectividad (hasta 2 SMMLV); horas extras y recargos
(Ley 2466: dominical/festivo 80 % desde 1-jul-2025, 90 % desde 1-jul-2026, 100 % desde 1-jul-2027; jornada 42 h desde 15-jul-2026);
comisiones, bonificaciones y auxilios (salariales o no); salario integral (IBC 70 %); salud 4 %/8,5 %, pensión 4 %/12 %,
fondo de solidaridad pensional (desde 4 SMMLV), ARL por clase de riesgo, caja 4 %, SENA 2 %, ICBF 3 % (con exoneración);
IBC con mínimo 1 y máximo 25 SMMLV y regla del 40 % de pagos no salariales; incapacidad general (tramos y piso del SMMLV),
laboral, licencias de maternidad/paternidad, vacaciones y licencia no remunerada; préstamos, libranzas, embargos y aportes
voluntarios; retención en la fuente (art. 383 procedimiento 1, tabla en UVT); provisiones mensuales de cesantías, intereses,
prima y vacaciones. La liquidación guarda su cálculo completo: cambiar parámetros o el contrato después no altera una nómina ya contabilizada.

**Cuentas** (se crean solas la primera vez, con su cuenta padre): gastos 5105xx (administración) o 5205xx (ventas) según el área
del contrato; 2505 salarios por pagar y 2510/2515/2520/2525 prestaciones (por empleado como tercero); 236505 retención;
237005 EPS, 237006 ARL, 237010 caja/SENA/ICBF, 238030 pensiones, 237025/237030/237045/237095 descuentos; 1365 préstamos a empleados;
138095 incapacidades por cobrar a EPS/ARL. Reglas `nomina_liquidacion`, `nomina_provisiones` y `nomina_pago` se crean al primer uso.

**Planilla de aportes:** resumen por empleado y por entidad (EPS, AFP, ARL, CCF, SENA, ICBF) con novedades PILA
(ING, RET, VAC, IGE, IRL, LMA, SLN) y aproximación de cada aporte al múltiplo de 100 hacia arriba, como exige la PILA.
Se descarga en CSV (`;`, UTF-8 con BOM). El archivo que se carga en el operador (plano de ancho fijo) se genera aparte: ver *Nómina · fase 2*.

**Supuestos a validar con el contador antes de usar en producción:**
- ARL durante vacaciones se cotiza por los días trabajados + vacaciones.
- La licencia de maternidad no entra a la base de retención en la fuente.
- Licencia no remunerada (SLN): el módulo no calcula ningún aporte por esos días (en la práctica la pensión y la salud durante la SLN tienen reglas propias que conviene confirmar).
- Vacaciones: se provisionan sobre el salario sin horas extras (base/24) y las disfrutadas se descargan de 2525.
- La regla del 40 % se calcula sobre pagos no salariales sin contar el auxilio de transporte.
- La retención no aplica los 72 UVT adicionales de dependientes; los dependientes se capturan como deducción.
- Fechas y porcentajes de las Leyes 2466 de 2025 y 2101 de 2021 tal como están en `parametrosLaborales.js`; años sin parámetros usan el último con aviso "estimado".
- Los asientos `anulado` por una reapertura deben excluirse de los reportes que se construyan después.

### Nómina · fase 2: prestaciones, vacaciones, liquidación final y planilla PILA

Dos pestañas nuevas: **Prestaciones y liquidación** y **Vacaciones**; y en **Planilla de aportes** el pago de la planilla.

**Flujo de una prestación:** crear el documento (se calcula en *borrador*, con "Cálculo" que explica base, método, días y
provisión de cada empleado) → revisar → **Registrar el pago** (se recalcula con la fecha de pago, se contabiliza y queda un egreso
en Tesorería pendiente de conciliar) → si hay un error, **Anular el pago** (asiento y egreso quedan anulados y el documento se puede crear de nuevo).
Tipos: **prima** (por semestre), **cesantías** (año), **intereses** (año), **vacaciones en dinero** (un empleado) y **liquidación final** (un contrato).
Hay un único documento vigente por (tipo, año, semestre). Comprobante imprimible por empleado (`/contable/comprobante-prestaciones.html`).

**Código:** reglas en `public/contable/prestacionesNomina.js` (compartido; pruebas `tests/prestacionesNomina.test.js`), asientos en
`asientoNomina.js` (`armarAsientoPrestaciones`, `armarAsientoPagoPlanilla`), servicio `src/modules/nomina/services/prestaciones.service.js`,
pantallas `public/contable/nominaPrestaciones.js`. Tablas nuevas: `nomina_prestaciones`, `nomina_prestacion_lineas`, `nomina_planilla_pagos`;
columnas nuevas: `nomina_contratos.vacaciones_dias_previos` y `tipo_documento`, `nomina_config.semana_laboral`, `codigo_departamento`, `codigo_municipio` y `centro_trabajo`.
**Base de datos en producción:** el servidor solo hace `sync` cuando `NODE_ENV=development`, así que en producción las tablas y columnas nuevas hay que crearlas a mano en Supabase con el SQL de cada entrega (`sql-nomina-fase2.sql`, `sql-centros-trabajo.sql`, `sql-contratistas-planilla-y.sql`, `sql-cargues-asopagos.sql`); usan `IF NOT EXISTS` y se pueden correr más de una vez.

**Reglas aplicadas:**
- Año de 360 días. **Prima:** 30 días por año (semestres 1-ene a 30-jun y 1-jul a 31-dic). **Cesantías:** un mes por año. **Intereses:** cesantías × días × 12 % ÷ 360.
- Base: si el salario fijo no cambió, el último salario (+ auxilio de transporte si corresponde; en cesantías se mira la ventana de los últimos 3 meses, en prima todo el semestre); si hubo cambios o conceptos variables, promedio ponderado por días.
  Licencias no remuneradas y suspensiones descuentan días. El salario integral no genera prestaciones (no entra en los lotes).
- **Vacaciones:** 15 días hábiles por 360 días de servicio; valor del día = base ÷ 30; la base no incluye horas extras, recargos festivos ni auxilio de transporte.
  El saldo descuenta lo disfrutado (ausencias), lo pagado en dinero y los *días previos al sistema* del contrato. La semana laboral (5 o 6 días) se define en Configuración.
- **Indemnización (art. 64 CST)**, solo con causa "despido sin justa causa": indefinido con menos de 10 SMMLV, 30 días el primer año y 20 por cada año adicional (proporcional);
  10 SMMLV o más, 20 y 15; fijo u obra, lo que faltaba del contrato (mínimo 15 días). Sobre el salario sin auxilio. Los días se pueden fijar a mano.
- **Retención en la fuente** de prima, vacaciones, indemnización y otros pagos: retención del mes de pago con el pago − retención sin él (procedimiento 1). Cesantías e intereses se tratan como exentos (avisa si el salario supera 350 UVT).
- **Liquidación final:** liquida prima, cesantías, intereses y vacaciones pendientes + indemnización + otros pagos − descuentos. El sueldo de los días del mes de retiro va en la nómina de ese mes (el sistema avisa si falta o si hay nóminas posteriores al retiro). Al pagar, el contrato queda terminado en la fecha de retiro; al anular, vuelve a su estado anterior.

**Contabilidad del pago** (evento `nomina_prestaciones`): Db pasivo (2520 prima, 2510 cesantías, 2515 intereses, 2525 vacaciones; con el empleado como tercero) por el valor pagado;
si el valor supera la provisión que hay en el libro, la diferencia va a gasto (5105xx/5205xx con sufijos 36, 30, 33, 39) y si se liquida todo y sobra provisión, se libera contra el gasto;
indemnización a 510560/520560; otros pagos a 5105xx95; Cr 236505 retención, Cr descuentos (1365, 2370xx), Cr banco o caja. Saldo de provisión = movimientos del empleado en esa cuenta hasta el fin del mes de la fecha de corte.

**Planilla PILA:** en *Planilla de aportes* se registra el **pago de la planilla** (Db 237005/238030/237006/237010 por lo liquidado, Db 5105xx95 por la aproximación a múltiplos de 100, Db 530520 intereses de mora; Cr banco o caja; evento `nomina_planilla_pago`)
y se puede anular. Hay dos descargas: el **CSV de cargue** (una fila por empleado, para digitar o importar; separa los nombres con una regla simple, de tres palabras 1 nombre y 2 apellidos, y de cuatro 2 y 2: revisa los nombres compuestos) y el **archivo plano oficial (.txt)**.

**Archivo plano PILA (`PILA-E-AAAA-MM.txt`):** archivo tipo 2 del Anexo Técnico 2 (Resolución 2388 de 2016, versión 09), planilla **tipo E** de empleados.
Código en `public/contable/pilaArchivo.js` (pruebas `tests/pilaArchivo.test.js`, que verifican la posición inicial de los campos contra el anexo); se descarga con `GET /api/nomina/periodos/:id/planilla-pila.txt`.
- Registro tipo 1 (encabezado, 359 posiciones) y un registro tipo 2 (686 posiciones, 97 campos) por cotizante, con saltos CRLF, solo ASCII (nombres en mayúsculas, sin tildes; la Ñ pasa a N).
- Si en el mes hay **vacaciones, incapacidades, licencias o suspensiones** se genera una línea por cada novedad (con sus fechas y su IBC) y otra con los días ordinarios, como pide el numeral 2.1.2.2 del anexo; el sobrante de redondeo queda en la línea ordinaria, de modo que el total sea el mismo de la planilla del sistema.
- **Datos que se exigen antes de generar** (si falta alguno, la descarga muestra la lista completa): departamento y municipio (se eligen por nombre en Configuración y se guarda el código DANE: 2 y 3 dígitos), códigos de ARL y de caja (hasta 6 caracteres), NIT con dígito de verificación correcto, y por empleado: tipo de documento, código de EPS y de fondo de pensiones, primer nombre y primer apellido.
- **Centro de trabajo (campo 62):** cada contrato tiene el suyo; si no elige, se usa el centro principal de la empresa y, si la empresa no tiene centros creados, el valor `centro_trabajo` de la configuración (heredado de antes).
- Campos que asigna el operador y se dejan en cero o blanco: secuencia/número de radicación, fecha de pago y código del operador del encabezado.
- Período del encabezado: pensión, ARL y parafiscales = mes liquidado; salud = mes siguiente (regla del numeral 2.1.1.2.4 del anexo para planillas E). Se puede pedir el mismo mes con `?periodoSalud=mismo`.
- Supuestos de tipo: cotizante 01 (dependiente), subtipo 0, forma de presentación U (única), modalidad electrónica, tipo de aportante 01 (empleador), tarifas con punto decimal (`0.16000`; ARL en 9 posiciones, `0.0052200`).
- **No se probó con un operador real.** Si Aportes en Línea, SOI u otro rechaza el archivo, el mensaje exacto del operador permite ajustarlo. Puntos a vigilar: línea de suspensión (SLN) con IBC 0, días de ARL en incapacidades, y el período de salud.
- No reporta aportes voluntarios a pensión ni novedades de traslado, variación de salario (VSP/VST) o correcciones (planilla N); se avisa si el contrato tiene aporte voluntario.

**Departamento y municipio, y centros de trabajo (Nómina → Configuración):**
- El departamento y el municipio se escogen de una lista con búsqueda por nombre (sin tildes ni mayúsculas; flechas y Enter funcionan). Se guarda solo el código DANE. La lista oficial DIVIPOLA (33 departamentos, 1.122 municipios) está en `public/contable/divipola.js` y el selector en `public/contable/selectorLugar.js` (reutilizable en otras pantallas). El servidor valida que el municipio pertenezca al departamento.
- **Centros de trabajo (ARL):** una empresa puede tener varios (por línea de negocio o sede). Cada uno tiene el código que asigna la ARL, un nombre, una clase de riesgo opcional (sugerencia al elegirlo en un contrato), principal y activo. El primero es principal automáticamente; solo hay un principal; no se elimina uno que tenga contratos (se desactiva) ni el principal mientras haya otros. API: `GET/POST /api/nomina/centros-trabajo`, `PATCH/DELETE /api/nomina/centros-trabajo/:id`. Tabla `nomina_centros_trabajo` y columna `nomina_contratos.centro_trabajo_id` (ver `sql-centros-trabajo.sql`).

### Nómina · contratistas independientes (planilla Y)

Subpestaña **Nómina → Contratistas (planilla Y)**. Para los contratistas de prestación de servicios con quienes se acordó que la empresa pague sus aportes a seguridad social (planilla Y, cotizante 59, aportante 15; Resolución 467 de 2025 del Ministerio de Salud). La empresa los paga por su operador (p. ej. Asopagos); aquí se calculan, se contabilizan y se registra el pago. Siigo sigue emitiendo factura o documento soporte.

- **Contratos** (`nomina_contratistas`): contratista (tercero proveedor; se crea con cédula y nombre o se elige uno existente), fechas, **valor mensualizado sin IVA**, clase de riesgo, área del gasto (ARL que asume la empresa), cuenta por pagar (2335 documento soporte o 2205 factura) y entidades (EPS/AFP con código).
- **Cálculo mensual** (`public/contable/aportesContratistas.js`, función pura): IBC = 40 % del valor **mensualizado** (no de lo pagado en el mes), con mínimo 1 SMMLV y máximo 25 SMMLV, proporcionales a los días si el contrato empieza o termina en el mes (mes comercial de 30 días); varios contratos del mismo contratista se suman y rige la clase de riesgo más alta. Salud 12,5 %, pensión 16 %, fondo de solidaridad desde 4 SMMLV, ARL por clase; cada aporte se aproxima al múltiplo de 100. **ARL clases I a III: se descuenta al contratista; clases IV y V: la asume la empresa.**
- **Contabilización (fin de mes):** Db 2335/2205 (con el contratista) por lo que se le descuenta; Db 5105xx68/5205xx68 por la ARL que asume la empresa; Cr 237005 salud, Cr 238030 pensión y solidaridad (igual que la nómina), Cr 237006 ARL. Reglas `nomina_aportes_contratistas` y `nomina_aportes_contratistas_pago`.
- **Pago de la planilla (mes vencido):** Db 237005/238030/237006 (con el contratista), Db 530520 si hubo mora, Cr banco o caja; deja un egreso pendiente de conciliar. Se puede reabrir un mes contabilizado (motivo ≥ 10 caracteres) o anular el pago.
- **CSV de cargue** (`planilla-y-cargue-AAAA-MM.csv`): resumen del mes por contratista (IBC, aportes y quién los asume) para revisar y digitar. El cargue que Asopagos recibe es el de la subpestaña *Cargues Asopagos*.
- API bajo `/api/nomina/contratistas/` (`opciones`, `contratos`, `aportes`, `aportes/:id/recalcular|contabilizar|reabrir|pago|anular-pago|cargue.csv`). Ver: contador, dueño y revisor; modificar: contador y dueño. Tablas `nomina_contratistas` y `nomina_aportes_contratistas` (ver `sql-contratistas-planilla-y.sql`).
- **A validar con el contador:** que la pensión use 238030 (como la nómina) y no una subcuenta de 2370; que el descuento se cause a fin de mes contra la cuenta por pagar del contratista; el pago neto al contratista se hace aparte (la app aún no cruza pagos a proveedores).
- **Pendiente:** caja de compensación voluntaria y reintegro del contratista a la planilla I. Cargue masivo de cotizantes y de novedades (ING/RET) para Asopagos: ver la sección siguiente.

### Nómina · cargues masivos para Asopagos

Subpestaña **Nómina → Cargues Asopagos**. Genera, para el mes elegido, los archivos que recibe Asopagos (formatos copiados del *Modelo_Cargue_Masivo.xls* y del *Instructivo cargue masivo de novedades* de Asopagos):

- **Cotizantes (empleados)** y **cotizantes (contratistas, planilla Y)**: CSV con las 41 columnas de la hoja `cargue_masivo`, en el mismo orden y con los mismos títulos (se pega en el modelo `.xls` desde la fila 3). Empleados: cotizante 1, subtipo 0, tipo de salario F (X si es integral), exoneración y tarifas (pensión 0,16; salud 0,125 o 0,04 si está exonerado; SENA, ICBF y caja) como en el archivo plano de la PILA. Contratistas: cotizante 59, **salario básico = valor mensualizado** (suma si tiene varios contratos), **base de cotización = IBC** (40 %, entre 1 y 25 SMMLV), tarifas de salud y pensión, sin parafiscales (`SINCCF`).
- **Novedades del mes** (`.txt`, una línea por novedad, campos separados por `;`): ING y RET de empleados y de contratistas, y VAC, LMA, IRL, IGE y SLN desde las ausencias de los empleados. El módulo `public/contable/cargueAsopagos.js` sabe armar todas las novedades del instructivo (ING, RET, VSP, VST, SLN, IGE, LMA, VAC, AVP, IRL, VCT, OIP, IBC de parafiscales, salario y pagos no salariales); sus pruebas son los ejemplos del PDF de Asopagos.
- **Datos que piden y de dónde salen:** código de ARL y de caja (Configuración), departamento y municipio (Configuración), código del **centro de trabajo** y su **actividad económica de 7 dígitos** (Configuración → Centros de trabajo; el contrato de contratista también elige centro), códigos de EPS y fondo de pensiones (cada contrato). Si algo falta, la pantalla lo avisa antes de descargar. Los códigos pueden guardarse como `EPS005` o `EPS005_SANITAS`: solo se usa lo que va antes del guion bajo.
- API: `GET /api/nomina/asopagos/cotizantes?tipo=empleados|contratistas&anio=&mes=` y `GET /api/nomina/asopagos/novedades?anio=&mes=` (devuelven `{ nombre, contenido, resumen }`). Ver: contador, dueño y revisor.
- **A validar:** que Asopagos acepte el CSV tal cual (si exige `.xls`, se pega en su modelo); las tarifas de IGE (1 los dos primeros días y 0,6666 desde el tercero; si pasó de 90 días son 0,5) y de SLN (aporte total) quedan marcadas con aviso; el retiro de un contratista sale como RET tipo N (la Resolución 467 habla de RET-T, que el instructivo no define); los ingresos solo a caja o solo a riesgos (tipos C y R) no se generan porque el ejemplo del instructivo es incoherente.
- **No incluido:** el archivo plano de la planilla Y (Asopagos liquida la Y a partir de los cotizantes y novedades cargados) y el cargue de horas laborales (solo para cotizantes 51 y 76).

**Supuestos de la fase 2 a validar con el contador:**
- Prima y cesantías con la base descrita (último salario si no hubo cambios); intereses pagados antes del 31 de enero (después, la ley obliga a pagar el doble: solo hay aviso).
- Vacaciones: base sin recargos ni auxilio de transporte; compensar en dinero mientras el contrato esté vigente exige acuerdo (CST art. 189), el sistema avisa pero no lo impide más allá del saldo.
- Retención de pagos adicionales por el procedimiento 1; cesantías e intereses exentos.
- La indemnización del art. 64 se calcula sobre salario ordinario; con salario variable conviene confirmar la base.
- Aproximación PILA y mora: se contabilizan como gasto (5105xx95 y 530520).

**Lo que sigue pendiente:** novedades VSP/VST en el archivo plano, planilla de correcciones, cambio de salario a mitad de mes; dos contratos de un mismo empleado en el mismo mes; saldos iniciales formales de provisiones
(hoy se resuelven con los días de vacaciones previos del contrato y con los saldos del libro); reversión de un pago de nómina mensual; usar el selector de departamento y municipio (`selectorLugar.js`) también en Mi Empresa y Terceros, que hoy son texto libre.

## Inventarios (costo promedio ponderado)

Pestaña **Inventarios**: catálogo de productos, kardex, movimientos manuales, valoración y conciliación con la contabilidad.
El inventario se lleva **a costo promedio ponderado, perpetuo**. El saldo de cada producto es (cantidad, valor): el costo
promedio es valor ÷ cantidad, y al sacar todo lo que hay se lleva el valor completo (no quedan centavos sueltos).

**Cómo se mueve el inventario**
- **Compra (factura de proveedor cargada desde el XML):** las líneas cuya cuenta destino es 14xx dan **entrada** al kardex por el
  valor con que quedaron en el asiento (incluye descuentos repartidos e IVA/impoconsumo no descontable). **No crea otro asiento:**
  la factura ya debitó el inventario. En el diálogo de la factura, cada línea a 14xx muestra «Producto en inventario»:
  *Automático* (lo reconoce o crea uno), *Crear producto nuevo* o un producto existente.
- **Venta (factura de venta cargada desde el XML):** las líneas enlazadas a un producto dan **salida al costo promedio** y se
  contabilizan aparte: `Db 6135 Costo de ventas / Cr 1435 Inventario` (cuentas por producto; centro de costo = el proyecto de la factura).
  El diálogo preselecciona el producto que reconoce (los servicios quedan en «Sin descargar inventario»).
- **Manual** (Productos → Movimiento): saldo inicial, compra sin factura, sobrante, devolución de cliente, consumo interno, faltante,
  baja por deterioro, devolución a proveedor. Con vista previa del valor y del asiento; la contrapartida se propone (5195, 4295, 2335, 2205) y se puede cambiar.
  El **saldo inicial** puede ir solo al kardex (si la contabilidad ya tiene el saldo de apertura) o con asiento.
- Todo ocurre **en la misma transacción que la factura**: si algo falla (p. ej. una línea a inventario sin cantidad) no se guarda nada.

**Cómo reconoce el producto de una línea** (`costeoInventario.buscarProducto`): en ventas, por código → alias → nombre; en compras
(el código es del proveedor) por alias atado al NIT del proveedor → nombre → código. Cuando eliges un producto a mano (o se crea uno
desde una compra) el producto «recuerda» el código y la descripción como alias: la próxima factura lo enlaza sola.

**Venta sin existencias:** como la factura ya se emitió en Siigo, **se registra igual**: lo que falta sale al último costo de compra,
el saldo queda en negativo (marcado en rojo y en alertas) y se corrige solo cuando llega la factura de compra (valor y cantidad se suman).
Si no hay ningún costo conocido, la venta queda con costo cero y avisa.

**Valoración y conciliación:** «Valoración» muestra el inventario a cualquier fecha de corte (CSV incluido) y compara el valor del
kardex con el saldo contable de las cuentas 14xx. Una diferencia normal es el saldo inicial cargado solo al kardex; cualquier otra
(compras a 1435 sin producto, asientos manuales a 14xx) se ve ahí.

**Anular:** solo el **último** movimiento **manual** de un producto (motivo ≥ 10 letras): el saldo vuelve al de la fila anterior y su asiento queda `anulado`.
Un movimiento de factura no se anula aquí (las facturas todavía no se pueden anular): se corrige con un ajuste.

**Permisos:** ver, todos; crear productos y movimientos: dueño, contador y auxiliar; anular y cambiar cuentas contables: dueño y contador (el revisor solo consulta).
**Tablas:** `productos` (ampliada; los productos viejos toman valor = cantidad × costo promedio) e `inventario_kardex` (nueva). La tabla vieja `movimientos_inventario` queda sin uso.
**Código:** cálculo en `public/contable/costeoInventario.js` y asientos en `asientoInventario.js` (compartidos navegador/servidor);
servicio en `src/modules/inventarios/services/inventarios.service.js`; rutas bajo `/api/inventarios`; pantalla en `public/contable/inventarios.js`.
Pruebas: `node --test tests/costeoInventario.test.js tests/asientoInventario.test.js`.

**Supuestos a validar con el contador:**
- Costo promedio **por movimiento en orden de registro**, no por fecha del documento: una factura cargada tarde con fecha anterior se valora con el promedio vigente al registrarla (no recalcula las ventas ya hechas).
- La venta sin existencias se valora al último costo de compra; el costo real se ajusta al entrar la compra, pero **el costo de ventas ya contabilizado no se reajusta** (la diferencia queda en el valor del inventario).
- Cuentas por defecto: inventario 1435, costo 6135; faltantes/consumos/bajas a 5195 y sobrantes a 4295 (se pueden cambiar en cada movimiento). Cuentas alternativas ofrecidas: 1405, 1410, 1430, 1455, 1460, 1465 y 6120, 6140.
- Una línea de compra a 14xx debe ir a la misma cuenta (primeros 4 dígitos) que el producto, para que el kardex cuadre con la contabilidad.

**Lo que no hace todavía:** notas crédito/débito de compra y venta (devoluciones por factura), anulación de movimientos de factura, lotes y vencimientos,
varias bodegas y traslados, costeo PEPS, producción (materias primas → producto terminado), IVA/inventario del documento soporte,
importación masiva de productos desde Excel y el recálculo del promedio por fecha.

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).

La raíz del dominio (`/`) es la página institucional de **Libaniel
Consulting**, pensada para ofrecer varios servicios de la firma — hoy
solo el software contable es real, los otros dos son marcadores de
posición con un `mailto:` genérico (`contacto@libanielconsulting.com`)
hasta que se definan de verdad.

El software contable en sí vive en **`/contable`** — mismo backend,
solo un subdirectorio distinto en `public/`. Cubre creación y las
transiciones de estado principales de los seis módulos (formularios
inline + botones de acción por fila según el estado del registro). Dos
simplificaciones deliberadas por ahora:
acciones que piden un solo dato adicional puntual (agregar empleado a
un periodo) usan `prompt()` del
navegador en vez de un formulario modal propio; y no hay edición ni
borrado de nada, solo creación y transiciones hacia adelante.

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa y resuelve solo el periodo
   contable vigente si no se le pasa explícito.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).
6. **Un movimiento bancario sin conciliar bloquea el cierre del periodo**
   (ver `cierrePeriodo.validarPeriodo`).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de la base de datos y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Sitios web → Apps Node.js → conectar el repositorio de GitHub.
2. Base de datos: PostgreSQL vía Supabase (host, puerto, nombre, usuario y
   contraseña como `DB_*` en las variables de entorno de la app).
3. hPanel → Avanzado → Cron Jobs → programar:
   - `node src/jobs/depreciacionMensual.js` — día 1 de cada mes
   - `node src/jobs/vencimientoCotizaciones.js` — diario

## Roles y autenticación

Cuatro roles, controlados por `src/middleware/auth.js` (`authenticate` +
`authorize(...roles)`):

| Rol | Puede |
|---|---|
| `dueño` | Operar el sistema, certificar el cierre mensual |
| `contador` | Todo lo anterior + reabrir un periodo certificado |
| `auxiliar` | Registrar operaciones del día a día (ventas, compras, nómina) |
| `revisor` | Solo lectura (pendiente de aplicar en cada ruta) |

**Rutas públicas** (sin sesión): `POST /api/auth/login` y `POST /api/auth/registro-empresa`. Todo lo demás
exige `Authorization: Bearer <token>`.

- **Sesión:** el token (8 h) dice quién es; el **rol y si sigue activo se leen de la base en cada petición**, así que
  desactivar a alguien o cambiarle el rol surte efecto al instante. Cada usuario ve y edita solo su empresa
  (`GET /api/empresas` devuelve únicamente la propia; `PATCH` solo la propia y solo dueño o contador).
- **Usuarios** (Mi Empresa › Usuarios, solo dueño y contador): `POST /api/auth/registro` crea un usuario **en la empresa de
  quien lo crea** (el `empresaId` del cuerpo se ignora); `GET /api/usuarios` y `PATCH /api/usuarios/:id` (rol, activar o
  desactivar, nueva contraseña). El contador no crea ni modifica dueños; nadie cambia su propio rol ni se desactiva.
  Contraseña: 8 a 72 caracteres con letras y números. El correo no distingue mayúsculas.
- **Empresas nuevas:** `POST /api/auth/registro-empresa` exige `CODIGO_REGISTRO` (variable de entorno que Libaniel entrega
  a quien puede crear empresas). Sin esa variable, el registro de empresas queda **cerrado**. Máximo 10 intentos por hora por IP.
- **Fuerza bruta:** el login admite 30 intentos por IP cada 15 min y 8 fallos seguidos por correo (luego 429 hasta que pase
  la ventana). El limitador es en memoria (un solo proceso de Node); `app.set('trust proxy', 1)` para ver la IP real.
- **Webhooks** (`/webhooks/*`): exigen el encabezado `x-webhook-secret` igual a `WEBHOOK_SECRET`; sin esa variable quedan
  deshabilitados (503).
- **CORS:** cerrado a otros sitios; se abre solo con `CORS_ORIGIN` (orígenes separados por coma).
- **Variables de entorno de seguridad:** `JWT_SECRET` (obligatoria; el servidor avisa si es corta o es el valor de
  ejemplo — cambiarla cierra las sesiones abiertas), `CODIGO_REGISTRO`, `WEBHOOK_SECRET`, `CORS_ORIGIN`.
- **RLS en Supabase:** `sql-seguridad-rls.sql` activa Row Level Security en todas las tablas de `public` y le quita
  permisos a los roles `anon`/`authenticated` de la API pública (la app se conecta como dueña de las tablas y no se afecta).
  Volver a correrlo después de crear tablas nuevas.

## Datos base (seed)

`POST /api/seed` (requiere sesión con rol `contador` o `dueño`) crea:
una empresa de prueba, el periodo contable del mes en curso, un plan de
24 cuentas, y 13 reglas de contabilización — una por cada
evento que disparan los seis módulos operativos. Seguro de correr más
de una vez — no duplica nada. Sin esto, `motorAsientos` no tiene con
qué contabilizar.

## Pendientes inmediatos

- [ ] **Retención en la fuente en órdenes es solo informativa**. Al registrar la factura desde XML la retención **sí** se contabiliza (2365/2367 al causar la factura), pero `convertirOrdenEnFactura` (cierre manual de una orden sin XML) sigue contabilizando el total bruto sin retención ni IVA aparte. Falta unificarlo, y decidir qué hace Tesorería al pagar (el neto a pagar ya queda en `facturas_compra.neto_a_pagar`)
- [ ] Retención: el concepto se elige a mano en cada orden; no se deriva automáticamente de `Tercero.tipoPersona` / `responsabilidadesFiscales` (declarante / no declarante, RST). El tope en UVT se mide **por orden**, sin acumular los pagos del mes o del año al mismo proveedor. Validar los conceptos y tarifas del catálogo con el contador
- [ ] AIU en órdenes: igual que en cotizaciones, no admite mezclar ítems exentos/Impoconsumo con IVA sobre la base AIU (el Impoconsumo de los ítems se suma aparte; el IVA individual de los ítems se ignora)
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` usan `<script>` y `<style>` en línea, y `server.js` define una CSP `script-src 'self'` / `style-src 'self'`. Un navegador que respete esa CSP los bloquea (probado en un entorno local sin proxy). Si en algún momento las páginas de impresión dejan de cargar, mover ese JS/CSS a archivos externos

- [ ] Plan de cuentas: no hay pantalla para editar las **reglas de contabilización** (qué cuenta usa cada evento); solo se ven en el bloqueo al desactivar. Tampoco hay importación masiva del plan desde Excel ni cuentas de orden (clases 8 y 9). La cuenta 1355 se usa como "IVA descontable" (en el PUC el IVA descontable es una subcuenta de 2408): validar con el contador si se prefiere la estructura del PUC
- [ ] Facturas de venta desde XML (Siigo): retenciones practicadas por el cliente al pago, notas crédito/débito, impoconsumo. Mientras tanto la factura de venta interna (`convertirCotizacionEnFactura`) sigue en el código pero sin botón en pantalla
- [ ] Facturas de compra desde XML: notas crédito/débito de proveedores (descuentos y devoluciones posteriores), documento soporte recibido, facturas en moneda extranjera y cruce de anticipos
- [ ] RADIAN: enviar los eventos del comprador (acuse de recibo, recibo del bien o servicio, aceptación expresa) a la DIAN a través del proveedor tecnológico; hoy solo se lee el XML. Tampoco se consulta a la DIAN para comprobar el CUFE (hay un enlace para hacerlo a mano)
- [ ] Facturas de compra: el control de duplicados (CUFE) es una consulta previa, no un índice único; dos cargas simultáneas idénticas podrían pasar. Considerar índice único `(empresa_id, cufe)` al migrar a `sequelize-cli`
- [ ] Facturas de compra: aprobar/anular un asiento en `borrador` y anular una factura registrada por error (hoy no hay forma de revertirla desde la pantalla)
- [ ] **Migraciones de Sequelize (`sequelize-cli`)** en vez de `sync({ alter: true })` — ya tenemos evidencia concreta de por qué importa: con cada redeploy que tocó el modelo, Sequelize fue acumulando una restricción única duplicada sobre `consecutivo` en vez de reconocer que ya existía una (llegaron a existir 23 restricciones idénticas en `ordenes_compra`, ver corrección en Supabase del 30/sep/2026). `alter: true` es cómodo para esta etapa pero no es confiable para cambios de índices/restricciones a largo plazo
- [ ] Tesorería (cruce de pagos): anticipos (de clientes y a proveedores), notas crédito/débito y cruce de pagos de órdenes de compra; «conciliar» un movimiento digitado a mano sin cruzarlo sigue sin generar asiento
- [ ] Bancos: conciliación por cuenta contra el extracto (importar el extracto y quitar la conciliación de un movimiento); los pagos, recaudos y la nómina ya van al auxiliar de la cuenta; cuentas en moneda extranjera (111010); cerrar/inactivar una cuenta bancaria; reclasificar movimientos antiguos de 1110 a su auxiliar
- [ ] Múltiples líneas por evento en `motorAsientos`: ya existe `contabilizarAsientoCompuesto` (lo usa la factura de compra desde XML), pero `contabilizarEvento` sigue siendo de un débito y un crédito — las ventas no discriminan IVA por pagar en un renglón aparte, ni los activos fijos (la nómina ya usa `contabilizarAsientoCompuesto`)
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `DELETE` de terceros (crear, listar y editar ya existen; falta borrar)
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Seguridad: autenticación en dos pasos, recuperar contraseña por correo (hoy la restablece el dueño o el contador), y mover el limitador de intentos a la base si algún día hay varios procesos de Node
- [ ] Reemplazar los `prompt()` del navegador (agregar empleado a nómina, si aún queda alguno) por formularios modales propios en el frontend; agregar edición/borrado en general
- [ ] Confirmar que `www.libanielconsulting.com` resuelve al mismo sitio que `libanielconsulting.com` (revisar en hPanel → Dominios, o agregar la redirección si falta)
- [ ] Definir de verdad los servicios 02 y 03 de la página institucional (`public/index.html`) y reemplazar el `mailto:contacto@libanielconsulting.com` por el correo real de la firma
- [x] ~~Fase 2, parte 2~~ — Órdenes de Adquisición ya tiene ítems dinámicos, "Ver ítems" y "Editar" (solo en borrador), igual que Cotizaciones
- [ ] Aplicar `mensajeError()` (`src/core/utils/mensajeError.js`) en los demás controladores — hoy `ventas.controller.js` y `compras.controller.js` lo usan; inventarios, activos fijos y tesorería todavía devuelven el mensaje genérico de Sequelize
- [ ] La opción "Otro (definir %)" de impuesto en el ítem se guarda como `tipoImpuesto: 'iva'` con el porcentaje manual — no distingue si en realidad era un Impoconsumo con tarifa distinta a 4/8/16%. Si eso resulta ser un caso frecuente, vale la pena dejar elegir tipo Y porcentaje por separado en vez de un solo desplegable combinado
- [ ] El cálculo de IVA cuando `aplicaAiu = true` sigue asumiendo 19% general sobre (subtotal + AIU) sin importar el `tipoImpuesto` real de los ítems — no contempla todavía una cotización con AIU que mezcle ítems de Impoconsumo o exentos
- [x] ~~Fase 3, parte 2~~ — `orden-imprimir.html` ya existe: mismo patrón que cotización, con los datos del proveedor (incluida su cuenta bancaria) en vez del cliente, y el proyecto resuelto desde el catálogo
- [ ] Validar con un caso real si el IVA de una cotización con AIU debe calcularse sobre (subtotal + AIU) como quedó programado, o de otra forma según el tipo de contrato — ver la nota en `crearCotizacion` (`ventas.service.js`)
- [ ] `GET /compras/ordenes/:id` con ítems (el de cotizaciones ya existe: `GET /ventas/cotizaciones/:id`) — necesario para "Ver ítems" y la Fase 3 en Órdenes
- [ ] "Enviar" (cotización) sigue siendo solo un cambio de estado — no manda correo ni WhatsApp automáticamente, el botón ahora lo aclara con un `confirm()`. El envío real de verdad (correo con el PDF adjunto, por ejemplo) requeriría configurar un proveedor de correo transaccional, que todavía no existe en el proyecto
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` generan el PDF usando "Imprimir" del navegador (`window.print()`), no una librería de generación de PDF en el servidor — evita agregar una dependencia pesada (ej. Puppeteer) que podría no funcionar bien en el hosting de Node de Hostinger. Si el formato de impresión del navegador resulta insuficiente, esto es lo primero a reconsiderar
- [ ] Conectar `Proyecto` con `Movimiento.centroCosto` para que la contabilidad se segmente por proyecto de verdad (hoy el catálogo solo se usa desde Órdenes de Adquisición)
- [x] ~~Editar un `Proyecto` desde la interfaz~~ — ya existe el botón "Editar" (mismo formulario que crear, incluye activar/desactivar y permite borrar datos opcionales). Falta solo **eliminar** (hoy se desactiva)
- [ ] Migrar las órdenes viejas que tienen `proyecto` (texto libre) pero no `proyectoId`, para que puedan filtrarse/agruparse igual que las nuevas
- [ ] Usar `Tercero.responsabilidadesFiscales` y `tipoPersona` para automatizar el cálculo de retención en la fuente (formulario 350) — hoy son solo datos capturados, no alimentan ningún cálculo todavía
- [ ] Consecutivos: ya son únicos por empresa (índice compuesto `empresa_id + consecutivo`, no `consecutivo` global) y toda la creación vive en una transacción real — un fallo a mitad de camino ya no deja un encabezado huérfano con el número gastado. Sigue sin bloqueo transaccional de secuencia bajo concurrencia muy alta (una tabla de secuencias con `SELECT ... FOR UPDATE` sería la solución definitiva si el volumen lo exige)
SCRIPTEOF
echo "OK  README.md"

echo ""
echo "Listo. Retenciones sufridas instaladas."
echo ""
echo "ANTES de subir (git push), en Supabase > SQL Editor corre sql-retenciones-sufridas.sql (agrega 6 columnas; los recaudos viejos quedan en 0. Si ya lo corriste antes, córrelo de nuevo completo: no daña nada)."
echo ""
echo "Siguiente paso (borra el script antes de subir):"
echo "  rm aplicar-tesoreria-retenciones-sufridas.sh"
echo "  git add ."
echo "  git commit -m \"Tesorería: retenciones (ReteFuente, ReteIVA, ReteICA) y estampillas, tasas y contribuciones que descuentan los clientes al cobrar, con reporte\""
echo "  git push"
echo ""
echo "Después del despliegue abre /contable con Ctrl+F5. En Tesorería > Por cobrar, al registrar un recaudo aparecen las casillas de retención."
