'use strict';

/**
 * lib/wifi.js
 *
 * Provisioning WiFi via Access Point usando NetworkManager (nmcli).
 * Objetivo: la Pi levanta un AP "Brumexa-Setup", el cliente se conecta,
 * ingresa credenciales en la página /setup y la Pi se registra al WiFi.
 *
 * Requiere: Raspberry Pi OS Bookworm (NetworkManager). nmcli debe estar disponible.
 */

const { execSync, exec } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ─── Configuración del AP (sobreescribible por .env) ─────────────────────────
const AP_SSID    = process.env.WIFI_AP_SSID || 'brumexa-local';
const AP_PASS    = process.env.WIFI_AP_PASS || 'brumexa123';
const AP_IP      = process.env.WIFI_AP_IP   || '10.42.0.1';
const AP_IFACE   = 'wlan0';

// ─── Monitoreo continuo de salud de WiFi (señal débil → LEDs naranja) ────────
const SIGNAL_WEAK_THRESHOLD = parseInt(process.env.WIFI_SIGNAL_WEAK_THRESHOLD, 10) || 40; // % (nmcli SIGNAL)
const HEALTH_CHECK_INTERVAL_MS = 15000;

// ─── Estado de la conexión en curso ──────────────────────────────────────────
let _connectState = {
  status:    'idle',   // 'idle' | 'connecting' | 'connected' | 'error'
  ssid:      null,
  ip:        null,
  error:     null,
  startedAt: null,
};

// ─── Log de debug persistente en la SD ───────────────────────────────────────
// Sobrevive a reinicios y se puede leer sacando la SD y montándola en otra PC,
// o vía GET /wifi/debug-log mientras el server esté vivo (AP o red real).
// No guardamos contraseñas en texto plano — solo su longitud.
const LOG_DIR       = path.join(__dirname, '..', 'logs');
const LOG_FILE      = path.join(LOG_DIR, 'wifi-debug.log');
const LOG_MAX_BYTES = 512 * 1024; // 512KB — si se pasa, se recorta a la mitad más reciente

function _maskPassword(pw) {
  if (!pw) return '(sin contraseña)';
  return `(${pw.length} caracteres)`;
}

