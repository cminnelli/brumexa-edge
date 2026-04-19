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

  // Un único WebSocketServer sin path — routing interno por pathname.
  // Usar dos WSS con path distinto en el mismo httpServer hace que el primero
  // llame socket.destroy() para paths que no le corresponden (bug ws v8).
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ws/audio' || pathname === '/ws/speaker') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const url      = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/ws/audio') {
      // ── Mic: arecord → PCM → browser ────────────────────────────────────
      const device = url.searchParams.get('device') || 'plughw:0,0';
      console.log(`[audio] ▶ /ws/audio conectado — device: ${device}  MIC_GAIN: ${MIC_GAIN}x`);

      // Matar arecords zombi antes de spawnear (evita "device busy")
      try { execSync('pkill -9 arecord 2>/dev/null || true', { timeout: 1000 }); } catch {}

      const proc = spawn('arecord', ['-D', device, '-f', FORMAT, '-r', String(SAMPLE_RATE), '-c', String(CHANNELS), '-t', 'raw']);
      console.log(`[audio]   arecord PID: ${proc.pid}`);

      let bytesIn = 0;
      let chunks  = 0;
      let peak    = 0;
      proc.stdout.on('data', (chunk) => {
        bytesIn += chunk.length;
        chunks++;
        // Medir peak para saber si arecord está capturando silencio o audio real
        for (let i = 0; i + 1 < chunk.length; i += 2) {
          const s = Math.abs(chunk.readInt16LE(i));
          if (s > peak) peak = s;
        }
        if (ws.readyState === ws.OPEN) ws.send(applyGain(chunk, MIC_GAIN));
      });
      proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.error('[arecord]', m); });
      proc.on('error', (err) => {
        console.error(`[audio] ✘ arecord PID ${proc.pid} error:`, err.message);
        if (ws.readyState === ws.OPEN) ws.close(1011, err.message);
      });
      proc.on('exit', (code, sig) => console.log(`[audio] arecord PID ${proc.pid} salió — code: ${code}  signal: ${sig}`));

      const stats = setInterval(() => {
        if (chunks === 0) return;
        const peakDb = peak > 0 ? (20 * Math.log10(peak / 32768)).toFixed(1) : '−∞';
        console.log(`[audio] /ws/audio — ${chunks} chunks / ${bytesIn} B  peak: ${peak} (${peakDb} dBFS)`);
        bytesIn = 0; chunks = 0; peak = 0;
      }, 2000);

      ws.on('close', () => {
        clearInterval(stats);
        console.log(`[audio] /ws/audio cerrado — matando arecord PID ${proc.pid}`);
        try { proc.kill('SIGTERM'); } catch {}
      });

    } else if (pathname === '/ws/speaker') {
      // ── Speaker: browser → PCM → aplay ──────────────────────────────────
      const device   = url.searchParams.get('device')   || 'plughw:0,0';
      const rate     = url.searchParams.get('rate')      || '48000';
      const channels = url.searchParams.get('channels')  || '1';
      console.log(`[audio] ▶ /ws/speaker conectado — device: ${device}  rate: ${rate}  ch: ${channels}`);

      // Matar aplays zombi antes de spawnear (incluye /recordings/play y /ws/speaker previos)
      try { execSync('pkill -9 aplay 2>/dev/null || true', { timeout: 1000 }); } catch {}

      const proc = spawn('aplay', ['-D', device, '-f', FORMAT, '-r', rate, '-c', channels, '-t', 'raw', '-']);
      console.log(`[audio]   aplay PID: ${proc.pid}`);

      proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.error('[aplay]', m); });
      proc.on('error', (err) => {
        console.error(`[audio] ✘ aplay PID ${proc.pid} error:`, err.message);
        if (ws.readyState === ws.OPEN) ws.close(1011, err.message);
      });
      proc.on('exit', (code, sig) => console.log(`[audio] aplay PID ${proc.pid} salió — code: ${code}  signal: ${sig}`));
      proc.stdin.on('error', (err) => console.warn('[audio] aplay stdin error:', err.message));

      let bytesOut   = 0;
      let chunks     = 0;
      let chunkCount = 0;
      let peak       = 0;
      ws.on('message', (data) => {
        if (proc.stdin.writable) {
          proc.stdin.write(data);
          bytesOut += data.length;
          chunks++;
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          for (let i = 0; i + 1 < buf.length; i += 2) {
            const s = Math.abs(buf.readInt16LE(i));
            if (s > peak) peak = s;
          }
          if (++chunkCount === 1) console.log(`[audio] /ws/speaker ← primer chunk (${data.length} B) → aplay stdin`);
        } else {
          console.warn(`[audio] /ws/speaker — aplay stdin no writable, dropping ${data.length} B`);
        }
      });

      const stats = setInterval(() => {
        if (chunks === 0) {
          console.log(`[audio] /ws/speaker — 0 chunks en 2s (no llega audio del browser)`);
          return;
        }
        const peakDb = peak > 0 ? (20 * Math.log10(peak / 32768)).toFixed(1) : '−∞';
        console.log(`[audio] /ws/speaker — ${chunks} chunks / ${bytesOut} B  peak: ${peak} (${peakDb} dBFS)`);
        bytesOut = 0; chunks = 0; peak = 0;
      }, 2000);

      ws.on('close', () => {
        clearInterval(stats);
        console.log(`[audio] /ws/speaker cerrado — total chunks: ${chunkCount}  — cerrando aplay PID ${proc.pid}`);
        proc.stdin.end();
        setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 500);
      });
    }
  });

  console.log('[audio] Listo — /audio-devices, /audio-playback-devices, /ws/audio, /ws/speaker');
}

module.exports = { setupAudio, getMicGain, setMicGain };
