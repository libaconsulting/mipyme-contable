// Pantalla de Nómina.
//
// Va en su propio archivo (app.js ya es muy grande) y se carga DESPUÉS de app.js:
// usa sus ayudas globales (api, escHtml, formatoDinero, formatoFecha, badge) y los
// módulos compartidos con el servidor (parametrosLaborales, liquidacionNomina) para
// la simulación del costo de un empleado mientras se llena el contrato.
//
// Pestañas internas: Liquidación mensual · Empleados y contratos · Novedades ·
// Provisiones · Planilla de aportes · Configuración.
(function () {
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const SUBS = [
    ['liquidacion', 'Liquidación mensual'],
    ['contratos', 'Empleados y contratos'],
    ['novedades', 'Novedades'],
    ['provisiones', 'Provisiones'],
    ['planilla', 'Planilla de aportes'],
    ['config', 'Configuración'],
  ];
  // Pestañas que agrega nominaPrestaciones.js (prestaciones y vacaciones).
  const subsExternas = {};
  const TIPOS_CONTRATO = { indefinido: 'Indefinido', fijo: 'Término fijo', obra_labor: 'Obra o labor' };
  const ESTADOS = { borrador: 'Borrador', contabilizada: 'Contabilizada', pagada: 'Pagada' };

  const nom = {
    sub: 'liquidacion',
    opciones: null,
    periodos: [],
    detalle: null, // período abierto
    contratos: [],
    ausencias: [],
    conceptos: [],
    planillaPeriodoId: null,
    provisionesAnio: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => escHtml(v);
  const dinero = (v) => formatoDinero(v);
  const puedeEditar = () => !!usuario && ['contador', 'dueño'].includes(usuario.rol);
  const nombreMes = (anio, mes) => `${MESES[mes - 1]} de ${anio}`;
  const contenido = () => $('nom-contenido');

  function boton(texto, nomAccion, datos, clase) {
    const attrs = Object.entries(datos || {}).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
    return `<button type="button" class="${clase || 'btn-accion'}" data-nom="${nomAccion}" ${attrs}>${texto}</button>`;
  }

  function aviso(tipo, texto) {
    return `<p class="fx-aviso ${tipo}">${texto}</p>`;
  }

  function mostrarError(err) {
    alert(err && err.message ? err.message : String(err));
  }

  // --- Diálogo genérico ----------------------------------------------------------
  let dialogoActual = null;
  function abrirDialogo({ titulo, cuerpo, guardar, extra, ancho }) {
    const dlg = $('dialogo-nom');
    $('titulo-nom').textContent = titulo;
    $('nom-dialogo-cuerpo').innerHTML = cuerpo;
    $('nom-dialogo-error').hidden = true;
    $('nom-dialogo-ayuda').textContent = '';
    dlg.classList.toggle('dialogo-chico', !ancho);
    const btnGuardar = $('btn-nom-guardar');
    btnGuardar.hidden = !guardar;
    btnGuardar.disabled = false;
    btnGuardar.textContent = guardar ? guardar.texto : 'Guardar';
    const cont = $('nom-dialogo-extra');
    cont.innerHTML = (extra || []).map((x, i) => `<button type="button" class="btn-secundario" data-nom-extra="${i}">${x.texto}</button>`).join('');
    dialogoActual = { guardar, extra: extra || [] };
    if (!dlg.open) dlg.showModal();
  }

  function cerrarDialogo() {
    const dlg = $('dialogo-nom');
    if (dlg.open) dlg.close();
    dialogoActual = null;
  }

  function errorDialogo(mensaje) {
    const el = $('nom-dialogo-error');
    el.textContent = mensaje;
    el.hidden = !mensaje;
  }

  $('btn-cerrar-nom').addEventListener('click', cerrarDialogo);
  $('btn-nom-cancelar').addEventListener('click', cerrarDialogo);
  $('btn-nom-guardar').addEventListener('click', async () => {
    if (!dialogoActual || !dialogoActual.guardar) return;
    const btn = $('btn-nom-guardar');
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
  $('nom-dialogo-extra').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nom-extra]');
    if (b && dialogoActual) dialogoActual.extra[Number(b.dataset.nomExtra)].fn();
  });

  const v = (id) => ($(id) ? $(id).value : '');
  const num = (id) => {
    const t = String(v(id)).replace(/[^\d.\-]/g, '');
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  };
  const campo = (etiqueta, html, clase) => `<label class="campo-etiquetado ${clase || ''}"><span>${etiqueta}</span>${html}</label>`;
  const opcionesSelect = (pares, elegido) => pares.map(([val, txt]) => `<option value="${esc(val)}"${String(val) === String(elegido) ? ' selected' : ''}>${esc(txt)}</option>`).join('');

  // --- Carga de datos ------------------------------------------------------------------
  async function cargarOpciones() {
    nom.opciones = await api('/nomina/opciones');
    return nom.opciones;
  }

  async function mostrarSub(sub) {
    nom.sub = sub;
    document.querySelectorAll('#nom-subtabs button').forEach((b) => b.classList.toggle('activo', b.dataset.sub === sub));
    contenido().innerHTML = '<p class="nota-panel">Cargando…</p>';
    try {
      if (!nom.opciones) await cargarOpciones();
      if (subsExternas[sub]) return await subsExternas[sub]();
      if (sub === 'liquidacion') {
        nom.periodos = await api('/nomina/periodos');
        if (nom.detalle) nom.detalle = await api(`/nomina/periodos/${nom.detalle.periodo.id}`).catch(() => null);
        return nom.detalle ? renderDetallePeriodo() : renderPeriodos();
      }
      if (sub === 'contratos') {
        nom.contratos = await api('/nomina/contratos');
        return renderContratos();
      }
      if (sub === 'novedades') {
        [nom.ausencias, nom.conceptos] = await Promise.all([api('/nomina/ausencias'), api('/nomina/conceptos')]);
        return renderNovedades();
      }
      if (sub === 'provisiones') return await cargarProvisiones();
      if (sub === 'planilla') {
        nom.periodos = await api('/nomina/periodos');
        return await cargarPlanilla();
      }
      if (sub === 'config') return renderConfig();
    } catch (err) {
      contenido().innerHTML = aviso('bloqueo', esc(err.message || err));
    }
  }

  // ===================================================================================
  // LIQUIDACIÓN MENSUAL
  // ===================================================================================
  function renderPeriodos() {
    const o = nom.opciones;
    let html = `<div class="nom-barra">
      <p class="nota-panel">Cada mes se calcula la nómina de todos los empleados con contrato vigente: sueldo, auxilio, novedades, aportes a seguridad social, retención en la fuente y provisiones de prestaciones. Revísala en borrador, y cuando esté bien se contabiliza.</p>
      ${puedeEditar() ? boton('+ Nueva nómina', 'nuevo-periodo', {}, 'btn-primario') : ''}
    </div>`;
    html += `<p class="nota-aiu">Parámetros ${o.parametros.anio}: salario mínimo ${dinero(o.parametros.smmlv)} · auxilio de transporte ${dinero(o.parametros.auxilioTransporte)} · UVT ${dinero(o.parametros.uvt)}${o.parametros.estimado ? ' (estimados: faltan los del año)' : ''}.</p>`;
    if (nom.periodos.length === 0) {
      html += '<p class="vacio">Todavía no hay nóminas. Primero registra los contratos en “Empleados y contratos”, luego crea la nómina del mes.</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Mes</th><th>Estado</th><th class="num">Empleados</th><th class="num">Devengado</th><th class="num">Deducciones</th><th class="num">Neto a pagar</th><th class="num">Aportes empleador</th><th class="num">Provisiones</th><th></th></tr></thead><tbody>
      ${nom.periodos.map((p) => `<tr>
        <td><strong>${esc(nombreMes(p.anio, p.mes))}</strong></td>
        <td>${badge(p.estado)}</td>
        <td class="num">${p.empleados}</td>
        <td class="num">${dinero(p.totalDevengado)}</td>
        <td class="num">${dinero(p.totalDeducciones)}</td>
        <td class="num">${dinero(p.totalNeto)}</td>
        <td class="num">${dinero(p.totalAportesEmpleador)}</td>
        <td class="num">${dinero(p.totalProvisiones)}</td>
        <td class="acciones">${boton('Abrir', 'abrir-periodo', { id: p.id })}</td></tr>`).join('')}
      </tbody></table></div>`;
    }
    contenido().innerHTML = html;
  }

  function dialogoNuevoPeriodo() {
    const o = nom.opciones;
    let anio = Number(o.hoy.slice(0, 4));
    let mes = Number(o.hoy.slice(5, 7));
    const ultimo = nom.periodos[0];
    if (ultimo) {
      mes = ultimo.mes + 1;
      anio = ultimo.anio;
      if (mes > 12) { mes = 1; anio += 1; }
    }
    abrirDialogo({
      titulo: 'Nueva nómina',
      cuerpo: `<div class="fila-campos">${campo('Mes', `<select id="np-mes">${opcionesSelect(MESES.map((m, i) => [i + 1, m]), mes)}</select>`)}
        ${campo('Año', `<input type="number" id="np-anio" value="${anio}" min="2020" max="2100">`)}</div>
        <p class="nota-aiu">Se calcula con los contratos, ausencias y novedades que hay hasta hoy. Mientras esté en borrador puedes agregar novedades y recalcular.</p>`,
      guardar: {
        texto: 'Crear y calcular',
        fn: async () => {
          const d = await api('/nomina/periodos', { method: 'POST', body: JSON.stringify({ anio: num('np-anio'), mes: num('np-mes') }) });
          nom.detalle = d;
          nom.periodos = await api('/nomina/periodos');
          renderDetallePeriodo();
        },
      },
    });
  }

  function renderDetallePeriodo() {
    const d = nom.detalle;
    const p = d.periodo;
    const editar = puedeEditar();
    const costo = p.totalDevengado + p.totalAportesEmpleador + p.totalProvisiones;
    const conError = d.liquidaciones.filter((l) => l.error);
    let html = `<div class="nom-barra">
      ${boton('← Nóminas', 'volver-periodos', {}, 'btn-secundario btn-chico')}
      <h3>Nómina de ${esc(nombreMes(p.anio, p.mes))}</h3> ${badge(p.estado)}
      <span class="nota-aiu">${p.fechaPago ? 'Pagada el ' + esc(formatoFecha(p.fechaPago)) : ''}</span>
    </div>
    <div class="nom-tarjetas">
      <div class="nom-tarjeta"><span>Devengado</span><strong>${dinero(p.totalDevengado)}</strong></div>
      <div class="nom-tarjeta"><span>Deducciones al empleado</span><strong>${dinero(p.totalDeducciones)}</strong></div>
      <div class="nom-tarjeta destacada"><span>Neto a pagar</span><strong>${dinero(p.totalNeto)}</strong></div>
      <div class="nom-tarjeta"><span>Aportes del empleador</span><strong>${dinero(p.totalAportesEmpleador)}</strong></div>
      <div class="nom-tarjeta"><span>Provisiones del mes</span><strong>${dinero(p.totalProvisiones)}</strong></div>
      <div class="nom-tarjeta"><span>Costo total para la empresa</span><strong>${dinero(costo)}</strong></div>
    </div>`;

    if (d.parametros.estimado) html += aviso('confirmar', 'No hay parámetros cargados para este año; se usaron los del último año conocido. Revísalos antes de contabilizar.');
    if (conError.length) html += aviso('bloqueo', 'No se pudo liquidar a: ' + conError.map((l) => `<strong>${esc(l.nombre)}</strong> (${esc(l.error)})`).join('; ') + '. Corrígelo y recalcula.');
    if (d.advertencias.length) html += aviso('confirmar', '<strong>Revisa:</strong><br>' + d.advertencias.map(esc).join('<br>'));
    if (d.liquidaciones.length === 0) html += aviso('info', 'No hay empleados con contrato vigente en este mes.');

    if (d.liquidaciones.length) {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th class="num">Días</th><th class="num">Devengado</th><th class="num">Deducciones</th><th class="num">Neto</th><th class="num">Aportes empleador</th><th class="num">Provisiones</th><th></th></tr></thead><tbody>
      ${d.liquidaciones.map((l) => `<tr${l.error ? ' class="fila-error"' : ''}>
        <td><strong>${esc(l.nombre)}</strong><br><span class="texto-suave">${esc(l.cargo || '')}${l.areaGasto === 'ventas' ? ' · ventas' : ''}</span></td>
        <td class="num">${l.diasTrabajados}</td>
        <td class="num">${dinero(l.devengado)}</td>
        <td class="num">${dinero(l.deducciones)}</td>
        <td class="num"><strong>${dinero(l.neto)}</strong></td>
        <td class="num">${dinero(l.aportesEmpleador)}</td>
        <td class="num">${dinero(l.provisiones)}</td>
        <td class="acciones">${l.error ? '' : boton('Ver', 'ver-liquidacion', { empleado: l.empleadoId })}</td></tr>`).join('')}
      </tbody></table></div>`;
    }

    html += '<div class="nom-acciones">';
    if (editar && p.estado === 'borrador') {
      html += boton('Recalcular', 'recalcular', {}, 'btn-secundario');
      html += boton('Contabilizar nómina y provisiones', 'contabilizar', {}, 'btn-primario');
    }
    if (editar && p.estado === 'contabilizada') {
      html += boton('Registrar pago de salarios', 'pagar', {}, 'btn-primario');
      html += boton('Reabrir', 'reabrir', {}, 'btn-secundario');
    }
    if (d.liquidaciones.length) html += boton('Planilla de aportes', 'ir-planilla', { id: p.id }, 'btn-secundario');
    html += '</div>';

    if (d.vistaPrevia) {
      if (d.vistaPrevia.error) html += aviso('bloqueo', esc(d.vistaPrevia.error));
      else {
        const titulo = p.estado === 'borrador' ? 'Así se contabilizará' : 'Asientos contabilizados';
        html += `<details class="nom-detalles"><summary>${titulo}: liquidación de la nómina</summary>${tablaAsiento(d.vistaPrevia.liquidacion)}</details>`;
        html += `<details class="nom-detalles"><summary>${titulo}: provisiones de prestaciones</summary>${tablaAsiento(d.vistaPrevia.provisiones)}</details>`;
      }
    }
    contenido().innerHTML = html;
  }

  function tablaAsiento(a) {
    return `<div class="tabla-envoltorio"><table class="tabla-items-detalle"><thead><tr><th>Cuenta</th><th>Tercero</th><th class="num">Débito</th><th class="num">Crédito</th></tr></thead><tbody>
      ${a.lineas.map((l) => `<tr><td><span class="mono">${esc(l.cuentaCodigo)}</span> ${esc(l.cuentaNombre)}</td><td>${esc(l.terceroNombre)}</td><td class="num">${l.debito ? dinero(l.debito) : ''}</td><td class="num">${l.credito ? dinero(l.credito) : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2"><strong>Total</strong></td><td class="num"><strong>${dinero(a.totalDebito)}</strong></td><td class="num"><strong>${dinero(a.totalCredito)}</strong></td></tr></tfoot></table></div>`;
  }

  async function accionPeriodo(ruta, opciones, mensajeOk) {
    try {
      const r = await api(`/nomina/periodos/${nom.detalle.periodo.id}/${ruta}`, { method: 'POST', body: JSON.stringify(opciones || {}) });
      nom.detalle = r;
      nom.periodos = await api('/nomina/periodos');
      renderDetallePeriodo();
      if (mensajeOk) alert(mensajeOk);
    } catch (err) {
      mostrarError(err);
    }
  }

  function dialogoReabrir() {
    abrirDialogo({
      titulo: 'Reabrir la nómina',
      cuerpo: `<p>Se anulan los asientos de la liquidación y de las provisiones, y la nómina vuelve a borrador para corregirla. Después se contabiliza de nuevo.</p>
        ${campo('Motivo (queda en la auditoría)', '<input type="text" id="nr-motivo" maxlength="250" autocomplete="off" placeholder="Ej.: faltaba una comisión del mes">')}`,
      guardar: {
        texto: 'Reabrir',
        fn: async () => {
          const r = await api(`/nomina/periodos/${nom.detalle.periodo.id}/reabrir`, { method: 'POST', body: JSON.stringify({ motivo: v('nr-motivo') }) });
          nom.detalle = r;
          nom.periodos = await api('/nomina/periodos');
          renderDetallePeriodo();
        },
      },
    });
  }

  function dialogoPago() {
    const p = nom.detalle.periodo;
    const bancos = nom.opciones.cuentasBancarias;
    abrirDialogo({
      titulo: 'Registrar pago de salarios',
      cuerpo: `<p>Se paga el neto de cada empleado: <strong>${dinero(p.totalNeto)}</strong>. Los aportes a seguridad social se pagan con la planilla.</p>
        <div class="fila-campos">
          ${campo('Desde', `<select id="pg-medio">${bancos.map((b) => `<option value="${b.id}">${esc(b.banco)} ${esc(b.tipoCuenta || '')} ****${esc(b.numero)}</option>`).join('')}<option value="caja">Efectivo (caja)</option></select>`)}
          ${campo('Fecha del pago', `<input type="date" id="pg-fecha" value="${nom.opciones.hoy}">`)}
        </div>
        <p class="nota-aiu">Queda registrado un egreso en la cuenta bancaria, pendiente de conciliar con el extracto.</p>`,
      guardar: {
        texto: 'Registrar pago',
        fn: async () => {
          const medio = v('pg-medio');
          const cuerpo = { fecha: v('pg-fecha') };
          if (medio === 'caja') cuerpo.medio = 'caja';
          else cuerpo.cuentaBancariaId = medio;
          const r = await api(`/nomina/periodos/${p.id}/pago`, { method: 'POST', body: JSON.stringify(cuerpo) });
          nom.detalle = r;
          nom.periodos = await api('/nomina/periodos');
          renderDetallePeriodo();
        },
      },
    });
  }

  // --- Detalle y desprendible de un empleado ---------------------------------------------
  function bloqueLiquidacion(d) {
    const L = d.resultado;
    const filaDev = (x) => `<tr><td>${esc(x.descripcion)}${x.detalle ? ` <span class="texto-suave">${esc(x.detalle)}</span>` : ''}${x.dias ? ` <span class="texto-suave">${x.dias} días</span>` : ''}</td><td class="num">${dinero(x.valor)}</td></tr>`;
    const filaDed = (x) => `<tr><td>${esc(x.descripcion)}</td><td class="num">${dinero(x.valor)}</td></tr>`;
    const ap = L.aportes;
    let h = `<div class="fx-rejilla">
      <div class="fx-bloque"><h4>Devengado</h4><table class="tabla-items-detalle"><tbody>${L.devengos.map(filaDev).join('')}</tbody>
        <tfoot><tr><td><strong>Total devengado</strong></td><td class="num"><strong>${dinero(L.totales.devengado)}</strong></td></tr></tfoot></table></div>
      <div class="fx-bloque"><h4>Deducciones</h4><table class="tabla-items-detalle"><tbody>${L.deducciones.map(filaDed).join('') || '<tr><td colspan="2" class="vacio">Sin deducciones</td></tr>'}</tbody>
        <tfoot><tr><td><strong>Total deducciones</strong></td><td class="num"><strong>${dinero(L.totales.deducciones)}</strong></td></tr>
        <tr><td><strong>Neto a pagar</strong></td><td class="num"><strong>${dinero(L.totales.neto)}</strong></td></tr></tfoot></table></div>
    </div>`;
    h += `<p class="nota-aiu">Días: ${L.dias.trabajados} trabajados${L.dias.vacaciones ? `, ${L.dias.vacaciones} de vacaciones` : ''}${L.dias.incapacidadesYLicencias ? `, ${L.dias.incapacidadesYLicencias} de incapacidad o licencia` : ''}${L.dias.noRemunerados ? `, ${L.dias.noRemunerados} sin remuneración` : ''}. IBC para seguridad social: ${dinero(L.ibc.total)}.</p>`;
    h += `<details class="nom-detalles"><summary>Aportes del empleador (no se descuentan al empleado)</summary><table class="tabla-items-detalle"><tbody>
      <tr><td>Salud (8,5 %)${ap.exonerado ? ' <span class="texto-suave">exonerado art. 114-1</span>' : ''}</td><td class="num">${dinero(ap.empleador.salud)}</td></tr>
      <tr><td>Pensión (12 %)</td><td class="num">${dinero(ap.empleador.pension)}</td></tr>
      <tr><td>Riesgos laborales (clase ${L.pila.claseRiesgo})</td><td class="num">${dinero(ap.empleador.arl)}</td></tr>
      <tr><td>Caja de compensación (4 %)</td><td class="num">${dinero(ap.empleador.caja)}</td></tr>
      <tr><td>SENA (2 %)</td><td class="num">${dinero(ap.empleador.sena)}</td></tr>
      <tr><td>ICBF (3 %)</td><td class="num">${dinero(ap.empleador.icbf)}</td></tr></tbody>
      <tfoot><tr><td><strong>Total</strong></td><td class="num"><strong>${dinero(ap.empleador.total)}</strong></td></tr></tfoot></table></details>`;
    h += `<details class="nom-detalles"><summary>Provisiones de prestaciones del mes</summary><table class="tabla-items-detalle"><tbody>
      <tr><td>Cesantías (8,33 %)</td><td class="num">${dinero(L.provisiones.cesantias)}</td></tr>
      <tr><td>Intereses sobre cesantías (12 % anual)</td><td class="num">${dinero(L.provisiones.intereses)}</td></tr>
      <tr><td>Prima de servicios (8,33 %)</td><td class="num">${dinero(L.provisiones.prima)}</td></tr>
      <tr><td>Vacaciones (4,17 %)</td><td class="num">${dinero(L.provisiones.vacaciones)}</td></tr></tbody>
      <tfoot><tr><td><strong>Total</strong></td><td class="num"><strong>${dinero(L.provisiones.total)}</strong></td></tr></tfoot></table>
      <p class="nota-aiu">Base de cesantías y prima: ${dinero(L.provisiones.baseCesantias)} (incluye auxilio de transporte). Base de vacaciones: ${dinero(L.provisiones.baseVacaciones)}.</p></details>`;
    if (L.retencion && L.retencion.modo === 'calculada' && L.retencion.ingresos) {
      const r = L.retencion;
      h += `<details class="nom-detalles"><summary>Cómo se calculó la retención en la fuente</summary><table class="tabla-items-detalle"><tbody>
        <tr><td>Ingresos laborales</td><td class="num">${dinero(r.ingresos)}</td></tr>
        <tr><td>− Aportes obligatorios (salud, pensión, solidaridad)</td><td class="num">${dinero(r.aportesObligatorios)}</td></tr>
        <tr><td>− Deducciones (vivienda, prepagada, dependientes)</td><td class="num">${dinero(r.vivienda + r.medicinaPrepagada + r.dependientes)}</td></tr>
        <tr><td>− Aportes voluntarios</td><td class="num">${dinero(r.aporteVoluntario)}</td></tr>
        <tr><td>− Renta exenta del 25 %</td><td class="num">${dinero(r.rentaExenta25)}</td></tr>
        <tr><td>Base gravable (${r.baseUvt} UVT)</td><td class="num">${dinero(r.baseGravable)}</td></tr></tbody>
        <tfoot><tr><td><strong>Retención</strong></td><td class="num"><strong>${dinero(r.valor)}</strong></td></tr></tfoot></table>
        <p class="nota-aiu">Procedimiento 1 del art. 383 del Estatuto Tributario. Las deducciones y rentas exentas tienen tope del 40 % del ingreso neto y 1.340 UVT al año.</p></details>`;
    }
    if (L.advertencias.length) h += aviso('confirmar', L.advertencias.map(esc).join('<br>'));
    return h;
  }

  async function verLiquidacion(empleadoId) {
    try {
      const d = await api(`/nomina/periodos/${nom.detalle.periodo.id}/empleados/${empleadoId}`);
      if (d.error) return alert(d.error);
      abrirDialogo({
        titulo: `${d.empleado ? d.empleado.nombre : 'Empleado'} · ${nombreMes(d.periodo.anio, d.periodo.mes)}`,
        cuerpo: bloqueLiquidacion(d),
        ancho: true,
        extra: [{ texto: 'Imprimir desprendible', fn: () => imprimirDesprendible(d) }],
      });
    } catch (err) {
      mostrarError(err);
    }
  }

  function imprimirDesprendible(d) {
    const w = window.open(`/contable/desprendible.html?periodo=${encodeURIComponent(d.periodo.id)}&empleado=${encodeURIComponent(d.empleado.id)}`, '_blank');
    if (!w) alert('El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.');
  }

  // ===================================================================================
  // EMPLEADOS Y CONTRATOS
  // ===================================================================================
  function renderContratos() {
    let html = `<div class="nom-barra"><p class="nota-panel">Un contrato por empleado: salario, tipo de salario, riesgo laboral, retención y las entidades de seguridad social. Cada mes la nómina toma estos datos; una nómina ya contabilizada no cambia si después editas el contrato.</p>
      ${puedeEditar() ? boton('+ Nuevo contrato', 'nuevo-contrato', {}, 'btn-primario') : ''}</div>`;
    if (nom.contratos.length === 0) html += '<p class="vacio">Todavía no hay contratos.</p>';
    else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th>Cargo</th><th>Contrato</th><th>Ingreso</th><th class="num">Salario</th><th>Estado</th><th></th></tr></thead><tbody>
      ${nom.contratos.map((c) => {
        const vigente = !c.fechaTerminacion || c.fechaTerminacion >= nom.opciones.hoy;
        return `<tr><td><strong>${esc(c.empleado ? c.empleado.nombre : '—')}</strong><br><span class="texto-suave">${esc(c.empleado ? c.empleado.identificacion : '')}</span></td>
          <td>${esc(c.cargo || '')}</td>
          <td>${esc(TIPOS_CONTRATO[c.tipoContrato] || c.tipoContrato)}${c.tipoSalario === 'integral' ? ' · integral' : ''}</td>
          <td>${esc(formatoFecha(c.fechaIngreso))}</td>
          <td class="num">${dinero(c.salarioBase)}</td>
          <td>${vigente ? '<span class="badge aceptada">vigente</span>' : `<span class="badge">terminado ${esc(formatoFecha(c.fechaTerminacion))}</span>`}</td>
          <td class="acciones">${puedeEditar() ? boton('Editar', 'editar-contrato', { id: c.id }) : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    }
    contenido().innerHTML = html;
  }

  const CONTRATO_VACIO = {
    tipoContrato: 'indefinido', tipoSalario: 'ordinario', auxilioTransporte: 'auto', tipoAuxilio: 'transporte', claseRiesgo: 1,
    areaGasto: 'administracion', retencionFuente: 'calculada', retencionManual: 0, dependientes: 0, interesesVivienda: 0,
    medicinaPrepagada: 0, aporteVoluntarioPension: 0, aporteAfc: 0, vacacionesDiasPrevios: 0, tipoDocumento: 'CC',
  };

  // Centros de trabajo para elegir en un contrato: los activos (y el que ya tiene el contrato, aunque se haya desactivado).
  function opcionesCentros(elegido) {
    const centros = (nom.opciones.centrosTrabajo || []).filter((x) => x.activo || x.id === elegido);
    const principal = centros.find((x) => x.principal);
    const etq = (x) => `${x.codigo} · ${x.nombre}${x.activo ? '' : ' (inactivo)'}`;
    const primera = `<option value=""${elegido ? '' : ' selected'}>${principal ? `Principal por defecto — ${esc(etq(principal))}` : 'Sin centros creados (Configuración)'}</option>`;
    return primera + centros.map((x) => `<option value="${esc(x.id)}"${x.id === elegido ? ' selected' : ''}>${esc(etq(x))}${x.principal ? ' · principal' : ''}</option>`).join('');
  }

  function formularioContrato(c, esNuevo) {
    const o = nom.opciones;
    const areas = Object.entries(o.areas);
    const riesgos = Object.entries(o.clasesRiesgo);
    const empleadoHtml = esNuevo
      ? `<div class="fx-bloque"><h4>Empleado</h4>
          ${campo('Empleado', `<select id="nc-empleado"><option value="">— Nuevo empleado —</option>${o.empleados.map((e) => `<option value="${e.id}">${esc(e.nombre)} · ${esc(e.identificacion)}</option>`).join('')}</select>`)}
          <div id="nc-nuevo-empleado">
            ${campo('Cédula', '<input type="text" id="nc-cedula" maxlength="20" autocomplete="off" inputmode="numeric">')}
            ${campo('Nombre completo', '<input type="text" id="nc-nombre" maxlength="150" autocomplete="off">')}
          </div></div>`
      : `<div class="fx-bloque"><h4>Empleado</h4><p><strong>${esc(c.empleado ? c.empleado.nombre : '')}</strong><br><span class="texto-suave">${esc(c.empleado ? c.empleado.identificacion : '')}</span></p></div>`;
    return `${empleadoHtml}
      <div class="fx-rejilla">
        <div class="fx-bloque"><h4>Contrato</h4>
          ${campo('Cargo', `<input type="text" id="nc-cargo" maxlength="100" value="${esc(c.cargo || '')}">`)}
          ${campo('Tipo de contrato', `<select id="nc-tipo">${opcionesSelect(Object.entries(TIPOS_CONTRATO), c.tipoContrato)}</select>`)}
          ${campo('Fecha de ingreso', `<input type="date" id="nc-ingreso" value="${esc(c.fechaIngreso || '')}">`)}
          <div id="nc-fila-fin" ${c.tipoContrato === 'fijo' ? '' : 'hidden'}>${campo('Fecha en que termina (término fijo)', `<input type="date" id="nc-fin-pactada" value="${esc(c.fechaFinPactada || '')}">`)}</div>
          ${esNuevo ? '' : campo('Fecha de terminación (si ya se retiró)', `<input type="date" id="nc-terminacion" value="${esc(c.fechaTerminacion || '')}">`)}
        </div>
        <div class="fx-bloque"><h4>Salario</h4>
          ${campo('Salario mensual', `<input type="number" id="nc-salario" min="0" step="1" value="${c.salarioBase || ''}">`)}
          ${campo('Tipo de salario', `<select id="nc-tipo-salario">${opcionesSelect([['ordinario', 'Ordinario'], ['integral', 'Integral (mínimo 13 SMMLV)']], c.tipoSalario)}</select>`)}
          ${campo('Auxilio de transporte', `<select id="nc-aux">${opcionesSelect([['auto', 'Automático (hasta 2 SMMLV)'], ['si', 'Siempre'], ['no', 'Nunca']], c.auxilioTransporte)}</select>`)}
          ${campo('El auxilio es de…', `<select id="nc-tipo-aux">${opcionesSelect([['transporte', 'Transporte (trabajo presencial)'], ['conectividad', 'Conectividad (trabajo remoto)']], c.tipoAuxilio)}</select>`)}
        </div>
        <div class="fx-bloque"><h4>Riesgo y gasto</h4>
          ${campo('Centro de trabajo (ARL)', `<select id="nc-centro">${opcionesCentros(c.centroTrabajoId)}</select>`)}
          ${campo('Clase de riesgo (ARL)', `<select id="nc-riesgo">${opcionesSelect(riesgos, c.claseRiesgo)}</select>`)}
          ${campo('Área donde va el gasto', `<select id="nc-area">${opcionesSelect(areas, c.areaGasto)}</select>`)}
          ${campo('Horas por semana (solo si no es la jornada máxima)', `<input type="number" id="nc-horas" min="1" max="48" step="1" value="${c.horasSemanales || ''}">`)}
          ${campo('Vacaciones: días hábiles ya tomados antes de usar el sistema', `<input type="number" id="nc-vac-previos" min="0" max="1000" step="0.5" value="${c.vacacionesDiasPrevios || 0}">`)}
          <p class="nota-aiu">Con esto el saldo de vacaciones arranca bien: se suman los días disfrutados o pagados en dinero desde el ingreso hasta hoy.</p>
        </div>
      </div>
      <div class="fx-rejilla">
        <div class="fx-bloque"><h4>Retención en la fuente</h4>
          ${campo('Cómo se retiene', `<select id="nc-retencion">${opcionesSelect([['calculada', 'Calcular (art. 383 E.T.)'], ['no_aplica', 'No aplica'], ['manual', 'Valor fijo mensual']], c.retencionFuente)}</select>`)}
          <div id="nc-fila-ret-manual" ${c.retencionFuente === 'manual' ? '' : 'hidden'}>${campo('Valor fijo mensual', `<input type="number" id="nc-ret-manual" min="0" step="1" value="${c.retencionManual || ''}">`)}</div>
          ${campo('Dependientes (hijos, cónyuge…)', `<input type="number" id="nc-dependientes" min="0" max="20" step="1" value="${c.dependientes || 0}">`)}
          ${campo('Intereses de vivienda al mes', `<input type="number" id="nc-vivienda" min="0" step="1" value="${c.interesesVivienda || ''}">`)}
          ${campo('Medicina prepagada al mes', `<input type="number" id="nc-prepagada" min="0" step="1" value="${c.medicinaPrepagada || ''}">`)}
          ${campo('Aporte voluntario a pensión al mes', `<input type="number" id="nc-voluntario" min="0" step="1" value="${c.aporteVoluntarioPension || ''}">`)}
          ${campo('Aporte a cuenta AFC al mes', `<input type="number" id="nc-afc" min="0" step="1" value="${c.aporteAfc || ''}">`)}
        </div>
        <div class="fx-bloque"><h4>Entidades del empleado</h4>
          ${campo('Tipo de documento (PILA)', `<select id="nc-tipodoc">${opcionesSelect([['CC', 'CC · Cédula de ciudadanía'], ['CE', 'CE · Cédula de extranjería'], ['TI', 'TI · Tarjeta de identidad'], ['PA', 'PA · Pasaporte'], ['PE', 'PE · Permiso especial de permanencia'], ['CD', 'CD · Carné diplomático'], ['SC', 'SC · Salvoconducto'], ['RC', 'RC · Registro civil']], c.tipoDocumento || 'CC')}</select>`)}
          ${campo('EPS', `<input type="text" id="nc-eps" maxlength="100" value="${esc(c.epsNombre || '')}" placeholder="Ej.: Sanitas">`)}
          ${campo('Código EPS (PILA)', `<input type="text" id="nc-eps-cod" maxlength="20" value="${esc(c.epsCodigo || '')}" placeholder="Ej.: EPS005">`)}
          ${campo('Fondo de pensiones', `<input type="text" id="nc-afp" maxlength="100" value="${esc(c.afpNombre || '')}" placeholder="Ej.: Porvenir">`)}
          ${campo('Código fondo (PILA)', `<input type="text" id="nc-afp-cod" maxlength="20" value="${esc(c.afpCodigo || '')}" placeholder="Ej.: 230301">`)}
          ${campo('Fondo de cesantías', `<input type="text" id="nc-ces" maxlength="100" value="${esc(c.fondoCesantiasNombre || '')}" placeholder="Ej.: Protección">`)}
          ${campo('Código fondo cesantías', `<input type="text" id="nc-ces-cod" maxlength="20" value="${esc(c.fondoCesantiasCodigo || '')}">`)}
        </div>
        <div class="fx-bloque"><h4>Cuánto cuesta al mes</h4>
          <div id="nc-simulacion" class="nom-simulacion"></div>
          <p class="nota-aiu">Simulación de un mes completo con el salario y las condiciones de arriba, sin novedades.</p>
        </div>
      </div>
      ${campo('Observaciones (opcional)', `<input type="text" id="nc-obs" maxlength="1000" value="${esc(c.observaciones || '')}">`)}`;
  }

  function leerContrato(esNuevo) {
    const c = {
      cargo: v('nc-cargo'), tipoContrato: v('nc-tipo'), fechaIngreso: v('nc-ingreso'),
      fechaFinPactada: v('nc-fin-pactada') || null,
      salarioBase: num('nc-salario'), tipoSalario: v('nc-tipo-salario'), auxilioTransporte: v('nc-aux'), tipoAuxilio: v('nc-tipo-aux'),
      claseRiesgo: num('nc-riesgo'), areaGasto: v('nc-area'), horasSemanales: v('nc-horas') ? num('nc-horas') : null,
      vacacionesDiasPrevios: num('nc-vac-previos'),
      retencionFuente: v('nc-retencion'), retencionManual: num('nc-ret-manual'), dependientes: num('nc-dependientes'),
      interesesVivienda: num('nc-vivienda'), medicinaPrepagada: num('nc-prepagada'), aporteVoluntarioPension: num('nc-voluntario'), aporteAfc: num('nc-afc'),
      centroTrabajoId: v('nc-centro') || null, tipoDocumento: v('nc-tipodoc') || 'CC', epsNombre: v('nc-eps'), epsCodigo: v('nc-eps-cod'), afpNombre: v('nc-afp'), afpCodigo: v('nc-afp-cod'),
      fondoCesantiasNombre: v('nc-ces'), fondoCesantiasCodigo: v('nc-ces-cod'), observaciones: v('nc-obs'),
    };
    if (!esNuevo) c.fechaTerminacion = v('nc-terminacion') || null;
    return c;
  }

  function simularContrato() {
    const caja = $('nc-simulacion');
    if (!caja) return;
    const c = leerContrato(true);
    if (!(c.salarioBase > 0)) {
      caja.innerHTML = '<p class="texto-suave">Escribe el salario para ver lo que cuesta este empleado al mes.</p>';
      return;
    }
    try {
      const hoy = nom.opciones.hoy;
      const L = window.liquidacionNomina.liquidarEmpleado({
        anio: Number(hoy.slice(0, 4)), mes: Number(hoy.slice(5, 7)),
        empresa: { exoneraArt114: nom.opciones.config.exoneraArt114 },
        contrato: Object.assign({}, c, { fechaIngreso: '2000-01-01', fechaTerminacion: null }),
      });
      const fila = (t, val, fuerte) => `<tr><td>${fuerte ? '<strong>' + t + '</strong>' : t}</td><td class="num">${fuerte ? '<strong>' + dinero(val) + '</strong>' : dinero(val)}</td></tr>`;
      caja.innerHTML = `<table class="tabla-items-detalle"><tbody>
        ${fila('Devengado', L.totales.devengado)}${fila('− Deducciones del empleado', L.totales.deducciones)}${fila('Neto que recibe', L.totales.neto, true)}
        ${fila('+ Aportes del empleador', L.aportes.empleador.total)}${fila('+ Provisiones de prestaciones', L.provisiones.total)}${fila('Costo total para la empresa', L.costoEmpleador, true)}</tbody></table>
        ${L.advertencias.length ? aviso('confirmar', L.advertencias.map(esc).join('<br>')) : ''}`;
    } catch (err) {
      caja.innerHTML = `<p class="texto-suave">${esc(err.message)}</p>`;
    }
  }

  function conectarFormularioContrato() {
    const cuerpo = $('nom-dialogo-cuerpo');
    const alCambiar = () => {
      const fijo = $('nc-tipo');
      if (fijo) $('nc-fila-fin').hidden = fijo.value !== 'fijo';
      if ($('nc-retencion')) $('nc-fila-ret-manual').hidden = $('nc-retencion').value !== 'manual';
      if ($('nc-empleado')) $('nc-nuevo-empleado').hidden = !!$('nc-empleado').value;
      simularContrato();
    };
    // Al elegir un centro que tiene clase de riesgo, se propone esa clase en el contrato.
    const aplicarRiesgoDelCentro = () => {
      const centros = nom.opciones.centrosTrabajo || [];
      const elegido = centros.find((x) => x.id === v('nc-centro')) || centros.find((x) => x.principal);
      if (elegido && elegido.claseRiesgo && $('nc-riesgo')) $('nc-riesgo').value = String(elegido.claseRiesgo);
    };
    cuerpo.oninput = alCambiar;
    cuerpo.onchange = (e) => {
      if (e.target && e.target.id === 'nc-centro') aplicarRiesgoDelCentro();
      alCambiar();
    };
    alCambiar();
  }

  function dialogoContrato(c) {
    const esNuevo = !c;
    const datos = c || CONTRATO_VACIO;
    abrirDialogo({
      titulo: esNuevo ? 'Nuevo contrato' : `Contrato de ${c.empleado ? c.empleado.nombre : ''}`,
      cuerpo: formularioContrato(datos, esNuevo),
      ancho: true,
      guardar: {
        texto: esNuevo ? 'Crear contrato' : 'Guardar cambios',
        fn: async () => {
          const cuerpo = leerContrato(esNuevo);
          if (esNuevo) {
            const emp = v('nc-empleado');
            if (emp) cuerpo.empleadoId = emp;
            else cuerpo.nuevoEmpleado = { identificacion: v('nc-cedula'), nombre: v('nc-nombre') };
            await api('/nomina/contratos', { method: 'POST', body: JSON.stringify(cuerpo) });
          } else {
            await api(`/nomina/contratos/${c.id}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
          }
          await cargarOpciones();
          nom.contratos = await api('/nomina/contratos');
          renderContratos();
        },
      },
    });
    conectarFormularioContrato();
  }

  // ===================================================================================
  // NOVEDADES
  // ===================================================================================
  function renderNovedades() {
    const editar = puedeEditar();
    let html = `<div class="nom-barra"><p class="nota-panel">Lo que cambia la nómina de un mes: incapacidades, licencias y vacaciones; horas extras, recargos, comisiones y bonos; y los descuentos (préstamos, libranzas, embargos). Una novedad se puede aplicar a un solo mes o repetirse cada mes hasta quitarla.</p></div>
      <div class="fx-titulo-con-accion"><h4>Incapacidades, licencias y vacaciones</h4>${editar ? boton('+ Registrar ausencia', 'nueva-ausencia', {}, 'btn-primario btn-chico') : ''}</div>`;
    if (nom.ausencias.length === 0) html += '<p class="vacio">Sin ausencias registradas.</p>';
    else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th>Tipo</th><th>Desde</th><th>Hasta</th><th class="num">Días</th><th>Documento</th><th></th></tr></thead><tbody>
      ${nom.ausencias.map((a) => `<tr><td>${esc(a.empleado ? a.empleado.nombre : '—')}</td><td>${esc(a.nombreTipo)}${a.diasPrevios ? ` <span class="texto-suave">(${a.diasPrevios} días previos)</span>` : ''}</td>
        <td>${esc(formatoFecha(a.fechaInicio))}</td><td>${esc(formatoFecha(a.fechaFin))}</td><td class="num">${a.dias}</td><td>${esc(a.numeroDocumento || '')}</td>
        <td class="acciones">${editar ? boton('Quitar', 'quitar-ausencia', { id: a.id }, 'btn-accion destructivo') : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    html += `<div class="fx-titulo-con-accion nom-titulo-sep"><h4>Devengos y descuentos</h4>${editar ? boton('+ Agregar novedad', 'nuevo-concepto', {}, 'btn-primario btn-chico') : ''}</div>`;
    if (nom.conceptos.length === 0) html += '<p class="vacio">Sin novedades registradas.</p>';
    else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th>Concepto</th><th>Clase</th><th class="num">Horas</th><th class="num">Valor</th><th>Aplica</th><th></th></tr></thead><tbody>
      ${nom.conceptos.map((c) => `<tr><td>${esc(c.empleado ? c.empleado.nombre : '—')}</td><td>${esc(c.nombreConcepto)}${c.descripcion ? ` <span class="texto-suave">${esc(c.descripcion)}</span>` : ''}</td>
        <td>${c.clase === 'devengo' ? 'Devengo' : 'Descuento'}</td><td class="num">${c.cantidad ? c.cantidad : ''}</td><td class="num">${c.valor ? dinero(c.valor) : ''}</td>
        <td>${c.recurrente ? `Cada mes desde ${esc(nombreMes(c.desdeAnio, c.desdeMes))}` : esc(nombreMes(c.anio, c.mes))}</td>
        <td class="acciones">${editar ? boton(c.recurrente ? 'Desactivar' : 'Quitar', 'quitar-concepto', { id: c.id }, 'btn-accion destructivo') : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    contenido().innerHTML = html;
  }

  function selectEmpleados(id) {
    const emp = nom.opciones.empleados;
    return `<select id="${id}">${emp.map((e) => `<option value="${e.id}">${esc(e.nombre)} · ${esc(e.identificacion)}</option>`).join('')}</select>`;
  }

  function dialogoAusencia() {
    if (!nom.opciones.empleados.length) return alert('Primero crea un contrato: así se registra el empleado.');
    abrirDialogo({
      titulo: 'Registrar ausencia',
      ancho: true,
      cuerpo: `<div class="fila-campos">${campo('Empleado', selectEmpleados('na-empleado'))}
        ${campo('Tipo', `<select id="na-tipo">${nom.opciones.ausencias.map((a) => `<option value="${a.codigo}">${esc(a.nombre)}</option>`).join('')}</select>`)}</div>
        <div class="fila-campos">${campo('Desde', '<input type="date" id="na-desde">')}${campo('Hasta (inclusive)', '<input type="date" id="na-hasta">')}</div>
        <div class="fila-campos" id="na-fila-previos">${campo('Días previos de la misma incapacidad (prórroga)', '<input type="number" id="na-previos" min="0" max="540" step="1" value="0">')}
          <p class="nota-aiu">Si esta incapacidad es continuación de otra, escribe cuántos días llevaba antes de la fecha de inicio. Define quién paga: días 1-2 la empresa, 3-90 la EPS al 66,67 %, 91-180 la EPS al 50 %, desde el 181 el fondo de pensiones.</p></div>
        <div class="fila-campos">${campo('Número del documento (opcional)', '<input type="text" id="na-doc" maxlength="50">')}
          ${campo('Valor diario distinto (opcional)', '<input type="number" id="na-valor" min="0" step="1" placeholder="Solo si no es salario ÷ 30">')}</div>
        ${campo('Observación (opcional)', '<input type="text" id="na-obs" maxlength="255">')}
        <p class="nota-aiu">El rango puede cruzar meses: cada nómina toma los días de su mes. No se puede registrar en un mes que ya está contabilizado.</p>`,
      guardar: {
        texto: 'Registrar',
        fn: async () => {
          await api('/nomina/ausencias', {
            method: 'POST',
            body: JSON.stringify({
              empleadoId: v('na-empleado'), tipo: v('na-tipo'), fechaInicio: v('na-desde'), fechaFin: v('na-hasta'),
              diasPrevios: num('na-previos'), numeroDocumento: v('na-doc'), valorDiario: v('na-valor') || null, observacion: v('na-obs'),
            }),
          });
          nom.ausencias = await api('/nomina/ausencias');
          renderNovedades();
        },
      },
    });
    const ajustar = () => { $('na-fila-previos').hidden = v('na-tipo') !== 'incapacidad_general'; };
    $('na-tipo').onchange = ajustar;
    ajustar();
  }

  function dialogoConcepto() {
    if (!nom.opciones.empleados.length) return alert('Primero crea un contrato: así se registra el empleado.');
    const o = nom.opciones;
    const hoy = o.hoy.slice(0, 7);
    abrirDialogo({
      titulo: 'Agregar novedad de nómina',
      ancho: true,
      cuerpo: `<div class="fila-campos">${campo('Empleado', selectEmpleados('nc2-empleado'))}
        ${campo('Clase', '<select id="nc2-clase"><option value="devengo">Devengo (se suma)</option><option value="descuento">Descuento (se resta)</option></select>')}
        ${campo('Concepto', '<select id="nc2-codigo"></select>')}</div>
        <div class="fila-campos"><span id="nc2-fila-horas">${campo('Horas', '<input type="number" id="nc2-horas" min="0" step="0.5">')}</span>
          ${campo('Valor ($)', '<input type="number" id="nc2-valor" min="0" step="1">')}
          ${campo('Mes', `<input type="month" id="nc2-mes" value="${hoy}">`)}</div>
        <p class="nota-aiu" id="nc2-ayuda"></p>
        <div class="fila-campos">${campo('Descripción (opcional)', '<input type="text" id="nc2-desc" maxlength="150">')}</div>
        <label class="check-linea"><input type="checkbox" id="nc2-recurrente"> <span>Repetir cada mes desde el mes elegido, hasta que se desactive (ej. una libranza o un auxilio fijo)</span></label>`,
      guardar: {
        texto: 'Agregar',
        fn: async () => {
          const [anio, mes] = v('nc2-mes').split('-').map(Number);
          await api('/nomina/conceptos', {
            method: 'POST',
            body: JSON.stringify({
              empleadoId: v('nc2-empleado'), clase: v('nc2-clase'), codigo: v('nc2-codigo'),
              cantidad: v('nc2-horas') || null, valor: v('nc2-valor') || null,
              anio, mes, recurrente: $('nc2-recurrente').checked, descripcion: v('nc2-desc'),
            }),
          });
          nom.conceptos = await api('/nomina/conceptos');
          renderNovedades();
        },
      },
    });
    const llenar = () => {
      const lista = v('nc2-clase') === 'devengo' ? o.devengos : o.descuentos;
      $('nc2-codigo').innerHTML = lista.map((x) => `<option value="${x.codigo}">${esc(x.nombre)}</option>`).join('');
      ajustar();
    };
    const ajustar = () => {
      const def = o.devengos.find((x) => x.codigo === v('nc2-codigo'));
      const horas = v('nc2-clase') === 'devengo' && def && def.horas;
      $('nc2-fila-horas').hidden = !horas;
      $('nc2-ayuda').textContent = horas
        ? 'Escribe las horas: el sistema las valora con el valor de la hora ordinaria y el recargo vigente (Ley 2466 de 2025). Si ya tienes el valor, escríbelo y se usa tal cual.'
        : (v('nc2-clase') === 'devengo' && def && !def.salarial ? 'Es un pago no salarial: no suma a prestaciones, y si pasa del 40 % de lo que gana, el exceso entra a la base de seguridad social.' : '');
    };
    $('nc2-clase').onchange = llenar;
    $('nc2-codigo').onchange = ajustar;
    llenar();
  }

  // ===================================================================================
  // PROVISIONES
  // ===================================================================================
  async function cargarProvisiones() {
    const anioActual = Number(nom.opciones.hoy.slice(0, 4));
    if (!nom.provisionesAnio) nom.provisionesAnio = anioActual;
    const r = await api(`/nomina/provisiones?anio=${nom.provisionesAnio}`);
    const anios = [anioActual + 1, anioActual, anioActual - 1, anioActual - 2];
    let html = `<div class="nom-barra"><p class="nota-panel">Lo que la empresa ya le debe a cada empleado por cesantías, intereses, prima y vacaciones, causado mes a mes en las nóminas contabilizadas.</p>
      <label class="campo-etiquetado nom-anio"><span>Año</span><select id="prov-anio">${opcionesSelect(anios.map((a) => [a, a]), nom.provisionesAnio)}</select></label></div>`;
    if (r.filas.length === 0) html += '<p class="vacio">Todavía no hay nóminas contabilizadas en este año.</p>';
    else {
      const t = r.totales;
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th class="num">Meses</th><th class="num">Cesantías</th><th class="num">Intereses</th><th class="num">Prima</th><th class="num">Vacaciones causadas</th><th class="num">Vacaciones disfrutadas</th><th class="num">Total por pagar</th></tr></thead><tbody>
        ${r.filas.map((f) => `<tr><td><strong>${esc(f.nombre)}</strong></td><td class="num">${f.meses}</td><td class="num">${dinero(f.cesantias)}</td><td class="num">${dinero(f.intereses)}</td><td class="num">${dinero(f.prima)}</td><td class="num">${dinero(f.vacaciones)}</td><td class="num">${dinero(f.vacacionesDisfrutadas)}</td><td class="num"><strong>${dinero(f.total)}</strong></td></tr>`).join('')}
        </tbody><tfoot><tr><td><strong>Total</strong></td><td></td><td class="num">${dinero(t.cesantias)}</td><td class="num">${dinero(t.intereses)}</td><td class="num">${dinero(t.prima)}</td><td class="num">${dinero(t.vacaciones)}</td><td class="num">${dinero(t.vacacionesDisfrutadas)}</td><td class="num"><strong>${dinero(t.total)}</strong></td></tr></tfoot></table></div>
        <p class="nota-aiu">${esc(r.nota)}</p>`;
    }
    contenido().innerHTML = html;
    $('prov-anio').onchange = () => { nom.provisionesAnio = Number($('prov-anio').value); cargarProvisiones().catch((e) => { contenido().innerHTML = aviso('bloqueo', esc(e.message)); }); };
  }

  // ===================================================================================
  // PLANILLA DE APORTES (PILA)
  // ===================================================================================
  async function cargarPlanilla() {
    const lista = nom.periodos.filter((p) => p.empleados > 0);
    let html = `<div class="nom-barra"><p class="nota-panel">Resumen de lo que hay que pagar a la seguridad social por la nómina del mes: salud, pensión, solidaridad, riesgos laborales, caja de compensación, SENA e ICBF. La PILA de un mes se paga en el mes siguiente. Aquí queda organizada por entidad y por empleado, con la aproximación al múltiplo de 100 que hace la PILA.</p></div>`;
    if (lista.length === 0) {
      contenido().innerHTML = html + '<p class="vacio">Primero crea una nómina mensual.</p>';
      return;
    }
    if (!nom.planillaPeriodoId || !lista.find((p) => p.id === nom.planillaPeriodoId)) nom.planillaPeriodoId = lista[0].id;
    const pl = await api(`/nomina/periodos/${nom.planillaPeriodoId}/planilla`);
    html += `<div class="fila-campos"><label class="campo-etiquetado nom-anio"><span>Nómina</span><select id="pla-periodo">${opcionesSelect(lista.map((p) => [p.id, `${nombreMes(p.anio, p.mes)} · ${ESTADOS[p.estado]}`]), nom.planillaPeriodoId)}</select></label>
      ${boton('Descargar CSV', 'planilla-csv', {}, 'btn-secundario')}
      ${boton('CSV de cargue PILA', 'planilla-cargue', {}, 'btn-secundario')}
      ${boton('Archivo plano PILA (.txt)', 'planilla-pila', {}, 'btn-primario')}</div>`;
    html += `<p class="nota-aiu">Aportante: <strong>${esc(pl.aportante.razonSocial)}</strong> · NIT ${esc(pl.aportante.nit)} · ARL: ${esc(pl.aportante.arl || '—')} · Caja: ${esc(pl.aportante.ccf || '—')} · ${pl.exoneraArt114 ? 'Con exoneración del art. 114-1 (salud, SENA e ICBF para quien gana menos de 10 SMMLV)' : 'Sin exoneración del art. 114-1'}.</p>`;
    if (pl.avisos.length) html += aviso('confirmar', '<strong>Para completar la planilla:</strong><br>' + pl.avisos.map(esc).join('<br>'));
    html += `<h4>Por entidad</h4><div class="tabla-envoltorio"><table><thead><tr><th>Tipo</th><th>Entidad</th><th>Conceptos</th><th class="num">Empleados</th><th class="num">Liquidado</th><th class="num">Valor PILA</th></tr></thead><tbody>
      ${pl.porEntidad.map((e) => `<tr><td>${esc(e.tipo)}</td><td>${esc(e.entidad)}</td><td>${Object.entries(e.conceptos).map(([k, val]) => `${esc(k)}: ${dinero(val)}`).join('<br>')}</td><td class="num">${e.empleados}</td><td class="num">${dinero(e.liquidado)}</td><td class="num"><strong>${dinero(e.pila)}</strong></td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="4"><strong>Total a pagar</strong></td><td class="num">${dinero(pl.totales.liquidado)}</td><td class="num"><strong>${dinero(pl.totales.pila)}</strong></td></tr></tfoot></table></div>
      <p class="nota-aiu">La diferencia entre lo liquidado y el valor PILA (${dinero(pl.totales.ajusteAproximacion)}) es la aproximación a múltiplos de 100 de cada aporte.</p>`;
    html += `<h4>Por empleado</h4><div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th class="num">Días</th><th class="num">IBC</th><th>Novedades</th><th class="num">Salud</th><th class="num">Pensión</th><th class="num">Solidaridad</th><th class="num">ARL</th><th class="num">Caja</th><th class="num">SENA</th><th class="num">ICBF</th><th class="num">Total</th></tr></thead><tbody>
      ${pl.filas.map((f) => `<tr><td><strong>${esc(f.nombre)}</strong><br><span class="texto-suave">${esc(f.identificacion)}</span></td><td class="num">${f.diasSalud}</td><td class="num">${dinero(f.ibc)}</td><td>${esc(f.novedades)}</td>
        <td class="num">${dinero(f.salud)}</td><td class="num">${dinero(f.pension)}</td><td class="num">${dinero(f.fsp)}</td><td class="num">${dinero(f.arl)}</td><td class="num">${dinero(f.caja)}</td><td class="num">${dinero(f.sena)}</td><td class="num">${dinero(f.icbf)}</td><td class="num"><strong>${dinero(f.pila)}</strong></td></tr>`).join('')}
      </tbody></table></div>
      <p class="nota-aiu">Novedades PILA: ING ingreso · RET retiro · VAC vacaciones · IGE incapacidad general · IRL incapacidad laboral · LMA licencia de maternidad o paternidad · SLN suspensión o licencia no remunerada. </p>`;
    html += bloquePagoPlanilla(pl);
    contenido().innerHTML = html;
    $('pla-periodo').onchange = () => { nom.planillaPeriodoId = v('pla-periodo'); cargarPlanilla().catch((e) => { contenido().innerHTML = aviso('bloqueo', esc(e.message)); }); };
  }

  // Pago de la planilla al operador de información (asiento + egreso del banco)
  function bloquePagoPlanilla(pl) {
    const p = nom.periodos.find((x) => x.id === nom.planillaPeriodoId);
    const cerrada = p && ['contabilizada', 'pagada'].includes(p.estado);
    let h = '<h4>Pago de la planilla</h4>';
    if (pl.pagoVigente) {
      const g = pl.pagoVigente;
      h += `<div class="nom-tarjetas">
        <div class="nom-tarjeta destacada"><span>Planilla pagada el ${esc(formatoFecha(g.fechaPago))}${g.numeroPlanilla ? ' · Nº ' + esc(g.numeroPlanilla) : ''}</span><strong>${dinero(g.total)}</strong></div>
        <div class="nom-tarjeta"><span>Aportes (valor PILA)</span><strong>${dinero(g.valorPila)}</strong></div>
        <div class="nom-tarjeta"><span>Intereses de mora</span><strong>${dinero(g.mora)}</strong></div></div>`;
      if (puedeEditar()) h += `<div class="nom-acciones">${boton('Anular el pago', 'anular-pago-planilla', { id: g.id }, 'btn-secundario')}</div>`;
    } else if (!cerrada) {
      h += aviso('info', 'Contabiliza la nómina de este mes para poder registrar el pago de su planilla.');
    } else if (puedeEditar()) {
      h += `<p class="nota-aiu">Cuando pagues la planilla en el operador, regístralo aquí: se cancelan los aportes por pagar (salud, pensión, ARL, caja, SENA e ICBF), la aproximación a 100 va a gasto y los intereses de mora, si hubo, a intereses.</p>
        <div class="nom-acciones">${boton('Registrar pago de la planilla', 'pagar-planilla', {}, 'btn-primario')}</div>`;
    }
    const anulados = (pl.pagos || []).filter((x) => x.estado === 'anulada');
    if (anulados.length) h += `<p class="nota-aiu">Pagos anulados: ${anulados.map((x) => `${esc(formatoFecha(x.fechaPago))} (${dinero(x.total)}${x.motivoAnulacion ? ', ' + esc(x.motivoAnulacion) : ''})`).join('; ')}.</p>`;
    return h;
  }

  function dialogoPagoPlanilla() {
    const p = nom.periodos.find((x) => x.id === nom.planillaPeriodoId);
    const bancos = nom.opciones.cuentasBancarias;
    const [a, m] = [p.anio, p.mes];
    const siguiente = m === 12 ? `${a + 1}-01-` : `${a}-${String(m + 1).padStart(2, '0')}-`;
    abrirDialogo({
      titulo: 'Registrar pago de la planilla',
      cuerpo: `<div class="fila-campos">
          ${campo('Pagada desde', `<select id="pp-medio">${bancos.map((b) => `<option value="${b.id}">${esc(b.banco)} ${esc(b.tipoCuenta || '')} ****${esc(b.numero)}</option>`).join('')}<option value="caja">Efectivo (caja)</option></select>`)}
          ${campo('Fecha del pago', `<input type="date" id="pp-fecha" value="${nom.opciones.hoy > p.fechaFin ? nom.opciones.hoy : siguiente + '10'}">`)}</div>
        <div class="fila-campos">
          ${campo('Número de la planilla (opcional)', '<input type="text" id="pp-numero" maxlength="30" autocomplete="off">')}
          ${campo('Intereses de mora (si pagaste tarde)', '<input type="number" id="pp-mora" min="0" step="1" value="0">')}</div>
        <p class="nota-aiu">El valor de la planilla es el de la tabla “Por entidad”. Queda un egreso en la cuenta bancaria, pendiente de conciliar con el extracto.</p>`,
      guardar: {
        texto: 'Registrar pago',
        fn: async () => {
          const medio = v('pp-medio');
          const cuerpo = { fecha: v('pp-fecha'), numeroPlanilla: v('pp-numero'), mora: num('pp-mora') };
          if (medio === 'caja') cuerpo.medio = 'caja';
          else cuerpo.cuentaBancariaId = medio;
          await api(`/nomina/periodos/${nom.planillaPeriodoId}/planilla-pago`, { method: 'POST', body: JSON.stringify(cuerpo) });
          await cargarPlanilla();
        },
      },
    });
  }

  function dialogoAnularPagoPlanilla(id) {
    abrirDialogo({
      titulo: 'Anular el pago de la planilla',
      cuerpo: `<p>Se anula el asiento y el egreso del banco, y la planilla queda pendiente de pago.</p>
        ${campo('Motivo (queda en la auditoría)', '<input type="text" id="ap-motivo" maxlength="250" autocomplete="off">')}`,
      guardar: {
        texto: 'Anular pago',
        fn: async () => {
          await api(`/nomina/planilla-pagos/${id}/anular`, { method: 'POST', body: JSON.stringify({ motivo: v('ap-motivo') }) });
          await cargarPlanilla();
        },
      },
    });
  }

  async function descargarArchivo(ruta, nombre) {
    try {
      const res = await fetch(`/api${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
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

  // Archivo plano de la PILA: se descarga y se muestra qué contiene y qué revisar.
  async function descargarArchivoPila() {
    try {
      const res = await fetch(`/api/nomina/periodos/${nom.planillaPeriodoId}/planilla-pila.txt`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo generar el archivo.');
      const nombre = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'PILA.txt';
      let resumen = null;
      try { resumen = JSON.parse(decodeURIComponent(res.headers.get('X-Pila-Resumen') || '')); } catch (e) { /* sin resumen */ }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = nombre;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (resumen) {
        abrirDialogo({
          titulo: 'Archivo plano de la PILA generado',
          cuerpo: `<p>Se descargó <strong>${esc(nombre)}</strong>: ${resumen.cotizantes} cotizante(s) en ${resumen.lineas} registro(s). Período de pensión, ARL y parafiscales: <strong>${esc(resumen.periodoOtros)}</strong>; período de salud: <strong>${esc(resumen.periodoSalud)}</strong>.</p>
            <p>Total que debe dar la planilla en el operador: <strong>${dinero(resumen.totales.total)}</strong> (salud ${dinero(resumen.totales.salud)}, pensión ${dinero(resumen.totales.pension)}, solidaridad ${dinero(resumen.totales.fsp)}, ARL ${dinero(resumen.totales.arl)}, caja ${dinero(resumen.totales.ccf)}, SENA ${dinero(resumen.totales.sena)}, ICBF ${dinero(resumen.totales.icbf)}).</p>
            ${resumen.avisos.length ? aviso('confirmar', '<strong>Revisa:</strong><br>' + resumen.avisos.map(esc).join('<br>')) : ''}
            <p class="nota-aiu">Cárgalo en el operador como planilla tipo E (modalidad electrónica, archivo plano). El operador valida la estructura: si rechaza alguna línea, dime el mensaje exacto para ajustar el archivo.</p>`,
        });
      }
    } catch (err) {
      mostrarError(err);
    }
  }

  async function descargarPlanillaCsv() {
    try {
      const res = await fetch(`/api/nomina/periodos/${nom.planillaPeriodoId}/planilla.csv`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo descargar.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'planilla-aportes.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      mostrarError(err);
    }
  }

  // ===================================================================================
  // CONFIGURACIÓN
  // ===================================================================================
  function renderConfig() {
    const o = nom.opciones;
    const c = o.config;
    const editar = puedeEditar();
    const dis = editar ? '' : ' disabled';
    contenido().innerHTML = `<div class="nom-barra"><p class="nota-panel">Datos de la empresa que son iguales para todos los empleados.</p></div>
      <form id="nom-form-config" class="fx-rejilla" novalidate>
        <div class="fx-bloque"><h4>Seguridad social de la empresa</h4>
          ${campo('ARL', `<input type="text" id="cf-arl" maxlength="100" value="${esc(c.arlNombre || '')}"${dis} placeholder="Ej.: Sura">`)}
          ${campo('Código ARL (PILA)', `<input type="text" id="cf-arl-cod" maxlength="20" value="${esc(c.arlCodigo || '')}"${dis}>`)}
          ${campo('Caja de compensación', `<input type="text" id="cf-ccf" maxlength="100" value="${esc(c.ccfNombre || '')}"${dis} placeholder="Ej.: Compensar">`)}
          ${campo('Código caja (PILA)', `<input type="text" id="cf-ccf-cod" maxlength="20" value="${esc(c.ccfCodigo || '')}"${dis}>`)}
          ${window.SelectorLugar.html('cf', { depto: c.codigoDepartamento, mpio: c.codigoMunicipio, deshabilitado: !editar })}
          ${campo('Operador de PILA', `<input type="text" id="cf-operador" maxlength="100" value="${esc(c.operadorPila || '')}"${dis} placeholder="Ej.: Aportes en Línea, SOI, Mi Planilla">`)}
        </div>
        <div class="fx-bloque"><h4>Cómo se liquida</h4>
          <label class="check-linea"><input type="checkbox" id="cf-exonera"${c.exoneraArt114 ? ' checked' : ''}${dis}> <span>Aplicar la exoneración del art. 114-1 del Estatuto Tributario (no pagar salud del empleador, SENA ni ICBF por quienes ganan menos de 10 SMMLV). Corresponde a personas jurídicas y a personas naturales con dos o más trabajadores.</span></label>
          ${campo('Área donde va el gasto por defecto', `<select id="cf-area"${dis}>${opcionesSelect(Object.entries(o.areas), c.areaGastoPorDefecto)}</select>`)}
          ${campo('Semana laboral (para contar los días hábiles de vacaciones)', `<select id="cf-semana"${dis}>${opcionesSelect([[5, '5 días: lunes a viernes'], [6, '6 días: lunes a sábado']], c.semanaLaboral || 5)}</select>`)}
          ${editar ? '<button type="submit" class="btn-primario">Guardar configuración</button>' : ''}
          <p class="fx-error" id="cf-error" hidden></p>
        </div>
        <div class="fx-bloque"><h4>Parámetros legales ${o.parametros.anio}</h4>
          <table class="tabla-items-detalle"><tbody>
            <tr><td>Salario mínimo mensual</td><td class="num">${dinero(o.parametros.smmlv)}</td></tr>
            <tr><td>Auxilio de transporte</td><td class="num">${dinero(o.parametros.auxilioTransporte)}</td></tr>
            <tr><td>UVT</td><td class="num">${dinero(o.parametros.uvt)}</td></tr></tbody></table>
          <p class="nota-aiu">Vienen del sistema (no se digitan). Cada enero hay que actualizarlos junto con el contador.</p>
        </div>
      </form>
      <div id="cf-centros"></div>
      <details class="nom-detalles"><summary>Supuestos legales que usa la liquidación (revísalos con tu contador)</summary>
        <ul class="nom-lista">
          <li>Mes comercial de 30 días. El auxilio de transporte aplica a quien devenga hasta 2 SMMLV y solo por días trabajados (no en vacaciones, incapacidad ni licencias).</li>
          <li>IBC de salud y pensión: sueldo, vacaciones, extras, recargos, comisiones, bonificaciones salariales e incapacidades y licencias al 100 % del salario; piso de 1 SMMLV y tope de 25 SMMLV (proporcional a los días). Los pagos no salariales que pasen del 40 % de la remuneración entran al IBC por el exceso (Ley 1393 de 2010, art. 30). El salario integral cotiza sobre el 70 %.</li>
          <li>Fondo de solidaridad pensional desde 4 SMMLV: 1 % (y hasta 2 % desde 16 SMMLV). ARL por clase de riesgo, a cargo del empleador. Caja de compensación 4 % sobre la nómina de salarios.</li>
          <li>Incapacidad general: días 1-2 a cargo de la empresa al 66,67 %; días 3-90 la EPS al 66,67 %; 91-180 al 50 %; desde el 181 el fondo de pensiones. Nunca menos de 1 SMMLV diario. La empresa la adelanta y la reconoce como cuenta por cobrar. La incapacidad laboral se paga al 100 % y se cobra a la ARL.</li>
          <li>Horas extras y recargos con la jornada máxima de la Ley 2101 (42 horas desde el 15 de julio de 2026) y el recargo dominical y festivo de la Ley 2466 (80 % hasta el 30 de junio de 2026, 90 % hasta el 30 de junio de 2027, 100 % después). Las extras no entran a la base de vacaciones.</li>
          <li>Provisiones: cesantías 8,33 %, intereses 12 % anual de las cesantías, prima 8,33 % (base: salario devengado + auxilio de transporte) y vacaciones 4,17 % (base: salario sin extras ni auxilio). Salario integral: solo vacaciones.</li>
          <li>Retención en la fuente: procedimiento 1 (art. 383 del E.T.), con renta exenta del 25 % (tope 790 UVT al año), deducciones por dependientes, vivienda y medicina prepagada, aportes voluntarios, y límite del 40 % / 1.340 UVT al año. No se aplica la deducción adicional de 72 UVT por dependiente (el empleado puede tomarla en su declaración). La licencia de maternidad no se incluye en la base. Se aproxima al múltiplo de mil.</li>
          <li>La licencia no remunerada y la suspensión no pagan salud ni pensión a cargo de la empresa (se reportan como SLN). En vacaciones sí se paga ARL.</li>
          <li>Prima, cesantías e intereses se pagan con 360 días al año, sin contar licencias no remuneradas ni suspensiones. Salario fijo sin cambios recientes: último salario más auxilio de transporte. Con pagos variables o con un cambio de salario en el período (en los últimos 3 meses, para cesantías): promedio del período. Intereses: 12 % anual sobre las cesantías. Salario integral: sin prestaciones.</li>
          <li>Vacaciones: 15 días hábiles por 360 días de servicio, valorados con el salario ordinario (sin extras ni recargos de festivos ni auxilio de transporte). Los hábiles excluyen domingos, festivos y, si la semana es de 5 días, los sábados. Compensar en dinero requiere acuerdo y normalmente es hasta la mitad; al retiro se paga todo lo pendiente.</li>
          <li>Retención de la prima, las vacaciones en dinero y la indemnización: se calcula como el aumento de la retención del mes en que se pagan (procedimiento 1). Cesantías e intereses se tratan como exentos; se avisa si el salario supera 350 UVT.</li>
          <li>Indemnización por despido sin justa causa (art. 64 del CST): indefinido con menos de 10 SMMLV, 30 días el primer año y 20 por cada año siguiente (proporcional); con 10 SMMLV o más, 20 y 15. Término fijo y obra o labor: lo que faltaba del contrato, mínimo 15 días. Se calcula sobre el salario sin auxilio de transporte.</li>
          <li>El pago de prestaciones se registra contra la provisión del libro de cada empleado: lo que falte va al gasto y, si se liquida todo y sobró, se libera.</li>
          <li>El cambio de salario a mitad de mes no está soportado: aplica a todo el mes. Un empleado con dos contratos en el mismo mes tampoco.</li>
        </ul></details>`;
    window.SelectorLugar.montar('cf');
    cargarCentros();
    const form = $('nom-form-config');
    if (editar) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('cf-error');
        err.hidden = true;
        const lugar = window.SelectorLugar.leer('cf');
        if (lugar.error) {
          err.textContent = lugar.error;
          err.hidden = false;
          return;
        }
        try {
          nom.opciones.config = await api('/nomina/config', {
            method: 'PUT',
            body: JSON.stringify({
              arlNombre: v('cf-arl'), arlCodigo: v('cf-arl-cod'), ccfNombre: v('cf-ccf'), ccfCodigo: v('cf-ccf-cod'),
              operadorPila: v('cf-operador'), exoneraArt114: $('cf-exonera').checked, areaGastoPorDefecto: v('cf-area'), semanaLaboral: Number(v('cf-semana')),
              codigoDepartamento: lugar.depto, codigoMunicipio: lugar.mpio,
            }),
          });
          alert('Configuración guardada.');
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      });
    }
  }

  // --- Centros de trabajo (ARL) ---------------------------------------------------
  async function cargarCentros() {
    try {
      nom.centros = await api('/nomina/centros-trabajo');
      nom.opciones.centrosTrabajo = nom.centros;
    } catch (err) {
      nom.centros = nom.opciones.centrosTrabajo || [];
    }
    renderCentros();
  }

  function renderCentros() {
    const caja = $('cf-centros');
    if (!caja) return;
    const editar = puedeEditar();
    const lista = nom.centros || [];
    let html = `<div class="fx-titulo-con-accion nom-titulo-sep"><h4>Centros de trabajo (ARL)</h4>${editar ? boton('+ Agregar centro', 'nuevo-centro', {}, 'btn-primario btn-chico') : ''}</div>
      <p class="nota-aiu">La ARL asigna un código a cada centro de trabajo. Si la empresa tiene varias líneas de negocio o sedes con distinta clase de riesgo, crea un centro por cada una y elige el que corresponde en el contrato de cada empleado. Ese código es el que va en la planilla PILA. Los contratos sin centro usan el principal.</p>`;
    if (!lista.length) {
      html += '<p class="vacio">Aún no hay centros de trabajo. Agrega el que te dio la ARL (normalmente el código es 1 o 0).</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Código ARL</th><th>Nombre o línea de negocio</th><th>Clase de riesgo</th><th class="num">Contratos</th><th>Estado</th><th></th></tr></thead><tbody>
        ${lista.map((x) => `<tr><td>${esc(x.codigo)}</td><td>${esc(x.nombre)}${x.principal ? ' <span class="badge pagada">Principal</span>' : ''}</td>
          <td>${x.claseRiesgo ? esc((nom.opciones.clasesRiesgo || {})[x.claseRiesgo] || x.claseRiesgo) : '<span class="texto-suave">—</span>'}</td>
          <td class="num">${x.contratos || 0}</td><td>${x.activo ? 'Activo' : '<span class="texto-suave">Inactivo</span>'}</td>
          <td class="acciones">${editar ? boton('Editar', 'editar-centro', { id: x.id }) + ' ' + boton('Eliminar', 'eliminar-centro', { id: x.id }, 'btn-accion destructivo') : ''}</td></tr>`).join('')}
        </tbody></table></div>`;
    }
    caja.innerHTML = html;
  }

  function dialogoCentro(x) {
    const esNuevo = !x;
    const d = x || { codigo: '', nombre: '', claseRiesgo: null, principal: !(nom.centros || []).length, activo: true };
    const riesgos = [['', '— Sin definir —']].concat(Object.entries(nom.opciones.clasesRiesgo || {}));
    abrirDialogo({
      titulo: esNuevo ? 'Nuevo centro de trabajo' : `Centro de trabajo ${x.codigo}`,
      ancho: true,
      cuerpo: `<div class="fila-campos">${campo('Código que asignó la ARL', `<input type="number" id="ct-codigo" min="0" max="999999999" step="1" value="${esc(d.codigo)}">`)}
          ${campo('Nombre o línea de negocio', `<input type="text" id="ct-nombre" maxlength="100" value="${esc(d.nombre)}" placeholder="Ej.: Taller, Sede Medellín, Obra norte">`)}</div>
        <div class="fila-campos">${campo('Clase de riesgo (opcional)', `<select id="ct-riesgo">${opcionesSelect(riesgos, d.claseRiesgo || '')}</select>`)}</div>
        <label class="check-linea"><input type="checkbox" id="ct-principal"${d.principal ? ' checked' : ''}${d.principal && !esNuevo ? ' disabled' : ''}> <span>Centro principal (lo usan los contratos que no eligen uno). Solo puede haber uno.</span></label>
        ${esNuevo ? '' : `<label class="check-linea"><input type="checkbox" id="ct-activo"${d.activo ? ' checked' : ''}${d.principal ? ' disabled' : ''}> <span>Activo (si se desactiva, ya no se puede elegir en contratos nuevos)</span></label>`}
        <p class="nota-aiu">La clase de riesgo solo sirve de sugerencia: al elegir este centro en un contrato se propone esa clase. La tarifa de ARL sale de la clase del contrato.</p>`,
      guardar: {
        texto: esNuevo ? 'Crear centro' : 'Guardar cambios',
        fn: async () => {
          const cuerpo = {
            codigo: v('ct-codigo'), nombre: v('ct-nombre'), claseRiesgo: v('ct-riesgo') || null, principal: $('ct-principal').checked,
          };
          if (!esNuevo) cuerpo.activo = $('ct-activo').checked;
          if (esNuevo) await api('/nomina/centros-trabajo', { method: 'POST', body: JSON.stringify(cuerpo) });
          else await api(`/nomina/centros-trabajo/${x.id}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
          await cargarCentros();
        },
      },
    });
  }

  // ===================================================================================
  // Eventos
  // ===================================================================================
  $('nom-subtabs').innerHTML = SUBS.map(([k, t]) => `<button type="button" data-sub="${k}">${t}</button>`).join('');
  $('nom-subtabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (!b) return;
    mostrarSub(b.dataset.sub);
  });

  $('panel-nomina').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-nom]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.nom) {
      case 'nuevo-periodo': return dialogoNuevoPeriodo();
      case 'abrir-periodo':
        try {
          nom.detalle = await api(`/nomina/periodos/${id}`);
          renderDetallePeriodo();
        } catch (err) { mostrarError(err); }
        return;
      case 'volver-periodos':
        nom.detalle = null;
        return mostrarSub('liquidacion');
      case 'ver-liquidacion': return verLiquidacion(b.dataset.empleado);
      case 'recalcular': return accionPeriodo('recalcular', {}, null);
      case 'contabilizar':
        if (confirm('¿Contabilizar esta nómina? Se registran el asiento de la liquidación y el de las provisiones, con fecha del último día del mes. Después ya no se recalcula (solo se puede reabrir).')) {
          return accionPeriodo('contabilizar', {}, 'Nómina contabilizada.');
        }
        return;
      case 'reabrir': return dialogoReabrir();
      case 'pagar': return dialogoPago();
      case 'ir-planilla':
        nom.planillaPeriodoId = id;
        return mostrarSub('planilla');
      case 'nuevo-centro': return dialogoCentro(null);
      case 'editar-centro': return dialogoCentro((nom.centros || []).find((x) => x.id === id));
      case 'eliminar-centro':
        if (confirm('¿Eliminar este centro de trabajo? Si tiene contratos, desactívalo en vez de eliminarlo.')) {
          try { await api(`/nomina/centros-trabajo/${id}`, { method: 'DELETE' }); await cargarCentros(); } catch (err) { mostrarError(err); }
        }
        return;
      case 'nuevo-contrato': return dialogoContrato(null);
      case 'editar-contrato': return dialogoContrato(nom.contratos.find((c) => c.id === id));
      case 'nueva-ausencia': return dialogoAusencia();
      case 'quitar-ausencia':
        if (confirm('¿Quitar esta ausencia?')) {
          try { await api(`/nomina/ausencias/${id}`, { method: 'DELETE' }); nom.ausencias = await api('/nomina/ausencias'); renderNovedades(); } catch (err) { mostrarError(err); }
        }
        return;
      case 'nuevo-concepto': return dialogoConcepto();
      case 'quitar-concepto':
        if (confirm('¿Quitar esta novedad? Las nóminas ya contabilizadas no cambian.')) {
          try { await api(`/nomina/conceptos/${id}`, { method: 'DELETE' }); nom.conceptos = await api('/nomina/conceptos'); renderNovedades(); } catch (err) { mostrarError(err); }
        }
        return;
      case 'planilla-csv': return descargarPlanillaCsv();
      case 'planilla-pila': return descargarArchivoPila();
      case 'planilla-cargue': return descargarArchivo(`/nomina/periodos/${nom.planillaPeriodoId}/planilla-cargue.csv`, 'pila-cargue.csv');
      case 'pagar-planilla': return dialogoPagoPlanilla();
      case 'anular-pago-planilla': return dialogoAnularPagoPlanilla(id);
    }
  });

  // Ayudas para nominaPrestaciones.js (prestaciones, vacaciones y liquidación final).
  window.nominaUI = {
    nom, $, esc, dinero, v, num, campo, opcionesSelect, boton, aviso, mostrarError, puedeEditar, nombreMes, contenido,
    abrirDialogo, cerrarDialogo, errorDialogo, tablaAsiento, descargarArchivo, MESES,
    registrarSub(clave, titulo, fn) {
      subsExternas[clave] = fn;
      const i = SUBS.findIndex((x) => x[0] === 'planilla');
      SUBS.splice(i, 0, [clave, titulo]);
      $('nom-subtabs').innerHTML = SUBS.map(([k, t]) => `<button type="button" data-sub="${k}">${t}</button>`).join('');
    },
    mostrarSub,
  };

  // Lo llama app.js cada vez que se abre la pestaña Nómina.
  window.nominaAlMostrar = function () {
    mostrarSub(nom.sub);
  };

  // El auxiliar no ve nómina (los sueldos son información sensible).
  window.nominaConfigurarAcceso = function () {
    const oculto = !usuario || usuario.rol === 'auxiliar';
    document.querySelectorAll('.nav-item[data-tab="nomina"], .tarjeta-modulo[data-ir-a="nomina"]').forEach((el) => { el.hidden = oculto; });
    nom.opciones = null;
    nom.detalle = null;
  };
  window.nominaConfigurarAcceso();
})();
