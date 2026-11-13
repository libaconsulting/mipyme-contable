// Anticipos de clientes y a proveedores.
//
//   Anticipo de cliente   (nos pagan antes de facturar)        Db banco o caja        Cr 2805 Anticipos y avances recibidos
//   Anticipo a proveedor  (pagamos antes de recibir factura)   Db 1330 Anticipos y avances   Cr banco o caja
//
// Cuando llega la factura se APLICA el anticipo (sin mover plata):
//   Cliente:    Db 2805            Cr 1305 Clientes
//   Proveedor:  Db 2205 / 2335     Cr 1330
// y la factura baja su saldo como con cualquier pago. Si el anticipo no se usa, se DEVUELVE:
//   Cliente:    Db 2805            Cr banco o caja      (le devolvemos la plata)
//   Proveedor:  Db banco o caja    Cr 1330              (el proveedor nos la devuelve)
//
// Un anticipo, un cruce y una devolución son filas de PagoTesoreria (ver el modelo). Lo que le queda a un anticipo es
// su valor menos los cruces y devoluciones activos; anular un cruce o una devolución le devuelve el saldo. Los cruces
// usan PagoAplicacion igual que un pago, así el saldo de la factura y su historial de pagos no necesitan cambios.
//
// Un anticipo a proveedor puede amarrarse a una orden de adquisición (ordenCompraId): del mismo proveedor, sin pasarse del total de la
// orden. Al aplicarlo a una factura que no es de esa orden se pide confirmar (aceptarFueraDeOrden).
//
// No se calcula IVA ni retención sobre el anticipo: la factura que lo cancela ya trae sus impuestos y retenciones.
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Tercero = require('../../../core/models/Tercero');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const OrdenCompra = require('../../compras/models/OrdenCompra');
const CuentaBancaria = require('../models/CuentaBancaria');
const MovimientoBancario = require('../models/MovimientoBancario');
const PagoTesoreria = require('../models/PagoTesoreria');
const PagoAplicacion = require('../models/PagoAplicacion');
const { contabilizarAsientoCompuesto, cuentasPorCodigo } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const { asegurarCuentaContable, nombreAuxiliar } = require('./contabilidadBancaria');
const auditoria = require('../../../core/services/auditoria');
const cruces = require('./cruces.service');

const { DOCS, saldosAnticipos, documentoDe, estadoContable, numeroDelDocumento, enriquecer, hoyColombia, fechaValida, texto, monto, aCentavos, dePesos } = cruces;

const SENTIDOS = {
  cliente: { tipo: 'anticipo_cliente', cuenta: '2805', docs: ['factura_venta'], etiqueta: 'Anticipo de cliente', movimiento: 'ingreso', movimientoDevolucion: 'egreso' },
  proveedor: { tipo: 'anticipo_proveedor', cuenta: '1330', docs: ['factura_compra', 'documento_soporte'], etiqueta: 'Anticipo a proveedor', movimiento: 'egreso', movimientoDevolucion: 'ingreso' },
};
const sentidoDeTipo = (tipo) => (tipo === 'anticipo_cliente' ? 'cliente' : 'proveedor');

// Eventos del motor que usan los anticipos (se crean la primera vez, como en el cruce de pagos).
const REGLAS = [
  { evento: 'tesoreria_anticipo_cliente', debito: '1110', credito: '2805' },
  { evento: 'tesoreria_anticipo_proveedor', debito: '1330', credito: '1110' },
  { evento: 'tesoreria_cruce_anticipo_cliente', debito: '2805', credito: '1305' },
  { evento: 'tesoreria_cruce_anticipo_proveedor', debito: '2205', credito: '1330' },
  { evento: 'tesoreria_devolucion_anticipo_cliente', debito: '2805', credito: '1110' },
  { evento: 'tesoreria_devolucion_anticipo_proveedor', debito: '1110', credito: '1330' },
];

