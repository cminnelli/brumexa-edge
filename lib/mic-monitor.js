'use strict';

/**
 * lib/mic-monitor.js
 *
 * Captura el mic en modo "idle" y reparte ese mismo audio a dos
 * consumidores: el nivel para los LEDs y la wake word — un solo proceso de
 * captura, nunca dos peleando por el mismo dispositivo de audio.
 *
 * En la Raspberry real usa "arecord" (ALSA). Para poder probar la wake
 * word en una PC de desarrollo (Windows/Mac) sin esperar a la Pi, usa
 * "sox" ahí en su lugar — mismo audio, misma lógica, distinta herramienta
 * de captura según el sistema.
 *
 * No sabe nada de LiveKit ni de sesiones — solo "escuchar el mic y avisar
 * nivel + alimentar la wake word". Quien lo usa decide cuándo pararlo
 * (ej. al conectar una sesión) y cuándo reanudarlo (al terminarla).
 */

const { spawn } = require('child_process');
const wakeWord   = require('./wake-word');
const leds       = require('./leds');
const { session: lkSession } = require('./livekit-session');

const MIC_DEVICE = process.env.MIC_DEVICE || 'plughw:0,0';

// Driver de SoX según el sistema — solo se usa fuera de Linux (dev/test).
const SOX_DRIVER = { win32: 'waveaudio', darwin: 'coreaudio' }[process.platform] || 'alsa';

// Devuelve { cmd, args } para capturar 16kHz/mono/S16LE crudo del mic,
// según la plataforma — arecord en la Pi real, sox en PC de desarrollo.
function captureCommand() {
  if (process.platform === 'linux') {
    return { cmd: 'arecord', args: ['-D', MIC_DEVICE, '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q'] };
  }
  return {
    cmd: 'sox',
    args: ['-q', '-t', SOX_DRIVER, 'default', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-'],
  };
}

let _proc  = null;
let _level = { level: 0, peak: 0, updatedAt: 0 };

// Arranca la captura de audio. Respeta el toggle manual "Mic desactivado"
// (/configuracion) — si está apagado, no abre ningún proceso.
function start() {
  if (!lkSession.getMicEnabled()) return;
  if (_proc) return;

  const { cmd, args } = captureCommand();
  const proc = spawn(cmd, args);
  let peak = 0;
  let last = Date.now();

  proc.stdout.on('data', (chunk) => {
    wakeWord.feed(chunk);
    for (let i = 0; i < chunk.length - 1; i += 2) {
      const s = Math.abs(chunk.readInt16LE(i));
      if (s > peak) peak = s;
    }
    if (Date.now() - last > 100) {
      const level = peak / 32767;
      leds.speaking(level);
      _level = { level, peak, updatedAt: Date.now() };
      peak = 0;
      last = Date.now();
    }
  });
  proc.on('error', (err) => console.warn(`[mic-monitor] no se pudo arrancar "${cmd}":`, err.message));
  _proc = proc;
  console.log(`[mic-monitor] iniciado (${cmd})`);
}

function stop() {
  if (!_proc) return Promise.resolve();
  const proc = _proc;
  _proc = null;
  console.log('[mic-monitor] detenido');
  const gone = new Promise((r) => proc.once('close', r));
  try { proc.kill('SIGTERM'); } catch {}
  return Promise.race([gone, new Promise((r) => setTimeout(r, 800))]);
}

function getLevel() {
  return { ..._level, active: !!_proc };
}

module.exports = { start, stop, getLevel };
