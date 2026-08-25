'use strict';

// ============================================================
// Página de Diagnóstico — deliberadamente un script APARTE de app.js
// (Panel), no compartido. app.js tiene un montón de módulos (grabaciones,
// mic test, LEDs lab) que dependían de elementos que vivían en el Panel —
// intentar reusarlo acá hubiera significado o duplicar esos módulos con
// referencias DOM que ya no existen (crash al cargar la página) o llenar
// app.js de guards por todos lados solo para que tolere la mitad de sus
// elementos ausentes. Más simple y más seguro: una página, un script,
// autocontenido, sin ninguna dependencia del flujo de conexión de LiveKit.
// ============================================================

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ─── Resultado general — un renglón por subsistema, arranca en "Sin
// probar" y se va llenando a medida que cada card corre su propio chequeo.
// LEDs y Micrófono se autochequean solos al cargar (son de solo lectura,
// sin efecto secundario); Parlante/Conexión/Grabaciones son manuales
// porque SÍ tienen efecto (suena un tono, pega contra la API real, graba). ──
const Summary = {
  // Mismos nombres de clase/estructura que .dbg-rows del Panel (dbg-val /
  // dbg-dot) — reusa el CSS que ya existe en vez de inventar uno nuevo.
  set(key, status, text) {
    const valEl = document.getElementById(`sum-${key}-val`);
    const dotEl = document.getElementById(`sum-${key}-dot`);
    if (valEl) valEl.textContent = text;
    if (dotEl) dotEl.className = `dbg-dot ${status}`;
  },
};

