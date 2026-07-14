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
const { execSync } = require('child_process');

function run(cmd, timeout = 3000) {
  try {
    return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
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
  };
}

function getAudioInfo() {
  if (process.platform !== 'linux') return { available: false };
  return {
    available:  true,
    arecordList: run('arecord -l 2>&1'),
    aplayList:   run('aplay -l 2>&1'),
    alsaProcs:   run('pgrep -a arecord ; pgrep -a aplay'),
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
  try {
    const LOG_FILE = path.join(__dirname, '..', 'logs', 'wifi-debug.log');
    if (!fs.existsSync(LOG_FILE)) return '(sin registros todavía)';
    const content = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    return content.slice(-lines).join('\n');
  } catch (e) {
    return `ERROR leyendo log: ${e.message}`;
  }
}

function setupLocalDebug(app, { getWifiStatus, lkSession, getDeviceConfig } = {}) {
  app.get('/local', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'local.html'));
  });

  app.get('/local/status', (_req, res) => {
    let wifi = null;
    try { wifi = getWifiStatus ? getWifiStatus() : null; } catch (e) { wifi = { error: e.message }; }

    let session = null;
    try { session = lkSession ? lkSession.getStatus() : null; } catch (e) { session = { error: e.message }; }

    let device = null;
    try { device = getDeviceConfig ? getDeviceConfig() : null; } catch (e) { device = { error: e.message }; }

    res.json({
      generatedAt: new Date().toISOString(),
      system:      getSystemInfo(),
      wifi,
      wifiLog:     getWifiLogTail(),
      audio:       getAudioInfo(),
      bluetooth:   getBluetoothInfo(),
      session,
      device,
    });
  });

  console.log('[local-debug] Endpoints OK — /local  /local/status');
}

module.exports = { setupLocalDebug };
