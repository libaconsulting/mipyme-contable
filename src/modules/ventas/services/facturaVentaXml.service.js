// Factura de venta a partir del XML que expide el proveedor tecnológico de la
// propia empresa (Siigo, etc.). La factura ya fue emitida y validada por la DIAN
// fuera de este programa; aquí se registra y se contabiliza.
//
// Dos pasos, ambos con el archivo en la mano:
//   1) previsualizarFacturaVentaXml: lee el XML, NO guarda nada, y devuelve lo que
//      hay que revisar (factura, cliente, cotizaciones candidatas, cuentas de ingreso).
//   2) registrarFacturaVentaXml: vuelve a leer el XML (nunca se confía en lo que
//      mande el navegador), valida, guarda y contabiliza, todo en una transacción.
//
// Asiento (ver public/contable/asientoVenta.js):
//   Db  1305 Clientes                         total
//   Cr  Ingreso (cuenta elegida por línea)    base
//   Cr  2408 IVA por pagar                    IVA
// Las retenciones que practique el cliente se registran al recibir el pago.

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Empresa = require('../../../core/models/Empresa');
const Tercero = require('../../../core/models/Tercero');
const Proyecto = require('../../../core/models/Proyecto');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Movimiento = require('../../../core/models/Movimiento');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const Cotizacion = require('../models/Cotizacion');
const FacturaVenta = require('../models/FacturaVenta');
const { contabilizarAsientoCompuesto } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const { leerFacturaElectronica } = require('../../../integrations/dian/facturaElectronica');
const { partesNit, mismoNit, decodificarArchivo } = require('../../../integrations/dian/utilDian');
const { armarAsientoVenta } = require('../../../../public/contable/asientoVenta');
const planCuentasReglas = require('../../../../public/contable/planCuentas');

const ESTADOS_COTIZACION_FACTURABLE = ['aceptada'];
const INGRESO_POR_DEFECTO = '4135';

// --- utilidades ------------------------------------------------------

async function cuentasIngresoDe(empresaId) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId, activa: true }, order: [['codigo', 'ASC']] });
  return cuentas.filter(planCuentasReglas.esDestinoVenta).map((c) => ({ codigo: c.codigo, nombre: c.nombre }));
}

// Cuenta de ingreso que hoy usa la regla de venta (valor por defecto).
async function ingresoSugerido(empresaId) {
  const regla = await ReglaContabilizacion.findOne({ where: { empresaId, eventoOrigen: 'factura_venta_credito' } });
  if (regla) {
    const cuenta = await PlanCuentas.findByPk(regla.cuentaCreditoId);
    if (cuenta && cuenta.activa) return cuenta.codigo;
  }
  return INGRESO_POR_DEFECTO;
}

async function buscarClientePorNit(empresaId, nit) {
  const { base } = partesNit(nit);
  if (!base) return null;
  const candidatos = await Tercero.findAll({ where: { empresaId, identificacion: { [Op.like]: `${base}%` } } });
  return candidatos.find((t) => mismoNit(t.identificacion, nit)) || null;
}

// Valores con los que se contabiliza (coherentes aunque el XML no lo sea).
function valoresContables(factura) {
  const t = factura.totales;
  const total = t.conImpuestos;
  const base = Math.round((total - t.iva - t.impoconsumo) * 100) / 100;
  return { total, iva: t.iva, impoconsumo: t.impoconsumo, base };
}

// --- análisis común a vista previa y registro ------------------------

