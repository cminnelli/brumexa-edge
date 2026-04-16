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

// ─── Configuración del AP (sobreescribible por .env) ─────────────────────────
const AP_SSID    = process.env.WIFI_AP_SSID || 'Brumexa-Setup';
const AP_PASS    = process.env.WIFI_AP_PASS || 'brumexa123';
const AP_IP      = process.env.WIFI_AP_IP   || '10.42.0.1';
const AP_IFACE   = 'wlan0';

// ─── Estado de la conexión en curso ──────────────────────────────────────────
let _connectState = {
  status:    'idle',   // 'idle' | 'connecting' | 'connected' | 'error'
  ssid:      null,
  ip:        null,
  error:     null,
  startedAt: null,
};

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
    return { available: false, apActive: false, connectedSSID: null, ipAddress: null };
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

  return { available: true, apActive, connectedSSID, ipAddress };
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
        resolve({ ok: false, error: out });
      } else {
        console.log(`[wifi] AP "${AP_SSID}" activo — IP: ${AP_IP}  pass: ${AP_PASS}`);
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
function connectToWifi(ssid, password) {
  if (!nmcliAvailable()) {
    _connectState = { status: 'error', ssid, ip: null, error: 'nmcli no disponible', startedAt: Date.now() };
    return;
  }

  _connectState = { status: 'connecting', ssid, ip: null, error: null, startedAt: Date.now() };
  console.log(`[wifi] Conectando a "${ssid}"…`);

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
      _connectState = { status: 'connected', ssid, ip, error: null, startedAt: _connectState.startedAt };

      // Apagar el AP ahora que hay WiFi
      setTimeout(() => stopAP(), 2000);

    } else {
      const errMsg = out.split('\n').find(l => l.trim()) || 'No se pudo conectar';
      console.error(`[wifi] ✘ Error conectando a "${ssid}": ${errMsg}`);
      _connectState = { status: 'error', ssid, ip: null, error: errMsg, startedAt: _connectState.startedAt };
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

  if (!status.connectedSSID && !status.apActive) {
    console.log('[wifi] Sin WiFi configurado → activando AP de provisioning…');
    await startAP();
  } else if (status.connectedSSID) {
    console.log(`[wifi] WiFi ya configurado: "${status.connectedSSID}" — AP no necesario`);
  }
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

  console.log('[wifi] Endpoints OK — /setup  /wifi/status  /wifi/scan  /wifi/connect');
}

module.exports = { setupWifi, autoStartAP, getStatus, startAP, stopAP };
