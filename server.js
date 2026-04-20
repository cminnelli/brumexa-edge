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
        deleteRecording, boostCaptureGain } = require('./lib/recorder');
const { setupBluetooth }                               = require('./lib/bluetooth');
const { setupWifi, autoStartAP }                       = require('./lib/wifi');
const { session: lkSession }                           = require('./lib/livekit-session');

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
lkSession.on('mic-stats',    s => { /* ya se imprime dentro del módulo */ });
lkSession.on('speaker-stats', s => { /* ya se imprime dentro del módulo */ });
lkSession.on('error',        e => console.error('[lk-session-evt] error:', e.message));
lkSession.on('disconnected', d => console.log('[lk-session-evt] disconnected:', d.reason));

// Decodifica el payload de un JWT (sin validar firma — solo para debug)
function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const b64  = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad  = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch { return null; }
}

// Helper interno: pedir token al servidor central (mismo flujo que /token)
async function fetchTokenFromCentral() {
  if (!TOKEN_API_URL) throw new Error('TOKEN_API_URL no configurado');

  const arch       = os.arch();
  const isArm      = /arm/i.test(arch);
  const deviceType = process.platform === 'linux' && isArm ? 'raspberry' : 'pc';
  const deviceId   = os.hostname();

  console.log(`[session] ▶ token-fetch START  url=${TOKEN_API_URL}  device=${deviceType}  id=${deviceId}`);

  const t0 = Date.now();
  let r;
  try {
    r = await fetch(TOKEN_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BRUMEXA_API_KEY && { 'x-api-key': BRUMEXA_API_KEY }),
      },
      body: JSON.stringify({ deviceType, deviceId }),
    });
  } catch (netErr) {
    throw new Error(`token-fetch network error (${Date.now()-t0}ms): ${netErr.code || ''} ${netErr.message}`);
  }
  const elapsed = Date.now() - t0;

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`token-fetch HTTP ${r.status} (${elapsed}ms): ${txt}`);
  }
  const data = await r.json();
  if (!data.token) throw new Error('Respuesta del servidor central sin "token"');

  // Introspección del JWT para debug
  const payload = decodeJwtPayload(data.token);
  if (payload) {
    const now  = Math.floor(Date.now() / 1000);
    const ttl  = payload.exp ? (payload.exp - now) : null;
    const room = payload.video?.room || payload.room || '(sin room en claims)';
    console.log(`[session] ◀ token-fetch OK  ${elapsed}ms`);
    console.log(`[session]   jwt.sub=${payload.sub}  jwt.iss=${payload.iss}  room=${room}  ttl=${ttl}s  jti=${payload.jti || '-'}`);
    if (ttl !== null && ttl < 60) console.warn(`[session]   ⚠ token TTL bajo (${ttl}s) — puede expirar antes de conectar`);
  } else {
    console.log(`[session] ◀ token-fetch OK  ${elapsed}ms  (no pude decodear JWT)`);
  }

  return {
    token:    data.token,
    url:      data.url      || LIVEKIT_URL,
    roomName: data.roomName || LIVEKIT_ROOM_NAME,
    identity: data.participantName || deviceId,
  };
}

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

    const tokT0 = Date.now();
    const { token, url, roomName } = await fetchTokenFromCentral();
    console.log(`[session/start:${reqId}]   token OK  (${Date.now()-tokT0}ms)  → connecting to ${url}  room=${roomName || '(auto)'}`);

    const connT0 = Date.now();
    await lkSession.start({ token, url, roomName, micDevice, speakerDevice });
    console.log(`[session/start:${reqId}]   lkSession.start OK  (${Date.now()-connT0}ms)`);

    console.log(`[session/start:${reqId}] ✔ DONE  total=${Date.now()-t0}ms`);
    res.json({ ok: true, status: lkSession.getStatus(), url, roomName });

  } catch (err) {
    console.error(`[session/start:${reqId}] ✘ FAIL  total=${Date.now()-t0}ms  ${err.message}`);
    if (err.stack) console.error(err.stack);
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

app.post('/session/mic-gain', express.json(), (req, res) => {
  const g = parseFloat(req.body?.gain);
  if (isNaN(g)) return res.status(400).json({ ok: false, error: 'gain inválido' });
  const ok = lkSession.setMicGain(g);
  res.json({ ok, gain: lkSession.getMicGain() });
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

  // En Linux: maximizar el gain de captura ALSA (Capture/Mic/ADC → 100% cap)
  // Así el mic anda aunque no se haya abierto nunca la UI de grabación.
  if (process.platform === 'linux') {
    console.log('[boot] Maximizando gain de captura ALSA…');
    boostCaptureGain();
  }

  // Si estamos en Linux y no hay WiFi configurado → activar AP automáticamente
  if (process.platform === 'linux') autoStartAP();
});