// ============================================================
// MICRÓFONO — nivel en vivo vía polling de /diag/mic-level (mismo dato que
// ya alimenta la respiración/detección de "hablando" en el server) en vez
// de capturar audio del browser con Web Audio API. Mucho más simple, y
// funciona igual estés en la Pi con el mic en reposo o en medio de una
// sesión — es el nivel REAL que el dispositivo ya está viendo, no una
// captura aparte.
// ============================================================
const MicMeter = {
  _timer: null,

  start() {
    if (this._timer) return;
    this._tick();
    this._timer = setInterval(() => this._tick(), 200);
  },

  // GET /diag/mic-level — a propósito NO usa /local/status: ese endpoint
  // corre ~8 comandos de shell síncronos (arecord -l, aplay -l, pgrep,
  // vcgencmd, bluetoothctl x2, tail de logs) + un fetch de red a la RAG API
  // en CADA llamada — pensado para cargarse una vez en un dashboard, no
  // para sondearlo cada 200ms. Sondeado así, esos ~8 execSync BLOQUEANTES
  // (cortan el event loop entero de Node — audio, LEDs, todo)
  // cinco veces por segundo terminaban trabando el dispositivo entero
  // mientras esta página estuviera abierta. /diag/mic-level solo lee una
  // variable en memoria, no spawnea nada.
  async _tick() {
    const bar    = document.getElementById('mic-vu-bar');
    const dbEl   = document.getElementById('mic-vu-db');
    const noteEl = document.getElementById('mic-vu-note');
    if (!bar) return;

    let mic;
    try {
      mic = await fetch('/diag/mic-level', { cache: 'no-store' }).then(r => r.json());

      const level = Math.max(0, Math.min(1, mic.level || 0));
      const db    = mic.peak > 0 ? (20 * Math.log10(mic.peak / 32767)).toFixed(1) : '-∞';
      const color = level < 0.5 ? '#3dba76' : level < 0.8 ? '#e0a032' : '#e05555';
      bar.style.width      = `${Math.round(level * 100)}%`;
      bar.style.background = color;
      dbEl.textContent     = `${db} dBFS`;

      const ageMs   = mic.updatedAt ? Date.now() - mic.updatedAt : Infinity;
      const flowing = ageMs < 1500;
      if (!mic.monitorActive && !flowing) {
        noteEl.textContent = 'El monitor de mic no está corriendo ahora mismo (¿mic desactivado en Configuración, sesión activa capturando el device, o este server no está corriendo en la Raspberry?).';
        Summary.set('mic', 'warn', 'Monitor inactivo');
      } else {
        noteEl.textContent = flowing
          ? 'Recibiendo audio en vivo — hablá cerca del mic para ver la barra moverse.'
          : 'Monitor activo, esperando la primera lectura…';
        Summary.set('mic', flowing ? 'ok' : 'warn', flowing ? 'Recibiendo audio' : 'Activo, sin señal reciente');
      }
    } catch (e) {
      noteEl.textContent = `Error consultando el estado: ${e.message}`;
      Summary.set('mic', 'error', 'Sin respuesta del servidor');
      return;
    }

    // ── Panorama de sonido: mismo poll de arriba, reusado para alimentar un
    // historial rolling y redibujar el gráfico — un solo request por tick.
    const dbfs = mic.peak > 0 ? 20 * Math.log10(mic.peak / 32767) : -90;
    this._history.push({
      dbfs,
      ambientFloorDbfs:       mic.ambientFloorDbfs,
      effectiveThresholdDbfs: mic.effectiveThresholdDbfs,
      gateOpen: !!mic.gateOpen,
      sensing:  !!mic.sensing,
    });
    if (this._history.length > this.MAX_SAMPLES) this._history.shift();
    this._calibratedThresholdDbfs = mic.calibratedThresholdDbfs;
    this._renderChart();
    this._renderStatus(mic);
    this._renderNumbers(mic, dbfs);
  },

  // Los mismos 4 valores del gráfico, pero como número — la línea sirve
  // para ver la tendencia, pero para decidir "¿cuánto margen tengo?" un
  // número exacto es más rápido de leer que estimar contra el eje Y.
  _renderNumbers(mic, dbfs) {
    const kv = document.getElementById('kv-sound-numbers');
    if (!kv) return;
    const fmt = v => (v === null || v === undefined || isNaN(v)) ? '—' : `${v.toFixed(1)} dBFS`;
    const eff = mic.effectiveThresholdDbfs;
    const margin = (eff !== null && eff !== undefined && !isNaN(eff)) ? dbfs - eff : null;
    kv.innerHTML = kvRows([
      ['Nivel actual',       fmt(dbfs)],
      ['Piso ambiente',      fmt(mic.ambientFloorDbfs)],
      ['Umbral calibrado',   fmt(mic.calibratedThresholdDbfs)],
      ['Umbral efectivo',    fmt(mic.effectiveThresholdDbfs)],
      ['Margen al umbral',   margin === null ? '—' : `${margin >= 0 ? '+' : ''}${margin.toFixed(1)} dB${margin >= 0 ? ' (por encima → hablando)' : ' (por debajo → silencio)'}`],
    ]);
  },

  // "¿Qué está pasando AHORA?" — prioriza señales que sirven para MEDIR el
  // entorno, no cualquier parpadeo interno del gate. "Sensando" (isSensing,
  // ~100-250ms, cualquier muestra que roza el umbral) se sacó de acá: dura
  // demasiado poco y no dice nada real del cuarto. En cambio, si el umbral
  // EFECTIVO subió por encima del calibrado (ver mic-speech-gate.js) SÍ es
  // una señal real de "el ambiente está más ruidoso que cuando calibraste"
  // — eso es justo lo que sirve para decidir si conviene recalibrar.
  _renderStatus(mic) {
    const el = document.getElementById('sound-status-pill');
    if (!el) return;

    if (mic.sessionActive && !mic.micGateEnabled) {
      el.className = 'pill dot warn';
      el.textContent = '⚠️ Gate OFF — todo sin filtrar';
      return;
    }

    const rise = (mic.effectiveThresholdDbfs != null && mic.calibratedThresholdDbfs != null)
      ? mic.effectiveThresholdDbfs - mic.calibratedThresholdDbfs
      : 0;
    const noisyEnv = rise > 2; // >2dB por encima de lo calibrado — el piso ambiente ya lo empujó

    const detect = mic.gateOpen
      ? '🎙 Hablando'
      : noisyEnv ? `🔊 Ambiente ruidoso (+${rise.toFixed(1)}dB)` : '🤫 Silencio';

    let cls, tx;
    if (!mic.sessionActive) {
      cls = mic.gateOpen ? 'live' : noisyEnv ? 'warn' : 'muted';
      tx = 'sin sesión';
    } else if (mic.gateOpen) {
      cls = 'live'; tx = '→ LiveKit';
    } else {
      cls = noisyEnv ? 'warn' : 'muted';
      tx = 'atenuado';
    }

    el.className = `pill dot ${cls}`;
    el.textContent = `${detect} · ${tx}`;
  },

  // ── Gráfico: dBFS en vivo + umbral calibrado (fijo) + umbral efectivo
  // (sube solo si el ambiente está más ruidoso que al calibrar) + franjas de
  // fondo marcando "sensando" (violeta) y "hablando confirmado" (ámbar) —
  // SVG a mano (mismo criterio que el sparkline de calibración en
  // /configuracion), sin ninguna librería de gráficos, no hace falta.
  MAX_SAMPLES: 150, // ~30s a 200ms/muestra
  Y_MIN: -60,
  Y_MAX: 0,
  CHART_W: 640, CHART_H: 130, PAD_L: 34, PAD_R: 6, PAD_T: 6, PAD_B: 6,
  _history: [],
  _calibratedThresholdDbfs: null,

  _xFor(i, n) {
    const usable = this.CHART_W - this.PAD_L - this.PAD_R;
    return this.PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * usable);
  },
  _yFor(dbfs) {
    const v = Math.max(this.Y_MIN, Math.min(this.Y_MAX, dbfs));
    const usable = this.CHART_H - this.PAD_T - this.PAD_B;
    return this.PAD_T + (1 - (v - this.Y_MIN) / (this.Y_MAX - this.Y_MIN)) * usable;
  },
  _points(getter) {
    const hist = this._history, n = hist.length, out = [];
    for (let i = 0; i < n; i++) {
      const v = getter(hist[i]);
      if (v === null || v === undefined || isNaN(v)) continue;
      out.push(`${this._xFor(i, n).toFixed(1)},${this._yFor(v).toFixed(1)}`);
    }
    return out.join(' ');
  },
  _renderChart() {
    const wrap = document.getElementById('sound-chart-wrap');
    if (!wrap) return;
    const hist = this._history, n = hist.length;
    if (!n) { wrap.innerHTML = '<p class="field-hint">Esperando datos…</p>'; return; }

    const step = n > 1 ? (this.CHART_W - this.PAD_L - this.PAD_R) / (n - 1) : (this.CHART_W - this.PAD_L - this.PAD_R);
    let bands = '';
    for (let i = 0; i < n; i++) {
      const s = hist[i];
      if (!s.gateOpen && !s.sensing) continue;
      const x = this._xFor(i, n) - step / 2;
      const color = s.gateOpen ? 'rgba(224,160,50,0.30)' : 'rgba(140,110,230,0.22)';
      bands += `<rect x="${x.toFixed(1)}" y="${this.PAD_T}" width="${(step + 0.6).toFixed(1)}" height="${this.CHART_H - this.PAD_T - this.PAD_B}" fill="${color}" />`;
    }

    let grid = '';
    for (const db of [0, -20, -40, -60]) {
      const y = this._yFor(db);
      grid += `<line x1="${this.PAD_L}" y1="${y.toFixed(1)}" x2="${this.CHART_W - this.PAD_R}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1" />`;
      grid += `<text x="2" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--text2)">${db}</text>`;
    }

    const dbfsLine   = this._points(s => s.dbfs);
    const ambLine    = this._points(s => s.ambientFloorDbfs);
    const effLine    = this._points(s => s.effectiveThresholdDbfs);
    const calibY     = this._calibratedThresholdDbfs != null ? this._yFor(this._calibratedThresholdDbfs) : null;

    wrap.innerHTML = `
      <svg width="100%" height="${this.CHART_H}" viewBox="0 0 ${this.CHART_W} ${this.CHART_H}" style="display:block; min-width:420px; background:var(--bg); border-radius:8px">
        ${bands}
        ${grid}
        ${calibY !== null ? `<line x1="${this.PAD_L}" y1="${calibY.toFixed(1)}" x2="${this.CHART_W - this.PAD_R}" y2="${calibY.toFixed(1)}" stroke="var(--text2)" stroke-width="1" stroke-dasharray="4,3" />` : ''}
        ${ambLine ? `<polyline points="${ambLine}" fill="none" stroke="var(--text2)" stroke-width="1" stroke-dasharray="1,2" opacity="0.8" />` : ''}
        ${effLine ? `<polyline points="${effLine}" fill="none" stroke="#3dc7e0" stroke-width="1.3" />` : ''}
        <polyline points="${dbfsLine}" fill="none" stroke="var(--accent)" stroke-width="1.6" />
      </svg>
    `;

    const legend = document.getElementById('sound-legend');
    if (legend) {
      legend.innerHTML = `
        <span><i style="background:var(--accent)"></i>Nivel real (dBFS)</span>
        <span><i style="background:#3dc7e0"></i>Umbral efectivo (en vivo)</span>
        <span><i style="background:var(--text2)"></i>Piso ambiente / umbral calibrado</span>
        <span><i style="background:rgba(224,160,50,0.7)"></i>Hablando confirmado</span>
        <span><i style="background:rgba(140,110,230,0.6)"></i>Sensando</span>
      `;
    }
  },
};