async function asegurarReglasAnticipos(empresaId, transaction) {
  const cuentas = await cuentasPorCodigo(empresaId, REGLAS.flatMap((r) => [r.debito, r.credito]), transaction);
  for (const r of REGLAS) {
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

// Caja o banco de una operación con plata (anticipo o devolución), y el movimiento del extracto si se enlaza uno.
async function leerMedio(datos, tipoMovimiento, empresaId) {
  const medio = datos.medio === 'caja' ? 'caja' : 'banco';
  let cuenta = null;
  let movimiento = null;
  if (medio === 'banco') {
    cuenta = await CuentaBancaria.findOne({ where: { id: datos.cuentaBancariaId || null, empresaId } });
    if (!cuenta) throw new Error('Elige la cuenta bancaria, o marca efectivo (caja).');
  }
  if (datos.movimientoBancarioId) {
    if (medio !== 'banco') throw new Error('Un movimiento bancario solo se enlaza a una operación por banco.');
    movimiento = await MovimientoBancario.findOne({ where: { id: datos.movimientoBancarioId, empresaId } });
    if (!movimiento) throw new Error('No se encontró el movimiento bancario.');
    if (movimiento.cuentaBancariaId !== cuenta.id) throw new Error('El movimiento es de otra cuenta bancaria.');
    if (movimiento.tipo !== tipoMovimiento) throw new Error(`Aquí se enlaza con un movimiento de tipo ${tipoMovimiento}.`);
    if (movimiento.origenModulo) throw new Error('Ese movimiento ya está ligado a otra operación.');
  }
  return { medio, cuenta, movimiento };
}

// Crea o enlaza el movimiento del banco. Devuelve { movimientoId, movimientoCreado }.
async function ligarMovimiento({ empresaId, cuenta, movimiento, fecha, valorCent, tipo, descripcion, origenId, transaction }) {
  if (!cuenta) return { movimientoId: null, movimientoCreado: false };
  if (movimiento) {
    await movimiento.update({ conciliado: true, origenModulo: 'tesoreria', origenId }, { transaction });
    return { movimientoId: movimiento.id, movimientoCreado: false };
  }
  const id = uuidv4();
  await MovimientoBancario.create({
    id, empresaId, cuentaBancariaId: cuenta.id, fecha, valor: dePesos(valorCent), tipo, descripcion: descripcion.slice(0, 255),
    conciliado: false, origenModulo: 'tesoreria', origenId,
  }, { transaction });
  return { movimientoId: id, movimientoCreado: true };
}

// Orden de adquisición a la que se amarra un anticipo a proveedor: del mismo proveedor, emitida, aprobada o recibida (no borrador,
// rechazada, anulada ni ya facturada), y lo anticipado (neto de devoluciones) no puede pasar del total de la orden.
const ESTADOS_ORDEN_ANTICIPO = ['emitida', 'aprobada', 'recibida_parcial', 'recibida_total'];
async function ordenParaAnticipo(empresaId, sentido, tercero, ordenId, valorCent, transaction) {
  if (sentido !== 'proveedor') throw new Error('Solo un anticipo a proveedor se amarra a una orden de adquisición.');
  const orden = await OrdenCompra.findOne({ where: { id: ordenId, empresaId }, transaction });
  if (!orden) throw new Error('La orden de adquisición elegida no existe.');
  if (orden.terceroId !== tercero.id) throw new Error(`La orden ${orden.consecutivo || ''} es de otro proveedor.`);
  if (!ESTADOS_ORDEN_ANTICIPO.includes(orden.estado)) {
    throw new Error(`La orden ${orden.consecutivo || ''} está en estado "${orden.estado}": un anticipo se concede sobre una orden emitida, aprobada o recibida, que aún no esté facturada.`);
  }
  const previos = await saldosAnticipos(empresaId, { ordenCompraId: orden.id }, transaction);
  const entregado = previos.reduce((s, a) => s + aCentavos(a.pago.valor) - a.devuelto, 0);
  if (entregado + valorCent > aCentavos(orden.total)) {
    throw new Error(`La orden ${orden.consecutivo || ''} es por ${orden.total} y ya tiene ${dePesos(entregado)} anticipados: con este anticipo (${dePesos(valorCent)}) pasaría de su total.`);
  }
  return orden;
}

// --- Registrar un anticipo ------------------------------------------------------
async function registrarAnticipo(datos, usuario) {
  const empresaId = usuario.empresaId;
  const sentido = datos.sentido;
  const S = SENTIDOS[sentido];
  if (!S) throw new Error('El anticipo es "cliente" (nos pagan antes de facturar) o "proveedor" (pagamos antes de recibir la factura).');
  const tercero = await Tercero.findOne({ where: { id: datos.terceroId || null, empresaId } });
  if (!tercero) throw new Error(`Elige ${sentido === 'cliente' ? 'el cliente' : 'el proveedor'}.`);
  const valorCent = monto(datos.valor, 'El valor del anticipo');
  const { medio, cuenta, movimiento } = await leerMedio(datos, S.movimiento, empresaId);
  if (movimiento && aCentavos(movimiento.valor) !== valorCent) {
    throw new Error(`El movimiento del banco es de ${movimiento.valor} y el anticipo es de ${dePesos(valorCent)}: deben ser iguales.`);
  }
  const fecha = datos.fecha || (movimiento ? movimiento.fecha : hoyColombia());
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha del anticipo (AAAA-MM-DD).');
  if (fecha > hoyColombia()) throw new Error('La fecha del anticipo no puede ser futura.');
  const referencia = texto(datos.referencia, 60, 'La referencia');
  const observaciones = texto(datos.observaciones, 250, 'Las observaciones');

  await aprovisionarContabilidadBase(empresaId);
  const creado = await sequelize.transaction(async (transaction) => {
    await asegurarReglasAnticipos(empresaId, transaction);
    const orden = datos.ordenCompraId ? await ordenParaAnticipo(empresaId, sentido, tercero, datos.ordenCompraId, valorCent, transaction) : null;
    const codigoBanco = cuenta ? (await asegurarCuentaContable(cuenta, transaction)).codigo : '1105';
    const terceroBanco = (cuenta && cuenta.terceroId) || tercero.id;
    const v = dePesos(valorCent);
    const lineas = sentido === 'cliente'
      ? [{ cuentaCodigo: codigoBanco, debito: v, credito: 0, terceroId: terceroBanco }, { cuentaCodigo: S.cuenta, debito: 0, credito: v, terceroId: tercero.id }]
      : [{ cuentaCodigo: S.cuenta, debito: v, credito: 0, terceroId: tercero.id }, { cuentaCodigo: codigoBanco, debito: 0, credito: v, terceroId: terceroBanco }];
    const pagoId = uuidv4();
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: `tesoreria_anticipo_${sentido}`, origenModulo: 'tesoreria', origenId: pagoId, fecha, lineas,
      usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha del anticipo está cerrado o no existe.');
    const { movimientoId, movimientoCreado } = await ligarMovimiento({
      empresaId, cuenta, movimiento, fecha, valorCent, tipo: S.movimiento, origenId: pagoId, transaction,
      descripcion: `${S.etiqueta} · ${tercero.nombre}`,
    });
    return PagoTesoreria.create({
      id: pagoId, empresaId, tipo: S.tipo, fecha, terceroId: tercero.id, valor: v, medio,
      cuentaBancariaId: cuenta ? cuenta.id : null, movimientoBancarioId: movimientoId, movimientoCreado, ordenCompraId: orden ? orden.id : null,
      asientoId: r.asiento.id, referencia, observaciones, estado: 'activo', usuarioId: usuario.id,
    }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: `tesoreria_anticipo_${sentido}_registrado`, entidad: 'PagoTesoreria', entidadId: creado.id,
    detalle: `${tercero.nombre} · ${creado.valor}`,
  });
  return detalleAnticipo(creado.id, usuario);
}

// --- Aplicar un anticipo a facturas ---------------------------------------------
async function aplicarAnticipo(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const previo = await PagoTesoreria.findOne({ where: { id, empresaId } });
  if (!previo || !['anticipo_cliente', 'anticipo_proveedor'].includes(previo.tipo)) throw new Error('Anticipo no encontrado.');
  const sentido = sentidoDeTipo(previo.tipo);
  const S = SENTIDOS[sentido];
  const aplicaciones = Array.isArray(datos.aplicaciones) ? datos.aplicaciones : [];
  if (!aplicaciones.length) throw new Error('Elige al menos una factura y el valor que se le aplica.');
  if (aplicaciones.length > 100) throw new Error('Demasiadas facturas en una sola aplicación (máximo 100).');
  const repetidos = new Set();
  for (const ap of aplicaciones) {
    if (!S.docs.includes(ap.docTipo)) {
      throw new Error(sentido === 'cliente' ? 'Un anticipo de cliente se aplica a facturas de venta.' : 'Un anticipo a proveedor se aplica a facturas de compra o documentos soporte.');
    }
    const clave = `${ap.docTipo}:${ap.docId}`;
    if (repetidos.has(clave)) throw new Error('Una misma factura aparece dos veces.');
    repetidos.add(clave);
  }
  const fecha = datos.fecha || hoyColombia();
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha de la aplicación (AAAA-MM-DD).');
  if (fecha > hoyColombia()) throw new Error('La fecha de la aplicación no puede ser futura.');
  const observaciones = texto(datos.observaciones, 250, 'Las observaciones');

  await aprovisionarContabilidadBase(empresaId);
  const creado = await sequelize.transaction(async (transaction) => {
    await asegurarReglasAnticipos(empresaId, transaction);
    const opciones = { where: { id, empresaId }, transaction };
    if (sequelize.getDialect() === 'postgres') opciones.lock = transaction.LOCK.UPDATE;
    const anticipo = await PagoTesoreria.findOne(opciones);
    if (!anticipo || anticipo.estado !== 'activo') throw new Error('Este anticipo está anulado.');
    const [estado] = await saldosAnticipos(empresaId, { id }, transaction);
    if (fecha < anticipo.fecha) throw new Error(`La aplicación (${fecha}) no puede ser anterior al anticipo (${anticipo.fecha}).`);

    const aplicado = [];
    const fuera = [];
    let totalCent = 0;
    const porCuenta = {};
    const nombres = [];
    for (const ap of aplicaciones) {
      const d = await documentoDe(empresaId, ap.docTipo, ap.docId, transaction);
      const numero = numeroDelDocumento(ap.docTipo, d);
      if (d.terceroId !== anticipo.terceroId) throw new Error(`${numero} es de otro tercero: el anticipo solo se aplica a facturas de quien lo entregó o recibió.`);
      const nopaga = await estadoContable(d, transaction);
      if (nopaga) throw new Error(`${numero}: ${nopaga}`);
      if (fecha < d.fecha) throw new Error(`La aplicación (${fecha}) no puede ser anterior al documento ${numero} (${d.fecha}).`);
      const v = monto(ap.valor, `El valor aplicado a ${numero}`);
      const s = await cruces.saldoDe(empresaId, ap.docTipo, d, transaction);
      if (v > s.saldo) throw new Error(`${numero}: el valor (${dePesos(v)}) supera el saldo pendiente (${dePesos(s.saldo)}).`);
      aplicado.push({ ap, d, v });
      if (anticipo.ordenCompraId && !(ap.docTipo === 'factura_compra' && d.ordenCompraOrigenId === anticipo.ordenCompraId)) fuera.push(numero);
      totalCent += v;
      porCuenta[DOCS[ap.docTipo].cuenta] = (porCuenta[DOCS[ap.docTipo].cuenta] || 0) + v;
      nombres.push(numero);
    }
    if (fuera.length && !(datos.aceptarFueraDeOrden === true || datos.aceptarFueraDeOrden === 'true')) {
      throw new Error(`Este anticipo se concedió sobre una orden de adquisición y ${fuera.join(', ')} no ${fuera.length > 1 ? 'son facturas' : 'es una factura'} de esa orden. Si de todos modos lo quieres aplicar, confírmalo.`);
    }
    if (totalCent > estado.saldo) throw new Error(`El anticipo solo tiene ${dePesos(estado.saldo)} sin aplicar y se intenta aplicar ${dePesos(totalCent)}.`);

    const lineas = [];
    if (sentido === 'cliente') {
      lineas.push({ cuentaCodigo: S.cuenta, debito: dePesos(totalCent), credito: 0, terceroId: anticipo.terceroId });
      lineas.push({ cuentaCodigo: '1305', debito: 0, credito: dePesos(totalCent), terceroId: anticipo.terceroId });
    } else {
      for (const [codigo, v] of Object.entries(porCuenta)) lineas.push({ cuentaCodigo: codigo, debito: dePesos(v), credito: 0, terceroId: anticipo.terceroId });
      lineas.push({ cuentaCodigo: S.cuenta, debito: 0, credito: dePesos(totalCent), terceroId: anticipo.terceroId });
    }
    const pagoId = uuidv4();
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: `tesoreria_cruce_anticipo_${sentido}`, origenModulo: 'tesoreria', origenId: pagoId, fecha, lineas,
      usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha de la aplicación está cerrado o no existe.');
    const pago = await PagoTesoreria.create({
      id: pagoId, empresaId, tipo: 'cruce_anticipo', fecha, terceroId: anticipo.terceroId, valor: dePesos(totalCent), medio: null,
      anticipoId: anticipo.id, asientoId: r.asiento.id, referencia: `Anticipo del ${anticipo.fecha}`, observaciones, estado: 'activo', usuarioId: usuario.id,
    }, { transaction });
    for (const a of aplicado) {
      await PagoAplicacion.create({
        id: uuidv4(), empresaId, pagoId, docTipo: a.ap.docTipo, docId: a.d.id, valor: dePesos(a.v),
        fuenteTipo: 'anticipo', fuenteId: anticipo.id, estado: 'activa',
      }, { transaction });
    }
    return { pago, nombres };
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: `tesoreria_anticipo_${sentido}_aplicado`, entidad: 'PagoTesoreria', entidadId: creado.pago.id,
    detalle: `${creado.pago.valor} · ${creado.nombres.slice(0, 5).join(', ')}`,
  });
  return detalleAnticipo(id, usuario);
}

// --- Devolver un anticipo -------------------------------------------------------
async function devolverAnticipo(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const previo = await PagoTesoreria.findOne({ where: { id, empresaId } });
  if (!previo || !['anticipo_cliente', 'anticipo_proveedor'].includes(previo.tipo)) throw new Error('Anticipo no encontrado.');
  const sentido = sentidoDeTipo(previo.tipo);
  const S = SENTIDOS[sentido];
  const { medio, cuenta, movimiento } = await leerMedio(datos, S.movimientoDevolucion, empresaId);
  const fecha = datos.fecha || (movimiento ? movimiento.fecha : hoyColombia());
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha de la devolución (AAAA-MM-DD).');
  if (fecha > hoyColombia()) throw new Error('La fecha de la devolución no puede ser futura.');
  const referencia = texto(datos.referencia, 60, 'La referencia');
  const observaciones = texto(datos.observaciones, 250, 'Las observaciones');

  await aprovisionarContabilidadBase(empresaId);
  const creado = await sequelize.transaction(async (transaction) => {
    await asegurarReglasAnticipos(empresaId, transaction);
    const opciones = { where: { id, empresaId }, transaction };
    if (sequelize.getDialect() === 'postgres') opciones.lock = transaction.LOCK.UPDATE;
    const anticipo = await PagoTesoreria.findOne(opciones);
    if (!anticipo || anticipo.estado !== 'activo') throw new Error('Este anticipo está anulado.');
    const [estado] = await saldosAnticipos(empresaId, { id }, transaction);
    if (estado.saldo <= 0) throw new Error('Este anticipo ya no tiene saldo por devolver.');
    const valorCent = datos.valor === undefined || datos.valor === null || datos.valor === '' ? estado.saldo : monto(datos.valor, 'El valor a devolver');
    if (valorCent > estado.saldo) throw new Error(`El anticipo solo tiene ${dePesos(estado.saldo)} sin aplicar.`);
    if (fecha < anticipo.fecha) throw new Error(`La devolución (${fecha}) no puede ser anterior al anticipo (${anticipo.fecha}).`);
    if (movimiento && aCentavos(movimiento.valor) !== valorCent) {
      throw new Error(`El movimiento del banco es de ${movimiento.valor} y la devolución es de ${dePesos(valorCent)}: deben ser iguales.`);
    }
    const tercero = await Tercero.findOne({ where: { id: anticipo.terceroId, empresaId }, transaction });
    const codigoBanco = cuenta ? (await asegurarCuentaContable(cuenta, transaction)).codigo : '1105';
    const terceroBanco = (cuenta && cuenta.terceroId) || anticipo.terceroId;
    const v = dePesos(valorCent);
    const lineas = sentido === 'cliente'
      ? [{ cuentaCodigo: S.cuenta, debito: v, credito: 0, terceroId: anticipo.terceroId }, { cuentaCodigo: codigoBanco, debito: 0, credito: v, terceroId: terceroBanco }]
      : [{ cuentaCodigo: codigoBanco, debito: v, credito: 0, terceroId: terceroBanco }, { cuentaCodigo: S.cuenta, debito: 0, credito: v, terceroId: anticipo.terceroId }];
    const pagoId = uuidv4();
    const r = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: `tesoreria_devolucion_anticipo_${sentido}`, origenModulo: 'tesoreria', origenId: pagoId, fecha, lineas,
      usuarioId: usuario.id, revisado: true, transaction,
    });
    if (r.periodoAjustado) throw new Error('El período contable de la fecha de la devolución está cerrado o no existe.');
    const { movimientoId, movimientoCreado } = await ligarMovimiento({
      empresaId, cuenta, movimiento, fecha, valorCent, tipo: S.movimientoDevolucion, origenId: pagoId, transaction,
      descripcion: `Devolución de anticipo · ${tercero ? tercero.nombre : ''}`,
    });
    return PagoTesoreria.create({
      id: pagoId, empresaId, tipo: 'devolucion_anticipo', fecha, terceroId: anticipo.terceroId, valor: v, medio,
      cuentaBancariaId: cuenta ? cuenta.id : null, movimientoBancarioId: movimientoId, movimientoCreado, anticipoId: anticipo.id,
      asientoId: r.asiento.id, referencia, observaciones, estado: 'activo', usuarioId: usuario.id,
    }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: `tesoreria_anticipo_${sentido}_devuelto`, entidad: 'PagoTesoreria', entidadId: creado.id, detalle: `${creado.valor}`,
  });
  return detalleAnticipo(id, usuario);
}

// --- Consultas ------------------------------------------------------------------
async function filaAnticipo(estado, terceroPorId, cuentaPorId, ordenPorId) {
  const p = estado.pago;
  const t = terceroPorId[p.terceroId];
  const c = p.cuentaBancariaId ? cuentaPorId[p.cuentaBancariaId] : null;
  return {
    id: p.id, sentido: sentidoDeTipo(p.tipo), fecha: p.fecha, terceroId: p.terceroId,
    terceroNombre: t ? t.nombre : '', terceroIdentificacion: t ? t.identificacion : '',
    valor: Number(p.valor), aplicado: dePesos(estado.aplicado), devuelto: dePesos(estado.devuelto), saldo: dePesos(estado.saldo),
    medio: p.medio, cuentaTexto: c ? nombreAuxiliar(c) : (p.medio === 'caja' ? 'Efectivo (caja)' : ''),
    referencia: p.referencia, observaciones: p.observaciones, asientoId: p.asientoId,
    ordenCompraId: p.ordenCompraId || null, ordenConsecutivo: (ordenPorId[p.ordenCompraId] || {}).consecutivo || null,
  };
}

// datos: { sentido: 'cliente'|'proveedor', terceroId, todos } — por defecto solo los que aún tienen saldo.
async function listarAnticipos(datos, usuario) {
  const empresaId = usuario.empresaId;
  const filtro = {};
  if (datos && SENTIDOS[datos.sentido]) filtro.tipo = SENTIDOS[datos.sentido].tipo;
  if (datos && datos.terceroId) filtro.terceroId = datos.terceroId;
  if (datos && datos.ordenCompraId) filtro.ordenCompraId = datos.ordenCompraId;
  const todos = datos && (datos.todos === true || datos.todos === 'true' || datos.todos === '1');
  const estados = (await saldosAnticipos(empresaId, filtro)).filter((e) => todos || e.saldo > 0);
  const terceros = estados.length ? await Tercero.findAll({ where: { id: [...new Set(estados.map((e) => e.pago.terceroId))], empresaId } }) : [];
  const terceroPorId = Object.fromEntries(terceros.map((t) => [t.id, t]));
  const cuentaIds = [...new Set(estados.map((e) => e.pago.cuentaBancariaId).filter(Boolean))];
  const cuentas = cuentaIds.length ? await CuentaBancaria.findAll({ where: { id: cuentaIds, empresaId } }) : [];
  const cuentaPorId = Object.fromEntries(cuentas.map((c) => [c.id, c]));
  const ordenIds = [...new Set(estados.map((e) => e.pago.ordenCompraId).filter(Boolean))];
  const ordenes = ordenIds.length ? await OrdenCompra.findAll({ where: { id: ordenIds, empresaId } }) : [];
  const ordenPorId = Object.fromEntries(ordenes.map((o) => [o.id, o]));
  const filas = [];
  for (const e of estados) filas.push(await filaAnticipo(e, terceroPorId, cuentaPorId, ordenPorId));
  filas.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  const suma = (s) => filas.filter((f) => f.sentido === s).reduce((t, f) => t + aCentavos(f.saldo), 0);
  return {
    resumen: {
      clientes: dePesos(suma('cliente')), proveedores: dePesos(suma('proveedor')),
      cantidadClientes: filas.filter((f) => f.sentido === 'cliente' && f.saldo > 0).length,
      cantidadProveedores: filas.filter((f) => f.sentido === 'proveedor' && f.saldo > 0).length,
    },
    anticipos: filas,
  };
}

// Un anticipo con todo lo que se hizo con él (aplicaciones a facturas y devoluciones, también las anuladas).
async function detalleAnticipo(id, usuario) {
  const empresaId = usuario.empresaId;
  const pago = await PagoTesoreria.findOne({ where: { id, empresaId } });
  if (!pago || !['anticipo_cliente', 'anticipo_proveedor'].includes(pago.tipo)) throw new Error('Anticipo no encontrado.');
  const [propio] = await enriquecer([pago], empresaId);
  const hijos = await PagoTesoreria.findAll({ where: { empresaId, anticipoId: pago.id }, order: [['fecha', 'ASC'], ['createdAt', 'ASC']] });
  const [estado] = pago.estado === 'activo' ? await saldosAnticipos(empresaId, { id: pago.id }) : [null];
  const cuenta = pago.cuentaBancariaId ? await CuentaBancaria.findOne({ where: { id: pago.cuentaBancariaId, empresaId } }) : null;
  const orden = pago.ordenCompraId ? await OrdenCompra.findOne({ where: { id: pago.ordenCompraId, empresaId } }) : null;
  return {
    ...propio,
    sentido: sentidoDeTipo(pago.tipo),
    aplicado: estado ? dePesos(estado.aplicado) : 0,
    devuelto: estado ? dePesos(estado.devuelto) : 0,
    saldo: estado ? dePesos(estado.saldo) : 0,
    cuentaTexto: cuenta ? nombreAuxiliar(cuenta) : propio.cuentaTexto,
    ordenCompraId: pago.ordenCompraId || null,
    ordenConsecutivo: orden ? orden.consecutivo : null,
    movimientos: await enriquecer(hijos, empresaId),
  };
}

module.exports = { registrarAnticipo, aplicarAnticipo, devolverAnticipo, listarAnticipos, detalleAnticipo, SENTIDOS };
