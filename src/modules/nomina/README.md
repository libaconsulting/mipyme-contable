# Módulo: nomina

Liquidación mensual de nómina, provisiones, contabilización, pago y planilla de aportes. La documentación
completa (flujo, qué calcula, cuentas, supuestos legales y pendientes) está en la sección **Nómina** del
`README.md` de la raíz.

- `models/`      → ConfigNomina, ContratoLaboral, AusenciaNomina, ConceptoNomina, NominaPeriodo, NominaLiquidacion
- `services/`    → `nomina.service.js`: usa el motor compartido `public/contable/liquidacionNomina.js` y contabiliza con
                   `motorAsientos.contabilizarAsientoCompuesto` (nunca escribe asientos directamente)
- `controllers/` → capa HTTP
- `routes/`      → montadas en `/api/nomina` (leer: dueño, contador, revisor; modificar: dueño y contador; el auxiliar no entra)

La nómina electrónica se emite en Siigo; aquí solo se calcula, contabiliza y se organiza la seguridad social.
