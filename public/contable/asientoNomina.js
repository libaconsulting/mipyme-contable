// Asientos contables de la nómina: liquidación mensual, provisiones y pago.
//
// Igual que asientoCompra.js y asientoVenta.js: UN solo archivo que usan el
// navegador (vista previa antes de contabilizar) y el backend (el que se
// guarda), así lo que se revisa es lo que se contabiliza. Todo en pesos enteros.
//
// Asiento de la liquidación (todos los empleados del mes):
//   Db  5105xx / 5205xx  Gastos de personal (sueldos, extras, comisiones, auxilios…)
//   Db  5105xx / 5205xx  Aportes del empleador (salud, pensión, ARL, caja, SENA, ICBF)
//   Db  2525             Vacaciones consolidadas (vacaciones disfrutadas)
//   Db  138095           Incapacidades y licencias por cobrar a EPS / ARL / AFP
//   Cr  2505             Salarios por pagar (neto de cada empleado)
//   Cr  236505           Retención en la fuente por salarios (por empleado)
//   Cr  237005           Aportes a EPS (empleado + empleador)
//   Cr  238030           Fondos de pensiones (empleado + empleador + solidaridad)
//   Cr  237006           Aportes a ARL
//   Cr  237010           Aportes a caja, SENA e ICBF
//   Cr  1365 / 2370xx    Préstamos, libranzas, embargos y otros descuentos
//
// Asiento de provisiones: Db 5105xx30/33/36/39 · Cr 2510 / 2515 / 2520 / 2525.
// Asiento de pago:        Db 2505 (por empleado) · Cr banco o caja.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.asientoNomina = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const CUENTAS = {
    SALARIOS_POR_PAGAR: '2505',
    CESANTIAS: '2510',
    INTERESES_CESANTIAS: '2515',
    PRIMA: '2520',
    VACACIONES: '2525',
    RETENCION_SALARIOS: '236505',
    APORTES_EPS: '237005',
    APORTES_ARL: '237006',
    APORTES_PARAFISCALES: '237010',
    APORTES_PENSION: '238030',
    CUENTAS_POR_COBRAR_INCAPACIDADES: '138095',
    PRESTAMOS_EMPLEADOS: '1365',
  };

  // Subcuentas de gastos de personal (PUC: 5105 administración, 5205 ventas).
  const SUFIJOS_GASTO = {
    '03': 'Salario integral',
    '06': 'Sueldos',
    '15': 'Horas extras y recargos',
    '18': 'Comisiones',
    '24': 'Incapacidades',
    '27': 'Auxilio de transporte / conectividad',
    '30': 'Cesantías',
    '33': 'Intereses sobre cesantías',
    '36': 'Prima de servicios',
    '39': 'Vacaciones',
    '45': 'Auxilios',
    '48': 'Bonificaciones',
    '68': 'Aportes a ARL',
    '69': 'Aportes a EPS',
    '70': 'Aportes a fondos de pensiones',
    '72': 'Aportes a cajas de compensación familiar',
    '75': 'Aportes al ICBF',
    '78': 'Aportes al SENA',
    '95': 'Otros gastos de personal',
  };

  const PREFIJO_AREA = { administracion: '5105', ventas: '5205' };
  const AREAS = { administracion: 'Administración', ventas: 'Ventas' };

  // Cuentas que el módulo crea en el plan de la empresa la primera vez que las necesita.
  // `padre` es la cuenta de 4 dígitos de la que cuelga una subcuenta de 6.
  const cu = (codigo, nombre, naturaleza, elementoNiif, padre) => ({ codigo, nombre, naturaleza, elementoNiif, padre: padre || null });
  const CATALOGO = [
    // Activo
    cu('1365', 'Cuentas por cobrar a trabajadores', 'debito', 'activo'),
    cu('1380', 'Deudores varios', 'debito', 'activo'),
    cu('138095', 'Incapacidades y licencias por cobrar (EPS, ARL, AFP)', 'debito', 'activo', '1380'),
    // Pasivo
    cu('2365', 'Retención en la fuente por pagar', 'credito', 'pasivo'),
    cu('236505', 'Retención en la fuente: salarios y pagos laborales', 'credito', 'pasivo', '2365'),
    cu('2370', 'Retenciones y aportes de nómina por pagar', 'credito', 'pasivo'),
    cu('237005', 'Aportes a EPS por pagar', 'credito', 'pasivo', '2370'),
    cu('237006', 'Aportes a ARL por pagar', 'credito', 'pasivo', '2370'),
    cu('237010', 'Aportes a caja de compensación, SENA e ICBF por pagar', 'credito', 'pasivo', '2370'),
    cu('237025', 'Embargos judiciales por pagar', 'credito', 'pasivo', '2370'),
    cu('237030', 'Libranzas por pagar', 'credito', 'pasivo', '2370'),
    cu('237045', 'Aportes voluntarios (fondos, AFC) por pagar', 'credito', 'pasivo', '2370'),
    cu('237095', 'Otros descuentos de nómina por pagar', 'credito', 'pasivo', '2370'),
    cu('2380', 'Acreedores varios', 'credito', 'pasivo'),
    cu('238030', 'Fondos de pensiones por pagar', 'credito', 'pasivo', '2380'),
    cu('2505', 'Salarios por pagar', 'credito', 'pasivo'),
    cu('2510', 'Cesantías consolidadas', 'credito', 'pasivo'),
    cu('2515', 'Intereses sobre cesantías', 'credito', 'pasivo'),
    cu('2520', 'Prima de servicios', 'credito', 'pasivo'),
    cu('2525', 'Vacaciones consolidadas', 'credito', 'pasivo'),
  ];
  for (const [prefijo, area] of Object.entries({ 5105: 'Gastos de personal', 5205: 'Gastos de personal (ventas)' })) {
    CATALOGO.push(cu(prefijo, area, 'debito', 'gasto'));
    for (const [sufijo, nombre] of Object.entries(SUFIJOS_GASTO)) {
      CATALOGO.push(cu(prefijo + sufijo, nombre + (prefijo === '5205' ? ' (ventas)' : ''), 'debito', 'gasto', prefijo));
    }
  }

  const cuentaGasto = (area, sufijo) => (PREFIJO_AREA[area] || PREFIJO_AREA.administracion) + sufijo;
  const pesos = (n) => Math.round(Number(n) || 0);

  // Acumulador de líneas: suma lo que cae en la misma cuenta (y el mismo tercero).
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
        // Una cuenta que recibe débito y crédito en el mismo asiento queda por su saldo.
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

  // items: [{ terceroId, area, liquidacion }]
  function armarAsientoLiquidacion(items) {
    const a = acumulador();
    for (const it of items || []) {
      const L = it.liquidacion;
      const t = it.terceroId;
      const area = it.area;
      if (L.totales.neto < 0) throw new Error('Hay un empleado con neto a pagar negativo; ajusta los descuentos antes de contabilizar.');

      for (const d of L.devengos) {
        if (d.codigo === 'vacaciones') {
          a.poner(CUENTAS.VACACIONES, d.valor, 0, t);
        } else if (d.codigo === 'incapacidades') {
          a.poner(cuentaGasto(area, '24'), L.incapacidades.pagoEmpleador, 0);
          a.poner(CUENTAS.CUENTAS_POR_COBRAR_INCAPACIDADES, L.incapacidades.porCobrar, 0, t);
        } else {
          a.poner(cuentaGasto(area, d.sufijo || '95'), d.valor, 0);
        }
      }

      const ap = L.aportes.empleador;
      a.poner(cuentaGasto(area, '69'), ap.salud, 0);
      a.poner(cuentaGasto(area, '70'), ap.pension, 0);
      a.poner(cuentaGasto(area, '68'), ap.arl, 0);
      a.poner(cuentaGasto(area, '72'), ap.caja, 0);
      a.poner(cuentaGasto(area, '78'), ap.sena, 0);
      a.poner(cuentaGasto(area, '75'), ap.icbf, 0);

      a.poner(CUENTAS.SALARIOS_POR_PAGAR, 0, L.totales.neto, t);
      for (const d of L.deducciones) {
        // Los aportes van a la entidad (sin tercero); lo demás queda a nombre del empleado.
        const porEntidad = d.cuenta === CUENTAS.APORTES_EPS || d.cuenta === CUENTAS.APORTES_PENSION;
        a.poner(d.cuenta, 0, d.valor, porEntidad ? undefined : t);
      }
      a.poner(CUENTAS.APORTES_EPS, 0, ap.salud);
      a.poner(CUENTAS.APORTES_PENSION, 0, ap.pension);
      a.poner(CUENTAS.APORTES_ARL, 0, ap.arl);
      a.poner(CUENTAS.APORTES_PARAFISCALES, 0, ap.caja + ap.sena + ap.icbf);
    }
    return a.resultado();
  }

  function armarAsientoProvisiones(items) {
    const a = acumulador();
    for (const it of items || []) {
      const p = it.liquidacion.provisiones;
      const t = it.terceroId;
      a.poner(cuentaGasto(it.area, '30'), p.cesantias, 0);
      a.poner(cuentaGasto(it.area, '33'), p.intereses, 0);
      a.poner(cuentaGasto(it.area, '36'), p.prima, 0);
      a.poner(cuentaGasto(it.area, '39'), p.vacaciones, 0);
      a.poner(CUENTAS.CESANTIAS, 0, p.cesantias, t);
      a.poner(CUENTAS.INTERESES_CESANTIAS, 0, p.intereses, t);
      a.poner(CUENTAS.PRIMA, 0, p.prima, t);
      a.poner(CUENTAS.VACACIONES, 0, p.vacaciones, t);
    }
    return a.resultado();
  }

  // pagos: [{ terceroId, valor }]  ·  cuentaPagoCodigo: auxiliar del banco o caja
  function armarAsientoPago(pagos, cuentaPagoCodigo) {
    const a = acumulador();
    for (const p of pagos || []) {
      a.poner(CUENTAS.SALARIOS_POR_PAGAR, p.valor, 0, p.terceroId);
      a.poner(cuentaPagoCodigo, 0, p.valor);
    }
    return a.resultado();
  }

  return { CUENTAS, CATALOGO, SUFIJOS_GASTO, AREAS, PREFIJO_AREA, cuentaGasto, armarAsientoLiquidacion, armarAsientoProvisiones, armarAsientoPago };
});
