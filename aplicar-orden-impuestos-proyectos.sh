#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
# Orden de adquisición: ID del proyecto visible, Impoconsumo, AIU (servicios),
# retención en la fuente por concepto (catálogo 2026) con topes en UVT y opción
# "No aplica", neto a pagar, y edición de Proyectos.
set -e
if [ ! -f "package.json" ]; then echo "ERROR: ve a la carpeta mipyme-contable primero."; exit 1; fi

mkdir -p public/contable src/modules/compras/models src/modules/compras/services tests
cat > public/contable/retencionesCatalogo.js << 'SCRIPTEOF'
// Catálogo de conceptos de retención en la fuente — año gravable 2026.
//
// Fuente: la tabla de conceptos que entregó la firma (Excel "datos_retenciones").
// Para cambiar de año: actualizar ANIO, UVT_VALOR y las tarifas/UVT del arreglo.
//
// Mismo patrón que calculoOrden.js: un solo archivo para el navegador
// (<script src>) y para el backend (require).
//
// Cada concepto:
//   codigo    identificador estable (RF-01...), es lo que se guarda en la orden
//   categoria agrupa el desplegable
//   uvt       base mínima en UVT para practicar la retención (0 = sin tope)
//   tarifa    porcentaje (2.5 = 2,5%)
//   sobre     sobre qué se aplica: 'base' = subtotal + AIU (antes de impuestos),
//             'aiu' = solo el AIU, 'iva' = el valor del IVA (ReteIVA)
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.retencionesCatalogo = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const ANIO = 2026;
  // Resolución DIAN 000238 de 2025. OJO: el Excel de la firma trae la
  // columna VALOR calculada con 52.400 (redondeada); aquí se usa la UVT
  // oficial para que el tope no quede levemente por encima del real.
  const UVT_VALOR = 52374;

  const CONCEPTO_MANUAL = {
    codigo: 'OTRO',
    categoria: 'Otro',
    nombre: 'Otro concepto (digitar tarifa)',
    uvt: 0,
    tarifa: 0,
    sobre: 'base',
    manual: true,
  };

  const CONCEPTOS = [
    {
      "codigo": "RF-01",
      "categoria": "Compras",
      "nombre": "Compras generales (declarantes)",
      "uvt": 10,
      "tarifa": 2.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-02",
      "categoria": "Compras",
      "nombre": "Compras generales (no declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-03",
      "categoria": "Compras",
      "nombre": "Compras con tarjeta débito o crédito",
      "uvt": 0,
      "tarifa": 1.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-04",
      "categoria": "Compras",
      "nombre": "Compras agrícolas o pecuarias sin procesamiento industrial",
      "uvt": 70,
      "tarifa": 1.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-05",
      "categoria": "Compras",
      "nombre": "Compras agrícolas o pecuarias con procesamiento industrial (declarantes)",
      "uvt": 10,
      "tarifa": 2.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-06",
      "categoria": "Compras",
      "nombre": "Compras agrícolas o pecuarias con procesamiento industrial (no declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base",
      "detalle": "Compras de bienes o productos agrícolas o pecuarios con procesamiento industrial declarantes (no declarantes)"
    },
    {
      "codigo": "RF-07",
      "categoria": "Compras",
      "nombre": "Compras de café pergamino o cereza",
      "uvt": 70,
      "tarifa": 0.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-08",
      "categoria": "Compras",
      "nombre": "Compras de combustibles derivados del petróleo",
      "uvt": 0,
      "tarifa": 0.1,
      "sobre": "base"
    },
    {
      "codigo": "RF-09",
      "categoria": "Compras",
      "nombre": "Enajenación de activos fijos de personas naturales (notarías y tránsito son agentes retenedores)",
      "uvt": 0,
      "tarifa": 1,
      "sobre": "base"
    },
    {
      "codigo": "RF-10",
      "categoria": "Compras",
      "nombre": "Compras de vehículos",
      "uvt": 0,
      "tarifa": 1,
      "sobre": "base"
    },
    {
      "codigo": "RF-11",
      "categoria": "Compras",
      "nombre": "Bienes raíces de vivienda de habitación (primeras 20.000 UVT)",
      "uvt": 0,
      "tarifa": 1,
      "sobre": "base",
      "detalle": "Compras de bienes raíces cuya destinación y uso sea vivienda de habitación (por las primeras 20.000 UVT, es decir hasta $941.300.000)"
    },
    {
      "codigo": "RF-12",
      "categoria": "Compras",
      "nombre": "Bienes raíces de vivienda de habitación (exceso de 20.000 UVT)",
      "uvt": 20000,
      "tarifa": 2.5,
      "sobre": "base",
      "detalle": "Compras de bienes raíces cuya destinación y uso sea vivienda de habitación (exceso de las primeras 20.000 UVT, es decir superior a $941.300.000)"
    },
    {
      "codigo": "RF-13",
      "categoria": "Compras",
      "nombre": "Bienes raíces de destinación distinta a vivienda",
      "uvt": 0,
      "tarifa": 2.5,
      "sobre": "base",
      "detalle": "Compras de bienes raíces cuya destinación y uso sea distinto a vivienda de habitación"
    },
    {
      "codigo": "RF-14",
      "categoria": "Servicios",
      "nombre": "Servicios generales (declarantes)",
      "uvt": 2,
      "tarifa": 4,
      "sobre": "base"
    },
    {
      "codigo": "RF-15",
      "categoria": "Servicios",
      "nombre": "Servicios generales (no declarantes)",
      "uvt": 2,
      "tarifa": 6,
      "sobre": "base"
    },
    {
      "codigo": "RF-16",
      "categoria": "Servicios",
      "nombre": "Emolumentos eclesiásticos (declarantes)",
      "uvt": 10,
      "tarifa": 4,
      "sobre": "base"
    },
    {
      "codigo": "RF-17",
      "categoria": "Servicios",
      "nombre": "Emolumentos eclesiásticos (no declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-18",
      "categoria": "Servicios",
      "nombre": "Servicios de transporte de carga",
      "uvt": 2,
      "tarifa": 1,
      "sobre": "base"
    },
    {
      "codigo": "RF-19",
      "categoria": "Servicios",
      "nombre": "Transporte nacional de pasajeros por vía terrestre (declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-20",
      "categoria": "Servicios",
      "nombre": "Transporte nacional de pasajeros por vía terrestre (no declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-21",
      "categoria": "Servicios",
      "nombre": "Transporte nacional de pasajeros por vía aérea o marítima",
      "uvt": 2,
      "tarifa": 1,
      "sobre": "base"
    },
    {
      "codigo": "RF-22",
      "categoria": "Servicios",
      "nombre": "Empresas de servicios temporales (sobre AIU)",
      "uvt": 2,
      "tarifa": 1,
      "sobre": "aiu"
    },
    {
      "codigo": "RF-23",
      "categoria": "Servicios",
      "nombre": "Empresas de vigilancia y aseo (sobre AIU)",
      "uvt": 2,
      "tarifa": 2,
      "sobre": "aiu"
    },
    {
      "codigo": "RF-24",
      "categoria": "Servicios",
      "nombre": "Servicios integrales de salud prestados por IPS",
      "uvt": 2,
      "tarifa": 2,
      "sobre": "base"
    },
    {
      "codigo": "RF-25",
      "categoria": "Servicios",
      "nombre": "Servicios de hoteles y restaurantes (declarantes)",
      "uvt": 2,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-26",
      "categoria": "Servicios",
      "nombre": "Servicios de hoteles y restaurantes (no declarantes)",
      "uvt": 2,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-27",
      "categoria": "Arrendamientos",
      "nombre": "Arrendamiento de bienes muebles",
      "uvt": 0,
      "tarifa": 4,
      "sobre": "base"
    },
    {
      "codigo": "RF-28",
      "categoria": "Arrendamientos",
      "nombre": "Arrendamiento de bienes inmuebles (declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-29",
      "categoria": "Arrendamientos",
      "nombre": "Arrendamiento de bienes inmuebles (no declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-30",
      "categoria": "Otros ingresos tributarios",
      "nombre": "Otros ingresos tributarios (declarantes)",
      "uvt": 10,
      "tarifa": 2.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-31",
      "categoria": "Otros ingresos tributarios",
      "nombre": "Otros ingresos tributarios (no declarantes)",
      "uvt": 10,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-32",
      "categoria": "Honorarios y comisiones",
      "nombre": "Honorarios y comisiones (personas jurídicas)",
      "uvt": 0,
      "tarifa": 11,
      "sobre": "base"
    },
    {
      "codigo": "RF-33",
      "categoria": "Honorarios y comisiones",
      "nombre": "Honorarios y comisiones a personas naturales (contratos o pagos del año superiores a 3.300 UVT)",
      "uvt": 0,
      "tarifa": 11,
      "sobre": "base",
      "detalle": "Honorarios y comisiones pagados a personas naturales que suscriban contratos por más de 3.300 Uvt o que la sumatoria de los pagos o abonos en cuenta durante el año gravable superen 3.300 UVT ($155.315.000)"
    },
    {
      "codigo": "RF-34",
      "categoria": "Honorarios y comisiones",
      "nombre": "Honorarios y comisiones (no declarantes)",
      "uvt": 0,
      "tarifa": 10,
      "sobre": "base"
    },
    {
      "codigo": "RF-35",
      "categoria": "Servicios",
      "nombre": "Servicios de licenciamiento o derecho de uso de software",
      "uvt": 0,
      "tarifa": 3.5,
      "sobre": "base"
    },
    {
      "codigo": "RF-36",
      "categoria": "Rendimientos financieros",
      "nombre": "Intereses o rendimientos financieros",
      "uvt": 0,
      "tarifa": 7,
      "sobre": "base"
    },
    {
      "codigo": "RF-37",
      "categoria": "Rendimientos financieros",
      "nombre": "Rendimientos financieros de títulos de renta fija",
      "uvt": 0,
      "tarifa": 4,
      "sobre": "base"
    },
    {
      "codigo": "RF-38",
      "categoria": "Juegos de suerte y azar",
      "nombre": "Loterías, rifas, apuestas y similares",
      "uvt": 48,
      "tarifa": 20,
      "sobre": "base"
    },
    {
      "codigo": "RF-39",
      "categoria": "Juegos de suerte y azar",
      "nombre": "Colocación independiente de juegos de suerte y azar",
      "uvt": 5,
      "tarifa": 3,
      "sobre": "base"
    },
    {
      "codigo": "RF-40",
      "categoria": "Construcción",
      "nombre": "Contratos de construcción y urbanización",
      "uvt": 10,
      "tarifa": 2,
      "sobre": "base"
    },
    {
      "codigo": "RF-41",
      "categoria": "ReteIVA",
      "nombre": "IVA retenido en servicios (ReteIVA)",
      "uvt": 2,
      "tarifa": 15,
      "sobre": "iva"
    },
    {
      "codigo": "RF-42",
      "categoria": "ReteIVA",
      "nombre": "IVA retenido en compras (ReteIVA)",
      "uvt": 10,
      "tarifa": 15,
      "sobre": "iva"
    },
    {
      "codigo": "RF-43",
      "categoria": "Pagos al exterior",
      "nombre": "Pagos al exterior: intereses, comisiones, honorarios, regalías, arrendamientos, servicios, propiedad industrial, software",
      "uvt": 0,
      "tarifa": 20,
      "sobre": "base",
      "detalle": "Pagos o abonos en cuenta por concepto de intereses, comisiones, honorarios, regalías, arrendamientos, compensaciones por servicios personales, o explotación de toda especie de propiedad industrial o del know-how, prestación de servicios, beneficios o regalías provenientes de la propiedad literaria, artística y científica, explotación de películas cinematográficas y explotación de software."
    },
    {
      "codigo": "RF-44",
      "categoria": "Pagos al exterior",
      "nombre": "Pagos al exterior: consultorías, servicios técnicos y asistencia técnica",
      "uvt": 0,
      "tarifa": 20,
      "sobre": "base",
      "detalle": "Pagos o abonos en cuenta por concepto de consultorías, servicios técnicos y de asistencia técnica, prestados por personas no residentes o no domiciliadas en Colombia,"
    },
    {
      "codigo": "RF-45",
      "categoria": "Pagos al exterior",
      "nombre": "Pagos al exterior: rendimientos financieros de créditos del exterior (1 año o más) y leasing",
      "uvt": 0,
      "tarifa": 15,
      "sobre": "base",
      "detalle": "Pagos o abonos en cuenta por concepto de rendimientos financieros, realizados a personas no residentes o no domiciliadas en el país, originados en créditos obtenidos en el exterior por término igual o superior a un (1) año o por concepto de intereses o costos financieros del canon de arrendamiento originados en contratos de leasing que se celebre directamente o a través de compañías de leasing con empresas extranjeras sin domicilio en Colombia,"
    },
    {
      "codigo": "RF-46",
      "categoria": "Pagos al exterior",
      "nombre": "Pagos al exterior: leasing de naves, helicópteros y aerodinos",
      "uvt": 0,
      "tarifa": 1,
      "sobre": "base",
      "detalle": "Pagos o abonos en cuenta, originados en contratos de leasing sobre naves, helicópteros y/o aerodinos, así como sus partes que se celebren directamente o a través de compañías de leasing, con empresas extranjeras sin domicilio en Colombia."
    },
    {
      "codigo": "RF-47",
      "categoria": "Pagos al exterior",
      "nombre": "Pagos al exterior: intereses de créditos a 8 años o más para infraestructura (APP)",
      "uvt": 0,
      "tarifa": 5,
      "sobre": "base",
      "detalle": "Pagos o abonos en cuenta por concepto de rendimientos financieros o intereses, realizados a personas no residentes o no domiciliadas en el país, originados en créditos o valores de contenido crediticio, por término igual o superior a ocho (8) años, destinados a la financiación de proyectos de infraestructura bajo el esquema de Asociaciones Público-Privadas en el marco de la Ley 1508 de 2012."
    },
    {
      "codigo": "RF-48",
      "categoria": "Pagos al exterior",
      "nombre": "Pagos al exterior: prima cedida por reaseguros",
      "uvt": 0,
      "tarifa": 1,
      "sobre": "base",
      "detalle": "Pagos o abonos en cuenta por concepto de prima cedida por reaseguros realizados a personas no residentes o no domiciliadas en el país."
    }
  ];

  // Motivos para NO practicar retención (quedan impresos en el PDF).
  const MOTIVOS_NO_APLICA = [
    'Proveedor en Régimen Simple de Tributación (RST)',
    'Proveedor con tratamiento tributario especial',
    'No supera la base mínima (tope) para practicar retención',
    'Otro motivo',
  ];

  function porCodigo(codigo) {
    if (codigo === CONCEPTO_MANUAL.codigo) return CONCEPTO_MANUAL;
    return CONCEPTOS.find((c) => c.codigo === codigo) || null;
  }

  // Convierte {codigo, tarifa?} en la "especificación" completa que
  // consume calcularOrden (incluye el nombre, la UVT y su valor, para que
  // una orden guardada no cambie si el catálogo se actualiza el año
  // siguiente). Con estricto:false un código vacío o inválido devuelve
  // una especificación en cero en vez de lanzar error (formulario a medias).
  function especificar(entrada, opciones) {
    const estricto = !opciones || opciones.estricto !== false;
    const concepto = entrada && porCodigo(entrada.codigo);
    if (!concepto) {
      if (estricto) throw new Error('Concepto de retención no reconocido: ' + (entrada && entrada.codigo));
      return { codigo: '', nombre: '', tarifa: 0, sobre: 'base', uvt: 0, uvtValor: UVT_VALOR };
    }
    let tarifa = concepto.tarifa;
    if (concepto.manual) {
      tarifa = Number(entrada.tarifa);
      if (!(tarifa > 0 && tarifa <= 100)) {
        if (estricto) throw new Error('Retención "Otro concepto": la tarifa debe ser mayor a 0 y máximo 100.');
        tarifa = 0;
      }
    }
    return {
      codigo: concepto.codigo,
      nombre: concepto.nombre,
      tarifa,
      sobre: concepto.sobre,
      uvt: concepto.uvt,
      uvtValor: UVT_VALOR,
    };
  }

  return { ANIO, UVT_VALOR, CONCEPTOS, CONCEPTO_MANUAL, MOTIVOS_NO_APLICA, porCodigo, especificar };
});
SCRIPTEOF
echo "OK  public/contable/retencionesCatalogo.js"

cat > public/contable/calculoOrden.js << 'SCRIPTEOF'
// Cálculo de totales de una orden de adquisición.
//
// UNA sola fuente de verdad: este mismo archivo lo usan
//   - el navegador (formulario de la orden y PDF), cargado con <script src>
//   - el backend (compras.service.js), con require()
// así lo que el usuario ve mientras digita es exactamente lo que se
// guarda. Vive en public/ para que el navegador pueda pedirlo; no
// depende de nada, ni de Node ni del DOM.
//
// Reglas:
//  - Subtotal = suma de (cantidad × valor unitario) de los ítems.
//  - AIU (Administración, Imprevistos, Utilidad): solo aplica en
//    órdenes de SERVICIOS. Cada porcentaje se calcula sobre el subtotal.
//  - IVA sin AIU: suma del IVA de cada ítem tipo "iva".
//  - IVA con AIU: 19% sobre (subtotal + AIU), o solo sobre la Utilidad
//    si aiuBaseIva === 'utilidad' (régimen especial de ciertos servicios).
//    Con AIU se ignora el IVA individual de los ítems (convención común
//    en contratos de obra/servicios).
//  - Impoconsumo: suma del impuesto de los ítems tipo "impoconsumo".
//  - Retención en la fuente: informativa para el proveedor. No se suma al
//    total: se resta para obtener el neto a pagar. Tres modos:
//      'ninguna'   no se menciona retención
//      'aplica'    una o varias líneas, cada una con su concepto ya
//                  "especificado" (ver retencionesCatalogo.especificar):
//                  tarifa, sobre qué se aplica (subtotal+AIU, solo AIU o el
//                  IVA) y tope mínimo en UVT. Si la base de la línea no
//                  alcanza el tope, esa línea no retiene (valor 0).
//      'no_aplica' el proveedor no está sujeto (Régimen Simple, tratamiento
//                  especial, bajo el tope...). Exige un motivo, que se imprime.
//    Este archivo NO conoce el catálogo de conceptos: recibe las líneas ya
//    resueltas, así una orden guardada no cambia si el catálogo se actualiza.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.calcularOrden = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const TARIFA_IVA_GENERAL = 19;

  function redondear(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  }

  // opciones.estricto (por defecto true): con true, datos inválidos
  // lanzan Error (lo que quiere el backend antes de guardar). Con false
  // se ignoran y se calcula con lo que haya (lo que quiere el formulario
  // mientras la persona todavía está digitando).
  function calcularOrden(datos, opciones) {
    const estricto = !opciones || opciones.estricto !== false;
    const tipo = datos.tipo || 'bienes';

    const lineas = (Array.isArray(datos.items) ? datos.items : []).map((item, i) => {
      const cantidad = numero(item.cantidad);
      const valorUnitario = numero(item.valorUnitario);
      if (estricto && (cantidad < 0 || valorUnitario < 0)) {
        throw new Error(`Ítem ${i + 1}: cantidad y valor unitario no pueden ser negativos.`);
      }
      const tipoImpuesto = item.tipoImpuesto || 'iva';
      const impuestoPorcentaje =
        tipoImpuesto === 'exento' ? 0 : numero(item.impuestoPorcentaje ?? TARIFA_IVA_GENERAL);
      const valorTotal = redondear(cantidad * valorUnitario);
      const impuestoValor = redondear(valorTotal * (impuestoPorcentaje / 100));
      return { ...item, cantidad, valorUnitario, tipoImpuesto, impuestoPorcentaje, valorTotal, impuestoValor };
    });

    const subtotal = redondear(lineas.reduce((s, l) => s + l.valorTotal, 0));

    // --- AIU (solo servicios) ---
    const aplicaAiu = tipo === 'servicios' && !!datos.aplicaAiu;
    const aiuAdministracion = aplicaAiu ? numero(datos.aiuAdministracion) : 0;
    const aiuImprevistos = aplicaAiu ? numero(datos.aiuImprevistos) : 0;
    const aiuUtilidad = aplicaAiu ? numero(datos.aiuUtilidad) : 0;
    if (estricto && [aiuAdministracion, aiuImprevistos, aiuUtilidad].some((p) => p < 0 || p > 100)) {
      throw new Error('Los porcentajes del AIU deben estar entre 0 y 100.');
    }
    const aiuAdministracionValor = redondear(subtotal * (aiuAdministracion / 100));
    const aiuImprevistosValor = redondear(subtotal * (aiuImprevistos / 100));
    const aiuUtilidadValor = redondear(subtotal * (aiuUtilidad / 100));
    const aiuBaseIva = datos.aiuBaseIva === 'utilidad' ? 'utilidad' : 'total';

    // Base antes de impuestos: subtotal + AIU (el AIU es 0 si no aplica).
    const base = redondear(subtotal + aiuAdministracionValor + aiuImprevistosValor + aiuUtilidadValor);

    // --- Impuestos ---
    let iva;
    if (aplicaAiu) {
      const baseIva = aiuBaseIva === 'utilidad' ? aiuUtilidadValor : base;
      iva = redondear(baseIva * (TARIFA_IVA_GENERAL / 100));
    } else {
      iva = redondear(lineas.filter((l) => l.tipoImpuesto === 'iva').reduce((s, l) => s + l.impuestoValor, 0));
    }
    const impoconsumo = redondear(
      lineas.filter((l) => l.tipoImpuesto === 'impoconsumo').reduce((s, l) => s + l.impuestoValor, 0)
    );

    const total = redondear(base + iva + impoconsumo);

    // --- Retención en la fuente ---
    const retencionModo = ['aplica', 'no_aplica'].includes(datos.retencionModo) ? datos.retencionModo : 'ninguna';
    const retencionMotivo = retencionModo === 'no_aplica' ? String(datos.retencionMotivo || '').trim() : '';
    const retencionDetalle = retencionModo === 'no_aplica' ? String(datos.retencionDetalle || '').trim() : '';

    if (estricto && retencionModo === 'no_aplica' && !retencionMotivo) {
      throw new Error('Indica el motivo por el cual no aplica la retención en la fuente.');
    }

    const aiuTotal = redondear(aiuAdministracionValor + aiuImprevistosValor + aiuUtilidadValor);
    let retenciones = [];
    if (retencionModo === 'aplica') {
      const entradas = Array.isArray(datos.retenciones) ? datos.retenciones : [];
      if (estricto && entradas.length === 0) {
        throw new Error('Agrega al menos un concepto de retención, o elige "No aplica retención".');
      }
      retenciones = entradas.map((r) => {
        const tarifa = numero(r.tarifa);
        const uvt = numero(r.uvt);
        const uvtValor = numero(r.uvtValor);
        const sobre = ['aiu', 'iva'].includes(r.sobre) ? r.sobre : 'base';
        if (estricto && (!r.codigo || !(tarifa > 0 && tarifa <= 100))) {
          throw new Error('Cada retención necesita un concepto con tarifa mayor a 0 y máximo 100.');
        }

        // Valor sobre el que se aplica la tarifa de este concepto.
        const baseLinea = sobre === 'aiu' ? aiuTotal : sobre === 'iva' ? iva : base;
        // El tope (en UVT) siempre se mide contra la base de la operación
        // (subtotal + AIU antes de impuestos), también en ReteIVA.
        const baseMinima = redondear(uvt * uvtValor);
        const alcanzaTope = base >= baseMinima;

        let nota = '';
        if (!r.codigo) nota = '';
        else if (sobre === 'aiu' && aiuTotal === 0) nota = 'Este concepto se calcula sobre el AIU: discrimínalo en la orden.';
        else if (!alcanzaTope) nota = 'La base no alcanza el tope mínimo: no se practica esta retención.';

        const aplica = !!r.codigo && alcanzaTope && baseLinea > 0;
        return {
          codigo: r.codigo || '',
          nombre: r.nombre || '',
          tarifa,
          sobre,
          uvt,
          uvtValor,
          base: baseLinea,
          baseMinima,
          aplica,
          valor: aplica ? redondear(baseLinea * (tarifa / 100)) : 0,
          nota,
        };
      });
    }
    const retencionValor = redondear(retenciones.reduce((s, r) => s + r.valor, 0));

    return {
      lineas,
      cabecera: {
        subtotal,
        iva,
        impoconsumo,
        total,
        aplicaAiu,
        aiuAdministracion,
        aiuImprevistos,
        aiuUtilidad,
        aiuAdministracionValor,
        aiuImprevistosValor,
        aiuUtilidadValor,
        aiuBaseIva,
        base,
        aiuTotal,
        retencionModo,
        retencionMotivo,
        retencionDetalle,
        retenciones,
        retencionValor,
      },
      netoAPagar: redondear(total - retencionValor),
    };
  }

  return calcularOrden;
});
SCRIPTEOF
echo "OK  public/contable/calculoOrden.js"

