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
//  - Retención en la fuente: porcentaje sobre la base ANTES de impuestos
//    (subtotal + AIU). No se suma al total: se resta para obtener el
//    neto a pagar al proveedor.
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
    const aplicaRetencion = !!datos.aplicaRetencion;
    let retencionPorcentaje = aplicaRetencion ? numero(datos.retencionPorcentaje) : 0;
    if (aplicaRetencion && !(retencionPorcentaje > 0 && retencionPorcentaje <= 100)) {
      if (estricto) throw new Error('Indica el porcentaje de retención en la fuente (mayor a 0 y máximo 100).');
      retencionPorcentaje = 0;
    }
    const retencionValor = aplicaRetencion ? redondear(base * (retencionPorcentaje / 100)) : 0;

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
        aplicaRetencion,
        retencionPorcentaje,
        retencionValor,
      },
      netoAPagar: redondear(total - retencionValor),
    };
  }

  return calcularOrden;
});
