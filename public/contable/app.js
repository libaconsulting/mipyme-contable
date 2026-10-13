const API = '/api';

let token = localStorage.getItem('token');
let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
let mapaTerceros = {};
let listaTerceros = [];
let mapaProyectos = {};
let listaProyectos = [];

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

  if (res.status === 413) {
    throw new Error('El archivo es demasiado grande para guardarlo. Intenta con una imagen más liviana.');
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
  // "2026-10-05" (fecha sin hora) se interpreta como día local; con new Date()
  // directo se tomaría como UTC y en Colombia se vería un día antes.
  const soloFecha = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor));
  const fecha = soloFecha ? new Date(Number(soloFecha[1]), Number(soloFecha[2]) - 1, Number(soloFecha[3])) : new Date(valor);
  return fecha.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const ETIQUETAS_IMPUESTO = { iva: 'IVA', impoconsumo: 'Impoconsumo', exento: 'Exento' };
function etiquetaImpuesto(tipoImpuesto, porcentaje) {
  const etiqueta = ETIQUETAS_IMPUESTO[tipoImpuesto] || 'IVA';
  return tipoImpuesto === 'exento' ? etiqueta : `${etiqueta} ${porcentaje}%`;
}

// Para totales de órdenes: el IVA del 19% casi siempre deja centavos, y
// redondearlos a peso entero haría que las líneas no sumen a la vista.
function formatoDineroDec(valor) {
  return Number(valor || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
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

// Convierte el archivo elegido a un data URI (base64) — así se manda
// tal cual al backend, sin necesitar un endpoint de subida de archivos
// aparte. Límite de 2MB para no inflar la base de datos con un logo
// pesado por error.
function leerArchivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error('El logo no debe pesar más de 2MB.'));
      return;
    }
    const lector = new FileReader();
    lector.onload = () => resolve(lector.result);
    lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    lector.readAsDataURL(file);
  });
}

document.getElementById('empresa-logo').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  const vistaPrevia = document.getElementById('empresa-logo-vista-previa');
  if (!archivo) {
    vistaPrevia.hidden = true;
    return;
  }
  try {
    vistaPrevia.src = await leerArchivoComoBase64(archivo);
    vistaPrevia.hidden = false;
  } catch (err) {
    alert(err.message);
    e.target.value = '';
  }
});

document.getElementById('form-empresa-nueva').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const archivoLogo = document.getElementById('empresa-logo').files[0];
    const logoBase64 = archivoLogo ? await leerArchivoComoBase64(archivoLogo) : undefined;

    const res = await fetch(API + '/empresas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razonSocial: document.getElementById('empresa-razon-social').value,
        nit: document.getElementById('empresa-nit').value,
        regimenTributario: document.getElementById('empresa-regimen').value,
        responsableIva: document.getElementById('empresa-responsable-iva').checked,
        email: document.getElementById('empresa-email').value || undefined,
        telefono: document.getElementById('empresa-telefono').value || undefined,
        direccion: document.getElementById('empresa-direccion').value || undefined,
        departamento: document.getElementById('empresa-departamento').value || undefined,
        municipio: document.getElementById('empresa-municipio').value || undefined,
        representanteLegalNombre: document.getElementById('empresa-representante-nombre').value || undefined,
        representanteLegalDocumento: document.getElementById('empresa-representante-documento').value || undefined,
        actividadEconomicaCiiu: document.getElementById('empresa-ciiu').value || undefined,
        matriculaMercantil: document.getElementById('empresa-matricula').value || undefined,
        logoBase64,
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
    if (miEmpresa) llenarFormularioMiEmpresa(miEmpresa);
  } catch (err) {
    console.error(err);
  }
}

function llenarFormularioMiEmpresa(empresa) {
  document.getElementById('miempresa-razon-social').value = empresa.razonSocial || '';
  document.getElementById('miempresa-nit').value = empresa.nit || '';
  document.getElementById('miempresa-regimen').value = empresa.regimenTributario || 'ordinario';
  document.getElementById('miempresa-responsable-iva').checked = !!empresa.responsableIva;
  document.getElementById('miempresa-email').value = empresa.email || '';
  document.getElementById('miempresa-telefono').value = empresa.telefono || '';
  document.getElementById('miempresa-direccion').value = empresa.direccion || '';
  document.getElementById('miempresa-departamento').value = empresa.departamento || '';
  document.getElementById('miempresa-municipio').value = empresa.municipio || '';
  document.getElementById('miempresa-representante-nombre').value = empresa.representanteLegalNombre || '';
  document.getElementById('miempresa-representante-documento').value = empresa.representanteLegalDocumento || '';
  document.getElementById('miempresa-ciiu').value = empresa.actividadEconomicaCiiu || '';
  document.getElementById('miempresa-matricula').value = empresa.matriculaMercantil || '';

  const vistaPrevia = document.getElementById('miempresa-logo-vista-previa');
  if (empresa.logoBase64) {
    vistaPrevia.src = empresa.logoBase64;
    vistaPrevia.hidden = false;
  } else {
    vistaPrevia.hidden = true;
  }
}

document.getElementById('miempresa-logo').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  const vistaPrevia = document.getElementById('miempresa-logo-vista-previa');
  if (!archivo) return; // sin archivo nuevo, se conserva el logo actual en la vista previa
  try {
    vistaPrevia.src = await leerArchivoComoBase64(archivo);
    vistaPrevia.hidden = false;
  } catch (err) {
    alert(err.message);
    e.target.value = '';
  }
});

document.getElementById('form-mi-empresa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultado = document.getElementById('miempresa-resultado');
  resultado.hidden = true;
  try {
    const archivoLogo = document.getElementById('miempresa-logo').files[0];
    // Si no se eligió un archivo nuevo, no se manda logoBase64 — así el
    // backend conserva el logo que ya tenía en vez de borrarlo.
    const logoBase64 = archivoLogo ? await leerArchivoComoBase64(archivoLogo) : undefined;

    await api(`/empresas/${usuario.empresaId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        razonSocial: document.getElementById('miempresa-razon-social').value,
        nit: document.getElementById('miempresa-nit').value,
        regimenTributario: document.getElementById('miempresa-regimen').value,
        responsableIva: document.getElementById('miempresa-responsable-iva').checked,
        email: document.getElementById('miempresa-email').value || undefined,
        telefono: document.getElementById('miempresa-telefono').value || undefined,
        direccion: document.getElementById('miempresa-direccion').value || undefined,
        departamento: document.getElementById('miempresa-departamento').value || undefined,
        municipio: document.getElementById('miempresa-municipio').value || undefined,
        representanteLegalNombre: document.getElementById('miempresa-representante-nombre').value || undefined,
        representanteLegalDocumento: document.getElementById('miempresa-representante-documento').value || undefined,
        actividadEconomicaCiiu: document.getElementById('miempresa-ciiu').value || undefined,
        matriculaMercantil: document.getElementById('miempresa-matricula').value || undefined,
        logoBase64,
      }),
    });

    document.getElementById('miempresa-logo').value = '';
    resultado.textContent = 'Datos de la empresa actualizados.';
    resultado.hidden = false;
    cargarNombreEmpresa();
  } catch (err) {
    alert(err.message);
  }
});

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
conectarToggle('btn-nuevo-proyecto', 'form-proyecto', 'btn-cancelar-proyecto');
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
    poblarSelectTodosTerceros('proyecto-contratante', 'Contratante');

    const proyectos = await api('/proyectos');
    listaProyectos = proyectos;
    mapaProyectos = Object.fromEntries(proyectos.map((p) => [p.id, etiquetaProyecto(p)]));
    renderProyectos(proyectos);
    poblarSelectProyectos(proyectos);

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

// "ID — nombre": el ID (centro de costo) va primero porque es lo que
// identifica el proyecto en los documentos; sin ID, solo el nombre.
function etiquetaProyecto(p) {
  return p.codigo ? `${p.codigo} — ${p.nombre}` : p.nombre;
}

function poblarSelectProyectos(proyectos) {
  const select = document.getElementById('orden-proyecto-id');
  select.innerHTML =
    '<option value="">Proyecto / Unidad de negocio (ID)...</option>' +
    proyectos
      .filter((p) => p.activo)
      .map((p) => `<option value="${p.id}">${etiquetaProyecto(p)}</option>`)
      .join('');
}

function nombreProyecto(id) {
  return id ? mapaProyectos[id] || id : '—';
}

// --- RENDER: PROYECTOS ---
function renderProyectos(lista) {
  document.querySelector('#tabla-proyectos thead').innerHTML =
    '<tr><th>ID (centro de costo)</th><th>Nombre</th><th>Contratante</th><th class="num">Valor total</th><th>Objeto</th><th>Estado</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-proyectos', 7, 'Todavía no hay proyectos. Crea el primero arriba.');
  document.querySelector('#tabla-proyectos tbody').innerHTML = lista
    .map(
      (p) =>
        `<tr><td><strong>${p.codigo || '—'}</strong></td><td>${p.nombre}</td><td>${nombreTercero(
          p.contratanteId
        )}</td><td class="num">${p.valorTotal ? formatoDinero(p.valorTotal) : '—'}</td><td>${
          p.objeto || '—'
        }</td><td>${badge(p.activo ? 'activo' : 'inactivo')}</td><td class="acciones">${botonAccion('Editar', {
          accion: 'editar-proyecto',
          id: p.id,
        })}</td></tr>`
    )
    .join('');
}

// null = el formulario crea un proyecto nuevo; con un id, edita ese
// proyecto (mismo formulario para las dos cosas, como en Terceros).
let proyectoEditandoId = null;

function salirDeEdicionProyecto() {
  proyectoEditandoId = null;
  document.querySelector('#form-proyecto button[type="submit"]').textContent = 'Guardar';
}

function abrirEdicionProyecto(id) {
  const p = listaProyectos.find((x) => x.id === id);
  if (!p) return;

  proyectoEditandoId = id;
  document.getElementById('form-proyecto').hidden = false;
  document.getElementById('proyecto-nombre').value = p.nombre || '';
  document.getElementById('proyecto-codigo').value = p.codigo || '';
  document.getElementById('proyecto-contratante').value = p.contratanteId || '';
  document.getElementById('proyecto-valor-total').value = p.valorTotal ? Number(p.valorTotal) : '';
  document.getElementById('proyecto-objeto').value = p.objeto || '';
  document.getElementById('proyecto-activo').checked = !!p.activo;

  document.querySelector('#form-proyecto button[type="submit"]').textContent = 'Guardar cambios';
  document.getElementById('form-proyecto').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Si se estaba editando y se pulsa "+ Nuevo proyecto", el formulario
// vuelve en blanco y en modo creación (conectarToggle ya lo alternó).
document.getElementById('btn-nuevo-proyecto').addEventListener('click', () => {
  if (proyectoEditandoId) {
    salirDeEdicionProyecto();
    const form = document.getElementById('form-proyecto');
    form.reset();
    form.hidden = false;
  }
});
document.getElementById('btn-cancelar-proyecto').addEventListener('click', salirDeEdicionProyecto);

conectarFormulario('form-proyecto', async () => {
  const nombre = document.getElementById('proyecto-nombre').value;
  const codigo = document.getElementById('proyecto-codigo').value;
  const contratanteId = document.getElementById('proyecto-contratante').value;
  const valor = document.getElementById('proyecto-valor-total').value;
  const objeto = document.getElementById('proyecto-objeto').value;
  const activo = document.getElementById('proyecto-activo').checked;

  if (proyectoEditandoId) {
    // Al editar, un campo vacío se manda como null para poder BORRAR
    // un dato (con undefined el servidor lo ignoraría y quedaría el viejo).
    await api(`/proyectos/${proyectoEditandoId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        nombre,
        codigo: codigo || null,
        contratanteId: contratanteId || null,
        valorTotal: valor ? Number(valor) : null,
        objeto: objeto || null,
        activo,
      }),
    });
  } else {
    await api('/proyectos', {
      method: 'POST',
      body: JSON.stringify({
        nombre,
        codigo: codigo || undefined,
        contratanteId: contratanteId || undefined,
        valorTotal: valor ? Number(valor) : undefined,
        objeto: objeto || undefined,
        activo,
      }),
    });
  }

  // Solo se sale del modo edición si la llamada tuvo éxito.
  salirDeEdicionProyecto();
});

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
    '<tr><th>No.</th><th>Fecha</th><th>Vence</th><th>Cliente</th><th>Estado</th><th class="num">Total</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-cotizaciones', 7, 'Todavía no hay cotizaciones.');
  document.querySelector('#tabla-cotizaciones tbody').innerHTML = lista
    .map((c) => {
      let acciones =
        botonAccion('Ver ítems', { accion: 'ver-items-cotizacion', id: c.id }) +
        botonAccion('Ver PDF', { accion: 'ver-pdf-cotizacion', id: c.id });
      if (c.estado === 'borrador')
        acciones +=
          botonAccion('Editar', { accion: 'editar-cotizacion', id: c.id }) +
          botonAccion('Enviar', { accion: 'enviar-cotizacion', id: c.id });
      else if (c.estado === 'enviada')
        acciones +=
          botonAccion('Aceptar', { accion: 'aceptar-cotizacion', id: c.id }) +
          botonAccion('Rechazar', { accion: 'rechazar-cotizacion', id: c.id }, true);
      else if (c.estado === 'aceptada') acciones += botonAccion('Convertir en factura', { accion: 'convertir-cotizacion', id: c.id });

      return `<tr data-fila-cotizacion="${c.id}"><td>${c.consecutivo || '—'}</td><td>${formatoFecha(
        c.fecha
      )}</td><td>${formatoFecha(c.fechaVencimiento)}</td><td>${nombreTercero(c.terceroId)}</td><td>${badge(
        c.estado
      )}</td><td class="num">${formatoDinero(c.total)}</td><td class="acciones">${acciones}</td></tr>`;
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
      let acciones =
        botonAccion('Ver ítems', { accion: 'ver-items-orden', id: o.id }) +
        botonAccion('Ver PDF', { accion: 'ver-pdf-orden', id: o.id });

      if (['borrador', 'emitida'].includes(o.estado)) {
        if (o.estado === 'borrador') acciones += botonAccion('Editar', { accion: 'editar-orden', id: o.id });
        acciones += botonAccion('Aprobar', { accion: 'aprobar-orden', id: o.id });
      } else if (['aprobada', 'recibida_parcial', 'recibida_total'].includes(o.estado)) {
        acciones += botonAccion('Convertir en factura', { accion: 'convertir-orden', id: o.id });
      }

      const proyecto = o.proyectoId ? nombreProyecto(o.proyectoId) : o.proyecto || '—';

      return `<tr data-fila-orden="${o.id}"><td>${o.consecutivo || '—'}</td><td>${formatoFecha(
        o.fecha
      )}</td><td>${nombreTercero(o.terceroId)}</td><td>${proyecto}</td><td>${o.tipo}</td><td>${badge(
        o.estado
      )}</td><td class="num">${formatoDineroDec(o.total)}</td><td class="acciones">${acciones}</td></tr>`;
    })
    .join('');
}