cat > public/contable/app.js << 'SCRIPTEOF'
const API = '/api';

let token = localStorage.getItem('token');
let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
let mapaTerceros = {};
let listaTerceros = [];
let mapaProyectos = {};
let listaProyectos = [];

const vistaLogin = document.getElementById('vista-login');
const vistaDashboard = document.getElementById('vista-dashboard');

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    cerrarSesion('Tu sesión expiró. Inicia sesión de nuevo.');
    throw new Error('No autenticado');
  }

  if (res.status === 413) {
    throw new Error('El archivo es demasiado grande para guardarlo. Intenta con una imagen más liviana.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

// Atajo para botones de acción: llama la API y recarga todo el tablero.
// Cualquier error se muestra en una alerta simple — es intencionalmente
// básico, para no construir un sistema de notificaciones todavía.
async function accion(path, options = {}) {
  try {
    await api(path, options);
    await cargarTodo();
  } catch (err) {
    alert(err.message);
  }
}

function formatoDinero(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });
}

function formatoFecha(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const ETIQUETAS_IMPUESTO = { iva: 'IVA', impoconsumo: 'Impoconsumo', exento: 'Exento' };
function etiquetaImpuesto(tipoImpuesto, porcentaje) {
  const etiqueta = ETIQUETAS_IMPUESTO[tipoImpuesto] || 'IVA';
  return tipoImpuesto === 'exento' ? etiqueta : `${etiqueta} ${porcentaje}%`;
}

// Para totales de órdenes: el IVA del 19% casi siempre deja centavos, y
// redondearlos a peso entero haría que las líneas no sumen a la vista.
function formatoDineroDec(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function nombreTercero(id) {
  return mapaTerceros[id] || id || '—';
}

function badge(estado) {
  if (!estado) return '—';
  return `<span class="badge ${estado}">${estado.replace(/_/g, ' ')}</span>`;
}

function tablaVacia(idTabla, colSpan, mensaje) {
  document.querySelector(`#${idTabla} tbody`).innerHTML =
    `<tr><td colspan="${colSpan}" class="vacio">${mensaje}</td></tr>`;
}

function botonAccion(texto, dataAttrs, destructivo) {
  const attrs = Object.entries(dataAttrs)
    .map(([k, v]) => `data-${k}="${v}"`)
    .join(' ');
  return `<button class="btn-accion${destructivo ? ' destructivo' : ''}" ${attrs}>${texto}</button>`;
}

// --- LOGIN ---
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  errorEl.style.color = '';

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');

    token = data.token;
    usuario = data.usuario;
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuario));
    mostrarDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

function cerrarSesion(mensaje) {
  token = null;
  usuario = null;
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  vistaDashboard.hidden = true;
  vistaLogin.hidden = false;
  if (mensaje) {
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = mensaje;
    errorEl.hidden = false;
  }
}

document.getElementById('btn-salir').addEventListener('click', () => cerrarSesion());

// --- ONBOARDING: crear empresa nueva y su primer usuario, sin sesión ---
const tarjetaLoginPrincipal = document.getElementById('tarjeta-login-principal');
const tarjetaOnboarding = document.getElementById('tarjeta-onboarding');
let empresaNuevaId = null;

document.getElementById('btn-mostrar-onboarding').addEventListener('click', () => {
  tarjetaLoginPrincipal.hidden = true;
  tarjetaOnboarding.hidden = false;
});

function volverALogin() {
  tarjetaOnboarding.hidden = true;
  tarjetaLoginPrincipal.hidden = false;
  document.getElementById('form-empresa-nueva').hidden = false;
  document.getElementById('form-usuario-nuevo').hidden = true;
  document.getElementById('form-empresa-nueva').reset();
  document.getElementById('form-usuario-nuevo').reset();
  document.getElementById('onboarding-resultado').hidden = true;
  empresaNuevaId = null;
}

document.getElementById('btn-volver-login').addEventListener('click', volverALogin);

// Convierte el archivo elegido a un data URI (base64) — así se manda
// tal cual al backend, sin necesitar un endpoint de subida de archivos
// aparte. Límite de 2MB para no inflar la base de datos con un logo
// pesado por error.
function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error('El logo no debe pesar más de 2MB.'));
      return;
    }
    const lector = new FileReader();
    lector.onload = () => resolve(lector.result);
    lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    lector.readAsDataURL(file);
  });
}

document.getElementById('empresa-logo').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  const vistaPrevia = document.getElementById('empresa-logo-vista-previa');
  if (!archivo) {
    vistaPrevia.hidden = true;
    return;
  }
  try {
    vistaPrevia.src = await leerArchivoComoBase64(archivo);
    vistaPrevia.hidden = false;
  } catch (err) {
    alert(err.message);
    e.target.value = '';
  }
});

document.getElementById('form-empresa-nueva').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const archivoLogo = document.getElementById('empresa-logo').files[0];
    const logoBase64 = archivoLogo ? await leerArchivoComoBase64(archivoLogo) : undefined;

    const res = await fetch(API + '/empresas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razonSocial: document.getElementById('empresa-razon-social').value,
        nit: document.getElementById('empresa-nit').value,
        regimenTributario: document.getElementById('empresa-regimen').value,
        responsableIva: document.getElementById('empresa-responsable-iva').checked,
        email: document.getElementById('empresa-email').value || undefined,
        telefono: document.getElementById('empresa-telefono').value || undefined,
        direccion: document.getElementById('empresa-direccion').value || undefined,
        departamento: document.getElementById('empresa-departamento').value || undefined,
        municipio: document.getElementById('empresa-municipio').value || undefined,
        representanteLegalNombre: document.getElementById('empresa-representante-nombre').value || undefined,
        representanteLegalDocumento: document.getElementById('empresa-representante-documento').value || undefined,
        actividadEconomicaCiiu: document.getElementById('empresa-ciiu').value || undefined,
        matriculaMercantil: document.getElementById('empresa-matricula').value || undefined,
        logoBase64,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la empresa.');

    empresaNuevaId = data.id;
    document.getElementById('empresa-creada-mensaje').textContent =
      `Empresa "${data.razonSocial}" creada. Ahora crea su primer usuario:`;
    document.getElementById('form-empresa-nueva').hidden = true;
    document.getElementById('form-usuario-nuevo').hidden = false;
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('form-usuario-nuevo').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch(API + '/auth/registro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empresaId: empresaNuevaId,
        nombre: document.getElementById('usuario-nuevo-nombre').value,
        email: document.getElementById('usuario-nuevo-email').value,
        password: document.getElementById('usuario-nuevo-password').value,
        rol: document.getElementById('usuario-nuevo-rol').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear el usuario.');

    volverALogin();
    document.getElementById('login-email').value = data.email;
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = `Usuario "${data.email}" creado. Ya puedes iniciar sesión.`;
    errorEl.style.color = 'var(--accent)';
    errorEl.hidden = false;
  } catch (err) {
    alert(err.message);
  }
});

// --- DASHBOARD SHELL ---
function mostrarDashboard() {
  vistaLogin.hidden = true;
  vistaDashboard.hidden = false;
  document.getElementById('usuario-nombre').textContent = usuario.nombre;
  document.getElementById('usuario-rol').textContent = usuario.rol;
  document.getElementById('inicio-usuario-nombre').textContent = usuario.nombre;
  cargarTodo();
  cargarNombreEmpresa();
}

async function cargarNombreEmpresa() {
  if (!usuario.empresaId) return;
  try {
    const empresas = await api('/empresas');
    const miEmpresa = empresas.find((e) => e.id === usuario.empresaId);
    document.getElementById('inicio-empresa-nombre').textContent = miEmpresa ? miEmpresa.razonSocial : '—';
    if (miEmpresa) llenarFormularioMiEmpresa(miEmpresa);
  } catch (err) {
    console.error(err);
  }
}

function llenarFormularioMiEmpresa(empresa) {
  document.getElementById('miempresa-razon-social').value = empresa.razonSocial || '';
  document.getElementById('miempresa-nit').value = empresa.nit || '';
  document.getElementById('miempresa-regimen').value = empresa.regimenTributario || 'ordinario';
  document.getElementById('miempresa-responsable-iva').checked = !!empresa.responsableIva;
  document.getElementById('miempresa-email').value = empresa.email || '';
  document.getElementById('miempresa-telefono').value = empresa.telefono || '';
  document.getElementById('miempresa-direccion').value = empresa.direccion || '';
  document.getElementById('miempresa-departamento').value = empresa.departamento || '';
  document.getElementById('miempresa-municipio').value = empresa.municipio || '';
  document.getElementById('miempresa-representante-nombre').value = empresa.representanteLegalNombre || '';
  document.getElementById('miempresa-representante-documento').value = empresa.representanteLegalDocumento || '';
  document.getElementById('miempresa-ciiu').value = empresa.actividadEconomicaCiiu || '';
  document.getElementById('miempresa-matricula').value = empresa.matriculaMercantil || '';

  const vistaPrevia = document.getElementById('miempresa-logo-vista-previa');
  if (empresa.logoBase64) {
    vistaPrevia.src = empresa.logoBase64;
    vistaPrevia.hidden = false;
  } else {
    vistaPrevia.hidden = true;
  }
}

document.getElementById('miempresa-logo').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  const vistaPrevia = document.getElementById('miempresa-logo-vista-previa');
  if (!archivo) return; // sin archivo nuevo, se conserva el logo actual en la vista previa
  try {
    vistaPrevia.src = await leerArchivoComoBase64(archivo);
    vistaPrevia.hidden = false;
  } catch (err) {
    alert(err.message);
    e.target.value = '';
  }
});

document.getElementById('form-mi-empresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultado = document.getElementById('miempresa-resultado');
  resultado.hidden = true;
  try {
    const archivoLogo = document.getElementById('miempresa-logo').files[0];
    // Si no se eligió un archivo nuevo, no se manda logoBase64 — así el
    // backend conserva el logo que ya tenía en vez de borrarlo.
    const logoBase64 = archivoLogo ? await leerArchivoComoBase64(archivoLogo) : undefined;

    await api(`/empresas/${usuario.empresaId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        razonSocial: document.getElementById('miempresa-razon-social').value,
        nit: document.getElementById('miempresa-nit').value,
        regimenTributario: document.getElementById('miempresa-regimen').value,
        responsableIva: document.getElementById('miempresa-responsable-iva').checked,
        email: document.getElementById('miempresa-email').value || undefined,
        telefono: document.getElementById('miempresa-telefono').value || undefined,
        direccion: document.getElementById('miempresa-direccion').value || undefined,
        departamento: document.getElementById('miempresa-departamento').value || undefined,
        municipio: document.getElementById('miempresa-municipio').value || undefined,
        representanteLegalNombre: document.getElementById('miempresa-representante-nombre').value || undefined,
        representanteLegalDocumento: document.getElementById('miempresa-representante-documento').value || undefined,
        actividadEconomicaCiiu: document.getElementById('miempresa-ciiu').value || undefined,
        matriculaMercantil: document.getElementById('miempresa-matricula').value || undefined,
        logoBase64,
      }),
    });

    document.getElementById('miempresa-logo').value = '';
    resultado.textContent = 'Datos de la empresa actualizados.';
    resultado.hidden = false;
    cargarNombreEmpresa();
  } catch (err) {
    alert(err.message);
  }
});

// Cambia de pestaña — la usan tanto el menú lateral como las tarjetas
// del panel de Inicio, para no duplicar la lógica.
function irATab(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activo'));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
  const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (navItem) navItem.classList.add('activo');
  document.getElementById('panel-' + tab).hidden = false;
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => irATab(btn.dataset.tab));
});

document.querySelectorAll('.tarjeta-modulo').forEach((btn) => {
  btn.addEventListener('click', () => irATab(btn.dataset.irA));
});

// --- TOGGLE DE FORMULARIOS "+ Nuevo..." ---
function conectarToggle(botonId, formularioId, cancelarId) {
  const boton = document.getElementById(botonId);
  const formulario = document.getElementById(formularioId);
  boton.addEventListener('click', () => (formulario.hidden = !formulario.hidden));
  document.getElementById(cancelarId).addEventListener('click', () => {
    formulario.hidden = true;
    formulario.reset();
  });
}

conectarToggle('btn-nuevo-tercero', 'form-tercero', 'btn-cancelar-tercero');
document.getElementById('btn-nuevo-tercero').addEventListener('click', () => {
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});
conectarToggle('btn-nuevo-proyecto', 'form-proyecto', 'btn-cancelar-proyecto');
conectarToggle('btn-nueva-cotizacion', 'form-cotizacion', 'btn-cancelar-cotizacion');
conectarToggle('btn-nueva-orden', 'form-orden', 'btn-cancelar-orden');
conectarToggle('btn-nuevo-periodo', 'form-periodo', 'btn-cancelar-periodo');
conectarToggle('btn-nuevo-producto', 'form-producto', 'btn-cancelar-producto');
conectarToggle('btn-nuevo-activo', 'form-activo', 'btn-cancelar-activo');
conectarToggle('btn-nueva-cuenta', 'form-cuenta', 'btn-cancelar-cuenta');
conectarToggle('btn-nuevo-movimiento', 'form-movimiento', 'btn-cancelar-movimiento');

// --- CARGA DE DATOS ---
async function cargarTodo() {
  try {
    const terceros = await api('/terceros');
    listaTerceros = terceros;
    mapaTerceros = Object.fromEntries(terceros.map((t) => [t.id, t.nombre]));
    renderTerceros(terceros);
    poblarSelectTodosTerceros('cotizacion-tercero', 'Tercero');
    poblarSelectTodosTerceros('orden-tercero', 'Tercero');
    poblarSelectTodosTerceros('proyecto-contratante', 'Contratante');

    const proyectos = await api('/proyectos');
    listaProyectos = proyectos;
    mapaProyectos = Object.fromEntries(proyectos.map((p) => [p.id, etiquetaProyecto(p)]));
    renderProyectos(proyectos);
    poblarSelectProyectos(proyectos);

    const [cotizaciones, facturasVenta, ordenes, facturasCompra, periodos, productos, activos, cuentas, movBancarios] = await Promise.all([
      api('/ventas/cotizaciones'),
      api('/ventas/facturas'),
      api('/compras/ordenes'),
      api('/compras/facturas'),
      api('/nomina/periodos'),
      api('/inventarios/productos'),
      api('/activos-fijos'),
      api('/tesoreria/cuentas'),
      api('/tesoreria/movimientos'),
    ]);

    renderCotizaciones(cotizaciones);
    renderFacturasVenta(facturasVenta);
    renderOrdenes(ordenes);
    renderFacturasCompra(facturasCompra);
    renderNomina(periodos);
    renderProductos(productos);
    renderActivos(activos);
    renderCuentas(cuentas);
    poblarSelectCuentas(cuentas);
    renderMovimientosBancarios(movBancarios);
  } catch (err) {
    console.error(err);
  }
}

// Muestra TODOS los terceros sin filtrar por tipo — la categorización
// (cliente/proveedor/empleado/otro) es solo una referencia informativa,
// no una restricción. La única excepción real es Nómina, que sí exige
// tipo "empleado" (ver agregarEmpleadoAPeriodo), porque ahí sí importa
// no confundir un proveedor con alguien de la nómina.
function poblarSelectTodosTerceros(selectId, etiqueta) {
  const select = document.getElementById(selectId);
  select.innerHTML =
    `<option value="">${etiqueta}...</option>` +
    listaTerceros.map((t) => `<option value="${t.id}">${t.nombre} (${t.tipo})</option>`).join('');
}

function poblarSelectCuentas(cuentas) {
  const select = document.getElementById('movimiento-cuenta');
  select.innerHTML =
    '<option value="">Cuenta bancaria...</option>' +
    cuentas.map((c) => `<option value="${c.id}">${c.banco} — ${c.numero}</option>`).join('');
}

// "ID — nombre": el ID (centro de costo) va primero porque es lo que
// identifica el proyecto en los documentos; sin ID, solo el nombre.
function etiquetaProyecto(p) {
  return p.codigo ? `${p.codigo} — ${p.nombre}` : p.nombre;
}

function poblarSelectProyectos(proyectos) {
  const select = document.getElementById('orden-proyecto-id');
  select.innerHTML =
    '<option value="">Proyecto / Unidad de negocio (ID)...</option>' +
    proyectos
      .filter((p) => p.activo)
      .map((p) => `<option value="${p.id}">${etiquetaProyecto(p)}</option>`)
      .join('');
}

function nombreProyecto(id) {
  return id ? mapaProyectos[id] || id : '—';
}

// --- RENDER: PROYECTOS ---
function renderProyectos(lista) {
  document.querySelector('#tabla-proyectos thead').innerHTML =
    '<tr><th>ID (centro de costo)</th><th>Nombre</th><th>Contratante</th><th class="num">Valor total</th><th>Objeto</th><th>Estado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-proyectos', 7, 'Todavía no hay proyectos. Crea el primero arriba.');
  document.querySelector('#tabla-proyectos tbody').innerHTML = lista
    .map(
      (p) =>
        `<tr><td><strong>${p.codigo || '—'}</strong></td><td>${p.nombre}</td><td>${nombreTercero(
          p.contratanteId
        )}</td><td class="num">${p.valorTotal ? formatoDinero(p.valorTotal) : '—'}</td><td>${
          p.objeto || '—'
        }</td><td>${badge(p.activo ? 'activo' : 'inactivo')}</td><td class="acciones">${botonAccion('Editar', {
          accion: 'editar-proyecto',
          id: p.id,
        })}</td></tr>`
    )
    .join('');
}

// null = el formulario crea un proyecto nuevo; con un id, edita ese
// proyecto (mismo formulario para las dos cosas, como en Terceros).
let proyectoEditandoId = null;

function salirDeEdicionProyecto() {
  proyectoEditandoId = null;
  document.querySelector('#form-proyecto button[type="submit"]').textContent = 'Guardar';
}

function abrirEdicionProyecto(id) {
  const p = listaProyectos.find((x) => x.id === id);
  if (!p) return;

  proyectoEditandoId = id;
  document.getElementById('form-proyecto').hidden = false;
  document.getElementById('proyecto-nombre').value = p.nombre || '';
  document.getElementById('proyecto-codigo').value = p.codigo || '';
  document.getElementById('proyecto-contratante').value = p.contratanteId || '';
  document.getElementById('proyecto-valor-total').value = p.valorTotal ? Number(p.valorTotal) : '';
  document.getElementById('proyecto-objeto').value = p.objeto || '';
  document.getElementById('proyecto-activo').checked = !!p.activo;

  document.querySelector('#form-proyecto button[type="submit"]').textContent = 'Guardar cambios';
  document.getElementById('form-proyecto').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Si se estaba editando y se pulsa "+ Nuevo proyecto", el formulario
// vuelve en blanco y en modo creación (conectarToggle ya lo alternó).
document.getElementById('btn-nuevo-proyecto').addEventListener('click', () => {
  if (proyectoEditandoId) {
    salirDeEdicionProyecto();
    const form = document.getElementById('form-proyecto');
    form.reset();
    form.hidden = false;
  }
});
document.getElementById('btn-cancelar-proyecto').addEventListener('click', salirDeEdicionProyecto);

conectarFormulario('form-proyecto', async () => {
  const nombre = document.getElementById('proyecto-nombre').value;
  const codigo = document.getElementById('proyecto-codigo').value;
  const contratanteId = document.getElementById('proyecto-contratante').value;
  const valor = document.getElementById('proyecto-valor-total').value;
  const objeto = document.getElementById('proyecto-objeto').value;
  const activo = document.getElementById('proyecto-activo').checked;

  if (proyectoEditandoId) {
    // Al editar, un campo vacío se manda como null para poder BORRAR
    // un dato (con undefined el servidor lo ignoraría y quedaría el viejo).
    await api(`/proyectos/${proyectoEditandoId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        nombre,
        codigo: codigo || null,
        contratanteId: contratanteId || null,
        valorTotal: valor ? Number(valor) : null,
        objeto: objeto || null,
        activo,
      }),
    });
  } else {
    await api('/proyectos', {
      method: 'POST',
      body: JSON.stringify({
        nombre,
        codigo: codigo || undefined,
        contratanteId: contratanteId || undefined,
        valorTotal: valor ? Number(valor) : undefined,
        objeto: objeto || undefined,
        activo,
      }),
    });
  }

  // Solo se sale del modo edición si la llamada tuvo éxito.
  salirDeEdicionProyecto();
});

// --- RENDER: TERCEROS ---
function renderTerceros(lista) {
  document.querySelector('#tabla-terceros thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th>Persona</th><th>Identificación</th><th>Celular</th><th>Correo</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-terceros', 7, 'Todavía no hay terceros. Crea el primero arriba.');
  document.querySelector('#tabla-terceros tbody').innerHTML = lista
    .map(
      (t) =>
        `<tr><td>${t.nombre}</td><td>${t.tipo}</td><td>${t.tipoPersona || '—'}</td><td>${
          t.identificacion
        }</td><td>${t.celular || '—'}</td><td>${t.email || '—'}</td><td class="acciones">${botonAccion(
          'Editar',
          { accion: 'editar-tercero', id: t.id }
        )}</td></tr>`
    )
    .join('');
}