// ============================================================
// PARLANTE — mismo endpoint que ya usaba Configuración
// ============================================================
async function runSpeakerTest() {
  const btn    = document.getElementById('btn-speaker-test');
  const result = document.getElementById('speaker-test-result');
  btn.disabled = true;
  btn.textContent = '🔊 Reproduciendo…';
  result.innerHTML = '';
  try {
    const res  = await fetch('/configuracion/speaker-test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      result.innerHTML = `<div class="pill ok">✅ ${esc(data.note || 'Tono reproducido')}</div>`;
      Summary.set('speaker', 'ok', 'Tono reproducido');
    } else {
      result.innerHTML = `<div class="pill bad">⚠ Error: ${esc(data.error || data.output || 'desconocido')}</div>`;
      Summary.set('speaker', 'error', data.error || 'Falló');
    }
  } catch (e) {
    result.innerHTML = `<div class="pill bad">⚠ Error: ${esc(e.message)}</div>`;
    Summary.set('speaker', 'error', 'Sin respuesta del servidor');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔊 Probar parlante (tono 1kHz)';
  }
}

// ============================================================
// DIAGNÓSTICO DE CONEXIÓN — RAG API + token de LiveKit, mismo par de
// endpoints que ya usaba Configuración.
// ============================================================
function kvRows(pairs) {
  return pairs
    .map(([k, v]) => {
      const val = (v === null || v === undefined || v === '') ? '—' : v;
      return `<div class="kv-row"><span class="k">${k}</span><span class="v">${val}</span></div>`;
    })
    .join('');
}

