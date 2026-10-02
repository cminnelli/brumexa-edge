'use strict';

/**
 * wakeword/wakeword-worker.js
 *
 * Corre wakeword-model.js en un worker thread — un hilo de Node
 * completamente aparte del principal. Aunque ahora cada pedazo de audio es
 * barato (streaming, ver feed() en wakeword-model.js), sigue siendo trabajo
 * de CPU continuo: acá adentro no le roba tiempo al hilo principal (HTTP,
 * audio, LEDs).
 *
 * Protocolo simple por mensajes:
 *   afuera -> adentro: { type: 'feed', buffer: ArrayBuffer }  (Int16 PCM NUEVO, múltiplo de 80ms)
 *                       { type: 'reset' }                      (stream de audio nuevo)
 *   adentro -> afuera: { type: 'ready' }
 *                       { type: 'score', scores: number[], inferMs: number }  (un score por pedazo de 80ms)
 *                       { type: 'error', error: string }
 */

const { parentPort, workerData } = require('worker_threads');
const { WakeWordModel } = require('./wakeword-model');

async function main() {
  const model = new WakeWordModel();
  await model.load(workerData);
  parentPort.postMessage({ type: 'ready' });

  parentPort.on('message', async (msg) => {
    if (msg.type === 'reset') { model.reset(); return; }
    if (msg.type !== 'feed') return;
    try {
      // inferMs = solo lo que tarda el modelo, medido acá adentro — para
      // /diag/wakeword-history (ver lib/wakeword-gate.js).
      const startedAt = performance.now();
      const scores = await model.feed(new Int16Array(msg.buffer));
      const inferMs = performance.now() - startedAt;
      parentPort.postMessage({ type: 'score', scores, inferMs });
    } catch (e) {
      parentPort.postMessage({ type: 'error', error: e.message });
    }
  });
}

main().catch((e) => parentPort.postMessage({ type: 'error', error: e.message }));