// --- RENDER: COTIZACIONES (con acciones según estado) ---
function renderCotizaciones(lista) {
  document.querySelector('#tabla-cotizaciones thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Vence</th><th>Cliente</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cotizaciones', 7, 'Todavía no hay cotizaciones.');
  document.querySelector('#tabla-cotizaciones tbody').innerHTML = lista
    .map((c) => {
      let acciones =
        botonAccion('Ver ítems', { accion: 'ver-items-cotizacion', id: c.id }) +
        botonAccion('Ver PDF', { accion: 'ver-pdf-cotizacion', id: c.id });
      if (c.estado === 'borrador')
        acciones +=
          botonAccion('Editar', { accion: 'editar-cotizacion', id: c.id }) +
          botonAccion('Enviar', { accion: 'enviar-cotizacion', id: c.id });
      else if (c.estado === 'enviada')
        acciones +=
          botonAccion('Aceptar', { accion: 'aceptar-cotizacion', id: c.id }) +
          botonAccion('Rechazar', { accion: 'rechazar-cotizacion', id: c.id }, true);
      else if (c.estado === 'aceptada') acciones += botonAccion('Convertir en factura', { accion: 'convertir-cotizacion', id: c.id });

      return `<tr data-fila-cotizacion="${c.id}"><td>${c.consecutivo || '—'}</td><td>${formatoFecha(
        c.fecha
      )}</td><td>${formatoFecha(c.fechaVencimiento)}</td><td>${nombreTercero(c.terceroId)}</td><td>${badge(
        c.estado
      )}</td><td class="num">${formatoDinero(c.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasVenta(lista) {
  document.querySelector('#tabla-facturas-venta thead').innerHTML =
    '<tr><th>Fecha</th><th>Cliente</th><th>DIAN</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-venta', 4, 'Todavía no hay facturas de venta.');
  document.querySelector('#tabla-facturas-venta tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoSincronizacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

// --- RENDER: ÓRDENES DE ADQUISICIÓN ---
function renderOrdenes(lista) {
  document.querySelector('#tabla-ordenes thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Proveedor</th><th>Proyecto</th><th>Tipo</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-ordenes', 8, 'Todavía no hay órdenes de adquisición.');
  document.querySelector('#tabla-ordenes tbody').innerHTML = lista
    .map((o) => {
      let acciones =
        botonAccion('Ver ítems', { accion: 'ver-items-orden', id: o.id }) +
        botonAccion('Ver PDF', { accion: 'ver-pdf-orden', id: o.id });

      if (['borrador', 'emitida'].includes(o.estado)) {
        if (o.estado === 'borrador') acciones += botonAccion('Editar', { accion: 'editar-orden', id: o.id });
        acciones += botonAccion('Aprobar', { accion: 'aprobar-orden', id: o.id });
      } else if (['aprobada', 'recibida_parcial', 'recibida_total'].includes(o.estado)) {
        acciones += botonAccion('Convertir en factura', { accion: 'convertir-orden', id: o.id });
      }

      const proyecto = o.proyectoId ? nombreProyecto(o.proyectoId) : o.proyecto || '—';

      return `<tr data-fila-orden="${o.id}"><td>${o.consecutivo || '—'}</td><td>${formatoFecha(
        o.fecha
      )}</td><td>${nombreTercero(o.terceroId)}</td><td>${proyecto}</td><td>${o.tipo}</td><td>${badge(
        o.estado
      )}</td><td class="num">${formatoDineroDec(o.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasCompra(lista) {
  document.querySelector('#tabla-facturas-compra thead').innerHTML =
    '<tr><th>Fecha</th><th>Proveedor</th><th>Conciliación</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-compra', 4, 'Todavía no hay facturas de compra.');
  document.querySelector('#tabla-facturas-compra tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoConciliacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

// --- RENDER: NÓMINA ---
function renderNomina(lista) {
  document.querySelector('#tabla-nomina thead').innerHTML = '<tr><th>Periodo</th><th>Estado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-nomina', 3, 'Todavía no hay periodos de nómina.');
  document.querySelector('#tabla-nomina tbody').innerHTML = lista
    .map((p) => {
      let acciones = '—';
      if (p.estado === 'borrador')
        acciones =
          botonAccion('Agregar empleado', { accion: 'agregar-empleado', id: p.id }) +
          botonAccion('Liquidar', { accion: 'liquidar-periodo', id: p.id });

      return `<tr><td>${formatoFecha(p.fechaInicio)} — ${formatoFecha(p.fechaFin)}</td><td>${badge(
        p.estado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: INVENTARIOS ---
function renderProductos(lista) {
  document.querySelector('#tabla-productos thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Costo promedio</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-productos', 5, 'Todavía no hay productos. Crea el primero arriba.');
  document.querySelector('#tabla-productos tbody').innerHTML = lista
    .map((p) => {
      const acciones =
        botonAccion('Entrada', { accion: 'entrada-inventario', id: p.id }) +
        botonAccion('Salida', { accion: 'salida-inventario', id: p.id }) +
        botonAccion('Ajuste', { accion: 'ajuste-inventario', id: p.id }, true);
      return `<tr><td>${p.nombre}</td><td>${p.tipo}</td><td class="num">${Number(p.cantidadDisponible).toLocaleString(
        'es-CO'
      )}</td><td class="num">${formatoDinero(p.costoPromedio)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: ACTIVOS FIJOS ---
function renderActivos(lista) {
  document.querySelector('#tabla-activos thead').innerHTML =
    '<tr><th>Nombre</th><th>Adquisición</th><th>Estado</th><th class="num">Costo</th><th class="num">Depreciado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-activos', 6, 'Todavía no hay activos fijos registrados.');
  document.querySelector('#tabla-activos tbody').innerHTML = lista
    .map((a) => {
      const acciones = a.estado === 'activo' ? botonAccion('Dar de baja', { accion: 'baja-activo', id: a.id }, true) : '—';
      return `<tr><td>${a.nombre}</td><td>${formatoFecha(a.fechaAdquisicion)}</td><td>${badge(
        a.estado
      )}</td><td class="num">${formatoDinero(a.costo)}</td><td class="num">${formatoDinero(
        a.valorDepreciadoAcumulado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: TESORERÍA ---
function renderCuentas(lista) {
  document.querySelector('#tabla-cuentas thead').innerHTML = '<tr><th>Banco</th><th>Número</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cuentas', 2, 'Todavía no hay cuentas bancarias registradas.');
  document.querySelector('#tabla-cuentas tbody').innerHTML = lista
    .map((c) => `<tr><td>${c.banco}</td><td>${c.numero}</td></tr>`)
    .join('');
}

function renderMovimientosBancarios(lista) {
  document.querySelector('#tabla-movimientos-bancarios thead').innerHTML =
    '<tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Conciliado</th><th class="num">Valor</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-movimientos-bancarios', 6, 'Todavía no hay movimientos bancarios registrados.');
  document.querySelector('#tabla-movimientos-bancarios tbody').innerHTML = lista
    .map((m) => {
      const acciones = m.conciliado ? '—' : botonAccion('Conciliar', { accion: 'conciliar-movimiento', id: m.id });
      return `<tr><td>${formatoFecha(m.fecha)}</td><td>${m.tipo}</td><td>${m.descripcion || '—'}</td><td>${
        m.conciliado ? badge('conciliado') : badge('pendiente')
      }</td><td class="num">${formatoDinero(m.valor)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- FORMULARIOS DE CREACIÓN ---
function conectarFormulario(formId, alEnviar) {
  const form = document.getElementById(formId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await alEnviar();
      form.reset();
      form.hidden = true;
      cargarTodo();
    } catch (err) {
      alert(err.message);
    }
  });
}

// null = el formulario está creando un tercero nuevo; con un id, está
// editando ese tercero existente (mismo formulario para las dos cosas).
let terceroEditandoId = null;

function abrirEdicionTercero(id) {
  const t = listaTerceros.find((x) => x.id === id);
  if (!t) return;

  terceroEditandoId = id;
  document.getElementById('form-tercero').hidden = false;
  document.getElementById('tercero-tipo').value = t.tipo || 'cliente';
  document.getElementById('tercero-tipo-persona').value = t.tipoPersona || '';
  document.getElementById('tercero-identificacion').value = t.identificacion || '';
  document.getElementById('tercero-nombre').value = t.nombre || '';
  document.getElementById('tercero-email').value = t.email || '';
  document.getElementById('tercero-celular').value = t.celular || '';
  document.getElementById('tercero-direccion').value = t.direccion || '';
  document.getElementById('tercero-departamento').value = t.departamento || '';
  document.getElementById('tercero-municipio').value = t.municipio || '';
  document.getElementById('tercero-regimen-iva').value = t.regimenIva || '';
  document.getElementById('tercero-cuenta-tipo').value = t.cuentaBancariaTipo || '';
  document.getElementById('tercero-cuenta-banco').value = t.cuentaBancariaBanco || '';
  document.getElementById('tercero-cuenta-numero').value = t.cuentaBancariaNumero || '';

  const responsabilidades = t.responsabilidadesFiscales || [];
  document.querySelectorAll('.chk-responsabilidad').forEach((chk) => {
    chk.checked = responsabilidades.includes(chk.value);
  });

  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar cambios';
  document.getElementById('form-tercero').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Cancelar también sale del modo edición, no solo limpia el formulario.
document.getElementById('btn-cancelar-tercero').addEventListener('click', () => {
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});

conectarFormulario('form-tercero', async () => {
  const responsabilidades = Array.from(document.querySelectorAll('.chk-responsabilidad:checked')).map((c) => c.value);
  const datos = {
    tipo: document.getElementById('tercero-tipo').value,
    tipoPersona: document.getElementById('tercero-tipo-persona').value || undefined,
    identificacion: document.getElementById('tercero-identificacion').value,
    nombre: document.getElementById('tercero-nombre').value,
    email: document.getElementById('tercero-email').value || undefined,
    celular: document.getElementById('tercero-celular').value || undefined,
    direccion: document.getElementById('tercero-direccion').value || undefined,
    departamento: document.getElementById('tercero-departamento').value || undefined,
    municipio: document.getElementById('tercero-municipio').value || undefined,
    regimenIva: document.getElementById('tercero-regimen-iva').value || undefined,
    cuentaBancariaTipo: document.getElementById('tercero-cuenta-tipo').value || undefined,
    cuentaBancariaBanco: document.getElementById('tercero-cuenta-banco').value || undefined,
    cuentaBancariaNumero: document.getElementById('tercero-cuenta-numero').value || undefined,
    responsabilidadesFiscales: responsabilidades.length > 0 ? responsabilidades : undefined,
  };

  if (terceroEditandoId) {
    await api(`/terceros/${terceroEditandoId}`, { method: 'PATCH', body: JSON.stringify(datos) });
  } else {
    await api('/terceros', { method: 'POST', body: JSON.stringify(datos) });
  }

  // Solo se limpia el modo edición si la llamada anterior tuvo éxito —
  // si falla, el formulario se queda abierto y editable para reintentar.
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});

// --- ÍTEMS DINÁMICOS DE COTIZACIÓN ---
const UNIDADES_MEDIDA = ['UND', 'KG', 'M', 'M2', 'M3', 'HR', 'DIA', 'MES', 'GLB', 'SERV', 'LT', 'GAL'];

// value = "tipoImpuesto-porcentaje". "otro" deja el % en blanco para
// que el usuario lo escriba a mano (ver el input que aparece al lado).
const OPCIONES_IMPUESTO = [
  { value: 'iva-19', texto: 'IVA 19%' },
  { value: 'iva-5', texto: 'IVA 5%' },
  { value: 'iva-0', texto: 'IVA 0%' },
  { value: 'impoconsumo-4', texto: 'Impoconsumo 4%' },
  { value: 'impoconsumo-8', texto: 'Impoconsumo 8%' },
  { value: 'impoconsumo-16', texto: 'Impoconsumo 16%' },
  { value: 'exento-0', texto: 'Exento' },
  { value: 'otro-', texto: 'Otro (definir %)' },
];

// Si se pasa "item", la fila nace precargada con sus datos — se usa
// tanto para "+ Agregar ítem" (sin argumento, fila en blanco) como para
// abrir una cotización existente en modo edición.
function crearFilaItemCotizacion(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="item-concepto" placeholder="Concepto" required></td>
    <td><input type="number" class="item-cantidad" placeholder="Cant." min="0" step="0.01" required></td>
    <td><select class="item-um">${UNIDADES_MEDIDA.map((u) => `<option value="${u}">${u}</option>`).join('')}</select></td>
    <td><input type="number" class="item-valor-unitario" placeholder="Valor unit." min="0" required></td>
    <td>
      <select class="item-tipo-impuesto">${OPCIONES_IMPUESTO.map((o) => `<option value="${o.value}">${o.texto}</option>`).join('')}</select>
      <input type="number" class="item-impuesto-manual" min="0" max="100" placeholder="%" hidden>
    </td>
    <td class="num item-total-texto">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-item">Quitar</button></td>
  `;
  tr.querySelectorAll('input').forEach((input) => input.addEventListener('input', recalcularTotalesCotizacion));
  tr.querySelector('.item-tipo-impuesto').addEventListener('change', (e) => {
    const manual = tr.querySelector('.item-impuesto-manual');
    manual.hidden = !e.target.value.startsWith('otro-');
    recalcularTotalesCotizacion();
  });
  tr.querySelector('.btn-quitar-item').addEventListener('click', () => {
    tr.remove();
    recalcularTotalesCotizacion();
  });

  if (item) {
    tr.querySelector('.item-concepto').value = item.concepto;
    tr.querySelector('.item-cantidad').value = item.cantidad;
    tr.querySelector('.item-um').value = item.unidadMedida;
    tr.querySelector('.item-valor-unitario').value = item.valorUnitario;

    const selectImpuesto = tr.querySelector('.item-tipo-impuesto');
    const valorCombinado = `${item.tipoImpuesto}-${item.impuestoPorcentaje}`;
    const coincide = Array.from(selectImpuesto.options).some((o) => o.value === valorCombinado);
    if (coincide) {
      selectImpuesto.value = valorCombinado;
    } else {
      // Porcentaje que no está en los presets (ej. 12%) — se guarda
      // igual, solo se muestra como "Otro" con el % manual visible.
      selectImpuesto.value = 'otro-';
      const manual = tr.querySelector('.item-impuesto-manual');
      manual.hidden = false;
      manual.value = item.impuestoPorcentaje;
    }
  }

  return tr;
}

document.getElementById('btn-agregar-item-cotizacion').addEventListener('click', () => {
  document.getElementById('items-cotizacion-tbody').appendChild(crearFilaItemCotizacion());
});

function leerImpuestoFila(fila) {
  const seleccion = fila.querySelector('.item-tipo-impuesto').value; // "tipo-porcentaje"
  const [tipoImpuesto, porcentajeTexto] = seleccion.split('-');
  if (tipoImpuesto === 'otro') {
    const manual = Number(fila.querySelector('.item-impuesto-manual').value || 0);
    return { tipoImpuesto: 'iva', impuestoPorcentaje: manual }; // "otro" se guarda como IVA con % manual
  }
  return { tipoImpuesto, impuestoPorcentaje: Number(porcentajeTexto) };
}

function leerItemsCotizacion() {
  const filas = document.querySelectorAll('#items-cotizacion-tbody tr');
  return Array.from(filas).map((fila) => {
    const cantidad = Number(fila.querySelector('.item-cantidad').value || 0);
    const valorUnitario = Number(fila.querySelector('.item-valor-unitario').value || 0);
    const { tipoImpuesto, impuestoPorcentaje } = leerImpuestoFila(fila);
    const valorTotal = cantidad * valorUnitario;
    fila.querySelector('.item-total-texto').textContent = formatoDinero(valorTotal);
    return {
      concepto: fila.querySelector('.item-concepto').value,
      cantidad,
      unidadMedida: fila.querySelector('.item-um').value,
      valorUnitario,
      tipoImpuesto,
      impuestoPorcentaje,
      valorTotal,
    };
  });
}

function recalcularTotalesCotizacion() {
  const items = leerItemsCotizacion();
  const subtotal = items.reduce((s, i) => s + i.valorTotal, 0);

  const aplicaAiu = document.getElementById('cotizacion-aplica-aiu').checked;
  let baseIva = subtotal;
  if (aplicaAiu) {
    const admin = subtotal * (Number(document.getElementById('cotizacion-aiu-administracion').value || 0) / 100);
    const imprevistos = subtotal * (Number(document.getElementById('cotizacion-aiu-imprevistos').value || 0) / 100);
    const utilidad = subtotal * (Number(document.getElementById('cotizacion-aiu-utilidad').value || 0) / 100);
    baseIva = subtotal + admin + imprevistos + utilidad;

    document.getElementById('valor-aiu-administracion').textContent = formatoDinero(admin);
    document.getElementById('valor-aiu-imprevistos').textContent = formatoDinero(imprevistos);
    document.getElementById('valor-aiu-utilidad').textContent = formatoDinero(utilidad);
  }
  const iva = baseIva * 0.19;
  const total = baseIva + iva;

  document.getElementById('resumen-subtotal').textContent = formatoDinero(subtotal);
  document.getElementById('resumen-iva').textContent = formatoDinero(iva);
  document.getElementById('resumen-total').textContent = formatoDinero(total);
}

document.getElementById('cotizacion-aplica-aiu').addEventListener('change', (e) => {
  document.getElementById('campos-aiu').hidden = !e.target.checked;
  recalcularTotalesCotizacion();
});
document.querySelectorAll('#campos-aiu input').forEach((el) => el.addEventListener('input', recalcularTotalesCotizacion));

function limpiarFormularioCotizacion() {
  document.getElementById('items-cotizacion-tbody').innerHTML = '';
  document.getElementById('campos-aiu').hidden = true;
  document.getElementById('cotizacion-aplica-aiu').checked = false;
  cotizacionEditandoId = null;
  document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar';
  recalcularTotalesCotizacion();
}

// null = el formulario está creando una cotización nueva; con un id,
// está editando esa cotización existente (mismo formulario, igual que
// con Terceros).
let cotizacionEditandoId = null;

async function abrirEdicionCotizacion(id) {
  try {
    const cotizacion = await api(`/ventas/cotizaciones/${id}`);
    if (cotizacion.estado !== 'borrador') {
      alert('Solo se puede editar una cotización en estado "borrador".');
      return;
    }

    cotizacionEditandoId = id;
    document.getElementById('form-cotizacion').hidden = false;
    document.getElementById('cotizacion-tercero').value = cotizacion.terceroId;
    document.getElementById('cotizacion-vencimiento').value = cotizacion.fechaVencimiento;
    document.getElementById('cotizacion-forma-pago').value = cotizacion.formaPago || '';
    document.getElementById('cotizacion-observaciones').value = cotizacion.observaciones || '';
    document.getElementById('cotizacion-contacto-nombre').value = cotizacion.contactoNombre || '';
    document.getElementById('cotizacion-contacto-telefono').value = cotizacion.contactoTelefono || '';

    document.getElementById('cotizacion-aplica-aiu').checked = cotizacion.aplicaAiu;
    document.getElementById('campos-aiu').hidden = !cotizacion.aplicaAiu;
    document.getElementById('cotizacion-aiu-administracion').value = cotizacion.aiuAdministracion || '';
    document.getElementById('cotizacion-aiu-imprevistos').value = cotizacion.aiuImprevistos || '';
    document.getElementById('cotizacion-aiu-utilidad').value = cotizacion.aiuUtilidad || '';

    const tbody = document.getElementById('items-cotizacion-tbody');
    tbody.innerHTML = '';
    const items = cotizacion.items || [];
    if (items.length > 0) items.forEach((item) => tbody.appendChild(crearFilaItemCotizacion(item)));
    else tbody.appendChild(crearFilaItemCotizacion());

    recalcularTotalesCotizacion();
    document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar cambios';
    document.getElementById('form-cotizacion').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert(err.message);
  }
}

// Empieza con un ítem en blanco listo para llenar, en vez de una tabla vacía.
document.getElementById('btn-nueva-cotizacion').addEventListener('click', () => {
  cotizacionEditandoId = null;
  document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar';
  if (document.getElementById('items-cotizacion-tbody').children.length === 0) {
    document.getElementById('items-cotizacion-tbody').appendChild(crearFilaItemCotizacion());
  }
});
document.getElementById('btn-cancelar-cotizacion').addEventListener('click', limpiarFormularioCotizacion);

conectarFormulario('form-cotizacion', async () => {
  const items = leerItemsCotizacion();
  if (items.length === 0 || items.some((i) => !i.concepto || i.cantidad <= 0)) {
    throw new Error('Agrega al menos un ítem con concepto y cantidad mayor a cero.');
  }

  const cuerpo = {
    terceroId: document.getElementById('cotizacion-tercero').value,
    fechaVencimiento: document.getElementById('cotizacion-vencimiento').value,
    formaPago: document.getElementById('cotizacion-forma-pago').value || undefined,
    observaciones: document.getElementById('cotizacion-observaciones').value || undefined,
    contactoNombre: document.getElementById('cotizacion-contacto-nombre').value || undefined,
    contactoTelefono: document.getElementById('cotizacion-contacto-telefono').value || undefined,
    aplicaAiu: document.getElementById('cotizacion-aplica-aiu').checked,
    aiuAdministracion: Number(document.getElementById('cotizacion-aiu-administracion').value || 0),
    aiuImprevistos: Number(document.getElementById('cotizacion-aiu-imprevistos').value || 0),
    aiuUtilidad: Number(document.getElementById('cotizacion-aiu-utilidad').value || 0),
    items,
  };

  if (cotizacionEditandoId) {
    await api(`/ventas/cotizaciones/${cotizacionEditandoId}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  } else {
    await api('/ventas/cotizaciones', { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  limpiarFormularioCotizacion();
  document.getElementById('form-cotizacion').hidden = true;
});

// --- VER ÍTEMS de una cotización existente (fila expandible) ---
async function verItemsCotizacion(id) {
  const filaDetalleExistente = document.getElementById('detalle-cotizacion-' + id);
  if (filaDetalleExistente) {
    filaDetalleExistente.remove();
    return;
  }

  try {
    const cotizacion = await api(`/ventas/cotizaciones/${id}`);
    const filaOriginal = document.querySelector(`tr[data-fila-cotizacion="${id}"]`);
    if (!filaOriginal) return;

    const itemsHtml = (cotizacion.items || [])
      .map(
        (it) =>
          `<tr><td>${it.concepto}</td><td class="num">${Number(it.cantidad).toLocaleString('es-CO')} ${
            it.unidadMedida
          }</td><td class="num">${formatoDinero(it.valorUnitario)}</td><td class="num">${etiquetaImpuesto(
            it.tipoImpuesto,
            it.impuestoPorcentaje
          )}</td><td class="num">${formatoDinero(it.valorTotal)}</td></tr>`
      )
      .join('');

    const tr = document.createElement('tr');
    tr.id = 'detalle-cotizacion-' + id;
    tr.innerHTML = `<td colspan="7"><div class="detalle-items">
      <table class="tabla-items-detalle">
        <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead>
        <tbody>${
          itemsHtml ||
          '<tr><td colspan="5" class="vacio">Esta cotización no tiene ítems registrados (se creó antes de esta función).</td></tr>'
        }</tbody>
      </table>
      ${
        cotizacion.aplicaAiu
          ? `<p class="nota-aiu">AIU aplicado — Administración ${cotizacion.aiuAdministracion}% · Imprevistos ${cotizacion.aiuImprevistos}% · Utilidad ${cotizacion.aiuUtilidad}%</p>`
          : ''
      }
    </div></td>`;
    filaOriginal.after(tr);
  } catch (err) {
    alert(err.message);
  }
}

// --- ÍTEMS DINÁMICOS DE ORDEN (mismo patrón que cotización) ---
// Reutiliza UNIDADES_MEDIDA, OPCIONES_IMPUESTO y etiquetaImpuesto, que
// ya están definidos más arriba para los ítems de cotización.
function crearFilaItemOrden(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="item-concepto" placeholder="Concepto" required></td>
    <td><input type="number" class="item-cantidad" placeholder="Cant." min="0" step="0.01" required></td>
    <td><select class="item-um">${UNIDADES_MEDIDA.map((u) => `<option value="${u}">${u}</option>`).join('')}</select></td>
    <td><input type="number" class="item-valor-unitario" placeholder="Valor unit." min="0" required></td>
    <td>
      <select class="item-tipo-impuesto">${OPCIONES_IMPUESTO.map((o) => `<option value="${o.value}">${o.texto}</option>`).join('')}</select>
      <input type="number" class="item-impuesto-manual" min="0" max="100" placeholder="%" hidden>
    </td>
    <td class="num item-total-texto">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-item">Quitar</button></td>
  `;
  tr.querySelectorAll('input').forEach((input) => input.addEventListener('input', recalcularTotalesOrden));
  tr.querySelector('.item-tipo-impuesto').addEventListener('change', (e) => {
    const manual = tr.querySelector('.item-impuesto-manual');
    manual.hidden = !e.target.value.startsWith('otro-');
    recalcularTotalesOrden();
  });
  tr.querySelector('.btn-quitar-item').addEventListener('click', () => {
    tr.remove();
    recalcularTotalesOrden();
  });

  if (item) {
    tr.querySelector('.item-concepto').value = item.concepto;
    tr.querySelector('.item-cantidad').value = item.cantidad;
    tr.querySelector('.item-um').value = item.unidadMedida;
    tr.querySelector('.item-valor-unitario').value = item.valorUnitario;

    const selectImpuesto = tr.querySelector('.item-tipo-impuesto');
    const valorCombinado = `${item.tipoImpuesto}-${item.impuestoPorcentaje}`;
    const coincide = Array.from(selectImpuesto.options).some((o) => o.value === valorCombinado);
    if (coincide) {
      selectImpuesto.value = valorCombinado;
    } else {
      selectImpuesto.value = 'otro-';
      const manual = tr.querySelector('.item-impuesto-manual');
      manual.hidden = false;
      manual.value = item.impuestoPorcentaje;
    }
  }

  return tr;
}

document.getElementById('btn-agregar-item-orden').addEventListener('click', () => {
  document.getElementById('items-orden-tbody').appendChild(crearFilaItemOrden());
});

function leerItemsOrden() {
  const filas = document.querySelectorAll('#items-orden-tbody tr');
  return Array.from(filas).map((fila) => {
    const cantidad = Number(fila.querySelector('.item-cantidad').value || 0);
    const valorUnitario = Number(fila.querySelector('.item-valor-unitario').value || 0);
    const seleccion = fila.querySelector('.item-tipo-impuesto').value;
    const [tipoBruto, porcentajeTexto] = seleccion.split('-');
    let tipoImpuesto = tipoBruto;
    let impuestoPorcentaje = Number(porcentajeTexto);
    if (tipoBruto === 'otro') {
      tipoImpuesto = 'iva';
      impuestoPorcentaje = Number(fila.querySelector('.item-impuesto-manual').value || 0);
    }
    const valorTotal = cantidad * valorUnitario;
    fila.querySelector('.item-total-texto').textContent = formatoDinero(valorTotal);
    return {
      concepto: fila.querySelector('.item-concepto').value,
      cantidad,
      unidadMedida: fila.querySelector('.item-um').value,
      valorUnitario,
      tipoImpuesto,
      impuestoPorcentaje,
      valorTotal,
    };
  });
}

// --- RETENCIÓN EN LA FUENTE (catálogo 2026, ver retencionesCatalogo.js) ---
// Desplegable de conceptos agrupado por categoría.
function opcionesConceptoRetencionHtml() {
  const cat = retencionesCatalogo;
  const grupos = {};
  cat.CONCEPTOS.forEach((c) => (grupos[c.categoria] = grupos[c.categoria] || []).push(c));
  const porGrupo = Object.entries(grupos)
    .map(
      ([nombre, lista]) =>
        `<optgroup label="${nombre}">` +
        lista
          .map(
            (c) =>
              `<option value="${c.codigo}" title="${(c.detalle || c.nombre).replace(/"/g, '&quot;')}">${c.nombre} — ${c.tarifa.toLocaleString('es-CO')}%</option>`
          )
          .join('') +
        '</optgroup>'
    )
    .join('');
  return `<option value="">Elegir concepto...</option>${porGrupo}<option value="${cat.CONCEPTO_MANUAL.codigo}">${cat.CONCEPTO_MANUAL.nombre}</option>`;
}

function crearFilaRetencion(linea) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="item-ret-concepto">${opcionesConceptoRetencionHtml()}</select>
      <span class="ret-nota" hidden></span>
    </td>
    <td><input type="number" class="item-ret-tarifa" min="0" max="100" step="0.01" placeholder="%" readonly> %</td>
    <td class="num ret-base">—</td>
    <td class="num ret-tope">—</td>
    <td class="num ret-valor">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-retencion">Quitar</button></td>
  `;
  const select = tr.querySelector('.item-ret-concepto');
  const tarifa = tr.querySelector('.item-ret-tarifa');
  select.addEventListener('change', () => {
    const concepto = retencionesCatalogo.porCodigo(select.value);
    // La tarifa sale del catálogo; solo "Otro concepto" se digita a mano.
    tarifa.readOnly = !(concepto && concepto.manual);
    tarifa.value = concepto ? (concepto.manual ? '' : concepto.tarifa) : '';
    recalcularTotalesOrden();
  });
  tarifa.addEventListener('input', recalcularTotalesOrden);
  tr.querySelector('.btn-quitar-retencion').addEventListener('click', () => {
    tr.remove();
    recalcularTotalesOrden();
  });

  if (linea) {
    select.value = linea.codigo || '';
    const concepto = retencionesCatalogo.porCodigo(select.value);
    tarifa.readOnly = !(concepto && concepto.manual);
    tarifa.value = linea.tarifa !== undefined && linea.tarifa !== null ? Number(linea.tarifa) : '';
  }
  return tr;
}

function modoRetencionOrden() {
  return document.querySelector('input[name="orden-retencion-modo"]:checked').value;
}

// Lo que se manda al servidor por cada retención: solo el código (y la
// tarifa si es "Otro concepto"). El servidor toma lo demás del catálogo.
function leerRetencionesOrden() {
  return Array.from(document.querySelectorAll('#retenciones-orden-tbody tr')).map((tr) => {
    const codigo = tr.querySelector('.item-ret-concepto').value;
    const concepto = retencionesCatalogo.porCodigo(codigo);
    return {
      codigo,
      tarifa: concepto && concepto.manual ? Number(tr.querySelector('.item-ret-tarifa').value || 0) : undefined,
    };
  });
}

// Junta lo que hay en el formulario con la forma que espera
// calcularOrden() (el mismo cálculo que corre el servidor al guardar).
function leerDatosOrden() {
  const tipo = document.getElementById('orden-tipo').value;
  const aplicaAiu = tipo === 'servicios' && document.getElementById('orden-aplica-aiu').checked;
  const retencionModo = modoRetencionOrden();

  return {
    tipo,
    items: leerItemsOrden(),
    aplicaAiu,
    aiuAdministracion: Number(document.getElementById('orden-aiu-administracion').value || 0),
    aiuImprevistos: Number(document.getElementById('orden-aiu-imprevistos').value || 0),
    aiuUtilidad: Number(document.getElementById('orden-aiu-utilidad').value || 0),
    aiuBaseIva: document.getElementById('orden-aiu-base-iva').value,
    retencionModo,
    retencionMotivo: document.getElementById('orden-retencion-motivo').value,
    retencionDetalle: document.getElementById('orden-retencion-detalle').value,
    // Una especificación por fila (aunque esté a medias, queda en cero)
    // para poder pintar cada resultado en su propia fila.
    retenciones:
      retencionModo === 'aplica'
        ? leerRetencionesOrden().map((r) => retencionesCatalogo.especificar(r, { estricto: false }))
        : [],
  };
}

function recalcularTotalesOrden() {
  // estricto:false → mientras se digita no se lanzan errores (ej.
  // retención sin concepto todavía); el servidor sí valida al guardar.
  const datos = leerDatosOrden();
  const { cabecera: c, netoAPagar } = calcularOrden(datos, { estricto: false });

  document.getElementById('valor-orden-aiu-administracion').textContent = formatoDineroDec(c.aiuAdministracionValor);
  document.getElementById('valor-orden-aiu-imprevistos').textContent = formatoDineroDec(c.aiuImprevistosValor);
  document.getElementById('valor-orden-aiu-utilidad').textContent = formatoDineroDec(c.aiuUtilidadValor);

  // Cada fila de retención muestra su base, su tope y su valor.
  document.querySelectorAll('#retenciones-orden-tbody tr').forEach((tr, i) => {
    const l = c.retenciones[i];
    if (!l) return;
    tr.querySelector('.ret-base').textContent = l.codigo ? formatoDineroDec(l.base) : '—';
    tr.querySelector('.ret-tope').textContent = l.codigo ? (l.baseMinima > 0 ? formatoDineroDec(l.baseMinima) : 'Sin tope') : '—';
    const valor = tr.querySelector('.ret-valor');
    valor.textContent = formatoDineroDec(l.valor);
    valor.classList.toggle('ret-sin-efecto', l.valor === 0);
    const nota = tr.querySelector('.ret-nota');
    nota.textContent = l.nota;
    nota.hidden = !l.nota;
  });

  document.getElementById('resumen-subtotal-orden').textContent = formatoDineroDec(c.subtotal);
  document.getElementById('resumen-aiu-orden').textContent = formatoDineroDec(c.aiuTotal);
  document.getElementById('resumen-aiu-orden-fila').hidden = !c.aplicaAiu;
  document.getElementById('resumen-iva-orden').textContent = formatoDineroDec(c.iva);
  document.getElementById('resumen-impoconsumo-orden').textContent = formatoDineroDec(c.impoconsumo);
  document.getElementById('resumen-total-orden').textContent = formatoDineroDec(c.total);

  const aplica = c.retencionModo === 'aplica';
  const noAplica = c.retencionModo === 'no_aplica';
  document.getElementById('resumen-retencion-orden').textContent = noAplica
    ? 'No aplica' + (c.retencionMotivo ? ' — ' + c.retencionMotivo : '')
    : '− ' + formatoDineroDec(c.retencionValor);
  document.getElementById('resumen-retencion-orden-fila').hidden = !(aplica || noAplica);
  document.getElementById('resumen-neto-orden').textContent = formatoDineroDec(netoAPagar);
  document.getElementById('resumen-neto-orden-fila').hidden = !(aplica || noAplica);

  document.getElementById('nota-retencion-orden').textContent =
    `Conceptos y tarifas ${retencionesCatalogo.ANIO} (UVT ${formatoDineroDec(retencionesCatalogo.UVT_VALOR)}). ` +
    'Elige el concepto según el bien o servicio de la orden. La base se mide antes de impuestos; si no alcanza el tope mínimo, esa retención no se practica. ' +
    'Si el proveedor no está sujeto (Régimen Simple, tratamiento especial), usa "No aplica retención".';
}

// Muestra/oculta los bloques según el tipo de orden y las opciones.
// El AIU solo existe en compra de SERVICIOS; al pasar a "bienes" se
// apaga para que no quede un AIU "fantasma" afectando el total.
function actualizarVisibilidadOrden() {
  const esServicios = document.getElementById('orden-tipo').value === 'servicios';
  document.getElementById('bloque-aiu-orden').hidden = !esServicios;
  if (!esServicios) document.getElementById('orden-aplica-aiu').checked = false;

  document.getElementById('campos-aiu-orden').hidden = !document.getElementById('orden-aplica-aiu').checked;

  const modo = modoRetencionOrden();
  document.getElementById('retencion-aplica-orden').hidden = modo !== 'aplica';
  document.getElementById('retencion-no-aplica-orden').hidden = modo !== 'no_aplica';
  // Al elegir "Aplicar" aparece ya la primera fila para elegir concepto.
  const tbody = document.getElementById('retenciones-orden-tbody');
  if (modo === 'aplica' && tbody.children.length === 0) tbody.appendChild(crearFilaRetencion());
}

document.getElementById('orden-tipo').addEventListener('change', () => {
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
});
document.getElementById('orden-aplica-aiu').addEventListener('change', () => {
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
});
document.querySelectorAll('input[name="orden-retencion-modo"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    actualizarVisibilidadOrden();
    recalcularTotalesOrden();
  })
);
document.getElementById('btn-agregar-retencion-orden').addEventListener('click', () => {
  document.getElementById('retenciones-orden-tbody').appendChild(crearFilaRetencion());
});
document.getElementById('orden-retencion-motivo').innerHTML =
  '<option value="">Elegir motivo...</option>' +
  retencionesCatalogo.MOTIVOS_NO_APLICA.map((m) => `<option value="${m}">${m}</option>`).join('');
document
  .querySelectorAll('#campos-aiu-orden input, #campos-aiu-orden select, #orden-retencion-motivo, #orden-retencion-detalle')
  .forEach((el) => {
    el.addEventListener('input', recalcularTotalesOrden);
    el.addEventListener('change', recalcularTotalesOrden);
  });

function limpiarFormularioOrden() {
  document.getElementById('items-orden-tbody').innerHTML = '';
  ordenEditandoId = null;
  document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar';

  document.getElementById('orden-aplica-aiu').checked = false;
  ['administracion', 'imprevistos', 'utilidad'].forEach((n) => (document.getElementById('orden-aiu-' + n).value = ''));
  document.getElementById('orden-aiu-base-iva').value = 'total';

  document.querySelector('input[name="orden-retencion-modo"][value="ninguna"]').checked = true;
  document.getElementById('retenciones-orden-tbody').innerHTML = '';
  document.getElementById('orden-retencion-motivo').value = '';
  document.getElementById('orden-retencion-detalle').value = '';
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
}

// null = creando una orden nueva; con un id, editando esa orden
// existente — mismo patrón que cotizaciones.
let ordenEditandoId = null;

async function abrirEdicionOrden(id) {
  try {
    const orden = await api(`/compras/ordenes/${id}`);
    if (orden.estado !== 'borrador') {
      alert('Solo se puede editar una orden en estado "borrador".');
      return;
    }

    ordenEditandoId = id;
    document.getElementById('form-orden').hidden = false;
    document.getElementById('orden-tercero').value = orden.terceroId;
    document.getElementById('orden-tipo').value = orden.tipo;
    document.getElementById('orden-proyecto-id').value = orden.proyectoId || '';
    document.getElementById('orden-lugar-entrega').value = orden.lugarEntrega || '';
    document.getElementById('orden-forma-pago').value = orden.formaPago || '';

    // Un proyecto desactivado ya no está en el selector; se agrega solo
    // para que la orden no pierda su proyecto al editarla.
    const selectProyecto = document.getElementById('orden-proyecto-id');
    if (orden.proyectoId && !Array.from(selectProyecto.options).some((o) => o.value === orden.proyectoId)) {
      selectProyecto.add(new Option(nombreProyecto(orden.proyectoId) + ' (inactivo)', orden.proyectoId));
    }
    selectProyecto.value = orden.proyectoId || '';

    document.getElementById('orden-aplica-aiu').checked = !!orden.aplicaAiu;
    document.getElementById('orden-aiu-administracion').value = Number(orden.aiuAdministracion) || '';
    document.getElementById('orden-aiu-imprevistos').value = Number(orden.aiuImprevistos) || '';
    document.getElementById('orden-aiu-utilidad').value = Number(orden.aiuUtilidad) || '';
    document.getElementById('orden-aiu-base-iva').value = orden.aiuBaseIva || 'total';

    // Retención: se recrean las filas desde la foto guardada en la orden.
    const modo = orden.retencionModo || 'ninguna';
    document.querySelector(`input[name="orden-retencion-modo"][value="${modo}"]`).checked = true;
    const tbodyRet = document.getElementById('retenciones-orden-tbody');
    tbodyRet.innerHTML = '';
    if (modo === 'aplica') (orden.retenciones || []).forEach((l) => tbodyRet.appendChild(crearFilaRetencion(l)));
    document.getElementById('orden-retencion-motivo').value = orden.retencionMotivo || '';
    document.getElementById('orden-retencion-detalle').value = orden.retencionDetalle || '';
    actualizarVisibilidadOrden();

    const tbody = document.getElementById('items-orden-tbody');
    tbody.innerHTML = '';
    const items = orden.items || [];
    if (items.length > 0) items.forEach((item) => tbody.appendChild(crearFilaItemOrden(item)));
    else tbody.appendChild(crearFilaItemOrden());

    recalcularTotalesOrden();
    document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar cambios';
    document.getElementById('form-orden').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('btn-nueva-orden').addEventListener('click', () => {
  ordenEditandoId = null;
  document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar';
  actualizarVisibilidadOrden();
  if (document.getElementById('items-orden-tbody').children.length === 0) {
    document.getElementById('items-orden-tbody').appendChild(crearFilaItemOrden());
  }
});
document.getElementById('btn-cancelar-orden').addEventListener('click', limpiarFormularioOrden);

conectarFormulario('form-orden', async () => {
  const datosCalculo = leerDatosOrden();
  const items = datosCalculo.items;
  if (items.length === 0 || items.some((i) => !i.concepto || i.cantidad <= 0)) {
    throw new Error('Agrega al menos un ítem con concepto y cantidad mayor a cero.');
  }
  if (datosCalculo.retencionModo === 'aplica') {
    const filas = leerRetencionesOrden();
    if (filas.length === 0 || filas.some((r) => !r.codigo)) {
      throw new Error('Elige el concepto de cada retención, o cambia a "No aplica retención".');
    }
    if (filas.some((r) => r.codigo === retencionesCatalogo.CONCEPTO_MANUAL.codigo && !(r.tarifa > 0))) {
      throw new Error('En "Otro concepto" digita la tarifa de la retención.');
    }
  }
  if (datosCalculo.retencionModo === 'no_aplica' && !datosCalculo.retencionMotivo) {
    throw new Error('Elige el motivo por el cual no aplica la retención en la fuente.');
  }

  const cuerpo = {
    terceroId: document.getElementById('orden-tercero').value,
    tipo: document.getElementById('orden-tipo').value,
    proyectoId: document.getElementById('orden-proyecto-id').value || undefined,
    lugarEntrega: document.getElementById('orden-lugar-entrega').value || undefined,
    formaPago: document.getElementById('orden-forma-pago').value || undefined,
    items,
    // AIU y retención: mismos datos que alimentan la vista previa de totales.
    aplicaAiu: datosCalculo.aplicaAiu,
    aiuAdministracion: datosCalculo.aiuAdministracion,
    aiuImprevistos: datosCalculo.aiuImprevistos,
    aiuUtilidad: datosCalculo.aiuUtilidad,
    aiuBaseIva: datosCalculo.aiuBaseIva,
    retencionModo: datosCalculo.retencionModo,
    retenciones: datosCalculo.retencionModo === 'aplica' ? leerRetencionesOrden() : [],
    retencionMotivo: datosCalculo.retencionModo === 'no_aplica' ? datosCalculo.retencionMotivo : undefined,
    retencionDetalle: datosCalculo.retencionModo === 'no_aplica' ? datosCalculo.retencionDetalle || undefined : undefined,
  };

  if (ordenEditandoId) {
    await api(`/compras/ordenes/${ordenEditandoId}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  } else {
    await api('/compras/ordenes', { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  limpiarFormularioOrden();
  document.getElementById('form-orden').hidden = true;
});

// --- VER ÍTEMS de una orden existente (fila expandible, mismo patrón que cotización) ---
async function verItemsOrden(id) {
  const filaDetalleExistente = document.getElementById('detalle-orden-' + id);
  if (filaDetalleExistente) {
    filaDetalleExistente.remove();
    return;
  }

  try {
    const orden = await api(`/compras/ordenes/${id}`);
    const filaOriginal = document.querySelector(`tr[data-fila-orden="${id}"]`);
    if (!filaOriginal) return;

    const itemsHtml = (orden.items || [])
      .map(
        (it) =>
          `<tr><td>${it.concepto}</td><td class="num">${Number(it.cantidad).toLocaleString('es-CO')} ${
            it.unidadMedida
          }</td><td class="num">${formatoDinero(it.valorUnitario)}</td><td class="num">${etiquetaImpuesto(
            it.tipoImpuesto,
            it.impuestoPorcentaje
          )}</td><td class="num">${formatoDinero(it.valorTotal)}</td></tr>`
      )
      .join('');

    const tr = document.createElement('tr');
    tr.id = 'detalle-orden-' + id;
    tr.innerHTML = `<td colspan="8"><div class="detalle-items">
      <table class="tabla-items-detalle">
        <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead>
        <tbody>${
          itemsHtml ||
          '<tr><td colspan="5" class="vacio">Esta orden no tiene ítems registrados (se creó antes de esta función).</td></tr>'
        }</tbody>
      </table>
      ${resumenTotalesOrdenHtml(orden)}
    </div></td>`;
    filaOriginal.after(tr);
  } catch (err) {
    alert(err.message);
  }
}

// Desglose en texto bajo los ítems: AIU, impuestos, retención y neto.
function resumenTotalesOrdenHtml(orden) {
  const c = orden.calculo;
  if (!c) return '';
  const partes = [`Subtotal ${formatoDineroDec(c.subtotal)}`];
  if (c.aplicaAiu) {
    partes.push(
      `AIU: Administración ${c.aiuAdministracion}% (${formatoDineroDec(c.aiuAdministracionValor)}) · Imprevistos ${
        c.aiuImprevistos
      }% (${formatoDineroDec(c.aiuImprevistosValor)}) · Utilidad ${c.aiuUtilidad}% (${formatoDineroDec(
        c.aiuUtilidadValor
      )}) — IVA sobre ${c.aiuBaseIva === 'utilidad' ? 'la Utilidad' : 'subtotal + AIU'}`
    );
  }
  partes.push(`IVA ${formatoDineroDec(c.iva)}`);
  if (c.impoconsumo > 0) partes.push(`Impoconsumo ${formatoDineroDec(c.impoconsumo)}`);
  partes.push(`<strong>Total ${formatoDineroDec(c.total)}</strong>`);
  if (c.retencionModo === 'aplica') {
    c.retenciones.forEach((l) => {
      partes.push(
        `Retención: ${l.nombre} ${l.tarifa}% sobre ${formatoDineroDec(l.base)} → ` +
          (l.aplica ? `− ${formatoDineroDec(l.valor)}` : 'no se practica (no alcanza el tope)')
      );
    });
    partes.push(`<strong>A consignar al proveedor ${formatoDineroDec(c.netoAPagar)}</strong>`);
  } else if (c.retencionModo === 'no_aplica') {
    partes.push(`No aplica retención en la fuente: ${c.retencionMotivo}${c.retencionDetalle ? ' (' + c.retencionDetalle + ')' : ''}`);
  }
  return `<p class="nota-aiu">${partes.join(' · ')}</p>`;
}

conectarFormulario('form-periodo', () =>
  api('/nomina/periodos', {
    method: 'POST',
    body: JSON.stringify({
      fechaInicio: document.getElementById('periodo-inicio').value,
      fechaFin: document.getElementById('periodo-fin').value,
    }),
  })
);

conectarFormulario('form-producto', () =>
  api('/inventarios/productos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('producto-nombre').value,
      tipo: document.getElementById('producto-tipo').value,
      unidadMedida: document.getElementById('producto-unidad').value || 'unidad',
    }),
  })
);

conectarFormulario('form-activo', () =>
  api('/activos-fijos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('activo-nombre').value,
      costo: Number(document.getElementById('activo-costo').value),
      vidaUtilMeses: Number(document.getElementById('activo-vida-util').value),
    }),
  })
);

conectarFormulario('form-cuenta', () =>
  api('/tesoreria/cuentas', {
    method: 'POST',
    body: JSON.stringify({
      banco: document.getElementById('cuenta-banco').value,
      numero: document.getElementById('cuenta-numero').value,
    }),
  })
);

conectarFormulario('form-movimiento', () =>
  api('/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      cuentaBancariaId: document.getElementById('movimiento-cuenta').value,
      tipo: document.getElementById('movimiento-tipo').value,
      valor: Number(document.getElementById('movimiento-valor').value),
      descripcion: document.getElementById('movimiento-descripcion').value || undefined,
    }),
  })
);

