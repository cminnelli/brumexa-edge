'use strict';

require('dotenv').config();

const http    = require('http');
const express = require('express');
const path    = require('path');
const os      = require('os');

const { setupAudio }                                    = require('./lib/audio');
const { startRecording, stopRecording, getStatus,
        listRecordings, RECORDINGS_DIR }               = require('./lib/recorder');

const {
  LIVEKIT_URL,
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
    livekitUrl:       LIVEKIT_URL || null,
    tokenApiConfigured: !!TOKEN_API_URL,
    port:             Number(PORT),
    server: {
      hostname: os.hostname(),
      platform: process.platform,
      arch:     os.arch(),
      uptime:   Math.floor(process.uptime()),
    },
  });
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

// ─── POST /record/start — iniciar grabación en la Pi ─────────────────────────
app.post('/record/start', express.json(), (req, res) => {
  try {
    const device = req.body?.device || 'default';
    const info   = startRecording(device);
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

// ─── GET /recordings/:file — descargar un archivo WAV ────────────────────────
app.get('/recordings/:file', (req, res) => {
  // Sanitizar: solo letras, números, guiones, puntos — sin path traversal
  const name = req.params.file.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const filePath = `${RECORDINGS_DIR}/${name}`;
  res.download(filePath, name, (err) => {
    if (err) res.status(404).json({ error: 'Archivo no encontrado' });
  });
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
// Usamos http.createServer para que el WebSocket de audio comparta el mismo puerto
const httpServer = http.createServer(app);
setupAudio(app, httpServer);

httpServer.listen(PORT, () => {
  console.log(`\n  Brumexa-Edge corriendo en → http://localhost:${PORT}`);
  console.log(`  LiveKit URL             → ${LIVEKIT_URL || '(no configurado)'}`);
  console.log(`  Token API               → ${TOKEN_API_URL || '(no configurado)'}`);
  console.log(`  Sala por defecto        → ${LIVEKIT_ROOM_NAME}\n`);
});
