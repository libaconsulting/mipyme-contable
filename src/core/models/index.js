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
};
