// Archivos de cargue masivo de Asopagos (operador de información de la PILA).
//
// Función pura (sin base de datos ni DOM), compartida entre navegador y servidor. Genera:
//   1) Cargue masivo de cotizantes (empleados y contratistas): las 41 columnas de la hoja «cargue_masivo»
//      del Modelo_Cargue_Masivo.xls de Asopagos.
//   2) Cargue masivo de novedades: una línea por novedad, campos separados por «;» (instructivo
//      «Cargue masivo de novedades»): ING, RET, VSP, VST, SLN, IGE, LMA, VAC, AVP, IRL, VCT y los cargues
//      de otros ingresos, IBC de parafiscales y actualización de salario / pagos no constitutivos.
//
// Los formatos están copiados de los documentos de Asopagos; los ejemplos del instructivo son las pruebas
// (tests/cargueAsopagos.test.js). Lo que el documento no define no se inventa: se avisa.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./pilaArchivo'));
  else raiz.cargueAsopagos = fabrica(raiz.pilaArchivo);
})(typeof self !== 'undefined' ? self : this, function (PILA) {
  const TIPOS_DOCUMENTO = ['CC', 'CE', 'TI', 'RC', 'PA', 'PE', 'PC', 'CD', 'SC', 'PT'];

  // --- Cargue de cotizantes ------------------------------------------------------------------------
  const COLUMNAS_COTIZANTE = [
    'Tipo de identificación', 'Número de identificación', 'Primer apellido', 'Segundo apellido', 'Primer nombre', 'Segundo nombre',
    'Tipo de cotizante', 'Subtipo de cotizante', 'Extranjero no obligado a cotizar pensiones ', 'Colombiano temporal en el exterior',
    'Tipo de Salario', 'Salario básico', 'Base de Cotización ', 'Otros ingresos para el IBC de parafiscales ',
    'Código de administradora de riesgos laborales', 'Código Centro de trabajo', 'Código Departamento de la ubicación laboral ',
    'Código de municipio de la ubicación laboral ', 'Acogido a exoneración en parafiscales ', 'Indicador de tarifa especial de pensión',
    'EPS', 'AFP', 'Caja de compensación', 'UPC adicional', 'Tipo de identificación del cotizante titular UPC',
    'Número de identificación del cotizante titular UPC', 'Tarifa pensión', 'Tarifa salud', 'Tarifa Sena', 'Tarifa Icbf',
    'Tarifa de Caja de compensación', 'Fecha de ingreso a laborar (aaaa-mm-dd)', 'Correo electrónico', 'Correo electrónico CC',
    'Días cotizados (Exclusivo para cotizante 51 o 76)', 'Pagos no constitutivos de salario (Ley 1393 de 2010)',
    'Indique código el soporte de pago de planilla', 'Fecha de radicación en el exterior (aaaa-mm-dd)',
    'Valor mesada pensional (solo si en el campo subtipo de cotizante relaciona los tipos 1, 2 y 9)', 'Actividad económica', 'Código Categoría',
  ];

  const entero = (n) => Math.max(0, Math.round(Number(n) || 0));
  const dos = (n) => String(n).padStart(2, '0');
  const soloAlfanumerico = (t) => String(t == null ? '' : t).replace(/[^0-9A-Za-z]/g, '');
  const soloDigitos = (t) => String(t == null ? '' : t).replace(/\D/g, '');
  // Tarifas con punto decimal y sin ceros sobrantes: 0.16, 0.125, 0.
  const tarifa = (t) => String(Math.round((Number(t) || 0) * 1e5) / 1e5);

  // Códigos de las listas de Asopagos vienen como «EPS005_SANITAS»: se toma lo que está antes del guion bajo.
  function codigoEntidad(t) {
    const x = String(t == null ? '' : t).trim();
    return x.includes('_') ? x.split('_')[0] : x;
  }

  // datos: { tipoDocumento, identificacion, nombre, tipoCotizante (1 | 59), subtipo, tipoSalario ('X' | 'F' | 'V' | ''),
  //   salarioBasico, baseCotizacion, codigoArl, centroTrabajo, departamento, municipio, exonerado (bool),
  //   epsCodigo, afpCodigo, ccfCodigo, tarifaPension, tarifaSalud, tarifaSena, tarifaIcbf, tarifaCcf, fechaIngreso,
  //   correo, actividadEconomica }
  // Devuelve { fila: [41 valores], avisos: [texto] }.
  function filaCotizante(d) {
    const avisos = [];
    const quien = `${d.nombre || d.identificacion || '(sin nombre)'}`;
    const aviso = (t) => avisos.push(`${quien}: ${t}`);
    const tipoDoc = String(d.tipoDocumento || 'CC').toUpperCase();
    if (!TIPOS_DOCUMENTO.includes(tipoDoc)) aviso(`el tipo de documento "${tipoDoc}" no es válido para Asopagos.`);
    const numero = soloAlfanumerico(d.identificacion).slice(0, 16);
    if (!numero) aviso('falta el número de identificación.');
    const n = PILA.partirNombre(d.nombre);
    if (!n.n1 || !n.a1) aviso('Asopagos exige primer nombre y primer apellido (escribe el nombre completo).');
    if (n.a1.length > 20 || n.n1.length > 20 || n.n2.length > 30 || n.a2.length > 30) aviso('algún nombre o apellido supera el largo permitido (20/30).');
    const tipoCot = Number(d.tipoCotizante) || 1;
    const salario = entero(d.salarioBasico);
    if (!salario) aviso('el salario básico es obligatorio y no puede ser 0.');
    if (String(salario).length > 9) aviso('el salario básico supera los 9 dígitos.');
    const arl = codigoEntidad(d.codigoArl);
    if (!arl) aviso('falta el código de la ARL (Nómina → Configuración).');
    const eps = codigoEntidad(d.epsCodigo);
    const afp = codigoEntidad(d.afpCodigo);
    if (!eps) aviso('falta el código de la EPS.');
    if (!afp) aviso('falta el código del fondo de pensiones.');
    const depto = soloDigitos(d.departamento).padStart(2, '0');
    const mpio = soloDigitos(d.municipio).padStart(3, '0');
    if (!soloDigitos(d.departamento) || !soloDigitos(d.municipio)) aviso('falta el departamento o el municipio de la ubicación laboral (Nómina → Configuración).');
    const actividad = soloDigitos(d.actividadEconomica);
    if (actividad.length !== 7) aviso('falta la actividad económica de 7 dígitos del centro de trabajo (Nómina → Configuración → Centros de trabajo).');
    const fecha = String(d.fechaIngreso || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) aviso('falta la fecha de ingreso (aaaa-mm-dd).');
    const correo = String(d.correo || '').trim();
    const fila = [
      tipoDoc, numero, n.a1, n.a2, n.n1, n.n2,
      tipoCot, Number(d.subtipo) || 0, 'N', 'N',
      d.tipoSalario || '', salario, d.baseCotizacion ? entero(d.baseCotizacion) : '', '',
      arl, soloDigitos(d.centroTrabajo) || 0, soloDigitos(d.departamento) ? depto : '', soloDigitos(d.municipio) ? mpio : '',
      d.exonerado ? 'S' : 'N', '',
      eps, afp, codigoEntidad(d.ccfCodigo) || 'SINCCF', '', '', '',
      tarifa(d.tarifaPension), tarifa(d.tarifaSalud), tarifa(d.tarifaSena), tarifa(d.tarifaIcbf), tarifa(d.tarifaCcf),
      fecha, correo.slice(0, 32), '', '', '', 0, '', '', actividad.length === 7 ? actividad : '', '',
    ];
    return { fila, avisos };
  }

  function celda(v) {
    const t = String(v == null ? '' : v);
    return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }

  // CSV con las 41 columnas en el orden del modelo (con la fila de títulos). Se abre en Excel y se pega en la
  // hoja «cargue_masivo» del Modelo_Cargue_Masivo.xls desde la fila 3.
  function cotizantesCsv(filas) {
    return '﻿' + [COLUMNAS_COTIZANTE, ...filas].map((f) => f.map(celda).join(';')).join('\r\n') + '\r\n';
  }

  // --- Novedades ------------------------------------------------------------------------------------
  const CODIGOS = { ING: 1, RET: 2, VSP: 7, VST: 9, SLN: 10, IGE: 11, LMA: 12, VAC: 13, AVP: 14, IRL: 15, VCT: 16, OIP: 17, IBC_PARAFISCALES: 19, SALARIO: 20, NO_SALARIAL: 21 };

  function cabecera(codigo, d) {
    const tipo = String(d.tipoDocumento || 'CC').toUpperCase();
    if (!TIPOS_DOCUMENTO.includes(tipo)) throw new Error(`Tipo de documento no válido: "${tipo}".`);
    const num = soloAlfanumerico(d.identificacion);
    if (!num || num.length > 16) throw new Error('El número de identificación es obligatorio (máximo 16 caracteres).');
    return [CODIGOS[codigo], tipo, num];
  }
  function periodo(d) {
    const a = Number(d.anio);
    const m = Number(d.mes);
    if (!(a >= 2000 && a <= 2100)) throw new Error('El año de la novedad debe tener 4 dígitos.');
    if (!(m >= 1 && m <= 12)) throw new Error('El mes de la novedad debe estar entre 1 y 12.');
    return [String(a), dos(m)];
  }
  function dia(d) {
    const n = Number(d.dia);
    const max = new Date(Date.UTC(Number(d.anio), Number(d.mes), 0)).getUTCDate();
    if (!(n >= 1 && n <= max)) throw new Error(`El día debe estar entre 1 y ${max}.`);
    return dos(n);
  }
  function fechaFinal(d) {
    const f = String(d.fechaFin || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw new Error('La fecha final debe tener el formato aaaa-mm-dd.');
    const ini = `${d.anio}-${dos(d.mes)}-${dia(d)}`;
    if (f < ini) throw new Error('La fecha final no puede ser anterior a la de inicio.');
    return f;
  }
  const valor9 = (n, nombre) => {
    const x = entero(n);
    if (String(x).length > 9) throw new Error(`${nombre} supera los 9 dígitos.`);
    return String(x);
  };
  const sn = (v) => (v === true || v === 'S' ? 'S' : 'N');
  const diasN = (d) => { const n = Math.round(Number(d.dias)); if (!(n >= 1)) throw new Error('Los días de la novedad deben ser 1 o más.'); return String(n); };
  const unir = (campos) => campos.join(';') + ';';

  const CONSTRUCTORES = {
    // Ingreso normal (X). Los ingresos solo a caja (C) o solo a riesgos (R) no están soportados: el ejemplo del instructivo es incoherente.
    ING(d) {
      return unir([...cabecera('ING', d), ...periodo(d), dia({ ...d, dia: d.dia }), valor9(d.salario, 'El salario'), 'X',
        valor9(d.centroTrabajo, 'El centro de trabajo'), '', '', '', '', d.tipoSalario || '',
        d.pagosNoSalariales ? valor9(d.pagosNoSalariales, 'Los pagos no salariales') : '', soloDigitos(d.actividadEconomica).slice(0, 7)]);
    },
    RET(d) {
      const tipo = String(d.tipoRetiro || 'N').toUpperCase();
      if (!['N', 'P', 'R', 'C'].includes(tipo)) throw new Error('El tipo de retiro debe ser N, P, R o C.');
      return unir([...cabecera('RET', d), ...periodo(d), dia(d), tipo]);
    },
    VSP(d) { return unir([...cabecera('VSP', d), ...periodo(d), dia(d), valor9(d.variacion, 'La variación')]); },
    VST(d) { return unir([...cabecera('VST', d), ...periodo(d), valor9(d.variacion, 'La variación')]); },
    SLN(d) {
      return unir([...cabecera('SLN', d), ...periodo(d), dia(d), fechaFinal(d), sn(d.comisionServicios), d.porcentajeAporte === 'E' ? 'E' : 'T',
        valor9(d.salarioAnterior, 'El salario anterior'), tarifa(d.tarifaSalud), tarifa(d.tarifaPension), diasN(d)]);
    },
    IGE(d) {
      const t = (v) => { const x = String(v == null || v === '' ? 1 : v); if (!['1', '0.6666', '0.5'].includes(x)) throw new Error('La tarifa de la incapacidad debe ser 1, 0.6666 o 0.5.'); return x; };
      const ajustar = sn(d.ajustar);
      return unir([...cabecera('IGE', d), ...periodo(d), dia(d), fechaFinal(d), t(d.tarifaDosPrimerosDias), t(d.tarifaDesdeTercerDia), ajustar,
        ajustar === 'S' ? valor9(d.valor, 'El valor de la novedad') : '0', diasN(d)]);
    },
    LMA(d) {
      const ajustar = sn(d.ajustar);
      const tipo = d.tipoLma === 'X' || d.tipoLma === 'P' ? d.tipoLma : '';
      return unir([...cabecera('LMA', d), ...periodo(d), dia(d), fechaFinal(d), diasN(d), ajustar, ajustar === 'S' ? valor9(d.valor, 'El valor de la novedad') : '0', tipo]);
    },
    VAC(d) {
      const tipo = d.tipoNovedad === 'L' ? 'L' : 'X';
      return unir([...cabecera('VAC', d), ...periodo(d), dia(d), fechaFinal(d), valor9(d.salario, 'El salario'), tipo, sn(d.pagoAnticipado), diasN(d)]);
    },
    AVP(d) {
      return unir([...cabecera('AVP', d), ...periodo(d), valor9(d.aporteAportante, 'El aporte del aportante'), valor9(d.aporteAfiliado, 'El aporte del afiliado'), valor9(d.valorNoRetenido, 'El valor no retenido')]);
    },
    IRL(d) {
      const ajustar = sn(d.ajustar);
      return unir([...cabecera('IRL', d), ...periodo(d), dia(d), fechaFinal(d), diasN(d), ajustar, ajustar === 'S' ? valor9(d.valor, 'El valor de la novedad') : '0']);
    },
    VCT(d) {
      const ac = soloDigitos(d.actividadEconomica);
      if (ac.length < 1 || ac.length > 7) throw new Error('El código de actividad económica es obligatorio (máximo 7 dígitos).');
      return unir([...cabecera('VCT', d), ...periodo(d), valor9(d.centroTrabajo, 'El centro de trabajo'), dia(d), d.fechaFin ? fechaFinal(d) : '', ac]);
    },
    OIP(d) { return unir([...cabecera('OIP', d), ...periodo(d), valor9(d.valor, 'El valor')]); },
    IBC_PARAFISCALES(d) { return unir([...cabecera('IBC_PARAFISCALES', d), ...periodo(d), valor9(d.ibc, 'El IBC')]); },
    SALARIO(d) { return unir([...cabecera('SALARIO', d), valor9(d.salario, 'El salario')]); },
    NO_SALARIAL(d) { return unir([...cabecera('NO_SALARIAL', d), ...periodo(d), valor9(d.valor, 'El valor')]); },
  };

  function lineaNovedad(codigo, datos) {
    const f = CONSTRUCTORES[codigo];
    if (!f) throw new Error(`Novedad desconocida: "${codigo}".`);
    return f(datos);
  }

  // Las novedades 20 (salario) no llevan año ni mes: el constructor de cabecera ya no los pide.
  function novedadesTxt(lineas) {
    return lineas.length ? lineas.join('\r\n') + '\r\n' : '';
  }

  return { COLUMNAS_COTIZANTE, CODIGOS, TIPOS_DOCUMENTO, codigoEntidad, filaCotizante, cotizantesCsv, lineaNovedad, novedadesTxt };
});
