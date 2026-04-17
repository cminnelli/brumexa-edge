'use strict';

require('dotenv').config();

const http    = require('http');
const express = require('express');
const path    = require('path');
const os      = require('os');

const { setupAudio, getMicGain, setMicGain }            = require('./lib/audio');
const { startRecording, stopRecording, getStatus,
        listRecordings, RECORDINGS_DIR,
        reserveBrowserFilename, saveBrowserRecording,
        deleteRecording } = require('./lib/recorder');
const { setupBluetooth }                               = require('./lib/bluetooth');
const { setupWifi, autoStartAP }                       = require('./lib/wifi');

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_AGENT_NAME = 'brumexa-agent',
  LIVEKIT_ROOM_NAME = 'brumexa-room',
  TOKEN_API_URL,
  BRUMEXA_API_KEY,
  PORT = 3000,
} = process.env;

if (!TOKEN_API_URL) {
  console.warn('[warn] TOKEN_API_URL no configurado. El endpoint /token no funcionará.');
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();
// ─── Log de cada petición HTTP ────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── GET / ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── GET /config — info del dispositivo y configuración (sin secretos) ───────
app.get('/config', (_req, res) => {
  res.json({
    livekitUrl:         LIVEKIT_URL || null,
    tokenApiConfigured: !!TOKEN_API_URL,
    port:               Number(PORT),
    micGain:            getMicGain(),
    server: {
      hostname: os.hostname(),
      platform: process.platform,
      arch:     os.arch(),
      uptime:   Math.floor(process.uptime()),
    },
  });
});

// ─── GET /debug — info completa del dispositivo para diagnóstico ─────────────
app.get('/debug', (_req, res) => {
  const { execSync } = require('child_process');
  const info = {
    platform: process.platform,
    arch:     os.arch(),
    hostname: os.hostname(),
    isLinux:  process.platform === 'linux',
  };

  // ALSA
  try {
    info.arecord = execSync('arecord -l 2>&1', { timeout: 3000 }).toString().trim();
  } catch (e) { info.arecord = `ERROR: ${e.message}`; }

  // Bluetooth
  try {
    info.bluetoothDevices = execSync('bluetoothctl devices Paired 2>&1', { timeout: 4000 }).toString().trim();
  } catch {
    try {
      info.bluetoothDevices = execSync("echo -e 'paired-devices\\nquit' | bluetoothctl 2>&1", { timeout: 4000, shell: true }).toString().trim();
    } catch (e) { info.bluetoothDevices = `ERROR: ${e.message}`; }
  }

  // BT connected
  try {
    info.bluetoothConnected = execSync("bluetoothctl devices Connected 2>&1", { timeout: 3000 }).toString().trim();
  } catch (e) { info.bluetoothConnected = `ERROR: ${e.message}`; }

  res.json(info);
});

// ─── GET /livekit-health — verifica que el host LiveKit responde ──────────────
app.get('/livekit-health', async (_req, res) => {
  if (!LIVEKIT_URL) return res.json({ online: false, reason: 'no-config' });

  const httpUrl = LIVEKIT_URL.replace(/^wss?:\/\//, 'https://');
  const t0      = Date.now();

  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 5000);
    await fetch(httpUrl, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    res.json({ online: true, latency: Date.now() - t0 });
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    res.json({ online: false, latency: Date.now() - t0, reason: timedOut ? 'timeout' : err.message });
  }
});

// ─── GET /token — pide el token al servidor central y lo reenvía al cliente ──
app.get('/token', async (_req, res) => {
  if (!TOKEN_API_URL) {
    return res.status(503).json({ error: 'TOKEN_API_URL no configurado en .env' });
  }

  // Identificar el dispositivo para el servidor central
  const arch        = os.arch();
  const isArm       = /arm/i.test(arch);
  const deviceType  = process.platform === 'linux' && isArm ? 'raspberry' : 'pc';
  const deviceId    = os.hostname();

  console.log(`[token] → POST ${TOKEN_API_URL}  device=${deviceType}  id=${deviceId}`);

  try {
    const response = await fetch(TOKEN_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BRUMEXA_API_KEY && { 'x-api-key': BRUMEXA_API_KEY }),
      },
      body: JSON.stringify({ deviceType, deviceId }),
    });

    const rawText = await response.text();
    console.log(`[token] ← HTTP ${response.status}  body: ${rawText}`);

    if (!response.ok) {
      return res.status(502).json({ error: `Servidor central respondió ${response.status}`, detail: rawText });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error('[token] Respuesta no es JSON válido');
      return res.status(502).json({ error: 'Respuesta inválida del servidor central' });
    }

    if (!data.token) {
      console.error('[token] Respuesta sin campo "token":', data);
      return res.status(502).json({ error: 'El servidor central no devolvió token' });
    }

    // El servidor central devuelve: { token, url, roomName, participantName, ... }
    const result = {
      token:    data.token,
      room:     data.roomName       || LIVEKIT_ROOM_NAME,
      identity: data.participantName || deviceId,
      livekitUrl: data.url          || LIVEKIT_URL,
      expiresIn:  data.expiresIn    || '?',
    };
    console.log(`[token] OK`);
    console.log(`         room       → ${result.room}`);
    console.log(`         identity   → ${result.identity}`);
    console.log(`         livekit    → ${result.livekitUrl}`);
    console.log(`         expiresIn  → ${result.expiresIn}`);
    res.json(result);

  } catch (err) {
    console.error('[token] Error de red contactando servidor central:', err.message);
    res.status(500).json({ error: 'No se pudo contactar al servidor central', detail: err.message });
  }
});

