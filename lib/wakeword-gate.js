'use strict';

/**
 * lib/wakeword-gate.js
 *
 * Detector de wake word "ei brúmexa" — misma forma que lib/clap-connect.js:
 * expone feed()/onWake()/setEnabled()/getEnabled() y no sabe nada de
 * sesiones ni de LiveKit, solo avisa cuando detecta.
 *
 * feed(chunk) se llama con el mismo PCM crudo (S16_LE, 16kHz) que ya recibe
 * el monitor de mic idle en server.js — no abre ningún mic nuevo.
 *
 * El modelo (wakeword/wakeword-model.js) es "stateless": necesita ~2
 * segundos de audio por llamada, no alcanza con un chunk suelto. Por eso acá
 * se mantiene una ventana rodante de los últimos 2s y se evalúa cada vez que
 * llega audio nuevo.
 */

const path = require('path');
const { WakeWordModel } = require('../wakeword/wakeword-model');

const SAMPLE_RATE     = 16000;
const WINDOW_SAMPLES  = SAMPLE_RATE * 2; // 2 segundos — lo que pide el modelo
const THRESHOLD       = 0.32;  // threshold óptimo que encontró el entrenamiento
const COOLDOWN_MS     = 3000;  // no repetir la detección mientras el score sigue alto

// WAKEWORD_ENABLED en .env — default true, apagable en caliente sin deploy
// nuevo (mismo criterio que CLAP_CONNECT_ENABLED).
let _armed        = process.env.WAKEWORD_ENABLED !== 'false';
let _onWakeFn      = null;
let _modelPromise  = null;
let _busy          = false;
let _lastTriggerAt = 0;
const _buffer      = new Int16Array(WINDOW_SAMPLES);

function onWake(fn)        { _onWakeFn = fn; }
function setEnabled(v)     { _armed = !!v; }
function getEnabled()      { return _armed; }

function _loadModel() {
  if (!_modelPromise) {
    _modelPromise = (async () => {
      const model = new WakeWordModel();
      const modelsDir = path.join(__dirname, '..', 'wakeword', 'models');
      await model.load({
        melPath:        path.join(modelsDir, 'melspectrogram.onnx'),
        embeddingPath:  path.join(modelsDir, 'embedding_model.onnx'),
        classifierPath: path.join(modelsDir, 'hey_brumexa.onnx'),
      });
      console.log('[wakeword-gate] modelo cargado');
      return model;
    })();
  }
  return _modelPromise;
}

// Mete `incoming` (Int16Array) al final del buffer de 2s, tirando lo más
// viejo — un buffer circular simple hecho a mano con copyWithin/set.
function _pushToBuffer(incoming) {
  const keep = WINDOW_SAMPLES - incoming.length;
  _buffer.copyWithin(0, incoming.length);
  _buffer.set(incoming, keep);
}

// Llamar con cada chunk de PCM crudo (Buffer, S16_LE) — mismo lugar donde ya
// se llama micGate.feed()/clapConnect.feed() en el monitor de mic idle.
function feed(chunk) {
  if (!_armed || _busy) return;

  const samples  = chunk.length / 2;
  const incoming = new Int16Array(chunk.buffer, chunk.byteOffset, samples);
  _pushToBuffer(incoming);

  _busy = true;
  _loadModel()
    .then((model) => model.predict(_buffer))
    .then((score) => {
      const now = Date.now();
      if (score > THRESHOLD && now - _lastTriggerAt > COOLDOWN_MS) {
        _lastTriggerAt = now;
        console.log(`[wakeword-gate] "ei brúmexa" detectado (score=${score.toFixed(3)})`);
        if (_onWakeFn) {
          try { _onWakeFn(); } catch (e) { console.warn('[wakeword-gate] callback error:', e.message); }
        }
      }
    })
    .catch((e) => console.warn('[wakeword-gate] error prediciendo:', e.message))
    .finally(() => { _busy = false; });
}

module.exports = { feed, onWake, setEnabled, getEnabled };
