'use strict';

// Visor de logs en vivo — WebSocket (/ws/logs, ver lib/log-stream.js: server
// empuja cada línea apenas la loguea, nada de polling).
//
// Antes había un segundo panel con el log de sistema/kernel (dmesg/
// journalctl), sondeado cada 4s. Se sacó a propósito: esos comandos podían
// tardar bastante en la Pi y cada corrida bloqueaba el event loop entero
// (audio, LEDs) mientras esta página estuviera abierta — ver /local/status
// para el resto del diagnóstico de sistema sin ese sondeo repetido.

const MAX_LINES = 500; // tope de <div> por panel — no queremos miles de nodos vivos en una sesión larga

// ─── Panel servidor (WebSocket) ──────────────────────────────────────────────
(function serverPanel() {
  const body   = document.getElementById('body-server');
  const dot    = document.getElementById('dot-server');
  const count  = document.getElementById('count-server');
  const filter = document.getElementById('logs-filter');
  const btnClr = document.getElementById('btn-clear-server');

  let shown  = 0;
  let filterText = '';

  function isAtBottom() {
    return body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  }

  function fmtTs(ts) {
    const d = new Date(ts);
    const base = d.toLocaleTimeString('es-AR', { hour12: false });
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${base}.${ms}`;
  }

  // stage/origin ya vienen clasificados del server (lib/log-stream.js) — acá
  // solo se traducen a clases CSS, mismo criterio que ya usa el color ANSI
  // de la terminal (pm2 logs), para que el panel del navegador y la
  // consola por SSH se vean equivalentes.
  function classify(entry) {
    if (entry.stream === 'stderr') return 'stderr';
    if (entry.origin === 'PI')  return 'origin-pi';
    if (entry.origin === 'RED') return 'origin-red';
    if (entry.stage === 'tx')   return 'hl-tx';
    if (entry.stage === 'rx')   return 'hl-rx';
    if (entry.stage === 'wait') return 'hl-wait';
    if (/Gate (ABIERTO|CERRADO)/.test(entry.text)) return 'hl-gate';
    return '';
  }

  function appendEntry(entry) {
    const el = document.createElement('div');
    el.className = 'log-line ' + classify(entry);
    el.dataset.text = entry.text.toLowerCase();
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTs(entry.ts);
    el.appendChild(ts);
    el.appendChild(document.createTextNode(entry.text));
    if (filterText && !el.dataset.text.includes(filterText)) el.style.display = 'none';

    const wasBottom = isAtBottom();
    body.appendChild(el);
    shown++;
    while (body.children.length > MAX_LINES) body.removeChild(body.firstChild);
    count.textContent = `${shown} líneas`;
    if (wasBottom) body.scrollTop = body.scrollHeight;
  }

  filter.addEventListener('input', () => {
    filterText = filter.value.trim().toLowerCase();
    for (const el of body.children) {
      el.style.display = (!filterText || el.dataset.text.includes(filterText)) ? '' : 'none';
    }
  });

  btnClr.addEventListener('click', () => {
    body.innerHTML = '';
    shown = 0;
    count.textContent = '';
  });

  let ws = null;
  let retryMs = 500;

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/logs`);

    ws.onopen = () => {
      dot.className = 'logs-dot live';
      retryMs = 500;
    };
    ws.onmessage = (e) => {
      try { appendEntry(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => {
      dot.className = 'logs-dot down';
      retryMs = Math.min(retryMs * 1.6, 5000);
      setTimeout(connect, retryMs);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  connect();
})();
