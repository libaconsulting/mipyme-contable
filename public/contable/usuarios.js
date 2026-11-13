// Mi Empresa › Usuarios: crear, cambiar de rol, desactivar y restablecer la contraseña de las personas
// que entran a la empresa. Solo lo ven el dueño y el contador (el contador no modifica al dueño).
//
// Se carga DESPUÉS de app.js: usa sus ayudas globales (api, usuario, escHtml, formatoFecha).
(function () {
  if (!document.getElementById('mi-empresa-sub-usuarios')) return;
  const ROLES = [['dueño', 'Dueño'], ['contador', 'Contador'], ['auxiliar', 'Auxiliar'], ['revisor', 'Revisor']];
  const U = { lista: [] };
  const $ = (id) => document.getElementById(id);
  const esc = (x) => escHtml(x);
  const puedeAdministrar = () => !!usuario && ['dueño', 'contador'].includes(usuario.rol);
  // Los roles que quien consulta puede asignar: el contador no asigna "dueño".
  const rolesAsignables = () => ROLES.filter(([r]) => usuario.rol === 'dueño' || r !== 'dueño');
  const puedeTocarA = (u) => usuario.rol === 'dueño' || u.rol !== 'dueño';

  async function cargar() {
    U.lista = await api('/usuarios');
    render();
  }

  function render() {
    $('tabla-usuarios').querySelector('thead').innerHTML = '<tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr>';
    $('tabla-usuarios').querySelector('tbody').innerHTML = U.lista.map((u) => {
      const yo = u.id === usuario.id;
      const editable = puedeTocarA(u);
      const rol = editable && !yo
        ? `<select data-usr="rol" data-id="${esc(u.id)}" aria-label="Rol de ${esc(u.nombre)}">${rolesAsignables().map(([r, t]) => `<option value="${r}"${r === u.rol ? ' selected' : ''}>${t}</option>`).join('')}${rolesAsignables().some(([r]) => r === u.rol) ? '' : `<option value="${esc(u.rol)}" selected>${esc(u.rol)}</option>`}</select>`
        : esc((ROLES.find(([r]) => r === u.rol) || [0, u.rol])[1]);
      const acciones = [];
      if (editable) {
        acciones.push(`<button type="button" class="btn-accion" data-usr="clave" data-id="${esc(u.id)}">Nueva contraseña</button>`);
        if (!yo) acciones.push(`<button type="button" class="btn-accion${u.activo ? ' destructivo' : ''}" data-usr="${u.activo ? 'desactivar' : 'activar'}" data-id="${esc(u.id)}">${u.activo ? 'Desactivar' : 'Activar'}</button>`);
      }
      return `<tr><td>${esc(u.nombre)}${yo ? ' <span class="texto-suave">(tú)</span>' : ''}</td><td>${esc(u.email)}</td><td>${rol}</td>
        <td>${u.activo ? '<span class="badge conciliado">activo</span>' : '<span class="badge rechazado">inactivo</span>'}</td><td class="acciones">${acciones.join(' ') || '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="vacio">Sin usuarios.</td></tr>';
  }

  // --- Diálogo ---------------------------------------------------------------------
  let guardar = null;
  function abrir(titulo, cuerpo, textoBoton, fn) {
    $('titulo-usuario').textContent = titulo;
    $('usuario-dialogo-cuerpo').innerHTML = cuerpo;
    $('usuario-dialogo-error').hidden = true;
    $('btn-usuario-guardar').textContent = textoBoton;
    guardar = fn;
    if (!$('dialogo-usuario').open) $('dialogo-usuario').showModal();
  }
  function cerrar() {
    if ($('dialogo-usuario').open) $('dialogo-usuario').close();
    guardar = null;
  }
  const campo = (etiqueta, html) => `<label class="campo-etiquetado"><span>${etiqueta}</span>${html}</label>`;
  const v = (id) => $(id).value;

  function dialogoNuevo() {
    abrir('Nuevo usuario', `
      ${campo('Nombre', '<input type="text" id="un-nombre" maxlength="150" autocomplete="off">')}
      ${campo('Correo', '<input type="email" id="un-email" maxlength="150" autocomplete="off">')}
      ${campo('Rol', `<select id="un-rol">${rolesAsignables().map(([r, t]) => `<option value="${r}"${r === 'auxiliar' ? ' selected' : ''}>${t}</option>`).join('')}</select>`)}
      ${campo('Contraseña inicial (mínimo 8 caracteres, con letras y números)', '<input type="password" id="un-clave" autocomplete="new-password">')}
      <p class="nota-aiu">Entrégale la contraseña por un medio privado; la persona puede pedir que se la cambien cuando quiera.</p>`,
    'Crear usuario', async () => {
      await api('/auth/registro', { method: 'POST', body: JSON.stringify({ nombre: v('un-nombre'), email: v('un-email'), rol: v('un-rol'), password: v('un-clave') }) });
      await cargar();
    });
  }

  function dialogoClave(id) {
    const u = U.lista.find((x) => x.id === id);
    if (!u) return;
    abrir(`Nueva contraseña de ${u.nombre}`, `
      ${campo('Contraseña nueva (mínimo 8 caracteres, con letras y números)', '<input type="password" id="un-clave" autocomplete="new-password">')}`,
    'Cambiar contraseña', async () => {
      await api(`/usuarios/${id}`, { method: 'PATCH', body: JSON.stringify({ password: v('un-clave') }) });
      await cargar();
    });
  }

  async function patch(id, cuerpo) {
    try {
      await api(`/usuarios/${id}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
    } catch (err) {
      alert(err.message);
    }
    await cargar();
  }

  $('btn-usuario-nuevo').addEventListener('click', dialogoNuevo);
  $('btn-cerrar-usuario').addEventListener('click', cerrar);
  $('btn-usuario-cancelar').addEventListener('click', cerrar);
  $('form-dialogo-usuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!guardar) return;
    const btn = $('btn-usuario-guardar');
    btn.disabled = true;
    try {
      await guardar();
      cerrar();
    } catch (err) {
      $('usuario-dialogo-error').textContent = err.message || String(err);
      $('usuario-dialogo-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('tabla-usuarios').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-usr]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.usr === 'clave') return dialogoClave(id);
    if (b.dataset.usr === 'desactivar') {
      const u = U.lista.find((x) => x.id === id);
      if (confirm(`¿Desactivar a ${u ? u.nombre : 'este usuario'}? Ya no podrá entrar; su historial se conserva.`)) patch(id, { activo: false });
      return;
    }
    if (b.dataset.usr === 'activar') patch(id, { activo: true });
  });
  $('tabla-usuarios').addEventListener('change', (e) => {
    const s = e.target.closest('select[data-usr="rol"]');
    if (!s) return;
    const u = U.lista.find((x) => x.id === s.dataset.id);
    if (u && confirm(`¿Cambiar el rol de ${u.nombre} a ${s.options[s.selectedIndex].text}?`)) patch(s.dataset.id, { rol: s.value });
    else render();
  });

  window.usuariosAlMostrar = async function () {
    try {
      await cargar();
    } catch (err) {
      alert(err.message);
    }
  };

  // Solo dueño y contador ven la pestaña.
  window.usuariosConfigurarAcceso = function () {
    $('subtab-usuarios').hidden = !puedeAdministrar();
  };
  if (usuario) window.usuariosConfigurarAcceso();
})();
