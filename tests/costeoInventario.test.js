// Ejecutar con: node --test tests/costeoInventario.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/contable/costeoInventario');

const vacio = { cantidad: 0, valor: 0 };

test('Promedio ponderado: dos compras a distinto costo', () => {
  let r = C.entrada(vacio, 10, 1000); // 100 c/u
  assert.equal(r.costoPromedio, 100);
  r = C.entrada(r.saldo, 10, 1200); // 120 c/u
  assert.deepEqual(r.saldo, { cantidad: 20, valor: 2200 });
  assert.equal(r.costoPromedio, 110);
  const s = C.salida(r.saldo, 5);
  assert.equal(s.valor, 550);
  assert.equal(s.costoUnitario, 110);
  assert.deepEqual(s.saldo, { cantidad: 15, valor: 1650 });
  assert.equal(s.sinExistencias, false);
});

test('Si sale todo lo que hay, se lleva el valor completo (sin centavos sueltos)', () => {
  let r = C.entrada(vacio, 3, 100); // 33,3333 c/u
  const s1 = C.salida(r.saldo, 1);
  assert.equal(s1.valor, 33.33);
  const s2 = C.salida(s1.saldo, 1);
  assert.equal(s2.valor, 33.34, 'saldo 66,67 / 2 unidades');
  const s3 = C.salida(s2.saldo, 1);
  assert.equal(s3.valor, 33.33, 'la última unidad se lleva lo que queda: en total salen exactamente 100');
  assert.deepEqual(s3.saldo, { cantidad: 0, valor: 0 });
});

test('Cantidades fraccionadas (kilos, metros)', () => {
  let r = C.entrada(vacio, 2.5, 25000);
  const s = C.salida(r.saldo, 0.75);
  assert.equal(s.valor, 7500);
  assert.deepEqual(s.saldo, { cantidad: 1.75, valor: 17500 });
});

test('Venta sin existencias: sale al último costo, queda en negativo y se corrige con la compra', () => {
  let r = C.entrada(vacio, 2, 200); // 100 c/u
  const s = C.salida(r.saldo, 5, 100);
  assert.equal(s.sinExistencias, true);
  assert.equal(s.faltante, 3);
  assert.equal(s.valor, 500, '200 de lo que había + 3 × 100');
  assert.deepEqual(s.saldo, { cantidad: -3, valor: -300 });
  assert.equal(s.costoPromedio, 0);
  // llega la compra de 10 a 110
  const e = C.entrada(s.saldo, 10, 1100);
  assert.deepEqual(e.saldo, { cantidad: 7, valor: 800 });
  assert.equal(e.costoPromedio, 114.2857);
});

test('Salida sin existencias y sin costo conocido: avisa que quedó en cero', () => {
  const s = C.salida(vacio, 2, 0);
  assert.equal(s.valor, 0);
  assert.equal(s.sinCosto, true);
  assert.equal(s.sinExistencias, true);
});

test('Validaciones', () => {
  assert.throws(() => C.entrada(vacio, 0, 10), /mayor que cero/);
  assert.throws(() => C.entrada(vacio, 1, -5), /negativo/);
  assert.throws(() => C.salida(vacio, -1), /mayor que cero/);
});

test('Unidades del XML', () => {
  assert.equal(C.unidadDesdeXml('KGM'), 'kg');
  assert.equal(C.unidadDesdeXml('94'), 'unidad');
  assert.equal(C.unidadDesdeXml('XYZ'), 'unidad');
});

const productos = [
  { id: 'a', codigo: 'TOR-12', nombre: 'Tornillo 1/2"', tipo: 'bien', alias: ['900123456|c:t12'] },
  { id: 'b', codigo: 'PIN-01', nombre: 'Pintura blanca galón', tipo: 'bien', alias: ['d:pintura blanca 1 galon'] },
  { id: 'c', codigo: 'SRV-1', nombre: 'Instalación', tipo: 'servicio' },
  { id: 'd', codigo: 'OLD', nombre: 'Descontinuado', tipo: 'bien', activo: false },
];

test('Venta: se reconoce por código, luego alias y nombre; ignora servicios e inactivos', () => {
  assert.equal(C.buscarProducto(productos, { codigo: 'tor-12', descripcion: 'x' }, { origen: 'venta' }).producto.id, 'a');
  assert.equal(C.buscarProducto(productos, { codigo: '', descripcion: 'Pintura blanca 1 galón' }, { origen: 'venta' }).producto.id, 'b');
  assert.equal(C.buscarProducto(productos, { codigo: '', descripcion: 'PINTURA BLANCA GALÓN' }, { origen: 'venta' }).motivo, 'nombre');
  assert.equal(C.buscarProducto(productos, { codigo: 'SRV-1', descripcion: 'Instalación' }, { origen: 'venta' }), null);
  assert.equal(C.buscarProducto(productos, { codigo: 'OLD', descripcion: '' }, { origen: 'venta' }), null);
});

test('Compra: el código es del proveedor, se ata a su NIT', () => {
  const a = C.buscarProducto(productos, { codigo: 'T12', descripcion: 'Tornillo' }, { origen: 'compra', nit: '900.123.456' });
  assert.equal(a.producto.id, 'a');
  assert.equal(a.motivo, 'alias');
  // el mismo código de otro proveedor no coincide por alias
  const b = C.buscarProducto(productos, { codigo: 'T12', descripcion: 'Otra cosa' }, { origen: 'compra', nit: '800111222' });
  assert.equal(b, null);
  assert.deepEqual(C.clavesAlias('compra', '900.123.456-7', { codigo: 'AB 1', descripcion: 'Un Ítem' }), ['9001234567|c:ab1', '9001234567|d:un item']);
  assert.deepEqual(C.clavesAlias('venta', null, { codigo: '', descripcion: 'Un Ítem' }), ['d:un item']);
});
