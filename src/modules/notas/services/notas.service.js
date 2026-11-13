// Notas crédito y débito electrónicas, cargadas desde el XML (por ahora; más adelante las traerá directo el proveedor
// tecnológico). Sirve para las dos puntas:
//   - lado 'compra': la nota la expide el proveedor y modifica una factura de compra (rebaja o cobra de más).
//   - lado 'venta':  la nota la expidió la propia empresa (Siigo u otro) y modifica una factura de venta.
// El lado se detecta solo: si el emisor del XML es la empresa es de venta; si la empresa es la receptora, de compra.
//
// Dos pasos, ambos con el archivo en la mano (igual que las facturas):
//   1) previsualizarNotaXml: lee el XML, NO guarda nada, y devuelve lo que hay que revisar.
//   2) registrarNotaXml: vuelve a leer el XML (nunca se confía en lo que mande el navegador), valida, guarda y
//      contabiliza en una sola transacción. El asiento es el espejo del de la factura (ver public/contable/asientoNota.js).
//
// La nota se vincula con la factura que modifica (por CUFE o por número) y cambia su saldo en Tesorería: la crédito lo
// baja y la débito lo sube. Una nota crédito reversa también, en proporción, las retenciones que se habían contabilizado
// con la factura (la persona puede corregir esos valores antes de registrar).

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const Empresa = require('../../../core/models/Empresa');
const Tercero = require('../../../core/models/Tercero');
const Proyecto = require('../../../core/models/Proyecto');
const PlanCuentas = require('../../../core/models/PlanCuentas');
const Movimiento = require('../../../core/models/Movimiento');
const Asiento = require('../../../core/models/Asiento');
const PeriodoContable = require('../../../core/models/PeriodoContable');
const ReglaContabilizacion = require('../../../core/models/ReglaContabilizacion');
const FacturaCompra = require('../../compras/models/FacturaCompra');
const FacturaVenta = require('../../ventas/models/FacturaVenta');
const NotaElectronica = require('../models/NotaElectronica');
const cruces = require('../../tesoreria/services/cruces.service');
const { contabilizarAsientoCompuesto, cuentasPorCodigo } = require('../../../core/services/motorAsientos');
const { aprovisionarContabilidadBase } = require('../../../core/services/seedService');
const auditoria = require('../../../core/services/auditoria');
const { leerFacturaElectronica, CONCEPTOS_NOTA } = require('../../../integrations/dian/facturaElectronica');
const { partesNit, mismoNit, decodificarArchivo } = require('../../../integrations/dian/utilDian');
const { armarAsientoNota } = require('../../../../public/contable/asientoNota');
const planCuentasReglas = require('../../../../public/contable/planCuentas');

const DOC_TIPO = { compra: 'factura_compra', venta: 'factura_venta' };
const MODELO = { compra: FacturaCompra, venta: FacturaVenta };
const MODULO = { compra: 'compras', venta: 'ventas' };
const NINGUNA = '__ninguna__'; // la persona decidió registrar la nota sin vincularla a una factura

// Eventos del motor (se crean la primera vez, como en tesorería e inventarios). Los códigos son solo los de la regla;
// las líneas del asiento traen sus propias cuentas.
const EVENTOS = {
  'compra:credito': { evento: 'nota_credito_compra', debito: '2205', credito: '5195' },
  'compra:debito': { evento: 'nota_debito_compra', debito: '5195', credito: '2205' },
  'venta:credito': { evento: 'nota_credito_venta', debito: '4135', credito: '1305' },
  'venta:debito': { evento: 'nota_debito_venta', debito: '1305', credito: '4135' },
};

const NOMBRE_NOTA = { credito: 'Nota crédito', debito: 'Nota débito' };
const INGRESO_POR_DEFECTO = '4135';
const GASTO_POR_DEFECTO = '5195';

// --- utilidades ------------------------------------------------------

const centavos = (n) => Math.round((Number(n) + Number.EPSILON) * 100);
const pesos = (c) => c / 100;
const redondear = (n) => pesos(centavos(n));

