'use strict';

/**
 * lib/wakeword-gate.js
 *
 * Detector de wake word "ei brúmexa" — expone feed()/onWake()/setEnabled()/
 * getEnabled() y no sabe nada de sesiones ni de LiveKit, solo avisa cuando
 * detecta.
 *
 * feed(chunk) se llama con el mismo PCM crudo (S16_LE, 16kHz) que ya recibe
 * el monitor de mic idle en server.js — no abre ningún mic nuevo.
 *
 * El modelo corre en un WORKER THREAD aparte (wakeword/wakeword-worker.js),
 * no en este hilo, para no robarle CPU al hilo principal (HTTP, audio, LEDs).
 *
 * STREAMING: cada pedazo de 80ms de audio se le manda al worker UNA vez, en
 * orden, y el modelo guarda estado entre pedazos (ver feed() en
 * wakeword-model.js). Antes se le mandaba una foto de los últimos 2s cada
 * ~400ms y el modelo recalculaba todo de cero: en la Pi tardaba ~680ms, así
 * que en la práctica evaluaba cada ~800ms — y la frase solo da score alto
 * durante ~400ms (cuando cae justo al final de la ventana), así que muchas
 * veces el instante justo quedaba ENTRE dos evaluaciones y no se detectaba.
 * Medido en /diagnostico y reproducido en PC con audio de prueba.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { CHUNK_SAMPLES } = require('../wakeword/wakeword-model');

const SAMPLE_RATE     = 16000;
const CHUNK_BYTES     = CHUNK_SAMPLES * 2; // 80ms de PCM S16_LE
const THRESHOLD       = 0.32;  // threshold óptimo que encontró el entrenamiento
const COOLDOWN_MS     = 3000;  // no repetir la detección mientras el score sigue alto

// Si el worker se atrasa (está procesando mientras sigue llegando audio), el
// PCM se acumula acá y se manda todo junto en el próximo mensaje. Topado a
// 2s: si el worker va TAN atrasado, mejor tirar lo más viejo (y contarlo como
// audio perdido en el diagnóstico) que acumular un delay creciente.
const MAX_BACKLOG_BYTES = SAMPLE_RATE * 2 * 2;

// Si el worker no contesta un predict en este tiempo, lo damos por colgado
// (no crasheado — el proceso sigue vivo pero no responde) y lo matamos a
// mano. Sin esto, un cuelgue deja _busy trabado en true para siempre y la
// detección queda muerta en silencio, sin ningún log.
const PREDICT_TIMEOUT_MS = 8000;

// Cap de reinicios seguidos del worker — si algo lo hace crashear en loop
// (modelo corrupto, etc.) no queremos quemar CPU reabriéndolo sin parar.
const RESPAWN_WINDOW_MS       = 60000;
const MAX_RESPAWNS_PER_WINDOW = 5;
const RESPAWN_COOLDOWN_MS     = 30000;

// WAKEWORD_ENABLED en .env — default false, prendible desde /configuracion
// (ver el checkbox "Conectar diciendo..."), aplicado en caliente sin
// reiniciar el proceso.
let _armed        = process.env.WAKEWORD_ENABLED === 'true';
let _onWakeFn      = null;
let _worker        = null;
let _workerReady   = false;
let _busy          = false;
let _lastTriggerAt = 0;
let _backlog       = Buffer.alloc(0);

// Diagnóstico (ver /diag/wakeword-history en server.js) — antes solo se
// logueaba cuando el score pasaba el umbral, así que un "lo dije y no lo
// tomó" no dejaba NINGÚN rastro: no había forma de saber si el modelo dio
// 0.30 (casi), 0.02 (ni se enteró) o si directamente no evaluó ese tramo
// de audio. Acá se guarda CADA mensaje al worker (score = el máximo de los
// pedazos de 80ms que llevaba). t = cuándo se mandó.
// Memoria acotada: además del recorte por tiempo (HISTORY_MS), cada lista
// tiene un tope fijo por cantidad — a ~8 mensajes/s el historial anda en
// ~480 entradas (~50KB); MAX_HISTORY es solo un techo de seguridad por si
// el ritmo cambia. Todo se recorta al AGREGAR, no al leer: si nadie abre
// /diagnostico en días, igual no crece.
const HISTORY_MS     = 60000;
const MAX_HISTORY    = 1000;
const MAX_DETECTIONS = 20;
const MAX_DROPS      = 100;
let _history         = []; // [{ t, score, inferMs, roundtripMs, audioMs }, ...] ordenado por tiempo
let _detections      = []; // [{ t, score }, ...] las últimas MAX_DETECTIONS
let _drops           = []; // [{ t, ms }, ...] audio tirado por backlog lleno, último minuto
let _evalStartedAt   = 0;

let _predictTimeoutTimer = null;
let _respawnCount        = 0;
let _respawnWindowStart  = 0;
let _respawnBlockedUntil = 0;

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
  if (Date.now() < _respawnBlockedUntil) return; // en cooldown por crash-loop

  const modelsDir = path.join(__dirname, '..', 'wakeword', 'models');
  const worker = new Worker(path.join(__dirname, '..', 'wakeword', 'wakeword-worker.js'), {
    workerData: {
      melPath:        path.join(modelsDir, 'melspectrogram.onnx'),
      embeddingPath:  path.join(modelsDir, 'embedding_model.onnx'),
      classifierPath: path.join(modelsDir, 'hey_brumexa.onnx'),
    },
  });
  _worker = worker;

  worker.on('message', (msg) => {
    if (_worker !== worker) return; // evento de un worker ya reemplazado

    if (msg.type === 'ready') {
      _workerReady = true;
      console.log('[wakeword-gate] worker listo (modelo cargado en hilo aparte, streaming de a 80ms)');
      _sendBacklog(worker);
      return;
    }

    if (msg.type === 'score') {
      _clearPredictTimeout();
      _busy = false;
      const now = Date.now();
      const score = msg.scores.length ? Math.max(...msg.scores) : 0;
      _history.push({ t: _evalStartedAt, score, inferMs: msg.inferMs, roundtripMs: now - _evalStartedAt, audioMs: msg.scores.length * 80 });
      while (_history.length && (_history[0].t < now - HISTORY_MS || _history.length > MAX_HISTORY)) _history.shift();
      if (score > THRESHOLD && now - _lastTriggerAt > COOLDOWN_MS) {
        _lastTriggerAt = now;
        _detections.push({ t: _evalStartedAt, score });
        if (_detections.length > MAX_DETECTIONS) _detections.shift();
        console.log(`[wakeword-gate] "ei brúmexa" detectado (score=${score.toFixed(3)})`);
        if (_onWakeFn) {
          try { _onWakeFn(); } catch (e) { console.warn('[wakeword-gate] callback error:', e.message); }
        }
      }
      _sendBacklog(worker);
      return;
    }

    if (msg.type === 'error') {
      _clearPredictTimeout();
      _busy = false;
      console.warn('[wakeword-gate] error en el worker:', msg.error);
      _sendBacklog(worker);
    }
  });

  worker.on('error', (e) => {
    if (_worker !== worker) return;
    console.warn('[wakeword-gate] el worker crasheó:', e.message);
    _teardownWorker(worker, `crash: ${e.message}`);
  });

  worker.on('exit', (code) => {
    if (_worker !== worker) return; // ya se limpió por 'error' — no duplicar
    if (code !== 0) console.warn(`[wakeword-gate] ⚠ worker terminó inesperadamente (code=${code})`);
    _teardownWorker(worker, `exit code=${code}`);
  });
}

function _clearPredictTimeout() {
  if (_predictTimeoutTimer) { clearTimeout(_predictTimeoutTimer); _predictTimeoutTimer = null; }
}

// Punto único de limpieza cuando un worker deja de servir (crash, exit
// inesperado, o timeout de predicción sin respuesta) — deja todo listo para
// que el próximo feed() respawnee uno nuevo, y nunca pisa un worker que ya
// fue reemplazado por una limpieza anterior.
function _teardownWorker(worker, reason) {
  if (_worker !== worker) return;
  _clearPredictTimeout();
  _worker      = null;
  _workerReady = false;
  _busy        = false;
  _backlog     = Buffer.alloc(0);
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
    console.warn(`[wakeword-gate] ⚠ demasiados reinicios del worker (${_respawnCount} en ${Math.round(RESPAWN_WINDOW_MS / 1000)}s) — pausando detección ${Math.round(RESPAWN_COOLDOWN_MS / 1000)}s`);
  }
}

// Manda al worker todo el audio acumulado que forme pedazos enteros de 80ms
// (el resto queda para el próximo). Se llama al llegar audio nuevo y cada
// vez que el worker termina, así nunca queda audio esperando de más.
function _sendBacklog(worker) {
  if (_busy || !_workerReady || _backlog.length < CHUNK_BYTES) return;

  const sendBytes = _backlog.length - (_backlog.length % CHUNK_BYTES);
  // Copia a un ArrayBuffer propio (no comparte memoria con _backlog ni con
  // el pool de Buffer) — se transfiere al worker sin volver a copiar.
  const pcm = new Int16Array(sendBytes / 2);
  Buffer.from(pcm.buffer).set(_backlog.subarray(0, sendBytes));
  _backlog = Buffer.from(_backlog.subarray(sendBytes));

  _busy = true;
  _evalStartedAt = Date.now();
  worker.postMessage({ type: 'feed', buffer: pcm.buffer }, [pcm.buffer]);

  _predictTimeoutTimer = setTimeout(() => {
    _predictTimeoutTimer = null;
    console.warn(`[wakeword-gate] ⚠ el worker no respondió en ${PREDICT_TIMEOUT_MS}ms — reiniciando`);
    _teardownWorker(worker, 'timeout');
  }, PREDICT_TIMEOUT_MS);
}

// Llamar con cada chunk de PCM crudo (Buffer, S16_LE) — mismo lugar donde ya
// se llama micGate.feed()/vadGate.feed() en el monitor de mic idle.
function feed(chunk) {
  if (!_armed) return;
  _ensureWorker();

  _backlog = _backlog.length ? Buffer.concat([_backlog, chunk]) : Buffer.from(chunk);

  // Backlog topado — un chunk enorme llega cuando el hilo principal estuvo
  // trabado varios segundos (arecord acumula en el pipe y entrega todo
  // junto; visto en producción durante un update, ~5.6s). Se tira lo más
  // viejo (múltiplo de 80ms, para no desalinear las muestras) y se cuenta.
  if (_backlog.length > MAX_BACKLOG_BYTES) {
    let drop = _backlog.length - MAX_BACKLOG_BYTES;
    drop += (CHUNK_BYTES - (drop % CHUNK_BYTES)) % CHUNK_BYTES;
    _backlog = Buffer.from(_backlog.subarray(drop));
    const now = Date.now();
    _drops.push({ t: now, ms: Math.round(drop / 2 / SAMPLE_RATE * 1000) });
    while (_drops.length && (_drops[0].t < now - HISTORY_MS || _drops.length > MAX_DROPS)) _drops.shift();
  }

  if (_worker) _sendBacklog(_worker);
}

// Stream de audio nuevo (arecord recién abierto) — el modelo olvida el
// audio anterior para no mezclarlo con el nuevo en la misma ventana.
function reset() {
  _backlog = Buffer.alloc(0);
  if (_worker && _workerReady) _worker.postMessage({ type: 'reset' });
}

// Volcado para /diag/wakeword-history — t relativo a "ahora" (ms atrás),
// mismo criterio que vad-gate.js getHistoryDump().
function getHistoryDump() {
  const now = Date.now();
  // Redondeado: el score con 3 decimales y los ms enteros alcanzan para
  // diagnosticar — los 16 decimales crudos duplicaban el tamaño del JSON
  // que /diagnostico pide cada segundo.
  return _history.map(h => ({
    msAgo:       now - h.t,
    score:       Math.round(h.score * 1000) / 1000,
    inferMs:     Math.round(h.inferMs),
    roundtripMs: h.roundtripMs,
    audioMs:     h.audioMs,
  }));
}

// Estado interno, para distinguir "el modelo dio bajo" de "el worker no
// estaba evaluando" (apagado, cargando, en cooldown de reinicios).
function getDebugState() {
  const now = Date.now();
  return {
    armed:               _armed,
    workerAlive:         !!_worker,
    workerReady:         _workerReady,
    busy:                _busy,
    respawnCount:        _respawnCount,
    cooldownRemainingMs: Math.max(0, _respawnBlockedUntil - now),
    threshold:           THRESHOLD,
    chunkMs:             Math.round(CHUNK_SAMPLES / SAMPLE_RATE * 1000),
    backlogMs:           Math.round(_backlog.length / 2 / SAMPLE_RATE * 1000),
    // Audio tirado en el último minuto porque el worker no daba abasto —
    // 0 = se evaluó todo el audio, sin huecos.
    droppedMsLastMinute: _drops.filter(d => d.t > now - HISTORY_MS).reduce((s, d) => s + d.ms, 0),
    detections:          _detections.map(d => ({ msAgo: now - d.t, score: d.score })),
  };
}

module.exports = { feed, reset, onWake, setEnabled, getEnabled, getHistoryDump, getDebugState };
