'use strict';

// ssh -L 3000:localhost:3000 brumelab@brumexa.local
require('dotenv').config();

// Lo más arriba posible — intercepta console.log/warn/error para que
// /ws/logs (ver lib/log-stream.js, /logs en el navegador) tenga el
// arranque completo en su buffer, no solo lo que se loguea después de
// este punto.
const { setupLogStream, handleLogsWsConnection } = require('./lib/log-stream');
setupLogStream();

const http    = require('http');
const express = require('express');
const path    = require('path');
const os      = require('os');

const { setupAudio, getMicGain, setMicGain,
        listAlsaDevices, listAlsaPlaybackDevices, findHatDevice } = require('./lib/audio');
const { startRecording, stopRecording, getStatus,
        listRecordings, RECORDINGS_DIR,
        reserveBrowserFilename, saveBrowserRecording,
        deleteRecording, boostCaptureGain } = require('./lib/recorder');
const { setupWifi, autoStartAP, startHealthMonitor, getStatus: getWifiStatus } = require('./lib/wifi');
const { setupLocalDebug }                              = require('./lib/local-debug');

// lib/configuracion.js se carga con red de seguridad: si el archivo llegó
// corrupto (pasó de verdad -- un git pull/fetch interrumpido lo dejó en
// 0 bytes dos veces) NO tiene que tirar abajo TODO Brumexa (voz, WiFi,
// terminal) por un módulo que no es crítico para la sesión de voz. Si
// falla, /configuracion queda con un 503 explicando por qué, y el resto
// del dispositivo sigue andando normal.
let setupConfiguracion;
try {
  ({ setupConfiguracion } = require('./lib/configuracion'));
  if (typeof setupConfiguracion !== 'function') {
    throw new Error('setupConfiguracion no es una función — lib/configuracion.js corrupto o incompleto');
  }
} catch (e) {
  console.error(`[server] ✘ No se pudo cargar lib/configuracion.js (${e.message}) — /configuracion no va a estar disponible, pero el resto de Brumexa sigue funcionando.`);
  setupConfiguracion = (app) => {
    app.all('/configuracion*', (_req, res) => {
      res.status(503).send(`Configuración no disponible: lib/configuracion.js no se pudo cargar (${e.message}). Revisar por SSH/terminal y reiniciar.`);
    });
  };
}

const { session: lkSession }                           = require('./lib/livekit-session');
const micGate                                          = require('./lib/mic-speech-gate');
const calibrationHistory                               = require('./lib/calibration-history');
const { createCalibrationRunner }                      = require('./lib/calibration');
const leds                                             = require('./lib/leds');
const ragAuth                                          = require('./lib/rag-auth');
const { requestRoomToken, setCredentials: setTokenCredentials } = require('./lib/rag-token');
const { POP_SETTLE_MS: MIC_MONITOR_WARMUP_MS }         = require('./lib/mic-calibration');

const {
  PORT = 3000,
} = process.env;

const DEVICE_CONFIGURED = !!(process.env.BRUMEXA_DEVICE_ID && process.env.BRUMEXA_API_KEY);
if (!DEVICE_CONFIGURED) {
  console.warn('[warn] BRUMEXA_DEVICE_ID / BRUMEXA_API_KEY no configurados. El endpoint /token y las sesiones no funcionarán.');
}

// Último serverUrl de LiveKit visto (llega dinámico en cada respuesta de
// requestRoomToken() — ya no es un valor fijo de .env). Se usa solo para
// mostrar estado en /config y /livekit-health antes de la primera sesión.
let lastKnownLivekitUrl = null;

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();
// ─── Log de cada petición HTTP ────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Los .html nunca se cachean (evita servir una versión vieja del panel tras
// un deploy) — los assets versionados (app.js?v=N, etc.) sí pueden cachear.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ─── GET / ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── GET /terminal — terminal remota como página propia (antes era un tab) ───
app.get('/terminal', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminal.html'));
});

// ─── GET /logs — visor de logs en vivo (server via WS + sistema por polling
// liviano) — pensado para mirar en paralelo mientras se prueba algo (ej. el
// gate de ruido del mic), sin tener que entrar por SSH.
app.get('/logs', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

// ─── GET /diagnostico — pruebas de hardware (mic/speaker/LEDs/grabaciones)
// + diagnóstico de conexión (RAG/token), todo lo que antes vivía repartido
// entre el Panel y Configuración. Script propio (diagnostico.js), no
// comparte app.js con el Panel — ver el comentario grande al principio de
// ese archivo para el porqué.
app.get('/diagnostico', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'diagnostico.html'));
});

