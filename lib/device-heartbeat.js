// Latido del dispositivo: le avisa a la RAG API "estoy online"
// (PATCH /devices/:deviceId/heartbeat, que actualiza devices.last_seen). Manda
// también su intervalo, así el admin sabe cuándo darla por offline (2,5×),
// su versión y estado (lib/device-health.js), y recibe en la respuesta las
// órdenes de actualización del admin (lib/remote-update.js).
//
// Espera abierta (2026-11-20): el latido pide `?wait=<ms>` y la API lo tiene
// abierto hasta que el admin manda una orden (contesta al toque) o se cumple
// el tiempo. Así una actualización arranca en un segundo, no "en el próximo
// latido". Apenas vuelve, sale el siguiente. Si la API no conoce `wait`
// (contesta sin `waited`), se espera el intervalo como antes.
//
//   start()             → arranca (idempotente). Sin sesión vigente, ese latido
//                         intenta loguearse primero (si la API no responde, se saltea).
//   nudge()             → manda un latido YA (corta la espera abierta), p. ej.
//                         cuando cambia el estado de una actualización
//   setIntervalMs(ms)   → cambia el intervalo en caliente (desde /configuracion).
//   getIntervalMs()
//
// Intervalo: DEVICE_HEARTBEAT_MS en .env (default 30 s, entre 10 s y 5 min).
// La espera abierta dura como mucho el intervalo (tope 25 s).
// Nunca debe afectar nada más: todo error se traga.

const ragAuth = require('./rag-auth');
const deviceHealth = require('./device-health');
const remoteUpdate = require('./remote-update');

const MIN_MS = 10_000;
const MAX_MS = 300_000;
const clamp = (ms) => Math.min(MAX_MS, Math.max(MIN_MS, ms));

let intervalMs = clamp(parseInt(process.env.DEVICE_HEARTBEAT_MS, 10) || 30_000);
let _loopOn = false;
let _abort = null;          // corta la espera abierta en curso (nudge)
let _sleepWake = null;      // corta la pausa entre latidos (nudge)
const LOGIN_RETRY_MS = 2 * 60 * 1000;
const MAX_WAIT_MS = 25_000;
let lastLoginTry = 0;

// Un latido. Devuelve true si la API sostuvo la espera abierta (el siguiente
// puede salir ya); false si hay que esperar el intervalo antes del próximo.
async function beat() {
  try {
    const { ragApiUrl, deviceId } = ragAuth.getStatus();
    if (!deviceId) return false;
    // Sin sesión vigente (token vencido o descartado) se loguea acá: así la
    // Pi se recupera sola aunque nadie le hable. Como mucho cada 2 min, para
    // no llenar el log si la API está apagada.
    if (!ragAuth.isAuthenticated()) {
      if (Date.now() - lastLoginTry < LOGIN_RETRY_MS) return false;
      lastLoginTry = Date.now();
      await ragAuth.ensureAuth();
    }
    // Además de "estoy viva": versión, estado (Wi-Fi, último error, última
    // charla) y cómo va una actualización pedida desde el admin.
    const health = await deviceHealth.snapshot().catch(() => null);
    const wait = Math.min(intervalMs, MAX_WAIT_MS);
    const ctrl = new AbortController();
    _abort = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), wait + 10_000);
    let res;
    try {
      res = await fetch(`${ragApiUrl}/devices/${encodeURIComponent(deviceId)}/heartbeat?wait=${wait}`, {
        method: 'PATCH',
        headers: { Authorization: ragAuth.getAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs, version: deviceHealth.version(), health, update: remoteUpdate.report() }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
      if (_abort === ctrl) _abort = null;
    }
    if (res.status === 401) ragAuth.invalidate(); // el próximo latido pide un token nuevo
    if (!res.ok) return false;
    // La respuesta puede traer una orden de actualización ({ update: { id, version } }).
    const data = await res.json().catch(() => null);
    if (data && data.update) remoteUpdate.handle(data.update);
    if (data && data.cancelUpdate) remoteUpdate.cancel(data.cancelUpdate);
    return !!(data && data.waited);
  } catch (e) {
    // cortado a propósito (nudge): el siguiente sale ya; si no, sin red o API caída
    return !!(e && e.name === 'AbortError' && _nudged);
  }
}

let _nudged = false;
function _sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    if (t.unref) t.unref();
    function done() { clearTimeout(t); _sleepWake = null; resolve(); }
    _sleepWake = done;
  });
}

async function _loop() {
  await _sleep(5000);   // el primero un toque después del arranque, cuando initAuth() ya tuvo tiempo de loguear
  while (_loopOn) {
    _nudged = false;
    const held = await beat();
    if (!held && !_nudged) await _sleep(intervalMs);
  }
}

function start() {
  if (_loopOn) return;
  _loopOn = true;
  void _loop();
}

function nudge() {
  _nudged = true;
  if (_abort) _abort.abort();
  if (_sleepWake) _sleepWake();
}

function setIntervalMs(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return false;
  intervalMs = clamp(ms);
  if (_loopOn) nudge(); // avisa el intervalo nuevo ya mismo
  return true;
}

function getIntervalMs() { return intervalMs; }

module.exports = { start, nudge, setIntervalMs, getIntervalMs };
