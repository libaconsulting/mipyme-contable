#!/bin/bash
# Ejecutar DESDE DENTRO de la carpeta mipyme-contable.
set -e

if [ ! -f "package.json" ]; then
  echo "ERROR: no se encontró package.json en esta carpeta."
  echo "Ve primero a la carpeta mipyme-contable (cd mipyme-contable) y vuelve a correr este script."
  exit 1
fi

mkdir -p public

cat > public/index.html << 'SCRIPTEOF'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mipyme Contable</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body>

<div id="vista-login" class="pantalla-login">
  <div class="tarjeta-login">
    <h1 class="wordmark">Mipyme Contable</h1>
    <p class="subtitulo">Sistema contable para microempresas — NIIF Grupo 3</p>
    <form id="form-login">
      <label>Correo
        <input type="email" id="login-email" required autocomplete="username">
      </label>
      <label>Contraseña
        <input type="password" id="login-password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn-primario">Entrar</button>
      <p id="login-error" class="mensaje-error" hidden></p>
    </form>
  </div>
</div>

<div id="vista-dashboard" class="app" hidden>
  <aside class="barra-lateral">
    <h1 class="wordmark">Mipyme Contable</h1>
    <nav>
      <button class="nav-item activo" data-tab="terceros">Terceros</button>
      <button class="nav-item" data-tab="cotizaciones">Cotizaciones</button>
      <button class="nav-item" data-tab="facturas-venta">Facturas de venta</button>
      <button class="nav-item" data-tab="ordenes">Órdenes de compra</button>
      <button class="nav-item" data-tab="facturas-compra">Facturas de compra</button>
      <button class="nav-item" data-tab="nomina">Nómina</button>
    </nav>
    <div class="usuario-actual">
      <p id="usuario-nombre"></p>
      <p id="usuario-rol" class="rol"></p>
      <button id="btn-salir">Cerrar sesión</button>
    </div>
  </aside>

  <main class="contenido">
    <section id="panel-terceros" class="panel">
      <header class="panel-header">
        <h2>Terceros</h2>
        <button class="btn-primario" id="btn-nuevo-tercero">+ Nuevo tercero</button>
      </header>
      <form id="form-tercero" class="form-inline" hidden>
        <select id="tercero-tipo" required>
          <option value="cliente">Cliente</option>
          <option value="proveedor">Proveedor</option>
          <option value="empleado">Empleado</option>
          <option value="otro">Otro</option>
        </select>
        <input type="text" id="tercero-identificacion" placeholder="Identificación" required>
        <input type="text" id="tercero-nombre" placeholder="Nombre" required>
        <input type="email" id="tercero-email" placeholder="Correo (opcional)">
        <button type="submit" class="btn-primario">Guardar</button>
        <button type="button" class="btn-secundario" id="btn-cancelar-tercero">Cancelar</button>
      </form>
      <div class="tabla-envoltorio">
        <table id="tabla-terceros"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-cotizaciones" class="panel" hidden>
      <header class="panel-header"><h2>Cotizaciones</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-cotizaciones"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-venta" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de venta</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-venta"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-ordenes" class="panel" hidden>
      <header class="panel-header"><h2>Órdenes de compra</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-ordenes"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-facturas-compra" class="panel" hidden>
      <header class="panel-header"><h2>Facturas de compra</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-facturas-compra"><thead></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="panel-nomina" class="panel" hidden>
      <header class="panel-header"><h2>Nómina</h2></header>
      <div class="tabla-envoltorio">
        <table id="tabla-nomina"><thead></thead><tbody></tbody></table>
      </div>
    </section>
  </main>
</div>

<script src="/app.js"></script>
</body>
</html>
SCRIPTEOF
echo "OK  public/index.html"

cat > public/style.css << 'SCRIPTEOF'
:root {
  --paper: #F6F8F4;
  --surface: #FFFFFF;
  --ink: #1C2A24;
  --ink-soft: #56655C;
  --rule: #CBD6CE;
  --rule-strong: #9FAFA4;
  --accent: #2F6B4F;
  --accent-hover: #275940;
  --accent-ink: #FFFFFF;
  --danger: #A6432E;
  --warn: #B8863A;
  --font-serif: 'IBM Plex Serif', Georgia, serif;
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'IBM Plex Mono', 'Courier New', monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--ink);
  background: var(--paper);
}

.wordmark {
  font-family: var(--font-serif);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}

button { font-family: var(--font-sans); cursor: pointer; }

.btn-primario {
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
}
.btn-primario:hover { background: var(--accent-hover); }

.btn-secundario {
  background: transparent;
  color: var(--ink-soft);
  border: 1px solid var(--rule-strong);
  padding: 10px 18px;
  font-size: 14px;
}

/* LOGIN */
.pantalla-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.tarjeta-login {
  width: 100%;
  max-width: 360px;
  background: var(--surface);
  border-top: 3px solid var(--accent);
  padding: 40px 32px;
}

.tarjeta-login .wordmark { font-size: 22px; margin-bottom: 4px; }

.subtitulo {
  color: var(--ink-soft);
  font-size: 13px;
  margin: 0 0 28px;
  line-height: 1.5;
}

