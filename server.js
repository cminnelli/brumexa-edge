'use strict';

// ssh -L 3000:localhost:3000 brumelab@brumexa.local
require('dotenv').config();

const http    = require('http');
const express = require('express');
const path    = require('path');
const os      = require('os');

const { setupAudio, getMicGain, setMicGain }            = require('./lib/audio');
const { startRecording, stopRecording, getStatus,
        listRecordings, RECORDINGS_DIR,
        reserveBrowserFilename, saveBrowserRecording,
        deleteRecording, boostCaptureGain } = require('./lib/recorder');
const { setupBluetooth }                               = require('./lib/bluetooth');
const { setupWifi, autoStartAP, startHealthMonitor, getStatus: getWifiStatus } = require('./lib/wifi');
const { setupLocalDebug }                              = require('./lib/local-debug');
const { setupConfiguracion }                           = require('./lib/configuracion');
const { session: lkSession }                           = require('./lib/livekit-session');
const leds                                             = require('./lib/leds');
const ragAuth                                          = require('./lib/rag-auth');
const { requestRoomToken }                             = require('./lib/rag-token');

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

// ─── GET /config — info del dispositivo y configuración (sin secretos) ───────
app.get('/config', (_req, res) => {
  res.json({
    livekitUrl:      lastKnownLivekitUrl,
    tokenConfigured: DEVICE_CONFIGURED,
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
  });
});

