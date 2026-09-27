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
 *                       { type: 'score', score: number }
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
      const score = await model.predict(new Int16Array(msg.buffer));
      parentPort.postMessage({ type: 'score', score });
    } catch (e) {
      parentPort.postMessage({ type: 'error', error: e.message });
    }
  });
}

main().catch((e) => parentPort.postMessage({ type: 'error', error: e.message }));
