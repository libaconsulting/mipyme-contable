// Punto único donde se registran TODOS los modelos del núcleo contable.
// server.js importa este archivo antes de sincronizar la base de datos,
// así que ningún modelo se queda afuera por no estar "require"ado en
// alguna cadena de rutas activa. A medida que agreguemos modelos a los
// módulos operativos (compras, nómina, etc.), se suman aquí también.

const Empresa = require('./Empresa');
const Tercero = require('./Tercero');
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
const OrdenCompra = require('../../modules/compras/models/OrdenCompra');
const FacturaCompra = require('../../modules/compras/models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../../modules/compras/models/DocumentoSoporteAdquisicion');
const PeriodoNomina = require('../../modules/nomina/models/PeriodoNomina');
const NominaEmpleado = require('../../modules/nomina/models/NominaEmpleado');
const NovedadNomina = require('../../modules/nomina/models/NovedadNomina');
const Producto = require('../../modules/inventarios/models/Producto');
const MovimientoInventario = require('../../modules/inventarios/models/MovimientoInventario');
const ActivoFijo = require('../../modules/activosFijos/models/ActivoFijo');
const CuentaBancaria = require('../../modules/tesoreria/models/CuentaBancaria');
const MovimientoBancario = require('../../modules/tesoreria/models/MovimientoBancario');

module.exports = {
  Empresa,
  Tercero,
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
  OrdenCompra,
  FacturaCompra,
  DocumentoSoporteAdquisicion,
  PeriodoNomina,
  NominaEmpleado,
  NovedadNomina,
  Producto,
  MovimientoInventario,
  ActivoFijo,
  CuentaBancaria,
  MovimientoBancario,
};
