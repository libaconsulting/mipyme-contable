# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
PostgreSQL en Supabase).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Página institucional de Libaniel Consulting (raíz del dominio)
├── style.css                  Estilos del sitio institucional
└── contable/                  El software contable en sí, en /contable
    ├── index.html                Login + tablero con pestañas por módulo
    ├── style.css                 Estética de libro contable (IBM Plex, reglas horizontales)
    └── app.js                    Login, consumo de la API, formularios y acciones por rol
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa (con logo), Tercero (persona natural/
│   │                           jurídica, ubicación, régimen y responsabilidades
│   │                           DIAN, cuenta bancaria), Proyecto (futuro centro
│   │                           de costo), PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario, Usuario, LogAuditoria
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       ├── cierrePeriodo.js    Máquina de estados del cierre mensual
│       ├── authService.js      Login y registro de usuarios
│       ├── auditoria.js        Registro de acciones sensibles
│       ├── seedService.js      Datos base: empresa, periodo, cuentas, reglas
│       └── consecutivos.js     Numeración legible tipo COT-2026-0001 / ODA-2026-0001
├── modules/                  # Módulos operativos (capa transaccional) — TODOS completos
│   ├── ventas/                 Cotización → factura, patrón de referencia
│   ├── compras/                Factura recibida + documento soporte, orden de compra
│   ├── nomina/                 Periodo → empleados → liquidar → documento soporte
│   ├── inventarios/            Kardex simplificado: entradas, salidas, ajustes
│   ├── activosFijos/           Registro, depreciación mensual (cron), baja
│   └── tesoreria/               Cuentas bancarias, movimientos, conciliación
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
│   ├── depreciacionMensual.js  Implementado — recorre todas las empresas
│   └── vencimientoCotizaciones.js
├── middleware/                # authenticate + authorize por rol
└── routes/                   # Router raíz (auth, seed, terceros, y los 6 módulos)
```

## Aprovisionar una empresa nueva

Desde la pantalla de login, "¿Primera vez? Crear empresa y usuario" abre
un flujo de dos pasos: `POST /api/empresas` crea la empresa (razón
social, NIT, régimen tributario —ordinario, RST o especial—,
responsable de IVA, correo, teléfono, dirección, departamento,
municipio, representante legal y su documento, código CIIU y matrícula
mercantil), luego `POST /api/auth/registro` crea su primer usuario (rol
`contador` o `dueño` recomendado). `PATCH /api/empresas/:id` permite
editar estos datos después. Los tres endpoints quedan abiertos por
ahora — ver el TODO en `src/routes/empresas.routes.js` antes de tener
más de un puñado de empresas reales.

**Contabilidad base.** Una empresa recién creada no trae plan de cuentas,
reglas ni periodo contable. La primera vez que se carga una factura de
compra desde XML, el sistema le crea (solo si no tiene ninguna cuenta) las
24 cuentas base, las 13 reglas de contabilización y el periodo del mes en
curso, y lo avisa en la vista previa. Si la empresa ya tiene plan de
cuentas pero no un periodo abierto, solo se crea el periodo. Nunca se
modifica un plan ya armado. (`aprovisionarContabilidadBase` en
`seedService.js`.)

Al iniciar sesión, el panel **Inicio** (pestaña por defecto, ya no
Terceros) saluda por nombre, muestra la razón social de la empresa, y
presenta los nueve módulos como tarjetas — clic en cualquiera navega
directo a esa sección.

## Límite de tamaño del body JSON

`express.json()` ahora acepta hasta 5mb (antes, el default de Express
es 100kb). Lo necesita el logo de empresa, que se manda como base64
dentro del JSON — sin este cambio, cualquier imagen un poco pesada
hacía que la petición se rechazara antes de llegar a nuestro código,
con un error genérico ("Error inesperado") que no decía qué había
pasado de verdad. `api()` en el frontend ahora también reconoce un 413
específicamente y muestra un mensaje claro.

## Caché de archivos estáticos

`express.static` ahora manda `Cache-Control: no-cache` en todo lo que
sirve desde `public/` (HTML, CSS, JS). Antes de esto, durante una
etapa con despliegues tan frecuentes, era fácil que el navegador (o el
CDN de Hostinger) se quedara sirviendo una versión vieja de `app.js`
mientras el HTML ya estaba actualizado — un botón nuevo aparecía en
pantalla pero no hacía nada, porque el JavaScript que lo conectaba
seguía siendo el de antes. Si algo similar vuelve a pasar (un botón
nuevo no responde, pero el código se ve bien), lo primero a probar es
una recarga forzada (Ctrl+Shift+R) o una ventana de incógnito antes de
asumir que el código tiene un error real.

**Versión en la URL de los archivos (`?v=`)**: aun con `Cache-Control: no-cache`, el CDN de Hostinger o el
navegador pueden seguir entregando un `app.js` o `style.css` viejo con un `index.html` nuevo (pasó el
12/oct/2026: el formulario mostraba el bloque nuevo de retención pero el JS era el anterior, así que la
retención "no hacía nada"). Por eso `public/contable/index.html` pide los archivos con `?v=AAAAMMDD-n`.
**Cada vez que cambie `app.js`, `style.css`, `calculoOrden.js`, `asientoCompra.js`, `planCuentas.js` o `retencionesCatalogo.js`, subir ese valor
en `index.html`.** Para comprobar qué versión está sirviendo producción, abrir
`/contable/app.js?v=<valor>` y buscar un texto que solo exista en la versión nueva.

## Mi Empresa

Pestaña nueva en el tablero (al final del menú, como una sección de
configuración) donde se edita el perfil completo de la empresa —todos
los campos que ya existían en el registro inicial, incluido el logo—
usando `PATCH /api/empresas/:id`. Si no se elige un archivo nuevo al
guardar, el logo actual se conserva (no se borra por accidente).

### Plan de cuentas (subpestaña de Mi Empresa)

Mi Empresa tiene dos subpestañas: **Datos de la empresa** y **Plan de cuentas**.
La segunda lista las cuentas de la empresa (código, nombre, tipo, origen y
cantidad de movimientos) y permite:

- **Crear una cuenta** (`POST /api/plan-cuentas`): código de 4 dígitos (cuenta), 6
  (subcuenta) u 8 (auxiliar) y nombre. Cada nivel cuelga del anterior (el auxiliar
  51352505 necesita la subcuenta 513525, y esta la cuenta 5135). El tipo y la naturaleza se deducen del primer dígito
  (1 activo, 2 pasivo, 3 patrimonio, 4 ingreso, 5 gasto, 6 y 7 costos; 8 y 9 no
  se admiten). Las cuentas que restan del activo (1399, 1499, 1592, 1599, 1698,
  1699) son de naturaleza crédito, y una subcuenta o auxiliar hereda la de su padre
  (que debe existir y estar activo). El código no se cambia nunca.
- **Catálogo de cuentas comunes** (`GET /api/plan-cuentas/catalogo`,
  `POST /api/plan-cuentas/catalogo/activar`): unas 50 cuentas del PUC que usa una
  mipyme (gastos de administración y ventas, financieros, costos, inventarios y
  activos, ingresos, ICA/renta por pagar), con casillas y un botón "Marcar las
  recomendadas". Es una guía: la cuenta que corresponde a cada gasto depende de la
  actividad; confirmarla con el contador. Los nombres y códigos siguen el PUC
  (Decreto 2650 de 1993); el marco NIIF Grupo 3 no lo obliga, pero es el que
  reconocen contadores, bancos y la DIAN, y facilita la información exógena.
- **Renombrar, desactivar y reactivar** (`PATCH /api/plan-cuentas/:id`). Nada se
  borra. No se puede desactivar una cuenta esencial del sistema (1355, 2205, 2365,
  2367), una que use una regla de contabilización, la de una cuenta bancaria, ni una con subcuentas activas.
  Las cuentas inactivas no se ofrecen como destino de una compra.
- Solo **contador** y **dueño** pueden modificar el plan; los demás roles lo ven
  en solo lectura (el API responde 403). Cada cambio queda en `logs_auditoria`.

Desde la ventana de **factura de compra (XML)**, cada selector de "Cuenta destino"
(y "Llevar todo a") termina en **+ Crear cuenta nueva…**: abre el mismo diálogo (con
el catálogo de cuentas válidas para una compra) y deja la cuenta elegida en la
línea. Si se cancela, el selector vuelve a lo que tenía. Una cuenta que no sirve
como destino de compra (por ejemplo un pasivo) se rechaza.

Reglas compartidas navegador/backend en `public/contable/planCuentas.js`;
servicio en `src/core/services/planCuentasService.js`; rutas en
`src/routes/planCuentas.routes.js`. Las columnas nuevas `plan_cuentas.activa` y
`plan_cuentas.origen` ('sistema' | 'catalogo' | 'usuario') se crean solas con
`sync({ alter: true })`; las cuentas existentes quedan activas y con origen 'sistema'.

### Bancos: un auxiliar contable por cuenta bancaria

Como en los programas contables tradicionales, cada cuenta bancaria de Tesorería
tiene su propio auxiliar dentro de `1110 Bancos`:

```
1110      Bancos
 111005   Bancos moneda nacional        (subcuenta, se crea sola)
  11100501 Bancolombia · Ahorros ****8901   (auxiliar: uno por cuenta bancaria)
  11100502 Davivienda · Corriente ****5566
