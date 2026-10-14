// Prestaciones sociales, vacaciones y liquidación final del contrato (Colombia).
//
// UN solo archivo para el servidor y para las pruebas (y la pantalla, si hace
// falta): función pura, sin base de datos ni DOM. Las cifras legales salen de
// parametrosLaborales.js y la retención de liquidacionNomina.js.
//
// Todo en pesos enteros. Base 360 días al año y 30 días al mes.
//
// Qué calcula:
//   · Prima de servicios (CST art. 306): 30 días de salario al año, pagadera por
//     semestre (a más tardar el 30 de junio y el 20 de diciembre).
//   · Cesantías (CST art. 249): un mes de salario por año de servicio.
//   · Intereses sobre cesantías (Ley 52 de 1975): 12 % anual sobre las cesantías.
//   · Vacaciones (CST art. 186): 15 días hábiles por año de servicio.
//   · Indemnización por despido sin justa causa (CST art. 64).
//   · Retención en la fuente de lo que se paga fuera de la nómina del mes.
//
// Base de liquidación (doctrina del Ministerio de Trabajo):
//   · salario fijo, sin cambios recientes  → último salario (+ auxilio de transporte)
//   · salario variable o con cambios       → promedio del período
// Las cesantías y la prima llevan auxilio de transporte; las vacaciones no.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./parametrosLaborales'), require('./liquidacionNomina'));
  else raiz.prestacionesNomina = fabrica(raiz.parametrosLaborales, raiz.liquidacionNomina);
})(typeof self !== 'undefined' ? self : this, function (PL, LN) {
  const r = (n) => Math.round(Number(n) || 0);
  const num = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  };
  const sumar = (lista, f) => lista.reduce((s, x) => s + f(x), 0);
  const redondear2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // Valor de los intereses sobre cesantías, por año de servicio completo.
  const TASA_INTERESES = 0.12;
  // Vacaciones: 15 días hábiles por 360 días de servicio.
  const DIAS_VACACIONES_ANIO = 15;

  // Devengos que NO entran a la base de vacaciones: trabajo suplementario y trabajo
  // en domingos y festivos (CST art. 192).
  const EXCLUIDOS_VACACIONES = ['hed', 'hen', 'hedf', 'henf', 'rdf', 'rnf'];

  const CAUSAS_RETIRO = {
    sin_justa_causa: { nombre: 'Despido sin justa causa', indemniza: true },
    con_justa_causa: { nombre: 'Despido con justa causa', indemniza: false },
    renuncia: { nombre: 'Renuncia del trabajador', indemniza: false },
    mutuo_acuerdo: { nombre: 'Mutuo acuerdo', indemniza: false },
    vencimiento_plazo: { nombre: 'Vencimiento del plazo del contrato', indemniza: false },
    terminacion_obra: { nombre: 'Terminación de la obra o labor', indemniza: false },
    periodo_prueba: { nombre: 'Terminación en período de prueba', indemniza: false },
  };

  // Concepto -> cuenta del pasivo que se paga y subcuenta del gasto que se ajusta.
  const CONCEPTOS = {
    prima: { nombre: 'Prima de servicios', pasivo: '2520', gasto: '36', salario: true },
    cesantias: { nombre: 'Cesantías', pasivo: '2510', gasto: '30', salario: false },
    intereses: { nombre: 'Intereses sobre cesantías', pasivo: '2515', gasto: '33', salario: false },
    vacaciones: { nombre: 'Vacaciones', pasivo: '2525', gasto: '39', salario: true },
    indemnizacion: { nombre: 'Indemnización por despido sin justa causa', pasivo: null, gasto: '60', salario: true },
    otro: { nombre: 'Otros pagos de la liquidación', pasivo: null, gasto: '95', salario: true },
  };

  // --- Fechas y días -------------------------------------------------------------
  const maxFecha = (a, b) => (a > b ? a : b);
  const minFecha = (a, b) => (a < b ? a : b);
  const finDeMes = (f) => {
    const p = PL.partes(f);
    return PL.texto(p.y, p.m, PL.diasDelMes(p.y, p.m));
  };
  const ordenMes = (anio, mes) => Number(anio) * 12 + Number(mes);

  // Días 360 entre dos fechas (inclusive), 0 si el rango está al revés.
  function dias360(desde, hasta) {
    if (!desde || !hasta || hasta < desde) return 0;
    return PL.dias360(desde, hasta);
  }

  // Días sin remuneración (licencias no remuneradas y suspensiones) dentro de un rango.
  // No cuentan para prima, cesantías ni vacaciones (CST art. 51 y 53 de la Ley 50).
  function diasNoRemunerados(ausencias, desde, hasta) {
    let total = 0;
    for (const a of ausencias || []) {
      const def = PL.AUSENCIAS[a.tipo];
      if (!def || def.remunerada) continue;
      const ini = maxFecha(a.desde, desde);
      const fin = minFecha(a.hasta, hasta);
      total += dias360(ini, fin);
    }
    return Math.min(total, dias360(desde, hasta));
  }

  // Días hábiles de un rango: sin domingos ni festivos, y sin sábados si la semana
  // laboral es de 5 días. Es lo que se descuenta del saldo de vacaciones.
  function diasHabiles(desde, hasta, semanaLaboral) {
    if (!desde || !hasta || hasta < desde) return 0;
    const sabadoHabil = Number(semanaLaboral) === 6;
    if (PL.diferenciaDias(desde, hasta) > 800) throw new Error('El rango de vacaciones es demasiado largo.');
    let n = 0;
    for (let f = desde; f <= hasta; f = PL.sumarDias(f, 1)) {
      const dow = PL.diaSemana(f);
      if (dow === 0) continue;
      if (dow === 6 && !sabadoHabil) continue;
      if (PL.esFestivo(f)) continue;
      n += 1;
    }
    return n;
  }

  // --- Meses de referencia ----------------------------------------------------------
  // Convierte la liquidación mensual (resultado de liquidarEmpleado) en lo que
  // necesitan las prestaciones de ese mes.
  function mesDeLiquidacion(L, opciones) {
    const o = opciones || {};
    const devengos = L.devengos || [];
    const excluido = sumar(devengos.filter((d) => EXCLUIDOS_VACACIONES.includes(d.codigo)), (d) => d.valor);
    return {
      anio: L.periodo.anio,
      mes: L.periodo.mes,
      dias: Math.max(0, L.dias.contrato - L.dias.noRemunerados),
      salarial: L.totales.devengadoSalarial,
      variable: L.totales.variableSalarial,
      auxilio: L.totales.auxilio,
      excluidoVacaciones: excluido,
      salarioBase: num(o.salarioBase),
      estimado: !!o.estimado,
    };
  }

  function filtrarMeses(meses, desde, hasta) {
    const a = ordenMes(desde.slice(0, 4), desde.slice(5, 7));
    const b = ordenMes(hasta.slice(0, 4), hasta.slice(5, 7));
    return (meses || [])
      .filter((m) => ordenMes(m.anio, m.mes) >= a && ordenMes(m.anio, m.mes) <= b)
      .sort((x, y) => ordenMes(x.anio, x.mes) - ordenMes(y.anio, y.mes));
  }

  // Auxilio de transporte que le corresponde a un salario completo (sin descontar días).
  function auxilioNominal(contrato, anio, salarioBase) {
    if (contrato.tipoSalario === 'integral') return 0;
    if (contrato.auxilioTransporte === 'no') return 0;
    const P = PL.parametros(anio);
    if (contrato.auxilioTransporte === 'si') return P.auxilioTransporte;
    return salarioBase <= P.limites.auxilioTransporteHastaSmmlv * P.smmlv ? P.auxilioTransporte : 0;
  }

  // --- Base de liquidación ------------------------------------------------------------
  // Devuelve la base MENSUAL y cómo se obtuvo.
  //   conAuxilio       suma el auxilio de transporte (cesantías, prima)
  //   sinExcluidos     quita extras y recargos de festivos (vacaciones)
  //   ventanaCambio    meses finales en los que un cambio de salario obliga a promediar
  //                    (cesantías: 3). Sin valor, mira todos los meses.
  function calcularBase({ contrato, meses, corte, conAuxilio, sinExcluidos, ventanaCambio, soloSalario }) {
    const lista = (meses || []).filter((m) => m.dias > 0);
    const anioCorte = Number(corte.slice(0, 4));
    const ultimoSalario = lista.length && lista[lista.length - 1].salarioBase > 0 ? lista[lista.length - 1].salarioBase : num(contrato.salarioBase);
    const aux = conAuxilio ? auxilioNominal(contrato, anioCorte, ultimoSalario) : 0;

    const hayVariable = lista.some((m) => m.variable > 0);
    const ventana = ventanaCambio ? lista.slice(-ventanaCambio) : lista;
    const salarios = new Set(ventana.map((m) => m.salarioBase).filter((s) => s > 0));
    const cambioSalario = salarios.size > 1;
    const totalDias = sumar(lista, (m) => m.dias);

    if (!lista.length || totalDias <= 0 || (!hayVariable && !cambioSalario)) {
      return {
        base: r(ultimoSalario + aux),
        salario: r(ultimoSalario),
        auxilio: r(aux),
        metodo: 'ultimo_salario',
        motivo: 'Salario fijo sin cambios recientes: se usa el último salario' + (aux ? ' más el auxilio de transporte.' : '.'),
      };
    }
    const numerador = sumar(lista, (m) => m.salarial - (sinExcluidos ? m.excluidoVacaciones : 0) + (conAuxilio ? m.auxilio : 0));
    const promedio = (numerador / totalDias) * 30;
    const soloSal = (sumar(lista, (m) => m.salarial - (sinExcluidos ? m.excluidoVacaciones : 0)) / totalDias) * 30;
    return {
      base: r(promedio),
      salario: r(soloSal),
      auxilio: r(promedio - soloSal),
      metodo: 'promedio',
      motivo: hayVariable
        ? 'Hay pagos variables: se promedia lo devengado en el período.'
        : 'El salario cambió en el período: se promedia lo devengado.',
    };
  }

  // --- Prima de servicios ------------------------------------------------------------
  // semestre 1: 1-ene a 30-jun · semestre 2: 1-jul a 31-dic.
  function calcularPrima({ contrato, anio, semestre, corte, meses, ausencias }) {
    const sem = Number(semestre) === 2 ? 2 : 1;
    const inicioSem = PL.texto(anio, sem === 1 ? 1 : 7, 1);
    const finSem = PL.texto(anio, sem === 1 ? 6 : 12, sem === 1 ? 30 : 31);
    const desde = maxFecha(contrato.fechaIngreso, inicioSem);
    let hasta = minFecha(corte || finSem, finSem);
    if (contrato.fechaTerminacion) hasta = minFecha(hasta, contrato.fechaTerminacion);
    return prestacionPeriodica('prima', { contrato, desde, hasta, meses, ausencias, ventanaCambio: null, conAuxilio: true });
  }

  function prestacionPeriodica(concepto, { contrato, desde, hasta, meses, ausencias, ventanaCambio, conAuxilio }) {
    const advertencias = [];
    if (contrato.tipoSalario === 'integral') {
      return { concepto, desde, hasta, dias: 0, diasNoRemunerados: 0, base: 0, metodo: 'integral', valor: 0, advertencias: ['El salario integral ya incluye las prestaciones; no se liquidan.'] };
    }
    const bruto = dias360(desde, hasta);
    const noRem = bruto ? diasNoRemunerados(ausencias, desde, hasta) : 0;
    const dias = Math.max(0, bruto - noRem);
    const delPeriodo = filtrarMeses(meses, desde, hasta);
    const b = calcularBase({ contrato, meses: delPeriodo, corte: hasta, conAuxilio, sinExcluidos: false, ventanaCambio });
    const estimados = delPeriodo.filter((m) => m.estimado).length;
    if (estimados) advertencias.push(`${estimados} mes(es) del período no tienen nómina en el sistema: se estimaron con el contrato actual.`);
    return {
      concepto,
      desde,
      hasta,
      dias,
      diasNoRemunerados: noRem,
      base: b.base,
      metodo: b.metodo,
      motivoBase: b.motivo,
      valor: dias > 0 ? r((b.base * dias) / 360) : 0,
      advertencias,
    };
  }

  // --- Cesantías e intereses -----------------------------------------------------------
  function periodoCesantias(contrato, anio, corte) {
    const desde = maxFecha(contrato.fechaIngreso, PL.texto(anio, 1, 1));
    let hasta = minFecha(corte || PL.texto(anio, 12, 31), PL.texto(anio, 12, 31));
    if (contrato.fechaTerminacion) hasta = minFecha(hasta, contrato.fechaTerminacion);
    return { desde, hasta };
  }

  function calcularCesantias({ contrato, anio, corte, meses, ausencias }) {
    const { desde, hasta } = periodoCesantias(contrato, anio, corte);
    return prestacionPeriodica('cesantias', { contrato, desde, hasta, meses, ausencias, ventanaCambio: 3, conAuxilio: true });
  }

  // Intereses = cesantías × días × 12 % / 360 (Ley 52 de 1975).
  function calcularIntereses({ cesantias }) {
    const dias = cesantias.dias;
    return {
      concepto: 'intereses',
      desde: cesantias.desde,
      hasta: cesantias.hasta,
      dias,
      diasNoRemunerados: cesantias.diasNoRemunerados,
      base: cesantias.valor,
      metodo: 'sobre_cesantias',
      valor: dias > 0 ? r((cesantias.valor * dias * TASA_INTERESES) / 360) : 0,
      advertencias: [],
    };
  }

  // --- Vacaciones ------------------------------------------------------------------------
  // contrato.vacacionesDiasPrevios: días hábiles ya disfrutados o compensados ANTES de
  // empezar a usar el sistema (desde el ingreso). tomados / compensados: lo registrado aquí.
  function saldoVacaciones({ contrato, corte, ausencias, tomados, compensados, meses }) {
    const bruto = dias360(contrato.fechaIngreso, corte);
    const noRem = bruto ? diasNoRemunerados(ausencias, contrato.fechaIngreso, corte) : 0;
    const diasServicio = Math.max(0, bruto - noRem);
    const causados = redondear2((diasServicio * DIAS_VACACIONES_ANIO) / 360);
    const previos = num(contrato.vacacionesDiasPrevios);
    const usados = redondear2(previos + num(tomados) + num(compensados));
    const saldo = redondear2(causados - usados);

    const ultimos12 = filtrarMeses(meses, PL.sumarDias(corte, -365), corte);
    const b = calcularBase({ contrato, meses: ultimos12, corte, conAuxilio: false, sinExcluidos: true, ventanaCambio: null });
    const valorDia = b.base / 30;
    return {
      diasServicio,
      diasNoRemunerados: noRem,
      causados,
      previos,
      tomados: num(tomados),
      compensados: num(compensados),
      saldo,
      base: b.base,
      metodo: b.metodo,
      motivoBase: b.motivo,
      valorDia: redondear2(valorDia),
      valorSaldo: saldo > 0 ? r(saldo * valorDia) : 0,
    };
  }

  // Valor de compensar en dinero N días hábiles.
  function calcularVacacionesEnDinero({ contrato, corte, ausencias, tomados, compensados, meses, dias }) {
    const s = saldoVacaciones({ contrato, corte, ausencias, tomados, compensados, meses });
    const d = redondear2(num(dias));
    const advertencias = [];
    if (!(d > 0)) throw new Error('Escribe cuántos días hábiles de vacaciones se pagan en dinero.');
    if (d > s.saldo + 1e-9) throw new Error(`El empleado solo tiene ${s.saldo} día(s) hábil(es) de vacaciones pendientes.`);
    return {
      concepto: 'vacaciones',
      desde: contrato.fechaIngreso,
      hasta: corte,
      dias: d,
      saldo: s.saldo,
      base: s.base,
      metodo: s.metodo,
      motivoBase: s.motivoBase,
      valorDia: s.valorDia,
      valor: r((d * s.base) / 30),
      advertencias,
    };
  }

  // --- Indemnización por despido sin justa causa (CST art. 64) ------------------------------
  function calcularIndemnizacion({ contrato, fechaRetiro, causa, baseMensual, diasManual }) {
    const def = CAUSAS_RETIRO[causa];
    if (!def) throw new Error('Elige la causa del retiro.');
    const advertencias = [];
    const vacio = (extra) => Object.assign({ concepto: 'indemnizacion', dias: 0, base: r(baseMensual), valor: 0, advertencias }, extra || {});
    if (!def.indemniza) return vacio();

    const P = PL.parametros(Number(fechaRetiro.slice(0, 4)));
    let dias;
    let detalle;
    if (diasManual != null && diasManual !== '') {
      dias = num(diasManual);
      detalle = 'Días indicados por el usuario.';
    } else if (contrato.tipoContrato === 'indefinido') {
      const servicio = dias360(contrato.fechaIngreso, fechaRetiro);
      const anios = servicio / 360;
      const alto = num(contrato.salarioBase) >= 10 * P.smmlv;
      const primero = alto ? 20 : 30;
      const adicional = alto ? 15 : 20;
      dias = primero + (anios > 1 ? adicional * (anios - 1) : 0);
      detalle = `Contrato indefinido, ${alto ? '10 o más' : 'menos de 10'} SMMLV: ${primero} días el primer año y ${adicional} por cada año siguiente (proporcional por fracción). Tiempo de servicio: ${servicio} días.`;
    } else {
      const fin = contrato.fechaFinPactada;
      let restantes = 0;
      if (fin && fin > fechaRetiro) restantes = dias360(PL.sumarDias(fechaRetiro, 1), fin);
      else if (!fin) advertencias.push('El contrato por obra o labor no tiene fecha estimada de terminación: se aplica el mínimo de 15 días. Indica los días si la obra duraba más.');
      dias = Math.max(15, restantes);
      detalle = `Contrato ${contrato.tipoContrato === 'fijo' ? 'a término fijo' : 'por obra o labor'}: salario del tiempo que faltaba (${restantes} días), mínimo 15 días.`;
    }
    return vacio({ dias: redondear2(dias), valor: r((redondear2(dias) * baseMensual) / 30), detalle, advertencias });
  }

  // --- Retención en la fuente de pagos fuera de la nómina del mes ------------------------------
  // Retención de (ingresos del mes + adicional) menos la del mes sin el adicional.
  // L: liquidación del mes en que se paga (guardada o estimada).
  function retencionAdicional({ anio, liquidacion, contrato, adicional }) {
    const R = liquidacion && liquidacion.retencion;
    const extra = Math.max(0, r(adicional));
    if (!extra) return { valor: 0, modo: 'sin_pagos_gravados' };
    if (!R) return { valor: 0, modo: 'sin_base' };
    if (R.modo === 'no_aplica') return { valor: 0, modo: 'no_aplica' };
    if (R.modo === 'manual') return { valor: 0, modo: 'manual' };
    const comun = {
      anio,
      aportesObligatorios: R.aportesObligatorios,
      aporteVoluntario: num(contrato.aporteVoluntarioPension) + num(contrato.aporteAfc),
      interesesVivienda: contrato.interesesVivienda,
      medicinaPrepagada: contrato.medicinaPrepagada,
      dependientes: Number(contrato.dependientes) > 0,
    };
    const sin = LN.calcularRetencion(Object.assign({}, comun, { ingresos: R.ingresos }));
    const con = LN.calcularRetencion(Object.assign({}, comun, { ingresos: R.ingresos + extra }));
    return { valor: Math.max(0, con.valor - sin.valor), modo: 'calculada', baseGravable: con.baseGravable, baseUvt: con.baseUvt };
  }

  // Lo que el empleado tendría de cesantías e intereses exentos: promedio de los últimos
  // 6 meses hasta 350 UVT (E.T. art. 206, num. 4). Solo se avisa.
  function avisoCesantiasGravadas(contrato, anio) {
    const P = PL.parametros(anio);
    return num(contrato.salarioBase) > 350 * P.uvt
      ? 'El salario supera 350 UVT: parte de las cesantías y los intereses puede ser renta gravable (E.T. art. 206, num. 4). Revisa la retención con el contador.'
      : null;
  }

  // --- Liquidación final del contrato ------------------------------------------------------
  // ctx: {
  //   contrato, fechaRetiro, causa, meses (todos los de referencia), ausencias,
  //   vacaciones: { tomados, compensados }, liquidacionMes (del mes de retiro),
  //   indemnizacionDias?, otrosDevengos: [{descripcion, valor}], descuentos: [{descripcion, valor, cuenta}]
  // }
  function liquidarContrato(ctx) {
    const c = Object.assign({}, ctx.contrato, { fechaTerminacion: ctx.fechaRetiro });
    const retiro = ctx.fechaRetiro;
    const anio = Number(retiro.slice(0, 4));
    const advertencias = [];
    if (!c.fechaIngreso || retiro < c.fechaIngreso) throw new Error('La fecha de retiro no puede ser anterior al ingreso.');
    if (!CAUSAS_RETIRO[ctx.causa]) throw new Error('Elige la causa del retiro.');

    const semestre = Number(retiro.slice(5, 7)) <= 6 ? 1 : 2;
    const prima = calcularPrima({ contrato: c, anio, semestre, corte: retiro, meses: ctx.meses, ausencias: ctx.ausencias });
    const cesantias = calcularCesantias({ contrato: c, anio, corte: retiro, meses: ctx.meses, ausencias: ctx.ausencias });
    const intereses = calcularIntereses({ cesantias });
    const vac = saldoVacaciones({ contrato: c, corte: retiro, ausencias: ctx.ausencias, tomados: ctx.vacaciones && ctx.vacaciones.tomados, compensados: ctx.vacaciones && ctx.vacaciones.compensados, meses: ctx.meses });

    const componentes = [];
    const poner = (concepto, valor, extra) => {
      if (!valor) return;
      componentes.push(Object.assign({ concepto, nombre: CONCEPTOS[concepto].nombre, valor: r(valor), liquidaTotal: true }, extra || {}));
    };
    poner('prima', prima.valor, { dias: prima.dias, desde: prima.desde, hasta: prima.hasta, base: prima.base, metodo: prima.metodo });
    poner('cesantias', cesantias.valor, { dias: cesantias.dias, desde: cesantias.desde, hasta: cesantias.hasta, base: cesantias.base, metodo: cesantias.metodo });
    poner('intereses', intereses.valor, { dias: intereses.dias, desde: intereses.desde, hasta: intereses.hasta, base: intereses.base, metodo: intereses.metodo });
    if (vac.saldo > 0) poner('vacaciones', vac.valorSaldo, { dias: vac.saldo, base: vac.base, metodo: vac.metodo, valorDia: vac.valorDia });
    else if (vac.saldo < 0) advertencias.push(`El empleado tomó ${Math.abs(vac.saldo)} día(s) hábil(es) de vacaciones más de los causados; no se descuentan automáticamente.`);

    // Indemnización: sobre el salario (sin auxilio) con las extras y recargos que forman parte de él.
    const baseSal = calcularBase({ contrato: c, meses: filtrarMeses(ctx.meses, PL.sumarDias(retiro, -365), retiro), corte: retiro, conAuxilio: false, sinExcluidos: false, ventanaCambio: null });
    const ind = calcularIndemnizacion({ contrato: c, fechaRetiro: retiro, causa: ctx.causa, baseMensual: baseSal.base, diasManual: ctx.indemnizacionDias });
    poner('indemnizacion', ind.valor, { dias: ind.dias, base: ind.base, detalle: ind.detalle });
    advertencias.push(...ind.advertencias);

    const otros = [];
    for (const o of ctx.otrosDevengos || []) {
      const v = r(o.valor);
      if (!(v > 0)) continue;
      otros.push({ descripcion: o.descripcion || 'Otro pago', valor: v });
    }
    if (otros.length) poner('otro', sumar(otros, (x) => x.valor), { detalle: otros.map((x) => x.descripcion).join('; '), liquidaTotal: false });

    for (const x of [prima, cesantias]) advertencias.push(...x.advertencias);
    const avisoGravada = avisoCesantiasGravadas(c, anio);
    if (avisoGravada) advertencias.push(avisoGravada);
    if (vac.metodo === 'promedio' && vac.base !== r(c.salarioBase)) advertencias.push('Las vacaciones se liquidaron con el promedio de los últimos 12 meses.');

    // Gravado: prima, vacaciones, indemnización y otros pagos. Cesantías e intereses, exentos hasta 350 UVT.
    const gravado = sumar(componentes.filter((x) => CONCEPTOS[x.concepto].salario), (x) => x.valor);
    const ret = retencionAdicional({ anio, liquidacion: ctx.liquidacionMes, contrato: c, adicional: gravado });
    if (ret.modo === 'manual') advertencias.push('La retención del contrato es un valor fijo mensual: en la liquidación final no se calcula. Digítala en “Otros descuentos” si aplica.');
    if (ret.modo === 'sin_base') advertencias.push('No se pudo estimar la retención en la fuente de la liquidación.');

    const descuentos = [];
    for (const d of ctx.descuentos || []) {
      const v = r(d.valor);
      if (v > 0) descuentos.push({ descripcion: d.descripcion || 'Descuento', valor: v, cuenta: d.cuenta || '237095', codigo: d.codigo || 'otro_descuento' });
    }

    const devengado = sumar(componentes, (x) => x.valor);
    const totalDescuentos = sumar(descuentos, (x) => x.valor);
    const neto = devengado - ret.valor - totalDescuentos;
    if (neto < 0) advertencias.push('Los descuentos superan lo que se le debe al empleado: el neto es negativo.');

    return {
      fechaRetiro: retiro,
      causa: ctx.causa,
      causaNombre: CAUSAS_RETIRO[ctx.causa].nombre,
      componentes,
      detalle: { prima, cesantias, intereses, vacaciones: vac, indemnizacion: ind },
      devengado,
      retencion: ret,
      descuentos,
      totalDescuentos,
      neto,
      advertencias,
    };
  }

  return {
    TASA_INTERESES,
    DIAS_VACACIONES_ANIO,
    EXCLUIDOS_VACACIONES,
    CAUSAS_RETIRO,
    CONCEPTOS,
    dias360,
    diasNoRemunerados,
    diasHabiles,
    finDeMes,
    mesDeLiquidacion,
    filtrarMeses,
    auxilioNominal,
    calcularBase,
    calcularPrima,
    calcularCesantias,
    calcularIntereses,
    saldoVacaciones,
    calcularVacacionesEnDinero,
    calcularIndemnizacion,
    retencionAdicional,
    liquidarContrato,
  };
});
