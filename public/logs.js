'use strict';

// Visor de logs en vivo — panel izquierdo (servidor) via WebSocket (/ws/logs,
// ver lib/log-stream.js: server empuja cada línea apenas la loguea, nada de
// polling), panel derecho (sistema/kernel) por polling liviano cada 4s (no
// hay forma barata de "tail -f" del kernel sin permisos/procesos extra, y
// los eventos ahí son infrecuentes — no hace falta que sea instantáneo).

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
    return new Date(ts).toLocaleTimeString('es-AR', { hour12: false });
  }

  function classify(text) {
    if (/Gate (ABIERTO|CERRADO)/.test(text)) return 'hl-gate';
    if (/hablando|dejó de hablar|EMITIENDO a LiveKit|Dejó de emitir señal real/.test(text)) return 'hl-speak';
    return '';
  }

  function appendEntry(entry) {
    const el = document.createElement('div');
    el.className = 'log-line' + (entry.stream === 'stderr' ? ' stderr' : ' ' + classify(entry.text));
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

// ─── Panel sistema (polling) ──────────────────────────────────────────────────
(function systemPanel() {
  const body  = document.getElementById('body-system');
  const dot   = document.getElementById('dot-system');
  const count = document.getElementById('count-system');
  const seen  = new Set();
  let shown = 0;

  function isAtBottom() {
    return body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  }

  function appendLine(text) {
    const el = document.createElement('div');
    el.className = 'log-line';
    el.textContent = text;
    const wasBottom = isAtBottom();
    body.appendChild(el);
    shown++;
    while (body.children.length > MAX_LINES) body.removeChild(body.firstChild);
    count.textContent = `${shown} líneas`;
    if (wasBottom) body.scrollTop = body.scrollHeight;
  }

  async function poll() {
    try {
      const res  = await fetch('/local/system-log', { cache: 'no-store' });
      const data = await res.json();
      dot.className = 'logs-dot live';
      const lines = (data.text || '').split('\n').filter(Boolean);
      for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);
        if (seen.size > MAX_LINES * 2) {
          // evitar crecer sin límite en una sesión larga — el Set solo
          // necesita recordar lo suficiente para no re-imprimir el tail
          const it = seen.values();
          for (let i = 0; i < MAX_LINES; i++) seen.delete(it.next().value);
        }
        appendLine(line);
      }
    } catch {
      dot.className = 'logs-dot down';
    }
  }

  poll();
  setInterval(poll, 4000);
})();