// --- BOTÓN GENERAL: correr depreciación del mes ---
document.getElementById('btn-depreciar').addEventListener('click', async () => {
  if (!confirm('¿Correr la depreciación mensual de todos los activos fijos activos?')) return;
  await accion('/activos-fijos/depreciar', { method: 'POST' });
});

// --- ACCIONES POR FILA (delegación de eventos sobre todo el tablero) ---
document.getElementById('vista-dashboard').addEventListener('click', async (e) => {
  const boton = e.target.closest('.btn-accion');
  if (!boton) return;

  const { accion: tipoAccion, id } = boton.dataset;

  switch (tipoAccion) {
    case 'editar-tercero':
      return abrirEdicionTercero(id);

    case 'editar-proyecto':
      return abrirEdicionProyecto(id);

    case 'ver-items-cotizacion':
      return verItemsCotizacion(id);

    case 'ver-pdf-cotizacion':
      window.open(`/contable/cotizacion-imprimir.html?id=${id}`, '_blank');
      return;

    case 'editar-cotizacion':
      return abrirEdicionCotizacion(id);

    case 'enviar-cotizacion':
      if (
        confirm(
          'Esto solo marca la cotización como "enviada" en el sistema — no manda ningún correo ni mensaje por sí solo.\n\nPara hacérsela llegar al cliente de verdad, usa "Ver PDF" y compártela tú mismo (correo, WhatsApp, etc.).\n\n¿Marcar como enviada?'
        )
      )
        return accion(`/ventas/cotizaciones/${id}/enviar`, { method: 'PATCH' });
      return;
    case 'aceptar-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/aceptar`, { method: 'PATCH' });
    case 'rechazar-cotizacion':
      if (confirm('¿Rechazar esta cotización?')) return accion(`/ventas/cotizaciones/${id}/rechazar`, { method: 'PATCH' });
      return;
    case 'convertir-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/convertir`, { method: 'POST' });

    case 'ver-items-orden':
      return verItemsOrden(id);
    case 'ver-pdf-orden':
      window.open(`/contable/orden-imprimir.html?id=${id}`, '_blank');
      return;
    case 'editar-orden':
      return abrirEdicionOrden(id);
    case 'aprobar-orden':
      return accion(`/compras/ordenes/${id}/aprobar`, { method: 'PATCH' });
    case 'convertir-orden':
      return accion(`/compras/ordenes/${id}/convertir`, { method: 'POST' });

    case 'agregar-empleado':
      return agregarEmpleadoAPeriodo(id);
    case 'liquidar-periodo':
      if (confirm('¿Liquidar este periodo? Se emitirá el documento soporte de cada empleado agregado.'))
        return accion(`/nomina/periodos/${id}/liquidar`, { method: 'POST' });
      return;

    case 'entrada-inventario':
      return movimientoInventario('entradas', id, true);
    case 'salida-inventario':
      return movimientoInventario('salidas', id, false);
    case 'ajuste-inventario':
      return movimientoInventario('ajustes', id, false, true);

    case 'baja-activo':
      if (confirm('¿Dar de baja este activo? Esta acción queda pendiente de revisión del contador.'))
        return accion(`/activos-fijos/${id}/baja`, { method: 'POST' });
      return;

    case 'conciliar-movimiento':
      return accion(`/tesoreria/movimientos/${id}/conciliar`, { method: 'POST' });
  }
});