#form-login label {
  display: block;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 16px;
}

#form-login input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  font-family: var(--font-sans);
  font-size: 14px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--ink);
}

#form-login input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

#form-login .btn-primario {
  width: 100%;
  padding: 12px;
  margin-top: 8px;
}

.mensaje-error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 12px;
}

/* APP SHELL */
.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.barra-lateral {
  background: var(--surface);
  border-right: 1px solid var(--rule);
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
}

.barra-lateral .wordmark { font-size: 17px; margin-bottom: 28px; }

.barra-lateral nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding: 9px 10px;
  font-size: 14px;
  color: var(--ink-soft);
}

.nav-item:hover { color: var(--ink); background: var(--paper); }

.nav-item.activo {
  color: var(--ink);
  border-left-color: var(--accent);
  background: var(--paper);
  font-weight: 500;
}

.usuario-actual {
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-top: 16px;
}

.usuario-actual p { margin: 0; font-size: 13px; }
.usuario-actual .rol {
  color: var(--ink-soft);
  text-transform: capitalize;
  margin-bottom: 10px;
}

#btn-salir {
  background: none;
  border: none;
  color: var(--ink-soft);
  font-size: 13px;
  padding: 0;
  text-decoration: underline;
}

.contenido { padding: 32px 40px; max-width: 1000px; }

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}

.panel-header h2 {
  font-family: var(--font-serif);
  font-weight: 600;
  font-size: 24px;
  margin: 0;
}

.form-inline {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: 16px;
  margin-bottom: 20px;
}

.form-inline input, .form-inline select {
  padding: 8px 10px;
  border: 1px solid var(--rule-strong);
  font-family: var(--font-sans);
  font-size: 14px;
  background: var(--paper);
}

/* TABLAS: estilo libro contable — solo reglas horizontales */
.tabla-envoltorio {
  background: var(--surface);
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

thead th {
  text-align: left;
  font-weight: 500;
  color: var(--ink-soft);
  font-size: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--rule-strong);
  white-space: nowrap;
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}

tbody tr:last-child td { border-bottom: none; }

td.num, th.num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  text-transform: capitalize;
}
.badge.aceptada, .badge.aceptado, .badge.contabilizado, .badge.liquidada, .badge.aprobada { border-color: var(--accent); color: var(--accent); }
.badge.rechazada, .badge.rechazado, .badge.objetada { border-color: var(--danger); color: var(--danger); }
.badge.pendiente, .badge.borrador, .badge.enviada, .badge.enviado { border-color: var(--warn); color: var(--warn); }

.vacio {
  padding: 32px 16px;
  color: var(--ink-soft);
  font-size: 14px;
  text-align: center;
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .barra-lateral {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
  .barra-lateral nav { flex-direction: row; flex-wrap: wrap; }
  .contenido { padding: 20px; }
}
SCRIPTEOF
echo "OK  public/style.css"

cat > public/app.js << 'SCRIPTEOF'
const API = '/api';

let token = localStorage.getItem('token');
let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
let mapaTerceros = {};

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

// --- LOGIN ---
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;

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

// --- DASHBOARD SHELL ---
function mostrarDashboard() {
  vistaLogin.hidden = true;
  vistaDashboard.hidden = false;
  document.getElementById('usuario-nombre').textContent = usuario.nombre;
  document.getElementById('usuario-rol').textContent = usuario.rol;
  cargarTodo();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activo'));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
    btn.classList.add('activo');
    document.getElementById('panel-' + btn.dataset.tab).hidden = false;
  });
});

// --- CARGA DE DATOS ---
async function cargarTodo() {
  try {
    const terceros = await api('/terceros');
    mapaTerceros = Object.fromEntries(terceros.map((t) => [t.id, t.nombre]));
    renderTerceros(terceros);

    const [cotizaciones, facturasVenta, ordenes, facturasCompra, periodos] = await Promise.all([
      api('/ventas/cotizaciones'),
      api('/ventas/facturas'),
      api('/compras/ordenes'),
      api('/compras/facturas'),
      api('/nomina/periodos'),
    ]);

    renderCotizaciones(cotizaciones);
    renderFacturasVenta(facturasVenta);
    renderOrdenes(ordenes);
    renderFacturasCompra(facturasCompra);
    renderNomina(periodos);
  } catch (err) {
    console.error(err);
  }
}

function renderTerceros(lista) {
  document.querySelector('#tabla-terceros thead').innerHTML =
    '<tr><th>Nombre</th><th>Tipo</th><th>Identificación</th><th>Correo</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-terceros', 4, 'Todavía no hay terceros. Crea el primero arriba.');
  document.querySelector('#tabla-terceros tbody').innerHTML = lista
    .map(
      (t) =>
        `<tr><td>${t.nombre}</td><td>${t.tipo}</td><td>${t.identificacion}</td><td>${t.email || '—'}</td></tr>`
    )
    .join('');
}

