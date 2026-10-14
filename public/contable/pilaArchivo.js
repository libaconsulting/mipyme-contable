// Archivo plano de la PILA (planilla integrada de liquidación de aportes): ARCHIVO TIPO 2
// del Anexo Técnico 2 (Resolución 2388 de 2016, versión 09 de 16-09-2019, UGPP/Minsalud).
//
// Función pura (sin base de datos ni DOM), compartida entre navegador y servidor.
//
// Estructura (texto de ancho fijo, una línea por registro, saltos de línea CRLF):
//   · Registro tipo 1 (encabezado): UNO por archivo, 359 posiciones.
//   · Registro tipo 2 (liquidación detallada): uno por cotizante (varios si en el mes hay
//     novedades que cambian el IBC: vacaciones, incapacidades, licencias), 686 posiciones.
// Campos numéricos (N): justificados a la derecha con ceros. Alfanuméricos (A): a la izquierda
// con espacios. Tarifas: decimales con punto (0.16000).
//
// Alcance: planilla tipo E (empleados de un solo aportante), cotizante tipo 01 (dependiente),
// subtipo 0, forma de presentación U (única), modalidad electrónica. Los campos que genera el
// operador (número de radicación, fecha de pago, secuencia del encabezado, código del operador)
// se dejan en ceros/blanco. NO se probó contra un operador real: ver README.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) {
    module.exports = fabrica(require('./parametrosLaborales'), require('./liquidacionNomina'));
  } else raiz.pilaArchivo = fabrica(raiz.parametrosLaborales, raiz.liquidacionNomina);
})(typeof self !== 'undefined' ? self : this, function (PL, LN) {
  const x100 = LN.aMultiplo100;
  const T = PL.TARIFAS;

  // --- Definición de campos ---------------------------------------------------------
  // t: 'N' numérico entero, 'A' alfanumérico, 'R' tarifa (decimales con punto).
  const campo = (n, l, t, nombre) => ({ n, l, t, nombre });
  const ENCABEZADO = [
    campo(1, 2, 'N', 'tipoRegistro'), campo(2, 1, 'N', 'modalidad'), campo(3, 4, 'N', 'secuencia'),
    campo(4, 200, 'A', 'razonSocial'), campo(5, 2, 'A', 'tipoDocAportante'), campo(6, 16, 'A', 'nit'), campo(7, 1, 'N', 'dv'),
    campo(8, 1, 'A', 'tipoPlanilla'), campo(9, 10, 'A', 'planillaAsociada'), campo(10, 10, 'A', 'fechaPlanillaAsociada'),
    campo(11, 1, 'A', 'formaPresentacion'), campo(12, 10, 'A', 'codigoSucursal'), campo(13, 40, 'A', 'nombreSucursal'),
    campo(14, 6, 'A', 'codigoArl'), campo(15, 7, 'A', 'periodoOtros'), campo(16, 7, 'A', 'periodoSalud'),
    campo(17, 10, 'N', 'radicacion'), campo(18, 10, 'A', 'fechaPago'), campo(19, 5, 'N', 'totalCotizantes'),
    campo(20, 12, 'N', 'valorNomina'), campo(21, 2, 'N', 'tipoAportante'), campo(22, 2, 'N', 'codigoOperador'),
  ];

  const COTIZANTE = [
    campo(1, 2, 'N', 'tipoRegistro'), campo(2, 5, 'N', 'secuencia'), campo(3, 2, 'A', 'tipoDocumento'), campo(4, 16, 'A', 'identificacion'),
    campo(5, 2, 'N', 'tipoCotizante'), campo(6, 2, 'N', 'subtipo'), campo(7, 1, 'A', 'extranjeroNoPension'), campo(8, 1, 'A', 'colombianoExterior'),
    campo(9, 2, 'A', 'departamento'), campo(10, 3, 'A', 'municipio'),
    campo(11, 20, 'A', 'primerApellido'), campo(12, 30, 'A', 'segundoApellido'), campo(13, 20, 'A', 'primerNombre'), campo(14, 30, 'A', 'segundoNombre'),
    campo(15, 1, 'A', 'ing'), campo(16, 1, 'A', 'ret'), campo(17, 1, 'A', 'tde'), campo(18, 1, 'A', 'tae'), campo(19, 1, 'A', 'tdp'), campo(20, 1, 'A', 'tap'),
    campo(21, 1, 'A', 'vsp'), campo(22, 1, 'A', 'correcciones'), campo(23, 1, 'A', 'vst'), campo(24, 1, 'A', 'sln'), campo(25, 1, 'A', 'ige'),
    campo(26, 1, 'A', 'lma'), campo(27, 1, 'A', 'vac'), campo(28, 1, 'A', 'avp'), campo(29, 1, 'A', 'vct'), campo(30, 2, 'N', 'diasIrl'),
    campo(31, 6, 'A', 'codigoAfp'), campo(32, 6, 'A', 'codigoAfpDestino'), campo(33, 6, 'A', 'codigoEps'), campo(34, 6, 'A', 'codigoEpsDestino'), campo(35, 6, 'A', 'codigoCcf'),
    campo(36, 2, 'N', 'diasPension'), campo(37, 2, 'N', 'diasSalud'), campo(38, 2, 'N', 'diasArl'), campo(39, 2, 'N', 'diasCcf'),
    campo(40, 9, 'N', 'salarioBasico'), campo(41, 1, 'A', 'salarioIntegral'),
    campo(42, 9, 'N', 'ibcPension'), campo(43, 9, 'N', 'ibcSalud'), campo(44, 9, 'N', 'ibcArl'), campo(45, 9, 'N', 'ibcCcf'),
    campo(46, 7, 'R', 'tarifaPension'), campo(47, 9, 'N', 'cotizacionPension'), campo(48, 9, 'N', 'voluntarioAfiliado'), campo(49, 9, 'N', 'voluntarioAportante'),
    campo(50, 9, 'N', 'totalPension'), campo(51, 9, 'N', 'fspSolidaridad'), campo(52, 9, 'N', 'fspSubsistencia'), campo(53, 9, 'N', 'valorNoRetenido'),
    campo(54, 7, 'R', 'tarifaSalud'), campo(55, 9, 'N', 'cotizacionSalud'), campo(56, 9, 'N', 'upcAdicional'),
    campo(57, 15, 'A', 'autorizacionIge'), campo(58, 9, 'N', 'valorIge'), campo(59, 15, 'A', 'autorizacionLma'), campo(60, 9, 'N', 'valorLma'),
    campo(61, 9, 'R', 'tarifaArl'), campo(62, 9, 'N', 'centroTrabajo'), campo(63, 9, 'N', 'cotizacionArl'),
    campo(64, 7, 'R', 'tarifaCcf'), campo(65, 9, 'N', 'valorCcf'), campo(66, 7, 'R', 'tarifaSena'), campo(67, 9, 'N', 'valorSena'),
    campo(68, 7, 'R', 'tarifaIcbf'), campo(69, 9, 'N', 'valorIcbf'), campo(70, 7, 'R', 'tarifaEsap'), campo(71, 9, 'N', 'valorEsap'),
    campo(72, 7, 'R', 'tarifaMen'), campo(73, 9, 'N', 'valorMen'),
    campo(74, 2, 'A', 'tipoDocPrincipal'), campo(75, 16, 'A', 'identificacionPrincipal'), campo(76, 1, 'A', 'exonerado'),
    campo(77, 6, 'A', 'codigoArl'), campo(78, 1, 'A', 'claseRiesgo'), campo(79, 1, 'A', 'tarifaEspecialPension'),
    campo(80, 10, 'A', 'fechaIngreso'), campo(81, 10, 'A', 'fechaRetiro'), campo(82, 10, 'A', 'fechaVspInicio'),
    campo(83, 10, 'A', 'fechaSlnInicio'), campo(84, 10, 'A', 'fechaSlnFin'), campo(85, 10, 'A', 'fechaIgeInicio'), campo(86, 10, 'A', 'fechaIgeFin'),
    campo(87, 10, 'A', 'fechaLmaInicio'), campo(88, 10, 'A', 'fechaLmaFin'), campo(89, 10, 'A', 'fechaVacInicio'), campo(90, 10, 'A', 'fechaVacFin'),
    campo(91, 10, 'A', 'fechaVctInicio'), campo(92, 10, 'A', 'fechaVctFin'), campo(93, 10, 'A', 'fechaIrlInicio'), campo(94, 10, 'A', 'fechaIrlFin'),
    campo(95, 9, 'N', 'ibcOtrosParafiscales'), campo(96, 3, 'N', 'horasLaboradas'), campo(97, 10, 'A', 'fechaExterior'),
  ];
  const LONGITUD_ENCABEZADO = ENCABEZADO.reduce((s, c) => s + c.l, 0);
  const LONGITUD_COTIZANTE = COTIZANTE.reduce((s, c) => s + c.l, 0);

  const TIPOS_DOCUMENTO = ['CC', 'CE', 'TI', 'PA', 'CD', 'SC', 'PE', 'RC'];
  const DOCUMENTOS_ALFANUMERICOS = ['PA', 'CD'];

  // --- Formato de un campo ------------------------------------------------------------
  function formatear(def, valor) {
    const l = def.l;
    if (def.t === 'A') {
      const t = valor == null ? '' : String(valor);
      if (t.length > l) throw new Error(`El campo ${def.n} (${def.nombre}) admite ${l} caracteres y llegó "${t}".`);
      return t.padEnd(l, ' ');
    }
    if (def.t === 'R') {
      const dec = l - 2; // "0." + decimales
      const n = Number(valor || 0);
      if (!(n >= 0) || n >= 1) throw new Error(`El campo ${def.n} (${def.nombre}) es una tarifa entre 0 y 1 y llegó "${valor}".`);
      const t = n.toFixed(dec);
      if (t.length !== l) throw new Error(`El campo ${def.n} (${def.nombre}) no cabe en ${l} posiciones: "${t}".`);
      return t;
    }
    const n = Math.round(Number(valor || 0));
    if (!Number.isFinite(n) || n < 0) throw new Error(`El campo ${def.n} (${def.nombre}) debe ser un número positivo y llegó "${valor}".`);
    const t = String(n);
    if (t.length > l) throw new Error(`El campo ${def.n} (${def.nombre}) admite ${l} dígitos y llegó ${t}.`);
    return t.padStart(l, '0');
  }

  function armarLinea(defs, valores, longitud, nombre) {
    const linea = defs.map((d) => formatear(d, valores[d.nombre])).join('');
    if (linea.length !== longitud) throw new Error(`El registro ${nombre} quedó de ${linea.length} posiciones y debe tener ${longitud}.`);
    return linea;
  }

  const registroEncabezado = (v) => armarLinea(ENCABEZADO, v, LONGITUD_ENCABEZADO, 'tipo 1');
  const registroCotizante = (v) => armarLinea(COTIZANTE, v, LONGITUD_COTIZANTE, 'tipo 2');

  // --- Utilidades ----------------------------------------------------------------------
  // Texto de nombres: mayúsculas, sin tildes ni caracteres especiales (la Ñ pasa a N).
  function limpiarNombre(t) {
    return String(t || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // De tres palabras: 1 nombre y 2 apellidos; de cuatro o más: 2 nombres y el resto apellidos.
  function partirNombre(nombre) {
    const p = limpiarNombre(nombre).split(' ').filter(Boolean);
    if (p.length >= 4) return { n1: p[0], n2: p[1], a1: p[2], a2: p.slice(3).join(' ') };
    if (p.length === 3) return { n1: p[0], n2: '', a1: p[1], a2: p[2] };
    if (p.length === 2) return { n1: p[0], n2: '', a1: p[1], a2: '' };
    return { n1: p[0] || '', n2: '', a1: '', a2: '' };
  }

  // Dígito de verificación del NIT (algoritmo de la DIAN).
  function digitoVerificacion(nit) {
    const d = String(nit).replace(/\D/g, '');
    if (!d || d.length > 15) return null;
    const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
    let s = 0;
    for (let i = 0; i < d.length; i++) s += Number(d[d.length - 1 - i]) * pesos[i];
    const m = s % 11;
    return m > 1 ? 11 - m : m;
  }

  // "900123456-1" -> { numero: '900123456', dv: 1 } (si no trae dígito, se calcula).
  function separarNit(nit) {
    const t = String(nit || '').trim();
    const m = /^([\d.\s]+)-\s*(\d)$/.exec(t);
    const numero = (m ? m[1] : t).replace(/\D/g, '');
    const calculado = digitoVerificacion(numero);
    return { numero, dv: m ? Number(m[2]) : calculado, calculado, informado: !!m };
  }

  const mesSiguiente = (anio, mes) => (mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, '0')}`);
  const periodoTexto = (anio, mes) => `${anio}-${String(mes).padStart(2, '0')}`;
  const limpiarCodigo = (c) => String(c || '').trim().toUpperCase();
  const documentoLimpio = (id) => String(id || '').replace(/[\s.\-]/g, '').toUpperCase();

  // --- Líneas (registros tipo 2) de un empleado -------------------------------------------
  // Si el mes no tiene novedades que cambien el IBC, es UNA línea. Si tiene vacaciones,
  // incapacidades, licencias o suspensiones, el anexo pide una línea por novedad y otra con los
  // días ordinarios: el IBC y los aportes se reparten entre ellas y lo que sobre por redondeo se
  // le deja a la línea ordinaria, de modo que el total del empleado sea el mismo de la planilla.
  const CODIGOS_SEGMENTO = ['VAC', 'IGE', 'LMA', 'IRL', 'SLN'];

  function lineasDeEmpleado(e, ctx) {
    const L = e.liquidacion;
    const p = L.pila;
    const ap = L.aportes;
    const avisos = [];
    const exonerado = !!p.exonerado;
    const tarifa = {
      pension: T.pensionEmpleado + T.pensionEmpleador,
      salud: exonerado ? T.saludEmpleado : T.saludEmpleado + T.saludEmpleador,
      arl: p.tarifaArl,
      ccf: T.cajaCompensacion,
      sena: exonerado ? 0 : T.sena,
      icbf: exonerado ? 0 : T.icbf,
    };
    const total = {
      pension: x100(ap.empleado.pension) + x100(ap.empleador.pension),
      salud: x100(ap.empleado.salud) + x100(ap.empleador.salud),
      arl: x100(ap.empleador.arl),
      ccf: x100(ap.empleador.caja),
      sena: x100(ap.empleador.sena),
      icbf: x100(ap.empleador.icbf),
      fspSolidaridad: x100(ap.empleado.fspSolidaridad),
      fspSubsistencia: x100(ap.empleado.fspSubsistencia),
    };
    const nombre = partirNombre(e.nombre);
    const ing = p.novedades.find((n) => n.codigo === 'ING');
    const ret = p.novedades.find((n) => n.codigo === 'RET');
    const ausencias = (L.ausencias || []).filter((a) => CODIGOS_SEGMENTO.includes(a.pila));

    // Segmentos: cada uno con sus días e IBC por sistema.
    const segmentos = [];
    const sumaIbc = (cods) => ausencias.filter((a) => cods.includes(a.pila)).reduce((s, a) => s + a.ibc, 0);
    const diasOrdinarios = L.dias.trabajados;
    if (!ausencias.length) {
      segmentos.push({
        ord: true, diasPension: p.diasPension, diasSalud: p.diasSalud, diasArl: p.diasArl, diasCcf: p.diasCcf,
        ibcPension: p.ibcPension, ibcSalud: p.ibcSalud, ibcArl: p.ibcArl, ibcCcf: p.ibcCcf,
      });
    } else {
      const ibcVac = sumaIbc(['VAC']);
      const ibcNoOrd = sumaIbc(['VAC', 'IGE', 'LMA', 'IRL']);
      for (const a of ausencias) {
        const s = { ord: false, codigo: a.pila, desde: a.desde, hasta: a.hasta, dias: a.dias };
        if (a.pila === 'VAC') {
          Object.assign(s, { diasPension: a.dias, diasSalud: a.dias, diasArl: a.dias, diasCcf: a.dias, ibcPension: a.ibc, ibcSalud: a.ibc, ibcArl: a.ibc, ibcCcf: a.ibc });
        } else if (a.pila === 'IGE' || a.pila === 'LMA') {
          Object.assign(s, { diasPension: a.dias, diasSalud: a.dias, diasArl: a.dias, diasCcf: 0, ibcPension: a.ibc, ibcSalud: a.ibc, ibcArl: 0, ibcCcf: 0 });
        } else if (a.pila === 'IRL') {
          Object.assign(s, { diasPension: a.dias, diasSalud: a.dias, diasArl: a.dias, diasCcf: 0, ibcPension: a.ibc, ibcSalud: a.ibc, ibcArl: 0, ibcCcf: 0 });
        } else { // SLN: el módulo no liquida aportes por estos días
          Object.assign(s, { diasPension: a.dias, diasSalud: a.dias, diasArl: a.dias, diasCcf: a.dias, ibcPension: 0, ibcSalud: 0, ibcArl: 0, ibcCcf: 0 });
          avisos.push(`${e.nombre}: tiene días de suspensión o licencia no remunerada (SLN). Se reportan con IBC 0; confirma con tu contador si debes cotizar pensión por esos días.`);
        }
        segmentos.push(s);
      }
      if (diasOrdinarios > 0) {
        segmentos.push({
          ord: true,
          diasPension: diasOrdinarios, diasSalud: diasOrdinarios, diasArl: diasOrdinarios, diasCcf: diasOrdinarios,
          ibcPension: Math.max(0, p.ibcPension - ibcNoOrd), ibcSalud: Math.max(0, p.ibcSalud - ibcNoOrd),
          ibcArl: Math.max(0, p.ibcArl - ibcVac), ibcCcf: Math.max(0, p.ibcCcf - ibcVac),
        });
      }
    }

    // Aportes de cada segmento; el sobrante de redondeo se le deja al segmento ordinario (o al de mayor IBC).
    const receptor = segmentos.find((s) => s.ord) || segmentos.slice().sort((a, b) => b.ibcPension - a.ibcPension)[0];
    for (const s of segmentos) {
      s.pension = x100(s.ibcPension * tarifa.pension);
      s.salud = x100(s.ibcSalud * tarifa.salud);
      s.arl = x100(s.ibcArl * tarifa.arl);
      s.ccf = x100(s.ibcCcf * tarifa.ccf);
      s.sena = x100(s.ibcCcf * tarifa.sena);
      s.icbf = x100(s.ibcCcf * tarifa.icbf);
      s.fspSolidaridad = 0;
      s.fspSubsistencia = 0;
    }
    if (segmentos.length === 1) {
      Object.assign(segmentos[0], { pension: total.pension, salud: total.salud, arl: total.arl, ccf: total.ccf, sena: total.sena, icbf: total.icbf });
    } else {
      for (const k of ['pension', 'salud', 'arl', 'ccf', 'sena', 'icbf']) {
        const resto = total[k] - segmentos.reduce((s, x) => s + x[k], 0);
        receptor[k] += resto;
        if (receptor[k] < 0) { // no debería pasar; se reparte sin valores negativos
          const falta = -receptor[k];
          receptor[k] = 0;
          const otro = segmentos.find((x) => x !== receptor && x[k] >= falta);
          if (otro) otro[k] -= falta;
        }
      }
    }
    receptor.fspSolidaridad = total.fspSolidaridad;
    receptor.fspSubsistencia = total.fspSubsistencia;

    // Marcas de ingreso y retiro: en la línea ordinaria; si no hay, en la primera (ingreso) o la última (retiro).
    const ordinario = segmentos.find((x) => x.ord);
    const primero = ordinario || segmentos[0];
    const ultimo = ordinario || segmentos[segmentos.length - 1];

    const base = {
      tipoRegistro: 2,
      tipoDocumento: e.tipoDocumento || 'CC',
      identificacion: documentoLimpio(e.identificacion),
      tipoCotizante: 1,
      subtipo: 0,
      departamento: ctx.codigoDepartamento,
      municipio: ctx.codigoMunicipio,
      primerApellido: nombre.a1, segundoApellido: nombre.a2, primerNombre: nombre.n1, segundoNombre: nombre.n2,
      codigoAfp: limpiarCodigo(e.afpCodigo), codigoEps: limpiarCodigo(e.epsCodigo), codigoCcf: limpiarCodigo(ctx.ccfCodigo),
      salarioBasico: e.salarioBase,
      salarioIntegral: e.tipoSalario === 'integral' ? 'X' : '',
      tarifaPension: tarifa.pension, tarifaSalud: tarifa.salud, tarifaArl: tarifa.arl,
      centroTrabajo: ctx.centroTrabajo,
      tarifaCcf: tarifa.ccf, tarifaSena: tarifa.sena, tarifaIcbf: tarifa.icbf, tarifaEsap: 0, tarifaMen: 0,
      exonerado: exonerado ? 'S' : 'N',
      codigoArl: limpiarCodigo(ctx.arlCodigo),
      claseRiesgo: String(p.claseRiesgo),
      horasLaboradas: 0,
    };

    const lineas = segmentos.map((s) => {
      const v = Object.assign({}, base, {
        diasPension: s.diasPension, diasSalud: s.diasSalud, diasArl: s.diasArl, diasCcf: s.diasCcf,
        ibcPension: s.ibcPension, ibcSalud: s.ibcSalud, ibcArl: s.ibcArl, ibcCcf: s.ibcCcf, ibcOtrosParafiscales: s.ibcCcf,
        cotizacionPension: s.pension, totalPension: s.pension, fspSolidaridad: s.fspSolidaridad, fspSubsistencia: s.fspSubsistencia,
        cotizacionSalud: s.salud, cotizacionArl: s.arl, valorCcf: s.ccf, valorSena: s.sena, valorIcbf: s.icbf,
      });
      if (s === primero && ing) { v.ing = 'X'; v.fechaIngreso = ing.desde; }
      if (s === ultimo && ret) { v.ret = 'X'; v.fechaRetiro = ret.desde; }
      if (s.codigo === 'VAC') { v.vac = 'X'; v.fechaVacInicio = s.desde; v.fechaVacFin = s.hasta; }
      if (s.codigo === 'IGE') { v.ige = 'X'; v.fechaIgeInicio = s.desde; v.fechaIgeFin = s.hasta; }
      if (s.codigo === 'LMA') { v.lma = 'X'; v.fechaLmaInicio = s.desde; v.fechaLmaFin = s.hasta; }
      if (s.codigo === 'SLN') { v.sln = 'X'; v.fechaSlnInicio = s.desde; v.fechaSlnFin = s.hasta; }
      if (s.codigo === 'IRL') { v.diasIrl = s.dias; v.fechaIrlInicio = s.desde; v.fechaIrlFin = s.hasta; }
      return { valores: v, ordinario: !!s.ord };
    });

    const c = e.contrato || {};
    if (c.aporteVoluntarioPension > 0) avisos.push(`${e.nombre}: tiene aporte voluntario a pensión; este archivo no lo reporta (campos 48, 49 y novedad AVP). Agrégalo en el operador si aplica.`);
    return { lineas, avisos };
  }

  // --- Validaciones previas ------------------------------------------------------------------
  // Devuelve la lista de datos que faltan o están mal, para que el usuario los corrija antes de generar.
  function revisarDatos({ aportante, config, empleados }) {
    const f = [];
    if (!aportante.razonSocial) f.push('Falta la razón social de la empresa (Mi Empresa).');
    const nit = separarNit(aportante.nit);
    if (!nit.numero) f.push('Falta el NIT de la empresa (Mi Empresa).');
    else if (nit.informado && nit.calculado !== null && nit.dv !== nit.calculado) f.push(`El dígito de verificación del NIT (${nit.dv}) no coincide con el calculado (${nit.calculado}). Corrígelo en Mi Empresa.`);
    if (!/^\d{2}$/.test(String(config.codigoDepartamento || ''))) f.push('Falta el código DANE del departamento (2 dígitos, p. ej. 11 para Bogotá) en Nómina > Configuración.');
    if (!/^\d{3}$/.test(String(config.codigoMunicipio || ''))) f.push('Falta el código DANE del municipio (3 dígitos, p. ej. 001 para Bogotá) en Nómina > Configuración.');
    if (!limpiarCodigo(config.arlCodigo)) f.push('Falta el código de la ARL en Nómina > Configuración.');
    else if (limpiarCodigo(config.arlCodigo).length > 6) f.push('El código de la ARL admite máximo 6 caracteres.');
    if (!limpiarCodigo(config.ccfCodigo)) f.push('Falta el código de la caja de compensación en Nómina > Configuración.');
    else if (limpiarCodigo(config.ccfCodigo).length > 6) f.push('El código de la caja de compensación admite máximo 6 caracteres.');
    if (!empleados.length) f.push('La nómina no tiene empleados liquidados.');
    for (const e of empleados) {
      const quien = e.nombre || e.identificacion || 'Empleado';
      const td = e.tipoDocumento || 'CC';
      if (!TIPOS_DOCUMENTO.includes(td)) f.push(`${quien}: tipo de documento no válido (${td}).`);
      const id = documentoLimpio(e.identificacion);
      if (!id) f.push(`${quien}: falta la identificación.`);
      else if (id.length > 16) f.push(`${quien}: la identificación admite máximo 16 caracteres.`);
      else if (!DOCUMENTOS_ALFANUMERICOS.includes(td) && !/^\d+$/.test(id)) f.push(`${quien}: la identificación debe ser numérica para el tipo ${td}.`);
      const n = partirNombre(e.nombre);
      if (!n.n1 || !n.a1) f.push(`${quien}: la PILA exige primer nombre y primer apellido (escribe el nombre completo).`);
      if (n.a1.length > 20 || n.n1.length > 20 || n.n2.length > 30 || n.a2.length > 30) f.push(`${quien}: algún nombre o apellido supera el largo permitido.`);
      if (!limpiarCodigo(e.epsCodigo)) f.push(`${quien}: falta el código de la EPS en su contrato.`);
      else if (limpiarCodigo(e.epsCodigo).length > 6) f.push(`${quien}: el código de la EPS admite máximo 6 caracteres.`);
      if (!limpiarCodigo(e.afpCodigo)) f.push(`${quien}: falta el código del fondo de pensiones en su contrato.`);
      else if (limpiarCodigo(e.afpCodigo).length > 6) f.push(`${quien}: el código del fondo de pensiones admite máximo 6 caracteres.`);
    }
    return f;
  }

  // --- Archivo completo --------------------------------------------------------------------------
  // entrada: {
  //   aportante: { razonSocial, nit }, periodo: { anio, mes },
  //   config: { arlCodigo, ccfCodigo, codigoDepartamento, codigoMunicipio, centroTrabajo },
  //   empleados: [{ nombre, identificacion, tipoDocumento?, epsCodigo, afpCodigo, salarioBase, tipoSalario, contrato?, liquidacion }],
  //   opciones: { periodoSalud: 'siguiente' (por defecto, según el anexo) | 'mismo' }
  // }
  function construirArchivo(entrada) {
    const faltantes = revisarDatos(entrada);
    if (faltantes.length) {
      const err = new Error('Faltan datos para generar el archivo plano de la PILA:\n- ' + faltantes.join('\n- '));
      err.faltantes = faltantes;
      throw err;
    }
    const { aportante, periodo, config, empleados } = entrada;
    const opciones = entrada.opciones || {};
    const nit = separarNit(aportante.nit);
    const ctx = {
      codigoDepartamento: String(config.codigoDepartamento),
      codigoMunicipio: String(config.codigoMunicipio),
      centroTrabajo: Number(config.centroTrabajo) || 0,
      arlCodigo: config.arlCodigo,
      ccfCodigo: config.ccfCodigo,
    };
    const avisos = [];
    const lineas = [];
    for (const e of empleados) {
      const r = lineasDeEmpleado(e, ctx);
      lineas.push(...r.lineas);
      avisos.push(...r.avisos);
    }
    lineas.forEach((l, i) => { l.valores.secuencia = i + 1; });
    const cotizantes = new Set(empleados.map((e) => documentoLimpio(e.identificacion))).size;
    const valorNomina = lineas.reduce((s, l) => s + l.valores.ibcOtrosParafiscales, 0);
    const periodoOtros = periodoTexto(periodo.anio, periodo.mes);
    const periodoSalud = opciones.periodoSalud === 'mismo' ? periodoOtros : mesSiguiente(periodo.anio, periodo.mes);
    const encabezado = registroEncabezado({
      tipoRegistro: 1, modalidad: 1, secuencia: 1,
      razonSocial: limpiarNombre(aportante.razonSocial), tipoDocAportante: 'NI', nit: nit.numero, dv: nit.dv,
      tipoPlanilla: 'E', formaPresentacion: 'U', codigoArl: limpiarCodigo(config.arlCodigo),
      periodoOtros, periodoSalud, radicacion: 0, totalCotizantes: cotizantes, valorNomina, tipoAportante: 1, codigoOperador: 0,
    });
    const registros = lineas.map((l) => registroCotizante(l.valores));
    const suma = (k) => lineas.reduce((s, l) => s + (l.valores[k] || 0), 0);
    const totales = {
      pension: suma('cotizacionPension'), fsp: suma('fspSolidaridad') + suma('fspSubsistencia'), salud: suma('cotizacionSalud'),
      arl: suma('cotizacionArl'), ccf: suma('valorCcf'), sena: suma('valorSena'), icbf: suma('valorIcbf'),
    };
    totales.total = totales.pension + totales.fsp + totales.salud + totales.arl + totales.ccf + totales.sena + totales.icbf;
    return {
      nombre: `PILA-E-${periodoOtros}.txt`,
      contenido: [encabezado, ...registros].join('\r\n') + '\r\n',
      encabezado,
      registros,
      cotizantes,
      lineas: registros.length,
      periodoOtros,
      periodoSalud,
      valorNomina,
      totales,
      avisos,
    };
  }

  return {
    ENCABEZADO, COTIZANTE, LONGITUD_ENCABEZADO, LONGITUD_COTIZANTE, TIPOS_DOCUMENTO,
    formatear, registroEncabezado, registroCotizante, limpiarNombre, partirNombre, digitoVerificacion, separarNit,
    lineasDeEmpleado, revisarDatos, construirArchivo,
  };
});
