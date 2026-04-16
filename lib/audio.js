'use strict';

/**
 * lib/audio.js
 *
 * Lista dispositivos ALSA, streamea PCM via WebSocket al browser (mic),
 * y recibe PCM del browser para reproducirlo con aplay (speaker).
 */

const { execSync, spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const SAMPLE_RATE = 16000;
const CHANNELS    = 1;
const FORMAT      = 'S16_LE';

// Ganancia digital aplicada al PCM antes de enviarlo al browser.
// 4.0 = +12 dB. Configurable con MIC_GAIN en .env o via POST /config/mic-gain.
let MIC_GAIN = parseFloat(process.env.MIC_GAIN) || 4.0;

function getMicGain()      { return MIC_GAIN; }
function setMicGain(value) {
  const v = parseFloat(value);
  if (!isNaN(v) && v >= 1 && v <= 32) {
    MIC_GAIN = v;
    console.log(`[audio] MIC_GAIN actualizado → ${MIC_GAIN}x (${(20 * Math.log10(MIC_GAIN)).toFixed(1)} dB)`);
  }
}

function applyGain(chunk, gain) {
  if (gain === 1.0) return chunk;
  const samples = chunk.byteLength >>> 1;
  const out     = Buffer.allocUnsafe(chunk.byteLength);
  for (let i = 0; i < samples; i++) {
    const s = chunk.readInt16LE(i * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * gain))), i * 2);
  }
  return out;
}

// ─── Listar dispositivos de captura ALSA ─────────────────────────────────────
// Parsea la salida de "arecord -l" con operaciones de string simples.
// Confirmado que funciona con: card 0: sndrpigooglevoi [snd_rpi_googlevoicehat_soundcar]
function listAlsaDevices() {
  let out;
  try {
    out = execSync('arecord -l 2>&1', { timeout: 3000 }).toString();
    console.log('[audio] arecord -l:\n' + out.trim());
  } catch {
    console.warn('[audio] arecord no disponible (no es Linux/Pi)');
    return [];
  }

  const devices = [];

  for (const line of out.split('\n')) {
    // Cada dispositivo empieza con "card N:"
    if (!line.startsWith('card ')) continue;

    // Número de card: "card 0: ..." → "0"
    const card = line.split(' ')[1].replace(':', '');

    // Número de device: "..., device 0: ..." → "0"
    const devPart  = line.split(', device ')[1] || '';
    const dev      = devPart.split(':')[0].trim();

    // Nombre legible: primer texto entre corchetes
    const match = line.match(/\[([^\]]+)\]/);
    const name  = match ? match[1] : `card ${card} device ${dev}`;

    devices.push({
      id:   `plughw:${card},${dev}`,   // plughw acepta más formatos que hw
      name,
      card: Number(card),
      device: Number(dev),
    });
  }

  return devices;
}

// ─── Listar dispositivos de reproducción ALSA ────────────────────────────────
// Parsea "aplay -l" — misma lógica que listAlsaDevices pero para playback.
function listAlsaPlaybackDevices() {
  let out;
  try {
    out = execSync('aplay -l 2>&1', { timeout: 3000 }).toString();
    console.log('[audio] aplay -l:\n' + out.trim());
  } catch {
    console.warn('[audio] aplay no disponible (no es Linux/Pi)');
    return [];
  }

  const devices = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('card ')) continue;
    const card    = line.split(' ')[1].replace(':', '');
    const devPart = line.split(', device ')[1] || '';
    const dev     = devPart.split(':')[0].trim();
    const match   = line.match(/\[([^\]]+)\]/);
    const name    = match ? match[1] : `card ${card} device ${dev}`;
    devices.push({ id: `plughw:${card},${dev}`, name, card: Number(card), device: Number(dev) });
  }
  return devices;
}

