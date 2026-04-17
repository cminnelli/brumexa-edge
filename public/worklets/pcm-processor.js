/**
 * pcm-processor.js
 *
 * Recibe Int16 PCM a 16000 Hz desde el servidor (arecord),
 * resamplifica al sampleRate del AudioContext (normalmente 48000 Hz),
 * y reporta el nivel de audio al hilo principal para indicador de voz.
 */

const INPUT_RATE  = 16000;
const SPEAK_EVERY = 20;   // postMessage de nivel cada N llamadas a process()

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue   = [];
    this._ratio   = sampleRate / INPUT_RATE;   // e.g. 48000/16000 = 3.0
    this._frac    = 0;     // posición fraccional dentro del sample actual
    this._lastSmp = 0;     // último sample para interpolación
    this._callN   = 0;
    this._peakRms = 0;

    this.port.onmessage = (e) => {
      const int16 = new Int16Array(e.data);
      const f32   = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
      this._queue.push(f32);
    };
  }

  // Avanza la posición fraccional y devuelve el sample interpolado
  _nextSample() {
    // Avanzar en el stream de entrada por 1/_ratio
    this._frac += 1 / this._ratio;

    while (this._frac >= 1) {
      this._frac -= 1;
      if (this._queue.length === 0) { this._lastSmp = 0; return 0; }
      const chunk = this._queue[0];
      this._lastSmp = chunk[0];
      if (chunk.length === 1) {
        this._queue.shift();
      } else {
        this._queue[0] = chunk.subarray(1);
      }
    }
    return this._lastSmp;
  }

  process(_inputs, outputs) {
    const out    = outputs[0][0];
    const needed = out.length;
    let   sumSq  = 0;

    for (let i = 0; i < needed; i++) {
      const s = this._nextSample();
      out[i]  = s;
      sumSq  += s * s;
    }

    // Enviar nivel RMS al hilo principal cada SPEAK_EVERY llamadas
    this._callN++;
    if (this._callN >= SPEAK_EVERY) {
      this._callN = 0;
      const rms = Math.sqrt(sumSq / needed);
      this.port.postMessage({ type: 'level', rms });
    }

    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
