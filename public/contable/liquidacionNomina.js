// Liquidación mensual de nómina de UN empleado (Colombia).
//
// UN solo archivo que usan el navegador (vista previa de la liquidación) y el
// backend (la que se guarda y se contabiliza): lo que se ve es lo que se
// registra. Función pura: no toca base de datos ni el DOM; todas las cifras
// legales salen de parametrosLaborales.js.
//
// Todo en pesos enteros: cada valor se redondea al peso, como en un
// desprendible de pago.
//
// Qué calcula:
//   1. Días: del contrato dentro del mes (base 30), ausencias y días trabajados.
//   2. Devengado: sueldo, auxilio de transporte/conectividad, vacaciones,
//      incapacidades y licencias, horas extras y recargos, comisiones y bonos.
//   3. Base de aportes (IBC): con tope mínimo/máximo y la regla del 40 % de
//      pagos no salariales.
//   4. Aportes del empleado (salud, pensión, fondo de solidaridad) y del
//      empleador (salud, pensión, ARL, caja, SENA, ICBF) con la exoneración
//      del art. 114-1 del Estatuto Tributario.
//   5. Retención en la fuente (art. 383 E.T., procedimiento 1).
//   6. Provisiones mensuales: cesantías, intereses, prima y vacaciones.
//   7. Datos para la planilla PILA: días, IBC y novedades.
//
// Esto es una guía operativa: los supuestos están listados en el README y
// conviene revisarlos con el contador antes de la primera nómina real.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./parametrosLaborales'));
  else raiz.liquidacionNomina = fabrica(raiz.parametrosLaborales);
})(typeof self !== 'undefined' ? self : this, function (PL) {
  const r = (n) => Math.round(Number(n) || 0);
  const num = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  };
  const sumar = (lista, f) => lista.reduce((s, x) => s + f(x), 0);
  const entre = (v, min, max) => Math.min(Math.max(v, min), max);

  // Pago diario de una incapacidad por enfermedad general según el día en que va
  // (contando desde el primer día de la incapacidad, incluidas sus prórrogas):
  //   días 1-2     66,67 % a cargo del empleador
  //   días 3-90    66,67 % a cargo de la EPS
  //   días 91-180  50 % a cargo de la EPS
  //   día 181 en adelante  50 % a cargo del fondo de pensiones (AFP)
  function tramoIncapacidad(dia) {
    if (dia <= 2) return { porcentaje: 0.6667, pagador: 'empleador' };
    if (dia <= 90) return { porcentaje: 0.6667, pagador: 'eps' };
    if (dia <= 180) return { porcentaje: 0.5, pagador: 'eps' };
    return { porcentaje: 0.5, pagador: 'afp' };
  }

  // --- Retención en la fuente por salarios (art. 383 E.T., procedimiento 1) -------
  // d: { anio, ingresos, aportesObligatorios, aporteVoluntario, interesesVivienda,
  //      medicinaPrepagada, dependientes }  (todo mensual, en pesos)
  function calcularRetencion(d) {
    const P = PL.parametros(d.anio);
    const R = P.retencion;
    const uvt = P.uvt;
    const ingresos = Math.max(0, num(d.ingresos));
    const incrngo = Math.max(0, num(d.aportesObligatorios));
    const neto = Math.max(0, ingresos - incrngo);

    const vivienda = Math.min(Math.max(0, num(d.interesesVivienda)), R.interesesViviendaMensualUvt * uvt);
    const prepagada = Math.min(Math.max(0, num(d.medicinaPrepagada)), R.medicinaPrepagadaMensualUvt * uvt);
    const dependientes = d.dependientes ? Math.min(R.dependientesPorcentaje * ingresos, R.dependientesMensualUvt * uvt) : 0;
    const voluntario = Math.min(
      Math.max(0, num(d.aporteVoluntario)),
      R.aportesVoluntariosPorcentaje * ingresos,
      (R.aportesVoluntariosAnualUvt * uvt) / 12
    );

    const baseRentaExenta = Math.max(0, neto - vivienda - prepagada - dependientes - voluntario);
    const rentaExenta25 = Math.min(R.rentaExentaLaboral * baseRentaExenta, (R.rentaExentaLaboralTopeAnualUvt * uvt) / 12);
    const beneficios = vivienda + prepagada + dependientes + voluntario + rentaExenta25;
    const limite = Math.min(R.limiteDeduccionesPorcentaje * neto, (R.limiteDeduccionesAnualUvt * uvt) / 12);
    const beneficiosAplicados = Math.min(beneficios, limite);
    const baseGravable = Math.max(0, neto - beneficiosAplicados);
    const baseUvt = baseGravable / uvt;

    const fila = P.tabla383.find((x) => baseUvt > x.desde && baseUvt <= x.hasta);
    const impuestoUvt = fila && fila.tarifa > 0 ? (baseUvt - fila.desde) * fila.tarifa + fila.suma : 0;
    const bruta = impuestoUvt * uvt;
    const valor = Math.round(bruta / R.aproximacion) * R.aproximacion;

    return {
      valor,
      ingresos: r(ingresos),
      aportesObligatorios: r(incrngo),
      ingresoNeto: r(neto),
      vivienda: r(vivienda),
      medicinaPrepagada: r(prepagada),
      dependientes: r(dependientes),
      aporteVoluntario: r(voluntario),
      rentaExenta25: r(rentaExenta25),
      limite: r(limite),
      beneficiosAplicados: r(beneficiosAplicados),
      baseGravable: r(baseGravable),
      baseUvt: Math.round(baseUvt * 100) / 100,
      tarifaMarginal: fila ? fila.tarifa : 0,
    };
  }

  // --- Ausencias del mes -----------------------------------------------------------
  function procesarAusencias(ausencias, ventana, ctx) {
    const { salarioDia, salarioIbcDia, smmlvDia, factorIbc } = ctx;
    const lista = [];
    for (const a of ausencias || []) {
      const def = PL.AUSENCIAS[a.tipo];
      if (!def) throw new Error(`Tipo de ausencia desconocido: "${a.tipo}".`);
      if (!a.desde || !a.hasta) throw new Error(`La ausencia "${def.nombre}" necesita fecha de inicio y de fin.`);
      if (a.hasta < a.desde) throw new Error(`La ausencia "${def.nombre}" termina antes de empezar.`);
      const desde = a.desde > ventana.desde ? a.desde : ventana.desde;
      const hasta = a.hasta < ventana.hasta ? a.hasta : ventana.hasta;
      if (desde > hasta) continue; // no toca este mes
      const dias = PL.dias360(desde, hasta);
      if (dias <= 0) continue;

      const item = {
        tipo: a.tipo,
        nombre: def.nombre,
        pila: def.pila,
        desde,
        hasta,
        dias,
        remunerada: def.remunerada,
        pagoTotal: 0,
        pagoEmpleador: 0,
        porCobrarEps: 0,
        porCobrarAfp: 0,
        porCobrarArl: 0,
        ibc: 0,
        valorDiario: 0,
      };

      const propio = a.valorDiario != null && a.valorDiario !== '' ? num(a.valorDiario) : null;
      if (a.tipo === 'vacaciones') {
        item.valorDiario = propio != null ? propio : salarioDia;
        item.pagoTotal = r(item.valorDiario * dias);
        item.pagoEmpleador = item.pagoTotal;
        item.ibc = r(item.pagoTotal * factorIbc);
      } else if (def.remunerada) {
        // Incapacidades y licencias: la seguridad social se paga sobre el 100 % del
        // salario (con piso de 1 SMMLV), aunque el pago sea menor.
        const baseDia = propio != null ? propio : salarioIbcDia;
        const baseIbcDia = Math.max(baseDia, smmlvDia);
        item.valorDiario = baseDia;
        item.ibc = r(baseIbcDia * dias);
        if (a.tipo === 'incapacidad_general') {
          const primero = num(a.diasPrevios) + PL.diferenciaDias(a.desde, desde) + 1;
          let empleador = 0;
          let eps = 0;
          let afp = 0;
          for (let k = 0; k < dias; k++) {
            const t = tramoIncapacidad(primero + k);
            // 66,67 % del salario, con piso de 1 SMMLV diario, sin pasar del salario.
            const pago = Math.min(baseDia, Math.max(baseDia * t.porcentaje, smmlvDia));
            if (t.pagador === 'empleador') empleador += pago;
            else if (t.pagador === 'eps') eps += pago;
            else afp += pago;
          }
          item.pagoEmpleador = r(empleador);
          item.porCobrarEps = r(eps);
          item.porCobrarAfp = r(afp);
        } else if (a.tipo === 'incapacidad_laboral') {
          item.porCobrarArl = r(baseIbcDia * dias);
        } else {
          item.porCobrarEps = r(baseIbcDia * dias); // licencias de maternidad / paternidad
        }
        item.pagoTotal = item.pagoEmpleador + item.porCobrarEps + item.porCobrarAfp + item.porCobrarArl;
      }
      lista.push(item);
    }

    lista.sort((x, y) => (x.desde < y.desde ? -1 : 1));
    for (let i = 1; i < lista.length; i++) {
      if (lista[i].desde <= lista[i - 1].hasta) {
        throw new Error(`Las ausencias "${lista[i - 1].nombre}" (${lista[i - 1].desde} a ${lista[i - 1].hasta}) y "${lista[i].nombre}" (${lista[i].desde} a ${lista[i].hasta}) se cruzan.`);
      }
    }
    return lista;
  }

  // --- Liquidación -----------------------------------------------------------------
  // entrada: {
  //   anio, mes,
  //   empresa:  { exoneraArt114 (por defecto true) },
  //   contrato: { fechaIngreso, fechaTerminacion?, salarioBase, tipoSalario ('ordinario'|'integral'),
  //               auxilioTransporte ('auto'|'si'|'no'), tipoAuxilio ('transporte'|'conectividad'),
  //               claseRiesgo (1-5), horasSemanales?, dependientes?, interesesVivienda?, medicinaPrepagada?,
  //               aporteVoluntarioPension?, aporteAfc?, retencionFuente ('calculada'|'no_aplica'|'manual'),
  //               retencionManual? },
  //   ausencias: [{ tipo, desde, hasta, diasPrevios?, valorDiario? }],
  //   conceptos: [{ codigo, cantidad? (horas), valor?, descripcion? }],   devengos
  //   descuentos: [{ codigo, valor, descripcion? }]
  // }
  function liquidarEmpleado(entrada) {
    const anio = Number(entrada.anio);
    const mes = Number(entrada.mes);
    if (!(anio >= 2000 && anio <= 2100) || !(mes >= 1 && mes <= 12)) throw new Error('Indica el año y el mes de la nómina.');
    const P = PL.parametros(anio);
    const T = P.tarifas;
    const L = P.limites;
    const advertencias = [];
    if (P.estimado) {
      advertencias.push(`No hay parámetros cargados para ${anio}; se usaron los de ${P.anioBase} (salario mínimo, auxilio y UVT). Actualízalos antes de liquidar.`);
    }

    const c = entrada.contrato || {};
    const empresa = entrada.empresa || {};
    const inicioMes = PL.texto(anio, mes, 1);
    const finMes = PL.texto(anio, mes, PL.diasDelMes(anio, mes));

    const salarioBase = num(c.salarioBase);
    if (!(salarioBase > 0)) throw new Error('El contrato no tiene salario.');
    if (!c.fechaIngreso) throw new Error('El contrato no tiene fecha de ingreso.');
    if (c.fechaIngreso > finMes) throw new Error('El empleado ingresó después de este mes.');
    if (c.fechaTerminacion && c.fechaTerminacion < inicioMes) throw new Error('El contrato terminó antes de este mes.');

    const integral = c.tipoSalario === 'integral';
    const factorIbc = integral ? L.factorIbcIntegral : 1;
    if (integral && salarioBase < L.salarioIntegralMinimoSmmlv * P.smmlv) {
      advertencias.push(`El salario integral debe ser mínimo 13 SMMLV (${r(L.salarioIntegralMinimoSmmlv * P.smmlv).toLocaleString('es-CO')}).`);
    }
    if (!integral && salarioBase < P.smmlv && !c.horasSemanales) {
      advertencias.push('El salario es menor al salario mínimo; revisa si es jornada parcial.');
    }

    const ventana = {
      desde: c.fechaIngreso > inicioMes ? c.fechaIngreso : inicioMes,
      hasta: c.fechaTerminacion && c.fechaTerminacion < finMes ? c.fechaTerminacion : finMes,
    };
    const diasContrato = PL.dias360(ventana.desde, ventana.hasta);
    const smmlvDia = P.smmlv / 30;
    const salarioDia = salarioBase / 30;
    const salarioIbcDia = (salarioBase * factorIbc) / 30;

    // --- Ausencias y días -------------------------------------------------------
    const ausencias = procesarAusencias(entrada.ausencias, ventana, { salarioDia, salarioIbcDia, smmlvDia, factorIbc });
    const diasDe = (f) => sumar(ausencias.filter(f), (a) => a.dias);
    const diasVac = diasDe((a) => a.tipo === 'vacaciones');
    const diasSln = diasDe((a) => !a.remunerada);
    const diasIncapLic = diasDe((a) => a.remunerada && a.tipo !== 'vacaciones');
    const diasAusentes = diasVac + diasSln + diasIncapLic;
    if (diasAusentes > diasContrato) throw new Error('Las ausencias suman más días que los del contrato en el mes.');
    const diasTrabajados = diasContrato - diasAusentes;

    // --- Devengos --------------------------------------------------------------
    const devengos = [];
    const agregar = (codigo, descripcion, valor, extra) => {
      if (!valor) return;
      devengos.push(Object.assign({ codigo, descripcion, valor: r(valor) }, extra || {}));
    };

    const sueldo = diasContrato === 30 && diasAusentes === 0 ? r(salarioBase) : r((salarioBase * diasTrabajados) / 30);
    agregar(integral ? 'salario_integral' : 'sueldo', integral ? 'Salario integral' : 'Sueldo', sueldo, { salarial: true, sufijo: integral ? '03' : '06', dias: diasTrabajados });

    const vacaciones = sumar(ausencias.filter((a) => a.tipo === 'vacaciones'), (a) => a.pagoTotal);
    const incapacidadesEmpleador = sumar(ausencias.filter((a) => a.tipo === 'incapacidad_general'), (a) => a.pagoEmpleador);
    const porCobrarEps = sumar(ausencias, (a) => a.porCobrarEps);
    const porCobrarAfp = sumar(ausencias, (a) => a.porCobrarAfp);
    const porCobrarArl = sumar(ausencias, (a) => a.porCobrarArl);
    const pagoIncapLic = incapacidadesEmpleador + porCobrarEps + porCobrarAfp + porCobrarArl;
    const pagoMaternidad = sumar(ausencias.filter((a) => a.tipo === 'licencia_maternidad'), (a) => a.pagoTotal);

    agregar('vacaciones', 'Vacaciones disfrutadas', vacaciones, { salarial: true, sufijo: '39', dias: diasVac });
    agregar('incapacidades', 'Incapacidades y licencias remuneradas', pagoIncapLic, { salarial: false, sufijo: '24', dias: diasIncapLic, ibcPropio: true });

    const horasMes = c.horasSemanales ? num(c.horasSemanales) * 5 : PL.horasMensuales(finMes);
    const valorHora = salarioBase / horasMes;
    const recargoFestivo = PL.recargoDominicalFestivo(finMes);
    for (const k of entrada.conceptos || []) {
      const def = PL.DEVENGOS[k.codigo];
      if (!def) throw new Error(`Concepto de devengo desconocido: "${k.codigo}".`);
      let valor;
      let detalle = k.descripcion || '';
      if (def.horas) {
        if (integral) {
          advertencias.push(`${def.nombre}: el salario integral ya remunera las horas extras y los recargos; no se liquidaron.`);
          continue;
        }
        const horas = num(k.cantidad);
        if (k.valor != null && k.valor !== '') valor = num(k.valor);
        else {
          const factor = def.base + (def.festivo ? recargoFestivo : 0);
          valor = horas * valorHora * factor;
        }
        if (horas && !detalle) detalle = `${horas} h`;
      } else {
        valor = num(k.valor);
      }
      if (!(valor > 0)) continue;
      agregar(k.codigo, def.nombre, valor, { salarial: def.salarial, extra: !!def.extra, sufijo: def.sufijo, detalle });
    }

    const salarialVariable = sumar(devengos.filter((d) => d.salarial && !['sueldo', 'salario_integral', 'vacaciones'].includes(d.codigo)), (d) => d.valor);
    const extrasYRecargos = sumar(devengos.filter((d) => d.extra), (d) => d.valor);
    const noSalarial = sumar(devengos.filter((d) => !d.salarial && !d.ibcPropio && !d.auxilio), (d) => d.valor);

    // Auxilio de transporte (o de conectividad): quien devenga hasta 2 SMMLV; solo por días trabajados.
    const tipoAuxilio = c.tipoAuxilio === 'conectividad' ? 'conectividad' : 'transporte';
    const modoAux = ['si', 'no'].includes(c.auxilioTransporte) ? c.auxilioTransporte : 'auto';
    const remuneracionMensual = salarioBase + salarialVariable;
    const topeAux = L.auxilioTransporteHastaSmmlv * P.smmlv;
    let conAuxilio = false;
    if (modoAux === 'si') {
      conAuxilio = true;
      if (remuneracionMensual > topeAux) advertencias.push('Se forzó el auxilio de transporte aunque el empleado devenga más de 2 SMMLV.');
    } else if (modoAux === 'auto') {
      conAuxilio = !integral && remuneracionMensual <= topeAux;
    }
    const auxilio = conAuxilio ? r((P.auxilioTransporte * diasTrabajados) / 30) : 0;
    agregar(tipoAuxilio === 'transporte' ? 'auxilio_transporte' : 'auxilio_conectividad',
      tipoAuxilio === 'transporte' ? 'Auxilio de transporte' : 'Auxilio de conectividad', auxilio, { salarial: false, sufijo: '27', auxilio: true, dias: diasTrabajados });

    const sumaDevengos = sumar(devengos, (d) => d.valor);
    const devengadoSalarial = sueldo + vacaciones + pagoIncapLic + salarialVariable;

    // --- IBC (base de aportes) --------------------------------------------------
    const sueldoIbc = r(sueldo * factorIbc);
    const vacacionesIbc = sumar(ausencias.filter((a) => a.tipo === 'vacaciones'), (a) => a.ibc);
    const ibcSalarial = sueldoIbc + vacacionesIbc + salarialVariable;
    const ibcIncapLic = sumar(ausencias.filter((a) => a.remunerada && a.tipo !== 'vacaciones'), (a) => a.ibc);
    const remuneracionTotal = devengadoSalarial + noSalarial; // sin auxilio de transporte
    const exceso40 = Math.max(0, r(noSalarial - L.limitePagosNoSalariales * remuneracionTotal));
    if (exceso40 > 0) advertencias.push(`Los pagos no salariales superan el 40 % de la remuneración: ${exceso40.toLocaleString('es-CO')} entran al IBC (Ley 1393 de 2010, art. 30).`);

    const diasCotizados = Math.min(30, diasContrato - diasSln);
    const ibcMin = (P.smmlv / 30) * diasCotizados * L.ibcMinimoSmmlv;
    const ibcMax = (P.smmlv / 30) * diasCotizados * L.ibcMaximoSmmlv;
    const ibcBruto = ibcSalarial + ibcIncapLic + exceso40;
    const ibc = diasCotizados > 0 ? r(entre(ibcBruto, r(ibcMin), r(ibcMax))) : 0;
    if (diasCotizados > 0 && ibcBruto < ibcMin) advertencias.push('El IBC quedó en el mínimo (1 SMMLV proporcional a los días).');
    if (diasCotizados > 0 && ibcBruto > ibcMax) advertencias.push('El IBC quedó en el tope de 25 SMMLV.');

    const diasArl = Math.min(30, diasTrabajados + diasVac);
    const ibcArl = diasArl > 0 ? r(entre(ibcSalarial + exceso40, r((P.smmlv / 30) * diasArl), r((P.smmlv / 30) * diasArl * L.ibcMaximoSmmlv))) : 0;
    const ibcParafiscales = diasArl > 0 ? r(ibcSalarial) : 0;
    const diasCcf = diasArl;

    // --- Aportes -----------------------------------------------------------------
    const ibcMensualizado = diasCotizados > 0 ? (ibc * 30) / diasCotizados : 0;
    const tarifaFsp = ibcMensualizado >= 4 * P.smmlv ? PL.tarifaFsp(ibcMensualizado, P.smmlv) : 0;
    const fspSolidaridad = tarifaFsp > 0 ? r(ibc * 0.01) : 0;
    const fspSubsistencia = tarifaFsp > 0 ? r(ibc * tarifaFsp) - fspSolidaridad : 0;

    const empleado = {
      salud: r(ibc * T.saludEmpleado),
      pension: r(ibc * T.pensionEmpleado),
      fspSolidaridad,
      fspSubsistencia,
    };
    empleado.fsp = empleado.fspSolidaridad + empleado.fspSubsistencia;
    empleado.total = empleado.salud + empleado.pension + empleado.fsp;

    const exoneradoEmpresa = empresa.exoneraArt114 !== false;
    const exonerado = exoneradoEmpresa && !integral && remuneracionMensual < L.exoneracionSmmlv * P.smmlv;
    const claseRiesgo = [1, 2, 3, 4, 5].includes(Number(c.claseRiesgo)) ? Number(c.claseRiesgo) : 1;
    const empleador = {
      salud: exonerado ? 0 : r(ibc * T.saludEmpleador),
      pension: r(ibc * T.pensionEmpleador),
      arl: r(ibcArl * T.arl[claseRiesgo]),
      caja: r(ibcParafiscales * T.cajaCompensacion),
      sena: exonerado ? 0 : r(ibcParafiscales * T.sena),
      icbf: exonerado ? 0 : r(ibcParafiscales * T.icbf),
    };
    empleador.total = empleador.salud + empleador.pension + empleador.arl + empleador.caja + empleador.sena + empleador.icbf;

    // --- Deducciones -------------------------------------------------------------
    const aporteVoluntario = r(c.aporteVoluntarioPension) + r(c.aporteAfc);
    const otrosDescuentos = [];
    for (const d of entrada.descuentos || []) {
      const def = PL.DESCUENTOS[d.codigo];
      if (!def) throw new Error(`Concepto de descuento desconocido: "${d.codigo}".`);
      const valor = r(d.valor);
      if (valor > 0) otrosDescuentos.push({ codigo: d.codigo, descripcion: def.nombre + (d.descripcion ? ` · ${d.descripcion}` : ''), valor, cuenta: def.cuenta });
    }

    // Retención en la fuente
    const modoRet = ['no_aplica', 'manual'].includes(c.retencionFuente) ? c.retencionFuente : 'calculada';
    const ingresosGravados = sumaDevengos - pagoMaternidad;
    let retencion = { valor: 0, modo: modoRet };
    if (modoRet === 'calculada') {
      retencion = Object.assign(
        calcularRetencion({
          anio,
          ingresos: ingresosGravados,
          aportesObligatorios: empleado.total,
          aporteVoluntario,
          interesesVivienda: c.interesesVivienda,
          medicinaPrepagada: c.medicinaPrepagada,
          dependientes: Number(c.dependientes) > 0,
        }),
        { modo: modoRet }
      );
    } else if (modoRet === 'manual') {
      retencion = { valor: r(c.retencionManual), modo: modoRet };
    }

    const deducciones = [];
    const ded = (codigo, descripcion, valor, cuenta) => {
      if (valor) deducciones.push({ codigo, descripcion, valor: r(valor), cuenta });
    };
    ded('salud_empleado', 'Aporte a salud (4 %)', empleado.salud, '237005');
    ded('pension_empleado', 'Aporte a pensión (4 %)', empleado.pension, '238030');
    ded('fsp_solidaridad', 'Fondo de solidaridad pensional', empleado.fspSolidaridad, '238030');
    ded('fsp_subsistencia', 'Fondo de subsistencia', empleado.fspSubsistencia, '238030');
    ded('retencion_fuente', 'Retención en la fuente', retencion.valor, '236505');
    ded('aporte_voluntario', 'Aporte voluntario a pensión / AFC', aporteVoluntario, '237045');
    for (const o of otrosDescuentos) ded(o.codigo, o.descripcion, o.valor, o.cuenta);

    const totalDeducciones = sumar(deducciones, (d) => d.valor);
    const neto = sumaDevengos - totalDeducciones;
    if (neto < 0) advertencias.push('Los descuentos superan lo devengado: el neto a pagar es negativo.');

    // --- Provisiones del mes ---------------------------------------------------------
    // Base de cesantías y prima: devengo salarial + auxilio de transporte.
    // Base de vacaciones: devengo salarial sin horas extras ni recargos de extras.
    const baseCesantias = devengadoSalarial + auxilio;
    const baseVacaciones = devengadoSalarial - extrasYRecargos;
    const provisiones = integral
      ? { cesantias: 0, intereses: 0, prima: 0, vacaciones: r(baseVacaciones / 24) }
      : {
          cesantias: r(baseCesantias / 12),
          intereses: r((baseCesantias / 12) * 0.12),
          prima: r(baseCesantias / 12),
          vacaciones: r(baseVacaciones / 24),
        };
    provisiones.total = provisiones.cesantias + provisiones.intereses + provisiones.prima + provisiones.vacaciones;
    provisiones.baseCesantias = r(baseCesantias);
    provisiones.baseVacaciones = r(baseVacaciones);

    // --- Datos para la planilla PILA --------------------------------------------------
    const novedades = ausencias.map((a) => ({ codigo: a.pila, tipo: a.tipo, desde: a.desde, hasta: a.hasta, dias: a.dias }));
    const ingreso = c.fechaIngreso >= inicioMes;
    const retiro = !!c.fechaTerminacion && c.fechaTerminacion <= finMes;
    if (ingreso) novedades.unshift({ codigo: 'ING', tipo: 'ingreso', desde: c.fechaIngreso, hasta: c.fechaIngreso, dias: 0 });
    if (retiro) novedades.push({ codigo: 'RET', tipo: 'retiro', desde: c.fechaTerminacion, hasta: c.fechaTerminacion, dias: 0 });

    const pila = {
      diasSalud: diasCotizados,
      diasPension: diasCotizados,
      diasArl,
      diasCcf,
      ibcSalud: ibc,
      ibcPension: ibc,
      ibcArl,
      ibcCcf: ibcParafiscales,
      claseRiesgo,
      tarifaArl: T.arl[claseRiesgo],
      exonerado,
      ingreso,
      retiro,
      novedades,
    };

    return {
      periodo: { anio, mes, inicio: inicioMes, fin: finMes },
      parametros: { smmlv: P.smmlv, auxilioTransporte: P.auxilioTransporte, uvt: P.uvt, estimado: P.estimado },
      dias: {
        contrato: diasContrato,
        trabajados: diasTrabajados,
        vacaciones: diasVac,
        incapacidadesYLicencias: diasIncapLic,
        noRemunerados: diasSln,
        cotizados: diasCotizados,
      },
      ausencias,
      devengos,
      totales: {
        sueldo,
        auxilio,
        vacaciones,
        incapacidadesYLicencias: pagoIncapLic,
        horasExtrasYRecargos: extrasYRecargos,
        variableSalarial: salarialVariable,
        noSalarial,
        devengadoSalarial,
        devengado: sumaDevengos,
        deducciones: totalDeducciones,
        neto,
      },
      incapacidades: {
        pagoEmpleador: incapacidadesEmpleador,
        porCobrarEps,
        porCobrarAfp,
        porCobrarArl,
        porCobrar: porCobrarEps + porCobrarAfp + porCobrarArl,
      },
      ibc: { total: ibc, bruto: r(ibcBruto), salarial: r(ibcSalarial), incapacidadesYLicencias: r(ibcIncapLic), exceso40, arl: ibcArl, parafiscales: ibcParafiscales },
      aportes: {
        empleado,
        empleador,
        fspTarifa: tarifaFsp,
        exonerado,
        totalSeguridadSocial: empleado.total + empleador.total,
      },
      retencion,
      deducciones,
      provisiones,
      pila,
      costoEmpleador: sumaDevengos + empleador.total + provisiones.total,
      advertencias,
    };
  }

  // --- Planilla de aportes (resumen tipo PILA) -------------------------------------
  // La PILA redondea el aporte de cada empleado al siguiente múltiplo de 100.
  const aMultiplo100 = (v) => (Math.ceil((Math.round(v) - 1e-9) / 100) * 100) || 0;

  // liquidaciones: [{ empleado:{...}, entidades:{eps,afp,arl,ccf}, liquidacion }]
  function resumenPlanilla(items) {
    const filas = [];
    const entidades = new Map();
    const sumaEn = (clave, nombre, tipo, concepto, valorLiquidado, valorPila) => {
      if (!valorLiquidado && !valorPila) return;
      const llave = `${tipo}|${clave || nombre}`;
      if (!entidades.has(llave)) entidades.set(llave, { tipo, entidad: nombre || '(sin asignar)', conceptos: {}, liquidado: 0, pila: 0, empleados: 0 });
      const e = entidades.get(llave);
      e.conceptos[concepto] = (e.conceptos[concepto] || 0) + valorLiquidado;
      e.liquidado += valorLiquidado;
      e.pila += valorPila;
      e.empleados += 1;
    };
    const totales = { liquidado: 0, pila: 0 };

    for (const it of items) {
      const L = it.liquidacion;
      const ent = it.entidades || {};
      const a = L.aportes;
      const p = L.pila;
      const saludLiq = a.empleado.salud + a.empleador.salud;
      const pensionLiq = a.empleado.pension + a.empleador.pension;
      const salud = aMultiplo100(a.empleado.salud) + aMultiplo100(a.empleador.salud);
      const pension = aMultiplo100(a.empleado.pension) + aMultiplo100(a.empleador.pension);
      const fsp = aMultiplo100(a.empleado.fspSolidaridad) + aMultiplo100(a.empleado.fspSubsistencia);
      const arl = aMultiplo100(a.empleador.arl);
      const caja = aMultiplo100(a.empleador.caja);
      const sena = aMultiplo100(a.empleador.sena);
      const icbf = aMultiplo100(a.empleador.icbf);

      sumaEn(ent.eps, ent.epsNombre, 'EPS', 'Salud', saludLiq, salud);
      sumaEn(ent.afp, ent.afpNombre, 'AFP', 'Pensión', pensionLiq, pension);
      sumaEn(ent.afp, ent.afpNombre, 'AFP', 'Fondo de solidaridad', a.empleado.fsp, fsp);
      sumaEn(ent.arl, ent.arlNombre, 'ARL', 'Riesgos laborales', a.empleador.arl, arl);
      sumaEn(ent.ccf, ent.ccfNombre, 'CCF', 'Caja de compensación', a.empleador.caja, caja);
      sumaEn('SENA', 'SENA', 'SENA', 'SENA', a.empleador.sena, sena);
      sumaEn('ICBF', 'ICBF', 'ICBF', 'ICBF', a.empleador.icbf, icbf);

      const liquidado = a.totalSeguridadSocial;
      const pilaTotal = salud + pension + fsp + arl + caja + sena + icbf;
      totales.liquidado += liquidado;
      totales.pila += pilaTotal;
      filas.push({
        empleadoId: it.empleado && it.empleado.id,
        nombre: it.empleado && it.empleado.nombre,
        identificacion: it.empleado && it.empleado.identificacion,
        diasSalud: p.diasSalud,
        diasPension: p.diasPension,
        diasArl: p.diasArl,
        diasCcf: p.diasCcf,
        ibc: p.ibcSalud,
        ibcArl: p.ibcArl,
        ibcCcf: p.ibcCcf,
        novedades: p.novedades.map((n) => n.codigo).join(', '),
        salud,
        pension,
        fsp,
        arl,
        caja,
        sena,
        icbf,
        liquidado,
        pila: pilaTotal,
        exonerado: p.exonerado,
      });
    }

    const porEntidad = Array.from(entidades.values()).sort((x, y) => (x.tipo < y.tipo ? -1 : x.tipo > y.tipo ? 1 : x.entidad < y.entidad ? -1 : 1));
    return {
      filas,
      porEntidad,
      totales: Object.assign(totales, { ajusteAproximacion: totales.pila - totales.liquidado }),
    };
  }

  return { liquidarEmpleado, calcularRetencion, resumenPlanilla, tramoIncapacidad, aMultiplo100 };
});
