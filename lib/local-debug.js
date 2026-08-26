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

const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

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

// Log de la Raspberry a nivel sistema/kernel (hardware, USB, alimentación) —
// distinto de los dos anteriores, que son ambos de la app. Puede fallar por
// permisos (dmesg suele estar restringido a root) — degrada con null.
function getSystemLogTail(lines = 50) {
  if (process.platform !== 'linux') return null;
  return run(`dmesg --ctime 2>&1 | tail -n ${lines}`) || run(`journalctl -n ${lines} --no-pager 2>&1`);
}

function setupLocalDebug(app, { getWifiStatus, lkSession, getMicLevel, getRecorderStatus, getDeviceConfig, getRagAuthStatus } = {}) {
  app.get('/local', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'local.html'));
  });

  // Liviano a propósito — a diferencia de /local/status (que dispara ~8
  // execSync bloqueantes: wifi, audio, bluetooth, chequeo de red), esto solo
  // lee la cola del log de sistema. Pensado para pollearse seguido (ver
  // public/logs.js) sin competir con el resto del event loop (audio, LEDs).
  app.get('/local/system-log', (_req, res) => {
    res.json({ text: getSystemLogTail(150) });
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
      // wifiLog/serverLog/systemLog sacados de acá — /logs (ver
      // lib/log-stream.js) ya los muestra en vivo, mejor que este polling de
      // 6s; esto evita 3 lecturas de disco de más en cada request.
      audio:       getAudioInfo(getMicLevel, getRecorderStatus),
      bluetooth:   getBluetoothInfo(),
      session,
      device,
      ragAuth,
      ragApi,
    });
  });

  console.log('[local-debug] Endpoints OK — /local  /local/status  /local/system-log (solo lectura — ver /configuracion para acciones)');
}

module.exports = { setupLocalDebug };