function renderFacturasCompra(lista) {
  document.querySelector('#tabla-facturas-compra thead').innerHTML =
    '<tr><th>Fecha</th><th>Número</th><th>Proveedor</th><th>Conciliación</th><th class="num">Total</th><th class="num">Retención</th><th class="num">A pagar</th><th>Acciones</th></tr>';
  if (lista.length === 0) return tablaVacia('tabla-facturas-compra', 8, 'Todavía no hay facturas de compra. Carga el XML de la primera con el botón de arriba.');
  document.querySelector('#tabla-facturas-compra tbody').innerHTML = lista
    .map((f) => {
      const neto = f.netoAPagar === null || f.netoAPagar === undefined ? f.total : f.netoAPagar;
      return (
        `<tr><td>${formatoFecha(f.fecha)}</td><td>${escHtml(f.numero || '—')}</td><td>${escHtml(nombreTercero(f.terceroId))}</td><td>${badge(f.estadoConciliacion)}</td>` +
        `<td class="num">${formatoDineroDec(f.total)}</td><td class="num">${Number(f.retencionValor) ? formatoDineroDec(f.retencionValor) : '—'}</td>` +
        `<td class="num">${formatoDineroDec(neto)}</td><td class="acciones">${botonAccion('Ver', { accion: 'ver-factura-compra', id: f.id })}${
          f.emisorNit ? botonAccion('XML', { accion: 'xml-factura-compra', id: f.id }) : ''
        }</td></tr>`
      );
    })
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

// --- ÍTEMS DINÁMICOS DE COTIZACIÓN ---
const UNIDADES_MEDIDA = ['UND', 'KG', 'M', 'M2', 'M3', 'HR', 'DIA', 'MES', 'GLB', 'SERV', 'LT', 'GAL'];

// value = "tipoImpuesto-porcentaje". "otro" deja el % en blanco para
// que el usuario lo escriba a mano (ver el input que aparece al lado).
const OPCIONES_IMPUESTO = [
  { value: 'iva-19', texto: 'IVA 19%' },
  { value: 'iva-5', texto: 'IVA 5%' },
  { value: 'iva-0', texto: 'IVA 0%' },
  { value: 'impoconsumo-4', texto: 'Impoconsumo 4%' },
  { value: 'impoconsumo-8', texto: 'Impoconsumo 8%' },
  { value: 'impoconsumo-16', texto: 'Impoconsumo 16%' },
  { value: 'exento-0', texto: 'Exento' },
  { value: 'otro-', texto: 'Otro (definir %)' },
];

// Si se pasa "item", la fila nace precargada con sus datos — se usa
// tanto para "+ Agregar ítem" (sin argumento, fila en blanco) como para
// abrir una cotización existente en modo edición.
function crearFilaItemCotizacion(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="item-concepto" placeholder="Concepto" required></td>
    <td><input type="number" class="item-cantidad" placeholder="Cant." min="0" step="0.01" required></td>
    <td><select class="item-um">${UNIDADES_MEDIDA.map((u) => `<option value="${u}">${u}</option>`).join('')}</select></td>
    <td><input type="number" class="item-valor-unitario" placeholder="Valor unit." min="0" required></td>
    <td>
      <select class="item-tipo-impuesto">${OPCIONES_IMPUESTO.map((o) => `<option value="${o.value}">${o.texto}</option>`).join('')}</select>
      <input type="number" class="item-impuesto-manual" min="0" max="100" placeholder="%" hidden>
    </td>
    <td class="num item-total-texto">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-item">Quitar</button></td>
  `;
  tr.querySelectorAll('input').forEach((input) => input.addEventListener('input', recalcularTotalesCotizacion));
  tr.querySelector('.item-tipo-impuesto').addEventListener('change', (e) => {
    const manual = tr.querySelector('.item-impuesto-manual');
    manual.hidden = !e.target.value.startsWith('otro-');
    recalcularTotalesCotizacion();
  });
  tr.querySelector('.btn-quitar-item').addEventListener('click', () => {
    tr.remove();
    recalcularTotalesCotizacion();
  });

  if (item) {
    tr.querySelector('.item-concepto').value = item.concepto;
    tr.querySelector('.item-cantidad').value = item.cantidad;
    tr.querySelector('.item-um').value = item.unidadMedida;
    tr.querySelector('.item-valor-unitario').value = item.valorUnitario;

    const selectImpuesto = tr.querySelector('.item-tipo-impuesto');
    const valorCombinado = `${item.tipoImpuesto}-${item.impuestoPorcentaje}`;
    const coincide = Array.from(selectImpuesto.options).some((o) => o.value === valorCombinado);
    if (coincide) {
      selectImpuesto.value = valorCombinado;
    } else {
      // Porcentaje que no está en los presets (ej. 12%) — se guarda
      // igual, solo se muestra como "Otro" con el % manual visible.
      selectImpuesto.value = 'otro-';
      const manual = tr.querySelector('.item-impuesto-manual');
      manual.hidden = false;
      manual.value = item.impuestoPorcentaje;
    }
  }

  return tr;
}

document.getElementById('btn-agregar-item-cotizacion').addEventListener('click', () => {
  document.getElementById('items-cotizacion-tbody').appendChild(crearFilaItemCotizacion());
});

function leerImpuestoFila(fila) {
  const seleccion = fila.querySelector('.item-tipo-impuesto').value; // "tipo-porcentaje"
  const [tipoImpuesto, porcentajeTexto] = seleccion.split('-');
  if (tipoImpuesto === 'otro') {
    const manual = Number(fila.querySelector('.item-impuesto-manual').value || 0);
    return { tipoImpuesto: 'iva', impuestoPorcentaje: manual }; // "otro" se guarda como IVA con % manual
  }
  return { tipoImpuesto, impuestoPorcentaje: Number(porcentajeTexto) };
}

function leerItemsCotizacion() {
  const filas = document.querySelectorAll('#items-cotizacion-tbody tr');
  return Array.from(filas).map((fila) => {
    const cantidad = Number(fila.querySelector('.item-cantidad').value || 0);
    const valorUnitario = Number(fila.querySelector('.item-valor-unitario').value || 0);
    const { tipoImpuesto, impuestoPorcentaje } = leerImpuestoFila(fila);
    const valorTotal = cantidad * valorUnitario;
    fila.querySelector('.item-total-texto').textContent = formatoDinero(valorTotal);
    return {
      concepto: fila.querySelector('.item-concepto').value,
      cantidad,
      unidadMedida: fila.querySelector('.item-um').value,
      valorUnitario,
      tipoImpuesto,
      impuestoPorcentaje,
      valorTotal,
    };
  });
}

function recalcularTotalesCotizacion() {
  const items = leerItemsCotizacion();
  const subtotal = items.reduce((s, i) => s + i.valorTotal, 0);

  const aplicaAiu = document.getElementById('cotizacion-aplica-aiu').checked;
  let baseIva = subtotal;
  if (aplicaAiu) {
    const admin = subtotal * (Number(document.getElementById('cotizacion-aiu-administracion').value || 0) / 100);
    const imprevistos = subtotal * (Number(document.getElementById('cotizacion-aiu-imprevistos').value || 0) / 100);
    const utilidad = subtotal * (Number(document.getElementById('cotizacion-aiu-utilidad').value || 0) / 100);
    baseIva = subtotal + admin + imprevistos + utilidad;

    document.getElementById('valor-aiu-administracion').textContent = formatoDinero(admin);
    document.getElementById('valor-aiu-imprevistos').textContent = formatoDinero(imprevistos);
    document.getElementById('valor-aiu-utilidad').textContent = formatoDinero(utilidad);
  }
  const iva = baseIva * 0.19;
  const total = baseIva + iva;

  document.getElementById('resumen-subtotal').textContent = formatoDinero(subtotal);
  document.getElementById('resumen-iva').textContent = formatoDinero(iva);
  document.getElementById('resumen-total').textContent = formatoDinero(total);
}

document.getElementById('cotizacion-aplica-aiu').addEventListener('change', (e) => {
  document.getElementById('campos-aiu').hidden = !e.target.checked;
  recalcularTotalesCotizacion();
});
document.querySelectorAll('#campos-aiu input').forEach((el) => el.addEventListener('input', recalcularTotalesCotizacion));

function limpiarFormularioCotizacion() {
  document.getElementById('items-cotizacion-tbody').innerHTML = '';
  document.getElementById('campos-aiu').hidden = true;
  document.getElementById('cotizacion-aplica-aiu').checked = false;
  cotizacionEditandoId = null;
  document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar';
  recalcularTotalesCotizacion();
}

// null = el formulario está creando una cotización nueva; con un id,
// está editando esa cotización existente (mismo formulario, igual que
// con Terceros).
let cotizacionEditandoId = null;

async function abrirEdicionCotizacion(id) {
  try {
    const cotizacion = await api(`/ventas/cotizaciones/${id}`);
    if (cotizacion.estado !== 'borrador') {
      alert('Solo se puede editar una cotización en estado "borrador".');
      return;
    }

    cotizacionEditandoId = id;
    document.getElementById('form-cotizacion').hidden = false;
    document.getElementById('cotizacion-tercero').value = cotizacion.terceroId;
    document.getElementById('cotizacion-vencimiento').value = cotizacion.fechaVencimiento;
    document.getElementById('cotizacion-forma-pago').value = cotizacion.formaPago || '';
    document.getElementById('cotizacion-observaciones').value = cotizacion.observaciones || '';
    document.getElementById('cotizacion-contacto-nombre').value = cotizacion.contactoNombre || '';
    document.getElementById('cotizacion-contacto-telefono').value = cotizacion.contactoTelefono || '';

    document.getElementById('cotizacion-aplica-aiu').checked = cotizacion.aplicaAiu;
    document.getElementById('campos-aiu').hidden = !cotizacion.aplicaAiu;
    document.getElementById('cotizacion-aiu-administracion').value = cotizacion.aiuAdministracion || '';
    document.getElementById('cotizacion-aiu-imprevistos').value = cotizacion.aiuImprevistos || '';
    document.getElementById('cotizacion-aiu-utilidad').value = cotizacion.aiuUtilidad || '';

    const tbody = document.getElementById('items-cotizacion-tbody');
    tbody.innerHTML = '';
    const items = cotizacion.items || [];
    if (items.length > 0) items.forEach((item) => tbody.appendChild(crearFilaItemCotizacion(item)));
    else tbody.appendChild(crearFilaItemCotizacion());

    recalcularTotalesCotizacion();
    document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar cambios';
    document.getElementById('form-cotizacion').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert(err.message);
  }
}

// Empieza con un ítem en blanco listo para llenar, en vez de una tabla vacía.
document.getElementById('btn-nueva-cotizacion').addEventListener('click', () => {
  cotizacionEditandoId = null;
  document.querySelector('#form-cotizacion button[type="submit"]').textContent = 'Guardar';
  if (document.getElementById('items-cotizacion-tbody').children.length === 0) {
    document.getElementById('items-cotizacion-tbody').appendChild(crearFilaItemCotizacion());
  }
});
document.getElementById('btn-cancelar-cotizacion').addEventListener('click', limpiarFormularioCotizacion);

conectarFormulario('form-cotizacion', async () => {
  const items = leerItemsCotizacion();
  if (items.length === 0 || items.some((i) => !i.concepto || i.cantidad <= 0)) {
    throw new Error('Agrega al menos un ítem con concepto y cantidad mayor a cero.');
  }

  const cuerpo = {
    terceroId: document.getElementById('cotizacion-tercero').value,
    fechaVencimiento: document.getElementById('cotizacion-vencimiento').value,
    formaPago: document.getElementById('cotizacion-forma-pago').value || undefined,
    observaciones: document.getElementById('cotizacion-observaciones').value || undefined,
    contactoNombre: document.getElementById('cotizacion-contacto-nombre').value || undefined,
    contactoTelefono: document.getElementById('cotizacion-contacto-telefono').value || undefined,
    aplicaAiu: document.getElementById('cotizacion-aplica-aiu').checked,
    aiuAdministracion: Number(document.getElementById('cotizacion-aiu-administracion').value || 0),
    aiuImprevistos: Number(document.getElementById('cotizacion-aiu-imprevistos').value || 0),
    aiuUtilidad: Number(document.getElementById('cotizacion-aiu-utilidad').value || 0),
    items,
  };

  if (cotizacionEditandoId) {
    await api(`/ventas/cotizaciones/${cotizacionEditandoId}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  } else {
    await api('/ventas/cotizaciones', { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  limpiarFormularioCotizacion();
  document.getElementById('form-cotizacion').hidden = true;
});

// --- VER ÍTEMS de una cotización existente (fila expandible) ---
async function verItemsCotizacion(id) {
  const filaDetalleExistente = document.getElementById('detalle-cotizacion-' + id);
  if (filaDetalleExistente) {
    filaDetalleExistente.remove();
    return;
  }

  try {
    const cotizacion = await api(`/ventas/cotizaciones/${id}`);
    const filaOriginal = document.querySelector(`tr[data-fila-cotizacion="${id}"]`);
    if (!filaOriginal) return;

    const itemsHtml = (cotizacion.items || [])
      .map(
        (it) =>
          `<tr><td>${it.concepto}</td><td class="num">${Number(it.cantidad).toLocaleString('es-CO')} ${
            it.unidadMedida
          }</td><td class="num">${formatoDinero(it.valorUnitario)}</td><td class="num">${etiquetaImpuesto(
            it.tipoImpuesto,
            it.impuestoPorcentaje
          )}</td><td class="num">${formatoDinero(it.valorTotal)}</td></tr>`
      )
      .join('');

    const tr = document.createElement('tr');
    tr.id = 'detalle-cotizacion-' + id;
    tr.innerHTML = `<td colspan="7"><div class="detalle-items">
      <table class="tabla-items-detalle">
        <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead>
        <tbody>${
          itemsHtml ||
          '<tr><td colspan="5" class="vacio">Esta cotización no tiene ítems registrados (se creó antes de esta función).</td></tr>'
        }</tbody>
      </table>
      ${
        cotizacion.aplicaAiu
          ? `<p class="nota-aiu">AIU aplicado — Administración ${cotizacion.aiuAdministracion}% · Imprevistos ${cotizacion.aiuImprevistos}% · Utilidad ${cotizacion.aiuUtilidad}%</p>`
          : ''
      }
    </div></td>`;
    filaOriginal.after(tr);
  } catch (err) {
    alert(err.message);
  }
}

// --- ÍTEMS DINÁMICOS DE ORDEN (mismo patrón que cotización) ---
// Reutiliza UNIDADES_MEDIDA, OPCIONES_IMPUESTO y etiquetaImpuesto, que
// ya están definidos más arriba para los ítems de cotización.
function crearFilaItemOrden(item) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="item-concepto" placeholder="Concepto" required></td>
    <td><input type="number" class="item-cantidad" placeholder="Cant." min="0" step="0.01" required></td>
    <td><select class="item-um">${UNIDADES_MEDIDA.map((u) => `<option value="${u}">${u}</option>`).join('')}</select></td>
    <td><input type="number" class="item-valor-unitario" placeholder="Valor unit." min="0" required></td>
    <td>
      <select class="item-tipo-impuesto">${OPCIONES_IMPUESTO.map((o) => `<option value="${o.value}">${o.texto}</option>`).join('')}</select>
      <input type="number" class="item-impuesto-manual" min="0" max="100" placeholder="%" hidden>
    </td>
    <td class="num item-total-texto">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-item">Quitar</button></td>
  `;
  tr.querySelectorAll('input').forEach((input) => input.addEventListener('input', recalcularTotalesOrden));
  tr.querySelector('.item-tipo-impuesto').addEventListener('change', (e) => {
    const manual = tr.querySelector('.item-impuesto-manual');
    manual.hidden = !e.target.value.startsWith('otro-');
    recalcularTotalesOrden();
  });
  tr.querySelector('.btn-quitar-item').addEventListener('click', () => {
    tr.remove();
    recalcularTotalesOrden();
  });

  if (item) {
    tr.querySelector('.item-concepto').value = item.concepto;
    tr.querySelector('.item-cantidad').value = item.cantidad;
    tr.querySelector('.item-um').value = item.unidadMedida;
    tr.querySelector('.item-valor-unitario').value = item.valorUnitario;

    const selectImpuesto = tr.querySelector('.item-tipo-impuesto');
    const valorCombinado = `${item.tipoImpuesto}-${item.impuestoPorcentaje}`;
    const coincide = Array.from(selectImpuesto.options).some((o) => o.value === valorCombinado);
    if (coincide) {
      selectImpuesto.value = valorCombinado;
    } else {
      selectImpuesto.value = 'otro-';
      const manual = tr.querySelector('.item-impuesto-manual');
      manual.hidden = false;
      manual.value = item.impuestoPorcentaje;
    }
  }

  return tr;
}

document.getElementById('btn-agregar-item-orden').addEventListener('click', () => {
  document.getElementById('items-orden-tbody').appendChild(crearFilaItemOrden());
});

function leerItemsOrden() {
  const filas = document.querySelectorAll('#items-orden-tbody tr');
  return Array.from(filas).map((fila) => {
    const cantidad = Number(fila.querySelector('.item-cantidad').value || 0);
    const valorUnitario = Number(fila.querySelector('.item-valor-unitario').value || 0);
    const seleccion = fila.querySelector('.item-tipo-impuesto').value;
    const [tipoBruto, porcentajeTexto] = seleccion.split('-');
    let tipoImpuesto = tipoBruto;
    let impuestoPorcentaje = Number(porcentajeTexto);
    if (tipoBruto === 'otro') {
      tipoImpuesto = 'iva';
      impuestoPorcentaje = Number(fila.querySelector('.item-impuesto-manual').value || 0);
    }
    const valorTotal = cantidad * valorUnitario;
    fila.querySelector('.item-total-texto').textContent = formatoDinero(valorTotal);
    return {
      concepto: fila.querySelector('.item-concepto').value,
      cantidad,
      unidadMedida: fila.querySelector('.item-um').value,
      valorUnitario,
      tipoImpuesto,
      impuestoPorcentaje,
      valorTotal,
    };
  });
}

// --- RETENCIÓN EN LA FUENTE (catálogo 2026, ver retencionesCatalogo.js) ---
// Desplegable de conceptos agrupado por categoría.
function opcionesConceptoRetencionHtml() {
  const cat = retencionesCatalogo;
  const grupos = {};
  cat.CONCEPTOS.forEach((c) => (grupos[c.categoria] = grupos[c.categoria] || []).push(c));
  const porGrupo = Object.entries(grupos)
    .map(
      ([nombre, lista]) =>
        `<optgroup label="${nombre}">` +
        lista
          .map(
            (c) =>
              `<option value="${c.codigo}" title="${(c.detalle || c.nombre).replace(/"/g, '&quot;')}">${c.nombre} — ${c.tarifa.toLocaleString('es-CO')}%</option>`
          )
          .join('') +
        '</optgroup>'
    )
    .join('');
  return `<option value="">Elegir concepto...</option>${porGrupo}<option value="${cat.CONCEPTO_MANUAL.codigo}">${cat.CONCEPTO_MANUAL.nombre}</option>`;
}

