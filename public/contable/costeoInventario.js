// Costeo del inventario por PROMEDIO PONDERADO (perpetuo).
//
// Un solo archivo que usan el servidor (al registrar) y el navegador (vistas previas).
// Se lleva por producto un saldo { cantidad, valor }: el costo promedio es valor / cantidad.
// Así el valor del inventario es siempre exactamente lo que está en la contabilidad
// (se guarda el valor total, no solo un costo unitario redondeado).
//
//   Entrada: suma cantidad y valor.
//   Salida:  sale al costo promedio vigente. Si sale TODO lo que hay, se lleva el valor
//            completo (no quedan centavos sueltos).
//   Sin existencias: si se vende más de lo que hay (la factura ya se emitió), lo que falta
//            sale al último costo conocido; el saldo queda en negativo y se corrige solo
//            cuando llega la compra (valor y cantidad se suman).
//
// Cantidades con 4 decimales; valores en pesos con centavos (se calculan en centavos enteros).
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.costeoInventario = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const centavos = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100);
  const cantidad4 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 10000) / 10000;
  const costo4 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 10000) / 10000;

  function costoPromedio(saldo) {
    const q = cantidad4(saldo && saldo.cantidad);
    return q > 0 ? costo4(Number(saldo.valor) / q) : 0;
  }

  // saldo: { cantidad, valor }  ·  devuelve el saldo nuevo y el costo promedio resultante.
  function entrada(saldo, cantidad, valor) {
    const q = cantidad4(cantidad);
    if (!(q > 0)) throw new Error('La cantidad de la entrada debe ser mayor que cero.');
    const v = centavos(valor);
    if (v < 0) throw new Error('El valor de la entrada no puede ser negativo.');
    const nuevo = { cantidad: cantidad4(cantidad4(saldo.cantidad) + q), valor: (centavos(saldo.valor) + v) / 100 };
    return { saldo: nuevo, costoPromedio: costoPromedio(nuevo), costoUnitario: costo4(v / 100 / q) };
  }

  // costoReferencia: costo unitario con que se valora lo que falte si no alcanzan las existencias
  // (normalmente el último costo de compra).
  function salida(saldo, cantidad, costoReferencia) {
    const q = cantidad4(cantidad);
    if (!(q > 0)) throw new Error('La cantidad de la salida debe ser mayor que cero.');
    const sq = cantidad4(saldo.cantidad);
    const sv = centavos(saldo.valor);
    let valorC;
    let faltante = 0;
    let sinCosto = false;
    if (sq >= q) {
      valorC = q === sq ? sv : Math.round((sv * q) / sq);
    } else {
      const disponible = sq > 0 ? sq : 0;
      faltante = cantidad4(q - disponible);
      const valorDisponible = sq > 0 ? sv : 0;
      const valorFaltante = Math.round(faltante * Number(costoReferencia || 0) * 100);
      sinCosto = valorFaltante === 0;
      valorC = valorDisponible + valorFaltante;
    }
    const nuevo = { cantidad: cantidad4(sq - q), valor: (sv - valorC) / 100 };
    return {
      valor: valorC / 100,
      costoUnitario: costo4(valorC / 100 / q),
      saldo: nuevo,
      costoPromedio: costoPromedio(nuevo),
      sinExistencias: faltante > 0,
      faltante,
      sinCosto,
    };
  }

  // --- Unidades de medida (códigos UN/ECE que trae el XML) ---------------------------------
  const UNIDADES_XML = {
    '94': 'unidad', EA: 'unidad', NIU: 'unidad', C62: 'unidad', ZZ: 'unidad', H87: 'unidad', '1I': 'unidad',
    KGM: 'kg', GRM: 'g', LBR: 'lb', TNE: 'ton', LTR: 'l', MLT: 'ml', GLL: 'galón',
    MTR: 'm', CMT: 'cm', MTK: 'm²', MTQ: 'm³', HUR: 'hora', DAY: 'día', MON: 'mes',
    BX: 'caja', PK: 'paquete', SET: 'juego', DZN: 'docena', PR: 'par', RM: 'resma', KT: 'kit',
  };
  function unidadDesdeXml(codigo) {
    const c = String(codigo || '').trim();
    return UNIDADES_XML[c] || UNIDADES_XML[c.toUpperCase()] || 'unidad';
  }

  // --- Cómo se reconoce el producto de una línea de factura --------------------------------
  function normalizar(texto) {
    return String(texto == null ? '' : texto)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Claves con las que un producto "recuerda" cómo viene en las facturas. La primera es la que
  // se guarda al enlazar a mano. En compras el código es del proveedor, así que se ata a su NIT.
  function clavesAlias(origen, nit, linea) {
    const cod = normalizar(linea && linea.codigo).replace(/ /g, '');
    const desc = normalizar(linea && linea.descripcion);
    const pre = origen === 'compra' ? `${String(nit || '').replace(/\D/g, '')}|` : '';
    const claves = [];
    if (cod) claves.push(`${pre}c:${cod}`);
    if (desc) claves.push(`${pre}d:${desc}`);
    return claves;
  }

  // productos: [{ id, codigo, nombre, alias, tipo, activo }] · linea: { codigo, descripcion }
  // origen: 'compra' (el código es del proveedor) o 'venta' (el código es el nuestro).
  // Devuelve { producto, motivo } o null.
  function buscarProducto(productos, linea, opciones) {
    const origen = (opciones && opciones.origen) || 'venta';
    const lista = (productos || []).filter((p) => p.tipo !== 'servicio' && p.activo !== false);
    const claves = clavesAlias(origen, opciones && opciones.nit, linea);
    const tieneAlias = (p, k) => Array.isArray(p.alias) && p.alias.includes(k);
    const cod = normalizar(linea && linea.codigo).replace(/ /g, '');
    const desc = normalizar(linea && linea.descripcion);
    const porCodigo = () => (cod ? lista.find((p) => normalizar(p.codigo).replace(/ /g, '') === cod) : null);
    const porNombre = () => (desc ? lista.find((p) => normalizar(p.nombre) === desc) : null);
    const porAlias = () => {
      for (const k of claves) {
        const p = lista.find((x) => tieneAlias(x, k));
        if (p) return p;
      }
      return null;
    };
    const orden = origen === 'compra'
      ? [['alias', porAlias], ['nombre', porNombre], ['código', porCodigo]]
      : [['código', porCodigo], ['alias', porAlias], ['nombre', porNombre]];
    for (const [motivo, fn] of orden) {
      const p = fn();
      if (p) return { producto: p, motivo };
    }
    return null;
  }

  return { centavos, cantidad4, costo4, costoPromedio, entrada, salida, UNIDADES_XML, unidadDesdeXml, normalizar, clavesAlias, buscarProducto };
});
