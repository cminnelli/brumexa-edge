// Latido del dispositivo: cada 30 s le avisa a la RAG API "estoy online"
// (PATCH /devices/:deviceId/heartbeat, que actualiza devices.last_seen). El
// admin muestra el dispositivo como online si el último latido es reciente.
//
//   start() → arranca (idempotente). Sin auth todavía, ese latido se saltea.
//
// Nunca debe afectar nada más: todo error se traga.

const ragAuth = require('./rag-auth');

const INTERVAL_MS = 30000;
let timer = null;

async function beat() {
  try {
    if (!ragAuth.isAuthenticated()) return;
    const { ragApiUrl, deviceId } = ragAuth.getStatus();
    if (!deviceId) return;
    await fetch(`${ragApiUrl}/devices/${encodeURIComponent(deviceId)}/heartbeat`, {
      method: 'PATCH',
      headers: { Authorization: ragAuth.getAuthHeader() },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // sin red o API caída: el próximo latido lo reintenta
  }
}

function start() {
  if (timer) return;
  timer = setInterval(beat, INTERVAL_MS);
  if (timer.unref) timer.unref();
  // El primero un toque después del arranque, cuando initAuth() ya tuvo tiempo de loguear.
  setTimeout(beat, 5000).unref?.();
}

module.exports = { start };
