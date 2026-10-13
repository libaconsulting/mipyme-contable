// Factura de compra a partir del XML que expide el proveedor.
//
// Dos pasos, ambos con el archivo en la mano:
//   1) previsualizarFacturaXml: lee el XML, NO guarda nada, y devuelve lo
//      que hay que revisar (datos de la factura, proveedor, órdenes
//      candidatas, advertencias, cuentas posibles).
//   2) registrarFacturaXml: vuelve a leer el XML (nunca se confía en lo que
//      mande el navegador), valida, guarda la factura y la contabiliza en
//      un asiento de varias líneas, todo en una sola transacción.
//
// Asiento resultante (valores de ejemplo):
//   Db  Inventario / Gasto / Costo (cuenta elegida por línea)   base (+ impoconsumo)
//   Db  1355 IVA descontable (si la empresa es responsable de IVA)
//   Cr  2205 Proveedores nacionales                              total - retenciones
//   Cr  2365 Retención en la fuente por pagar
//   Cr  2367 ReteIVA por pagar

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Empresa = require('../../../core/models/Empresa');
const Tercero = require('../../../core/models/Tercero');
const Proyecto = require('../../../core/models/Proyecto');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Movimiento = require('../../../core/models/Movimiento');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const OrdenCompra = require('../models/OrdenCompra');
const FacturaCompra = require('../models/FacturaCompra');
const { contabilizarAsientoCompuesto } = require('../../../core/services/motorAsientos');
const { leerFacturaElectronica } = require('../../../integrations/dian/facturaElectronica');
const calcularOrden = require('../../../../public/contable/calculoOrden');
const { armarAsientoCompra, repartir } = require('../../../../public/contable/asientoCompra');
const retencionesCatalogo = require('../../../../public/contable/retencionesCatalogo');

const MAX_ARCHIVO_BYTES = 3.5 * 1024 * 1024; // el límite de JSON del servidor es 5 MB (base64 pesa ~33% más)
const ESTADOS_ORDEN_FACTURABLE = ['aprobada', 'recibida_parcial', 'recibida_total'];

// --- utilidades ------------------------------------------------------

const centavos = (n) => Math.round((Number(n) + Number.EPSILON) * 100);

// "900.123.456-1" -> { base: '900123456', tieneDv: true }
function partesNit(nit) {
  const crudo = String(nit || '').trim();
  const tieneDv = crudo.includes('-');
  const base = (tieneDv ? crudo.split('-')[0] : crudo).replace(/\D/g, '');
  return { base, tieneDv };
}

// Compara NITs aunque uno traiga el dígito de verificación pegado y el otro no.
function mismoNit(a, b) {
  const x = partesNit(a);
  const y = partesNit(b);
  if (!x.base || !y.base) return false;
  if (x.base === y.base) return true;
  if (!x.tieneDv && x.base.slice(0, -1) === y.base) return true;
  if (!y.tieneDv && y.base.slice(0, -1) === x.base) return true;
  return false;
}

function decodificarArchivo(archivoBase64) {
  if (typeof archivoBase64 !== 'string' || archivoBase64.length === 0) {
    throw new Error('Selecciona el archivo XML (o ZIP) de la factura.');
  }
  const limpio = archivoBase64.replace(/^data:[^,]*,/, '');
  const buffer = Buffer.from(limpio, 'base64');
  if (buffer.length === 0) throw new Error('El archivo está vacío.');
  if (buffer.length > MAX_ARCHIVO_BYTES) {
    throw new Error('El archivo es demasiado grande (máximo 3,5 MB). Sube solo el XML de la factura.');
  }
  return buffer;
}

// Las cuentas a las que se puede llevar el gasto/costo/activo de una compra.
function esCuentaDestino(c) {
  if (c.naturaleza !== 'debito') return false;
  if (['costo', 'gasto'].includes(c.elementoNiif)) return true;
  return /^(14|15|17)/.test(c.codigo) && !/^1592/.test(c.codigo);
}

