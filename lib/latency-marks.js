// Marcas de tiempo para la línea de latencia de punta a punta (página
// "Latencia" del admin). La Pi solo dice "pasó X en mi reloj"; el agente las
// convierte a su reloj y arma la línea de tiempo (ver
// brumexa-livekit-agent/src/services/latencyTracker.ts).
//
//   mark(name, t?, extra?) → manda { mark, t, ...extra } por el topic "brumexa.timing". Si
//                     todavía no hay sala (wake, token), queda en cola y sale
//                     apenas se conecta.
//   attach(room)    → al conectar: registra el RPC "brumexa.clock" (el agente
//                     lo usa para medir el offset entre relojes) y vacía la cola.
//   detach()        → al cerrar la sesión.
//
// Nunca debe afectar la conversación: todo error se traga.

const TOPIC = 'brumexa.timing';
const MAX_QUEUE = 50;

let room = null;
const queue = [];
// Las de arranque salen apenas conecta la Pi, y el agente puede entrar a la
// sala después (arranque en frío) y no verlas. Se reenvían cuando el agente
// ya está seguro (startup.agentSubscribed); del otro lado pisar la misma
// marca con el mismo valor no cambia nada.
let startupMarks = [];

function flush() {
  const lp = room && room.localParticipant;
  if (!lp) return;
  while (queue.length) {
    const m = queue.shift();
    lp.sendText(JSON.stringify(m), { topic: TOPIC }).catch(() => {});
  }
}

function mark(name, t = Date.now(), extra = {}) {
  // Sin sala solo tienen sentido las de arranque (wake, token…): una trabada
  // o un audio fuera de una conversación no debe caer en la próxima.
  if (!room && !name.startsWith('startup.')) return;
  const m = { ...extra, mark: name, t: Math.round(t) };
  if (name === 'startup.agentSubscribed') queue.push(...startupMarks);
  if (name.startsWith('startup.')) startupMarks.push(m);
  queue.push(m);
  if (queue.length > MAX_QUEUE) queue.shift();
  flush();
}

function attach(r) {
  room = r;
  try {
    r.localParticipant.registerRpcMethod('brumexa.clock', async () => String(Date.now()));
  } catch (e) {
    console.warn('[latency-marks] no se pudo registrar brumexa.clock:', e.message);
  }
  flush();
}

// Vacía la cola: una marca que quedó colgada de esta sesión no debe aparecer
// en la próxima (las de arranque de la próxima se encolan después de esto).
function detach() {
  room = null;
  queue.length = 0;
  startupMarks = [];
}

module.exports = { mark, attach, detach };
