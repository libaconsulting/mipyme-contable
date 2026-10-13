const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../public/contable/planCuentas');

test('clasifica el código por su primer dígito', () => {
  const casos = [
    ['1105', 'debito', 'activo'],
    ['2205', 'credito', 'pasivo'],
    ['3605', 'credito', 'patrimonio'],
    ['4135', 'credito', 'ingreso'],
    ['5135', 'debito', 'gasto'],
    ['6135', 'debito', 'costo'],
    ['7305', 'debito', 'costo'],
  ];
  for (const [codigo, naturaleza, elemento] of casos) {
    const r = pc.clasificarCodigo(codigo);
    assert.equal(r.ok, true, codigo);
    assert.equal(r.naturaleza, naturaleza, codigo);
    assert.equal(r.elementoNiif, elemento, codigo);
    assert.equal(r.nivel, 1);
  }
});

test('las cuentas que restan del activo son de naturaleza crédito', () => {
  for (const c of ['1399', '1499', '1592', '1599', '1698', '1699']) {
    assert.equal(pc.clasificarCodigo(c).naturaleza, 'credito', c);
  }
  assert.equal(pc.clasificarCodigo('1524').naturaleza, 'debito');
});

test('subcuenta de 6 dígitos: nivel 2 y hereda la naturaleza de la cuenta padre', () => {
  const r = pc.clasificarCodigo('513525');
  assert.equal(r.nivel, 2);
  assert.equal(r.naturaleza, 'debito');
  const hija = pc.clasificarCodigo('159205', { naturaleza: 'credito' });
  assert.equal(hija.naturaleza, 'credito');
});

test('rechaza códigos mal formados con mensajes claros', () => {
  assert.match(pc.clasificarCodigo('').error, /Escribe el código/);
  assert.match(pc.clasificarCodigo('51A5').error, /solo lleva números/);
  assert.match(pc.clasificarCodigo('8105').error, /empezar por 1/);
  assert.match(pc.clasificarCodigo('9105').error, /empezar por 1/);
  assert.match(pc.clasificarCodigo('513').error, /4 dígitos/);
  assert.match(pc.clasificarCodigo('51352').error, /4 dígitos/);
  assert.match(pc.clasificarCodigo('51352512').error, /4 dígitos/);
  assert.match(pc.clasificarCodigo('0135').error, /empezar por 1/);
});

test('ignora espacios dentro del código', () => {
  assert.equal(pc.clasificarCodigo(' 51 35 ').codigo, '5135');
});

test('avisa (sin bloquear) si el grupo no es habitual del PUC', () => {
  assert.equal(pc.clasificarCodigo('5135').aviso, '');
  assert.match(pc.clasificarCodigo('5699').aviso, /no es un grupo habitual/);
  assert.equal(pc.clasificarCodigo('5699').ok, true);
});

test('valida el nombre', () => {
  assert.equal(pc.validarNombre('  Papelería   y útiles ').nombre, 'Papelería y útiles');
  assert.equal(pc.validarNombre('ab').ok, false);
  assert.equal(pc.validarNombre('x'.repeat(101)).ok, false);
  assert.equal(pc.validarNombre('<script>').ok, false);
  assert.equal(pc.validarNombre(null).ok, false);
});

test('qué cuentas sirven como destino de una compra', () => {
  const d = (codigo) => pc.esDestinoCompra(pc.datosDeCatalogo({ codigo, nombre: 'x' }));
  assert.equal(d('5135'), true); // gasto
  assert.equal(d('6135'), true); // costo
  assert.equal(d('1455'), true); // inventario
  assert.equal(d('1528'), true); // activo fijo
  assert.equal(d('1635'), true); // intangible
  assert.equal(d('1705'), true); // diferido
  assert.equal(d('1592'), false); // depreciación acumulada (crédito)
  assert.equal(d('2205'), false); // pasivo
  assert.equal(d('4135'), false); // ingreso
  assert.equal(d('1110'), false); // bancos
  assert.equal(pc.esDestinoCompra(null), false);
});

test('el catálogo es consistente', () => {
  const codigos = pc.CATALOGO.map((c) => c.codigo);
  assert.equal(new Set(codigos).size, codigos.length, 'sin códigos repetidos');
  for (const c of pc.CATALOGO) {
    assert.match(c.codigo, /^[1-7]\d{3}$/, c.codigo);
    assert.ok(pc.GRUPOS_CATALOGO.includes(c.grupo), c.grupo);
    assert.ok(c.nombre.length >= 3 && c.uso.length > 10, c.codigo);
    const k = pc.clasificarCodigo(c.codigo);
    assert.equal(k.ok, true);
    assert.equal(k.aviso, '', 'grupo conocido: ' + c.codigo);
  }
  // Toda cuenta esencial del sistema tiene que poder existir
  for (const e of pc.CUENTAS_ESENCIALES) assert.match(e, /^\d{4}$/);
});
