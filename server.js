'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const os      = require('os');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

// ─── Validación temprana de variables de entorno ─────────────────────────────
const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_ROOM_NAME = 'voice-room',
  PORT = 3000,
} = process.env;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.warn(
    '[warn] LIVEKIT_API_KEY o LIVEKIT_API_SECRET no están configurados.\n' +
    '       El endpoint /token no funcionará. Copiá .env.example a .env y completá los valores.'
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();

// Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, 'public')));

// ─── GET / — frontend principal ──────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── GET /config — configuración actual (sin secretos) ───────────────────────
app.get('/config', (_req, res) => {
  res.json({
    livekitUrl:          LIVEKIT_URL    || null,
    roomName:            LIVEKIT_ROOM_NAME,
    apiKeyConfigured:    !!LIVEKIT_API_KEY,
    apiSecretConfigured: !!LIVEKIT_API_SECRET,
    port:                Number(PORT),
    server: {
      hostname: os.hostname(),
      platform: process.platform,   // 'linux' | 'win32' | 'darwin'
      arch:     os.arch(),          // 'arm' | 'arm64' | 'x64' | ...
      release:  os.release(),
    },
  });
});

// ─── GET /livekit-health — verifica conectividad con el servidor LiveKit ─────
//   Usa RoomServiceClient para hacer un listRooms() real.
//   Responde: { online: bool, latency: ms, reason?: string }
app.get('/livekit-health', async (_req, res) => {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
    return res.json({ online: false, reason: 'no-config' });
  }

  const httpUrl = LIVEKIT_URL.replace(/^wss?:\/\//, 'https://');
  const svc     = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  const t0      = Date.now();

  try {
    await svc.listRooms();
    res.json({ online: true, latency: Date.now() - t0 });
  } catch (err) {
    res.json({ online: false, latency: Date.now() - t0, reason: err.message });
  }
});

// ─── GET /token — genera un JWT para que el cliente se conecte a LiveKit ─────
//   Query params opcionales:
//     ?identity=mi-nombre   (identificador del participante)
//     ?room=otra-sala       (sobreescribe LIVEKIT_ROOM_NAME)
app.get('/token', async (req, res) => {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(503).json({
      error: 'LiveKit no está configurado en el servidor (falta API_KEY o API_SECRET).',
    });
  }

  const identity = req.query.identity || `user-${Date.now()}`;
  const room     = req.query.room     || LIVEKIT_ROOM_NAME;

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl: '1h',
    });

    // Permisos: entrar a la sala, publicar y suscribirse
    at.addGrant({
      roomJoin:     true,
      room,
      canPublish:   true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    res.json({ token, room, identity });
  } catch (err) {
    console.error('[error] Generando token:', err.message);
    res.status(500).json({ error: 'No se pudo generar el token.' });
  }
});

// ─── Inicio del servidor ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Brumexa-Edge corriendo en → http://localhost:${PORT}`);
  console.log(`  LiveKit URL             → ${LIVEKIT_URL || '(no configurado)'}`);
  console.log(`  Sala por defecto        → ${LIVEKIT_ROOM_NAME}\n`);
});
