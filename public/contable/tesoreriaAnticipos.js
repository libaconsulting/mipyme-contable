// Tesorería · Anticipos de clientes y a proveedores.
//
// Va en su propio archivo y se carga DESPUÉS de tesoreriaCruce.js: usa su diálogo y sus ayudas (window.tesoreriaKit).
//
// Un anticipo es plata que entra de un cliente antes de facturarle (queda en 2805 Anticipos y avances recibidos) o que
// sale a un proveedor antes de recibir su factura (queda en 1330 Anticipos y avances). Cuando llega la factura se
// aplica el anticipo —sin mover plata— y la factura baja su saldo; si no se usa, se devuelve.
(function () {
  const K = window.tesoreriaKit;
  if (!K || !document.getElementById('tes-cruce')) return;
  const { abrirDialogo, cerrarDialogo, refrescarTodo, boton, campo, opcionesSelect, aviso, mostrarError, num, v, redondear } = K;

  const $ = (id) => document.getElementById(id);
  const esc = (x) => escHtml(x);
  const dinero = (x) => formatoDineroDec(x);
  const fecha = (f) => (f ? formatoFecha(f) : '—');
  const hoy = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

  const SENTIDO = {
    cliente: { titulo: 'Anticipo de cliente', quien: 'Cliente', cartera: 'cobrar', tipoMov: 'ingreso', tipoMovDev: 'egreso', entra: 'Entra a', dev: 'Sale de' },
    proveedor: { titulo: 'Anticipo a proveedor', quien: 'Proveedor', cartera: 'pagar', tipoMov: 'egreso', tipoMovDev: 'ingreso', entra: 'Sale de', dev: 'Entra a' },
  };
  const A = { sentido: '', todos: false, datos: null };

  // ===================================================================================
  // LISTA
  // ===================================================================================
  async function mostrar() {
    const q = [A.sentido ? `sentido=${A.sentido}` : '', A.todos ? 'todos=1' : ''].filter(Boolean).join('&');
    A.datos = await api('/tesoreria/anticipos' + (q ? '?' + q : ''));
    render();
  }

  function render() {
    const d = A.datos;
    const r = d.resumen;
    let html = `<div class="inv-tarjetas">
      <div class="inv-tarjeta destacada"><span>Anticipos de clientes sin aplicar</span><strong>${dinero(r.clientes)}</strong></div>
      <div class="inv-tarjeta"><span>Anticipos a proveedores sin aplicar</span><strong>${dinero(r.proveedores)}</strong></div></div>`;
    html += `<p class="nota-panel">Un anticipo de cliente es plata que recibes antes de facturar (se anota en 2805, un pasivo). Uno a proveedor es plata que entregas antes de recibir su factura (1330, un activo). Cuando llega la factura, usa «Aplicar» y su saldo baja sin mover dinero; si no se usa, «Devolver». No lleva IVA ni retención: esos van en la factura que lo cancela.</p>`;
    html += `<div class="inv-barra">
      <select id="ant-f-sentido" aria-label="Tipo de anticipo">${opcionesSelect([['', 'Clientes y proveedores'], ['cliente', 'Solo clientes'], ['proveedor', 'Solo proveedores']], A.sentido)}</select>
      <label class="fx-check"><input type="checkbox" id="ant-todos"${A.todos ? ' checked' : ''}> Incluir los ya aplicados o devueltos</label>
      ${K.puedeRegistrar() ? boton('+ Anticipo de cliente', 'nuevo', { sentido: 'cliente' }, 'btn-primario') + ' ' + boton('+ Anticipo a proveedor', 'nuevo', { sentido: 'proveedor' }, 'btn-primario') : ''}
    </div>`;
    if (!d.anticipos.length) {
      html += `<p class="vacio">${A.todos ? 'Todavía no hay anticipos.' : 'No hay anticipos con saldo por aplicar.'}</p>`;
    } else {
      html += `<div class="tabla-envoltorio"><table class="tabla-anticipos"><thead><tr><th>Fecha</th><th>Tercero</th><th>Medio y referencia</th><th class="num">Valor</th><th class="num">Usado</th><th class="num">Saldo</th><th></th></tr></thead><tbody>
      ${d.anticipos.map((a) => {
        const acc = [];
        if (K.puedeRegistrar() && a.saldo > 0) {
          acc.push(boton('Aplicar', 'aplicar', { id: a.id }));
          acc.push(boton('Devolver', 'devolver', { id: a.id }));
        }
        acc.push(boton('Ver', 'ver', { id: a.id }));
        if (K.puedeAnular()) acc.push(boton('Anular', 'anular', { id: a.id }, 'btn-accion destructivo'));
        return `<tr><td class="no-corta">${esc(fecha(a.fecha))}</td>
          <td>${esc(a.terceroNombre)}<br><span class="texto-suave">${a.sentido === 'cliente' ? 'Cliente' : 'Proveedor'} · ${esc(a.terceroIdentificacion)}</span>${a.ordenConsecutivo ? `<br><span class="badge conciliado">Orden ${esc(a.ordenConsecutivo)}</span>` : ''}</td>
          <td>${esc(a.cuentaTexto || 'Banco')}<br><span class="texto-suave">${esc(a.referencia || 'sin referencia')}</span></td>
          <td class="num">${dinero(a.valor)}</td>
          <td class="num">${a.aplicado > 0 ? `aplicado ${dinero(a.aplicado)}` : ''}${a.aplicado > 0 && a.devuelto > 0 ? '<br>' : ''}${a.devuelto > 0 ? `devuelto ${dinero(a.devuelto)}` : ''}${a.aplicado <= 0 && a.devuelto <= 0 ? '—' : ''}</td>
          <td class="num"><strong>${dinero(a.saldo)}</strong></td><td class="acciones">${acc.join(' ')}</td></tr>`;
      }).join('')}
      </tbody></table></div>`;
    }
    K.contenido().innerHTML = html;
  }

  // ===================================================================================
  // REGISTRAR UN ANTICIPO
  // ===================================================================================
  // ordenId: orden de adquisición con la que se abre el diálogo (desde el botón «Anticipo» de la orden).
  async function dialogoNuevo(sentido, ordenId) {
    const S = SENTIDO[sentido];
    const [terceros, libres, cuentas, ordenes, previos] = await Promise.all([
      api('/terceros'), api('/tesoreria/movimientos-libres'), api('/tesoreria/cuentas'),
      sentido === 'proveedor' ? api('/compras/ordenes') : Promise.resolve([]),
      sentido === 'proveedor' ? api('/tesoreria/anticipos?sentido=proveedor&todos=1') : Promise.resolve({ anticipos: [] }),
    ]);
    const ordenInicial = ordenId ? ordenes.find((o) => o.id === ordenId) : null;
    if (ordenId && !ordenInicial) throw new Error('No se encontró la orden de adquisición.');
    // Anticipado por orden (menos devoluciones), para mostrar cuánto queda por anticipar.
    const anticipado = {};
    for (const a of previos.anticipos) if (a.ordenCompraId) anticipado[a.ordenCompraId] = (anticipado[a.ordenCompraId] || 0) + a.valor - a.devuelto;
    const elegibles = terceros.filter((t) => t.tipo === sentido || t.tipo === 'otro').sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (!elegibles.length) throw new Error(`Primero crea el ${S.quien.toLowerCase()} en Terceros.`);
    const cuentaInicial = cuentas[0] ? cuentas[0].id : '';
    const cuerpo = `
      ${K.sinCuentas(cuentas)}
      ${campo(S.quien, `<select id="an-tercero"><option value="">Elige…</option>${opcionesSelect(elegibles.map((t) => [t.id, `${t.nombre} · ${t.identificacion}`]), ordenInicial ? ordenInicial.terceroId : '')}</select>`)}
      ${sentido === 'proveedor' ? campo('Orden de adquisición (opcional, recomendada)', '<select id="an-orden"></select>') + '<p class="nota-aiu" id="an-orden-info"></p>' : ''}
      <div class="fila-campos">
        ${campo('Fecha', `<input type="date" id="an-fecha" value="${hoy()}" max="${hoy()}">`)}
        ${campo('Valor', '<input type="number" id="an-valor" min="0" step="0.01" placeholder="0">')}
      </div>
      <div class="fila-campos">
        ${campo(S.entra, `<select id="an-medio">${opcionesSelect([['banco', 'Cuenta bancaria'], ['caja', 'Efectivo (caja)']], cuentas.length ? 'banco' : 'caja')}</select>`)}
        ${campo('Cuenta bancaria', `<select id="an-cuenta">${opcionesSelect(cuentas.map((c) => [c.id, `${c.banco} · ${c.numero}`]), cuentaInicial)}</select>`, 'an-banco')}
      </div>
      ${campo('Movimiento del banco', '<select id="an-movimiento"></select>', 'an-banco')}
      <div class="fila-campos">
        ${campo('Referencia (opcional)', '<input type="text" id="an-referencia" maxlength="60" placeholder="Nº de transferencia, recibo…" autocomplete="off">')}
        ${campo('Observaciones (opcional)', '<input type="text" id="an-observaciones" maxlength="250" autocomplete="off">', 'dc-nombre')}
      </div>
      <p class="nota-aiu" id="an-asiento"></p>`;
    abrirDialogo({
      titulo: S.titulo, cuerpo, ancho: true,
      guardar: {
        texto: 'Registrar anticipo',
        fn: async () => {
          const banco = v('an-medio') === 'banco';
          await api('/tesoreria/anticipos', {
            method: 'POST',
            body: JSON.stringify({
              sentido, terceroId: v('an-tercero'), ordenCompraId: sentido === 'proveedor' && v('an-orden') ? v('an-orden') : null, fecha: v('an-fecha'), valor: num(v('an-valor')), medio: v('an-medio'),
              cuentaBancariaId: banco ? v('an-cuenta') : null, movimientoBancarioId: banco && v('an-movimiento') ? v('an-movimiento') : null,
              referencia: v('an-referencia'), observaciones: v('an-observaciones'),
            }),
          });
          await refrescarTodo();
        },
      },
    });
    const pintarBanco = () => {
      const banco = v('an-medio') === 'banco';
      document.querySelectorAll('#dialogo-tes .an-banco').forEach((el) => { el.hidden = !banco; });
    };
    const pintarMovimientos = () => {
      const cand = libres.filter((m) => m.tipo === S.tipoMov && m.cuentaBancariaId === v('an-cuenta'));
      $('an-movimiento').innerHTML = '<option value="">Crear el movimiento al guardar</option>'
        + cand.map((m) => `<option value="${esc(m.id)}">${esc(fecha(m.fecha))} · ${esc(dinero(m.valor))} · ${esc(m.descripcion || 'sin descripción')}</option>`).join('');
    };
    const pintarAsiento = () => {
      const val = redondear(num(v('an-valor')));
      $('an-asiento').textContent = val > 0
        ? (sentido === 'cliente' ? `Asiento: Db ${v('an-medio') === 'banco' ? 'banco' : 'caja'} ${dinero(val)} / Cr 2805 Anticipos y avances recibidos ${dinero(val)}.`
          : `Asiento: Db 1330 Anticipos y avances ${dinero(val)} / Cr ${v('an-medio') === 'banco' ? 'banco' : 'caja'} ${dinero(val)}.`)
        : '';
    };
    // Órdenes del proveedor elegido en las que se puede conceder un anticipo (emitida, aprobada o recibida).
    const ESTADOS_ORDEN = ['emitida', 'aprobada', 'recibida_parcial', 'recibida_total'];
    const pintarOrdenes = (elegida) => {
      const sel = $('an-orden');
      if (!sel) return;
      const lista = ordenes.filter((o) => o.terceroId === v('an-tercero') && ESTADOS_ORDEN.includes(o.estado));
      sel.innerHTML = `<option value="">${v('an-tercero') ? (lista.length ? 'Sin orden' : 'Sin orden (este proveedor no tiene órdenes disponibles)') : 'Elige primero el proveedor'}</option>`
        + lista.map((o) => `<option value="${esc(o.id)}"${o.id === elegida ? ' selected' : ''}>${esc(o.consecutivo || 's/n')} · ${esc(o.tipo)} · ${esc(dinero(o.total))}</option>`).join('');
      pintarInfoOrden();
    };
    const pintarInfoOrden = () => {
      const o = ordenes.find((x) => x.id === v('an-orden'));
      $('an-orden-info').textContent = o
        ? `Orden por ${dinero(o.total)} · ya anticipado ${dinero(anticipado[o.id] || 0)} · se puede anticipar hasta ${dinero(Math.max(0, redondear(Number(o.total) - (anticipado[o.id] || 0))))}.`
        : '';
    };
    $('tes-dialogo-cuerpo').onchange = (e) => {
      if (e.target.id === 'an-tercero') pintarOrdenes('');
      if (e.target.id === 'an-orden') pintarInfoOrden();
      if (e.target.id === 'an-medio') { pintarBanco(); pintarAsiento(); }
      if (e.target.id === 'an-cuenta') pintarMovimientos();
      if (e.target.id === 'an-movimiento') {
        const m = libres.find((x) => x.id === e.target.value);
        if (m) { $('an-valor').value = m.valor; $('an-fecha').value = m.fecha; pintarAsiento(); }
      }
    };
    $('tes-dialogo-cuerpo').oninput = (e) => { if (e.target.id === 'an-valor') pintarAsiento(); };
    pintarBanco();
    pintarMovimientos();
    pintarOrdenes(ordenInicial ? ordenInicial.id : '');
  }

  // ===================================================================================
  // APLICAR UN ANTICIPO A FACTURAS
  // ===================================================================================
  // anticipos: los anticipos con saldo del tercero; docId: factura que se marca de entrada (opcional).
  async function dialogoAplicar(anticipos, docId) {
    const S = SENTIDO[anticipos[0].sentido];
    const cartera = await K.cargarCartera(S.cartera);
    const terceroId = anticipos[0].terceroId;
    const docs = cartera.documentos.filter((d) => d.terceroId === terceroId && d.pagable);
    if (!docs.length) throw new Error(`${anticipos[0].terceroNombre} no tiene facturas con saldo para aplicar el anticipo.`);
    // Si la factura elegida es de una orden, el anticipo de esa orden va de primero.
    const docElegido = docs.find((d) => d.docId === docId);
    if (docElegido && docElegido.ordenCompraId) anticipos = [...anticipos].sort((x, y) => Number(y.ordenCompraId === docElegido.ordenCompraId) - Number(x.ordenCompraId === docElegido.ordenCompraId));
    const cuerpo = `
      ${anticipos.length > 1
        ? campo('Anticipo', `<select id="aa-anticipo">${opcionesSelect(anticipos.map((a) => [a.id, `${fecha(a.fecha)} · ${a.referencia || 'sin referencia'} · saldo ${dinero(a.saldo)}`]), anticipos[0].id)}</select>`)
        : `<p class="nota-panel">Anticipo del ${esc(fecha(anticipos[0].fecha))}${anticipos[0].referencia ? ' · ' + esc(anticipos[0].referencia) : ''} de <strong>${esc(anticipos[0].terceroNombre)}</strong>.</p>`}
      <div class="fila-campos">
        ${campo('Fecha de la aplicación', `<input type="date" id="aa-fecha" value="${hoy()}" max="${hoy()}">`)}
        ${campo('Observaciones (opcional)', '<input type="text" id="aa-observaciones" maxlength="250" autocomplete="off">', 'dc-nombre')}
      </div>
      <h4 class="inv-sec-titulo">Facturas a las que se aplica</h4>
      <div class="tabla-envoltorio"><table><thead><tr><th></th><th>Documento</th><th>Vence</th><th class="num">Saldo</th><th class="num">Valor a aplicar</th></tr></thead><tbody>
        ${docs.map((d) => `<tr><td><input type="checkbox" data-aa-doc="${esc(d.docId)}" data-tipo="${esc(d.docTipo)}" data-saldo="${d.saldo}" aria-label="Incluir ${esc(d.numero)}"></td>
          <td>${esc(d.numero)}<br><span class="texto-suave">${esc(d.etiqueta)}</span> <span class="aa-orden" data-orden="${esc(d.ordenCompraId || '')}" data-tipo="${esc(d.docTipo)}"></span></td><td>${esc(fecha(d.fechaVencimiento))}</td><td class="num">${dinero(d.saldo)}</td>
          <td class="num"><input type="number" min="0" step="0.01" data-aa-valor="${esc(d.docId)}" disabled aria-label="Valor a aplicar a ${esc(d.numero)}"></td></tr>`).join('')}
      </tbody></table></div>
      <p id="aa-total" class="nota-aiu"></p>
      <div id="aa-fuera" hidden>
        <p class="fx-aviso confirmar" id="aa-fuera-texto"></p>
        <label class="fx-check"><input type="checkbox" id="aa-fuera-ok"> Aplicar de todos modos</label>
      </div>`;
    abrirDialogo({
      titulo: 'Aplicar anticipo a facturas', cuerpo, ancho: true,
      guardar: {
        texto: 'Aplicar anticipo',
        fn: async () => {
          const aplicaciones = marcadas().map((chk) => ({ docTipo: chk.dataset.tipo, docId: chk.dataset.aaDoc, valor: num(entrada(chk.dataset.aaDoc).value) }));
          await api(`/tesoreria/anticipos/${anticipoActual().id}/aplicar`, {
            method: 'POST', body: JSON.stringify({ fecha: v('aa-fecha'), observaciones: v('aa-observaciones'), aplicaciones, aceptarFueraDeOrden: $('aa-fuera-ok').checked }),
          });
          await refrescarTodo();
        },
      },
    });
    const anticipoActual = () => anticipos.find((a) => a.id === (anticipos.length > 1 ? v('aa-anticipo') : anticipos[0].id)) || anticipos[0];
    const marcadas = () => [...document.querySelectorAll('#tes-dialogo-cuerpo input[data-aa-doc]:checked')];
    const entrada = (id) => document.querySelector(`#tes-dialogo-cuerpo input[data-aa-valor="${id}"]`);
    // Si el anticipo es de una orden, marca cada factura (de la orden o no) y pide confirmar las que no son de esa orden.
    const marcarOrden = () => {
      const a = anticipoActual();
      document.querySelectorAll('#tes-dialogo-cuerpo .aa-orden').forEach((m) => {
        if (!a.ordenCompraId) { m.textContent = ''; return; }
        const deLaOrden = m.dataset.tipo === 'factura_compra' && m.dataset.orden === a.ordenCompraId;
        m.textContent = deLaOrden ? `· de la orden ${a.ordenConsecutivo || ''}` : '· no es de la orden';
        m.className = 'aa-orden ' + (deLaOrden ? 'texto-suave' : 'aa-fuera-marca');
      });
      const fuera = marcadas().filter((c) => {
        const m = c.closest('tr').querySelector('.aa-orden');
        return a.ordenCompraId && !(m.dataset.tipo === 'factura_compra' && m.dataset.orden === a.ordenCompraId);
      });
      $('aa-fuera').hidden = !fuera.length;
      if (!fuera.length) $('aa-fuera-ok').checked = false;
      $('aa-fuera-texto').textContent = `Este anticipo se concedió sobre la orden ${a.ordenConsecutivo || ''} y estás aplicándolo a facturas que no son de esa orden. Confirma si es lo que quieres.`;
    };
    const totalizar = () => {
      marcarOrden();
      const saldo = anticipoActual().saldo;
      const total = redondear(marcadas().reduce((s, chk) => s + num(entrada(chk.dataset.aaDoc).value), 0));
      const resto = redondear(saldo - total);
      $('aa-total').innerHTML = `Se aplica <strong>${esc(dinero(total))}</strong> de ${esc(dinero(saldo))}.`
        + (resto < 0 ? ' <strong>Es más de lo que tiene el anticipo.</strong>' : ` Queda sin aplicar ${esc(dinero(resto))}.`);
    };
    $('tes-dialogo-cuerpo').onchange = (e) => {
      if (e.target.id === 'aa-anticipo') return totalizar();
      const doc = e.target.dataset && e.target.dataset.aaDoc;
      if (!doc) return;
      const inp = entrada(doc);
      inp.disabled = !e.target.checked;
      if (e.target.checked) {
        // Sugiere lo que alcance: lo que le queda al anticipo (sin contar esta factura) o el saldo de la factura.
        const otras = marcadas().filter((c) => c !== e.target).reduce((s, c) => s + num(entrada(c.dataset.aaDoc).value), 0);
        inp.value = Math.max(0, Math.min(Number(e.target.dataset.saldo), redondear(anticipoActual().saldo - otras)));
      } else {
        inp.value = '';
      }
      totalizar();
    };
    $('tes-dialogo-cuerpo').oninput = (e) => { if (e.target.dataset && e.target.dataset.aaValor) totalizar(); };
    if (docId) {
      const chk = document.querySelector(`#tes-dialogo-cuerpo input[data-aa-doc="${docId}"]`);
      if (chk) { chk.checked = true; chk.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    totalizar();
  }

  async function aplicarDesde(id) {
    const a = A.datos.anticipos.find((x) => x.id === id);
    if (!a) return;
    await dialogoAplicar([a]);
  }

  // Desde la cartera: aplica un anticipo del tercero a la factura elegida.
  window.tesoreriaAnticiposAplicarA = async function (terceroId, docTipo, docId) {
    const sentido = docTipo === 'factura_venta' ? 'cliente' : 'proveedor';
    const r = await api(`/tesoreria/anticipos?sentido=${sentido}&terceroId=${encodeURIComponent(terceroId)}`);
    const con = r.anticipos.filter((a) => a.saldo > 0);
    if (!con.length) throw new Error('Ese tercero ya no tiene anticipos con saldo.');
    await dialogoAplicar(con, docId);
  };

  // ===================================================================================
  // DEVOLVER
  // ===================================================================================
  async function dialogoDevolver(id) {
    const a = A.datos.anticipos.find((x) => x.id === id);
    if (!a) return;
    const S = SENTIDO[a.sentido];
    const [libres, cuentas] = await Promise.all([api('/tesoreria/movimientos-libres'), api('/tesoreria/cuentas')]);
    const cuerpo = `
      ${K.sinCuentas(cuentas)}
      ${aviso('info', a.sentido === 'cliente'
        ? `Le devuelves a <strong>${esc(a.terceroNombre)}</strong> plata de su anticipo: Db 2805 / Cr ${'banco o caja'}.`
        : `<strong>${esc(a.terceroNombre)}</strong> te devuelve plata del anticipo: Db banco o caja / Cr 1330.`)}
      <p class="nota-panel">Saldo del anticipo: <strong>${esc(dinero(a.saldo))}</strong>.</p>
      <div class="fila-campos">
        ${campo('Valor a devolver', `<input type="number" id="ad-valor" min="0" step="0.01" value="${a.saldo}">`)}
        ${campo('Fecha', `<input type="date" id="ad-fecha" value="${hoy()}" max="${hoy()}">`)}
      </div>
      <div class="fila-campos">
        ${campo(S.dev, `<select id="ad-medio">${opcionesSelect([['banco', 'Cuenta bancaria'], ['caja', 'Efectivo (caja)']], cuentas.length ? 'banco' : 'caja')}</select>`)}
        ${campo('Cuenta bancaria', `<select id="ad-cuenta">${opcionesSelect(cuentas.map((c) => [c.id, `${c.banco} · ${c.numero}`]), cuentas[0] ? cuentas[0].id : '')}</select>`, 'ad-banco')}
      </div>
      ${campo('Movimiento del banco', '<select id="ad-movimiento"></select>', 'ad-banco')}
      <div class="fila-campos">
        ${campo('Referencia (opcional)', '<input type="text" id="ad-referencia" maxlength="60" autocomplete="off">')}
        ${campo('Observaciones (opcional)', '<input type="text" id="ad-observaciones" maxlength="250" autocomplete="off">', 'dc-nombre')}
      </div>`;
    abrirDialogo({
      titulo: 'Devolver anticipo', cuerpo, ancho: true,
      guardar: {
        texto: 'Registrar devolución',
        fn: async () => {
          const banco = v('ad-medio') === 'banco';
          await api(`/tesoreria/anticipos/${id}/devolver`, {
            method: 'POST',
            body: JSON.stringify({
              valor: num(v('ad-valor')), fecha: v('ad-fecha'), medio: v('ad-medio'), cuentaBancariaId: banco ? v('ad-cuenta') : null,
              movimientoBancarioId: banco && v('ad-movimiento') ? v('ad-movimiento') : null, referencia: v('ad-referencia'), observaciones: v('ad-observaciones'),
            }),
          });
          await refrescarTodo();
        },
      },
    });
    const pintarBanco = () => document.querySelectorAll('#dialogo-tes .ad-banco').forEach((el) => { el.hidden = v('ad-medio') !== 'banco'; });
    const pintarMovimientos = () => {
      const cand = libres.filter((m) => m.tipo === S.tipoMovDev && m.cuentaBancariaId === v('ad-cuenta'));
      $('ad-movimiento').innerHTML = '<option value="">Crear el movimiento al guardar</option>'
        + cand.map((m) => `<option value="${esc(m.id)}">${esc(fecha(m.fecha))} · ${esc(dinero(m.valor))} · ${esc(m.descripcion || 'sin descripción')}</option>`).join('');
    };
    $('tes-dialogo-cuerpo').onchange = (e) => {
      if (e.target.id === 'ad-medio') pintarBanco();
      if (e.target.id === 'ad-cuenta') pintarMovimientos();
      if (e.target.id === 'ad-movimiento') {
        const m = libres.find((x) => x.id === e.target.value);
        if (m) { $('ad-valor').value = m.valor; $('ad-fecha').value = m.fecha; }
      }
    };
    pintarBanco();
    pintarMovimientos();
  }

  // ===================================================================================
  // VER LO QUE SE HIZO CON UN ANTICIPO
  // ===================================================================================
  async function dialogoVer(id) {
    const a = await api(`/tesoreria/anticipos/${id}`);
    const nombre = { cruce_anticipo: 'Aplicado a facturas', devolucion_anticipo: 'Devolución' };
    const filas = a.movimientos.map((m) => {
      const anulado = m.estado === 'anulado';
      const detalle = m.tipo === 'cruce_anticipo'
        ? m.aplicaciones.map((x) => `${esc(x.numero)} <span class="texto-suave">${dinero(x.valor)}</span>`).join('<br>')
        : esc(m.medio === 'caja' ? 'Efectivo (caja)' : (m.cuentaTexto || 'Banco'));
      return `<tr><td>${esc(fecha(m.fecha))}</td><td>${nombre[m.tipo] || esc(m.tipo)}</td><td>${detalle}</td><td class="num">${dinero(m.valor)}</td>
        <td>${anulado ? `<span class="badge rechazado">anulado</span><br><span class="texto-suave">${esc(m.motivoAnulacion || '')}</span>` : '<span class="badge conciliado">activo</span>'}</td>
        <td class="acciones">${!anulado && K.puedeAnular() ? boton('Anular', 'anular-pago', { id: m.id }, 'btn-accion destructivo') : ''}</td></tr>`;
    }).join('');
    abrirDialogo({
      titulo: `${a.sentido === 'cliente' ? 'Anticipo de' : 'Anticipo a'} ${a.terceroNombre}`, ancho: true,
      cuerpo: `<p class="nota-panel">${a.ordenConsecutivo ? `Orden de adquisición <strong>${esc(a.ordenConsecutivo)}</strong> · ` : ''}Entregado el ${esc(fecha(a.fecha))} · valor <strong>${dinero(a.valor)}</strong> · aplicado <strong>${dinero(a.aplicado)}</strong> · devuelto <strong>${dinero(a.devuelto)}</strong> · saldo <strong>${dinero(a.saldo)}</strong>${a.estado === 'anulado' ? ' · <span class="badge rechazado">anulado</span>' : ''}</p>
        <div class="tabla-envoltorio"><table><thead><tr><th>Fecha</th><th>Qué se hizo</th><th>Detalle</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead><tbody>${filas || '<tr><td colspan="6" class="vacio">Todavía no se ha aplicado ni devuelto.</td></tr>'}</tbody></table></div>`,
    });
  }

  function dialogoAnular(id) {
    abrirDialogo({
      titulo: 'Anular anticipo',
      cuerpo: `${aviso('confirmar', 'Se anula el asiento del anticipo y su movimiento bancario (o se libera el que ya existía en el extracto). Si ya se aplicó a facturas o se devolvió, primero anula esas aplicaciones o devoluciones.')}
        ${campo('Motivo (mínimo 10 letras)', '<input type="text" id="ta-motivo" maxlength="250" autocomplete="off">')}`,
      guardar: {
        texto: 'Anular anticipo',
        fn: async () => {
          await api(`/tesoreria/pagos/${id}/anular`, { method: 'POST', body: JSON.stringify({ motivo: v('ta-motivo') }) });
          await refrescarTodo();
        },
      },
    });
  }

  // ===================================================================================
  // Eventos
  // ===================================================================================
  $('tes-cruce').addEventListener('change', async (e) => {
    if (e.target.id === 'ant-f-sentido') { A.sentido = e.target.value; return mostrar().catch(mostrarError); }
    if (e.target.id === 'ant-todos') { A.todos = e.target.checked; return mostrar().catch(mostrarError); }
  });
  $('tes-cruce').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tes="nuevo"],[data-tes="aplicar"],[data-tes="devolver"],[data-tes="ver"],[data-tes="anular"]');
    if (!b || document.querySelector('#tes-subtabs button.activo').dataset.sub !== 'anticipos') return;
    try {
      switch (b.dataset.tes) {
        case 'nuevo': return await dialogoNuevo(b.dataset.sentido);
        case 'aplicar': return await aplicarDesde(b.dataset.id);
        case 'devolver': return await dialogoDevolver(b.dataset.id);
        case 'ver': return await dialogoVer(b.dataset.id);
        case 'anular': return dialogoAnular(b.dataset.id);
      }
    } catch (err) {
      mostrarError(err);
    }
  });

  // Desde la orden de adquisición: abre Tesorería › Anticipos con el anticipo a proveedor sobre esa orden.
  window.tesoreriaAnticiposNuevoParaOrden = async function (ordenId) {
    await K.mostrarSub('anticipos');
    await dialogoNuevo('proveedor', ordenId);
  };

  window.tesoreriaAnticiposMostrar = mostrar;
})();
