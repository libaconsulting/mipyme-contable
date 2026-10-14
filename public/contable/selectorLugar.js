// Selector de departamento y municipio con búsqueda por nombre (sin tildes ni mayúsculas).
// Muestra el nombre y guarda solo el código DANE (departamento: 2 dígitos; municipio: 3 dígitos).
// Usa la lista oficial DIVIPOLA (divipola.js).
//
//   SelectorLugar.html('cf', { depto: '11', mpio: '001', deshabilitado: false })  -> HTML de los dos campos
//   SelectorLugar.montar('cf')                                                    -> conecta los eventos
//   SelectorLugar.leer('cf')                                                      -> { depto, mpio, error }
(function () {
  'use strict';

  const D = window.DIVIPOLA;
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (id) => document.getElementById(id);

  function campoHtml(base, tipo, etiqueta, valor, nombre, deshabilitado, ayuda) {
    const id = `${base}-${tipo}`;
    return `<div class="campo-etiquetado combo-campo">
      <span id="${id}-etq">${esc(etiqueta)}</span>
      <div class="combo" id="${id}-combo">
        <input type="text" id="${id}-txt" class="combo-entrada" autocomplete="off" spellcheck="false" role="combobox"
          aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-lista" aria-labelledby="${id}-etq"
          value="${esc(nombre)}" placeholder="${esc(ayuda)}"${deshabilitado ? ' disabled' : ''}>
        <ul class="combo-lista" id="${id}-lista" role="listbox" hidden></ul>
        <input type="hidden" id="${id}" value="${esc(valor)}">
      </div>
      <small class="combo-codigo" id="${id}-cod">${valor ? 'Código DANE: <strong>' + esc(valor) + '</strong>' : ''}</small>
    </div>`;
  }

  function html(base, opciones) {
    const o = opciones || {};
    let depto = String(o.depto || '');
    let mpio = String(o.mpio || '');
    if (!D.nombreDepartamento(depto)) { depto = ''; mpio = ''; }
    if (!D.nombreMunicipio(depto, mpio)) mpio = '';
    return campoHtml(base, 'depto', 'Departamento', depto, D.nombreDepartamento(depto), !!o.deshabilitado, 'Escribe para buscar…')
      + campoHtml(base, 'mpio', 'Municipio', mpio, D.nombreMunicipio(depto, mpio), !!o.deshabilitado || !depto, depto ? 'Escribe para buscar…' : 'Primero elige el departamento');
  }

  function montar(base) {
    const deptoTxt = el(`${base}-depto-txt`);
    const mpioTxt = el(`${base}-mpio-txt`);
    if (!deptoTxt || !mpioTxt) return;
    const bloqueado = deptoTxt.disabled;

    function opcionesDe(tipo) {
      if (tipo === 'depto') return D.departamentos();
      return D.municipiosDe(el(`${base}-depto`).value);
    }
    function nombreDe(tipo, codigo) {
      return tipo === 'depto' ? D.nombreDepartamento(codigo) : D.nombreMunicipio(el(`${base}-depto`).value, codigo);
    }

    function pintarCodigo(tipo) {
      const cod = el(`${base}-${tipo}`).value;
      el(`${base}-${tipo}-cod`).innerHTML = cod ? 'Código DANE: <strong>' + esc(cod) + '</strong>' : '';
    }

    function marcar(tipo, invalido) {
      el(`${base}-${tipo}-txt`).classList.toggle('combo-invalido', !!invalido);
    }

    const estado = { depto: { activo: -1, items: [] }, mpio: { activo: -1, items: [] } };

    function cerrar(tipo) {
      const lista = el(`${base}-${tipo}-lista`);
      lista.hidden = true;
      el(`${base}-${tipo}-txt`).setAttribute('aria-expanded', 'false');
      estado[tipo].activo = -1;
    }

    function abrir(tipo, todo) {
      const txt = el(`${base}-${tipo}-txt`);
      const lista = el(`${base}-${tipo}-lista`);
      const q = todo ? '' : D.sinTildes(txt.value);
      const items = opcionesDe(tipo).filter((i) => !q || D.sinTildes(i.nombre).includes(q) || i.codigo.startsWith(q));
      // Primero el nombre exacto, luego los que empiezan por lo escrito.
      const rango = (i) => { const n = D.sinTildes(i.nombre); return n === q ? 0 : (n.startsWith(q) ? 1 : 2); };
      items.sort((a, b) => rango(a) - rango(b));
      estado[tipo].items = items;
      estado[tipo].activo = items.length && q ? 0 : -1; // con algo escrito, Enter toma la primera opción
      lista.innerHTML = estado[tipo].items.length
        ? estado[tipo].items.map((i, n) => `<li role="option" id="${base}-${tipo}-op${n}" data-i="${n}" class="${n === estado[tipo].activo ? 'activo' : ''}">${esc(i.nombre)} <small>${esc(i.codigo)}</small></li>`).join('')
        : '<li class="combo-mas" aria-disabled="true">Sin resultados</li>';
      lista.hidden = false;
      txt.setAttribute('aria-expanded', 'true');
    }

    function elegir(tipo, item) {
      const txt = el(`${base}-${tipo}-txt`);
      const cod = el(`${base}-${tipo}`);
      const cambio = cod.value !== item.codigo;
      cod.value = item.codigo;
      txt.value = item.nombre;
      marcar(tipo, false);
      pintarCodigo(tipo);
      cerrar(tipo);
      if (tipo === 'depto' && cambio) {
        el(`${base}-mpio`).value = '';
        mpioTxt.value = '';
        mpioTxt.disabled = bloqueado;
        mpioTxt.placeholder = 'Escribe para buscar…';
        marcar('mpio', false);
        pintarCodigo('mpio');
      }
    }

    function limpiar(tipo) {
      el(`${base}-${tipo}`).value = '';
      pintarCodigo(tipo);
      if (tipo === 'depto') {
        el(`${base}-mpio`).value = '';
        mpioTxt.value = '';
        mpioTxt.disabled = true;
        mpioTxt.placeholder = 'Primero elige el departamento';
        marcar('mpio', false);
        pintarCodigo('mpio');
      }
    }

    // Al salir del campo: si lo escrito coincide con una opción, se elige; si está vacío, se borra; si no, se marca.
    function resolver(tipo) {
      const txt = el(`${base}-${tipo}-txt`);
      const t = txt.value.trim();
      if (!t) { limpiar(tipo); marcar(tipo, false); return; }
      const hallado = tipo === 'depto' ? D.resolverDepartamento(t) : D.resolverMunicipio(el(`${base}-depto`).value, t);
      if (hallado) { if (el(`${base}-${tipo}`).value !== hallado.codigo || txt.value !== hallado.nombre) elegir(tipo, hallado); marcar(tipo, false); return; }
      // Si hay una sola opción que contenga lo escrito, se toma esa.
      const q = D.sinTildes(t);
      const parecidos = opcionesDe(tipo).filter((i) => D.sinTildes(i.nombre).includes(q));
      if (parecidos.length === 1) { elegir(tipo, parecidos[0]); return; }
      el(`${base}-${tipo}`).value = '';
      pintarCodigo(tipo);
      marcar(tipo, true);
    }

    ['depto', 'mpio'].forEach((tipo) => {
      const txt = el(`${base}-${tipo}-txt`);
      const lista = el(`${base}-${tipo}-lista`);
      txt.addEventListener('focus', () => { if (!txt.disabled) { txt.select(); abrir(tipo, true); } });
      txt.addEventListener('click', () => { if (!txt.disabled && lista.hidden) abrir(tipo, true); });
      txt.addEventListener('input', () => {
        marcar(tipo, false);
        if (el(`${base}-${tipo}`).value) {
          // Escribir encima de una opción elegida la quita (el departamento arrastra al municipio).
          el(`${base}-${tipo}`).value = '';
          pintarCodigo(tipo);
          if (tipo === 'depto') { el(`${base}-mpio`).value = ''; mpioTxt.value = ''; mpioTxt.disabled = true; mpioTxt.placeholder = 'Primero elige el departamento'; pintarCodigo('mpio'); }
        }
        abrir(tipo, false);
      });
      txt.addEventListener('keydown', (ev) => {
        const est = estado[tipo];
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          if (lista.hidden) abrir(tipo, !txt.value);
          if (!est.items.length) return;
          est.activo = ev.key === 'ArrowDown' ? (est.activo + 1) % est.items.length : (est.activo <= 0 ? est.items.length - 1 : est.activo - 1);
          lista.querySelectorAll('li[data-i]').forEach((li) => li.classList.toggle('activo', Number(li.dataset.i) === est.activo));
          const li = el(`${base}-${tipo}-op${est.activo}`);
          if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
          txt.setAttribute('aria-activedescendant', `${base}-${tipo}-op${est.activo}`);
        } else if (ev.key === 'Enter') {
          if (!lista.hidden && est.activo >= 0 && est.items[est.activo]) { ev.preventDefault(); elegir(tipo, est.items[est.activo]); }
          else if (!lista.hidden && est.items.length === 1) { ev.preventDefault(); elegir(tipo, est.items[0]); }
        } else if (ev.key === 'Escape') {
          if (!lista.hidden) { ev.preventDefault(); ev.stopPropagation(); cerrar(tipo); }
        }
      });
      // mousedown (y no click) para elegir antes de que el campo pierda el foco.
      lista.addEventListener('mousedown', (ev) => {
        const li = ev.target.closest('li[data-i]');
        ev.preventDefault();
        if (li) elegir(tipo, estado[tipo].items[Number(li.dataset.i)]);
      });
      txt.addEventListener('blur', () => { cerrar(tipo); resolver(tipo); });
    });
  }

  // Valores para guardar. error = mensaje si hay algo escrito que no es una opción, o si falta el municipio.
  function leer(base) {
    const dTxt = el(`${base}-depto-txt`);
    const mTxt = el(`${base}-mpio-txt`);
    const depto = el(`${base}-depto`) ? el(`${base}-depto`).value : '';
    const mpio = el(`${base}-mpio`) ? el(`${base}-mpio`).value : '';
    let error = '';
    if (dTxt && dTxt.value.trim() && !depto) error = 'Elige el departamento de la lista (escribe unas letras y selecciónalo).';
    else if (mTxt && mTxt.value.trim() && !mpio) error = 'Elige el municipio de la lista (escribe unas letras y selecciónalo).';
    else if (depto && !mpio) error = 'Elige también el municipio.';
    return { depto, mpio, error };
  }

  window.SelectorLugar = { html, montar, leer };
})();
