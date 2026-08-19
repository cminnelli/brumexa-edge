'use strict';

// Toggle de modo claro/oscuro — persiste en localStorage y respeta el
// sistema si el usuario nunca lo tocó a mano. La aplicación temprana del
// atributo (antes de este archivo) vive en un <script> inline en el <head>
// de cada página, para no parpadear con el tema equivocado al cargar.
(function () {
  const KEY = 'brumexa-theme';

  function effectiveTheme() {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // SVG en vez de emoji — el 🌙 de emoji rendeaba distinto según SO/fuente
  // (llegó a leerse como una medialuna de panadería en vez de luna).
  const ICON_SUN  = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  const ICON_MOON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>';

  function paintButton(btn) {
    const dark = effectiveTheme() === 'dark';
    btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
    btn.title = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  }

  function init() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    paintButton(btn);
    btn.addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      document.documentElement.setAttribute('data-theme', next);
      paintButton(btn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
