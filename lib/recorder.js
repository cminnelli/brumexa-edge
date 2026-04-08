'use strict';

/**
 * lib/recorder.js
 *
 * Graba audio desde un dispositivo ALSA usando arecord y guarda
 * el archivo WAV en la carpeta recordings/ del proyecto.
 *
 * Solo funciona cuando hay un dispositivo ALSA disponible (Raspberry Pi).
 * En PC de desarrollo el módulo carga igual pero los endpoints devuelven error claro.
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

// Carpeta donde se guardan las grabaciones (relativa a la raíz del proyecto)
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');

// Asegurar que la carpeta existe al cargar el módulo
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log('[recorder] Carpeta creada:', RECORDINGS_DIR);
}

// Parámetros de grabación
const SAMPLE_RATE = 16000;
const CHANNELS    = 1;
const FORMAT      = 'S16_LE';

// Estado interno — solo una grabación a la vez
let _proc     = null;
let _filename = null;
let _startedAt = null;

// ─── Iniciar grabación ────────────────────────────────────────────────────────
function startRecording(device = 'default') {
  if (_proc) throw new Error('Ya hay una grabación en curso');

  // Nombre de archivo con timestamp: rec_2026-04-08_15-30-00.wav
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  _filename  = `rec_${ts}.wav`;
  const dest = path.join(RECORDINGS_DIR, _filename);

  console.log(`[recorder] Iniciando grabación → ${_filename}  device: ${device}`);

  _proc = spawn('arecord', [
    '-D', device,
    '-f', FORMAT,
    '-r', String(SAMPLE_RATE),
    '-c', String(CHANNELS),
    dest,   // arecord escribe WAV directamente al path
  ]);

  _startedAt = Date.now();

  _proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log('[arecord]', msg);
  });

  _proc.on('error', (err) => {
    console.error('[recorder] Error al iniciar arecord:', err.message);
    _proc = null; _filename = null; _startedAt = null;
  });

  _proc.on('close', (code) => {
    console.log(`[recorder] arecord terminó (código ${code}) → ${_filename}`);
    _proc = null;
  });

  return { filename: _filename, device, startedAt: _startedAt };
}

// ─── Detener grabación ────────────────────────────────────────────────────────
function stopRecording() {
  if (!_proc) throw new Error('No hay grabación en curso');

  const result = {
    filename:  _filename,
    duration:  Math.round((Date.now() - _startedAt) / 1000),
    path:      path.join(RECORDINGS_DIR, _filename),
  };

  _proc.kill('SIGTERM');
  _proc      = null;
  _filename  = null;
  _startedAt = null;

  console.log(`[recorder] Grabación detenida → ${result.filename}  (${result.duration}s)`);
  return result;
}

// ─── Estado actual ────────────────────────────────────────────────────────────
function getStatus() {
  return {
    recording: !!_proc,
    filename:  _filename,
    duration:  _startedAt ? Math.round((Date.now() - _startedAt) / 1000) : 0,
  };
}

// ─── Listar grabaciones guardadas ─────────────────────────────────────────────
function listRecordings() {
  const files = fs.readdirSync(RECORDINGS_DIR)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return {
        filename: f,
        size:     stat.size,
        created:  stat.birthtime.toISOString(),
      };
    })
    .sort((a, b) => b.created.localeCompare(a.created));  // más recientes primero

  return files;
}

module.exports = { startRecording, stopRecording, getStatus, listRecordings, RECORDINGS_DIR };
