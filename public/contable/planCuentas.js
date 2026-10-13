// Reglas del plan de cuentas y catálogo simplificado de cuentas comunes.
//
// UN solo archivo que usan el navegador (para mostrar al instante de qué tipo
// es una cuenta mientras se escribe el código) y el backend (que valida de
// verdad). No depende de Node ni del DOM.
//
// Referencia: códigos del PUC (Decreto 2650 de 1993). El marco NIIF para
// Grupo 3 (Decreto 2420 de 2015, Anexo 3) no obliga a usar ese PUC, pero es el
// que reconocen contadores, bancos y la DIAN en sus formatos, y usar sus
// códigos evita tener que re-mapear cuentas cuando haya que reportar
// (información exógena, conciliaciones, estados financieros).
//
// Este catálogo es una guía, no asesoría contable: la cuenta que corresponde
// a cada gasto depende de la actividad de la empresa; confírmala con el contador.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.planCuentas = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  // Primer dígito del código -> tipo de cuenta
  const CLASES = {
    1: { nombre: 'Activo', naturaleza: 'debito', elementoNiif: 'activo' },
    2: { nombre: 'Pasivo', naturaleza: 'credito', elementoNiif: 'pasivo' },
    3: { nombre: 'Patrimonio', naturaleza: 'credito', elementoNiif: 'patrimonio' },
    4: { nombre: 'Ingreso', naturaleza: 'credito', elementoNiif: 'ingreso' },
    5: { nombre: 'Gasto', naturaleza: 'debito', elementoNiif: 'gasto' },
    6: { nombre: 'Costo de ventas', naturaleza: 'debito', elementoNiif: 'costo' },
    7: { nombre: 'Costo de producción u operación', naturaleza: 'debito', elementoNiif: 'costo' },
  };

  // Cuentas del activo que restan (provisiones, depreciación y amortización
  // acumuladas): tienen naturaleza crédito aunque estén en el activo.
  const CONTRA_ACTIVO = ['1399', '1499', '1592', '1599', '1698', '1699'];

  // Grupos (2 primeros dígitos) del PUC que reconocemos. Un código fuera de
  // esta lista no se bloquea (el PUC es extenso), pero se avisa.
  const GRUPOS_CONOCIDOS = [
    '11', '12', '13', '14', '15', '16', '17', '18', '19',
    '21', '22', '23', '24', '25', '26', '27', '28', '29',
    '31', '32', '33', '34', '35', '36', '37', '38',
    '41', '42', '47',
    '51', '52', '53', '54', '59',
    '61', '62', '71', '72', '73', '74',
  ];

  const CUENTAS_ESENCIALES = ['1355', '2205', '2365', '2367'];

  const CODIGO_RE = /^[1-7]\d{3}(\d{2}(\d{2})?)?$/;

  function normalizarCodigo(codigo) {
    return String(codigo == null ? '' : codigo).replace(/\s+/g, '');
  }

  function normalizarNombre(nombre) {
    return String(nombre == null ? '' : nombre).replace(/\s+/g, ' ').trim();
  }

  // Qué es una cuenta según su código: 4 dígitos = cuenta (nivel 1), 6 =
  // subcuenta (nivel 2), 8 = auxiliar (nivel 3). `padre` (opcional) es la
  // cuenta de la que cuelga (la de 4 o la de 6 dígitos): hereda su naturaleza.
  // Devuelve { ok, error, codigo, nivel, naturaleza, elementoNiif, claseNombre, aviso }.
  function clasificarCodigo(codigoCrudo, padre) {
    const codigo = normalizarCodigo(codigoCrudo);
    if (!codigo) return { ok: false, error: 'Escribe el código de la cuenta.' };
    if (!/^\d+$/.test(codigo)) return { ok: false, error: 'El código solo lleva números.' };
    if (!/^[1-7]/.test(codigo)) {
      return { ok: false, error: 'El código debe empezar por 1 (activo), 2 (pasivo), 3 (patrimonio), 4 (ingreso), 5 (gasto), 6 o 7 (costos).' };
    }
    if (!CODIGO_RE.test(codigo)) {
      return { ok: false, error: 'El código debe tener 4 dígitos (cuenta), 6 (subcuenta) u 8 (auxiliar), por ejemplo 5135, 513525 o 51352505.' };
    }
    const clase = CLASES[codigo[0]];
    const prefijo = codigo.slice(0, 4);
    let naturaleza = clase.naturaleza;
    if (codigo[0] === '1' && CONTRA_ACTIVO.includes(prefijo)) naturaleza = 'credito';
    if (codigo.length > 4 && padre && padre.naturaleza) naturaleza = padre.naturaleza;

    const resultado = {
      ok: true,
      codigo,
      nivel: codigo.length === 8 ? 3 : codigo.length === 6 ? 2 : 1,
      naturaleza,
      elementoNiif: clase.elementoNiif,
      claseNombre: clase.nombre,
      aviso: '',
    };
    if (!GRUPOS_CONOCIDOS.includes(codigo.slice(0, 2))) {
      resultado.aviso = `El grupo ${codigo.slice(0, 2)} no es un grupo habitual del PUC. Revisa el código con tu contador.`;
    }
    return resultado;
  }

  function validarNombre(nombreCrudo) {
    const nombre = normalizarNombre(nombreCrudo);
    if (nombre.length < 3) return { ok: false, error: 'Escribe el nombre de la cuenta (mínimo 3 letras).' };
    if (nombre.length > 100) return { ok: false, error: 'El nombre es muy largo (máximo 100 caracteres).' };
    if (/[<>]/.test(nombre)) return { ok: false, error: 'El nombre no puede llevar los símbolos < o >.' };
    return { ok: true, nombre };
  }

  // ¿Sirve como destino de una compra? (inventario, activo, costo o gasto)
  function esDestinoCompra(cuenta) {
    if (!cuenta || cuenta.naturaleza !== 'debito') return false;
    if (cuenta.elementoNiif === 'costo' || cuenta.elementoNiif === 'gasto') return true;
    return /^(14|15|16|17)/.test(String(cuenta.codigo));
  }

  // --- Catálogo -----------------------------------------------------------
  // Pocas cuentas, las que de verdad usa una mipyme de servicios o comercio.
  // `recomendada`: se sugiere activarla desde el inicio.
  const GRUPOS_CATALOGO = [
    'Gastos de administración',
    'Gastos de ventas',
    'Gastos financieros e impuesto de renta',
    'Costos',
    'Compras que se llevan al activo',
    'Ingresos',
    'Impuestos por pagar',
  ];

  const e = (grupo, codigo, nombre, uso, extra) => Object.assign({ grupo, codigo, nombre, uso, recomendada: false }, extra || {});

  const CATALOGO = [
    // Gastos de administración (grupo 51)
    e('Gastos de administración', '5105', 'Gastos de personal', 'Sueldos, prestaciones y aportes del personal administrativo.'),
    e('Gastos de administración', '5110', 'Honorarios', 'Asesorías, servicios profesionales y contratistas independientes.', { recomendada: true }),
    e('Gastos de administración', '5115', 'Impuestos', 'ICA, predial, vehículos, timbre. No lleva el impuesto de renta (ese va en 5405).', { recomendada: true }),
    e('Gastos de administración', '5120', 'Arrendamientos', 'Arriendo de oficina, bodega o equipos.', { recomendada: true }),
    e('Gastos de administración', '5125', 'Contribuciones y afiliaciones', 'Cámara de Comercio, gremios, cuotas de sostenimiento.'),
    e('Gastos de administración', '5130', 'Seguros', 'Pólizas de la empresa (la parte que corresponde al periodo).'),
    e('Gastos de administración', '5135', 'Servicios', 'Servicios públicos, internet, teléfono, aseo, vigilancia, temporales, asistencia técnica.', { recomendada: true }),
    e('Gastos de administración', '5140', 'Gastos legales', 'Notaría, registro mercantil, trámites y certificados.', { recomendada: true }),
    e('Gastos de administración', '5145', 'Mantenimiento y reparaciones', 'Mantenimiento de equipos, vehículos, locales.', { recomendada: true }),
    e('Gastos de administración', '5150', 'Adecuación e instalación', 'Adecuaciones menores de oficinas y locales.'),
    e('Gastos de administración', '5155', 'Gastos de viaje', 'Tiquetes, hospedaje y alimentación en viajes de trabajo.', { recomendada: true }),
    e('Gastos de administración', '5160', 'Depreciación', 'Depreciación mensual de los activos fijos.'),
    e('Gastos de administración', '5165', 'Amortizaciones', 'Amortización de intangibles y diferidos.'),
    e('Gastos de administración', '5195', 'Diversos (administración)', 'Papelería, útiles, cafetería, combustibles, taxis y gastos menores que no tienen cuenta propia.', { recomendada: true }),
    e('Gastos de administración', '5199', 'Provisiones', 'Provisiones de cartera y otras.'),
    // Gastos de ventas (grupo 52)
    e('Gastos de ventas', '5205', 'Gastos de personal (ventas)', 'Personal del área comercial.'),
    e('Gastos de ventas', '5210', 'Honorarios (ventas)', 'Comisionistas y asesores comerciales.'),
    e('Gastos de ventas', '5220', 'Arrendamientos (ventas)', 'Arriendo de puntos de venta.'),
    e('Gastos de ventas', '5235', 'Servicios (ventas)', 'Publicidad, propaganda y promoción, fletes, servicios del área comercial.'),
    e('Gastos de ventas', '5245', 'Mantenimiento y reparaciones (ventas)', 'Mantenimiento de puntos de venta y equipos comerciales.'),
    e('Gastos de ventas', '5255', 'Gastos de viaje (ventas)', 'Viajes del equipo comercial.'),
    e('Gastos de ventas', '5295', 'Diversos (ventas)', 'Gastos menores del área comercial.'),
    // Financieros e impuesto de renta
    e('Gastos financieros e impuesto de renta', '5305', 'Gastos bancarios', 'Comisiones, intereses, gravamen a los movimientos financieros (4x1000).', { recomendada: true }),
    e('Gastos financieros e impuesto de renta', '5315', 'Gastos extraordinarios', 'Multas, sanciones e intereses de mora.'),
    e('Gastos financieros e impuesto de renta', '5395', 'Gastos diversos (no operacionales)', 'Otros gastos que no son del objeto social.'),
    e('Gastos financieros e impuesto de renta', '5405', 'Impuesto de renta y complementarios', 'Provisión del impuesto de renta del año.', { recomendada: true }),
    // Costos
    e('Costos', '6135', 'Costo de ventas', 'Costo de la mercancía vendida (comercio).'),
    e('Costos', '6155', 'Costo de servicios', 'Costos directos de prestar servicios (consultoría, ingeniería, obra). Confirma con tu contador la cuenta de costo de tu actividad.'),
    e('Costos', '6205', 'Compras de mercancías', 'Compras de mercancía cuando se lleva inventario periódico.'),
    // Compras que se llevan al activo
    e('Compras que se llevan al activo', '1405', 'Materias primas', 'Materiales que se transforman en el producto.'),
    e('Compras que se llevan al activo', '1435', 'Inventarios de mercancías', 'Mercancía para la venta.'),
    e('Compras que se llevan al activo', '1455', 'Materiales, repuestos y accesorios', 'Repuestos, suministros y materiales de consumo.', { recomendada: true }),
    e('Compras que se llevan al activo', '1516', 'Construcciones y edificaciones', 'Edificios y locales propios.'),
    e('Compras que se llevan al activo', '1520', 'Maquinaria y equipo', 'Maquinaria, herramientas de valor.'),
    e('Compras que se llevan al activo', '1524', 'Equipo de oficina', 'Muebles y enseres de oficina.'),
    e('Compras que se llevan al activo', '1528', 'Equipo de computación y comunicación', 'Computadores, servidores, celulares, impresoras.', { recomendada: true }),
    e('Compras que se llevan al activo', '1540', 'Flota y equipo de transporte', 'Vehículos de la empresa.'),
    e('Compras que se llevan al activo', '1635', 'Licencias y software', 'Licencias de uso de varios años, software.', { recomendada: true }),
    e('Compras que se llevan al activo', '1705', 'Gastos pagados por anticipado', 'Seguros, arriendos y suscripciones pagados que cubren varios meses.', { recomendada: true }),
    e('Compras que se llevan al activo', '1710', 'Cargos diferidos', 'Costos que se amortizan en el tiempo.'),
    // Ingresos
    e('Ingresos', '4135', 'Ingresos por venta de bienes', 'Ventas de mercancía.'),
    e('Ingresos', '4155', 'Ingresos por servicios', 'Ingresos por consultoría, servicios empresariales y alquiler.'),
    e('Ingresos', '4210', 'Ingresos financieros', 'Intereses y rendimientos.'),
    e('Ingresos', '4295', 'Ingresos diversos', 'Otros ingresos que no son del objeto social.'),
    // Impuestos por pagar
    e('Impuestos por pagar', '2368', 'ReteICA por pagar', 'Retención de industria y comercio practicada a proveedores.'),
    e('Impuestos por pagar', '2404', 'Impuesto de renta por pagar', 'Saldo del impuesto de renta del año.'),
    e('Impuestos por pagar', '2412', 'ICA por pagar', 'Impuesto de industria y comercio causado.'),
  ];

  // elementoNiif / naturaleza de una entrada del catálogo (siempre 4 dígitos)
  function datosDeCatalogo(entrada) {
    const c = clasificarCodigo(entrada.codigo);
    return { codigo: entrada.codigo, nombre: entrada.nombre, naturaleza: c.naturaleza, elementoNiif: c.elementoNiif, nivel: 1 };
  }

  return {
    CLASES,
    CATALOGO,
    GRUPOS_CATALOGO,
    CUENTAS_ESENCIALES,
    CONTRA_ACTIVO,
    normalizarCodigo,
    normalizarNombre,
    clasificarCodigo,
    validarNombre,
    esDestinoCompra,
    datosDeCatalogo,
  };
});
