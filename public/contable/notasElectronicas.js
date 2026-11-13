// Notas crédito y débito · carga desde el XML.
//
// Va en su propio archivo y se carga DESPUÉS de app.js: usa sus ayudas globales (api, usuario, escHtml, formatoDineroDec,
// formatoFecha, listaProyectos, etiquetaProyecto, archivoABase64, TAMANO_MAX_XML) y asientoNota.js (el mismo cálculo del
// asiento que usa el servidor al guardar, así lo que se ve es lo que se contabiliza).
//
// Flujo: se elige el XML (o el .zip) → el servidor lo lee SIN guardar y dice de qué lado es (compra: la expide el
// proveedor; venta: la expediste tú), a qué factura corresponde y qué retenciones reversaría → la persona revisa cuentas,
// factura y retenciones → se registra y contabiliza. El servidor vuelve a leer el XML al registrar: nada de lo que se ve
// aquí se toma como cierto sin validarlo.
(function () {
  if (!document.getElementById('panel-notas')) return;

  const $ = (id) => document.getElementById(id);
  const esc = (x) => escHtml(x);
  const dinero = (x) => formatoDineroDec(x);
  const NINGUNA = '__ninguna__';
  const puedeRegistrar = () => !!usuario && ['contador', 'dueño', 'auxiliar'].includes(usuario.rol);
  const puedeAnular = () => !!usuario && ['contador', 'dueño'].includes(usuario.rol);
  const redondear = (n) => Math.round(Number(n || 0) * 100) / 100;
  const num = (id) => Number($(id).value || 0);

  const FIJAS = {
    1305: 'Clientes', 2408: 'IVA por pagar', 2205: 'Proveedores nacionales', 1355: 'IVA descontable',
    2365: 'Retención en la fuente por pagar', 2367: 'ReteIVA por pagar',
    135515: 'Retención en la fuente (a favor)', 135517: 'ReteIVA (a favor)', 135518: 'ReteICA (a favor)',
  };
  const NOMBRE_TIPO = { credito: 'Nota crédito', debito: 'Nota débito' };
  const NOMBRE_LADO = { compra: 'de compra', venta: 'de venta' };

  const N = { lista: [], filtro: { lado: '', tipo: '', estado: '' }, detalleId: null };
  const nx = { base64: null, nombre: '', preview: null, documentoId: '', tocado: new Set(), enviando: false };

  // --- Lista ------------------------------------------------------------------------

  async function cargarLista() {
    const q = Object.entries(N.filtro).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    N.lista = await api('/notas' + (q ? '?' + q : ''));
    pintarLista();
  }

  function efectoTexto(n) {
    if (n.estado === 'anulada') return '<span class="texto-suave">Anulada</span>';
    if (!n.docId) return '<span class="texto-suave">Sin vincular</span>';
    return n.tipo === 'credito' ? `− ${esc(dinero(n.neto))}` : `+ ${esc(dinero(n.neto))}`;
  }

  function pintarLista() {
    const tabla = $('tabla-notas');
    tabla.querySelector('thead').innerHTML = '<tr><th>Fecha</th><th>Nota</th><th>Proveedor / Cliente</th><th>Factura que modifica</th><th class="num">Total</th><th class="num">Efecto en el saldo</th><th>Estado</th><th></th></tr>';
    const cuerpo = tabla.querySelector('tbody');
    if (!N.lista.length) {
      cuerpo.innerHTML = '<tr><td colspan="8" class="vacio">Todavía no hay notas. Carga el XML de la primera con el botón de arriba.</td></tr>';
      return;
    }
    cuerpo.innerHTML = N.lista
      .map(
        (n) => `<tr>
          <td>${esc(formatoFecha(n.fecha))}</td>
          <td><strong>${esc(NOMBRE_TIPO[n.tipo])}</strong> ${esc(n.numero || '')}<br><span class="texto-suave">${esc(NOMBRE_LADO[n.lado])}</span></td>
          <td>${esc(n.terceroNombre || '—')}<br><span class="texto-suave">NIT ${esc(n.terceroNit || '')}</span></td>
          <td>${esc(n.facturaNumero || n.referenciaNumero || '—')}${n.docId ? '' : n.referenciaNumero ? '<br><span class="texto-suave">no está registrada</span>' : ''}</td>
          <td class="num">${esc(dinero(n.total))}</td>
          <td class="num">${efectoTexto(n)}</td>
          <td>${n.estado === 'anulada' ? '<span class="badge rechazada">anulada</span>' : '<span class="badge aceptada">vigente</span>'}</td>
          <td><button type="button" class="btn-accion" data-nx="ver" data-id="${esc(n.id)}">Ver</button></td>
        </tr>`
      )
      .join('');
  }

  // --- Cargar una nota -----------------------------------------------------------------

  const dialogo = $('dialogo-nota-xml');

  function reiniciar() {
    nx.base64 = null;
    nx.nombre = '';
    nx.preview = null;
    nx.documentoId = '';
    nx.tocado = new Set();
    nx.enviando = false;
    $('nx-archivo').value = '';
    $('nx-paso-archivo').hidden = false;
    $('nx-revision').hidden = true;
    $('nx-estado-lectura').textContent = '';
    $('nx-estado-lectura').classList.remove('error');
    $('nx-zona-archivo').classList.remove('error', 'arrastrando');
    $('nx-error').hidden = true;
    $('nx-ayuda').textContent = '';
    $('btn-registrar-nota-xml').disabled = true;
    $('nx-aceptar').checked = false;
    $('nx-crear-tercero').checked = true;
  }

  function abrir() {
    reiniciar();
    if (typeof dialogo.showModal === 'function') dialogo.showModal();
    else dialogo.setAttribute('open', '');
  }

  function cerrar() {
    if (nx.enviando) return;
    dialogo.close();
  }

  function estadoLectura(texto, esError) {
    $('nx-estado-lectura').textContent = texto;
    $('nx-estado-lectura').classList.toggle('error', !!esError);
    $('nx-zona-archivo').classList.toggle('error', !!esError);
  }

  async function procesarArchivo(archivo) {
    if (!archivo) return;
    if (archivo.size > TAMANO_MAX_XML) {
      estadoLectura('El archivo pesa demasiado (máximo 3,5 MB). Sube solo el XML o el .zip de la nota.', true);
      return;
    }
    estadoLectura('Leyendo la nota...');
    try {
      nx.base64 = await archivoABase64(archivo);
      nx.nombre = archivo.name;
      nx.preview = await api('/notas/xml/previsualizar', { method: 'POST', body: JSON.stringify({ archivoBase64: nx.base64 }) });
      nx.documentoId = nx.preview.documento ? nx.preview.documento.id : '';
      nx.tocado = new Set();
      mostrarRevision();
    } catch (err) {
      nx.base64 = null;
      nx.preview = null;
      estadoLectura(err.message, true);
    }
  }

  function nombreCuenta(codigo) {
    const p = nx.preview;
    const c = (p.cuentasLinea || []).find((x) => x.codigo === codigo);
    if (c) return c.nombre;
    if (FIJAS[codigo]) return FIJAS[codigo];
    const o = p.reversa && p.reversa.maximo && (p.reversa.maximo.otros || []).find((x) => x.cuentaCodigo === codigo);
    return o ? o.cuentaNombre || '' : '';
  }

  function opcionesCuentas(seleccionada) {
    return nx.preview.cuentasLinea
      .map((c) => `<option value="${esc(c.codigo)}"${c.codigo === seleccionada ? ' selected' : ''}>${esc(c.codigo)} — ${esc(c.nombre)}</option>`)
      .join('');
  }

  function pintarAdvertencias() {
    const lista = nx.preview.advertencias;
    const etiqueta = { bloqueo: 'No se puede registrar', confirmar: 'Revisa', info: 'Aviso' };
    $('nx-advertencias').innerHTML = lista.map((a) => `<div class="fx-aviso ${a.nivel}"><strong>${etiqueta[a.nivel] || ''}:</strong> ${esc(a.texto)}</div>`).join('');
    const hayConfirmar = lista.some((a) => a.nivel === 'confirmar');
    $('nx-aceptar-fila').hidden = !hayConfirmar;
    if (!hayConfirmar) $('nx-aceptar').checked = false;
  }

  function pintarResumen() {
    const p = nx.preview;
    const n = p.nota;
    const dian = n.validacionDian.disponible
      ? n.validacionDian.validada
        ? '<span class="badge libre aceptada">Validada por la DIAN</span>'
        : '<span class="badge libre rechazada">No validada</span>'
      : '<span class="badge libre pendiente">Sin respuesta de la DIAN en el archivo</span>';
    const lado = p.lado === 'compra' ? 'Compra: la expidió tu proveedor' : p.lado === 'venta' ? 'Venta: la expediste tú' : 'No corresponde a tu empresa';
    const filas = [
      ['Documento', `${esc(p.tituloTipo || n.tipoNombre)} <strong>${esc(n.numero || '—')}</strong>`],
      ['Lado', esc(lado)],
      ['Fecha de emisión', esc(formatoFecha(n.fechaEmision))],
      ['Emisor', `${esc(n.emisor ? n.emisor.nombre : '')}<br>NIT ${esc(n.emisor ? n.emisor.nit : '')}`],
      ['Receptor', `${esc(n.receptor ? n.receptor.nombre : '')}<br>NIT ${esc(n.receptor ? n.receptor.nit : '')}`],
      p.motivo || p.conceptoNombre ? ['Motivo', esc(p.motivo || p.conceptoNombre)] : null,
      ['Factura que cita', n.referencia && n.referencia.numero ? `${esc(n.referencia.numero)}${n.referencia.fecha ? ' · ' + esc(formatoFecha(n.referencia.fecha)) : ''}` : 'No cita ninguna'],
      ['Total de la nota', `<strong>${esc(dinero(n.totales.conImpuestos))}</strong>`],
      ['Validación', dian],
      [
        'CUDE',
        n.cufe ? `<span class="mono" title="${esc(n.cufe)}">${esc(n.cufe.slice(0, 18))}…${esc(n.cufe.slice(-8))}</span>` + (p.verificacionDianUrl ? `<br><a href="${esc(p.verificacionDianUrl)}" target="_blank" rel="noopener noreferrer">Verificar en la DIAN</a>` : '') : '—',
      ],
      ['Archivo', `${esc(nx.nombre)}<br><a href="#" id="nx-otro-archivo">Cargar otro archivo</a>`],
    ];
    $('nx-resumen').innerHTML = filas.filter(Boolean).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }

  function pintarTercero() {
    const p = nx.preview;
    const rotulo = p.lado === 'venta' ? 'Cliente' : 'Proveedor';
    $('nx-tercero-titulo').textContent = rotulo;
    const el = $('nx-tercero');
    const fila = $('nx-crear-tercero-fila');
    if (!p.lado) {
      el.textContent = '—';
      fila.hidden = true;
    } else if (p.tercero) {
      el.innerHTML = `✔ <strong>${esc(p.tercero.nombre)}</strong> (${esc(p.tercero.identificacion)}) ya está en Terceros.`;
      fila.hidden = true;
    } else {
      el.innerHTML = `<strong>${esc(p.terceroXml.nombre)}</strong> · NIT ${esc(p.terceroXml.nit)} no está en Terceros.`;
      fila.hidden = false;
    }
  }

  function pintarDocumentos() {
    const p = nx.preview;
    const sel = $('nx-documento');
    const opciones = [];
    if (!p.documento) opciones.push(`<option value="">Elige la factura que modifica…</option>`);
    for (const d of p.documentos) {
      opciones.push(`<option value="${esc(d.id)}"${d.id === nx.documentoId ? ' selected' : ''}>${esc(d.numero)} · ${esc(formatoFecha(d.fecha))} · ${esc(dinero(d.total))} · saldo ${esc(dinero(d.saldo))}</option>`);
    }
    opciones.push(`<option value="${NINGUNA}"${nx.documentoId === NINGUNA ? ' selected' : ''}>Registrar sin vincular a una factura</option>`);
    sel.innerHTML = opciones.join('');
    sel.value = nx.documentoId || '';
    sel.disabled = !p.lado;
  }

  function pintarProyectos() {
    const cual = $('nx-proyecto').value;
    $('nx-proyecto').innerHTML = '<option value="">Sin proyecto</option>' + listaProyectos.filter((x) => x.activo).map((x) => `<option value="${esc(x.id)}">${esc(etiquetaProyecto(x))}</option>`).join('');
    $('nx-proyecto').value = cual;
  }

  function pintarLineas() {
    const p = nx.preview;
    $('nx-detalle-titulo').textContent = p.lado === 'venta' ? 'Detalle y cuenta de ingreso' : 'Detalle y cuenta de gasto, costo o activo';
    $('nx-th-cuenta').textContent = p.lado === 'venta' ? 'Cuenta de ingreso' : 'Cuenta de gasto / costo';
    const previas = {};
    document.querySelectorAll('.nx-cuenta-linea').forEach((s) => (previas[Number(s.dataset.linea)] = s.value));
    $('nx-tabla-lineas').querySelector('tbody').innerHTML = p.nota.lineas
      .map((l, i) => {
        const elegida = nx.tocado.has(i) && previas[i] ? previas[i] : p.cuentasSugeridas[i];
        return `<tr><td>${esc(l.numero)}</td><td>${esc(l.descripcion)}</td><td class="num">${esc(l.cantidad)}</td><td class="num">${esc(dinero(l.valorTotal))}</td><td class="num">${esc(dinero(l.iva))}</td>` +
          `<td><select class="nx-cuenta-linea" data-linea="${i}"><option value="">Elegir cuenta...</option>${opcionesCuentas(elegida)}</select></td></tr>`;
      })
      .join('');
    $('nx-cuenta-todas').innerHTML = '<option value="">Elegir...</option>' + opcionesCuentas('');
  }

  // Retenciones que se reversan: solo en nota crédito vinculada a una factura que las tenía.
  function pintarReversa() {
    const p = nx.preview;
    const bloque = $('nx-rev-bloque');
    const r = p.reversa;
    bloque.hidden = !r;
    if (!r) return;
    const venta = r.lado === 'venta';
    $('nx-rev-fuente-etiqueta').textContent = venta ? 'ReteFuente' : 'Retención en la fuente';
    $('nx-rev-reteica-fila').hidden = !venta;
    $('nx-rev-retefuente').value = r.sugerida.retefuente || '';
    $('nx-rev-reteiva').value = r.sugerida.reteiva || '';
    $('nx-rev-reteica').value = venta ? r.sugerida.reteica || '' : '';
    const partes = [`Retención en la fuente ${dinero(r.original.retefuente)}`, `ReteIVA ${dinero(r.original.reteiva)}`];
    if (venta) partes.push(`ReteICA ${dinero(r.original.reteica)}`);
    const hay = r.maximo.retefuente + r.maximo.reteiva + (venta ? r.maximo.reteica : 0) + (venta ? (r.maximo.otros || []).reduce((s, o) => s + o.maximo, 0) : 0) > 0;
    $('nx-rev-nota').textContent = hay
      ? `La factura ${venta ? 'tenía descontado' : 'tenía retenido'}: ${partes.join(' · ')}. Se sugiere reversar la parte que cubre la nota; corrígelo si hace falta. ${venta ? 'La cuenta por cobrar baja solo por lo que realmente se iba a cobrar.' : 'La cuenta por pagar baja solo por lo que realmente se le iba a pagar al proveedor.'}`
      : 'La factura no tenía retenciones contabilizadas: no hay nada que reversar.';
    $('nx-rev-otros').innerHTML = venta
      ? (r.sugerida.otros || [])
          .map(
            (o, i) => `<div class="nx-otro"><span>${esc(o.concepto)} <span class="texto-suave">· ${esc(o.cuentaCodigo)} ${esc(o.cuentaNombre || '')}</span></span>` +
              `<input type="number" min="0" step="0.01" data-nx-otro="${i}" aria-label="${esc(o.concepto)}" value="${o.valor || ''}" placeholder="0"></div>`
          )
          .join('')
      : '';
  }

  // Lo que la persona dejó escrito como reversa, en el formato del servidor y en el de asientoNota.
  function leerReversa() {
    const p = nx.preview;
    const r = p.reversa;
    if (!r) return { servidor: undefined, asiento: {} };
    if (r.lado === 'compra') {
      const v = { retefuente: num('nx-rev-retefuente'), reteiva: num('nx-rev-reteiva') };
      return { servidor: v, asiento: v };
    }
    const otros = (r.sugerida.otros || []).map((o, i) => {
      const el = document.querySelector(`#nx-rev-otros [data-nx-otro="${i}"]`);
      return { concepto: o.concepto, cuentaCodigo: o.cuentaCodigo, valor: el ? Number(el.value || 0) : 0 };
    });
    const v = { retefuente: num('nx-rev-retefuente'), reteiva: num('nx-rev-reteiva'), reteica: num('nx-rev-reteica'), otros };
    return {
      servidor: v,
      asiento: {
        retenciones: [
          { cuentaCodigo: '135515', valor: v.retefuente },
          { cuentaCodigo: '135517', valor: v.reteiva },
          { cuentaCodigo: '135518', valor: v.reteica },
        ],
        descuentos: otros.map((o) => ({ cuentaCodigo: o.cuentaCodigo, valor: o.valor })),
      },
    };
  }

  function reversaExcede(rev) {
    const r = nx.preview.reversa;
    if (!r) return null;
    const m = r.maximo;
    const v = rev.servidor;
    if (v.retefuente > m.retefuente + 0.004) return 'La retención en la fuente que se reversa supera lo que tenía la factura.';
    if (v.reteiva > m.reteiva + 0.004) return 'El ReteIVA que se reversa supera lo que tenía la factura.';
    if (r.lado === 'venta' && v.reteica > m.reteica + 0.004) return 'El ReteICA que se reversa supera lo que tenía la factura.';
    if (r.lado === 'venta' && (v.otros || []).some((o, i) => o.valor > ((m.otros || [])[i] || { maximo: 0 }).maximo + 0.004)) return 'Una estampilla o tasa que se reversa supera lo que tenía la factura.';
    return null;
  }

  function leerCuentasLineas() {
    const c = {};
    document.querySelectorAll('.nx-cuenta-linea').forEach((s) => (c[Number(s.dataset.linea)] = s.value));
    return c;
  }

  function mostrarRevision() {
    $('nx-paso-archivo').hidden = true;
    $('nx-revision').hidden = false;
    $('nx-error').hidden = true;
    pintarAdvertencias();
    pintarResumen();
    pintarTercero();
    pintarDocumentos();
    pintarProyectos();
    pintarLineas();
    pintarReversa();
    recalcular();
  }

  function recalcular() {
    const p = nx.preview;
    if (!p) return;
    const c = p.contable;
    const cuentas = leerCuentasLineas();
    const lineasListas = p.lado && p.nota.lineas.every((_, i) => cuentas[i]);
    const proyecto = listaProyectos.find((x) => x.id === $('nx-proyecto').value);
    const rev = leerReversa();
    const reversaTotal = p.reversa
      ? redondear(rev.servidor.retefuente + rev.servidor.reteiva + (rev.servidor.reteica || 0) + (rev.servidor.otros || []).reduce((s, o) => s + o.valor, 0))
      : 0;
    const excede = p.lado && p.reversa ? reversaExcede(rev) : null;
    const reversaMayor = reversaTotal > 0 && reversaTotal >= c.total;

    let asiento = null;
    if (lineasListas && !excede && !reversaMayor && c.base > 0) {
      try {
        asiento = asientoNota.armarAsientoNota({
          lado: p.lado, tipo: p.tipo, lineas: p.nota.lineas, base: c.base, iva: c.iva, impoconsumo: c.impoconsumo, total: c.total,
          ivaDescontable: c.ivaDescontable, cuentasLinea: p.nota.lineas.map((_, i) => cuentas[i]), reversa: rev.asiento,
          centroCosto: proyecto ? proyecto.codigo || proyecto.nombre : null,
        });
      } catch (_) {
        asiento = null;
      }
    }
    const tbody = $('nx-tabla-asiento').querySelector('tbody');
    const tfoot = $('nx-tabla-asiento').querySelector('tfoot');
    if (asiento) {
      tbody.innerHTML = asiento.lineas
        .map(
          (l) => `<tr><td class="${l.credito ? 'indentar' : ''}">${esc(l.cuentaCodigo)} <span class="cuenta-nombre">${esc(nombreCuenta(l.cuentaCodigo))}</span>${l.centroCosto ? ` <span class="badge">${esc(l.centroCosto)}</span>` : ''}</td>` +
            `<td class="num">${l.debito ? esc(dinero(l.debito)) : ''}</td><td class="num">${l.credito ? esc(dinero(l.credito)) : ''}</td></tr>`
        )
        .join('');
      tfoot.innerHTML = `<tr><td>Sumas iguales${asiento.cuadra ? '' : ' — NO CUADRA'}</td><td class="num">${esc(dinero(asiento.totalDebito))}</td><td class="num">${esc(dinero(asiento.totalCredito))}</td></tr>`;
    } else {
      tbody.innerHTML = `<tr><td colspan="3" class="vacio">${p.lado ? 'Elige la cuenta de cada línea.' : 'La nota no se puede contabilizar.'}</td></tr>`;
      tfoot.innerHTML = '';
    }

    // Efecto sobre el saldo de la factura vinculada
    const doc = p.documento;
    const neto = redondear(c.total - (p.tipo === 'credito' ? reversaTotal : 0));
    let efecto = '';
    if (doc) {
      const despues = redondear(doc.saldo + (p.tipo === 'credito' ? -neto : neto));
      efecto = `<span>Saldo de la factura ${esc(doc.numero)}: <strong>${esc(dinero(doc.saldo))}</strong> → <strong>${esc(dinero(despues))}</strong></span>`;
      $('nx-documento-nota').textContent = doc.pagado > 0 ? `Ya tiene ${dinero(doc.pagado)} pagados o recaudados.` : 'La nota cambia el saldo de esta factura en Tesorería.';
    } else {
      $('nx-documento-nota').textContent = p.lado ? 'Sin factura vinculada la nota no cambia el saldo de ninguna factura.' : '';
    }
    $('nx-totales').innerHTML =
      `<span>Base: <strong>${esc(dinero(c.base))}</strong></span><span>IVA: <strong>${esc(dinero(c.iva))}</strong></span>` +
      (c.impoconsumo ? `<span>Impoconsumo: <strong>${esc(dinero(c.impoconsumo))}</strong></span>` : '') +
      `<span>Total nota: <strong>${esc(dinero(c.total))}</strong></span>` +
      (reversaTotal > 0 && p.tipo === 'credito' ? `<span>Retenciones que se reversan: <strong>− ${esc(dinero(reversaTotal))}</strong></span>` : '') +
      `<span>Efecto en lo que ${p.lado === 'venta' ? 'se cobra' : 'se debe'}: <strong class="neto">${p.tipo === 'credito' ? '− ' : '+ '}${esc(dinero(neto))}</strong></span>` + efecto;

    const pendientes = [];
    if (!p.lado) pendientes.push('La nota no corresponde a tu empresa.');
    if (p.advertencias.some((a) => a.nivel === 'bloqueo')) pendientes.push('La nota tiene errores que impiden registrarla.');
    if (excede) pendientes.push(excede);
    if (reversaMayor) pendientes.push('Las retenciones que se reversan deben ser menores que el total de la nota.');
    if (p.lado && !p.cuentasLinea.length) pendientes.push('Tu empresa no tiene cuentas para esta nota. Créalas en el plan de cuentas.');
    else if (p.lado && !lineasListas) pendientes.push('Elige la cuenta de cada línea.');
    if (p.lado && !p.tercero && !$('nx-crear-tercero').checked) pendientes.push('Marca “Crear este tercero” (o créalo antes en Terceros).');
    if (p.advertencias.some((a) => a.nivel === 'confirmar') && !$('nx-aceptar').checked) pendientes.push('Acepta las advertencias para continuar.');
    if (asiento && !asiento.cuadra) pendientes.push('El asiento no cuadra.');
    if (!puedeRegistrar()) pendientes.push('Tu rol no permite registrar notas.');
    $('nx-ayuda').textContent = pendientes[0] || 'Todo listo para contabilizar.';
    $('btn-registrar-nota-xml').disabled = pendientes.length > 0 || nx.enviando;
  }

  // Cambió la factura elegida: el servidor vuelve a revisar saldos, retenciones y cuentas sugeridas.
  async function alCambiarDocumento() {
    nx.documentoId = $('nx-documento').value;
    try {
      const nuevo = await api('/notas/xml/previsualizar', { method: 'POST', body: JSON.stringify({ archivoBase64: nx.base64, documentoId: nx.documentoId || undefined }) });
      const aceptado = $('nx-aceptar').checked;
      nx.preview = nuevo;
      $('nx-aceptar').checked = aceptado && nuevo.advertencias.some((a) => a.nivel === 'confirmar');
      pintarAdvertencias();
      pintarDocumentos();
      pintarLineas();
      pintarReversa();
    } catch (err) {
      $('nx-error').textContent = err.message;
      $('nx-error').hidden = false;
    }
    recalcular();
  }

  async function registrar() {
    const p = nx.preview;
    if (!p || nx.enviando) return;
    nx.enviando = true;
    const boton = $('btn-registrar-nota-xml');
    boton.disabled = true;
    boton.textContent = 'Registrando…';
    $('nx-error').hidden = true;
    try {
      const rev = leerReversa();
      const cuerpo = {
        archivoBase64: nx.base64,
        documentoId: nx.documentoId || undefined,
        terceroId: p.tercero ? p.tercero.id : undefined,
        crearTercero: !p.tercero && $('nx-crear-tercero').checked,
        cuentasLineas: leerCuentasLineas(),
        proyectoId: $('nx-proyecto').value || undefined,
        reversa: p.reversa ? rev.servidor : undefined,
        aceptarAdvertencias: $('nx-aceptar').checked,
      };
      const r = await api('/notas/xml', { method: 'POST', body: JSON.stringify(cuerpo) });
      nx.enviando = false;
      dialogo.close();
      await cargarLista();
      const avisos = [];
      if (r.periodoAjustado) avisos.push('La fecha de la nota cae en un período cerrado: el asiento quedó en el período vigente.');
      if (r.requiereRevision) avisos.push('La regla de esta nota está en modo manual: el asiento quedó pendiente de revisión.');
      abrirDetalle(r.nota.id, avisos, `${NOMBRE_TIPO[r.nota.tipo]} ${r.nota.numero || ''} registrada y contabilizada.`);
    } catch (err) {
      $('nx-error').textContent = err.message;
      $('nx-error').hidden = false;
      // Si el servidor pide aceptar advertencias que la pantalla no mostraba (por ejemplo por un valor que la persona cambió), se muestran.
      if (/advertencias que debes revisar/.test(err.message)) {
        $('nx-aceptar-fila').hidden = false;
      }
    } finally {
      nx.enviando = false;
      boton.textContent = 'Registrar y contabilizar';
      recalcular();
    }
  }

  // --- Detalle ---------------------------------------------------------------------------

  const dialogoDetalle = $('dialogo-nota-detalle');

  async function abrirDetalle(id, avisos, mensajeOk) {
    try {
      const n = await api(`/notas/${id}`);
      N.detalleId = id;
      const det = n.detalle || {};
      const lineas = det.lineas || [];
      const rev = n.reversa || {};
      const cuentaTxt = (codigo, nombre) => `${esc(codigo)} <span class="cuenta-nombre">${esc(nombre || '')}</span>`;
      $('titulo-nota-detalle').textContent = `${NOMBRE_TIPO[n.tipo]} ${n.numero || ''}`.trim();
      const reversaTxt = [['ReteFuente', rev.retefuente], ['ReteIVA', rev.reteiva], ['ReteICA', rev.reteica]]
        .filter(([, v]) => Number(v) > 0)
        .map(([t, v]) => `${t} ${esc(dinero(v))}`)
        .concat((rev.otros || []).map((o) => `${esc(o.concepto)} ${esc(dinero(o.valor))}`))
        .join(' · ');
      const filas = [
        ['Lado', n.lado === 'compra' ? 'De compra (la expidió el proveedor)' : 'De venta (la expediste tú)'],
        [n.lado === 'compra' ? 'Proveedor' : 'Cliente', `${esc(n.terceroNombre || '')}<br>NIT ${esc(n.terceroNit || '')}`],
        ['Fecha', esc(formatoFecha(n.fecha))],
        ['Factura que modifica', n.factura ? `${esc(n.factura.numero || '')} · ${esc(formatoFecha(n.factura.fecha))} · ${esc(dinero(n.factura.total))}` : n.referenciaNumero ? `${esc(n.referenciaNumero)} <span class="texto-suave">(no está registrada)</span>` : 'Sin vincular'],
        n.motivo ? ['Motivo', esc(n.motivo)] : null,
        ['Base', esc(dinero(n.subtotal))],
        ['IVA', esc(dinero(n.iva))],
        Number(n.impoconsumo) > 0 ? ['Impoconsumo', esc(dinero(n.impoconsumo))] : null,
        ['Total', `<strong>${esc(dinero(n.total))}</strong>`],
        Number(n.reversaTotal) > 0 ? ['Retenciones que reversa', `− ${esc(dinero(n.reversaTotal))}<br><span class="texto-suave">${reversaTxt}</span>`] : null,
        [n.tipo === 'credito' ? 'Baja el saldo en' : 'Sube el saldo en', `<strong>${esc(dinero(n.neto))}</strong>`],
        ['Estado', n.estado === 'anulada' ? `<span class="badge rechazada">anulada</span><br><span class="texto-suave">${esc(n.motivoAnulacion || '')}</span>` : '<span class="badge aceptada">vigente</span>'],
        ['CUDE', n.cufe ? `<span class="mono" title="${esc(n.cufe)}">${esc(n.cufe.slice(0, 18))}…${esc(n.cufe.slice(-8))}</span>` : '—'],
      ];
      $('nd-cuerpo').innerHTML =
        (mensajeOk ? `<div class="fd-aviso">${esc(mensajeOk)}</div>` : '') +
        (avisos || []).map((a) => `<div class="fd-aviso alerta">${esc(a)}</div>`).join('') +
        `<dl class="fx-resumen">${filas.filter(Boolean).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
        (lineas.length
          ? `<h4>Detalle</h4><table class="tabla-items-detalle"><thead><tr><th>#</th><th>Descripción</th><th class="num">Cant.</th><th class="num">Valor</th><th class="num">IVA</th><th>Cuenta</th></tr></thead><tbody>` +
            lineas.map((l) => `<tr><td>${esc(l.numero)}</td><td>${esc(l.descripcion)}</td><td class="num">${esc(l.cantidad)}</td><td class="num">${esc(dinero(l.valorTotal))}</td><td class="num">${esc(dinero(l.iva))}</td><td>${esc(l.cuentaCodigo)}</td></tr>`).join('') +
            `</tbody></table>`
          : '') +
        `<h4>Asiento contable</h4>` +
        (n.asiento && n.asiento.length
          ? `<table class="tabla-items-detalle"><thead><tr><th>Cuenta</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead><tbody>` +
            n.asiento.map((m) => `<tr><td class="${m.credito ? 'indentar' : ''}">${cuentaTxt(m.cuentaCodigo, m.cuentaNombre)}${m.centroCosto ? ` <span class="badge">${esc(m.centroCosto)}</span>` : ''}</td><td class="num">${m.debito ? esc(dinero(m.debito)) : ''}</td><td class="num">${m.credito ? esc(dinero(m.credito)) : ''}</td></tr>`).join('') +
            `</tbody></table>${n.estado === 'anulada' ? '<p class="fx-texto">El asiento de esta nota está anulado.</p>' : ''}`
          : '<p class="fx-texto">Esta nota no tiene asiento (quedó pendiente de revisión).</p>') +
        (n.estado === 'activa' && puedeAnular()
          ? `<h4>Anular esta nota</h4><p class="nota-aiu">Anula su asiento y devuelve el saldo de la factura. Úsalo si se cargó por error.</p>` +
            `<div class="fila-campos"><label class="campo-etiquetado nx-anular"><span>Motivo (mínimo 10 letras)</span><input type="text" id="nd-motivo" maxlength="250" autocomplete="off"></label>` +
            `<button type="button" class="btn-accion destructivo" data-nx="anular" data-id="${esc(n.id)}">Anular nota</button></div><p class="fx-error" id="nd-error" hidden></p>`
          : '');
      if (typeof dialogoDetalle.showModal === 'function') {
        if (!dialogoDetalle.open) dialogoDetalle.showModal();
      } else dialogoDetalle.setAttribute('open', '');
    } catch (err) {
      alert(err.message);
    }
  }

  async function anular(id) {
    const motivo = $('nd-motivo').value;
    $('nd-error').hidden = true;
    try {
      await api(`/notas/${id}/anular`, { method: 'POST', body: JSON.stringify({ motivo }) });
      await cargarLista();
      await abrirDetalle(id, [], 'Nota anulada: el saldo de la factura volvió a lo que era.');
    } catch (err) {
      $('nd-error').textContent = err.message;
      $('nd-error').hidden = false;
    }
  }

  async function descargarXml(id) {
    try {
      const res = await fetch(`${API}/notas/${id}/xml`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo descargar el XML.');
      const blob = await res.blob();
      const nombre = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      const enlace = document.createElement('a');
      enlace.href = URL.createObjectURL(blob);
      enlace.download = nombre ? nombre[1] : 'nota.xml';
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(enlace.href);
    } catch (err) {
      alert(err.message);
    }
  }

  // --- Eventos ---------------------------------------------------------------------------

  $('btn-cargar-nota-xml').addEventListener('click', abrir);
  $('btn-cerrar-nota-xml').addEventListener('click', cerrar);
  $('btn-cancelar-nota-xml').addEventListener('click', cerrar);
  $('btn-registrar-nota-xml').addEventListener('click', registrar);
  $('nx-archivo').addEventListener('change', (e) => procesarArchivo(e.target.files[0]));
  const zona = $('nx-zona-archivo');
  ['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('arrastrando'); }));
  ['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove('arrastrando'); }));
  zona.addEventListener('drop', (e) => procesarArchivo(e.dataTransfer.files[0]));
  $('nx-resumen').addEventListener('click', (e) => {
    if (e.target.id === 'nx-otro-archivo') {
      e.preventDefault();
      reiniciar();
    }
  });
  $('nx-documento').addEventListener('change', alCambiarDocumento);
  $('nx-proyecto').addEventListener('change', recalcular);
  $('nx-aceptar').addEventListener('change', recalcular);
  $('nx-crear-tercero').addEventListener('change', recalcular);
  $('nx-tabla-lineas').addEventListener('change', (e) => {
    if (!e.target.classList.contains('nx-cuenta-linea')) return;
    nx.tocado.add(Number(e.target.dataset.linea));
    recalcular();
  });
  $('nx-cuenta-todas').addEventListener('change', (e) => {
    if (!e.target.value) return;
    document.querySelectorAll('.nx-cuenta-linea').forEach((s) => {
      s.value = e.target.value;
      nx.tocado.add(Number(s.dataset.linea));
    });
    e.target.value = '';
    recalcular();
  });
  $('nx-rev-bloque').addEventListener('input', recalcular);

  $('panel-notas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nx]');
    if (b && b.dataset.nx === 'ver') abrirDetalle(b.dataset.id);
  });
  $('nd-cuerpo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nx]');
    if (b && b.dataset.nx === 'anular') anular(b.dataset.id);
  });
  $('btn-cerrar-nota-detalle').addEventListener('click', () => dialogoDetalle.close());
  $('btn-cerrar-nota-detalle-pie').addEventListener('click', () => dialogoDetalle.close());
  $('btn-xml-nota-detalle').addEventListener('click', () => N.detalleId && descargarXml(N.detalleId));
  for (const [id, campo] of [['nx-filtro-lado', 'lado'], ['nx-filtro-tipo', 'tipo'], ['nx-filtro-estado', 'estado']]) {
    $(id).addEventListener('change', (e) => {
      N.filtro[campo] = e.target.value;
      cargarLista().catch((err) => alert(err.message));
    });
  }
  $('btn-cargar-nota-xml').hidden = !puedeRegistrar();

  // Lo llama app.js al abrir la pestaña.
  window.notasAlMostrar = function () {
    $('btn-cargar-nota-xml').hidden = !puedeRegistrar();
    cargarLista().catch((err) => alert(err.message));
  };

  // Notas de una factura (para su ventana de detalle): se agregan al final, sin demorar la ventana.
  window.notasEnDetalle = async function (docTipo, docId) {
    try {
      const notas = await api(`/notas/documento/${docTipo}/${docId}`);
      if (!notas.length) return;
      const cuerpo = document.getElementById('fd-cuerpo');
      if (!cuerpo) return;
      cuerpo.insertAdjacentHTML(
        'beforeend',
        `<h4>Notas crédito y débito</h4><table class="tabla-items-detalle"><thead><tr><th>Nota</th><th>Fecha</th><th class="num">Total</th><th class="num">Efecto en el saldo</th><th>Estado</th></tr></thead><tbody>` +
          notas
            .map(
              (n) => `<tr><td>${esc(NOMBRE_TIPO[n.tipo])} ${esc(n.numero || '')}</td><td>${esc(formatoFecha(n.fecha))}</td><td class="num">${esc(dinero(n.total))}</td>` +
                `<td class="num">${n.estado === 'anulada' ? '—' : (n.tipo === 'credito' ? '− ' : '+ ') + esc(dinero(n.neto))}</td><td>${n.estado === 'anulada' ? 'anulada' : 'vigente'}</td></tr>`
            )
            .join('') +
          `</tbody></table>`
      );
    } catch (_) {
      /* las notas son un complemento: si fallan, la factura se ve igual */
    }
  };
})();