async function testConnection() {
  const btn    = document.getElementById('btn-test-connection');
  const kv     = document.getElementById('kv-diag');
  const result = document.getElementById('diag-result');
  btn.disabled = true;
  btn.textContent = 'Probando…';
  kv.innerHTML = '';
  result.innerHTML = '';

  let auth;
  try {
    auth = await fetch('/configuracion/force-auth', { method: 'POST' }).then(r => r.json());
  } catch (e) {
    auth = { ok: false, error: e.message };
  }

  const rows = [
    ['Autenticación', auth.ok ? '✅ OK' : `❌ ${esc(auth.error || 'falló')}`],
    ['Negocio', auth.status?.businessId || '—'],
  ];

  let token = null;
  if (auth.ok) {
    try {
      token = await fetch('/configuracion/force-token', { method: 'POST' }).then(r => r.json());
    } catch (e) {
      token = { ok: false, error: e.message };
    }
    rows.push(['Token LiveKit', token.ok ? '✅ OK' : `❌ ${esc(token.error || 'falló')}`]);
    if (token.ok) {
      rows.push(['Sala', token.roomName]);
      rows.push(['Servidor', token.serverUrl]);
    }
  }

  kv.innerHTML = kvRows(rows);
  const allOk = auth.ok && token?.ok;
  result.innerHTML = allOk
    ? '<div class="flow-note ok">✔ Todo funciona — autenticación y token de LiveKit OK</div>'
    : '<div class="flow-note bad">✘ Algo falló — revisá las credenciales en Configuración</div>';
  Summary.set('conn', allOk ? 'ok' : 'error', allOk ? 'Autenticación y token OK' : 'Falló — ver detalle abajo');

  btn.disabled = false;
  btn.textContent = 'Probar conexión';
}

