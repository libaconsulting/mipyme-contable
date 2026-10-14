// Ejecutar con: node --test tests/divipola.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/contable/divipola');

test('Lista oficial: 33 departamentos y 1.122 municipios, sin repetidos', () => {
  assert.equal(D.DEPARTAMENTOS.length, 33);
  assert.equal(D.MUNICIPIOS.length, 1122);
  assert.equal(new Set(D.MUNICIPIOS.map((m) => m[0])).size, 1122);
  for (const m of D.MUNICIPIOS) {
    assert.match(m[0], /^\d{5}$/);
    assert.ok(D.nombreDepartamento(m[0].slice(0, 2)), `departamento de ${m[0]}`);
  }
});

test('Códigos conocidos', () => {
  assert.equal(D.nombreDepartamento('11'), 'Bogotá, D.C.');
  assert.equal(D.nombreMunicipio('11', '001'), 'Bogotá, D.C.');
  assert.equal(D.nombreMunicipio('05', '001'), 'Medellín');
  assert.equal(D.nombreMunicipio('76', '001'), 'Cali');
  assert.equal(D.nombreMunicipio('08', '001'), 'Barranquilla');
  assert.equal(D.nombreMunicipio('27', '086'), 'Belén de Bajirá');
  assert.equal(D.nombreDepartamento('88'), 'Archipiélago de San Andrés, Providencia y Santa Catalina');
  assert.equal(D.nombreMunicipio('05', '999'), '');
  assert.equal(D.etiquetaMunicipio('05', '001'), 'Medellín (001)');
  assert.equal(D.municipiosDe('88').length, 2);
});

test('Interpretar lo escrito: sin tildes, sin mayúsculas, con o sin código', () => {
  assert.equal(D.resolverDepartamento('antioquia').codigo, '05');
  assert.equal(D.resolverDepartamento('BOGOTA, d.c.').codigo, '11');
  assert.equal(D.resolverDepartamento('Valle del Cauca (76)').codigo, '76');
  assert.equal(D.resolverDepartamento('76').codigo, '76');
  assert.equal(D.resolverDepartamento('Inventado'), null);
  assert.equal(D.resolverMunicipio('05', 'medellin').codigo, '001');
  assert.equal(D.resolverMunicipio('05', 'Cali'), null); // Cali no es de Antioquia
  assert.equal(D.resolverMunicipio('76', 'cali (001)').codigo, '001');
});
