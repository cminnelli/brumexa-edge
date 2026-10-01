'use strict';

/**
 * lib/vad-gate.js
 *
 * "¿Esto que se está escuchando es voz humana?" — Silero VAD corriendo en
 * un worker thread aparte (wakeword/vad-worker.js). Expone feed(chunk) +
 * getScore()/setEnabled()/getEnabled()/reset(), mismo estilo que
 * lib/wakeword-gate.js, pero sin cooldown/onWake: esto no dispara nada por
 * sí solo, solo mantiene viva una probabilidad de voz (0-1) actualizada en
 * vivo para que lib/mic-speech-gate.js la combine con su propio umbral de
 * volumen.
 *
 * A diferencia del wake word (ventana de 2s, evaluada cada 400ms), Silero
 * es STATEFUL y hay que alimentarlo con CADA bloque de 512 muestras
 * (32ms @16kHz) en orden, sin saltos — por eso acá no hay throttle de
 * "evaluar cada tanto": se junta el PCM en bloques exactos y se procesan
 * todos, uno detrás del otro.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { WINDOW_SIZE_SAMPLES } = require('../wakeword/vad-model');

const WINDOW_BYTES = WINDOW_SIZE_SAMPLES * 2; // Int16 = 2 bytes/muestra

// Mismos valores que wakeword-gate.js, mismo motivo: un cuelgue o un
// crash no deben dejar esto trabado para siempre.
const PREDICT_TIMEOUT_MS      = 2000; // cada predict es chico (32ms de audio) — si tarda esto, algo anda mal
const RESPAWN_WINDOW_MS       = 60000;
const MAX_RESPAWNS_PER_WINDOW = 5;
const RESPAWN_COOLDOWN_MS     = 30000;

// Si el worker se queda atrás (predict en curso mientras sigue llegando
// audio), el PCM sin procesar se acumula acá — backlog chico a propósito
// (10 bloques = 320ms): si el worker está realmente colgado, mejor perder
// un poco de continuidad del VAD que acumular un delay creciente sin
// límite. El timeout/respawn de arriba se encarga del caso "colgado de
// verdad".
const MAX_BACKLOG_WINDOWS = 10;

let _armed            = false;
let _worker            = null;
let _workerReady       = false;
let _busy              = false;
let _score             = 0;
let _pcmBacklog        = Buffer.alloc(0);

let _predictTimeoutTimer = null;
let _respawnCount        = 0;
let _respawnWindowStart  = 0;
let _respawnBlockedUntil = 0;

function setEnabled(v) {
  _armed = !!v;
  if (_armed) _ensureWorker();
}

function getEnabled() { return _armed; }

// Probabilidad de voz (0-1) de la última ventana procesada — 0 si todavía
// no hay ninguna (recién prendido, o worker cargando el modelo).
function getScore() { return _score; }

// true solo si el worker está vivo y listo para procesar — quien use este
// gate como condición extra (ver mic-speech-gate.js) tiene que chequear
// esto PRIMERO: si el VAD no está disponible por cualquier motivo (worker
// cargando, crasheado y en cooldown, modelo no encontrado, etc.), hay que
// seguir funcionando solo con volumen como antes, nunca quedar "sordo" del
// todo esperando una confirmación que no va a llegar.
function isReady() { return _armed && _workerReady && Date.now() >= _respawnBlockedUntil; }

// Limpia el estado interno del modelo (contexto + RNN) y el backlog —
// llamar cada vez que arranca un arecord nuevo (idle monitor o sesión real),
// para no arrastrar contexto de un stream de audio que ya se cortó.
function reset() {
  _pcmBacklog = Buffer.alloc(0);
  if (_worker && _workerReady) _worker.postMessage({ type: 'reset' });
}

function _ensureWorker() {
  if (_worker) return;
  if (Date.now() < _respawnBlockedUntil) return;

  const modelPath = path.join(__dirname, '..', 'wakeword', 'models', 'silero_vad.onnx');
  const worker = new Worker(path.join(__dirname, '..', 'wakeword', 'vad-worker.js'), {
    workerData: { modelPath },
  });
  _worker = worker;

  worker.on('message', (msg) => {
    if (_worker !== worker) return;

    if (msg.type === 'ready') {
      _workerReady = true;
      console.log('[vad-gate] worker listo (Silero VAD cargado en hilo aparte)');
      _drainBacklog(worker);
      return;
    }

    if (msg.type === 'score') {
      _clearPredictTimeout();
      _busy = false;
      _score = msg.score;
      _drainBacklog(worker);
      return;
    }

    if (msg.type === 'error') {
      _clearPredictTimeout();
      _busy = false;
      console.warn('[vad-gate] error en el worker:', msg.error);
      _drainBacklog(worker);
    }
  });

  worker.on('error', (e) => {
    if (_worker !== worker) return;
    console.warn('[vad-gate] el worker crasheó:', e.message);
    _teardownWorker(worker, `crash: ${e.message}`);
  });

  worker.on('exit', (code) => {
    if (_worker !== worker) return;
    if (code !== 0) console.warn(`[vad-gate] ⚠ worker terminó inesperadamente (code=${code})`);
    _teardownWorker(worker, `exit code=${code}`);
  });
}

function _clearPredictTimeout() {
  if (_predictTimeoutTimer) { clearTimeout(_predictTimeoutTimer); _predictTimeoutTimer = null; }
}

function _teardownWorker(worker, reason) {
  if (_worker !== worker) return;
  _clearPredictTimeout();
  _worker        = null;
  _workerReady   = false;
  _busy          = false;
  _pcmBacklog    = Buffer.alloc(0);
  _score         = 0;
  worker.terminate().catch(() => {});
  _registerRespawnAttempt();
}

function _registerRespawnAttempt() {
  const now = Date.now();
  if (now - _respawnWindowStart > RESPAWN_WINDOW_MS) {
    _respawnWindowStart = now;
    _respawnCount = 0;
  }
  _respawnCount++;
  if (_respawnCount > MAX_RESPAWNS_PER_WINDOW) {
    _respawnBlockedUntil = now + RESPAWN_COOLDOWN_MS;
    console.warn(`[vad-gate] ⚠ demasiados reinicios del worker (${_respawnCount} en ${Math.round(RESPAWN_WINDOW_MS / 1000)}s) — pausando ${Math.round(RESPAWN_COOLDOWN_MS / 1000)}s`);
  }
}

// Si hay un bloque completo esperando y el worker está libre, lo manda.
// Se llama después de cada respuesta del worker (para seguir vaciando el
// backlog) y después de cada feed() nuevo.
function _drainBacklog(worker) {
  if (_busy || !_workerReady) return;
  if (_pcmBacklog.length < WINDOW_BYTES) return;

  const windowBuf = _pcmBacklog.subarray(0, WINDOW_BYTES);
  _pcmBacklog = Buffer.from(_pcmBacklog.subarray(WINDOW_BYTES)); // copia — subarray comparte memoria con el buffer viejo

  const samples = new Int16Array(windowBuf.buffer, windowBuf.byteOffset, WINDOW_SIZE_SAMPLES);
  const floatSamples = new Float32Array(WINDOW_SIZE_SAMPLES);
  for (let i = 0; i < WINDOW_SIZE_SAMPLES; i++) floatSamples[i] = samples[i] / 32768;

  _busy = true;
  worker.postMessage({ type: 'predict', buffer: floatSamples.buffer }, [floatSamples.buffer]);

  _predictTimeoutTimer = setTimeout(() => {
    _predictTimeoutTimer = null;
    console.warn(`[vad-gate] ⚠ el worker no respondió en ${PREDICT_TIMEOUT_MS}ms — reiniciando`);
    _teardownWorker(worker, 'timeout');
  }, PREDICT_TIMEOUT_MS);
}

// Llamar con cada chunk de PCM crudo (Buffer, S16_LE, 16kHz) — mismo lugar
// donde ya se llama wakewordGate.feed()/micGate.feed().
function feed(chunk) {
  if (!_armed) return;
  _ensureWorker();

  _pcmBacklog = _pcmBacklog.length ? Buffer.concat([_pcmBacklog, chunk]) : Buffer.from(chunk);

  // Backlog topado — si el worker viene atrás hace rato, preferible perder
  // continuidad (tirar lo más viejo) que acumular delay sin límite. El
  // timeout/respawn de más arriba cubre el caso "colgado de verdad"; esto
  // cubre el caso más benigno "va unos bloques atrás nomás".
  const maxBytes = MAX_BACKLOG_WINDOWS * WINDOW_BYTES;
  if (_pcmBacklog.length > maxBytes) {
    _pcmBacklog = Buffer.from(_pcmBacklog.subarray(_pcmBacklog.length - maxBytes));
  }

  if (!_workerReady || !_worker) return;
  _drainBacklog(_worker);
}

module.exports = { feed, getScore, isReady, setEnabled, getEnabled, reset };
