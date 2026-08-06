'use strict';

/**
 * scripts/test-wake-word.js
 *
 * Prueba lib/wake-word.js en la PC (Windows/Mac/Linux), sin la Raspberry.
 * Graba el mic de la PC con SoX y se lo pasa tal cual a wake-word.js — es
 * lo mismo que hace server.js con arecord en la Pi, solo que acá el que
 * graba es SoX (necesita SoX instalado y en el PATH).
 *
 * Uso:
 *   1. Completar WAKE_WORD_MODEL_PATH en .env (ver .env.example)
 *   2. node scripts/test-wake-word.js
 *   3. Decir la wake word cerca del mic
 */

require('dotenv').config();
const { spawn } = require('child_process');
const wakeWord  = require('../lib/wake-word');

wakeWord.start();

wakeWord.on('wake', () => {
  console.log('\n🎉 WAKE WORD DETECTADA — acá es donde arrancaría la sesión con LiveKit\n');
});

console.log('🎙  Escuchando con el mic de la PC (Ctrl+C para salir)…\n');

// Driver de audio de SoX según el sistema operativo.
const SOX_DRIVER = { win32: 'waveaudio', darwin: 'coreaudio', linux: 'alsa' }[process.platform] || 'alsa';

const mic = spawn('sox', [
  '-q', // sin barra de progreso — solo queremos los datos crudos
  '-t', SOX_DRIVER, 'default',
  '-r', '16000',
  '-c', '1',
  '-b', '16',
  '-e', 'signed-integer',
  '-t', 'raw', '-',
]);

mic.stdout.on('data', (chunk) => wakeWord.feed(chunk));
mic.stderr.on('data', (chunk) => console.error('[sox]', chunk.toString().trim()));
mic.on('error', (err) => console.error('[mic] no se pudo arrancar sox:', err.message));

process.on('SIGINT', () => {
  mic.kill();
  process.exit(0);
});