async function cuentasDestinoDe(empresaId) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId }, order: [['codigo', 'ASC']] });
  return cuentas.filter(esCuentaDestino).map((c) => ({ codigo: c.codigo, nombre: c.nombre }));
}

// Cuenta de débito que hoy usan las reglas de compra (valor por defecto del destino).
async function destinosSugeridos(empresaId) {
  const resultado = { bienes: '1435', gasto: '5195' };
  for (const [clave, evento] of [
    ['bienes', 'factura_compra_con_orden'],
    ['gasto', 'factura_compra_sin_orden'],
  ]) {
    const regla = await ReglaContabilizacion.findOne({ where: { empresaId, eventoOrigen: evento } });
    if (!regla) continue;
    const cuenta = await PlanCuentas.findByPk(regla.cuentaDebitoId);
    if (cuenta) resultado[clave] = cuenta.codigo;
  }
  return resultado;
}

async function buscarProveedorPorNit(empresaId, nit) {
  const { base } = partesNit(nit);
  if (!base) return null;
  const candidatos = await Tercero.findAll({
    where: { empresaId, identificacion: { [Op.like]: `${base}%` } },
  });
  return candidatos.find((t) => mismoNit(t.identificacion, nit)) || null;
}

// Retención que se sugiere según lo que el propio XML dice del proveedor.
function sugerirRetencion(emisor) {
  if (emisor.esRegimenSimple) {
    return {
      modo: 'no_aplica',
      motivo: retencionesCatalogo.MOTIVOS_NO_APLICA[0],
      detalle: '',
      texto: 'El XML indica que el proveedor es del Régimen Simple de Tributación (O-47). Confirma que su certificado esté vigente.',
    };
  }
  if (emisor.esAutorretenedor) {
    return {
      modo: 'no_aplica',
      motivo: retencionesCatalogo.MOTIVOS_NO_APLICA[3],
      detalle: 'El proveedor es autorretenedor (O-15).',
      texto: 'El XML indica que el proveedor es autorretenedor (O-15): normalmente no se le practica retención.',
    };
  }
  return null;
}

// --- análisis común a vista previa y registro ------------------------

