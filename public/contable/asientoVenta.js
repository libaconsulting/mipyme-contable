// Asiento contable de una factura de venta (emitida por la empresa).
//
// Igual que asientoCompra.js: UN solo archivo que usan el navegador (vista
// previa) y el backend (guardado), para que lo que se ve sea lo que se contabiliza.
//
// Asiento:
//   Db  1305 Clientes                       total de la factura
//   Cr  Ingreso (4135, 4155...)  por línea  base (agrupado por cuenta)
//   Cr  2408 IVA por pagar                  IVA
//
// Retenciones y descuentos que el cliente practicará (opcionales, los digita o confirma la persona al registrar la factura):
//   Db  135515 / 135517 / 135518  ReteFuente / ReteIVA / ReteICA (anticipo de impuestos)
//   Db  Gasto o costo             estampillas, tasas y contribuciones (no se recuperan en declaraciones)
// y entonces el Db 1305 Clientes baja a lo que realmente se va a cobrar (total − retenciones − descuentos).
// Si no se informan, se registran al recibir el pago (Tesorería). Todo en centavos enteros para que el asiento cuadre siempre.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./asientoCompra'));
  else raiz.asientoVenta = fabrica(raiz.asientoCompra);
})(typeof self !== 'undefined' ? self : this, function (asientoCompra) {
  const CUENTAS_FIJAS = { CLIENTES: '1305', IVA_POR_PAGAR: '2408', RETEFUENTE: '135515', RETEIVA: '135517', RETEICA: '135518' };
  const centavos = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100);
  const pesos = (c) => c / 100;

  // datos:
  //   lineas       [{ valorTotal }]            de la factura (valor antes de impuestos)
  //   base, iva, total                         valores contables de la factura
  //   cuentasLinea [codigo]                    cuenta de ingreso de cada línea
  //   retenciones  [{ cuentaCodigo, valor }]   Db 1355xx (opcional)
  //   descuentos   [{ cuentaCodigo, valor }]   Db gasto/costo: estampillas, tasas, contribuciones (opcional)
  //   centroCosto  texto opcional (proyecto)
  function armarAsientoVenta(datos) {
    const lineas = datos.lineas || [];
    if (lineas.length === 0) throw new Error('La factura no tiene líneas.');
    if (lineas.length !== (datos.cuentasLinea || []).length) {
      throw new Error('Falta la cuenta de ingreso de alguna línea.');
    }
    const baseCent = centavos(datos.base);
    const ivaCent = centavos(datos.iva);
    const totalCent = centavos(datos.total);

    const pesosLineas = lineas.map((l) => Math.max(0, centavos(l.valorTotal)));
    const sumaLineas = pesosLineas.reduce((a, b) => a + b, 0);
    // Descuentos o cargos a nivel de factura y diferencias de centavos: proporcional al valor de cada línea.
    const sobrante = asientoCompra.repartir(baseCent - sumaLineas, pesosLineas);

    const porCuenta = new Map();
    lineas.forEach((_, i) => {
      const cuenta = datos.cuentasLinea[i];
      porCuenta.set(cuenta, (porCuenta.get(cuenta) || 0) + pesosLineas[i] + sobrante[i]);
    });

    const centro = datos.centroCosto ? { centroCosto: datos.centroCosto } : {};
    // Débitos adicionales (retenciones y descuentos de la entidad), agrupados por cuenta.
    const adicionales = new Map();
    for (const x of [...(datos.retenciones || []), ...(datos.descuentos || [])]) {
      const cent = centavos(x.valor);
      if (cent < 0) throw new Error('Las retenciones y descuentos no pueden ser negativos.');
      if (cent > 0) adicionales.set(x.cuentaCodigo, (adicionales.get(x.cuentaCodigo) || 0) + cent);
    }
    const adicionalCent = Array.from(adicionales.values()).reduce((a, b) => a + b, 0);
    if (adicionalCent >= totalCent && adicionalCent > 0) {
      throw new Error('Las retenciones y descuentos deben ser menores que el total de la factura.');
    }
    const asiento = [{ cuentaCodigo: CUENTAS_FIJAS.CLIENTES, debito: pesos(totalCent - adicionalCent), credito: 0 }];
    for (const [cuenta, cent] of adicionales) asiento.push({ cuentaCodigo: cuenta, debito: pesos(cent), credito: 0 });
    for (const [cuenta, cent] of porCuenta) {
      if (cent !== 0) asiento.push({ cuentaCodigo: cuenta, debito: 0, credito: pesos(cent), ...centro });
    }
    if (ivaCent !== 0) asiento.push({ cuentaCodigo: CUENTAS_FIJAS.IVA_POR_PAGAR, debito: 0, credito: pesos(ivaCent) });

    const debitos = asiento.reduce((s, l) => s + centavos(l.debito), 0);
    const creditos = asiento.reduce((s, l) => s + centavos(l.credito), 0);
    return {
      lineas: asiento,
      totalDebito: pesos(debitos),
      totalCredito: pesos(creditos),
      cuadra: debitos === creditos,
    };
  }

  return { armarAsientoVenta, CUENTAS_FIJAS };
});
