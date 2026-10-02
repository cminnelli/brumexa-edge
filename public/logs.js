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
const num = (text, re) => { const m = text.match(re); return m ? m[1] : null; };
const FRIENDLY = {
  'voice-on': (t) => {
    const ms = num(t, /confirmado en (\d+)ms/);
    return `🗣️ Empezaste a hablar${ms ? ` (lo detectó en ${ms} ms)` : ''}${/sobre ruido de fondo/.test(t) ? ' — encima del ruido de fondo' : ''}`;
  },
  'voice-off':    (t) => { const s = num(t, /\(([\d.]+)s\)/); return `🤫 Dejaste de hablar${s ? ` (hablaste ${s} s)` : ''}`; },
  'voice-reject': ()  => '🚫 Se escuchó un ruido, pero no era voz — ignorado',
  'wake': (t) => {
    const score = num(t, /score=([\d.]+)/);
    return `👋 Te escuché decir «ei brúmexa»${score ? ` (${Math.round(parseFloat(score) * 100)}% seguro)` : ''} — conectando…`;
  },
  'session-wait': ()  => '🔗 Conectando con el asistente…',
  'session-up':   (t) => (/Agente/.test(t) ? '🤖 El asistente está listo — podés hablarle' : '✅ Conectado a la sala'),
  'session-down': (t) => (/Sesión cerrada/.test(t) ? '👋 Conversación terminada' : '🔌 Se cortó la conexión con el asistente'),
  'agent-on':     ()  => '🔊 El asistente está hablando',
  'agent-off':    ()  => '🔈 El asistente terminó de hablar',
  'system': (t) => {
    const hash = num(t, /update: listo \((\w+)\)/);
    if (hash) return `⬆️ Brumexa se actualizó (versión ${hash}) — reiniciando`;
    if (/wakeword-gate\] toggle/.test(t)) return `⚙️ «Ei brúmexa» ${/ACTIVADO/.test(t) ? 'activado' : 'desactivado'}`;
    const mode = num(t, /modo de detección → (\w+)/);
    if (mode) return `⚙️ Detección de voz: ${mode === 'vad' ? 'Volumen + VAD' : 'solo Volumen'}`;
    return null;
  },
};

// Saca prefijos técnicos tipo "[event-loop] " / "[rag-auth] " de un aviso.
const stripTags = (t) => t.replace(/^(\[[^\]]+\]\s*)+/, '');

// Qué mostrar en vista simple — { text, cls } o null (no se muestra).
function simpleView(entry) {
  if (entry.event) {
    const f = FRIENDLY[entry.event];
    return { text: (f && f(entry.text)) || entry.text, cls: `ev ev-${entry.event}` };
  }
  if (entry.stream === 'stderr' || entry.level === 'error') {
    const t = stripTags(entry.text);
    return { text: /^[✘✗❌]/.test(t) ? t : '❌ ' + t, cls: 'stderr' }; // sin doble cruz si el mensaje ya trae la suya
  }
  if (entry.level === 'warn') return { text: stripTags(entry.text), cls: 'lvl-warn' };
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

  // Seguir al último: por default SIEMPRE baja a la línea nueva. Solo deja
  // de seguir si subís a propósito para leer algo (si no, te arrastraría
  // para abajo mientras leés) — ahí aparece "↓ Ir al último" para volver.
  let follow = true;

  const isSimple = () => hasDetail && prefs.detail === 'simple';
  const matches  = (el) => !filterText || el.dataset.text.includes(filterText);

  function isAtBottom() {
    return body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  }

  function scrollToLatest() {
    body.scrollTop = body.scrollHeight;
  }

  function setFollow(v) {
    follow = v;
    btnJump.hidden = v;
  }

  // Scroll del usuario (rueda, arrastre) — los scrolls que hace el propio
  // código terminan siempre abajo de todo, así que no apagan el seguimiento.
  body.addEventListener('scroll', () => setFollow(isAtBottom()));
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
    let text = entry.text, cls = technicalClass(entry);
    if (isSimple()) {
      const v = simpleView(entry);
      if (!v) return;
      ({ text, cls } = v);

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
    el.append(ts, msg);
    if (!matches(el)) el.style.display = 'none';
    body.appendChild(el);
    lastEl = el;
    markLatest(el);
    while (body.children.length > MAX_ENTRIES) body.removeChild(body.firstChild);
  }

  function updateCount() {
    count.textContent = `${body.children.length} líneas`;
  }

  function append(entry) {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    render(entry);
    updateCount();
    if (follow) scrollToLatest();
  }

  // Re-dibuja todo desde las entradas guardadas (al cambiar Simple ↔ Técnico).
  function rerender() {
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
