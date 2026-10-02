'use strict';

/**
 * wakeword/wakeword-worker.js
 *
 * Corre wakeword-model.js en un worker thread — un hilo de Node
 * completamente aparte del principal. Cada corrida real del modelo puede
 * tardar varios segundos en una Pi Zero 2W; si eso pasara en el hilo
 * principal, bloquearía TODO lo demás (HTTP, audio, LEDs) — confirmado en
 * producción, no es una precaución de más. Acá adentro puede tardar lo que
 * tarde sin afectar al resto de la app.
 *
 * Protocolo simple por mensajes:
 *   afuera -> adentro: { type: 'predict', buffer: ArrayBuffer }
 *   adentro -> afuera: { type: 'ready' }
 *                       { type: 'score', score: number, inferMs: number }
 *                       { type: 'error', error: string }
 */

const { parentPort, workerData } = require('worker_threads');
const { WakeWordModel } = require('./wakeword-model');

async function main() {
  const model = new WakeWordModel();
  await model.load(workerData);
  parentPort.postMessage({ type: 'ready' });

  parentPort.on('message', async (msg) => {
    if (msg.type !== 'predict') return;
    try {
      // inferMs = solo lo que tarda el modelo, medido acá adentro — para
      // /diag/wakeword-history (ver lib/wakeword-gate.js).
      const startedAt = performance.now();
      const score = await model.predict(new Int16Array(msg.buffer));
      const inferMs = performance.now() - startedAt;
      parentPort.postMessage({ type: 'score', score, inferMs });
    } catch (e) {
      parentPort.postMessage({ type: 'error', error: e.message });
    }
  });
}

main().catch((e) => parentPort.postMessage({ type: 'error', error: e.message }));
