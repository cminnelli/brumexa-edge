'use strict';

/**
 * server2.js — Brumexa, solo por voz
 *
 * Versión mínima del dispositivo: sin panel web, sin WiFi/Bluetooth/
 * terminal/grabación de test. Un solo flujo, de punta a punta:
 *
 *   boot          → login del dispositivo + wake word escuchando
 *   "Hey Brumexa" → pedir token → conectar a LiveKit → publicar mic → charla
 *   fin de charla → vuelve a escuchar
 *
 * Para desarrollo/soporte (WiFi, terminal remota, grabación, panel web)
 * seguí usando server.js — este archivo es la versión "producto final",
 * pensada para correr sin que nadie mire una pantalla.
 *
 * Único endpoint HTTP: GET /status — para chequear que está vivo sin SSH.
 */

require('dotenv').config();
const express = require('express');

const ragAuth                = require('./lib/rag-auth');
const { requestRoomToken }   = require('./lib/rag-token');
const { session: lkSession } = require('./lib/livekit-session');
const wakeWord                = require('./lib/wake-word');
const micMonitor               = require('./lib/mic-monitor');
const leds                     = require('./lib/leds');

const {
  PORT = 3000,
  MIC_DEVICE     = 'plughw:0,0',
  SPEAKER_DEVICE = 'plughw:0,0',
} = process.env;

// ─── El único flujo que importa: pedir token, conectar, publicar mic ───────
async function startSession() {
  if (lkSession.isActive()) {
    console.log('[session] ya había una sesión activa — se ignora');
    return;
  }

  console.log('[session] pidiendo token…');
  const { token, roomName, serverUrl: url } = await requestRoomToken();
  console.log(`[session] token OK → sala "${roomName}"`);

  await micMonitor.stop(); // liberar ALSA antes de que lkSession lo tome
  await lkSession.start({ token, url, roomName, micDevice: MIC_DEVICE, speakerDevice: SPEAKER_DEVICE });
  console.log('[session] ✔ conectado — charla en curso');
}

// ─── Wake word → arrancar sesión ────────────────────────────────────────────
wakeWord.on('wake', () => {
  console.log('[wake-word] 🎤 detectada → arrancando sesión');
  leds.wakeHeard();
  startSession().catch((err) => {
    console.error('[session] ✘ no se pudo arrancar:', err.message);
    leds.brumexaError(4000);
  });
});

// ─── Fin de la charla (normal, error, o el agente se cae) → volver a escuchar
lkSession.on('connected',    () => leds.idle());
lkSession.on('disconnected', (d) => {
  console.log(`[session] cerrada (${d.reason}) → vuelvo a escuchar`);
  leds.idle();
  micMonitor.start();
});
lkSession.on('error', (err) => {
  console.error('[session] ✘ error:', err.message);
  leds.brumexaError(4000);
  micMonitor.start();
});

// ─── Único endpoint: estado, para chequear que está vivo sin entrar por SSH ─
const app = express();
app.get('/status', (_req, res) => {
  res.json({
    listening: wakeWord.isEnabled,
    mic:       micMonitor.getLevel(),
    session:   lkSession.getStatus(),
    auth:      ragAuth.getStatus(),
  });
});

app.listen(PORT, async () => {
  console.log(`\n[boot] Brumexa (solo voz) — puerto ${PORT}`);

  console.log('[boot] autenticando dispositivo…');
  await ragAuth.initAuth();
  console.log(`[boot] auth: ${ragAuth.getStatus().authenticated ? '✔ OK' : '✘ falló (revisar RAG_API_URL / BRUMEXA_API_KEY)'}`);

  leds.init();

  console.log('[boot] arrancando wake word…');
  wakeWord.start();
  console.log(`[boot] wake word: ${wakeWord.isEnabled ? '✔ escuchando' : '✘ deshabilitada (revisar WAKE_WORD_MODEL_PATH en .env)'}`);

  if (process.platform === 'linux') {
    micMonitor.start();
    console.log('[boot] mic idle: ✔ arrancado (arecord)');
  } else {
    console.log('[boot] mic idle: — no disponible fuera de Linux (usá scripts/test-wake-word.js para probar con audio real)');
  }

  console.log('[boot] listo — decí la wake word para arrancar\n');
});

process.on('SIGTERM', () => { leds.cleanup(); process.exit(0); });
process.on('SIGINT',  () => { leds.cleanup(); process.exit(0); });
