// Aportes de contratistas independientes que la empresa paga en la planilla Y de la PILA
// (cotizante 59 «Independiente con contrato de prestación de servicios superior a 1 mes»,
// aportante 15 «Contratante»; Resolución 467 de 2025 del Ministerio de Salud).
//
// Función pura (sin base de datos ni DOM), compartida entre navegador y servidor.
//
// Reglas que aplica (revísalas con tu contador):
//   · IBC = 40 % del valor MENSUALIZADO del contrato, sin IVA (no de lo efectivamente pagado en el mes).
//     Si el contratista tiene varios contratos en el mes se suman. Mínimo 1 SMMLV y máximo 25 SMMLV
//     (proporcionales a los días si el contrato empieza o termina dentro del mes; mes comercial de 30 días).
//   · Salud 12,5 %, pensión 16 % y fondo de solidaridad pensional desde 4 SMMLV: los asume el contratista.
//   · ARL según la clase de riesgo (la más alta si hay varios contratos): clases I a III las asume el
//     contratista (se le descuenta); clases IV y V las asume la empresa.
//   · Cada aporte se aproxima al siguiente múltiplo de 100, como la PILA.
//   · Caja de compensación (voluntaria) y archivo plano de la planilla Y: no incluidos en esta fase.
//
// Asiento de causación (fin de mes, el descuento al contratista):
//   Db  2335 / 2205 (con el contratista)   lo que se le descuenta (salud + pensión + solidaridad + ARL clases I-III)
//   Db  5105xx68 / 5205xx68                ARL que asume la empresa (clases IV y V)
//   Cr  237005                             salud
//   Cr  238030                             pensión y fondo de solidaridad
//   Cr  237006                             ARL
// Asiento del pago de la planilla (mes vencido):
//   Db  237005 / 238030 / 237006           lo causado (con el contratista)
//   Db  530520                             intereses de mora, si hubo
//   Cr  banco o caja                       total pagado al operador
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) {
    module.exports = fabrica(require('./parametrosLaborales'), require('./liquidacionNomina'), require('./asientoNomina'));
  } else raiz.aportesContratistas = fabrica(raiz.parametrosLaborales, raiz.liquidacionNomina, raiz.asientoNomina);
})(typeof self !== 'undefined' ? self : this, function (PL, LN, AN) {
  const x100 = LN.aMultiplo100;
  const T = PL.TARIFAS;
  const TARIFA_SALUD = 0.125;
  const TARIFA_PENSION = 0.16;
  const FACTOR_IBC = 0.4;
  const CUENTAS_POR_PAGAR = { 2335: 'Costos y gastos por pagar (documento soporte)', 2205: 'Proveedores nacionales (factura)' };
  const pesos = (n) => Math.round(Number(n) || 0);

  // Días comerciales (mes de 30 días) de un contrato dentro de un mes: devuelve el rango [desde, hasta] de días 1..30.
  function rangoComercial(anio, mes, fechaInicio, fechaFin) {
    const ultimo = PL.diasDelMes(anio, mes);
    const ini = PL.texto(anio, mes, 1);
    const fin = PL.texto(anio, mes, ultimo);
    const desdeF = fechaInicio && fechaInicio > ini ? fechaInicio : ini;
    const hastaF = fechaFin && fechaFin < fin ? fechaFin : fin;
    if (desdeF > hastaF) return null;
    const dia = (f) => Number(f.slice(8, 10));
    const desde = Math.min(dia(desdeF), 30);
    const hasta = dia(hastaF) >= ultimo ? 30 : Math.min(dia(hastaF), 30);
    if (hasta < desde) return null;
    return { desde, hasta, dias: hasta - desde + 1 };
  }

  // contratos: [{ id, fechaInicio, fechaFin, valorMensual (sin IVA), claseRiesgo }]
  function liquidarContratista({ anio, mes, contratos }) {
    const P = PL.parametros(anio);
    const avisos = [];
    const usados = [];
    const dias = new Set();
    let base40 = 0;
    let valorDelMes = 0;
    let clase = 0;
    let terminaEnMes = false;
    const finMes = PL.texto(anio, mes, PL.diasDelMes(anio, mes));
    for (const c of contratos || []) {
      const r = rangoComercial(anio, mes, c.fechaInicio, c.fechaFin);
      if (!r) continue;
      const valor = Number(c.valorMensual) || 0;
      if (!(valor > 0)) { avisos.push('Un contrato no tiene valor mensual.'); continue; }
      for (let d = r.desde; d <= r.hasta; d++) dias.add(d);
      const proporcional = valor * r.dias / 30;
      valorDelMes += proporcional;
      base40 += proporcional * FACTOR_IBC;
      clase = Math.max(clase, Number(c.claseRiesgo) || 1);
      if (c.fechaFin && c.fechaFin <= finMes) terminaEnMes = true;
      usados.push({ id: c.id, dias: r.dias, valor: pesos(proporcional) });
    }
    if (!usados.length) return null;
    const nDias = dias.size;
    const minimo = pesos(P.smmlv * nDias / 30);
    const maximo = pesos(P.limites.ibcMaximoSmmlv * P.smmlv * nDias / 30);
    let ibc = pesos(base40);
    let origenIbc = '40 % del valor mensualizado';
    if (ibc < minimo) { ibc = minimo; origenIbc = 'mínimo (1 SMMLV)'; }
    if (ibc > maximo) { ibc = maximo; origenIbc = 'máximo (25 SMMLV)'; }

    const salud = x100(ibc * TARIFA_SALUD);
    const pension = x100(ibc * TARIFA_PENSION);
    // Solidaridad pensional: se mira sobre el IBC de un mes completo.
    const ibcMes = nDias ? ibc * 30 / nDias : ibc;
    const tarifaFsp = ibcMes >= 4 * P.smmlv ? PL.tarifaFsp(ibcMes, P.smmlv) : 0;
    const fspSolidaridad = tarifaFsp > 0 ? x100(ibc * 0.01) : 0;
    const fspSubsistencia = tarifaFsp > 0 ? x100(ibc * tarifaFsp - Math.round(ibc * 0.01)) : 0;
    const tarifaArl = T.arl[clase];
    const arl = x100(ibc * tarifaArl);
    const arlLaPagaEmpresa = clase >= 4;
    const descuento = salud + pension + fspSolidaridad + fspSubsistencia + (arlLaPagaEmpresa ? 0 : arl);
    const asumeEmpresa = arlLaPagaEmpresa ? arl : 0;
    if (terminaEnMes) avisos.push('El contrato termina este mes: reporta la novedad RET-T en la planilla Y (a partir del mes siguiente el contratista paga en planilla I).');
    if (ibc === minimo && base40 < minimo) avisos.push('El 40 % del valor del contrato no alcanza 1 SMMLV: se cotiza sobre el mínimo.');

    return {
      dias: nDias,
      contratos: usados,
      valorDelMes: pesos(valorDelMes),
      base40: pesos(base40),
      ibc,
      origenIbc,
      salud: { tarifa: TARIFA_SALUD, valor: salud },
      pension: { tarifa: TARIFA_PENSION, valor: pension },
      fsp: { tarifa: tarifaFsp, solidaridad: fspSolidaridad, subsistencia: fspSubsistencia, valor: fspSolidaridad + fspSubsistencia },
      arl: { clase, tarifa: tarifaArl, valor: arl, aCargoDe: arlLaPagaEmpresa ? 'empresa' : 'contratista' },
      descuento,
      asumeEmpresa,
      total: descuento + asumeEmpresa,
      netoAntesDeImpuestos: pesos(valorDelMes) - descuento,
      terminaEnMes,
      avisos,
    };
  }

  // contratistas: [{ terceroId, nombre, identificacion, contratos:[...] }]
  function liquidarPeriodo({ anio, mes, contratistas }) {
    const lineas = [];
    for (const c of contratistas || []) {
      const r = liquidarContratista({ anio, mes, contratos: c.contratos });
      if (r) lineas.push(Object.assign({ terceroId: c.terceroId, nombre: c.nombre, identificacion: c.identificacion }, r));
    }
    const suma = (f) => lineas.reduce((s, l) => s + f(l), 0);
    const totales = {
      contratistas: lineas.length,
      ibc: suma((l) => l.ibc),
      salud: suma((l) => l.salud.valor),
      pension: suma((l) => l.pension.valor + l.fsp.valor),
      arl: suma((l) => l.arl.valor),
      descuento: suma((l) => l.descuento),
      asumeEmpresa: suma((l) => l.asumeEmpresa),
      total: suma((l) => l.total),
    };
    return { lineas, totales };
  }

  // --- Asientos -------------------------------------------------------------------------------------
  function acumulador() {
    const mapa = new Map();
    const poner = (cuentaCodigo, debito, credito, terceroId) => {
      const d = pesos(debito);
      const c = pesos(credito);
      if (!d && !c) return;
      const clave = `${cuentaCodigo}|${terceroId || ''}`;
      if (!mapa.has(clave)) mapa.set(clave, { cuentaCodigo, debito: 0, credito: 0, terceroId: terceroId || undefined });
      const l = mapa.get(clave);
      l.debito += d;
      l.credito += c;
    };
    const resultado = () => {
      const lineas = Array.from(mapa.values()).map((l) => {
        const neto = l.debito - l.credito;
        return Object.assign({}, l, { debito: neto > 0 ? neto : 0, credito: neto < 0 ? -neto : 0 });
      }).filter((l) => l.debito || l.credito);
      lineas.sort((a, b) => (b.debito > 0) - (a.debito > 0) || (a.cuentaCodigo < b.cuentaCodigo ? -1 : a.cuentaCodigo > b.cuentaCodigo ? 1 : 0));
      const totalDebito = lineas.reduce((s, l) => s + l.debito, 0);
      const totalCredito = lineas.reduce((s, l) => s + l.credito, 0);
      return { lineas, totalDebito, totalCredito, cuadra: totalDebito === totalCredito && lineas.length > 0 };
    };
    return { poner, resultado };
  }

  // items: [{ terceroId, area, cuentaPorPagar ('2335' | '2205'), liquidacion }]
  function armarAsientoCausacion(items) {
    const a = acumulador();
    for (const it of items || []) {
      const L = it.liquidacion;
      const t = it.terceroId;
      const porPagar = CUENTAS_POR_PAGAR[it.cuentaPorPagar] ? it.cuentaPorPagar : '2335';
      a.poner(porPagar, L.descuento, 0, t);
      a.poner(AN.cuentaGasto(it.area, '68'), L.asumeEmpresa, 0, t);
      a.poner(AN.CUENTAS.APORTES_EPS, 0, L.salud.valor, t);
      a.poner(AN.CUENTAS.APORTES_PENSION, 0, L.pension.valor + L.fsp.valor, t);
      a.poner(AN.CUENTAS.APORTES_ARL, 0, L.arl.valor, t);
    }
    return a.resultado();
  }

  // items: [{ terceroId, liquidacion }]; mora: intereses de mora; cuentaPagoCodigo: banco o caja.
  function armarAsientoPago(items, mora, cuentaPagoCodigo) {
    const a = acumulador();
    let total = 0;
    for (const it of items || []) {
      const L = it.liquidacion;
      a.poner(AN.CUENTAS.APORTES_EPS, L.salud.valor, 0, it.terceroId);
      a.poner(AN.CUENTAS.APORTES_PENSION, L.pension.valor + L.fsp.valor, 0, it.terceroId);
      a.poner(AN.CUENTAS.APORTES_ARL, L.arl.valor, 0, it.terceroId);
      total += L.total;
    }
    a.poner('530520', mora, 0);
    a.poner(cuentaPagoCodigo, 0, total + pesos(mora));
    return a.resultado();
  }

  return {
    TARIFA_SALUD, TARIFA_PENSION, FACTOR_IBC, CUENTAS_POR_PAGAR,
    rangoComercial, liquidarContratista, liquidarPeriodo, armarAsientoCausacion, armarAsientoPago,
  };
});