// Prompts sencillos para acciones que necesitan un dato adicional puntual.
// Es deliberadamente básico — reemplazar por un formulario modal real
// queda como mejora pendiente, ver README.

async function agregarEmpleadoAPeriodo(periodoId) {
  const empleados = listaTerceros.filter((t) => t.tipo === 'empleado');
  if (empleados.length === 0) {
    alert('Primero crea un tercero de tipo "empleado" en la pestaña Terceros.');
    return;
  }
  const opciones = empleados.map((e, i) => `${i + 1}. ${e.nombre}`).join('\n');
  const seleccion = prompt(`¿Qué empleado? Escribe el número:\n${opciones}`);
  const empleado = empleados[Number(seleccion) - 1];
  if (!empleado) return;

  const devengado = prompt(`Devengado de ${empleado.nombre} ($):`);
  if (!devengado) return;
  const deducciones = prompt('Deducciones ($) — Enter para 0:') || '0';

  await accion(`/nomina/periodos/${periodoId}/empleados`, {
    method: 'POST',
    body: JSON.stringify({ empleadoId: empleado.id, devengado: Number(devengado), deducciones: Number(deducciones) }),
  });
}

async function movimientoInventario(tipo, productoId, pideCosto, pideObservacion) {
  const cantidad = prompt('Cantidad:');
  if (!cantidad) return;

  const body = { productoId, cantidad: Number(cantidad) };

  if (pideCosto) {
    const costo = prompt('Costo unitario ($):');
    if (!costo) return;
    body.costoUnitario = Number(costo);
  }

  if (pideObservacion) {
    body.observacion = prompt('Motivo del ajuste:') || '';
  }

  await accion(`/inventarios/${tipo}`, { method: 'POST', body: JSON.stringify(body) });
}

// --- INICIO ---
if (token && usuario) {
  mostrarDashboard();
}
SCRIPTEOF
echo "OK  public/contable/app.js"

cat > public/contable/index.html << 'SCRIPTEOF'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mipyme Contable</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/contable/style.css?v=20261012-3">
</head>
<body>

<div id="vista-login" class="pantalla-login">
  <div class="tarjeta-login" id="tarjeta-login-principal">
    <h1 class="wordmark">Mipyme Contable</h1>
    <p class="subtitulo">Sistema contable para microempresas — NIIF Grupo 3</p>
    <form id="form-login">
      <label>Correo
        <input type="email" id="login-email" required autocomplete="username">
      </label>
      <label>Contraseña
        <input type="password" id="login-password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn-primario">Entrar</button>
      <p id="login-error" class="mensaje-error" hidden></p>
    </form>
    <button type="button" id="btn-mostrar-onboarding" class="enlace-onboarding">¿Primera vez? Crear empresa y usuario →</button>
  </div>

  <div class="tarjeta-login tarjeta-onboarding" id="tarjeta-onboarding" hidden>
    <h1 class="wordmark">Nueva empresa</h1>
    <p class="subtitulo">Dos pasos: primero la empresa, luego su primer usuario.</p>

    <form id="form-empresa-nueva">
      <label>Razón social
        <input type="text" id="empresa-razon-social" required>
      </label>
      <label>NIT
        <input type="text" id="empresa-nit" required>
      </label>
      <label>Régimen tributario
        <select id="empresa-regimen">
          <option value="ordinario">Ordinario</option>
          <option value="rst">Régimen Simple (RST)</option>
          <option value="especial">Régimen Tributario Especial (ESAL, cooperativas)</option>
        </select>
      </label>
      <label class="check-inline">
        <input type="checkbox" id="empresa-responsable-iva"> Responsable de IVA
      </label>
      <label>Correo electrónico
        <input type="email" id="empresa-email">
      </label>
      <label>Teléfono de contacto
        <input type="text" id="empresa-telefono">
      </label>
      <label>Dirección
        <input type="text" id="empresa-direccion">
      </label>
      <label>Departamento
        <input type="text" id="empresa-departamento">
      </label>
      <label>Municipio
        <input type="text" id="empresa-municipio">
      </label>
      <label>Representante legal
        <input type="text" id="empresa-representante-nombre">
      </label>
      <label>Documento del representante legal
        <input type="text" id="empresa-representante-documento">
      </label>
      <label>Código CIIU (actividad económica)
        <input type="text" id="empresa-ciiu">
      </label>
      <label>Matrícula mercantil
        <input type="text" id="empresa-matricula">
      </label>
      <label>Logo (opcional — aparecerá en cotizaciones y órdenes)
        <input type="file" id="empresa-logo" accept="image/png, image/jpeg, image/svg+xml">
        <img id="empresa-logo-vista-previa" class="logo-vista-previa" hidden>
      </label>
      <button type="submit" class="btn-primario">Crear empresa</button>
    </form>

    <form id="form-usuario-nuevo" hidden>
      <p id="empresa-creada-mensaje" class="mensaje-exito"></p>
      <label>Nombre del usuario
        <input type="text" id="usuario-nuevo-nombre" required>
      </label>
      <label>Correo
        <input type="email" id="usuario-nuevo-email" required>
      </label>
      <label>Contraseña
        <input type="password" id="usuario-nuevo-password" required>
      </label>
      <label>Rol
        <select id="usuario-nuevo-rol">
          <option value="contador">Contador</option>
          <option value="dueño">Dueño</option>
          <option value="auxiliar">Auxiliar</option>
          <option value="revisor">Revisor</option>
        </select>
      </label>
      <button type="submit" class="btn-primario">Crear usuario</button>
    </form>

    <p id="onboarding-resultado" class="mensaje-exito" hidden></p>
    <button type="button" id="btn-volver-login" class="enlace-onboarding">← Volver a iniciar sesión</button>
  </div>
</div>

<div id="vista-dashboard" class="app" hidden>
  <aside class="barra-lateral">
    <h1 class="wordmark">Mipyme Contable</h1>
    <nav>
      <button class="nav-item activo" data-tab="inicio">Inicio</button>
      <button class="nav-item" data-tab="terceros">Terceros</button>
      <button class="nav-item" data-tab="proyectos">Proyectos</button>
      <button class="nav-item" data-tab="cotizaciones">Cotizaciones</button>
      <button class="nav-item" data-tab="facturas-venta">Facturas de venta</button>
      <button class="nav-item" data-tab="ordenes">Órdenes de adquisición</button>
      <button class="nav-item" data-tab="facturas-compra">Facturas de compra</button>
      <button class="nav-item" data-tab="nomina">Nómina</button>
      <button class="nav-item" data-tab="inventarios">Inventarios</button>
      <button class="nav-item" data-tab="activos-fijos">Activos fijos</button>
      <button class="nav-item" data-tab="tesoreria">Tesorería</button>
      <button class="nav-item" data-tab="mi-empresa">Mi Empresa</button>
    </nav>
    <div class="usuario-actual">
      <p id="usuario-nombre"></p>
      <p id="usuario-rol" class="rol"></p>
      <button id="btn-salir">Cerrar sesión</button>
      <a href="/" class="enlace-sitio">← libanielconsulting.com</a>
    </div>
  </aside>

  <main class="contenido">
    <section id="panel-inicio" class="panel">
      <header class="panel-header"><h2>Inicio</h2></header>
      <p class="bienvenida">Bienvenido, <span id="inicio-usuario-nombre"></span> — trabajando en <strong id="inicio-empresa-nombre">—</strong>.</p>
      <div class="grid-modulos">
        <button class="tarjeta-modulo" data-ir-a="terceros">
          <span class="numero-modulo">01</span>
          <h3>Terceros</h3>
          <p>Clientes, proveedores y empleados</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="cotizaciones">
          <span class="numero-modulo">02</span>
          <h3>Cotizaciones</h3>
          <p>Cotiza y da seguimiento a tus ventas</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="facturas-venta">
          <span class="numero-modulo">03</span>
          <h3>Facturas de venta</h3>
          <p>Facturación electrónica</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="ordenes">
          <span class="numero-modulo">04</span>
          <h3>Órdenes de Adquisición</h3>
          <p>Compras de bienes y servicios</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="facturas-compra">
          <span class="numero-modulo">05</span>
          <h3>Facturas de compra</h3>
          <p>Facturas recibidas y documento soporte</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="nomina">
          <span class="numero-modulo">06</span>
          <h3>Nómina</h3>
          <p>Liquidación de empleados</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="inventarios">
          <span class="numero-modulo">07</span>
          <h3>Inventarios</h3>
          <p>Control de existencias</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="activos-fijos">
          <span class="numero-modulo">08</span>
          <h3>Activos fijos</h3>
          <p>Depreciación y activos</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="tesoreria">
          <span class="numero-modulo">09</span>
          <h3>Tesorería</h3>
          <p>Cuentas y movimientos bancarios</p>
        </button>
        <button class="tarjeta-modulo" data-ir-a="proyectos">
          <span class="numero-modulo">10</span>
          <h3>Proyectos</h3>
          <p>Contratos y negocios — futuro centro de costo</p>
        </button>
      </div>
    </section>

    <section id="panel-terceros" class="panel" hidden>
      <header class="panel-header">
        <h2>Terceros</h2>
        <button class="btn-primario" id="btn-nuevo-tercero">+ Nuevo tercero</button>
      </header>
      <form id="form-tercero" class="form-inline" hidden>
        <select id="tercero-tipo" required>
          <option value="cliente">Cliente</option>
          <option value="proveedor">Proveedor</option>
          <option value="empleado">Empleado</option>
          <option value="otro">Otro</option>
        </select>
        <select id="tercero-tipo-persona">
          <option value="">Tipo de persona...</option>
          <option value="natural">Natural</option>
          <option value="juridica">Jurídica</option>
        </select>
        <input type="text" id="tercero-identificacion" placeholder="Identificación" required>
        <input type="text" id="tercero-nombre" placeholder="Nombre" required>
        <input type="email" id="tercero-email" placeholder="Correo (opcional)">
        <input type="text" id="tercero-celular" placeholder="Celular (opcional)">
        <input type="text" id="tercero-direccion" placeholder="Dirección (opcional)">
        <input type="text" id="tercero-departamento" placeholder="Departamento (opcional)">
        <input type="text" id="tercero-municipio" placeholder="Municipio (opcional)">
        <select id="tercero-regimen-iva">
          <option value="">Régimen de IVA...</option>
          <option value="responsable">Responsable de IVA</option>
          <option value="no_responsable">No responsable de IVA</option>
        </select>
        <select id="tercero-cuenta-tipo">
          <option value="">Tipo de cuenta...</option>
          <option value="ahorros">Ahorros</option>
          <option value="corriente">Corriente</option>
        </select>
        <input type="text" id="tercero-cuenta-banco" placeholder="Banco (opcional)">
        <input type="text" id="tercero-cuenta-numero" placeholder="No. cuenta (opcional)">
        <fieldset class="fieldset-responsabilidades">
          <legend>Responsabilidad fiscal (marca las que apliquen)</legend>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-13"> O-13 Gran contribuyente</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-15"> O-15 Autorretenedor</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-23"> O-23 Agente de retención IVA</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="O-47"> O-47 Régimen simple de tributación</label>
          <label><input type="checkbox" class="chk-responsabilidad" value="R-99-PN"> R-99-PN No aplica - Otros</label>
        </fieldset>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-tercero">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-terceros"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-proyectos" class="panel" hidden>
      <header class="panel-header">
        <h2>Proyectos</h2>
        <button class="btn-primario" id="btn-nuevo-proyecto">+ Nuevo proyecto</button>
      </header>
      <p class="nota-panel">Contratos, negocios o proyectos de la empresa — se usan como "Proyecto / Unidad de Negocio" en Órdenes de Adquisición, y están pensados para servir como centro de costo contable más adelante.</p>
      <form id="form-proyecto" class="form-inline" hidden>
        <input type="text" id="proyecto-nombre" placeholder="Nombre del proyecto/contrato" required>
        <input type="text" id="proyecto-codigo" placeholder="ID del proyecto (centro de costo)">
        <select id="proyecto-contratante"></select>
        <input type="number" id="proyecto-valor-total" placeholder="Valor total" min="0">
        <input type="text" id="proyecto-objeto" placeholder="Objeto del proyecto (opcional)">
        <label class="check-aiu">
          <input type="checkbox" id="proyecto-activo" checked> Activo (aparece en el selector de las órdenes)
        </label>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-proyecto">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-proyectos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-cotizaciones" class="panel" hidden>
      <header class="panel-header">
        <h2>Cotizaciones</h2>
        <button class="btn-primario" id="btn-nueva-cotizacion">+ Nueva cotización</button>
      </header>
      <form id="form-cotizacion" class="form-grande" hidden>
        <div class="fila-campos">
          <select id="cotizacion-tercero" required></select>
          <label class="campo-etiquetado">
            <span>Vigente hasta</span>
            <input type="date" id="cotizacion-vencimiento" required>
          </label>
          <input type="text" id="cotizacion-forma-pago" placeholder="Forma de pago (opcional)">
          <input type="text" id="cotizacion-observaciones" placeholder="Observaciones (opcional)">
          <input type="text" id="cotizacion-contacto-nombre" placeholder="Persona de contacto (opcional)">
          <input type="text" id="cotizacion-contacto-telefono" placeholder="Teléfono de contacto (opcional)">
        </div>

        <div class="bloque-items">
          <div class="bloque-items-header">
            <h4>Ítems cotizados</h4>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-item-cotizacion">+ Agregar ítem</button>
          </div>
          <table class="tabla-items">
            <thead>
              <tr><th>Concepto</th><th>Cantidad</th><th>UM</th><th class="num">Valor unitario</th><th>Impuesto</th><th class="num">Total</th><th></th></tr>
            </thead>
            <tbody id="items-cotizacion-tbody"></tbody>
          </table>
        </div>

        <label class="check-aiu">
          <input type="checkbox" id="cotizacion-aplica-aiu"> ¿Aplica AIU? (Administración, Imprevistos, Utilidad — contratos de obra/servicios)
        </label>
        <div class="fila-campos" id="campos-aiu" hidden>
          <label class="campo-aiu">
            <span>Administración %</span>
            <input type="number" id="cotizacion-aiu-administracion" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-administracion">$0</span>
          </label>
          <label class="campo-aiu">
            <span>Imprevistos %</span>
            <input type="number" id="cotizacion-aiu-imprevistos" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-imprevistos">$0</span>
          </label>
          <label class="campo-aiu">
            <span>Utilidad %</span>
            <input type="number" id="cotizacion-aiu-utilidad" placeholder="%" min="0" max="100">
            <span class="valor-aiu" id="valor-aiu-utilidad">$0</span>
          </label>
        </div>

        <div class="resumen-totales">
          <span>Subtotal: <strong id="resumen-subtotal">$0</strong></span>
          <span>IVA: <strong id="resumen-iva">$0</strong></span>
          <span>Total: <strong id="resumen-total">$0</strong></span>
        </div>

        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar</button>
          <button type="button" class="btn-secundario" id="btn-cancelar-cotizacion">Cancelar</button>
        </div>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-cotizaciones"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-venta" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de venta</h2></header>
      <p class="nota-panel">Se generan al convertir una cotización aceptada — no se crean directo aquí.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-venta"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-ordenes" class="panel" hidden>
      <header class="panel-header">
        <h2>Órdenes de adquisición</h2>
        <button class="btn-primario" id="btn-nueva-orden">+ Nueva orden</button>
      </header>
      <form id="form-orden" class="form-grande" hidden>
        <div class="fila-campos">
          <select id="orden-tercero" required></select>
          <select id="orden-tipo">
            <option value="bienes">Bienes</option>
            <option value="servicios">Servicios</option>
          </select>
          <select id="orden-proyecto-id">
            <option value="">Proyecto / Unidad de negocio (ID)...</option>
          </select>
          <input type="text" id="orden-lugar-entrega" placeholder="Lugar de entrega (opcional)">
          <input type="text" id="orden-forma-pago" placeholder="Forma de pago (opcional)">
        </div>

        <div class="bloque-items">
          <div class="bloque-items-header">
            <h4>Ítems de la orden</h4>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-item-orden">+ Agregar ítem</button>
          </div>
          <table class="tabla-items">
            <thead>
              <tr><th>Concepto</th><th>Cantidad</th><th>UM</th><th class="num">Valor unitario</th><th>Impuesto</th><th class="num">Total</th><th></th></tr>
            </thead>
            <tbody id="items-orden-tbody"></tbody>
          </table>
        </div>

        <div id="bloque-aiu-orden" hidden>
          <label class="check-aiu">
            <input type="checkbox" id="orden-aplica-aiu"> Discriminar AIU (Administración, Imprevistos, Utilidad) — solo compra de servicios
          </label>
          <div class="fila-campos" id="campos-aiu-orden" hidden>
            <label class="campo-aiu">
              <span>Administración %</span>
              <input type="number" id="orden-aiu-administracion" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-administracion">$0</span>
            </label>
            <label class="campo-aiu">
              <span>Imprevistos %</span>
              <input type="number" id="orden-aiu-imprevistos" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-imprevistos">$0</span>
            </label>
            <label class="campo-aiu">
              <span>Utilidad %</span>
              <input type="number" id="orden-aiu-utilidad" placeholder="%" min="0" max="100" step="0.01">
              <span class="valor-aiu" id="valor-orden-aiu-utilidad">$0</span>
            </label>
            <label class="campo-aiu">
              <span>IVA se calcula sobre</span>
              <select id="orden-aiu-base-iva">
                <option value="total">Subtotal + AIU</option>
                <option value="utilidad">Solo la Utilidad</option>
              </select>
            </label>
          </div>
        </div>

        <fieldset class="bloque-retencion" id="bloque-retencion-orden">
          <legend>Retención en la fuente (informativa para el proveedor)</legend>
          <div class="opciones-retencion">
            <label><input type="radio" name="orden-retencion-modo" value="ninguna" checked> No indicar retención</label>
            <label><input type="radio" name="orden-retencion-modo" value="aplica"> Aplicar retención</label>
            <label><input type="radio" name="orden-retencion-modo" value="no_aplica"> No aplica retención</label>
          </div>

          <div id="retencion-aplica-orden" hidden>
            <table class="tabla-items">
              <thead>
                <tr><th>Concepto (tipo de bien o servicio)</th><th>Tarifa</th><th class="num">Base</th><th class="num">Tope mínimo</th><th class="num">Retención</th><th></th></tr>
              </thead>
              <tbody id="retenciones-orden-tbody"></tbody>
            </table>
            <button type="button" class="btn-secundario btn-chico" id="btn-agregar-retencion-orden">+ Agregar concepto de retención</button>
            <p class="nota-aiu" id="nota-retencion-orden"></p>
          </div>

          <div id="retencion-no-aplica-orden" class="fila-campos" hidden>
            <label class="campo-aiu">
              <span>Motivo</span>
              <select id="orden-retencion-motivo"></select>
            </label>
            <label class="campo-aiu campo-ancho">
              <span>Detalle (opcional)</span>
              <input type="text" id="orden-retencion-detalle" maxlength="255" placeholder="Ej.: certificado RST vigente, resolución, etc.">
            </label>
          </div>
        </fieldset>

        <div class="resumen-totales">
          <span>Subtotal: <strong id="resumen-subtotal-orden">$0</strong></span>
          <span id="resumen-aiu-orden-fila" hidden>AIU: <strong id="resumen-aiu-orden">$0</strong></span>
          <span>IVA: <strong id="resumen-iva-orden">$0</strong></span>
          <span>Impoconsumo: <strong id="resumen-impoconsumo-orden">$0</strong></span>
          <span>Total: <strong id="resumen-total-orden">$0</strong></span>
          <span id="resumen-retencion-orden-fila" hidden>Retención en la fuente: <strong id="resumen-retencion-orden">$0</strong></span>
          <span id="resumen-neto-orden-fila" hidden>Valor a consignar al proveedor: <strong id="resumen-neto-orden">$0</strong></span>
        </div>

        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar</button>
          <button type="button" class="btn-secundario" id="btn-cancelar-orden">Cancelar</button>
        </div>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-ordenes"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-compra" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de compra</h2></header>
      <p class="nota-panel">Se generan al convertir una orden aprobada, o llegan por webhook del proveedor tecnológico.</p>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-compra"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-nomina" class="panel" hidden>
      <header class="panel-header">
        <h2>Nómina</h2>
        <button class="btn-primario" id="btn-nuevo-periodo">+ Nuevo periodo</button>
      </header>
      <form id="form-periodo" class="form-inline" hidden>
        <input type="date" id="periodo-inicio" required title="Fecha de inicio">
        <input type="date" id="periodo-fin" required title="Fecha de fin">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-periodo">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-nomina"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-inventarios" class="panel" hidden>
      <header class="panel-header">
        <h2>Inventarios</h2>
        <button class="btn-primario" id="btn-nuevo-producto">+ Nuevo producto</button>
      </header>
      <form id="form-producto" class="form-inline" hidden>
        <input type="text" id="producto-nombre" placeholder="Nombre" required>
        <select id="producto-tipo">
          <option value="bien">Bien</option>
          <option value="servicio">Servicio</option>
        </select>
        <input type="text" id="producto-unidad" placeholder="Unidad" value="unidad">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-producto">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-productos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-activos-fijos" class="panel" hidden>
      <header class="panel-header">
        <h2>Activos fijos</h2>
        <div class="acciones-header">
          <button class="btn-secundario" id="btn-depreciar">Correr depreciación del mes</button>
          <button class="btn-primario" id="btn-nuevo-activo">+ Nuevo activo</button>
        </div>
      </header>
      <form id="form-activo" class="form-inline" hidden>
        <input type="text" id="activo-nombre" placeholder="Nombre" required>
        <input type="number" id="activo-costo" placeholder="Costo" required min="0">
        <input type="number" id="activo-vida-util" placeholder="Vida útil (meses)" required min="1">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-activo">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-activos"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-tesoreria" class="panel" hidden>
      <header class="panel-header"><h2>Tesorería</h2></header>

      <div class="subseccion-header">
        <h3 class="subseccion">Cuentas bancarias</h3>
        <button class="btn-primario btn-chico" id="btn-nueva-cuenta">+ Nueva cuenta</button>
      </div>
      <form id="form-cuenta" class="form-inline" hidden>
        <input type="text" id="cuenta-banco" placeholder="Banco" required>
        <input type="text" id="cuenta-numero" placeholder="Número" required>
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-cuenta">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-cuentas"><thead></thead><tbody></tbody></table>
      </div>

      <div class="subseccion-header">
        <h3 class="subseccion">Movimientos</h3>
        <button class="btn-primario btn-chico" id="btn-nuevo-movimiento">+ Nuevo movimiento</button>
      </div>
      <form id="form-movimiento" class="form-inline" hidden>
        <select id="movimiento-cuenta" required></select>
        <select id="movimiento-tipo">
          <option value="ingreso">Ingreso</option>
          <option value="egreso">Egreso</option>
          <option value="comision">Comisión</option>
        </select>
        <input type="number" id="movimiento-valor" placeholder="Valor" required min="0">
        <input type="text" id="movimiento-descripcion" placeholder="Descripción (opcional)">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-movimiento">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-movimientos-bancarios"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-mi-empresa" class="panel" hidden>
      <header class="panel-header"><h2>Mi Empresa</h2></header>
      <p class="nota-panel">Estos datos aparecen en el encabezado de las cotizaciones y órdenes de adquisición en PDF.</p>
      <form id="form-mi-empresa" class="form-grande">
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Razón social</span>
            <input type="text" id="miempresa-razon-social" required>
          </label>
          <label class="campo-etiquetado">
            <span>NIT</span>
            <input type="text" id="miempresa-nit" required>
          </label>
          <label class="campo-etiquetado">
            <span>Régimen tributario</span>
            <select id="miempresa-regimen">
              <option value="ordinario">Ordinario</option>
              <option value="rst">Régimen Simple (RST)</option>
              <option value="especial">Régimen Tributario Especial</option>
            </select>
          </label>
          <label class="check-aiu">
            <input type="checkbox" id="miempresa-responsable-iva"> Responsable de IVA
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Correo electrónico</span>
            <input type="email" id="miempresa-email">
          </label>
          <label class="campo-etiquetado">
            <span>Teléfono de contacto</span>
            <input type="text" id="miempresa-telefono">
          </label>
          <label class="campo-etiquetado">
            <span>Dirección</span>
            <input type="text" id="miempresa-direccion">
          </label>
          <label class="campo-etiquetado">
            <span>Departamento</span>
            <input type="text" id="miempresa-departamento">
          </label>
          <label class="campo-etiquetado">
            <span>Municipio</span>
            <input type="text" id="miempresa-municipio">
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Representante legal</span>
            <input type="text" id="miempresa-representante-nombre">
          </label>
          <label class="campo-etiquetado">
            <span>Documento del representante legal</span>
            <input type="text" id="miempresa-representante-documento">
          </label>
          <label class="campo-etiquetado">
            <span>Código CIIU</span>
            <input type="text" id="miempresa-ciiu">
          </label>
          <label class="campo-etiquetado">
            <span>Matrícula mercantil</span>
            <input type="text" id="miempresa-matricula">
          </label>
        </div>
        <div class="fila-campos">
          <label class="campo-etiquetado">
            <span>Logo</span>
            <input type="file" id="miempresa-logo" accept="image/png, image/jpeg, image/svg+xml">
          </label>
          <img id="miempresa-logo-vista-previa" class="logo-vista-previa" hidden>
        </div>
        <div class="fila-botones">
          <button type="submit" class="btn-primario">Guardar cambios</button>
        </div>
        <p id="miempresa-resultado" class="mensaje-exito" hidden></p>
      </form>
    </section>
  </main>
