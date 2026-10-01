'use strict';

/**
 * wakeword/vad-model.js
 *
 * Silero VAD: audio crudo (bloques de 512 muestras a 16kHz) -> probabilidad
 * de voz humana (0-1). A diferencia del wake word (wakeword-model.js,
 * "stateless", evalúa una ventana de 2s de una sola vez), este modelo es
 * STATEFUL -- mantiene una RNN interna entre llamadas, así que hay que
 * alimentarlo en ORDEN, sin saltar bloques, nunca con audio fuera de
 * secuencia. Puerto directo del mismo modelo que ya usa en producción el
 * agente de LiveKit (@livekit/agents-plugin-silero, onnx_model.js) -- mismo
 * archivo .onnx (ver wakeword/models/silero_vad.onnx), misma forma de
 * llamarlo.
 */

const ort = require('onnxruntime-node');

const SAMPLE_RATE         = 16000;
const WINDOW_SIZE_SAMPLES = 512; // 32ms a 16kHz -- fijo por el modelo, no tocar
const CONTEXT_SIZE        = 64;  // fijo por el modelo para 16kHz

// Mismo criterio que wakeword-model.js: un solo núcleo, no competir por CPU
// con el resto de la app en la Pi Zero 2W.
const SESSION_OPTIONS = { executionMode: 'sequential', intraOpNumThreads: 1, interOpNumThreads: 1 };

class VadModel {
  async load(modelPath) {
    this._session  = await ort.InferenceSession.create(modelPath, SESSION_OPTIONS);
    this._srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]));
    this._generation = 0;
    this.reset();
  }

  // Limpia el estado interno (contexto + RNN) -- llamar al prender el gate
  // o ante cualquier corte real en el flujo de audio, para no arrancar con
  // contexto de audio viejo que ya no corresponde al momento actual.
  // _generation sube en cada reset(): si predict() ya estaba a mitad de un
  // await (la inferencia ONNX) cuando esto corre, predict() lo nota al
  // volver y NO pisa el estado recién limpiado con el resultado, calculado
  // sobre contexto viejo, que ya no corresponde (ver predict() abajo) --
  // sin esto, un reset() que cae justo en el medio de un predict() en
  // vuelo se deshacía solo apenas ese predict terminaba.
  reset() {
    this._generation = (this._generation || 0) + 1;
    this._context  = new Float32Array(CONTEXT_SIZE);
    this._rnnState = new Float32Array(2 * 1 * 128);
  }

  // samples: Float32Array de exactamente WINDOW_SIZE_SAMPLES (512) valores
  // en [-1, 1]. Llamar en orden -- no es seguro saltar bloques (ver
  // comentario de arriba, el modelo es stateful).
  async predict(samples) {
    const myGeneration = this._generation;
    const input = new Float32Array(CONTEXT_SIZE + WINDOW_SIZE_SAMPLES);
    input.set(this._context, 0);
    input.set(samples, CONTEXT_SIZE);

    const out = await this._session.run({
      input: new ort.Tensor('float32', input, [1, CONTEXT_SIZE + WINDOW_SIZE_SAMPLES]),
      state: new ort.Tensor('float32', this._rnnState, [2, 1, 128]),
      sr:    this._srTensor,
    });

    // Si reset() corrió mientras este predict estaba en vuelo, myGeneration
    // quedó vieja -- este resultado se calculó sobre contexto que ya no
    // corresponde (de antes del corte real de audio). Se descarta: ni se
    // pisa el estado recién limpiado, ni se devuelve un score que mezclaría
    // audio de dos streams distintos.
    if (myGeneration !== this._generation) return 0;

    this._rnnState = out.stateN.data;
    this._context  = input.slice(-CONTEXT_SIZE);
    return out.output.data[0]; // probabilidad de voz, 0-1
  }
}

module.exports = { VadModel, WINDOW_SIZE_SAMPLES };
