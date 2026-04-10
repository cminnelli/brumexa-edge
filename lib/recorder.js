'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log('[recorder] Carpeta creada:', RECORDINGS_DIR);
}

const SAMPLE_RATE = 16000;
const CHANNELS    = 1;
const FORMAT      = 'S16_LE';

// Hostname limpio para el nombre de archivo
const HOSTNAME = os.hostname().replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

// Contador secuencial por sesión
let _counter   = 0;
let _proc      = null;
let _filename  = null;
let _startedAt = null;

function nextFilename(source) {
  _counter++;
  return `${HOSTNAME}_${source}_${_counter}.wav`;
}

// ─── ALSA: grabación server-side con arecord ──────────────────────────────────
function startRecording(device = 'default') {
  if (_proc) throw new Error('Ya hay una grabación en curso');

  _filename  = nextFilename('alsa');
  const dest = path.join(RECORDINGS_DIR, _filename);

  console.log(`[recorder] ▶ ALSA  device="${device}"  →  ${_filename}`);

  _proc = spawn('arecord', ['-D', device, '-f', FORMAT, '-r', String(SAMPLE_RATE), '-c', String(CHANNELS), dest]);
  _startedAt = Date.now();

  _proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log('[arecord]', msg);
  });
  _proc.on('error', (err) => {
    console.error('[recorder] Error arecord:', err.message);
    _proc = null; _filename = null; _startedAt = null;
  });
  _proc.on('close', (code) => {
    console.log(`[recorder] arecord terminó (código ${code}) → ${_filename}`);
    _proc = null;
  });

  return { filename: _filename, source: 'alsa', device, startedAt: _startedAt };
}

function stopRecording() {
  if (!_proc) throw new Error('No hay grabación ALSA en curso');

  const result = {
    filename: _filename,
    source:   'alsa',
    duration: Math.round((Date.now() - _startedAt) / 1000),
    path:     path.join(RECORDINGS_DIR, _filename),
  };

  _proc.kill('SIGTERM');
  _proc = null; _filename = null; _startedAt = null;

  console.log(`[recorder] ⏹ ALSA  ${result.filename}  (${result.duration}s)`);
  return result;
}

// ─── Browser: el cliente graba con MediaRecorder y sube el blob ───────────────
function reserveBrowserFilename() {
  const name = nextFilename('browser');
  console.log(`[recorder] ▶ Browser  reservado nombre: ${name}`);
  return name;
}

function saveBrowserRecording(filename, buffer) {
  // Validar que el nombre es uno nuestro (evita path traversal)
  if (!/^[a-z0-9-]+_browser_\d+\.wav$/.test(filename)) {
    throw new Error('Nombre de archivo inválido');
  }
  const dest = path.join(RECORDINGS_DIR, filename);
  fs.writeFileSync(dest, buffer);
  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`[recorder] ✔ Browser  guardado: ${filename}  (${kb} KB)`);
  return { filename, source: 'browser', path: dest };
}

// ─── Estado y listado ─────────────────────────────────────────────────────────
function getStatus() {
  return {
    recording: !!_proc,
    filename:  _filename,
    source:    _filename ? 'alsa' : null,
    duration:  _startedAt ? Math.round((Date.now() - _startedAt) / 1000) : 0,
  };
}

function listRecordings() {
  return fs.readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.wav'))
    .map(f => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return { filename: f, size: stat.size, created: stat.birthtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

module.exports = {
  startRecording, stopRecording, getStatus, listRecordings,
  reserveBrowserFilename, saveBrowserRecording,
  RECORDINGS_DIR,
};
