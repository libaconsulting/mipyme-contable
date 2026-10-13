// Documento soporte por compras a proveedores NO obligados a facturar,
// expedido en otro sistema (Siigo) y registrado aquí para contabilizarlo.
//
// Siigo solo entrega el PDF de este documento (no hay XML que leer), así que los
// datos se digitan en pantalla y el PDF se guarda como soporte documental.
//
// Asiento (mismo módulo del navegador, public/contable/asientoCompra.js):
//   Db  Cuenta de gasto / costo / activo (por línea)       valor bruto
//   Cr  2365 Retención en la fuente por pagar              retención practicada
//   Cr  2335 Costos y gastos por pagar                     bruto - retención
// Un documento soporte no lleva IVA: el proveedor no es responsable ni facturador.

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Empresa = require('../../../core/models/Empresa');
const Tercero = require('../../../core/models/Tercero');
const Proyecto = require('../../../core/models/Proyecto');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Movimiento = require('../../../core/models/Movimiento');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const { contabilizarAsientoCompuesto } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const calcularOrden = require('../../../../public/contable/calculoOrden');
const { armarAsientoCompra, CUENTAS_FIJAS } = require('../../../../public/contable/asientoCompra');
const retencionesCatalogo = require('../../../../public/contable/retencionesCatalogo');
const planCuentasReglas = require('../../../../public/contable/planCuentas');
const { partesNit, mismoNit, MAX_ARCHIVO_BYTES } = require('../../../integrations/dian/utilDian');

const MAX_LINEAS = 50;
const CUENTA_GASTO_POR_DEFECTO = '5195';

const centavos = (n) => Math.round((Number(n) + Number.EPSILON) * 100);
const redondear = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function cuentasDestinoDe(empresaId) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId, activa: true }, order: [['codigo', 'ASC']] });
  return cuentas.filter(planCuentasReglas.esDestinoCompra).map((c) => ({ codigo: c.codigo, nombre: c.nombre }));
}

// Cuenta de gasto que hoy usa la regla del documento soporte (valor por defecto).
async function cuentaSugerida(empresaId) {
  const regla = await ReglaContabilizacion.findOne({ where: { empresaId, eventoOrigen: 'documento_soporte_compra' } });
  if (regla) {
    const cuenta = await PlanCuentas.findByPk(regla.cuentaDebitoId);
    if (cuenta && cuenta.activa && planCuentasReglas.esDestinoCompra(cuenta)) return cuenta.codigo;
  }
  return CUENTA_GASTO_POR_DEFECTO;
}

async function buscarProveedorPorNit(empresaId, nit) {
  const { base } = partesNit(nit);
  if (!base) return null;
  const candidatos = await Tercero.findAll({ where: { empresaId, identificacion: { [Op.like]: `${base}%` } } });
  return candidatos.find((t) => mismoNit(t.identificacion, nit)) || null;
}

function fechaValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(texto || ''))) return false;
  const d = new Date(texto + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

function hoyColombia() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function decodificarPdf(base64) {
  const limpio = String(base64).replace(/^data:[^,]*,/, '');
  const buffer = Buffer.from(limpio, 'base64');
  if (buffer.length === 0) throw new Error('El PDF está vacío.');
  if (buffer.length > MAX_ARCHIVO_BYTES) throw new Error('El PDF es demasiado grande (máximo 3,5 MB).');
  if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') throw new Error('El archivo adjunto no es un PDF.');
  return limpio;
}

// Datos que necesita la pantalla antes de digitar.
async function opciones(usuario) {
  const empresa = await Empresa.findByPk(usuario.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada.');
  await aprovisionarContabilidadBase(empresa.id);
  return {
    cuentasDestino: await cuentasDestinoDe(empresa.id),
    cuentaSugerida: await cuentaSugerida(empresa.id),
    empresa: { nit: empresa.nit },
  };
}

async function registrarDocumentoSoporte(datos, usuario) {
  datos = datos || {};
  const empresa = await Empresa.findByPk(usuario.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada.');
  await aprovisionarContabilidadBase(empresa.id);

  // --- encabezado
  const numero = String(datos.numero || '').trim().replace(/\s+/g, ' ');
  if (!numero) throw new Error('Escribe el número del documento soporte (ej. DS 44).');
  if (numero.length > 40) throw new Error('El número del documento soporte es demasiado largo.');
  if (!fechaValida(datos.fecha)) throw new Error('La fecha de la compra no es válida.');
  if (datos.fecha > hoyColombia()) throw new Error('La fecha de la compra no puede ser futura.');
  const formaPago = ['contado', 'credito'].includes(datos.formaPago) ? datos.formaPago : 'contado';
  const observaciones = datos.observaciones ? String(datos.observaciones).slice(0, 1000) : null;

  const repetido = await DocumentoSoporteAdquisicion.findOne({ where: { empresaId: empresa.id, numero } });
  if (repetido) throw new Error(`Ya está registrado el documento soporte ${numero} (${repetido.fecha}).`);

  // --- líneas
  const entradas = Array.isArray(datos.lineas) ? datos.lineas : [];
  if (entradas.length === 0) throw new Error('Agrega al menos una línea con lo que se compró.');
  if (entradas.length > MAX_LINEAS) throw new Error(`Máximo ${MAX_LINEAS} líneas por documento.`);
  const lineas = entradas.map((l, i) => {
    const descripcion = String(l.descripcion || '').trim();
    const cantidad = Number(l.cantidad);
    const valorUnitario = Number(l.valorUnitario);
    if (!descripcion) throw new Error(`Línea ${i + 1}: escribe la descripción.`);
    if (descripcion.length > 255) throw new Error(`Línea ${i + 1}: la descripción es demasiado larga.`);
    if (!(cantidad > 0)) throw new Error(`Línea ${i + 1}: la cantidad debe ser mayor a 0.`);
    if (!(valorUnitario > 0)) throw new Error(`Línea ${i + 1}: el valor unitario debe ser mayor a 0.`);
    return { numero: String(i + 1), descripcion, cantidad, unidad: 'UND', valorUnitario, valorTotal: redondear(cantidad * valorUnitario), iva: 0, ivaPorcentaje: 0 };
  });
  const base = redondear(lineas.reduce((s, l) => s + l.valorTotal, 0));
  if (!(base > 0)) throw new Error('El valor del documento debe ser mayor a 0.');

  // --- proveedor
  let terceroId;
  let nuevoProveedor = null;
  if (datos.terceroId) {
    const elegido = await Tercero.findOne({ where: { id: datos.terceroId, empresaId: empresa.id } });
    if (!elegido) throw new Error('El proveedor elegido no existe.');
    terceroId = elegido.id;
  } else {
    const { base: nitBase, tieneDv } = partesNit(datos.proveedorNit);
    if (!nitBase || nitBase.length < 5 || nitBase.length > 12) throw new Error('Escribe la cédula o NIT del proveedor.');
    if (mismoNit(empresa.nit, datos.proveedorNit)) throw new Error('El proveedor no puede ser tu propia empresa.');
    const existente = await buscarProveedorPorNit(empresa.id, datos.proveedorNit);
    if (existente) {
      terceroId = existente.id;
    } else {
      const nombre = String(datos.proveedorNombre || '').trim();
      if (!nombre) throw new Error('Escribe el nombre del proveedor (no está en Terceros).');
      const dv = tieneDv ? String(datos.proveedorNit).split('-')[1].replace(/\D/g, '').slice(0, 1) : '';
      nuevoProveedor = { identificacion: dv ? `${nitBase}-${dv}` : nitBase, nombre: nombre.slice(0, 150) };
    }
  }
  const proveedorExistente = terceroId ? await Tercero.findByPk(terceroId) : null;
  if (proveedorExistente && mismoNit(empresa.nit, proveedorExistente.identificacion)) {
    throw new Error('El proveedor no puede ser tu propia empresa.');
  }

  // --- retención (misma función y catálogo que la orden y la factura de compra)
  const modo = datos.retencionModo;
  if (!['aplica', 'no_aplica'].includes(modo)) {
    throw new Error('Decide la retención: elige "Aplicar retención" o "No aplica retención" (con su motivo).');
  }
  const especificadas = modo === 'aplica' ? (Array.isArray(datos.retenciones) ? datos.retenciones : []).map((e) => retencionesCatalogo.especificar(e)) : [];
  const ret = calcularOrden.calcularRetenciones({
    base,
    iva: 0,
    aiuTotal: 0,
    retencionModo: modo,
    retencionMotivo: datos.retencionMotivo,
    retencionDetalle: datos.retencionDetalle,
    retenciones: especificadas,
  });
  if (ret.retenciones.some((r) => r.sobre !== 'base')) {
    throw new Error('Un documento soporte no lleva IVA ni AIU: elige conceptos de retención calculados sobre la base.');
  }
  if (centavos(ret.retencionValor) >= centavos(base)) throw new Error('La retención no puede ser igual o mayor al valor del documento.');

  // --- cuentas de gasto por línea
  const permitidas = new Set((await cuentasDestinoDe(empresa.id)).map((c) => c.codigo));
  const porDefecto = datos.cuentaDestino || (await cuentaSugerida(empresa.id));
  const cuentasLinea = lineas.map((_, i) => {
    const elegida = (datos.cuentasLineas && (datos.cuentasLineas[i] || datos.cuentasLineas[String(i)])) || porDefecto;
    if (!permitidas.has(elegida)) throw new Error(`La cuenta ${elegida} (línea ${i + 1}) no existe o no sirve como destino de una compra.`);
    return elegida;
  });

  // --- proyecto / centro de costo
  const proyectoId = datos.proyectoId || null;
  let centroCosto = null;
  if (proyectoId) {
    const proyecto = await Proyecto.findOne({ where: { id: proyectoId, empresaId: empresa.id } });
    if (!proyecto) throw new Error('El proyecto elegido no existe.');
    centroCosto = String(proyecto.codigo || proyecto.nombre).slice(0, 50);
  }

  // --- soporte PDF (opcional)
  const archivoPdf = datos.pdfBase64 ? decodificarPdf(datos.pdfBase64) : null;
  const archivoNombre = archivoPdf ? String(datos.pdfNombre || `${numero}.pdf`).replace(/[^\w .()-]/g, '_').slice(0, 150) : null;

  // --- asiento
  const asientoArmado = armarAsientoCompra({
    lineas,
    base,
    iva: 0,
    impoconsumo: 0,
    total: base,
    ivaDescontable: false,
    cuentasLinea,
    retenciones: ret.retenciones,
    centroCosto,
    cuentaPorPagar: CUENTAS_FIJAS.COSTOS_Y_GASTOS_POR_PAGAR,
  });
  if (!asientoArmado.cuadra) throw new Error('El asiento del documento no cuadra; revisa los valores.');
  const lineasAsiento = asientoArmado.lineas.map((l) => ({
    cuentaCodigo: l.cuentaCodigo,
    ...(l.debito ? { debito: l.debito } : { credito: l.credito }),
    ...(l.centroCosto ? { centroCosto: l.centroCosto } : {}),
  }));

  // --- guardado, todo o nada
  return sequelize.transaction(async (transaction) => {
    if (nuevoProveedor) {
      const nuevo = await Tercero.create({ id: uuidv4(), empresaId: empresa.id, tipo: 'proveedor', ...nuevoProveedor }, { transaction });
      terceroId = nuevo.id;
    }
    const proveedor = nuevoProveedor || proveedorExistente || (await Tercero.findByPk(terceroId, { transaction }));

    const creado = await DocumentoSoporteAdquisicion.create(
      {
        id: uuidv4(),
        empresaId: empresa.id,
        terceroId,
        origen: 'registrado',
        numero,
        fecha: datos.fecha,
        concepto: lineas.map((l) => l.descripcion).join('; ').slice(0, 255),
        valor: base,
        formaPago,
        proveedorNit: partesNit(proveedor.identificacion).base,
        proveedorNombre: String(proveedor.nombre || '').slice(0, 200),
        retencionModo: ret.retencionModo,
        retencionMotivo: ret.retencionModo === 'no_aplica' ? [ret.retencionMotivo, ret.retencionDetalle].filter(Boolean).join(' — ').slice(0, 200) : null,
        retenciones: ret.retenciones,
        retencionValor: ret.retencionValor,
        netoAPagar: asientoArmado.netoAPagar,
        detalle: {
          lineas: lineas.map((l, i) => ({ ...l, cuentaCodigo: cuentasLinea[i] })),
          lineasAsiento,
        },
        observaciones,
        proyectoId,
        archivoNombre,
        archivoPdf,
        estadoSincronizacion: 'aceptado', // ya expedido y validado en Siigo
      },
      { transaction }
    );

    const resultado = await contabilizarAsientoCompuesto({
      empresaId: empresa.id,
      tipoEvento: 'documento_soporte_compra',
      origenModulo: 'compras',
      origenId: creado.id,
      fecha: datos.fecha,
      terceroId,
      usuarioId: usuario.id,
      lineas: lineasAsiento,
      revisado: true, // la persona revisó el desglose en pantalla
      transaction,
    });
    await creado.update({ asientoId: resultado.asiento ? resultado.asiento.id : null }, { transaction });

    return {
      documento: sinPdf(creado),
      lineasAsiento,
      contabilizada: !!(resultado.asiento && resultado.asiento.estado === 'contabilizado'),
      requiereRevision: resultado.requiereRevision,
      periodoAjustado: resultado.periodoAjustado,
    };
  });
}

function sinPdf(registro) {
  const plano = registro.toJSON();
  delete plano.archivoPdf;
  plano.pdfDisponible = !!registro.archivoPdf;
  return plano;
}

async function listarDocumentosSoporte(usuario) {
  const docs = await DocumentoSoporteAdquisicion.findAll({
    where: { empresaId: usuario.empresaId, origen: 'registrado' },
    attributes: { exclude: ['archivoPdf', 'detalle', 'observaciones'] },
    order: [['fecha', 'DESC'], ['createdAt', 'DESC']],
  });
  return docs;
}

async function obtenerDocumentoSoporte(id, usuario) {
  const doc = await DocumentoSoporteAdquisicion.findOne({
    where: { id, empresaId: usuario.empresaId },
    attributes: { exclude: ['archivoPdf'] },
  });
  if (!doc) return null;
  const pdfDisponible = (await DocumentoSoporteAdquisicion.count({ where: { id, archivoPdf: { [Op.ne]: null } } })) > 0;

  let asiento = [];
  if (doc.asientoId) {
    const movimientos = await Movimiento.findAll({ where: { asientoId: doc.asientoId } });
    const cuentas = await PlanCuentas.findAll({ where: { id: { [Op.in]: movimientos.map((m) => m.cuentaId) } } });
    const porId = Object.fromEntries(cuentas.map((c) => [c.id, c]));
    asiento = movimientos.map((m) => ({
      cuentaCodigo: porId[m.cuentaId] ? porId[m.cuentaId].codigo : '',
      cuentaNombre: porId[m.cuentaId] ? porId[m.cuentaId].nombre : '',
      debito: Number(m.debito),
      credito: Number(m.credito),
      centroCosto: m.centroCosto,
    }));
    asiento.sort((a, b) => (b.debito > 0) - (a.debito > 0) || a.cuentaCodigo.localeCompare(b.cuentaCodigo));
  }
  return { ...doc.toJSON(), pdfDisponible, asiento };
}

async function obtenerPdf(id, usuario) {
  const doc = await DocumentoSoporteAdquisicion.findOne({
    where: { id, empresaId: usuario.empresaId },
    attributes: ['id', 'numero', 'archivoNombre', 'archivoPdf'],
  });
  if (!doc || !doc.archivoPdf) return null;
  return { nombre: doc.archivoNombre || `${(doc.numero || doc.id).replace(/[^\w.-]/g, '_')}.pdf`, contenido: Buffer.from(doc.archivoPdf, 'base64') };
}

module.exports = { opciones, registrarDocumentoSoporte, listarDocumentosSoporte, obtenerDocumentoSoporte, obtenerPdf };
