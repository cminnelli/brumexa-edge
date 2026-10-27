// Latido del dispositivo: cada N segundos le avisa a la RAG API "estoy online"
// (PATCH /devices/:deviceId/heartbeat, que actualiza devices.last_seen). Manda
// también su intervalo, así el admin sabe cuándo darla por offline (2,5×).
//
//   start()             → arranca (idempotente). Sin auth todavía, ese latido se saltea.
//   setIntervalMs(ms)   → cambia el intervalo en caliente (desde /configuracion).
//   getIntervalMs()
//
// Intervalo: DEVICE_HEARTBEAT_MS en .env (default 30 s, entre 10 s y 5 min).
// Nunca debe afectar nada más: todo error se traga.

const ragAuth = require('./rag-auth');

const MIN_MS = 10_000;
const MAX_MS = 300_000;
const clamp = (ms) => Math.min(MAX_MS, Math.max(MIN_MS, ms));

let intervalMs = clamp(parseInt(process.env.DEVICE_HEARTBEAT_MS, 10) || 30_000);
let timer = null;

async function beat() {
  try {
    if (!ragAuth.isAuthenticated()) return;
    const { ragApiUrl, deviceId } = ragAuth.getStatus();
    if (!deviceId) return;
    await fetch(`${ragApiUrl}/devices/${encodeURIComponent(deviceId)}/heartbeat`, {
      method: 'PATCH',
      headers: { Authorization: ragAuth.getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMs }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // sin red o API caída: el próximo latido lo reintenta
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(beat, intervalMs);
  if (timer.unref) timer.unref();
}

function start() {
  if (timer) return;
  schedule();
  // El primero un toque después del arranque, cuando initAuth() ya tuvo tiempo de loguear.
  setTimeout(beat, 5000).unref?.();
}

function setIntervalMs(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return false;
  intervalMs = clamp(ms);
  if (timer) { schedule(); void beat(); } // avisa el intervalo nuevo ya mismo
  return true;
}

function getIntervalMs() { return intervalMs; }

module.exports = { start, setIntervalMs, getIntervalMs };
