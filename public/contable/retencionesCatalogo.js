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