```

- Al registrar la cuenta bancaria (`POST /api/tesoreria/cuentas`: banco, tipo,
  número y, opcional, NIT del banco) se crea el auxiliar con el siguiente código
  libre (01 a 99). El número completo nunca va en el nombre: solo `****` y los
  últimos 4 dígitos.
- Con el NIT, el banco queda como **tercero** (tipo "otro"; si ya existe uno con ese
  NIT, con o sin dígito de verificación, se reutiliza) y se anota en los movimientos
  contables, para sacar el auxiliar por banco y por cuenta.
- La **comisión bancaria** conciliada se contabiliza `Db 5305 Gastos bancarios / Cr`
  auxiliar de ESA cuenta (el motor acepta `cuentaDebitoId`/`cuentaCreditoId`
  alternativas a las de la regla). Si no se puede contabilizar (por ejemplo no hay
  periodo abierto), el movimiento sigue pendiente de conciliar.
- Las cuentas bancarias registradas antes de este cambio reciben su auxiliar la primera
  vez que se listan. Los movimientos antiguos que ya estaban en 1110 no se reclasifican.
- El auxiliar de una cuenta bancaria no se puede desactivar mientras esa cuenta exista;
  sí se puede renombrar.
- **Aún no** cruzan contra el banco los demás movimientos (ingresos y egresos solo se marcan
  conciliados; ventas de contado y pagos siguen contra la regla genérica 1110). Hasta que
  se cruce el pago con su factura, el auxiliar solo refleja lo que se contabiliza contra él.
  Código en `src/modules/tesoreria/services/contabilidadBancaria.js`.

## Logo de empresa

`Empresa.logoBase64` guarda el logo como data URI (base64) directo en
la base de datos, no como archivo en disco — en el hosting de Node de
Hostinger un archivo subido podría perderse en un redeploy, así que
esto evita esa dependencia. Límite de 2MB desde el frontend. Aparece en
el encabezado de `cotizacion-imprimir.html` y `orden-imprimir.html`
cuando existe.

## Proyectos (futuro centro de costo)

Catálogo nuevo (`Proyecto`: nombre, código/ID del centro de costo,
objeto, contratante —referencia a Tercero—, valor total, activo) para
los contratos/negocios/proyectos de la empresa. Hoy se usa desde
Órdenes de Adquisición (`OrdenCompra.proyectoId`, con el campo de texto
viejo `proyecto` conservado solo por compatibilidad con órdenes
anteriores al catálogo). Pendiente real: conectarlo con
`Movimiento.centroCosto` (hoy sigue siendo texto libre) para que la
segmentación contable por proyecto sea automática, no solo informativa
en las órdenes.

## Orden de adquisición: impuestos, AIU y retención

El cálculo de totales vive en **un solo archivo**, `public/contable/calculoOrden.js`,
que usan tanto el navegador (vista previa mientras se digita y PDF) como el
backend (`compras.service.js`, con `require`). El servidor siempre recalcula al
guardar; nunca confía en totales que lleguen del cliente. Pruebas:
`node --test tests/calculoOrden.test.js` (incluye el caso real ODA-016-2026).

- **IVA e Impoconsumo** se discriminan por separado (`OrdenCompra.iva` / `.impoconsumo`).
- **AIU** (Administración, Imprevistos, Utilidad): solo en órdenes de *servicios*; cada % se
  calcula sobre el subtotal. IVA 19% sobre (subtotal + AIU), o solo sobre la Utilidad
  (`aiuBaseIva = 'utilidad'`). Con AIU se ignora el IVA individual de los ítems.
- **Retención en la fuente** (informativa para el proveedor; no se suma al total, se resta para
  dar el **neto a pagar**). Tres opciones por orden: *No indicar*, *Aplicar* o *No aplica*.
  - *Aplicar*: una o varias líneas; cada una se elige **manualmente** del catálogo 2026
    (`public/contable/retencionesCatalogo.js`, 48 conceptos tomados del Excel de la firma: tarifa,
    tope en UVT y sobre qué se aplica). Se puede combinar, p. ej., retefuente de servicios + ReteIVA.
    La base es subtotal + AIU antes de impuestos; los conceptos "sobre AIU" (temporales, vigilancia y
    aseo) usan solo el AIU y ReteIVA usa el valor del IVA. Si la base no alcanza el tope en UVT
    (medido por orden), esa línea no retiene. "Otro concepto" permite digitar la tarifa.
  - *No aplica*: exige motivo (Régimen Simple, tratamiento especial, no supera el tope, otro) y
    detalle opcional; se imprime en el PDF.
  - El servidor toma tarifas y topes **del catálogo** (el cliente solo manda el código) y guarda una
    **foto** de las líneas calculadas (`OrdenCompra.retenciones`), para que una orden vieja no
    cambie cuando se actualice el catálogo en otro año. Para cambiar de año: editar `ANIO`,
    `UVT_VALOR` y el arreglo de conceptos.
  - **Proyección de pago** en el PDF: valor total de la orden (impuestos incluidos), cada retención
    descontada con su tarifa y base, y el **valor que recibirá el proveedor en su cuenta**
    (con su cuenta bancaria si está registrada). Es solo informativa: la orden no genera asientos
    contables; el único asiento ocurre al convertirla en factura de compra y hoy usa el total
    bruto (la retención aún no se contabiliza).
  - UVT 2026 = $52.374 (Res. DIAN 000238/2025). El Excel traía la columna VALOR con 52.400; el
    sistema usa la oficial.
- Al convertir la orden en factura de compra, `subtotal = total − iva`, de modo que el
  Impoconsumo (no descontable) queda como mayor valor del costo y `subtotal + iva = total`.

## Factura de compra desde el XML del proveedor

En **Facturas de compra → "+ Cargar factura (XML)"** se abre una ventana para subir el archivo que envía
el proveedor. Acepta tres formas (la persona no tiene que saber cuál es cuál): el XML de la factura
(`<Invoice>`), el `AttachedDocument` que mandan la mayoría de proveedores tecnológicos (trae la factura
adentro más la respuesta de la DIAN) o el **.zip** completo. También se puede arrastrar el archivo.

Son dos pasos y **nada se guarda hasta confirmar**:

1. **Vista previa** — `POST /api/compras/facturas/xml/previsualizar`. El servidor lee el XML y devuelve
   lo que hay que revisar: número, fecha, CUFE (con enlace "Verificar en la DIAN"), proveedor, líneas,
   IVA/Impoconsumo, totales, si la DIAN la validó, las órdenes de adquisición candidatas y las advertencias.
2. **Registro** — `POST /api/compras/facturas/xml`. El servidor **vuelve a leer el XML** (no confía en lo que
   muestre el navegador), valida, guarda la factura y el asiento en **una sola transacción**.

Qué hace al leerla / registrarla:

- **Proveedor por NIT** (ignora el dígito de verificación). Si no existe en Terceros se crea con los datos
  del XML (nombre, tipo de persona, régimen de IVA, responsabilidades RUT, correo, teléfono, dirección).
- **Orden de adquisición**: propone las del proveedor aprobadas o recibidas (marca la que la factura cita en
  `OrderReference` o la que tiene el mismo valor). Al vincularla la orden pasa a `facturada`, hereda el
  proyecto (centro de costo) y precarga su retención; si el valor difiere, pide aceptar la advertencia.
- **Retención**: la decide la persona (no se toma del XML), con el mismo catálogo 2026 y las mismas reglas
  (topes en UVT, ReteIVA, "No aplica" con motivo) de la orden — comparten `calcularRetenciones` en
  `calculoOrden.js`. Es obligatorio decidir. Si el XML dice que el proveedor es de Régimen Simple (O-47) o
  autorretenedor (O-15) se **sugiere** "No aplica" con su motivo. La base es el valor antes de impuestos de la
  factura real, no el de la orden.
- **Cuenta destino por línea** (inventario, gasto, costo, activo). Por defecto: orden de bienes → cuenta de
  débito de la regla `factura_compra_con_orden` (1435); servicios o sin orden → la de `factura_compra_sin_orden`
  (5195). "Llevar todo a" aplica una cuenta a todas las líneas.
- **Asiento de varias líneas**, mostrado antes de confirmar y guardado idéntico (módulo compartido
  `public/contable/asientoCompra.js`, en centavos enteros para que cuadre siempre):

  ```
  Db  cuenta destino de cada línea (+ Impoconsumo y otros impuestos que no son IVA)
  Db  1355 IVA descontable        (solo si la empresa es responsable de IVA; si no, va al gasto)
  Cr  2365 Retención en la fuente por pagar
  Cr  2367 ReteIVA por pagar
  Cr  2205 Proveedores nacionales   = total − retenciones   (= "valor a pagar")
  ```
  Descuentos o cargos globales de la factura se reparten entre las líneas en proporción a su valor.
  Si la factura tiene proyecto, las líneas de débito llevan `Movimiento.centroCosto` = código del proyecto.
- El motor (`motorAsientos.contabilizarAsientoCompuesto`) respeta la **regla** del evento: `manual` registra la
  factura **sin** asiento (queda `pendiente`); `asistido` se contabiliza porque la vista previa ya es la
  revisión humana; `automatico` también. Si la fecha de la factura no cae en un periodo abierto, el asiento
  va al periodo vigente con la fecha de hoy y se avisa — nunca escribe en un periodo cerrado.
  Las cuentas 2365 y 2367 se crean solas si la empresa no las tiene (se agregaron al seed).
- **Bloqueos** (no deja registrar): CUFE ya registrado, mismo número del mismo proveedor con otro CUFE, nota
  crédito/débito o documento soporte, moneda distinta de COP, sin CUFE/fecha/NIT, la DIAN no la validó.
  **Por confirmar** (checkbox): factura a nombre de otro NIT, total que no coincide con la orden, XML con
  totales incoherentes, anticipos, CUFE con formato raro.
- El **XML original** queda guardado en `facturas_compra.xml_contenido` y se descarga desde el detalle
  (`GET /api/compras/facturas/:id/xml`). El listado no lo trae (pesa); el detalle
  (`GET /api/compras/facturas/:id`) devuelve el desglose y el asiento.

Seguridad: el archivo viene de un tercero. El lector (`src/integrations/dian/xmlMini.js`) no tiene
dependencias y **rechaza cualquier DOCTYPE/ENTITY** (sin XXE ni expansión de entidades), limita la
profundidad, limita el tamaño descomprimido de un ZIP, y el navegador escapa todo texto del XML antes de
mostrarlo. Pruebas: `node --test tests/facturaElectronica.test.js` (lector y datos), `tests/asientoCompra.test.js`
(asiento). Los archivos de ejemplo se generan con `tests/helpers/facturaDian.js` (datos ficticios).

Lo que **no** hace todavía: notas crédito/débito, facturas en moneda extranjera, cruce de anticipos, ni los
eventos RADIAN (acuse de recibo, recibo del bien, aceptación expresa) — ver pendientes.

## Factura de venta desde el XML de Siigo

Mientras no tengamos integración directa ni proveedor tecnológico propio, las facturas de venta se expiden
en **Siigo** (o el proveedor que tenga contratado la empresa) y aquí solo se **cargan y contabilizan**.
Facturas de venta → **+ Cargar factura emitida (XML)**: sirve el `.xml` o el `.zip` que descarga Siigo
(trae el `AttachedDocument` con la factura y la respuesta de la DIAN; se probó con una factura real).

- Dos pasos, como en compras: `POST /api/ventas/facturas/xml/previsualizar` (lee, no guarda) y
  `POST /api/ventas/facturas/xml` (vuelve a leer el archivo, valida, guarda y contabiliza en una
  transacción). Detalle: `GET /api/ventas/facturas/:id`; XML guardado: `GET /api/ventas/facturas/:id/xml`.
  Código: `src/modules/ventas/services/facturaVentaXml.service.js`; asiento compartido con el navegador en
  `public/contable/asientoVenta.js`.
- **Asiento**: Db 1305 Clientes (total) / Cr cuenta de ingreso por línea (base; por defecto la de la regla
  `factura_venta_credito`, se puede cambiar por línea o crear una nueva con "+ Crear cuenta nueva…") /
  Cr 2408 IVA por pagar. Siempre a crédito (1305): el recaudo se registra en Tesorería.
- **Cliente**: se busca por NIT en Terceros; si no existe se crea con los datos del XML (casilla de la pantalla).
- **Cotizaciones**: ya no se convierten en factura desde aquí (se quitó el botón). Al cargar el XML se puede
  vincular una cotización **aceptada** del mismo cliente (se sugiere la citada en el XML o la del mismo valor);
  queda `facturada`. Si el total difiere hay que confirmar.
- **Se bloquea** (con mensaje claro): que el emisor no sea la propia empresa (si es una factura de compra se
  indica que va en Facturas de compra; y al revés, Facturas de compra rechaza facturas propias), CUFE o número
  ya cargados, notas crédito/débito, e impuesto al consumo/otros impuestos distintos de IVA. Pide confirmar si
  la factura trae IVA y la empresa figura como no responsable de IVA.
- Empresa nueva sin plan de cuentas: se aprovisiona la contabilidad base igual que en compras.
- Pruebas: `node --test tests/asientoVenta.test.js`.

Lo que **no** hace todavía: retenciones que practica el cliente (se registrarán al recibir el pago, en
Tesorería), notas crédito/débito, costo de ventas de bienes (inventarios), impoconsumo en ventas, ni el
**documento soporte** (Siigo no entrega XML: se registra a mano, ver la sección siguiente).

## Documento soporte (compras a no obligados a facturar), expedido en Siigo

Siigo **solo entrega el PDF** del documento soporte (no hay XML), así que no se "carga": se **registra**.
Pestaña **Documentos soporte → + Registrar documento soporte**: se digita lo que dice el PDF (número como
sale en Siigo, fecha de compra, cédula/NIT y nombre del proveedor, qué se compró y cuánto, cuenta de gasto,
retención en la fuente) y se adjunta el PDF como soporte (opcional, hasta 3,5 MB; se valida que sea PDF).

- Código: `src/modules/compras/services/documentoSoporte.service.js`; rutas bajo `/api/compras/documentos-soporte`
  (`GET /opciones`, `GET /`, `POST /`, `GET /:id`, `GET /:id/pdf`). La tabla `documentos_soporte_adquisicion`
  (la misma del flujo de emisión con proveedor tecnológico) ganó columnas; `origen = 'registrado'` distingue estos.
- **Asiento** (mismo `asientoCompra.js` que la factura de compra, con `cuentaPorPagar: '2335'`):
  Db gasto/costo por línea (bruto) / Cr 2365 retención en la fuente / Cr **2335 Costos y gastos por pagar**
  (bruto − retención). Sin IVA. Ejemplo real (DS 44): 4.530.000 / 271.800 (6 %, servicios no declarantes) / 4.258.200.
- El proveedor se busca por cédula/NIT en Terceros (con o sin puntos y dígito de verificación); si no existe se
  crea como proveedor. El número del documento es único por empresa. No puede ser tu propia empresa ni tener fecha futura.
- Retención: mismo catálogo y reglas de tope en UVT que órdenes y facturas de compra. Solo conceptos sobre la base
  (no ReteIVA ni AIU). El concepto lo elige la persona; no se deduce solo de si el proveedor es declarante.
- Pruebas: `node --test tests/asientoCompra.test.js` (caso DS 44 incluido).

Lo que **no** hace todavía: leer el PDF automáticamente (se digita), IVA teórico/mayor valor, notas de ajuste
al documento soporte, ni pagar el documento (el pago se cruzará contra 2335 cuando exista el cruce en Tesorería).
Cuando haya proveedor tecnológico propio, el flujo `POST /api/compras/documento-soporte` (emisión) sigue disponible.

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).

La raíz del dominio (`/`) es la página institucional de **Libaniel
Consulting**, pensada para ofrecer varios servicios de la firma — hoy
solo el software contable es real, los otros dos son marcadores de
posición con un `mailto:` genérico (`contacto@libanielconsulting.com`)
hasta que se definan de verdad.

El software contable en sí vive en **`/contable`** — mismo backend,
solo un subdirectorio distinto en `public/`. Cubre creación y las
transiciones de estado principales de los seis módulos (formularios
inline + botones de acción por fila según el estado del registro). Dos
simplificaciones deliberadas por ahora:
acciones que piden un solo dato adicional puntual (agregar empleado a
un periodo, entradas/salidas/ajustes de inventario) usan `prompt()` del
navegador en vez de un formulario modal propio; y no hay edición ni
borrado de nada, solo creación y transiciones hacia adelante.

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa y resuelve solo el periodo
   contable vigente si no se le pasa explícito.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).
6. **Un movimiento bancario sin conciliar bloquea el cierre del periodo**
   (ver `cierrePeriodo.validarPeriodo`).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de la base de datos y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Sitios web → Apps Node.js → conectar el repositorio de GitHub.
2. Base de datos: PostgreSQL vía Supabase (host, puerto, nombre, usuario y
   contraseña como `DB_*` en las variables de entorno de la app).
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

## Datos base (seed)

`POST /api/seed` (requiere sesión con rol `contador` o `dueño`) crea:
una empresa de prueba, el periodo contable del mes en curso, un plan de
24 cuentas, y 13 reglas de contabilización — una por cada
evento que disparan los seis módulos operativos. Seguro de correr más
de una vez — no duplica nada. Sin esto, `motorAsientos` no tiene con
qué contabilizar.

## Pendientes inmediatos

- [ ] **Retención en la fuente en órdenes es solo informativa**. Al registrar la factura desde XML la retención **sí** se contabiliza (2365/2367 al causar la factura), pero `convertirOrdenEnFactura` (cierre manual de una orden sin XML) sigue contabilizando el total bruto sin retención ni IVA aparte. Falta unificarlo, y decidir qué hace Tesorería al pagar (el neto a pagar ya queda en `facturas_compra.neto_a_pagar`)
- [ ] Retención: el concepto se elige a mano en cada orden; no se deriva automáticamente de `Tercero.tipoPersona` / `responsabilidadesFiscales` (declarante / no declarante, RST). El tope en UVT se mide **por orden**, sin acumular los pagos del mes o del año al mismo proveedor. Validar los conceptos y tarifas del catálogo con el contador
- [ ] AIU en órdenes: igual que en cotizaciones, no admite mezclar ítems exentos/Impoconsumo con IVA sobre la base AIU (el Impoconsumo de los ítems se suma aparte; el IVA individual de los ítems se ignora)
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` usan `<script>` y `<style>` en línea, y `server.js` define una CSP `script-src 'self'` / `style-src 'self'`. Un navegador que respete esa CSP los bloquea (probado en un entorno local sin proxy). Si en algún momento las páginas de impresión dejan de cargar, mover ese JS/CSS a archivos externos

