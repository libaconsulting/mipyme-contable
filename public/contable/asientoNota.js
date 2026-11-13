// Asiento contable de una nota crédito o débito (electrónica) que modifica una factura.
//
// Igual que asientoCompra.js y asientoVenta.js: UN solo archivo que usan el navegador (vista previa) y el backend
// (guardado), para que lo que se ve sea lo que se contabiliza. No depende de Node ni del DOM.
//
// La nota hace lo mismo que la factura que modifica:
//   - Nota DÉBITO  = el mismo asiento de la factura (aumenta lo que se debe o se cobra).
//   - Nota CRÉDITO = el asiento de la factura con débitos y créditos invertidos (anula o rebaja).
//
//   Compra, nota crédito (el proveedor nos rebaja):        Compra, nota débito (nos cobra más):
//     Db 2205 Proveedores         total − retenciones          Db gasto / costo / inventario   base
//     Db 2365 / 2367 retención    lo que se reversa            Db 1355 IVA descontable         IVA
//     Cr gasto / costo / inv.     base                         Cr 2205 Proveedores             total
//     Cr 1355 IVA descontable     IVA
//   Venta, nota crédito (le rebajamos al cliente):          Venta, nota débito (le cobramos más):
//     Db ingreso (por línea)      base                         Db 1305 Clientes                total
//     Db 2408 IVA por pagar       IVA                          Cr ingreso (por línea)          base
//     Cr 1305 Clientes            total − lo que se reversa    Cr 2408 IVA por pagar           IVA
//     Cr 135515 / 135517 / 135518 retenciones que se reversan
//     Cr gasto/costo              estampillas y tasas que se reversan
//
// Todo en centavos enteros para que el asiento cuadre siempre.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./asientoCompra'), require('./asientoVenta'));
  else raiz.asientoNota = fabrica(raiz.asientoCompra, raiz.asientoVenta);
})(typeof self !== 'undefined' ? self : this, function (asientoCompra, asientoVenta) {
  const centavos = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100);
  const pesos = (c) => c / 100;

  function invertir(lineas) {
    return lineas.map((l) => ({ ...l, debito: l.credito, credito: l.debito }));
  }

  // datos:
  //   lado          'compra' (la expide el proveedor) | 'venta' (la expide la empresa)
  //   tipo          'credito' | 'debito'
  //   lineas, base, iva, impoconsumo, total   valores de la nota (como en la factura)
  //   cuentasLinea  [codigo]  cuenta de cada línea (gasto/costo/inventario en compras; ingreso en ventas)
  //   ivaDescontable   (compras) true si la empresa es responsable de IVA
  //   reversa       solo en nota crédito. Compras: { retefuente, reteiva }.
  //                 Ventas: { retenciones: [{ cuentaCodigo, valor }], descuentos: [{ cuentaCodigo, valor }] }
  //   centroCosto   texto opcional (proyecto)
  function armarAsientoNota(datos) {
    const lado = datos.lado;
    const tipo = datos.tipo;
    if (!['compra', 'venta'].includes(lado)) throw new Error('La nota es de compra o de venta.');
    if (!['credito', 'debito'].includes(tipo)) throw new Error('La nota es crédito o débito.');
    const reversa = tipo === 'credito' ? datos.reversa || {} : {};

    let armado;
    let reversaCent = 0;
    if (lado === 'compra') {
      const fuente = centavos(reversa.retefuente);
      const reteIva = centavos(reversa.reteiva);
      if (fuente < 0 || reteIva < 0) throw new Error('Las retenciones que se reversan no pueden ser negativas.');
      reversaCent = fuente + reteIva;
      armado = asientoCompra.armarAsientoCompra({
        lineas: datos.lineas,
        base: datos.base,
        iva: datos.iva,
        impoconsumo: datos.impoconsumo,
        total: datos.total,
        ivaDescontable: datos.ivaDescontable,
        cuentasLinea: datos.cuentasLinea,
        retenciones: [
          { sobre: 'base', valor: pesos(fuente) },
          { sobre: 'iva', valor: pesos(reteIva) },
        ].filter((r) => centavos(r.valor) > 0),
        centroCosto: datos.centroCosto,
      });
    } else {
      const retenciones = reversa.retenciones || [];
      const descuentos = reversa.descuentos || [];
      reversaCent = [...retenciones, ...descuentos].reduce((s, x) => s + centavos(x.valor), 0);
      armado = asientoVenta.armarAsientoVenta({
        lineas: datos.lineas,
        base: datos.base,
        iva: datos.iva,
        total: datos.total,
        cuentasLinea: datos.cuentasLinea,
        retenciones,
        descuentos,
        centroCosto: datos.centroCosto,
      });
    }

    const lineas = tipo === 'credito' ? invertir(armado.lineas) : armado.lineas;
    const debitos = lineas.reduce((s, l) => s + centavos(l.debito), 0);
    const creditos = lineas.reduce((s, l) => s + centavos(l.credito), 0);
    return {
      lineas,
      totalDebito: pesos(debitos),
      totalCredito: pesos(creditos),
      cuadra: debitos === creditos && lineas.length > 1,
      reversaTotal: pesos(reversaCent),
      // Lo que la nota sube (débito) o baja (crédito) de lo que se debe al proveedor o se cobra al cliente.
      neto: pesos(centavos(datos.total) - reversaCent),
    };
  }

  return { armarAsientoNota };
});
