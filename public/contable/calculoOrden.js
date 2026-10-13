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