// ─── POST /setup/config — escribir .env y reiniciar proceso (PM2 restart) ────
app.post('/setup/config', express.json(), (req, res) => {
  const envFile = path.join(__dirname, '.env');
  const { ragApiUrl, deviceId, apiKey, deviceName, micGain, speakerGain, talkThreshold } = req.body || {};
  let content = '';
  try { content = require('fs').readFileSync(envFile, 'utf8'); } catch {}

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

  if (ragApiUrl  !== undefined) content = setEnvLine(content, 'RAG_API_URL',       ragApiUrl);
  if (deviceId   !== undefined) content = setEnvLine(content, 'BRUMEXA_DEVICE_ID', deviceId);
  if (apiKey     !== undefined) content = setEnvLine(content, 'BRUMEXA_API_KEY',   apiKey);
  if (deviceName !== undefined) content = setEnvLine(content, 'DEVICE_NAME',       deviceName);
  if (micGain     !== undefined) content = setEnvLine(content, 'MIC_GAIN',      micGain);
  if (speakerGain !== undefined) content = setEnvLine(content, 'SPEAKER_GAIN',  speakerGain);
  if (talkThreshold !== undefined) content = setEnvLine(content, 'MIC_TALK_THRESHOLD_DBFS', talkThreshold);

  try {
    require('fs').writeFileSync(envFile, content, 'utf8');
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 600);
  } catch (err) {
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
  const { filename, device = 'plughw:0,0' } = req.body || {};
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
  const proc  = spawn('aplay', ['-D', device, '-v', filePath]);
  _playProc   = proc;
  console.log(`[play] ▶ aplay PID ${proc.pid} -D ${device} ${safeName}`);

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

  res.json({ ok: true, filename: safeName, device, pid: proc.pid });
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

// Re-emitir eventos del session a la consola para diagnóstico
// ─── Monitor de mic standalone (cuando no hay sesión LiveKit activa) ─────────
let _micMonitor = null;

// Última lectura de nivel de mic — la actualiza tanto el monitor idle (abajo)
// como los eventos 'mic-stats' de lkSession durante una sesión activa.
// Expuesta a /local/status para saber si el mic está captando algo sin tener
// que arrancar una sesión — es la misma señal que ya alimenta los LEDs.
let _micLevel = { level: 0, peak: 0, updatedAt: 0, source: null };

function startMicMonitor() {
  // Respeta el toggle "Mic desactivado" de /configuracion — si el usuario
  // lo apagó a mano, nada debe volver a abrir arecord (ni el watchdog de
  // error/disconnect, ni el reanudar tras record/stop), hasta que lo
  // reactive él mismo.
  if (!lkSession.getMicEnabled()) return;
  if (_micMonitor || process.platform !== 'linux') return;
  const MIC = process.env.MIC_DEVICE || 'plughw:0,0';
  const proc = spawn('arecord', ['-D', MIC, '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q']);
  let peak = 0;
  let last = Date.now();

  proc.stdout.on('data', chunk => {
    for (let i = 0; i < chunk.length - 1; i += 2) {
      const s = Math.abs(chunk.readInt16LE(i));
      if (s > peak) peak = s;
    }
    if (Date.now() - last > 100) {
      const level = peak / 32767;
      // Comentado: satura el log out de PM2 (10x/seg) mientras el mic físico
      // está roto (INMP441 en reemplazo). Reactivar cuando vuelva a andar.
      // console.log(`[mic-monitor] level=${level.toFixed(2)}`);
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

let _sessionConnectedAt = 0;
lkSession.on('mic-stats',     ({ peak, dbfs }) => {
  const level = peak / 32767;
  _micLevel = { level, peak, updatedAt: Date.now(), source: 'session' };
  if (Date.now() - _sessionConnectedAt > 2000) leds.speaking(level);
});
lkSession.on('speaker-stats', s => { /* ya se imprime dentro del módulo */ });
lkSession.on('connected',     () => { stopMicMonitor(); _sessionConnectedAt = Date.now(); leds.idle(); });
lkSession.on('error',         e => { console.error('[lk-session-evt] error:', e.message); leds.brumexaError(4000); startMicMonitor(); });
lkSession.on('disconnected',  d => { console.log('[lk-session-evt] disconnected:', d.reason); leds.idle(); startMicMonitor(); });

app.post('/session/start', express.json(), async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 7);
  const t0 = Date.now();
  console.log(`\n[session/start:${reqId}] ▶ BEGIN`);
  try {
    if (lkSession.isActive()) {
      console.warn(`[session/start:${reqId}] ⚠ sesión ya activa — status=${JSON.stringify(lkSession.getStatus())}`);
      return res.status(409).json({ ok: false, error: 'Sesión ya activa', status: lkSession.getStatus() });
    }

    const micDevice     = req.body?.micDevice     || process.env.MIC_DEVICE     || 'plughw:0,0';
    const speakerDevice = req.body?.speakerDevice || process.env.SPEAKER_DEVICE || 'plughw:0,0';
    console.log(`[session/start:${reqId}]   mic=${micDevice}  speaker=${speakerDevice}`);

    const { token, roomName, serverUrl: url } = await requestRoomToken();
    lastKnownLivekitUrl = url;
    console.log(`[session/start:${reqId}]   token OK  → connecting to ${url}  room=${roomName || '(auto)'}`);

    await stopMicMonitor();  // esperar que ALSA quede libre antes de que lkSession tome el mic
    const connT0 = Date.now();
    await lkSession.start({ token, url, roomName, micDevice, speakerDevice });
    console.log(`[session/start:${reqId}]   lkSession.start OK  (${Date.now()-connT0}ms)`);

    console.log(`[session/start:${reqId}] ✔ DONE  total=${Date.now()-t0}ms`);
    res.json({ ok: true, status: lkSession.getStatus(), url, roomName });

  } catch (err) {
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
setupAudio(app, httpServer);
setupBluetooth(app, express);
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
setupConfiguracion(app, { lkSession, ragAuth, requestRoomToken });

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

  leds.init();  // arranca respiracion automaticamente
  if (process.platform === 'linux') startMicMonitor();

  // En Linux: maximizar el gain de captura ALSA (Capture/Mic/ADC → 100% cap)
  // Así el mic anda aunque no se haya abierto nunca la UI de grabación.
  if (process.platform === 'linux') {
    console.log('[boot] Maximizando gain de captura ALSA…');
    boostCaptureGain();
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
