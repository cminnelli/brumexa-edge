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
const fs   = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Versión async — /local/status la usa para sus ~7 comandos
// (vcgencmd, arecord/aplay, bluetoothctl x2). Con execSync, cada una de
// esas llamadas congela el event loop ENTERO de Node mientras corre — y
// como local.html sondea /local/status cada 6s (ver REFRESH_MS ahí), eso
// significa un freeze periódico de todo lo demás corriendo en el server:
// audio, y sobre todo la respiración de los LEDs (su setInterval de 16ms
// no puede tickear mientras el event loop está bloqueado), que quedaba
// "pegada" en el brillo que tenía en ese instante — se veía como que la
// respiración se paraba y quedaba más tenue de golpe, cada tanto. Con
// exec (async) el comando sigue corriendo en un proceso aparte sin
// bloquear nada acá.
function runAsync(cmd, timeout = 3000) {
  return execAsync(cmd, { timeout, encoding: 'utf8' })
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
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

// ─── % de uso de CPU ──────────────────────────────────────────────────────
// Mismo patrón que getBandwidth() en lib/wifi.js: comparar dos lecturas de
// contadores acumulados en vez de spawnear un proceso (top/mpstat) — acá el
// contador es /proc/stat en vez de /sys/class/net/.../statistics. Como
// local.html sondea /local/status cada 6s solo, esa cadencia YA alcanza
// para comparar "muestra actual vs. la del refresh anterior", sin timer
// propio ni costo extra.
let _lastCpuSample = null; // { idle, total, ts }

function _readCpuTimes() {
  try {
    const line  = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle  = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total, ts: Date.now() };
  } catch (e) {
    return null;
  }
}

function getCpuUsagePct() {
  const sample = _readCpuTimes();
  if (!sample) return null;
  let pct = null;
  if (_lastCpuSample) {
    const dIdle  = sample.idle  - _lastCpuSample.idle;
    const dTotal = sample.total - _lastCpuSample.total;
    if (dTotal > 0) pct = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
  }
  _lastCpuSample = sample;
  return pct; // null en la primera lectura del proceso — mismo caso que bandwidth (no hay "anterior" con qué comparar todavía)
}

// ─── Espacio en disco (tarjeta SD) ────────────────────────────────────────
// Relevante de verdad en una Pi: una SD llena es una falla clásica, y las
// actualizaciones desde /configuracion (clone blue-green, ver
// lib/configuracion.js) dejan backups "<repo>-backup-<ts>" que ocupan
// espacio. runAsync (no execSync) — mismo motivo que el resto de este
// archivo: no bloquear el event loop mientras corre.
async function getDiskInfo() {
  if (process.platform !== 'linux') return null;
  const out = await runAsync('df -k /');
  if (!out) return null;
  const line  = out.trim().split('\n').pop(); // última línea — por si el nombre del filesystem wrappea a 2 líneas en salidas angostas
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  return {
    totalMB: Math.round(Number(parts[1]) / 1024),
    usedMB:  Math.round(Number(parts[2]) / 1024),
    freeMB:  Math.round(Number(parts[3]) / 1024),
    usePct:  parseInt(parts[4], 10), // "29%" → parseInt corta en el "%"
  };
}

async function getSystemInfo() {
  let cpuTempC  = null;
  let throttled = null;
  if (process.platform === 'linux') {
    const [tempRaw, throttledRaw] = await Promise.all([
      runAsync('vcgencmd measure_temp'),
      runAsync('vcgencmd get_throttled'),
    ]);
    const m = tempRaw && tempRaw.match(/temp=([\d.]+)/);
    cpuTempC  = m ? parseFloat(m[1]) : null;
    throttled = decodeThrottled(throttledRaw);
  }
  // os.userInfo() puede tirar en algún sandbox/contenedor raro sin usuario
  // resoluble (visto documentado en Node, no en Brumexa puntualmente) — no
  // vale la pena que tumbe todo /local/status por un dato secundario.
  let username = null;
  try { username = os.userInfo().username; } catch (e) { /* noop */ }

  return {
    hostname:   os.hostname(),
    username,
    platform:   process.platform,
    arch:       os.arch(),
    uptimeSec:  Math.floor(process.uptime()),
    freeMemMB:  Math.round(os.freemem() / 1024 / 1024),
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    // Carga de CPU (1/5/15 min) — para cruzar contra un tildado reportado:
    // si justo en ese momento la carga estaba alta, apunta a contención
    // real de CPU (otro proceso, un pico del sistema) en vez del driver de
    // los LEDs en sí.
    loadavg:    os.loadavg(),
    cpuCores:   os.cpus().length,
    cpuUsagePct: process.platform === 'linux' ? getCpuUsagePct() : null,
    cpuTempC,
    throttled,
  };
}

async function getAudioInfo(getMicLevel, getRecorderStatus) {
  if (process.platform !== 'linux') return { available: false };

  let mic = null;
  try { mic = getMicLevel ? getMicLevel() : null; } catch (e) { mic = { error: e.message }; }

  let recorder = null;
  try { recorder = getRecorderStatus ? getRecorderStatus() : null; } catch (e) { recorder = { error: e.message }; }

  const [arecordList, aplayList, alsaProcs] = await Promise.all([
    runAsync('arecord -l 2>&1'),
    runAsync('aplay -l 2>&1'),
    runAsync('pgrep -a arecord ; pgrep -a aplay'),
  ]);

  return { available: true, arecordList, aplayList, alsaProcs, mic, recorder };
}

async function getBluetoothInfo() {
  if (process.platform !== 'linux') return { available: false };
  const [paired, connected] = await Promise.all([
    runAsync('bluetoothctl devices Paired 2>&1'),
    runAsync('bluetoothctl devices Connected 2>&1'),
  ]);
  return { available: true, paired, connected };
}

function setupLocalDebug(app, { getWifiStatus, lkSession, getMicLevel, getRecorderStatus, getDeviceConfig, getRagAuthStatus } = {}) {
  app.get('/local', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'local.html'));
  });

  app.get('/local/status', async (_req, res) => {
    let wifi = null;
    try { wifi = getWifiStatus ? await getWifiStatus() : null; } catch (e) { wifi = { error: e.message }; }

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

    const [system, audio, bluetooth, disk] = await Promise.all([
      getSystemInfo(),
      getAudioInfo(getMicLevel, getRecorderStatus),
      getBluetoothInfo(),
      getDiskInfo(),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      system,
      disk,
      wifi,
      // wifiLog/serverLog/systemLog sacados de acá — /logs (ver
      // lib/log-stream.js) ya los muestra en vivo, mejor que este polling de
      // 6s; esto evita 3 lecturas de disco de más en cada request.
      audio,
      bluetooth,
      session,
      device,
      ragAuth,
      ragApi,
    });
  });

  console.log('[local-debug] Endpoints OK — /local  /local/status (solo lectura — ver /configuracion para acciones)');
}

module.exports = { setupLocalDebug, getSystemInfo };
