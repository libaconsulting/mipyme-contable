# Módulo: tesoreria

Cuentas bancarias (cada una con su auxiliar contable 11100501…), movimientos bancarios, conciliación y
**cruce de pagos** con facturas de compra, documentos soporte y facturas de venta.

- `models/`   → `CuentaBancaria`, `MovimientoBancario` (con `origenModulo`/`origenId`), `PagoTesoreria`, `PagoAplicacion`
- `services/` → `tesoreria.service.js` (cuentas, movimientos, conciliar), `contabilidadBancaria.js` (auxiliares y tercero del
                 banco), `cruces.service.js` (cartera, pagos/recaudos, descuentos de aportes, anulación). Todo se contabiliza con
                 `contabilizarAsientoCompuesto` del motor de asientos.
- `controllers/`, `routes/` → capa HTTP, montada en `/api/tesoreria`

Pantalla: `public/contable/tesoreriaCruce.js`. Detalle del flujo, reglas y alcance en el README de la raíz
(sección «Tesorería: cruce de pagos»). Tablas nuevas en producción: `sql-cruce-pagos-tesoreria.sql`.