</div>

<!-- ?v=... evita que el navegador o el CDN sirvan una copia vieja de estos archivos: subir el valor cada vez que cambie alguno (ver README, "Caché de archivos estáticos") -->
<script src="/contable/retencionesCatalogo.js?v=20261012-3"></script>
<script src="/contable/calculoOrden.js?v=20261012-3"></script>
<script src="/contable/app.js?v=20261012-3"></script>
</body>
</html>
SCRIPTEOF
echo "OK  public/contable/index.html"

cat > public/contable/style.css << 'SCRIPTEOF'
:root {
  --paper: #F6F8F4;
  --surface: #FFFFFF;
  --ink: #1C2A24;
  --ink-soft: #56655C;
  --rule: #CBD6CE;
  --rule-strong: #9FAFA4;
  --accent: #2F6B4F;
  --accent-hover: #275940;
  --accent-ink: #FFFFFF;
  --danger: #A6432E;
  --warn: #B8863A;
  --font-serif: 'IBM Plex Serif', Georgia, serif;
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
}

* { box-sizing: border-box; }

/* El atributo hidden debe ganar siempre, incluso sobre elementos con
   display: grid/flex por clase (.app, .pantalla-login, etc.) — sin
   esto, el navegador puede dejar visible un elemento "oculto". */
[hidden] { display: none !important; }

body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--paper);
}

.wordmark {
  font-family: var(--font-serif);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

button { font-family: var(--font-sans); cursor: pointer; }

.btn-primario {
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
}
.btn-primario:hover { background: var(--accent-hover); }

.btn-secundario {
  background: transparent;
  color: var(--ink-soft);
  border: 1px solid var(--rule-strong);
  padding: 10px 18px;
  font-size: 14px;
}

/* LOGIN */
.pantalla-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.tarjeta-login {
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border-top: 3px solid var(--accent);
  padding: 40px 32px;
}

.tarjeta-login .wordmark { font-size: 22px; margin-bottom: 4px; }

.subtitulo {
  color: var(--ink-soft);
  font-size: 13px;
  margin: 0 0 28px;
  line-height: 1.5;
}

#form-login label {
  display: block;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 16px;
}

#form-login input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}

#form-login input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

#form-login .btn-primario {
  width: 100%;
  padding: 12px;
  margin-top: 8px;
}

.mensaje-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 12px;
}

.mensaje-exito {
  color: var(--accent);
  font-size: 13px;
  margin: 0 0 14px;
}

.enlace-onboarding {
  display: block;
  width: 100%;
  text-align: center;
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  margin-top: 20px;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}
.enlace-onboarding:hover { color: var(--accent); }

.tarjeta-onboarding { max-width: 420px; }
.tarjeta-onboarding label { display: block; font-size: 13px; color: var(--ink-soft); margin-bottom: 14px; }
.tarjeta-onboarding input, .tarjeta-onboarding select {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}
.tarjeta-onboarding .btn-primario { width: 100%; padding: 12px; margin-top: 4px; }

.logo-vista-previa {
  display: block;
  max-width: 140px;
  max-height: 80px;
  margin-top: 8px;
  border: 1px solid var(--rule-strong);
  padding: 6px;
}

.tarjeta-onboarding .check-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.tarjeta-onboarding .check-inline input[type="checkbox"] {
  width: auto;
  margin: 0;
}

/* PANEL DE INICIO */
.bienvenida {
  color: var(--ink-soft);
  font-size: 14px;
  margin: -10px 0 28px;
}

.grid-modulos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.tarjeta-modulo {
  text-align: left;
  background: var(--surface);
  border: none;
  border-top: 3px solid var(--accent);
  padding: 20px 18px;
  cursor: pointer;
  font-family: var(--font-sans);
}
.tarjeta-modulo:hover { background: var(--paper); }

.numero-modulo {
  display: block;
  font-family: var(--font-serif);
  font-size: 13px;
  color: var(--rule-strong);
  font-weight: 600;
  margin-bottom: 8px;
}

.tarjeta-modulo h3 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 16px;
  margin: 0 0 6px;
  color: var(--ink);
}

.tarjeta-modulo p {
  font-size: 13px;
  color: var(--ink-soft);
  margin: 0;
  line-height: 1.4;
}

@media (max-width: 720px) {
  .grid-modulos { grid-template-columns: 1fr; }
}

/* APP SHELL */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.barra-lateral {
  background: var(--surface);
  border-right: 1px solid var(--rule);
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
}

.barra-lateral .wordmark { font-size: 17px; margin-bottom: 28px; }

.barra-lateral nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding: 9px 10px;
  font-size: 14px;
  color: var(--ink-soft);
}

.nav-item:hover { color: var(--ink); background: var(--paper); }

.nav-item.activo {
  color: var(--ink);
  border-left-color: var(--accent);
  background: var(--paper);
  font-weight: 500;
}

.usuario-actual {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-top: 16px;
}

.usuario-actual p { margin: 0; font-size: 13px; }
.usuario-actual .rol {
  color: var(--ink-soft);
  text-transform: capitalize;
  margin-bottom: 10px;
}

#btn-salir {
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  padding: 0;
  text-decoration: underline;
}

.enlace-sitio {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-top: 8px;
}

.contenido { padding: 32px 40px; max-width: 1000px; }

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}

.panel-header h2 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 24px;
  margin: 0;
}

.subseccion {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 15px;
  color: var(--ink-soft);
  margin: 0;
}

.subseccion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 24px 0 10px;
}
.subseccion-header:first-of-type { margin-top: 0; }

.acciones-header {
  display: flex;
  gap: 10px;
  align-items: center;
}

.nota-panel {
  color: var(--ink-soft);
  font-size: 13px;
  margin: -8px 0 16px;
}

.btn-chico {
  padding: 6px 12px;
  font-size: 13px;
}

.btn-accion {
  background: none;
  border: 1px solid var(--rule-strong);
  color: var(--ink);
  padding: 4px 10px;
  font-size: 12px;
  margin-right: 6px;
  white-space: nowrap;
}
.btn-accion:hover { background: var(--paper); }
.btn-accion.destructivo { border-color: var(--danger); color: var(--danger); }
.btn-accion.destructivo:hover { background: #fbeae6; }

td.acciones { white-space: nowrap; }

.form-inline {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 16px;
  margin-bottom: 20px;
}

.form-inline input, .form-inline select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

.fieldset-responsabilidades {
  border: 1px solid var(--rule-strong);
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  width: 100%;
}
.fieldset-responsabilidades legend {
  font-size: 12px;
  color: var(--ink-soft);
  padding: 0 4px;
}
.fieldset-responsabilidades label {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

/* Formularios más grandes (cotización, orden) con ítems dinámicos */
.form-grande {
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 20px;
  margin-bottom: 20px;
}

.fila-campos {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.fila-campos input, .fila-campos select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

.campo-etiquetado {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-soft);
}

.bloque-items {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-bottom: 16px;
}
.bloque-items-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.bloque-items-header h4 {
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--ink-soft);
}

.tabla-items { width: 100%; border-collapse: collapse; font-size: 13px; }
.tabla-items thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 11px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--rule-strong);
}
.tabla-items td { padding: 4px 6px; }
.tabla-items input, .tabla-items select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 13px;
  background: var(--paper);
}
.tabla-items .num { text-align: right; font-family: var(--font-mono); white-space: nowrap; }
.tabla-items .item-total-texto { font-family: var(--font-mono); }

.check-aiu {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 12px;
}

.campo-aiu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-soft);
}
.campo-aiu .valor-aiu {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink);
}

.resumen-totales {
  display: flex;
  gap: 24px;
  justify-content: flex-end;
  border-top: 1px solid var(--rule);
  padding-top: 12px;
  margin-bottom: 16px;
  font-size: 14px;
}
.resumen-totales strong { font-family: var(--font-mono); }

.fila-botones { display: flex; gap: 10px; }

.tabla-items-detalle { width: 100%; border-collapse: collapse; font-size: 13px; margin: 10px 0; }
.tabla-items-detalle th {
  text-align: left;
  font-size: 11px;
  color: var(--ink-soft);
  padding: 6px 10px;
  border-bottom: 1px solid var(--rule-strong);
}
.tabla-items-detalle td { padding: 6px 10px; border-bottom: 1px solid var(--rule); }
.tabla-items-detalle .num { text-align: right; font-family: var(--font-mono); }
.detalle-items { background: var(--paper); padding: 14px 16px; }
.nota-aiu { font-size: 12px; color: var(--ink-soft); margin: 8px 0 0; }

/* TABLAS: estilo libro contable — solo reglas horizontales */
.tabla-envoltorio {
  background: var(--surface);
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--rule-strong);
  white-space: nowrap;
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}

tbody tr:last-child td { border-bottom: none; }

td.num, th.num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  text-transform: capitalize;
}
.badge.aceptada, .badge.aceptado, .badge.contabilizado, .badge.liquidada, .badge.aprobada, .badge.conciliado { border-color: var(--accent); color: var(--accent); }
.badge.rechazada, .badge.rechazado, .badge.objetada { border-color: var(--danger); color: var(--danger); }
.badge.pendiente, .badge.borrador, .badge.enviada, .badge.enviado { border-color: var(--warn); color: var(--warn); }

.vacio {
  padding: 32px 16px;
  color: var(--ink-soft);
  font-size: 14px;
  text-align: center;
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .barra-lateral {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
  .barra-lateral nav { flex-direction: row; flex-wrap: wrap; }
  .contenido { padding: 20px; }
}

/* Orden de adquisición: totales con varias líneas (AIU, Impoconsumo,
   retención, neto). Se permite pasar a otra línea en pantallas angostas. */
.resumen-totales { flex-wrap: wrap; row-gap: 6px; }
.resumen-totales .neto-pagar, #resumen-neto-orden-fila { font-weight: 600; }
.fila-campos .nota-aiu { flex-basis: 100%; margin: 0; }

/* Retención en la fuente de la orden */
.bloque-retencion {
  border: 1px solid var(--rule);
  padding: 12px 16px 14px;
  margin: 0 0 16px;
}
.bloque-retencion legend {
  font-family: var(--font-serif);
  font-size: 13px;
  padding: 0 6px;
  color: var(--ink-soft);
}
.opciones-retencion { display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px; margin-bottom: 10px; }
.opciones-retencion label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.bloque-retencion select, .bloque-retencion input[type="text"], .bloque-retencion input[type="number"] {
  padding: 7px 9px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 13px;
  background: var(--paper);
}
.bloque-retencion .item-ret-concepto { width: 100%; min-width: 260px; }
.bloque-retencion .item-ret-tarifa { width: 70px; }
.bloque-retencion .campo-ancho { flex: 1; min-width: 240px; }
.bloque-retencion .campo-ancho input { width: 100%; }
.bloque-retencion .ret-nota { display: block; font-size: 11px; color: #9A5B13; margin-top: 3px; }
.bloque-retencion .ret-sin-efecto { color: var(--ink-soft); }
.bloque-retencion td:nth-child(2) { white-space: nowrap; }
SCRIPTEOF
echo "OK  public/contable/style.css"

cat > public/contable/orden-imprimir.html << 'SCRIPTEOF'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orden de Adquisición</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #1C2A24;
    --ink-soft: #56655C;
    --rule: #CBD6CE;
    --rule-strong: #9FAFA4;
    --accent: #2F6B4F;
    --font-serif: 'IBM Plex Serif', Georgia, serif;
    --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    --font-mono: 'IBM Plex Mono', monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--font-sans);
    color: var(--ink);
    background: #E9EEE9;
  }
  .barra-acciones {
    position: sticky;
    top: 0;
    background: #1F4D38;
    padding: 14px 24px;
    display: flex;
    gap: 14px;
    align-items: center;
    z-index: 10;
  }
  .barra-acciones a, .barra-acciones button {
    font-family: var(--font-sans);
    font-size: 14px;
    cursor: pointer;
  }
  .barra-acciones a { color: #D7E3DC; text-decoration: none; }
  .barra-acciones button {
    background: #fff;
    color: #1F4D38;
    border: none;
    padding: 8px 18px;
    font-weight: 600;
  }
  .hoja {
    max-width: 780px;
    margin: 24px auto 60px;
    background: #fff;
    padding: 48px 56px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
  }
  .encabezado {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 3px solid var(--accent);
    padding-bottom: 20px;
    margin-bottom: 24px;
  }
  .encabezado-empresa { display: flex; gap: 14px; align-items: flex-start; }
  .logo-empresa { max-width: 72px; max-height: 72px; object-fit: contain; }
  .empresa-nombre {
    font-family: var(--font-serif);
    font-weight: 700;
    font-size: 20px;
    margin: 0 0 6px;
  }
  .empresa-datos { font-size: 12px; color: var(--ink-soft); line-height: 1.6; }
  .titulo-documento { text-align: right; }
  .titulo-documento h1 {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 22px;
    margin: 0 0 4px;
    color: var(--accent);
  }
  .titulo-documento .consecutivo { font-family: var(--font-mono); font-size: 15px; }
  .titulo-documento .fechas { font-size: 12px; color: var(--ink-soft); margin-top: 6px; }

  .fila-bloques { display: flex; gap: 16px; margin-bottom: 24px; }
  .bloque-cliente {
    background: #F6F8F4;
    padding: 16px 20px;
    flex: 1;
  }
  .bloque-cliente h3 {
    font-family: var(--font-serif);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-soft);
    margin: 0 0 8px;
  }
  .bloque-cliente p { margin: 2px 0; font-size: 13px; }

  table.items { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  table.items th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--ink-soft);
    border-bottom: 2px solid var(--rule-strong);
    padding: 8px 6px;
  }
  table.items td { padding: 8px 6px; border-bottom: 1px solid var(--rule); font-size: 13px; }
  table.items .num { text-align: right; font-family: var(--font-mono); white-space: nowrap; }

  .totales { display: flex; justify-content: flex-end; margin-bottom: 28px; }
  .totales table { border-collapse: collapse; min-width: 320px; }
  .totales td { padding: 5px 8px; font-size: 13px; }
  .totales td.num { text-align: right; font-family: var(--font-mono); }
  .totales tr.total-final td { border-top: 2px solid var(--accent); font-weight: 600; font-size: 15px; padding-top: 10px; }

  .proyeccion-pago {
    border: 1px solid var(--rule-strong);
    border-left: 4px solid var(--accent);
    padding: 12px 16px 10px;
    margin: 0 0 20px;
    break-inside: avoid;
  }
  .proyeccion-pago h3 {
    font-family: var(--font-serif);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-soft);
    margin: 0 0 8px;
  }
  .proyeccion-pago table { width: 100%; border-collapse: collapse; }
  .proyeccion-pago td { padding: 4px 0; font-size: 13px; }
  .proyeccion-pago td.num { text-align: right; font-family: var(--font-mono); white-space: nowrap; padding-left: 16px; }
  .proyeccion-pago tr.recibe td { border-top: 2px solid var(--accent); font-weight: 600; font-size: 15px; padding-top: 8px; }
  .proyeccion-pago p { font-size: 12px; line-height: 1.5; color: var(--ink-soft); margin: 8px 0 0; }
  .info-adicional { font-size: 13px; margin-bottom: 8px; }
  .info-adicional strong { color: var(--ink-soft); font-weight: 500; }

  .pie-firma {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
    font-size: 12px;
    color: var(--ink-soft);
  }

  .vacio { text-align: center; padding: 40px; color: var(--ink-soft); font-family: var(--font-sans); }

  @media print {
    body { background: #fff; }
    .barra-acciones { display: none; }
    .hoja { box-shadow: none; margin: 0; max-width: none; padding: 0; }
  }
</style>
</head>
<body>

<div class="barra-acciones">
  <a href="/contable">← Volver al software</a>
  <button id="btn-imprimir" style="margin-left:auto;">Imprimir / Guardar como PDF</button>
</div>

<div id="contenido">
  <p class="vacio">Cargando...</p>
</div>

<script>
const API = '/api';
const token = localStorage.getItem('token');
const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
const params = new URLSearchParams(window.location.search);
const ordenId = params.get('id');

function formatoDinero(valor) {
  return Number(valor || 0).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
}
// Con centavos cuando los hay: el IVA del 19% casi nunca da pesos exactos.
function formatoDineroDec(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
function formatoFecha(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
}
const ETIQUETAS_IMPUESTO = { iva: 'IVA', impoconsumo: 'Impoconsumo', exento: 'Exento' };
function etiquetaImpuesto(tipo, porcentaje) {
  const etiqueta = ETIQUETAS_IMPUESTO[tipo] || 'IVA';
  return tipo === 'exento' ? etiqueta : `${etiqueta} ${porcentaje}%`;
}

async function api(path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Error al cargar los datos.');
  return res.json();
}

function mostrarError(mensaje) {
  document.getElementById('contenido').innerHTML = `<p class="vacio">${mensaje}</p>`;
}

async function cargar() {
  if (!token || !usuario) return mostrarError('Debes iniciar sesión primero. <a href="/contable">Ir al login</a>');
  if (!ordenId) return mostrarError('Falta indicar qué orden mostrar.');

  try {
    const [orden, empresas, terceros, proyectos] = await Promise.all([
      api(`/compras/ordenes/${ordenId}`),
      api('/empresas'),
      api('/terceros'),
      api('/proyectos'),
    ]);

    const empresa = empresas.find((e) => e.id === usuario.empresaId) || {};
    const proveedor = terceros.find((t) => t.id === orden.terceroId) || {};
    const proyecto = proyectos.find((p) => p.id === orden.proyectoId);
    // ID (centro de costo) primero; el nombre acompaña.
    const etiquetaProyecto = proyecto
      ? (proyecto.codigo ? `<strong>${proyecto.codigo}</strong> — ${proyecto.nombre}` : proyecto.nombre)
      : orden.proyecto || '—';
    const items = orden.items || [];

    const cuentaProveedor = proveedor.cuentaBancariaBanco
      ? `${proveedor.cuentaBancariaBanco} · ${proveedor.cuentaBancariaTipo || ''} ${proveedor.cuentaBancariaNumero || ''}`
      : null;

    // Desglose calculado por el servidor (mismo cálculo que al guardar).
    // Órdenes antiguas, sin ítems, no lo traen: se usan sus totales guardados.
    const c = orden.calculo;
    let filasTotales;
    let proyeccionPago = '';
    if (c) {
      const f = (etiqueta, valor, clase) =>
        `<tr${clase ? ` class="${clase}"` : ''}><td>${etiqueta}</td><td class="num">${valor}</td></tr>`;
      const filas = [f('Subtotal', formatoDineroDec(c.subtotal))];
      if (c.aplicaAiu) {
        filas.push(f(`AIU — Administración (${c.aiuAdministracion}%)`, formatoDineroDec(c.aiuAdministracionValor)));
        filas.push(f(`AIU — Imprevistos (${c.aiuImprevistos}%)`, formatoDineroDec(c.aiuImprevistosValor)));
        filas.push(f(`AIU — Utilidad (${c.aiuUtilidad}%)`, formatoDineroDec(c.aiuUtilidadValor)));
        filas.push(f('Base gravable (subtotal + AIU)', formatoDineroDec(c.base)));
      }
      filas.push(
        f(
          c.aplicaAiu ? `IVA 19% sobre ${c.aiuBaseIva === 'utilidad' ? 'la Utilidad' : 'la base gravable'}` : 'IVA',
          formatoDineroDec(c.iva)
        )
      );
      if (c.impoconsumo > 0) filas.push(f('Impoconsumo', formatoDineroDec(c.impoconsumo)));
      filas.push(f('Total', formatoDineroDec(c.total), 'total-final'));
      // Proyección de pago: lo que el proveedor sabrá que recibirá en su
      // cuenta y cuánto se retiene. Aplica la retención sobre el valor TOTAL
      // de la orden (la retención se calcula sobre la base antes de impuestos,
      // pero se descuenta del total con impuestos).
      const fp = (etiqueta, valor, clase) =>
        `<tr${clase ? ` class="${clase}"` : ''}><td>${etiqueta}</td><td class="num">${valor}</td></tr>`;
      if (c.retencionModo === 'aplica') {
        const practicadas = c.retenciones.filter((l) => l.aplica);
        const sinEfecto = c.retenciones.filter((l) => !l.aplica);
        const pctSobreTotal = c.total > 0 ? Math.round((c.retencionValor / c.total) * 10000) / 100 : 0;
        const filasPago = [fp('Valor total de la orden (impuestos incluidos)', formatoDineroDec(c.total))];
        practicadas.forEach((l) =>
          filasPago.push(
            fp(
              `(−) Retención en la fuente: ${l.nombre} — ${l.tarifa.toLocaleString('es-CO')}% sobre ${formatoDineroDec(l.base)}${
                l.sobre === 'iva' ? ' (valor del IVA)' : l.sobre === 'aiu' ? ' (AIU)' : ''
              }`,
              '− ' + formatoDineroDec(l.valor)
            )
          )
        );
        if (practicadas.length === 0) filasPago.push(fp('(−) Retención en la fuente', formatoDineroDec(0)));
        filasPago.push(
          fp(
            cuentaProveedor ? `Valor que recibirá en su cuenta (${cuentaProveedor})` : 'Valor que recibirá en su cuenta',
            formatoDineroDec(c.netoAPagar),
            'recibe'
          )
        );
        proyeccionPago = `<div class="proyeccion-pago">
          <h3>Proyección de pago al proveedor</h3>
          <table>${filasPago.join('')}</table>
          <p>${
            practicadas.length > 0
              ? `Total retenido: ${formatoDineroDec(c.retencionValor)}, equivalente al ${pctSobreTotal.toLocaleString('es-CO')}% del valor total de la orden. `
              : 'No se practica retención en esta orden. '
          }${
            sinEfecto.length > 0
              ? `No se practica: ${sinEfecto.map((l) => l.nombre).join('; ')} (la base no alcanza el tope mínimo o no hay base de cálculo). `
              : ''
          }Al aceptar esta orden, el proveedor declara conocer la retención aquí proyectada.</p>
        </div>`;
      } else if (c.retencionModo === 'no_aplica') {
        proyeccionPago = `<div class="proyeccion-pago">
          <h3>Proyección de pago al proveedor</h3>
          <table>${[
            fp('Valor total de la orden (impuestos incluidos)', formatoDineroDec(c.total)),
            fp('(−) Retención en la fuente: no aplica', formatoDineroDec(0)),
            fp(
              cuentaProveedor ? `Valor que recibirá en su cuenta (${cuentaProveedor})` : 'Valor que recibirá en su cuenta',
              formatoDineroDec(c.total),
              'recibe'
            ),
          ].join('')}</table>
          <p>Motivo por el que no aplica retención: ${c.retencionMotivo}${c.retencionDetalle ? ' (' + c.retencionDetalle + ')' : ''}.</p>
        </div>`;
      }
      filasTotales = filas.join('');
    } else {
      filasTotales = `
        <tr><td>Subtotal</td><td class="num">${formatoDineroDec(orden.subtotal)}</td></tr>
        <tr><td>IVA</td><td class="num">${formatoDineroDec(orden.iva)}</td></tr>
        <tr class="total-final"><td>Total</td><td class="num">${formatoDineroDec(orden.total)}</td></tr>`;
    }

    document.getElementById('contenido').innerHTML = `
      <div class="hoja">
        <div class="encabezado">
          <div class="encabezado-empresa">
            ${empresa.logoBase64 ? `<img class="logo-empresa" src="${empresa.logoBase64}" alt="Logo">` : ''}
            <div>
              <p class="empresa-nombre">${empresa.razonSocial || '—'}</p>
              <div class="empresa-datos">
                NIT ${empresa.nit || '—'}<br>
                ${empresa.direccion || ''} ${empresa.municipio ? '· ' + empresa.municipio : ''} ${empresa.departamento ? ', ' + empresa.departamento : ''}<br>
                ${empresa.telefono || ''} ${empresa.email ? '· ' + empresa.email : ''}
              </div>
            </div>
          </div>
          <div class="titulo-documento">
            <h1>Orden de Adquisición</h1>
            <div class="consecutivo">${orden.consecutivo || '—'}</div>
            <div class="fechas">
              Fecha: ${formatoFecha(orden.fecha)}<br>
              Entrega requerida: ${formatoFecha(orden.fechaRequerida)}
            </div>
          </div>
        </div>

        <div class="fila-bloques">
          <div class="bloque-cliente">
            <h3>Proveedor</h3>
            <p><strong>${proveedor.nombre || '—'}</strong>${proveedor.identificacion ? ' · ' + proveedor.identificacion : ''}</p>
            <p>${proveedor.direccion || ''}</p>
            <p>${proveedor.celular || ''} ${proveedor.email ? '· ' + proveedor.email : ''}</p>
            ${cuentaProveedor ? `<p>Cuenta: ${cuentaProveedor}</p>` : ''}
          </div>
          <div class="bloque-cliente">
            <h3>Orden</h3>
            <p><strong>Tipo:</strong> ${orden.tipo === 'servicios' ? 'Servicios' : 'Bienes'}</p>
            <p><strong>Proyecto / Unidad de negocio (ID):</strong> ${etiquetaProyecto}</p>
            <p><strong>Lugar de entrega:</strong> ${orden.lugarEntrega || '—'}</p>
          </div>
        </div>

        <table class="items">
          <thead>
            <tr><th>Concepto</th><th>Cant.</th><th>UM</th><th class="num">Valor unitario</th><th>Impuesto</th><th class="num">Total</th></tr>
          </thead>
          <tbody>
            ${
              items.length > 0
                ? items.map((it) => `
                  <tr>
                    <td>${it.concepto}</td>
                    <td>${Number(it.cantidad).toLocaleString('es-CO')}</td>
                    <td>${it.unidadMedida}</td>
                    <td class="num">${formatoDinero(it.valorUnitario)}</td>
                    <td>${orden.calculo && orden.calculo.aplicaAiu ? 'Según AIU' : etiquetaImpuesto(it.tipoImpuesto, it.impuestoPorcentaje)}</td>
                    <td class="num">${formatoDinero(it.valorTotal)}</td>
                  </tr>`).join('')
                : '<tr><td colspan="6" style="text-align:center; color:#888;">Esta orden no tiene ítems registrados.</td></tr>'
            }
          </tbody>
        </table>

        <div class="totales">
          <table>
            ${filasTotales}
          </table>
        </div>

        ${proyeccionPago}

        ${orden.formaPago ? `<p class="info-adicional"><strong>Forma de pago:</strong> ${orden.formaPago}</p>` : ''}

        <div class="pie-firma">
          ${empresa.representanteLegalNombre ? `${empresa.representanteLegalNombre}${empresa.representanteLegalDocumento ? ' · C.C. ' + empresa.representanteLegalDocumento : ''}<br>` : ''}
          Orden de adquisición generada por ${empresa.razonSocial || 'el sistema'}.
        </div>
      </div>
    `;
  } catch (err) {
    mostrarError(err.message);
  }
}

document.getElementById('btn-imprimir').addEventListener('click', () => window.print());
cargar();
</script>
</body>
</html>
SCRIPTEOF
echo "OK  public/contable/orden-imprimir.html"

cat > src/modules/compras/models/OrdenCompra.js << 'SCRIPTEOF'
const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Unifica orden de compra (bienes) y orden de servicio en una sola
// entidad, distinguida por "tipo" — comparten ciclo de vida y campos de
// cabecera; lo único que cambia es la plantilla de impresión y que en
// servicios el renglón suele llevar descripción libre en vez de producto_id.
//
// Ciclo de vida: borrador -> emitida -> aprobada -> recibida_parcial |
// recibida_total -> facturada, o rechazada / anulada en cualquier punto
// antes de facturada. No genera asiento contable en ningún estado.
const OrdenCompra = sequelize.define('OrdenCompra', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false }, // proveedor
  tipo: {
    type: DataTypes.ENUM('bienes', 'servicios'),
    allowNull: false,
    defaultValue: 'bienes',
  },
  aprobadorId: { type: DataTypes.UUID },
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  fechaRequerida: { type: DataTypes.DATEONLY }, // fecha de cumplimiento
  estado: {
    type: DataTypes.ENUM(
      'borrador',
      'emitida',
      'aprobada',
      'recibida_parcial',
      'recibida_total',
      'facturada',
      'rechazada',
      'anulada'
    ),
    allowNull: false,
    defaultValue: 'borrador',
  },
  consecutivo: { type: DataTypes.STRING(30) },
  // Proyecto o unidad de negocio al que pertenece — es, en la práctica,
  // el mismo concepto que centro de costo (todavía pendiente como
  // catálogo propio, ver README).
  // proyectoId es la referencia real al catálogo Proyecto (selector en
  // el formulario). "proyecto" (texto libre) se conserva solo por
  // compatibilidad con órdenes creadas antes de que existiera el
  // catálogo — las nuevas usan proyectoId.
  proyectoId: { type: DataTypes.UUID },
  proyecto: { type: DataTypes.STRING(150) },
  lugarEntrega: { type: DataTypes.STRING(255) },
  formaPago: { type: DataTypes.TEXT },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  iva: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  impoconsumo: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  // AIU (Administración, Imprevistos, Utilidad): solo en órdenes de
  // servicios. Se guardan los porcentajes; los valores en pesos se
  // derivan con calculoOrden.js. aiuBaseIva: 'total' = IVA sobre
  // (subtotal + AIU); 'utilidad' = IVA solo sobre la Utilidad.
  aplicaAiu: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  aiuAdministracion: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  aiuImprevistos: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  aiuUtilidad: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  aiuBaseIva: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'total' },
  // Retención en la fuente: informativa para el proveedor (se muestra en
  // el PDF con el neto a pagar). No genera asiento por sí sola.
  //   retencionModo: 'ninguna' | 'aplica' | 'no_aplica'
  //   retenciones:   líneas calculadas (concepto, tarifa, base, tope, valor).
  //                  Es una FOTO del momento de guardar: así la orden no
  //                  cambia si el catálogo de tarifas se actualiza otro año.
  //   retencionMotivo/Detalle: por qué no aplica (RST, tratamiento especial...)
  retencionModo: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ninguna' },
  retencionMotivo: { type: DataTypes.STRING(120) },
  retencionDetalle: { type: DataTypes.STRING(255) },
  retenciones: { type: DataTypes.JSON },
  retencionValor: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
}, {
  tableName: 'ordenes_compra',
  indexes: [{ unique: true, fields: ['empresa_id', 'consecutivo'] }],
});