// ============================================================
// LEDS — estado (paquete instalado / configurado), chispazo de prueba, y
// laboratorio inline de hue/saturación/brillo sobre el hardware real.
// ============================================================
const LedsDiag = {
  async check() {
    const kv = document.getElementById('kv-leds-diag');
    try {
      const d = await fetch('/diag/leds').then(r => r.json());
      if (d.platform !== 'linux') {
        kv.innerHTML = kvRows([['Estado', `No aplica — plataforma: ${d.platform}`]]);
        Summary.set('leds', 'idle', 'No aplica en este equipo');
        return;
      }
      if (!d.packageInstalled) {
        kv.innerHTML = kvRows([['Estado', '❌ Paquete no instalado'], ['Detalle', 'rpi-ws281x no está en node_modules — correr: sudo npm install rpi-ws281x']]);
        Summary.set('leds', 'error', 'Paquete no instalado');
        return;
      }
      if (!d.configured) {
        const rootHint = d.isRoot === false ? ' — probá corriendo el server con sudo' : '';
        kv.innerHTML = kvRows([['Estado', '⚠ Instalado, pero falló al configurar'], ['Detalle', `${d.lastError || 'error desconocido'}${rootHint}`]]);
        Summary.set('leds', 'error', 'Falló al configurar');
        return;
      }
      const rootWarn = d.isRoot === false ? ' ⚠ no corre como root' : '';
      kv.innerHTML = kvRows([
        ['Estado', `✅ OK — v${d.packageVersion}`],
        ['LEDs', `${d.numLeds} en GPIO ${d.gpioPin}${rootWarn}`],
      ]);
      Summary.set('leds', 'ok', `OK — ${d.numLeds} LEDs`);
    } catch (e) {
      kv.innerHTML = kvRows([['Estado', `❌ Sin respuesta: ${e.message}`]]);
      Summary.set('leds', 'error', 'Sin respuesta del servidor');
    }
  },
};

// Laboratorio de color — igual lógica que el modal viejo del Panel, pero
// inline (esta página ya ES el lugar dedicado a probar cosas, no hace
// falta un overlay encima de otra pantalla). "Salir del laboratorio"
// reemplaza al cierre del modal — restaura el color de carcasa normal.
const LedsLab = {
  _sendTimer: null,
  _settleTimer: null,
  _active: false,

  init() {
    const hueEl = document.getElementById('leds-lab-hue');
    const satEl = document.getElementById('leds-lab-sat');
    const valEl = document.getElementById('leds-lab-val');
    if (!hueEl) return;
    const onMove = () => { this._active = true; this._render(); };
    hueEl.addEventListener('input', onMove);
    satEl.addEventListener('input', onMove);
    valEl.addEventListener('input', onMove);
    document.getElementById('btn-leds-lab-exit')?.addEventListener('click', () => this.exit());
    this._render();
  },

  _hsvToRgb(h, s, v) {
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const table = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i];
    return table.map(ch => Math.round(ch * 255));
  },
  _toCss([r, g, b]) { return `rgb(${r},${g},${b})`; },

  _render() {
    const hueEl = document.getElementById('leds-lab-hue');
    const satEl = document.getElementById('leds-lab-sat');
    const valEl = document.getElementById('leds-lab-val');
    const swatchEl = document.getElementById('leds-lab-swatch');
    const h = Number(hueEl.value);
    const s = Number(satEl.value) / 100;
    const v = Number(valEl.value) / 100;
    const [r, g, b] = this._hsvToRgb(h, s, v);

    swatchEl.style.background = `rgb(${r},${g},${b})`;
    satEl.style.background = `linear-gradient(to right, ${this._toCss(this._hsvToRgb(h, 0, v))}, ${this._toCss(this._hsvToRgb(h, 1, v))})`;
    valEl.style.background = `linear-gradient(to right, #000, ${this._toCss(this._hsvToRgb(h, s, 1))})`;

    if (!this._active) return; // no mandar nada hasta que el usuario toque un slider

    clearTimeout(this._sendTimer);
    this._sendTimer = setTimeout(() => {
      fetch('/diag/leds/set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ h, s, v }),
      }).catch(() => {});
    }, 40);

    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      fetch('/diag/leds/preview-breathe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ h, s }),
      }).catch(() => {});
    }, 2000);
  },

  exit() {
    this._active = false;
    clearTimeout(this._sendTimer);
    clearTimeout(this._settleTimer);
    fetch('/diag/leds/set/exit', { method: 'POST' }).catch(() => {});
    const result = document.getElementById('leds-lab-result');
    if (result) result.innerHTML = '<div class="pill ok">✔ Laboratorio cerrado — volvió al color normal de la carcasa</div>';
  },
};

