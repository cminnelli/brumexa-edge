'use strict';

// Visor de logs en vivo — un único WebSocket (/ws/logs, ver lib/log-stream.js)
// alimenta DOS paneles: "Servidor" (console.log/warn/error de toda la app) y
// "WiFi" (historial persistente de logs/wifi-debug.log, sobrevive reinicios).
// El server tagea cada entrada con `source` ('server' o 'wifi'); acá solo se
// rutea al panel que corresponda, sin pedir nada aparte.
//
// Dos controles arriba de todo (se recuerdan en localStorage):
//  - Paneles: Servidor / WiFi / Ambos.
//  - Detalle del panel Servidor:
//      "Simple"  — solo lo que importa (hitos + problemas), en castellano
//                  llano, y los avisos repetidos agrupados ("×12").
//      "Técnico" — todo crudo, tal cual lo imprime el server (para depurar).
//    El panel WiFi ya es un log curado, se ve igual en los dos modos.
//
// Antes había un segundo panel con el log de sistema/kernel (dmesg/
// journalctl), sondeado cada 4s. Se sacó a propósito: esos comandos podían
// tardar bastante en la Pi y cada corrida bloqueaba el event loop entero
// (audio, LEDs) mientras esta página estuviera abierta — ver /local/status
// para el resto del diagnóstico de sistema sin ese sondeo repetido.

const MAX_ENTRIES = 500; // tope por panel — no queremos miles de nodos vivos en una sesión larga

// ─── Preferencias (localStorage, mejor esfuerzo) ─────────────────────────────
const PREFS_KEY = 'brumexa-logs-prefs';
const prefs = (() => {
  try { return { panels: 'both', detail: 'simple', ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { panels: 'both', detail: 'simple' }; }
})();
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }

// ─── Vista técnica: clases CSS a partir de lo que ya clasificó el server ─────
// stage/origin/level/event vienen de lib/log-stream.js — mismo criterio que
// el color ANSI de la terminal (pm2 logs).
function technicalClass(entry) {
  if (entry.event) return `ev ev-${entry.event}`;
  // Origen (prefijo "🔧 PI ·" / "☁️ RED ·") + nivel (color) se combinan.
  const origin = entry.origin === 'PI' ? ' origin-pi' : entry.origin === 'RED' ? ' origin-red' : '';
  if (entry.stream === 'stderr' || entry.level === 'error') return 'stderr' + origin;
  if (entry.level === 'warn') return 'lvl-warn' + origin;
  if (entry.stage === 'tx')   return 'hl-tx';
  if (entry.stage === 'rx')   return 'hl-rx';
  if (entry.stage === 'wait') return 'hl-wait';
  if (/Gate (ABIERTO|CERRADO)/.test(entry.text)) return 'hl-gate';
  if (/^(GET|POST|PUT|DELETE) \//.test(entry.text)) return 'dim-req'; // pedidos HTTP: ruido de fondo, atenuados
  return origin.trim();
}

// ─── Vista simple: hitos traducidos a castellano llano ───────────────────────
// Una función por hito (event de lib/log-stream.js): recibe el texto técnico
// y devuelve la frase para humanos. Si un hito nuevo no está acá, se muestra
// su texto técnico tal cual (nunca se pierde).
// Íconos de línea (trazos estilo Lucide, mismo lenguaje que el navbar) —
// reemplazan a los emojis: más sobrios y del color de cada evento.
const ICONS = {
  mic:     '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  micOff:  '<path d="m2 2 20 20"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M12 19v3"/>',
  ban:     '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  wake:    '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  loader:  '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  link:    '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
  bot:     '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  end:     '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  unplug:  '<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
  speaker: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  speakerOff: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  alert:   '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  error:   '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  ear:     '<path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/>',
};
const icon = (name) => `<span class="ico"><svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg></span>`;

// Cada hito → [ícono, texto]. Texto sin emojis (el ícono ya cumple ese rol).
const num = (text, re) => { const m = text.match(re); return m ? m[1] : null; };
const FRIENDLY = {
  'voice-on': (t) => {
    const ms = num(t, /confirmado en (\d+)ms/);
    return ['mic', `Empezaste a hablar${ms ? ` · detectado en ${ms} ms` : ''}${/sobre ruido de fondo/.test(t) ? ' · sobre ruido de fondo' : ''}`];
  },
  'voice-off':    (t) => { const s = num(t, /\(([\d.]+)s\)/); return ['micOff', `Dejaste de hablar${s ? ` · ${s} s` : ''}`]; },
  'voice-reject': ()  => ['ban', 'Ruido descartado — no era voz'],
  'wake': (t) => {
    const score = num(t, /score=([\d.]+)/);
    return ['wake', `Te escuché decir «ei brúmexa»${score ? ` · ${Math.round(parseFloat(score) * 100)}% seguro` : ''}`];
  },
  'session-wait': ()  => ['loader', 'Conectando con el asistente…'],
  'session-up':   (t) => (/Agente/.test(t) ? ['bot', 'El asistente está listo — podés hablarle'] : ['link', 'Conectado a la sala']),
  'session-down': (t) => (/Sesión cerrada/.test(t) ? ['end', 'Conversación terminada'] : ['unplug', 'Se cortó la conexión con el asistente']),
  'agent-on':     ()  => ['speaker', 'El asistente está hablando'],
  'agent-off':    ()  => ['speakerOff', 'El asistente terminó de hablar'],
  'system': (t) => {
    const hash = num(t, /update: listo \((\w+)\)/);
    if (hash) return ['refresh', `Brumexa se actualizó · versión ${hash} · reiniciando`];
    if (/wakeword-gate\] toggle/.test(t)) return ['sliders', `«Ei brúmexa» ${/ACTIVADO/.test(t) ? 'activado' : 'desactivado'}`];
    const mode = num(t, /modo de detección → (\w+)/);
    if (mode) return ['sliders', `Detección de voz: ${mode === 'vad' ? 'Volumen + VAD' : 'solo Volumen'}`];
    return null;
  },
};