function _logDebug(line) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${stamp}] ${line}\n`, 'utf8');

    const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (stat && stat.size > LOG_MAX_BYTES) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, content.slice(Math.floor(content.length / 2)), 'utf8');
    }
  } catch (e) {
    console.warn('[wifi] _logDebug error:', e.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function nmcliAvailable() {
  try { execSync('which nmcli', { timeout: 2000 }); return true; }
  catch { return false; }
}

function run(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
  } catch (e) {
    return (e.stdout || e.stderr || '').toString().trim();
  }
}

// ─── Estado WiFi actual ───────────────────────────────────────────────────────
function getStatus() {
  if (!nmcliAvailable()) {
    return { available: false, apActive: false, connectedSSID: null, ipAddress: null, signal: null };
  }

  let apActive      = false;
  let connectedSSID = null;
  let ipAddress     = null;

  try {
    // Ver si hay un hotspot activo con nombre AP_SSID
    const conns = run('nmcli -t -f NAME,TYPE,DEVICE connection show --active', 4000);
    for (const line of conns.split('\n')) {
      if (line.includes(AP_SSID)) { apActive = true; break; }
    }

    // Ver SSID conectado en wlan0
    const devInfo = run(`nmcli -t -f GENERAL.CONNECTION,IP4.ADDRESS device show ${AP_IFACE}`, 4000);
    for (const line of devInfo.split('\n')) {
      if (line.startsWith('GENERAL.CONNECTION:')) {
        const conn = line.split(':').slice(1).join(':').trim();
        if (conn && conn !== '--' && conn !== AP_SSID) connectedSSID = conn;
      }
      if (line.startsWith('IP4.ADDRESS')) {
        const addr = line.split(':').slice(1).join(':').trim();
        if (addr && addr !== '--') ipAddress = addr.split('/')[0];
      }
    }
  } catch (e) {
    console.warn('[wifi] getStatus error:', e.message);
  }

  const signal = connectedSSID ? getSignalStrength() : null;

  return { available: true, apActive, connectedSSID, ipAddress, signal };
}

// ─── Fuerza de señal (0-100) de la red actualmente asociada ──────────────────
function getSignalStrength() {
  if (!nmcliAvailable()) return null;
  try {
    // Sin --rescan: usa el scan cacheado de NetworkManager, rápido (~ms)
    const out = run(`nmcli -t -f IN-USE,SIGNAL,SSID device wifi list ifname ${AP_IFACE}`, 4000);
    for (const line of out.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === '*') return parseInt(parts[1], 10);
    }
  } catch (e) {
    console.warn('[wifi] getSignalStrength error:', e.message);
  }
  return null;
}

// ─── Escanear redes disponibles ───────────────────────────────────────────────
function scanNetworks() {
  if (!nmcliAvailable()) return [];

  try {
    // --rescan yes fuerza nuevo scan (puede tardar ~5s)
    const out = run(
      `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname ${AP_IFACE} --rescan yes`,
      12000,
    );

    const networks = [];
    const seen     = new Set();

    for (const line of out.split('\n')) {
      const parts = line.split(':');
      if (parts.length < 2) continue;
      const ssid     = parts[0].replace(/\\:/g, ':').trim();
      const signal   = parseInt(parts[1], 10) || 0;
      const security = (parts[2] || '').trim();

      if (!ssid || ssid === '--' || seen.has(ssid)) continue;
      if (ssid === AP_SSID) continue;   // no mostrar nuestro propio AP
      seen.add(ssid);
      networks.push({ ssid, signal, security: security || 'open' });
    }

    // Ordenar por señal descendente
    networks.sort((a, b) => b.signal - a.signal);
    console.log(`[wifi] scan → ${networks.length} redes`);
    return networks;

  } catch (e) {
    console.error('[wifi] scanNetworks error:', e.message);
    return [];
  }
}

// ─── Iniciar AP hotspot ───────────────────────────────────────────────────────
async function startAP() {
  if (!nmcliAvailable()) {
    console.warn('[wifi] nmcli no disponible — no se puede activar AP');
    return { ok: false, error: 'nmcli no disponible' };
  }

  console.log(`[wifi] Activando AP "${AP_SSID}"…`);

  // Borrar conexión previa con el mismo nombre si existe
  run(`nmcli connection delete "${AP_SSID}" 2>/dev/null || true`, 5000);

  return new Promise((resolve) => {
    const cmd = `nmcli device wifi hotspot ifname ${AP_IFACE} ssid "${AP_SSID}" password "${AP_PASS}"`;
    exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim();
      if (err && !out.toLowerCase().includes('successfully')) {
        console.error('[wifi] startAP error:', out);
        _logDebug(`AP "${AP_SSID}" FALLÓ al activar — ${out.slice(0, 300)}`);
        resolve({ ok: false, error: out });
      } else {
        console.log(`[wifi] AP "${AP_SSID}" activo — IP: ${AP_IP}  pass: ${AP_PASS}`);
        _logDebug(`AP "${AP_SSID}" activo — IP: ${AP_IP}`);
        resolve({ ok: true, ssid: AP_SSID, ip: AP_IP });
      }
    });
  });
}

// ─── Detener AP ───────────────────────────────────────────────────────────────
function stopAP() {
  if (!nmcliAvailable()) return { ok: false, error: 'nmcli no disponible' };
  try {
    run(`nmcli connection delete "${AP_SSID}"`, 8000);
    console.log(`[wifi] AP "${AP_SSID}" detenido`);
    return { ok: true };
  } catch (e) {
    console.warn('[wifi] stopAP:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── Conectar a WiFi del cliente ──────────────────────────────────────────────
// El radio wlan0 es de un solo modo: no puede ser hotspot (AP) y cliente de
// otra red a la vez. Por eso hay que apagar el AP ANTES de intentar conectar
// — si no, nmcli intenta asociar con el radio ocupado sirviendo "Brumexa-Setup"
// y el intento falla siempre, dejando el AP encendido en loop infinito.
async function connectToWifi(ssid, password) {
  if (!nmcliAvailable()) {
    _connectState = { status: 'error', ssid, ip: null, error: 'nmcli no disponible', startedAt: Date.now() };
    return;
  }

  _connectState = { status: 'connecting', ssid, ip: null, error: null, startedAt: Date.now() };
  console.log(`[wifi] Conectando a "${ssid}"…`);
  _logDebug(`Intentando conectar a SSID="${ssid}" ${_maskPassword(password)}`);

  // Liberar el radio: apagar el AP y esperar a que el driver termine la transición
  stopAP();
  await new Promise(r => setTimeout(r, 1500));

  // Borrar conexión guardada previa con el mismo SSID para evitar conflictos
  run(`nmcli connection delete "${ssid}" 2>/dev/null || true`, 4000);

  const passArg = password ? `password "${password}"` : '';
  const cmd     = `nmcli device wifi connect "${ssid}" ${passArg} ifname ${AP_IFACE}`;

  exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    const out = (stdout + stderr).toLowerCase().trim();
    console.log(`[wifi] connect result: ${out.slice(0, 200)}`);

    if (!err && (out.includes('successfully') || out.includes('activated'))) {
      // Leer IP asignada
      const ip = run(`nmcli -t -f IP4.ADDRESS device show ${AP_IFACE}`, 3000)
        .split('\n')
        .find(l => l.startsWith('IP4.ADDRESS'))
        ?.split(':')[1]?.split('/')[0]?.trim() || null;

      console.log(`[wifi] ✔ Conectado a "${ssid}" — IP: ${ip}`);
      _logDebug(`✔ Conectado a SSID="${ssid}" — IP: ${ip}`);
      _connectState = { status: 'connected', ssid, ip, error: null, startedAt: _connectState.startedAt };

    } else {
      const errMsg = out.split('\n').find(l => l.trim()) || 'No se pudo conectar';
      console.error(`[wifi] ✘ Error conectando a "${ssid}": ${errMsg} — reactivando AP de provisioning`);
      _logDebug(`✘ Falló conexión a SSID="${ssid}" — ${errMsg} — reactivando AP`);
      _connectState = { status: 'error', ssid, ip: null, error: errMsg, startedAt: _connectState.startedAt };

      // No dejar al usuario sin forma de reintentar: volver a levantar el AP
      startAP();
    }
  });
}

// ─── Auto-inicio: activar AP si no hay WiFi al arrancar ──────────────────────
async function autoStartAP() {
  if (process.platform !== 'linux') return;
  if (!nmcliAvailable()) {
    console.warn('[wifi] nmcli no disponible — omitiendo auto-AP');
    return;
  }

  // Esperar 3s a que NetworkManager termine de arrancar
  await new Promise(r => setTimeout(r, 3000));

  const status = getStatus();
  console.log(`[wifi] autoStartAP — connectedSSID: ${status.connectedSSID}  apActive: ${status.apActive}`);
  _logDebug(`Boot — connectedSSID=${status.connectedSSID || '(ninguno)'} apActive=${status.apActive} signal=${status.signal ?? 'n/a'}`);

  if (!status.connectedSSID && !status.apActive) {
    console.log('[wifi] Sin WiFi configurado → activando AP de provisioning…');
    await startAP();
  } else if (status.connectedSSID) {
    console.log(`[wifi] WiFi ya configurado: "${status.connectedSSID}" — AP no necesario`);
  }
}

// ─── Monitor continuo — corre cada HEALTH_CHECK_INTERVAL_MS, actualiza LEDs ──
// A diferencia de autoStartAP() (chequeo único al boot), esto detecta caídas
// de señal o desconexiones que pasan DESPUÉS de que el server ya arrancó.
let _lastLoggedHealth = null; // evita spamear el log cada 15s — solo loguea transiciones

function _checkHealth() {
  const leds   = require('./leds');
  const status = getStatus();

  let health;
  if (!status.connectedSSID) {
    health = 'disconnected';
    leds.setNetworkHealth('disconnected');
  } else if (status.signal !== null && status.signal < SIGNAL_WEAK_THRESHOLD) {
    console.log(`[wifi] señal débil: ${status.signal}% (umbral ${SIGNAL_WEAK_THRESHOLD}%)`);
    health = 'weak';
    leds.setNetworkHealth('weak');
  } else {
    health = 'ok';
    leds.setNetworkHealth('ok');
  }

  if (health !== _lastLoggedHealth) {
    _logDebug(`Salud de red: ${_lastLoggedHealth ?? '(inicial)'} → ${health} — SSID=${status.connectedSSID || '(ninguno)'} signal=${status.signal ?? 'n/a'}%`);
    _lastLoggedHealth = health;
  }
}

function startHealthMonitor() {
  if (process.platform !== 'linux') return;
  const timer = setInterval(_checkHealth, HEALTH_CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[wifi] Monitor de señal activo — cada ${HEALTH_CHECK_INTERVAL_MS / 1000}s, umbral débil ${SIGNAL_WEAK_THRESHOLD}%`);
}

