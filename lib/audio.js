'use strict';

/**
 * server/audio.js
 *
 * Captura audio desde dispositivos ALSA de la Raspberry Pi
 * y lo envía al navegador via WebSocket como PCM raw (S16_LE, 16kHz, mono).
 *
 * El browser procesa el PCM con un AudioWorklet (pcm-processor.js)
 * y lo publica en LiveKit como si fuera un micrófono local.
 */

const { spawn }            = require('child_process');
const { WebSocketServer }  = require('ws');

// ─── Parámetros de captura (deben coincidir con pcm-processor.js) ─────────────
const SAMPLE_RATE = 16000;
const CHANNELS    = 1;
const FORMAT      = 'S16_LE';

// ─── Listar dispositivos de captura ALSA ─────────────────────────────────────
// Lee /proc/asound/pcm directamente — sin parsear texto humano.
// Cada línea: "00-00: Nombre del dispositivo : Nombre largo : playback N : capture N"
// Usamos plughw: en lugar de hw: porque acepta más formatos de audio (ej: voiceHAT).
function listAlsaDevices() {
  try {
    const raw   = fs.readFileSync('/proc/asound/pcm', 'utf8').trim();
    console.log('[audio] /proc/asound/pcm:\n' + raw);

    return raw.split('\n').map((line) => {
      const parts  = line.split(':');
      const cardDev = parts[0].trim();              // "00-00"
      const name    = (parts[1] || '').trim();      // nombre del dispositivo
      const [card, device] = cardDev.split('-').map(Number);
      return {
        id:     `plughw:${card},${device}`,         // plughw: acepta más formatos
        card,
        device,
        name,
      };
    }).filter((d) => !isNaN(d.card));               // descartar líneas mal formateadas

  } catch {
    // /proc/asound/pcm no existe → no es Linux con ALSA (ej: PC de desarrollo)
    return [];
  }
}

// ─── Registrar endpoints en la app Express ────────────────────────────────────
function setupAudio(app, httpServer) {

  // GET /audio-devices — devuelve lista de dispositivos ALSA
  app.get('/audio-devices', (_req, res) => {
    const devices = listAlsaDevices();
    console.log(`[audio] /audio-devices → ${devices.length} dispositivo(s)`);
    res.json({ devices });
  });

  // WebSocket /ws/audio?device=hw:1,0
  // Spawnea arecord con el dispositivo pedido y streamea PCM al browser
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/audio' });

  wss.on('connection', (ws, req) => {
    const url    = new URL(req.url, 'http://localhost');
    const device = url.searchParams.get('device') || 'default';

    console.log(`[audio] WebSocket conectado — device: ${device}`);

    // Iniciar captura: raw PCM sin header WAV
    const proc = spawn('arecord', [
      '-D', device,
      '-f', FORMAT,
      '-r', String(SAMPLE_RATE),
      '-c', String(CHANNELS),
      '-t', 'raw',
    ]);

    // Cada chunk de PCM va directo al browser
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

    // Al cerrar el WebSocket, detener arecord
    ws.on('close', () => {
      console.log('[audio] WebSocket cerrado — deteniendo arecord');
      proc.kill('SIGTERM');
    });
  });

  console.log('[audio] Listo: /audio-devices y WebSocket /ws/audio');
}

module.exports = { setupAudio };
