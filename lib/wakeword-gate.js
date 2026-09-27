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
 * El modelo corre en un WORKER THREAD aparte (wakeword/wakeword-worker.js),
 * no en este hilo. Una corrida completa del modelo puede tardar varios
 * segundos en una Pi Zero 2W — correrlo acá mismo bloqueaba TODO lo demás
 * (HTTP, audio, LEDs), confirmado en producción. El worker puede tardar lo
 * que tarde sin afectar al resto de la app.
 *
 * El modelo también es "stateless": necesita ~2 segundos de audio por
 * llamada, no alcanza con un chunk suelto. Por eso acá se mantiene una
 * ventana rodante de los últimos 2s.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const SAMPLE_RATE     = 16000;
const WINDOW_SAMPLES  = SAMPLE_RATE * 2; // 2 segundos — lo que pide el modelo
const THRESHOLD       = 0.32;  // threshold óptimo que encontró el entrenamiento
const COOLDOWN_MS     = 3000;  // no repetir la detección mientras el score sigue alto

// No tiene sentido pedirle al worker una predicción por cada chunk que llega
// del mic (cada 20-30ms) — una palabra tarda ~1s en decirse, evaluar cada
// 400ms sobra para pescarla sin saturarle la cola de mensajes al worker.
const EVAL_INTERVAL_MS = 400;

// WAKEWORD_ENABLED en .env — default false, prendible desde /configuracion
// (ver el checkbox "Conectar diciendo..."), aplicado en caliente sin
// reiniciar el proceso.
let _armed        = process.env.WAKEWORD_ENABLED === 'true';
let _onWakeFn      = null;
let _worker        = null;
let _workerReady   = false;
let _busy          = false;
let _lastEvalAt    = 0;
let _lastTriggerAt = 0;
const _buffer      = new Int16Array(WINDOW_SAMPLES);

function onWake(fn) { _onWakeFn = fn; }

function setEnabled(v) {
  _armed = !!v;
  if (_armed) _ensureWorker();
}

function getEnabled() { return _armed; }

// Arranca el worker la primera vez que hace falta (prendido por .env al
// boot, o por el toggle de /configuracion en caliente) — no antes, así no
// carga los modelos en memoria si el wake word nunca se usa.
function _ensureWorker() {
  if (_worker) return;

  const modelsDir = path.join(__dirname, '..', 'wakeword', 'models');
  _worker = new Worker(path.join(__dirname, '..', 'wakeword', 'wakeword-worker.js'), {
    workerData: {
      melPath:        path.join(modelsDir, 'melspectrogram.onnx'),
      embeddingPath:  path.join(modelsDir, 'embedding_model.onnx'),
      classifierPath: path.join(modelsDir, 'hey_brumexa.onnx'),
    },
  });

  _worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      _workerReady = true;
      console.log('[wakeword-gate] worker listo (modelo cargado en hilo aparte)');
      return;
    }

    if (msg.type === 'score') {
      _busy = false;
      const now = Date.now();
      if (msg.score > THRESHOLD && now - _lastTriggerAt > COOLDOWN_MS) {
        _lastTriggerAt = now;
        console.log(`[wakeword-gate] "ei brúmexa" detectado (score=${msg.score.toFixed(3)})`);
        if (_onWakeFn) {
          try { _onWakeFn(); } catch (e) { console.warn('[wakeword-gate] callback error:', e.message); }
        }
      }
      return;
    }

    if (msg.type === 'error') {
      _busy = false;
      console.warn('[wakeword-gate] error en el worker:', msg.error);
    }
  });

  _worker.on('error', (e) => {
    console.warn('[wakeword-gate] el worker crasheó:', e.message);
    _worker = null;
    _workerReady = false;
  });
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
  if (!_armed) return;
  _ensureWorker();

  // El buffer se actualiza siempre (es barato, solo copia memoria) para que
  // la ventana de 2s esté fresca — lo que se frena es PEDIRLE AL WORKER que
  // evalúe.
  const samples  = chunk.length / 2;
  const incoming = new Int16Array(chunk.buffer, chunk.byteOffset, samples);
  _pushToBuffer(incoming);

  if (!_workerReady) return; // todavía cargando los modelos, la primera vez

  const now = Date.now();
  if (_busy || now - _lastEvalAt < EVAL_INTERVAL_MS) return;
  _lastEvalAt = now;
  _busy = true;

  // Copia aparte (no el _buffer en sí, que se sigue mutando) — se transfiere
  // al worker sin copiar de nuevo (segundo argumento de postMessage).
  const snapshot = _buffer.slice();
  _worker.postMessage({ type: 'predict', buffer: snapshot.buffer }, [snapshot.buffer]);
}

module.exports = { feed, onWake, setEnabled, getEnabled };
