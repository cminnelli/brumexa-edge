'use strict';

const { execSync, exec } = require('child_process');

/**
 * Lista los dispositivos Bluetooth pareados.
 * @returns {Array<{ mac: string, name: string, connected: boolean }>}
 */
function listPairedDevices() {
  let out;
  try {
    out = execSync('bluetoothctl devices Paired 2>&1', { timeout: 4000 }).toString();
  } catch {
    try {
      // Fallback para versiones más antiguas de bluetoothctl
      out = execSync("echo -e 'paired-devices\\nquit' | bluetoothctl 2>&1", {
        timeout: 4000, shell: true,
      }).toString();
    } catch {
      return [];
    }
  }

  const devices = [];
  for (const line of out.split('\n')) {
    // Formato: "Device AA:BB:CC:DD:EE:FF Nombre del dispositivo"
    const m = line.match(/Device\s+([0-9A-F:]{17})\s+(.+)/i);
    if (!m) continue;
    const mac  = m[1].trim();
    const name = m[2].trim();
    const connected = isConnected(mac);
    devices.push({ mac, name, connected });
  }
  return devices;
}

/**
 * Verifica si un dispositivo está conectado actualmente.
 */
function isConnected(mac) {
  try {
    const info = execSync(`bluetoothctl info ${mac} 2>&1`, { timeout: 2000 }).toString();
    return /Connected:\s*yes/i.test(info);
  } catch {
    return false;
  }
}

/**
 * Conecta a un dispositivo Bluetooth por MAC.
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
function connectDevice(mac) {
  return new Promise((resolve) => {
    exec(`bluetoothctl connect ${mac}`, { timeout: 10000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).toLowerCase();
      if (!err && (out.includes('connection successful') || out.includes('already connected'))) {
        resolve({ ok: true, message: 'Conectado' });
      } else {
        const msg = err?.message || stderr || stdout || 'Error desconocido';
        resolve({ ok: false, message: msg.trim().split('\n')[0] });
      }
    });
  });
}

/**
 * Desconecta un dispositivo Bluetooth por MAC.
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
function disconnectDevice(mac) {
  return new Promise((resolve) => {
    exec(`bluetoothctl disconnect ${mac}`, { timeout: 6000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).toLowerCase();
      if (!err && (out.includes('successful') || out.includes('not connected'))) {
        resolve({ ok: true, message: 'Desconectado' });
      } else {
        const msg = err?.message || stderr || stdout || 'Error desconocido';
        resolve({ ok: false, message: msg.trim().split('\n')[0] });
      }
    });
  });
}

/**
 * Registra los endpoints de Bluetooth en la app Express.
 * Solo activo en Linux (Raspberry Pi / PC Linux).
 */
function setupBluetooth(app, express) {
  if (process.platform !== 'linux') return;

  // GET /bluetooth/devices — lista dispositivos pareados con estado de conexión
  app.get('/bluetooth/devices', (_req, res) => {
    try {
      const devices = listPairedDevices();
      res.json({ ok: true, devices });
    } catch (err) {
      res.json({ ok: false, devices: [], error: err.message });
    }
  });

  // POST /bluetooth/connect — conectar { mac }
  app.post('/bluetooth/connect', express.json(), async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      return res.status(400).json({ ok: false, message: 'MAC inválida' });
    }
    const result = await connectDevice(mac);
    res.json(result);
  });

  // POST /bluetooth/disconnect — desconectar { mac }
  app.post('/bluetooth/disconnect', express.json(), async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      return res.status(400).json({ ok: false, message: 'MAC inválida' });
    }
    const result = await disconnectDevice(mac);
    res.json(result);
  });

  console.log('[bluetooth] Endpoints registrados: /bluetooth/devices, connect, disconnect');
}

module.exports = { setupBluetooth };
