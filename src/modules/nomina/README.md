# Módulo: nomina

Liquidación mensual de nómina, provisiones, contabilización, pago, planilla de aportes (con pago y CSV de cargue PILA) y archivo plano PILA, prestaciones sociales, vacaciones y liquidación final. La documentación
completa (flujo, qué calcula, cuentas, supuestos legales y pendientes) está en la sección **Nómina** del
`README.md` de la raíz.

- `models/`      → ConfigNomina, ContratoLaboral, AusenciaNomina, ConceptoNomina, NominaPeriodo, NominaLiquidacion,
                   NominaPrestacion, NominaPrestacionLinea, NominaPlanillaPago, CentroTrabajo (centros de la ARL, varios por empresa)
- `services/`    → `nomina.service.js` (mensual) y `prestaciones.service.js` (prima, cesantías, intereses, vacaciones, liquidación final, pago de planilla): usan el motor compartido `public/contable/liquidacionNomina.js` y contabiliza con
                   `motorAsientos.contabilizarAsientoCompuesto` (nunca escribe asientos directamente)
- `controllers/` → capa HTTP
- `routes/`      → montadas en `/api/nomina` (leer: dueño, contador, revisor; modificar: dueño y contador; el auxiliar no entra)

La nómina electrónica se emite en Siigo; aquí solo se calcula, contabiliza y se organiza la seguridad social.

En producción las tablas y columnas nuevas no se crean solas (`sync` solo corre con `NODE_ENV=development`): hay que correr el SQL de cada entrega en Supabase (`sql-nomina-fase2.sql`, `sql-centros-trabajo.sql`).
