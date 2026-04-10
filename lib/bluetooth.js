'use strict';

const { execSync, exec, spawn } = require('child_process');

// MACs con formato random (primeros bits indican privacidad BT) — las ignoramos en el scan
function isRandomMac(mac) {
  const first = parseInt(mac.split(':')[0], 16);
  return (first & 0x02) !== 0;   // bit 1 del primer byte = MAC aleatoria
}

function isConnected(mac) {
  try {
    const info = execSync(`bluetoothctl info ${mac} 2>&1`, { timeout: 2000 }).toString();
    return /Connected:\s*yes/i.test(info);
  } catch { return false; }
}

function isPaired(mac) {
  try {
    const info = execSync(`bluetoothctl info ${mac} 2>&1`, { timeout: 2000 }).toString();
    return /Paired:\s*yes/i.test(info);
  } catch { return false; }
}

/**
 * Lista dispositivos pareados con estado de conexión.
 */
function listPairedDevices() {
  let out = '';
  try {
    out = execSync('bluetoothctl devices Paired 2>&1', { timeout: 4000 }).toString();
  } catch {
    try {
      out = execSync("echo -e 'paired-devices\\nquit' | bluetoothctl 2>&1",
        { timeout: 4000, shell: true }).toString();
    } catch { return []; }
  }

  const devices = [];
  for (const line of out.split('\n')) {
    const m = line.match(/Device\s+([0-9A-F:]{17})\s+(.+)/i);
    if (!m) continue;
    const mac  = m[1].trim();
    const name = m[2].trim();
    devices.push({ mac, name, connected: isConnected(mac), paired: true });
  }
  return devices;
}

/**
 * Escanea ~8 segundos y devuelve dispositivos con nombre (filtra MACs random).
 * @returns {Promise<Array<{ mac, name, connected, paired }>>}
 */
function scanDevices(seconds = 8) {
  return new Promise((resolve) => {
    const found = new Map();

    // Capturar dispositivos ya conocidos antes de escanear
    try {
      const known = execSync('bluetoothctl devices 2>&1', { timeout: 3000 }).toString();
      for (const line of known.split('\n')) {
        const m = line.match(/Device\s+([0-9A-F:]{17})\s+(.+)/i);
        if (m) found.set(m[1].trim(), m[2].trim());
      }
    } catch {}

    const bt = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';

    bt.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const m = line.match(/\[NEW\]\s+Device\s+([0-9A-F:]{17})\s+(.+)/i);
        if (m) found.set(m[1].trim(), m[2].trim());
      }
    });

    bt.stdin.write('scan on\n');

    setTimeout(() => {
      bt.stdin.write('scan off\n');
      setTimeout(() => {
        try { bt.kill(); } catch {}

        const devices = [];
        for (const [mac, name] of found.entries()) {
          // Filtrar MACs aleatorias y dispositivos sin nombre real
          if (isRandomMac(mac)) continue;
          if (/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/i.test(name)) continue; // nombre = solo MAC
          devices.push({
            mac,
            name,
            connected: isConnected(mac),
            paired:    isPaired(mac),
          });
        }
        resolve(devices);
      }, 1500);
    }, seconds * 1000);
  });
}

/**
 * Parear y conectar un dispositivo.
 */
function pairAndConnect(mac) {
  return new Promise((resolve) => {
    const bt = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    bt.stdout.on('data', d => { out += d.toString(); });

    bt.stdin.write(`pair ${mac}\n`);

    setTimeout(() => {
      bt.stdin.write(`connect ${mac}\n`);
      setTimeout(() => {
        bt.stdin.write('quit\n');
        setTimeout(() => {
          try { bt.kill(); } catch {}
          const low = out.toLowerCase();
          if (low.includes('connection successful') || low.includes('already connected')) {
            resolve({ ok: true, message: 'Conectado' });
          } else if (low.includes('paired') || low.includes('already exists')) {
            // Fue pareado pero connect tardó — intentar connect directo
            exec(`bluetoothctl connect ${mac}`, { timeout: 8000 }, (err, stdout) => {
              const r = (stdout || '').toLowerCase();
              resolve({
                ok: r.includes('connection successful') || r.includes('already connected'),
                message: r.includes('successful') ? 'Conectado' : 'Pareado pero sin conexión de audio',
              });
            });
          } else {
            resolve({ ok: false, message: 'No se pudo conectar — aceptá el pairing en el dispositivo si lo pide' });
          }
        }, 500);
      }, 5000);
    }, 4000);
  });
}

function connectDevice(mac) {
  return new Promise((resolve) => {
    exec(`bluetoothctl connect ${mac}`, { timeout: 10000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).toLowerCase();
      if (!err && (out.includes('connection successful') || out.includes('already connected'))) {
        resolve({ ok: true, message: 'Conectado' });
      } else {
        const msg = (stderr || stdout || err?.message || 'Error desconocido').trim().split('\n')[0];
        resolve({ ok: false, message: msg });
      }
    });
  });
}

function disconnectDevice(mac) {
  return new Promise((resolve) => {
    exec(`bluetoothctl disconnect ${mac}`, { timeout: 6000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).toLowerCase();
      if (!err && (out.includes('successful') || out.includes('not connected'))) {
        resolve({ ok: true, message: 'Desconectado' });
      } else {
        const msg = (stderr || stdout || err?.message || 'Error desconocido').trim().split('\n')[0];
        resolve({ ok: false, message: msg });
      }
    });
  });
}

function setupBluetooth(app, express) {
  if (process.platform !== 'linux') return;

  // GET /bluetooth/devices — pareados
  app.get('/bluetooth/devices', (_req, res) => {
    try { res.json({ ok: true, devices: listPairedDevices() }); }
    catch (err) { res.json({ ok: false, devices: [], error: err.message }); }
  });

  // POST /bluetooth/scan — escanea N segundos (default 8)
  app.post('/bluetooth/scan', express.json(), async (req, res) => {
    const seconds = Math.min(Number(req.body?.seconds) || 8, 20);
    const devices = await scanDevices(seconds);
    res.json({ ok: true, devices });
  });

  // POST /bluetooth/pair-connect — parear + conectar { mac }
  app.post('/bluetooth/pair-connect', express.json(), async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      return res.status(400).json({ ok: false, message: 'MAC inválida' });
    }
    const result = await pairAndConnect(mac);
    res.json(result);
  });

  // POST /bluetooth/connect
  app.post('/bluetooth/connect', express.json(), async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      return res.status(400).json({ ok: false, message: 'MAC inválida' });
    }
    res.json(await connectDevice(mac));
  });

  // POST /bluetooth/disconnect
  app.post('/bluetooth/disconnect', express.json(), async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      return res.status(400).json({ ok: false, message: 'MAC inválida' });
    }
    res.json(await disconnectDevice(mac));
  });

  console.log('[bluetooth] Endpoints OK');
}

module.exports = { setupBluetooth };
