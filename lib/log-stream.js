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

const util = require('util');

const RING_SIZE = 300; // líneas que le mandamos a un cliente que recién conecta, para no arrancar en blanco
const ring = [];
const clients = new Set();

function _stringify(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// ─── Colores ANSI para la terminal (SSH / pm2 logs) ──────────────────────────
// Antes cada console.log salía en blanco y liso, sin hora — para entender
// "¿esto pasó hace 2 segundos o hace 10 minutos?" o "¿esto es la Pi (mic,
// WiFi, LEDs) o el servidor remoto (rag-api, LiveKit)?" había que leer cada
// línea con atención. Acá se le suma, SIN tocar ninguno de los cientos de
// console.log() ya escritos: hora con milisegundos siempre, más color según
// de qué se trata la línea (mismos emojis/prefijos que el código ya usaba
// para loguear, solo que ahora también pintan).
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

// Etapa del flujo de voz con LiveKit — separa de un vistazo "mandando audio
// tuyo" (📤/🎤, arrancó en _publishMic de lib/livekit-session.js) de
// "recibiendo audio del agente" (🔊/🤖, _consumeRemoteAudio) de "esperando/
// conectando" (🔗 al abrir la sala, ⏲ watchdog del agente) — que es
// justamente lo que se pidió poder distinguir mientras se sigue el log en
// vivo por SSH.
const STAGE_TX   = /📤|🎤.*publicad/;
const STAGE_RX   = /🔊|🤖|frame del agente/;
const STAGE_WAIT = /🔗|⏲|conectando|reintentando conexión|Watchdog armado/;

function _classifyStage(text) {
  if (STAGE_TX.test(text))   return 'tx';
  if (STAGE_RX.test(text))   return 'rx';
  if (STAGE_WAIT.test(text)) return 'wait';
  return null;
}

// De dónde viene el problema — solo se evalúa en warn/error (líneas que ya
// importan), para responder rápido "¿a quién le aviso?": ¿hardware/red LOCAL
// de la Raspberry (mic, parlante, WiFi, Bluetooth, LEDs, el propio hilo de
// Node atrasándose) o el lado REMOTO (rag-api / servidor LiveKit
// inalcanzable, auth, token)? No es exhaustivo — mejor esfuerzo por prefijo/
// palabra clave, ya existentes en el código de antes.
const ORIGIN_PI  = /\[wifi\]|\[audio\]|\[bluetooth\]|\[event-loop\]|\[leds?\]|\[mic-monitor\]|arecord|aplay|ALSA|undervoltage|throttl|nmcli|GPIO|NeoPixel/i;
const ORIGIN_RED = /\[rag-auth\]|\[rag-token\]|RAG_API_URL|fetch failed|agent-dead|agent no se suscribió|ls-remote|git (clone|ls-remote)|LiveKit.*(inalcanzable|no responde)/i;

function _classifyOrigin(text) {
  if (ORIGIN_PI.test(text))  return 'PI';
  if (ORIGIN_RED.test(text)) return 'RED';
  return null;
}

function _timestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// Arma la línea coloreada que se manda a stdout/stderr real (lo que ve pm2
// logs / una sesión SSH con `node server.js` en primer plano) — la que va
// por WebSocket a /logs (_push más abajo) viaja sin códigos ANSI, con los
// mismos datos ya separados en campos (stage/origin) para que el navegador
// los pinte con CSS en vez de tener que parsear escapes.
function _colorize(level, text, stage, origin) {
  let color = C.reset;
  if (level === 'error')      color = C.red;
  else if (level === 'warn')  color = C.yellow;
  else if (stage === 'tx')    color = C.cyan;
  else if (stage === 'rx')    color = C.green;
  else if (stage === 'wait')  color = C.magenta;

  const originTag = origin ? `${C.dim}${C.gray}[${origin}]${C.reset} ` : '';
  return `${C.gray}${_timestamp()}${C.reset} ${originTag}${color}${text}${C.reset}`;
}

function _push(stream, stage, origin, text) {
  const entry = { ts: Date.now(), stream, text, stage, origin };
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

  // util.format(...args) es lo mismo que usa console.* por dentro para
  // convertir varios argumentos (strings, objetos, %s) en una sola línea de
  // texto — así el texto que coloreamos/mandamos por WS es idéntico al que
  // ya se imprimía antes, solo que ahora en un único console.log(línea) en
  // vez de pasar los args sueltos.
  //
  // warn se etiqueta como 'stdout' (mismo canal que ve PM2 por defecto para
  // console.warn) — solo console.error va a 'stderr', para que el panel
  // "en rojo" del visor coincida con lo que ya distingue /local hoy.
  console.log = (...args) => {
    const text  = util.format(...args);
    const stage = _classifyStage(text);
    origLog(_colorize('log', text, stage, null));
    _push('stdout', stage, null, text);
  };
  console.warn = (...args) => {
    const text   = util.format(...args);
    const origin = _classifyOrigin(text);
    origWarn(_colorize('warn', text, null, origin));
    _push('stdout', null, origin, text);
  };
  console.error = (...args) => {
    const text   = util.format(...args);
    const origin = _classifyOrigin(text);
    origErr(_colorize('error', text, null, origin));
    _push('stderr', null, origin, text);
  };
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
