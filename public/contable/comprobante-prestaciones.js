// Comprobante de pago de prestaciones / vacaciones / liquidación final (página imprimible).
(function () {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const empleadoId = params.get('empleado');
  const token = localStorage.getItem('token');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = (v) => Number(v || 0).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const fecha = (v) => {
    if (!v) return '—';
    const [a, m, d] = String(v).slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  };
  const dias = (v) => Number(v || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 });
  const TIPOS_CONTRATO = { indefinido: 'Término indefinido', fijo: 'Término fijo', obra: 'Obra o labor', aprendizaje: 'Aprendizaje' };

  function fila(c) {
    const periodo = c.desde ? ` · del ${esc(fecha(c.desde))} al ${esc(fecha(c.hasta))}` : '';
    const d = c.dias ? ` · ${esc(dias(c.dias))} días` : '';
    const b = c.base ? ` · base ${esc(dinero(c.base))}` : '';
    return `<tr><td>${esc(c.nombre)}${periodo}${d}${b}</td><td class="n">${dinero(c.valor)}</td></tr>`;
  }

  function pintar(d) {
    const p = d.prestacion;
    const l = d.linea;
    const esLiq = p.tipo === 'liquidacion';
    const titulo = p.tipo === 'liquidacion' ? 'Liquidación final del contrato de trabajo'
      : `Comprobante de pago · ${esc(p.nombreTipo || p.tipo)}${p.anio ? ' ' + esc(p.anio) + (p.semestre ? ' · semestre ' + esc(p.semestre) : '') : ''}`;
    const borrador = p.estado !== 'pagada'
      ? `<p class="error"><b>${p.estado === 'anulada' ? 'DOCUMENTO ANULADO' : 'BORRADOR: el pago aún no se ha registrado.'}</b></p>` : '';
    document.getElementById('contenido').innerHTML = `
      <h1>${esc(d.empresa ? d.empresa.razonSocial : '')}</h1><div>NIT ${esc(d.empresa ? d.empresa.nit : '')}</div>
      <h2>${titulo}</h2>${borrador}
      <div class="cab"><div><b>Empleado:</b> ${esc(d.empleado ? d.empleado.nombre : '')}</div><div><b>Cédula:</b> ${esc(d.empleado ? d.empleado.identificacion : '')}</div>
      <div><b>Cargo:</b> ${esc(d.contrato ? d.contrato.cargo || '' : '')}</div><div><b>Contrato:</b> ${esc(d.contrato ? TIPOS_CONTRATO[d.contrato.tipoContrato] || d.contrato.tipoContrato || '' : '')}</div>
      <div><b>Ingreso:</b> ${esc(fecha(d.contrato && d.contrato.fechaIngreso))}</div><div><b>Salario básico:</b> ${dinero(d.contrato ? d.contrato.salarioBase : 0)}</div>
      ${esLiq ? `<div><b>Fecha de retiro:</b> ${esc(fecha(l.fechaRetiro))}</div><div><b>Causa:</b> ${esc(l.causa || '')}</div>` : `<div><b>Fecha de corte:</b> ${esc(fecha(p.fechaCorte))}</div>`}
      <div><b>Fecha de pago:</b> ${esc(fecha(p.fechaPago))}</div></div>
      <h2>Devengado</h2><table>${l.componentes.map(fila).join('')}<tr class="tot"><td>Total devengado</td><td class="n">${dinero(l.devengado)}</td></tr></table>
      <h2>Deducciones</h2><table>
        ${l.retencion ? `<tr><td>Retención en la fuente</td><td class="n">${dinero(l.retencion)}</td></tr>` : ''}
        ${(l.descuentosDetalle || []).map((x) => `<tr><td>${esc(x.descripcion)}</td><td class="n">${dinero(x.valor)}</td></tr>`).join('')}
        ${!l.retencion && !(l.descuentosDetalle || []).length ? '<tr><td>Sin deducciones</td><td></td></tr>' : ''}
        <tr class="tot"><td>Total deducciones</td><td class="n">${dinero((l.retencion || 0) + (l.descuentos || 0))}</td></tr></table>
      <h2>Neto a pagar</h2><table><tr class="tot"><td>Neto a pagar</td><td class="n">${dinero(l.neto)}</td></tr></table>
      ${esLiq ? '<p>Con el pago de esta suma el empleado declara recibir a satisfacción lo que le corresponde por la terminación del contrato, sin perjuicio de lo que la ley permita reclamar.</p>' : ''}
      <div class="firma"><div>Firma del empleador</div><div>Firma del empleado</div></div>`;
  }

  async function cargar() {
    const cont = document.getElementById('contenido');
    try {
      if (!token || !id || !empleadoId) throw new Error('Falta la sesión o el empleado. Abre el comprobante desde Nómina.');
      const res = await fetch(`/api/nomina/prestaciones/${encodeURIComponent(id)}/empleados/${encodeURIComponent(empleadoId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || 'No se pudo cargar el comprobante.');
      pintar(d);
    } catch (err) {
      cont.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  document.getElementById('btn-imprimir').addEventListener('click', () => window.print());
  cargar();
})();
