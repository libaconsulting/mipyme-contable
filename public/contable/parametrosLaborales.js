// Parámetros laborales y de seguridad social de Colombia, por año.
//
// UN solo archivo que usan el navegador (pantallas de nómina) y el backend
// (liquidación y contabilización). No depende de Node ni del DOM.
//
// Aquí vive TODO número que cambia por norma o por año, para que el motor de
// liquidación (liquidacionNomina.js) no tenga cifras escondidas:
//   - salario mínimo, auxilio de transporte y UVT de cada año
//   - tarifas de aportes (salud, pensión, ARL, parafiscales) y fondo de solidaridad
//   - tabla de retención en la fuente del artículo 383 del Estatuto Tributario
//   - jornada máxima semanal (Ley 2101 de 2021) y recargos (Ley 2466 de 2025)
//   - festivos de Colombia (Ley Emiliani + Semana Santa)
//
// IMPORTANTE: estos valores son una guía operativa, no asesoría laboral ni
// tributaria. Cada enero (y cada vez que cambie una norma) hay que revisarlos
// con el contador. Para un año que no esté en la tabla se usa el último año
// conocido y se avisa con `estimado: true`.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.parametrosLaborales = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  // --- Valores por año ------------------------------------------------------
  const ANUAL = {
    2023: { smmlv: 1160000, auxilioTransporte: 140606, uvt: 42412 },
    2024: { smmlv: 1300000, auxilioTransporte: 162000, uvt: 47065 },
    2025: { smmlv: 1423500, auxilioTransporte: 200000, uvt: 49799 },
    2026: { smmlv: 1750905, auxilioTransporte: 249095, uvt: 52374 },
  };

  // --- Tarifas (no cambian de un año a otro) ---------------------------------
  const TARIFAS = {
    saludEmpleado: 0.04,
    saludEmpleador: 0.085,
    pensionEmpleado: 0.04,
    pensionEmpleador: 0.12,
    cajaCompensacion: 0.04,
    sena: 0.02,
    icbf: 0.03,
    // Riesgos laborales (Decreto 1772 de 1994), tarifa inicial de cada clase.
    arl: { 1: 0.00522, 2: 0.01044, 3: 0.02436, 4: 0.0435, 5: 0.0696 },
  };

  const CLASES_RIESGO = {
    1: 'Clase I · riesgo mínimo (oficina)',
    2: 'Clase II · riesgo bajo',
    3: 'Clase III · riesgo medio',
    4: 'Clase IV · riesgo alto',
    5: 'Clase V · riesgo máximo',
  };

  // Fondo de Solidaridad Pensional (Ley 797 de 2003, art. 8): lo paga el
  // empleado cuando su IBC es de 4 SMMLV o más. Tarifa total por rango de SMMLV.
  const FSP_RANGOS = [
    { desde: 4, hasta: 16, tarifa: 0.01 },
    { desde: 16, hasta: 17, tarifa: 0.012 },
    { desde: 17, hasta: 18, tarifa: 0.014 },
    { desde: 18, hasta: 19, tarifa: 0.016 },
    { desde: 19, hasta: 20, tarifa: 0.018 },
    { desde: 20, hasta: Infinity, tarifa: 0.02 },
  ];

  const LIMITES = {
    ibcMinimoSmmlv: 1,
    ibcMaximoSmmlv: 25,
    // Art. 114-1 del Estatuto Tributario: quien devenga menos de 10 SMMLV no
    // paga salud del empleador, SENA ni ICBF (si el empleador es persona
    // jurídica, o natural con 2 o más trabajadores).
    exoneracionSmmlv: 10,
    // Aux. de transporte: quien devenga hasta 2 SMMLV.
    auxilioTransporteHastaSmmlv: 2,
    // Salario integral: mínimo 13 SMMLV (10 + 30 % de factor prestacional).
    salarioIntegralMinimoSmmlv: 13,
    factorIbcIntegral: 0.7,
    // Ley 1393 de 2010, art. 30: los pagos no salariales que pasen del 40 % de
    // la remuneración total entran al IBC por el exceso.
    limitePagosNoSalariales: 0.4,
  };

  // --- Retención en la fuente por salarios (art. 383 E.T.), en UVT mensuales ---
  const TABLA_383 = [
    { desde: 0, hasta: 95, tarifa: 0, suma: 0 },
    { desde: 95, hasta: 150, tarifa: 0.19, suma: 0 },
    { desde: 150, hasta: 360, tarifa: 0.28, suma: 10 },
    { desde: 360, hasta: 640, tarifa: 0.33, suma: 69 },
    { desde: 640, hasta: 945, tarifa: 0.35, suma: 162 },
    { desde: 945, hasta: 2300, tarifa: 0.37, suma: 268 },
    { desde: 2300, hasta: Infinity, tarifa: 0.39, suma: 770 },
  ];

  // Topes de la depuración de la base de retención, en UVT.
  const RETENCION = {
    rentaExentaLaboral: 0.25,
    rentaExentaLaboralTopeAnualUvt: 790,
    limiteDeduccionesPorcentaje: 0.4,
    limiteDeduccionesAnualUvt: 1340,
    interesesViviendaMensualUvt: 100,
    medicinaPrepagadaMensualUvt: 16,
    dependientesPorcentaje: 0.1,
    dependientesMensualUvt: 32,
    aportesVoluntariosPorcentaje: 0.3,
    aportesVoluntariosAnualUvt: 3800,
    // La retención se aproxima al múltiplo de mil más cercano.
    aproximacion: 1000,
  };

  // --- Tipos de ausencia, conceptos de devengo y de descuento ------------------
  const AUSENCIAS = {
    incapacidad_general: { nombre: 'Incapacidad por enfermedad general', pila: 'IGE', remunerada: true },
    incapacidad_laboral: { nombre: 'Incapacidad por accidente de trabajo / enfermedad laboral', pila: 'IRL', remunerada: true },
    licencia_maternidad: { nombre: 'Licencia de maternidad', pila: 'LMA', remunerada: true },
    licencia_paternidad: { nombre: 'Licencia de paternidad', pila: 'LMA', remunerada: true },
    vacaciones: { nombre: 'Vacaciones disfrutadas', pila: 'VAC', remunerada: true },
    licencia_no_remunerada: { nombre: 'Licencia no remunerada', pila: 'SLN', remunerada: false },
    suspension: { nombre: 'Suspensión del contrato', pila: 'SLN', remunerada: false },
  };

  // Devengos que se digitan como novedad.
  //  - horas: se liquidan con el valor de la hora ordinaria × factor.
  //  - factor 'adicional': lo que se paga ENCIMA del sueldo mensual (que ya
  //    remunera la hora ordinaria). `festivo: true` suma el recargo dominical.
  //  - salarial: cuenta para IBC y prestaciones (los no salariales, no).
  //  - sinHorasExtras: marca los que NO entran a la base de vacaciones (art. 192 C.S.T.).
  const DEVENGOS = {
    hed: { nombre: 'Hora extra diurna', horas: true, base: 1.25, festivo: false, salarial: true, extra: true, sufijo: '15' },
    hen: { nombre: 'Hora extra nocturna', horas: true, base: 1.75, festivo: false, salarial: true, extra: true, sufijo: '15' },
    rn: { nombre: 'Recargo nocturno', horas: true, base: 0.35, festivo: false, salarial: true, extra: false, sufijo: '15' },
    rdf: { nombre: 'Recargo dominical / festivo (diurno)', horas: true, base: 0, festivo: true, salarial: true, extra: false, sufijo: '15' },
    rnf: { nombre: 'Recargo nocturno dominical / festivo', horas: true, base: 0.35, festivo: true, salarial: true, extra: false, sufijo: '15' },
    hedf: { nombre: 'Hora extra diurna dominical / festiva', horas: true, base: 1.25, festivo: true, salarial: true, extra: true, sufijo: '15' },
    henf: { nombre: 'Hora extra nocturna dominical / festiva', horas: true, base: 1.75, festivo: true, salarial: true, extra: true, sufijo: '15' },
    comision: { nombre: 'Comisiones', horas: false, salarial: true, extra: false, sufijo: '18' },
    bonificacion_salarial: { nombre: 'Bonificación salarial', horas: false, salarial: true, extra: false, sufijo: '48' },
    otro_devengo_salarial: { nombre: 'Otro devengo salarial', horas: false, salarial: true, extra: false, sufijo: '95' },
    bonificacion_no_salarial: { nombre: 'Bonificación no salarial', horas: false, salarial: false, extra: false, sufijo: '48' },
    auxilio_no_salarial: { nombre: 'Auxilio no salarial (alimentación, rodamiento…)', horas: false, salarial: false, extra: false, sufijo: '45' },
    otro_devengo_no_salarial: { nombre: 'Otro pago no salarial', horas: false, salarial: false, extra: false, sufijo: '95' },
  };

  // Descuentos que se digitan como novedad (los aportes y la retención se calculan solos).
  const DESCUENTOS = {
    prestamo: { nombre: 'Préstamo a empleado', cuenta: '1365' },
    libranza: { nombre: 'Libranza', cuenta: '237030' },
    embargo: { nombre: 'Embargo judicial', cuenta: '237025' },
    otro_descuento: { nombre: 'Otro descuento', cuenta: '237095' },
  };

  // --- Funciones ----------------------------------------------------------------
  function parametros(anio) {
    const a = Number(anio);
    const conocidos = Object.keys(ANUAL).map(Number).sort((x, y) => x - y);
    let usado = a;
    let estimado = false;
    if (!ANUAL[a]) {
      estimado = true;
      usado = a < conocidos[0] ? conocidos[0] : conocidos[conocidos.length - 1];
    }
    return Object.assign({ anio: a, anioBase: usado, estimado }, ANUAL[usado], {
      tarifas: TARIFAS,
      limites: LIMITES,
      retencion: RETENCION,
      tabla383: TABLA_383,
      fsp: FSP_RANGOS,
    });
  }

  // Tarifa total del Fondo de Solidaridad Pensional según el IBC.
  function tarifaFsp(ibc, smmlv) {
    if (!smmlv) return 0;
    const veces = ibc / smmlv;
    const r = FSP_RANGOS.find((x) => veces >= x.desde && veces < x.hasta);
    return r ? r.tarifa : 0;
  }

  // --- Fechas ('YYYY-MM-DD', sin zonas horarias) ---------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  const texto = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  function partes(f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f || ''));
    if (!m) throw new Error(`Fecha inválida: "${f}". Usa el formato AAAA-MM-DD.`);
    const y = Number(m[1]);
    const mes = Number(m[2]);
    const d = Number(m[3]);
    if (mes < 1 || mes > 12 || d < 1 || d > diasDelMes(y, mes)) throw new Error(`Fecha inválida: "${f}".`);
    return { y, m: mes, d };
  }

  function diasDelMes(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function sumarDias(f, n) {
    const { y, m, d } = partes(f);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return texto(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }

  // Días calendario entre dos fechas (hasta - desde).
  function diferenciaDias(desde, hasta) {
    const a = partes(desde);
    const b = partes(hasta);
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }

  function diaSemana(f) {
    const { y, m, d } = partes(f);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 domingo
  }

  // Días entre dos fechas (ambas incluidas) en base 30/360: todos los meses
  // valen 30 días, como se liquida la nómina en Colombia. El último día de cada
  // mes (28, 29, 30 o 31) cuenta como 30.
  function dias360(desde, hasta) {
    const a = partes(desde);
    const b = partes(hasta);
    const ajustar = (p) => (p.d === diasDelMes(p.y, p.m) ? 30 : Math.min(p.d, 30));
    const n = (b.y - a.y) * 360 + (b.m - a.m) * 30 + (ajustar(b) - ajustar(a)) + 1;
    return Math.max(0, n);
  }

  // --- Festivos -------------------------------------------------------------------
  // Domingo de Pascua (algoritmo de Meeus/Jones/Butcher).
  function pascua(anio) {
    const a = anio % 19;
    const b = Math.floor(anio / 100);
    const c = anio % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31);
    const dia = ((h + l - 7 * m + 114) % 31) + 1;
    return texto(anio, mes, dia);
  }

  // Ley Emiliani (Ley 51 de 1983): pasa al lunes siguiente si no cae lunes.
  function alLunes(f) {
    const dow = diaSemana(f);
    return dow === 1 ? f : sumarDias(f, (8 - dow) % 7);
  }

  const cacheFestivos = {};
  // Lista ordenada de festivos nacionales del año ('AAAA-MM-DD').
  function festivos(anio) {
    if (cacheFestivos[anio]) return cacheFestivos[anio];
    const p = pascua(anio);
    const fijos = [texto(anio, 1, 1), texto(anio, 5, 1), texto(anio, 7, 20), texto(anio, 8, 7), texto(anio, 12, 8), texto(anio, 12, 25)];
    const emiliani = [
      texto(anio, 1, 6), // Reyes Magos
      texto(anio, 3, 19), // San José
      texto(anio, 6, 29), // San Pedro y San Pablo
      texto(anio, 8, 15), // Asunción de la Virgen
      texto(anio, 10, 12), // Día de la Raza
      texto(anio, 11, 1), // Todos los Santos
      texto(anio, 11, 11), // Independencia de Cartagena
    ].map(alLunes);
    const semanaSanta = [sumarDias(p, -3), sumarDias(p, -2)]; // jueves y viernes santo
    const pascuales = [sumarDias(p, 39), sumarDias(p, 60), sumarDias(p, 68)].map(alLunes); // Ascensión, Corpus Christi, Sagrado Corazón
    const lista = Array.from(new Set([...fijos, ...emiliani, ...semanaSanta, ...pascuales])).sort();
    cacheFestivos[anio] = lista;
    return lista;
  }

  function esFestivo(f) {
    return festivos(partes(f).y).includes(f);
  }

  function esDominicalOFestivo(f) {
    return diaSemana(f) === 0 || esFestivo(f);
  }

  // --- Reglas que cambian con la fecha ------------------------------------------
  // Recargo por trabajar domingo o festivo (Ley 2466 de 2025, art. 14):
  // 75 % hasta el 30-jun-2025, 80 % desde el 1-jul-2025, 90 % desde el 1-jul-2026
  // y 100 % desde el 1-jul-2027.
  function recargoDominicalFestivo(f) {
    if (f < '2025-07-01') return 0.75;
    if (f < '2026-07-01') return 0.8;
    if (f < '2027-07-01') return 0.9;
    return 1.0;
  }

  // Jornada máxima semanal (Ley 2101 de 2021): 47 h desde 15-jul-2023,
  // 46 h desde 15-jul-2024, 44 h desde 15-jul-2025 y 42 h desde 15-jul-2026.
  function horasSemanales(f) {
    if (f < '2023-07-15') return 48;
    if (f < '2024-07-15') return 47;
    if (f < '2025-07-15') return 46;
    if (f < '2026-07-15') return 44;
    return 42;
  }

  // Horas del mes que divide el sueldo para sacar el valor de la hora.
  // 240 con jornada de 48 h (48 × 5), 210 con la de 42 h.
  function horasMensuales(f) {
    return horasSemanales(f) * 5;
  }

  // Desde el 25-dic-2025 (Ley 2466) la jornada nocturna empieza a las 7 p. m.; antes, a las 9 p. m.
  function inicioJornadaNocturna(f) {
    return f < '2025-12-25' ? '21:00' : '19:00';
  }

  return {
    ANUAL,
    TARIFAS,
    CLASES_RIESGO,
    LIMITES,
    TABLA_383,
    RETENCION,
    FSP_RANGOS,
    AUSENCIAS,
    DEVENGOS,
    DESCUENTOS,
    parametros,
    tarifaFsp,
    partes,
    texto,
    diasDelMes,
    sumarDias,
    diferenciaDias,
    diaSemana,
    dias360,
    pascua,
    festivos,
    esFestivo,
    esDominicalOFestivo,
    recargoDominicalFestivo,
    horasSemanales,
    horasMensuales,
    inicioJornadaNocturna,
  };
});
