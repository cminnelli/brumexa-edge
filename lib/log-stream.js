'use strict';

/**
 * lib/log-stream.js
 *
 * Reenvía TODO lo que la app ya loguea con console.log/warn/error a quien
 * esté escuchando por WebSocket (/ws/logs), en tiempo real — sin tocar
 * ninguno de los cientos de console.log() ya existentes en el proyecto
 * (leds.js, livekit-session.js, terminal, etc.): se interceptan los tres
 * métodos UNA sola vez acá. Sigue escribiendo a stdout/stderr como siempre
 * (PM2 lo sigue viendo igual) — esto solo AGREGA un segundo destino, no
 * reemplaza nada. Mucho más liviano que el polling anterior de /local (leía
 * y parseaba el archivo de PM2 cada 6s): acá es solo un append en memoria +
 * un send a los sockets ya conectados, nada de I/O de disco.
 */

const RING_SIZE = 300; // líneas que le mandamos a un cliente que recién conecta, para no arrancar en blanco
const ring = [];
const clients = new Set();

function _stringify(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function _push(stream, args) {
  const text  = args.map(_stringify).join(' ');
  const entry = { ts: Date.now(), stream, text };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  const payload = JSON.stringify(entry);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(payload); } catch {} }
  }
}

let _patched = false;
function _patchConsole() {
  if (_patched) return;
  _patched = true;
  const origLog  = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr  = console.error.bind(console);
  // warn se etiqueta como 'stdout' (mismo canal que ve PM2 por defecto para
  // console.warn) — solo console.error va a 'stderr', para que el panel
  // "en rojo" del visor coincida con lo que ya distingue /local hoy.
  console.log   = (...args) => { origLog(...args);  _push('stdout', args); };
  console.warn  = (...args) => { origWarn(...args); _push('stdout', args); };
  console.error = (...args) => { origErr(...args);  _push('stderr', args); };
}

function setupLogStream() {
  _patchConsole();
  console.log(`[log-stream] listo — buffer de las últimas ${RING_SIZE} líneas, WS en /ws/logs`);
}

// Llamado desde lib/audio.js, que es el dueño único del 'upgrade' del
// httpServer (ver el comentario ahí sobre el bug de ws v8 con dos
// WebSocketServer con distinto path en el mismo server) cuando llega una
// conexión nueva a /ws/logs.
function handleLogsWsConnection(ws) {
  clients.add(ws);
  for (const entry of ring) {
    try { ws.send(JSON.stringify(entry)); } catch {}
  }
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

module.exports = { setupLogStream, handleLogsWsConnection };
