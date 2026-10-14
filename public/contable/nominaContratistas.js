// Nómina · Contratistas independientes: aportes que la empresa paga en la planilla Y de la PILA.
//
// Se carga DESPUÉS de nomina.js, que le presta sus ayudas por window.nominaUI.
//
// Qué hace:
//   · Contratos de contratistas con acuerdo de pago de aportes (valor mensualizado, clase de riesgo, entidades).
//   · Cada mes: calcula salud, pensión y ARL (IBC = 40 % del valor mensualizado), contabiliza el descuento
//     al contratista contra 2370 y registra el pago de la planilla al operador (Asopagos u otro).
(function () {
  const U = window.nominaUI;
  if (!U) return;
  const { nom, $, esc, dinero, v, num, campo, opcionesSelect, boton, aviso, mostrarError, puedeEditar, abrirDialogo, tablaAsiento, descargarArchivo, MESES } = U;
  const AC = window.aportesContratistas;

  const ctr = { opciones: null, contratos: [], periodos: [], detalle: null };
  const fecha = (f) => (f ? formatoFecha(f) : '—');
  const ESTADOS = { borrador: 'Borrador', contabilizada: 'Contabilizada', pagada: 'Pagada' };
  const TIPOS_DOC = [['CC', 'CC · Cédula de ciudadanía'], ['CE', 'CE · Cédula de extranjería'], ['TI', 'TI · Tarjeta de identidad'], ['PA', 'PA · Pasaporte'], ['PE', 'PE · Permiso especial de permanencia'], ['CD', 'CD · Carné diplomático'], ['SC', 'SC · Salvoconducto'], ['RC', 'RC · Registro civil']];
  const ROMANOS = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };
  const nombreMes = (a, m) => `${MESES[m - 1]} de ${a}`;

  async function cargarOpciones() {
    ctr.opciones = await api('/nomina/contratistas/opciones');
    return ctr.opciones;
  }

  // ===================================================================================
  // LISTAS
  // ===================================================================================
  async function mostrarContratistas() {
    if (!ctr.opciones) await cargarOpciones();
    if (ctr.detalle) {
      try { ctr.detalle = await api(`/nomina/contratistas/aportes/${ctr.detalle.periodo.id}`); } catch (e) { ctr.detalle = null; }
    }
    if (ctr.detalle) return renderDetalle();
    [ctr.contratos, ctr.periodos] = await Promise.all([api('/nomina/contratistas/contratos'), api('/nomina/contratistas/aportes')]);
    renderLista();
  }

  function renderLista() {
    const editar = puedeEditar();
    const P = ctr.opciones.parametros;
    let html = `<div class="nom-barra"><p class="nota-panel">Contratistas de prestación de servicios a quienes la empresa les paga la seguridad social en la <strong>planilla Y</strong> (Resolución 467 de 2025), por acuerdo con ellos. Se les descuenta de los honorarios: salud ${(P.tarifaSalud * 100).toFixed(1).replace('.', ',')} %, pensión ${(P.tarifaPension * 100)} % y la ARL de las clases I a III; la ARL de las clases IV y V la asume la empresa. La base es el ${P.factorIbc * 100} % del valor <strong>mensualizado</strong> del contrato (sin IVA), con mínimo de 1 SMMLV.</p></div>`;

    html += `<div class="fx-titulo-con-accion"><h4>Contratos con acuerdo de pago de aportes</h4>${editar ? boton('+ Nuevo contrato', 'ctr-nuevo-contrato', {}, 'btn-primario btn-chico') : ''}</div>`;
    if (!ctr.contratos.length) {
      html += '<p class="vacio">Aún no hay contratistas. Registra el contrato de cada persona a la que la empresa le paga los aportes.</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Contratista</th><th>Desde</th><th>Hasta</th><th class="num">Valor mensual</th><th>Riesgo</th><th>Estado</th><th></th></tr></thead><tbody>
      ${ctr.contratos.map((c) => `<tr><td><strong>${esc(c.tercero ? c.tercero.nombre : '—')}</strong><br><span class="texto-suave">${esc(c.tercero ? c.tercero.identificacion : '')}${c.descripcion ? ' · ' + esc(c.descripcion) : ''}</span></td>
        <td>${esc(fecha(c.fechaInicio))}</td><td>${esc(fecha(c.fechaFin))}</td><td class="num">${dinero(c.valorMensual)}</td>
        <td>Clase ${ROMANOS[c.claseRiesgo] || c.claseRiesgo}${c.claseRiesgo >= 4 ? ' <span class="texto-suave">(la asume la empresa)</span>' : ''}</td>
        <td>${c.activo ? 'Activo' : '<span class="texto-suave">Inactivo</span>'}</td>
        <td class="acciones">${editar ? boton('Editar', 'ctr-editar-contrato', { id: c.id }) + ' ' + boton('Eliminar', 'ctr-eliminar-contrato', { id: c.id }, 'btn-accion destructivo') : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    }

    html += `<div class="fx-titulo-con-accion nom-titulo-sep"><h4>Aportes por mes (planilla Y)</h4>${editar ? boton('+ Calcular un mes', 'ctr-nuevo-periodo', {}, 'btn-primario btn-chico') : ''}</div>`;
    if (!ctr.periodos.length) {
      html += '<p class="vacio">Todavía no hay meses liquidados. Cuando termine el mes, calcula los aportes, contabilízalos y, al pagar la planilla en el operador, regístralo aquí.</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Mes</th><th>Estado</th><th class="num">Contratistas</th><th class="num">Se descuenta</th><th class="num">Asume la empresa</th><th class="num">Total planilla</th><th>Pago</th><th></th></tr></thead><tbody>
      ${ctr.periodos.map((p) => `<tr><td><strong>${esc(nombreMes(p.anio, p.mes))}</strong></td><td>${badge(p.estado)}</td><td class="num">${(p.totales || {}).contratistas || 0}</td>
        <td class="num">${dinero((p.totales || {}).descuento)}</td><td class="num">${dinero((p.totales || {}).asumeEmpresa)}</td><td class="num"><strong>${dinero((p.totales || {}).total)}</strong></td>
        <td>${p.estado === 'pagada' ? esc(fecha(p.fechaPago)) : ''}</td>
        <td class="acciones">${boton('Abrir', 'ctr-abrir', { id: p.id })}</td></tr>`).join('')}
      </tbody></table></div>`;
    }
    U.contenido().innerHTML = html;
  }

  // ===================================================================================
  // DETALLE DE UN MES
  // ===================================================================================
  function renderDetalle() {
    const d = ctr.detalle;
    const p = d.periodo;
    const t = d.totales || {};
    const editar = puedeEditar();
    let html = `<div class="nom-barra">
      ${boton('← Contratistas', 'ctr-volver', {}, 'btn-secundario btn-chico')}
      <h3>Aportes de contratistas · ${esc(nombreMes(p.anio, p.mes))}</h3> ${badge(p.estado)}
      <span class="nota-aiu">${p.estado === 'pagada' ? 'Planilla pagada el ' + esc(fecha(p.fechaPago)) + (p.numeroPlanilla ? ' · ' + esc(p.numeroPlanilla) : '') + (p.operador ? ' · ' + esc(p.operador) : '') : ESTADOS[p.estado]}</span>
    </div>
    <div class="nom-tarjetas">
      <div class="nom-tarjeta"><span>Se descuenta a los contratistas</span><strong>${dinero(t.descuento)}</strong></div>
      <div class="nom-tarjeta"><span>ARL que asume la empresa</span><strong>${dinero(t.asumeEmpresa)}</strong></div>
      <div class="nom-tarjeta destacada"><span>Total de la planilla Y</span><strong>${dinero(t.total)}</strong></div>
      ${p.estado === 'pagada' && p.mora ? `<div class="nom-tarjeta"><span>Intereses de mora</span><strong>${dinero(p.mora)}</strong></div>` : ''}
    </div>`;
    if (d.avisos.length) html += aviso('confirmar', '<strong>Revisa:</strong><br>' + d.avisos.map(esc).join('<br>'));

    html += `<div class="tabla-envoltorio"><table><thead><tr><th>Contratista</th><th class="num">Días</th><th class="num">Honorarios del mes</th><th class="num">IBC</th><th class="num">Salud</th><th class="num">Pensión</th><th class="num">ARL</th><th class="num">Se descuenta</th><th class="num">Asume la empresa</th><th class="num">Neto al contratista</th></tr></thead><tbody>
      ${d.lineas.map((l) => `<tr><td><strong>${esc(l.nombre)}</strong><br><span class="texto-suave">${esc(l.identificacion)}${l.contratos.length > 1 ? ' · ' + l.contratos.length + ' contratos' : ''}${l.terminaEnMes ? ' · termina: RET-T' : ''}</span></td>
        <td class="num">${l.dias}</td><td class="num">${dinero(l.valorDelMes)}</td>
        <td class="num">${dinero(l.ibc)}<br><span class="texto-suave">${esc(l.origenIbc)}</span></td>
        <td class="num">${dinero(l.salud.valor)}</td><td class="num">${dinero(l.pension.valor + l.fsp.valor)}${l.fsp.valor ? `<br><span class="texto-suave">con solidaridad</span>` : ''}</td>
        <td class="num">${dinero(l.arl.valor)}<br><span class="texto-suave">clase ${l.arl.clase} · ${l.arl.aCargoDe === 'empresa' ? 'empresa' : 'contratista'}</span></td>
        <td class="num"><strong>${dinero(l.descuento)}</strong></td><td class="num">${dinero(l.asumeEmpresa)}</td><td class="num">${dinero(l.netoAntesDeImpuestos)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="nota-aiu">El neto al contratista es el valor de sus honorarios del mes menos los aportes que se le descuentan; todavía no incluye IVA ni retención en la fuente. Al pagarle su cuenta de cobro o documento soporte, págale ese neto: el descuento ya queda contabilizado contra su cuenta por pagar.</p>`;

    html += '<div class="nom-acciones">';
    html += boton('Descargar CSV de cargue', 'ctr-cargue', {}, 'btn-secundario');
    if (editar && p.estado === 'borrador') {
      html += boton('Recalcular', 'ctr-recalcular', {}, 'btn-secundario');
      html += boton('Contabilizar el descuento', 'ctr-contabilizar', {}, 'btn-primario');
      html += boton('Eliminar', 'ctr-eliminar-periodo', {}, 'btn-secundario');
    }
    if (editar && p.estado === 'contabilizada') {
      html += boton('Registrar el pago de la planilla', 'ctr-pagar', {}, 'btn-primario');
      html += boton('Reabrir', 'ctr-reabrir', {}, 'btn-secundario');
    }
    if (editar && p.estado === 'pagada') html += boton('Anular el pago', 'ctr-anular-pago', {}, 'btn-secundario');
    html += '</div>';

    if (d.vistaPrevia) {
      const titulo = p.estado === 'borrador' ? 'Así se contabilizará el descuento' : 'Asiento del descuento (contabilizado)';
      html += `<details class="nom-detalles"><summary>${titulo}</summary>${tablaAsiento(d.vistaPrevia.causacion)}</details>`;
      if (p.estado !== 'pagada') html += `<details class="nom-detalles"><summary>Así se contabilizará el pago de la planilla (la cuenta del banco o caja se define al pagar)</summary>${tablaAsiento(d.vistaPrevia.pago)}</details>`;
    }
    html += `<details class="nom-detalles"><summary>Reglas que aplica el cálculo (revísalas con tu contador)</summary><ul class="nom-lista">
      <li>Planilla Y: cotizante 59 (independiente con contrato de prestación de servicios superior a 1 mes) y aportante 15 (contratante). Es voluntaria: solo para los contratistas con los que se acordó que la empresa pague los aportes.</li>
      <li>IBC = 40 % del valor mensualizado del contrato, sin IVA (no de lo pagado en el mes). Si el contratista tiene varios contratos se suman; la ARL va por la clase de riesgo más alta. Mínimo 1 SMMLV y máximo 25 SMMLV, proporcionales a los días si el contrato empieza o termina en el mes (mes de 30 días).</li>
      <li>Salud 12,5 %, pensión 16 % y fondo de solidaridad pensional desde 4 SMMLV: a cargo del contratista. ARL: clases I a III se descuentan al contratista; clases IV y V las asume la empresa. Cada aporte se aproxima al siguiente múltiplo de 100.</li>
      <li>Contabilización: al terminar el mes, débito a la cuenta por pagar del contratista (2335 o 2205) y crédito a 2370 (salud y ARL) y 238030 (pensión); la ARL de las clases IV y V va a gasto. Al pagar la planilla se salda el 2370.</li>
      <li>El pago es mes vencido. Cuando un contrato termina o se suspende, la empresa reporta la novedad RET-T y el contratista paga después en planilla I. La caja de compensación y el archivo plano de la planilla Y no están incluidos todavía: se digita en el operador con el CSV de cargue.</li></ul></details>`;
    U.contenido().innerHTML = html;
  }

  // ===================================================================================
  // DIÁLOGOS
  // ===================================================================================
  const VACIO = { descripcion: '', fechaInicio: '', fechaFin: '', valorMensual: '', claseRiesgo: 1, areaGasto: 'administracion', cuentaPorPagar: '2335', tipoDocumento: 'CC', epsNombre: '', epsCodigo: '', afpNombre: '', afpCodigo: '', activo: true, observaciones: '' };

  function formularioContrato(c, esNuevo) {
    const o = ctr.opciones;
    const contratista = esNuevo
      ? `<div class="fx-bloque"><h4>Contratista</h4>
          ${campo('Contratista', `<select id="ct-tercero"><option value="">— Nuevo contratista —</option>${o.terceros.map((t) => `<option value="${esc(t.id)}">${esc(t.nombre)} · ${esc(t.identificacion)}</option>`).join('')}</select>`)}
          <div id="ct-nuevo">${campo('Cédula', '<input type="text" id="ct-cedula" maxlength="20" autocomplete="off" inputmode="numeric">')}
            ${campo('Nombre completo', '<input type="text" id="ct-nombre" maxlength="150" autocomplete="off">')}</div></div>`
      : `<div class="fx-bloque"><h4>Contratista</h4><p><strong>${esc(c.tercero ? c.tercero.nombre : '')}</strong><br><span class="texto-suave">${esc(c.tercero ? c.tercero.identificacion : '')}</span></p></div>`;
    return `${contratista}
      <div class="fx-rejilla">
        <div class="fx-bloque"><h4>Contrato</h4>
          ${campo('Objeto del contrato (opcional)', `<input type="text" id="ct-desc" maxlength="255" value="${esc(c.descripcion || '')}">`)}
          ${campo('Aportes desde (inicio del contrato o del acuerdo)', `<input type="date" id="ct-inicio" value="${esc(c.fechaInicio || '')}">`)}
          ${campo('Hasta (fin del contrato; vacío si no tiene)', `<input type="date" id="ct-fin" value="${esc(c.fechaFin || '')}">`)}
          ${campo('Valor mensual del contrato, sin IVA', `<input type="number" id="ct-valor" min="0" step="1" value="${c.valorMensual || ''}">`)}
          <p class="nota-aiu">Es el valor <strong>mensualizado</strong>: si el contrato es por un valor total, divídelo entre los meses.</p>
        </div>
        <div class="fx-bloque"><h4>Riesgo y contabilidad</h4>
          ${campo('Clase de riesgo (ARL)', `<select id="ct-riesgo">${opcionesSelect(Object.entries(o.clasesRiesgo), c.claseRiesgo)}</select>`)}
          <p class="nota-aiu">Clases I a III: la ARL se descuenta al contratista. Clases IV y V: la asume la empresa.</p>
          ${campo('Área donde va la ARL que asume la empresa', `<select id="ct-area">${opcionesSelect(Object.entries(o.areas), c.areaGasto)}</select>`)}
          ${campo('Cuenta por pagar al contratista', `<select id="ct-cxp">${opcionesSelect(Object.entries(o.cuentasPorPagar), c.cuentaPorPagar)}</select>`)}
          ${esNuevo ? '' : `<label class="check-linea"><input type="checkbox" id="ct-activo"${c.activo ? ' checked' : ''}> <span>Activo (si se desmarca, deja de entrar en los aportes de los meses nuevos)</span></label>`}
        </div>
        <div class="fx-bloque"><h4>Entidades del contratista</h4>
          ${campo('Tipo de documento', `<select id="ct-tipodoc">${opcionesSelect(TIPOS_DOC, c.tipoDocumento || 'CC')}</select>`)}
          ${campo('EPS', `<input type="text" id="ct-eps" maxlength="100" value="${esc(c.epsNombre || '')}">`)}
          ${campo('Código EPS', `<input type="text" id="ct-eps-cod" maxlength="20" value="${esc(c.epsCodigo || '')}" placeholder="Ej.: EPS005">`)}
          ${campo('Fondo de pensiones', `<input type="text" id="ct-afp" maxlength="100" value="${esc(c.afpNombre || '')}">`)}
          ${campo('Código fondo', `<input type="text" id="ct-afp-cod" maxlength="20" value="${esc(c.afpCodigo || '')}" placeholder="Ej.: 230301">`)}
        </div>
        <div class="fx-bloque"><h4>Cuánto sería un mes completo</h4><div id="ct-simulacion" class="nom-simulacion"></div></div>
      </div>
      ${campo('Observaciones (opcional)', `<input type="text" id="ct-obs" maxlength="500" value="${esc(c.observaciones || '')}">`)}`;
  }

  function leerContrato(esNuevo) {
    const c = {
      descripcion: v('ct-desc'), fechaInicio: v('ct-inicio'), fechaFin: v('ct-fin') || null, valorMensual: num('ct-valor'),
      claseRiesgo: num('ct-riesgo'), areaGasto: v('ct-area'), cuentaPorPagar: v('ct-cxp'), tipoDocumento: v('ct-tipodoc'),
      epsNombre: v('ct-eps'), epsCodigo: v('ct-eps-cod'), afpNombre: v('ct-afp'), afpCodigo: v('ct-afp-cod'), observaciones: v('ct-obs'),
    };
    if (!esNuevo) c.activo = $('ct-activo').checked;
    return c;
  }

  function simular() {
    const caja = $('ct-simulacion');
    if (!caja || !AC) return;
    const c = leerContrato(true);
    if (!(c.valorMensual > 0)) { caja.innerHTML = '<p class="texto-suave">Escribe el valor mensual para ver los aportes.</p>'; return; }
    const hoy = ctr.opciones.hoy;
    const L = AC.liquidarContratista({ anio: Number(hoy.slice(0, 4)), mes: Number(hoy.slice(5, 7)), contratos: [{ id: 'x', fechaInicio: '2000-01-01', fechaFin: null, valorMensual: c.valorMensual, claseRiesgo: c.claseRiesgo }] });
    caja.innerHTML = `<table class="tabla-items-detalle"><tbody>
      <tr><td>IBC (${esc(L.origenIbc)})</td><td class="num">${dinero(L.ibc)}</td></tr>
      <tr><td>Salud 12,5 %</td><td class="num">${dinero(L.salud.valor)}</td></tr>
      <tr><td>Pensión 16 %${L.fsp.valor ? ' + solidaridad' : ''}</td><td class="num">${dinero(L.pension.valor + L.fsp.valor)}</td></tr>
      <tr><td>ARL clase ${L.arl.clase} (${L.arl.aCargoDe === 'empresa' ? 'la asume la empresa' : 'se descuenta'})</td><td class="num">${dinero(L.arl.valor)}</td></tr>
      <tr><td><strong>Se descuenta al contratista</strong></td><td class="num"><strong>${dinero(L.descuento)}</strong></td></tr>
      <tr><td><strong>Neto a pagarle (antes de IVA y retención)</strong></td><td class="num"><strong>${dinero(L.netoAntesDeImpuestos)}</strong></td></tr></tbody></table>`;
  }

  function dialogoContrato(c) {
    const esNuevo = !c;
    abrirDialogo({
      titulo: esNuevo ? 'Nuevo contrato de contratista' : `Contrato de ${c.tercero ? c.tercero.nombre : ''}`,
      cuerpo: formularioContrato(c || VACIO, esNuevo),
      ancho: true,
      guardar: {
        texto: esNuevo ? 'Crear contrato' : 'Guardar cambios',
        fn: async () => {
          const cuerpo = leerContrato(esNuevo);
          let r;
          if (esNuevo) {
            const t = v('ct-tercero');
            if (t) cuerpo.terceroId = t;
            else cuerpo.nuevoTercero = { identificacion: v('ct-cedula'), nombre: v('ct-nombre') };
            r = await api('/nomina/contratistas/contratos', { method: 'POST', body: JSON.stringify(cuerpo) });
          } else {
            r = await api(`/nomina/contratistas/contratos/${c.id}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
          }
          await cargarOpciones();
          ctr.contratos = await api('/nomina/contratistas/contratos');
          renderLista();
          if (r.avisos && r.avisos.length) alert(r.avisos.join('\n'));
        },
      },
    });
    const cuerpo = $('nom-dialogo-cuerpo');
    const alCambiar = () => {
      if ($('ct-tercero')) $('ct-nuevo').hidden = !!$('ct-tercero').value;
      simular();
    };
    cuerpo.oninput = alCambiar;
    cuerpo.onchange = alCambiar;
    alCambiar();
  }

  function dialogoPeriodo() {
    const hoy = ctr.opciones.hoy;
    let anio = Number(hoy.slice(0, 4));
    let mes = Number(hoy.slice(5, 7)) - 1; // el pago es mes vencido: por defecto, el mes anterior
    if (mes < 1) { mes = 12; anio -= 1; }
    abrirDialogo({
      titulo: 'Calcular los aportes de un mes',
      cuerpo: `<div class="fila-campos">${campo('Mes', `<select id="cp-mes">${opcionesSelect(MESES.map((m, i) => [i + 1, m]), mes)}</select>`)}
        ${campo('Año', `<input type="number" id="cp-anio" value="${anio}" min="2020" max="2100">`)}</div>
        <p class="nota-aiu">Entran los contratistas con contrato activo y vigente en ese mes. Los aportes se pagan mes vencido: los de septiembre, en octubre.</p>`,
      guardar: {
        texto: 'Calcular',
        fn: async () => {
          ctr.detalle = await api('/nomina/contratistas/aportes', { method: 'POST', body: JSON.stringify({ anio: num('cp-anio'), mes: num('cp-mes') }) });
          renderDetalle();
        },
      },
    });
  }

  function dialogoPago() {
    const p = ctr.detalle.periodo;
    const bancos = ctr.opciones.cuentasBancarias;
    const ultimo = new Date(Date.UTC(p.anio, p.mes, 0)).toISOString().slice(0, 10); // último día del mes causado
    const sugerida = ctr.opciones.hoy > ultimo ? ctr.opciones.hoy : ultimo;
    abrirDialogo({
      titulo: 'Registrar el pago de la planilla Y',
      cuerpo: `<p>Valor de la planilla: <strong>${dinero((ctr.detalle.totales || {}).total)}</strong>.</p>
        <div class="fila-campos">
          ${campo('Pagada desde', `<select id="cg-medio">${bancos.map((b) => `<option value="${esc(b.id)}">${esc(b.banco)} ${esc(b.tipoCuenta || '')} ****${esc(b.numero)}</option>`).join('')}<option value="caja">Efectivo (caja)</option></select>`)}
          ${campo('Fecha del pago', `<input type="date" id="cg-fecha" value="${sugerida}">`)}</div>
        <div class="fila-campos">
          ${campo('Operador', `<input type="text" id="cg-operador" maxlength="100" value="${esc(ctr.opciones.operadorPila || '')}" placeholder="Ej.: Asopagos">`)}
          ${campo('Número de la planilla (opcional)', '<input type="text" id="cg-numero" maxlength="30" autocomplete="off">')}
          ${campo('Intereses de mora (si pagaste tarde)', '<input type="number" id="cg-mora" min="0" step="1" value="0">')}</div>
        <p class="nota-aiu">Queda un egreso en la cuenta bancaria, pendiente de conciliar con el extracto. El pago se registra contra el 2370 que se causó al contabilizar el descuento.</p>`,
      guardar: {
        texto: 'Registrar pago',
        fn: async () => {
          const medio = v('cg-medio');
          const cuerpo = { fecha: v('cg-fecha'), operador: v('cg-operador'), numeroPlanilla: v('cg-numero'), mora: num('cg-mora') };
          if (medio === 'caja') cuerpo.medio = 'caja';
          else cuerpo.cuentaBancariaId = medio;
          ctr.detalle = await api(`/nomina/contratistas/aportes/${p.id}/pago`, { method: 'POST', body: JSON.stringify(cuerpo) });
          renderDetalle();
        },
      },
    });
  }

  function dialogoMotivo(titulo, texto, ruta, boton2) {
    const p = ctr.detalle.periodo;
    abrirDialogo({
      titulo,
      cuerpo: `<p>${texto}</p>${campo('Motivo (queda en la auditoría)', '<input type="text" id="cm-motivo" maxlength="250" autocomplete="off">')}`,
      guardar: {
        texto: boton2,
        fn: async () => {
          ctr.detalle = await api(`/nomina/contratistas/aportes/${p.id}/${ruta}`, { method: 'POST', body: JSON.stringify({ motivo: v('cm-motivo') }) });
          renderDetalle();
        },
      },
    });
  }

  // ===================================================================================
  // Eventos
  // ===================================================================================
  async function accion(ruta, mensajeOk) {
    try {
      ctr.detalle = await api(`/nomina/contratistas/aportes/${ctr.detalle.periodo.id}/${ruta}`, { method: 'POST', body: JSON.stringify({}) });
      renderDetalle();
      if (mensajeOk) alert(mensajeOk);
    } catch (err) {
      mostrarError(err);
    }
  }

  $('panel-nomina').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-nom]');
    if (!b || !String(b.dataset.nom).startsWith('ctr-')) return;
    const id = b.dataset.id;
    switch (b.dataset.nom) {
      case 'ctr-nuevo-contrato': return dialogoContrato(null);
      case 'ctr-editar-contrato': return dialogoContrato(ctr.contratos.find((c) => c.id === id));
      case 'ctr-eliminar-contrato':
        if (confirm('¿Eliminar este contrato? Si ya entró en meses contabilizados, ponle fecha de fin o desactívalo en vez de eliminarlo.')) {
          try { await api(`/nomina/contratistas/contratos/${id}`, { method: 'DELETE' }); ctr.contratos = await api('/nomina/contratistas/contratos'); renderLista(); } catch (err) { mostrarError(err); }
        }
        return;
      case 'ctr-nuevo-periodo': return dialogoPeriodo();
      case 'ctr-abrir':
        try { ctr.detalle = await api(`/nomina/contratistas/aportes/${id}`); renderDetalle(); } catch (err) { mostrarError(err); }
        return;
      case 'ctr-volver':
        ctr.detalle = null;
        return U.mostrarSub('contratistas');
      case 'ctr-recalcular': return accion('recalcular');
      case 'ctr-contabilizar':
        if (confirm('¿Contabilizar el descuento de aportes de este mes? Se registra el asiento con fecha del último día del mes.')) return accion('contabilizar', 'Descuento contabilizado.');
        return;
      case 'ctr-eliminar-periodo':
        if (confirm('¿Eliminar este borrador?')) {
          try { await api(`/nomina/contratistas/aportes/${ctr.detalle.periodo.id}`, { method: 'DELETE' }); ctr.detalle = null; U.mostrarSub('contratistas'); } catch (err) { mostrarError(err); }
        }
        return;
      case 'ctr-pagar': return dialogoPago();
      case 'ctr-reabrir': return dialogoMotivo('Reabrir el mes', 'Se anula el asiento del descuento y el mes vuelve a borrador para recalcularlo.', 'reabrir', 'Reabrir');
      case 'ctr-anular-pago': return dialogoMotivo('Anular el pago', 'Se anulan el asiento y el egreso del banco; el mes vuelve a quedar contabilizado, pendiente de pago.', 'anular-pago', 'Anular');
      case 'ctr-cargue': return descargarArchivo(`/nomina/contratistas/aportes/${ctr.detalle.periodo.id}/cargue.csv`, `planilla-y-cargue-${ctr.detalle.periodo.anio}-${String(ctr.detalle.periodo.mes).padStart(2, '0')}.csv`);
    }
  });

  U.registrarSub('contratistas', 'Contratistas (planilla Y)', mostrarContratistas);
})();