// ============================================================
// GRABACIONES — versión simplificada: solo ALSA server-side (arecord/
// aplay en la Pi), sin el path de MediaRecorder del browser ni el
// selector de fuente — esta página siempre prueba EL MIC DE ESTE
// DISPOSITIVO, no tiene sentido elegir "browser" acá.
// ============================================================
const Recorder = {
  _interval: null,
  _elapsed: 0,
  _statusPoll: null,
  _playPoll: null,
  _playBtn: null,

  async show() {
    await this.refreshList();
  },

  async start() {
    try {
      const res = await fetch('/record/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(r => r.json());
      if (!res.ok) throw new Error(res.error);

      document.getElementById('btn-rec-start').style.display = 'none';
      document.getElementById('btn-rec-stop').style.display  = '';
      document.getElementById('rec-timer').style.display     = '';
      this._elapsed = 0;
      this._interval = setInterval(() => {
        this._elapsed++;
        document.getElementById('rec-seconds').textContent = this._elapsed;
      }, 1000);

      this._statusPoll = setInterval(async () => {
        try {
          const s = await fetch('/record/status').then(r => r.json());
          if (!s.recording && this._interval !== null) {
            this._resetButtons();
            document.getElementById('rec-result').innerHTML =
              '<div class="pill bad">⚠ La grabación terminó sola — revisá el dispositivo de mic</div>';
            await this.refreshList();
          }
        } catch {}
      }, 2000);
    } catch (e) {
      document.getElementById('rec-result').innerHTML = `<div class="pill bad">⚠ ${esc(e.message)}</div>`;
    }
  },

  async stop() {
    if (this._statusPoll) { clearInterval(this._statusPoll); this._statusPoll = null; }
    clearInterval(this._interval);
    this._interval = null;
    try {
      const res = await fetch('/record/stop', { method: 'POST' }).then(r => r.json());
      this._resetButtons();
      if (!res.ok) throw new Error(res.error);
      document.getElementById('rec-result').innerHTML =
        `<div class="pill ok">✔ Guardado: ${esc(res.filename)} (${res.duration}s)</div>`;
      await new Promise(r => setTimeout(r, 400));
      await this.refreshList();
    } catch (e) {
      document.getElementById('rec-result').innerHTML = `<div class="pill bad">⚠ ${esc(e.message)}</div>`;
    }
  },

  _resetButtons() {
    document.getElementById('btn-rec-stop').style.display  = 'none';
    document.getElementById('btn-rec-start').style.display = '';
    document.getElementById('rec-timer').style.display     = 'none';
    document.getElementById('rec-seconds').textContent     = '0';
  },

  async refreshList() {
    const list = document.getElementById('recordings-list');
    try {
      const { files } = await fetch('/recordings').then(r => r.json());
      list.innerHTML = '';
      if (files.length === 0) {
        list.innerHTML = '<li class="rec-empty">Sin grabaciones aún.</li>';
        return;
      }
      for (const f of files) list.appendChild(this._makeRecItem(f));
    } catch (e) {
      list.innerHTML = `<li class="rec-empty">Error cargando grabaciones: ${esc(e.message)}</li>`;
    }
  },

  _makeRecItem(f) {
    const kb   = (f.size / 1024).toFixed(1);
    const date = new Date(f.created).toLocaleString();

    const li = document.createElement('li');
    li.className = 'rec-item';

    // .rec-item-name/.rec-item-size traen grid-column/grid-row pensados
    // para CUANDO había un ícono de fuente (🌐/🍓) como primer hijo — acá
    // no hay ícono (esta página solo graba con el mic de la Pi), así que
    // se pisa el placement a mano en vez de heredar el hueco de esa columna.
    const nameEl = document.createElement('span');
    nameEl.className = 'rec-item-name';
    nameEl.style.gridColumn = '1 / span 4';
    nameEl.style.gridRow    = '1';
    nameEl.title = f.filename;
    nameEl.textContent = f.filename;

    const sizeEl = document.createElement('span');
    sizeEl.className = 'rec-item-size';
    sizeEl.style.gridColumn = '1';
    sizeEl.style.gridRow    = '2';
    sizeEl.textContent = `${kb} KB · ${date}`;

    const playBtn = document.createElement('button');
    playBtn.className = 'rec-item-play';
    playBtn.style.gridColumn = '2';
    playBtn.style.gridRow    = '2';
    playBtn.textContent = '▶';
    playBtn.title = 'Reproducir en el parlante de este dispositivo';
    playBtn.addEventListener('click', () => {
      if (playBtn.classList.contains('playing')) this._stopPlay();
      else this._play(f.filename, playBtn);
    });

    const dlLink = document.createElement('a');
    dlLink.className = 'rec-item-dl';
    dlLink.style.gridColumn = '3';
    dlLink.style.gridRow    = '2';
    dlLink.href = `/recordings/${encodeURIComponent(f.filename)}`;
    dlLink.download = f.filename;
    dlLink.textContent = '↓';

    const delBtn = document.createElement('button');
    delBtn.className = 'rec-item-del';
    delBtn.style.gridColumn = '4';
    delBtn.style.gridRow    = '2';
    delBtn.textContent = '🗑';
    delBtn.title = 'Eliminar';
    delBtn.addEventListener('click', async () => {
      if (delBtn.disabled) return;
      if (!confirm(`¿Eliminar "${f.filename}"?`)) return;
      delBtn.disabled = true;
      try {
        const res = await fetch(`/recordings/${encodeURIComponent(f.filename)}`, { method: 'DELETE' }).then(r => r.json());
        if (!res.ok) throw new Error(res.error);
        await this.refreshList();
      } catch (e) {
        delBtn.disabled = false;
        alert(`Error al eliminar: ${e.message}`);
      }
    });

    li.append(nameEl, sizeEl, playBtn, dlLink, delBtn);
    return li;
  },

  async _play(filename, btn) {
    await this._stopPlay();
    this._playBtn = btn;
    btn.textContent = '⏹';
    btn.classList.add('playing');
    try {
      const res = await fetch('/recordings/play', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      }).then(r => r.json());
      if (!res.ok) { this._finishPlay(); alert(`Error: ${res.error}`); return; }

      let ticks = 0;
      this._playPoll = setInterval(async () => {
        ticks++;
        if (ticks > 2250) { this._finishPlay(); return; }
        try {
          const { playing } = await fetch('/recordings/play-status').then(r => r.json());
          if (!playing) this._finishPlay();
        } catch { this._finishPlay(); }
      }, 800);
    } catch (e) {
      this._finishPlay();
      alert(`Error: ${e.message}`);
    }
  },

  async _stopPlay() {
    if (this._playPoll) { clearInterval(this._playPoll); this._playPoll = null; }
    if (this._playBtn) {
      try { await fetch('/recordings/stop-play', { method: 'POST' }); } catch {}
    }
    this._finishPlay();
  },

  _finishPlay() {
    if (this._playPoll) { clearInterval(this._playPoll); this._playPoll = null; }
    if (this._playBtn) {
      this._playBtn.textContent = '▶';
      this._playBtn.classList.remove('playing');
      this._playBtn = null;
    }
  },
};