// ─── Registrar rutas Express ──────────────────────────────────────────────────
function setupWifi(app) {
  const jsonBody = require('express').json();

  // Redirigir captive portal — Android, iOS, Windows abren el setup automáticamente
  const portalPaths = [
    '/generate_204',
    '/hotspot-detect.html',
    '/ncsi.txt',
    '/connectivity-check.html',
    '/canonical.html',
    '/success.txt',
  ];
  app.get(portalPaths, (_req, res) => {
    res.redirect(`http://${AP_IP}:${process.env.PORT || 3000}/setup`);
  });

  // GET /setup — sirve la página de configuración WiFi
  app.get('/setup', (_req, res) => {
    const path = require('path');
    res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
  });

  // GET /wifi/status
  app.get('/wifi/status', (_req, res) => {
    res.json({ ...getStatus(), apSsid: AP_SSID, apIp: AP_IP });
  });

  // GET /wifi/scan
  app.get('/wifi/scan', (_req, res) => {
    const networks = scanNetworks();
    res.json({ ok: true, networks });
  });

  // POST /wifi/ap/start
  app.post('/wifi/ap/start', jsonBody, async (_req, res) => {
    const result = await startAP();
    res.json(result);
  });

  // POST /wifi/ap/stop
  app.post('/wifi/ap/stop', (_req, res) => {
    res.json(stopAP());
  });

  // POST /wifi/connect  { ssid, password }
  app.post('/wifi/connect', jsonBody, (req, res) => {
    const body     = req.body || {};
    const { ssid } = body;
    const password = body.password || '';

    if (!ssid || typeof ssid !== 'string' || ssid.length > 64) {
      return res.status(400).json({ ok: false, error: 'SSID inválido' });
    }
    if (password.length > 64) {
      return res.status(400).json({ ok: false, error: 'Contraseña demasiado larga' });
    }

    connectToWifi(ssid.trim(), password);
    res.json({ ok: true, message: 'Conectando…' });
  });

  // GET /wifi/connect/status
  app.get('/wifi/connect/status', (_req, res) => {
    res.json(_connectState);
  });

  // GET /wifi/debug-log — historial persistente (sobrevive reinicios)
  app.get('/wifi/debug-log', (_req, res) => {
    try {
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '(sin registros todavía)';
      res.type('text/plain').send(content);
    } catch (e) {
      res.status(500).type('text/plain').send(`Error leyendo el log: ${e.message}`);
    }
  });

  console.log('[wifi] Endpoints OK — /setup  /wifi/status  /wifi/scan  /wifi/connect  /wifi/debug-log');
}

module.exports = { setupWifi, autoStartAP, getStatus, startAP, stopAP, startHealthMonitor };
