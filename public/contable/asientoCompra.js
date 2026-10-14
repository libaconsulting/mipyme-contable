// Asiento contable de una factura de compra.
//
// Igual que calculoOrden.js: UN solo archivo que usan el navegador (para
// mostrar el asiento antes de confirmar) y el backend (para guardarlo),
// de modo que lo que se ve es exactamente lo que se contabiliza. No
// depende de Node ni del DOM.
//
// Asiento:
//   Db  cuenta destino de cada línea (inventario / gasto / costo / activo)
//   Db  1355 IVA descontable      (si la empresa es responsable de IVA)
//   Cr  2365 Retención en la fuente por pagar
//   Cr  2367 ReteIVA por pagar
//   Cr  2205 Proveedores nacionales       total - retenciones
//       (o la cuenta que se indique en `cuentaPorPagar`, ej. 2335 en un documento soporte)
//
// Todo se calcula en centavos enteros para que el asiento cuadre siempre.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.asientoCompra = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const CUENTAS_FIJAS = {
    IVA_DESCONTABLE: '1355',
    PROVEEDORES: '2205',
    COSTOS_Y_GASTOS_POR_PAGAR: '2335',
    RETEFUENTE: '2365',
    RETEIVA: '2367',
  };

  const centavos = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100);
  const pesos = (c) => c / 100;

  // Reparte `total` (centavos, puede ser negativo) en proporción a `pesosLineas`
  // sin perder un centavo: el residuo va a la línea de mayor peso.
  function repartir(total, pesosLineas) {
    if (pesosLineas.length === 0) return [];
    const suma = pesosLineas.reduce((a, b) => a + b, 0);
    if (suma === 0) return pesosLineas.map((_, i) => (i === 0 ? total : 0));
    let asignado = 0;
    const partes = pesosLineas.map((p) => {
      const x = Math.round((total * p) / suma);
      asignado += x;
      return x;
    });
    partes[pesosLineas.indexOf(Math.max(...pesosLineas))] += total - asignado;
    return partes;
  }

  // datos:
  //   lineas        [{ valorTotal, iva, otrosImpuestos }]  de la factura
  //   base, iva, impoconsumo, total   valores contables de la factura
  //   ivaDescontable   true si la empresa es responsable de IVA
  //   cuentasLinea  [codigo]  cuenta destino de cada línea
  //   retenciones   [{ sobre: 'base'|'aiu'|'iva', valor }]  ya calculadas
  //   centroCosto   texto opcional (proyecto)
  //   cuentaPorPagar  opcional, por defecto 2205
  function armarAsientoCompra(datos) {
    const lineas = datos.lineas || [];
    if (lineas.length !== (datos.cuentasLinea || []).length) {
      throw new Error('Falta la cuenta destino de alguna línea.');
    }
    const ivaDescontable = !!datos.ivaDescontable;
    const baseCent = centavos(datos.base);
    const ivaCent = centavos(datos.iva);
    const totalCent = centavos(datos.total);

    const pesosLineas = lineas.map((l) => Math.max(0, centavos(l.valorTotal)));
    const sumaLineas = pesosLineas.reduce((a, b) => a + b, 0);

    // Mayor valor del gasto: impoconsumo y demás impuestos que no son IVA (siempre) y el
    // IVA si la empresa no es responsable (no lo puede descontar). Cada línea carga con sus
    // propios impuestos; lo que quede sin asignar (descuentos o cargos a nivel de factura,
    // impuestos que el XML solo trae en el resumen, diferencias menores) se reparte en
    // proporción al valor de cada línea.
    const propios = lineas.map((l) => centavos(l.otrosImpuestos) + (ivaDescontable ? 0 : centavos(l.iva)));
    const ajusteTotal = baseCent - sumaLineas + centavos(datos.impoconsumo) + (ivaDescontable ? 0 : ivaCent);
    const sobrante = repartir(ajusteTotal - propios.reduce((a, b) => a + b, 0), pesosLineas);

    const porCuenta = new Map();
    lineas.forEach((_, i) => {
      const cuenta = datos.cuentasLinea[i];
      porCuenta.set(cuenta, (porCuenta.get(cuenta) || 0) + pesosLineas[i] + propios[i] + sobrante[i]);
    });

    const asiento = [];
    for (const [cuentaCodigo, cent] of porCuenta) {
      asiento.push({ cuentaCodigo, debito: pesos(cent), credito: 0, centroCosto: datos.centroCosto || null });
    }
    if (ivaDescontable && ivaCent > 0) {
      asiento.push({ cuentaCodigo: CUENTAS_FIJAS.IVA_DESCONTABLE, debito: pesos(ivaCent), credito: 0 });
    }

    const retenciones = datos.retenciones || [];
    const reteIva = retenciones.filter((r) => r.sobre === 'iva').reduce((s, r) => s + centavos(r.valor), 0);
    const retTotal = retenciones.reduce((s, r) => s + centavos(r.valor), 0);
    const reteFuente = retTotal - reteIva;
    if (reteFuente > 0) asiento.push({ cuentaCodigo: CUENTAS_FIJAS.RETEFUENTE, debito: 0, credito: pesos(reteFuente) });
    if (reteIva > 0) asiento.push({ cuentaCodigo: CUENTAS_FIJAS.RETEIVA, debito: 0, credito: pesos(reteIva) });
    asiento.push({ cuentaCodigo: datos.cuentaPorPagar || CUENTAS_FIJAS.PROVEEDORES, debito: 0, credito: pesos(totalCent - retTotal) });

    const debitos = asiento.reduce((s, l) => s + centavos(l.debito), 0);
    const creditos = asiento.reduce((s, l) => s + centavos(l.credito), 0);
    return {
      lineas: asiento,
      // Lo que cargó cada línea de la factura a su cuenta (con su impuesto no descontable y su parte
      // de descuentos): es el costo de entrada al kardex cuando la línea va a inventario.
      valoresLinea: lineas.map((_, i) => pesos(pesosLineas[i] + propios[i] + sobrante[i])),
      totalDebito: pesos(debitos),
      totalCredito: pesos(creditos),
      cuadra: debitos === creditos,
      retencionTotal: pesos(retTotal),
      netoAPagar: pesos(totalCent - retTotal),
    };
  }

  return { armarAsientoCompra, repartir, CUENTAS_FIJAS };
});
