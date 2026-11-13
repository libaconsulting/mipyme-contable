const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un pago a proveedores, un recaudo de clientes o un descuento que cruza documentos por pagar / por cobrar.
//  - pago:      sale plata (banco o caja) y baja facturas de compra / documentos soporte (2205 / 2335).
//  - recaudo:   entra plata (banco o caja) y baja facturas de venta (1305).
//  - descuento: baja el saldo de un documento sin mover plata (ej. aportes de seguridad social que el
//               contratista asume: ya se causaron contra 2335 en la planilla Y, aquí solo se aplican).
// Anticipos (anticipos.service.js):
//  - anticipo_cliente:    entra plata de un cliente antes de facturarle (Db banco / Cr 2805). Sin documentos.
//  - anticipo_proveedor:  sale plata a un proveedor antes de recibir su factura (Db 1330 / Cr banco). Sin documentos.
//  - cruce_anticipo:      aplica un anticipo a facturas; no mueve plata (cliente: Db 2805 / Cr 1305; proveedor: Db 2205 o 2335 / Cr 1330).
//  - devolucion_anticipo: se devuelve (o nos devuelven) la plata de un anticipo que no se aplicó.
// Los cruces y las devoluciones apuntan a su anticipo con `anticipoId`; lo que le queda = valor − cruces − devoluciones activos.
// Lo que cada pago cubre está en PagoAplicacion.
const PagoTesoreria = sequelize.define('PagoTesoreria', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  tipo: { type: DataTypes.STRING(20), allowNull: false }, // pago | recaudo | descuento | anticipo_cliente | anticipo_proveedor | cruce_anticipo | devolucion_anticipo
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false },
  // Lo que realmente entró o salió de caja o banco. En un recaudo con retenciones es lo aplicado a las facturas menos lo retenido.
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  retenciones: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 }, // total retenido por el cliente (solo recaudos)
  otrosDescuentos: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 }, // estampillas, tasas y contribuciones descontadas (solo recaudos)
  medio: { type: DataTypes.STRING(10) }, // banco | caja (nulo en descuentos)
  cuentaBancariaId: { type: DataTypes.UUID },
  movimientoBancarioId: { type: DataTypes.UUID },
  // true si el movimiento lo creó este pago (se borra al anular); false si ya existía en el extracto y se enlazó.
  movimientoCreado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  asientoId: { type: DataTypes.UUID },
  // Solo en cruce_anticipo y devolucion_anticipo: el anticipo (otro PagoTesoreria) al que pertenecen.
  anticipoId: { type: DataTypes.UUID },
  referencia: { type: DataTypes.STRING(60) }, // número de transferencia, cheque, consignación...
  observaciones: { type: DataTypes.STRING(250) },
  estado: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'activo' }, // activo | anulado
  motivoAnulacion: { type: DataTypes.STRING(250) },
  fechaAnulacion: { type: DataTypes.DATE },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'tesoreria_pagos',
  indexes: [{ fields: ['empresa_id', 'tercero_id'] }, { fields: ['empresa_id', 'fecha'] }, { fields: ['anticipo_id'] }],
});

module.exports = PagoTesoreria;
