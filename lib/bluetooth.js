'use strict';

const { execSync, exec, spawn } = require('child_process');

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// MAC aleatoria = bit 1 del primer octeto en 1
function isRandomMac(mac) {
  return (parseInt(mac.split(':')[0], 16) & 0x02) !== 0;
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

// Intentar obtener nombre real de un dispositivo via bluetoothctl info
function resolveName(mac, fallback) {
  try {
    const info = execSync(`bluetoothctl info ${mac} 2>&1`, { timeout: 2000 }).toString();
    const m    = info.match(/Name:\s*(.+)/i);
    return m ? m[1].trim() : fallback;
  } catch { return fallback; }
}

// ── Scan ──────────────────────────────────────────────────────────────────────

/**
 * Escanea dispositivos BT Classic + LE.
 * Usa transport:bredr primero (speakers/headphones), luego agrega LE.
 */
function scanDevices(seconds = 10) {
  return new Promise((resolve) => {
    console.log(`[bluetooth] Scan ${seconds}s — BR/EDR + LE`);

    // Fase 1: scan BR/EDR (clásico — speakers, auriculares)
    const cmd = [
      `set-scan-filter-transport bredr`,
      `scan on`,
    ].join('\n');

    const script = `(printf '${cmd}\\n'; sleep ${seconds}; echo 'quit') | bluetoothctl 2>&1`;
    exec(script, { timeout: (seconds + 4) * 1000, shell: true }, (_err, stdout) => {
      console.log('[bluetooth] scan out:', stripAnsi(stdout || '').slice(0, 300));

      // Obtener lista completa
      let devOut = '';
      try { devOut = execSync('bluetoothctl devices 2>&1', { timeout: 3000 }).toString(); }
      catch {}

      const devices = [];
      for (const line of devOut.split('\n')) {
        const clean = stripAnsi(line).trim();
        const m     = clean.match(/Device\s+([0-9A-F:]{17})\s+(.+)/i);
        if (!m) continue;
        const mac    = m[1].trim();
        let   name   = m[2].trim();

        if (isRandomMac(mac)) continue;

        // Si el nombre parece una MAC en guiones, intentar resolver
        if (/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i.test(name)) {
          name = resolveName(mac, name);
        }

        const paired    = isPaired(mac);
        const connected = isConnected(mac);

        // Detectar si es potencialmente un dispositivo de audio
        // (verificamos UUIDs solo si fue visto antes o está pareado)
        const audioCapable = detectAudio(mac);

        devices.push({ mac, name, connected, paired, audioCapable });
      }

      // Ordenar: audio primero, luego por nombre
      devices.sort((a, b) => {
        if (a.audioCapable !== b.audioCapable) return b.audioCapable - a.audioCapable;
        return a.name.localeCompare(b.name);
      });

      console.log(`[bluetooth] ${devices.length} dispositivo(s) encontrado(s)`);
      devices.forEach(d => console.log(`  ${d.audioCapable ? '🔊' : '  '} ${d.name} (${d.mac}) paired=${d.paired}`));
      resolve(devices);
    });
  });
}

/**
 * Detecta si el dispositivo tiene perfil de audio (A2DP Sink).
 * Solo funciona si el dispositivo fue visto/contactado antes.
 */
function detectAudio(mac) {
  try {
    const info = execSync(`bluetoothctl info ${mac} 2>&1`, { timeout: 1500 }).toString();
    // A2DP Sink UUID = 0000110b
    return /0000110b/i.test(info) || /Audio Sink/i.test(info) || /Headset/i.test(info);
  } catch { return false; }
}

// ── Estado global de pairing ──────────────────────────────────────────────────
let _pairingProc = null;
let _pairingMac  = null;

function cancelPairing() {
  if (!_pairingProc) return { ok: false, message: 'No hay pairing en curso' };
  try {
    _pairingProc.stdin.write('quit\n');
    setTimeout(() => { try { _pairingProc?.kill(); } catch {} }, 500);
  } catch {}
  _pairingProc = null;
  _pairingMac  = null;
  console.log('[bluetooth] Pairing cancelado por el usuario');
  return { ok: true, message: 'Cancelado' };
}

// ── Pair + Connect ────────────────────────────────────────────────────────────

function pairAndConnect(mac) {
  if (_pairingProc) {
    return Promise.resolve({ ok: false, message: 'Ya hay un pairing en curso' });
  }

  return new Promise((resolve) => {
    console.log(`[bluetooth] pairAndConnect → ${mac}`);
    _pairingMac = mac;

    const bt = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    _pairingProc = bt;
    let out = '';

    bt.stdout.on('data', d => {
      const text = stripAnsi(d.toString());
      out += text;
      console.log('[bt]', text.trim());

      // Auto-confirmar passkey numérico (SSP NumericComparison)
      if (/confirm passkey|Confirm passkey/i.test(text)) {
        console.log('[bluetooth] → yes (passkey confirmation)');
        bt.stdin.write('yes\n');
      }
    });

    bt.stderr.on('data', d => console.log('[bt err]', d.toString().trim()));

    // Secuencia con tiempos
    const send = (cmd, delay) => setTimeout(() => {
      if (!_pairingProc) return;
      console.log(`[bluetooth] → ${cmd}`);
      bt.stdin.write(cmd + '\n');
    }, delay);

    send('agent DisplayYesNo',  200);   // agente que puede confirmar SSP
    send('default-agent',       600);
    send(`pair ${mac}`,        1000);   // inicia pairing
    send(`trust ${mac}`,       9000);   // confiar para reconexión auto
    send(`connect ${mac}`,    10000);   // conectar

    // Timeout total: 16s
    const done = setTimeout(() => {
      if (!_pairingProc) return;
      bt.stdin.write('quit\n');
      setTimeout(() => { try { bt.kill(); } catch {} }, 500);
      _pairingProc = null;
      _pairingMac  = null;

      const low = out.toLowerCase();
      console.log('[bluetooth] output final:', low.slice(0, 400));

      if (low.includes('connection successful') || low.includes('already connected')) {
        resolve({ ok: true, message: 'Conectado' });
      } else if (low.includes('not available') || low.includes('not found')) {
        resolve({ ok: false, message: 'Dispositivo no encontrado — poné el speaker en modo pairing' });
      } else if (low.includes('already paired') || low.includes('already exists')) {
        resolve({ ok: false, message: 'Ya estaba pareado — probá "Conectar"' });
      } else {
        resolve({ ok: false, message: `No conectó — fijate en los logs del servidor para más detalle` });
      }
    }, 16000);

    bt.on('close', () => {
      clearTimeout(done);
      if (!_pairingProc) return;   // ya resolvido (cancelado)
      _pairingProc = null;
      _pairingMac  = null;
      const low = out.toLowerCase();
      if (low.includes('connection successful') || low.includes('already connected')) {
        resolve({ ok: true, message: 'Conectado' });
      } else {
        resolve({ ok: false, message: 'Proceso terminó sin confirmar conexión' });
      }
    });
  });
}

// ── Connect / Disconnect ──────────────────────────────────────────────────────

function connectDevice(mac) {
  return new Promise((resolve) => {
    exec(`bluetoothctl connect ${mac}`, { timeout: 12000 }, (err, stdout, stderr) => {
      const out = stripAnsi(stdout + stderr).toLowerCase();
      console.log(`[bluetooth] connect ${mac}:`, out.slice(0, 200));
      if (out.includes('connection successful') || out.includes('already connected')) {
        resolve({ ok: true, message: 'Conectado' });
      } else {
        resolve({ ok: false, message: out.split('\n').find(l => l.trim()) || 'Error' });
      }
    });
  });
}

function disconnectDevice(mac) {
  return new Promise((resolve) => {
    exec(`bluetoothctl disconnect ${mac}`, { timeout: 6000 }, (_err, stdout, stderr) => {
      const out = stripAnsi(stdout + stderr).toLowerCase();
      resolve(out.includes('successful') || out.includes('not connected')
        ? { ok: true,  message: 'Desconectado' }
        : { ok: false, message: out.split('\n').find(l => l.trim()) || 'Error' });
    });
  });
}

// ── Listar pareados ───────────────────────────────────────────────────────────

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
    const m = stripAnsi(line).match(/Device\s+([0-9A-F:]{17})\s+(.+)/i);
    if (!m) continue;
    const mac  = m[1].trim();
    const name = m[2].trim();
    devices.push({ mac, name, connected: isConnected(mac), paired: true, audioCapable: detectAudio(mac) });
  }
  return devices;
}

// ── Setup Express ─────────────────────────────────────────────────────────────

function setupBluetooth(app, express) {
  if (process.platform !== 'linux') return;

  app.get('/bluetooth/devices', (_req, res) => {
    try { res.json({ ok: true, devices: listPairedDevices() }); }
    catch (err) { res.json({ ok: false, devices: [], error: err.message }); }
  });

  app.post('/bluetooth/scan', express.json(), async (req, res) => {
    const seconds = Math.min(Number(req.body?.seconds) || 10, 20);
    const devices = await scanDevices(seconds);
    res.json({ ok: true, devices });
  });

  app.post('/bluetooth/pair-connect', express.json(), async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      return res.status(400).json({ ok: false, message: 'MAC inválida' });
    }
    res.json(await pairAndConnect(mac));
  });

  app.post('/bluetooth/cancel-pairing', (_req, res) => {
    res.json(cancelPairing());
  });

  app.post('/bluetooth/connect', express.json(), async (req, res) => {
    const { mac } = req.body || {};
    if (!mac || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      return res.status(400).json({ ok: false, message: 'MAC inválida' });
    }
    res.json(await connectDevice(mac));
  });

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