async function analizar(datos, usuario) {
  const buffer = decodificarArchivo(datos.archivoBase64);
  const factura = leerFacturaElectronica(buffer);
  const empresa = await Empresa.findByPk(usuario.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada.');
  const advertencias = [...factura.advertencias];

  // Empresa nueva: sin plan de cuentas no hay dónde contabilizar.
  const aprovision = await aprovisionarContabilidadBase(empresa.id);
  if (aprovision.creado) {
    advertencias.push({
      nivel: 'info',
      texto: `Tu empresa aún no tenía contabilidad base, así que se creó: ${aprovision.detalle}. Puedes ajustar las cuentas y reglas más adelante.`,
    });
  }

  if (!factura.esFactura) {
    const motivo =
      factura.elementoRaiz === 'CreditNote'
        ? 'Es una nota crédito: todavía no se pueden cargar notas crédito desde XML.'
        : factura.elementoRaiz === 'DebitNote'
        ? 'Es una nota débito: todavía no se pueden cargar notas débito desde XML.'
        : `Es un documento de tipo "${factura.tipoNombre}", que no se carga como factura de venta.`;
    advertencias.push({ nivel: 'bloqueo', texto: motivo });
  }

  // La factura de venta la tiene que haber emitido la propia empresa.
  const emisorEsLaEmpresa = factura.emisor && factura.emisor.nit && mismoNit(empresa.nit, factura.emisor.nit);
  if (!emisorEsLaEmpresa) {
    const receptorEsLaEmpresa = factura.receptor && factura.receptor.nit && mismoNit(empresa.nit, factura.receptor.nit);
    advertencias.push({
      nivel: 'bloqueo',
      texto: receptorEsLaEmpresa
        ? `Esta factura la emitió ${factura.emisor && factura.emisor.nombre ? factura.emisor.nombre : 'otra empresa'} a nombre de la tuya: es una factura de compra. Cárgala en "Facturas de compra".`
        : `El emisor de la factura (NIT ${factura.emisor ? factura.emisor.nit : '—'}) no coincide con el NIT de tu empresa (${empresa.nit}). Solo se cargan facturas que emitió tu empresa.`,
    });
  }

  if (factura.totales.impoconsumo > 0) {
    advertencias.push({
      nivel: 'bloqueo',
      texto: 'La factura trae impuesto al consumo u otros impuestos distintos del IVA. Todavía no se contabilizan en ventas; avísanos para habilitarlo.',
    });
  }
  if (factura.totales.iva > 0 && !empresa.responsableIva) {
    advertencias.push({
      nivel: 'confirmar',
      texto: 'La factura trae IVA pero tu empresa figura como NO responsable de IVA (Mi Empresa). Confirma que es correcto antes de registrarla.',
    });
  }
  if (factura.retencionesEmisor && factura.retencionesEmisor.length) {
    advertencias.push({
      nivel: 'info',
      texto: 'El XML informa retenciones. No se contabilizan aquí: las retenciones que te practique el cliente se registran al recibir el pago.',
    });
  }

  // ¿Ya la cargamos?
  if (factura.cufe) {
    const repetida = await FacturaVenta.findOne({ where: { empresaId: empresa.id, cufe: factura.cufe } });
    if (repetida) {
      advertencias.push({
        nivel: 'bloqueo',
        texto: `Esta factura ya está registrada (${repetida.numero || 'sin número'}, ${repetida.fecha}). No se puede cargar dos veces.`,
      });
    }
  }
  if (factura.numero) {
    const mismaNumeracion = await FacturaVenta.findOne({ where: { empresaId: empresa.id, numero: factura.numero } });
    if (mismaNumeracion && (!factura.cufe || mismaNumeracion.cufe !== factura.cufe)) {
      advertencias.push({ nivel: 'bloqueo', texto: `Ya existe la factura ${factura.numero} registrada con otro CUFE.` });
    }
  }

  const cliente = factura.receptor && factura.receptor.nit ? await buscarClientePorNit(empresa.id, factura.receptor.nit) : null;

  // Cotizaciones aceptadas del cliente que podrían corresponder a esta factura.
  const referencia = String(factura.ordenReferencia || '').trim().toUpperCase();
  let cotizaciones = [];
  if (cliente) {
    cotizaciones = await Cotizacion.findAll({
      where: { empresaId: empresa.id, terceroId: cliente.id, estado: { [Op.in]: ESTADOS_COTIZACION_FACTURABLE } },
      order: [['fecha', 'DESC']],
      limit: 50,
    });
  }
  const candidatas = cotizaciones.map((c) => {
    const diferencia = Math.round((Number(c.total) - factura.totales.conImpuestos) * 100) / 100;
    const coincideReferencia = !!referencia && String(c.consecutivo || '').toUpperCase() === referencia;
    return {
      id: c.id,
      consecutivo: c.consecutivo,
      fecha: c.fecha,
      total: Number(c.total),
      diferencia,
      sugerida: coincideReferencia || Math.abs(diferencia) < 1,
      coincideReferencia,
    };
  });
  candidatas.sort((a, b) => Number(b.sugerida) - Number(a.sugerida));

  // Cotización elegida por el usuario (si ya eligió una).
  let cotizacion = null;
  if (datos.cotizacionId) {
    cotizacion = await Cotizacion.findOne({ where: { id: datos.cotizacionId, empresaId: empresa.id } });
    if (!cotizacion) {
      advertencias.push({ nivel: 'bloqueo', texto: 'La cotización elegida no existe.' });
    } else {
      if (!ESTADOS_COTIZACION_FACTURABLE.includes(cotizacion.estado)) {
        advertencias.push({ nivel: 'bloqueo', texto: `La cotización ${cotizacion.consecutivo} está en estado "${cotizacion.estado}" y no se puede vincular.` });
      }
      if (cliente && cotizacion.terceroId !== cliente.id) {
        advertencias.push({ nivel: 'bloqueo', texto: `La cotización ${cotizacion.consecutivo} es de otro cliente.` });
      }
      const dif = Math.round((Number(cotizacion.total) - factura.totales.conImpuestos) * 100) / 100;
      if (Math.abs(dif) >= 1) {
        advertencias.push({
          nivel: 'confirmar',
          texto: `La cotización ${cotizacion.consecutivo} es por ${Number(cotizacion.total)} y la factura por ${factura.totales.conImpuestos} (diferencia ${dif}).`,
        });
      }
    }
  }

  return { factura, empresa, cliente, candidatas, cotizacion, advertencias };
}

// --- 1) vista previa -------------------------------------------------

async function previsualizarFacturaVentaXml(datos, usuario) {
  const { factura, empresa, cliente, candidatas, cotizacion, advertencias } = await analizar(datos, usuario);
  delete factura.xmlOriginal; // pesado e innecesario para el navegador

  if (factura.receptor && !cliente) {
    advertencias.push({
      nivel: 'info',
      texto: `El cliente ${factura.receptor.nombre || factura.receptor.nit} (NIT ${factura.receptor.nit}) no está en Terceros. Se creará al registrar la factura.`,
    });
  }

  return {
    factura,
    empresa: { nit: empresa.nit, razonSocial: empresa.razonSocial, responsableIva: !!empresa.responsableIva },
    cliente: cliente ? { id: cliente.id, nombre: cliente.nombre, identificacion: cliente.identificacion, tipo: cliente.tipo } : null,
    cotizacionesCandidatas: candidatas,
    cotizacionSeleccionada: cotizacion ? { id: cotizacion.id, consecutivo: cotizacion.consecutivo } : null,
    contable: valoresContables(factura),
    cuentasIngreso: await cuentasIngresoDe(empresa.id),
    ingresoSugerido: await ingresoSugerido(empresa.id),
    advertencias,
    verificacionDianUrl: factura.cufe ? `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${factura.cufe}` : null,
  };
}

// --- 2) registro + contabilización ------------------------------------

async function registrarFacturaVentaXml(datos, usuario) {
  const { factura, empresa, cliente, cotizacion, advertencias } = await analizar(datos, usuario);

  const bloqueos = advertencias.filter((a) => a.nivel === 'bloqueo');
  if (bloqueos.length) throw new Error(bloqueos.map((b) => b.texto).join(' '));
  const porConfirmar = advertencias.filter((a) => a.nivel === 'confirmar');
  if (porConfirmar.length && !datos.aceptarAdvertencias) {
    throw new Error('Hay advertencias que debes revisar y aceptar antes de registrar: ' + porConfirmar.map((a) => a.texto).join(' '));
  }

  // --- cliente
  let terceroId;
  let crearCliente = false;
  if (datos.terceroId) {
    const elegido = await Tercero.findOne({ where: { id: datos.terceroId, empresaId: empresa.id } });
    if (!elegido) throw new Error('El cliente elegido no existe.');
    if (!mismoNit(elegido.identificacion, factura.receptor.nit)) {
      throw new Error('El cliente elegido no coincide con el NIT que trae la factura.');
    }
    terceroId = elegido.id;
  } else if (cliente) {
    terceroId = cliente.id;
  } else if (datos.crearCliente) {
    crearCliente = true;
  } else {
    throw new Error('El cliente de la factura no está en Terceros. Acepta crearlo o créalo antes.');
  }
  if (cotizacion && crearCliente) {
    throw new Error('La cotización elegida pertenece a un cliente que ya existe; este cliente es nuevo.');
  }
  if (cotizacion && terceroId && cotizacion.terceroId !== terceroId) {
    throw new Error(`La cotización ${cotizacion.consecutivo} es de otro cliente.`);
  }

  const contable = valoresContables(factura);
  if (!(contable.base > 0)) throw new Error('La base de la factura no es positiva; revisa los totales del XML.');

  // --- cuentas de ingreso por línea
  const permitidas = new Set((await cuentasIngresoDe(empresa.id)).map((c) => c.codigo));
  const porDefecto = datos.cuentaIngreso || (await ingresoSugerido(empresa.id));
  const cuentasLinea = factura.lineas.map((l, i) => {
    const elegida = (datos.cuentasLineas && (datos.cuentasLineas[i] || datos.cuentasLineas[String(i)])) || porDefecto;
    if (!permitidas.has(elegida)) {
      throw new Error(`La cuenta ${elegida} (línea ${i + 1}) no existe o no sirve como cuenta de ingreso.`);
    }
    return elegida;
  });

  // --- proyecto / centro de costo
  const proyectoId = datos.proyectoId || null;
  let centroCosto = null;
  if (proyectoId) {
    const proyecto = await Proyecto.findOne({ where: { id: proyectoId, empresaId: empresa.id } });
    if (!proyecto) throw new Error('El proyecto elegido no existe.');
    centroCosto = String(proyecto.codigo || proyecto.nombre || '').slice(0, 50) || null;
  }

  // --- asiento (mismo módulo que usa la vista previa del navegador)
  const asientoArmado = armarAsientoVenta({
    lineas: factura.lineas,
    base: contable.base,
    iva: contable.iva,
    total: contable.total,
    cuentasLinea,
    centroCosto,
  });
  if (!asientoArmado.cuadra) throw new Error('El asiento de la factura no cuadra; revisa los valores del XML.');
  const lineasAsiento = asientoArmado.lineas.map((l) => ({
    cuentaCodigo: l.cuentaCodigo,
    ...(l.debito ? { debito: l.debito } : { credito: l.credito }),
    ...(l.centroCosto ? { centroCosto: l.centroCosto } : {}),
  }));

  // --- guardado, todo o nada
  return sequelize.transaction(async (transaction) => {
    if (crearCliente) {
      const r = factura.receptor;
      const nuevo = await Tercero.create(
        {
          id: uuidv4(),
          empresaId: empresa.id,
          tipo: 'cliente',
          identificacion: r.dv ? `${r.nit}-${r.dv}` : r.nit,
          nombre: String(r.nombre || r.nombreComercial || r.nit).slice(0, 150),
          tipoPersona: r.tipoPersona || undefined,
          regimenIva: r.regimenIva || undefined,
          responsabilidadesFiscales: r.responsabilidades && r.responsabilidades.length ? r.responsabilidades : undefined,
          email: r.email ? r.email.slice(0, 150) : undefined,
          celular: r.telefono ? r.telefono.slice(0, 20) : undefined,
          direccion: r.direccion ? r.direccion.slice(0, 255) : undefined,
          municipio: r.municipio ? r.municipio.slice(0, 100) : undefined,
          departamento: r.departamento ? r.departamento.slice(0, 100) : undefined,
        },
        { transaction }
      );
      terceroId = nuevo.id;
    }

    const creada = await FacturaVenta.create(
      {
        id: uuidv4(),
        empresaId: empresa.id,
        terceroId,
        cotizacionOrigenId: cotizacion ? cotizacion.id : null,
        origen: 'xml',
        numero: factura.numero,
        fecha: factura.fechaEmision,
        fechaVencimiento: factura.fechaVencimiento || null,
        formaPago: factura.formaPago,
        subtotal: contable.base,
        iva: contable.iva,
        total: contable.total,
        cufe: factura.cufe,
        estadoSincronizacion: factura.validacionDian && factura.validacionDian.validada ? 'aceptado' : 'enviado',
        receptorNit: factura.receptor.nit,
        receptorNombre: String(factura.receptor.nombre || '').slice(0, 200),
        proyectoId,
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
          totales: factura.totales,
          validacionDian: factura.validacionDian,
          lineasAsiento,
        },
        xmlContenido: factura.xmlOriginal || null,
      },
      { transaction }
    );

    const resultado = await contabilizarAsientoCompuesto({
      empresaId: empresa.id,
      tipoEvento: 'factura_venta_credito',
      origenModulo: 'ventas',
      origenId: creada.id,
      fecha: factura.fechaEmision,
      terceroId,
      usuarioId: usuario.id,
      lineas: lineasAsiento,
      revisado: true, // el usuario revisó el desglose en la vista previa
      transaction,
    });

    await creada.update({ asientoId: resultado.asiento ? resultado.asiento.id : null }, { transaction });
    if (cotizacion) await cotizacion.update({ estado: 'facturada' }, { transaction });

    return {
      factura: sinXml(creada),
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
  const factura = await FacturaVenta.findOne({
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
  const xmlDisponible = (await FacturaVenta.count({ where: { id, empresaId: usuario.empresaId, xmlContenido: { [Op.ne]: null } } })) > 0;
  return { ...factura.toJSON(), xmlDisponible, asiento };
}

async function obtenerXml(id, usuario) {
  const factura = await FacturaVenta.findOne({
    where: { id, empresaId: usuario.empresaId },
    attributes: ['id', 'numero', 'xmlContenido'],
  });
  if (!factura || !factura.xmlContenido) return null;
  return { nombre: `${(factura.numero || factura.id).replace(/[^\w.-]/g, '_')}.xml`, contenido: factura.xmlContenido };
}

module.exports = { previsualizarFacturaVentaXml, registrarFacturaVentaXml, obtenerFactura, obtenerXml };