// ─── Registrar endpoints en Express + WebSocket ───────────────────────────────
function setupAudio(app, httpServer) {

  // GET /audio-devices — lista de dispositivos ALSA de captura
  app.get('/audio-devices', (_req, res) => {
    const devices = listAlsaDevices();
    console.log(`[audio] /audio-devices → ${devices.length} dispositivo(s):`, devices.map(d => d.id));
    res.json({ devices });
  });

  // GET /audio-playback-devices — lista de dispositivos ALSA de reproducción
  app.get('/audio-playback-devices', (_req, res) => {
    const devices = listAlsaPlaybackDevices();
    console.log(`[audio] /audio-playback-devices → ${devices.length} dispositivo(s):`, devices.map(d => d.id));
    res.json({ devices });
  });

  // WebSocket /ws/audio?device=plughw:0,0
  // Spawnea arecord y envía PCM raw al browser
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/audio' });

  wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, 'http://localhost');
    const device = url.searchParams.get('device') || 'plughw:0,0';

    console.log(`[audio] Mic WS conectado — device: ${device}`);

    const proc = spawn('arecord', [
      '-D', device,
      '-f', FORMAT,
      '-r', String(SAMPLE_RATE),
      '-c', String(CHANNELS),
      '-t', 'raw',
    ]);

    console.log(`[audio] MIC_GAIN: ${MIC_GAIN}x (${(20 * Math.log10(MIC_GAIN)).toFixed(1)} dB)`);

    proc.stdout.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(applyGain(chunk, MIC_GAIN));
    });

    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[arecord]', msg);
    });

    proc.on('error', (err) => {
      console.error('[audio] Error al iniciar arecord:', err.message);
      if (ws.readyState === ws.OPEN) ws.close(1011, err.message);
    });

    ws.on('close', () => {
      console.log('[audio] Mic WS cerrado — deteniendo arecord');
      proc.kill('SIGTERM');
    });
  });

  // WebSocket /ws/speaker?device=plughw:0,0&rate=48000&channels=1
  // Recibe PCM Int16 del browser y lo reproduce con aplay en la Pi
  const wssSpeaker = new WebSocketServer({ server: httpServer, path: '/ws/speaker' });

  wssSpeaker.on('connection', (ws, req) => {
    const url      = new URL(req.url, 'http://localhost');
    const device   = url.searchParams.get('device')   || 'plughw:0,0';
    const rate     = url.searchParams.get('rate')      || '48000';
    const channels = url.searchParams.get('channels')  || '1';

    console.log(`[audio] Speaker WS conectado — device: ${device}  rate: ${rate}  ch: ${channels}`);

    const proc = spawn('aplay', [
      '-D', device,
      '-f', FORMAT,
      '-r', rate,
      '-c', channels,
      '-t', 'raw',
      '-',              // leer de stdin
    ]);

    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[aplay]', msg);
    });

    proc.on('error', (err) => {
      console.error('[audio] Error al iniciar aplay:', err.message);
      if (ws.readyState === ws.OPEN) ws.close(1011, err.message);
    });

    // Evitar crash si el pipe se rompe antes de que se escriba
    proc.stdin.on('error', (err) => {
      console.warn('[audio] aplay stdin error:', err.message);
    });

    let chunkCount = 0;
    ws.on('message', (data) => {
      if (proc.stdin.writable) {
        proc.stdin.write(data);
        chunkCount++;
        if (chunkCount === 1) {
          console.log(`[audio] Speaker — primer chunk recibido (${data.length} bytes)`);
        }
      }
    });

    ws.on('close', () => {
      console.log(`[audio] Speaker WS cerrado — chunks: ${chunkCount} — deteniendo aplay`);
      proc.stdin.end();
      // Dar 500 ms para que aplay vacíe el buffer antes de matar
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 500);
    });
  });

  console.log('[audio] Listo — /audio-devices, /audio-playback-devices, /ws/audio, /ws/speaker');
}

module.exports = { setupAudio, getMicGain, setMicGain };
