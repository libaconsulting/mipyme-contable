const { DataTypes } = require('sequelize');
const sequelize = require('../../../config/database');

// Un pago a proveedores, un recaudo de clientes o un descuento que cruza documentos por pagar / por cobrar.
//  - pago:      sale plata (banco o caja) y baja facturas de compra / documentos soporte (2205 / 2335).
//  - recaudo:   entra plata (banco o caja) y baja facturas de venta (1305).
//  - descuento: baja el saldo de un documento sin mover plata (ej. aportes de seguridad social que el
//               contratista asume: ya se causaron contra 2335 en la planilla Y, aquí solo se aplican).
// Lo que cada pago cubre está en PagoAplicacion.
const PagoTesoreria = sequelize.define('PagoTesoreria', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  empresaId: { type: DataTypes.UUID, allowNull: false },
  tipo: { type: DataTypes.STRING(10), allowNull: false }, // pago | recaudo | descuento
  fecha: { type: DataTypes.DATEONLY, allowNull: false },
  terceroId: { type: DataTypes.UUID, allowNull: false },
  valor: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  medio: { type: DataTypes.STRING(10) }, // banco | caja (nulo en descuentos)
  cuentaBancariaId: { type: DataTypes.UUID },
  movimientoBancarioId: { type: DataTypes.UUID },
  // true si el movimiento lo creó este pago (se borra al anular); false si ya existía en el extracto y se enlazó.
  movimientoCreado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  asientoId: { type: DataTypes.UUID },
  referencia: { type: DataTypes.STRING(60) }, // número de transferencia, cheque, consignación...
  observaciones: { type: DataTypes.STRING(250) },
  estado: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'activo' }, // activo | anulado
  motivoAnulacion: { type: DataTypes.STRING(250) },
  fechaAnulacion: { type: DataTypes.DATE },
  usuarioId: { type: DataTypes.UUID },
}, {
  tableName: 'tesoreria_pagos',
  indexes: [{ fields: ['empresa_id', 'tercero_id'] }, { fields: ['empresa_id', 'fecha'] }],
});

module.exports = PagoTesoreria;
