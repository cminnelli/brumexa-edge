'use strict';

// Foto del estado de la Pi para el admin — viaja en cada latido
// (lib/device-heartbeat.js): versión de código, Wi-Fi, último error y última
// charla. Así te enterás de un problema antes que el cliente.
//
//   init({ lkSession, getWifiStatus, getNetworkHealth })
//   version()     → hash de git del código que está corriendo (o null)
//   snapshot()    → Promise<{ branch, wifi, lastError, lastConversationAt, uptimeS }>

const util = require('util');
const path = require('path');
const { execSync } = require('child_process');

const REPO_DIR = path.join(__dirname, '..');

function _git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: REPO_DIR, encoding: 'utf8', timeout: 5000 }).trim(); } catch { return null; }
}

// Se leen una vez: el código no cambia sin reiniciar el proceso.
const _version = _git('rev-parse HEAD');
const _branch = _git('rev-parse --abbrev-ref HEAD');

let _getWifiStatus = null;
let _getNetworkHealth = () => null;
let _lastError = null;            // { text, at }
let _lastConversationAt = null;

function init({ lkSession, getWifiStatus, getNetworkHealth } = {}) {
  _getWifiStatus = getWifiStatus || null;
  if (getNetworkHealth) _getNetworkHealth = getNetworkHealth;
  if (lkSession) lkSession.on('connected', () => { _lastConversationAt = Date.now(); });

  // Último console.error del proceso (se suma al parche de lib/log-stream.js,
  // no lo reemplaza). Los avisos de Node ("(node:123) XxxWarning: …") también
  // salen por acá, pero no son fallas: se loguean igual y no cuentan como error.
  const origErr = console.error;
  console.error = (...args) => {
    const text = util.format(...args);
    if (!isNodeWarning(text)) _lastError = { text: text.slice(0, 300), at: Date.now() };
    origErr(...args);
  };
}

const isNodeWarning = (text) => /^\(node:\d+\) \w*Warning\b/.test(text) || /^\(Use `node --trace-/.test(text);

function version() { return _version; }

async function snapshot() {
  let wifi = null;
  try {
    const st = _getWifiStatus ? await _getWifiStatus() : null;
    if (st) wifi = { ssid: st.connectedSSID || null, signal: st.signal ?? null, health: _getNetworkHealth() };
  } catch { /* sin datos de Wi-Fi */ }
  return {
    branch: _branch,
    wifi,
    lastError: _lastError ? { text: _lastError.text, at: new Date(_lastError.at).toISOString() } : null,
    lastConversationAt: _lastConversationAt ? new Date(_lastConversationAt).toISOString() : null,
    uptimeS: Math.round(process.uptime()),
  };
}

module.exports = { init, version, snapshot };
