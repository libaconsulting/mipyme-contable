// Inventarios: catálogo de productos, kardex a costo promedio ponderado, movimientos
// manuales (saldo inicial, consumos, faltantes…), valoración y conciliación con la
// contabilidad, y el enganche con las facturas de compra (entradas) y de venta (salidas
// + costo de ventas).
//
// El cálculo vive en public/contable/costeoInventario.js y los asientos en
// public/contable/asientoInventario.js (los mismos archivos que usa la pantalla).
// Las entradas por compra NO crean asiento aquí: la factura de compra ya debita la cuenta
// de inventario. Las salidas por venta sí: Db costo de ventas / Cr inventario.

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Producto = require('../models/Producto');
const KardexMovimiento = require('../models/KardexMovimiento');
const Tercero = require('../../../core/models/Tercero');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Asiento = require('../../../core/models/Asiento');
const Movimiento = require('../../../core/models/Movimiento');
const PeriodoContable = require('../../../core/models/PeriodoContable');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const { contabilizarAsientoCompuesto, cuentasPorCodigo } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const auditoria = require('../../../core/services/auditoria');
const CI = require('../../../../public/contable/costeoInventario');
const AI = require('../../../../public/contable/asientoInventario');

const MAX_CANTIDAD = 1000000000;
const MAX_VALOR = 100000000000;
const LIMITE_MOVIMIENTOS = 500;

// --- Utilidades -----------------------------------------------------------------------
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
function numero(valor, nombre, { obligatorio = false, positivo = false, max = MAX_VALOR, decimales = 4 } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obligatorio) throw new Error(`Falta ${nombre}.`);
    return null;
  }
  const n = Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`${nombre} no es un número válido.`);
  if (n < 0) throw new Error(`${nombre} no puede ser negativo.`);
  if (positivo && n <= 0) throw new Error(`${nombre} debe ser mayor que cero.`);
  if (n > max) throw new Error(`${nombre} es demasiado grande.`);
  const f = 10 ** decimales;
  return Math.round((n + Number.EPSILON) * f) / f;
}
const redondear2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Saldo de un producto. En los creados antes de este módulo no hay valor guardado:
// se toma cantidad × costo promedio.
function saldoDe(p) {
  const cantidad = Number(p.cantidadDisponible);
  const valor = p.valorInventario !== null && p.valorInventario !== undefined ? Number(p.valorInventario) : redondear2(cantidad * Number(p.costoPromedio));
  return { cantidad, valor };
}

const nombresCuentas = Object.fromEntries(AI.CATALOGO.map((c) => [c.codigo, c.nombre]));

// Una cuenta sirve si está activa en el plan de la empresa o si el sistema sabe crearla sola.
async function validarCuenta(empresaId, codigo, { prefijos, etiqueta }) {
  const c = String(codigo || '').trim();
  if (!c) throw new Error(`Falta ${etiqueta}.`);
  if (prefijos && !prefijos.some((p) => c.startsWith(p))) {
    throw new Error(`${etiqueta}: la cuenta ${c} no corresponde (debe empezar por ${prefijos.join(' o ')}).`);
  }
  const existente = await PlanCuentas.findOne({ where: { empresaId, codigo: c } });
  if (existente) {
    if (!existente.activa) throw new Error(`${etiqueta}: la cuenta ${c} está inactiva.`);
    return existente;
  }
  const seed = require('../../../core/services/seedService').CUENTAS.find((x) => x.codigo === c);
  if (seed || nombresCuentas[c]) return null; // el motor la crea al contabilizar
  throw new Error(`${etiqueta}: la cuenta ${c} no existe en el plan de cuentas.`);
}

