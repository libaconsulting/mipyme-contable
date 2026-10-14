// Nómina · Prestaciones sociales, vacaciones y liquidación final.
//
// Se carga DESPUÉS de nomina.js, que le presta sus ayudas (diálogo, formato, API)
// por window.nominaUI y le deja registrar pestañas nuevas.
//
// Pestañas que agrega:
//   · Prestaciones y liquidación: prima, cesantías, intereses (por lote), vacaciones
//     en dinero y liquidación final de un contrato. Cada documento se calcula en
//     borrador, se revisa y se paga (con su asiento); un pago se puede anular.
//   · Vacaciones: saldo de días y de dinero de cada empleado.
(function () {
  const U = window.nominaUI;
  if (!U) return;
  const { nom, $, esc, dinero, v, num, campo, opcionesSelect, boton, aviso, mostrarError, puedeEditar, abrirDialogo, tablaAsiento } = U;

  const pre = { docs: [], detalle: null, vac: null, vacCorte: null };
  const TIPOS = {
    prima: 'Prima de servicios', cesantias: 'Cesantías', intereses: 'Intereses sobre cesantías',
    vacaciones: 'Vacaciones en dinero', liquidacion: 'Liquidación final',
  };
  const dias2 = (x) => (Math.round((Number(x) || 0) * 100) / 100).toLocaleString('es-CO');
  const fecha = (f) => (f ? formatoFecha(f) : '—');

  function etiqueta(d) {
    if (d.tipo === 'prima') return `Prima de servicios ${d.anio} · semestre ${d.semestre}`;
    if (d.tipo === 'cesantias') return `Cesantías ${d.anio}`;
    if (d.tipo === 'intereses') return `Intereses sobre cesantías ${d.anio}`;
    if (d.tipo === 'vacaciones') return `Vacaciones en dinero${d.empleado ? ' · ' + d.empleado : ''}`;
    return `Liquidación final${d.empleado ? ' · ' + d.empleado : ''} (retiro ${formatoFecha(d.fechaCorte)})`;
  }

  // ===================================================================================
  // LISTA
  // ===================================================================================
  async function mostrarPrestaciones() {
    if (pre.detalle) {
      try { pre.detalle = await api(`/nomina/prestaciones/${pre.detalle.prestacion.id}`); } catch (e) { pre.detalle = null; }
    }
    if (pre.detalle) return renderDetalle();
    pre.docs = await api('/nomina/prestaciones');
    renderLista();
  }

  function renderLista() {
    const editar = puedeEditar();
    let html = `<div class="nom-barra"><p class="nota-panel">Prima de servicios (junio y diciembre), cesantías e intereses (febrero), vacaciones pagadas en dinero y la liquidación final cuando un empleado se retira. Se calculan con las nóminas del sistema y el contrato, se revisan en borrador y, al pagarlas, quedan contabilizadas contra la provisión de cada empleado.</p></div>`;
    if (editar) {
      html += `<div class="nom-acciones">
        ${boton('+ Prima', 'nuevo-lote', { tipo: 'prima' }, 'btn-primario')}
        ${boton('+ Cesantías', 'nuevo-lote', { tipo: 'cesantias' }, 'btn-primario')}
        ${boton('+ Intereses de cesantías', 'nuevo-lote', { tipo: 'intereses' }, 'btn-primario')}
        ${boton('+ Vacaciones en dinero', 'nueva-vacacion', {}, 'btn-secundario')}
        ${boton('+ Liquidación final', 'nueva-liquidacion', {}, 'btn-secundario')}</div>`;
    }
    if (!pre.docs.length) {
      html += '<p class="vacio">Todavía no hay pagos de prestaciones. Empieza con la prima del semestre, las cesantías del año o la liquidación de un empleado que se retira.</p>';
    } else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Documento</th><th>Estado</th><th class="num">Empleados</th><th class="num">Devengado</th><th class="num">Retención</th><th class="num">Neto</th><th>Pago</th><th></th></tr></thead><tbody>
      ${pre.docs.map((d) => `<tr><td><strong>${esc(etiqueta(d))}</strong></td><td>${badge(d.estado)}</td><td class="num">${d.empleados}</td>
        <td class="num">${dinero(d.totalDevengado)}</td><td class="num">${dinero(d.totalRetencion)}</td><td class="num"><strong>${dinero(d.totalNeto)}</strong></td>
        <td>${d.estado === 'pagada' ? esc(fecha(d.fechaPago)) : ''}</td>
        <td class="acciones">${boton('Abrir', 'abrir', { id: d.id })}</td></tr>`).join('')}
      </tbody></table></div>`;
    }
    U.contenido().innerHTML = html;
  }

  // ===================================================================================
  // DETALLE DE UN DOCUMENTO
  // ===================================================================================
  function textoComponente(c) {
    const partes = [`<strong>${esc(c.nombre)}</strong>`];
    if (c.dias) partes.push(`<span class="texto-suave">${dias2(c.dias)} ${c.concepto === 'vacaciones' || c.concepto === 'indemnizacion' ? 'días' : 'días'}</span>`);
    return `<div class="nom-comp">${partes.join(' ')} · ${dinero(c.valor)}</div>`;
  }

  function renderDetalle() {
    const d = pre.detalle;
    const p = d.prestacion;
    const editar = puedeEditar();
    let html = `<div class="nom-barra">
      ${boton('← Prestaciones', 'volver', {}, 'btn-secundario btn-chico')}
      <h3>${esc(d.nombreTipo)}${p.tipo === 'prima' ? ` ${p.anio} · semestre ${p.semestre}` : (p.tipo === 'cesantias' || p.tipo === 'intereses' ? ' ' + p.anio : '')}</h3> ${badge(p.estado)}
      <span class="nota-aiu">${p.estado === 'pagada' ? 'Pagada el ' + esc(fecha(p.fechaPago)) : `Liquidada hasta el ${esc(fecha(p.fechaCorte))}`}</span>
    </div>
    <div class="nom-tarjetas">
      <div class="nom-tarjeta"><span>Devengado</span><strong>${dinero(p.totalDevengado)}</strong></div>
      <div class="nom-tarjeta"><span>Retención en la fuente</span><strong>${dinero(p.totalRetencion)}</strong></div>
      ${p.totalDescuentos ? `<div class="nom-tarjeta"><span>Descuentos</span><strong>${dinero(p.totalDescuentos)}</strong></div>` : ''}
      <div class="nom-tarjeta destacada"><span>Neto a pagar</span><strong>${dinero(p.totalNeto)}</strong></div>
    </div>`;
    if (p.estado === 'anulada') html += aviso('bloqueo', `Anulado. Motivo: ${esc(p.motivoAnulacion || '')}`);
    const conError = d.lineas.filter((l) => l.error);
    if (conError.length) html += aviso('bloqueo', 'No se pudo calcular a: ' + conError.map((l) => `<strong>${esc(l.nombre)}</strong> (${esc(l.error)})`).join('; '));
    if (d.advertencias.length) html += aviso('confirmar', '<strong>Revisa:</strong><br>' + d.advertencias.map(esc).join('<br>'));
    if (!d.lineas.length) html += aviso('info', 'Ningún empleado entra en este documento todavía.');

    if (d.lineas.length) {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th>Conceptos</th><th class="num">Devengado</th><th class="num">Retención</th><th class="num">Descuentos</th><th class="num">Neto</th><th></th></tr></thead><tbody>
      ${d.lineas.map((l) => `<tr${l.error ? ' class="fila-error"' : ''}>
        <td><strong>${esc(l.nombre)}</strong><br><span class="texto-suave">${esc(l.cargo || '')}</span></td>
        <td>${l.componentes.map(textoComponente).join('') || '<span class="texto-suave">—</span>'}</td>
        <td class="num">${dinero(l.devengado)}</td><td class="num">${dinero(l.retencion)}</td><td class="num">${dinero(l.descuentos)}</td>
        <td class="num"><strong>${dinero(l.neto)}</strong></td>
        <td class="acciones">${l.error ? '' : boton('Cálculo', 'ver-calculo', { linea: l.id }) + ' ' + boton('Comprobante', 'comprobante', { empleado: l.empleadoId })}</td></tr>`).join('')}
      </tbody></table></div>`;
    }

    html += '<div class="nom-acciones">';
    if (editar && p.estado === 'borrador') {
      html += boton('Recalcular', 'pre-recalcular', {}, 'btn-secundario');
      if (p.tipo === 'liquidacion' || p.tipo === 'vacaciones') html += boton('Editar', 'editar', {}, 'btn-secundario');
      html += boton('Registrar el pago', 'pre-pagar', {}, 'btn-primario');
      html += boton('Eliminar', 'eliminar', {}, 'btn-secundario');
    }
    if (editar && p.estado === 'pagada') html += boton('Anular el pago', 'anular', {}, 'btn-secundario');
    html += '</div>';

    if (d.asiento) {
      if (d.asiento.error) html += aviso('bloqueo', esc(d.asiento.error));
      else {
        const titulo = p.estado === 'borrador' ? 'Así se contabilizará (la cuenta del banco o caja se define al pagar)' : 'Asiento contabilizado';
        html += `<details class="nom-detalles"><summary>${titulo}</summary>${tablaAsiento(d.asiento)}</details>`;
      }
    }
    U.contenido().innerHTML = html;
  }

  // Explicación del cálculo de un empleado
  function filaCalculo(c, l) {
    const base = dinero(c.base);
    const metodo = c.metodo === 'promedio' ? 'promedio del período' : (c.metodo === 'ultimo_salario' ? 'último salario' : '');
    let formula = '';
    if (c.concepto === 'prima' || c.concepto === 'cesantias') {
      formula = `Base mensual ${base} (${metodo}${c.concepto ? ', con auxilio de transporte' : ''}) × ${dias2(c.dias)} días ÷ 360`;
    } else if (c.concepto === 'intereses') {
      formula = `Cesantías ${base} × ${dias2(c.dias)} días × 12 % ÷ 360`;
    } else if (c.concepto === 'vacaciones') {
      formula = `${dias2(c.dias)} días hábiles × (base ${base} ÷ 30)${metodo ? ' · ' + metodo : ''}`;
    } else if (c.concepto === 'indemnizacion') {
      formula = `${dias2(c.dias)} días × (base ${base} ÷ 30). ${esc(c.detalle || '')}`;
    } else {
      formula = esc(c.detalle || '');
    }
    const periodo = c.desde ? ` <span class="texto-suave">del ${esc(fecha(c.desde))} al ${esc(fecha(c.hasta))}</span>` : '';
    const prov = c.saldoProvision !== undefined && c.saldoProvision !== null && ['prima', 'cesantias', 'intereses', 'vacaciones'].includes(c.concepto)
      ? `<br><span class="texto-suave">Provisión en el libro: ${dinero(c.saldoProvision)}${c.valor > c.saldoProvision ? ' · la diferencia (' + dinero(c.valor - c.saldoProvision) + ') va a gasto' : (c.liquidaTotal && c.valor < c.saldoProvision ? ' · se libera ' + dinero(c.saldoProvision - c.valor) : '')}</span>`
      : '';
    return `<tr><td>${esc(c.nombre)}${periodo}</td><td>${formula}${prov}</td><td class="num">${dinero(c.valor)}</td></tr>`;
  }

  function verCalculo(lineaId) {
    const l = pre.detalle.lineas.find((x) => x.id === lineaId);
    if (!l) return;
    let h = `<div class="tabla-envoltorio"><table class="tabla-items-detalle"><thead><tr><th>Concepto</th><th>Cómo se calculó</th><th class="num">Valor</th></tr></thead><tbody>${l.componentes.map((c) => filaCalculo(c, l)).join('')}</tbody>
      <tfoot><tr><td colspan="2"><strong>Total devengado</strong></td><td class="num"><strong>${dinero(l.devengado)}</strong></td></tr>
      ${l.retencion ? `<tr><td colspan="2">− Retención en la fuente</td><td class="num">${dinero(l.retencion)}</td></tr>` : ''}
      ${(l.descuentosDetalle || []).map((x) => `<tr><td colspan="2">− ${esc(x.descripcion)}</td><td class="num">${dinero(x.valor)}</td></tr>`).join('')}
      <tr><td colspan="2"><strong>Neto a pagar</strong></td><td class="num"><strong>${dinero(l.neto)}</strong></td></tr></tfoot></table></div>`;
    if (l.advertencias.length) h += aviso('confirmar', l.advertencias.map(esc).join('<br>'));
    if (l.retencion) h += '<p class="nota-aiu">La retención es el aumento de la retención del mes en que se paga (procedimiento 1, art. 383 del E.T.) por sumar este pago a lo que gana el empleado ese mes.</p>';
    abrirDialogo({ titulo: `${l.nombre} · cálculo`, cuerpo: h, ancho: true });
  }

  // ===================================================================================
  // DIÁLOGOS
  // ===================================================================================
  function irADetalle(d) {
    pre.detalle = d;
    renderDetalle();
  }

  function dialogoLote(tipo) {
    const hoy = nom.opciones.hoy;
    const mes = Number(hoy.slice(5, 7));
    let anio = Number(hoy.slice(0, 4));
    let semestre = mes <= 6 ? 1 : 2;
    if (tipo !== 'prima' && mes <= 2) anio -= 1; // en enero y febrero se pagan las cesantías del año anterior
    abrirDialogo({
      titulo: `Nueva liquidación: ${TIPOS[tipo].toLowerCase()}`,
      cuerpo: `<div class="fila-campos">${campo('Año', `<input type="number" id="pl-anio" value="${anio}" min="2020" max="2100">`)}
        ${tipo === 'prima' ? campo('Semestre', `<select id="pl-semestre">${opcionesSelect([[1, 'Enero a junio (se paga a más tardar el 30 de junio)'], [2, 'Julio a diciembre (se paga a más tardar el 20 de diciembre)']], semestre)}</select>`) : ''}</div>
        <p class="nota-aiu">${tipo === 'prima' ? 'Se liquida a todos los empleados con contrato vigente al cierre del semestre (menos quienes tienen salario integral). Quienes ya se retiraron se liquidan en su liquidación final.'
          : tipo === 'cesantias' ? 'Se liquidan las cesantías del año completo (hasta el 31 de diciembre). Se consignan al fondo de cada empleado a más tardar el 14 de febrero del año siguiente.'
            : 'Se liquida el 12 % anual sobre las cesantías del año. Se pagan directamente al empleado a más tardar el 31 de enero del año siguiente; si no, la ley obliga a pagar el doble.'}</p>`,
      guardar: {
        texto: 'Crear y calcular',
        fn: async () => {
          const cuerpo = { tipo, anio: num('pl-anio') };
          if (tipo === 'prima') cuerpo.semestre = num('pl-semestre');
          irADetalle(await api('/nomina/prestaciones', { method: 'POST', body: JSON.stringify(cuerpo) }));
        },
      },
    });
  }

  async function dialogoVacaciones(empleadoId) {
    if (!nom.opciones.empleados.length) return alert('Primero crea un contrato: así se registra el empleado.');
    let resumen;
    try { resumen = await api('/nomina/vacaciones'); } catch (e) { return mostrarError(e); }
    const sel = empleadoId || nom.opciones.empleados[0].id;
    abrirDialogo({
      titulo: 'Vacaciones pagadas en dinero',
      cuerpo: `<div class="fila-campos">${campo('Empleado', `<select id="pv-empleado">${nom.opciones.empleados.map((e) => `<option value="${e.id}"${e.id === sel ? ' selected' : ''}>${esc(e.nombre)} · ${esc(e.identificacion)}</option>`).join('')}</select>`)}
        ${campo('Días hábiles a pagar', '<input type="number" id="pv-dias" min="0.5" max="90" step="0.5">')}
        ${campo('Fecha de pago', `<input type="date" id="pv-fecha" value="${nom.opciones.hoy}">`)}</div>
        <p class="nota-aiu" id="pv-info"></p>
        <p class="nota-aiu">Compensar vacaciones en dinero exige acuerdo con el empleado y, mientras el contrato esté vigente, normalmente es hasta la mitad de las de un año (CST art. 189). El resto se disfruta.</p>`,
      guardar: {
        texto: 'Crear y calcular',
        fn: async () => {
          irADetalle(await api('/nomina/prestaciones/vacaciones', { method: 'POST', body: JSON.stringify({ empleadoId: v('pv-empleado'), dias: num('pv-dias'), fechaPago: v('pv-fecha') }) }));
        },
      },
    });
    const info = () => {
      const f = resumen.filas.find((x) => x.empleadoId === v('pv-empleado'));
      $('pv-info').textContent = f
        ? `Saldo de ${f.nombre}: ${dias2(f.saldo)} días hábiles (≈ ${dinero(f.valorSaldo)}; ${dinero(f.valorDia)} por día). Provisión en libros: ${dinero(f.provision)}.`
        : 'Este empleado no tiene un contrato vigente.';
    };
    $('pv-empleado').onchange = info;
    info();
  }

  const FILAS_FORM = 3;
  function camposLiquidacion(e) {
    const o = nom.opciones;
    const otros = (e && e.otrosDevengos) || [];
    const desc = (e && e.descuentos) || [];
    let h = `<div class="fila-campos">${campo('Causa del retiro', `<select id="lq-causa">${o.causasRetiro.map((c) => `<option value="${c.codigo}"${e && e.causa === c.codigo ? ' selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>`)}
      ${campo('Días de indemnización (déjalo vacío para calcularlos)', `<input type="number" id="lq-ind" min="0" step="0.5" value="${e && e.indemnizacionDias != null ? e.indemnizacionDias : ''}">`)}</div>
      <h4>Otros pagos (opcional)</h4>`;
    for (let i = 0; i < FILAS_FORM; i++) {
      const x = otros[i] || {};
      h += `<div class="fila-campos">${campo('Descripción', `<input type="text" id="lq-o${i}-desc" maxlength="100" value="${esc(x.descripcion || '')}" placeholder="Ej.: bonificación pactada">`)}
        ${campo('Valor', `<input type="number" id="lq-o${i}-val" min="0" step="1" value="${x.valor || ''}">`)}</div>`;
    }
    h += '<h4>Descuentos (opcional)</h4>';
    for (let i = 0; i < FILAS_FORM; i++) {
      const x = desc[i] || {};
      h += `<div class="fila-campos">${campo('Tipo', `<select id="lq-d${i}-cod">${o.descuentos.map((c) => `<option value="${c.codigo}"${x.codigo === c.codigo ? ' selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>`)}
        ${campo('Descripción', `<input type="text" id="lq-d${i}-desc" maxlength="100" value="${esc(x.descripcion || '')}">`)}
        ${campo('Valor', `<input type="number" id="lq-d${i}-val" min="0" step="1" value="${x.valor || ''}">`)}</div>`;
    }
    return h;
  }

  function leerLiquidacion() {
    const otros = [];
    const descuentos = [];
    for (let i = 0; i < FILAS_FORM; i++) {
      if (v(`lq-o${i}-val`)) otros.push({ descripcion: v(`lq-o${i}-desc`), valor: num(`lq-o${i}-val`) });
      if (v(`lq-d${i}-val`)) descuentos.push({ codigo: v(`lq-d${i}-cod`), descripcion: v(`lq-d${i}-desc`), valor: num(`lq-d${i}-val`) });
    }
    return { causa: v('lq-causa'), indemnizacionDias: v('lq-ind') === '' ? null : num('lq-ind'), otrosDevengos: otros, descuentos };
  }

  async function dialogoLiquidacion() {
    let contratos;
    try { contratos = await api('/nomina/contratos'); } catch (e) { return mostrarError(e); }
    if (!contratos.length) return alert('Primero crea un contrato.');
    const orden = contratos.slice().sort((a, b) => (a.fechaTerminacion ? 1 : 0) - (b.fechaTerminacion ? 1 : 0));
    abrirDialogo({
      titulo: 'Liquidación final de un contrato',
      ancho: true,
      cuerpo: `<div class="fila-campos">${campo('Contrato', `<select id="lq-contrato">${orden.map((c) => `<option value="${c.id}">${esc(c.empleado ? c.empleado.nombre : '—')} · ingreso ${esc(formatoFecha(c.fechaIngreso))}${c.fechaTerminacion ? ' · terminado ' + esc(formatoFecha(c.fechaTerminacion)) : ''}</option>`).join('')}</select>`)}
        ${campo('Fecha de retiro (último día trabajado)', '<input type="date" id="lq-retiro">')}</div>
        ${camposLiquidacion(null)}
        <p class="nota-aiu">Se liquidan prima, cesantías, intereses y vacaciones pendientes, más la indemnización si fue despido sin justa causa. El sueldo de los días del mes de retiro va en la nómina de ese mes. Al pagar la liquidación queda registrada la terminación del contrato.</p>`,
      guardar: {
        texto: 'Crear y calcular',
        fn: async () => {
          const cuerpo = Object.assign({ contratoId: v('lq-contrato'), fechaRetiro: v('lq-retiro') }, leerLiquidacion());
          irADetalle(await api('/nomina/prestaciones/liquidacion', { method: 'POST', body: JSON.stringify(cuerpo) }));
        },
      },
    });
    const ajustar = () => {
      const c = contratos.find((x) => x.id === v('lq-contrato'));
      const f = $('lq-retiro');
      f.value = c && c.fechaTerminacion ? c.fechaTerminacion : f.value;
      f.disabled = !!(c && c.fechaTerminacion);
    };
    $('lq-contrato').onchange = ajustar;
    ajustar();
  }

  function dialogoEditar() {
    const d = pre.detalle;
    const p = d.prestacion;
    const l = d.lineas[0];
    if (!l) return;
    if (p.tipo === 'vacaciones') {
      return abrirDialogo({
        titulo: 'Cambiar los días de vacaciones',
        cuerpo: campo('Días hábiles a pagar', `<input type="number" id="pv-dias" min="0.5" max="90" step="0.5" value="${l.entrada ? l.entrada.dias : ''}">`),
        guardar: { texto: 'Recalcular', fn: async () => irADetalle(await api(`/nomina/prestaciones/${p.id}/recalcular`, { method: 'POST', body: JSON.stringify({ dias: num('pv-dias') }) })) },
      });
    }
    abrirDialogo({
      titulo: `Liquidación de ${l.nombre}`,
      ancho: true,
      cuerpo: `<p>Fecha de retiro: <strong>${esc(fecha(l.entrada ? l.entrada.fechaRetiro : p.fechaCorte))}</strong></p>${camposLiquidacion(l.entrada)}`,
      guardar: { texto: 'Recalcular', fn: async () => irADetalle(await api(`/nomina/prestaciones/${p.id}/recalcular`, { method: 'POST', body: JSON.stringify(leerLiquidacion()) })) },
    });
  }

  function dialogoPagar() {
    const p = pre.detalle.prestacion;
    const bancos = nom.opciones.cuentasBancarias;
    const sugerida = p.tipo === 'liquidacion' && p.fechaCorte > nom.opciones.hoy ? p.fechaCorte : nom.opciones.hoy;
    abrirDialogo({
      titulo: `Registrar el pago: ${pre.detalle.nombreTipo.toLowerCase()}`,
      cuerpo: `<p>Se paga el neto de cada empleado: <strong>${dinero(p.totalNeto)}</strong>.${p.tipo === 'cesantias' ? ' Las cesantías se consignan al fondo de cada empleado; el valor sale en un solo egreso.' : ''}</p>
        <div class="fila-campos">
          ${campo('Desde', `<select id="pg-medio">${bancos.map((b) => `<option value="${b.id}">${esc(b.banco)} ${esc(b.tipoCuenta || '')} ****${esc(b.numero)}</option>`).join('')}<option value="caja">Efectivo (caja)</option></select>`)}
          ${campo('Fecha del pago', `<input type="date" id="pg-fecha" value="${sugerida}">`)}</div>
        <p class="nota-aiu">Se recalcula con la fecha del pago (cambian la retención y la provisión disponible). Queda un egreso en la cuenta bancaria, pendiente de conciliar con el extracto.${p.tipo === 'intereses' ? ' Recuerda: pagados después del 31 de enero, los intereses se pagan dobles.' : ''}${p.tipo === 'liquidacion' ? ' Al pagar, el contrato queda terminado en la fecha de retiro.' : ''}</p>`,
      guardar: {
        texto: 'Registrar pago',
        fn: async () => {
          const medio = v('pg-medio');
          const cuerpo = { fecha: v('pg-fecha') };
          if (medio === 'caja') cuerpo.medio = 'caja';
          else cuerpo.cuentaBancariaId = medio;
          irADetalle(await api(`/nomina/prestaciones/${p.id}/pagar`, { method: 'POST', body: JSON.stringify(cuerpo) }));
          await cargarOpcionesSilencioso();
        },
      },
    });
  }

  function dialogoAnular() {
    const p = pre.detalle.prestacion;
    abrirDialogo({
      titulo: 'Anular el pago',
      cuerpo: `<p>Se anulan el asiento y el egreso del banco.${p.tipo === 'liquidacion' ? ' El contrato vuelve a su estado anterior.' : ''} El documento queda anulado y se puede crear de nuevo.</p>
        ${campo('Motivo (queda en la auditoría)', '<input type="text" id="an-motivo" maxlength="250" autocomplete="off">')}`,
      guardar: {
        texto: 'Anular',
        fn: async () => {
          irADetalle(await api(`/nomina/prestaciones/${p.id}/anular`, { method: 'POST', body: JSON.stringify({ motivo: v('an-motivo') }) }));
          await cargarOpcionesSilencioso();
        },
      },
    });
  }

  async function cargarOpcionesSilencioso() {
    try { nom.opciones = await api('/nomina/opciones'); } catch (e) { /* no pasa nada */ }
  }

  // ===================================================================================
  // VACACIONES
  // ===================================================================================
  async function mostrarVacaciones() {
    if (!pre.vacCorte) pre.vacCorte = nom.opciones.hoy;
    pre.vac = await api(`/nomina/vacaciones?corte=${encodeURIComponent(pre.vacCorte)}`);
    const r = pre.vac;
    let html = `<div class="nom-barra"><p class="nota-panel">Cada empleado causa 15 días hábiles de vacaciones por año de servicio. Aquí ves cuántos lleva causados, cuántos ha disfrutado o cobrado, el saldo y lo que vale. Las vacaciones que se disfrutan se registran como ausencia en “Novedades”; las que se pagan en dinero, en “Prestaciones”.</p>
      <label class="campo-etiquetado nom-anio"><span>Saldo al</span><input type="date" id="vac-corte" value="${esc(r.corte)}"></label></div>`;
    if (!r.filas.length) html += '<p class="vacio">No hay contratos vigentes en esa fecha.</p>';
    else {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Empleado</th><th>Ingreso</th><th class="num">Causados</th><th class="num">Antes del sistema</th><th class="num">Disfrutados</th><th class="num">Pagados</th><th class="num">Saldo (días)</th><th class="num">Valor del saldo</th><th class="num">Provisión en libros</th><th></th></tr></thead><tbody>
      ${r.filas.map((f) => `<tr><td><strong>${esc(f.nombre)}</strong><br><span class="texto-suave">${esc(f.cargo)}</span></td><td>${esc(fecha(f.fechaIngreso))}</td>
        <td class="num">${dias2(f.causados)}</td><td class="num">${dias2(f.previos)}</td><td class="num">${dias2(f.tomados)}</td><td class="num">${dias2(f.compensados)}</td>
        <td class="num"><strong>${dias2(f.saldo)}</strong></td><td class="num">${dinero(f.valorSaldo)}</td><td class="num">${dinero(f.provision)}</td>
        <td class="acciones">${puedeEditar() && f.saldo > 0 ? boton('Pagar en dinero', 'vacacion-empleado', { empleado: f.empleadoId }) : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="7"><strong>Total</strong></td><td class="num"><strong>${dinero(r.totales.valorSaldo)}</strong></td><td class="num"><strong>${dinero(r.totales.provision)}</strong></td><td></td></tr></tfoot></table></div>
      <p class="nota-aiu">${esc(r.nota)} Semana laboral: ${r.semanaLaboral} días (se cambia en Configuración). Si el valor del saldo y la provisión se distancian mucho, revisa los “días ya tomados antes de usar el sistema” del contrato.</p>`;
    }
    U.contenido().innerHTML = html;
    $('vac-corte').onchange = () => { pre.vacCorte = v('vac-corte') || nom.opciones.hoy; mostrarVacaciones().catch((e) => { U.contenido().innerHTML = aviso('bloqueo', esc(e.message)); }); };
  }

  // ===================================================================================
  // Eventos
  // ===================================================================================
  async function accion(ruta, cuerpo) {
    try {
      pre.detalle = await api(`/nomina/prestaciones/${pre.detalle.prestacion.id}/${ruta}`, { method: 'POST', body: JSON.stringify(cuerpo || {}) });
      renderDetalle();
    } catch (err) {
      mostrarError(err);
    }
  }

  $('panel-nomina').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-nom]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.nom) {
      case 'nuevo-lote': return dialogoLote(b.dataset.tipo);
      case 'nueva-vacacion': return dialogoVacaciones();
      case 'vacacion-empleado': return dialogoVacaciones(b.dataset.empleado);
      case 'nueva-liquidacion': return dialogoLiquidacion();
      case 'abrir':
        try { pre.detalle = await api(`/nomina/prestaciones/${id}`); renderDetalle(); } catch (err) { mostrarError(err); }
        return;
      case 'volver':
        pre.detalle = null;
        return U.mostrarSub('prestaciones');
      case 'ver-calculo': return verCalculo(b.dataset.linea);
      case 'comprobante': {
        const w = window.open(`/contable/comprobante-prestaciones.html?id=${encodeURIComponent(pre.detalle.prestacion.id)}&empleado=${encodeURIComponent(b.dataset.empleado)}`, '_blank');
        if (!w) alert('El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.');
        return;
      }
      case 'pre-recalcular': return accion('recalcular', {});
      case 'editar': return dialogoEditar();
      case 'pre-pagar': return dialogoPagar();
      case 'anular': return dialogoAnular();
      case 'eliminar':
        if (confirm('¿Eliminar este borrador?')) {
          try { await api(`/nomina/prestaciones/${pre.detalle.prestacion.id}`, { method: 'DELETE' }); pre.detalle = null; U.mostrarSub('prestaciones'); } catch (err) { mostrarError(err); }
        }
    }
  });

  U.registrarSub('prestaciones', 'Prestaciones y liquidación', mostrarPrestaciones);
  U.registrarSub('vacaciones', 'Vacaciones', mostrarVacaciones);
})();