function crearFilaRetencion(linea, alCambiar) {
  const avisar = alCambiar || recalcularTotalesOrden;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="item-ret-concepto">${opcionesConceptoRetencionHtml()}</select>
      <span class="ret-nota" hidden></span>
    </td>
    <td><input type="number" class="item-ret-tarifa" min="0" max="100" step="0.01" placeholder="%" readonly> %</td>
    <td class="num ret-base">—</td>
    <td class="num ret-tope">—</td>
    <td class="num ret-valor">$0</td>
    <td><button type="button" class="btn-accion destructivo btn-quitar-retencion">Quitar</button></td>
  `;
  const select = tr.querySelector('.item-ret-concepto');
  const tarifa = tr.querySelector('.item-ret-tarifa');
  select.addEventListener('change', () => {
    const concepto = retencionesCatalogo.porCodigo(select.value);
    // La tarifa sale del catálogo; solo "Otro concepto" se digita a mano.
    tarifa.readOnly = !(concepto && concepto.manual);
    tarifa.value = concepto ? (concepto.manual ? '' : concepto.tarifa) : '';
    avisar();
  });
  tarifa.addEventListener('input', avisar);
  tr.querySelector('.btn-quitar-retencion').addEventListener('click', () => {
    tr.remove();
    avisar();
  });

  if (linea) {
    select.value = linea.codigo || '';
    const concepto = retencionesCatalogo.porCodigo(select.value);
    tarifa.readOnly = !(concepto && concepto.manual);
    tarifa.value = linea.tarifa !== undefined && linea.tarifa !== null ? Number(linea.tarifa) : '';
  }
  return tr;
}

function modoRetencionOrden() {
  return document.querySelector('input[name="orden-retencion-modo"]:checked').value;
}

// Lo que se manda al servidor por cada retención: solo el código (y la
// tarifa si es "Otro concepto"). El servidor toma lo demás del catálogo.
function leerRetencionesOrden(idTbody) {
  return Array.from(document.querySelectorAll('#' + (idTbody || 'retenciones-orden-tbody') + ' tr')).map((tr) => {
    const codigo = tr.querySelector('.item-ret-concepto').value;
    const concepto = retencionesCatalogo.porCodigo(codigo);
    return {
      codigo,
      tarifa: concepto && concepto.manual ? Number(tr.querySelector('.item-ret-tarifa').value || 0) : undefined,
    };
  });
}

// Junta lo que hay en el formulario con la forma que espera
// calcularOrden() (el mismo cálculo que corre el servidor al guardar).
function leerDatosOrden() {
  const tipo = document.getElementById('orden-tipo').value;
  const aplicaAiu = tipo === 'servicios' && document.getElementById('orden-aplica-aiu').checked;
  const retencionModo = modoRetencionOrden();

  return {
    tipo,
    items: leerItemsOrden(),
    aplicaAiu,
    aiuAdministracion: Number(document.getElementById('orden-aiu-administracion').value || 0),
    aiuImprevistos: Number(document.getElementById('orden-aiu-imprevistos').value || 0),
    aiuUtilidad: Number(document.getElementById('orden-aiu-utilidad').value || 0),
    aiuBaseIva: document.getElementById('orden-aiu-base-iva').value,
    retencionModo,
    retencionMotivo: document.getElementById('orden-retencion-motivo').value,
    retencionDetalle: document.getElementById('orden-retencion-detalle').value,
    // Una especificación por fila (aunque esté a medias, queda en cero)
    // para poder pintar cada resultado en su propia fila.
    retenciones:
      retencionModo === 'aplica'
        ? leerRetencionesOrden().map((r) => retencionesCatalogo.especificar(r, { estricto: false }))
        : [],
  };
}

function recalcularTotalesOrden() {
  // estricto:false → mientras se digita no se lanzan errores (ej.
  // retención sin concepto todavía); el servidor sí valida al guardar.
  const datos = leerDatosOrden();
  const { cabecera: c, netoAPagar } = calcularOrden(datos, { estricto: false });

  document.getElementById('valor-orden-aiu-administracion').textContent = formatoDineroDec(c.aiuAdministracionValor);
  document.getElementById('valor-orden-aiu-imprevistos').textContent = formatoDineroDec(c.aiuImprevistosValor);
  document.getElementById('valor-orden-aiu-utilidad').textContent = formatoDineroDec(c.aiuUtilidadValor);

  // Cada fila de retención muestra su base, su tope y su valor.
  document.querySelectorAll('#retenciones-orden-tbody tr').forEach((tr, i) => {
    const l = c.retenciones[i];
    if (!l) return;
    tr.querySelector('.ret-base').textContent = l.codigo ? formatoDineroDec(l.base) : '—';
    tr.querySelector('.ret-tope').textContent = l.codigo ? (l.baseMinima > 0 ? formatoDineroDec(l.baseMinima) : 'Sin tope') : '—';
    const valor = tr.querySelector('.ret-valor');
    valor.textContent = formatoDineroDec(l.valor);
    valor.classList.toggle('ret-sin-efecto', l.valor === 0);
    const nota = tr.querySelector('.ret-nota');
    nota.textContent = l.nota;
    nota.hidden = !l.nota;
  });

  document.getElementById('resumen-subtotal-orden').textContent = formatoDineroDec(c.subtotal);
  document.getElementById('resumen-aiu-orden').textContent = formatoDineroDec(c.aiuTotal);
  document.getElementById('resumen-aiu-orden-fila').hidden = !c.aplicaAiu;
  document.getElementById('resumen-iva-orden').textContent = formatoDineroDec(c.iva);
  document.getElementById('resumen-impoconsumo-orden').textContent = formatoDineroDec(c.impoconsumo);
  document.getElementById('resumen-total-orden').textContent = formatoDineroDec(c.total);

  const aplica = c.retencionModo === 'aplica';
  const noAplica = c.retencionModo === 'no_aplica';
  document.getElementById('resumen-retencion-orden').textContent = noAplica
    ? 'No aplica' + (c.retencionMotivo ? ' — ' + c.retencionMotivo : '')
    : '− ' + formatoDineroDec(c.retencionValor);
  document.getElementById('resumen-retencion-orden-fila').hidden = !(aplica || noAplica);
  document.getElementById('resumen-neto-orden').textContent = formatoDineroDec(netoAPagar);
  document.getElementById('resumen-neto-orden-fila').hidden = !(aplica || noAplica);

  document.getElementById('nota-retencion-orden').textContent =
    `Conceptos y tarifas ${retencionesCatalogo.ANIO} (UVT ${formatoDineroDec(retencionesCatalogo.UVT_VALOR)}). ` +
    'Elige el concepto según el bien o servicio de la orden. La base se mide antes de impuestos; si no alcanza el tope mínimo, esa retención no se practica. ' +
    'Si el proveedor no está sujeto (Régimen Simple, tratamiento especial), usa "No aplica retención".';
}

// Muestra/oculta los bloques según el tipo de orden y las opciones.
// El AIU solo existe en compra de SERVICIOS; al pasar a "bienes" se
// apaga para que no quede un AIU "fantasma" afectando el total.
function actualizarVisibilidadOrden() {
  const esServicios = document.getElementById('orden-tipo').value === 'servicios';
  document.getElementById('bloque-aiu-orden').hidden = !esServicios;
  if (!esServicios) document.getElementById('orden-aplica-aiu').checked = false;

  document.getElementById('campos-aiu-orden').hidden = !document.getElementById('orden-aplica-aiu').checked;

  const modo = modoRetencionOrden();
  document.getElementById('retencion-aplica-orden').hidden = modo !== 'aplica';
  document.getElementById('retencion-no-aplica-orden').hidden = modo !== 'no_aplica';
  // Al elegir "Aplicar" aparece ya la primera fila para elegir concepto.
  const tbody = document.getElementById('retenciones-orden-tbody');
  if (modo === 'aplica' && tbody.children.length === 0) tbody.appendChild(crearFilaRetencion());
}

document.getElementById('orden-tipo').addEventListener('change', () => {
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
});
document.getElementById('orden-aplica-aiu').addEventListener('change', () => {
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
});
document.querySelectorAll('input[name="orden-retencion-modo"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    actualizarVisibilidadOrden();
    recalcularTotalesOrden();
  })
);
document.getElementById('btn-agregar-retencion-orden').addEventListener('click', () => {
  document.getElementById('retenciones-orden-tbody').appendChild(crearFilaRetencion());
});
document.getElementById('orden-retencion-motivo').innerHTML =
  '<option value="">Elegir motivo...</option>' +
  retencionesCatalogo.MOTIVOS_NO_APLICA.map((m) => `<option value="${m}">${m}</option>`).join('');
document
  .querySelectorAll('#campos-aiu-orden input, #campos-aiu-orden select, #orden-retencion-motivo, #orden-retencion-detalle')
  .forEach((el) => {
    el.addEventListener('input', recalcularTotalesOrden);
    el.addEventListener('change', recalcularTotalesOrden);
  });

function limpiarFormularioOrden() {
  document.getElementById('items-orden-tbody').innerHTML = '';
  ordenEditandoId = null;
  document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar';

  document.getElementById('orden-aplica-aiu').checked = false;
  ['administracion', 'imprevistos', 'utilidad'].forEach((n) => (document.getElementById('orden-aiu-' + n).value = ''));
  document.getElementById('orden-aiu-base-iva').value = 'total';

  document.querySelector('input[name="orden-retencion-modo"][value="ninguna"]').checked = true;
  document.getElementById('retenciones-orden-tbody').innerHTML = '';
  document.getElementById('orden-retencion-motivo').value = '';
  document.getElementById('orden-retencion-detalle').value = '';
  actualizarVisibilidadOrden();
  recalcularTotalesOrden();
}

// null = creando una orden nueva; con un id, editando esa orden
// existente — mismo patrón que cotizaciones.
let ordenEditandoId = null;

async function abrirEdicionOrden(id) {
  try {
    const orden = await api(`/compras/ordenes/${id}`);
    if (orden.estado !== 'borrador') {
      alert('Solo se puede editar una orden en estado "borrador".');
      return;
    }

    ordenEditandoId = id;
    document.getElementById('form-orden').hidden = false;
    document.getElementById('orden-tercero').value = orden.terceroId;
    document.getElementById('orden-tipo').value = orden.tipo;
    document.getElementById('orden-proyecto-id').value = orden.proyectoId || '';
    document.getElementById('orden-lugar-entrega').value = orden.lugarEntrega || '';
    document.getElementById('orden-forma-pago').value = orden.formaPago || '';

    // Un proyecto desactivado ya no está en el selector; se agrega solo
    // para que la orden no pierda su proyecto al editarla.
    const selectProyecto = document.getElementById('orden-proyecto-id');
    if (orden.proyectoId && !Array.from(selectProyecto.options).some((o) => o.value === orden.proyectoId)) {
      selectProyecto.add(new Option(nombreProyecto(orden.proyectoId) + ' (inactivo)', orden.proyectoId));
    }
    selectProyecto.value = orden.proyectoId || '';

    document.getElementById('orden-aplica-aiu').checked = !!orden.aplicaAiu;
    document.getElementById('orden-aiu-administracion').value = Number(orden.aiuAdministracion) || '';
    document.getElementById('orden-aiu-imprevistos').value = Number(orden.aiuImprevistos) || '';
    document.getElementById('orden-aiu-utilidad').value = Number(orden.aiuUtilidad) || '';
    document.getElementById('orden-aiu-base-iva').value = orden.aiuBaseIva || 'total';

    // Retención: se recrean las filas desde la foto guardada en la orden.
    const modo = orden.retencionModo || 'ninguna';
    document.querySelector(`input[name="orden-retencion-modo"][value="${modo}"]`).checked = true;
    const tbodyRet = document.getElementById('retenciones-orden-tbody');
    tbodyRet.innerHTML = '';
    if (modo === 'aplica') (orden.retenciones || []).forEach((l) => tbodyRet.appendChild(crearFilaRetencion(l)));
    document.getElementById('orden-retencion-motivo').value = orden.retencionMotivo || '';
    document.getElementById('orden-retencion-detalle').value = orden.retencionDetalle || '';
    actualizarVisibilidadOrden();

    const tbody = document.getElementById('items-orden-tbody');
    tbody.innerHTML = '';
    const items = orden.items || [];
    if (items.length > 0) items.forEach((item) => tbody.appendChild(crearFilaItemOrden(item)));
    else tbody.appendChild(crearFilaItemOrden());

    recalcularTotalesOrden();
    document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar cambios';
    document.getElementById('form-orden').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('btn-nueva-orden').addEventListener('click', () => {
  ordenEditandoId = null;
  document.querySelector('#form-orden button[type="submit"]').textContent = 'Guardar';
  actualizarVisibilidadOrden();
  if (document.getElementById('items-orden-tbody').children.length === 0) {
    document.getElementById('items-orden-tbody').appendChild(crearFilaItemOrden());
  }
});
document.getElementById('btn-cancelar-orden').addEventListener('click', limpiarFormularioOrden);

conectarFormulario('form-orden', async () => {
  const datosCalculo = leerDatosOrden();
  const items = datosCalculo.items;
  if (items.length === 0 || items.some((i) => !i.concepto || i.cantidad <= 0)) {
    throw new Error('Agrega al menos un ítem con concepto y cantidad mayor a cero.');
  }
  if (datosCalculo.retencionModo === 'aplica') {
    const filas = leerRetencionesOrden();
    if (filas.length === 0 || filas.some((r) => !r.codigo)) {
      throw new Error('Elige el concepto de cada retención, o cambia a "No aplica retención".');
    }
    if (filas.some((r) => r.codigo === retencionesCatalogo.CONCEPTO_MANUAL.codigo && !(r.tarifa > 0))) {
      throw new Error('En "Otro concepto" digita la tarifa de la retención.');
    }
  }
  if (datosCalculo.retencionModo === 'no_aplica' && !datosCalculo.retencionMotivo) {
    throw new Error('Elige el motivo por el cual no aplica la retención en la fuente.');
  }

  const cuerpo = {
    terceroId: document.getElementById('orden-tercero').value,
    tipo: document.getElementById('orden-tipo').value,
    proyectoId: document.getElementById('orden-proyecto-id').value || undefined,
    lugarEntrega: document.getElementById('orden-lugar-entrega').value || undefined,
    formaPago: document.getElementById('orden-forma-pago').value || undefined,
    items,
    // AIU y retención: mismos datos que alimentan la vista previa de totales.
    aplicaAiu: datosCalculo.aplicaAiu,
    aiuAdministracion: datosCalculo.aiuAdministracion,
    aiuImprevistos: datosCalculo.aiuImprevistos,
    aiuUtilidad: datosCalculo.aiuUtilidad,
    aiuBaseIva: datosCalculo.aiuBaseIva,
    retencionModo: datosCalculo.retencionModo,
    retenciones: datosCalculo.retencionModo === 'aplica' ? leerRetencionesOrden() : [],
    retencionMotivo: datosCalculo.retencionModo === 'no_aplica' ? datosCalculo.retencionMotivo : undefined,
    retencionDetalle: datosCalculo.retencionModo === 'no_aplica' ? datosCalculo.retencionDetalle || undefined : undefined,
  };

  if (ordenEditandoId) {
    await api(`/compras/ordenes/${ordenEditandoId}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
  } else {
    await api('/compras/ordenes', { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  limpiarFormularioOrden();
  document.getElementById('form-orden').hidden = true;
});

// --- VER ÍTEMS de una orden existente (fila expandible, mismo patrón que cotización) ---
async function verItemsOrden(id) {
  const filaDetalleExistente = document.getElementById('detalle-orden-' + id);
  if (filaDetalleExistente) {
    filaDetalleExistente.remove();
    return;
  }

  try {
    const orden = await api(`/compras/ordenes/${id}`);
    const filaOriginal = document.querySelector(`tr[data-fila-orden="${id}"]`);
    if (!filaOriginal) return;

    const itemsHtml = (orden.items || [])
      .map(
        (it) =>
          `<tr><td>${it.concepto}</td><td class="num">${Number(it.cantidad).toLocaleString('es-CO')} ${
            it.unidadMedida
          }</td><td class="num">${formatoDinero(it.valorUnitario)}</td><td class="num">${etiquetaImpuesto(
            it.tipoImpuesto,
            it.impuestoPorcentaje
          )}</td><td class="num">${formatoDinero(it.valorTotal)}</td></tr>`
      )
      .join('');

    const tr = document.createElement('tr');
    tr.id = 'detalle-orden-' + id;
    tr.innerHTML = `<td colspan="8"><div class="detalle-items">
      <table class="tabla-items-detalle">
        <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead>
        <tbody>${
          itemsHtml ||
          '<tr><td colspan="5" class="vacio">Esta orden no tiene ítems registrados (se creó antes de esta función).</td></tr>'
        }</tbody>
      </table>
      ${resumenTotalesOrdenHtml(orden)}
    </div></td>`;
    filaOriginal.after(tr);
  } catch (err) {
    alert(err.message);
  }
}

// Desglose en texto bajo los ítems: AIU, impuestos, retención y neto.
function resumenTotalesOrdenHtml(orden) {
  const c = orden.calculo;
  if (!c) return '';
  const partes = [`Subtotal ${formatoDineroDec(c.subtotal)}`];
  if (c.aplicaAiu) {
    partes.push(
      `AIU: Administración ${c.aiuAdministracion}% (${formatoDineroDec(c.aiuAdministracionValor)}) · Imprevistos ${
        c.aiuImprevistos
      }% (${formatoDineroDec(c.aiuImprevistosValor)}) · Utilidad ${c.aiuUtilidad}% (${formatoDineroDec(
        c.aiuUtilidadValor
      )}) — IVA sobre ${c.aiuBaseIva === 'utilidad' ? 'la Utilidad' : 'subtotal + AIU'}`
    );
  }
  partes.push(`IVA ${formatoDineroDec(c.iva)}`);
  if (c.impoconsumo > 0) partes.push(`Impoconsumo ${formatoDineroDec(c.impoconsumo)}`);
  partes.push(`<strong>Total ${formatoDineroDec(c.total)}</strong>`);
  if (c.retencionModo === 'aplica') {
    c.retenciones.forEach((l) => {
      partes.push(
        `Retención: ${l.nombre} ${l.tarifa}% sobre ${formatoDineroDec(l.base)} → ` +
          (l.aplica ? `− ${formatoDineroDec(l.valor)}` : 'no se practica (no alcanza el tope)')
      );
    });
    partes.push(`<strong>A consignar al proveedor ${formatoDineroDec(c.netoAPagar)}</strong>`);
  } else if (c.retencionModo === 'no_aplica') {
    partes.push(`No aplica retención en la fuente: ${c.retencionMotivo}${c.retencionDetalle ? ' (' + c.retencionDetalle + ')' : ''}`);
  }
  return `<p class="nota-aiu">${partes.join(' · ')}</p>`;
}

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

// --- FACTURAS DE COMPRA: CARGA DEL XML DEL PROVEEDOR ---
// Flujo: elegir archivo -> el servidor lo lee (sin guardar nada) -> se revisa
// en pantalla (proveedor, orden, cuentas, retención, asiento) -> confirmar.
// El servidor vuelve a leer el XML al registrar: nada de lo que se ve aquí
// se toma como verdad, solo las decisiones de la persona.

function escHtml(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NOMBRES_CUENTAS_FIJAS = {
  1355: 'IVA descontable',
  2205: 'Proveedores nacionales',
  2365: 'Retención en la fuente por pagar',
  2367: 'ReteIVA por pagar',
};
const TAMANO_MAX_XML = 3.5 * 1024 * 1024;

const fx = {
  base64: null,
  nombre: '',
  preview: null,
  ordenId: '',
  tocado: { cuentas: new Set(), proyecto: false, retencion: false },
  enviando: false,
};

const dialogoFx = document.getElementById('dialogo-factura-xml');

function fxReiniciar() {
  fx.base64 = null;
  fx.nombre = '';
  fx.preview = null;
  fx.ordenId = '';
  fx.tocado = { cuentas: new Set(), proyecto: false, retencion: false };
  fx.enviando = false;
  document.getElementById('fx-archivo').value = '';
  document.getElementById('fx-paso-archivo').hidden = false;
  document.getElementById('fx-revision').hidden = true;
  document.getElementById('fx-estado-lectura').textContent = '';
  document.getElementById('fx-estado-lectura').classList.remove('error');
  document.getElementById('fx-zona-archivo').classList.remove('error', 'arrastrando');
  document.getElementById('fx-error').hidden = true;
  document.getElementById('fx-ayuda').textContent = '';
  document.getElementById('btn-registrar-factura-xml').disabled = true;
  document.getElementById('fx-retenciones-tbody').innerHTML = '';
  document.getElementById('fx-aceptar').checked = false;
  document.getElementById('fx-aiu').value = '';
  document.querySelectorAll('input[name="fx-retencion-modo"]').forEach((r) => (r.checked = false));
}

function abrirDialogoFacturaXml() {
  fxReiniciar();
  if (typeof dialogoFx.showModal === 'function') dialogoFx.showModal();
  else dialogoFx.setAttribute('open', '');
}

function cerrarDialogoFacturaXml() {
  if (fx.enviando) return;
  dialogoFx.close();
}

function archivoABase64(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split(',')[1] || '');
    lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    lector.readAsDataURL(archivo);
  });
}