// Reglas que el motor de asientos exige para los eventos de inventario.
async function asegurarReglas(empresaId, transaction) {
  const reglas = [
    { evento: 'salida_inventario_venta', debito: '6135', credito: '1435' },
    { evento: 'inventario_entrada_manual', debito: '1435', credito: '4295' },
    { evento: 'inventario_salida_manual', debito: '5195', credito: '1435' },
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

// --- Productos --------------------------------------------------------------------------
function vistaProducto(p) {
  const s = saldoDe(p);
  const minimo = Number(p.cantidadMinima);
  return {
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    categoria: p.categoria,
    tipo: p.tipo,
    unidadMedida: p.unidadMedida,
    cantidad: s.cantidad,
    valor: s.valor,
    costoPromedio: Number(p.costoPromedio),
    ultimoCosto: Number(p.ultimoCosto),
    cantidadMinima: minimo,
    cuentaInventario: p.cuentaInventario,
    cuentaCosto: p.cuentaCosto,
    activo: p.activo,
    origen: p.origen,
    negativo: s.cantidad < 0,
    bajoMinimo: p.tipo === 'bien' && minimo > 0 && s.cantidad >= 0 && s.cantidad <= minimo,
    valorSinUnidades: p.tipo === 'bien' && s.cantidad === 0 && s.valor !== 0,
  };
}

async function listarProductos(usuario, filtros = {}) {
  const where = { empresaId: usuario.empresaId };
  if (filtros.estado !== 'todos') where.activo = true;
  const productos = await Producto.findAll({ where, order: [['nombre', 'ASC']] });
  const q = CI.normalizar(filtros.q || '');
  let lista = productos.map(vistaProducto);
  if (q) lista = lista.filter((p) => CI.normalizar(`${p.codigo || ''} ${p.nombre} ${p.categoria || ''}`).includes(q));
  if (filtros.estado === 'alertas') lista = lista.filter((p) => p.negativo || p.bajoMinimo || p.valorSinUnidades);
  return {
    productos: lista,
    totales: {
      productos: lista.length,
      valor: redondear2(lista.reduce((s, p) => s + p.valor, 0)),
      negativos: lista.filter((p) => p.negativo).length,
      bajoMinimo: lista.filter((p) => p.bajoMinimo).length,
    },
  };
}

async function productoDe(id, empresaId, transaction) {
  const p = await Producto.findOne({
    where: { id: id || null, empresaId },
    transaction,
    ...(transaction && transaction.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!p) throw new Error('El producto no existe.');
  return p;
}

async function codigoLibre(empresaId, codigo, excluirId) {
  if (!codigo) return;
  const todos = await Producto.findAll({ where: { empresaId }, attributes: ['id', 'codigo'] });
  const n = CI.normalizar(codigo);
  if (todos.some((p) => p.id !== excluirId && p.codigo && CI.normalizar(p.codigo) === n)) {
    throw new Error(`Ya existe un producto con el código "${codigo}".`);
  }
}

async function validarCuentasProducto(empresaId, datos) {
  if (datos.cuentaInventario !== undefined) {
    await validarCuenta(empresaId, datos.cuentaInventario, { prefijos: ['14'], etiqueta: 'La cuenta de inventario' });
  }
  if (datos.cuentaCosto !== undefined) {
    await validarCuenta(empresaId, datos.cuentaCosto, { prefijos: ['6'], etiqueta: 'La cuenta de costo de ventas' });
  }
}

async function crearProducto(datos, usuario) {
  const empresaId = usuario.empresaId;
  const nombre = limpiarTexto(datos.nombre, 150, 'El nombre', true);
  const codigo = limpiarTexto(datos.codigo, 50, 'El código', false);
  const tipo = datos.tipo === 'servicio' ? 'servicio' : 'bien';
  await codigoLibre(empresaId, codigo);
  const cuentaInventario = String(datos.cuentaInventario || AI.CUENTAS.INVENTARIO).trim();
  const cuentaCosto = String(datos.cuentaCosto || AI.CUENTAS.COSTO_VENTAS).trim();
  if (tipo === 'bien') await validarCuentasProducto(empresaId, { cuentaInventario, cuentaCosto });
  const minimo = numero(datos.cantidadMinima, 'La cantidad mínima', { max: MAX_CANTIDAD }) || 0;

  const inicial = datos.saldoInicial && datos.saldoInicial.cantidad !== undefined && datos.saldoInicial.cantidad !== '' ? datos.saldoInicial : null;
  if (inicial && tipo === 'servicio') throw new Error('Un servicio no lleva existencias.');

  const prepInicial = inicial
    ? await prepararManual(
      { tipo, activo: true, costoPromedio: 0, ultimoCosto: 0 },
      {
        concepto: 'saldo_inicial', cantidad: inicial.cantidad, costoUnitario: inicial.costoUnitario, valorTotal: inicial.valorTotal,
        fecha: inicial.fecha, sinAsiento: inicial.sinAsiento !== false && inicial.sinAsiento !== 'false', contrapartida: inicial.contrapartida,
        observacion: 'Existencias iniciales',
      },
      usuario
    )
    : null;

  const producto = await sequelize.transaction(async (transaction) => {
    const p = await Producto.create({
      id: uuidv4(),
      empresaId,
      codigo,
      nombre,
      categoria: limpiarTexto(datos.categoria, 60, 'La categoría', false),
      tipo,
      unidadMedida: limpiarTexto(datos.unidadMedida, 20, 'La unidad', false) || 'unidad',
      cantidadDisponible: 0,
      valorInventario: 0,
      costoPromedio: 0,
      ultimoCosto: 0,
      cantidadMinima: minimo,
      cuentaInventario: tipo === 'bien' ? cuentaInventario : AI.CUENTAS.INVENTARIO,
      cuentaCosto: tipo === 'bien' ? cuentaCosto : AI.CUENTAS.COSTO_VENTAS,
      alias: [],
      activo: true,
      origen: datos.origen === 'factura_compra' ? 'factura_compra' : 'manual',
    }, { transaction });
    if (prepInicial) await ejecutarManual(p.id, prepInicial, usuario, transaction);
    return p;
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'producto_creado', entidad: 'Producto', entidadId: producto.id, detalle: nombre,
  });
  return vistaProducto(await Producto.findByPk(producto.id));
}

async function actualizarProducto(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const p = await productoDe(id, empresaId);
  const cambios = {};
  if (datos.nombre !== undefined) cambios.nombre = limpiarTexto(datos.nombre, 150, 'El nombre', true);
  if (datos.codigo !== undefined) {
    cambios.codigo = limpiarTexto(datos.codigo, 50, 'El código', false);
    await codigoLibre(empresaId, cambios.codigo, p.id);
  }
  if (datos.categoria !== undefined) cambios.categoria = limpiarTexto(datos.categoria, 60, 'La categoría', false);
  if (datos.unidadMedida !== undefined) cambios.unidadMedida = limpiarTexto(datos.unidadMedida, 20, 'La unidad', false) || 'unidad';
  if (datos.cantidadMinima !== undefined) cambios.cantidadMinima = numero(datos.cantidadMinima, 'La cantidad mínima', { max: MAX_CANTIDAD }) || 0;
  if (datos.activo !== undefined) {
    cambios.activo = !!datos.activo;
    const s = saldoDe(p);
    if (!cambios.activo && (s.cantidad !== 0 || s.valor !== 0)) {
      throw new Error('No se puede inactivar un producto con existencias o valor en inventario. Sácalas primero con una salida o un ajuste.');
    }
  }
  const tocaCuentas = (datos.cuentaInventario !== undefined && datos.cuentaInventario !== p.cuentaInventario)
    || (datos.cuentaCosto !== undefined && datos.cuentaCosto !== p.cuentaCosto);
  if (tocaCuentas) {
    if (!['contador', 'dueño'].includes(usuario.rol)) throw new Error('Solo el contador o el dueño pueden cambiar las cuentas contables de un producto.');
    await validarCuentasProducto(empresaId, datos);
    if (datos.cuentaInventario !== undefined && datos.cuentaInventario !== p.cuentaInventario) {
      const s = saldoDe(p);
      const haMovido = await KardexMovimiento.count({ where: { productoId: p.id, anulado: false } });
      if (haMovido && (s.cantidad !== 0 || s.valor !== 0)) {
        throw new Error(`El producto tiene existencias contabilizadas en ${p.cuentaInventario}; sácalas antes de cambiarle la cuenta de inventario.`);
      }
      cambios.cuentaInventario = String(datos.cuentaInventario).trim();
    }
    if (datos.cuentaCosto !== undefined) cambios.cuentaCosto = String(datos.cuentaCosto).trim();
  }
  if (datos.tipo !== undefined && datos.tipo !== p.tipo) {
    const haMovido = await KardexMovimiento.count({ where: { productoId: p.id } });
    if (haMovido) throw new Error('El producto ya tiene movimientos; no se le puede cambiar el tipo.');
    cambios.tipo = datos.tipo === 'servicio' ? 'servicio' : 'bien';
  }
  await p.update(cambios);
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'producto_actualizado', entidad: 'Producto', entidadId: p.id, detalle: Object.keys(cambios).join(', '),
  });
  return vistaProducto(p);
}

// --- Movimientos (núcleo) -----------------------------------------------------------------
// Aplica un movimiento al producto (ya bloqueado dentro de la transacción) y deja la fila del kardex.
async function aplicarMovimiento(p, m, transaction) {
  const saldo = saldoDe(p);
  let calculo;
  if (m.tipo === 'entrada') {
    calculo = CI.entrada(saldo, m.cantidad, m.valor);
  } else {
    calculo = CI.salida(saldo, m.cantidad, Number(p.ultimoCosto) || Number(p.costoPromedio));
  }
  const valor = m.tipo === 'entrada' ? CI.centavos(m.valor) / 100 : calculo.valor;
  const secuencia = ((await KardexMovimiento.max('secuencia', { where: { productoId: p.id }, transaction })) || 0) + 1;
  const mov = await KardexMovimiento.create({
    id: uuidv4(),
    empresaId: p.empresaId,
    productoId: p.id,
    secuencia,
    fecha: m.fecha,
    tipo: m.tipo,
    concepto: m.concepto,
    cantidad: CI.cantidad4(m.cantidad),
    valor,
    costoUnitario: calculo.costoUnitario,
    saldoCantidad: calculo.saldo.cantidad,
    saldoValor: calculo.saldo.valor,
    saldoCosto: calculo.costoPromedio,
    origenTipo: m.origenTipo || 'manual',
    origenId: m.origenId || null,
    documento: m.documento || null,
    terceroId: m.terceroId || null,
    contrapartida: m.contrapartida || null,
    observacion: m.observacion || null,
    sinExistencias: !!calculo.sinExistencias,
    usuarioId: m.usuarioId || null,
  }, { transaction });
  const cambios = {
    cantidadDisponible: calculo.saldo.cantidad,
    valorInventario: calculo.saldo.valor,
    costoPromedio: calculo.costoPromedio,
  };
  if (m.tipo === 'entrada' && calculo.costoUnitario > 0) cambios.ultimoCosto = calculo.costoUnitario;
  await p.update(cambios, { transaction });
  return { movimiento: mov, calculo };
}

function periodoContableTexto(fecha) {
  return fecha.slice(0, 7);
}

// Movimiento hecho a mano (con su asiento, salvo el saldo inicial "solo kardex").
// Se separa en dos pasos: preparar (todas las validaciones, antes de abrir la transacción)
// y ejecutar (escribe, dentro de la transacción).
async function prepararManual(p, datos, usuario) {
  const empresaId = usuario.empresaId;
  if (p.tipo !== 'bien') throw new Error('Un servicio no lleva inventario.');
  if (!p.activo) throw new Error('El producto está inactivo.');
  const concepto = AI.CONCEPTOS[datos.concepto];
  if (!concepto) throw new Error('Elige el tipo de movimiento.');
  const fecha = datos.fecha || hoyColombia();
  if (!fechaValida(fecha)) throw new Error('Escribe la fecha (AAAA-MM-DD).');
  if (fecha > hoyColombia()) throw new Error('La fecha no puede ser futura.');
  const cantidad = numero(datos.cantidad, 'La cantidad', { obligatorio: true, positivo: true, max: MAX_CANTIDAD });

  // Valor de una entrada: costo unitario o valor total; los sobrantes y devoluciones toman el costo actual.
  let valorEntrada = null;
  if (concepto.tipo === 'entrada') {
    const unit = numero(datos.costoUnitario, 'El costo unitario', { max: MAX_VALOR });
    const total = numero(datos.valorTotal, 'El valor total', { max: MAX_VALOR, decimales: 2 });
    if (total !== null) valorEntrada = total;
    else if (unit !== null) valorEntrada = redondear2(cantidad * unit);
    else if (['sobrante', 'devolucion_cliente'].includes(datos.concepto)) {
      const c = Number(p.costoPromedio) || Number(p.ultimoCosto);
      if (!(c > 0)) throw new Error('Este producto no tiene costo conocido: escribe el costo unitario.');
      valorEntrada = redondear2(cantidad * c);
    } else {
      throw new Error('Escribe el costo unitario (o el valor total) de lo que entra.');
    }
  }

  const sinAsiento = !!concepto.sinAsiento && datos.sinAsiento !== false && datos.sinAsiento !== 'false';
  if (datos.sinAsiento === true && !concepto.sinAsiento) throw new Error('Solo el saldo inicial puede registrarse sin asiento contable.');
  const contrapartida = sinAsiento ? null : String(datos.contrapartida || concepto.contrapartida || '').trim();
  if (!sinAsiento) {
    if (!contrapartida) throw new Error('Elige la cuenta contra la que se contabiliza este movimiento.');
    if (contrapartida.startsWith('14')) throw new Error('La contrapartida no puede ser otra cuenta de inventario.');
    await validarCuenta(empresaId, contrapartida, { etiqueta: 'La cuenta de contrapartida' });
  }
  let terceroId = datos.terceroId || null;
  if (terceroId) {
    const t = await Tercero.findOne({ where: { id: terceroId, empresaId } });
    if (!t) throw new Error('El tercero elegido no existe.');
  }
  const observacion = limpiarTexto(datos.observacion, 250, 'La observación', false);
  const documento = limpiarTexto(datos.documento, 60, 'El documento', false);
  if (['faltante', 'baja', 'otra_salida', 'otra_entrada', 'sobrante'].includes(datos.concepto) && !observacion) {
    throw new Error('Escribe el motivo en la observación.');
  }
  if (!sinAsiento) await aprovisionarContabilidadBase(empresaId);
  return { concepto, conceptoCodigo: datos.concepto, fecha, cantidad, valorEntrada, sinAsiento, contrapartida, terceroId, observacion, documento };
}

async function ejecutarManual(productoId, prep, usuario, transaction) {
  const empresaId = usuario.empresaId;
  const { concepto, fecha, cantidad, sinAsiento, contrapartida, terceroId } = prep;
  const prod = await productoDe(productoId, empresaId, transaction);
  if (concepto.tipo === 'salida') {
    const s = saldoDe(prod);
    if (s.cantidad < cantidad) {
      throw new Error(`No hay suficiente inventario de "${prod.nombre}": hay ${s.cantidad} ${prod.unidadMedida} y se intenta sacar ${cantidad}.`);
    }
  }
  const r = await aplicarMovimiento(prod, {
    tipo: concepto.tipo, concepto: prep.conceptoCodigo, cantidad, valor: prep.valorEntrada, fecha,
    origenTipo: 'manual', documento: prep.documento, terceroId, contrapartida, observacion: prep.observacion, usuarioId: usuario.id,
  }, transaction);
  let asientoId = null;
  if (!sinAsiento && r.movimiento.valor > 0) {
    await asegurarReglas(empresaId, transaction);
    const asiento = AI.armarAsientoMovimiento({
      tipo: concepto.tipo, valor: Number(r.movimiento.valor), cuentaInventario: prod.cuentaInventario, contrapartida, terceroId,
    });
    if (!asiento.cuadra) throw new Error('El asiento del movimiento no cuadra.');
    const res = await contabilizarAsientoCompuesto({
      empresaId,
      tipoEvento: concepto.tipo === 'entrada' ? 'inventario_entrada_manual' : 'inventario_salida_manual',
      origenModulo: 'inventarios',
      origenId: r.movimiento.id,
      fecha,
      terceroId: terceroId || undefined,
      usuarioId: usuario.id,
      lineas: asiento.lineas,
      revisado: true,
      transaction,
    });
    if (res.periodoAjustado) {
      throw new Error(`El período contable de ${periodoContableTexto(fecha)} está cerrado o no existe; ábrelo o créalo antes de registrar este movimiento.`);
    }
    asientoId = res.asiento ? res.asiento.id : null;
    await r.movimiento.update({ asientoId }, { transaction });
  }
  return { ...r, asientoId, producto: prod };
}

async function crearMovimiento(datos, usuario) {
  const p = await productoDe(datos.productoId, usuario.empresaId);
  const prep = await prepararManual(p, datos, usuario);
  const r = await sequelize.transaction((transaction) => ejecutarManual(p.id, prep, usuario, transaction));
  await auditoria.registrar({
    empresaId: usuario.empresaId, usuarioId: usuario.id, accion: 'inventario_movimiento', entidad: 'KardexMovimiento', entidadId: r.movimiento.id,
    detalle: `${datos.concepto} · ${p.nombre} · ${r.movimiento.cantidad}`,
  });
  return {
    movimiento: vistaMovimiento(r.movimiento, p),
    producto: vistaProducto(await Producto.findByPk(p.id)),
    asientoId: r.asientoId,
  };
}

function vistaMovimiento(m, p) {
  return {
    id: m.id,
    productoId: m.productoId,
    producto: p ? p.nombre : undefined,
    codigo: p ? p.codigo : undefined,
    unidadMedida: p ? p.unidadMedida : undefined,
    secuencia: m.secuencia,
    fecha: m.fecha,
    tipo: m.tipo,
    concepto: m.concepto,
    conceptoTexto: (AI.CONCEPTOS[m.concepto] && AI.CONCEPTOS[m.concepto].nombre) || AI.CONCEPTOS_FACTURA[m.concepto] || m.concepto,
    cantidad: Number(m.cantidad),
    valor: Number(m.valor),
    costoUnitario: Number(m.costoUnitario),
    saldoCantidad: Number(m.saldoCantidad),
    saldoValor: Number(m.saldoValor),
    saldoCosto: Number(m.saldoCosto),
    origenTipo: m.origenTipo,
    origenId: m.origenId,
    documento: m.documento,
    observacion: m.observacion,
    contrapartida: m.contrapartida,
    asientoId: m.asientoId,
    sinExistencias: m.sinExistencias,
    anulado: m.anulado,
    motivoAnulacion: m.motivoAnulacion,
  };
}

async function anularMovimiento(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const motivo = limpiarTexto(datos && datos.motivo, 250, 'El motivo', true);
  if (motivo.length < 10) throw new Error('Escribe el motivo de la anulación (mínimo 10 letras).');
  const mov = await KardexMovimiento.findOne({ where: { id: id || null, empresaId } });
  if (!mov) throw new Error('El movimiento no existe.');
  if (mov.anulado) throw new Error('El movimiento ya está anulado.');
  if (mov.origenTipo !== 'manual') {
    throw new Error('Este movimiento viene de una factura. Las facturas todavía no se pueden anular desde el sistema; corrige con un ajuste (entrada o salida manual).');
  }
  await sequelize.transaction(async (transaction) => {
    const p = await productoDe(mov.productoId, empresaId, transaction);
    const ultimo = await KardexMovimiento.findOne({ where: { productoId: p.id, anulado: false }, order: [['secuencia', 'DESC']], transaction });
    if (!ultimo || ultimo.id !== mov.id) {
      throw new Error('Solo se puede anular el último movimiento del producto. Si hubo movimientos después, corrige con un ajuste.');
    }
    if (mov.asientoId) {
      const asiento = await Asiento.findOne({ where: { id: mov.asientoId, empresaId }, transaction });
      if (asiento) {
        const pc = await PeriodoContable.findByPk(asiento.periodoContableId, { transaction });
        if (pc && !['abierto', 'en_cierre'].includes(pc.estado)) {
          throw new Error('El período contable de este movimiento ya está cerrado; no se puede anular su asiento.');
        }
        await asiento.update({ estado: 'anulado' }, { transaction });
      }
    }
    await mov.update({ anulado: true, motivoAnulacion: motivo }, { transaction });
    const previo = await KardexMovimiento.findOne({ where: { productoId: p.id, anulado: false }, order: [['secuencia', 'DESC']], transaction });
    const ultimaEntrada = await KardexMovimiento.findOne({ where: { productoId: p.id, anulado: false, tipo: 'entrada' }, order: [['secuencia', 'DESC']], transaction });
    await p.update({
      cantidadDisponible: previo ? Number(previo.saldoCantidad) : 0,
      valorInventario: previo ? Number(previo.saldoValor) : 0,
      costoPromedio: previo ? Number(previo.saldoCosto) : 0,
      ultimoCosto: ultimaEntrada ? Number(ultimaEntrada.costoUnitario) : 0,
    }, { transaction });
  });
  await auditoria.registrar({
    empresaId, usuarioId: usuario.id, accion: 'inventario_movimiento_anulado', entidad: 'KardexMovimiento', entidadId: mov.id, detalle: motivo,
  });
  const p = await Producto.findByPk(mov.productoId);
  return { producto: vistaProducto(p) };
}

// --- Consultas: kardex, movimientos, valoración ---------------------------------------------
function validarRango(filtros) {
  const desde = filtros.desde || null;
  const hasta = filtros.hasta || null;
  if (desde && !fechaValida(desde)) throw new Error('La fecha "desde" no es válida.');
  if (hasta && !fechaValida(hasta)) throw new Error('La fecha "hasta" no es válida.');
  if (desde && hasta && desde > hasta) throw new Error('La fecha "desde" es posterior a la fecha "hasta".');
  return { desde, hasta };
}

async function kardexDeProducto(productoId, filtros, usuario) {
  const empresaId = usuario.empresaId;
  const p = await productoDe(productoId, empresaId);
  const { desde, hasta } = validarRango(filtros || {});
  const where = { productoId: p.id, empresaId };
  if (desde || hasta) where.fecha = Object.assign({}, desde ? { [Op.gte]: desde } : {}, hasta ? { [Op.lte]: hasta } : {});
  const filas = await KardexMovimiento.findAll({ where, order: [['secuencia', 'ASC']] });
  let inicial = { cantidad: 0, valor: 0 };
  if (desde) {
    const antes = await KardexMovimiento.findAll({ where: { productoId: p.id, empresaId, anulado: false, fecha: { [Op.lt]: desde } }, order: [['secuencia', 'DESC']], limit: 1 });
    if (antes[0]) inicial = { cantidad: Number(antes[0].saldoCantidad), valor: Number(antes[0].saldoValor) };
  }
  const vigentes = filas.filter((f) => !f.anulado);
  const entradas = vigentes.filter((f) => f.tipo === 'entrada');
  const salidas = vigentes.filter((f) => f.tipo === 'salida');
  const suma = (arr, k) => arr.reduce((s, f) => s + Number(f[k]), 0);
  return {
    producto: vistaProducto(p),
    desde, hasta,
    saldoInicial: inicial,
    movimientos: filas.map((f) => vistaMovimiento(f, p)),
    totales: {
      entradasCantidad: CI.cantidad4(suma(entradas, 'cantidad')), entradasValor: redondear2(suma(entradas, 'valor')),
      salidasCantidad: CI.cantidad4(suma(salidas, 'cantidad')), salidasValor: redondear2(suma(salidas, 'valor')),
    },
    ultimoMovimientoId: (() => { const v = vigentes[vigentes.length - 1]; return v ? v.id : null; })(),
  };
}

async function listarMovimientos(usuario, filtros = {}) {
  const empresaId = usuario.empresaId;
  const { desde, hasta } = validarRango(filtros);
  const where = { empresaId };
  if (filtros.productoId) where.productoId = filtros.productoId;
  if (filtros.concepto) where.concepto = String(filtros.concepto);
  if (desde || hasta) where.fecha = Object.assign({}, desde ? { [Op.gte]: desde } : {}, hasta ? { [Op.lte]: hasta } : {});
  const filas = await KardexMovimiento.findAll({ where, order: [['fecha', 'DESC'], ['createdAt', 'DESC']], limit: LIMITE_MOVIMIENTOS });
  const productos = await Producto.findAll({ where: { empresaId, id: { [Op.in]: Array.from(new Set(filas.map((f) => f.productoId))) } } });
  const porId = Object.fromEntries(productos.map((p) => [p.id, p]));
  return { movimientos: filas.map((f) => vistaMovimiento(f, porId[f.productoId])), limite: LIMITE_MOVIMIENTOS, truncado: filas.length === LIMITE_MOVIMIENTOS };
}

// Saldo contable de las cuentas de inventario (14xx) a una fecha.
async function saldoContable(empresaId, corte) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId, codigo: { [Op.like]: '14%' } } });
  if (!cuentas.length) return {};
  const ids = cuentas.map((c) => c.id);
  const movs = await Movimiento.findAll({ where: { cuentaId: { [Op.in]: ids } } });
  if (!movs.length) return {};
  const asientos = await Asiento.findAll({
    where: { empresaId, estado: 'contabilizado', fecha: { [Op.lte]: corte }, id: { [Op.in]: Array.from(new Set(movs.map((m) => m.asientoId))) } },
    attributes: ['id'],
  });
  const validos = new Set(asientos.map((a) => a.id));
  const codigoPorId = Object.fromEntries(cuentas.map((c) => [c.id, c.codigo]));
  const porGrupo = {};
  for (const m of movs) {
    if (!validos.has(m.asientoId)) continue;
    const grupo = codigoPorId[m.cuentaId].slice(0, 4);
    porGrupo[grupo] = redondear2((porGrupo[grupo] || 0) + Number(m.debito) - Number(m.credito));
  }
  return porGrupo;
}