// Lee una clave KEY=valor de .env en el momento (sin caché — si alguien la
// cambió a mano por SSH, se ve reflejada al toque). Compartida por /config
// y /setup/config para no duplicar el mismo regex dos veces.
function getEnvVal(key) {
  let content = '';
  try { content = require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch {}
  const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

// ─── GET /config — info del dispositivo y configuración (sin secretos) ───────
app.get('/config', (_req, res) => {
  res.json({
    livekitUrl:      lastKnownLivekitUrl,
    tokenConfigured: DEVICE_CONFIGURED,
    port:               Number(PORT),
    micGain:            getMicGain(),
    // Dispositivo ALSA elegido en Configuración — el Panel lo lee de acá al
    // conectar en vez de tener su propio selector (ver PiNativeModule.start
    // en app.js). Default 'default'/'plughw:0,0': mismo fallback que ya
    // usaba el selector viejo cuando no había nada elegido.
    alsaMicDevice:      getEnvVal('MIC_ALSA_DEVICE')     || 'default',
    alsaSpeakerDevice:  getEnvVal('SPEAKER_ALSA_DEVICE') || 'plughw:0,0',
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
  if (!lastKnownLivekitUrl) return res.json({ online: false, reason: 'no-config' });

  const httpUrl = lastKnownLivekitUrl.replace(/^wss?:\/\//, 'https://');
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

// ─── GET /token — pide un token de LiveKit nuevo al servidor central (rag-api) ─
app.get('/token', async (_req, res) => {
  if (!DEVICE_CONFIGURED) {
    return res.status(503).json({ error: 'BRUMEXA_DEVICE_ID / BRUMEXA_API_KEY no configurados en .env' });
  }
  try {
    const data = await requestRoomToken();
    lastKnownLivekitUrl = data.serverUrl;
    res.json({
      token:      data.token,
      room:       data.roomName,
      identity:   data.identity,
      livekitUrl: data.serverUrl,
      expiresIn:  '1h',
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /setup/config — config editable del .env para el panel de setup ─────
app.get('/setup/config', (_req, res) => {
  const envFile = path.join(__dirname, '.env');
  let content = '';
  try { content = require('fs').readFileSync(envFile, 'utf8'); } catch {}
  const getVal = (key) => {
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  res.json({
    ragApiUrl: getVal('RAG_API_URL') || 'http://localhost:4000',
    deviceId:  getVal('BRUMEXA_DEVICE_ID'),
    apiKey:    getVal('BRUMEXA_API_KEY'),
    deviceName: getVal('DEVICE_NAME') || os.hostname(),
    micGain:      getVal('MIC_GAIN')      || '4.0',
    speakerGain:  getVal('SPEAKER_GAIN')  || '3.0',
    talkThreshold: getVal('MIC_TALK_THRESHOLD_DBFS') || '-25',
    silenceTimeoutMs: getVal('SILENCE_DISCONNECT_MS') || '20000',
    // Gate de ruido sobre el audio publicado a LiveKit — ver
    // lib/livekit-session.js (_publishMic) y lib/mic-speech-gate.js.
    micGateEnabled:       getVal('MIC_GATE_ENABLED')       || 'true',
    micGateAttenuationDb: getVal('MIC_GATE_ATTENUATION_DB') || '-90',
    micPrerollMs:         getVal('MIC_PREROLL_MS')          || '500',
    brumexaColor: getVal('BRUMEXA_COLOR') || 'negro',
    // Ritmo de los LEDS — ver lib/leds.js (setBreathePeriodMs, setHangoverMs,
    // setOnsetDurationMs, setOffsetDurationMs) para el porqué de cada uno.
    ledBreathePeriodMs: getVal('LED_BREATHE_PERIOD_MS') || '1900',
    ledHangoverMs:      getVal('LED_HANGOVER_MS')       || '1100',
    ledOnsetMs:         getVal('LED_ONSET_MS')          || '536',
    ledOffsetMs:        getVal('LED_OFFSET_MS')         || '965',
    alsaMicDevice:      getVal('MIC_ALSA_DEVICE')     || 'default',
    alsaSpeakerDevice:  getVal('SPEAKER_ALSA_DEVICE') || 'plughw:0,0',
  });
});

// ─── GET /setup/color-schemes — roles + combinación de LEDs por color de
// carcasa (lib/color-schemes.json), para pintar el picker + preview en vivo
// del panel de setup sin duplicar los datos ahí adentro.
app.get('/setup/color-schemes', (_req, res) => {
  res.json(leds.getColorSchemes());
});

// GET /setup/custom-colors — para precargar los sliders del panel de
// colores personalizados con lo último guardado (null si nunca se armó uno).
app.get('/setup/custom-colors', (_req, res) => {
  res.json({ colors: leds.getCustomColors() });
});

// POST /setup/custom-colors — guarda un set de colores personalizados (uno
// por rol — ver colorSchemes.roles en lib/color-schemes.json) y lo deja activo YA, sin
// reiniciar. Ruta aparte de /setup/config porque el shape es distinto
// (objeto anidado, no un string plano) y porque "guardar" y "aplicar" acá
// son la misma acción — no tiene sentido persistir colores sin aplicarlos.
app.post('/setup/custom-colors', express.json(), (req, res) => {
  const { colors } = req.body || {};
  const ok = leds.setCustomColors(colors);
  if (!ok) {
    return res.status(400).json({ ok: false, error: 'Colores inválidos — cada rol necesita hue (0-359) y sat (0-1).' });
  }
  const envFile = path.join(__dirname, '.env');
  let content = '';
  try { content = require('fs').readFileSync(envFile, 'utf8'); } catch {}
  content = setEnvLine(content, 'BRUMEXA_COLOR', 'custom');
  content = setEnvLine(content, 'LED_CUSTOM_COLORS', JSON.stringify(leds.getCustomColors()));
  try {
    require('fs').writeFileSync(envFile, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Escribe/reemplaza una línea KEY=value en el contenido de un .env — usado
// por /setup/config (todos los campos, reinicia) y /setup/config/live (solo
// los que ya se aplican en caliente, no reinicia).
function setEnvLine(src, key, value) {
  const lines = src.split('\n');
  let found = false;
  const out = lines.map(line => {
    if (line.startsWith(key + '=') || line.startsWith(key + ' =')) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (src && !src.endsWith('\n')) out.push('');
    out.push(`${key}=${value}`);
  }
  return out.join('\n');
}

// Si todavía no hay tarjeta ALSA elegida a mano (ni por Configuración ni por
// una instalación anterior), la busca sola por nombre de driver y la
// persiste — así una instalación nueva no necesita que alguien entre a
// Configuración a buscarla a mano antes de que el mic/parlante funcionen
// (el número de tarjeta varía según qué otro audio tenga la Raspberry, ver
// findHatDevice en lib/audio.js). Nunca pisa una elección ya guardada (solo
// actúa si el campo está vacío) y si no encuentra el HAT (hardware
// distinto, no conectado) no hace nada — el resto del código sigue con el
// fallback de siempre (plughw:0,0) y el desplegable manual de Configuración
// sigue disponible para corregirlo a mano.
function autoDetectAlsaDevices() {
  const hasMic     = !!getEnvVal('MIC_ALSA_DEVICE');
  const hasSpeaker = !!getEnvVal('SPEAKER_ALSA_DEVICE');
  if (hasMic && hasSpeaker) return;

  const micId     = hasMic     ? null : findHatDevice(listAlsaDevices());
  const speakerId = hasSpeaker ? null : findHatDevice(listAlsaPlaybackDevices());
  if (!micId && !speakerId) return;

  const envFile = path.join(__dirname, '.env');
  let content = '';
  try { content = require('fs').readFileSync(envFile, 'utf8'); } catch {}
  if (micId)     content = setEnvLine(content, 'MIC_ALSA_DEVICE',     micId);
  if (speakerId) content = setEnvLine(content, 'SPEAKER_ALSA_DEVICE', speakerId);
  require('fs').writeFileSync(envFile, content, 'utf8');

  if (micId)     console.log(`[audio] tarjeta ALSA del mic detectada sola → ${micId}`);
  if (speakerId) console.log(`[audio] tarjeta ALSA del parlante detectada sola → ${speakerId}`);
}

// ─── POST /setup/config — escribir .env y aplicar en caliente ────────────────
// Todos estos campos, BRUMEXA_COLOR incluido, se aplican sin reiniciar el
// proceso (credenciales → ragAuth/ragToken.setCredentials, ganancias/umbral →
// lkSession, mic gain del modo browser → lib/audio, color → leds.setDeviceColor).
app.post('/setup/config', express.json(), (req, res) => {
  const envFile = path.join(__dirname, '.env');
  const {
    ragApiUrl, deviceId, apiKey, deviceName, micGain, speakerGain, talkThreshold, silenceTimeoutMs, brumexaColor,
    ledBreathePeriodMs, ledHangoverMs, ledOnsetMs, ledOffsetMs,
    alsaMicDevice, alsaSpeakerDevice,
    micGateEnabled, micGateAttenuationDb, micPrerollMs,
  } = req.body || {};
  let content = '';
  try { content = require('fs').readFileSync(envFile, 'utf8'); } catch {}

  if (ragApiUrl  !== undefined) content = setEnvLine(content, 'RAG_API_URL',       ragApiUrl);
  if (deviceId   !== undefined) content = setEnvLine(content, 'BRUMEXA_DEVICE_ID', deviceId);
  if (apiKey     !== undefined) content = setEnvLine(content, 'BRUMEXA_API_KEY',   apiKey);
  if (deviceName !== undefined) content = setEnvLine(content, 'DEVICE_NAME',       deviceName);
  if (micGain     !== undefined) content = setEnvLine(content, 'MIC_GAIN',      micGain);
  if (speakerGain !== undefined) content = setEnvLine(content, 'SPEAKER_GAIN',  speakerGain);
  if (talkThreshold !== undefined) content = setEnvLine(content, 'MIC_TALK_THRESHOLD_DBFS', talkThreshold);
  if (silenceTimeoutMs !== undefined) content = setEnvLine(content, 'SILENCE_DISCONNECT_MS', silenceTimeoutMs);
  if (brumexaColor  !== undefined) content = setEnvLine(content, 'BRUMEXA_COLOR', brumexaColor);
  if (ledBreathePeriodMs !== undefined) content = setEnvLine(content, 'LED_BREATHE_PERIOD_MS', ledBreathePeriodMs);
  if (ledHangoverMs      !== undefined) content = setEnvLine(content, 'LED_HANGOVER_MS',       ledHangoverMs);
  if (ledOnsetMs         !== undefined) content = setEnvLine(content, 'LED_ONSET_MS',          ledOnsetMs);
  if (ledOffsetMs        !== undefined) content = setEnvLine(content, 'LED_OFFSET_MS',         ledOffsetMs);
  if (alsaMicDevice     !== undefined) content = setEnvLine(content, 'MIC_ALSA_DEVICE',     alsaMicDevice);
  if (alsaSpeakerDevice !== undefined) content = setEnvLine(content, 'SPEAKER_ALSA_DEVICE', alsaSpeakerDevice);
  if (micGateEnabled       !== undefined) content = setEnvLine(content, 'MIC_GATE_ENABLED',        micGateEnabled);
  if (micGateAttenuationDb !== undefined) content = setEnvLine(content, 'MIC_GATE_ATTENUATION_DB', micGateAttenuationDb);
  if (micPrerollMs         !== undefined) content = setEnvLine(content, 'MIC_PREROLL_MS',           micPrerollMs);

  try {
    require('fs').writeFileSync(envFile, content, 'utf8');

    // Aplicar en caliente lo que no necesita reiniciar
    if (ragApiUrl !== undefined || deviceId !== undefined || apiKey !== undefined) {
      ragAuth.setCredentials({ ragApiUrl, deviceId, apiKey });
      setTokenCredentials({ ragApiUrl, deviceId });
    }
    if (micGain !== undefined) {
      const g = parseFloat(micGain);
      if (!isNaN(g)) { setMicGain(g); lkSession.setMicGain(g); }
    }
    if (speakerGain !== undefined) {
      const g = parseFloat(speakerGain);
      if (!isNaN(g)) lkSession.setSpeakerGain(g);
    }
    if (talkThreshold !== undefined) {
      const t = parseFloat(talkThreshold);
      if (!isNaN(t)) { lkSession.setTalkThreshold(t); leds.setSpeakThresholdDbfs(t); }
    }
    if (silenceTimeoutMs !== undefined) {
      const s = parseInt(silenceTimeoutMs, 10);
      if (!isNaN(s)) lkSession.setSilenceTimeout(s);
    }
    if (brumexaColor !== undefined) leds.setDeviceColor(brumexaColor);
    if (ledBreathePeriodMs !== undefined) { const v = parseFloat(ledBreathePeriodMs); if (!isNaN(v)) leds.setBreathePeriodMs(v); }
    if (ledHangoverMs      !== undefined) { const v = parseFloat(ledHangoverMs);      if (!isNaN(v)) leds.setHangoverMs(v); }
    if (ledOnsetMs         !== undefined) { const v = parseFloat(ledOnsetMs);         if (!isNaN(v)) leds.setOnsetDurationMs(v); }
    if (ledOffsetMs        !== undefined) { const v = parseFloat(ledOffsetMs);        if (!isNaN(v)) leds.setOffsetDurationMs(v); }
    if (micGateEnabled       !== undefined) lkSession.setMicGateEnabled(micGateEnabled !== 'false' && micGateEnabled !== false);
    if (micGateAttenuationDb !== undefined) { const v = parseFloat(micGateAttenuationDb); if (!isNaN(v)) lkSession.setMicGateAttenuationDb(v); }
    if (micPrerollMs         !== undefined) { const v = parseFloat(micPrerollMs);         if (!isNaN(v)) lkSession.setMicPrerollMs(v); }

    res.json({ ok: true, restarting: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /setup/config/live — persistir en .env SOLO los parámetros que ya
// se aplican en caliente (mic gain, speaker gain, umbral de sensibilidad) sin
// reiniciar el proceso. El valor ya está corriendo (lo aplicó /session/mic-gain,
// /session/speaker-gain o /session/talk-threshold antes de llamar acá) — esto
// solo lo deja como default para el próximo arranque, sin cortar la sesión actual.
app.post('/setup/config/live', express.json(), (req, res) => {
  const envFile = path.join(__dirname, '.env');
  const { micGain, speakerGain, talkThreshold } = req.body || {};
  let content = '';
  try { content = require('fs').readFileSync(envFile, 'utf8'); } catch {}

  if (micGain       !== undefined) content = setEnvLine(content, 'MIC_GAIN', micGain);
  if (speakerGain   !== undefined) content = setEnvLine(content, 'SPEAKER_GAIN', speakerGain);
  if (talkThreshold !== undefined) content = setEnvLine(content, 'MIC_TALK_THRESHOLD_DBFS', talkThreshold);

  try {
    require('fs').writeFileSync(envFile, content, 'utf8');
    console.log(`[setup] .env actualizado sin reiniciar → ${JSON.stringify({ micGain, speakerGain, talkThreshold })}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[setup] ✘ no se pudo escribir .env:', err.message);
    res.status(500).json({ ok: false, error: err.message });
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
app.post('/record/start', express.json(), async (req, res) => {
  try {
    // IMPORTANTE: hay que esperar a que el monitor idle suelte el dispositivo
    // ALSA antes de abrir uno nuevo — si no, arecord choca con el device
    // todavía ocupado y sale con "terminó inesperadamente" (código != 0).
    await stopMicMonitor();
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
    startMicMonitor();  // reanudar monitor de mic
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
  const { filename, device } = req.body || {};
  const playDevice = device || getEnvVal('SPEAKER_ALSA_DEVICE') || 'plughw:0,0';
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ ok: false, error: 'filename requerido' });
  }
  const safeName = filename.replace(/[^a-zA-Z0-9_\-\. ]/g, '');
  const filePath = path.join(RECORDINGS_DIR, safeName);

  await killAplay(); // espera que el anterior muera
  // Matar cualquier aplay zombi (incluye los de /ws/speaker)
  try { require('child_process').execSync('pkill -9 aplay 2>/dev/null || true', { timeout: 1000 }); } catch {}

  // Verificar que el archivo existe y su tamaño
  try {
    const stat = require('fs').statSync(filePath);
    console.log(`[play] archivo: ${safeName}  size: ${stat.size} B`);
  } catch (err) {
    console.error(`[play] ✘ archivo no encontrado: ${filePath}`);
    return res.status(404).json({ ok: false, error: 'archivo no encontrado' });
  }

  _playResult = null;
  const proc  = spawn('aplay', ['-D', playDevice, '-v', filePath]);
  _playProc   = proc;
  console.log(`[play] ▶ aplay PID ${proc.pid} -D ${playDevice} ${safeName}`);

  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) { console.log('[aplay]', msg); stderrBuf += msg + '\n'; }
  });
  proc.on('error', err => {
    console.error(`[play] ✘ aplay PID ${proc.pid} error:`, err.message);
    if (_playProc === proc) { _playProc = null; _playResult = { exitCode: -1, stderr: err.message, filename: safeName }; }
  });
  proc.on('close', code => {
    console.log(`[play] aplay PID ${proc.pid} exited code ${code}`);
    if (_playProc === proc) {
      _playProc   = null;
      _playResult = { exitCode: code, stderr: stderrBuf.trim(), filename: safeName };
    }
  });

  res.json({ ok: true, filename: safeName, device: playDevice, pid: proc.pid });
});

// GET /diag/audio — diagnóstico del estado de audio en la Pi
app.get('/diag/audio', (_req, res) => {
  const { execSync } = require('child_process');
  const run = (cmd) => {
    try { return execSync(cmd + ' 2>&1', { timeout: 3000, encoding: 'utf8' }).trim(); }
    catch (e) { return `ERR(${e.status ?? '?'}): ${(e.stdout || e.stderr || e.message || '').toString().trim()}`; }
  };
  res.json({
    platform:       process.platform,
    aplay_l:        run('aplay -l'),
    arecord_l:      run('arecord -l'),
    pgrep_aplay:    run('pgrep -a aplay'),
    pgrep_arecord:  run('pgrep -a arecord'),
    amixer_PCM:     run('amixer sget PCM'),
    amixer_Master:  run('amixer sget Master'),
    amixer_controls:run('amixer scontrols'),
    asound_state:   run('cat /proc/asound/cards'),
  });
});

// GET /diag/leds — por qué no prenden los LEDs (paquete faltante, permisos, etc.)
app.get('/diag/leds', (_req, res) => {
  res.json(leds.getDiagnostics());
});

// POST /diag/leds/test — verde fijo unos segundos para confirmar a ojo que el
// hardware responde; vuelve solo al estado normal al terminar.
app.post('/diag/leds/test', (_req, res) => {
  const ok = leds.test();
  res.json({ ok, error: ok ? null : 'LEDs no configurados — ver /diag/leds' });
});

// POST /diag/leds/preview { color } — aplica un color de carcasa en el
// hardware YA, para ver cómo queda de verdad antes de decidir "Guardar
// color" — NO escribe en .env, es solo probar. Si tocás "Guardar color"
// después, sí persiste (misma función leds.setDeviceColor por dentro).
app.post('/diag/leds/preview', express.json(), (req, res) => {
  const { color } = req.body || {};
  if (typeof color !== 'string') return res.status(400).json({ ok: false, error: 'color inválido' });
  const ok = leds.setDeviceColor(color);
  res.json({ ok, error: ok ? null : `Color desconocido: "${color}"` });
});

// POST /diag/leds/set { h, s, v } — laboratorio de LEDs: pinta un color
// exacto (hue 0-360, sat/val 0-1) en el hardware al toque, moviendo un
// slider. No toca .env ni color-schemes.json, es solo jugar/probar.
app.post('/diag/leds/set', express.json(), (req, res) => {
  const h = Number(req.body?.h), s = Number(req.body?.s), v = Number(req.body?.v);
  if (![h, s, v].every(Number.isFinite)) return res.status(400).json({ ok: false, error: 'h/s/v inválidos' });
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));
  const { r, g, b } = leds.hsvToRgbStd(hue, sat, val);
  leds.on({ r, g, b });
  res.json({ ok: true, r, g, b });
});

// POST /diag/leds/preview-breathe { h, s } — 2s sin mover los sliders del
// laboratorio → deja de ser un chispazo sólido y pasa a respirar con ese
// color, para ver cómo se ve de verdad en uso normal.
app.post('/diag/leds/preview-breathe', express.json(), (req, res) => {
  const h = Number(req.body?.h), s = Number(req.body?.s);
  if (![h, s].every(Number.isFinite)) return res.status(400).json({ ok: false, error: 'h/s inválidos' });
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const ok = leds.previewBreathe(hue, sat);
  res.json({ ok, error: ok ? null : 'LEDs no configurados — ver /diag/leds' });
});

// POST /diag/leds/set/exit — sale del laboratorio; restaura el hue/sat del
// color de carcasa REAL (setDeviceColor pisa lo que haya dejado el
// laboratorio) y vuelve a respirar normal.
app.post('/diag/leds/set/exit', (_req, res) => {
  leds.setDeviceColor(leds.getDeviceColor());
  res.json({ ok: true });
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


// ─── LiveKit Session (@livekit/rtc-node) ─────────────────────────────────────
//   POST /session/start  → pide token, conecta room, publica mic, escucha agente
//   POST /session/stop   → cierra mic, speaker y room
//   GET  /session/status → estado actual de la sesión
//   POST /session/mic-gain { gain } → ajustar gain del mic en vivo

// ─── Monitor de mic standalone (cuando no hay sesión LiveKit activa) ─────────
let _micMonitor = null;

// Última lectura de nivel de mic — la actualiza tanto el monitor idle (abajo)
// como los eventos 'mic-stats' de lkSession durante una sesión activa.
// Expuesta a /local/status para saber si el mic está captando algo sin tener
// que arrancar una sesión — es la misma señal que ya alimenta los LEDs.
let _micLevel = { level: 0, peak: 0, updatedAt: 0, source: null };

// GET /diag/mic-level — SOLO esto, nada más. /local/status (que también
// trae este dato) corre ~8 comandos de shell síncronos (arecord -l, aplay
// -l, pgrep, vcgencmd, bluetoothctl x2, tail de logs) + un fetch de red a la
// RAG API en CADA llamada — pensado para cargarse una vez en un dashboard
// de diagnóstico, no para sondearlo seguido. El medidor de mic en vivo de
// /diagnostico lo sondea cada 200ms — con /local/status eso eran ~8
// execSync (BLOQUEANTES, cortan el event loop entero de Node — audio,
// LEDs, todo) cinco veces por segundo, sin parar mientras la
// página estuviera abierta. Esta ruta solo lee la variable en memoria que
// ya se actualiza sola — sin spawnear nada.
app.get('/diag/mic-level', (_req, res) => {
  res.json({
    ..._micLevel,
    monitorActive: !!_micMonitor,
    // Estado del gate (lib/mic-speech-gate.js) leído EN VIVO, no cacheado en
    // _micLevel — isVoiceActive()/isSensing() cambian por sus propios timers
    // de hangover, no solo cuando llega una muestra nueva, así que un
    // snapshot tomado en el último write podría estar desactualizado.
    // voiceActive (dinámico, sube/baja con tu voz) — no confundir con
    // micGateEnabled más abajo (interruptor FIJO de configuración).
    voiceActive:               micGate.isVoiceActive(),
    sensing:                   micGate.isSensing(),
    ambientFloorDbfs:          micGate.getAmbientFloorDbfs(),
    effectiveThresholdDbfs:    micGate.getEffectiveThresholdDbfs(),
    calibratedThresholdDbfs:   micGate.getSpeakThresholdDbfs(),
    // Para el panel de "¿qué está pasando ahora?" en /diagnostico — sin
    // esto, voiceActive/sensing por sí solos no alcanzan para saber si de
    // verdad hay algo yendo a LiveKit: durante el monitor idle (sin
    // sesión) el gate igual corre (alimenta el LED), pero no hay ninguna
    // conexión a la que mandarle nada.
    sessionActive:             lkSession.isActive(),
    micGateEnabled:            lkSession.getMicGateEnabled(),
  });
});

// GET /diag/calibration-history — todas las corridas guardadas (boot +
// manuales + guiadas), más viejas primero, para graficar la tendencia del
// umbral en /diagnostico. Liviano: solo lee un archivo local, nada de shell.
app.get('/diag/calibration-history', (_req, res) => {
  res.json({ runs: calibrationHistory.readCalibrationHistory(200) });
});

// POST /diag/calibration-history — la calibración guiada (wizard) aplica el
// umbral vía /setup/config (mismo endpoint genérico que el slider manual),
// que NO pasa por runCalibration() ni por acá — así que, a diferencia de la
// calibración de boot y "Recalibrar ahora", nunca quedaba una fila en el
// historial. Esta ruta la agrega aparte, llamada por el wizard justo cuando
// aplicás. measuredAt lo pone el server (no confiar en la hora del
// cliente); triggeredBy queda fijo en 'guided' (no lo manda el cliente) para
// no mezclarlo con los otros dos orígenes por error.
app.post('/diag/calibration-history', express.json(), (req, res) => {
  const { threshold, noiseFloorDbfs, unusualEnvironment } = req.body || {};
  const t = parseFloat(threshold);
  if (isNaN(t)) return res.status(400).json({ ok: false, error: 'threshold inválido' });
  const floor = parseFloat(noiseFloorDbfs);
  calibrationHistory.appendCalibration({
    measuredAt:     Date.now(),
    triggeredBy:    'guided',
    noiseFloorDbfs: isNaN(floor) ? null : Math.round(floor * 10) / 10,
    threshold:      Math.round(t * 10) / 10,
    marginDb:       null, // el wizard no usa un margen fijo como boot/manual — no aplica
    unusualEnvironment: !!unusualEnvironment,
  });
  res.json({ ok: true });
});

function startMicMonitor() {
  // Respeta el toggle "Mic desactivado" de /configuracion — si el usuario
  // lo apagó a mano, nada debe volver a abrir arecord (ni el watchdog de
  // error/disconnect, ni el reanudar tras record/stop), hasta que lo
  // reactive él mismo.
  if (!lkSession.getMicEnabled()) return;
  if (_micMonitor || process.platform !== 'linux') return;
  const MIC = getEnvVal('MIC_ALSA_DEVICE') || 'plughw:0,0';
  const proc = spawn('arecord', ['-D', MIC, '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q']);
  const startedAt = Date.now();
  let peak = 0;
  let last = Date.now();

  proc.stdout.on('data', chunk => {
    // arecord suele meter un pop/click de inicialización en los primeros
    // milisegundos de un device recién abierto (artefacto de ALSA, no ruido
    // real) — mismo MIC_MONITOR_WARMUP_MS que usa lib/mic-calibration.js,
    // sin esto un simple restart del monitor podía mostrar "vos hablando"
    // en pleno silencio.
    if (Date.now() - startedAt < MIC_MONITOR_WARMUP_MS) return;

    // Mismo gain que usa la sesión real de LiveKit (_publishMic en
    // lib/livekit-session.js) — sin esto, el nivel en reposo quedaba fijo a
    // la señal cruda del mic, sin importar qué gain configures.
    const gain = lkSession.getMicGain();
    for (let i = 0; i < chunk.length - 1; i += 2) {
      let s = Math.abs(chunk.readInt16LE(i)) * gain;
      if (s > 32767) s = 32767;
      if (s > peak) peak = s;
    }
    if (Date.now() - last > 100) {
      const level = peak / 32767;
      // Fuera de sesión no hay LiveKit de por medio (no hay audio que
      // gatear), pero el piso de ruido ambiente igual tiene que seguir
      // actualizándose acá — si no, arrancar una sesión justo después de
      // que algo ruidoso empezó (ej. la impresora) heredaría un piso
      // desactualizado hasta que _publishMic lo alcance a corregir solo.
      micGate.feed(level);
      leds.speaking(level);
      _micLevel = { level, peak, updatedAt: Date.now(), source: 'idle-monitor' };
      peak = 0;
      last = Date.now();
    }
  });
  proc.on('error', () => {});
  _micMonitor = proc;
  console.log('[mic-monitor] iniciado');
}

function stopMicMonitor() {
  if (!_micMonitor) return Promise.resolve();
  const proc = _micMonitor;
  _micMonitor = null;
  console.log('[mic-monitor] detenido');
  const gone = new Promise(r => proc.once('close', r));
  try { proc.kill('SIGTERM'); } catch {}
  return Promise.race([gone, new Promise(r => setTimeout(r, 800))]);
}

// ─── Calibración de ruido ambiente ───────────────────────────────────────────
// La orquestación (medir + aplicar + persistir + LEDs + historial) vive en
// lib/calibration.js — acá solo se instancia con sus dependencias (mismo
// patrón que ya usa setupConfiguracion() más abajo). runCalibration/
// getLastCalibration/runBootCalibrationIfNeeded quedan como variables
// normales de este archivo, así el resto de server.js (y lib/configuracion.js,
// que las recibe inyectadas) no tiene que cambiar cómo las usa.
const { runCalibration, getLastCalibration, runBootCalibrationIfNeeded } = createCalibrationRunner({
  lkSession, leds, getEnvVal, setEnvLine,
  envFile: path.join(__dirname, '.env'),
  startMicMonitor, stopMicMonitor,
});

// ─── startSession(): la misma lógica que corría inline en POST /session/start,
// separada para más claridad — hoy la usa solo esa ruta HTTP ────────────────
async function startSession({ micDevice, speakerDevice }) {
  if (lkSession.isActive()) {
    const err = new Error('Sesión ya activa');
    err.sessionActive = true;
    throw err;
  }

  // Frenar el monitor de mic ambiente ANTES de mostrar el cometa: si sigue
  // vivo durante el pedido de token (red, puede tardar), cualquier ruido
  // ambiente dispara leds.speaking() y pisa la animación de "conectando" con
  // ámbar. Frenarlo acá además le da más margen a ALSA para quedar libre
  // antes de que lkSession tome el mic más abajo.
  await stopMicMonitor();
  _agentConfirmed = false;
  leds.connecting();  // cometa cian mientras se pide token y conecta a LiveKit

  const { token, roomName, serverUrl: url } = await requestRoomToken();
  lastKnownLivekitUrl = url;

  await lkSession.start({ token, url, roomName, micDevice, speakerDevice });

  return { status: lkSession.getStatus(), url, roomName };
}

let _sessionConnectedAt = 0;

// El mic de la sesión arranca a publicar apenas conecta la SALA (ver
// _publishMic en lib/livekit-session.js), bastante antes de saber si el
// agente va a aparecer. Sin este freno, ruido ambiente cruzando el umbral
// disparaba leds.speaking() (ámbar) y pisaba el cometa durante toda la
// espera al agente — incluido cada reintento de auto-reconnect, donde
// _sessionConnectedAt se resetea de nuevo y el gate de 2s expira rápido.
// Solo se habilita una vez que 'agent-audio' confirma que el agente
// realmente está — se apaga otra vez al arrancar una sesión nueva o al
// entrar a un ciclo de reintento.
let _agentConfirmed = false;
lkSession.on('mic-stats',     ({ peak, dbfs }) => {
  const level = peak / 32767;
  _micLevel = { level, peak, updatedAt: Date.now(), source: 'session' };
  if (_agentConfirmed && Date.now() - _sessionConnectedAt > 2000) leds.speaking(level);
});
lkSession.on('speaker-stats', ({ peak }) => {
  // El log ya lo hace lib/livekit-session.js — acá solo sincronizamos el LED
  // (verde) con el volumen real de la voz del agente, mismo patrón que 'mic-stats'.
  leds.agentSpeaking(peak / 32767);
});
// 'connected' es solo la SALA (room.connect() resuelto) — el agente puede
// tardar hasta AGENT_DETECT_TIMEOUT_MS más en aparecer (o ni aparecer, y
// disparar un reintento). El cometa tiene que seguir hasta la conexión
// FINAL con el agente, así que acá no se toca el LED — solo se libera el
// monitor de mic idle para que lkSession pueda tomar el mic.
lkSession.on('connected',     () => { stopMicMonitor(); _sessionConnectedAt = Date.now(); });
// Recién acá el agente confirmó que está — ya sea porque se suscribió justo
// ahora (TrackSubscribed) o porque ya estaba en la sala al conectar. Este es
// el momento real de "conectado" para el usuario, así que el LED pasa a
// idle acá, no en el 'connected' de arriba.
lkSession.on('agent-audio',   () => { _agentConfirmed = true; leds.idle(); });
lkSession.on('error',         e => { console.error('[lk-session-evt] error:', e.message); leds.brumexaError(4000); startMicMonitor(); });
// _isReconnecting en lkSession vuelve a false apenas la SALA reconecta
// (room.connect() de start() resuelto), no cuando el agente confirma — así
// que este evento es la única señal de "arrancó un nuevo intento" que llega
// ANTES de esa ventana ciega. Sin resetear _agentConfirmed acá, el mic-stats
// del reintento podía volver a mostrar ámbar por ruido ambiente incluso con
// el agente todavía sin responder.
lkSession.on('reconnecting',  () => { _agentConfirmed = false; });
// Si esto es parte de un ciclo de auto-reconexión (agente no respondió →
// lkSession.stop()+start() por su cuenta, ver _triggerReconnect en
// lib/livekit-session.js), NO es un disconnect real — el cometa tiene que
// seguir (no volver a idle) y el monitor de mic idle NO debe reanudarse
// (si lo hace, vuelve el falso "vos → hablando" por ruido ambiente que ya
// arreglamos, pisando el cometa).
lkSession.on('disconnected',  d => {
  console.log('[lk-session-evt] disconnected:', d.reason);
  if (lkSession.getStatus().isReconnecting) {
    leds.connecting();
    return;
  }
  leds.idle();
  startMicMonitor();
});
// Se agotaron los reintentos (agente inalcanzable) — señal clara de error
// en vez de caer en idle como si todo estuviera bien.
lkSession.on('agent-dead',    () => { leds.brumexaError(4000); startMicMonitor(); });

app.post('/session/start', express.json(), async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 7);
  const t0 = Date.now();
  console.log(`\n[session/start:${reqId}] ▶ BEGIN`);
  try {
    const micDevice     = req.body?.micDevice     || getEnvVal('MIC_ALSA_DEVICE')     || 'plughw:0,0';
    const speakerDevice = req.body?.speakerDevice || getEnvVal('SPEAKER_ALSA_DEVICE') || 'plughw:0,0';
    console.log(`[session/start:${reqId}]   mic=${micDevice}  speaker=${speakerDevice}`);

    const result = await startSession({ micDevice, speakerDevice });

    console.log(`[session/start:${reqId}] ✔ DONE  total=${Date.now()-t0}ms`);
    res.json({ ok: true, ...result });

  } catch (err) {
    if (err.sessionActive) {
      console.warn(`[session/start:${reqId}] ⚠ sesión ya activa — status=${JSON.stringify(lkSession.getStatus())}`);
      return res.status(409).json({ ok: false, error: err.message, status: lkSession.getStatus() });
    }
    console.error(`[session/start:${reqId}] ✘ FAIL  total=${Date.now()-t0}ms  ${err.message}`);
    if (err.stack) console.error(err.stack);
    leds.brumexaError(4000);  // rojo 4s, luego vuelve al breathe
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/session/stop', async (_req, res) => {
  try {
    await lkSession.stop();
    res.json({ ok: true, status: lkSession.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/session/status', (_req, res) => {
  res.json(lkSession.getStatus());
});

// ─── GET /session/diag — estado detallado del pipeline de audio en la Pi ─────
app.get('/session/diag', (_req, res) => {
  const status = lkSession.getStatus();
  const { execSync } = require('child_process');
  const run = cmd => { try { return execSync(cmd, { timeout: 2000, encoding: 'utf8' }).trim(); } catch { return null; } };
  res.json({
    ...status,
    arecordRunning: status.micActive,
    aplayRunning:   status.speakerActive,
    arecordPid:     lkSession.arecordProc?.pid || null,
    aplayPid:       lkSession.aplayProc?.pid   || null,
    // Procesos ALSA activos en el sistema
    alsaProcs: process.platform === 'linux' ? run('pgrep -a arecord ; pgrep -a aplay') : null,
    // Nivel de captura ALSA
    alsaCapture: process.platform === 'linux' ? run('amixer sget Capture 2>/dev/null || amixer sget Mic 2>/dev/null') : null,
  });
});

app.post('/session/mic-gain', express.json(), (req, res) => {
  const g = parseFloat(req.body?.gain);
  if (isNaN(g)) return res.status(400).json({ ok: false, error: 'gain inválido' });
  const ok = lkSession.setMicGain(g);
  res.json({ ok, gain: lkSession.getMicGain() });
});

// ─── POST /session/speaker-gain — volumen de la voz del agente, en vivo ──────
app.post('/session/speaker-gain', express.json(), (req, res) => {
  const g = parseFloat(req.body?.gain);
  if (isNaN(g)) return res.status(400).json({ ok: false, error: 'gain inválido' });
  const ok = lkSession.setSpeakerGain(g);
  res.json({ ok, gain: lkSession.getSpeakerGain() });
});

// ─── POST /session/talk-threshold — umbral (dBFS) de voz, conectado a AMBOS: ─
// el texto del log en consola ("empezó/dejó de hablar") Y el LED (corta el
// breathing y pasa a "hablando"). Un solo umbral, un solo slider.
app.post('/session/talk-threshold', express.json(), (req, res) => {
  const t = parseFloat(req.body?.threshold);
  if (isNaN(t)) return res.status(400).json({ ok: false, error: 'threshold inválido' });
  const ok = lkSession.setTalkThreshold(t) && leds.setSpeakThresholdDbfs(t);
  res.json({ ok, threshold: lkSession.getTalkThreshold(), ledThreshold: leds.getSpeakThresholdDbfs() });
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
setupAudio(app, httpServer, { '/ws/logs': handleLogsWsConnection });
setupWifi(app);
setupLocalDebug(app, {
  getWifiStatus: getWifiStatus,
  lkSession,
  getMicLevel: () => ({ ..._micLevel, monitorActive: !!_micMonitor }),
  getRecorderStatus: getStatus,
  getRagAuthStatus: ragAuth.getStatus,
  getDeviceConfig: () => ({
    tokenConfigured: DEVICE_CONFIGURED,
    livekitUrl:      lastKnownLivekitUrl,
  }),
});
setupConfiguracion(app, { lkSession, ragAuth, requestRoomToken, runCalibration, getLastCalibration, getEnvVal });

// Antes esto dependía de "fuser -k", un binario externo (paquete psmisc)
// que puede no estar instalado en la Pi -- si fallaba, reintentaba en
// silencio para siempre sin decir por qué, y el único síntoma visible era
// que nunca aparecía la línea final "Brumexa-Edge corriendo en...".
//
// Ahora busca el PID que tiene el puerto directamente con "ss" (siempre
// disponible) y lo mata desde Node mismo (sin depender de fuser). Casi
// siempre es un "npm run brumexa" viejo que quedó huérfano de una terminal
// que se cerró sin Ctrl+C — mismo usuario, así que este proceso SÍ tiene
// permiso de matarlo sin sudo. Si es de otro usuario (ej. quedó algo
// corriendo como root), avisa y se rinde rápido en vez de reintentar 5 veces.
let _eaddrinuseAttempts = 0;
const EADDRINUSE_MAX_ATTEMPTS = 2;

// IMPORTANTE: solo devuelve un PID si el proceso que tiene el puerto es
// literalmente "node" — nunca matamos otra cosa. Un intento anterior mataba
// lo que fuera que tuviera el puerto, y una vez terminó matando el proceso
// sshd-session que sostenía el propio túnel SSH del usuario, cortándole la
// conexión. Mejor no liberar el puerto que arriesgar matar algo ajeno.
function _findPortHolderPid(port) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(`ss -tlnp sport = :${port}`, { encoding: 'utf8', timeout: 3000 });
    const line = out.split('\n').find(l => /users:\(\("node/.test(l));
    if (!line) return null;
    const m = line.match(/pid=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

httpServer.on('error', err => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`[boot] ✘ Error inesperado al levantar el server: ${err.message}`);
    return;
  }

  _eaddrinuseAttempts++;
  console.error(`\n⚠ Puerto ${PORT} ya está ocupado por otro proceso (intento ${_eaddrinuseAttempts}/${EADDRINUSE_MAX_ATTEMPTS}).`);

  if (_eaddrinuseAttempts > EADDRINUSE_MAX_ATTEMPTS) {
    console.error(
      `❌ No se pudo liberar el puerto ${PORT} — me rindo.\n` +
      `   Buscá quién lo tiene con: sudo ss -tlnp | grep ${PORT}\n` +
      `   Y matalo con: sudo kill -9 <PID>\n`
    );
    process.exit(1);
  }

  const pid = _findPortHolderPid(PORT);
  if (!pid) {
    console.error(`   → Lo que tiene el puerto no es un proceso "node" (o "ss" no está disponible) — no lo toco. Reintentando en 1s por si se libera solo…`);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
      console.error(`   → Maté el proceso viejo (PID ${pid}) que tenía el puerto tomado. Reintentando en 1s…`);
    } catch (killErr) {
      console.error(
        `   → El puerto lo tiene el PID ${pid}, pero no pude matarlo (${killErr.code === 'EPERM' ? 'permiso denegado — es de otro usuario, hace falta sudo' : killErr.message}).\n` +
        `      Si es de otro usuario: sudo kill -9 ${pid}`
      );
    }
  }
  setTimeout(() => httpServer.listen(PORT), 1000);
});

httpServer.listen(PORT, () => {
  console.log(`\n  Brumexa-Edge corriendo en → http://localhost:${PORT}`);
  console.log(`  RAG API                 → ${process.env.RAG_API_URL || 'http://localhost:4000'}`);
  console.log(`  Device                  → ${DEVICE_CONFIGURED ? `✔ ${process.env.BRUMEXA_DEVICE_ID}` : '(no configurado)'}`);
  console.log(`  Setup WiFi              → http://localhost:${PORT}/setup\n`);

  if (DEVICE_CONFIGURED) ragAuth.initAuth();

  // ACÁ, no antes — scripts/boot.js (systemd, corre ANTES que PM2/server.js)
  // tiene su PROPIO leds.init() y se queda con el GPIO/DMA del NeoPixel
  // hasta que detecta que este puerto ya está escuchando (recién ahí suelta
  // y hace process.exit()). Si este leds.init() corriera antes de que
  // httpServer esté escuchando, los dos procesos pelearían por el mismo
  // GPIO al mismo tiempo. Ver scripts/boot.js para el detalle del handoff.
  leds.init();

  // En Linux: maximizar el gain de captura ALSA (Capture/Mic/ADC → 100% cap)
  // Así el mic anda aunque no se haya abierto nunca la UI de grabación.
  // Va ANTES de calibrar — la calibración tiene que medir con el mismo gain
  // de ALSA que se va a usar después, si no el piso medido no vale.
  if (process.platform === 'linux') {
    // Antes de tocar gain o calibrar — si no hay tarjeta ALSA elegida
    // todavía, la busca sola (ver autoDetectAlsaDevices arriba) para que
    // calibración y el resto del arranque ya usen el dispositivo correcto.
    autoDetectAlsaDevices();

    console.log('[boot] Maximizando gain de captura ALSA…');
    boostCaptureGain();

    // Mide ciego (blinks + 4s de silencio asumido) SOLO si es la primera
    // vez que este dispositivo arranca sin ningún umbral guardado — ver el
    // comentario grande en lib/calibration.js (runBootCalibrationIfNeeded).
    runBootCalibrationIfNeeded();
  }

  // Si estamos en Linux y no hay WiFi configurado → activar AP + LEDs rojo
  if (process.platform === 'linux') {
    autoStartAP().then(() => {
      const { getStatus } = require('./lib/wifi');
      if (!getStatus().connectedSSID) leds.brumexaError();
    });
    // Monitor continuo — a diferencia del chequeo de arriba (una sola vez al
    // boot), esto detecta caídas de señal/conexión que pasan después.
    startHealthMonitor();
  }
});

process.on('SIGTERM', () => { leds.cleanup(); process.exit(0); });
process.on('SIGINT',  () => { leds.cleanup(); process.exit(0); });
