'use strict';

/**
 * lib/local-debug.js
 *
 * Dashboard de diagnóstico para debuguear la Pi sin teclado ni pantalla.
 * Pensado para usarse conectado al AP de fallback (ver lib/wifi.js): cuando
 * la Pi no tiene WiFi configurado, levanta el hotspot "brumexa-local" y
 * desde ahí se puede abrir GET /local en el navegador del celular.
 *
 * Cada fuente de datos se resuelve con su propio try/catch — si un comando
 * Linux-only no existe (p.ej. en una PC de desarrollo Windows), esa sección
 * se marca como no disponible en vez de romper el resto del dashboard.
 */

const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const express = require('express');
const { execSync } = require('child_process');

const PM2_APP_NAME = process.env.PM2_APP_NAME || 'brumexa-edge';

function run(cmd, timeout = 3000) {
  try {
    return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

// Chequeo en vivo de si la Pi puede alcanzar RAG_API_URL — esto es lo que
// falla con "fetch failed" cuando RAG_API_URL apunta mal (ej. localhost en
// vez de la IP de la PC que corre rag-api-v2).
async function checkRagApiReachable(ragApiUrl) {
  if (!ragApiUrl) return { reachable: false, error: 'RAG_API_URL no configurado' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${ragApiUrl}/health`, { signal: controller.signal });
    return { reachable: res.ok, status: res.status };
  } catch (e) {
    return { reachable: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Lee solo la cola de un archivo (evita cargar logs enormes en RAM — la Pi
// tiene poca memoria disponible).
function tailFile(filePath, maxLines = 50, maxBytes = 64 * 1024) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return '(vacío)';
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines).join('\n') || '(sin registros)';
  } catch (e) {
    return `ERROR leyendo ${filePath}: ${e.message}`;
  }
}

// vcgencmd get_throttled devuelve un bitmask — lo mas util para debug de
// campo es saber si hubo undervoltage o throttling termico (causa clasica
// de reinicios random en Raspberry Pi).
function decodeThrottled(raw) {
  const m = raw && raw.match(/0x([0-9a-fA-F]+)/);
  if (!m) return null;
  const bits = parseInt(m[1], 16);
  const FLAGS = [
    [0x1,     'undervoltage-ahora'],
    [0x2,     'freq-limitada-ahora'],
    [0x4,     'throttled-ahora'],
    [0x8,     'temp-limite-ahora'],
    [0x10000, 'undervoltage-hist'],
    [0x20000, 'freq-limitada-hist'],
    [0x40000, 'throttled-hist'],
    [0x80000, 'temp-limite-hist'],
  ];
  const flags = FLAGS.filter(([bit]) => bits & bit).map(([, name]) => name);
  return { raw: m[0], flags };
}

function getSystemInfo() {
  return {
    hostname:   os.hostname(),
    platform:   process.platform,
    arch:       os.arch(),
    uptimeSec:  Math.floor(process.uptime()),
    freeMemMB:  Math.round(os.freemem() / 1024 / 1024),
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    cpuTempC:   process.platform === 'linux'
      ? (() => {
          const raw = run('vcgencmd measure_temp');
          const m = raw && raw.match(/temp=([\d.]+)/);
          return m ? parseFloat(m[1]) : null;
        })()
      : null,
    throttled: process.platform === 'linux' ? decodeThrottled(run('vcgencmd get_throttled')) : null,
  };
}

function getAudioInfo(getMicLevel, getRecorderStatus) {
  if (process.platform !== 'linux') return { available: false };

  let mic = null;
  try { mic = getMicLevel ? getMicLevel() : null; } catch (e) { mic = { error: e.message }; }

  let recorder = null;
  try { recorder = getRecorderStatus ? getRecorderStatus() : null; } catch (e) { recorder = { error: e.message }; }

  return {
    available:   true,
    arecordList: run('arecord -l 2>&1'),
    aplayList:   run('aplay -l 2>&1'),
    alsaProcs:   run('pgrep -a arecord ; pgrep -a aplay'),
    mic,
    recorder,
  };
}

function getBluetoothInfo() {
  if (process.platform !== 'linux') return { available: false };
  return {
    available: true,
    paired:    run('bluetoothctl devices Paired 2>&1'),
    connected: run('bluetoothctl devices Connected 2>&1'),
  };
}

function getWifiLogTail(lines = 60) {
  const LOG_FILE = path.join(__dirname, '..', 'logs', 'wifi-debug.log');
  return tailFile(LOG_FILE, lines) || '(sin registros todavía)';
}

// Le pedimos a PM2 la ruta exacta de sus logs en vez de asumir ~/.pm2/logs/
// — si el daemon de PM2 corre bajo otro usuario/HOME (p.ej. via "pm2 startup"
// como systemd), adivinar la ruta falla en silencio y el log queda vacío.
let _pm2LogPathsCache = null;
function getPm2LogPaths() {
  if (_pm2LogPathsCache) return _pm2LogPathsCache;
  try {
    const raw  = execSync('pm2 jlist', { timeout: 4000, encoding: 'utf8' });
    const list = JSON.parse(raw);
    const proc = list.find(p => p.name === PM2_APP_NAME);
    if (!proc) return null;
    _pm2LogPathsCache = {
      out:   proc.pm2_env?.pm_out_log_path,
      error: proc.pm2_env?.pm_err_log_path,
    };
    return _pm2LogPathsCache;
  } catch (e) {
    return null;
  }
}

// Log de la app (todo lo que loguean server.js y lib/*.js) — vive en los
// archivos de PM2, separado del log de WiFi que es solo eventos de conexión.
function getServerLogTail(lines = 50) {
  const pm2Paths = getPm2LogPaths();
  const home     = os.homedir();
  const outFile  = pm2Paths?.out   || path.join(home, '.pm2', 'logs', `${PM2_APP_NAME}-out.log`);
  const errFile  = pm2Paths?.error || path.join(home, '.pm2', 'logs', `${PM2_APP_NAME}-error.log`);
  return {
    out:      tailFile(outFile, lines),
    error:    tailFile(errFile, lines),
    outPath:  outFile,
    errPath:  errFile,
  };
}

// Log de la Raspberry a nivel sistema/kernel (hardware, USB, alimentación) —
// distinto de los dos anteriores, que son ambos de la app. Puede fallar por
// permisos (dmesg suele estar restringido a root) — degrada con null.
function getSystemLogTail(lines = 50) {
  if (process.platform !== 'linux') return null;
  return run(`dmesg --ctime 2>&1 | tail -n ${lines}`) || run(`journalctl -n ${lines} --no-pager 2>&1`);
}

function setupLocalDebug(app, { getWifiStatus, lkSession, getMicLevel, getRecorderStatus, getDeviceConfig, getRagAuthStatus, ragAuth, requestRoomToken } = {}) {
  app.get('/local', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'local.html'));
  });

  app.get('/local/status', async (_req, res) => {
    let wifi = null;
    try { wifi = getWifiStatus ? getWifiStatus() : null; } catch (e) { wifi = { error: e.message }; }

    let session = null;
    try { session = lkSession ? lkSession.getStatus() : null; } catch (e) { session = { error: e.message }; }

    let device = null;
    try { device = getDeviceConfig ? getDeviceConfig() : null; } catch (e) { device = { error: e.message }; }

    // Cadena de conexión LiveKit: ¿la Pi llega a la API? ¿el dispositivo
    // autenticó? ¿hay sesión? — pensado para diagnosticar "fetch failed"
    // sin tener que ir a buscar los logs de PM2 a mano.
    let ragAuth = null;
    try { ragAuth = getRagAuthStatus ? getRagAuthStatus() : null; } catch (e) { ragAuth = { error: e.message }; }

    let ragApi = null;
    try { ragApi = ragAuth ? await checkRagApiReachable(ragAuth.ragApiUrl) : null; } catch (e) { ragApi = { reachable: false, error: e.message }; }

    res.json({
      generatedAt: new Date().toISOString(),
      system:      getSystemInfo(),
      wifi,
      wifiLog:     getWifiLogTail(),
      serverLog:   getServerLogTail(),
      systemLog:   getSystemLogTail(),
      audio:       getAudioInfo(getMicLevel, getRecorderStatus),
      bluetooth:   getBluetoothInfo(),
      session,
      device,
      ragAuth,
      ragApi,
    });
  });

  // POST /local/speaker-test — dispara un tono de prueba por el parlante.
  // No requiere liberar el mic (captura y reproducción son sub-devices
  // distintos del mismo HAT) — puede correr con la app funcionando normal.
  app.post('/local/speaker-test', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, error: 'Solo disponible en Linux' });
    }
    const { exec } = require('child_process');
    exec(
      'speaker-test -D plughw:0,0 -c 2 -t sine -f 1000 -l 1',
      { timeout: 6000 },
      (err, stdout, stderr) => {
        // speaker-test a veces no corta solo al terminar el loop — el
        // timeout de exec lo mata igual; eso no es una falla real.
        if (err && err.killed) {
          return res.json({ ok: true, note: 'Tono reproducido (cortado por timeout de seguridad)' });
        }
        res.json({ ok: !err, output: (stdout + stderr).trim().slice(-500) || null });
      }
    );
  });

  // POST /local/mic-toggle { enabled: bool } — activa/desactiva la captura
  // de mic en las próximas sesiones LiveKit (no afecta una sesión ya
  // conectada, solo aplica desde el próximo start()). Flag en memoria,
  // no persiste en .env — vuelve a "activado" si se reinicia el proceso.
  app.post('/local/mic-toggle', express.json(), (req, res) => {
    if (!lkSession) return res.status(400).json({ ok: false, error: 'lkSession no disponible' });
    const { enabled } = req.body || {};
    const result = lkSession.setMicEnabled(enabled);
    res.json({ ok: true, micEnabled: result });
  });

  // POST /local/force-auth — dispara ragAuth.login() a mano, mismo llamado
  // que hace initAuth() al boot. Sirve para ver el resultado (o el error
  // exacto) del paso de autenticación sin tener que arrancar una sesión.
  app.post('/local/force-auth', async (_req, res) => {
    if (!ragAuth) return res.status(400).json({ ok: false, error: 'rag-auth no disponible' });
    try {
      await ragAuth.login();
      res.json({ ok: true, status: ragAuth.getStatus() });
    } catch (e) {
      res.json({ ok: false, error: e.message, status: ragAuth.getStatus() });
    }
  });

  // POST /local/force-token — dispara requestRoomToken() a mano (el mismo
  // llamado que hace /session/start). No devuelve el token completo por
  // seguridad, solo confirmación + metadata de la sala asignada.
  app.post('/local/force-token', async (_req, res) => {
    if (!requestRoomToken) return res.status(400).json({ ok: false, error: 'rag-token no disponible' });
    try {
      const data = await requestRoomToken();
      res.json({
        ok: true,
        roomName:     data.roomName,
        serverUrl:    data.serverUrl,
        tokenPreview: data.token ? `${data.token.slice(0, 16)}…` : null,
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  console.log('[local-debug] Endpoints OK — /local  /local/status  /local/speaker-test  /local/force-auth  /local/force-token');
}

module.exports = { setupLocalDebug };