function renderCotizaciones(lista) {
  document.querySelector('#tabla-cotizaciones thead').innerHTML =
    '<tr><th>Fecha</th><th>Cliente</th><th>Estado</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cotizaciones', 4, 'Todavía no hay cotizaciones.');
  document.querySelector('#tabla-cotizaciones tbody').innerHTML = lista
    .map(
      (c) =>
        `<tr><td>${formatoFecha(c.fecha)}</td><td>${nombreTercero(c.terceroId)}</td><td>${badge(
          c.estado
        )}</td><td class="num">${formatoDinero(c.total)}</td></tr>`
    )
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

function renderOrdenes(lista) {
  document.querySelector('#tabla-ordenes thead').innerHTML =
    '<tr><th>Fecha</th><th>Proveedor</th><th>Tipo</th><th>Estado</th><th class="num">Total</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-ordenes', 5, 'Todavía no hay órdenes de compra.');
  document.querySelector('#tabla-ordenes tbody').innerHTML = lista
    .map(
      (o) =>
        `<tr><td>${formatoFecha(o.fecha)}</td><td>${nombreTercero(o.terceroId)}</td><td>${o.tipo}</td><td>${badge(
          o.estado
        )}</td><td class="num">${formatoDinero(o.total)}</td></tr>`
    )
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

function renderNomina(lista) {
  document.querySelector('#tabla-nomina thead').innerHTML = '<tr><th>Periodo</th><th>Estado</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-nomina', 2, 'Todavía no hay periodos de nómina.');
  document.querySelector('#tabla-nomina tbody').innerHTML = lista
    .map(
      (p) =>
        `<tr><td>${formatoFecha(p.fechaInicio)} — ${formatoFecha(p.fechaFin)}</td><td>${badge(p.estado)}</td></tr>`
    )
    .join('');
}

// --- CREAR TERCERO ---
const formTercero = document.getElementById('form-tercero');

document.getElementById('btn-nuevo-tercero').addEventListener('click', () => {
  formTercero.hidden = !formTercero.hidden;
});

document.getElementById('btn-cancelar-tercero').addEventListener('click', () => {
  formTercero.hidden = true;
  formTercero.reset();
});

formTercero.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/terceros', {
      method: 'POST',
      body: JSON.stringify({
        tipo: document.getElementById('tercero-tipo').value,
        identificacion: document.getElementById('tercero-identificacion').value,
        nombre: document.getElementById('tercero-nombre').value,
        email: document.getElementById('tercero-email').value || undefined,
      }),
    });
    formTercero.reset();
    formTercero.hidden = true;
    cargarTodo();
  } catch (err) {
    alert(err.message);
  }
});

// --- INICIO ---
if (token && usuario) {
  mostrarDashboard();
}
SCRIPTEOF
echo "OK  public/app.js"

cat > src/server.js << 'SCRIPTEOF'
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const sequelize = require('./config/database');
require('./core/models'); // registra todos los modelos antes de sync()
const routes = require('./routes');
const webhooksFacturacion = require('./integrations/webhooks/proveedorTecnologicoWebhook');

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', routes);
app.use('/webhooks', webhooksFacturacion);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;

