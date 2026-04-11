'use strict';

/**
 * TerminalModule — ejecuta comandos en la Pi desde el browser
 * Requiere: endpoint POST /terminal/run en el servidor
 */
const TerminalModule = (() => {

  // ── Grupos de comandos ────────────────────────────────────────────────────

  const PORT = window.location.port || '3000';

  const GROUPS = [
    {
      label: 'Red',
      icon: '🌐',
      cmds: [
        { label: 'IP local',     cmd: 'hostname -I' },
        { label: 'Interfaces',   cmd: 'ip addr show' },
        { label: 'Ruta defecto', cmd: 'ip route show default' },
        { label: 'WiFi',         cmd: 'iwconfig 2>/dev/null || echo "(iwconfig no disponible)"' },
        { label: 'DNS',          cmd: 'cat /etc/resolv.conf' },
      ],
    },
    {
      label: 'Sistema',
      icon: '🖥',
      cmds: [
        { label: 'Kernel',    cmd: 'uname -a' },
        { label: 'OS',        cmd: 'cat /etc/os-release 2>/dev/null || echo "(no disponible)"' },
        { label: 'Temp CPU',  cmd: 'cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk \'{printf "%.1f °C\\n", $1/1000}\' || echo "(no disponible)"' },
        { label: 'RAM',       cmd: 'free -h' },
        { label: 'Disco',     cmd: 'df -h /' },
        { label: 'Uptime',    cmd: 'uptime' },
        { label: 'Procesos',  cmd: 'ps aux --sort=-%cpu | head -12' },
      ],
    },
    {
      label: 'Node.js',
      icon: '⬡',
      cmds: [
        { label: 'node -v',   cmd: 'node --version' },
        { label: 'npm -v',    cmd: 'npm --version' },
        { label: 'which node',cmd: 'which node' },
        { label: 'pm2 list',  cmd: 'pm2 list 2>/dev/null || echo "(pm2 no encontrado)"' },
        { label: 'pm2 logs',  cmd: 'pm2 logs --lines 30 --nostream 2>/dev/null || echo "(pm2 no encontrado)"' },
      ],
    },
    {
      label: 'Audio ALSA',
      icon: '🎙',
      cmds: [
        { label: 'Capturas',   cmd: 'arecord -l 2>&1' },
        { label: 'Playbacks',  cmd: 'aplay -l 2>&1' },
        { label: 'Cards',      cmd: 'cat /proc/asound/cards 2>/dev/null || echo "(no disponible)"' },
        { label: 'Módulos snd',cmd: 'lsmod | grep snd' },
        { label: 'amixer',     cmd: 'amixer 2>/dev/null || echo "(amixer no disponible)"' },
        { label: 'pactl',      cmd: 'pactl info 2>/dev/null || echo "(pulseaudio no disponible)"' },
        { label: 'sinks',      cmd: 'pactl list sinks short 2>/dev/null || echo "(pulseaudio no disponible)"' },
      ],
    },
    {
      label: 'Proceso',
      icon: '⚙',
      cmds: [
        { label: 'Brumexa ps',  cmd: 'ps aux | grep -E "node|brumexa" | grep -v grep' },
        { label: 'Puertos',     cmd: 'ss -tlnp' },
        { label: '/health',     cmd: `curl -s http://localhost:${PORT}/config` },
        { label: '/debug',      cmd: `curl -s http://localhost:${PORT}/debug` },
        { label: 'env NODE',    cmd: 'env | grep -E "NODE|LIVEKIT|PORT|TOKEN" | sort' },
      ],
    },
    {
      label: 'Bluetooth',
      icon: '🔵',
      cmds: [
        { label: 'Pareados',      cmd: 'bluetoothctl devices Paired 2>&1' },
        { label: 'Conectados',    cmd: 'bluetoothctl devices Connected 2>&1' },
        { label: 'hciconfig',     cmd: 'hciconfig -a 2>/dev/null || echo "(no disponible)"' },
        { label: 'rfkill',        cmd: 'rfkill list' },
        { label: 'pactl sinks',   cmd: 'pactl list sinks short 2>/dev/null || echo "(no disponible)"' },
        { label: 'bt status',     cmd: 'systemctl status bluetooth --no-pager 2>&1 | head -20' },
      ],
    },
    {
      label: 'GPIO / I2S',
      icon: '📌',
      cmds: [
        { label: 'gpio readall',  cmd: 'gpio readall 2>/dev/null || echo "(gpio no disponible)"' },
        { label: 'config.txt',    cmd: 'cat /boot/firmware/config.txt 2>/dev/null || cat /boot/config.txt 2>/dev/null || echo "(no encontrado)"' },
        { label: 'lsmod snd',     cmd: 'lsmod | grep snd' },
        { label: 'dtoverlay -l',  cmd: 'dtoverlay -l 2>/dev/null || echo "(dtoverlay no disponible)"' },
        { label: 'I2C devices',   cmd: 'ls /dev/i2c* 2>/dev/null || echo "(no encontrado)"' },
      ],
    },
  ];

  // ── Estado ────────────────────────────────────────────────────────────────

  let _running  = false;
  let _inited   = false;

  // ── DOM refs ──────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  // ── Render grupos ─────────────────────────────────────────────────────────

  function _buildGroups() {
    const container = $('term-groups');
    if (!container) return;

    GROUPS.forEach(group => {
      const section = document.createElement('div');
      section.className = 'term-group';

      const label = document.createElement('div');
      label.className = 'term-group-label';
      label.textContent = `${group.icon} ${group.label}`;
      section.appendChild(label);

      const row = document.createElement('div');
      row.className = 'term-btn-row';

      group.cmds.forEach(({ label: btnLabel, cmd }) => {
        const btn = document.createElement('button');
        btn.className = 'btn-term';
        btn.textContent = btnLabel;
        btn.title = cmd;
        btn.addEventListener('click', () => run(cmd));
        row.appendChild(btn);
      });

      section.appendChild(row);
      container.appendChild(section);
    });
  }

  // ── Ejecutar comando ──────────────────────────────────────────────────────

  async function run(cmd) {
    if (_running) return;
    _running = true;

    const runBtn   = $('btn-term-run');
    const inputEl  = $('term-input');
    if (runBtn)  runBtn.disabled = true;

    _appendEntry(cmd, null, null);  // "pending" entry

    try {
      const res  = await fetch('/terminal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      _appendEntry(cmd, data.output, data.exitCode, data.ms);
    } catch (err) {
      _appendEntry(cmd, `Error de red: ${err.message}`, -1, null);
    } finally {
      _running = false;
      if (runBtn)  runBtn.disabled = false;
      if (inputEl) inputEl.focus();
    }
  }

  // ── Render output ─────────────────────────────────────────────────────────

  function _appendEntry(cmd, output, exitCode, ms) {
    const out = $('term-output');
    if (!out) return;

    const entry = document.createElement('div');
    entry.className = 'term-entry';

    // Header: prompt + command + meta
    const header = document.createElement('div');
    header.className = 'term-entry-header';

    const time = new Date().toLocaleTimeString('es-AR', { hour12: false });
    const ok   = exitCode === null || exitCode === 0;

    header.innerHTML =
      `<span class="term-prompt-char">$</span>` +
      `<span class="term-cmd-text">${_esc(cmd)}</span>` +
      (exitCode !== null
        ? `<span class="term-meta ${ok ? 'term-ok' : 'term-err'}">` +
          `exit ${exitCode}${ms != null ? ` · ${ms}ms` : ''}` +
          `</span>`
        : `<span class="term-meta term-pending">ejecutando…</span>`) +
      `<span class="term-time">${time}</span>`;

    entry.appendChild(header);

    // Body: output text
    if (output !== null) {
      const body = document.createElement('pre');
      body.className = 'term-entry-body' + (ok ? '' : ' term-body-err');
      body.textContent = output;
      entry.appendChild(body);
    } else {
      // placeholder while pending — will be replaced when complete
      entry.id = 'term-pending-entry';
    }

    // If there was a pending entry, remove it
    const pending = $('term-pending-entry');
    if (pending) pending.remove();

    out.appendChild(entry);
    out.scrollTop = out.scrollHeight;
  }

  function _esc(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Limpiar output ────────────────────────────────────────────────────────

  function clear() {
    const out = $('term-output');
    if (out) out.innerHTML = '';
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    if (_inited) return;
    _inited = true;

    _buildGroups();

    // Custom input: Enter key
    const inputEl  = $('term-input');
    const runBtn   = $('btn-term-run');
    const clearBtn = $('btn-term-clear');

    if (inputEl) {
      inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && inputEl.value.trim()) {
          const cmd = inputEl.value.trim();
          inputEl.value = '';
          run(cmd);
        }
      });
    }

    if (runBtn) {
      runBtn.addEventListener('click', () => {
        const cmd = inputEl?.value.trim();
        if (cmd) { inputEl.value = ''; run(cmd); }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', clear);
    }

    // Run a welcome command to confirm connectivity
    run('echo "Terminal lista · $(hostname) · $(date)"');
  }

  return { init, run, clear };
})();
