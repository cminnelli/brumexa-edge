'use strict';

/**
 * lib/audio.js
 *
 * Lista dispositivos ALSA y streamea PCM via WebSocket al browser.
 * El browser lo publica en LiveKit usando un AudioWorklet.
 */

const { execSync, spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const SAMPLE_RATE = 16000;
const CHANNELS    = 1;
const FORMAT      = 'S16_LE';

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

// ─── Registrar endpoints en Express + WebSocket ───────────────────────────────
function setupAudio(app, httpServer) {

  // GET /audio-devices — lista de dispositivos ALSA disponibles
  app.get('/audio-devices', (_req, res) => {
    const devices = listAlsaDevices();
    console.log(`[audio] /audio-devices → ${devices.length} dispositivo(s):`, devices.map(d => d.id));
    res.json({ devices });
  });

  // WebSocket /ws/audio?device=plughw:0,0
  // Spawnea arecord y envía PCM raw al browser
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/audio' });

  wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, 'http://localhost');
    const device = url.searchParams.get('device') || 'plughw:0,0';

    console.log(`[audio] WebSocket conectado — device: ${device}`);

    const proc = spawn('arecord', [
      '-D', device,
      '-f', FORMAT,
      '-r', String(SAMPLE_RATE),
      '-c', String(CHANNELS),
      '-t', 'raw',
    ]);

    proc.stdout.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
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
      console.log('[audio] WebSocket cerrado — deteniendo arecord');
      proc.kill('SIGTERM');
    });
  });

  console.log('[audio] Listo — /audio-devices y WebSocket /ws/audio');
}

module.exports = { setupAudio };
