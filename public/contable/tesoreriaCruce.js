// Tesorería · Cruce de pagos.
//
// Va en su propio archivo y se carga DESPUÉS de app.js: usa sus ayudas globales (api, usuario,
// escHtml, formatoDineroDec, formatoFecha, cargarTodo).
//
// Qué hace: muestra la cartera por pagar (facturas de compra y documentos soporte) y por cobrar
// (facturas de venta) con su saldo y vencimiento, y permite registrar el pago o el recaudo contra cada
// documento (completo o por abonos, uno o varios a la vez). Cada pago se contabiliza (Dr 2205/2335 –
// Cr banco; Dr banco – Cr 1305), crea o enlaza el movimiento bancario y queda cruzado con el documento.
// También aplica el descuento de aportes de un contratista y deja anular un pago con su motivo.
// Al cobrar una factura de venta se anotan las retenciones que el cliente practicó (ReteFuente, ReteIVA,
// ReteICA): el banco recibe el valor menos lo retenido, y la pestaña «Retenciones sufridas» las resume por
// cliente para las declaraciones. Las estampillas, tasas y contribuciones que descuenta una entidad pública (según el
// estatuto de rentas local) se anotan aparte en cada factura: no son anticipo de impuestos sino gasto o costo, y van a
// la cuenta que elijas (por defecto 5195).
(function () {
  if (!document.getElementById('panel-tesoreria')) return;
  const SUBS = [['pagar', 'Por pagar'], ['cobrar', 'Por cobrar'], ['historial', 'Pagos y recaudos'], ['retenciones', 'Retenciones sufridas']];
  const RETENCIONES = [['retefuente', 'ReteFuente'], ['reteiva', 'ReteIVA'], ['reteica', 'ReteICA']];
  const TIPO_PAGO = { pago: 'Pago', recaudo: 'Recaudo', descuento: 'Descuento' };
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  const T = { sub: 'pagar', cartera: {}, buscar: '', todos: false, pagos: [], filtro: { tipo: '', estado: '' }, cuentas: null, ret: { desde: '', hasta: '', datos: null } };

  const $ = (id) => document.getElementById(id);
  const esc = (x) => escHtml(x);
  const dinero = (x) => formatoDineroDec(x);
  const puedeRegistrar = () => !!usuario && ['contador', 'dueño', 'auxiliar'].includes(usuario.rol);
  const puedeAnular = () => !!usuario && ['contador', 'dueño'].includes(usuario.rol);
  const aviso = (tipo, texto) => `<p class="fx-aviso ${tipo}">${texto}</p>`;
  const mostrarError = (err) => alert(err && err.message ? err.message : String(err));
  const redondear = (n) => Math.round(Number(n || 0) * 100) / 100;
  const campo = (etiqueta, html, clase) => `<label class="campo-etiquetado ${clase || ''}"><span>${etiqueta}</span>${html}</label>`;
  const opcionesSelect = (pares, elegido) => pares.map(([val, txt]) => `<option value="${esc(val)}"${String(val) === String(elegido) ? ' selected' : ''}>${esc(txt)}</option>`).join('');
  const v = (id) => ($(id) ? $(id).value : '');
  const num = (valor) => {
    const n = Number(String(valor == null ? '' : valor).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  function boton(texto, nombre, datos, clase) {
    const attrs = Object.entries(datos || {}).map(([k, val]) => `data-${k}="${esc(val)}"`).join(' ');
    return `<button type="button" class="${clase || 'btn-accion'}" data-tes="${nombre}" ${attrs}>${texto}</button>`;
  }
  const contenido = () => $('tes-contenido');
  const fecha = (f) => (f ? formatoFecha(f) : '—');

  // --- Diálogo genérico ----------------------------------------------------------
  let dialogoActual = null;
  function abrirDialogo({ titulo, cuerpo, guardar, ancho }) {
    const dlg = $('dialogo-tes');
    $('titulo-tes').textContent = titulo;
    $('tes-dialogo-cuerpo').innerHTML = cuerpo;
    $('tes-dialogo-error').hidden = true;
    $('tes-dialogo-cuerpo').onchange = null;
    $('tes-dialogo-cuerpo').oninput = null;
    $('tes-dialogo-cuerpo').onclick = null;
    dlg.classList.toggle('dialogo-chico', !ancho);
    const btn = $('btn-tes-guardar');
    btn.hidden = !guardar;
    btn.disabled = false;
    btn.textContent = guardar ? guardar.texto : 'Guardar';
    dialogoActual = { guardar };
    if (!dlg.open) dlg.showModal();
  }
  function cerrarDialogo() {
    const dlg = $('dialogo-tes');
    if (dlg.open) dlg.close();
    dialogoActual = null;
  }
  function errorDialogo(mensaje) {
    const el = $('tes-dialogo-error');
    el.textContent = mensaje;
    el.hidden = !mensaje;
  }
  $('btn-cerrar-tes').addEventListener('click', cerrarDialogo);
  $('btn-tes-cancelar').addEventListener('click', cerrarDialogo);
  $('btn-tes-guardar').addEventListener('click', async () => {
    if (!dialogoActual || !dialogoActual.guardar) return;
    const btn = $('btn-tes-guardar');
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

  // --- Carga ----------------------------------------------------------------------
  async function cargarCartera(tipo) {
    T.cartera[tipo] = await api(`/tesoreria/cartera?tipo=${tipo}${T.todos ? '&todos=1' : ''}`);
    return T.cartera[tipo];
  }

  async function mostrarSub(sub) {
    T.sub = sub;
    document.querySelectorAll('#tes-subtabs button').forEach((b) => b.classList.toggle('activo', b.dataset.sub === sub));
    try {
      if (sub === 'historial') {
        const q = ['tipo', 'estado'].filter((k) => T.filtro[k]).map((k) => `${k}=${encodeURIComponent(T.filtro[k])}`).join('&');
        T.pagos = await api('/tesoreria/pagos' + (q ? '?' + q : ''));
        return renderHistorial();
      }
      if (sub === 'retenciones') return await cargarRetenciones();
      await cargarCartera(sub);
      renderCartera(sub);
    } catch (err) {
      contenido().innerHTML = aviso('bloqueo', esc(err.message || err));
    }
  }

  // ===================================================================================
  // CARTERA
  // ===================================================================================
  function renderCartera(sub) {
    const c = T.cartera[sub];
    const r = c.resumen;
    const porPagar = sub === 'pagar';
    let html = `<div class="inv-tarjetas">
      <div class="inv-tarjeta destacada"><span>${porPagar ? 'Total por pagar' : 'Total por cobrar'}</span><strong>${dinero(r.total)}</strong></div>
      <div class="inv-tarjeta${r.vencido ? ' alerta' : ''}"><span>Vencido</span><strong>${dinero(r.vencido)}</strong></div>
      <div class="inv-tarjeta"><span>Al día</span><strong>${dinero(r.porVencer)}</strong></div>
      <div class="inv-tarjeta"><span>Documentos con saldo</span><strong>${r.documentos}</strong></div></div>`;
    html += `<p class="nota-panel">Vencido por edad: 1–30 días <strong>${dinero(r.edades.de1a30)}</strong> · 31–60 días <strong>${dinero(r.edades.de31a60)}</strong> · 61–90 días <strong>${dinero(r.edades.de61a90)}</strong> · más de 90 días <strong>${dinero(r.edades.masDe90)}</strong>.</p>`;
    html += `<div class="inv-barra">
      <input type="search" id="tes-buscar" placeholder="Buscar por tercero o número" value="${esc(T.buscar)}">
      <label class="fx-check"><input type="checkbox" id="tes-todos"${T.todos ? ' checked' : ''}> Incluir los ya pagados</label>
      ${puedeRegistrar() ? boton(porPagar ? '+ Registrar pago' : '+ Registrar recaudo', 'nuevo-pago', {}, 'btn-primario') : ''}
    </div>`;
    html += '<div id="tes-tabla-cartera"></div>';
    contenido().innerHTML = html;
    renderTablaCartera(sub);
  }

  function renderTablaCartera(sub) {
    const c = T.cartera[sub];
    const q = T.buscar.trim().toLowerCase();
    const filas = c.documentos.filter((d) => !q || `${d.terceroNombre} ${d.terceroIdentificacion} ${d.numero}`.toLowerCase().includes(q));
    const porPagar = sub === 'pagar';
    if (!filas.length) {
      $('tes-tabla-cartera').innerHTML = `<p class="vacio">${c.documentos.length ? 'Ningún documento coincide con la búsqueda.' : (porPagar ? 'No hay facturas ni documentos soporte con saldo por pagar.' : 'No hay facturas de venta con saldo por cobrar.')}</p>`;
      return;
    }
    $('tes-tabla-cartera').innerHTML = `<div class="tabla-envoltorio"><table><thead><tr><th>Documento</th><th>${porPagar ? 'Proveedor' : 'Cliente'}</th><th>Fecha</th><th>Vence</th><th class="num">Valor</th><th class="num">${porPagar ? 'Pagado' : 'Cobrado'}</th><th class="num">Saldo</th><th></th></tr></thead><tbody>
      ${filas.map((d) => {
        const vence = d.saldo > 0 && d.vencida ? `${esc(fecha(d.fechaVencimiento))}<br><span class="badge rechazado">vencida ${d.diasVencido} d</span>` : esc(fecha(d.fechaVencimiento));
        const acc = [];
        if (puedeRegistrar() && d.pagable) {
          acc.push(boton(porPagar ? 'Pagar' : 'Cobrar', 'pagar-doc', { tipo: d.docTipo, id: d.docId }));
          if (porPagar) acc.push(boton('Descuento de aportes', 'descuento-doc', { tipo: d.docTipo, id: d.docId }));
        } else if (d.saldo > 0 && d.motivoNoPagable) {
          acc.push(`<span class="texto-suave">${esc(d.motivoNoPagable)}</span>`);
        }
        if (d.pagado > 0) acc.push(boton('Ver pagos', 'ver-pagos-doc', { tipo: d.docTipo, id: d.docId }));
        return `<tr><td><strong>${esc(d.numero)}</strong><br><span class="texto-suave">${esc(d.etiqueta)}</span></td>
          <td>${esc(d.terceroNombre)}<br><span class="texto-suave">${esc(d.terceroIdentificacion)}</span></td>
          <td>${esc(fecha(d.fecha))}</td><td>${vence}</td><td class="num">${dinero(d.neto)}${d.retenido > 0 ? `<br><span class="texto-suave">ya descontados ${dinero(d.retenido)} de retenciones</span>` : ''}</td><td class="num">${dinero(d.pagado)}</td>
          <td class="num"><strong>${dinero(d.saldo)}</strong></td><td class="acciones">${acc.join(' ')}</td></tr>`;
      }).join('')}
    </tbody></table></div>`;
  }

  // ===================================================================================
  // HISTORIAL
  // ===================================================================================
  // " · ReteFuente $70.000 · ReteICA $7.000" de una aplicación (vacío si no hay retenciones).
  function textoRetenciones(a) {
    const otros = (a.otrosDescuentos || []).map((o) => ` · ${o.concepto} ${dinero(o.valor)}`).join('');
    return RETENCIONES.filter(([k]) => a[k] > 0).map(([k, t]) => ` · ${t} ${dinero(a[k])}`).join('') + otros;
  }

  function textoMedio(p) {
    if (p.tipo === 'descuento') return 'Sin movimiento de dinero';
    return p.medio === 'caja' ? 'Efectivo (caja)' : esc(p.cuentaTexto || 'Banco');
  }

  function renderHistorial() {
    let html = `<div class="inv-barra">
      <select id="tes-f-tipo" aria-label="Tipo">${opcionesSelect([['', 'Todos los tipos'], ['pago', 'Pagos'], ['recaudo', 'Recaudos'], ['descuento', 'Descuentos']], T.filtro.tipo)}</select>
      <select id="tes-f-estado" aria-label="Estado">${opcionesSelect([['', 'Activos y anulados'], ['activo', 'Solo activos'], ['anulado', 'Solo anulados']], T.filtro.estado)}</select>
    </div>`;
    if (!T.pagos.length) {
      html += '<p class="vacio">Todavía no hay pagos ni recaudos cruzados con documentos.</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Tercero</th><th>Documentos</th><th>Medio</th><th>Referencia</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>
      ${T.pagos.map((p) => `<tr><td>${esc(fecha(p.fecha))}</td><td>${TIPO_PAGO[p.tipo] || esc(p.tipo)}</td><td>${esc(p.terceroNombre)}</td>
        <td>${p.aplicaciones.map((a) => `${esc(a.numero)} <span class="texto-suave">${dinero(a.valor)}${textoRetenciones(a)}</span>`).join('<br>')}</td>
        <td>${textoMedio(p)}</td><td>${esc(p.referencia || '—')}</td><td class="num">${dinero(p.valor)}${p.retenciones > 0 ? `<br><span class="texto-suave">+ ${dinero(p.retenciones)} retenido</span>` : ''}${p.otrosDescuentos > 0 ? `<br><span class="texto-suave">+ ${dinero(p.otrosDescuentos)} en estampillas y tasas</span>` : ''}</td>
        <td>${p.estado === 'anulado' ? `<span class="badge rechazado">anulado</span><br><span class="texto-suave">${esc(p.motivoAnulacion || '')}</span>` : '<span class="badge conciliado">activo</span>'}</td>
        <td class="acciones">${p.estado === 'activo' && puedeAnular() ? boton('Anular', 'anular-pago', { id: p.id }, 'btn-accion destructivo') : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    }
    contenido().innerHTML = html;
  }

  // ===================================================================================
  // REGISTRAR PAGO / RECAUDO
  // ===================================================================================
  // opciones: { sub, terceroId, docId, movimiento }
  async function dialogoPago(opciones) {
    const sub = opciones.sub;
    const porPagar = sub === 'pagar';
    const tipoMov = porPagar ? 'egreso' : 'ingreso';
    const [cartera, libres, cuentas, plan] = await Promise.all([
      cargarCartera(sub), api('/tesoreria/movimientos-libres'), api('/tesoreria/cuentas'), porPagar ? Promise.resolve([]) : api('/plan-cuentas'),
    ]);
    T.cuentas = cuentas;
    // Cuentas donde pueden registrarse estampillas, tasas y contribuciones: gasto o costo, activas y que no sean "padre" de otras.
    const padres = new Set(plan.map((c) => c.cuentaPadreId).filter(Boolean));
    const cuentasOtros = plan.filter((c) => c.activa && c.naturaleza === 'debito' && ['gasto', 'costo'].includes(c.elementoNiif) && !padres.has(c.id));
    const cuenta5195 = plan.find((c) => c.codigo === '5195');
    const opcionesOtros = `<option value="">${cuenta5195 ? esc(`${cuenta5195.codigo} · ${cuenta5195.nombre}`) : '5195 · Diversos (administración)'}</option>`
      + cuentasOtros.filter((c) => c.codigo !== '5195').map((c) => `<option value="${esc(c.id)}">${esc(c.codigo)} · ${esc(c.nombre)}</option>`).join('');
    const pagables = cartera.documentos.filter((d) => d.pagable);
    const mov = opciones.movimiento ? libres.find((m) => m.id === opciones.movimiento) : null;
    if (opciones.movimiento && !mov) throw new Error('Ese movimiento ya no está disponible para cruzar.');
    if (!pagables.length) throw new Error(porPagar ? 'No hay facturas ni documentos soporte con saldo para pagar.' : 'No hay facturas de venta con saldo para cobrar.');
    const terceros = [];
    for (const d of pagables) if (!terceros.some((t) => t[0] === d.terceroId)) terceros.push([d.terceroId, `${d.terceroNombre}${d.terceroIdentificacion ? ' · ' + d.terceroIdentificacion : ''}`]);
    terceros.sort((a, b) => a[1].localeCompare(b[1], 'es'));
    let terceroId = opciones.terceroId || (opciones.docId ? (pagables.find((d) => d.docId === opciones.docId) || {}).terceroId : '') || '';
    const cuentaInicial = mov ? mov.cuentaBancariaId : (cuentas[0] ? cuentas[0].id : '');
    const medioInicial = mov || cuentas.length ? 'banco' : 'caja';

    const cuerpo = `
      ${campo(porPagar ? 'Proveedor' : 'Cliente', `<select id="tp-tercero"><option value="">Elige…</option>${opcionesSelect(terceros, terceroId)}</select>`)}
      <div class="fila-campos">
        ${campo('Fecha', `<input type="date" id="tp-fecha" value="${esc(mov ? mov.fecha : cartera.hoy)}" max="2099-12-31">`)}
        ${campo(porPagar ? 'Sale de' : 'Entra a', `<select id="tp-medio">${opcionesSelect([['banco', 'Cuenta bancaria'], ['caja', 'Efectivo (caja)']], medioInicial)}</select>`)}
        ${campo('Cuenta bancaria', `<select id="tp-cuenta">${opcionesSelect(cuentas.map((c) => [c.id, `${c.banco} · ${c.numero}`]), cuentaInicial)}</select>`, 'tp-banco')}
      </div>
      ${campo('Movimiento del banco', '<select id="tp-movimiento"></select>', 'tp-banco')}
      <div class="fila-campos">
        ${campo('Referencia (opcional)', '<input type="text" id="tp-referencia" maxlength="60" placeholder="Nº de transferencia, cheque…" autocomplete="off">')}
        ${campo('Observaciones (opcional)', '<input type="text" id="tp-observaciones" maxlength="250" autocomplete="off">', 'dc-nombre')}
      </div>
      <h4 class="inv-sec-titulo">Documentos que ${porPagar ? 'paga' : 'cobra'}</h4>
      <div id="tp-docs"></div>
      <p id="tp-total" class="nota-aiu"></p>`;

    abrirDialogo({
      titulo: porPagar ? 'Registrar pago a proveedor' : 'Registrar recaudo de cliente', cuerpo, ancho: true,
      guardar: {
        texto: porPagar ? 'Registrar pago' : 'Registrar recaudo',
        fn: async () => {
          const aplicaciones = [...document.querySelectorAll('#tp-docs input[data-doc]:checked')].map((chk) => {
            const ap = { docTipo: chk.dataset.tipo, docId: chk.dataset.doc, valor: num(document.querySelector(`#tp-docs input[data-valor="${chk.dataset.doc}"]`).value) };
            if (!porPagar) {
              for (const [k] of RETENCIONES) ap[k] = num(retInput(chk.dataset.doc, k).value);
              ap.otros = [...document.querySelectorAll(`#tp-docs .tp-otro[data-doc-otro="${chk.dataset.doc}"]`)].map((f) => ({
                concepto: f.querySelector('[data-otro="concepto"]').value, cuentaId: f.querySelector('[data-otro="cuenta"]').value || null,
                valor: num(f.querySelector('[data-otro="valor"]').value),
              }));
            }
            return ap;
          });
          const banco = v('tp-medio') === 'banco';
          await api('/tesoreria/pagos', {
            method: 'POST',
            body: JSON.stringify({
              tipo: porPagar ? 'pago' : 'recaudo', terceroId: v('tp-tercero'), fecha: v('tp-fecha'), medio: v('tp-medio'),
              cuentaBancariaId: banco ? v('tp-cuenta') : null, movimientoBancarioId: banco && v('tp-movimiento') ? v('tp-movimiento') : null,
              referencia: v('tp-referencia'), observaciones: v('tp-observaciones'), aplicaciones,
            }),
          });
          await refrescarTodo();
        },
      },
    });

    const retInput = (docId, k) => document.querySelector(`#tp-docs input[data-ret="${k}"][data-doc-ret="${docId}"]`);
    const movimientoElegido = () => libres.find((m) => m.id === v('tp-movimiento')) || null;

    function pintarMovimientos() {
      const cuentaId = v('tp-cuenta');
      const candidatos = libres.filter((m) => m.tipo === tipoMov && m.cuentaBancariaId === cuentaId);
      const previo = mov && mov.cuentaBancariaId === cuentaId ? mov.id : '';
      $('tp-movimiento').innerHTML = `<option value="">Crear el movimiento al guardar</option>` + candidatos.map((m) => `<option value="${esc(m.id)}"${m.id === previo ? ' selected' : ''}>${esc(fecha(m.fecha))} · ${esc(dinero(m.valor))} · ${esc(m.descripcion || 'sin descripción')}</option>`).join('');
    }

    function pintarBanco() {
      const banco = v('tp-medio') === 'banco';
      document.querySelectorAll('#dialogo-tes .tp-banco').forEach((el) => { el.hidden = !banco; });
    }

    function pintarDocs() {
      const tid = v('tp-tercero');
      const docs = pagables.filter((d) => d.terceroId === tid);
      if (!tid) { $('tp-docs').innerHTML = '<p class="texto-suave">Elige primero el tercero.</p>'; return totalizar(); }
      $('tp-docs').innerHTML = `<div class="tabla-envoltorio"><table><thead><tr><th></th><th>Documento</th><th>Vence</th><th class="num">Saldo</th><th class="num">Valor a aplicar</th>${porPagar ? '' : RETENCIONES.map(([, t]) => `<th class="num">${t}</th>`).join('')}</tr></thead><tbody>
        ${docs.map((d) => {
          const marcado = opciones.docId === d.docId;
          return `<tr><td><input type="checkbox" data-doc="${esc(d.docId)}" data-tipo="${esc(d.docTipo)}" data-saldo="${d.saldo}" aria-label="Incluir ${esc(d.numero)}"${marcado ? ' checked' : ''}></td>
          <td>${esc(d.numero)}<br><span class="texto-suave">${esc(d.etiqueta)}</span></td><td>${esc(fecha(d.fechaVencimiento))}${d.vencida ? ` <span class="badge rechazado">${d.diasVencido} d</span>` : ''}</td>
          <td class="num">${dinero(d.saldo)}</td>
          <td class="num"><input type="number" min="0" step="0.01" data-valor="${esc(d.docId)}" value="${marcado ? d.saldo : ''}" ${marcado ? '' : 'disabled'} aria-label="Valor a aplicar a ${esc(d.numero)}"></td>
          ${porPagar ? '' : RETENCIONES.map(([k, t]) => `<td class="num"><input type="number" class="tp-ret" min="0" step="0.01" data-ret="${k}" data-doc-ret="${esc(d.docId)}" placeholder="0" ${marcado ? '' : 'disabled'} aria-label="${t} de ${esc(d.numero)}"></td>`).join('')}</tr>
          ${porPagar ? '' : `<tr class="tp-otros-fila" data-otros-de="${esc(d.docId)}"${marcado ? '' : ' hidden'}><td></td><td colspan="${3 + RETENCIONES.length + 1}">
            <div class="tp-otros-lista" data-lista-de="${esc(d.docId)}"></div>
            ${boton('+ Estampilla, tasa o contribución', 'otro-agregar', { doc: d.docId })}</td></tr>`}`;
        }).join('')}
      </tbody></table></div>`;
      // Si viene de un movimiento del banco y un solo documento tiene justo ese saldo, se deja marcado.
      const m = movimientoElegido();
      if (m && !document.querySelector('#tp-docs input[data-doc]:checked')) {
        const igual = docs.filter((d) => redondear(d.saldo) === redondear(m.valor));
        if (igual.length === 1) {
          const chk = document.querySelector(`#tp-docs input[data-doc="${igual[0].docId}"]`);
          chk.checked = true;
          const inp = document.querySelector(`#tp-docs input[data-valor="${igual[0].docId}"]`);
          inp.disabled = false;
          inp.value = igual[0].saldo;
          document.querySelectorAll(`#tp-docs input[data-doc-ret="${igual[0].docId}"]`).forEach((r) => { r.disabled = false; });
          const filaOtros = document.querySelector(`#tp-docs tr[data-otros-de="${igual[0].docId}"]`);
          if (filaOtros) filaOtros.hidden = false;
        }
      }
      totalizar();
    }

    function totalizar() {
      let bruto = 0;
      let retenido = 0;
      let otrosDesc = 0;
      let n = 0;
      document.querySelectorAll('#tp-docs input[data-doc]:checked').forEach((chk) => {
        bruto += num(document.querySelector(`#tp-docs input[data-valor="${chk.dataset.doc}"]`).value);
        if (!porPagar) {
          for (const [k] of RETENCIONES) retenido += num(retInput(chk.dataset.doc, k).value);
          document.querySelectorAll(`#tp-docs .tp-otro[data-doc-otro="${chk.dataset.doc}"] [data-otro="valor"]`).forEach((i) => { otrosDesc += num(i.value); });
        }
        n += 1;
      });
      bruto = redondear(bruto);
      retenido = redondear(retenido);
      otrosDesc = redondear(otrosDesc);
      const descuentos = redondear(retenido + otrosDesc);
      const total = redondear(bruto - descuentos); // lo que realmente entra o sale del banco o la caja
      let html = n ? `Total ${porPagar ? 'a pagar' : 'a cobrar'}: <strong>${dinero(bruto)}</strong> en ${n} documento${n === 1 ? '' : 's'}.` : 'Marca los documentos y el valor de cada uno (puede ser un abono).';
      if (n && descuentos > 0) {
        html += ` ${retenido > 0 ? `Retenciones: <strong>${dinero(retenido)}</strong> · ` : ''}${otrosDesc > 0 ? `Estampillas, tasas y contribuciones: <strong>${dinero(otrosDesc)}</strong> · ` : ''}Dinero que recibes: <strong>${dinero(total)}</strong>.`;
      }
      if (n && descuentos >= bruto && descuentos > 0) html += ' <strong>Las retenciones y descuentos deben ser menores que el valor cobrado.</strong>';
      const m = v('tp-medio') === 'banco' ? movimientoElegido() : null;
      if (m && n) {
        html += redondear(m.valor) === total
          ? ' <strong>Coincide con el movimiento del banco.</strong>'
          : ` <strong>El movimiento del banco es de ${dinero(m.valor)}: ${descuentos > 0 ? 'el dinero que recibes' : 'el total'} debe sumar lo mismo.</strong>`;
      }
      $('tp-total').innerHTML = html;
    }

    pintarBanco();
    pintarMovimientos();
    pintarDocs();
    const cuerpoEl = $('tes-dialogo-cuerpo');
    cuerpoEl.onchange = (e) => {
      const id = e.target.id;
      if (id === 'tp-tercero') return pintarDocs();
      if (id === 'tp-medio') { pintarBanco(); return totalizar(); }
      if (id === 'tp-cuenta') { pintarMovimientos(); return totalizar(); }
      if (id === 'tp-movimiento') {
        const m = movimientoElegido();
        if (m) $('tp-fecha').value = m.fecha;
        return pintarDocs();
      }
      if (e.target.dataset && e.target.dataset.doc) {
        const inp = document.querySelector(`#tp-docs input[data-valor="${e.target.dataset.doc}"]`);
        inp.disabled = !e.target.checked;
        inp.value = e.target.checked ? e.target.dataset.saldo : '';
        const filaOtros = document.querySelector(`#tp-docs tr[data-otros-de="${e.target.dataset.doc}"]`);
        if (filaOtros) {
          filaOtros.hidden = !e.target.checked;
          if (!e.target.checked) filaOtros.querySelector('.tp-otros-lista').innerHTML = '';
        }
        document.querySelectorAll(`#tp-docs input[data-doc-ret="${e.target.dataset.doc}"]`).forEach((r) => { r.disabled = !e.target.checked; r.value = ''; });
        totalizar();
      }
    };
    cuerpoEl.onclick = (e) => {
      const b = e.target.closest('[data-tes="otro-agregar"], [data-tes="otro-quitar"]');
      if (!b) return;
      if (b.dataset.tes === 'otro-quitar') {
        b.closest('.tp-otro').remove();
        return totalizar();
      }
      const lista = document.querySelector(`#tp-docs .tp-otros-lista[data-lista-de="${b.dataset.doc}"]`);
      if (lista.children.length >= 10) return;
      lista.insertAdjacentHTML('beforeend', `<div class="tp-otro" data-doc-otro="${esc(b.dataset.doc)}">
        <input type="text" data-otro="concepto" maxlength="120" placeholder="Concepto (ej. Estampilla pro-cultura 1,5 %)" aria-label="Concepto del descuento">
        <select data-otro="cuenta" aria-label="Cuenta de gasto o costo">${opcionesOtros}</select>
        <input type="number" min="0" step="0.01" data-otro="valor" placeholder="Valor" aria-label="Valor del descuento">
        ${boton('Quitar', 'otro-quitar', {}, 'btn-accion destructivo')}</div>`);
      lista.lastElementChild.querySelector('[data-otro="concepto"]').focus();
    };
    cuerpoEl.oninput = (e) => { if (e.target.dataset && (e.target.dataset.valor || e.target.dataset.ret || e.target.dataset.otro === 'valor')) totalizar(); };
  }

  // ===================================================================================
  // RETENCIONES SUFRIDAS (las que los clientes nos practicaron al pagar)
  // ===================================================================================
  async function cargarRetenciones() {
    const q = ['desde', 'hasta'].filter((k) => T.ret[k]).map((k) => `${k}=${encodeURIComponent(T.ret[k])}`).join('&');
    T.ret.datos = await api('/tesoreria/retenciones-sufridas' + (q ? '?' + q : ''));
    renderRetenciones();
  }

  function renderRetenciones() {
    const r = T.ret.datos;
    const t = r.totales;
    let html = `<div class="inv-barra">
      ${campo('Desde', `<input type="date" id="tes-r-desde" value="${esc(T.ret.desde)}">`)}
      ${campo('Hasta', `<input type="date" id="tes-r-hasta" value="${esc(T.ret.hasta)}">`)}
      ${r.filas.length ? boton('Descargar CSV de retenciones', 'csv-retenciones', {}, 'btn-primario') : ''}
      ${r.otros.filas.length ? boton('Descargar CSV de estampillas y tasas', 'csv-otros', {}, 'btn-accion') : ''}
    </div>
    <div class="inv-tarjetas">
      <div class="inv-tarjeta destacada"><span>Total retenido</span><strong>${dinero(t.total)}</strong></div>
      <div class="inv-tarjeta"><span>ReteFuente</span><strong>${dinero(t.retefuente)}</strong></div>
      <div class="inv-tarjeta"><span>ReteIVA</span><strong>${dinero(t.reteiva)}</strong></div>
      <div class="inv-tarjeta"><span>ReteICA</span><strong>${dinero(t.reteica)}</strong></div>
      <div class="inv-tarjeta"><span>Estampillas, tasas y contribuciones</span><strong>${dinero(r.otros.total)}</strong></div></div>
    <p class="nota-panel">Retenciones que los clientes practicaron al pagar las facturas (cuentas 135515, 135517 y 135518). Son un anticipo: se descuentan en las declaraciones de renta, IVA e ICA. Compáralas con los certificados de retención que te entrega cada cliente. Los recaudos anulados no cuentan.</p>`;
    if (!r.filas.length && !r.otros.filas.length) {
      html += '<p class="vacio">No hay retenciones ni descuentos registrados en este rango. Se anotan al registrar un recaudo en «Por cobrar».</p>';
    } else if (r.filas.length) {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Factura</th><th>Registrada</th><th class="num">Valor</th><th class="num">ReteFuente</th><th class="num">ReteIVA</th><th class="num">ReteICA</th><th class="num">Total</th></tr></thead><tbody>
      ${r.filas.map((f) => `<tr><td>${esc(fecha(f.fecha))}</td><td>${esc(f.terceroNombre)}<br><span class="texto-suave">${esc(f.terceroIdentificacion)}</span></td><td>${esc(f.factura)}</td><td>${f.origen === 'factura' ? 'En la factura' : 'Al cobrar'}</td>
        <td class="num">${dinero(f.baseCobrada)}</td><td class="num">${dinero(f.retefuente)}</td><td class="num">${dinero(f.reteiva)}</td><td class="num">${dinero(f.reteica)}</td><td class="num"><strong>${dinero(f.total)}</strong></td></tr>`).join('')}
      </tbody><tfoot><tr><th colspan="5">Totales</th><th class="num">${dinero(t.retefuente)}</th><th class="num">${dinero(t.reteiva)}</th><th class="num">${dinero(t.reteica)}</th><th class="num">${dinero(t.total)}</th></tr></tfoot></table></div>`;
    }
    if (r.otros.filas.length) {
      html += `<h4 class="inv-sec-titulo">Estampillas, tasas y contribuciones descontadas por las entidades</h4>
      <p class="nota-panel">No son anticipo de impuestos: no se descuentan en ninguna declaración. Se registran como gasto o costo en la cuenta elegida al cobrar.</p>
      <div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Factura</th><th>Registrado</th><th>Concepto</th><th>Cuenta</th><th class="num">Valor</th></tr></thead><tbody>
      ${r.otros.filas.map((f) => `<tr><td>${esc(fecha(f.fecha))}</td><td>${esc(f.terceroNombre)}<br><span class="texto-suave">${esc(f.terceroIdentificacion)}</span></td><td>${esc(f.factura)}</td><td>${f.origen === 'factura' ? 'En la factura' : 'Al cobrar'}</td>
        <td>${esc(f.concepto)}</td><td>${esc(f.cuentaCodigo)} · ${esc(f.cuentaNombre)}</td><td class="num">${dinero(f.valor)}</td></tr>`).join('')}
      </tbody><tfoot><tr><th colspan="6">Total</th><th class="num">${dinero(r.otros.total)}</th></tr></tfoot></table></div>`;
    }
    contenido().innerHTML = html;
  }

  function descargarCsv(nombre, filas) {
    const celda = (x) => {
      let t = String(x == null ? '' : x);
      if (typeof x === 'string' && /^[=+\-@]/.test(t)) t = "'" + t; // evita que Excel lo tome como fórmula
      return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = '\ufeff' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${nombre}${T.ret.desde ? '-desde-' + T.ret.desde : ''}${T.ret.hasta ? '-hasta-' + T.ret.hasta : ''}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function descargarCsvRetenciones() {
    const r = T.ret.datos;
    if (!r || !r.filas.length) return;
    descargarCsv('retenciones-sufridas', [['Fecha', 'Cliente', 'Identificación', 'Factura', 'Registrada', 'Valor', 'ReteFuente', 'ReteIVA', 'ReteICA', 'Total retenido']]
      .concat(r.filas.map((f) => [f.fecha, f.terceroNombre, f.terceroIdentificacion, f.factura, f.origen === 'factura' ? 'En la factura' : 'Al cobrar', f.baseCobrada, f.retefuente, f.reteiva, f.reteica, f.total])));
  }

  function descargarCsvOtros() {
    const r = T.ret.datos;
    if (!r || !r.otros.filas.length) return;
    descargarCsv('estampillas-y-tasas', [['Fecha', 'Cliente', 'Identificación', 'Factura', 'Registrado', 'Concepto', 'Cuenta', 'Valor']]
      .concat(r.otros.filas.map((f) => [f.fecha, f.terceroNombre, f.terceroIdentificacion, f.factura, f.origen === 'factura' ? 'En la factura' : 'Al cobrar', f.concepto, `${f.cuentaCodigo} ${f.cuentaNombre}`, f.valor])));
  }

  // ===================================================================================
  // DESCUENTO DE APORTES DE UN CONTRATISTA
  // ===================================================================================
  async function dialogoDescuento(docTipo, docId) {
    const d = T.cartera.pagar.documentos.find((x) => x.docId === docId);
    if (!d) return;
    const cuentaDoc = docTipo === 'documento_soporte' ? '2335' : '2205';
    const meses = (await api(`/tesoreria/descuentos-aportes?terceroId=${encodeURIComponent(d.terceroId)}`)).filter((m) => m.cuentaPorPagar === cuentaDoc);
    if (!meses.length) {
      throw new Error(`${d.terceroNombre} no tiene aportes de contratista pendientes por descontar en este tipo de documento. Se generan al contabilizar el mes en Nómina › Contratistas.`);
    }
    const nombreMes = (m) => `${MESES[m.mes - 1]} de ${m.anio}`;
    const cuerpo = `
      ${aviso('info', `Los aportes de seguridad social que el contratista asume ya se descontaron contra la cuenta por pagar al contabilizar el mes. Aquí se aplican al documento <strong>${esc(d.numero)}</strong> (saldo ${esc(dinero(d.saldo))}) para que el saldo refleje lo que realmente se le debe. No mueve dinero ni crea otro asiento.`)}
      ${campo('Mes de aportes', `<select id="td-mes">${opcionesSelect(meses.map((m) => [m.fuenteId, `${nombreMes(m)} · disponible ${dinero(m.disponible)}`]), meses[0].fuenteId)}</select>`)}
      <div class="fila-campos">
        ${campo('Valor a descontar', `<input type="number" id="td-valor" min="0" step="0.01" value="${Math.min(meses[0].disponible, d.saldo)}">`)}
        ${campo('Fecha', `<input type="date" id="td-fecha" value="${esc(T.cartera.pagar.hoy)}">`)}
      </div>
      ${campo('Observaciones (opcional)', '<input type="text" id="td-observaciones" maxlength="250" autocomplete="off">')}`;
    abrirDialogo({
      titulo: 'Aplicar descuento de aportes', cuerpo,
      guardar: {
        texto: 'Aplicar descuento',
        fn: async () => {
          await api('/tesoreria/descuentos', {
            method: 'POST',
            body: JSON.stringify({ terceroId: d.terceroId, docTipo, docId, fuenteId: v('td-mes'), valor: num(v('td-valor')), fecha: v('td-fecha'), observaciones: v('td-observaciones') }),
          });
          await refrescarTodo();
        },
      },
    });
    $('tes-dialogo-cuerpo').onchange = (e) => {
      if (e.target.id !== 'td-mes') return;
      const m = meses.find((x) => x.fuenteId === e.target.value);
      if (m) $('td-valor').value = Math.min(m.disponible, d.saldo);
    };
  }

  // ===================================================================================
  // PAGOS DE UN DOCUMENTO Y ANULACIÓN
  // ===================================================================================
  async function dialogoPagosDoc(docTipo, docId) {
    const r = await api(`/tesoreria/documentos/${docTipo}/${docId}/pagos`);
    const filas = r.pagos.map((p) => {
      const aplicado = p.aplicaciones.filter((a) => a.docId === docId && a.estado === 'activa').reduce((s, a) => s + a.valor, 0);
      const retenido = p.aplicaciones.filter((a) => a.docId === docId).map(textoRetenciones).join('');
      const anulado = p.estado === 'anulado';
      return `<tr><td>${esc(fecha(p.fecha))}</td><td>${TIPO_PAGO[p.tipo] || esc(p.tipo)}</td><td>${textoMedio(p)}</td><td>${esc(p.referencia || '—')}</td>
        <td class="num">${dinero(anulado ? p.aplicaciones.filter((a) => a.docId === docId).reduce((s, a) => s + a.valor, 0) : aplicado)}${retenido ? `<br><span class="texto-suave">${esc(retenido.replace(/^ · /, ''))}</span>` : ''}</td>
        <td>${anulado ? `<span class="badge rechazado">anulado</span>` : '<span class="badge conciliado">activo</span>'}</td>
        <td class="acciones">${!anulado && puedeAnular() ? boton('Anular', 'anular-pago', { id: p.id }, 'btn-accion destructivo') : ''}</td></tr>`;
    }).join('');
    abrirDialogo({
      titulo: `Pagos de ${r.numero}`, ancho: true,
      cuerpo: `<p class="nota-panel">Valor <strong>${dinero(r.neto)}</strong> · aplicado <strong>${dinero(r.pagado)}</strong> · saldo <strong>${dinero(r.saldo)}</strong></p>
        <div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Medio</th><th>Referencia</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>${filas || '<tr><td colspan="7" class="vacio">Sin pagos.</td></tr>'}</tbody></table></div>`,
    });
  }

  function dialogoAnular(id) {
    abrirDialogo({
      titulo: 'Anular pago',
      cuerpo: `${aviso('confirmar', 'Se anula el asiento contable, el movimiento bancario que creó este pago (o se libera el que ya existía en el extracto) y los documentos recuperan su saldo.')}
        ${campo('Motivo (mínimo 10 letras)', '<input type="text" id="ta-motivo" maxlength="250" autocomplete="off">')}`,
      guardar: {
        texto: 'Anular pago',
        fn: async () => {
          await api(`/tesoreria/pagos/${id}/anular`, { method: 'POST', body: JSON.stringify({ motivo: v('ta-motivo') }) });
          await refrescarTodo();
        },
      },
    });
  }

  async function refrescarTodo() {
    T.cartera = {};
    await mostrarSub(T.sub);
    if (typeof cargarTodo === 'function') await cargarTodo();
  }

  // ===================================================================================
  // Eventos
  // ===================================================================================
  $('tes-subtabs').innerHTML = SUBS.map(([k, t]) => `<button type="button" data-sub="${k}">${t}</button>`).join('');
  $('tes-subtabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (b) mostrarSub(b.dataset.sub);
  });

  let temporizador = null;
  $('tes-cruce').addEventListener('input', (e) => {
    if (e.target.id !== 'tes-buscar') return;
    T.buscar = e.target.value;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => renderTablaCartera(T.sub), 150);
  });
  $('tes-cruce').addEventListener('change', async (e) => {
    if (e.target.id === 'tes-todos') {
      T.todos = e.target.checked;
      return mostrarSub(T.sub);
    }
    if (e.target.id === 'tes-r-desde' || e.target.id === 'tes-r-hasta') {
      T.ret.desde = v('tes-r-desde');
      T.ret.hasta = v('tes-r-hasta');
      return mostrarSub('retenciones');
    }
    if (e.target.id === 'tes-f-tipo' || e.target.id === 'tes-f-estado') {
      T.filtro = { tipo: v('tes-f-tipo'), estado: v('tes-f-estado') };
      return mostrarSub('historial');
    }
  });

  async function alClic(e) {
    const b = e.target.closest('[data-tes]');
    if (!b) return;
    try {
      switch (b.dataset.tes) {
        case 'nuevo-pago': return await dialogoPago({ sub: T.sub });
        case 'pagar-doc': return await dialogoPago({ sub: T.sub, docId: b.dataset.id });
        case 'descuento-doc': return await dialogoDescuento(b.dataset.tipo, b.dataset.id);
        case 'ver-pagos-doc': return await dialogoPagosDoc(b.dataset.tipo, b.dataset.id);
        case 'anular-pago': return dialogoAnular(b.dataset.id);
        case 'csv-retenciones': return descargarCsvRetenciones();
        case 'csv-otros': return descargarCsvOtros();
      }
    } catch (err) {
      mostrarError(err);
    }
  }
  $('tes-cruce').addEventListener('click', alClic);
  $('tes-dialogo-cuerpo').addEventListener('click', alClic);

  // Lo llama app.js al abrir la pestaña Tesorería.
  window.tesoreriaAlMostrar = function () {
    mostrarSub(T.sub);
  };

  // Desde la tabla de movimientos: cruzar un movimiento del extracto con las facturas que paga.
  window.tesoreriaCruzarMovimiento = async function (id) {
    try {
      const movs = await api('/tesoreria/movimientos-libres');
      const m = movs.find((x) => x.id === id);
      if (!m) throw new Error('Ese movimiento ya está ligado a otra operación.');
      T.sub = m.tipo === 'egreso' ? 'pagar' : 'cobrar';
      document.querySelectorAll('#tes-subtabs button').forEach((b) => b.classList.toggle('activo', b.dataset.sub === T.sub));
      await dialogoPago({ sub: T.sub, movimiento: id });
    } catch (err) {
      mostrarError(err);
    }
  };
})();
