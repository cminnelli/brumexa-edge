'use strict';

const TerminalModule = (() => {

  const PORT = window.location.port || '3000';

  // ── Grupos de comandos ───────────────────────────────────────────────────
  const GROUPS = [
    {
      label: 'Red',
      icon: '🌐',
      desc: 'Conectividad y configuración de red',
      cmds: [
        { name: 'IP de la Pi',           desc: 'Todas las IPs asignadas (WiFi + Ethernet)',          cmd: 'hostname -I' },
        { name: 'Interfaces de red',     desc: 'Estado detallado de cada interfaz',                  cmd: 'ip addr show' },
        { name: 'Puerta de enlace',      desc: 'Router y ruta de salida a internet',                 cmd: 'ip route show default' },
        { name: 'WiFi — SSID y señal',   desc: 'Red conectada, calidad de señal y frecuencia',       cmd: 'iwconfig wlan0 2>/dev/null || echo "(iwconfig no disponible)"' },
        { name: 'Servidores DNS',        desc: 'Servidores de nombre configurados',                  cmd: 'cat /etc/resolv.conf | grep -v "^#"' },
        { name: 'Ping a internet',       desc: 'Verifica acceso a internet (4 pings a Google)',      cmd: 'ping -c 4 8.8.8.8' },
        { name: 'Puertos abiertos',      desc: 'Servicios escuchando en red (ss = socket stats)',    cmd: 'ss -tlnp' },
        { name: 'Conexiones activas',    desc: 'Conexiones TCP establecidas en este momento',        cmd: 'ss -tnp state established' },
      ],
    },
    {
      label: 'Sistema',
      icon: '🖥',
      desc: 'Hardware, recursos y estado del SO',
      cmds: [
        { name: 'Kernel y arquitectura', desc: 'Versión del kernel Linux y arquitectura del CPU',    cmd: 'uname -a' },
        { name: 'Sistema operativo',     desc: 'Nombre y versión de la distribución Linux',          cmd: 'cat /etc/os-release | grep -E "^(NAME|VERSION|ID)="' },
        { name: 'Temperatura CPU',       desc: 'Temp del procesador — crítico si supera 80 °C',     cmd: 'cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk \'{printf "CPU: %.1f °C\\n", $1/1000}\' || echo "sensor no disponible"' },
        { name: 'Uso de RAM',            desc: 'Memoria total, usada y libre',                       cmd: 'free -h' },
        { name: 'Espacio en disco',      desc: 'Uso del disco en partición raíz',                    cmd: 'df -h / /boot/firmware 2>/dev/null || df -h /' },
        { name: 'Tiempo encendida',      desc: 'Hace cuánto arrancó la Pi y carga promedio del CPU', cmd: 'uptime' },
        { name: 'Procesos por CPU',      desc: 'Top 10 procesos ordenados por consumo de CPU',       cmd: 'ps aux --sort=-%cpu | head -11' },
        { name: 'Procesos por RAM',      desc: 'Top 10 procesos ordenados por consumo de memoria',   cmd: 'ps aux --sort=-%mem | head -11' },
        { name: 'Logs del sistema',      desc: 'Últimos 30 mensajes del log del sistema',            cmd: 'journalctl -n 30 --no-pager 2>/dev/null | tail -30' },
      ],
    },
    {
      label: 'Brumexa · Servidor',
      icon: '⬡',
      desc: 'Estado del proceso Node.js y configuración',
      cmds: [
        { name: 'Proceso Node activo',    desc: 'Procesos node/brumexa corriendo ahora mismo',              cmd: 'ps aux | grep -E "node|brumexa" | grep -v grep' },
        { name: 'Versión Node.js',        desc: 'Versión de Node.js y npm instaladas',                      cmd: 'node --version && npm --version' },
        { name: 'Config del servidor',    desc: 'Endpoint /config — plataforma, LiveKit URL, puerto',       cmd: `curl -s http://localhost:${PORT}/config | python3 -m json.tool 2>/dev/null || curl -s http://localhost:${PORT}/config` },
        { name: 'Debug completo',         desc: 'Diagnóstico: ALSA, Bluetooth, info de sistema',            cmd: `curl -s http://localhost:${PORT}/debug | python3 -m json.tool 2>/dev/null || curl -s http://localhost:${PORT}/debug` },
        { name: 'Variables LiveKit',      desc: 'Variables de entorno relacionadas con LiveKit y la API',   cmd: 'env | grep -E "LIVEKIT|TOKEN|PORT|BRUMEXA" | sort' },
        { name: 'pm2 — estado',           desc: 'Estado de procesos gestionados por pm2',                   cmd: 'pm2 list 2>/dev/null || echo "(pm2 no instalado)"' },
        { name: 'pm2 — logs recientes',   desc: 'Últimas 50 líneas del log de pm2',                        cmd: 'pm2 logs --lines 50 --nostream 2>/dev/null || echo "(pm2 no instalado)"' },
        { name: 'Token de sesión',        desc: 'Pide un token al servidor central (test E2E completo)',    cmd: `curl -s http://localhost:${PORT}/token | python3 -m json.tool 2>/dev/null || curl -s http://localhost:${PORT}/token` },
        { name: 'Health de LiveKit',      desc: 'Verifica si el servidor LiveKit cloud responde',           cmd: `curl -s http://localhost:${PORT}/livekit-health` },
        { name: 'Archivos de grabación',  desc: 'Lista archivos WAV guardados con tamaños',                 cmd: 'ls -lh recordings/ 2>/dev/null || echo "carpeta recordings/ no encontrada"' },
      ],
    },
    {
      label: 'Micrófono · Audio ALSA',
      icon: '🎙',
      desc: 'Captura de audio, micrófono y niveles',
      cmds: [
        { name: 'Micrófonos disponibles', desc: 'Lista todos los dispositivos de captura ALSA',              cmd: 'arecord -l 2>&1' },
        { name: 'Altavoces disponibles',  desc: 'Lista todos los dispositivos de reproducción ALSA',         cmd: 'aplay -l 2>&1' },
        { name: 'Tarjetas de sonido',     desc: 'Resumen de tarjetas detectadas por el kernel',              cmd: 'cat /proc/asound/cards 2>/dev/null || echo "sin tarjetas detectadas"' },
        { name: 'Módulos de audio',       desc: 'Módulos del kernel relacionados con sonido (snd_*)',        cmd: 'lsmod | grep snd | sort' },
        { name: 'Info de dispositivo default',desc: 'Qué dispositivo ALSA está configurado como default',   cmd: 'cat ~/.asoundrc 2>/dev/null; cat /etc/asound.conf 2>/dev/null; echo "---"; arecord --dump-hw-params -D default /dev/null 2>&1 | head -20' },
        { name: 'Controles de volumen',   desc: 'Controles del mixer ALSA disponibles (amixer)',             cmd: 'amixer scontrols 2>/dev/null || echo "(amixer no disponible)"' },
        { name: 'Niveles de volumen',     desc: 'Niveles actuales configurados en el mixer ALSA',            cmd: 'amixer 2>/dev/null | grep -E "Simple|dB|%" | head -30 || echo "(amixer no disponible)"' },
        { name: 'Volumen del micrófono',  desc: 'Nivel de captura del mic (Capture, Mic Boost, etc.)',       cmd: 'amixer sget Capture 2>/dev/null || amixer sget Mic 2>/dev/null || amixer sget "ADC Capture" 2>/dev/null || amixer 2>/dev/null | grep -A3 -i capture | head -30' },
        { name: 'Test: grabar 3 segundos',desc: 'Graba 3s del mic default a /tmp — confirma que funciona',  cmd: 'arecord -d 3 -f S16_LE -r 16000 -c 1 /tmp/test_brumexa.wav 2>&1 && ls -lh /tmp/test_brumexa.wav && echo "✓ Micrófono funciona"' },
        { name: 'Test: grabar hw:0,0',    desc: 'Graba 3s forzando tarjeta 0 dispositivo 0',                cmd: 'arecord -d 3 -D hw:0,0 -f S16_LE -r 16000 -c 1 /tmp/test_hw00.wav 2>&1 && ls -lh /tmp/test_hw00.wav' },
        { name: 'Test: grabar hw:1,0',    desc: 'Graba 3s forzando tarjeta 1 dispositivo 0 (USB mic, HAT)', cmd: 'arecord -d 3 -D hw:1,0 -f S16_LE -r 16000 -c 1 /tmp/test_hw10.wav 2>&1 && ls -lh /tmp/test_hw10.wav' },
        { name: 'Nivel de señal en vivo', desc: 'Muestra nivel RMS del micrófono durante 5 segundos',       cmd: 'arecord -d 5 -f S16_LE -r 16000 -c 1 /dev/null 2>&1' },
        { name: 'Formatos soportados',    desc: 'Formatos y frecuencias soportadas por la tarjeta default',  cmd: 'arecord --dump-hw-params -D default /dev/null 2>&1' },
        { name: 'PulseAudio — estado',    desc: 'Estado del servidor PulseAudio (si está corriendo)',        cmd: 'pactl info 2>/dev/null || echo "(PulseAudio no corre — sistema usa ALSA directo)"' },
        { name: 'PulseAudio — sinks',     desc: 'Destinos de audio: altavoces, BT, HDMI',                   cmd: 'pactl list sinks short 2>/dev/null || echo "(PulseAudio no corre)"' },
        { name: 'PulseAudio — sources',   desc: 'Fuentes de audio disponibles (micrófonos en PulseAudio)',  cmd: 'pactl list sources short 2>/dev/null || echo "(PulseAudio no corre)"' },
        { name: 'PulseAudio — volumen',   desc: 'Volumen actual de todas las fuentes y destinos',            cmd: 'pactl list sinks 2>/dev/null | grep -E "Name|Volume|Mute" | head -30' },
        { name: 'Audio en logs',          desc: 'Errores de audio recientes en el log del sistema',          cmd: 'journalctl --no-pager -n 50 2>/dev/null | grep -i -E "alsa|audio|sound|snd|pulse" | tail -20' },
      ],
    },
    {
      label: 'Bluetooth',
      icon: '🔵',
      desc: 'Altavoces BT y conectividad inalámbrica',
      cmds: [
        { name: 'Dispositivos pareados',   desc: 'Todos los dispositivos ya vinculados con la Pi',           cmd: 'bluetoothctl devices Paired 2>&1' },
        { name: 'Dispositivos conectados', desc: 'Dispositivos activos en este momento',                     cmd: 'bluetoothctl devices Connected 2>&1' },
        { name: 'Info del adaptador BT',   desc: 'MAC, nombre y estado del adaptador Bluetooth',             cmd: 'bluetoothctl show 2>&1 | head -20' },
        { name: 'rfkill — bloqueos radio', desc: 'Si el WiFi o BT están bloqueados por software',           cmd: 'rfkill list' },
        { name: 'Servicio Bluetooth',      desc: 'Estado del daemon bluetoothd del sistema',                 cmd: 'systemctl status bluetooth --no-pager 2>&1 | head -25' },
        { name: 'BT como audio sink',      desc: 'Si algún dispositivo BT aparece como altavoz en PA',      cmd: 'pactl list sinks 2>/dev/null | grep -A8 "bluez" || echo "No hay sinks BT en PulseAudio"' },
        { name: 'Logs de Bluetooth',       desc: 'Errores y eventos BT recientes del sistema',              cmd: 'journalctl -u bluetooth --no-pager -n 40 2>/dev/null | tail -40' },
        { name: 'hciconfig',               desc: 'Estado del adaptador HCI Bluetooth (bajo nivel)',          cmd: 'hciconfig hci0 2>/dev/null || echo "(hciconfig no disponible)"' },
      ],
    },
    {
      label: 'GPIO · I2S · Boot',
      icon: '📌',
      desc: 'Pines, overlays de audio y config de arranque',
      cmds: [
        { name: 'Config de boot',          desc: 'Overlays I2S, HDMI y parámetros del firmware',             cmd: 'cat /boot/firmware/config.txt 2>/dev/null || cat /boot/config.txt 2>/dev/null || echo "no encontrado"' },
        { name: 'Overlays activos',        desc: 'Device Tree overlays cargados en este boot',               cmd: 'dtoverlay -l 2>/dev/null || echo "(dtoverlay no disponible)"' },
        { name: 'Módulos I2S cargados',    desc: 'Módulos snd_soc y PCM activos (para I2S HATs)',            cmd: 'lsmod | grep -E "^snd" | sort' },
        { name: 'GPIO — estado de pines',  desc: 'Lectura de todos los pines GPIO (requiere wiringpi)',       cmd: 'gpio readall 2>/dev/null || echo "(gpio/wiringpi no disponible)"' },
        { name: 'Dispositivos I2C',        desc: 'Buses I2C disponibles en /dev/i2c-*',                      cmd: 'ls -la /dev/i2c* 2>/dev/null || echo "sin dispositivos I2C"' },
        { name: 'Dispositivos SPI',        desc: 'Buses SPI disponibles en /dev/spidev*',                    cmd: 'ls -la /dev/spi* 2>/dev/null || echo "sin dispositivos SPI"' },
        { name: 'cmdline.txt',             desc: 'Parámetros pasados al kernel en el arranque',              cmd: 'cat /boot/firmware/cmdline.txt 2>/dev/null || cat /boot/cmdline.txt 2>/dev/null || echo "no encontrado"' },
      ],
    },
  ];

  // ── Estado ───────────────────────────────────────────────────────────────
  let _running = false;
  let _inited  = false;
  let _allItems = [];   // lista plana para búsqueda: { el, name, desc, cmd, groupLabel }

  const $ = id => document.getElementById(id);

  // ── Construir sidebar ────────────────────────────────────────────────────
  function _build() {
    const container = $('term-groups');
    if (!container) return;
    _allItems = [];

    for (const group of GROUPS) {
      const sec = document.createElement('div');
      sec.className = 'term-group';
      sec.dataset.group = group.label;

      sec.innerHTML =
        `<div class="term-group__hdr">` +
          `<span class="term-group__icon">${group.icon}</span>` +
          `<span class="term-group__name">${group.label}</span>` +
        `</div>` +
        `<div class="term-group__desc">${group.desc}</div>`;

      const ul = document.createElement('ul');
      ul.className = 'term-cmd-list';

      for (const c of group.cmds) {
        const li = _makeItem(c, group.label);
        ul.appendChild(li);
        _allItems.push({ el: li, name: c.name.toLowerCase(), desc: c.desc.toLowerCase(), cmd: c.cmd.toLowerCase(), groupLabel: group.label.toLowerCase() });
      }

      sec.appendChild(ul);
      container.appendChild(sec);
    }
  }

  function _makeItem(c, groupLabel) {
    const li = document.createElement('li');
    li.className = 'term-cmd-item';
    li.title = c.cmd;
    li.innerHTML =
      `<div class="term-cmd-item__top">` +
        `<span class="term-cmd-item__name">${_esc(c.name)}</span>` +
        `<span class="term-cmd-item__group">${_esc(groupLabel)}</span>` +
      `</div>` +
      `<span class="term-cmd-item__desc">${_esc(c.desc)}</span>` +
      `<code class="term-cmd-item__code">${_esc(c.cmd)}</code>`;
    li.addEventListener('click', () => run(c.cmd, c.name));
    return li;
  }

  // ── Buscador ──────────────────────────────────────────────────────────────
  function _initSearch() {
    const input = $('term-search');
    if (!input) return;

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      _filter(q);
    });

    // Limpiar con Escape
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { input.value = ''; _filter(''); }
    });
  }

  function _filter(q) {
    const container = $('term-groups');
    if (!container) return;

    if (!q) {
      container.classList.remove('is-searching');
      for (const { el } of _allItems) el.style.display = '';
      for (const sec of container.querySelectorAll('.term-group')) sec.style.display = '';
      return;
    }

    container.classList.add('is-searching');

    // Filtrar items
    for (const item of _allItems) {
      const match = item.name.includes(q) || item.desc.includes(q) || item.cmd.includes(q) || item.groupLabel.includes(q);
      item.el.style.display = match ? '' : 'none';
    }

    // Ocultar grupos sin resultados
    for (const sec of container.querySelectorAll('.term-group')) {
      const visible = [...sec.querySelectorAll('.term-cmd-item')].some(li => li.style.display !== 'none');
      sec.style.display = visible ? '' : 'none';
    }
  }

  // ── Ejecutar ─────────────────────────────────────────────────────────────
  async function run(cmd, label) {
    if (_running) return;
    _running = true;

    const runBtn  = $('btn-term-run');
    const inputEl = $('term-input');
    if (runBtn) runBtn.disabled = true;

    const pendingId = 'term-entry-pending';
    _addEntry({ cmd, label: label || cmd, output: null, exitCode: null, ms: null, id: pendingId });

    try {
      const res  = await fetch('/terminal/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      _addEntry({ cmd, label: label || cmd, output: data.output, exitCode: data.exitCode, ms: data.ms, replace: pendingId });
    } catch (err) {
      _addEntry({ cmd, label: label || cmd, output: `Error de red: ${err.message}`, exitCode: -1, ms: null, replace: pendingId });
    } finally {
      _running = false;
      if (runBtn) runBtn.disabled = false;
      if (inputEl) inputEl.focus();
    }
  }

  // ── Render entrada ───────────────────────────────────────────────────────
  function _addEntry({ cmd, label, output, exitCode, ms, id, replace }) {
    const out = $('term-output');
    if (!out) return;

    const ok   = exitCode === null || exitCode === 0;
    const time = new Date().toLocaleTimeString('es-AR', { hour12: false });

    const badge = exitCode !== null
      ? `<span class="term-badge ${ok ? 'term-badge--ok' : 'term-badge--err'}">${ok ? 'OK' : `exit ${exitCode}`}${ms != null ? ` · ${ms}ms` : ''}</span>`
      : `<span class="term-badge term-badge--run">ejecutando…</span>`;

    const entry = document.createElement('div');
    if (id) entry.id = id;
    entry.className = `term-entry${ok ? '' : ' term-entry--err'}`;
    entry.innerHTML =
      `<div class="term-entry__hdr">` +
        `<span class="term-entry__prompt">$</span>` +
        `<span class="term-entry__name">${_esc(label)}</span>` +
        badge +
        `<span class="term-entry__time">${time}</span>` +
      `</div>` +
      `<div class="term-entry__cmd-row"><code class="term-entry__cmd">${_esc(cmd)}</code></div>` +
      (output !== null
        ? `<pre class="term-entry__body${ok ? '' : ' term-entry__body--err'}">${_esc(output)}</pre>`
        : '');

    if (replace) {
      const old = $(replace);
      old ? old.replaceWith(entry) : out.appendChild(entry);
    } else {
      out.appendChild(entry);
    }

    out.scrollTop = out.scrollHeight;
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function clear() {
    const out = $('term-output');
    if (out) out.innerHTML = '';
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    if (_inited) return;
    _inited = true;

    _build();
    _initSearch();

    const inputEl = $('term-input');
    const runBtn  = $('btn-term-run');

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

    $('btn-term-clear')?.addEventListener('click', clear);

    run('echo "Brumexa Pi Terminal" && echo "Host: $(hostname)" && echo "Fecha: $(date)" && uname -m', 'Bienvenida');
  }

  return { init, run, clear };
})();
