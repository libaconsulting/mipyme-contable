# Módulo: compras

Construido, siguiendo el mismo patrón que `ventas`. Dos flujos distintos
conviven aquí — no los confundas al extenderlo:

- **Factura recibida** (`FacturaCompra`): el proveedor SÍ factura
  electrónicamente. El documento llega desde afuera ya validado (webhook
  `/webhooks/compras`) y se contabiliza directo.
- **Documento soporte** (`DocumentoSoporteAdquisicion`): el proveedor NO
  factura. Aquí SOMOS nosotros quienes generamos y emitimos el
  documento, igual que una factura de venta (`documentoSoporteAdapter.js`
  → webhook `/webhooks/documento-soporte`).

`OrdenCompra` es pre-transaccional (no genera asiento) hasta que se
convierte en `FacturaCompra`, igual que `Cotizacion` en ventas.

Pendiente: CRUD completo de órdenes, y confirmar con el proveedor
tecnológico que se contrate la mecánica exacta para RECIBIR facturas
(RADIAN vs. notificación directa del proveedor).