async function analizar(datos, usuario) {
  const buffer = decodificarArchivo(datos.archivoBase64);
  const factura = leerFacturaElectronica(buffer);
  const empresa = await Empresa.findByPk(usuario.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada.');

  const advertencias = [...factura.advertencias];

  if (!factura.esFactura) {
    const motivo =
      factura.elementoRaiz === 'CreditNote'
        ? 'Es una nota crédito: todavía no se pueden cargar notas crédito desde XML.'
        : factura.elementoRaiz === 'DebitNote'
        ? 'Es una nota débito: todavía no se pueden cargar notas débito desde XML.'
        : `Es un documento de tipo "${factura.tipoNombre}", que no se carga como factura de compra.`;
    advertencias.push({ nivel: 'bloqueo', texto: motivo });
  }

  // ¿Está a nombre de nuestra empresa?
  if (factura.receptor && factura.receptor.nit && !mismoNit(empresa.nit, factura.receptor.nit)) {
    advertencias.push({
      nivel: 'confirmar',
      texto:
        `La factura está a nombre de ${factura.receptor.nombre || 'otra persona'} (NIT ${factura.receptor.nit}), ` +
        `que no coincide con el NIT de tu empresa (${empresa.nit}).`,
    });
  }

  // ¿Ya la cargamos?
  if (factura.cufe) {
    const repetida = await FacturaCompra.findOne({ where: { empresaId: empresa.id, cufe: factura.cufe } });
    if (repetida) {
      advertencias.push({
        nivel: 'bloqueo',
        texto: `Esta factura ya está registrada (${repetida.numero || 'sin número'}, ${repetida.fecha}). No se puede cargar dos veces.`,
      });
    }
  }
  if (factura.emisor && factura.emisor.nit && factura.numero) {
    const mismaNumeracion = await FacturaCompra.findOne({
      where: { empresaId: empresa.id, numero: factura.numero, emisorNit: factura.emisor.nit },
    });
    if (mismaNumeracion && (!factura.cufe || mismaNumeracion.cufe !== factura.cufe)) {
      advertencias.push({
        nivel: 'bloqueo',
        texto: `Ya existe la factura ${factura.numero} de este proveedor registrada con otro CUFE.`,
      });
    }
  }

  const proveedor = factura.emisor && factura.emisor.nit ? await buscarProveedorPorNit(empresa.id, factura.emisor.nit) : null;

  // Órdenes de adquisición que podrían corresponder a esta factura.
  const filtroOrden = { empresaId: empresa.id, estado: { [Op.in]: ESTADOS_ORDEN_FACTURABLE } };
  if (proveedor) filtroOrden.terceroId = proveedor.id;
  const referencia = String(factura.ordenReferencia || '').trim().toUpperCase();
  let ordenes = [];
  if (proveedor) {
    ordenes = await OrdenCompra.findAll({ where: filtroOrden, order: [['fecha', 'DESC']], limit: 50 });
  } else if (referencia) {
    // Proveedor nuevo: solo tiene sentido buscar la orden que la propia factura cita.
    ordenes = await OrdenCompra.findAll({ where: { ...filtroOrden, consecutivo: referencia }, limit: 5 });
  }
  const candidatas = ordenes.map((o) => {
    const diferencia = Math.round((Number(o.total) - factura.totales.conImpuestos) * 100) / 100;
    const coincideReferencia = !!referencia && String(o.consecutivo || '').toUpperCase() === referencia;
    return {
      id: o.id,
      consecutivo: o.consecutivo,
      fecha: o.fecha,
      tipo: o.tipo,
      total: Number(o.total),
      proyectoId: o.proyectoId,
      diferencia,
      sugerida: coincideReferencia || Math.abs(diferencia) < 1,
      coincideReferencia,
      // Lo que la orden ya tenía decidido, para precargarlo en la factura.
      aiuTotal: o.aplicaAiu
        ? Math.round(Number(o.subtotal) * ((Number(o.aiuAdministracion) + Number(o.aiuImprevistos) + Number(o.aiuUtilidad)) / 100) * 100) / 100
        : 0,
      retencion: {
        modo: o.retencionModo,
        motivo: o.retencionMotivo || '',
        detalle: o.retencionDetalle || '',
        conceptos: (Array.isArray(o.retenciones) ? o.retenciones : []).map((r) => ({ codigo: r.codigo, tarifa: r.tarifa })),
      },
    };
  });
  candidatas.sort((a, b) => Number(b.sugerida) - Number(a.sugerida));

  // Orden elegida por el usuario (si ya eligió una).
  let orden = null;
  if (datos.ordenCompraId) {
    orden = await OrdenCompra.findOne({ where: { id: datos.ordenCompraId, empresaId: empresa.id } });
    if (!orden) {
      advertencias.push({ nivel: 'bloqueo', texto: 'La orden de adquisición elegida no existe.' });
    } else {
      if (!ESTADOS_ORDEN_FACTURABLE.includes(orden.estado)) {
        advertencias.push({ nivel: 'bloqueo', texto: `La orden ${orden.consecutivo} está en estado "${orden.estado}" y no se puede facturar.` });
      }
      if (proveedor && orden.terceroId !== proveedor.id) {
        advertencias.push({ nivel: 'bloqueo', texto: `La orden ${orden.consecutivo} es de otro proveedor.` });
      }
      const dif = Math.round((Number(orden.total) - factura.totales.conImpuestos) * 100) / 100;
      if (Math.abs(dif) >= 1) {
        advertencias.push({
          nivel: 'confirmar',
          texto: `La orden ${orden.consecutivo} es por ${Number(orden.total)} y la factura por ${factura.totales.conImpuestos} (diferencia ${dif}).`,
        });
      }
    }
  }

  return { buffer, factura, empresa, proveedor, candidatas, orden, advertencias };
}

// Valores con los que se contabiliza (coherentes aunque el XML no lo sea).
function valoresContables(factura) {
  const t = factura.totales;
  const total = t.conImpuestos;
  const base = Math.round((total - t.iva - t.impoconsumo) * 100) / 100;
  return { total, iva: t.iva, impoconsumo: t.impoconsumo, base };
}

// --- 1) vista previa -------------------------------------------------

async function previsualizarFacturaXml(datos, usuario) {
  const { factura, empresa, proveedor, candidatas, orden, advertencias } = await analizar(datos, usuario);
  delete factura.xmlOriginal; // pesado e innecesario para el navegador

  if (factura.emisor && !proveedor) {
    advertencias.push({
      nivel: 'info',
      texto: `El proveedor ${factura.emisor.nombre} (NIT ${factura.emisor.nit}) no está en Terceros. Se creará al registrar la factura.`,
    });
  }

  const contable = valoresContables(factura);
  return {
    factura,
    empresa: { nit: empresa.nit, razonSocial: empresa.razonSocial, responsableIva: !!empresa.responsableIva },
    proveedor: proveedor ? { id: proveedor.id, nombre: proveedor.nombre, identificacion: proveedor.identificacion, tipo: proveedor.tipo } : null,
    ordenesCandidatas: candidatas,
    ordenSeleccionada: orden ? { id: orden.id, consecutivo: orden.consecutivo, tipo: orden.tipo, proyectoId: orden.proyectoId } : null,
    contable: { ...contable, ivaDescontable: !!empresa.responsableIva },
    retencionSugerida: sugerirRetencion(factura.emisor || {}),
    cuentasDestino: await cuentasDestinoDe(empresa.id),
    destinosSugeridos: await destinosSugeridos(empresa.id),
    advertencias,
    verificacionDianUrl: factura.cufe ? `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${factura.cufe}` : null,
  };
}

// --- 2) registro + contabilización ------------------------------------

async function registrarFacturaXml(datos, usuario) {
  const { factura, empresa, proveedor, orden, advertencias } = await analizar(datos, usuario);

  const bloqueos = advertencias.filter((a) => a.nivel === 'bloqueo');
  if (bloqueos.length) throw new Error(bloqueos.map((b) => b.texto).join(' '));
  const porConfirmar = advertencias.filter((a) => a.nivel === 'confirmar');
  if (porConfirmar.length && !datos.aceptarAdvertencias) {
    throw new Error('Hay advertencias que debes revisar y aceptar antes de registrar: ' + porConfirmar.map((a) => a.texto).join(' '));
  }

  // --- proveedor
  let terceroId;
  let crearProveedor = false;
  if (datos.terceroId) {
    const elegido = await Tercero.findOne({ where: { id: datos.terceroId, empresaId: empresa.id } });
    if (!elegido) throw new Error('El proveedor elegido no existe.');
    if (!mismoNit(elegido.identificacion, factura.emisor.nit)) {
      throw new Error('El proveedor elegido no coincide con el NIT que trae la factura.');
    }
    terceroId = elegido.id;
  } else if (proveedor) {
    terceroId = proveedor.id;
  } else if (datos.crearProveedor) {
    crearProveedor = true;
  } else {
    throw new Error('El proveedor de la factura no está en Terceros. Acepta crearlo o créalo antes.');
  }
  if (orden && crearProveedor) {
    throw new Error('La orden elegida pertenece a un proveedor que ya existe; este proveedor es nuevo.');
  }
  if (orden && terceroId && orden.terceroId !== terceroId) {
    throw new Error(`La orden ${orden.consecutivo} es de otro proveedor.`);
  }

  const contable = valoresContables(factura);
  if (!(contable.base > 0)) throw new Error('La base de la factura no es positiva; revisa los totales del XML.');

  // --- retención (misma función y catálogo que la orden de adquisición)
  const modo = datos.retencionModo;
  if (!['aplica', 'no_aplica'].includes(modo)) {
    throw new Error('Decide la retención: elige "Aplicar retención" o "No aplica retención" (con su motivo).');
  }
  const especificadas =
    modo === 'aplica' ? (Array.isArray(datos.retenciones) ? datos.retenciones : []).map((e) => retencionesCatalogo.especificar(e)) : [];
  const ret = calcularOrden.calcularRetenciones({
    base: contable.base,
    iva: contable.iva,
    aiuTotal: Number(datos.aiuTotal) > 0 ? Number(datos.aiuTotal) : 0,
    retencionModo: modo,
    retencionMotivo: datos.retencionMotivo,
    retencionDetalle: datos.retencionDetalle,
    retenciones: especificadas,
  });
  const retencionCent = centavos(ret.retencionValor);
  if (retencionCent >= centavos(contable.total)) throw new Error('La retención no puede ser igual o mayor al total de la factura.');

  // --- cuentas por línea
  const permitidas = new Set((await cuentasDestinoDe(empresa.id)).map((c) => c.codigo));
  const sugeridos = await destinosSugeridos(empresa.id);
  const porDefecto = datos.cuentaDestino || (orden && orden.tipo === 'bienes' ? sugeridos.bienes : sugeridos.gasto);
  const cuentasLinea = factura.lineas.map((l, i) => {
    const elegida = (datos.cuentasLineas && (datos.cuentasLineas[i] || datos.cuentasLineas[String(i)])) || porDefecto;
    if (!permitidas.has(elegida)) {
      throw new Error(`La cuenta ${elegida} (línea ${i + 1}) no existe o no sirve como destino de una compra.`);
    }
    return elegida;
  });

  // --- proyecto / centro de costo
  const proyectoId = datos.proyectoId || (orden && orden.proyectoId) || null;
  let centroCosto = null;
  if (proyectoId) {
    const proyecto = await Proyecto.findOne({ where: { id: proyectoId, empresaId: empresa.id } });
    if (!proyecto) throw new Error('El proyecto elegido no existe.');
    centroCosto = String(proyecto.codigo || proyecto.nombre).slice(0, 50);
  }

  // --- armado del asiento (mismo módulo que usa la vista previa del navegador)
  const ivaDescontable = !!empresa.responsableIva;
  const asientoArmado = armarAsientoCompra({
    lineas: factura.lineas,
    base: contable.base,
    iva: contable.iva,
    impoconsumo: contable.impoconsumo,
    total: contable.total,
    ivaDescontable,
    cuentasLinea,
    retenciones: ret.retenciones,
    centroCosto,
  });
  if (!asientoArmado.cuadra) throw new Error('El asiento de la factura no cuadra; revisa los valores del XML.');
  const lineasAsiento = asientoArmado.lineas.map((l) => ({
    cuentaCodigo: l.cuentaCodigo,
    ...(l.debito ? { debito: l.debito } : { credito: l.credito }),
    ...(l.centroCosto ? { centroCosto: l.centroCosto } : {}),
  }));
  const netoAPagar = asientoArmado.netoAPagar;

  // --- guardado, todo o nada
  return sequelize.transaction(async (transaction) => {
    if (crearProveedor) {
      const e = factura.emisor;
      const nuevo = await Tercero.create(
        {
          id: uuidv4(),
          empresaId: empresa.id,
          tipo: 'proveedor',
          identificacion: e.dv ? `${e.nit}-${e.dv}` : e.nit,
          nombre: String(e.nombre || e.nombreComercial || e.nit).slice(0, 150),
          tipoPersona: e.tipoPersona || undefined,
          regimenIva: e.regimenIva || undefined,
          responsabilidadesFiscales: e.responsabilidades.length ? e.responsabilidades : undefined,
          email: e.email ? e.email.slice(0, 150) : undefined,
          celular: e.telefono ? e.telefono.slice(0, 20) : undefined,
          direccion: e.direccion ? e.direccion.slice(0, 255) : undefined,
          municipio: e.municipio ? e.municipio.slice(0, 100) : undefined,
          departamento: e.departamento ? e.departamento.slice(0, 100) : undefined,
        },
        { transaction }
      );
      terceroId = nuevo.id;
    }

    const creada = await FacturaCompra.create(
      {
        id: uuidv4(),
        empresaId: empresa.id,
        terceroId,
        ordenCompraOrigenId: orden ? orden.id : null,
        proyectoId,
        fecha: factura.fechaEmision,
        fechaVencimiento: factura.fechaVencimiento || null,
        formaPago: factura.formaPago,
        numero: factura.numero,
        subtotal: contable.base,
        iva: contable.iva,
        impoconsumo: contable.impoconsumo,
        total: contable.total,
        cufe: factura.cufe,
        retencionModo: ret.retencionModo,
        retencionMotivo: ret.retencionModo === 'no_aplica' ? [ret.retencionMotivo, ret.retencionDetalle].filter(Boolean).join(' — ').slice(0, 200) : null,
        retenciones: ret.retenciones,
        retencionValor: ret.retencionValor,
        netoAPagar,
        emisorNit: factura.emisor.nit,
        emisorNombre: String(factura.emisor.nombre || '').slice(0, 200),
        detalle: {
          lineas: factura.lineas.map((l, i) => ({
            numero: l.numero,
            descripcion: l.descripcion,
            cantidad: l.cantidad,
            unidad: l.unidad,
            valorUnitario: l.valorUnitario,
            valorTotal: l.valorTotal,
            iva: l.iva,
            ivaPorcentaje: l.ivaPorcentaje,
            cuentaCodigo: cuentasLinea[i],
          })),
          impuestos: factura.impuestos,
          retencionesEmisor: factura.retencionesEmisor,
          totales: factura.totales,
          validacionDian: factura.validacionDian,
          lineasAsiento,
        },
        xmlContenido: factura.xmlOriginal || null,
        estadoConciliacion: 'pendiente',
      },
      { transaction }
    );

    const resultado = await contabilizarAsientoCompuesto({
      empresaId: empresa.id,
      tipoEvento: orden ? 'factura_compra_con_orden' : 'factura_compra_sin_orden',
      origenModulo: 'compras',
      origenId: creada.id,
      fecha: factura.fechaEmision,
      terceroId,
      usuarioId: usuario.id,
      lineas: lineasAsiento,
      revisado: true, // el usuario revisó el desglose en la vista previa
      transaction,
    });

    await creada.update(
      {
        asientoId: resultado.asiento ? resultado.asiento.id : null,
        estadoConciliacion: resultado.asiento && resultado.asiento.estado === 'contabilizado' ? 'contabilizada' : 'pendiente',
      },
      { transaction }
    );
    if (orden) await orden.update({ estado: 'facturada' }, { transaction });

    return {
      factura: await sinXml(creada),
      lineasAsiento,
      contabilizada: !!(resultado.asiento && resultado.asiento.estado === 'contabilizado'),
      requiereRevision: resultado.requiereRevision,
      periodoAjustado: resultado.periodoAjustado,
    };
  });
}

function sinXml(registro) {
  const plano = registro.toJSON();
  delete plano.xmlContenido;
  return plano;
}

// --- consulta ----------------------------------------------------------

async function obtenerFactura(id, usuario) {
  const factura = await FacturaCompra.findOne({
    where: { id, empresaId: usuario.empresaId },
    attributes: { exclude: ['xmlContenido'] },
  });
  if (!factura) return null;

  let asiento = [];
  if (factura.asientoId) {
    const movimientos = await Movimiento.findAll({ where: { asientoId: factura.asientoId } });
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
  return { ...factura.toJSON(), asiento };
}

async function obtenerXml(id, usuario) {
  const factura = await FacturaCompra.findOne({
    where: { id, empresaId: usuario.empresaId },
    attributes: ['id', 'numero', 'xmlContenido'],
  });
  if (!factura || !factura.xmlContenido) return null;
  return { nombre: `${(factura.numero || factura.id).replace(/[^\w.-]/g, '_')}.xml`, contenido: factura.xmlContenido };
}

module.exports = {
  previsualizarFacturaXml,
  registrarFacturaXml,
  obtenerFactura,
  obtenerXml,
  // exportadas para pruebas
  _mismoNit: mismoNit,
  _repartir: repartir,
};
