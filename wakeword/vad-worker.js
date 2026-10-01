'use strict';

/**
 * wakeword/vad-worker.js
 *
 * Corre vad-model.js (Silero VAD) en un worker thread aparte -- mismo
 * criterio que wakeword-worker.js: no bloquear el hilo principal (HTTP,
 * audio, LEDs). Cada inferencia acá es chica (32ms de audio) y debería ser
 * rápida, pero se corre igual en worker thread para no arriesgar nada si en
 * la Pi real tarda más de lo esperado -- esto corre MUCHO más seguido que
 * el wake word (cada 32ms vs cada 400ms), así que cualquier lentitud pesa
 * más acá.
 *
 * Protocolo por mensajes:
 *   afuera -> adentro: { type: 'predict', buffer: ArrayBuffer }  (512 muestras Float32)
 *                       { type: 'reset' }
 *   adentro -> afuera: { type: 'ready' }
 *                       { type: 'score', score: number }
 *                       { type: 'error', error: string }
 */

const { parentPort, workerData } = require('worker_threads');
const { VadModel } = require('./vad-model');

async function main() {
  const model = new VadModel();
  await model.load(workerData.modelPath);
  parentPort.postMessage({ type: 'ready' });

  parentPort.on('message', async (msg) => {
    if (msg.type === 'reset') { model.reset(); return; }
    if (msg.type !== 'predict') return;
    try {
      const score = await model.predict(new Float32Array(msg.buffer));
      parentPort.postMessage({ type: 'score', score });
    } catch (e) {
      parentPort.postMessage({ type: 'error', error: e.message });
    }
  });
}

main().catch((e) => parentPort.postMessage({ type: 'error', error: e.message }));
