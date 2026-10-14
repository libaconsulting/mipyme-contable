// Pantalla de Inventarios.
//
// Va en su propio archivo (app.js ya es muy grande) y se carga DESPUÉS de app.js: usa sus
// ayudas globales (api, token, usuario, escHtml, formatoDinero, formatoDineroDec, formatoFecha, badge)
// y los módulos compartidos con el servidor (costeoInventario, asientoInventario) para mostrar el
// costo y el asiento antes de guardar un movimiento.
//
// Pestañas: Productos · Movimientos · Valoración. El kardex de cada producto se abre en un diálogo.
// También expone window.invFacturas, que usan los diálogos de factura de compra y de venta para
// elegir el producto de cada línea.
(function () {
  const SUBS = [
    ['productos', 'Productos'],
    ['movimientos', 'Movimientos'],
    ['valoracion', 'Valoración'],
  ];
  const ORIGENES = { manual: 'Manual', factura_compra: 'Factura de compra', factura_venta: 'Factura de venta' };

  const inv = {
    sub: 'productos',
    opciones: null,
    productos: [],
    totales: null,
    filtros: { q: '', estado: 'activos' },
    movFiltros: { productoId: '', concepto: '', desde: '', hasta: '' },
    corte: '',
  };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => escHtml(v);
  const dinero = (v) => formatoDineroDec(v);
  const cant = (n) => Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 4 });
  const puedeRegistrar = () => !!usuario && ['contador', 'dueño', 'auxiliar'].includes(usuario.rol);
  const puedeAnular = () => !!usuario && ['contador', 'dueño'].includes(usuario.rol);
  const contenido = () => $('inv-contenido');
  const aviso = (tipo, texto) => `<p class="fx-aviso ${tipo}">${texto}</p>`;
  const mostrarError = (err) => alert(err && err.message ? err.message : String(err));

  function boton(texto, nombre, datos, clase) {
    const attrs = Object.entries(datos || {}).map(([k, val]) => `data-${k}="${esc(val)}"`).join(' ');
    return `<button type="button" class="${clase || 'btn-accion'}" data-inv="${nombre}" ${attrs}>${texto}</button>`;
  }
  const campo = (etiqueta, html, clase) => `<label class="campo-etiquetado ${clase || ''}"><span>${etiqueta}</span>${html}</label>`;
  const opcionesSelect = (pares, elegido) => pares.map(([val, txt]) => `<option value="${esc(val)}"${String(val) === String(elegido) ? ' selected' : ''}>${esc(txt)}</option>`).join('');
  const v = (id) => ($(id) ? $(id).value : '');
  const num = (id) => {
    const t = String(v(id)).replace(/[^\d.\-]/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  };
  const query = (obj) => Object.entries(obj).filter(([, val]) => val !== '' && val != null).map(([k, val]) => `${k}=${encodeURIComponent(val)}`).join('&');

  // --- Diálogo genérico ----------------------------------------------------------
  let dialogoActual = null;
  function abrirDialogo({ titulo, cuerpo, guardar, extra, ancho }) {
    const dlg = $('dialogo-inv');
    $('titulo-inv').textContent = titulo;
    $('inv-dialogo-cuerpo').innerHTML = cuerpo;
    $('inv-dialogo-error').hidden = true;
    $('inv-dialogo-ayuda').textContent = '';
    dlg.classList.toggle('dialogo-chico', !ancho);
    const btnGuardar = $('btn-inv-guardar');
    btnGuardar.hidden = !guardar;
    btnGuardar.disabled = false;
    btnGuardar.textContent = guardar ? guardar.texto : 'Guardar';
    $('inv-dialogo-extra').innerHTML = (extra || []).map((x, i) => `<button type="button" class="btn-secundario" data-inv-extra="${i}">${x.texto}</button>`).join('');
    dialogoActual = { guardar, extra: extra || [] };
    if (!dlg.open) dlg.showModal();
  }
  function cerrarDialogo() {
    const dlg = $('dialogo-inv');
    if (dlg.open) dlg.close();
    dialogoActual = null;
  }
  function errorDialogo(mensaje) {
    const el = $('inv-dialogo-error');
    el.textContent = mensaje;
    el.hidden = !mensaje;
  }
  $('btn-cerrar-inv').addEventListener('click', cerrarDialogo);
  $('btn-inv-cancelar').addEventListener('click', cerrarDialogo);
  $('btn-inv-guardar').addEventListener('click', async () => {
    if (!dialogoActual || !dialogoActual.guardar) return;
    const btn = $('btn-inv-guardar');
    btn.disabled = true;
    errorDialogo('');
    try {
      const cerrar = await dialogoActual.guardar.fn();
      if (cerrar !== false) cerrarDialogo();
    } catch (err) {
      errorDialogo(err.message || String(err));
    } finally {
      btn.disabled = false;
    }
  });
  $('inv-dialogo-extra').addEventListener('click', (e) => {
    const b = e.target.closest('[data-inv-extra]');
    if (b && dialogoActual) dialogoActual.extra[Number(b.dataset.invExtra)].fn();
  });

  async function descargar(url, nombre) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo descargar.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = nombre;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      mostrarError(err);
    }
  }

  // --- Carga ------------------------------------------------------------------------------
  async function cargarOpciones() {
    inv.opciones = await api('/inventarios/opciones');
    return inv.opciones;
  }

  async function cargarProductos() {
    const r = await api(`/inventarios/productos?${query({ q: inv.filtros.q, estado: inv.filtros.estado })}`);
    inv.productos = r.productos;
    inv.totales = r.totales;
  }

  async function mostrarSub(sub) {
    inv.sub = sub;
    document.querySelectorAll('#inv-subtabs button').forEach((b) => b.classList.toggle('activo', b.dataset.sub === sub));
    contenido().innerHTML = '<p class="nota-panel">Cargando…</p>';
    try {
      if (!inv.opciones) await cargarOpciones();
      if (!inv.corte) inv.corte = inv.opciones.hoy;
      if (sub === 'productos') {
        await cargarProductos();
        return renderProductos();
      }
      if (sub === 'movimientos') return await cargarMovimientos();
      if (sub === 'valoracion') return await cargarValoracion();
    } catch (err) {
      contenido().innerHTML = aviso('bloqueo', esc(err.message || err));
    }
  }

  // ===================================================================================
  // PRODUCTOS
  // ===================================================================================
  function renderProductos() {
    const t = inv.totales;
    let html = `<div class="inv-tarjetas">
      <div class="inv-tarjeta"><span>Productos</span><strong>${t.productos}</strong></div>
      <div class="inv-tarjeta destacada"><span>Valor del inventario</span><strong>${dinero(t.valor)}</strong></div>
      <div class="inv-tarjeta${t.bajoMinimo ? ' alerta' : ''}"><span>Bajo el mínimo</span><strong>${t.bajoMinimo}</strong></div>
      <div class="inv-tarjeta${t.negativos ? ' alerta' : ''}"><span>Con saldo negativo</span><strong>${t.negativos}</strong></div></div>`;
    html += `<div class="inv-barra">
      <input type="search" id="inv-buscar" placeholder="Buscar por código, nombre o categoría" value="${esc(inv.filtros.q)}">
      <select id="inv-estado">${opcionesSelect([['activos', 'Activos'], ['alertas', 'Con alertas'], ['todos', 'Todos (incluye inactivos)']], inv.filtros.estado)}</select>
      ${puedeRegistrar() ? boton('+ Nuevo producto', 'nuevo-producto', {}, 'btn-primario') : ''}
    </div>`;
    html += '<p class="nota-panel">El inventario se lleva a costo promedio ponderado. Las compras (factura de proveedor con líneas a inventario) dan entrada y las ventas dan salida con su costo de ventas automáticamente; aquí registras lo demás: existencias iniciales, consumos, faltantes y ajustes.</p>';
    if (inv.productos.length === 0) {
      html += '<p class="vacio">No hay productos con este filtro. Crea el primero o carga una factura de compra con líneas a inventario: los productos se crean solos.</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Código</th><th>Producto</th><th>Unidad</th><th class="num">Existencias</th><th class="num">Costo promedio</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>
      ${inv.productos.map((p) => {
        const marcas = [];
        if (!p.activo) marcas.push('<span class="badge">inactivo</span>');
        if (p.negativo) marcas.push('<span class="badge rechazado">negativo</span>');
        if (p.bajoMinimo) marcas.push('<span class="badge pendiente">bajo mínimo</span>');
        if (p.valorSinUnidades) marcas.push('<span class="badge pendiente">valor sin unidades</span>');
        if (p.tipo === 'servicio') marcas.push('<span class="badge libre">servicio</span>');
        const acciones = [boton('Kardex', 'kardex', { id: p.id })];
        if (puedeRegistrar() && p.tipo === 'bien' && p.activo) acciones.push(boton('Movimiento', 'nuevo-movimiento', { id: p.id }));
        if (puedeRegistrar()) acciones.push(boton('Editar', 'editar-producto', { id: p.id }));
        return `<tr><td>${esc(p.codigo || '—')}</td><td><strong>${esc(p.nombre)}</strong>${p.categoria ? `<br><span class="texto-suave">${esc(p.categoria)}</span>` : ''}</td>
          <td>${esc(p.unidadMedida)}</td>
          <td class="num">${p.tipo === 'servicio' ? '—' : cant(p.cantidad)}${p.cantidadMinima > 0 ? `<br><span class="texto-suave">mín. ${cant(p.cantidadMinima)}</span>` : ''}</td>
          <td class="num">${p.tipo === 'servicio' ? '—' : dinero(p.costoPromedio)}</td>
          <td class="num">${p.tipo === 'servicio' ? '—' : dinero(p.valor)}</td>
          <td>${marcas.join(' ') || '—'}</td>
          <td class="acciones">${acciones.join(' ')}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    }
    contenido().innerHTML = html;
  }

  function dialogoProducto(p) {
    const o = inv.opciones;
    const editando = !!p;
    const cuentasInv = o.cuentasInventario.map((c) => [c.codigo, `${c.codigo} · ${c.nombre}${c.nueva ? ' (se crea al usarla)' : ''}`]);
    const cuentasCosto = o.cuentasCosto.map((c) => [c.codigo, `${c.codigo} · ${c.nombre}${c.nueva ? ' (se crea al usarla)' : ''}`]);
    const bloqueaCuentas = editando && (!o.puedeCambiarCuentas || p.cantidad !== 0 || p.valor !== 0);
    let cuerpo = `<div class="fila-campos">
        ${campo('Código (opcional)', `<input type="text" id="ip-codigo" maxlength="50" value="${esc(p ? p.codigo || '' : '')}">`)}
        ${campo('Nombre', `<input type="text" id="ip-nombre" maxlength="150" value="${esc(p ? p.nombre : '')}">`, 'dc-nombre')}
      </div>
      <div class="fila-campos">
        ${campo('Categoría', `<input type="text" id="ip-categoria" maxlength="60" value="${esc(p ? p.categoria || '' : '')}">`)}
        ${campo('Unidad', `<input type="text" id="ip-unidad" maxlength="20" list="ip-unidades" value="${esc(p ? p.unidadMedida : 'unidad')}"><datalist id="ip-unidades">${['unidad', 'kg', 'g', 'l', 'ml', 'm', 'm²', 'm³', 'caja', 'paquete', 'par', 'juego', 'resma', 'galón'].map((u) => `<option value="${u}">`).join('')}</datalist>`)}
        ${campo('Tipo', `<select id="ip-tipo"${editando ? ' disabled' : ''}>${opcionesSelect([['bien', 'Bien (lleva existencias)'], ['servicio', 'Servicio (sin existencias)']], p ? p.tipo : 'bien')}</select>`)}
        ${campo('Mínimo (alerta)', `<input type="number" id="ip-minimo" min="0" step="any" value="${p ? p.cantidadMinima : 0}">`)}
      </div>
      <div id="ip-cuentas">
        <div class="fila-campos">
          ${campo('Cuenta de inventario', `<select id="ip-cinv"${bloqueaCuentas ? ' disabled' : ''}>${opcionesSelect(cuentasInv, p ? p.cuentaInventario : '1435')}</select>`)}
          ${campo('Cuenta de costo de ventas', `<select id="ip-ccosto"${editando && !o.puedeCambiarCuentas ? ' disabled' : ''}>${opcionesSelect(cuentasCosto, p ? p.cuentaCosto : '6135')}</select>`)}
        </div>
        ${editando && bloqueaCuentas ? '<p class="nota-aiu">La cuenta de inventario solo la cambia el contador o el dueño, y únicamente cuando el producto no tiene existencias.</p>' : ''}
      </div>`;
    if (!editando) {
      cuerpo += `<div id="ip-inicial"><h4 class="inv-sec-titulo">Existencias iniciales (opcional)</h4>
        <div class="fila-campos">
          ${campo('Cantidad', '<input type="number" id="ip-cant" min="0" step="any">')}
          ${campo('Costo unitario', '<input type="number" id="ip-costo" min="0" step="any">')}
          ${campo('Fecha', `<input type="date" id="ip-fecha" value="${o.hoy}" max="${o.hoy}">`)}
        </div>
        <label class="fx-check"><input type="checkbox" id="ip-conasiento"> Cargarlas también a la contabilidad (marca esto solo si el saldo contable de inventario todavía no incluye estas existencias)</label>
        <div id="ip-contra-caja" hidden>${campo('Contra qué cuenta', `<select id="ip-contra"><option value="">Elegir cuenta…</option>${opcionesSelect(o.cuentas.map((c) => [c.codigo, `${c.codigo} · ${c.nombre}`]), '')}</select>`)}</div>
        <p class="nota-aiu">Sin marcar, el saldo inicial queda solo en el kardex (la contabilidad ya tendría ese valor por su saldo de apertura).</p></div>`;
    }
    abrirDialogo({
      titulo: editando ? `Editar producto · ${p.nombre}` : 'Nuevo producto',
      cuerpo,
      ancho: true,
      guardar: {
        texto: editando ? 'Guardar cambios' : 'Crear producto',
        fn: async () => {
          const cuerpoJson = {
            codigo: v('ip-codigo'), nombre: v('ip-nombre'), categoria: v('ip-categoria'), unidadMedida: v('ip-unidad'),
            cantidadMinima: v('ip-minimo') || 0,
          };
          if (!editando) {
            cuerpoJson.tipo = v('ip-tipo');
            if (cuerpoJson.tipo === 'bien') { cuerpoJson.cuentaInventario = v('ip-cinv'); cuerpoJson.cuentaCosto = v('ip-ccosto'); }
            if (v('ip-cant') !== '' && cuerpoJson.tipo === 'bien') {
              const conAsiento = $('ip-conasiento').checked;
              cuerpoJson.saldoInicial = { cantidad: v('ip-cant'), costoUnitario: v('ip-costo'), fecha: v('ip-fecha'), sinAsiento: !conAsiento, contrapartida: conAsiento ? v('ip-contra') : undefined };
            }
            await api('/inventarios/productos', { method: 'POST', body: JSON.stringify(cuerpoJson) });
          } else {
            if (!$('ip-cinv').disabled) cuerpoJson.cuentaInventario = v('ip-cinv');
            if (!$('ip-ccosto').disabled) cuerpoJson.cuentaCosto = v('ip-ccosto');
            await api(`/inventarios/productos/${p.id}`, { method: 'PATCH', body: JSON.stringify(cuerpoJson) });
          }
          await mostrarSub('productos');
        },
      },
      extra: editando && puedeRegistrar() && p.cantidad === 0 && p.valor === 0 ? [{
        texto: p.activo ? 'Inactivar' : 'Reactivar',
        fn: async () => {
          try {
            await api(`/inventarios/productos/${p.id}`, { method: 'PATCH', body: JSON.stringify({ activo: !p.activo }) });
            cerrarDialogo();
            await mostrarSub('productos');
          } catch (err) { errorDialogo(err.message); }
        },
      }] : [],
    });
    const alternar = () => {
      const esServicio = !editando && v('ip-tipo') === 'servicio';
      $('ip-cuentas').hidden = esServicio;
      if ($('ip-inicial')) $('ip-inicial').hidden = esServicio;
    };
    if (!editando) {
      $('ip-tipo').addEventListener('change', alternar);
      $('ip-conasiento').addEventListener('change', () => { $('ip-contra-caja').hidden = !$('ip-conasiento').checked; });
    } else if (p.tipo === 'servicio') {
      $('ip-cuentas').hidden = true;
    }
  }

  // ===================================================================================
  // MOVIMIENTO MANUAL
  // ===================================================================================
  function dialogoMovimiento(productoId) {
    const o = inv.opciones;
    const p = inv.productos.find((x) => x.id === productoId);
    if (!p) return;
    const conceptos = o.conceptos;
    const grupo = (tipo, etiqueta) => `<optgroup label="${etiqueta}">${conceptos.filter((c) => c.tipo === tipo).map((c) => `<option value="${c.codigo}">${esc(c.nombre)}</option>`).join('')}</optgroup>`;
    const cuentas = o.cuentas.map((c) => [c.codigo, `${c.codigo} · ${c.nombre}${c.nueva ? ' (se crea al usarla)' : ''}`]);
    const cuerpo = `<p class="nota-aiu"><strong>${esc(p.nombre)}</strong> · ${cant(p.cantidad)} ${esc(p.unidadMedida)} · costo promedio ${dinero(p.costoPromedio)} · valor ${dinero(p.valor)}</p>
      <div class="fila-campos">
        ${campo('Tipo de movimiento', `<select id="im-concepto">${grupo('entrada', 'Entradas')}${grupo('salida', 'Salidas')}</select>`, 'dc-nombre')}
        ${campo('Fecha', `<input type="date" id="im-fecha" value="${o.hoy}" max="${o.hoy}">`)}
      </div>
      <div class="fila-campos">
        ${campo(`Cantidad (${esc(p.unidadMedida)})`, '<input type="number" id="im-cant" min="0" step="any">')}
        <span id="im-caja-costo">${campo('Costo unitario', '<input type="number" id="im-costo" min="0" step="any">')}</span>
        ${campo('Documento (opcional)', '<input type="text" id="im-doc" maxlength="60">')}
      </div>
      <label class="fx-check" id="im-caja-sinasiento" hidden><input type="checkbox" id="im-sinasiento" checked> Solo kardex (la contabilidad ya tiene este valor por su saldo de apertura)</label>
      <div id="im-caja-contra">${campo('Contrapartida contable', `<select id="im-contra"><option value="">Elegir cuenta…</option>${opcionesSelect(cuentas, '')}</select>`)}</div>
      ${campo('Observación / motivo', '<input type="text" id="im-obs" maxlength="250">')}
      <div id="im-vista"></div>`;
    abrirDialogo({
      titulo: 'Movimiento de inventario',
      cuerpo,
      ancho: true,
      guardar: {
        texto: 'Registrar',
        fn: async () => {
          const c = o.conceptos.find((x) => x.codigo === v('im-concepto'));
          const cuerpoJson = {
            productoId: p.id, concepto: c.codigo, cantidad: v('im-cant'), fecha: v('im-fecha'),
            documento: v('im-doc'), observacion: v('im-obs'),
          };
          if (c.tipo === 'entrada') cuerpoJson.costoUnitario = v('im-costo');
          if (c.sinAsiento) cuerpoJson.sinAsiento = $('im-sinasiento').checked;
          if (!(c.sinAsiento && $('im-sinasiento').checked)) cuerpoJson.contrapartida = v('im-contra');
          await api('/inventarios/movimientos', { method: 'POST', body: JSON.stringify(cuerpoJson) });
          await mostrarSub(inv.sub);
        },
      },
    });
    const refrescar = () => {
      const c = o.conceptos.find((x) => x.codigo === v('im-concepto'));
      $('im-caja-costo').hidden = c.tipo !== 'entrada';
      $('im-caja-sinasiento').hidden = !c.sinAsiento;
      const sinAsiento = c.sinAsiento && $('im-sinasiento').checked;
      $('im-caja-contra').hidden = sinAsiento;
      const caja = $('im-vista');
      const q = num('im-cant');
      if (!(q > 0)) { caja.innerHTML = ''; return; }
      const saldo = { cantidad: p.cantidad, valor: p.valor };
      let valor = 0;
      let html = '';
      try {
        if (c.tipo === 'entrada') {
          const unit = v('im-costo') !== '' ? num('im-costo') : (c.codigo === 'sobrante' || c.codigo === 'devolucion_cliente') ? (p.costoPromedio || p.ultimoCosto) : null;
          if (unit === null) { caja.innerHTML = ''; return; }
          valor = Math.round(q * unit * 100) / 100;
          const r = costeoInventario.entrada(saldo, q, valor);
          html = `Entra por ${dinero(valor)}. Quedará: ${cant(r.saldo.cantidad)} ${esc(p.unidadMedida)} · costo promedio ${dinero(r.costoPromedio)} · valor ${dinero(r.saldo.valor)}.`;
        } else {
          if (q > p.cantidad) { caja.innerHTML = aviso('bloqueo', `Solo hay ${cant(p.cantidad)} ${esc(p.unidadMedida)} en existencia.`); return; }
          const r = costeoInventario.salida(saldo, q, p.ultimoCosto || p.costoPromedio);
          valor = r.valor;
          html = `Sale por ${dinero(valor)} (al costo promedio). Quedará: ${cant(r.saldo.cantidad)} ${esc(p.unidadMedida)} · valor ${dinero(r.saldo.valor)}.`;
        }
        html = `<p class="nota-aiu">${html}</p>`;
        if (!sinAsiento && v('im-contra') && valor > 0) {
          const a = asientoInventario.armarAsientoMovimiento({ tipo: c.tipo, valor, cuentaInventario: p.cuentaInventario, contrapartida: v('im-contra') });
          html += `<table class="tabla-items-detalle"><thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead><tbody>${a.lineas.map((l) => `<tr><td>${esc(l.cuentaCodigo)}</td><td class="num">${l.debito ? dinero(l.debito) : ''}</td><td class="num">${l.credito ? dinero(l.credito) : ''}</td></tr>`).join('')}</tbody></table>`;
        }
      } catch (err) {
        html = aviso('bloqueo', esc(err.message));
      }
      caja.innerHTML = html;
    };
    const alCambiarConcepto = () => {
      const c = o.conceptos.find((x) => x.codigo === v('im-concepto'));
      $('im-contra').value = c.contrapartida && cuentas.some(([cod]) => cod === c.contrapartida) ? c.contrapartida : '';
      refrescar();
    };
    $('im-concepto').addEventListener('change', alCambiarConcepto);
    ['im-cant', 'im-costo', 'im-contra', 'im-sinasiento'].forEach((id) => { $(id).addEventListener('input', refrescar); $(id).addEventListener('change', refrescar); });
    $('im-concepto').value = 'consumo';
    alCambiarConcepto();
  }

  // ===================================================================================
  // KARDEX
  // ===================================================================================
  let kardexActual = { id: null, desde: '', hasta: '' };

  async function abrirKardex(id, desde, hasta) {
    try {
      kardexActual = { id, desde: desde || '', hasta: hasta || '' };
      const k = await api(`/inventarios/productos/${id}/kardex?${query({ desde: kardexActual.desde, hasta: kardexActual.hasta })}`);
      const p = k.producto;
      let cuerpo = `<div class="inv-barra">
          <span class="texto-suave">Desde</span><input type="date" id="ik-desde" value="${esc(kardexActual.desde)}">
          <span class="texto-suave">hasta</span><input type="date" id="ik-hasta" value="${esc(kardexActual.hasta)}">
          ${boton('Aplicar', 'kardex-filtrar', {})}
          ${boton('Descargar CSV', 'kardex-csv', {})}
        </div>
        <div class="inv-tarjetas">
          <div class="inv-tarjeta"><span>Existencias</span><strong>${cant(p.cantidad)} ${esc(p.unidadMedida)}</strong></div>
          <div class="inv-tarjeta"><span>Costo promedio</span><strong>${dinero(p.costoPromedio)}</strong></div>
          <div class="inv-tarjeta destacada"><span>Valor</span><strong>${dinero(p.valor)}</strong></div>
          <div class="inv-tarjeta"><span>Cuentas</span><strong>${esc(p.cuentaInventario)} / ${esc(p.cuentaCosto)}</strong></div></div>`;
      if (p.negativo) cuerpo += aviso('confirmar', 'El saldo está en negativo: se vendió más de lo registrado. Se corrige al cargar la factura de compra o con un saldo inicial.');
      cuerpo += `<div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Movimiento</th><th>Documento</th><th class="num">Entra</th><th class="num">Sale</th><th class="num">Saldo</th><th class="num">Costo prom.</th><th class="num">Valor saldo</th><th></th></tr></thead><tbody>`;
      cuerpo += `<tr><td colspan="5"><em>Saldo al empezar el rango</em></td><td class="num">${cant(k.saldoInicial.cantidad)}</td><td></td><td class="num">${dinero(k.saldoInicial.valor)}</td><td></td></tr>`;
      for (const m of k.movimientos) {
        const detalle = [ORIGENES[m.origenTipo] || m.origenTipo, m.observacion].filter(Boolean).join(' · ');
        const marcas = [];
        if (m.sinExistencias) marcas.push('<span class="badge rechazado">sin existencias</span>');
        if (m.anulado) marcas.push('<span class="badge">anulado</span>');
        const puedeAnularEste = puedeAnular() && !m.anulado && m.origenTipo === 'manual' && m.id === k.ultimoMovimientoId;
        cuerpo += `<tr class="${m.anulado ? 'inv-anulado' : ''}"><td>${esc(formatoFecha(m.fecha))}</td>
          <td>${esc(m.conceptoTexto)}${marcas.length ? ' ' + marcas.join(' ') : ''}<br><span class="texto-suave">${esc(detalle)}</span></td>
          <td>${esc(m.documento || '—')}</td>
          <td class="num">${m.tipo === 'entrada' ? cant(m.cantidad) + '<br><span class="texto-suave">' + dinero(m.valor) + '</span>' : ''}</td>
          <td class="num">${m.tipo === 'salida' ? cant(m.cantidad) + '<br><span class="texto-suave">' + dinero(m.valor) + '</span>' : ''}</td>
          <td class="num">${m.anulado ? '' : cant(m.saldoCantidad)}</td>
          <td class="num">${m.anulado ? '' : dinero(m.saldoCosto)}</td>
          <td class="num">${m.anulado ? '' : dinero(m.saldoValor)}</td>
          <td class="acciones">${puedeAnularEste ? boton('Anular', 'anular-mov', { id: m.id }) : ''}</td></tr>`;
      }
      if (!k.movimientos.length) cuerpo += '<tr><td colspan="9" class="vacio">Sin movimientos en este rango.</td></tr>';
      cuerpo += `</tbody><tfoot><tr><td colspan="3"><strong>Totales del rango</strong></td><td class="num">${cant(k.totales.entradasCantidad)}<br>${dinero(k.totales.entradasValor)}</td><td class="num">${cant(k.totales.salidasCantidad)}<br>${dinero(k.totales.salidasValor)}</td><td colspan="4"></td></tr></tfoot></table></div>`;
      abrirDialogo({ titulo: `Kardex · ${p.nombre}`, cuerpo, ancho: true });
    } catch (err) {
      mostrarError(err);
    }
  }

  function dialogoAnular(movId) {
    abrirDialogo({
      titulo: 'Anular movimiento',
      cuerpo: `<p class="nota-aiu">Se deshace el movimiento: el producto vuelve al saldo anterior y, si tenía asiento contable, queda anulado. Solo se puede anular el último movimiento manual de un producto.</p>
        ${campo('Motivo (mínimo 10 letras)', '<input type="text" id="ia-motivo" maxlength="250">')}`,
      guardar: {
        texto: 'Anular movimiento',
        fn: async () => {
          await api(`/inventarios/movimientos/${movId}/anular`, { method: 'POST', body: JSON.stringify({ motivo: v('ia-motivo') }) });
          await abrirKardex(kardexActual.id, kardexActual.desde, kardexActual.hasta);
          if (inv.sub === 'productos') cargarProductos().then(renderProductos).catch(() => {});
          return false;
        },
      },
    });
  }

  // ===================================================================================
  // MOVIMIENTOS (lista general)
  // ===================================================================================
  async function cargarMovimientos() {
    if (!inv.productos.length) await cargarProductos();
    const f = inv.movFiltros;
    const r = await api(`/inventarios/movimientos?${query(f)}`);
    const conceptos = [['', 'Todos los tipos'], ...Object.entries({ compra: 'Compra (factura)', venta: 'Venta (factura)' }), ...inv.opciones.conceptos.map((c) => [c.codigo, c.nombre])];
    let html = `<div class="inv-barra">
      <select id="im-f-producto">${opcionesSelect([['', 'Todos los productos'], ...inv.productos.map((p) => [p.id, `${p.codigo ? p.codigo + ' · ' : ''}${p.nombre}`])], f.productoId)}</select>
      <select id="im-f-concepto">${opcionesSelect(conceptos, f.concepto)}</select>
      <span class="texto-suave">Desde</span><input type="date" id="im-f-desde" value="${esc(f.desde)}">
      <span class="texto-suave">hasta</span><input type="date" id="im-f-hasta" value="${esc(f.hasta)}">
      ${boton('Filtrar', 'filtrar-movimientos', {})}
    </div>`;
    if (r.truncado) html += aviso('info', `Se muestran los últimos ${r.limite} movimientos; usa los filtros para acotar.`);
    if (!r.movimientos.length) html += '<p class="vacio">No hay movimientos con este filtro.</p>';
    else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Producto</th><th>Movimiento</th><th>Documento</th><th class="num">Cantidad</th><th class="num">Valor</th><th>Origen</th><th></th></tr></thead><tbody>
      ${r.movimientos.map((m) => `<tr class="${m.anulado ? 'inv-anulado' : ''}"><td>${esc(formatoFecha(m.fecha))}</td>
        <td><strong>${esc(m.producto || '')}</strong>${m.codigo ? `<br><span class="texto-suave">${esc(m.codigo)}</span>` : ''}</td>
        <td>${esc(m.conceptoTexto)}${m.sinExistencias ? ' <span class="badge rechazado">sin existencias</span>' : ''}${m.anulado ? ' <span class="badge">anulado</span>' : ''}</td>
        <td>${esc(m.documento || '—')}</td>
        <td class="num">${m.tipo === 'salida' ? '−' : '+'}${cant(m.cantidad)} ${esc(m.unidadMedida || '')}</td>
        <td class="num">${dinero(m.valor)}</td>
        <td>${esc(ORIGENES[m.origenTipo] || m.origenTipo)}</td>
        <td class="acciones">${boton('Kardex', 'kardex', { id: m.productoId })}</td></tr>`).join('')}</tbody></table></div>`;
    }
    contenido().innerHTML = html;
  }

  // ===================================================================================
  // VALORACIÓN
  // ===================================================================================
  async function cargarValoracion() {
    const r = await api(`/inventarios/valoracion?${query({ corte: inv.corte })}`);
    let html = `<div class="inv-barra">
      <span class="texto-suave">Inventario valorado al</span><input type="date" id="iv-corte" value="${esc(r.corte)}" max="${esc(inv.opciones.hoy)}">
      ${boton('Calcular', 'calcular-valoracion', {})}
      ${boton('Descargar CSV', 'valoracion-csv', {})}
    </div>`;
    html += `<div class="inv-tarjetas"><div class="inv-tarjeta destacada"><span>Valor total del inventario</span><strong>${dinero(r.total)}</strong></div>
      <div class="inv-tarjeta"><span>Productos con existencias</span><strong>${r.productos.length}</strong></div></div>`;
    html += '<h4 class="inv-sec-titulo">Kardex contra contabilidad</h4>';
    if (!r.conciliacion.length) html += '<p class="vacio">Todavía no hay valores en inventario ni en la contabilidad.</p>';
    else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Cuenta</th><th class="num">Según el kardex</th><th class="num">Según la contabilidad</th><th class="num">Diferencia</th></tr></thead><tbody>
      ${r.conciliacion.map((c) => `<tr><td><strong>${esc(c.cuenta)}</strong> ${esc(c.nombre)}</td><td class="num">${dinero(c.kardex)}</td><td class="num">${dinero(c.contabilidad)}</td>
        <td class="num ${Math.abs(c.diferencia) < 0.005 ? 'inv-dif-ok' : 'inv-dif-mal'}">${Math.abs(c.diferencia) < 0.005 ? 'cuadra' : dinero(c.diferencia)}</td></tr>`).join('')}</tbody></table></div>`;
      html += r.cuadra
        ? aviso('info', 'El kardex coincide con la contabilidad de inventarios.')
        : aviso('confirmar', 'Hay diferencia entre el kardex y la contabilidad. Causas comunes: existencias iniciales cargadas solo al kardex (el saldo contable de apertura no está en el sistema), compras llevadas a inventario sin enlazar a un producto, o asientos manuales a cuentas 14xx. Revisa el kardex de los productos y el libro auxiliar de la cuenta.');
    }
    html += '<h4 class="inv-sec-titulo">Detalle por producto</h4>';
    if (!r.productos.length) html += '<p class="vacio">No hay productos con existencias a esta fecha.</p>';
    else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Código</th><th>Producto</th><th>Cuenta</th><th class="num">Cantidad</th><th class="num">Costo promedio</th><th class="num">Valor</th></tr></thead><tbody>
      ${r.productos.map((p) => `<tr><td>${esc(p.codigo || '—')}</td><td>${esc(p.nombre)}${p.negativo ? ' <span class="badge rechazado">negativo</span>' : ''}</td><td>${esc(p.cuentaInventario)}</td>
        <td class="num">${cant(p.cantidad)} ${esc(p.unidadMedida)}</td><td class="num">${dinero(p.costoPromedio)}</td><td class="num">${dinero(p.valor)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5"><strong>Total</strong></td><td class="num"><strong>${dinero(r.total)}</strong></td></tr></tfoot></table></div>`;
    }
    contenido().innerHTML = html;
  }

  // ===================================================================================
  // Puente con los diálogos de factura de compra y de venta
  // ===================================================================================
  const textoProducto = (p) => `${p.codigo ? p.codigo + ' · ' : ''}${p.nombre} (${cant(p.cantidad)} ${p.unidadMedida})`;
  window.invFacturas = {
    // Selector del producto de una línea. En compras solo se muestra si la línea va a una cuenta 14xx.
    htmlSelect(origen, i, inventario) {
      if (!inventario) return '';
      const prods = inventario.productos || [];
      const sug = (inventario.sugerencias || [])[i] || {};
      const sugerido = prods.find((p) => p.id === sug.productoId);
      if (origen === 'compra') {
        const auto = sugerido ? `Automático: «${sugerido.nombre}» (por ${sug.motivo})` : 'Automático: crear producto nuevo';
        const pares = [['', auto], ['nuevo', 'Crear producto nuevo'], ...prods.map((p) => [p.id, textoProducto(p)])];
        return `<div class="inv-linea" data-inv-linea="${i}" hidden><small>Producto en inventario</small><select class="fx-producto-linea" data-linea="${i}">${opcionesSelect(pares, '')}</select></div>`;
      }
      if (!prods.length) return '';
      const pares = [['ninguno', 'Sin descargar inventario'], ...prods.map((p) => [p.id, textoProducto(p)])];
      return `<div class="inv-linea"><small>Descarga inventario de</small><select class="vx-producto-linea" data-linea="${i}">${opcionesSelect(pares, sugerido ? sugerido.id : 'ninguno')}</select></div>`;
    },
    // Muestra el selector solo en las líneas de compra cuya cuenta es de inventario.
    alternarCompra() {
      document.querySelectorAll('.fx-cuenta-linea').forEach((sel) => {
        const caja = document.querySelector(`.inv-linea[data-inv-linea="${sel.dataset.linea}"]`);
        if (caja) caja.hidden = !String(sel.value).startsWith('14');
      });
    },
    // Mapa línea -> elección, solo de lo que se ve.
    leer(prefijo) {
      const mapa = {};
      document.querySelectorAll(`.${prefijo}-producto-linea`).forEach((sel) => {
        if (sel.closest('.inv-linea').hidden) return;
        mapa[Number(sel.dataset.linea)] = sel.value;
      });
      return mapa;
    },
    avisos(origen, resultado) {
      if (!resultado) return [];
      const out = [];
      const n = (resultado.movimientos || []).length;
      if (n && origen === 'compra') out.push(`Inventario: ${n} línea${n === 1 ? '' : 's'} dieron entrada al kardex.`);
      if (n && origen === 'venta') out.push(`Inventario: ${n} línea${n === 1 ? '' : 's'} descargadas, costo de ventas ${formatoDineroDec(resultado.costoTotal || 0)}.`);
      return out.concat(resultado.advertencias || []);
    },
  };

  // ===================================================================================
  // Eventos
  // ===================================================================================
  $('inv-subtabs').innerHTML = SUBS.map(([k, t]) => `<button type="button" data-sub="${k}">${t}</button>`).join('');
  $('inv-subtabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (b) mostrarSub(b.dataset.sub);
  });

  let temporizadorBusqueda = null;
  $('panel-inventarios').addEventListener('input', (e) => {
    if (e.target.id !== 'inv-buscar') return;
    inv.filtros.q = e.target.value;
    clearTimeout(temporizadorBusqueda);
    temporizadorBusqueda = setTimeout(async () => {
      try {
        await cargarProductos();
        const pos = e.target.selectionStart;
        renderProductos();
        const nuevo = $('inv-buscar');
        nuevo.focus();
        nuevo.setSelectionRange(pos, pos);
      } catch (err) { mostrarError(err); }
    }, 300);
  });
  $('panel-inventarios').addEventListener('change', async (e) => {
    if (e.target.id !== 'inv-estado') return;
    inv.filtros.estado = e.target.value;
    try { await cargarProductos(); renderProductos(); } catch (err) { mostrarError(err); }
  });

  function alClic(e) {
    const b = e.target.closest('[data-inv]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.inv) {
      case 'nuevo-producto': return dialogoProducto(null);
      case 'editar-producto': return dialogoProducto(inv.productos.find((p) => p.id === id));
      case 'nuevo-movimiento': return dialogoMovimiento(id);
      case 'kardex': return abrirKardex(id, '', '');
      case 'kardex-filtrar': return abrirKardex(kardexActual.id, v('ik-desde'), v('ik-hasta'));
      case 'kardex-csv': return descargar(`/api/inventarios/productos/${kardexActual.id}/kardex.csv?${query({ desde: v('ik-desde'), hasta: v('ik-hasta') })}`, 'kardex.csv');
      case 'anular-mov': return dialogoAnular(id);
      case 'filtrar-movimientos':
        inv.movFiltros = { productoId: v('im-f-producto'), concepto: v('im-f-concepto'), desde: v('im-f-desde'), hasta: v('im-f-hasta') };
        return mostrarSub('movimientos');
      case 'calcular-valoracion':
        inv.corte = v('iv-corte') || inv.opciones.hoy;
        return mostrarSub('valoracion');
      case 'valoracion-csv': return descargar(`/api/inventarios/valoracion.csv?${query({ corte: v('iv-corte') || inv.corte })}`, 'inventario-valorado.csv');
    }
  }
  $('panel-inventarios').addEventListener('click', alClic);
  $('inv-dialogo-cuerpo').addEventListener('click', alClic);

  // Lo llama app.js cada vez que se abre la pestaña Inventarios.
  window.inventariosAlMostrar = function () {
    inv.opciones = null;
    mostrarSub(inv.sub);
  };
})();
