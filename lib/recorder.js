'use strict';

const { spawn, execSync } = require('child_process');
const path                = require('path');
const fs                  = require('fs');
const os                  = require('os');

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

function nextFilename(source, ext = 'wav') {
  _counter++;
  return `${HOSTNAME}_${source}_${_counter}.${ext}`;
}

// ─── Aplicar ganancia digital a un archivo WAV S16_LE ────────────────────────
// Busca el chunk "data" leyendo los chunks RIFF en lugar de asumir offset 44,
// porque algunos builds de arecord añaden chunks extra (LIST, INFO…) antes de data.
function applyGainToWav(filePath, gain) {
  if (!gain || gain <= 1.0) return;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 12) return;

    // Verificar firma RIFF / WAVE
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      console.warn(`[recorder] ${path.basename(filePath)} no es WAV válido, gain omitido`);
      return;
    }

    // Recorrer chunks hasta encontrar "data"
    let dataOffset = -1;
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const chunkId   = buf.toString('ascii', pos, pos + 4);
      const chunkSize = buf.readUInt32LE(pos + 4);
      if (chunkId === 'data') { dataOffset = pos + 8; break; }
      pos += 8 + chunkSize + (chunkSize % 2); // los chunks WAV son padding par
    }

    if (dataOffset < 0) {
      console.warn(`[recorder] Chunk "data" no encontrado en ${path.basename(filePath)}`);
      return;
    }

    // 1ª pasada: encontrar el pico real en el archivo
    let peak = 0;
    for (let i = dataOffset; i + 1 < buf.length; i += 2) {
      const s = Math.abs(buf.readInt16LE(i));
      if (s > peak) peak = s;
    }

    // Si el archivo está completamente en silencio, no hacer nada
    if (peak === 0) {
      console.log(`[recorder] Audio en silencio — gain omitido → ${path.basename(filePath)}`);
      return;
    }

    // Ganancia total = gain fijo + normalización al 85% del máximo
    // La normalización sube el volumen hasta que el pico quede en 0.85 * 32767
    const normGain   = (32767 * 0.85) / peak;
    const totalGain  = Math.min(gain * normGain, 64); // cap en 64x para no amplificar solo ruido
    console.log(`[recorder] peak: ${peak}  gain: ${gain}x  normGain: ${normGain.toFixed(2)}x  total: ${totalGain.toFixed(2)}x (${(20 * Math.log10(totalGain)).toFixed(1)} dB) → ${path.basename(filePath)}`);

    // 2ª pasada: aplicar ganancia total
    for (let i = dataOffset; i + 1 < buf.length; i += 2) {
      const s = buf.readInt16LE(i);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * totalGain))), i);
    }
    fs.writeFileSync(filePath, buf);
  } catch (err) {
    console.error(`[recorder] Error aplicando gain a ${path.basename(filePath)}: ${err.message}`);
  }
}

// ─── Maximizar gain de captura ALSA (best-effort) ────────────────────────────
function boostCaptureGain() {
  try {
    const controls = execSync('amixer scontrols 2>/dev/null', { timeout: 2000, encoding: 'utf8' });
    for (const line of controls.split('\n')) {
      const m = line.match(/Simple mixer control '([^']+)'/);
      if (!m) continue;
      const name = m[1];
      // Subir controles de captura / ADC / Mic al máximo
      if (/Capture|ADC|Mic/i.test(name)) {
        try {
          execSync(`amixer sset '${name}' 100% cap 2>/dev/null`, { timeout: 1000 });
          console.log(`[recorder] amixer: '${name}' → 100% cap`);
        } catch { /* control no soporta ese flag */ }
      }
    }
  } catch {
    // amixer no disponible o no es Linux — ignorar
  }
}

// ─── ALSA: grabación server-side con arecord ──────────────────────────────────
function startRecording(device = 'default') {
  if (_proc) throw new Error('Ya hay una grabación en curso');

  // Maximizar gain antes de grabar
  boostCaptureGain();

  _filename  = nextFilename('alsa');
  const dest = path.join(RECORDINGS_DIR, _filename);

  console.log(`[recorder] ▶ ALSA  device="${device}"  →  ${_filename}`);

  _proc = spawn('arecord', [
    '-D', device,
    '-f', FORMAT,
    '-r', String(SAMPLE_RATE),
    '-c', String(CHANNELS),
    dest,
  ]);
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
    console.log(`[recorder] arecord terminó (código ${code}) → ${path.basename(dest)}`);
    _proc = null;
    // _filename lo dejamos hasta que stopRecording lo limpie, así el cliente
    // puede recuperar el archivo aunque arecord haya salido antes de stop.

    // Aplicar la misma ganancia digital que el stream WebSocket
    const MIC_GAIN = parseFloat(process.env.MIC_GAIN) || 4.0;
    applyGainToWav(dest, MIC_GAIN);
  });

  return { filename: _filename, source: 'alsa', device, startedAt: _startedAt };
}

function stopRecording() {
  // arecord puede haber salido solo (error de dispositivo, etc.)
  // en ese caso _proc=null pero _filename sigue seteado — igual devolvemos el archivo
  if (!_proc && !_filename) throw new Error('No hay grabación ALSA en curso');

  const result = {
    filename: _filename,
    source:   'alsa',
    duration: _startedAt ? Math.round((Date.now() - _startedAt) / 1000) : 0,
    path:     path.join(RECORDINGS_DIR, _filename),
  };

  if (_proc) {
    // SIGINT: arecord lo maneja limpiamente → cierra el WAV con el header correcto.
    // SIGTERM no finaliza el header → aplay luego se cuelga con el archivo corrupto.
    _proc.kill('SIGINT');
    _proc = null;
  }
  _filename  = null;
  _startedAt = null;

  console.log(`[recorder] ⏹ ALSA  ${result.filename}  (${result.duration}s)`);
  return result;
}

// ─── Browser: el cliente graba con MediaRecorder y sube el blob ───────────────
function reserveBrowserFilename() {
  // .webm — MediaRecorder en Chrome/Firefox emite WebM/Opus, no WAV real
  const name = nextFilename('browser', 'webm');
  console.log(`[recorder] ▶ Browser  reservado nombre: ${name}`);
  return name;
}

function saveBrowserRecording(filename, buffer) {
  // Validar que el nombre es uno nuestro (evita path traversal)
  if (!/^[a-z0-9-]+_browser_\d+\.(wav|webm)$/.test(filename)) {
    throw new Error(`Nombre de archivo inválido: "${filename}"`);
  }
  const dest = path.join(RECORDINGS_DIR, filename);
  fs.writeFileSync(dest, buffer);
  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`[recorder] ✔ Browser  guardado: ${filename}  (${kb} KB)`);
  return { filename, source: 'browser', path: dest };
}

// ─── Eliminar grabación ───────────────────────────────────────────────────────
function deleteRecording(filename) {
  if (!/^[a-z0-9-]+_(alsa|browser)_\d+\.(wav|webm)$/.test(filename)) {
    throw new Error(`Nombre de archivo inválido: "${filename}"`);
  }
  const dest = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(dest)) throw new Error('Archivo no encontrado');
  fs.unlinkSync(dest);
  console.log(`[recorder] 🗑 Eliminado: ${filename}`);
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
    .filter(f => f.endsWith('.wav') || f.endsWith('.webm'))
    .map(f => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return { filename: f, size: stat.size, created: stat.birthtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

module.exports = {
  startRecording, stopRecording, getStatus, listRecordings,
  reserveBrowserFilename, saveBrowserRecording, deleteRecording,
  RECORDINGS_DIR,
};
