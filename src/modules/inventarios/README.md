# Módulo: inventarios

Productos, kardex a costo promedio ponderado, movimientos manuales, valoración y conciliación con la contabilidad.
La documentación completa (flujo con las facturas, supuestos y pendientes) está en la sección **Inventarios** del `README.md` de la raíz.

- `models/`      → Producto (catálogo + saldo), KardexMovimiento (una fila por movimiento, con el saldo que dejó)
- `services/`    → `inventarios.service.js`: usa los motores compartidos `public/contable/costeoInventario.js` y `asientoInventario.js`;
                   contabiliza con `motorAsientos.contabilizarAsientoCompuesto` (nunca escribe asientos directamente).
                   `entradasDeCompra` y `salidasDeVenta` las llaman las facturas XML dentro de su propia transacción.
- `controllers/` → capa HTTP
- `routes/`      → montadas en `/api/inventarios` (ver: todos; registrar: dueño, contador, auxiliar; anular: dueño y contador)
