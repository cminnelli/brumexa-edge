'use strict';

// Navbar compartido — ÚNICA fuente de las pestañas de todas las páginas.
// Antes el mismo bloque de links estaba copiado a mano en cada .html (8
// copias): sumar una pestaña era editar 8 archivos, y con cada página nueva
// el header se llenaba más. Ahora cada página tiene solo
//   <nav class="tab-nav"></nav><script src="/nav.js?v=N"></script>
// y este script lo rellena en el acto (sincrónico, sin parpadeo) — antes de
// que corran admin-link.js / app.js, que buscan #nav-admin / #nav-terminal.
//
// Dos niveles: lo de todos los días (PRIMARY) siempre a la vista; el resto
// (herramientas de diagnóstico y sistema) dentro del menú "Herramientas".
(function () {
  const ICONS = {
    panel:  '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    config: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    diag:   '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    logs:   '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
    api:    '<path d="M8 6 2 12l6 6"/><path d="m16 6 6 6-6 6"/>',
    term:   '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
    local:  '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
    install:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
    admin:  '<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3Z"/>',
    tools:  '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    chevron:'<path d="m6 9 6 6 6-6"/>',
  };

  const PRIMARY = [
    { href: '/',              label: 'Panel',         icon: 'panel' },
    { href: '/configuracion', label: 'Configuración', icon: 'config' },
    { href: '/diagnostico',   label: 'Diagnóstico',   icon: 'diag' },
  ];

  const TOOLS = [
    { group: 'Monitoreo', items: [
      { href: '/logs',      label: 'Logs',      icon: 'logs', desc: 'Lo que pasa en el server, en vivo' },
      { href: '/endpoints', label: 'Endpoints', icon: 'api',  desc: 'Todas las rutas y sus datos crudos' },
    ] },
    { group: 'Sistema', items: [
      { href: '/terminal',    label: 'Terminal Pi', icon: 'term',    id: 'nav-terminal', desc: 'Correr comandos en la Pi' },
      { href: '/local',       label: 'Local',       icon: 'local',   desc: 'Estado del dispositivo' },
      { href: '/instalacion', label: 'Instalación', icon: 'install', desc: 'Puesta en marcha' },
    ] },
    { group: 'Externo', items: [
      { href: '#', label: 'Admin ↗', icon: 'admin', id: 'nav-admin', desc: 'Panel de administración' },
    ] },
  ];

  const nav = document.currentScript && document.currentScript.previousElementSibling;
  if (!nav || !nav.classList.contains('tab-nav')) return;

  const svg = (name) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const isActive = (href) => href !== '#' && (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'));

  const primaryHtml = PRIMARY.map(p =>
    `<a class="tab-btn${isActive(p.href) ? ' active' : ''}" href="${p.href}" title="${p.label}">${svg(p.icon)}<span class="tab-btn__label">${p.label}</span></a>`
  ).join('');

  // Si la página actual vive dentro del menú, el botón toma su nombre y
  // queda marcado como activo — así se sigue viendo dónde estás.
  const activeTool = TOOLS.flatMap(g => g.items).find(i => isActive(i.href));

  const menuHtml = TOOLS.map(g => `
    <div class="nav-menu__group">${g.group}</div>
    ${g.items.map(i => `
      <a class="nav-menu__item${isActive(i.href) ? ' active' : ''}" href="${i.href}"${i.id ? ` id="${i.id}"` : ''} role="menuitem">
        ${svg(i.icon)}
        <span><span class="nav-menu__label">${i.label}</span><span class="nav-menu__desc">${i.desc}</span></span>
      </a>`).join('')}
  `).join('');

  nav.innerHTML = `
    ${primaryHtml}
    <div class="nav-more">
      <button class="tab-btn${activeTool ? ' active' : ''}" type="button" aria-haspopup="true" aria-expanded="false" title="Herramientas">
        ${svg(activeTool ? activeTool.icon : 'tools')}<span class="tab-btn__label">${activeTool ? activeTool.label : 'Herramientas'}</span>${svg('chevron')}
      </button>
      <div class="nav-menu" role="menu" hidden>${menuHtml}</div>
    </div>
  `;

  const btn  = nav.querySelector('.nav-more > button');
  const menu = nav.querySelector('.nav-menu');
  const setOpen = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  // Admin abre un diálogo (admin-link.js), no navega — cerrar el menú igual.
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
})();