async function valoracion(usuario, filtros = {}) {
  const empresaId = usuario.empresaId;
  const hoy = hoyColombia();
  const corte = filtros.corte || hoy;
  if (!fechaValida(corte)) throw new Error('La fecha de corte no es válida.');
  const productos = await Producto.findAll({ where: { empresaId, tipo: 'bien' }, order: [['nombre', 'ASC']] });

  let saldos; // productoId -> { cantidad, valor, costo }
  if (corte >= hoy) {
    saldos = Object.fromEntries(productos.map((p) => { const s = saldoDe(p); return [p.id, { cantidad: s.cantidad, valor: s.valor, costo: Number(p.costoPromedio) }]; }));
  } else {
    const filas = await KardexMovimiento.findAll({ where: { empresaId, anulado: false, fecha: { [Op.lte]: corte } }, order: [['productoId', 'ASC'], ['secuencia', 'ASC']] });
    saldos = {};
    for (const f of filas) saldos[f.productoId] = { cantidad: Number(f.saldoCantidad), valor: Number(f.saldoValor), costo: Number(f.saldoCosto) };
  }

  const filasProducto = productos
    .map((p) => {
      const s = saldos[p.id] || { cantidad: 0, valor: 0, costo: 0 };
      return {
        id: p.id, codigo: p.codigo, nombre: p.nombre, categoria: p.categoria, unidadMedida: p.unidadMedida, cuentaInventario: p.cuentaInventario,
        cantidad: s.cantidad, costoPromedio: s.costo, valor: s.valor, negativo: s.cantidad < 0, valorSinUnidades: s.cantidad === 0 && s.valor !== 0,
      };
    })
    .filter((f) => filtros.incluirCeros === 'true' || filtros.incluirCeros === true || f.cantidad !== 0 || f.valor !== 0);

  const contable = await saldoContable(empresaId, corte);
  const porGrupo = {};
  for (const f of filasProducto) {
    const g = String(f.cuentaInventario).slice(0, 4);
    porGrupo[g] = redondear2((porGrupo[g] || 0) + f.valor);
  }
  const grupos = Array.from(new Set([...Object.keys(porGrupo), ...Object.keys(contable)])).sort();
  const nombres = await PlanCuentas.findAll({ where: { empresaId, codigo: { [Op.in]: grupos } } });
  const nombrePorCodigo = Object.fromEntries(nombres.map((c) => [c.codigo, c.nombre]));
  const conciliacion = grupos.map((g) => {
    const kardex = porGrupo[g] || 0;
    const contabilidad = contable[g] || 0;
    return { cuenta: g, nombre: nombrePorCodigo[g] || nombresCuentas[g] || '', kardex, contabilidad, diferencia: redondear2(kardex - contabilidad) };
  });
  return {
    corte,
    productos: filasProducto,
    total: redondear2(filasProducto.reduce((s, f) => s + f.valor, 0)),
    conciliacion,
    cuadra: conciliacion.every((c) => Math.abs(c.diferencia) < 0.005),
  };
}

