/**
 * speaker-capture.js
 *
 * AudioWorklet que captura audio Float32 del agente LiveKit
 * y envía chunks Int16 al hilo principal para transmitir por WebSocket a la Pi.
 */
class SpeakerCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4096);
    this._pos = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this._buf[this._pos++] = ch[i];
      if (this._pos === this._buf.length) {
        // Convertir Float32 → Int16 y enviar al hilo principal
        const int16 = new Int16Array(this._buf.length);
        for (let j = 0; j < this._buf.length; j++) {
          int16[j] = Math.max(-32768, Math.min(32767, Math.round(this._buf[j] * 32767)));
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('speaker-capture', SpeakerCapture);
