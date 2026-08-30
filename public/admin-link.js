'use strict';

// Link "Admin" del navbar — abre el dashboard de brumexa-admin-v2. A
// diferencia del resto del navbar (rutas fijas DENTRO de esta misma app),
// dónde vive el admin cambia según el momento: a veces corriendo local en
// desarrollo (http://localhost:4200), a veces ya deployado en
// https://brumexaadmin.vercel.app/dashboard — no hay forma de saber cuál
// corresponde desde acá. En vez de asumir una sola URL fija, este botón
// SIEMPRE pregunta con un diálogo chico (nunca navega directo, pedido
// explícito), con las dos URLs conocidas editables inline — si el puerto
// local o el dominio de Vercel cambian algún día, se corrige ahí mismo y
// queda guardado en localStorage para la próxima vez.
(function () {
  const STORAGE_KEY = 'brumexa-admin-urls';
  const DEFAULTS = [
    { label: 'Local (desarrollo)', url: 'http://localhost:4200' },
    { label: 'Hosteado (Vercel)',  url: 'https://brumexaadmin.vercel.app/dashboard' },
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function loadUrls() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      // Mismo largo/orden que DEFAULTS — si algún día se agrega/saca una
      // instancia acá arriba, un localStorage viejo con menos/más filas no
      // rompe el render, se descarta y arranca de los defaults de nuevo.
      if (Array.isArray(saved) && saved.length === DEFAULTS.length) return saved;
    } catch (e) { /* localStorage corrupto o inaccesible — usar defaults */ }
    return DEFAULTS.map(d => ({ ...d }));
  }

  function saveUrls(urls) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(urls)); } catch (e) { /* noop */ }
  }

  let dialogEl = null;

  function buildDialog() {
    const dlg = document.createElement('dialog');
    dlg.id = 'admin-link-dialog';
    dlg.className = 'app-dialog';
    dlg.innerHTML = `
      <div class="app-dialog__hdr">
        <div class="app-dialog__title">Abrir Admin</div>
        <button class="app-dialog__close" type="button" aria-label="Cerrar">✕</button>
      </div>
      <div class="app-dialog__body">
        <p class="field-hint" style="margin-bottom:12px">¿A qué instancia del panel de administración querés ir? Podés editar la URL si cambió.</p>
        <div id="admin-link-rows"></div>
      </div>
    `;
    document.body.appendChild(dlg);
    dlg.querySelector('.app-dialog__close').addEventListener('click', () => dlg.close());
    // Cerrar clickeando el backdrop nativo del <dialog> (afuera del cuadro) —
    // un click DENTRO del cuadro nunca llega acá porque los inputs/botones
    // adentro paran la propagación al no ser el propio dlg el target.
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    return dlg;
  }

  function renderRows(dlg) {
    const urls = loadUrls();
    const wrap = dlg.querySelector('#admin-link-rows');
    wrap.innerHTML = urls.map((u, i) => `
      <div class="admin-link-row">
        <label class="field-label">${esc(u.label)}</label>
        <div class="admin-link-row__inputs">
          <input type="text" class="setup-input" data-idx="${i}" value="${esc(u.url)}" spellcheck="false" autocomplete="off" />
          <button class="btn-connect" data-idx="${i}" type="button" style="flex:none; padding:8px 16px">Ir →</button>
        </div>
      </div>
    `).join('');

    wrap.querySelectorAll('input').forEach((inp) => {
      // Guarda la edición apenas se sale del campo — no hace falta un botón
      // "Guardar" aparte, "Ir →" ya guarda también por si se editó y se usó
      // sin perder foco (ej. autocompletado del navegador).
      inp.addEventListener('change', () => {
        const list = loadUrls();
        list[Number(inp.dataset.idx)].url = inp.value.trim();
        saveUrls(list);
      });
    });
    wrap.querySelectorAll('button[data-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const inp = wrap.querySelector(`input[data-idx="${idx}"]`);
        const url = (inp.value || '').trim();
        if (!url) { inp.focus(); return; }
        const list = loadUrls();
        list[idx].url = url;
        saveUrls(list);
        dlg.close();
        window.open(url, '_blank', 'noopener');
      });
    });
  }

  function openDialog() {
    if (!dialogEl) dialogEl = buildDialog();
    renderRows(dialogEl);
    if (typeof dialogEl.showModal === 'function') dialogEl.showModal();
  }

  function init() {
    const link = document.getElementById('nav-admin');
    if (!link) return;
    link.addEventListener('click', (e) => {
      e.preventDefault(); // nunca navega directo — ver comentario grande arriba
      openDialog();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
