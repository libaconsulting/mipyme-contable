// Punto único donde se registran TODOS los modelos del núcleo contable.
// server.js importa este archivo antes de sincronizar la base de datos,
// así que ningún modelo se queda afuera por no estar "require"ado en
// alguna cadena de rutas activa. A medida que agreguemos modelos a los
// módulos operativos (compras, nómina, etc.), se suman aquí también.

const Empresa = require('./Empresa');
const Tercero = require('./Tercero');
const Proyecto = require('./Proyecto');
const PlanCuentas = require('./PlanCuentas');
const Asiento = require('./Asiento');
const Movimiento = require('./Movimiento');
const PeriodoContable = require('./PeriodoContable');
const ReglaContabilizacion = require('./ReglaContabilizacion');
const ParametroTributario = require('./ParametroTributario');
const Usuario = require('./Usuario');
const LogAuditoria = require('./LogAuditoria');

// Modelos de módulos operativos ya construidos
const FacturaVenta = require('../../modules/ventas/models/FacturaVenta');
const Cotizacion = require('../../modules/ventas/models/Cotizacion');
const CotizacionItem = require('../../modules/ventas/models/CotizacionItem');
const OrdenCompra = require('../../modules/compras/models/OrdenCompra');
const OrdenCompraItem = require('../../modules/compras/models/OrdenCompraItem');
const FacturaCompra = require('../../modules/compras/models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../../modules/compras/models/DocumentoSoporteAdquisicion');
const ConfigNomina = require('../../modules/nomina/models/ConfigNomina');
const ContratoLaboral = require('../../modules/nomina/models/ContratoLaboral');
const AusenciaNomina = require('../../modules/nomina/models/AusenciaNomina');
const ConceptoNomina = require('../../modules/nomina/models/ConceptoNomina');
const NominaPeriodo = require('../../modules/nomina/models/NominaPeriodo');
const NominaLiquidacion = require('../../modules/nomina/models/NominaLiquidacion');
const NominaPrestacion = require('../../modules/nomina/models/NominaPrestacion');
const NominaPrestacionLinea = require('../../modules/nomina/models/NominaPrestacionLinea');
const NominaPlanillaPago = require('../../modules/nomina/models/NominaPlanillaPago');
const CentroTrabajo = require('../../modules/nomina/models/CentroTrabajo');
const ContratoContratista = require('../../modules/nomina/models/ContratoContratista');
const AportesContratistas = require('../../modules/nomina/models/AportesContratistas');
const Producto = require('../../modules/inventarios/models/Producto');
const KardexMovimiento = require('../../modules/inventarios/models/KardexMovimiento');
const ActivoFijo = require('../../modules/activosFijos/models/ActivoFijo');
const CuentaBancaria = require('../../modules/tesoreria/models/CuentaBancaria');
const MovimientoBancario = require('../../modules/tesoreria/models/MovimientoBancario');

module.exports = {
  Empresa,
  Tercero,
  Proyecto,
  PlanCuentas,
  Asiento,
  Movimiento,
  PeriodoContable,
  ReglaContabilizacion,
  ParametroTributario,
  Usuario,
  LogAuditoria,
  FacturaVenta,
  Cotizacion,
  CotizacionItem,
  OrdenCompra,
  OrdenCompraItem,
  FacturaCompra,
  DocumentoSoporteAdquisicion,
  ConfigNomina,
  ContratoLaboral,
  AusenciaNomina,
  ConceptoNomina,
  NominaPeriodo,
  NominaLiquidacion,
  NominaPrestacion,
  NominaPrestacionLinea,
  NominaPlanillaPago,
  CentroTrabajo,
  ContratoContratista,
  AportesContratistas,
  Producto,
  KardexMovimiento,
  ActivoFijo,
  CuentaBancaria,
  MovimientoBancario,
};
