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

// Streaming (feed): el mel usa ventanas de 512 muestras con paso de 160
// (10ms), sin padding. Un pedazo de 1280 muestras (80ms) + 480 de contexto
// del pedazo anterior da EXACTAMENTE 8 frames nuevos (= EMBEDDING_STRIDE),
// idénticos a los que salen calculando la ventana entera de una — medido
// contra predict(), diferencia ~1e-4 (ruido de float). Así cada 80ms de
// audio produce 1 embedding nuevo, sin huecos ni frames repetidos.
const CHUNK_SAMPLES = 1280;
const MEL_CONTEXT   = 480;

// Sin esto, onnxruntime usa TODOS los núcleos del chip para cada corrida —
// en una Pi Zero 2W (4 núcleos) eso deja al hilo principal (audio, LEDs,
// HTTP) sin margen real de CPU aunque el modelo corra en un worker thread
// aparte. Un solo núcleo alcanza de sobra para este modelo chico, y deja el
// resto libre para todo lo demás. Mismo criterio que ya usa la versión
// Python de referencia (livekit-wakeword) al cargar el clasificador ONNX.
const SESSION_OPTIONS = { executionMode: 'sequential', intraOpNumThreads: 1, interOpNumThreads: 1 };

class WakeWordModel {
  async load({ melPath, embeddingPath, classifierPath }) {
    this._mel = await ort.InferenceSession.create(melPath, SESSION_OPTIONS);
    this._embedding = await ort.InferenceSession.create(embeddingPath, SESSION_OPTIONS);
    this._classifier = await ort.InferenceSession.create(classifierPath, SESSION_OPTIONS);
    this.reset();
  }

  // Olvida todo el audio anterior — llamar cuando el stream se corta (arecord
  // nuevo), para no mezclar audio viejo con el nuevo en la misma ventana.
  reset() {
    this._pending = new Float32Array(0);           // muestras que todavía no llegan a un pedazo entero
    this._context = new Float32Array(MEL_CONTEXT); // cola del pedazo anterior (arranca en silencio)
    this._melRows = [];                            // últimos EMBEDDING_WINDOW frames
    this._embeddings = [];                         // últimos MIN_EMBEDDINGS embeddings
  }

  // STREAMING — lo que usa la Pi. Recibe audio NUEVO (cualquier largo) y
  // devuelve un score por cada pedazo completo de 80ms procesado. Por
  // pedazo solo corre 1 mel chico + 1 embedding + el clasificador, en vez
  // de recalcular 2s enteros (16 embeddings) como predict(): en la Pi Zero
  // eso tardaba ~680ms y obligaba a evaluar cada ~800ms, salteándose el
  // instante justo en que la frase cae bien en la ventana.
  async feed(audioInt16) {
    const merged = new Float32Array(this._pending.length + audioInt16.length);
    merged.set(this._pending);
    for (let i = 0; i < audioInt16.length; i++) merged[this._pending.length + i] = audioInt16[i] / 32768;

    const scores = [];
    let offset = 0;
    for (; offset + CHUNK_SAMPLES <= merged.length; offset += CHUNK_SAMPLES) {
      const input = new Float32Array(MEL_CONTEXT + CHUNK_SAMPLES);
      input.set(this._context);
      input.set(merged.subarray(offset, offset + CHUNK_SAMPLES), MEL_CONTEXT);
      this._context = input.slice(input.length - MEL_CONTEXT);

      this._melRows.push(...await this._runMel(input));
      if (this._melRows.length > EMBEDDING_WINDOW) this._melRows.splice(0, this._melRows.length - EMBEDDING_WINDOW);

      if (this._melRows.length === EMBEDDING_WINDOW) {
        this._embeddings.push(await this._runEmbedding(this._melRows));
        if (this._embeddings.length > MIN_EMBEDDINGS) this._embeddings.shift();
      }
      scores.push(this._embeddings.length === MIN_EMBEDDINGS ? await this._runClassifier(this._embeddings) : 0);
    }
    this._pending = merged.slice(offset);
    return scores;
  }

  // REFERENCIA — versión "stateless" original (ventana de ~2s entera por
  // llamada, igual que la clase Python de livekit-wakeword). La Pi ya no la
  // usa (ver feed()); queda para comparar que feed() da lo mismo.
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

module.exports = { WakeWordModel, CHUNK_SAMPLES };
