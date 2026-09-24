#!/bin/bash
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  exit 1
fi

cat > src/routes/terceros.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Tercero = require('../core/models/Tercero');

// Campos editables/creables — se comparten entre crear y editar para
// no tener dos listas que se puedan desincronizar.
const CAMPOS_TERCERO = [
  'tipo',
  'tipoPersona',
  'identificacion',
  'nombre',
  'email',
  'celular',
  'direccion',
  'departamento',
  'municipio',
  'regimenIva',
  'responsabilidadesFiscales',
  'cuentaBancariaTipo',
  'cuentaBancariaBanco',
  'cuentaBancariaNumero',
];

function extraerCampos(body) {
  const datos = {};
  for (const campo of CAMPOS_TERCERO) {
    if (body[campo] !== undefined) datos[campo] = body[campo];
  }
  return datos;
}

// POST /api/terceros
router.post('/', async (req, res) => {
  try {
    const tercero = await Tercero.create({
      id: uuidv4(),
      empresaId: req.usuario.empresaId,
      ...extraerCampos(req.body),
    });
    res.status(201).json(tercero);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/terceros (opcionalmente filtrado por ?tipo=cliente|proveedor|empleado|otro)
router.get('/', async (req, res) => {
  try {
    const where = { empresaId: req.usuario.empresaId };
    if (req.query.tipo) where.tipo = req.query.tipo;
    const terceros = await Tercero.findAll({ where });
    res.json(terceros);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PATCH /api/terceros/:id
router.patch('/:id', async (req, res) => {
  try {
    const tercero = await Tercero.findOne({
      where: { id: req.params.id, empresaId: req.usuario.empresaId },
    });
    if (!tercero) {
      return res.status(404).json({ error: 'Tercero no encontrado.' });
    }
    await tercero.update(extraerCampos(req.body));
    res.json(tercero);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
SCRIPTEOF
echo "OK  src/routes/terceros.routes.js"

cat > public/contable/app.js << 'SCRIPTEOF'
const API = '/api';

let token = localStorage.getItem('token');
let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
let mapaTerceros = {};
let listaTerceros = [];

const vistaLogin = document.getElementById('vista-login');
const vistaDashboard = document.getElementById('vista-dashboard');

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    cerrarSesion('Tu sesión expiró. Inicia sesión de nuevo.');
    throw new Error('No autenticado');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

// Atajo para botones de acción: llama la API y recarga todo el tablero.
// Cualquier error se muestra en una alerta simple — es intencionalmente
// básico, para no construir un sistema de notificaciones todavía.
async function accion(path, options = {}) {
  try {
    await api(path, options);
    await cargarTodo();
  } catch (err) {
    alert(err.message);
  }
}

function formatoDinero(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });
}

function formatoFecha(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function nombreTercero(id) {
  return mapaTerceros[id] || id || '—';
}

function badge(estado) {
  if (!estado) return '—';
  return `<span class="badge ${estado}">${estado.replace(/_/g, ' ')}</span>`;
}

function tablaVacia(idTabla, colSpan, mensaje) {
  document.querySelector(`#${idTabla} tbody`).innerHTML =
    `<tr><td colspan="${colSpan}" class="vacio">${mensaje}</td></tr>`;
}

function botonAccion(texto, dataAttrs, destructivo) {
  const attrs = Object.entries(dataAttrs)
    .map(([k, v]) => `data-${k}="${v}"`)
    .join(' ');
  return `<button class="btn-accion${destructivo ? ' destructivo' : ''}" ${attrs}>${texto}</button>`;
}

// --- LOGIN ---
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  errorEl.style.color = '';

  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');

    token = data.token;
    usuario = data.usuario;
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuario));
    mostrarDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

function cerrarSesion(mensaje) {
  token = null;
  usuario = null;
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  vistaDashboard.hidden = true;
  vistaLogin.hidden = false;
  if (mensaje) {
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = mensaje;
    errorEl.hidden = false;
  }
}

document.getElementById('btn-salir').addEventListener('click', () => cerrarSesion());

// --- ONBOARDING: crear empresa nueva y su primer usuario, sin sesión ---
const tarjetaLoginPrincipal = document.getElementById('tarjeta-login-principal');
const tarjetaOnboarding = document.getElementById('tarjeta-onboarding');
let empresaNuevaId = null;

document.getElementById('btn-mostrar-onboarding').addEventListener('click', () => {
  tarjetaLoginPrincipal.hidden = true;
  tarjetaOnboarding.hidden = false;
});

function volverALogin() {
  tarjetaOnboarding.hidden = true;
  tarjetaLoginPrincipal.hidden = false;
  document.getElementById('form-empresa-nueva').hidden = false;
  document.getElementById('form-usuario-nuevo').hidden = true;
  document.getElementById('form-empresa-nueva').reset();
  document.getElementById('form-usuario-nuevo').reset();
  document.getElementById('onboarding-resultado').hidden = true;
  empresaNuevaId = null;
}

document.getElementById('btn-volver-login').addEventListener('click', volverALogin);

document.getElementById('form-empresa-nueva').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch(API + '/empresas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razonSocial: document.getElementById('empresa-razon-social').value,
        nit: document.getElementById('empresa-nit').value,
        regimenTributario: document.getElementById('empresa-regimen').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la empresa.');

    empresaNuevaId = data.id;
    document.getElementById('empresa-creada-mensaje').textContent =
      `Empresa "${data.razonSocial}" creada. Ahora crea su primer usuario:`;
    document.getElementById('form-empresa-nueva').hidden = true;
    document.getElementById('form-usuario-nuevo').hidden = false;
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('form-usuario-nuevo').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch(API + '/auth/registro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empresaId: empresaNuevaId,
        nombre: document.getElementById('usuario-nuevo-nombre').value,
        email: document.getElementById('usuario-nuevo-email').value,
        password: document.getElementById('usuario-nuevo-password').value,
        rol: document.getElementById('usuario-nuevo-rol').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear el usuario.');

    volverALogin();
    document.getElementById('login-email').value = data.email;
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = `Usuario "${data.email}" creado. Ya puedes iniciar sesión.`;
    errorEl.style.color = 'var(--accent)';
    errorEl.hidden = false;
  } catch (err) {
    alert(err.message);
  }
});

// --- DASHBOARD SHELL ---
function mostrarDashboard() {
  vistaLogin.hidden = true;
  vistaDashboard.hidden = false;
  document.getElementById('usuario-nombre').textContent = usuario.nombre;
  document.getElementById('usuario-rol').textContent = usuario.rol;
  document.getElementById('inicio-usuario-nombre').textContent = usuario.nombre;
  cargarTodo();
  cargarNombreEmpresa();
}

async function cargarNombreEmpresa() {
  if (!usuario.empresaId) return;
  try {
    const empresas = await api('/empresas');
    const miEmpresa = empresas.find((e) => e.id === usuario.empresaId);
    document.getElementById('inicio-empresa-nombre').textContent = miEmpresa ? miEmpresa.razonSocial : '—';
  } catch (err) {
    console.error(err);
  }
}

// Cambia de pestaña — la usan tanto el menú lateral como las tarjetas
// del panel de Inicio, para no duplicar la lógica.
function irATab(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activo'));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
  const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (navItem) navItem.classList.add('activo');
  document.getElementById('panel-' + tab).hidden = false;
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => irATab(btn.dataset.tab));
});

document.querySelectorAll('.tarjeta-modulo').forEach((btn) => {
  btn.addEventListener('click', () => irATab(btn.dataset.irA));
});

// --- TOGGLE DE FORMULARIOS "+ Nuevo..." ---
function conectarToggle(botonId, formularioId, cancelarId) {
  const boton = document.getElementById(botonId);
  const formulario = document.getElementById(formularioId);
  boton.addEventListener('click', () => (formulario.hidden = !formulario.hidden));
  document.getElementById(cancelarId).addEventListener('click', () => {
    formulario.hidden = true;
    formulario.reset();
  });
}

conectarToggle('btn-nuevo-tercero', 'form-tercero', 'btn-cancelar-tercero');
document.getElementById('btn-nuevo-tercero').addEventListener('click', () => {
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});
conectarToggle('btn-nueva-cotizacion', 'form-cotizacion', 'btn-cancelar-cotizacion');
conectarToggle('btn-nueva-orden', 'form-orden', 'btn-cancelar-orden');
conectarToggle('btn-nuevo-periodo', 'form-periodo', 'btn-cancelar-periodo');
conectarToggle('btn-nuevo-producto', 'form-producto', 'btn-cancelar-producto');
conectarToggle('btn-nuevo-activo', 'form-activo', 'btn-cancelar-activo');
conectarToggle('btn-nueva-cuenta', 'form-cuenta', 'btn-cancelar-cuenta');
conectarToggle('btn-nuevo-movimiento', 'form-movimiento', 'btn-cancelar-movimiento');

// --- CARGA DE DATOS ---
async function cargarTodo() {
  try {
    const terceros = await api('/terceros');
    listaTerceros = terceros;
    mapaTerceros = Object.fromEntries(terceros.map((t) => [t.id, t.nombre]));
    renderTerceros(terceros);
    poblarSelectTodosTerceros('cotizacion-tercero', 'Tercero');
    poblarSelectTodosTerceros('orden-tercero', 'Tercero');

    const [cotizaciones, facturasVenta, ordenes, facturasCompra, periodos, productos, activos, cuentas, movBancarios] = await Promise.all([
      api('/ventas/cotizaciones'),
      api('/ventas/facturas'),
      api('/compras/ordenes'),
      api('/compras/facturas'),
      api('/nomina/periodos'),
      api('/inventarios/productos'),
      api('/activos-fijos'),
      api('/tesoreria/cuentas'),
      api('/tesoreria/movimientos'),
    ]);

    renderCotizaciones(cotizaciones);
    renderFacturasVenta(facturasVenta);
    renderOrdenes(ordenes);
    renderFacturasCompra(facturasCompra);
    renderNomina(periodos);
    renderProductos(productos);
    renderActivos(activos);
    renderCuentas(cuentas);
    poblarSelectCuentas(cuentas);
    renderMovimientosBancarios(movBancarios);
  } catch (err) {
    console.error(err);
  }
}

// Muestra TODOS los terceros sin filtrar por tipo — la categorización
// (cliente/proveedor/empleado/otro) es solo una referencia informativa,
// no una restricción. La única excepción real es Nómina, que sí exige
// tipo "empleado" (ver agregarEmpleadoAPeriodo), porque ahí sí importa
// no confundir un proveedor con alguien de la nómina.
function poblarSelectTodosTerceros(selectId, etiqueta) {
  const select = document.getElementById(selectId);
  select.innerHTML =
    `<option value="">${etiqueta}...</option>` +
    listaTerceros.map((t) => `<option value="${t.id}">${t.nombre} (${t.tipo})</option>`).join('');
}

function poblarSelectCuentas(cuentas) {
  const select = document.getElementById('movimiento-cuenta');
  select.innerHTML =
    '<option value="">Cuenta bancaria...</option>' +
    cuentas.map((c) => `<option value="${c.id}">${c.banco} — ${c.numero}</option>`).join('');
}

// --- RENDER: TERCEROS ---
function renderTerceros(lista) {
  document.querySelector('#tabla-terceros thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th>Persona</th><th>Identificación</th><th>Celular</th><th>Correo</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-terceros', 7, 'Todavía no hay terceros. Crea el primero arriba.');
  document.querySelector('#tabla-terceros tbody').innerHTML = lista
    .map(
      (t) =>
        `<tr><td>${t.nombre}</td><td>${t.tipo}</td><td>${t.tipoPersona || '—'}</td><td>${
          t.identificacion
        }</td><td>${t.celular || '—'}</td><td>${t.email || '—'}</td><td class="acciones">${botonAccion(
          'Editar',
          { accion: 'editar-tercero', id: t.id }
        )}</td></tr>`
    )
    .join('');
}

// --- RENDER: COTIZACIONES (con acciones según estado) ---
function renderCotizaciones(lista) {
  document.querySelector('#tabla-cotizaciones thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Cliente</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cotizaciones', 6, 'Todavía no hay cotizaciones.');
  document.querySelector('#tabla-cotizaciones tbody').innerHTML = lista
    .map((c) => {
      let acciones = '—';
      if (c.estado === 'borrador') acciones = botonAccion('Enviar', { accion: 'enviar-cotizacion', id: c.id });
      else if (c.estado === 'enviada')
        acciones =
          botonAccion('Aceptar', { accion: 'aceptar-cotizacion', id: c.id }) +
          botonAccion('Rechazar', { accion: 'rechazar-cotizacion', id: c.id }, true);
      else if (c.estado === 'aceptada') acciones = botonAccion('Convertir en factura', { accion: 'convertir-cotizacion', id: c.id });

      return `<tr><td>${c.consecutivo || '—'}</td><td>${formatoFecha(c.fecha)}</td><td>${nombreTercero(
        c.terceroId
      )}</td><td>${badge(c.estado)}</td><td class="num">${formatoDinero(c.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasVenta(lista) {
  document.querySelector('#tabla-facturas-venta thead').innerHTML =
    '<tr><th>Fecha</th><th>Cliente</th><th>DIAN</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-venta', 4, 'Todavía no hay facturas de venta.');
  document.querySelector('#tabla-facturas-venta tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoSincronizacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

// --- RENDER: ÓRDENES DE ADQUISICIÓN ---
function renderOrdenes(lista) {
  document.querySelector('#tabla-ordenes thead').innerHTML =
    '<tr><th>No.</th><th>Fecha</th><th>Proveedor</th><th>Proyecto</th><th>Tipo</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-ordenes', 8, 'Todavía no hay órdenes de adquisición.');
  document.querySelector('#tabla-ordenes tbody').innerHTML = lista
    .map((o) => {
      let acciones = '—';
      if (['borrador', 'emitida'].includes(o.estado)) acciones = botonAccion('Aprobar', { accion: 'aprobar-orden', id: o.id });
      else if (['aprobada', 'recibida_parcial', 'recibida_total'].includes(o.estado))
        acciones = botonAccion('Convertir en factura', { accion: 'convertir-orden', id: o.id });

      return `<tr><td>${o.consecutivo || '—'}</td><td>${formatoFecha(o.fecha)}</td><td>${nombreTercero(
        o.terceroId
      )}</td><td>${o.proyecto || '—'}</td><td>${o.tipo}</td><td>${badge(
        o.estado
      )}</td><td class="num">${formatoDinero(o.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasCompra(lista) {
  document.querySelector('#tabla-facturas-compra thead').innerHTML =
    '<tr><th>Fecha</th><th>Proveedor</th><th>Conciliación</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-compra', 4, 'Todavía no hay facturas de compra.');
  document.querySelector('#tabla-facturas-compra tbody').innerHTML = lista
    .map(
      (f) =>
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${nombreTercero(f.terceroId)}</td><td>${badge(
          f.estadoConciliacion
        )}</td><td class="num">${formatoDinero(f.total)}</td></tr>`
    )
    .join('');
}

// --- RENDER: NÓMINA ---
function renderNomina(lista) {
  document.querySelector('#tabla-nomina thead').innerHTML = '<tr><th>Periodo</th><th>Estado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-nomina', 3, 'Todavía no hay periodos de nómina.');
  document.querySelector('#tabla-nomina tbody').innerHTML = lista
    .map((p) => {
      let acciones = '—';
      if (p.estado === 'borrador')
        acciones =
          botonAccion('Agregar empleado', { accion: 'agregar-empleado', id: p.id }) +
          botonAccion('Liquidar', { accion: 'liquidar-periodo', id: p.id });

      return `<tr><td>${formatoFecha(p.fechaInicio)} — ${formatoFecha(p.fechaFin)}</td><td>${badge(
        p.estado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: INVENTARIOS ---
function renderProductos(lista) {
  document.querySelector('#tabla-productos thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Costo promedio</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-productos', 5, 'Todavía no hay productos. Crea el primero arriba.');
  document.querySelector('#tabla-productos tbody').innerHTML = lista
    .map((p) => {
      const acciones =
        botonAccion('Entrada', { accion: 'entrada-inventario', id: p.id }) +
        botonAccion('Salida', { accion: 'salida-inventario', id: p.id }) +
        botonAccion('Ajuste', { accion: 'ajuste-inventario', id: p.id }, true);
      return `<tr><td>${p.nombre}</td><td>${p.tipo}</td><td class="num">${Number(p.cantidadDisponible).toLocaleString(
        'es-CO'
      )}</td><td class="num">${formatoDinero(p.costoPromedio)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: ACTIVOS FIJOS ---
function renderActivos(lista) {
  document.querySelector('#tabla-activos thead').innerHTML =
    '<tr><th>Nombre</th><th>Adquisición</th><th>Estado</th><th class="num">Costo</th><th class="num">Depreciado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-activos', 6, 'Todavía no hay activos fijos registrados.');
  document.querySelector('#tabla-activos tbody').innerHTML = lista
    .map((a) => {
      const acciones = a.estado === 'activo' ? botonAccion('Dar de baja', { accion: 'baja-activo', id: a.id }, true) : '—';
      return `<tr><td>${a.nombre}</td><td>${formatoFecha(a.fechaAdquisicion)}</td><td>${badge(
        a.estado
      )}</td><td class="num">${formatoDinero(a.costo)}</td><td class="num">${formatoDinero(
        a.valorDepreciadoAcumulado
      )}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- RENDER: TESORERÍA ---
function renderCuentas(lista) {
  document.querySelector('#tabla-cuentas thead').innerHTML = '<tr><th>Banco</th><th>Número</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cuentas', 2, 'Todavía no hay cuentas bancarias registradas.');
  document.querySelector('#tabla-cuentas tbody').innerHTML = lista
    .map((c) => `<tr><td>${c.banco}</td><td>${c.numero}</td></tr>`)
    .join('');
}

function renderMovimientosBancarios(lista) {
  document.querySelector('#tabla-movimientos-bancarios thead').innerHTML =
    '<tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Conciliado</th><th class="num">Valor</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-movimientos-bancarios', 6, 'Todavía no hay movimientos bancarios registrados.');
  document.querySelector('#tabla-movimientos-bancarios tbody').innerHTML = lista
    .map((m) => {
      const acciones = m.conciliado ? '—' : botonAccion('Conciliar', { accion: 'conciliar-movimiento', id: m.id });
      return `<tr><td>${formatoFecha(m.fecha)}</td><td>${m.tipo}</td><td>${m.descripcion || '—'}</td><td>${
        m.conciliado ? badge('conciliado') : badge('pendiente')
      }</td><td class="num">${formatoDinero(m.valor)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

// --- FORMULARIOS DE CREACIÓN ---
function conectarFormulario(formId, alEnviar) {
  const form = document.getElementById(formId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await alEnviar();
      form.reset();
      form.hidden = true;
      cargarTodo();
    } catch (err) {
      alert(err.message);
    }
  });
}

// null = el formulario está creando un tercero nuevo; con un id, está
// editando ese tercero existente (mismo formulario para las dos cosas).
let terceroEditandoId = null;

function abrirEdicionTercero(id) {
  const t = listaTerceros.find((x) => x.id === id);
  if (!t) return;

  terceroEditandoId = id;
  document.getElementById('form-tercero').hidden = false;
  document.getElementById('tercero-tipo').value = t.tipo || 'cliente';
  document.getElementById('tercero-tipo-persona').value = t.tipoPersona || '';
  document.getElementById('tercero-identificacion').value = t.identificacion || '';
  document.getElementById('tercero-nombre').value = t.nombre || '';
  document.getElementById('tercero-email').value = t.email || '';
  document.getElementById('tercero-celular').value = t.celular || '';
  document.getElementById('tercero-direccion').value = t.direccion || '';
  document.getElementById('tercero-departamento').value = t.departamento || '';
  document.getElementById('tercero-municipio').value = t.municipio || '';
  document.getElementById('tercero-regimen-iva').value = t.regimenIva || '';
  document.getElementById('tercero-cuenta-tipo').value = t.cuentaBancariaTipo || '';
  document.getElementById('tercero-cuenta-banco').value = t.cuentaBancariaBanco || '';
  document.getElementById('tercero-cuenta-numero').value = t.cuentaBancariaNumero || '';

  const responsabilidades = t.responsabilidadesFiscales || [];
  document.querySelectorAll('.chk-responsabilidad').forEach((chk) => {
    chk.checked = responsabilidades.includes(chk.value);
  });

  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar cambios';
  document.getElementById('form-tercero').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Cancelar también sale del modo edición, no solo limpia el formulario.
document.getElementById('btn-cancelar-tercero').addEventListener('click', () => {
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});

conectarFormulario('form-tercero', async () => {
  const responsabilidades = Array.from(document.querySelectorAll('.chk-responsabilidad:checked')).map((c) => c.value);
  const datos = {
    tipo: document.getElementById('tercero-tipo').value,
    tipoPersona: document.getElementById('tercero-tipo-persona').value || undefined,
    identificacion: document.getElementById('tercero-identificacion').value,
    nombre: document.getElementById('tercero-nombre').value,
    email: document.getElementById('tercero-email').value || undefined,
    celular: document.getElementById('tercero-celular').value || undefined,
    direccion: document.getElementById('tercero-direccion').value || undefined,
    departamento: document.getElementById('tercero-departamento').value || undefined,
    municipio: document.getElementById('tercero-municipio').value || undefined,
    regimenIva: document.getElementById('tercero-regimen-iva').value || undefined,
    cuentaBancariaTipo: document.getElementById('tercero-cuenta-tipo').value || undefined,
    cuentaBancariaBanco: document.getElementById('tercero-cuenta-banco').value || undefined,
    cuentaBancariaNumero: document.getElementById('tercero-cuenta-numero').value || undefined,
    responsabilidadesFiscales: responsabilidades.length > 0 ? responsabilidades : undefined,
  };

  if (terceroEditandoId) {
    await api(`/terceros/${terceroEditandoId}`, { method: 'PATCH', body: JSON.stringify(datos) });
  } else {
    await api('/terceros', { method: 'POST', body: JSON.stringify(datos) });
  }

  // Solo se limpia el modo edición si la llamada anterior tuvo éxito —
  // si falla, el formulario se queda abierto y editable para reintentar.
  terceroEditandoId = null;
  document.querySelector('#form-tercero button[type="submit"]').textContent = 'Guardar';
});

conectarFormulario('form-cotizacion', () =>
  api('/ventas/cotizaciones', {
    method: 'POST',
    body: JSON.stringify({
      terceroId: document.getElementById('cotizacion-tercero').value,
      fechaVencimiento: document.getElementById('cotizacion-vencimiento').value,
      total: Number(document.getElementById('cotizacion-total').value),
      formaPago: document.getElementById('cotizacion-forma-pago').value || undefined,
      observaciones: document.getElementById('cotizacion-observaciones').value || undefined,
      contactoNombre: document.getElementById('cotizacion-contacto-nombre').value || undefined,
      contactoTelefono: document.getElementById('cotizacion-contacto-telefono').value || undefined,
    }),
  })
);

conectarFormulario('form-orden', () =>
  api('/compras/ordenes', {
    method: 'POST',
    body: JSON.stringify({
      terceroId: document.getElementById('orden-tercero').value,
      tipo: document.getElementById('orden-tipo').value,
      proyecto: document.getElementById('orden-proyecto').value || undefined,
      lugarEntrega: document.getElementById('orden-lugar-entrega').value || undefined,
      formaPago: document.getElementById('orden-forma-pago').value || undefined,
      subtotal: Number(document.getElementById('orden-subtotal').value),
      iva: Number(document.getElementById('orden-iva').value || 0),
      total: Number(document.getElementById('orden-total').value),
    }),
  })
);

conectarFormulario('form-periodo', () =>
  api('/nomina/periodos', {
    method: 'POST',
    body: JSON.stringify({
      fechaInicio: document.getElementById('periodo-inicio').value,
      fechaFin: document.getElementById('periodo-fin').value,
    }),
  })
);

conectarFormulario('form-producto', () =>
  api('/inventarios/productos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('producto-nombre').value,
      tipo: document.getElementById('producto-tipo').value,
      unidadMedida: document.getElementById('producto-unidad').value || 'unidad',
    }),
  })
);

conectarFormulario('form-activo', () =>
  api('/activos-fijos', {
    method: 'POST',
    body: JSON.stringify({
      nombre: document.getElementById('activo-nombre').value,
      costo: Number(document.getElementById('activo-costo').value),
      vidaUtilMeses: Number(document.getElementById('activo-vida-util').value),
    }),
  })
);

conectarFormulario('form-cuenta', () =>
  api('/tesoreria/cuentas', {
    method: 'POST',
    body: JSON.stringify({
      banco: document.getElementById('cuenta-banco').value,
      numero: document.getElementById('cuenta-numero').value,
    }),
  })
);

conectarFormulario('form-movimiento', () =>
  api('/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      cuentaBancariaId: document.getElementById('movimiento-cuenta').value,
      tipo: document.getElementById('movimiento-tipo').value,
      valor: Number(document.getElementById('movimiento-valor').value),
      descripcion: document.getElementById('movimiento-descripcion').value || undefined,
    }),
  })
);

// --- BOTÓN GENERAL: correr depreciación del mes ---
document.getElementById('btn-depreciar').addEventListener('click', async () => {
  if (!confirm('¿Correr la depreciación mensual de todos los activos fijos activos?')) return;
  await accion('/activos-fijos/depreciar', { method: 'POST' });
});

// --- ACCIONES POR FILA (delegación de eventos sobre todo el tablero) ---
document.getElementById('vista-dashboard').addEventListener('click', async (e) => {
  const boton = e.target.closest('.btn-accion');
  if (!boton) return;

  const { accion: tipoAccion, id } = boton.dataset;

  switch (tipoAccion) {
    case 'editar-tercero':
      return abrirEdicionTercero(id);

    case 'enviar-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/enviar`, { method: 'PATCH' });
    case 'aceptar-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/aceptar`, { method: 'PATCH' });
    case 'rechazar-cotizacion':
      if (confirm('¿Rechazar esta cotización?')) return accion(`/ventas/cotizaciones/${id}/rechazar`, { method: 'PATCH' });
      return;
    case 'convertir-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/convertir`, { method: 'POST' });

    case 'aprobar-orden':
      return accion(`/compras/ordenes/${id}/aprobar`, { method: 'PATCH' });
    case 'convertir-orden':
      return accion(`/compras/ordenes/${id}/convertir`, { method: 'POST' });

    case 'agregar-empleado':
      return agregarEmpleadoAPeriodo(id);
    case 'liquidar-periodo':
      if (confirm('¿Liquidar este periodo? Se emitirá el documento soporte de cada empleado agregado.'))
        return accion(`/nomina/periodos/${id}/liquidar`, { method: 'POST' });
      return;

    case 'entrada-inventario':
      return movimientoInventario('entradas', id, true);
    case 'salida-inventario':
      return movimientoInventario('salidas', id, false);
    case 'ajuste-inventario':
      return movimientoInventario('ajustes', id, false, true);

    case 'baja-activo':
      if (confirm('¿Dar de baja este activo? Esta acción queda pendiente de revisión del contador.'))
        return accion(`/activos-fijos/${id}/baja`, { method: 'POST' });
      return;

    case 'conciliar-movimiento':
      return accion(`/tesoreria/movimientos/${id}/conciliar`, { method: 'POST' });
  }
});

// Prompts sencillos para acciones que necesitan un dato adicional puntual.
// Es deliberadamente básico — reemplazar por un formulario modal real
// queda como mejora pendiente, ver README.

async function agregarEmpleadoAPeriodo(periodoId) {
  const empleados = listaTerceros.filter((t) => t.tipo === 'empleado');
  if (empleados.length === 0) {
    alert('Primero crea un tercero de tipo "empleado" en la pestaña Terceros.');
    return;
  }
  const opciones = empleados.map((e, i) => `${i + 1}. ${e.nombre}`).join('\n');
  const seleccion = prompt(`¿Qué empleado? Escribe el número:\n${opciones}`);
  const empleado = empleados[Number(seleccion) - 1];
  if (!empleado) return;

  const devengado = prompt(`Devengado de ${empleado.nombre} ($):`);
  if (!devengado) return;
  const deducciones = prompt('Deducciones ($) — Enter para 0:') || '0';

  await accion(`/nomina/periodos/${periodoId}/empleados`, {
    method: 'POST',
    body: JSON.stringify({ empleadoId: empleado.id, devengado: Number(devengado), deducciones: Number(deducciones) }),
  });
}

async function movimientoInventario(tipo, productoId, pideCosto, pideObservacion) {
  const cantidad = prompt('Cantidad:');
  if (!cantidad) return;

  const body = { productoId, cantidad: Number(cantidad) };

  if (pideCosto) {
    const costo = prompt('Costo unitario ($):');
    if (!costo) return;
    body.costoUnitario = Number(costo);
  }

  if (pideObservacion) {
    body.observacion = prompt('Motivo del ajuste:') || '';
  }

  await accion(`/inventarios/${tipo}`, { method: 'POST', body: JSON.stringify(body) });
}

// --- INICIO ---
if (token && usuario) {
  mostrarDashboard();
}
SCRIPTEOF
echo "OK  public/contable/app.js"

cat > README.md << 'SCRIPTEOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
PostgreSQL en Supabase).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Página institucional de Libaniel Consulting (raíz del dominio)
├── style.css                  Estilos del sitio institucional
└── contable/                  El software contable en sí, en /contable
    ├── index.html                Login + tablero con pestañas por módulo
    ├── style.css                 Estética de libro contable (IBM Plex, reglas horizontales)
    └── app.js                    Login, consumo de la API, formularios y acciones por rol
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa, Tercero (persona natural/jurídica,
│   │                           ubicación, régimen y responsabilidades DIAN,
│   │                           cuenta bancaria), PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario, Usuario, LogAuditoria
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       ├── cierrePeriodo.js    Máquina de estados del cierre mensual
│       ├── authService.js      Login y registro de usuarios
│       ├── auditoria.js        Registro de acciones sensibles
│       ├── seedService.js      Datos base: empresa, periodo, cuentas, reglas
│       └── consecutivos.js     Numeración legible tipo COT-2026-0001 / ODA-2026-0001
├── modules/                  # Módulos operativos (capa transaccional) — TODOS completos
│   ├── ventas/                 Cotización → factura, patrón de referencia
│   ├── compras/                Factura recibida + documento soporte, orden de compra
│   ├── nomina/                 Periodo → empleados → liquidar → documento soporte
│   ├── inventarios/            Kardex simplificado: entradas, salidas, ajustes
│   ├── activosFijos/           Registro, depreciación mensual (cron), baja
│   └── tesoreria/               Cuentas bancarias, movimientos, conciliación
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
│   ├── depreciacionMensual.js  Implementado — recorre todas las empresas
│   └── vencimientoCotizaciones.js
├── middleware/                # authenticate + authorize por rol
└── routes/                   # Router raíz (auth, seed, terceros, y los 6 módulos)
```

## Aprovisionar una empresa nueva

Desde la pantalla de login, "¿Primera vez? Crear empresa y usuario" abre
un flujo de dos pasos: `POST /api/empresas` crea la empresa, luego
`POST /api/auth/registro` crea su primer usuario (rol `contador` o
`dueño` recomendado). Ambos endpoints quedan abiertos por ahora — ver
el TODO en `src/routes/empresas.routes.js` antes de tener más de un
puñado de empresas reales.

Al iniciar sesión, el panel **Inicio** (pestaña por defecto, ya no
Terceros) saluda por nombre, muestra la razón social de la empresa, y
presenta los nueve módulos como tarjetas — clic en cualquiera navega
directo a esa sección.

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).

La raíz del dominio (`/`) es la página institucional de **Libaniel
Consulting**, pensada para ofrecer varios servicios de la firma — hoy
solo el software contable es real, los otros dos son marcadores de
posición con un `mailto:` genérico (`contacto@libanielconsulting.com`)
hasta que se definan de verdad.

El software contable en sí vive en **`/contable`** — mismo backend,
solo un subdirectorio distinto en `public/`. Cubre creación y las
transiciones de estado principales de los seis módulos (formularios
inline + botones de acción por fila según el estado del registro). Dos
simplificaciones deliberadas por ahora:
acciones que piden un solo dato adicional puntual (agregar empleado a
un periodo, entradas/salidas/ajustes de inventario) usan `prompt()` del
navegador en vez de un formulario modal propio; y no hay edición ni
borrado de nada, solo creación y transiciones hacia adelante.

## Principios de diseño (no romper esto)

1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa y resuelve solo el periodo
   contable vigente si no se le pasa explícito.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).
6. **Un movimiento bancario sin conciliar bloquea el cierre del periodo**
   (ver `cierrePeriodo.validarPeriodo`).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de la base de datos y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Sitios web → Apps Node.js → conectar el repositorio de GitHub.
2. Base de datos: PostgreSQL vía Supabase (host, puerto, nombre, usuario y
   contraseña como `DB_*` en las variables de entorno de la app).
3. hPanel → Avanzado → Cron Jobs → programar:
   - `node src/jobs/depreciacionMensual.js` — día 1 de cada mes
   - `node src/jobs/vencimientoCotizaciones.js` — diario

## Roles y autenticación

Cuatro roles, controlados por `src/middleware/auth.js` (`authenticate` +
`authorize(...roles)`):

| Rol | Puede |
|---|---|
| `dueño` | Operar el sistema, certificar el cierre mensual |
| `contador` | Todo lo anterior + reabrir un periodo certificado |
| `auxiliar` | Registrar operaciones del día a día (ventas, compras, nómina) |
| `revisor` | Solo lectura (pendiente de aplicar en cada ruta) |

`POST /api/auth/login` y `POST /api/auth/registro` son las únicas rutas
públicas. Todas las demás requieren `Authorization: Bearer <token>`.

## Datos base (seed)

`POST /api/seed` (requiere sesión con rol `contador` o `dueño`) crea:
una empresa de prueba, el periodo contable del mes en curso, un plan de
cuentas de 22 cuentas, y 13 reglas de contabilización — una por cada
evento que disparan los seis módulos operativos. Seguro de correr más
de una vez — no duplica nada. Sin esto, `motorAsientos` no tiene con
qué contabilizar.

## Pendientes inmediatos

- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] Migraciones de Sequelize (`sequelize-cli`) para las tablas ya modeladas
- [ ] Reemplazar `FACTOR_PRESTACIONES` (21.83% fijo) en `nomina.service.js` por el cálculo exacto de cesantías, intereses, prima y vacaciones según la normativa laboral vigente y el tipo de contrato
- [ ] Integrar `NovedadNomina` con el cálculo del devengado (hoy es solo un registro informativo, no ajusta nada automáticamente)
- [ ] Tesorería: cruzar movimientos de tipo ingreso/egreso contra la factura, orden o nómina específica que pagan (hoy solo "comisión" se contabiliza sola al conciliar; el resto solo queda marcado como conciliado, sin generar el asiento de pago)
- [ ] Mapear cada `CuentaBancaria` a su propia subcuenta contable — hoy todas comparten el código 1110 Bancos
- [ ] Soportar múltiples líneas (débito/crédito) por evento en `motorAsientos` — hoy una venta no discrimina el IVA en un renglón aparte
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `DELETE` de terceros (crear, listar y editar ya existen; falta borrar)
- [ ] Vincular `MovimientoInventario` con los ítems reales de `FacturaVenta`/`FacturaCompra` — hoy las entradas y salidas se registran manualmente por API, no automático desde una venta
- [ ] Cuadre global de débitos vs. créditos del periodo como validación bloqueante del cierre (ver TODO en `cierrePeriodo.validarPeriodo`)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Reemplazar los `prompt()` del navegador (agregar empleado a nómina, entradas/salidas/ajustes de inventario) por formularios modales propios en el frontend; agregar edición/borrado en general
- [ ] Confirmar que `www.libanielconsulting.com` resuelve al mismo sitio que `libanielconsulting.com` (revisar en hPanel → Dominios, o agregar la redirección si falta)
- [ ] Definir de verdad los servicios 02 y 03 de la página institucional (`public/index.html`) y reemplazar el `mailto:contacto@libanielconsulting.com` por el correo real de la firma
- [ ] **Fase 2 — ítems de cotización/orden en el frontend**: tabla dinámica para agregar renglones (concepto, cantidad, UM con lista desplegable, valor unitario, IVA) en vez del campo de total a mano; el backend ya soporta `items[]` en `POST /ventas/cotizaciones` y `POST /compras/ordenes`, ver `CotizacionItem`/`OrdenCompraItem`
- [ ] **Fase 3 — plantilla imprimible/PDF** de cotización y orden de adquisición, replicando el formato real de la firma (membrete, datos del cliente/proveedor, ítems, AIU cuando aplique, firmas)
- [ ] Validar con un caso real si el IVA de una cotización con AIU debe calcularse sobre (subtotal + AIU) como quedó programado, o de otra forma según el tipo de contrato — ver la nota en `crearCotizacion` (`ventas.service.js`)
- [ ] `GET` de detalle con ítems para cotización y orden (hoy el listado no trae los renglones, solo la cabecera) — necesario para la Fase 2 y 3
- [ ] Usar `Tercero.responsabilidadesFiscales` y `tipoPersona` para automatizar el cálculo de retención en la fuente (formulario 350) — hoy son solo datos capturados, no alimentan ningún cálculo todavía
- [ ] Consecutivos (`generarConsecutivo`): reemplazar el conteo simple por una tabla de secuencias con bloqueo transaccional antes de tener varios usuarios creando documentos al mismo tiempo
SCRIPTEOF
echo "OK  README.md"

echo ""
echo "Listo. Edicion de terceros habilitada, y el bug de campos faltantes en crear corregido."
echo "  git add ."
echo "  git commit -m \"Agregar edicion de terceros y corregir campos faltantes al crear\""
echo "  git push"