module.exports = OrdenCompra;
SCRIPTEOF
echo "OK  src/modules/compras/models/OrdenCompra.js"

cat > src/modules/compras/services/compras.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../../config/database');
const OrdenCompra = require('../models/OrdenCompra');
const OrdenCompraItem = require('../models/OrdenCompraItem');
const FacturaCompra = require('../models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const documentoSoporteAdapter = require('../../../integrations/adapters/documentoSoporteAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');
const { crearConSecutivoUnico } = require('../../../core/services/consecutivos');
// Mismo archivo que usa el navegador: lo que se ve al digitar es lo que se guarda.
const calcularOrden = require('../../../../public/contable/calculoOrden');
const retencionesCatalogo = require('../../../../public/contable/retencionesCatalogo');

// Lo que llega del cliente por cada retención es solo {codigo, tarifa?}
// (tarifa solo para "Otro concepto"). Nombre, tarifa oficial, tope en UVT y
// base de cálculo se toman SIEMPRE del catálogo del servidor.
function prepararDatosOrden(datos) {
  if (datos.retencionModo !== 'aplica') return { ...datos, retenciones: [] };
  const entradas = Array.isArray(datos.retenciones) ? datos.retenciones : [];
  return { ...datos, retenciones: entradas.map((e) => retencionesCatalogo.especificar(e)) };
}

// Campos de cabecera derivados del cálculo (impuestos, AIU, retención).
function camposCalculados(cabecera, datos) {
  return {
    subtotal: cabecera.subtotal,
    iva: cabecera.iva,
    impoconsumo: cabecera.impoconsumo,
    total: cabecera.total,
    aplicaAiu: cabecera.aplicaAiu,
    aiuAdministracion: cabecera.aiuAdministracion,
    aiuImprevistos: cabecera.aiuImprevistos,
    aiuUtilidad: cabecera.aiuUtilidad,
    aiuBaseIva: cabecera.aiuBaseIva,
    retencionModo: cabecera.retencionModo,
    retencionMotivo: cabecera.retencionModo === 'no_aplica' ? cabecera.retencionMotivo : null,
    retencionDetalle: cabecera.retencionModo === 'no_aplica' ? cabecera.retencionDetalle || null : null,
    retenciones: cabecera.retenciones,
    retencionValor: cabecera.retencionValor,
  };
}

async function guardarItems(ordenId, lineas, transaction) {
  for (const l of lineas) {
    await OrdenCompraItem.create(
      {
        id: uuidv4(),
        ordenCompraId: ordenId,
        concepto: l.concepto,
        cantidad: l.cantidad,
        unidadMedida: l.unidadMedida || 'UND',
        valorUnitario: l.valorUnitario,
        tipoImpuesto: l.tipoImpuesto,
        impuestoPorcentaje: l.impuestoPorcentaje,
        valorTotal: l.valorTotal,
        impuestoValor: l.impuestoValor,
      },
      { transaction }
    );
  }
}

// Crea una orden de adquisición (bienes o servicios) en "borrador". Si
// vienen "items", se crean como OrdenCompraItem y todos los totales
// (subtotal, IVA, Impoconsumo, AIU, retención) se calculan en el
// servidor con calculoOrden.js — no se confía en totales mandados a
// mano. Sin items, respeta subtotal/iva/total por compatibilidad.
async function crearOrden(datos, usuario) {
  const hayItems = Array.isArray(datos.items) && datos.items.length > 0;
  // Se calcula (y valida) ANTES de abrir la transacción: si el
  // porcentaje de retención viene mal, falla sin consumir consecutivo.
  const calculo = hayItems ? calcularOrden(prepararDatosOrden(datos)) : null;

  return crearConSecutivoUnico(OrdenCompra, usuario.empresaId, 'ODA', async (consecutivo, transaction) => {
    const orden = await OrdenCompra.create(
      {
        id: uuidv4(),
        empresaId: usuario.empresaId,
        terceroId: datos.terceroId,
        tipo: datos.tipo || 'bienes',
        consecutivo,
        fecha: datos.fecha || new Date(),
        fechaRequerida: datos.fechaRequerida,
        proyectoId: datos.proyectoId || null,
        proyecto: datos.proyecto,
        lugarEntrega: datos.lugarEntrega,
        formaPago: datos.formaPago,
        estado: 'borrador',
        subtotal: datos.subtotal || 0,
        iva: datos.iva || 0,
        total: datos.total || 0,
        ...(calculo ? camposCalculados(calculo.cabecera, datos) : {}),
      },
      { transaction }
    );

    if (calculo) await guardarItems(orden.id, calculo.lineas, transaction);

    return orden;
  });
}

// borrador/emitida -> aprobada (aprobador interno, no el proveedor)
async function aprobarOrden(id, usuario) {
  const orden = await OrdenCompra.findByPk(id);
  if (!['borrador', 'emitida'].includes(orden.estado)) {
    throw new Error('Solo se puede aprobar una orden en estado "borrador" o "emitida".');
  }
  await orden.update({ estado: 'aprobada', aprobadorId: usuario.id });
  return orden;
}

async function listarOrdenes(usuario) {
  return OrdenCompra.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

async function listarFacturas(usuario) {
  return FacturaCompra.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Cierra manualmente una orden aprobada/recibida contra una factura que
// el usuario ya tiene en mano. Con orden de compra de por medio, el
// nivel de automatización es más alto (ver tabla de reglas del módulo).
async function convertirOrdenEnFactura(ordenId, usuario) {
  const orden = await OrdenCompra.findByPk(ordenId);

  if (!['aprobada', 'recibida_parcial', 'recibida_total'].includes(orden.estado)) {
    throw new Error('La orden debe estar aprobada o recibida para facturarse.');
  }

  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: orden.empresaId,
    terceroId: orden.terceroId,
    ordenCompraOrigenId: orden.id,
    fecha: new Date(),
    // subtotal = todo lo que no es IVA: base (ítems + AIU) más el
    // Impoconsumo, que no es descontable y se lleva como mayor valor
    // del costo/gasto. Así subtotal + iva = total siempre cuadra.
    subtotal: Number(orden.total) - Number(orden.iva),
    iva: orden.iva,
    total: orden.total,
  });

  await orden.update({ estado: 'facturada' });

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: 'factura_compra_con_orden',
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
    usuarioId: usuario?.id,
  });

  return factura;
}

// Llamado desde el webhook cuando un proveedor que sí factura
// electrónicamente emite una factura a nuestro nombre y llega vía
// RADIAN o el proveedor tecnológico. Ya viene validada ante la DIAN,
// así que se contabiliza directo (sin pasar por estado "borrador").
//
// TODO: la mecánica exacta para RECIBIR facturas vía RADIAN (o si el
// proveedor tecnológico contratado lo resuelve por su cuenta y solo nos
// avisa por webhook) todavía hay que investigarla con el proveedor
// específico que se contrate — no está 100% definida.
async function registrarFacturaRecibida(datos) {
  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: datos.empresaId,
    terceroId: datos.terceroId,
    ordenCompraOrigenId: datos.ordenCompraOrigenId || null,
    fecha: datos.fecha || new Date(),
    subtotal: datos.subtotal,
    iva: datos.iva || 0,
    total: datos.total,
    cufe: datos.cufe,
    xmlUrl: datos.xmlUrl,
    estadoConciliacion: 'contabilizada',
  });

  // Sin orden de compra de por medio, nivel de automatización más bajo
  // (nivel 2: exige clasificar costo vs. gasto — ver tabla de reglas).
  const evento = factura.ordenCompraOrigenId
    ? 'factura_compra_con_orden'
    : 'factura_compra_sin_orden';

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: evento,
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
  });

  return factura;
}

// El documento soporte lo EMITE el propio comprador (nuestro cliente),
// porque el proveedor no está obligado a facturar. Flujo simétrico al
// de ventas: se envía al proveedor tecnológico y solo se contabiliza
// cuando confirma (ver confirmarDocumentoSoporteEmitido).
async function emitirDocumentoSoporte(datos, usuario) {
  const documento = await DocumentoSoporteAdquisicion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    fecha: datos.fecha || new Date(),
    concepto: datos.concepto,
    valor: datos.valor,
    estadoSincronizacion: 'pendiente',
  });

  const respuesta = await documentoSoporteAdapter.emitirDocumentoSoporte(documento);

  await documento.update({
    idTransaccionExterna: respuesta.idTransaccionExterna,
    estadoSincronizacion: 'enviado',
  });

  return documento;
}

// Llamado desde el webhook cuando el proveedor tecnológico confirma que
// la DIAN validó nuestro documento soporte.
async function confirmarDocumentoSoporteEmitido(documentoId, datosProveedor) {
  const documento = await DocumentoSoporteAdquisicion.findByPk(documentoId);

  await documento.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
  });

  // La primera vez por proveedor exige clasificar la cuenta (nivel 2);
  // ver la regla 'documento_soporte_compra' y su memorización por tercero.
  await contabilizarEvento({
    empresaId: documento.empresaId,
    tipoEvento: 'documento_soporte_compra',
    origenModulo: 'compras',
    origenId: documento.id,
    valor: documento.valor,
    terceroId: documento.terceroId,
  });

  return documento;
}

// Orden con sus ítems — para "Ver ítems", "Editar" y el PDF.
async function obtenerOrden(id, usuario) {
  const orden = await OrdenCompra.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!orden) return null;

  const items = await OrdenCompraItem.findAll({ where: { ordenCompraId: id } });
  const datos = orden.toJSON();

  // Desglose listo para mostrar (valores del AIU en pesos, base,
  // retención y neto a pagar). Se recalcula con los mismos datos
  // guardados; "modo formulario" para no fallar con órdenes viejas que
  // no tienen nada de esto.
  // Las retenciones se calculan con la foto guardada (no con el catálogo
  // vigente), para que una orden vieja no cambie al actualizar tarifas.
  const { cabecera, netoAPagar } = calcularOrden(
    { ...datos, items: items.map((i) => i.toJSON()), retenciones: datos.retenciones || [] },
    { estricto: false }
  );
  // Órdenes anteriores a los ítems/AIU/retención conservan sus totales guardados.
  const calculo = items.length > 0 ? { ...cabecera, netoAPagar } : null;

  return { ...datos, items, calculo };
}

// Edita una orden — solo mientras sigue en "borrador", mismo criterio
// y misma mecánica (reemplaza todos los ítems dentro de una
// transacción) que actualizarCotizacion en ventas.service.js.
async function actualizarOrden(id, datos, usuario) {
  const orden = await OrdenCompra.findOne({ where: { id, empresaId: usuario.empresaId } });
  if (!orden) return null;

  if (orden.estado !== 'borrador') {
    throw new Error('Solo se puede editar una orden en estado "borrador".');
  }

  const calculo = calcularOrden(prepararDatosOrden(datos));

  return sequelize.transaction(async (transaction) => {
    await orden.update(
      {
        terceroId: datos.terceroId,
        tipo: datos.tipo || 'bienes',
        fechaRequerida: datos.fechaRequerida,
        proyectoId: datos.proyectoId || null,
        proyecto: datos.proyecto,
        lugarEntrega: datos.lugarEntrega,
        formaPago: datos.formaPago,
        ...camposCalculados(calculo.cabecera, datos),
      },
      { transaction }
    );

    await OrdenCompraItem.destroy({ where: { ordenCompraId: id }, transaction });
    await guardarItems(id, calculo.lineas, transaction);

    return orden;
  });
}

module.exports = {
  crearOrden,
  aprobarOrden,
  listarOrdenes,
  listarFacturas,
  obtenerOrden,
  actualizarOrden,
  convertirOrdenEnFactura,
  registrarFacturaRecibida,
  emitirDocumentoSoporte,
  confirmarDocumentoSoporteEmitido,
};
SCRIPTEOF
echo "OK  src/modules/compras/services/compras.service.js"

cat > tests/calculoOrden.test.js << 'SCRIPTEOF'
// Ejecutar con: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const calcularOrden = require('../public/contable/calculoOrden');
const cat = require('../public/contable/retencionesCatalogo');

// Línea de retención ya "especificada" a partir del catálogo.
const ret = (codigo, tarifa) => cat.especificar({ codigo, tarifa });

const item = (valorUnitario, extra = {}) => ({ concepto: 'x', cantidad: 1, valorUnitario, ...extra });

test('ODA-016-2026: servicios, IVA 19% y retención 2,5%', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(906807)],
    retencionModo: 'aplica',
    retenciones: [ret('RF-01')], // Compras generales (declarantes) 2,5%
  });
  assert.equal(r.cabecera.subtotal, 906807);
  assert.equal(r.cabecera.iva, 172293.33);
  assert.equal(r.cabecera.total, 1079100.33);
  assert.equal(r.cabecera.retencionValor, 22670.18);
  assert.equal(r.netoAPagar, 1056430.15);
});

test('AIU 10/5/5 sobre 1.000.000 con IVA sobre el total', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
  });
  assert.equal(r.cabecera.aiuAdministracionValor, 100000);
  assert.equal(r.cabecera.aiuImprevistosValor, 50000);
  assert.equal(r.cabecera.aiuUtilidadValor, 50000);
  assert.equal(r.cabecera.base, 1200000);
  assert.equal(r.cabecera.iva, 228000);
  assert.equal(r.cabecera.total, 1428000);
});

test('AIU con IVA solo sobre la utilidad', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
    aiuBaseIva: 'utilidad',
  });
  assert.equal(r.cabecera.iva, 9500);
  assert.equal(r.cabecera.total, 1209500);
});

test('AIU se ignora en órdenes de bienes', () => {
  const r = calcularOrden({
    tipo: 'bienes',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
  });
  assert.equal(r.cabecera.aplicaAiu, false);
  assert.equal(r.cabecera.base, 1000000);
  assert.equal(r.cabecera.iva, 190000);
  assert.equal(r.cabecera.total, 1190000);
});

test('IVA, Impoconsumo y exento mezclados', () => {
  const r = calcularOrden({
    tipo: 'bienes',
    items: [
      item(100000, { tipoImpuesto: 'iva', impuestoPorcentaje: 19 }),
      item(100000, { tipoImpuesto: 'impoconsumo', impuestoPorcentaje: 8 }),
      item(50000, { tipoImpuesto: 'exento' }),
    ],
  });
  assert.equal(r.cabecera.subtotal, 250000);
  assert.equal(r.cabecera.iva, 19000);
  assert.equal(r.cabecera.impoconsumo, 8000);
  assert.equal(r.cabecera.total, 277000);
});

test('Retención con AIU se calcula sobre subtotal + AIU, no sobre el IVA', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(1000000)],
    aplicaAiu: true,
    aiuAdministracion: 10,
    aiuImprevistos: 5,
    aiuUtilidad: 5,
    retencionModo: 'aplica',
    retenciones: [ret('RF-14')], // Servicios generales (declarantes) 4%
  });
  assert.equal(r.cabecera.retenciones[0].base, 1200000);
  assert.equal(r.cabecera.retencionValor, 48000); // 1.200.000 × 4%
  assert.equal(r.netoAPagar, 1380000); // 1.428.000 − 48.000
});

test('Retefuente + ReteIVA en la misma orden', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(906807)],
    retencionModo: 'aplica',
    retenciones: [ret('RF-14'), ret('RF-41')], // 4% sobre la base + 15% sobre el IVA
  });
  assert.equal(r.cabecera.retenciones[0].valor, 36272.28); // 906.807 × 4%
  assert.equal(r.cabecera.retenciones[1].base, 172293.33);
  assert.equal(r.cabecera.retenciones[1].valor, 25844); // 172.293,33 × 15%
  assert.equal(r.cabecera.retencionValor, 62116.28);
  assert.equal(r.netoAPagar, 1016984.05); // 1.079.100,33 − 62.116,28
});

