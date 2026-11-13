// Nómina · Cargues masivos para Asopagos.
//
// Se carga DESPUÉS de nomina.js, que le presta sus ayudas por window.nominaUI.
// Genera los archivos que recibe Asopagos: cargue de cotizantes (empleados o contratistas de la planilla Y)
// y cargue de novedades del mes (ING, RET y ausencias). Los arma el servidor (asopagos.service.js).
(function () {
  const U = window.nominaUI;
  if (!U) return;
  const { nom, $, esc, v, campo, opcionesSelect, boton, aviso, mostrarError, contenido, MESES } = U;

  const aso = { anio: null, mes: null, resultados: {} };
  const TIPOS = {
    'cot-empleados': { titulo: 'Cotizantes: empleados', ruta: 'cotizantes?tipo=empleados', mime: 'text/csv;charset=utf-8',
      ayuda: 'Los empleados con contrato vigente en el mes (cotizante 1). Súbelo una sola vez por empleado: Asopagos no duplica a los que ya están.' },
    'cot-contratistas': { titulo: 'Cotizantes: contratistas (planilla Y)', ruta: 'cotizantes?tipo=contratistas', mime: 'text/csv;charset=utf-8',
      ayuda: 'Los contratistas con acuerdo de pago de aportes (cotizante 59), con el IBC del 40 % de un mes completo.' },
    novedades: { titulo: 'Novedades del mes', ruta: 'novedades', mime: 'text/plain;charset=utf-8',
      ayuda: 'Ingresos y retiros del mes, vacaciones, incapacidades y licencias de los empleados, e ingreso y retiro de los contratistas.' },
  };

  function periodo() {
    if (aso.anio) return;
    const hoy = (nom.opciones && nom.opciones.hoy) || new Date().toISOString().slice(0, 10);
    aso.anio = Number(hoy.slice(0, 4));
    aso.mes = Number(hoy.slice(5, 7));
  }

  async function mostrarAsopagos() {
    periodo();
    const anios = [aso.anio - 1, aso.anio, aso.anio + 1];
    contenido().innerHTML = `
      <div class="fx-titulo-con-accion"><h3>Cargues masivos para Asopagos</h3></div>
      <p class="nota-aiu">Genera con los datos de la app los archivos de cargue masivo de Asopagos, para no digitar a mano a cada cotizante. Elige el mes que vas a reportar, genera el archivo, revisa los avisos y descárgalo.</p>
      <div class="fila-campos">
        ${campo('Mes', `<select id="as-mes">${opcionesSelect(MESES.map((m, i) => [i + 1, m]), aso.mes)}</select>`)}
        ${campo('Año', `<select id="as-anio">${opcionesSelect(anios.map((a) => [a, a]), aso.anio)}</select>`)}
      </div>
      <div id="as-tarjetas">${Object.keys(TIPOS).map(tarjeta).join('')}</div>
      <details class="nom-detalles"><summary>Cómo cargarlos en Asopagos</summary>
        <ol class="nom-lista">
          <li><strong>Cotizantes:</strong> abre el CSV en Excel, copia las filas y pégalas en la hoja <em>cargue_masivo</em> del <em>Modelo_Cargue_Masivo.xls</em> que te da Asopagos (desde la fila 3, bajo los títulos) y súbelo en <em>Datos de liquidación → Empleados</em>. Las columnas van en el mismo orden del modelo. Asopagos inserta a quienes pasan las validaciones y te muestra el error de los demás.</li>
          <li><strong>Novedades:</strong> el archivo de texto tiene una línea por novedad con los campos separados por punto y coma, como el instructivo de cargue masivo de novedades.</li>
          <li>Los códigos de EPS, fondo de pensiones, ARL y caja salen de los códigos que guardaste en cada contrato y en <em>Configuración</em> (por ejemplo EPS005, 230301, 14-11, CCF24). Si en la lista de Asopagos aparecen como <em>EPS005_SANITAS</em>, usa solo lo que va antes del guion bajo.</li>
          <li>La actividad económica de 7 dígitos y el código del centro de trabajo salen del centro de trabajo del contrato (<em>Configuración → Centros de trabajo</em>).</li>
        </ol>
      </details>`;
    Object.keys(TIPOS).forEach(pintar);
  }

  function tarjeta(clave) {
    const t = TIPOS[clave];
    return `<div class="fx-bloque" id="as-${clave}"><h4>${esc(t.titulo)}</h4><p class="nota-aiu">${esc(t.ayuda)}</p>
      <div>${boton('Generar', 'aso-generar', { tipo: clave }, 'btn-primario btn-chico')}</div><div id="as-res-${clave}"></div></div>`;
  }

  function pintar(clave) {
    const caja = $(`as-res-${clave}`);
    const r = aso.resultados[clave];
    if (!caja || !r) return;
    const res = r.resumen;
    const cuantos = clave === 'novedades' ? `${res.novedades} novedad(es)` : `${res.cotizantes} cotizante(s)`;
    let html = `<p><strong>${esc(cuantos)}</strong> para ${esc(MESES[r.mes - 1])} de ${esc(r.anio)}. ${r.contenido ? boton('Descargar ' + esc(r.nombre), 'aso-descargar', { tipo: clave }, 'btn-accion') : ''}</p>`;
    if (res.avisos && res.avisos.length) {
      html += aviso('confirmar', '<strong>Revisa antes de cargar:</strong><ul>' + res.avisos.map((a) => `<li>${esc(a)}</li>`).join('') + '</ul>');
    } else if (r.contenido) html += aviso('info', 'Sin avisos: la app no detectó datos faltantes.');
    if (clave === 'novedades' && res.detalle && res.detalle.length) {
      html += `<div class="tabla-envoltorio"><table><thead><tr><th>Quién</th><th>Novedad</th><th>Línea del archivo</th></tr></thead><tbody>${
        res.detalle.map((d) => `<tr><td>${esc(d.quien)}</td><td>${esc(d.codigo)}</td><td><code>${esc(d.linea)}</code></td></tr>`).join('')}</tbody></table></div>`;
    }
    caja.innerHTML = html;
  }

  async function generar(clave) {
    const t = TIPOS[clave];
    aso.anio = Number(v('as-anio'));
    aso.mes = Number(v('as-mes'));
    const caja = $(`as-res-${clave}`);
    caja.innerHTML = '<p class="vacio">Generando…</p>';
    try {
      const r = await api(`/nomina/asopagos/${t.ruta}${t.ruta.includes('?') ? '&' : '?'}anio=${aso.anio}&mes=${aso.mes}`);
      aso.resultados[clave] = Object.assign(r, { anio: aso.anio, mes: aso.mes });
      pintar(clave);
    } catch (err) {
      caja.innerHTML = '';
      mostrarError(err);
    }
  }

  function descargar(clave) {
    const r = aso.resultados[clave];
    if (!r) return;
    const blob = new Blob([r.contenido], { type: TIPOS[clave].mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('panel-nomina').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nom]');
    if (!b || !String(b.dataset.nom).startsWith('aso-')) return;
    if (b.dataset.nom === 'aso-generar') return generar(b.dataset.tipo);
    if (b.dataset.nom === 'aso-descargar') return descargar(b.dataset.tipo);
  });

  // Al cambiar el mes o el año se descartan los archivos ya generados (eran de otro período).
  $('panel-nomina').addEventListener('change', (e) => {
    if (!e.target || (e.target.id !== 'as-mes' && e.target.id !== 'as-anio')) return;
    aso.anio = Number(v('as-anio'));
    aso.mes = Number(v('as-mes'));
    aso.resultados = {};
    Object.keys(TIPOS).forEach((k) => { const c = $(`as-res-${k}`); if (c) c.innerHTML = ''; });
  });

  U.registrarSub('asopagos', 'Cargues Asopagos', mostrarAsopagos);
})();
