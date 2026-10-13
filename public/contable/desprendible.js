// Desprendible de pago de nómina (página imprimible). Lee el detalle de la
// liquidación desde la API con la sesión del navegador.
(function () {
  const params = new URLSearchParams(window.location.search);
  const periodoId = params.get('periodo');
  const empleadoId = params.get('empleado');
  const token = localStorage.getItem('token');
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = (v) => Number(v || 0).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const fecha = (v) => {
    if (!v) return '—';
    const [a, m, d] = String(v).slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  };
  const fila = (x) => `<tr><td>${esc(x.descripcion)}${x.dias ? ` (${x.dias} días)` : ''}${x.detalle ? ` · ${esc(x.detalle)}` : ''}</td><td class="n">${dinero(x.valor)}</td></tr>`;

  function pintar(d) {
    const L = d.resultado;
    const cont = document.getElementById('contenido');
    cont.innerHTML = `
      <h1>${esc(d.empresa ? d.empresa.razonSocial : '')}</h1><div>NIT ${esc(d.empresa ? d.empresa.nit : '')}</div>
      <h2>Desprendible de pago de nómina · ${esc(MESES[d.periodo.mes - 1])} de ${esc(d.periodo.anio)}</h2>
      <div class="cab"><div><b>Empleado:</b> ${esc(d.empleado ? d.empleado.nombre : '')}</div><div><b>Cédula:</b> ${esc(d.empleado ? d.empleado.identificacion : '')}</div>
      <div><b>Cargo:</b> ${esc(d.contrato ? d.contrato.cargo || '' : '')}</div><div><b>Salario básico:</b> ${dinero(d.contrato ? d.contrato.salarioBase : 0)}</div>
      <div><b>Período:</b> ${esc(fecha(d.periodo.fechaInicio))} a ${esc(fecha(d.periodo.fechaFin))}</div><div><b>Días trabajados:</b> ${esc(L.dias.trabajados)}</div></div>
      <h2>Devengado</h2><table>${L.devengos.map(fila).join('')}<tr class="tot"><td>Total devengado</td><td class="n">${dinero(L.totales.devengado)}</td></tr></table>
      <h2>Deducciones</h2><table>${L.deducciones.map(fila).join('') || '<tr><td>Sin deducciones</td><td></td></tr>'}<tr class="tot"><td>Total deducciones</td><td class="n">${dinero(L.totales.deducciones)}</td></tr></table>
      <h2>Neto a pagar</h2><table><tr class="tot"><td>Neto a pagar</td><td class="n">${dinero(L.totales.neto)}</td></tr></table>
      <div class="firma"><div>Firma del empleador</div><div>Firma del empleado</div></div>`;
  }

  async function cargar() {
    const cont = document.getElementById('contenido');
    try {
      if (!token || !periodoId || !empleadoId) throw new Error('Falta la sesión o el empleado. Abre el desprendible desde Nómina.');
      const res = await fetch(`/api/nomina/periodos/${encodeURIComponent(periodoId)}/empleados/${encodeURIComponent(empleadoId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || 'No se pudo cargar el desprendible.');
      pintar(d);
    } catch (err) {
      cont.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  document.getElementById('btn-imprimir').addEventListener('click', () => window.print());
  cargar();
})();