// ============================================================
// CALIBRACIÓN — panorama: valores actuales + historial de corridas guardado
// en disco (lib/calibration-history.js), para ver cómo cambió el umbral
// entre distintos días/ambientes, no solo la última corrida.
// ============================================================
const CalibrationPanorama = {
  async load() {
    const kv       = document.getElementById('kv-calibration-diag');
    const histWrap = document.getElementById('calibration-history-wrap');
    if (!kv) return;

    try {
      const status = await fetch('/configuracion/status', { cache: 'no-store' }).then(r => r.json());
      const cal = status.calibration;
      kv.innerHTML = !cal
        ? kvRows([['Estado', 'Sin calibrar todavía']])
        : kvRows([
            ['Piso de ruido medido', `${cal.noiseFloorDbfs} dBFS`],
            ['Umbral aplicado',      `${cal.threshold} dBFS`],
            ['Margen',               `+${cal.marginDb} dB`],
            ['Cuándo',               new Date(cal.measuredAt).toLocaleString('es-AR')],
            ['Disparada por',        cal.triggeredBy === 'boot' ? 'Automática (arranque)' : 'Manual'],
          ]);
    } catch (e) {
      kv.innerHTML = kvRows([['Estado', `Error: ${esc(e.message)}`]]);
    }

    try {
      const { runs } = await fetch('/diag/calibration-history', { cache: 'no-store' }).then(r => r.json());
      this._renderHistory(histWrap, runs || []);
    } catch {
      if (histWrap) histWrap.innerHTML = '';
    }
  },

  _renderHistory(wrap, runs) {
    if (!wrap) return;
    if (!runs.length) { wrap.innerHTML = '<p class="field-hint">Todavía no hay historial guardado — se va a ir llenando con cada calibración (automática al arrancar o manual).</p>'; return; }

    const thresholds = runs.map(r => r.threshold);
    const lo = Math.min(...thresholds) - 2;
    const hi = Math.max(...thresholds, -12) + 2;
    const bars = runs.map(r => {
      const pct   = Math.max(4, Math.round(((r.threshold - lo) / (hi - lo || 1)) * 100));
      const date  = new Date(r.measuredAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
      const title = `${date} — umbral ${r.threshold}dBFS (piso ${r.noiseFloorDbfs}dBFS, ${r.triggeredBy === 'boot' ? 'auto' : 'manual'})`;
      return `<div class="calib-history-bar" style="height:${pct}%" title="${esc(title)}"></div>`;
    }).join('');

    wrap.innerHTML = `
      <div class="field-hint" style="margin-bottom:4px">Historial de umbrales (${runs.length} corrida${runs.length === 1 ? '' : 's'} — pasá el mouse por una barra)</div>
      <div class="calib-history-row">${bars}</div>
    `;
  },
};

// ============================================================
// INIT
// ============================================================
(async function init() {
  document.getElementById('btn-speaker-test')?.addEventListener('click', runSpeakerTest);
  document.getElementById('btn-test-connection')?.addEventListener('click', testConnection);
  document.getElementById('btn-rec-start')?.addEventListener('click', () => Recorder.start());
  document.getElementById('btn-rec-stop')?.addEventListener('click', () => Recorder.stop());

  // Todo lo que es Linux-only se avisa acá arriba una sola vez, en vez de
  // que cada card lo chequee por separado.
  try {
    const cfg = await fetch('/config', { cache: 'no-store' }).then(r => r.json());
    if (cfg.server?.platform !== 'linux') {
      document.getElementById('diagnostico-platform-note').style.display = '';
      document.getElementById('diagnostico-platform-note').textContent =
        `Algunas pruebas (mic, parlante, LEDs, grabaciones) solo están disponibles en la Raspberry — este server corre en ${cfg.server?.platform || 'este equipo'}.`;
    }
  } catch {}

  MicMeter.start();
  LedsDiag.check();
  LedsLab.init();
  CalibrationPanorama.load();
  await Recorder.show();
})();
