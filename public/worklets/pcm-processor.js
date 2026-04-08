/**
 * public/worklets/pcm-processor.js
 *
 * AudioWorklet que recibe chunks de PCM Int16 (S16_LE, 16 kHz, mono)
 * enviados por el servidor via WebSocket, los convierte a Float32
 * y los inyecta en el grafo de audio del browser.
 *
 * El nodo se registra como 'pcm-processor' y se instancia desde app.js.
 */

class PcmProcessor extends AudioWorkletProcessor {

  constructor() {
    super();
    // Cola de muestras Float32 listas para procesar
    this._queue = [];
    this._total = 0;

    // Recibir chunks PCM desde el hilo principal
    this.port.onmessage = (e) => {
      const int16 = new Int16Array(e.data);
      const float = new Float32Array(int16.length);

      // Convertir Int16 [-32768, 32767] → Float32 [-1.0, 1.0]
      for (let i = 0; i < int16.length; i++) {
        float[i] = int16[i] / 32768;
      }

      this._queue.push(float);
      this._total += float.length;
    };
  }

  /**
   * process() se llama ~cada 128 samples a la tasa del AudioContext (generalmente 44100 / 48000 Hz).
   * El servidor envía a 16000 Hz, así que habrá diferencia de ritmo — la cola absorbe el delta.
   */
  process(_inputs, outputs) {
    const output   = outputs[0][0]; // canal 0 del primer output
    const needed   = output.length; // siempre 128

    let written = 0;

    while (written < needed && this._queue.length > 0) {
      const chunk     = this._queue[0];
      const available = chunk.length;
      const take      = Math.min(needed - written, available);

      output.set(chunk.subarray(0, take), written);
      written += take;

      if (take < available) {
        // Quedan muestras en este chunk — avanzar el puntero
        this._queue[0] = chunk.subarray(take);
      } else {
        this._queue.shift();
      }
      this._total -= take;
    }

    // Silencio si no hay datos aún
    if (written < needed) {
      output.fill(0, written);
    }

    return true; // mantener el nodo vivo
  }
}

registerProcessor('pcm-processor', PcmProcessor);