async function asegurarReglasNotas(empresaId, transaction) {
  const defs = Object.values(EVENTOS);
  const cuentas = await cuentasPorCodigo(empresaId, defs.flatMap((r) => [r.debito, r.credito]), transaction);
  for (const r of defs) {
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

// Cuentas a las que se puede llevar cada línea de la nota.
async function cuentasDeLinea(empresaId, lado) {
  const cuentas = await PlanCuentas.findAll({ where: { empresaId, activa: true }, order: [['codigo', 'ASC']] });
  const sirve = lado === 'compra' ? planCuentasReglas.esDestinoCompra : (c) => c.elementoNiif === 'ingreso'; // también las de devoluciones (4175)
  return cuentas.filter(sirve).map((c) => ({ codigo: c.codigo, nombre: c.nombre }));
}

// Cuenta que hoy usan las reglas de factura (valor por defecto cuando no hay otra pista).
async function cuentaPorDefecto(empresaId, lado) {
  const evento = lado === 'compra' ? 'factura_compra_sin_orden' : 'factura_venta_credito';
  const regla = await ReglaContabilizacion.findOne({ where: { empresaId, eventoOrigen: evento } });
  if (regla) {
    const cuenta = await PlanCuentas.findByPk(lado === 'compra' ? regla.cuentaDebitoId : regla.cuentaCreditoId);
    if (cuenta && cuenta.activa) return cuenta.codigo;
  }
  return lado === 'compra' ? GASTO_POR_DEFECTO : INGRESO_POR_DEFECTO;
}

async function buscarTerceroPorNit(empresaId, nit) {
  const { base } = partesNit(nit);
  if (!base) return null;
  const candidatos = await Tercero.findAll({ where: { empresaId, identificacion: { [Op.like]: `${base}%` } } });
  return candidatos.find((t) => mismoNit(t.identificacion, nit)) || null;
}

// Valores con los que se contabiliza (coherentes aunque el XML no lo sea).
function valoresContables(nota) {
  const t = nota.totales;
  const total = t.conImpuestos;
  return { total, iva: t.iva, impoconsumo: t.impoconsumo, base: redondear(total - t.iva - t.impoconsumo) };
}

// Parte de la factura que cubre la nota (1 si la cubre toda, tolerando diferencias de centavos).
function proporcion(parte, todo) {
  const p = Number(parte);
  const t = Number(todo);
  if (!(t > 0)) return 1;
  if (Math.abs(p - t) < 1) return 1;
  return Math.max(0, Math.min(1, p / t));
}

const normalizar = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();

// --- Retenciones que reversa una nota crédito ------------------------------------------

// Lo que la factura retuvo/descontó, lo que ya reversaron otras notas, y la sugerencia para esta nota.
function reversaDeFactura(lado, doc, valores, previas) {
  const sumaPrevias = (campo) => redondear(previas.reduce((s, n) => s + Number((n.reversa && n.reversa[campo]) || 0), 0));
  if (lado === 'compra') {
    const rets = Array.isArray(doc.retenciones) ? doc.retenciones : [];
    const origIva = redondear(rets.filter((r) => r.sobre === 'iva').reduce((s, r) => s + Number(r.valor || 0), 0));
    const origFuente = redondear(rets.filter((r) => r.sobre !== 'iva').reduce((s, r) => s + Number(r.valor || 0), 0));
    const maxFuente = Math.max(0, redondear(origFuente - sumaPrevias('retefuente')));
    const maxIva = Math.max(0, redondear(origIva - sumaPrevias('reteiva')));
    const pBase = proporcion(valores.base, doc.subtotal);
    const pIva = Number(doc.iva) > 0 ? proporcion(valores.iva, doc.iva) : pBase;
    return {
      original: { retefuente: origFuente, reteiva: origIva },
      maximo: { retefuente: maxFuente, reteiva: maxIva },
      sugerida: { retefuente: Math.min(maxFuente, redondear(origFuente * pBase)), reteiva: Math.min(maxIva, redondear(origIva * pIva)) },
    };
  }
  const p = proporcion(valores.base, doc.subtotal);
  const campos = ['retefuente', 'reteiva', 'reteica'];
  const original = {};
  const maximo = {};
  const sugerida = {};
  for (const c of campos) {
    original[c] = redondear(doc[c]);
    maximo[c] = Math.max(0, redondear(original[c] - sumaPrevias(c)));
    sugerida[c] = Math.min(maximo[c], redondear(original[c] * p));
  }
  const clave = (o) => `${o.concepto}|${o.cuentaCodigo}`;
  const otrosOrig = Array.isArray(doc.otrosDescuentos) ? doc.otrosDescuentos : [];
  const yaReversado = {};
  for (const n of previas) {
    for (const o of (n.reversa && n.reversa.otros) || []) yaReversado[clave(o)] = redondear((yaReversado[clave(o)] || 0) + Number(o.valor || 0));
  }
  const otros = otrosOrig.map((o) => {
    const max = Math.max(0, redondear(Number(o.valor) - (yaReversado[clave(o)] || 0)));
    return { concepto: o.concepto, cuentaCodigo: o.cuentaCodigo, cuentaNombre: o.cuentaNombre, original: redondear(o.valor), maximo: max, valor: Math.min(max, redondear(Number(o.valor) * p)) };
  });
  return { original: { ...original, otros: otrosOrig }, maximo: { ...maximo, otros }, sugerida: { ...sugerida, otros } };
}

// Lo que la persona confirmó, validado contra lo que la factura realmente retuvo. Devuelve lo que va al asiento y lo que se guarda.
function leerReversa(lado, datos, info) {
  const pedida = datos.reversa === undefined || datos.reversa === null ? info.sugerida : datos.reversa;
  const valor = (x, nombre) => {
    if (x === undefined || x === null || x === '') return 0;
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${nombre}: no es un valor válido.`);
    return redondear(n);
  };
  if (lado === 'compra') {
    const r = { retefuente: valor(pedida.retefuente, 'Retención en la fuente'), reteiva: valor(pedida.reteiva, 'ReteIVA') };
    if (r.retefuente > info.maximo.retefuente + 0.004) throw new Error(`La retención en la fuente que se reversa (${r.retefuente}) supera lo que queda por reversar de la factura (${info.maximo.retefuente}).`);
    if (r.reteiva > info.maximo.reteiva + 0.004) throw new Error(`El ReteIVA que se reversa (${r.reteiva}) supera lo que queda por reversar de la factura (${info.maximo.reteiva}).`);
    return { asiento: { retefuente: r.retefuente, reteiva: r.reteiva }, guardado: r, total: redondear(r.retefuente + r.reteiva) };
  }
  const cuentasRet = Object.fromEntries(cruces.RETENCIONES.map((x) => [x.campo, x]));
  const guardado = {};
  const retenciones = [];
  let total = 0;
  for (const c of ['retefuente', 'reteiva', 'reteica']) {
    const v = valor(pedida[c], cuentasRet[c].etiqueta);
    if (v > info.maximo[c] + 0.004) throw new Error(`${cuentasRet[c].etiqueta} que se reversa (${v}) supera lo que queda por reversar de la factura (${info.maximo[c]}).`);
    guardado[c] = v;
    total += v;
    if (v > 0) retenciones.push({ cuentaCodigo: cuentasRet[c].cuenta, valor: v });
  }
  const descuentos = [];
  const otros = [];
  for (const o of Array.isArray(pedida.otros) ? pedida.otros : []) {
    const v = valor(o.valor, `«${o.concepto}»`);
    if (v <= 0) continue;
    const origen = (info.maximo.otros || []).find((m) => m.concepto === o.concepto && m.cuentaCodigo === o.cuentaCodigo);
    if (!origen) throw new Error(`«${o.concepto}» no es un descuento de la factura que se está reversando.`);
    if (v > origen.maximo + 0.004) throw new Error(`«${o.concepto}» que se reversa (${v}) supera lo que queda por reversar (${origen.maximo}).`);
    total += v;
    descuentos.push({ cuentaCodigo: origen.cuentaCodigo, valor: v });
    otros.push({ concepto: origen.concepto, cuentaCodigo: origen.cuentaCodigo, cuentaNombre: origen.cuentaNombre, valor: v });
  }
  guardado.otros = otros;
  return { asiento: { retenciones, descuentos }, guardado, total: redondear(total) };
}

// --- análisis común a vista previa y registro ------------------------

async function buscarDocumento(lado, empresaId, nota, tercero) {
  const Modelo = MODELO[lado];
  const ref = nota.referencia;
  if (!ref) return null;
  let doc = null;
  if (ref.cufe) doc = await Modelo.findOne({ where: { empresaId, cufe: ref.cufe } });
  if (!doc && ref.numero) {
    const where = { empresaId, numero: ref.numero };
    if (tercero) where.terceroId = tercero.id;
    doc = await Modelo.findOne({ where });
  }
  return doc;
}

// Resumen de una factura con lo que la nota necesita saber (saldo y notas previas).
async function resumenDocumento(lado, empresaId, d, mapas) {
  const docTipo = DOC_TIPO[lado];
  const neto = cruces.netoDelDocumento(docTipo, d);
  const aplicado = mapas.aplicado[d.id] || 0;
  const notas = mapas.notas[d.id] || 0;
  return {
    id: d.id,
    docTipo,
    numero: d.numero || `${String(d.id).slice(0, 8)}`,
    fecha: d.fecha,
    total: Number(d.total),
    neto: pesos(neto),
    notas: pesos(notas),
    pagado: pesos(aplicado),
    saldo: pesos(neto + notas - aplicado),
    cufe: d.cufe || null,
    contabilizada: !!d.asientoId,
  };
}

async function analizar(datos, usuario) {
  const buffer = decodificarArchivo(datos.archivoBase64);
  const nota = leerFacturaElectronica(buffer);
  const empresa = await Empresa.findByPk(usuario.empresaId);
  if (!empresa) throw new Error('Empresa no encontrada.');
  const advertencias = [...nota.advertencias];

  const aprovision = await aprovisionarContabilidadBase(empresa.id);
  if (aprovision.creado) {
    advertencias.push({
      nivel: 'info',
      texto: `Tu empresa aún no tenía contabilidad base, así que se creó: ${aprovision.detalle}. Puedes ajustar las cuentas y reglas más adelante.`,
    });
  }

  const esNota = nota.esNotaCredito || nota.esNotaDebito;
  const tipo = nota.esNotaCredito ? 'credito' : nota.esNotaDebito ? 'debito' : null;
  if (!esNota) {
    advertencias.push({
      nivel: 'bloqueo',
      texto: nota.elementoRaiz === 'Invoice'
        ? 'Este archivo es una factura, no una nota crédito o débito. Cárgala en «Facturas de compra» o «Facturas de venta».'
        : `Es un documento de tipo "${nota.tipoNombre}", que no es una nota crédito ni débito.`,
    });
  }

  // ¿De qué lado es? La expide la empresa (venta) o la recibe de un proveedor (compra).
  const emisorEsEmpresa = !!(nota.emisor && nota.emisor.nit && mismoNit(empresa.nit, nota.emisor.nit));
  const receptorEsEmpresa = !!(nota.receptor && nota.receptor.nit && mismoNit(empresa.nit, nota.receptor.nit));
  let lado = emisorEsEmpresa ? 'venta' : receptorEsEmpresa ? 'compra' : null;
  let terceroDelXml = lado === 'venta' ? nota.receptor : nota.emisor;
  let tercero = lado && terceroDelXml && terceroDelXml.nit ? await buscarTerceroPorNit(empresa.id, terceroDelXml.nit) : null;

  let documento = null;
  if (!lado && esNota && nota.emisor && nota.emisor.nit) {
    // La nota no trae el NIT de la empresa (a veces el proveedor se equivoca al facturar): se acepta como compra solo
    // si cita una factura de compra que ya está registrada, y se pide confirmación.
    const proveedor = await buscarTerceroPorNit(empresa.id, nota.emisor.nit);
    const candidato = await buscarDocumento('compra', empresa.id, nota, proveedor);
    if (candidato) {
      lado = 'compra';
      terceroDelXml = nota.emisor;
      tercero = proveedor;
      documento = candidato;
      advertencias.push({
        nivel: 'confirmar',
        texto: `La nota está a nombre de ${nota.receptor && nota.receptor.nombre ? nota.receptor.nombre : 'otra persona'} (NIT ${nota.receptor ? nota.receptor.nit : '—'}), que no coincide con el NIT de tu empresa (${empresa.nit}). Se tomó como nota de compra porque corrige la factura ${candidato.numero} que ya tienes registrada.`,
      });
    }
  }
  if (!lado && esNota) {
    advertencias.push({
      nivel: 'bloqueo',
      texto: `Ni el emisor (NIT ${nota.emisor ? nota.emisor.nit : '—'}) ni el receptor (NIT ${nota.receptor ? nota.receptor.nit : '—'}) de la nota coinciden con el NIT de tu empresa (${empresa.nit}).`,
    });
  }

  // Duplicados
  if (nota.cufe) {
    const repetida = await NotaElectronica.findOne({ where: { empresaId: empresa.id, cufe: nota.cufe } });
    if (repetida) {
      advertencias.push({
        nivel: 'bloqueo',
        texto: `Esta nota ya está registrada (${repetida.numero || 'sin número'}, ${repetida.fecha}${repetida.estado === 'anulada' ? ', anulada' : ''}). No se puede cargar dos veces.`,
      });
    }
  }
  if (lado && nota.numero && terceroDelXml && terceroDelXml.nit) {
    const misma = await NotaElectronica.findOne({ where: { empresaId: empresa.id, lado, tipo, numero: nota.numero, terceroNit: terceroDelXml.nit } });
    if (misma && (!nota.cufe || misma.cufe !== nota.cufe)) {
      advertencias.push({ nivel: 'bloqueo', texto: `Ya existe la nota ${nota.numero} de este ${lado === 'compra' ? 'proveedor' : 'cliente'} registrada con otro CUDE.` });
    }
  }

  if (lado === 'venta' && nota.totales.impoconsumo > 0) {
    advertencias.push({
      nivel: 'bloqueo',
      texto: 'La nota trae impuesto al consumo u otros impuestos distintos del IVA. Todavía no se contabilizan en ventas; avísanos para habilitarlo.',
    });
  }
  if (lado === 'venta' && nota.totales.iva > 0 && !empresa.responsableIva) {
    advertencias.push({
      nivel: 'confirmar',
      texto: 'La nota trae IVA pero tu empresa figura como NO responsable de IVA (Mi Empresa). Confirma que es correcto antes de registrarla.',
    });
  }

  // --- factura que modifica
  const contable = valoresContables(nota);
  let candidatas = [];
  const mapas = lado ? { aplicado: await cruces.aplicadoPorDocumento(empresa.id, DOC_TIPO[lado]), notas: await cruces.notasPorDocumento(empresa.id, DOC_TIPO[lado]) } : null;
  let documentoAuto = false;
  let sinVincular = false;
  if (lado) {
    const Modelo = MODELO[lado];
    if (datos.documentoId === NINGUNA) {
      sinVincular = true;
      documento = null;
    } else if (datos.documentoId) {
      documento = await Modelo.findOne({ where: { id: datos.documentoId, empresaId: empresa.id } });
      if (!documento) advertencias.push({ nivel: 'bloqueo', texto: 'La factura elegida no existe.' });
    } else if (!documento) {
      documento = await buscarDocumento(lado, empresa.id, nota, tercero);
      documentoAuto = !!documento;
    } else {
      documentoAuto = true;
    }
    const filtro = { empresaId: empresa.id, asientoId: { [Op.ne]: null } };
    if (tercero) filtro.terceroId = tercero.id;
    if (tercero || documento) {
      const lista = await Modelo.findAll({ where: filtro, order: [['fecha', 'DESC']], limit: 60 });
      if (documento && !lista.some((d) => d.id === documento.id)) lista.unshift(documento);
      for (const d of lista) candidatas.push(await resumenDocumento(lado, empresa.id, d, mapas));
    }
  }

  let resumenDoc = null;
  let reversaInfo = null;
  let previas = [];
  if (documento) {
    resumenDoc = await resumenDocumento(lado, empresa.id, documento, mapas);
    if (tercero && documento.terceroId !== tercero.id) {
      advertencias.push({ nivel: 'bloqueo', texto: `La factura ${resumenDoc.numero} es de otro ${lado === 'compra' ? 'proveedor' : 'cliente'}.` });
    }
    if (!documento.asientoId) {
      advertencias.push({ nivel: 'bloqueo', texto: `La factura ${resumenDoc.numero} aún no está contabilizada; contabilízala antes de cargar su nota.` });
    }
    previas = await NotaElectronica.findAll({ where: { empresaId: empresa.id, docTipo: DOC_TIPO[lado], docId: documento.id, estado: 'activa' } });
    if (tipo === 'credito') {
      const yaAcreditado = redondear(previas.filter((n) => n.tipo === 'credito').reduce((s, n) => s + Number(n.total), 0));
      if (centavos(yaAcreditado + contable.total) > centavos(documento.total) + 100) { // 1 peso de tolerancia: las dos facturas redondean distinto
        advertencias.push({
          nivel: 'bloqueo',
          texto: `Las notas crédito de la factura ${resumenDoc.numero} sumarían ${yaAcreditado + contable.total} y la factura es por ${Number(documento.total)}${yaAcreditado ? ` (ya hay ${yaAcreditado} en notas crédito)` : ''}.`,
        });
      }
      reversaInfo = reversaDeFactura(lado, documento, contable, previas);
      // Lo que la nota baja del saldo es su total menos las retenciones que reversa (las que la persona confirmó, o las sugeridas).
      let reversaTotal = 0;
      try {
        reversaTotal = leerReversa(lado, datos, reversaInfo).total;
      } catch (error) {
        advertencias.push({ nivel: 'bloqueo', texto: error.message }); // lo que la persona digitó no es válido
      }
      const despues = resumenDoc.saldo - (contable.total - reversaTotal);
      if (despues < -0.004 && !advertencias.some((a) => a.nivel === 'bloqueo')) {
        advertencias.push({
          nivel: 'confirmar',
          texto: `La factura ${resumenDoc.numero} ya tiene pagos o recaudos aplicados (${resumenDoc.pagado}): con esta nota queda un saldo a favor de ${redondear(-despues)} que Tesorería no muestra en la cartera. Tendrás que manejarlo aparte (devolución o cruce con otra factura).`,
        });
      }
    }
    if (nota.fechaEmision && documento.fecha && nota.fechaEmision < documento.fecha) {
      advertencias.push({ nivel: 'confirmar', texto: `La nota (${nota.fechaEmision}) es anterior a la factura que modifica (${documento.fecha}).` });
    }
    if (lado === 'venta' && documento.detalle && Array.isArray(documento.detalle.inventario) && documento.detalle.inventario.length) {
      advertencias.push({
        nivel: 'confirmar',
        texto: 'La factura descargó inventario y esta nota NO mueve el kardex ni el costo de ventas. Si corresponde a una devolución de mercancía, ajusta el inventario en Inventarios (el valor de la nota se contabiliza igual).',
      });
    }
    if (lado === 'compra' && documento.detalle && Array.isArray(documento.detalle.inventario) && documento.detalle.inventario.length) {
      advertencias.push({
        nivel: 'confirmar',
        texto: 'La factura dio entrada de inventario y esta nota NO mueve el kardex. Si corresponde a una devolución de mercancía, la cuenta de inventario queda reducida en la contabilidad pero no en el kardex; revísalo en Inventarios.',
      });
    }
  } else if (lado && esNota && !sinVincular) {
    advertencias.push({
      nivel: 'confirmar',
      texto: nota.referencia && nota.referencia.numero
        ? `La factura que modifica la nota (${nota.referencia.numero}) no está registrada en el sistema: elige otra de la lista o registra la nota sin vincularla (no cambiará el saldo de ninguna factura).`
        : 'La nota no cita la factura que modifica: elige una de la lista o registra la nota sin vincularla (no cambiará el saldo de ninguna factura).',
    });
  } else if (lado && sinVincular) {
    advertencias.push({ nivel: 'info', texto: 'La nota se registrará sin vincularla a una factura: no cambia el saldo de ninguna factura en Tesorería.' });
  }

  if (nota.totales.anticipos > 0) {
    advertencias.push({ nivel: 'confirmar', texto: 'La nota trae anticipos: se contabiliza el total completo; revisa el cruce de anticipos aparte.' });
  }

  return { buffer, nota, empresa, lado, tipo, terceroDelXml, tercero, documento, resumenDoc, documentoAuto, candidatas, reversaInfo, previas, contable, advertencias };
}

// Cuentas por línea: la que tenía la línea equivalente de la factura, y si no, la más usada de la factura o el valor por defecto.
function cuentasSugeridasDeLineas(nota, documento, porDefecto) {
  const originales = documento && documento.detalle && Array.isArray(documento.detalle.lineas) ? documento.detalle.lineas : [];
  const usadas = {};
  for (const l of originales) if (l.cuentaCodigo) usadas[l.cuentaCodigo] = (usadas[l.cuentaCodigo] || 0) + 1;
  const masUsada = Object.keys(usadas).sort((a, b) => usadas[b] - usadas[a])[0] || porDefecto;
  return nota.lineas.map((l, i) => {
    const igual = originales.find((o) => o.cuentaCodigo && normalizar(o.descripcion) === normalizar(l.descripcion));
    if (igual) return igual.cuentaCodigo;
    if (originales.length === nota.lineas.length && originales[i] && originales[i].cuentaCodigo) return originales[i].cuentaCodigo;
    return masUsada;
  });
}

function motivoDeLaNota(nota, tipo) {
  const d = nota.discrepancia;
  if (d && d.descripcion) return d.descripcion;
  const conceptos = CONCEPTOS_NOTA[tipo] || {};
  if (d && d.codigo && conceptos[Number(d.codigo)]) return conceptos[Number(d.codigo)];
  // Los proveedores suelen escribir el motivo en las observaciones: se toma la más larga con letras.
  const textos = (nota.notas || []).filter((t) => /[A-Za-zÁÉÍÓÚáéíóúñÑ]{4}/.test(t)).sort((a, b) => b.length - a.length);
  return textos[0] || '';
}

// --- 1) vista previa -------------------------------------------------

async function previsualizarNotaXml(datos, usuario) {
  const a = await analizar(datos, usuario);
  const { nota, empresa, lado, tipo, terceroDelXml, tercero, resumenDoc, documento, documentoAuto, candidatas, reversaInfo, contable, advertencias } = a;
  delete nota.xmlOriginal; // pesado e innecesario para el navegador

  if (lado && terceroDelXml && !tercero) {
    advertencias.push({
      nivel: 'info',
      texto: `El ${lado === 'compra' ? 'proveedor' : 'cliente'} ${terceroDelXml.nombre || terceroDelXml.nit} (NIT ${terceroDelXml.nit}) no está en Terceros. Se creará al registrar la nota.`,
    });
  }
  const porDefecto = lado ? await cuentaPorDefecto(empresa.id, lado) : null;
  return {
    nota,
    lado,
    tipo,
    tituloTipo: tipo ? NOMBRE_NOTA[tipo] : null,
    empresa: { nit: empresa.nit, razonSocial: empresa.razonSocial, responsableIva: !!empresa.responsableIva },
    tercero: tercero ? { id: tercero.id, nombre: tercero.nombre, identificacion: tercero.identificacion, tipo: tercero.tipo } : null,
    terceroXml: terceroDelXml ? { nit: terceroDelXml.nit, nombre: terceroDelXml.nombre } : null,
    documentos: candidatas,
    documento: resumenDoc,
    documentoAuto,
    contable: { ...contable, ivaDescontable: !!empresa.responsableIva },
    reversa: lado && tipo === 'credito' && documento && reversaInfo ? { lado, ...reversaInfo } : null,
    cuentasLinea: lado ? await cuentasDeLinea(empresa.id, lado) : [],
    cuentaPorDefecto: porDefecto,
    cuentasSugeridas: lado ? cuentasSugeridasDeLineas(nota, documento, porDefecto) : [],
    motivo: tipo ? motivoDeLaNota(nota, tipo) : '',
    conceptoNombre: tipo && nota.discrepancia && nota.discrepancia.codigo ? (CONCEPTOS_NOTA[tipo] || {})[Number(nota.discrepancia.codigo)] || null : null,
    advertencias,
    verificacionDianUrl: nota.cufe ? `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${nota.cufe}` : null,
  };
}

// --- 2) registro + contabilización ------------------------------------

async function registrarNotaXml(datos, usuario) {
  const a = await analizar(datos, usuario);
  const { nota, empresa, lado, tipo, terceroDelXml, tercero, documento, reversaInfo, contable, advertencias } = a;

  const bloqueos = advertencias.filter((x) => x.nivel === 'bloqueo');
  if (bloqueos.length) throw new Error(bloqueos.map((b) => b.texto).join(' '));
  const porConfirmar = advertencias.filter((x) => x.nivel === 'confirmar');
  if (porConfirmar.length && !datos.aceptarAdvertencias) {
    throw new Error('Hay advertencias que debes revisar y aceptar antes de registrar: ' + porConfirmar.map((x) => x.texto).join(' '));
  }
  if (!(contable.base > 0)) throw new Error('La base de la nota no es positiva; revisa los totales del XML.');

  // --- proveedor / cliente
  const rotuloTercero = lado === 'compra' ? 'proveedor' : 'cliente';
  let terceroId;
  let crearTercero = false;
  if (datos.terceroId) {
    const elegido = await Tercero.findOne({ where: { id: datos.terceroId, empresaId: empresa.id } });
    if (!elegido) throw new Error(`El ${rotuloTercero} elegido no existe.`);
    if (!mismoNit(elegido.identificacion, terceroDelXml.nit)) throw new Error(`El ${rotuloTercero} elegido no coincide con el NIT que trae la nota.`);
    terceroId = elegido.id;
  } else if (tercero) {
    terceroId = tercero.id;
  } else if (datos.crearTercero) {
    crearTercero = true;
  } else {
    throw new Error(`El ${rotuloTercero} de la nota no está en Terceros. Acepta crearlo o créalo antes.`);
  }
  if (documento && crearTercero) throw new Error(`La factura elegida pertenece a un ${rotuloTercero} que ya existe; este es nuevo.`);
  if (documento && terceroId && documento.terceroId !== terceroId) throw new Error('La factura elegida es de otro tercero.');

  // --- cuentas por línea
  const permitidas = new Set((await cuentasDeLinea(empresa.id, lado)).map((c) => c.codigo));
  const porDefecto = datos.cuentaDestino || (await cuentaPorDefecto(empresa.id, lado));
  const sugeridas = cuentasSugeridasDeLineas(nota, documento, porDefecto);
  const cuentasLinea = nota.lineas.map((l, i) => {
    const elegida = (datos.cuentasLineas && (datos.cuentasLineas[i] || datos.cuentasLineas[String(i)])) || sugeridas[i];
    if (!permitidas.has(elegida)) throw new Error(`La cuenta ${elegida} (línea ${i + 1}) no existe o no sirve para esta nota.`);
    return elegida;
  });

  // --- proyecto / centro de costo
  const proyectoId = datos.proyectoId || (documento && documento.proyectoId) || null;
  let centroCosto = null;
  if (proyectoId) {
    const proyecto = await Proyecto.findOne({ where: { id: proyectoId, empresaId: empresa.id } });
    if (!proyecto) throw new Error('El proyecto elegido no existe.');
    centroCosto = String(proyecto.codigo || proyecto.nombre || '').slice(0, 50) || null;
  }

  // --- retenciones que reversa (solo nota crédito vinculada a una factura)
  let reversa = { asiento: {}, guardado: {}, total: 0 };
  if (tipo === 'credito') {
    if (documento && reversaInfo) reversa = leerReversa(lado, datos, reversaInfo);
    else if (datos.reversa) {
      const hay = JSON.stringify(datos.reversa).match(/[1-9]/);
      if (hay) throw new Error('Para reversar retenciones la nota debe estar vinculada a su factura.');
    }
    if (centavos(reversa.total) >= centavos(contable.total)) throw new Error('Las retenciones que se reversan deben ser menores que el total de la nota.');
  }

  const ivaDescontable = !!empresa.responsableIva;
  const asientoArmado = armarAsientoNota({
    lado, tipo, lineas: nota.lineas, base: contable.base, iva: contable.iva, impoconsumo: contable.impoconsumo, total: contable.total,
    ivaDescontable, cuentasLinea, reversa: reversa.asiento, centroCosto,
  });
  if (!asientoArmado.cuadra) throw new Error('El asiento de la nota no cuadra; revisa los valores del XML.');
  const lineasAsiento = asientoArmado.lineas.map((l) => ({
    cuentaCodigo: l.cuentaCodigo,
    ...(l.debito ? { debito: l.debito } : { credito: l.credito }),
    ...(l.centroCosto ? { centroCosto: l.centroCosto } : {}),
  }));
  const evento = EVENTOS[`${lado}:${tipo}`].evento;
  const motivo = motivoDeLaNota(nota, tipo).slice(0, 300) || null;

  // --- guardado, todo o nada
  const guardado = await sequelize.transaction(async (transaction) => {
    if (crearTercero) {
      const e = terceroDelXml;
      const nuevo = await Tercero.create(
        {
          id: uuidv4(),
          empresaId: empresa.id,
          tipo: lado === 'compra' ? 'proveedor' : 'cliente',
          identificacion: e.dv ? `${e.nit}-${e.dv}` : e.nit,
          nombre: String(e.nombre || e.nombreComercial || e.nit).slice(0, 150),
          tipoPersona: e.tipoPersona || undefined,
          regimenIva: e.regimenIva || undefined,
          responsabilidadesFiscales: e.responsabilidades && e.responsabilidades.length ? e.responsabilidades : undefined,
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

    await asegurarReglasNotas(empresa.id, transaction);
    if (lado === 'venta' && tipo === 'credito' && reversa.total > 0) await cruces.asegurarCuentasRetencion(empresa.id, transaction);

    const creada = await NotaElectronica.create(
      {
        id: uuidv4(),
        empresaId: empresa.id,
        lado,
        tipo,
        numero: nota.numero,
        fecha: nota.fechaEmision,
        cufe: nota.cufe,
        terceroId,
        terceroNit: terceroDelXml.nit,
        terceroNombre: String(terceroDelXml.nombre || '').slice(0, 200),
        docTipo: documento ? DOC_TIPO[lado] : null,
        docId: documento ? documento.id : null,
        referenciaNumero: nota.referencia ? String(nota.referencia.numero || '').slice(0, 40) : null,
        referenciaCufe: nota.referencia ? nota.referencia.cufe || null : null,
        concepto: nota.discrepancia && nota.discrepancia.codigo ? String(nota.discrepancia.codigo).slice(0, 10) : null,
        motivo,
        subtotal: contable.base,
        iva: contable.iva,
        impoconsumo: contable.impoconsumo,
        total: contable.total,
        reversa: reversa.guardado,
        reversaTotal: reversa.total,
        neto: asientoArmado.neto,
        proyectoId,
        detalle: {
          lineas: nota.lineas.map((l, i) => ({
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
          impuestos: nota.impuestos,
          totales: nota.totales,
          notas: nota.notas,
          validacionDian: nota.validacionDian,
          lineasAsiento,
        },
        xmlContenido: nota.xmlOriginal || null,
        estado: 'activa',
        usuarioId: usuario.id,
      },
      { transaction }
    );

    const resultado = await contabilizarAsientoCompuesto({
      empresaId: empresa.id,
      tipoEvento: evento,
      origenModulo: MODULO[lado],
      origenId: creada.id,
      fecha: nota.fechaEmision,
      terceroId,
      usuarioId: usuario.id,
      lineas: lineasAsiento,
      revisado: true, // la persona revisó el desglose en la vista previa
      transaction,
    });
    await creada.update({ asientoId: resultado.asiento ? resultado.asiento.id : null }, { transaction });

    return {
      nota: sinXml(creada),
      lineasAsiento,
      contabilizada: !!(resultado.asiento && resultado.asiento.estado === 'contabilizado'),
      requiereRevision: resultado.requiereRevision,
      periodoAjustado: resultado.periodoAjustado,
    };
  });
  await auditoria.registrar({
    empresaId: empresa.id, usuarioId: usuario.id, accion: 'nota_electronica_registrada', entidad: 'NotaElectronica', entidadId: guardado.nota.id,
    detalle: `${NOMBRE_NOTA[tipo]} ${lado} ${nota.numero || ''} · ${contable.total}`.slice(0, 250),
  });
  return guardado;
}

function sinXml(registro) {
  const plano = registro.toJSON();
  delete plano.xmlContenido;
  return plano;
}

// --- consulta ----------------------------------------------------------

async function listarNotas(filtros, usuario) {
  const where = { empresaId: usuario.empresaId };
  if (filtros && ['compra', 'venta'].includes(filtros.lado)) where.lado = filtros.lado;
  if (filtros && ['credito', 'debito'].includes(filtros.tipo)) where.tipo = filtros.tipo;
  if (filtros && ['activa', 'anulada'].includes(filtros.estado)) where.estado = filtros.estado;
  const notas = await NotaElectronica.findAll({ where, attributes: { exclude: ['xmlContenido', 'detalle'] }, order: [['fecha', 'DESC'], ['createdAt', 'DESC']], limit: 300 });
  const facturas = { compra: {}, venta: {} };
  for (const lado of ['compra', 'venta']) {
    const ids = [...new Set(notas.filter((n) => n.lado === lado && n.docId).map((n) => n.docId))];
    if (!ids.length) continue;
    const docs = await MODELO[lado].findAll({ where: { id: ids, empresaId: usuario.empresaId }, attributes: ['id', 'numero'] });
    for (const d of docs) facturas[lado][d.id] = d.numero;
  }
  return notas.map((n) => ({ ...n.toJSON(), facturaNumero: n.docId ? facturas[n.lado][n.docId] || null : null }));
}

async function obtenerNota(id, usuario) {
  const nota = await NotaElectronica.findOne({ where: { id, empresaId: usuario.empresaId }, attributes: { exclude: ['xmlContenido'] } });
  if (!nota) return null;
  let asiento = [];
  if (nota.asientoId) {
    const movimientos = await Movimiento.findAll({ where: { asientoId: nota.asientoId } });
    const cuentas = await PlanCuentas.findAll({ where: { id: { [Op.in]: movimientos.map((m) => m.cuentaId) } } });
    const porId = Object.fromEntries(cuentas.map((c) => [c.id, c]));
    asiento = movimientos.map((m) => ({
      cuentaCodigo: porId[m.cuentaId] ? porId[m.cuentaId].codigo : '',
      cuentaNombre: porId[m.cuentaId] ? porId[m.cuentaId].nombre : '',
      debito: Number(m.debito),
      credito: Number(m.credito),
      centroCosto: m.centroCosto,
    }));
    asiento.sort((x, y) => (y.debito > 0) - (x.debito > 0) || x.cuentaCodigo.localeCompare(y.cuentaCodigo));
  }
  let factura = null;
  if (nota.docId) {
    const d = await MODELO[nota.lado].findOne({ where: { id: nota.docId, empresaId: usuario.empresaId }, attributes: ['id', 'numero', 'fecha', 'total'] });
    if (d) factura = { id: d.id, numero: d.numero, fecha: d.fecha, total: Number(d.total) };
  }
  return { ...nota.toJSON(), factura, asiento };
}

// Notas vigentes o anuladas de una factura (para mostrarlas en su detalle).
async function notasDeDocumento(docTipo, docId, usuario) {
  if (!['factura_compra', 'factura_venta'].includes(docTipo)) throw new Error('Tipo de documento no válido.');
  const notas = await NotaElectronica.findAll({
    where: { empresaId: usuario.empresaId, docTipo, docId },
    attributes: ['id', 'tipo', 'numero', 'fecha', 'total', 'neto', 'estado', 'motivo'],
    order: [['fecha', 'ASC']],
  });
  return notas.map((n) => n.toJSON());
}

async function obtenerXml(id, usuario) {
  const n = await NotaElectronica.findOne({ where: { id, empresaId: usuario.empresaId }, attributes: ['id', 'numero', 'xmlContenido'] });
  if (!n || !n.xmlContenido) return null;
  return { nombre: `${(n.numero || n.id).replace(/[^\w.-]/g, '_')}.xml`, contenido: n.xmlContenido };
}

// --- anulación -----------------------------------------------------------

async function anularNota(id, datos, usuario) {
  const empresaId = usuario.empresaId;
  const nota = await NotaElectronica.findOne({ where: { id, empresaId } });
  if (!nota) throw new Error('Nota no encontrada.');
  if (nota.estado === 'anulada') throw new Error('Esta nota ya está anulada.');
  const motivo = String((datos && datos.motivo) || '').replace(/\s+/g, ' ').trim();
  if (motivo.length < 10) throw new Error('Escribe el motivo de la anulación (mínimo 10 letras).');
  if (motivo.length > 250) throw new Error('El motivo es muy largo (máximo 250 caracteres).');
  if (/[<>]/.test(motivo)) throw new Error('El motivo no puede llevar los símbolos < o >.');
  await sequelize.transaction(async (transaction) => {
    const asiento = nota.asientoId ? await Asiento.findOne({ where: { id: nota.asientoId, empresaId }, transaction }) : null;
    if (asiento) {
      const periodo = await PeriodoContable.findByPk(asiento.periodoContableId, { transaction });
      if (periodo && !['abierto', 'en_cierre'].includes(periodo.estado)) throw new Error('El período contable de esta nota ya está cerrado; no se puede anular.');
      await asiento.update({ estado: 'anulado' }, { transaction });
    }
    await nota.update({ estado: 'anulada', motivoAnulacion: motivo, fechaAnulacion: new Date() }, { transaction });
  });
  await auditoria.registrar({ empresaId, usuarioId: usuario.id, accion: 'nota_electronica_anulada', entidad: 'NotaElectronica', entidadId: nota.id, detalle: motivo });
  return obtenerNota(nota.id, usuario);
}

module.exports = { previsualizarNotaXml, registrarNotaXml, listarNotas, obtenerNota, notasDeDocumento, obtenerXml, anularNota, NINGUNA };