// ─── GET /config/mic-gain — ganancia actual del mic en vivo ──────────────────
app.get('/config/mic-gain', (_req, res) => {
  res.json({ gain: getMicGain() });
});

// ─── POST /config/mic-gain — actualizar ganancia del mic en vivo ──────────────
app.post('/config/mic-gain', express.json(), (req, res) => {
  const gain = parseFloat(req.body?.gain);
  if (isNaN(gain) || gain < 1 || gain > 32) {
    return res.status(400).json({ ok: false, error: 'gain debe ser un número entre 1 y 32' });
  }
  setMicGain(gain);
  res.json({ ok: true, gain: getMicGain() });
});

// ─── POST /record/start — iniciar grabación en la Pi ─────────────────────────
app.post('/record/start', express.json(), (req, res) => {
  try {
    const device     = req.body?.device     || 'default';
    const normTarget = parseFloat(req.body?.normTarget);
    const info       = startRecording(device, isNaN(normTarget) ? 0.85 : Math.min(Math.max(normTarget, 0.3), 1.0));
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

// ─── POST /record/stop — detener grabación en curso ──────────────────────────
app.post('/record/stop', (_req, res) => {
  try {
    const info = stopRecording();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

// ─── GET /record/status — estado de la grabación actual ──────────────────────
app.get('/record/status', (_req, res) => {
  res.json(getStatus());
});

// ─── GET /recordings — listar archivos grabados ───────────────────────────────
app.get('/recordings', (_req, res) => {
  res.json({ files: listRecordings() });
});

// ─── POST /record/reserve-browser — reservar nombre para grabación del browser ─
app.post('/record/reserve-browser', (_req, res) => {
  const filename = reserveBrowserFilename();
  res.json({ ok: true, filename });
});

// ─── POST /record/upload — recibir blob WAV del browser ──────────────────────
app.post('/record/upload/:filename', (req, res) => {
  const filename = req.params.filename;
  const chunks   = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);
      const result = saveBrowserRecording(filename, buffer);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
});

// ─── DELETE /recordings/:file — eliminar grabación ───────────────────────────
app.delete('/recordings/:file', (req, res) => {
  const name = req.params.file.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  try {
    deleteRecording(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── GET /recordings/:file — servir archivo de audio (streaming + descarga) ───
app.get('/recordings/:file', (req, res) => {
  const name     = req.params.file.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const filePath = path.join(RECORDINGS_DIR, name);
  const mime     = name.endsWith('.webm') ? 'audio/webm' : 'audio/wav';

  // sendFile soporta range requests (necesario para que el <audio> del browser funcione bien)
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(filePath, { root: '/' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Archivo no encontrado' });
  });
});

// ─── Reproducción de grabaciones en la Pi ────────────────────────────────────
const { spawn } = require('child_process');
let _playProc   = null;
let _playResult = null;  // { exitCode, stderr, filename } — resultado del último aplay

// Mata el aplay en curso y espera que realmente muera (máx. 1.5 s)
function killAplay() {
  if (!_playProc) return Promise.resolve();
  const proc = _playProc;
  _playProc  = null;
  const gone = new Promise(r => proc.once('close', r));
  try { proc.kill('SIGTERM'); } catch {}
  // timeout de seguridad: si en 1.5 s no murió, continuamos igual
  return Promise.race([gone, new Promise(r => setTimeout(r, 1500))]);
}

// POST /recordings/play — espera que el aplay previo muera antes de iniciar uno nuevo
app.post('/recordings/play', express.json(), async (req, res) => {
  const { filename, device = 'plughw:0,0' } = req.body || {};
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ ok: false, error: 'filename requerido' });
  }
  const safeName = filename.replace(/[^a-zA-Z0-9_\-\. ]/g, '');
  const filePath = path.join(RECORDINGS_DIR, safeName);

  await killAplay(); // espera que el anterior muera

  _playResult = null;
  const proc  = spawn('aplay', ['-D', device, filePath]);
  _playProc   = proc;
  console.log(`[play] aplay -D ${device} ${safeName}`);

  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) { console.error('[aplay]', msg); stderrBuf += msg + '\n'; }
  });
  proc.on('error', err => {
    console.error('[play] aplay error:', err.message);
    if (_playProc === proc) { _playProc = null; _playResult = { exitCode: -1, stderr: err.message, filename: safeName }; }
  });
  proc.on('close', code => {
    console.log(`[play] aplay exited code ${code}`);
    if (_playProc === proc) {
      _playProc   = null;
      _playResult = { exitCode: code, stderr: stderrBuf.trim(), filename: safeName };
    }
  });

  res.json({ ok: true, filename: safeName, device });
});

// POST /recordings/stop-play — mata aplay y espera que muera antes de responder
app.post('/recordings/stop-play', async (_req, res) => {
  if (_playProc) {
    console.log('[play] deteniendo aplay…');
    await killAplay();
    console.log('[play] aplay detenido');
    res.json({ ok: true });
  } else {
    res.json({ ok: false, message: 'Sin reproducción activa' });
  }
});

// GET /recordings/play-status — si aplay sigue corriendo + resultado del último
app.get('/recordings/play-status', (_req, res) => {
  res.json({
    playing:  _playProc !== null,
    result:   _playResult,   // { exitCode, stderr, filename } o null si no hay resultado aún
  });
});

// ─── POST /livekit/dispatch — despachar agente explícitamente a una sala ─────
app.post('/livekit/dispatch', express.json(), async (req, res) => {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(503).json({ ok: false, error: 'LIVEKIT_API_KEY / LIVEKIT_API_SECRET no configurados' });
  }

  const { room } = req.body || {};
  if (!room || typeof room !== 'string') {
    return res.status(400).json({ ok: false, error: 'room requerido' });
  }

  const { AgentDispatchClient } = require('livekit-server-sdk');
  const httpUrl = (LIVEKIT_URL || '').replace(/^wss?:\/\//, 'https://');
  const client  = new AgentDispatchClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

  try {
    console.log(`[dispatch] → room: ${room}`);
    const dispatch = await client.createDispatch(room, LIVEKIT_AGENT_NAME);
    console.log(`[dispatch] ✔ id: ${dispatch.id}`);
    res.json({ ok: true, dispatchId: dispatch.id });
  } catch (err) {
    console.error('[dispatch] ✘', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /terminal/run — ejecutar comando en la Pi ──────────────────────────
app.post('/terminal/run', express.json(), (req, res) => {
  const { command } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ ok: false, output: 'Comando inválido' });
  }

  // Bloquear comandos destructivos
  const blocked = /rm\s+-rf\s+\/|mkfs|dd\s+if=|shutdown|reboot|halt|>\s*\/dev\/sd/i;
  if (blocked.test(command)) {
    return res.status(403).json({ ok: false, output: 'Comando bloqueado por seguridad' });
  }

  const { exec } = require('child_process');
  const start = Date.now();
  console.log(`[terminal] $ ${command}`);

  exec(command, { timeout: 15000, shell: true, cwd: process.cwd() }, (err, stdout, stderr) => {
    const ms     = Date.now() - start;
    const output = (stdout + stderr).trim() || '(sin output)';
    console.log(`[terminal] done (${ms}ms) exit=${err?.code ?? 0}`);
    res.json({ ok: !err || err.code === 0, output, exitCode: err?.code ?? 0, ms });
  });
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
// Usamos http.createServer para que el WebSocket de audio comparta el mismo puerto
const httpServer = http.createServer(app);
setupAudio(app, httpServer);
setupBluetooth(app, express);
setupWifi(app);

httpServer.listen(PORT, () => {
  console.log(`\n  Brumexa-Edge corriendo en → http://localhost:${PORT}`);
  console.log(`  LiveKit URL             → ${LIVEKIT_URL || '(no configurado)'}`);
  console.log(`  Token API               → ${TOKEN_API_URL || '(no configurado)'}`);
  console.log(`  Sala por defecto        → ${LIVEKIT_ROOM_NAME}`);
  console.log(`  Setup WiFi              → http://localhost:${PORT}/setup\n`);

  // Si estamos en Linux y no hay WiFi configurado → activar AP automáticamente
  if (process.platform === 'linux') autoStartAP();
});