async function iniciar() {
  try {
    await sequelize.authenticate();
    console.log('Conexión a la base de datos establecida.');

    // En desarrollo, sincroniza el esquema. En producción usar migraciones
    // (npm run migrate) en vez de sync({ alter: true }).
    if (process.env.NODE_ENV === 'development') {
      await sequelize.sync({ alter: true });
    }

    app.listen(PORT, () => {
      console.log(`Servidor corriendo en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('No se pudo iniciar el servidor:', error);
    process.exit(1);
  }
}

iniciar();

module.exports = app;
SCRIPTEOF
echo "OK  src/server.js"

cat > src/modules/ventas/services/ventas.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const Cotizacion = require('../models/Cotizacion');
const FacturaVenta = require('../models/FacturaVenta');
const facturacionAdapter = require('../../../integrations/adapters/facturacionAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Crea una cotización nueva en estado "borrador".
async function crearCotizacion(datos, usuario) {
  const cotizacion = await Cotizacion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    vendedorId: usuario.id,
    fecha: datos.fecha || new Date(),
    fechaVencimiento: datos.fechaVencimiento,
    estado: 'borrador',
    total: datos.total,
  });
  return cotizacion;
}

// borrador -> enviada
async function enviarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'borrador') {
    throw new Error('Solo se puede enviar una cotización en estado "borrador".');
  }
  await cotizacion.update({ estado: 'enviada' });
  return cotizacion;
}

// enviada -> aceptada
async function aceptarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'enviada') {
    throw new Error('Solo se puede aceptar una cotización en estado "enviada".');
  }
  await cotizacion.update({ estado: 'aceptada' });
  return cotizacion;
}

// enviada -> rechazada
async function rechazarCotizacion(id) {
  const cotizacion = await Cotizacion.findByPk(id);
  if (cotizacion.estado !== 'enviada') {
    throw new Error('Solo se puede rechazar una cotización en estado "enviada".');
  }
  await cotizacion.update({ estado: 'rechazada' });
  return cotizacion;
}

async function listarCotizaciones(usuario) {
  return Cotizacion.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

async function listarFacturas(usuario) {
  return FacturaVenta.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Copia los renglones de la cotización aceptada a una factura nueva,
// deja el vínculo de trazabilidad y marca la cotización como facturada.
async function convertirCotizacionEnFactura(cotizacionId, usuarioId) {
  const cotizacion = await Cotizacion.findByPk(cotizacionId);

  if (cotizacion.estado !== 'aceptada') {
    throw new Error('Solo se puede facturar una cotización en estado "aceptada".');
  }

  const factura = await FacturaVenta.create({
    id: uuidv4(),
    empresaId: cotizacion.empresaId,
    terceroId: cotizacion.terceroId,
    cotizacionOrigenId: cotizacion.id,
    fecha: new Date(),
    subtotal: cotizacion.total, // TODO: recalcular desde los ítems reales
    total: cotizacion.total,
    estadoSincronizacion: 'pendiente',
  });

  // TODO: copiar CotizacionItem -> FacturaVentaItem

  await cotizacion.update({ estado: 'facturada' });

  await emitirFacturaAnteProveedor(factura);

  return factura;
}

// Envía la factura al proveedor tecnológico acreditado; el motor de
// asientos solo se dispara cuando llega la confirmación (ver webhook).
async function emitirFacturaAnteProveedor(factura) {
  const respuesta = await facturacionAdapter.emitirFactura(factura);
  await factura.update({
    idTransaccionExterna: respuesta.idTransaccionExterna,
    estadoSincronizacion: 'enviado',
  });
  return respuesta;
}

// Llamado desde el webhook cuando el proveedor confirma "aceptada".
async function confirmarFacturaAceptada(facturaId, datosProveedor) {
  const factura = await FacturaVenta.findByPk(facturaId);

  await factura.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
    pdfUrl: datosProveedor.pdfUrl,
  });

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: 'factura_venta_credito', // o 'factura_venta_contado' según forma de pago
    origenModulo: 'ventas',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
  });

  return factura;
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  listarCotizaciones,
  listarFacturas,
  convertirCotizacionEnFactura,
  confirmarFacturaAceptada,
};
SCRIPTEOF
echo "OK  src/modules/ventas/services/ventas.service.js"

cat > src/modules/ventas/controllers/ventas.controller.js << 'SCRIPTEOF'
const ventasService = require('../services/ventas.service');

async function crearCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.crearCotizacion(req.body, req.usuario);
    res.status(201).json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function enviarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.enviarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function aceptarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.aceptarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function rechazarCotizacion(req, res) {
  try {
    const cotizacion = await ventasService.rechazarCotizacion(req.params.id);
    res.json(cotizacion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function convertirCotizacion(req, res) {
  try {
    const factura = await ventasService.convertirCotizacionEnFactura(
      req.params.cotizacionId,
      req.usuario?.id
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarCotizaciones(req, res) {
  try {
    const cotizaciones = await ventasService.listarCotizaciones(req.usuario);
    res.json(cotizaciones);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarFacturas(req, res) {
  try {
    const facturas = await ventasService.listarFacturas(req.usuario);
    res.json(facturas);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = {
  crearCotizacion,
  enviarCotizacion,
  aceptarCotizacion,
  rechazarCotizacion,
  convertirCotizacion,
  listarCotizaciones,
  listarFacturas,
};
SCRIPTEOF
echo "OK  src/modules/ventas/controllers/ventas.controller.js"

cat > src/modules/ventas/routes/ventas.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const ventasController = require('../controllers/ventas.controller');

// GET /api/ventas/cotizaciones
router.get('/cotizaciones', ventasController.listarCotizaciones);

// GET /api/ventas/facturas
router.get('/facturas', ventasController.listarFacturas);

// POST /api/ventas/cotizaciones
router.post('/cotizaciones', ventasController.crearCotizacion);

// PATCH /api/ventas/cotizaciones/:id/enviar
router.patch('/cotizaciones/:id/enviar', ventasController.enviarCotizacion);

// PATCH /api/ventas/cotizaciones/:id/aceptar
router.patch('/cotizaciones/:id/aceptar', ventasController.aceptarCotizacion);

// PATCH /api/ventas/cotizaciones/:id/rechazar
router.patch('/cotizaciones/:id/rechazar', ventasController.rechazarCotizacion);

// POST /api/ventas/cotizaciones/:cotizacionId/convertir
router.post('/cotizaciones/:cotizacionId/convertir', ventasController.convertirCotizacion);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/ventas/routes/ventas.routes.js"

cat > src/modules/compras/services/compras.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const OrdenCompra = require('../models/OrdenCompra');
const FacturaCompra = require('../models/FacturaCompra');
const DocumentoSoporteAdquisicion = require('../models/DocumentoSoporteAdquisicion');
const documentoSoporteAdapter = require('../../../integrations/adapters/documentoSoporteAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Crea una orden de compra/servicio nueva en estado "borrador".
async function crearOrden(datos, usuario) {
  const orden = await OrdenCompra.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    tipo: datos.tipo || 'bienes',
    fecha: datos.fecha || new Date(),
    fechaRequerida: datos.fechaRequerida,
    estado: 'borrador',
    subtotal: datos.subtotal,
    iva: datos.iva || 0,
    total: datos.total,
  });
  return orden;
}

// borrador/emitida -> aprobada (aprobador interno, no el proveedor)
async function aprobarOrden(id, usuario) {
  const orden = await OrdenCompra.findByPk(id);
  if (!['borrador', 'emitida'].includes(orden.estado)) {
    throw new Error('Solo se puede aprobar una orden en estado "borrador" o "emitida".');
  }
  await orden.update({ estado: 'aprobada', aprobadorId: usuario.id });
  return orden;
}

async function listarOrdenes(usuario) {
  return OrdenCompra.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

async function listarFacturas(usuario) {
  return FacturaCompra.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fecha', 'DESC']],
  });
}

// Cierra manualmente una orden aprobada/recibida contra una factura que
// el usuario ya tiene en mano. Con orden de compra de por medio, el
// nivel de automatización es más alto (ver tabla de reglas del módulo).
async function convertirOrdenEnFactura(ordenId, usuario) {
  const orden = await OrdenCompra.findByPk(ordenId);

  if (!['aprobada', 'recibida_parcial', 'recibida_total'].includes(orden.estado)) {
    throw new Error('La orden debe estar aprobada o recibida para facturarse.');
  }

  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: orden.empresaId,
    terceroId: orden.terceroId,
    ordenCompraOrigenId: orden.id,
    fecha: new Date(),
    subtotal: orden.subtotal,
    iva: orden.iva,
    total: orden.total,
  });

  await orden.update({ estado: 'facturada' });

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: 'factura_compra_con_orden',
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
    usuarioId: usuario?.id,
  });

  return factura;
}

// Llamado desde el webhook cuando un proveedor que sí factura
// electrónicamente emite una factura a nuestro nombre y llega vía
// RADIAN o el proveedor tecnológico. Ya viene validada ante la DIAN,
// así que se contabiliza directo (sin pasar por estado "borrador").
//
// TODO: la mecánica exacta para RECIBIR facturas vía RADIAN (o si el
// proveedor tecnológico contratado lo resuelve por su cuenta y solo nos
// avisa por webhook) todavía hay que investigarla con el proveedor
// específico que se contrate — no está 100% definida.
async function registrarFacturaRecibida(datos) {
  const factura = await FacturaCompra.create({
    id: uuidv4(),
    empresaId: datos.empresaId,
    terceroId: datos.terceroId,
    ordenCompraOrigenId: datos.ordenCompraOrigenId || null,
    fecha: datos.fecha || new Date(),
    subtotal: datos.subtotal,
    iva: datos.iva || 0,
    total: datos.total,
    cufe: datos.cufe,
    xmlUrl: datos.xmlUrl,
    estadoConciliacion: 'contabilizada',
  });

  // Sin orden de compra de por medio, nivel de automatización más bajo
  // (nivel 2: exige clasificar costo vs. gasto — ver tabla de reglas).
  const evento = factura.ordenCompraOrigenId
    ? 'factura_compra_con_orden'
    : 'factura_compra_sin_orden';

  await contabilizarEvento({
    empresaId: factura.empresaId,
    tipoEvento: evento,
    origenModulo: 'compras',
    origenId: factura.id,
    valor: factura.total,
    terceroId: factura.terceroId,
  });

  return factura;
}

// El documento soporte lo EMITE el propio comprador (nuestro cliente),
// porque el proveedor no está obligado a facturar. Flujo simétrico al
// de ventas: se envía al proveedor tecnológico y solo se contabiliza
// cuando confirma (ver confirmarDocumentoSoporteEmitido).
async function emitirDocumentoSoporte(datos, usuario) {
  const documento = await DocumentoSoporteAdquisicion.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    terceroId: datos.terceroId,
    fecha: datos.fecha || new Date(),
    concepto: datos.concepto,
    valor: datos.valor,
    estadoSincronizacion: 'pendiente',
  });

  const respuesta = await documentoSoporteAdapter.emitirDocumentoSoporte(documento);

  await documento.update({
    idTransaccionExterna: respuesta.idTransaccionExterna,
    estadoSincronizacion: 'enviado',
  });

  return documento;
}

// Llamado desde el webhook cuando el proveedor tecnológico confirma que
// la DIAN validó nuestro documento soporte.
async function confirmarDocumentoSoporteEmitido(documentoId, datosProveedor) {
  const documento = await DocumentoSoporteAdquisicion.findByPk(documentoId);

  await documento.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
  });

  // La primera vez por proveedor exige clasificar la cuenta (nivel 2);
  // ver la regla 'documento_soporte_compra' y su memorización por tercero.
  await contabilizarEvento({
    empresaId: documento.empresaId,
    tipoEvento: 'documento_soporte_compra',
    origenModulo: 'compras',
    origenId: documento.id,
    valor: documento.valor,
    terceroId: documento.terceroId,
  });

  return documento;
}

module.exports = {
  crearOrden,
  aprobarOrden,
  listarOrdenes,
  listarFacturas,
  convertirOrdenEnFactura,
  registrarFacturaRecibida,
  emitirDocumentoSoporte,
  confirmarDocumentoSoporteEmitido,
};
SCRIPTEOF
echo "OK  src/modules/compras/services/compras.service.js"

cat > src/modules/compras/controllers/compras.controller.js << 'SCRIPTEOF'
const comprasService = require('../services/compras.service');

async function crearOrden(req, res) {
  try {
    const orden = await comprasService.crearOrden(req.body, req.usuario);
    res.status(201).json(orden);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function aprobarOrden(req, res) {
  try {
    const orden = await comprasService.aprobarOrden(req.params.id, req.usuario);
    res.json(orden);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function convertirOrden(req, res) {
  try {
    const factura = await comprasService.convertirOrdenEnFactura(
      req.params.ordenId,
      req.usuario
    );
    res.status(201).json(factura);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function emitirDocumentoSoporte(req, res) {
  try {
    const documento = await comprasService.emitirDocumentoSoporte(req.body, req.usuario);
    res.status(201).json(documento);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarOrdenes(req, res) {
  try {
    const ordenes = await comprasService.listarOrdenes(req.usuario);
    res.json(ordenes);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarFacturas(req, res) {
  try {
    const facturas = await comprasService.listarFacturas(req.usuario);
    res.json(facturas);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = {
  crearOrden,
  aprobarOrden,
  convertirOrden,
  emitirDocumentoSoporte,
  listarOrdenes,
  listarFacturas,
};
SCRIPTEOF
echo "OK  src/modules/compras/controllers/compras.controller.js"

cat > src/modules/compras/routes/compras.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const comprasController = require('../controllers/compras.controller');

// GET /api/compras/ordenes
router.get('/ordenes', comprasController.listarOrdenes);

// GET /api/compras/facturas
router.get('/facturas', comprasController.listarFacturas);

// POST /api/compras/ordenes
router.post('/ordenes', comprasController.crearOrden);

// PATCH /api/compras/ordenes/:id/aprobar
router.patch('/ordenes/:id/aprobar', comprasController.aprobarOrden);

// POST /api/compras/ordenes/:ordenId/convertir
router.post('/ordenes/:ordenId/convertir', comprasController.convertirOrden);

// POST /api/compras/documento-soporte
router.post('/documento-soporte', comprasController.emitirDocumentoSoporte);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/compras/routes/compras.routes.js"

cat > src/modules/nomina/services/nomina.service.js << 'SCRIPTEOF'
const { v4: uuidv4 } = require('uuid');
const PeriodoNomina = require('../models/PeriodoNomina');
const NominaEmpleado = require('../models/NominaEmpleado');
const NovedadNomina = require('../models/NovedadNomina');
const nominaAdapter = require('../../../integrations/adapters/nominaAdapter');
const { contabilizarEvento } = require('../../../core/services/motorAsientos');

// Factor simplificado de prestaciones sociales sobre el devengado
// (cesantías 8.33% + intereses cesantías 1% + prima 8.33% + vacaciones
// 4.17% ≈ 21.83%). Es una aproximación para el MVP — antes de usarse
// con datos reales hay que reemplazarla por el cálculo exacto según la
// normativa laboral vigente, que además varía según el tipo de contrato.
const FACTOR_PRESTACIONES = 0.2183;

async function crearPeriodoNomina(datos, usuario) {
  const periodo = await PeriodoNomina.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    fechaInicio: datos.fechaInicio,
    fechaFin: datos.fechaFin,
    estado: 'borrador',
  });
  return periodo;
}

async function agregarEmpleadoANomina(periodoNominaId, datos, usuario) {
  const devengado = Number(datos.devengado);
  const deducciones = Number(datos.deducciones || 0);

  const nomina = await NominaEmpleado.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    periodoNominaId,
    empleadoId: datos.empleadoId,
    devengado,
    deducciones,
    netoPagar: devengado - deducciones,
    estadoSincronizacion: 'pendiente',
  });
  return nomina;
}

// Cierra el periodo (ya no se pueden agregar más empleados) y emite el
// documento soporte de nómina de cada empleado ante el proveedor
// tecnológico. El motor de asientos se dispara solo cuando llega la
// confirmación de cada uno (ver confirmarNominaEmitida).
async function liquidarPeriodo(periodoNominaId, usuario) {
  const periodo = await PeriodoNomina.findByPk(periodoNominaId);

  if (periodo.estado !== 'borrador') {
    throw new Error('Solo se puede liquidar un periodo en estado "borrador".');
  }

  const registros = await NominaEmpleado.findAll({ where: { periodoNominaId } });

  if (registros.length === 0) {
    throw new Error('El periodo no tiene empleados agregados.');
  }

  for (const registro of registros) {
    const respuesta = await nominaAdapter.emitirNomina(registro);
    await registro.update({
      idTransaccionExterna: respuesta.idTransaccionExterna,
      estadoSincronizacion: 'enviado',
    });
  }

  await periodo.update({ estado: 'liquidada' });

  return periodo;
}

// Llamado desde el webhook cuando el proveedor confirma que la DIAN
// validó el documento soporte de nómina de un empleado específico.
// Contabiliza el devengado Y la provisión de prestaciones sociales del
// mismo empleado, en dos eventos separados.
async function confirmarNominaEmitida(nominaEmpleadoId, datosProveedor) {
  const registro = await NominaEmpleado.findByPk(nominaEmpleadoId);

  await registro.update({
    estadoSincronizacion: 'aceptado',
    cufe: datosProveedor.cufe,
    xmlUrl: datosProveedor.xmlUrl,
  });

  await contabilizarEvento({
    empresaId: registro.empresaId,
    tipoEvento: 'nomina_devengado',
    origenModulo: 'nomina',
    origenId: registro.id,
    valor: registro.devengado,
    terceroId: registro.empleadoId,
  });

  await contabilizarEvento({
    empresaId: registro.empresaId,
    tipoEvento: 'provision_prestaciones',
    origenModulo: 'nomina',
    origenId: registro.id,
    valor: Number(registro.devengado) * FACTOR_PRESTACIONES,
    terceroId: registro.empleadoId,
  });

  return registro;
}

async function registrarNovedad(datos, usuario) {
  const novedad = await NovedadNomina.create({
    id: uuidv4(),
    empresaId: usuario.empresaId,
    empleadoId: datos.empleadoId,
    tipo: datos.tipo,
    fechaInicio: datos.fechaInicio,
    fechaFin: datos.fechaFin,
    observacion: datos.observacion,
  });
  return novedad;
}

async function listarPeriodos(usuario) {
  return PeriodoNomina.findAll({
    where: { empresaId: usuario.empresaId },
    order: [['fechaInicio', 'DESC']],
  });
}

module.exports = {
  crearPeriodoNomina,
  agregarEmpleadoANomina,
  liquidarPeriodo,
  confirmarNominaEmitida,
  registrarNovedad,
  listarPeriodos,
};
SCRIPTEOF
echo "OK  src/modules/nomina/services/nomina.service.js"

cat > src/modules/nomina/controllers/nomina.controller.js << 'SCRIPTEOF'
const nominaService = require('../services/nomina.service');

async function crearPeriodo(req, res) {
  try {
    const periodo = await nominaService.crearPeriodoNomina(req.body, req.usuario);
    res.status(201).json(periodo);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function agregarEmpleado(req, res) {
  try {
    const nomina = await nominaService.agregarEmpleadoANomina(
      req.params.periodoId,
      req.body,
      req.usuario
    );
    res.status(201).json(nomina);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function liquidar(req, res) {
  try {
    const periodo = await nominaService.liquidarPeriodo(req.params.periodoId, req.usuario);
    res.json(periodo);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function crearNovedad(req, res) {
  try {
    const novedad = await nominaService.registrarNovedad(req.body, req.usuario);
    res.status(201).json(novedad);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

async function listarPeriodos(req, res) {
  try {
    const periodos = await nominaService.listarPeriodos(req.usuario);
    res.json(periodos);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

module.exports = { crearPeriodo, agregarEmpleado, liquidar, crearNovedad, listarPeriodos };
SCRIPTEOF
echo "OK  src/modules/nomina/controllers/nomina.controller.js"

cat > src/modules/nomina/routes/nomina.routes.js << 'SCRIPTEOF'
const express = require('express');
const router = express.Router();
const nominaController = require('../controllers/nomina.controller');

// GET /api/nomina/periodos
router.get('/periodos', nominaController.listarPeriodos);

// POST /api/nomina/periodos
router.post('/periodos', nominaController.crearPeriodo);

// POST /api/nomina/periodos/:periodoId/empleados
router.post('/periodos/:periodoId/empleados', nominaController.agregarEmpleado);

// POST /api/nomina/periodos/:periodoId/liquidar
router.post('/periodos/:periodoId/liquidar', nominaController.liquidar);

// POST /api/nomina/novedades
router.post('/novedades', nominaController.crearNovedad);

module.exports = router;
SCRIPTEOF
echo "OK  src/modules/nomina/routes/nomina.routes.js"

cat > README.md << 'SCRIPTEOF'
# mipyme-contable

Sistema contable para microempresas colombianas (NIIF Grupo 3), pensado
para desplegarse en Hostinger (plan Business — Node.js administrado +
MySQL/MariaDB).

## Arquitectura

```
public/                     # Frontend mínimo: HTML + JS plano, sin build step
├── index.html                 Login + tablero con pestañas por módulo
├── style.css                  Estética de libro contable (IBM Plex, reglas horizontales)
└── app.js                     Login, consumo de la API, formulario de terceros
src/
├── server.js                 # Punto de entrada — también sirve public/ como estáticos
├── config/                   # Conexión a base de datos, variables de entorno
├── core/                     # Núcleo contable — nunca depende de la infraestructura
│   ├── models/                 Empresa, Tercero, PlanCuentas, Asiento,
│   │                           Movimiento, PeriodoContable, ReglaContabilizacion,
│   │                           ParametroTributario
│   └── services/
│       ├── motorAsientos.js    Traduce eventos operativos en partida doble
│       └── cierrePeriodo.js    Máquina de estados del cierre mensual
├── modules/                  # Módulos operativos (capa transaccional)
│   ├── ventas/                 Completo — patrón de referencia
│   ├── compras/                Completo — mismo patrón que ventas
│   ├── inventarios/            Pendiente
│   ├── nomina/                 Completo — mismo patrón que ventas
│   ├── activosFijos/           Pendiente
│   └── tesoreria/              Pendiente
├── integrations/             # Capa adaptadora hacia proveedores acreditados
│   ├── adapters/                Interfaz única por tipo de documento
│   └── webhooks/                Recepción asíncrona de confirmaciones DIAN
├── jobs/                     # Disparados por Cron Jobs de hPanel
├── middleware/                # Auth, manejo de errores (pendiente)
└── routes/                   # Router raíz
```

## Frontend

`public/` es intencionalmente mínimo: sin framework, sin paso de
compilación, servido directo por el mismo Express (`express.static`).
Hoy es de **solo lectura** para la mayoría de módulos (tablas de
cotizaciones, facturas, órdenes, nómina) — el único formulario de
creación es el de terceros. El resto se sigue creando por API
(`curl` o Postman) hasta que se agreguen sus formularios.

## Principios de diseño (no romper esto)


1. **Ningún módulo operativo escribe asientos directamente.** Todo pasa
   por `motorAsientos.contabilizarEvento()`, que consulta la tabla
   `ReglaContabilizacion` de la empresa.
2. **Cotizaciones y órdenes de compra/servicio no generan asiento.**
   Solo lo hacen cuando se convierten en factura.
3. **Nunca hardcodear UVT, tarifas de retención, RST o ICA.** Viven en
   `ParametroTributario`, versionado por año gravable.
4. **La lógica del proveedor tecnológico de facturación/nómina/documento
   soporte vive únicamente en `src/integrations/adapters/`.** Cambiar de
   proveedor no debe tocar ningún módulo operativo.
5. **Un periodo `cerrado_certificado` es inmutable** salvo por el
   proceso formal de reapertura (rol Contador + justificación obligatoria).

## Puesta en marcha

```bash
cp .env.example .env      # completar credenciales de MySQL y del proveedor tecnológico
npm install
npm run dev
```

## Despliegue en Hostinger (plan Business)

1. hPanel → Hosting de apps web → Node.js → conectar el repositorio de GitHub.
2. hPanel → Bases de datos MySQL → crear la base y el usuario, y completar `.env`.
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
cuentas mínimo, y las reglas de contabilización para los eventos que
Ventas y Compras ya disparan. Seguro de correr más de una vez — no
duplica nada. Sin esto, `motorAsientos` no tiene con qué contabilizar.

## Pendientes inmediatos

- [ ] Restringir `POST /api/auth/registro` a `authenticate + authorize('dueño', 'contador')` una vez exista el primer usuario de cada empresa (ver TODO en `authService.js`)
- [ ] Migraciones de Sequelize (`sequelize-cli`) para las tablas ya modeladas
- [ ] Completar los módulos de inventarios, activos fijos y tesorería (protegidos con `authenticate`, igual que ventas, compras y nómina) — y agregar sus reglas de contabilización a `seedService.js`
- [ ] Reemplazar `FACTOR_PRESTACIONES` (21.83% fijo) en `nomina.service.js` por el cálculo exacto de cesantías, intereses, prima y vacaciones según la normativa laboral vigente y el tipo de contrato
- [ ] Integrar `NovedadNomina` con el cálculo del devengado (hoy es solo un registro informativo, no ajusta nada automáticamente)
- [ ] Pago de nómina y de PILA dependen de Tesorería (todavía no construido) para conciliarse contra banco
- [ ] Soportar múltiples líneas (débito/crédito) por evento en `motorAsientos` — hoy una venta no discrimina el IVA en un renglón aparte
- [ ] Implementar el mapeo real en `facturacionAdapter.js` y `documentoSoporteAdapter.js` contra el proveedor contratado
- [ ] Confirmar con el proveedor tecnológico la mecánica exacta para RECIBIR facturas de compra (RADIAN vs. notificación directa) — ver TODO en `compras.service.js`
- [ ] `GET/PATCH/DELETE` de terceros (hoy `terceros.routes.js` solo tiene crear y listar)
- [ ] **Centros de costo**: permitir contabilidad segmentada por proyecto para empresas que manejan varios en paralelo. Hoy `Movimiento.centroCosto` es solo un campo de texto libre — falta un catálogo propio (`CentroCosto`: id, empresa_id, nombre, activo) y reportes/filtros por centro de costo en los estados financieros
- [ ] Activar Row Level Security (RLS) en las tablas de Supabase antes de manejar datos reales
- [ ] Agregar formularios de creación al frontend para cotizaciones, órdenes de compra y nómina (hoy solo terceros tiene formulario; el resto se crea por API)
SCRIPTEOF
echo "OK  README.md"

echo ""
echo "Listo. Frontend minimo y endpoints de listado creados/actualizados."
echo "Siguiente paso:"
echo "  git add ."
echo "  git commit -m \"Agregar frontend minimo y endpoints de listado\""
echo "  git push"