function fxMostrarEstado(texto, esError) {
  const el = document.getElementById('fx-estado-lectura');
  el.textContent = texto;
  el.classList.toggle('error', !!esError);
  document.getElementById('fx-zona-archivo').classList.toggle('error', !!esError);
}

async function procesarArchivoFactura(archivo) {
  if (!archivo) return;
  if (archivo.size > TAMANO_MAX_XML) {
    fxMostrarEstado('El archivo pesa demasiado (máximo 3,5 MB). Sube solo el XML de la factura.', true);
    return;
  }
  fxMostrarEstado('Leyendo la factura...');
  try {
    fx.base64 = await archivoABase64(archivo);
    fx.nombre = archivo.name;
    fx.preview = await api('/compras/facturas/xml/previsualizar', {
      method: 'POST',
      body: JSON.stringify({ archivoBase64: fx.base64 }),
    });
    fxMostrarRevision();
  } catch (err) {
    fx.base64 = null;
    fx.preview = null;
    fxMostrarEstado(err.message, true);
  }
}

// Orden candidata elegida actualmente (o null).
function fxOrdenElegida() {
  if (!fx.preview || !fx.ordenId) return null;
  return fx.preview.ordenesCandidatas.find((o) => o.id === fx.ordenId) || null;
}

function fxCuentaPorDefecto() {
  const orden = fxOrdenElegida();
  const sug = fx.preview.destinosSugeridos;
  return orden && orden.tipo === 'bienes' ? sug.bienes : sug.gasto;
}

