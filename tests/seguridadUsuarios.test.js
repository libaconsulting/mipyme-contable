const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/core/utils/validacionUsuario');
const { crearLimitador } = require('../src/middleware/limitador');

test('correo: se normaliza y se valida', () => {
  assert.equal(V.validarEmail('  Ana@Correo.CO '), 'ana@correo.co');
  for (const malo of ['', 'ana', 'ana@', '@correo.co', 'ana@correo', 'a na@correo.co', 'a<b>@correo.co']) {
    assert.throws(() => V.validarEmail(malo), /correo electrónico válido/, malo);
  }
});

test('contraseña: 8 a 72 caracteres con letras y números', () => {
  assert.equal(V.validarPassword('clave1234'), 'clave1234');
  assert.throws(() => V.validarPassword('abc123'), /8 caracteres/);
  assert.throws(() => V.validarPassword('solamenteletras'), /letras y números/);
  assert.throws(() => V.validarPassword('12345678'), /letras y números/);
  assert.throws(() => V.validarPassword('a1'.repeat(40)), /72/);
  assert.throws(() => V.validarPassword(undefined), /8 caracteres/);
});

test('nombre y rol', () => {
  assert.equal(V.validarNombre('  Ana   María  '), 'Ana María');
  assert.throws(() => V.validarNombre('A'), /nombre/);
  assert.throws(() => V.validarNombre('<script>'), /símbolos/);
  assert.equal(V.validarRol('contador'), 'contador');
  assert.throws(() => V.validarRol('admin'), /rol es/);
});

test('quién puede asignar roles y administrar a quién', () => {
  assert.equal(V.puedeAsignarRol('dueño', 'dueño'), true);
  assert.equal(V.puedeAsignarRol('contador', 'dueño'), false);
  assert.equal(V.puedeAsignarRol('contador', 'auxiliar'), true);
  assert.equal(V.puedeAsignarRol('auxiliar', 'revisor'), false);
  assert.equal(V.puedeAsignarRol('dueño', 'superadmin'), false);
  assert.equal(V.puedeAdministrarA('contador', 'dueño'), false);
  assert.equal(V.puedeAdministrarA('contador', 'contador'), true);
  assert.equal(V.puedeAdministrarA('dueño', 'dueño'), true);
  assert.equal(V.puedeAdministrarA('revisor', 'auxiliar'), false);
});

test('limitador: bloquea al pasar el máximo y se libera al vencer la ventana', () => {
  const l = crearLimitador({ ventanaMs: 1000, max: 3 });
  for (let i = 0; i < 3; i++) { assert.equal(l.permitido('a', 0), true); l.registrar('a', 0); }
  assert.equal(l.permitido('a', 500), false);
  assert.equal(l.permitido('b', 500), true); // otra clave no se afecta
  assert.equal(l.minutosRestantes('a', 500), 1);
  assert.equal(l.permitido('a', 1000), true); // venció la ventana
  l.registrar('a', 1000); l.registrar('a', 1000); l.registrar('a', 1000);
  assert.equal(l.permitido('a', 1100), false);
  l.reiniciar('a');
  assert.equal(l.permitido('a', 1100), true);
});