function celdaCsv(v) {
  let t = String(v == null ? '' : v);
  // Un texto que empieza con = + - @ lo interpreta Excel como fórmula.
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t)) t = `'${t}`;
  return /[",;\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
const aCsv = (filas) => '﻿' + filas.map((f) => f.map(celdaCsv).join(';')).join('\r\n');

async function valoracionCsv(usuario, filtros) {
  const v = await valoracion(usuario, filtros);
  const filas = [['Código', 'Producto', 'Categoría', 'Unidad', 'Cuenta', 'Cantidad', 'Costo promedio', 'Valor']];
  for (const f of v.productos) filas.push([f.codigo || '', f.nombre, f.categoria || '', f.unidadMedida, f.cuentaInventario, f.cantidad, f.costoPromedio, f.valor]);
  filas.push(['', 'TOTAL', '', '', '', '', '', v.total]);
  return { nombre: `inventario-valorado-${v.corte}.csv`, contenido: aCsv(filas) };
}

async function kardexCsv(productoId, filtros, usuario) {
  const k = await kardexDeProducto(productoId, filtros, usuario);
  const filas = [['Fecha', 'Concepto', 'Documento', 'Entrada cant.', 'Entrada valor', 'Salida cant.', 'Salida valor', 'Saldo cant.', 'Saldo valor', 'Costo promedio', 'Observación']];
  filas.push(['', 'Saldo inicial', '', '', '', '', '', k.saldoInicial.cantidad, k.saldoInicial.valor, '', '']);
  for (const m of k.movimientos) {
    if (m.anulado) continue;
    filas.push([m.fecha, m.conceptoTexto, m.documento || '', m.tipo === 'entrada' ? m.cantidad : '', m.tipo === 'entrada' ? m.valor : '', m.tipo === 'salida' ? m.cantidad : '', m.tipo === 'salida' ? m.valor : '', m.saldoCantidad, m.saldoValor, m.saldoCosto, m.observacion || '']);
  }
  const base = (k.producto.codigo || k.producto.nombre).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
  return { nombre: `kardex-${base}.csv`, contenido: aCsv(filas) };
}

// --- Opciones para la pantalla ---------------------------------------------------------------
async function opciones(usuario) {
  const empresaId = usuario.empresaId;
  const cuentas = await PlanCuentas.findAll({ where: { empresaId, activa: true }, attributes: ['codigo', 'nombre'], order: [['codigo', 'ASC']] });
  const enPlan = new Set(cuentas.map((c) => c.codigo));
  const faltantes = AI.CATALOGO.filter((c) => !enPlan.has(c.codigo)).map((c) => ({ codigo: c.codigo, nombre: c.nombre, nueva: true }));
  const todas = [...cuentas.map((c) => ({ codigo: c.codigo, nombre: c.nombre })), ...faltantes].sort((a, b) => (a.codigo < b.codigo ? -1 : 1));
  return {
    hoy: hoyColombia(),
    conceptos: Object.entries(AI.CONCEPTOS).map(([codigo, c]) => ({ codigo, ...c })),
    cuentasInventario: todas.filter((c) => c.codigo.length === 4 && c.codigo.startsWith('14')),
    cuentasCosto: todas.filter((c) => c.codigo.startsWith('61')),
    cuentas: todas.filter((c) => !c.codigo.startsWith('14')),
    puedeCambiarCuentas: ['contador', 'dueño'].includes(usuario.rol),
  };
}

// === Enganche con las facturas ============================================================
// Estas funciones las llaman las facturas de compra y de venta DENTRO de su propia
// transacción, para que o se guarda todo (factura + asiento + inventario) o nada.

const vistaCorta = (p) => ({
  id: p.id, codigo: p.codigo, nombre: p.nombre, unidadMedida: p.unidadMedida, tipo: p.tipo,
  cantidad: Number(p.cantidadDisponible), costoPromedio: Number(p.costoPromedio), ultimoCosto: Number(p.ultimoCosto), cuentaInventario: p.cuentaInventario,
});

// Para la vista previa: productos disponibles y cuál reconoce el sistema en cada línea.
async function sugerirProductos(empresaId, lineas, { origen, nit } = {}) {
  const productos = await Producto.findAll({ where: { empresaId, tipo: 'bien', activo: true }, order: [['nombre', 'ASC']] });
  const planos = productos.map((p) => ({ id: p.id, codigo: p.codigo, nombre: p.nombre, alias: p.alias || [], tipo: p.tipo, activo: p.activo }));
  const sugerencias = (lineas || []).map((l, i) => {
    const r = CI.buscarProducto(planos, { codigo: l.codigo, descripcion: l.descripcion }, { origen, nit });
    return { linea: i, productoId: r ? r.producto.id : null, motivo: r ? r.motivo : null };
  });
  return { productos: productos.map(vistaCorta), sugerencias };
}

function recordarAlias(p, origen, nit, linea) {
  const claves = CI.clavesAlias(origen, nit, linea);
  if (!claves.length) return false;
  const alias = Array.isArray(p.alias) ? p.alias.slice() : [];
  const nuevo = claves.filter((k) => !alias.includes(k));
  if (!nuevo.length) return false;
  // Se guardan todas las claves de la línea (código y descripción); tope por producto.
  p.alias = alias.concat(nuevo).slice(-40);
  return true;
}

// Entradas por compra. lineas: [{ i, linea:{codigo,descripcion,cantidad,unidad}, valor, cuentaCodigo, seleccion }]
//   seleccion: id de producto | 'nuevo' | vacío (reconocer solo; si no se reconoce, se crea).
async function entradasDeCompra({ empresaId, usuario, factura, proveedor, lineas, transaction }) {
  const resumen = [];
  const advertencias = [];
  if (!lineas.length) return { movimientos: resumen, advertencias };
  const productos = await Producto.findAll({ where: { empresaId, tipo: 'bien', activo: true }, transaction });
  const planos = productos.map((p) => ({ id: p.id, codigo: p.codigo, nombre: p.nombre, alias: p.alias || [], tipo: p.tipo, activo: p.activo }));

  for (const it of lineas) {
    const l = it.linea;
    const cantidad = CI.cantidad4(l.cantidad);
    if (!(cantidad > 0)) {
      throw new Error(`La línea ${it.i + 1} ("${String(l.descripcion || '').slice(0, 60)}") va a inventario pero no trae cantidad.`);
    }
    let p = null;
    let creado = false;
    let enlaceManual = false;
    if (it.seleccion && it.seleccion !== 'nuevo') {
      p = await Producto.findOne({ where: { id: it.seleccion, empresaId }, transaction });
      if (!p || p.tipo !== 'bien') throw new Error(`El producto elegido para la línea ${it.i + 1} no existe o no es un bien.`);
      enlaceManual = true;
    } else if (it.seleccion !== 'nuevo') {
      const r = CI.buscarProducto(planos, { codigo: l.codigo, descripcion: l.descripcion }, { origen: 'compra', nit: proveedor.nit });
      if (r) p = await Producto.findOne({ where: { id: r.producto.id, empresaId }, transaction });
    }
    if (!p) {
      const nombre = String(l.descripcion || `Producto ${l.codigo || it.i + 1}`).replace(/\s+/g, ' ').trim().slice(0, 150) || 'Producto sin nombre';
      p = await Producto.create({
        id: uuidv4(), empresaId, codigo: null, nombre, tipo: 'bien', unidadMedida: CI.unidadDesdeXml(l.unidad),
        cantidadDisponible: 0, valorInventario: 0, costoPromedio: 0, ultimoCosto: 0, cantidadMinima: 0,
        cuentaInventario: it.cuentaCodigo.slice(0, 4), cuentaCosto: AI.CUENTAS.COSTO_VENTAS, alias: [], activo: true, origen: 'factura_compra',
      }, { transaction });
      creado = true;
      planos.push({ id: p.id, codigo: null, nombre: p.nombre, alias: [], tipo: 'bien', activo: true });
    } else if (String(p.cuentaInventario).slice(0, 4) !== it.cuentaCodigo.slice(0, 4)) {
      throw new Error(`La línea ${it.i + 1} va a la cuenta ${it.cuentaCodigo}, pero el producto "${p.nombre}" se lleva en ${p.cuentaInventario}. Cambia la cuenta de la línea o la del producto para que el kardex cuadre con la contabilidad.`);
    }
    if (creado || enlaceManual) {
      if (recordarAlias(p, 'compra', proveedor.nit, { codigo: l.codigo, descripcion: l.descripcion })) await p.save({ transaction });
    }
    const bloqueado = await productoDe(p.id, empresaId, transaction);
    const r = await aplicarMovimiento(bloqueado, {
      tipo: 'entrada', concepto: 'compra', cantidad, valor: it.valor, fecha: factura.fecha,
      origenTipo: 'factura_compra', origenId: factura.id, documento: factura.numero, terceroId: proveedor.terceroId,
      observacion: String(l.descripcion || '').slice(0, 250), usuarioId: usuario.id,
    }, transaction);
    resumen.push({ linea: it.i, productoId: p.id, producto: p.nombre, cantidad, valor: Number(r.movimiento.valor), creado, movimientoId: r.movimiento.id });
    if (creado) advertencias.push(`Se creó el producto "${p.nombre}" (línea ${it.i + 1}). Puedes ponerle código y mínimo en Inventarios.`);
  }
  return { movimientos: resumen, advertencias };
}

// Salidas por venta + asiento del costo. lineas: [{ i, linea, seleccion }]
//   seleccion: id de producto | 'ninguno' | vacío (reconocer solo; si no se reconoce, no se descarga).
async function salidasDeVenta({ empresaId, usuario, factura, cliente, lineas, centroCosto, transaction }) {
  const resumen = [];
  const advertencias = [];
  const costos = [];
  const productos = await Producto.findAll({ where: { empresaId, tipo: 'bien', activo: true }, transaction });
  const planos = productos.map((p) => ({ id: p.id, codigo: p.codigo, nombre: p.nombre, alias: p.alias || [], tipo: p.tipo, activo: p.activo }));
  const sinProducto = [];

  for (const it of lineas) {
    if (it.seleccion === 'ninguno') continue;
    const l = it.linea;
    let p = null;
    let enlaceManual = false;
    if (it.seleccion) {
      p = await Producto.findOne({ where: { id: it.seleccion, empresaId }, transaction });
      if (!p || p.tipo !== 'bien') throw new Error(`El producto elegido para la línea ${it.i + 1} no existe o no es un bien.`);
      enlaceManual = true;
    } else {
      const r = CI.buscarProducto(planos, { codigo: l.codigo, descripcion: l.descripcion }, { origen: 'venta' });
      if (r) p = await Producto.findOne({ where: { id: r.producto.id, empresaId }, transaction });
    }
    if (!p) {
      if (planos.length) sinProducto.push(it.i + 1);
      continue;
    }
    const cantidad = CI.cantidad4(l.cantidad);
    if (!(cantidad > 0)) {
      advertencias.push(`La línea ${it.i + 1} no trae cantidad: no se descargó "${p.nombre}".`);
      continue;
    }
    if (enlaceManual && recordarAlias(p, 'venta', null, { codigo: l.codigo, descripcion: l.descripcion })) await p.save({ transaction });
    const bloqueado = await productoDe(p.id, empresaId, transaction);
    const r = await aplicarMovimiento(bloqueado, {
      tipo: 'salida', concepto: 'venta', cantidad, fecha: factura.fecha,
      origenTipo: 'factura_venta', origenId: factura.id, documento: factura.numero, terceroId: cliente.terceroId,
      observacion: String(l.descripcion || '').slice(0, 250), usuarioId: usuario.id,
    }, transaction);
    const v = Number(r.movimiento.valor);
    costos.push({ cuentaInventario: p.cuentaInventario, cuentaCosto: p.cuentaCosto, valor: v });
    resumen.push({ linea: it.i, productoId: p.id, producto: p.nombre, cantidad, costo: v, movimientoId: r.movimiento.id, sinExistencias: r.calculo.sinExistencias, sinCosto: r.calculo.sinCosto });
    if (r.calculo.sinExistencias) {
      advertencias.push(`"${p.nombre}": se vendieron ${cantidad} y no había suficientes existencias (faltaron ${r.calculo.faltante}). El saldo quedó en negativo; se corrige al registrar la compra.`);
    }
    if (r.calculo.sinCosto) advertencias.push(`"${p.nombre}" no tiene costo conocido: la venta quedó con costo cero. Registra la compra o el saldo inicial.`);
  }
  if (sinProducto.length) advertencias.push(`Las líneas ${sinProducto.join(', ')} no están enlazadas a un producto: no descargaron inventario (normal si son servicios).`);

  let asientoId = null;
  const totalCosto = redondear2(costos.reduce((s, c) => s + c.valor, 0));
  if (totalCosto > 0) {
    await asegurarReglas(empresaId, transaction);
    const asiento = AI.armarAsientoCostoVenta(costos, { centroCosto });
    if (!asiento.cuadra) throw new Error('El asiento del costo de ventas no cuadra.');
    const res = await contabilizarAsientoCompuesto({
      empresaId, tipoEvento: 'salida_inventario_venta', origenModulo: 'inventarios', origenId: factura.id, fecha: factura.fecha,
      terceroId: cliente.terceroId, usuarioId: usuario.id, lineas: asiento.lineas, revisado: true, transaction,
    });
    asientoId = res.asiento ? res.asiento.id : null;
    if (asientoId) {
      await KardexMovimiento.update({ asientoId }, { where: { id: { [Op.in]: resumen.map((r) => r.movimientoId) } }, transaction });
    }
  }
  return { movimientos: resumen, advertencias, costoTotal: totalCosto, asientoId };
}

module.exports = {
  opciones,
  listarProductos, crearProducto, actualizarProducto,
  crearMovimiento, anularMovimiento, listarMovimientos, kardexDeProducto, valoracion,
  valoracionCsv, kardexCsv,
  sugerirProductos, entradasDeCompra, salidasDeVenta,
};
