'use strict';

/**
 * wakeword/wakeword-model.js
 *
 * La matemática del detector de wake word: audio crudo -> mel-spectrogram ->
 * embeddings en ventanas deslizantes -> clasificador -> score (0-1).
 *
 * Reimplementa acá, en JS, exactamente lo que en Windows hacía la clase
 * Python WakeWordModel de livekit-wakeword (los mismos 3 modelos ONNX, en el
 * mismo orden) — así el comportamiento es idéntico al que ya se probó ahí.
 * Este archivo no sabe nada de mic, de Brumexa, ni de sesiones — solo hace
 * la cuenta. Ver lib/wakeword-gate.js para el enganche con el resto de la app.
 */

const ort = require('onnxruntime-node');

const EMBEDDING_WINDOW = 76; // frames de mel por ventana de embedding
const EMBEDDING_STRIDE = 8;  // paso entre ventanas
const MIN_EMBEDDINGS = 16;   // cuántos embeddings necesita el clasificador
const MEL_BINS = 32;

class WakeWordModel {
  async load({ melPath, embeddingPath, classifierPath }) {
    this._mel = await ort.InferenceSession.create(melPath);
    this._embedding = await ort.InferenceSession.create(embeddingPath);
    this._classifier = await ort.InferenceSession.create(classifierPath);
  }

  // audioInt16: Int16Array de ~2 segundos a 16kHz. El modelo es "stateless"
  // (sin memoria entre llamadas) — una ventana corta simplemente da 0, igual
  // que en la versión Python.
  async predict(audioInt16) {
    const audioFloat = new Float32Array(audioInt16.length);
    for (let i = 0; i < audioInt16.length; i++) audioFloat[i] = audioInt16[i] / 32768;

    const mel = await this._runMel(audioFloat); // array de filas Float32Array(32)
    if (mel.length < EMBEDDING_WINDOW) return 0;

    const embeddings = [];
    for (let start = 0; start + EMBEDDING_WINDOW <= mel.length; start += EMBEDDING_STRIDE) {
      embeddings.push(await this._runEmbedding(mel.slice(start, start + EMBEDDING_WINDOW)));
    }
    if (embeddings.length < MIN_EMBEDDINGS) return 0;

    return this._runClassifier(embeddings.slice(-MIN_EMBEDDINGS));
  }

  async _runMel(audioFloat) {
    const inputName = this._mel.inputNames[0];
    const tensor = new ort.Tensor('float32', audioFloat, [1, audioFloat.length]);
    const out = await this._mel.run({ [inputName]: tensor });
    const outTensor = out[this._mel.outputNames[0]];

    // Salida real del modelo: (1, 1, timeFrames, 32) — los dos últimos ejes
    // son los que importan, no dependen de cuántos "1" haya adelante porque
    // un tensor ONNX es row-major (esos ejes de tamaño 1 no corren el buffer).
    const dims = outTensor.dims;
    const timeFrames = dims[dims.length - 2];
    const data = outTensor.data;

    const mel = [];
    for (let t = 0; t < timeFrames; t++) {
      const row = new Float32Array(MEL_BINS);
      for (let m = 0; m < MEL_BINS; m++) {
        // Post-proceso x/10 + 2 — mismo ajuste que hace la versión Python
        // para llevar la escala de dB al rango que espera el embedding.
        row[m] = data[t * MEL_BINS + m] / 10 + 2;
      }
      mel.push(row);
    }
    return mel;
  }

  async _runEmbedding(window) {
    // window: 76 filas de 32 valores -> tensor (1, 76, 32, 1)
    const flat = new Float32Array(EMBEDDING_WINDOW * MEL_BINS);
    for (let f = 0; f < EMBEDDING_WINDOW; f++) flat.set(window[f], f * MEL_BINS);

    const inputName = this._embedding.inputNames[0];
    const tensor = new ort.Tensor('float32', flat, [1, EMBEDDING_WINDOW, MEL_BINS, 1]);
    const out = await this._embedding.run({ [inputName]: tensor });
    return out[this._embedding.outputNames[0]].data; // 96 valores
  }

  async _runClassifier(embeddings) {
    // embeddings: 16 vectores de 96 -> tensor (1, 16, 96)
    const embDim = embeddings[0].length;
    const flat = new Float32Array(MIN_EMBEDDINGS * embDim);
    for (let i = 0; i < MIN_EMBEDDINGS; i++) flat.set(embeddings[i], i * embDim);

    const inputName = this._classifier.inputNames[0];
    const tensor = new ort.Tensor('float32', flat, [1, MIN_EMBEDDINGS, embDim]);
    const out = await this._classifier.run({ [inputName]: tensor });
    return out[this._classifier.outputNames[0]].data[0];
  }
}

module.exports = { WakeWordModel };
