# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
MySQL/MariaDB).

## Arquitectura

```
src/
├── server.js                 # Punto de entrada
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa, Tercero, PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       └── cierrePeriodo.js    Máquina de estados del cierre mensual
├── modules/                  # Módulos operativos (capa transaccional)
│   ├── ventas/                 Completo — patrón de referencia
│   ├── compras/                Completo — mismo patrón que ventas
│   ├── inventarios/            Pendiente
│   ├── nomina/                 Pendiente
│   ├── activosFijos/           Pendiente
│   └── tesoreria/              Pendiente
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
├── middleware/                # Auth, manejo de errores (pendiente)
└── routes/                   # Router raíz
```

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de MySQL y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Hosting de apps web → Node.js → conectar el repositorio de GitHub.
2. hPanel → Bases de datos MySQL → crear la base y el usuario, y completar `.env`.
3. hPanel → Avanzado → Cron Jobs → programar:
   - `node src/jobs/depreciacionMensual.js` — día 1 de cada mes
   - `node src/jobs/vencimientoCotizaciones.js` — diario

## Roles y autenticación

Cuatro roles, controlados por `src/middleware/auth.js` (`authenticate` +
`authorize(...roles)`):

| Rol | Puede |
|---|---|
| `dueño` | Operar el sistema, certificar el cierre mensual |
| `contador` | Todo lo anterior + reabrir un periodo certificado |
| `auxiliar` | Registrar operaciones del día a día (ventas, compras, nómina) |
| `revisor` | Solo lectura (pendiente de aplicar en cada ruta) |

`POST /api/auth/login` y `POST /api/auth/registro` son las únicas rutas
públicas. Todas las demás requieren `Authorization: Bearer <token>`.

## Pendientes inmediatos

- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] Migraciones de Sequelize (`sequelize-cli`) para las tablas ya modeladas
- [ ] Completar los módulos de inventarios, nómina, activos fijos y tesorería (protegidos con `authenticate`, igual que ventas y compras)
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] Seed de: al menos una `Empresa`, un `PeriodoContable` abierto, `PlanCuentas` y `ReglaContabilizacion` por defecto — sin esto, `motorAsientos` no tiene con qué contabilizar
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