function fxOpcionesCuentas(seleccionada) {
  return fx.preview.cuentasDestino
    .map((c) => `<option value="${escHtml(c.codigo)}"${c.codigo === seleccionada ? ' selected' : ''}>${escHtml(c.codigo)} — ${escHtml(c.nombre)}</option>`)
    .join('');
}

function fxRenderAdvertencias() {
  const lista = fx.preview.advertencias;
  const etiqueta = { bloqueo: 'No se puede registrar', confirmar: 'Revisa', info: 'Aviso' };
  document.getElementById('fx-advertencias').innerHTML = lista
    .map((a) => `<div class="fx-aviso ${a.nivel}"><strong>${etiqueta[a.nivel] || ''}:</strong> ${escHtml(a.texto)}</div>`)
    .join('');
  const hayConfirmar = lista.some((a) => a.nivel === 'confirmar');
  document.getElementById('fx-aceptar-fila').hidden = !hayConfirmar;
  if (!hayConfirmar) document.getElementById('fx-aceptar').checked = false;
}

function fxRenderResumen() {
  const p = fx.preview;
  const f = p.factura;
  const dian = f.validacionDian.disponible
    ? f.validacionDian.validada
      ? '<span class="badge libre aceptada">Validada por la DIAN</span>'
      : '<span class="badge libre rechazada">No validada</span>'
    : '<span class="badge libre pendiente">Sin respuesta de la DIAN en el archivo</span>';
  const filas = [
    ['Documento', `${escHtml(f.tipoNombre)} <strong>${escHtml(f.numero || '—')}</strong>`],
    ['Fecha de emisión', escHtml(formatoFecha(f.fechaEmision))],
    ['Forma de pago', f.formaPago === 'credito' ? `Crédito${f.fechaVencimiento ? ' · vence ' + escHtml(formatoFecha(f.fechaVencimiento)) : ''}` : f.formaPago === 'contado' ? 'Contado' : '—'],
    ['Emisor', `${escHtml(f.emisor.nombre)}<br>NIT ${escHtml(f.emisor.nit)}${f.emisor.dv ? '-' + escHtml(f.emisor.dv) : ''}`],
    ['Total factura', `<strong>${escHtml(formatoDineroDec(f.totales.conImpuestos))}</strong>`],
    ['Validación', dian],
    [
      'CUFE',
      `<span class="mono" title="${escHtml(f.cufe)}">${escHtml(f.cufe.slice(0, 18))}…${escHtml(f.cufe.slice(-8))}</span>` +
        (p.verificacionDianUrl ? `<br><a href="${escHtml(p.verificacionDianUrl)}" target="_blank" rel="noopener noreferrer">Verificar en la DIAN</a>` : ''),
    ],
    ['Archivo', `${escHtml(fx.nombre)}<br><a href="#" id="fx-otro-archivo">Cargar otro archivo</a>`],
  ];
  document.getElementById('fx-resumen').innerHTML = filas.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function fxRenderProveedor() {
  const p = fx.preview;
  const e = p.factura.emisor;
  const el = document.getElementById('fx-proveedor');
  const fila = document.getElementById('fx-crear-proveedor-fila');
  if (p.proveedor) {
    el.innerHTML = `✔ <strong>${escHtml(p.proveedor.nombre)}</strong> (${escHtml(p.proveedor.identificacion)}) ya está en Terceros.`;
    fila.hidden = true;
  } else {
    el.innerHTML = `<strong>${escHtml(e.nombre)}</strong> · NIT ${escHtml(e.nit)}${e.dv ? '-' + escHtml(e.dv) : ''} no está en Terceros.`;
    fila.hidden = false;
  }
}

function fxRenderOrdenes() {
  const p = fx.preview;
  const sel = document.getElementById('fx-orden');
  sel.innerHTML =
    '<option value="">Sin orden (compra directa)</option>' +
    p.ordenesCandidatas
      .map(
        (o) =>
          `<option value="${escHtml(o.id)}"${o.id === fx.ordenId ? ' selected' : ''}>${escHtml(o.consecutivo)} · ${escHtml(o.tipo)} · ${escHtml(
            formatoDineroDec(o.total)
          )}${o.coincideReferencia ? ' · citada' : o.sugerida ? ' · mismo valor' : ''}</option>`
      )
      .join('');
  document.getElementById('fx-orden-nota').textContent = p.ordenesCandidatas.length
    ? 'Vincula la factura a la orden aprobada: queda “facturada” y hereda proyecto y retención.'
    : p.proveedor
    ? 'Este proveedor no tiene órdenes aprobadas pendientes de facturar.'
    : '';
}

function fxRenderProyectos() {
  const sel = document.getElementById('fx-proyecto');
  sel.innerHTML =
    '<option value="">Sin proyecto</option>' +
    listaProyectos.filter((x) => x.activo).map((x) => `<option value="${escHtml(x.id)}">${escHtml(etiquetaProyecto(x))}</option>`).join('');
}

function fxRenderLineas() {
  const p = fx.preview;
  const defecto = fxCuentaPorDefecto();
  document.querySelector('#fx-tabla-lineas tbody').innerHTML = p.factura.lineas
    .map(
      (l, i) =>
        `<tr><td>${escHtml(l.numero)}</td><td>${escHtml(l.descripcion)}${l.gratuita ? ' <span class="badge">sin costo</span>' : ''}</td>` +
        `<td class="num">${escHtml(l.cantidad)}</td><td class="num">${escHtml(formatoDineroDec(l.valorTotal))}</td>` +
        `<td class="num">${escHtml(formatoDineroDec(l.iva))}</td>` +
        `<td><select class="fx-cuenta-linea" data-linea="${i}">${fxOpcionesCuentas(defecto)}</select></td></tr>`
    )
    .join('');
  document.getElementById('fx-cuenta-todas').innerHTML = '<option value="">Elegir...</option>' + fxOpcionesCuentas('');
}

// Retención inicial: la de la orden si hay una; si no, lo que sugiere el XML.
function fxPrecargarRetencion() {
  const p = fx.preview;
  const orden = fxOrdenElegida();
  const sugerenciaEl = document.getElementById('fx-retencion-sugerencia');
  let carga = null;
  let texto = '';

  if (orden && orden.retencion && ['aplica', 'no_aplica'].includes(orden.retencion.modo)) {
    carga = orden.retencion;
    texto = `Precargada desde la orden ${orden.consecutivo}. Se recalcula con los valores reales de la factura.`;
  } else if (p.retencionSugerida) {
    carga = { modo: p.retencionSugerida.modo, motivo: p.retencionSugerida.motivo, detalle: p.retencionSugerida.detalle, conceptos: [] };
    texto = p.retencionSugerida.texto;
  }

  const tbody = document.getElementById('fx-retenciones-tbody');
  tbody.innerHTML = '';
  document.querySelectorAll('input[name="fx-retencion-modo"]').forEach((r) => (r.checked = !!carga && r.value === carga.modo));
  document.getElementById('fx-retencion-motivo').value = carga ? carga.motivo : '';
  document.getElementById('fx-retencion-detalle').value = carga ? carga.detalle : '';
  if (carga && carga.modo === 'aplica') {
    carga.conceptos.forEach((c) => tbody.appendChild(crearFilaRetencion(c, fxAlCambiarRetencion)));
  }
  if (orden && orden.aiuTotal > 0) document.getElementById('fx-aiu').value = orden.aiuTotal;

  sugerenciaEl.textContent = texto;
  sugerenciaEl.hidden = !texto;
}

function fxAlCambiarRetencion() {
  fx.tocado.retencion = true;
  recalcularFactura();
}

function fxModoRetencion() {
  const marcado = document.querySelector('input[name="fx-retencion-modo"]:checked');
  return marcado ? marcado.value : '';
}

function fxMostrarRevision() {
  document.getElementById('fx-paso-archivo').hidden = true;
  document.getElementById('fx-revision').hidden = false;
  document.getElementById('fx-error').hidden = true;
  const p = fx.preview;

  // Si hay una orden claramente emparejada (la factura la cita, o mismo valor), se propone.
  const sugerida = p.ordenesCandidatas.find((o) => o.sugerida);
  fx.ordenId = sugerida ? sugerida.id : '';
  fx.tocado = { cuentas: new Set(), proyecto: false, retencion: false };

  fxRenderResumen();
  fxRenderProveedor();
  fxRenderOrdenes();
  fxRenderProyectos();
  fxRenderLineas();
  document.getElementById('fx-retencion-motivo').innerHTML =
    '<option value="">Elegir motivo...</option>' + retencionesCatalogo.MOTIVOS_NO_APLICA.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  fxAplicarOrden(true);
}

// Aplica lo que hereda de la orden elegida (proyecto, cuentas, retención) y
// refresca las advertencias (las del valor de la orden dependen de cuál se elija).
async function fxAplicarOrden(inicial) {
  const orden = fxOrdenElegida();
  if (!inicial) {
    try {
      const nuevo = await api('/compras/facturas/xml/previsualizar', {
        method: 'POST',
        body: JSON.stringify({ archivoBase64: fx.base64, ordenCompraId: fx.ordenId || undefined }),
      });
      fx.preview.advertencias = nuevo.advertencias;
    } catch (err) {
      document.getElementById('fx-error').textContent = err.message;
      document.getElementById('fx-error').hidden = false;
    }
  }
  fxRenderAdvertencias();

  if (!fx.tocado.proyecto) document.getElementById('fx-proyecto').value = orden && orden.proyectoId ? orden.proyectoId : '';
  const defecto = fxCuentaPorDefecto();
  document.querySelectorAll('.fx-cuenta-linea').forEach((sel) => {
    if (!fx.tocado.cuentas.has(Number(sel.dataset.linea))) sel.value = defecto;
  });
  if (!fx.tocado.retencion) fxPrecargarRetencion();
  recalcularFactura();
}

function fxLeerCuentasLineas() {
  const cuentas = {};
  document.querySelectorAll('.fx-cuenta-linea').forEach((sel) => (cuentas[Number(sel.dataset.linea)] = sel.value));
  return cuentas;
}

function fxNombreCuenta(codigo) {
  const c = fx.preview.cuentasDestino.find((x) => x.codigo === codigo);
  return c ? c.nombre : NOMBRES_CUENTAS_FIJAS[codigo] || '';
}

// Recalcula retención, asiento y totales con lo que hay en pantalla y
// decide si ya se puede registrar.
function recalcularFactura() {
  if (!fx.preview) return;
  const p = fx.preview;
  const c = p.contable;
  const modo = fxModoRetencion();

  document.getElementById('fx-retencion-aplica').hidden = modo !== 'aplica';
  document.getElementById('fx-retencion-no-aplica').hidden = modo !== 'no_aplica';
  if (modo === 'aplica' && document.getElementById('fx-retenciones-tbody').children.length === 0) {
    document.getElementById('fx-retenciones-tbody').appendChild(crearFilaRetencion(null, fxAlCambiarRetencion));
  }

  const entradas = modo === 'aplica' ? leerRetencionesOrden('fx-retenciones-tbody') : [];
  const hayConceptoSobreAiu = entradas.some((e) => {
    const k = retencionesCatalogo.porCodigo(e.codigo);
    return k && k.sobre === 'aiu';
  });
  document.getElementById('fx-aiu-fila').hidden = !hayConceptoSobreAiu;

  const ret = calcularOrden.calcularRetenciones(
    {
      base: c.base,
      iva: c.iva,
      aiuTotal: hayConceptoSobreAiu ? Number(document.getElementById('fx-aiu').value || 0) : 0,
      retencionModo: modo,
      retencionMotivo: document.getElementById('fx-retencion-motivo').value,
      retencionDetalle: document.getElementById('fx-retencion-detalle').value,
      retenciones: entradas.map((e) => retencionesCatalogo.especificar(e, { estricto: false })),
    },
    false
  );

  document.querySelectorAll('#fx-retenciones-tbody tr').forEach((tr, i) => {
    const l = ret.retenciones[i];
    if (!l) return;
    tr.querySelector('.ret-base').textContent = l.codigo ? formatoDineroDec(l.base) : '—';
    tr.querySelector('.ret-tope').textContent = l.codigo ? (l.baseMinima > 0 ? formatoDineroDec(l.baseMinima) : 'Sin tope') : '—';
    const valor = tr.querySelector('.ret-valor');
    valor.textContent = formatoDineroDec(l.valor);
    valor.classList.toggle('ret-sin-efecto', l.valor === 0);
    const nota = tr.querySelector('.ret-nota');
    nota.textContent = l.nota;
    nota.hidden = !l.nota;
  });
  document.getElementById('fx-nota-retencion').textContent =
    `Conceptos y tarifas ${retencionesCatalogo.ANIO} (UVT ${formatoDineroDec(retencionesCatalogo.UVT_VALOR)}). La base se mide antes de impuestos (${formatoDineroDec(c.base)}); ` +
    'si no alcanza el tope mínimo, esa retención no se practica.';

  // Asiento
  const proyectoSel = document.getElementById('fx-proyecto');
  const proyecto = listaProyectos.find((x) => x.id === proyectoSel.value);
  const cuentasPorLinea = fxLeerCuentasLineas();
  let asiento;
  try {
    asiento = asientoCompra.armarAsientoCompra({
      lineas: p.factura.lineas,
      base: c.base,
      iva: c.iva,
      impoconsumo: c.impoconsumo,
      total: c.total,
      ivaDescontable: c.ivaDescontable,
      cuentasLinea: p.factura.lineas.map((_, i) => cuentasPorLinea[i]),
      retenciones: ret.retenciones,
      centroCosto: proyecto ? proyecto.codigo || proyecto.nombre : null,
    });
  } catch (_) {
    asiento = null;
  }
  const tbody = document.querySelector('#fx-tabla-asiento tbody');
  const tfoot = document.querySelector('#fx-tabla-asiento tfoot');
  if (asiento) {
    tbody.innerHTML = asiento.lineas
      .map(
        (l) =>
          `<tr><td class="${l.credito ? 'indentar' : ''}">${escHtml(l.cuentaCodigo)} <span class="cuenta-nombre">${escHtml(fxNombreCuenta(l.cuentaCodigo))}</span>${
            l.centroCosto ? ` <span class="badge">${escHtml(l.centroCosto)}</span>` : ''
          }</td><td class="num">${l.debito ? escHtml(formatoDineroDec(l.debito)) : ''}</td><td class="num">${l.credito ? escHtml(formatoDineroDec(l.credito)) : ''}</td></tr>`
      )
      .join('');
    tfoot.innerHTML = `<tr><td>Sumas iguales${asiento.cuadra ? '' : ' — NO CUADRA'}</td><td class="num">${escHtml(formatoDineroDec(asiento.totalDebito))}</td><td class="num">${escHtml(
      formatoDineroDec(asiento.totalCredito)
    )}</td></tr>`;
  } else {
    tbody.innerHTML = '<tr><td colspan="3" class="vacio">Elige la cuenta de cada línea.</td></tr>';
    tfoot.innerHTML = '';
  }

  const neto = asiento ? asiento.netoAPagar : c.total - ret.retencionValor;
  document.getElementById('fx-totales').innerHTML =
    `<span>Base: <strong>${escHtml(formatoDineroDec(c.base))}</strong></span>` +
    `<span>IVA${c.ivaDescontable ? '' : ' (al gasto)'}: <strong>${escHtml(formatoDineroDec(c.iva))}</strong></span>` +
    (c.impoconsumo ? `<span>Impoconsumo: <strong>${escHtml(formatoDineroDec(c.impoconsumo))}</strong></span>` : '') +
    `<span>Total: <strong>${escHtml(formatoDineroDec(c.total))}</strong></span>` +
    `<span>Retención: <strong>− ${escHtml(formatoDineroDec(ret.retencionValor))}</strong></span>` +
    `<span>A pagar al proveedor: <strong class="neto">${escHtml(formatoDineroDec(neto))}</strong></span>`;

  // ¿Ya se puede registrar?
  const pendientes = [];
  if (p.advertencias.some((a) => a.nivel === 'bloqueo')) pendientes.push('La factura tiene errores que impiden registrarla.');
  if (!p.proveedor && !document.getElementById('fx-crear-proveedor').checked) pendientes.push('Marca “Crear este proveedor” (o créalo antes en Terceros).');
  if (!modo) pendientes.push('Decide la retención: aplicar o no aplicar.');
  if (modo === 'aplica' && (entradas.length === 0 || entradas.some((e) => !e.codigo))) pendientes.push('Elige el concepto de la retención.');
  if (modo === 'aplica' && entradas.some((e) => e.codigo === retencionesCatalogo.CONCEPTO_MANUAL.codigo && !(e.tarifa > 0))) pendientes.push('Escribe la tarifa del “Otro concepto”.');
  if (modo === 'no_aplica' && !document.getElementById('fx-retencion-motivo').value) pendientes.push('Elige el motivo por el que no aplica la retención.');
  if (p.advertencias.some((a) => a.nivel === 'confirmar') && !document.getElementById('fx-aceptar').checked) pendientes.push('Acepta las advertencias para continuar.');
  if (asiento && !asiento.cuadra) pendientes.push('El asiento no cuadra.');

  document.getElementById('fx-ayuda').textContent = pendientes[0] || 'Todo listo para contabilizar.';
  document.getElementById('btn-registrar-factura-xml').disabled = pendientes.length > 0 || fx.enviando;
  return { modo, ret, entradas };
}

async function registrarFacturaXml() {
  if (fx.enviando) return;
  const estado = recalcularFactura();
  const p = fx.preview;
  const errorEl = document.getElementById('fx-error');
  errorEl.hidden = true;

  const cargaRetenciones = estado.modo === 'aplica' ? estado.entradas.map((e) => ({ codigo: e.codigo, tarifa: e.tarifa })) : [];
  const cuerpo = {
    archivoBase64: fx.base64,
    ordenCompraId: fx.ordenId || undefined,
    terceroId: p.proveedor ? p.proveedor.id : undefined,
    crearProveedor: !p.proveedor && document.getElementById('fx-crear-proveedor').checked,
    proyectoId: document.getElementById('fx-proyecto').value || undefined,
    cuentasLineas: fxLeerCuentasLineas(),
    retencionModo: estado.modo,
    retencionMotivo: document.getElementById('fx-retencion-motivo').value,
    retencionDetalle: document.getElementById('fx-retencion-detalle').value,
    retenciones: cargaRetenciones,
    aiuTotal: Number(document.getElementById('fx-aiu').value || 0),
    aceptarAdvertencias: document.getElementById('fx-aceptar').checked,
  };

  const boton = document.getElementById('btn-registrar-factura-xml');
  fx.enviando = true;
  boton.disabled = true;
  boton.textContent = 'Registrando...';
  try {
    const resultado = await api('/compras/facturas/xml', { method: 'POST', body: JSON.stringify(cuerpo) });
    fx.enviando = false;
    dialogoFx.close();
    await cargarTodo();
    const avisos = [];
    if (!resultado.contabilizada) avisos.push('La factura quedó registrada, pero SIN asiento: la regla contable de este evento está en nivel manual. Contabilízala desde el módulo contable.');
    if (resultado.periodoAjustado) avisos.push('La fecha de la factura no cae en un periodo contable abierto; el asiento quedó con la fecha de hoy en el periodo vigente.');
    await abrirDetalleFactura(resultado.factura.id, avisos, 'Factura registrada y contabilizada.');
  } catch (err) {
    fx.enviando = false;
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    boton.textContent = 'Registrar y contabilizar';
    if (fx.preview) recalcularFactura();
  }
}

// --- Eventos de la ventana ---
document.getElementById('btn-cargar-factura-xml').addEventListener('click', abrirDialogoFacturaXml);
document.getElementById('btn-cerrar-factura-xml').addEventListener('click', cerrarDialogoFacturaXml);
document.getElementById('btn-cancelar-factura-xml').addEventListener('click', cerrarDialogoFacturaXml);
document.getElementById('btn-registrar-factura-xml').addEventListener('click', registrarFacturaXml);
dialogoFx.addEventListener('cancel', (e) => {
  if (fx.enviando) e.preventDefault();
});

const zonaArchivoFx = document.getElementById('fx-zona-archivo');
document.getElementById('fx-archivo').addEventListener('change', (e) => procesarArchivoFactura(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) =>
  zonaArchivoFx.addEventListener(ev, (e) => {
    e.preventDefault();
    zonaArchivoFx.classList.add('arrastrando');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  zonaArchivoFx.addEventListener(ev, (e) => {
    e.preventDefault();
    zonaArchivoFx.classList.remove('arrastrando');
  })
);
zonaArchivoFx.addEventListener('drop', (e) => procesarArchivoFactura(e.dataTransfer.files[0]));

document.getElementById('fx-resumen').addEventListener('click', (e) => {
  if (e.target.id !== 'fx-otro-archivo') return;
  e.preventDefault();
  fxReiniciar();
});

document.getElementById('fx-orden').addEventListener('change', (e) => {
  fx.ordenId = e.target.value;
  fxAplicarOrden(false);
});
document.getElementById('fx-proyecto').addEventListener('change', () => {
  fx.tocado.proyecto = true;
  recalcularFactura();
});
document.getElementById('fx-crear-proveedor').addEventListener('change', recalcularFactura);
document.getElementById('fx-aceptar').addEventListener('change', recalcularFactura);
document.getElementById('fx-tabla-lineas').addEventListener('change', (e) => {
  if (!e.target.classList.contains('fx-cuenta-linea')) return;
  fx.tocado.cuentas.add(Number(e.target.dataset.linea));
  recalcularFactura();
});
document.getElementById('fx-cuenta-todas').addEventListener('change', (e) => {
  if (!e.target.value) return;
  document.querySelectorAll('.fx-cuenta-linea').forEach((sel) => {
    sel.value = e.target.value;
    fx.tocado.cuentas.add(Number(sel.dataset.linea));
  });
  e.target.value = '';
  recalcularFactura();
});
document.querySelectorAll('input[name="fx-retencion-modo"]').forEach((radio) => radio.addEventListener('change', fxAlCambiarRetencion));
document.getElementById('btn-agregar-retencion-fx').addEventListener('click', () => {
  document.getElementById('fx-retenciones-tbody').appendChild(crearFilaRetencion(null, fxAlCambiarRetencion));
  fx.tocado.retencion = true;
});
['fx-retencion-motivo', 'fx-retencion-detalle', 'fx-aiu'].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener('input', fxAlCambiarRetencion);
  el.addEventListener('change', fxAlCambiarRetencion);
});

// --- Detalle de una factura registrada ---
const dialogoDetalle = document.getElementById('dialogo-factura-detalle');
let facturaDetalleId = null;

async function abrirDetalleFactura(id, avisos, mensajeOk) {
  try {
    const f = await api(`/compras/facturas/${id}`);
    facturaDetalleId = id;
    const det = f.detalle || {};
    const lineas = det.lineas || [];
    const retenciones = Array.isArray(f.retenciones) ? f.retenciones : [];
    const cuentaTxt = (codigo, nombre) => `${escHtml(codigo)} <span class="cuenta-nombre">${escHtml(nombre || '')}</span>`;

    document.getElementById('titulo-factura-detalle').textContent = `Factura de compra ${f.numero || ''}`.trim();
    document.getElementById('btn-xml-factura-detalle').hidden = !f.emisorNit;
    document.getElementById('fd-cuerpo').innerHTML =
      (mensajeOk ? `<div class="fd-aviso">${escHtml(mensajeOk)}</div>` : '') +
      (avisos || []).map((a) => `<div class="fd-aviso alerta">${escHtml(a)}</div>`).join('') +
      `<dl class="fx-resumen">` +
      [
        ['Proveedor', `${escHtml(f.emisorNombre || nombreTercero(f.terceroId))}${f.emisorNit ? '<br>NIT ' + escHtml(f.emisorNit) : ''}`],
        ['Fecha', escHtml(formatoFecha(f.fecha))],
        ['Forma de pago', f.formaPago === 'credito' ? `Crédito${f.fechaVencimiento ? ' · vence ' + escHtml(formatoFecha(f.fechaVencimiento)) : ''}` : f.formaPago === 'contado' ? 'Contado' : '—'],
        ['Orden de adquisición', f.ordenCompraOrigenId ? 'Vinculada' : 'Compra directa'],
        ['Proyecto', escHtml(nombreProyecto(f.proyectoId))],
        ['Estado', badge(f.estadoConciliacion)],
        ['Total', `<strong>${escHtml(formatoDineroDec(f.total))}</strong>`],
        ['Retención', escHtml(formatoDineroDec(f.retencionValor))],
        ['A pagar al proveedor', `<strong>${escHtml(formatoDineroDec(f.netoAPagar === null || f.netoAPagar === undefined ? f.total : f.netoAPagar))}</strong>`],
        ['CUFE', f.cufe ? `<span class="mono" title="${escHtml(f.cufe)}">${escHtml(f.cufe.slice(0, 18))}…${escHtml(f.cufe.slice(-8))}</span>` : '—'],
      ]
        .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
        .join('') +
      `</dl>` +
      (lineas.length
        ? `<h4>Detalle</h4><table class="tabla-items-detalle"><thead><tr><th>#</th><th>Descripción</th><th class="num">Cant.</th><th class="num">Valor</th><th class="num">IVA</th><th>Cuenta</th></tr></thead><tbody>` +
          lineas
            .map(
              (l) =>
                `<tr><td>${escHtml(l.numero)}</td><td>${escHtml(l.descripcion)}</td><td class="num">${escHtml(l.cantidad)}</td><td class="num">${escHtml(formatoDineroDec(l.valorTotal))}</td><td class="num">${escHtml(
                  formatoDineroDec(l.iva)
                )}</td><td>${escHtml(l.cuentaCodigo)}</td></tr>`
            )
            .join('') +
          `</tbody></table>`
        : '') +
      (f.retencionModo === 'aplica' && retenciones.length
        ? `<h4>Retenciones practicadas</h4><table class="tabla-items-detalle"><thead><tr><th>Concepto</th><th class="num">Tarifa</th><th class="num">Base</th><th class="num">Valor</th></tr></thead><tbody>` +
          retenciones
            .map((r) => `<tr><td>${escHtml(r.nombre)}</td><td class="num">${escHtml(r.tarifa)}%</td><td class="num">${escHtml(formatoDineroDec(r.base))}</td><td class="num">${escHtml(formatoDineroDec(r.valor))}</td></tr>`)
            .join('') +
          `</tbody></table>`
        : f.retencionModo === 'no_aplica'
        ? `<h4>Retención</h4><p class="fx-texto">No aplica — ${escHtml(f.retencionMotivo || '')}</p>`
        : '') +
      `<h4>Asiento contable</h4>` +
      (f.asiento && f.asiento.length
        ? `<table class="tabla-items-detalle"><thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead><tbody>` +
          f.asiento
            .map(
              (m) =>
                `<tr><td class="${m.credito ? 'indentar' : ''}">${cuentaTxt(m.cuentaCodigo, m.cuentaNombre)}${m.centroCosto ? ` <span class="badge">${escHtml(m.centroCosto)}</span>` : ''}</td><td class="num">${
                  m.debito ? escHtml(formatoDineroDec(m.debito)) : ''
                }</td><td class="num">${m.credito ? escHtml(formatoDineroDec(m.credito)) : ''}</td></tr>`
            )
            .join('') +
          `</tbody></table>`
        : '<p class="fx-texto">Esta factura no tiene asiento (se generó antes del cargue por XML o está pendiente de contabilizar).</p>');

    if (typeof dialogoDetalle.showModal === 'function') dialogoDetalle.showModal();
    else dialogoDetalle.setAttribute('open', '');
  } catch (err) {
    alert(err.message);
  }
}

async function descargarXmlFactura(id) {
  try {
    const res = await fetch(`${API}/compras/facturas/${id}/xml`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo descargar el XML.');
    }
    const blob = await res.blob();
    const nombre = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = nombre ? nombre[1] : 'factura.xml';
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(enlace.href), 2000);
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('btn-cerrar-factura-detalle').addEventListener('click', () => dialogoDetalle.close());
document.getElementById('btn-listo-factura-detalle').addEventListener('click', () => dialogoDetalle.close());
document.getElementById('btn-xml-factura-detalle').addEventListener('click', () => facturaDetalleId && descargarXmlFactura(facturaDetalleId));

// --- ACCIONES POR FILA (delegación de eventos sobre todo el tablero) ---
document.getElementById('vista-dashboard').addEventListener('click', async (e) => {
  const boton = e.target.closest('.btn-accion');
  if (!boton) return;

  const { accion: tipoAccion, id } = boton.dataset;

  switch (tipoAccion) {
    case 'editar-tercero':
      return abrirEdicionTercero(id);

    case 'editar-proyecto':
      return abrirEdicionProyecto(id);

    case 'ver-factura-compra':
      return abrirDetalleFactura(id);

    case 'xml-factura-compra':
      return descargarXmlFactura(id);

    case 'ver-items-cotizacion':
      return verItemsCotizacion(id);

    case 'ver-pdf-cotizacion':
      window.open(`/contable/cotizacion-imprimir.html?id=${id}`, '_blank');
      return;

    case 'editar-cotizacion':
      return abrirEdicionCotizacion(id);

    case 'enviar-cotizacion':
      if (
        confirm(
          'Esto solo marca la cotización como "enviada" en el sistema — no manda ningún correo ni mensaje por sí solo.\n\nPara hacérsela llegar al cliente de verdad, usa "Ver PDF" y compártela tú mismo (correo, WhatsApp, etc.).\n\n¿Marcar como enviada?'
        )
      )
        return accion(`/ventas/cotizaciones/${id}/enviar`, { method: 'PATCH' });
      return;
    case 'aceptar-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/aceptar`, { method: 'PATCH' });
    case 'rechazar-cotizacion':
      if (confirm('¿Rechazar esta cotización?')) return accion(`/ventas/cotizaciones/${id}/rechazar`, { method: 'PATCH' });
      return;
    case 'convertir-cotizacion':
      return accion(`/ventas/cotizaciones/${id}/convertir`, { method: 'POST' });

    case 'ver-items-orden':
      return verItemsOrden(id);
    case 'ver-pdf-orden':
      window.open(`/contable/orden-imprimir.html?id=${id}`, '_blank');
      return;
    case 'editar-orden':
      return abrirEdicionOrden(id);
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