// Saca prefijos técnicos ("[event-loop] ") y emojis/símbolos del principio
// de un aviso — en vista Simple el ícono ya indica que es aviso/error.
const stripTags = (t) => t.replace(/^(\[[^\]]+\]\s*)+/, '').replace(/^[^\p{L}\p{N}«(]+/u, '');

// Qué mostrar en vista simple — { icon, text, cls } o null (no se muestra).
function simpleView(entry) {
  if (entry.event) {
    const f = FRIENDLY[entry.event];
    const [ico, text] = (f && f(entry.text)) || ['refresh', entry.text];
    return { icon: ico, text, cls: `ev-${entry.event}` };
  }
  if (entry.stream === 'stderr' || entry.level === 'error') return { icon: 'error', text: stripTags(entry.text), cls: 'stderr' };
  if (entry.level === 'warn') return { icon: 'alert', text: stripTags(entry.text), cls: 'lvl-warn' };
  return null;
}

// Clave para agrupar repetidos en vista simple: mismo texto ignorando números.
const groupKey = (text) => text.replace(/[\d.]+/g, '#');

function fmtTs(ts) {
  const d = new Date(ts);
  const base = d.toLocaleTimeString('es-AR', { hour12: false });
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${base}.${ms}`;
}

// ─── Tarjeta "Ahora" ─────────────────────────────────────────────────────────
// Qué está pasando EN ESTE MOMENTO, armado a partir de los mismos hitos del
// log (entry.event). Dos capas: la "base" (en espera / conectando / en
// conversación) y, encima, quién está hablando ahora (vos / el asistente).
const NOW_STATES = {
  listening:  { icon: 'ear',    title: 'Escuchando',                 sub: 'Decí «ei brúmexa» para hablar con el asistente' },
  connecting: { icon: 'loader', title: 'Conectando…',                sub: 'Llamando al asistente' },
  connected:  { icon: 'bot',    title: 'Conversación activa',        sub: 'El asistente te está escuchando' },
  user:       { icon: 'mic',    title: 'Estás hablando',             sub: '' },
  agent:      { icon: 'speaker', title: 'El asistente está hablando', sub: '' },
  error:      { icon: 'alert',  title: 'Hubo un problema',           sub: '' },
};

const NowCard = (() => {
  const el = document.getElementById('now-server');
  let base = 'listening';  // listening | connecting | connected
  let speaker = null;      // null | 'user' | 'agent'
  let errorText = null;    // último error, se muestra unos segundos
  let errorUntil = 0;
  let since = Date.now();  // desde cuándo está en el estado visible actual
  let shown = null;

  function current() {
    if (errorText && Date.now() < errorUntil) return 'error';
    return speaker || base;
  }

  function render() {
    const state = current();
    if (state !== shown) { shown = state; since = Date.now(); }
    const s = NOW_STATES[state];
    el.dataset.state = state;
    if (el.dataset.icon !== s.icon) { // re-dibujar el SVG solo si cambió
      el.dataset.icon = s.icon;
      el.querySelector('.now__icon .ico').outerHTML = icon(s.icon);
    }
    el.querySelector('.now__title').textContent = s.title;
    el.querySelector('.now__sub').textContent =
      state === 'error' ? errorText
      : state === 'user' ? (base === 'connected' ? 'El asistente te está escuchando' : 'Sin conversación activa — solo se ve en el LED')
      : state === 'agent' ? 'Respondiendo'
      : s.sub;
    const secs = Math.floor((Date.now() - since) / 1000);
    el.querySelector('.now__since').textContent = secs < 60 ? `hace ${secs} s` : `hace ${Math.floor(secs / 60)} min`;
  }

  function feed(entry) {
    switch (entry.event) {
      case 'voice-on':     speaker = 'user'; break;
      case 'voice-off':    if (speaker === 'user') speaker = null; break;
      case 'agent-on':     speaker = 'agent'; break;
      case 'agent-off':    if (speaker === 'agent') speaker = null; break;
      case 'wake':
      case 'session-wait': base = 'connecting'; break;
      case 'session-up':   base = 'connected'; break;
      case 'session-down': base = 'listening'; speaker = null; break;
    }
    if (entry.stream === 'stderr' || entry.level === 'error') {
      errorText = stripTags(entry.text);
      errorUntil = Date.now() + 8000;
    }
    render();
  }

  setInterval(render, 1000); // "hace N s" + vencimiento del error
  render();
  return { feed };
})();

// ─── Panel ───────────────────────────────────────────────────────────────────
// Guarda las entradas crudas (no solo los <div>) para poder re-dibujar todo
// al cambiar de vista Simple ↔ Técnico sin perder historia.
function makePanel(prefix, { hasDetail }) {
  const root   = document.getElementById(`panel-${prefix}`);
  const body   = document.getElementById(`body-${prefix}`);
  const dot    = document.getElementById(`dot-${prefix}`);
  const count  = document.getElementById(`count-${prefix}`);
  const filter = document.getElementById(`filter-${prefix}`);
  const btnClr = document.getElementById(`btn-clear-${prefix}`);

  const btnJump = document.getElementById(`jump-${prefix}`);

  const entries = [];
  let filterText = '';
  let lastEl = null;   // último <div> dibujado — para agrupar repetidos en vista simple
  let latestEl = null; // la línea marcada como "la última" (resaltada)

  // Seguir al último: por default SIEMPRE se queda en la línea nueva. Solo
  // deja de seguir si te movés a propósito a leer algo (si no, te
  // arrastraría mientras leés) — ahí aparece "Ir a lo último" para volver.
  let follow = true;

  const isSimple = () => hasDetail && prefs.detail === 'simple';
  const matches  = (el) => !filterText || el.dataset.text.includes(filterText);

  // Vista Simple = feed, lo más nuevo ARRIBA. Vista Técnico (y WiFi) =
  // terminal, lo más nuevo ABAJO — así se lee de corrido para depurar.
  const newestTop = () => isSimple();

  function isAtLatest() {
    return newestTop()
      ? body.scrollTop < 40
      : body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  }

  function scrollToLatest() {
    body.scrollTop = newestTop() ? 0 : body.scrollHeight;
  }

  function setFollow(v) {
    follow = v;
    btnJump.hidden = v;
    btnJump.textContent = newestTop() ? '↑ Ir a lo último' : '↓ Ir a lo último';
  }

  // Scroll del usuario (rueda, arrastre) — los scrolls que hace el propio
  // código terminan siempre en el extremo de lo último, así que no apagan
  // el seguimiento.
  body.addEventListener('scroll', () => setFollow(isAtLatest()));
  btnJump.addEventListener('click', () => { setFollow(true); scrollToLatest(); });

  // Resalta `el` como la última línea (y le saca la marca a la anterior).
  // El destello se re-dispara aunque sea la misma línea (repetido agrupado).
  function markLatest(el) {
    if (latestEl && latestEl !== el) latestEl.classList.remove('latest');
    latestEl = el;
    el.classList.remove('flash');
    void el.offsetWidth; // reinicia la animación
    el.classList.add('latest', 'flash');
  }

  function render(entry) {
    let text = entry.text, cls = technicalClass(entry), ico = null;
    if (isSimple()) {
      const v = simpleView(entry);
      if (!v) return;
      ({ text, cls, icon: ico } = v);
      cls = 'tl ' + cls;

      // Repetido del anterior (ignorando números) → se suma al contador
      // del que ya está en pantalla en vez de agregar otra línea.
      const key = groupKey(text);
      if (lastEl && lastEl.dataset.key === key) {
        const n = Number(lastEl.dataset.count) + 1;
        lastEl.dataset.count = n;
        lastEl.querySelector('.ts').textContent = fmtTs(entry.ts);
        lastEl.querySelector('.msg').textContent = text;
        let badge = lastEl.querySelector('.rep');
        if (!badge) { badge = document.createElement('span'); badge.className = 'rep'; lastEl.appendChild(badge); }
        badge.textContent = `×${n}`;
        markLatest(lastEl);
        return;
      }
    }

    const el = document.createElement('div');
    el.className = 'log-line ' + cls;
    el.dataset.text  = text.toLowerCase();
    el.dataset.key   = groupKey(text);
    el.dataset.count = 1;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTs(entry.ts);
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = text;
    if (ico) {
      const badge = document.createElement('span');
      badge.className = 'tl-ico';
      badge.innerHTML = icon(ico); // SVG fijo de ICONS, nunca texto del log
      el.append(badge);
    }
    el.append(ts, msg);
    if (!matches(el)) el.style.display = 'none';
    if (newestTop()) {
      body.prepend(el);
      while (body.children.length > MAX_ENTRIES) body.removeChild(body.lastChild);
    } else {
      body.appendChild(el);
      while (body.children.length > MAX_ENTRIES) body.removeChild(body.firstChild);
    }
    lastEl = el;
    markLatest(el);
  }

  function updateCount() {
    count.textContent = `${body.children.length} líneas`;
  }

  function append(entry) {
    if (hasDetail) NowCard.feed(entry); // solo el panel Servidor tiene la tarjeta "Ahora"
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    render(entry);
    updateCount();
    if (follow) scrollToLatest();
  }

  // Re-dibuja todo desde las entradas guardadas (al cambiar Simple ↔ Técnico).
  // Clases de layout según la vista: feed (Simple) o terminal (Técnico).
  function syncLayout() {
    body.classList.toggle('timeline', isSimple());
    root.classList.toggle('newest-top', newestTop());
  }

  function rerender() {
    syncLayout();
    body.innerHTML = '';
    lastEl = latestEl = null;
    for (const e of entries) render(e);
    updateCount();
    setFollow(true);
    scrollToLatest();
  }

  filter.addEventListener('input', () => {
    filterText = filter.value.trim().toLowerCase();
    for (const el of body.children) el.style.display = matches(el) ? '' : 'none';
  });

  btnClr.addEventListener('click', () => {
    entries.length = 0;
    body.innerHTML = '';
    lastEl = latestEl = null;
    count.textContent = '';
    setFollow(true);
  });

  function setLive(isLive) {
    dot.className = 'logs-dot ' + (isLive ? 'live' : 'down');
  }

  syncLayout(); // estado inicial (después lo cambia rerender())

  // Al volver a mostrar un panel oculto, arrancar en lo último.
  function setVisible(v) {
    root.hidden = !v;
    if (v && follow) scrollToLatest();
  }

  return { append, setLive, rerender, setVisible };
}

const panels = {
  server: makePanel('server', { hasDetail: true }),
  wifi:   makePanel('wifi',   { hasDetail: false }),
};

// ─── Controles de arriba (segmented) ─────────────────────────────────────────
function bindSegmented(groupId, key, onChange) {
  const group = document.getElementById(groupId);
  const sync = () => group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === prefs[key]));
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn || prefs[key] === btn.dataset.value) return;
    prefs[key] = btn.dataset.value;
    savePrefs();
    sync();
    onChange();
  });
  sync();
}

function applyPanels() {
  panels.server.setVisible(prefs.panels !== 'wifi');
  panels.wifi.setVisible(prefs.panels !== 'server');
  // El selector de detalle solo aplica al panel Servidor.
  document.getElementById('seg-detail-wrap').hidden = prefs.panels === 'wifi';
}

bindSegmented('seg-panels', 'panels', applyPanels);
bindSegmented('seg-detail', 'detail', () => panels.server.rerender());
applyPanels();

// ─── WebSocket ───────────────────────────────────────────────────────────────
let ws = null;
let retryMs = 500;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/logs`);

  ws.onopen = () => {
    panels.server.setLive(true);
    panels.wifi.setLive(true);
    retryMs = 500;
  };
  ws.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      const panel = panels[entry.source] || panels.server;
      panel.append(entry);
    } catch {}
  };
  ws.onclose = () => {
    panels.server.setLive(false);
    panels.wifi.setLive(false);
    retryMs = Math.min(retryMs * 1.6, 5000);
    setTimeout(connect, retryMs);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

connect();
