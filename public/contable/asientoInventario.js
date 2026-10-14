// Asientos contables del inventario (costo de ventas y movimientos manuales).
//
// Igual que asientoNomina.js / asientoCompra.js: UN solo archivo para el servidor y la
// pantalla. Las ENTRADAS por compra no generan asiento aquí: la factura de compra ya debita
// la cuenta de inventario (1435 u otra 14xx) al registrarse.
//
//   Venta (costo):   Db 6135 Costo de ventas      · Cr 1435 Inventario      (al costo promedio)
//   Entrada manual:  Db 1435 Inventario           · Cr contrapartida elegida
//   Salida manual:   Db contrapartida (gasto…)    · Cr 1435 Inventario
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.asientoInventario = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const CUENTAS = { INVENTARIO: '1435', COSTO_VENTAS: '6135', GASTO_DIVERSOS: '5195', INGRESO_SOBRANTES: '4295' };

  const cu = (codigo, nombre, naturaleza, elementoNiif) => ({ codigo, nombre, naturaleza, elementoNiif, padre: null });
  // Cuentas que el módulo crea en el plan de la empresa la primera vez que las necesita.
  const CATALOGO = [
    cu('1405', 'Materias primas', 'debito', 'activo'),
    cu('1410', 'Productos en proceso', 'debito', 'activo'),
    cu('1430', 'Productos terminados', 'debito', 'activo'),
    cu('1435', 'Mercancías no fabricadas por la empresa', 'debito', 'activo'),
    cu('1455', 'Materiales, repuestos y accesorios', 'debito', 'activo'),
    cu('1460', 'Envases y empaques', 'debito', 'activo'),
    cu('1465', 'Inventarios en tránsito', 'debito', 'activo'),
    cu('4295', 'Ingresos diversos', 'credito', 'ingreso'),
    cu('6120', 'Costo de ventas: industrias manufactureras', 'debito', 'costo'),
    cu('6135', 'Costo de ventas: comercio al por mayor y al por menor', 'debito', 'costo'),
    cu('6140', 'Costo de ventas: hoteles y restaurantes', 'debito', 'costo'),
  ];
  const CUENTAS_INVENTARIO = CATALOGO.filter((c) => c.codigo.startsWith('14')).map((c) => c.codigo);
  const CUENTAS_COSTO = CATALOGO.filter((c) => c.codigo.startsWith('61')).map((c) => c.codigo);

  // Conceptos de los movimientos manuales. `contrapartida` es la cuenta que se propone;
  // `sinAsiento` = solo kardex (típico del saldo inicial cuando el saldo contable ya está cargado).
  const CONCEPTOS = {
    saldo_inicial: { tipo: 'entrada', nombre: 'Saldo inicial (inventario que ya existía)', contrapartida: null, sinAsiento: true },
    compra_sin_factura: { tipo: 'entrada', nombre: 'Compra sin factura electrónica', contrapartida: '2335' },
    sobrante: { tipo: 'entrada', nombre: 'Sobrante en toma física', contrapartida: '4295' },
    devolucion_cliente: { tipo: 'entrada', nombre: 'Devolución de un cliente', contrapartida: null },
    otra_entrada: { tipo: 'entrada', nombre: 'Otra entrada', contrapartida: null },
    consumo: { tipo: 'salida', nombre: 'Consumo interno (uso en el negocio)', contrapartida: '5195' },
    faltante: { tipo: 'salida', nombre: 'Faltante en toma física', contrapartida: '5195' },
    baja: { tipo: 'salida', nombre: 'Baja por deterioro, vencimiento u obsolescencia', contrapartida: '5195' },
    devolucion_proveedor: { tipo: 'salida', nombre: 'Devolución a un proveedor', contrapartida: '2205' },
    otra_salida: { tipo: 'salida', nombre: 'Otra salida', contrapartida: null },
  };
  // Conceptos de los movimientos que generan las facturas (no se crean a mano).
  const CONCEPTOS_FACTURA = { compra: 'Compra (factura de proveedor)', venta: 'Venta (factura emitida)' };

  const centavos = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100);

  function resultado(mapa) {
    const lineas = [];
    for (const l of mapa.values()) {
      if (l.debito || l.credito) lineas.push({ cuentaCodigo: l.cuentaCodigo, debito: l.debito / 100, credito: l.credito / 100, ...(l.centroCosto ? { centroCosto: l.centroCosto } : {}), ...(l.terceroId ? { terceroId: l.terceroId } : {}) });
    }
    lineas.sort((a, b) => (b.debito > 0) - (a.debito > 0) || (a.cuentaCodigo < b.cuentaCodigo ? -1 : a.cuentaCodigo > b.cuentaCodigo ? 1 : 0));
    const td = lineas.reduce((s, l) => s + centavos(l.debito), 0);
    const tc = lineas.reduce((s, l) => s + centavos(l.credito), 0);
    return { lineas, totalDebito: td / 100, totalCredito: tc / 100, cuadra: td === tc && lineas.length > 1 };
  }
  function poner(mapa, cuentaCodigo, debitoC, creditoC, extra) {
    const clave = `${cuentaCodigo}|${(extra && extra.centroCosto) || ''}|${(extra && extra.terceroId) || ''}`;
    if (!mapa.has(clave)) mapa.set(clave, { cuentaCodigo, debito: 0, credito: 0, ...(extra || {}) });
    const l = mapa.get(clave);
    l.debito += debitoC;
    l.credito += creditoC;
  }

  // items: [{ cuentaInventario, cuentaCosto, valor }] — una por producto vendido.
  function armarAsientoCostoVenta(items, opciones) {
    const mapa = new Map();
    const extra = opciones && opciones.centroCosto ? { centroCosto: opciones.centroCosto } : undefined;
    for (const it of items || []) {
      const v = centavos(it.valor);
      if (!v) continue;
      poner(mapa, it.cuentaCosto || CUENTAS.COSTO_VENTAS, v, 0, extra);
      poner(mapa, it.cuentaInventario || CUENTAS.INVENTARIO, 0, v);
    }
    return resultado(mapa);
  }

  // m: { tipo: 'entrada'|'salida', valor, cuentaInventario, contrapartida, terceroId?, centroCosto? }
  function armarAsientoMovimiento(m) {
    const v = centavos(m.valor);
    const mapa = new Map();
    if (v) {
      const inv = m.cuentaInventario || CUENTAS.INVENTARIO;
      const extra = m.centroCosto ? { centroCosto: m.centroCosto } : undefined;
      const tercero = m.terceroId ? { terceroId: m.terceroId } : undefined;
      if (m.tipo === 'entrada') {
        poner(mapa, inv, v, 0, extra);
        poner(mapa, m.contrapartida, 0, v, tercero);
      } else {
        poner(mapa, m.contrapartida, v, 0, Object.assign({}, extra, tercero));
        poner(mapa, inv, 0, v);
      }
    }
    return resultado(mapa);
  }

  return { CUENTAS, CATALOGO, CUENTAS_INVENTARIO, CUENTAS_COSTO, CONCEPTOS, CONCEPTOS_FACTURA, armarAsientoCostoVenta, armarAsientoMovimiento };
});