- [ ] Plan de cuentas: no hay pantalla para editar las **reglas de contabilización** (qué cuenta usa cada evento); solo se ven en el bloqueo al desactivar. Tampoco hay importación masiva del plan desde Excel ni cuentas de orden (clases 8 y 9). La cuenta 1355 se usa como "IVA descontable" (en el PUC el IVA descontable es una subcuenta de 2408): validar con el contador si se prefiere la estructura del PUC
- [ ] Facturas de venta desde XML (Siigo): retenciones practicadas por el cliente al pago, notas crédito/débito, costo de ventas e inventario, impoconsumo, Mientras tanto la factura de venta interna (`convertirCotizacionEnFactura`) sigue en el código pero sin botón en pantalla
- [ ] Facturas de compra desde XML: notas crédito/débito de proveedores (descuentos y devoluciones posteriores), documento soporte recibido, facturas en moneda extranjera y cruce de anticipos
- [ ] RADIAN: enviar los eventos del comprador (acuse de recibo, recibo del bien o servicio, aceptación expresa) a la DIAN a través del proveedor tecnológico; hoy solo se lee el XML. Tampoco se consulta a la DIAN para comprobar el CUFE (hay un enlace para hacerlo a mano)
- [ ] Facturas de compra: el control de duplicados (CUFE) es una consulta previa, no un índice único; dos cargas simultáneas idénticas podrían pasar. Considerar índice único `(empresa_id, cufe)` al migrar a `sequelize-cli`
- [ ] Facturas de compra: aprobar/anular un asiento en `borrador` y anular una factura registrada por error (hoy no hay forma de revertirla desde la pantalla)
- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] **Migraciones de Sequelize (`sequelize-cli`)** en vez de `sync({ alter: true })` — ya tenemos evidencia concreta de por qué importa: con cada redeploy que tocó el modelo, Sequelize fue acumulando una restricción única duplicada sobre `consecutivo` en vez de reconocer que ya existía una (llegaron a existir 23 restricciones idénticas en `ordenes_compra`, ver corrección en Supabase del 30/sep/2026). `alter: true` es cómodo para esta etapa pero no es confiable para cambios de índices/restricciones a largo plazo
- [ ] Reemplazar `FACTOR_PRESTACIONES` (21.83% fijo) en `nomina.service.js` por el cálculo exacto de cesantías, intereses, prima y vacaciones según la normativa laboral vigente y el tipo de contrato
- [ ] Integrar `NovedadNomina` con el cálculo del devengado (hoy es solo un registro informativo, no ajusta nada automáticamente)
- [ ] Tesorería: cruzar movimientos de tipo ingreso/egreso contra la factura, orden o nómina específica que pagan (hoy solo "comisión" se contabiliza sola al conciliar; el resto solo queda marcado como conciliado, sin generar el asiento de pago)
- [ ] Bancos: dirigir al auxiliar de cada cuenta bancaria los pagos y recaudos (hoy solo la comisión lo hace), con conciliación por cuenta contra el extracto; cuentas en moneda extranjera (111010); cerrar/inactivar una cuenta bancaria; reclasificar movimientos antiguos de 1110 a su auxiliar
- [ ] Múltiples líneas por evento en `motorAsientos`: ya existe `contabilizarAsientoCompuesto` (lo usa la factura de compra desde XML), pero `contabilizarEvento` sigue siendo de un débito y un crédito — las ventas no discriminan IVA por pagar en un renglón aparte, ni la nómina ni los activos fijos
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `DELETE` de terceros (crear, listar y editar ya existen; falta borrar)
- [ ] Vincular `MovimientoInventario` con los ítems reales de `FacturaVenta`/`FacturaCompra` — hoy las entradas y salidas se registran manualmente por API, no automático desde una venta
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Reemplazar los `prompt()` del navegador (agregar empleado a nómina, entradas/salidas/ajustes de inventario) por formularios modales propios en el frontend; agregar edición/borrado en general
- [ ] Confirmar que `www.libanielconsulting.com` resuelve al mismo sitio que `libanielconsulting.com` (revisar en hPanel → Dominios, o agregar la redirección si falta)
- [ ] Definir de verdad los servicios 02 y 03 de la página institucional (`public/index.html`) y reemplazar el `mailto:contacto@libanielconsulting.com` por el correo real de la firma
- [x] ~~Fase 2, parte 2~~ — Órdenes de Adquisición ya tiene ítems dinámicos, "Ver ítems" y "Editar" (solo en borrador), igual que Cotizaciones
- [ ] Aplicar `mensajeError()` (`src/core/utils/mensajeError.js`) en los demás controladores — hoy `ventas.controller.js` y `compras.controller.js` lo usan; nómina, inventarios, activos fijos y tesorería todavía devuelven el mensaje genérico de Sequelize
- [ ] La opción "Otro (definir %)" de impuesto en el ítem se guarda como `tipoImpuesto: 'iva'` con el porcentaje manual — no distingue si en realidad era un Impoconsumo con tarifa distinta a 4/8/16%. Si eso resulta ser un caso frecuente, vale la pena dejar elegir tipo Y porcentaje por separado en vez de un solo desplegable combinado
- [ ] El cálculo de IVA cuando `aplicaAiu = true` sigue asumiendo 19% general sobre (subtotal + AIU) sin importar el `tipoImpuesto` real de los ítems — no contempla todavía una cotización con AIU que mezcle ítems de Impoconsumo o exentos
- [x] ~~Fase 3, parte 2~~ — `orden-imprimir.html` ya existe: mismo patrón que cotización, con los datos del proveedor (incluida su cuenta bancaria) en vez del cliente, y el proyecto resuelto desde el catálogo
- [ ] Validar con un caso real si el IVA de una cotización con AIU debe calcularse sobre (subtotal + AIU) como quedó programado, o de otra forma según el tipo de contrato — ver la nota en `crearCotizacion` (`ventas.service.js`)
- [ ] `GET /compras/ordenes/:id` con ítems (el de cotizaciones ya existe: `GET /ventas/cotizaciones/:id`) — necesario para "Ver ítems" y la Fase 3 en Órdenes
- [ ] "Enviar" (cotización) sigue siendo solo un cambio de estado — no manda correo ni WhatsApp automáticamente, el botón ahora lo aclara con un `confirm()`. El envío real de verdad (correo con el PDF adjunto, por ejemplo) requeriría configurar un proveedor de correo transaccional, que todavía no existe en el proyecto
- [ ] `cotizacion-imprimir.html` y `orden-imprimir.html` generan el PDF usando "Imprimir" del navegador (`window.print()`), no una librería de generación de PDF en el servidor — evita agregar una dependencia pesada (ej. Puppeteer) que podría no funcionar bien en el hosting de Node de Hostinger. Si el formato de impresión del navegador resulta insuficiente, esto es lo primero a reconsiderar
- [ ] Conectar `Proyecto` con `Movimiento.centroCosto` para que la contabilidad se segmente por proyecto de verdad (hoy el catálogo solo se usa desde Órdenes de Adquisición)
- [x] ~~Editar un `Proyecto` desde la interfaz~~ — ya existe el botón "Editar" (mismo formulario que crear, incluye activar/desactivar y permite borrar datos opcionales). Falta solo **eliminar** (hoy se desactiva)
- [ ] Migrar las órdenes viejas que tienen `proyecto` (texto libre) pero no `proyectoId`, para que puedan filtrarse/agruparse igual que las nuevas
- [ ] Usar `Tercero.responsabilidadesFiscales` y `tipoPersona` para automatizar el cálculo de retención en la fuente (formulario 350) — hoy son solo datos capturados, no alimentan ningún cálculo todavía
- [ ] Consecutivos: ya son únicos por empresa (índice compuesto `empresa_id + consecutivo`, no `consecutivo` global) y toda la creación vive en una transacción real — un fallo a mitad de camino ya no deja un encabezado huérfano con el número gastado. Sigue sin bloqueo transaccional de secuencia bajo concurrencia muy alta (una tabla de secuencias con `SELECT ... FOR UPDATE` sería la solución definitiva si el volumen lo exige)
