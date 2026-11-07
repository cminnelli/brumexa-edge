// Graba la pregunta que decís después de "hey brumexa", mientras la sesión
// se conecta de fondo. El monitor de mic en reposo (startMicMonitor en
// server.js) ya está andando y caliente: le pasa cada chunk a feed(), y acá
// se guarda desde un poco antes del wake (por si lo dijiste de corrido:
// "hey brumexa, ¿dónde queda…") hasta que dejás de hablar (800 ms de silencio: con 500 cortaba en "dónde…").
//
//   feed(chunk)  → siempre (en reposo y escuchando): PCM 16 bits mono 16 kHz
//   start(opts)  → empieza a grabar; avisa onDone(pcm) o onNoSpeech()
//   cancel()     → descarta lo grabado
//   isActive()
//
// Cuándo hablaste y cuándo terminaste lo decide el mismo gate que usa toda
// la Pi (lib/mic-speech-gate.js, lo alimenta el monitor cada ~100 ms).
'use strict';
const micGate = require('./mic-speech-gate');

const RATE = 16000;
const BYTES_PER_MS = RATE * 2 / 1000;

// Voz que sigue más de esto después del wake = estás preguntando (la cola
// del propio "hey brumexa" termina antes).
const AFTER_WAKE_MS = 350;

let ring = [], ringBytes = 0;   // lo último que oyó el mic, para el audio previo
let cur = null;                 // grabación en curso
let _lookbackBytes = 250 * BYTES_PER_MS;

function feed(chunk) {
  if (cur) {
    cur.chunks.push(chunk);
    cur.bytes += chunk.length;
    _check();
    return;
  }
  ring.push(chunk);
  ringBytes += chunk.length;
  while (ring.length > 1 && ringBytes - ring[0].length >= _lookbackBytes) {
    ringBytes -= ring.shift().length;
  }
}

function start({ lookbackMs = 250, waitMs = 6000, endSilenceMs = 800, maxMs = 15000, onSpeech, onDone, onNoSpeech }) {
  cancel();
  _lookbackBytes = lookbackMs * BYTES_PER_MS;
  // Audio previo: los últimos lookbackMs del ring.
  const chunks = [];
  let bytes = 0;
  for (let i = ring.length - 1; i >= 0 && bytes < _lookbackBytes; i--) { chunks.unshift(ring[i]); bytes += ring[i].length; }
  ring = []; ringBytes = 0;
  const startedAt = Date.now();
  cur = { chunks, bytes, startedAt, heard: false, endSilenceMs, onSpeech, onDone, onNoSpeech, timers: [] };
  // Sin voz en waitMs → se vuelve a dormir. Tope de largo de la pregunta.
  cur.timers.push(setTimeout(() => { if (cur && !cur.heard) _finish(false); }, waitMs));
  cur.timers.push(setTimeout(() => { if (cur) _finish(true); }, maxMs));
}

function _check() {
  const lastVoice = micGate.getLastVoiceAt();
  if (!cur.heard) {
    if (lastVoice > cur.startedAt + AFTER_WAKE_MS) { cur.heard = true; cur.onSpeech?.(); }
    return;
  }
  if (Date.now() - lastVoice >= cur.endSilenceMs) _finish(true);
}

function _finish(ok) {
  const c = cur;
  cur = null;
  for (const t of c.timers) clearTimeout(t);
  if (ok && c.heard) c.onDone?.(Buffer.concat(c.chunks, c.bytes));
  else c.onNoSpeech?.();
}

function cancel() {
  if (!cur) return;
  for (const t of cur.timers) clearTimeout(t);
  cur = null;
}

module.exports = { feed, start, cancel, isActive: () => !!cur, RATE };
