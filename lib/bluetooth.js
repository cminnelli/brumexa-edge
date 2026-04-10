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
 * Escanea N segundos y devuelve dispositivos con nombre real (filtra MACs random).
 * Usa un pipe con sleep para mantener bluetoothctl activo mientras descubre.
 * @returns {Promise<Array<{ mac, name, connected, paired }>>}
 */
function scanDevices(seconds = 8) {
  return new Promise((resolve) => {
    console.log(`[bluetooth] Iniciando scan ${seconds}s via pipe…`);

    // (echo "scan on"; sleep N; echo "quit") | bluetoothctl
    // Mantiene stdin abierto mientras el stack BT descubre dispositivos.
    const cmd = `(echo "scan on"; sleep ${seconds}; echo "quit") | bluetoothctl 2>&1`;

    exec(cmd, { timeout: (seconds + 4) * 1000, shell: true }, (err, stdout) => {
      console.log('[bluetooth] scan stdout:', stdout?.slice(0, 300));
      if (err) console.log('[bluetooth] scan err:', err.message);

      // Ahora listar TODOS los dispositivos conocidos por el stack BT
      let devOut = '';
      try {
        devOut = execSync('bluetoothctl devices 2>&1', { timeout: 3000 }).toString();
      } catch (e) {
        console.log('[bluetooth] devices error:', e.message);
      }
      console.log('[bluetooth] devices raw:', devOut);

      // Filtrar y armar resultado
      const devices = [];
      for (const line of devOut.split('\n')) {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        const m     = clean.match(/Device\s+([0-9A-F:]{17})\s+(.+)/i);
        if (!m) continue;
        const mac  = m[1].trim();
        let   name = m[2].trim();

        // MACs aleatorias sin nombre real → ignorar
        if (isRandomMac(mac)) continue;

        // Si el nombre es la MAC en guiones, intentar resolverlo con bluetoothctl info
        if (/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i.test(name)) {
          try {
            const info = execSync(`bluetoothctl info ${mac} 2>&1`, { timeout: 2000 }).toString();
            const nm   = info.match(/Name:\s*(.+)/i);
            name = nm ? nm[1].trim() : name;
          } catch {}
        }

        devices.push({ mac, name, connected: isConnected(mac), paired: isPaired(mac) });
      }

      console.log(`[bluetooth] Resultado: ${devices.length} dispositivo(s)`);
      resolve(devices);
    });
  });
}

/**
 * Parear y conectar un dispositivo.
 * Usa agent NoInputNoOutput para pairing automático sin PIN.
 */
function pairAndConnect(mac) {
  return new Promise((resolve) => {
    console.log(`[bluetooth] pairAndConnect → ${mac}`);

    // Secuencia: agent NoInputNoOutput → default-agent → pair → trust → connect → quit
    const bt = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';

    bt.stdout.on('data', d => {
      const text = d.toString();
      out += text;
      console.log('[bluetooth] >', text.trim());
    });
    bt.stderr.on('data', d => console.log('[bluetooth] err>', d.toString().trim()));

    // Enviar comandos con delay entre ellos
    bt.stdin.write('agent NoInputNoOutput\n');
    setTimeout(() => bt.stdin.write('default-agent\n'), 500);
    setTimeout(() => { console.log(`[bluetooth] → pair ${mac}`); bt.stdin.write(`pair ${mac}\n`); }, 1000);
    setTimeout(() => { console.log(`[bluetooth] → trust ${mac}`); bt.stdin.write(`trust ${mac}\n`); }, 8000);
    setTimeout(() => { console.log(`[bluetooth] → connect ${mac}`); bt.stdin.write(`connect ${mac}\n`); }, 9000);
    setTimeout(() => {
      bt.stdin.write('quit\n');
      setTimeout(() => {
        try { bt.kill(); } catch {}
        const low = out.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
        console.log('[bluetooth] output completo:', low.slice(0, 500));

        if (low.includes('connection successful') || low.includes('already connected')) {
          resolve({ ok: true, message: 'Conectado' });
        } else if (low.includes('not available') || low.includes('not found')) {
          resolve({ ok: false, message: 'Dispositivo no encontrado — asegurate que esté en modo pairing' });
        } else if (low.includes('paired') || low.includes('already exists')) {
          resolve({ ok: false, message: 'Pareado pero no conectó — intentá "Conectar" ahora' });
        } else {
          resolve({ ok: false, message: `Sin respuesta del dispositivo: ${low.slice(0, 80)}` });
        }
      }, 1000);
    }, 14000);
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