test('Concepto sobre AIU (vigilancia y aseo) retiene solo sobre el AIU', () => {
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(10000000)],
    aplicaAiu: true,
    aiuAdministracion: 8,
    aiuImprevistos: 2,
    aiuUtilidad: 5,
    retencionModo: 'aplica',
    retenciones: [ret('RF-23')], // 2% sobre AIU
  });
  assert.equal(r.cabecera.aiuTotal, 1500000);
  assert.equal(r.cabecera.retenciones[0].base, 1500000);
  assert.equal(r.cabecera.retencionValor, 30000);
});

test('Concepto sobre AIU sin AIU discriminado: no retiene y avisa', () => {
  const r = calcularOrden(
    { tipo: 'servicios', items: [item(10000000)], retencionModo: 'aplica', retenciones: [ret('RF-23')] }
  );
  assert.equal(r.cabecera.retencionValor, 0);
  assert.match(r.cabecera.retenciones[0].nota, /AIU/);
});

test('Base por debajo del tope en UVT: la línea no retiene', () => {
  // Servicios: tope 2 UVT = 104.748. Base de 100.000 no lo alcanza.
  const r = calcularOrden({
    tipo: 'servicios',
    items: [item(100000)],
    retencionModo: 'aplica',
    retenciones: [ret('RF-14')],
  });
  const l = r.cabecera.retenciones[0];
  assert.equal(l.baseMinima, 104748);
  assert.equal(l.aplica, false);
  assert.equal(l.valor, 0);
  assert.match(l.nota, /tope/);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('Base exactamente en el tope sí retiene', () => {
  const r = calcularOrden({ tipo: 'servicios', items: [item(104748)], retencionModo: 'aplica', retenciones: [ret('RF-14')] });
  assert.equal(r.cabecera.retenciones[0].aplica, true);
});

test('Concepto sin tope (honorarios) retiene desde el primer peso', () => {
  const r = calcularOrden({ tipo: 'servicios', items: [item(10000)], retencionModo: 'aplica', retenciones: [ret('RF-32')] });
  assert.equal(r.cabecera.retencionValor, 1100); // 11%
});

test('"Otro concepto" usa la tarifa digitada', () => {
  const r = calcularOrden({ items: [item(1000000)], retencionModo: 'aplica', retenciones: [ret('OTRO', 3)] });
  assert.equal(r.cabecera.retencionValor, 30000);
  assert.throws(() => ret('OTRO', 0), /tarifa/);
});

test('Modo "aplica" sin líneas falla en estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(1000)], retencionModo: 'aplica', retenciones: [] }), /concepto de retención/);
});

test('Concepto desconocido falla al especificar', () => {
  assert.throws(() => cat.especificar({ codigo: 'RF-99' }), /no reconocido/);
});

test('Formulario a medias (modo aplica, línea vacía) se calcula en cero sin lanzar error', () => {
  const lineaVacia = cat.especificar({ codigo: '' }, { estricto: false });
  const r = calcularOrden(
    { items: [item(1000)], retencionModo: 'aplica', retenciones: [lineaVacia] },
    { estricto: false }
  );
  assert.equal(r.cabecera.retencionValor, 0);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('"No aplica retención" guarda el motivo y no retiene', () => {
  const r = calcularOrden({
    items: [item(5000000)],
    retencionModo: 'no_aplica',
    retencionMotivo: 'Proveedor en Régimen Simple de Tributación (RST)',
    retencionDetalle: 'Certificado RST 2026',
    retenciones: [ret('RF-01')], // se ignora
  });
  assert.equal(r.cabecera.retencionModo, 'no_aplica');
  assert.equal(r.cabecera.retencionMotivo, 'Proveedor en Régimen Simple de Tributación (RST)');
  assert.equal(r.cabecera.retenciones.length, 0);
  assert.equal(r.cabecera.retencionValor, 0);
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('"No aplica retención" sin motivo falla en estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(1000)], retencionModo: 'no_aplica' }), /motivo/);
});

test('Sin retención (modo ninguna), el neto es igual al total', () => {
  const r = calcularOrden({ items: [item(1000)] });
  assert.equal(r.cabecera.retencionModo, 'ninguna');
  assert.equal(r.netoAPagar, r.cabecera.total);
});

test('Catálogo: 48 conceptos con tarifa válida y códigos únicos', () => {
  assert.equal(cat.CONCEPTOS.length, 48);
  assert.equal(new Set(cat.CONCEPTOS.map((c) => c.codigo)).size, 48);
  for (const c of cat.CONCEPTOS) assert.ok(c.tarifa > 0 && c.tarifa <= 100, c.codigo);
  assert.equal(cat.UVT_VALOR, 52374);
});

test('Valores negativos fallan en modo estricto', () => {
  assert.throws(() => calcularOrden({ items: [item(-5)] }), /negativos/);
});
SCRIPTEOF
echo "OK  tests/calculoOrden.test.js"

cat > README.md << 'SCRIPTEOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
PostgreSQL en Supabase).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Página institucional de Libaniel Consulting (raíz del dominio)
├── style.css                  Estilos del sitio institucional
└── contable/                  El software contable en sí, en /contable
    ├── index.html                Login + tablero con pestañas por módulo
    ├── style.css                 Estética de libro contable (IBM Plex, reglas horizontales)
    └── app.js                    Login, consumo de la API, formularios y acciones por rol
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa (con logo), Tercero (persona natural/
│   │                           jurídica, ubicación, régimen y responsabilidades
│   │                           DIAN, cuenta bancaria), Proyecto (futuro centro
│   │                           de costo), PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario, Usuario, LogAuditoria
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       ├── cierrePeriodo.js    Máquina de estados del cierre mensual
│       ├── authService.js      Login y registro de usuarios
│       ├── auditoria.js        Registro de acciones sensibles
│       ├── seedService.js      Datos base: empresa, periodo, cuentas, reglas
│       └── consecutivos.js     Numeración legible tipo COT-2026-0001 / ODA-2026-0001
├── modules/                  # Módulos operativos (capa transaccional) — TODOS completos
│   ├── ventas/                 Cotización → factura, patrón de referencia
│   ├── compras/                Factura recibida + documento soporte, orden de compra
│   ├── nomina/                 Periodo → empleados → liquidar → documento soporte
│   ├── inventarios/            Kardex simplificado: entradas, salidas, ajustes
│   ├── activosFijos/           Registro, depreciación mensual (cron), baja
│   └── tesoreria/               Cuentas bancarias, movimientos, conciliación
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
│   ├── depreciacionMensual.js  Implementado — recorre todas las empresas
│   └── vencimientoCotizaciones.js
├── middleware/                # authenticate + authorize por rol
└── routes/                   # Router raíz (auth, seed, terceros, y los 6 módulos)
```

## Aprovisionar una empresa nueva

Desde la pantalla de login, "¿Primera vez? Crear empresa y usuario" abre
un flujo de dos pasos: `POST /api/empresas` crea la empresa (razón
social, NIT, régimen tributario —ordinario, RST o especial—,
responsable de IVA, correo, teléfono, dirección, departamento,
municipio, representante legal y su documento, código CIIU y matrícula
mercantil), luego `POST /api/auth/registro` crea su primer usuario (rol
`contador` o `dueño` recomendado). `PATCH /api/empresas/:id` permite
editar estos datos después. Los tres endpoints quedan abiertos por
ahora — ver el TODO en `src/routes/empresas.routes.js` antes de tener
más de un puñado de empresas reales.

Al iniciar sesión, el panel **Inicio** (pestaña por defecto, ya no
Terceros) saluda por nombre, muestra la razón social de la empresa, y
presenta los nueve módulos como tarjetas — clic en cualquiera navega
directo a esa sección.

## Límite de tamaño del body JSON

`express.json()` ahora acepta hasta 5mb (antes, el default de Express
es 100kb). Lo necesita el logo de empresa, que se manda como base64
dentro del JSON — sin este cambio, cualquier imagen un poco pesada
hacía que la petición se rechazara antes de llegar a nuestro código,
con un error genérico ("Error inesperado") que no decía qué había
pasado de verdad. `api()` en el frontend ahora también reconoce un 413
específicamente y muestra un mensaje claro.

## Caché de archivos estáticos

`express.static` ahora manda `Cache-Control: no-cache` en todo lo que
sirve desde `public/` (HTML, CSS, JS). Antes de esto, durante una
etapa con despliegues tan frecuentes, era fácil que el navegador (o el
CDN de Hostinger) se quedara sirviendo una versión vieja de `app.js`
mientras el HTML ya estaba actualizado — un botón nuevo aparecía en
pantalla pero no hacía nada, porque el JavaScript que lo conectaba
seguía siendo el de antes. Si algo similar vuelve a pasar (un botón
nuevo no responde, pero el código se ve bien), lo primero a probar es
una recarga forzada (Ctrl+Shift+R) o una ventana de incógnito antes de
asumir que el código tiene un error real.

**Versión en la URL de los archivos (`?v=`)**: aun con `Cache-Control: no-cache`, el CDN de Hostinger o el
navegador pueden seguir entregando un `app.js` o `style.css` viejo con un `index.html` nuevo (pasó el
12/oct/2026: el formulario mostraba el bloque nuevo de retención pero el JS era el anterior, así que la
retención "no hacía nada"). Por eso `public/contable/index.html` pide los archivos con `?v=AAAAMMDD-n`.
**Cada vez que cambie `app.js`, `style.css`, `calculoOrden.js` o `retencionesCatalogo.js`, subir ese valor
en `index.html`.** Para comprobar qué versión está sirviendo producción, abrir
`/contable/app.js?v=<valor>` y buscar un texto que solo exista en la versión nueva.

## Mi Empresa

Pestaña nueva en el tablero (al final del menú, como una sección de
configuración) donde se edita el perfil completo de la empresa —todos
los campos que ya existían en el registro inicial, incluido el logo—
usando `PATCH /api/empresas/:id`. Si no se elige un archivo nuevo al
guardar, el logo actual se conserva (no se borra por accidente).

## Logo de empresa

`Empresa.logoBase64` guarda el logo como data URI (base64) directo en
la base de datos, no como archivo en disco — en el hosting de Node de
Hostinger un archivo subido podría perderse en un redeploy, así que
esto evita esa dependencia. Límite de 2MB desde el frontend. Aparece en
el encabezado de `cotizacion-imprimir.html` y `orden-imprimir.html`
cuando existe.

## Proyectos (futuro centro de costo)

Catálogo nuevo (`Proyecto`: nombre, código/ID del centro de costo,
objeto, contratante —referencia a Tercero—, valor total, activo) para
los contratos/negocios/proyectos de la empresa. Hoy se usa desde
Órdenes de Adquisición (`OrdenCompra.proyectoId`, con el campo de texto
viejo `proyecto` conservado solo por compatibilidad con órdenes
anteriores al catálogo). Pendiente real: conectarlo con
`Movimiento.centroCosto` (hoy sigue siendo texto libre) para que la
segmentación contable por proyecto sea automática, no solo informativa
en las órdenes.

## Orden de adquisición: impuestos, AIU y retención

El cálculo de totales vive en **un solo archivo**, `public/contable/calculoOrden.js`,
que usan tanto el navegador (vista previa mientras se digita y PDF) como el
backend (`compras.service.js`, con `require`). El servidor siempre recalcula al
guardar; nunca confía en totales que lleguen del cliente. Pruebas:
`node --test tests/calculoOrden.test.js` (incluye el caso real ODA-016-2026).

- **IVA e Impoconsumo** se discriminan por separado (`OrdenCompra.iva` / `.impoconsumo`).
- **AIU** (Administración, Imprevistos, Utilidad): solo en órdenes de *servicios*; cada % se
  calcula sobre el subtotal. IVA 19% sobre (subtotal + AIU), o solo sobre la Utilidad
  (`aiuBaseIva = 'utilidad'`). Con AIU se ignora el IVA individual de los ítems.
- **Retención en la fuente** (informativa para el proveedor; no se suma al total, se resta para
  dar el **neto a pagar**). Tres opciones por orden: *No indicar*, *Aplicar* o *No aplica*.
  - *Aplicar*: una o varias líneas; cada una se elige **manualmente** del catálogo 2026
    (`public/contable/retencionesCatalogo.js`, 48 conceptos tomados del Excel de la firma: tarifa,
    tope en UVT y sobre qué se aplica). Se puede combinar, p. ej., retefuente de servicios + ReteIVA.
    La base es subtotal + AIU antes de impuestos; los conceptos "sobre AIU" (temporales, vigilancia y
    aseo) usan solo el AIU y ReteIVA usa el valor del IVA. Si la base no alcanza el tope en UVT
    (medido por orden), esa línea no retiene. "Otro concepto" permite digitar la tarifa.
  - *No aplica*: exige motivo (Régimen Simple, tratamiento especial, no supera el tope, otro) y
    detalle opcional; se imprime en el PDF.
  - El servidor toma tarifas y topes **del catálogo** (el cliente solo manda el código) y guarda una
    **foto** de las líneas calculadas (`OrdenCompra.retenciones`), para que una orden vieja no
    cambie cuando se actualice el catálogo en otro año. Para cambiar de año: editar `ANIO`,
    `UVT_VALOR` y el arreglo de conceptos.
  - **Proyección de pago** en el PDF: valor total de la orden (impuestos incluidos), cada retención
    descontada con su tarifa y base, y el **valor que recibirá el proveedor en su cuenta**
    (con su cuenta bancaria si está registrada). Es solo informativa: la orden no genera asientos
    contables; el único asiento ocurre al convertirla en factura de compra y hoy usa el total
    bruto (la retención aún no se contabiliza).
  - UVT 2026 = $52.374 (Res. DIAN 000238/2025). El Excel traía la columna VALOR con 52.400; el
    sistema usa la oficial.
- Al convertir la orden en factura de compra, `subtotal = total − iva`, de modo que el
  Impoconsumo (no descontable) queda como mayor valor del costo y `subtotal + iva = total`.

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).

La raíz del dominio (`/`) es la página institucional de **Libaniel
Consulting**, pensada para ofrecer varios servicios de la firma — hoy
solo el software contable es real, los otros dos son marcadores de
posición con un `mailto:` genérico (`contacto@libanielconsulting.com`)
hasta que se definan de verdad.

El software contable en sí vive en **`/contable`** — mismo backend,
solo un subdirectorio distinto en `public/`. Cubre creación y las
transiciones de estado principales de los seis módulos (formularios
inline + botones de acción por fila según el estado del registro). Dos
simplificaciones deliberadas por ahora:
acciones que piden un solo dato adicional puntual (agregar empleado a
un periodo, entradas/salidas/ajustes de inventario) usan `prompt()` del
navegador en vez de un formulario modal propio; y no hay edición ni
borrado de nada, solo creación y transiciones hacia adelante.

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa y resuelve solo el periodo
   contable vigente si no se le pasa explícito.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).
6. **Un movimiento bancario sin conciliar bloquea el cierre del periodo**
   (ver `cierrePeriodo.validarPeriodo`).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de la base de datos y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Sitios web → Apps Node.js → conectar el repositorio de GitHub.
2. Base de datos: PostgreSQL vía Supabase (host, puerto, nombre, usuario y
   contraseña como `DB_*` en las variables de entorno de la app).
3. hPanel → Avanzado → Cron Jobs → programar:
   - `node src/jobs/depreciacionMensual.js` — día 1 de cada mes
   - `node src/jobs/vencimientoCotizaciones.js` — diario

## Roles y autenticación

Cuatro roles, controlados por `src/middleware/auth.js` (`authenticate` +
`authorize(...roles)`):

| Rol | Puede |
|---|---|
| `dueño` | Operar el sistema, certificar el cierre mensual |
| `contador` | Todo lo anterior + reabrir un periodo certificado |
| `auxiliar` | Registrar operaciones del día a día (ventas, compras, nómina) |
| `revisor` | Solo lectura (pendiente de aplicar en cada ruta) |

`POST /api/auth/login` y `POST /api/auth/registro` son las únicas rutas
públicas. Todas las demás requieren `Authorization: Bearer <token>`.

## Datos base (seed)

`POST /api/seed` (requiere sesión con rol `contador` o `dueño`) crea:
una empresa de prueba, el periodo contable del mes en curso, un plan de
cuentas de 22 cuentas, y 13 reglas de contabilización — una por cada
evento que disparan los seis módulos operativos. Seguro de correr más
de una vez — no duplica nada. Sin esto, `motorAsientos` no tiene con
qué contabilizar.

## Pendientes inmediatos

- [ ] **Retención en la fuente en órdenes es solo informativa**: no genera asiento (retención por pagar) ni la usa `convertirOrdenEnFactura` / `motorAsientos`. Falta decidir si se contabiliza al causar la factura o al pagar (Tesorería)
- [ ] Retención: el concepto se elige a mano en cada orden; no se deriva automáticamente de `Tercero.tipoPersona` / `responsabilidadesFiscales` (declarante / no declarante, RST). El tope en UVT se mide **por orden**, sin acumular los pagos del mes o del año al mismo proveedor. Validar los conceptos y tarifas del catálogo con el contador
- [ ] AIU en órdenes: igual que en cotizaciones, no admite mezclar ítems exentos/Impoconsumo con IVA sobre la base AIU (el Impoconsumo de los ítems se suma aparte; el IVA individual de los ítems se ignora)
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` usan `<script>` y `<style>` en línea, y `server.js` define una CSP `script-src 'self'` / `style-src 'self'`. Un navegador que respete esa CSP los bloquea (probado en un entorno local sin proxy). Si en algún momento las páginas de impresión dejan de cargar, mover ese JS/CSS a archivos externos

- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] **Migraciones de Sequelize (`sequelize-cli`)** en vez de `sync({ alter: true })` — ya tenemos evidencia concreta de por qué importa: con cada redeploy que tocó el modelo, Sequelize fue acumulando una restricción única duplicada sobre `consecutivo` en vez de reconocer que ya existía una (llegaron a existir 23 restricciones idénticas en `ordenes_compra`, ver corrección en Supabase del 30/sep/2026). `alter: true` es cómodo para esta etapa pero no es confiable para cambios de índices/restricciones a largo plazo
- [ ] Reemplazar `FACTOR_PRESTACIONES` (21.83% fijo) en `nomina.service.js` por el cálculo exacto de cesantías, intereses, prima y vacaciones según la normativa laboral vigente y el tipo de contrato
- [ ] Integrar `NovedadNomina` con el cálculo del devengado (hoy es solo un registro informativo, no ajusta nada automáticamente)
- [ ] Tesorería: cruzar movimientos de tipo ingreso/egreso contra la factura, orden o nómina específica que pagan (hoy solo "comisión" se contabiliza sola al conciliar; el resto solo queda marcado como conciliado, sin generar el asiento de pago)
- [ ] Mapear cada `CuentaBancaria` a su propia subcuenta contable — hoy todas comparten el código 1110 Bancos
- [ ] Soportar múltiples líneas (débito/crédito) por evento en `motorAsientos` — hoy una venta no discrimina el IVA en un renglón aparte
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `DELETE` de terceros (crear, listar y editar ya existen; falta borrar)
- [ ] Vincular `MovimientoInventario` con los ítems reales de `FacturaVenta`/`FacturaCompra` — hoy las entradas y salidas se registran manualmente por API, no automático desde una venta
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Reemplazar los `prompt()` del navegador (agregar empleado a nómina, entradas/salidas/ajustes de inventario) por formularios modales propios en el frontend; agregar edición/borrado en general
- [ ] Confirmar que `www.libanielconsulting.com` resuelve al mismo sitio que `libanielconsulting.com` (revisar en hPanel → Dominios, o agregar la redirección si falta)
- [ ] Definir de verdad los servicios 02 y 03 de la página institucional (`public/index.html`) y reemplazar el `mailto:contacto@libanielconsulting.com` por el correo real de la firma
- [x] ~~Fase 2, parte 2~~ — Órdenes de Adquisición ya tiene ítems dinámicos, "Ver ítems" y "Editar" (solo en borrador), igual que Cotizaciones
- [ ] Aplicar `mensajeError()` (`src/core/utils/mensajeError.js`) en los demás controladores — hoy `ventas.controller.js` y `compras.controller.js` lo usan; nómina, inventarios, activos fijos y tesorería todavía devuelven el mensaje genérico de Sequelize
- [ ] La opción "Otro (definir %)" de impuesto en el ítem se guarda como `tipoImpuesto: 'iva'` con el porcentaje manual — no distingue si en realidad era un Impoconsumo con tarifa distinta a 4/8/16%. Si eso resulta ser un caso frecuente, vale la pena dejar elegir tipo Y porcentaje por separado en vez de un solo desplegable combinado
- [ ] El cálculo de IVA cuando `aplicaAiu = true` sigue asumiendo 19% general sobre (subtotal + AIU) sin importar el `tipoImpuesto` real de los ítems — no contempla todavía una cotización con AIU que mezcle ítems de Impoconsumo o exentos
- [x] ~~Fase 3, parte 2~~ — `orden-imprimir.html` ya existe: mismo patrón que cotización, con los datos del proveedor (incluida su cuenta bancaria) en vez del cliente, y el proyecto resuelto desde el catálogo
- [ ] Validar con un caso real si el IVA de una cotización con AIU debe calcularse sobre (subtotal + AIU) como quedó programado, o de otra forma según el tipo de contrato — ver la nota en `crearCotizacion` (`ventas.service.js`)
- [ ] `GET /compras/ordenes/:id` con ítems (el de cotizaciones ya existe: `GET /ventas/cotizaciones/:id`) — necesario para "Ver ítems" y la Fase 3 en Órdenes
- [ ] "Enviar" (cotización) sigue siendo solo un cambio de estado — no manda correo ni WhatsApp automáticamente, el botón ahora lo aclara con un `confirm()`. El envío real de verdad (correo con el PDF adjunto, por ejemplo) requeriría configurar un proveedor de correo transaccional, que todavía no existe en el proyecto
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` generan el PDF usando "Imprimir" del navegador (`window.print()`), no una librería de generación de PDF en el servidor — evita agregar una dependencia pesada (ej. Puppeteer) que podría no funcionar bien en el hosting de Node de Hostinger. Si el formato de impresión del navegador resulta insuficiente, esto es lo primero a reconsiderar
- [ ] Conectar `Proyecto` con `Movimiento.centroCosto` para que la contabilidad se segmente por proyecto de verdad (hoy el catálogo solo se usa desde Órdenes de Adquisición)
- [x] ~~Editar un `Proyecto` desde la interfaz~~ — ya existe el botón "Editar" (mismo formulario que crear, incluye activar/desactivar y permite borrar datos opcionales). Falta solo **eliminar** (hoy se desactiva)
- [ ] Migrar las órdenes viejas que tienen `proyecto` (texto libre) pero no `proyectoId`, para que puedan filtrarse/agruparse igual que las nuevas
- [ ] Usar `Tercero.responsabilidadesFiscales` y `tipoPersona` para automatizar el cálculo de retención en la fuente (formulario 350) — hoy son solo datos capturados, no alimentan ningún cálculo todavía
- [ ] Consecutivos: ya son únicos por empresa (índice compuesto `empresa_id + consecutivo`, no `consecutivo` global) y toda la creación vive en una transacción real — un fallo a mitad de camino ya no deja un encabezado huérfano con el número gastado. Sigue sin bloqueo transaccional de secuencia bajo concurrencia muy alta (una tabla de secuencias con `SELECT ... FOR UPDATE` sería la solución definitiva si el volumen lo exige)
SCRIPTEOF
echo "OK  README.md"

echo ""
echo "Listo. Orden de adquisición actualizada."
echo "Las columnas nuevas de ordenes_compra (impoconsumo, AIU, retención) se crean solas al reiniciar el servidor."
echo "Prueba opcional del cálculo:  node --test tests/calculoOrden.test.js"
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Orden de adquisición: Impoconsumo, AIU, retención por concepto 2026, ID de proyecto y edición de proyectos\""
echo "  git push"
echo ""
echo "Después del despliegue abre /contable con Ctrl+F5. Los archivos ahora se piden con ?v=... para saltarse cualquier caché vieja."
