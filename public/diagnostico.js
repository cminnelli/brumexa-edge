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
  //
  // La card de "Micrófono — nivel en vivo" (barra VU suelta) se sacó por
  // redundante con Panorama de sonido, que muestra lo mismo con más
  // contexto (piso/umbral/margen). Pero este mismo tick sigue siendo dueño
  // de Summary.set('mic', ...) (la fila de "Resultado general") Y de
  // alimentar el historial del gráfico de Panorama — así que NO corta
  // temprano si no encuentra la barra vieja, solo se salta escribirle a
  // esos elementos si no existen.
  async _tick() {
    const bar    = document.getElementById('mic-vu-bar');
    const dbEl   = document.getElementById('mic-vu-db');
    const noteEl = document.getElementById('mic-vu-note');

    let mic;
    try {
      mic = await fetch('/diag/mic-level', { cache: 'no-store' }).then(r => r.json());

      if (bar) {
        const level = Math.max(0, Math.min(1, mic.level || 0));
        const db    = mic.peak > 0 ? (20 * Math.log10(mic.peak / 32767)).toFixed(1) : '-∞';
        const color = level < 0.5 ? '#3dba76' : level < 0.8 ? '#e0a032' : '#e05555';
        bar.style.width      = `${Math.round(level * 100)}%`;
        bar.style.background = color;
        dbEl.textContent     = `${db} dBFS`;
      }

      const ageMs   = mic.updatedAt ? Date.now() - mic.updatedAt : Infinity;
      const flowing = ageMs < 1500;
      if (!mic.monitorActive && !flowing) {
        if (noteEl) noteEl.textContent = 'El monitor de mic no está corriendo ahora mismo (¿mic desactivado en Configuración, sesión activa capturando el device, o este server no está corriendo en la Raspberry?).';
        Summary.set('mic', 'warn', 'Monitor inactivo');
      } else {
        if (noteEl) noteEl.textContent = flowing
          ? 'Recibiendo audio en vivo — hablá cerca del mic para ver la barra moverse.'
          : 'Monitor activo, esperando la primera lectura…';
        Summary.set('mic', flowing ? 'ok' : 'warn', flowing ? 'Recibiendo audio' : 'Activo, sin señal reciente');
      }
    } catch (e) {
      if (noteEl) noteEl.textContent = `Error consultando el estado: ${e.message}`;
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
      voiceActive: !!mic.voiceActive,
      sensing:  !!mic.sensing,
    });
    if (this._history.length > this.MAX_SAMPLES) this._history.shift();
    this._calibratedThresholdDbfs = mic.calibratedThresholdDbfs;
    this._lastMic = mic; // para el popup de detalles técnicos, que solo se lee al abrirlo
    this._renderChart();
    this._renderStatus(mic);
    this._renderNumbers(mic, dbfs);
  },

  // Los únicos 2 números que quedan como texto (todo lo demás —
  // piso/calibrado/efectivo — vive DENTRO del gráfico como línea+label, sin
  // repetirlo acá también). "Nivel actual" es la magnitud; "Margen al
  // umbral" es la que responde "¿cuánto me falta/sobra para disparar?".
  _renderNumbers(mic, dbfs) {
    const numEl = document.getElementById('stat-level-num');
    const marEl = document.getElementById('stat-margin-num');
    const subEl = document.getElementById('stat-margin-sub');
    if (!numEl || !marEl) return;

    numEl.textContent = isNaN(dbfs) ? '—' : dbfs.toFixed(1);

    const eff = mic.effectiveThresholdDbfs;
    const margin = (eff !== null && eff !== undefined && !isNaN(eff)) ? dbfs - eff : null;
    if (margin === null) {
      marEl.textContent = '—';
      marEl.style.color = '';
      subEl.textContent = '';
    } else {
      marEl.textContent = `${margin >= 0 ? '+' : ''}${margin.toFixed(1)}`;
      marEl.style.color = margin >= 0 ? 'var(--danger)' : '';
      subEl.textContent = margin >= 0 ? '↑ por encima — hablando' : '↓ por debajo — silencio';
    }
  },

  // Un comentario en una sola frase, en criollo — no un panel de estado. Los
  // números/nombres técnicos (piso ambiente, umbral calibrado/efectivo)
  // quedan afuera de acá a propósito: viven en el popup de detalles (ver
  // CalibrationPanorama.load), esto es solo "¿qué está pasando, en criollo?".
  _renderStatus(mic) {
    const el = document.getElementById('sound-alert');
    if (!el) return;

    if (mic.sessionActive && !mic.micGateEnabled) {
      el.className = 'sound-alert warn';
      el.textContent = '⚠️ El filtro de ruido está apagado — se manda todo tal cual, sin filtrar';
      return;
    }

    // El umbral efectivo subió por encima del calibrado — SOLO significa
    // que el piso de sonido detectado viene alto hace un rato (~25-75s de
    // promedio). No hay forma de saber si es ruido de ambiente o vos
    // hablando sostenido — el detector no distingue contenido, solo nivel +
    // tiempo (ver mic-speech-gate.js). Por eso el texto describe el HECHO
    // medido (el umbral subió) y no adivina una causa.
    const rise = (mic.effectiveThresholdDbfs != null && mic.calibratedThresholdDbfs != null)
      ? mic.effectiveThresholdDbfs - mic.calibratedThresholdDbfs
      : 0;
    const thresholdRising = rise > 2;

    // "conectado a LiveKit" = mic.sessionActive (sesión real, ver server.js
    // /diag/mic-level). "Mandando audio" = ADEMÁS mic.voiceActive — por
    // debajo del umbral el stream sigue técnicamente abierto pero se manda
    // atenuado (~-90dB, silencio real) a LiveKit, ver _publishMic.
    let cls, text;
    if (mic.voiceActive) {
      cls = 'live';
      text = mic.sessionActive ? '🎙️ Conectado a LiveKit — mandando tu voz' : '🎙️ Te está escuchando (sin conexión a LiveKit)';
    } else if (thresholdRising) {
      cls = 'warn';
      text = `📈 El umbral subió +${rise.toFixed(1)}dB desde la calibración`;
    } else {
      cls = 'muted';
      text = mic.sessionActive ? '🔗 Conectado a LiveKit — esperando que hables' : 'Todo tranquilo — sin conexión a LiveKit';
    }

    el.className = `sound-alert ${cls}`;
    el.textContent = text;
  },

  // ── Gráfico: SOLO 2 líneas — tu volumen (suavizado, acento de marca) y
  // "se activa acá" (el umbral que se usa AHORA, gris, sin nombre técnico) —
  // más la franja ámbar de "hablando confirmado". Todo lo demás (piso
  // ambiente, calibrado vs. efectivo) se sacó del gráfico — vive en el popup
  // de detalles (ver CalibrationPanorama.load), no acá.
  //
  // Ventana más larga (60s en vez de 30s) + redibujado más espaciado
  // (RENDER_INTERVAL_MS, no cada muestra) + suavizado (_smoothedDbfs) =
  // se lee como una tendencia tranquila, no como un electrocardiograma.
  // Los DATOS se siguen juntando cada 200ms igual (el pill/stat-tiles no
  // pierden reactividad) — solo el DIBUJO del gráfico va más despacio.
  MAX_SAMPLES: 300, // ~60s a 200ms/muestra
  RENDER_INTERVAL_MS: 200, // igual al ritmo de los datos (MicMeter._tick, cada 200ms) — redibuja en cada muestra nueva, lo más rápido que tiene sentido
  SMOOTH_WINDOW: 3,
  Y_MIN: -60,
  Y_MAX: 0,
  CHART_W: 640, CHART_H: 190, PAD_L: 28, PAD_R: 4, PAD_T: 16, PAD_B: 6,
  _history: [],
  _calibratedThresholdDbfs: null,
  _lastMic: null,
  _lastRenderAt: 0,

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
  // Promedio de las últimas SMOOTH_WINDOW muestras — calma el jitter de
  // sample a sample sin agregar demora perceptible (la ventana es de menos
  // de 1s de audio real).
  _smoothedDbfs() {
    const hist = this._history, n = hist.length, out = [];
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - this.SMOOTH_WINDOW + 1); j <= i; j++) { sum += hist[j].dbfs; cnt++; }
      out.push(sum / cnt);
    }
    return out;
  },
  _renderChart() {
    const now = Date.now();
    if (now - this._lastRenderAt < this.RENDER_INTERVAL_MS) return; // los datos se siguen juntando; el DIBUJO va más espaciado
    this._lastRenderAt = now;

    const wrap = document.getElementById('sound-chart-wrap');
    if (!wrap) return;
    const hist = this._history, n = hist.length;
    if (!n) { wrap.innerHTML = '<p class="field-hint">Esperando datos…</p>'; return; }

    const step = n > 1 ? (this.CHART_W - this.PAD_L - this.PAD_R) / (n - 1) : (this.CHART_W - this.PAD_L - this.PAD_R);
    let bands = '';
    for (let i = 0; i < n; i++) {
      if (!hist[i].voiceActive) continue;
      const x = this._xFor(i, n) - step / 2;
      bands += `<rect x="${x.toFixed(1)}" y="${this.PAD_T}" width="${(step + 0.6).toFixed(1)}" height="${this.CHART_H - this.PAD_T - this.PAD_B}" fill="rgba(224,160,50,0.22)" />`;
    }

    // Gridlines cada 10dB, con número — para leer el valor directo del eje
    // sin tener que estimar.
    let grid = '';
    for (let db = this.Y_MIN; db <= this.Y_MAX; db += 10) {
      const y = this._yFor(db);
      grid += `<line x1="${this.PAD_L}" y1="${y.toFixed(1)}" x2="${this.CHART_W - this.PAD_R}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1" />`;
      grid += `<text x="2" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--text2)">${db}</text>`;
    }

    const smoothed = this._smoothedDbfs();
    const dbfsLine = this._pointsFromArray(smoothed);
    const effLine  = this._points(s => s.effectiveThresholdDbfs);

    const lastSample = hist[n - 1];
    const lastX = this._xFor(n - 1, n);
    const lastY = this._yFor(smoothed[n - 1]);
    const endDot = `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4.5" fill="var(--accent)" stroke="var(--bg)" stroke-width="2" />`;

    const effY = (lastSample.effectiveThresholdDbfs != null && !isNaN(lastSample.effectiveThresholdDbfs))
      ? this._yFor(lastSample.effectiveThresholdDbfs) : null;
    const effLabel = effY !== null
      ? `<text x="${this.CHART_W - this.PAD_R - 3}" y="${(effY - 5).toFixed(1)}" font-size="10" text-anchor="end" fill="var(--text2)">se activa acá (${lastSample.effectiveThresholdDbfs.toFixed(1)}dB)</text>`
      : '';

    wrap.innerHTML = `
      <svg width="100%" height="${this.CHART_H}" viewBox="0 0 ${this.CHART_W} ${this.CHART_H}" style="display:block; min-width:420px; background:var(--bg); border-radius:8px">
        ${bands}
        ${grid}
        ${effLine ? `<polyline points="${effLine}" fill="none" stroke="var(--text2)" stroke-width="1.3" stroke-dasharray="4,3" opacity="0.85" />` : ''}
        <polyline points="${dbfsLine}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
        ${endDot}
        ${effLabel}
      </svg>
    `;
  },
  _pointsFromArray(values) {
    const n = values.length, out = [];
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || v === undefined || isNaN(v)) continue;
      out.push(`${this._xFor(i, n).toFixed(1)},${this._yFor(v).toFixed(1)}`);
    }
    return out.join(' ');
  },

};

// ============================================================
// PARLANTE — mismo endpoint que ya usaba Configuración. Toggle: si ya
// está sonando, tocar el botón de nuevo corta el tono en vez de esperar
// a que termine solo (antes se dejaba correr entero, "muy molesto").
// ============================================================
let _speakerPlaying = false;
async function runSpeakerTest() {
  const btn    = document.getElementById('btn-speaker-test');
  const result = document.getElementById('speaker-test-result');

  if (_speakerPlaying) {
    // Ya está sonando — este click corta el tono. Optimista: bajamos el
    // estado ya mismo, la respuesta del server solo confirma.
    _speakerPlaying = false;
    btn.textContent = '🔊 Probar parlante (tono 1kHz)';
    try { await fetch('/configuracion/speaker-test', { method: 'POST' }); } catch {}
    return;
  }

  _speakerPlaying = true;
  btn.textContent = '⏹ Detener';
  result.innerHTML = '';
  try {
    const res  = await fetch('/configuracion/speaker-test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (!data.stopped) {
        result.innerHTML = `<div class="pill ok">✅ ${esc(data.note || 'Tono reproducido')}</div>`;
        Summary.set('speaker', 'ok', 'Tono reproducido');
      }
    } else {
      result.innerHTML = `<div class="pill bad">⚠ Error: ${esc(data.error || data.output || 'desconocido')}</div>`;
      Summary.set('speaker', 'error', data.error || 'Falló');
    }
  } catch (e) {
    result.innerHTML = `<div class="pill bad">⚠ Error: ${esc(e.message)}</div>`;
    Summary.set('speaker', 'error', 'Sin respuesta del servidor');
  } finally {
    _speakerPlaying = false;
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
      // El aviso de "no corre como root" se sacó — es defensivo (por si
      // alguna vez alguien lo necesita), pero acá ws281x ya está
      // "configured" (funcionando de verdad), así que en la práctica no
      // hace falta root en este setup y el aviso solo generaba dudas.
      kv.innerHTML = kvRows([
        ['Estado', `✅ OK — v${d.packageVersion}`],
        ['LEDs', `${d.numLeds} en GPIO ${d.gpioPin}`],
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
      let failStreak = 0;
      this._playPoll = setInterval(async () => {
        ticks++;
        if (ticks > 2250) { this._finishPlay(); return; }
        try {
          const { playing } = await fetch('/recordings/play-status').then(r => r.json());
          failStreak = 0;
          if (!playing) this._finishPlay();
        } catch {
          // Un solo pedido que falla (hipo de red/servidor) no alcanza para
          // decir "terminó" — antes un solo fallo bajaba el ícono a ▶ ya
          // mismo mientras el aplay seguía sonando de verdad en el server,
          // dejando la UI mostrando "parado" con el audio todavía andando.
          // Recién a la 3ra falla seguida (~2.4s sin poder confirmar nada)
          // asumimos que se cortó, y esta vez si pedimos que pare de verdad.
          failStreak++;
          if (failStreak >= 3) {
            try { await fetch('/recordings/stop-play', { method: 'POST' }); } catch {}
            this._finishPlay();
          }
        }
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
  // Un solo kv, nombres que dejan claro qué es EN VIVO (se mueve solo) y
  // qué es FIJO (de la última calibración) — antes esto vivía repartido en
  // 2 bloques (uno de /diag/mic-level, otro de /configuracion/status) con
  // valores parecidos pero mal distinguidos ("Ruido de fondo del cuarto" vs
  // "Piso de ruido medido" eran cosas DISTINTAS con nombres casi iguales).
  // Se rellena solo al abrir el popup — no hace falta que esté en vivo
  // mientras nadie lo está mirando.
  async load() {
    const kv       = document.getElementById('kv-sound-details');
    const histWrap = document.getElementById('calibration-history-wrap');
    if (!kv) return;

    const mic = MicMeter._lastMic;
    const fmt = v => (v === null || v === undefined || isNaN(v)) ? '—' : `${v.toFixed(1)} dBFS`;

    let calLine = '—';
    try {
      const status = await fetch('/configuracion/status', { cache: 'no-store' }).then(r => r.json());
      const cal = status.calibration;
      if (cal) {
        const when = new Date(cal.measuredAt).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        calLine = `${when} — ${cal.triggeredBy === 'boot' ? 'automática al arrancar' : 'manual'}`;
      }
    } catch {}

    kv.innerHTML = kvRows([
      ['Ruido de fondo (ahora)',  mic ? fmt(mic.ambientFloorDbfs) : '—'],
      ['Umbral calibrado (fijo)', mic ? fmt(mic.calibratedThresholdDbfs) : '—'],
      ['Umbral en uso (ahora)',   mic ? fmt(mic.effectiveThresholdDbfs) : '—'],
      ['Última calibración',      calLine],
    ]);

    try {
      const { runs } = await fetch('/diag/calibration-history', { cache: 'no-store' }).then(r => r.json());
      this._renderHistory(histWrap, runs || []);
    } catch {
      if (histWrap) histWrap.innerHTML = '';
    }
  },

  _renderHistory(wrap, runs) {
    if (!wrap) return;
    if (!runs.length) { wrap.innerHTML = '<p class="field-hint">Todavía no hay historial guardado — se va a ir llenando con cada calibración (automática al arrancar, manual o guiada).</p>'; return; }

    const thresholds = runs.map(r => r.threshold);
    const lo = Math.min(...thresholds) - 2;
    const hi = Math.max(...thresholds, -12) + 2;
    const originLabel = { boot: 'auto', manual: 'manual', guided: 'guiada' };
    const bars = runs.map(r => {
      const pct   = Math.max(4, Math.round(((r.threshold - lo) / (hi - lo || 1)) * 100));
      const date  = new Date(r.measuredAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
      let title = `${date} — umbral ${r.threshold}dBFS (piso ${r.noiseFloorDbfs}dBFS, ${originLabel[r.triggeredBy] || r.triggeredBy})`;
      if (r.unusualEnvironment) title += ' — ⚠️ marcado como ambiente ruidoso/inusual';
      const cls = r.unusualEnvironment ? 'calib-history-bar calib-history-bar--unusual' : 'calib-history-bar';
      return `<div class="${cls}" style="height:${pct}%" title="${esc(title)}"></div>`;
    }).join('');

    wrap.innerHTML = `
      <div class="field-hint" style="margin-bottom:4px">Historial de umbrales (${runs.length} corrida${runs.length === 1 ? '' : 's'} — pasá el mouse por una barra)</div>
      <div class="calib-history-row">${bars}</div>
    `;
  },
};

// ============================================================
// SENSIBILIDAD — umbral de la voz + recalibrar, movido acá desde
// Configuración para que el efecto de cada ajuste se vea al toque en el
// gráfico de arriba (mismo dato, /diag/mic-level ya lo está sondeando).
// ============================================================
const SensitivityControls = {
  async init() {
    const slider = document.getElementById('inp-talk-threshold');
    const label  = document.getElementById('val-talk-threshold');
    if (!slider) return;

    try {
      const cfg = await fetch('/setup/config', { cache: 'no-store' }).then(r => r.json());
      const v = parseFloat(cfg.talkThreshold);
      slider.value = isNaN(v) ? -25 : v;
      label.textContent = `${slider.value} dBFS`;
    } catch {}

    // Aplica en vivo (no persiste en cada arrastre — solo recalibrar
    // persiste, igual que antes en Configuración).
    let threshTimer = null;
    slider.addEventListener('input', (e) => {
      label.textContent = `${e.target.value} dBFS`;
      clearTimeout(threshTimer);
      threshTimer = setTimeout(async () => {
        try {
          await fetch('/session/talk-threshold', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ threshold: parseFloat(e.target.value) }),
          });
        } catch {}
      }, 400);
    });

    document.getElementById('btn-recalibrate')?.addEventListener('click', () => this.recalibrate());
  },

  async recalibrate() {
    const btn    = document.getElementById('btn-recalibrate');
    const result = document.getElementById('calibration-result');
    const slider = document.getElementById('inp-talk-threshold');
    const label  = document.getElementById('val-talk-threshold');
    btn.disabled = true;
    btn.textContent = '🎚️ Calibrando… quedate en silencio';
    result.innerHTML = '';
    try {
      const res  = await fetch('/configuracion/recalibrate', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'error desconocido');
      slider.value = data.calibration.threshold;
      label.textContent = `${data.calibration.threshold} dBFS`;
      result.innerHTML = '<div class="flow-note ok">✔ Calibración actualizada</div>' + this._sparkline(data.calibration.ticksDbfs, data.calibration.threshold);
      CalibrationPanorama.load(); // refresca el popup para la próxima vez que se abra
    } catch (e) {
      result.innerHTML = `<div class="flow-note bad">✘ ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '🎚️ Recalibrar ahora (8s de silencio)';
    }
  },

  // Traza de los 8s medidos, con línea punteada en el umbral que resultó —
  // feedback inmediato de "¿quedó holgado o pegado a lo medido?" justo donde
  // tocaste "Recalibrar".
  _sparkline(ticksDbfs, thresholdDbfs) {
    if (!ticksDbfs || !ticksDbfs.length) return '';
    const W = 280, H = 56, PAD = 4;
    const lo = Math.min(...ticksDbfs, thresholdDbfs) - 3;
    const hi = 0;
    const x = i => PAD + (i / (ticksDbfs.length - 1 || 1)) * (W - PAD * 2);
    const y = v => H - PAD - ((v - lo) / (hi - lo || 1)) * (H - PAD * 2);
    const points = ticksDbfs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const ty = y(thresholdDbfs).toFixed(1);
    return `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;margin-top:8px;background:var(--bg);border-radius:6px">
        <line x1="0" y1="${ty}" x2="${W}" y2="${ty}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4,3" />
        <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" />
      </svg>
      <div class="field-hint" style="margin-top:2px">línea punteada = umbral aplicado (${thresholdDbfs} dBFS) — ${ticksDbfs.length} muestras</div>
    `;
  },
};

// Íconos de línea (mismo criterio que el resto de la plataforma — stroke,
// sin relleno, currentColor — ver .card-section-icon svg en style.css) para
// el wizard, en vez de emoji: silueta consistente con el resto de
// /diagnostico y con brillo/color propio en vez de depender de cómo cada
// SO dibuja el emoji.
const ICON_MUTE     = '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const ICON_MIC       = '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 19v3"/><path d="M8 22h8"/></svg>';
const ICON_ZAP       = '<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const ICON_VOLUME_LO = '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
const ICON_CHECK     = '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const ICON_WARN      = '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const ICON_INFO      = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
const ICON_SPARKLES  = '<svg viewBox="0 0 24 24"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>';
const ICON_PLAY      = '<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const ICON_REPEAT    = '<svg viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

// ============================================================
// CALIBRACIÓN GUIADA — wizard de pasos cronometrados que termina definiendo
// un umbral, no solo diagnosticando. Mide con el mismo /diag/mic-level que
// ya alimenta el gráfico (nada nuevo del lado del server) — cada paso junta
// muestras durante su ventana. A diferencia de "Recalibrar" (que solo mide
// silencio + un margen fijo), acá hay 3 señales reales — piso, tu voz de
// verdad, y un ruido corto de prueba — así que el umbral propuesto queda en
// el hueco entre "lo que no es tu voz" y "lo que sí es tu voz", en vez de
// ser una regla ciega. No es un test de laboratorio (el timing depende de
// la reacción real de la persona) — es una forma rápida de proponer un
// umbral razonable y detectar si algo está MUY fuera de lo esperable.
// ============================================================
const GuidedDiag = {
  STEPS: [
    { key: 'silence1', title: 'Silencio',           instruction: 'No digas nada — medimos el ambiente tal cual está ahora.',        durationMs: 3000, icon: ICON_MUTE },
    { key: 'speak',    title: 'Hablá normal',        instruction: 'Decí algo con tu tono habitual, como si le hablaras a Brumexa.',  durationMs: 4000, icon: ICON_MIC },
    { key: 'silence2', title: 'Silencio de nuevo',   instruction: 'Dejá de hablar y esperá.',                                       durationMs: 3000, icon: ICON_MUTE },
    { key: 'noise',    title: 'Ruido corto',         instruction: 'Un aplauso o un golpe seco en la mesa — algo breve, no sostenido.', durationMs: 2500, icon: ICON_ZAP },
    { key: 'whisper',  title: 'Susurro',             instruction: 'Hablá bien bajito, casi susurrando.',                            durationMs: 3000, icon: ICON_VOLUME_LO },
  ],
  PREP_MS: 3000,
  SAMPLE_MS: 150,
  _results: {},
  _running: false,
  _unusualEnvironment: false,

  async start() {
    this._results = {};
    this._running = true;
    // Se lee ACÁ, antes de arrancar — la pantalla de intro (con el
    // checkbox) se pisa con la del primer paso enseguida, así que si no se
    // guarda ahora el valor se pierde para cuando arma el reporte final.
    this._unusualEnvironment = document.getElementById('chk-guided-unusual')?.checked ?? false;
    for (const step of this.STEPS) {
      if (!this._running) return; // se canceló (cerraron el dialog en el medio)
      await this._prep(step);
      if (!this._running) return;
      this._results[step.key] = await this._runStep(step);
    }
    if (this._running) this._renderReport();
  },

  cancel() { this._running = false; },

  async _prep(step) {
    const body = document.getElementById('guided-body');
    if (!body) return;
    let remaining = Math.ceil(this.PREP_MS / 1000);
    body.innerHTML = this._stepShell(step, `Preparate — arranca en ${remaining}…`);
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        remaining--;
        if (!this._running) { clearInterval(iv); resolve(); return; }
        const el = document.getElementById('guided-instruction');
        if (el) el.textContent = remaining > 0 ? `Preparate — arranca en ${remaining}…` : '¡Ahora!';
        if (remaining <= 0) { clearInterval(iv); setTimeout(resolve, 300); }
      }, 1000);
    });
  },

  async _runStep(step) {
    const body = document.getElementById('guided-body');
    if (body) body.innerHTML = this._stepShell(step, step.instruction);
    const samples = [];
    const startedAt = Date.now();
    let openedAtMs = null;

    await new Promise((resolve) => {
      const iv = setInterval(async () => {
        const elapsed = Date.now() - startedAt;
        const pct = Math.min(100, Math.round((elapsed / step.durationMs) * 100));
        const bar = document.getElementById('guided-progress');
        if (bar) bar.style.width = `${pct}%`;
        try {
          const mic  = await fetch('/diag/mic-level', { cache: 'no-store' }).then(r => r.json());
          const dbfs = mic.peak > 0 ? 20 * Math.log10(mic.peak / 32767) : -90;
          samples.push({ dbfs, voiceActive: !!mic.voiceActive });
          if (mic.voiceActive && openedAtMs === null) openedAtMs = Date.now() - startedAt;
          const live = document.getElementById('guided-live');
          if (live) live.textContent = `${dbfs.toFixed(1)} dBFS${mic.voiceActive ? ' · 🎙️ detectando' : ''}`;
        } catch {}
        if (!this._running || elapsed >= step.durationMs) { clearInterval(iv); resolve(); }
      }, this.SAMPLE_MS);
    });

    const dbfsValues     = samples.map(s => s.dbfs).filter(v => isFinite(v));
    const avgDbfs        = dbfsValues.length ? dbfsValues.reduce((a, b) => a + b, 0) / dbfsValues.length : null;
    const peakDbfs       = dbfsValues.length ? Math.max(...dbfsValues) : null;
    const voiceDetected  = samples.some(s => s.voiceActive);
    const voiceActiveAtEnd = samples.length ? samples[samples.length - 1].voiceActive : false;

    return { avgDbfs, peakDbfs, voiceDetected, voiceActiveAtEnd, openedAtMs, sampleCount: samples.length };
  },

  _stepShell(step, instruction) {
    return `
      <div class="guided-step">
        <div class="guided-step__icon">${step.icon}</div>
        <div class="guided-step__title">${esc(step.title)}</div>
        <div class="guided-step__instruction" id="guided-instruction">${esc(instruction)}</div>
        <div class="guided-progress-track"><div class="guided-progress-bar" id="guided-progress"></div></div>
        <div class="guided-live" id="guided-live">&nbsp;</div>
      </div>
    `;
  },

  // Conclusión: cada chequeo es honesto sobre lo que en verdad puede
  // afirmar (ver la discusión sobre "ambiente ruidoso" — no adivina causas
  // que no puede medir, solo reporta lo que pasó en cada paso).
  // Umbral propuesto — a diferencia de "Recalibrar" (que solo mide silencio
  // y suma un margen fijo), acá se mide además tu voz real (speak). El
  // umbral queda en el HUECO entre "el piso" y "lo más flojo que SÍ es tu
  // voz" — si ese hueco no existe (tu voz está pegada al piso), no hay
  // ningún número seguro para proponer, así que se dice eso en vez de
  // inventar uno.
  //
  // El ruido corto de prueba (paso "noise") YA NO participa de esta cuenta
  // — es un solo golpe, a la fuerza que decidiste hacerlo ese día, así que
  // ni fuerte ni flojo dice gran cosa sobre qué tan fuerte puede ser un
  // ruido real del taller (usuario: "no sé si es representativo, porque
  // ruidos puede haber más fuertes más tranqui"). Además, lo que de verdad
  // filtra un golpe corto es la DURACIÓN (~300ms sostenidos, ONSET_MIN_
  // STREAK), no el volumen — así que ese resultado queda solo como dato
  // informativo en el reporte, nunca bloqueando la aceptación del umbral.
  _computeThreshold(r) {
    if (!r.silence1 || !r.speak || r.silence1.avgDbfs == null || r.speak.avgDbfs == null) {
      return { ok: false, why: 'No se juntaron suficientes muestras — repetí la prueba.' };
    }
    const floor          = r.silence1.avgDbfs;
    const voiceAvg        = r.speak.avgDbfs;
    const notVoiceCeiling = floor + 6;
    const voiceFloorSafe  = voiceAvg - 3;

    // Caso realmente sin salida: la voz medida ni siquiera superó el piso
    // de fondo — acá no hay ningún criterio razonable (ni el punto medio
    // tiene sentido, caería del lado del ruido). Este sí se bloquea.
    if (voiceAvg <= floor) {
      return {
        ok: false,
        why: `Tu voz medida (~${voiceAvg.toFixed(1)}dBFS) no llegó a superar el piso de fondo (~${floor.toFixed(1)}dBFS) — repetí la prueba hablando bien cerca del mic.`,
      };
    }

    // Con hueco seguro: punto medio entre "techo de lo que no es voz" y
    // "piso de lo que sí es voz" (con los márgenes de siempre). Sin hueco
    // pero la voz sigue siendo más fuerte que el piso (caso real: alguien
    // habla siempre así de cerca/flojo, decirle "no hay nada" no ayuda) —
    // mejor esfuerzo: punto medio DIRECTO entre piso y voz, sin los
    // márgenes de seguridad, marcado como "riesgoso" y con la
    // recomendación explícita de repetir la prueba con más separación en
    // vez de negarse a proponer un número.
    const hasGap = notVoiceCeiling < voiceFloorSafe;
    const raw = hasGap ? (notVoiceCeiling + voiceFloorSafe) / 2 : (floor + voiceAvg) / 2;
    const value = Math.round(Math.max(-45, Math.min(-12, raw)) * 10) / 10;
    return {
      ok: true, value, floor, voiceAvg,
      risky: !hasGap,
      riskyWhy: hasGap ? null : `Tu voz (~${voiceAvg.toFixed(1)}dBFS) está pegada al piso de fondo (~${floor.toFixed(1)}dBFS) — este es el mejor punto medio posible, pero con poco margen: puede fallar más seguido de lo normal (perderse el inicio de alguna palabra, o confundir ruido con voz). Te conviene repetir la prueba hablando más cerca del mic o con más ganancia, y volver a calibrar cuando tengas más margen.`,
    };
  },

  async _applyThreshold(value) {
    try {
      const res = await fetch('/setup/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ talkThreshold: value }),
      });
      if (!res.ok) return false;
      const slider = document.getElementById('inp-talk-threshold');
      const label  = document.getElementById('val-talk-threshold');
      if (slider) slider.value = value;
      if (label) label.textContent = `${value} dBFS`;
      return true;
    } catch { return false; }
  },

  _renderReport() {
    const r = this._results;
    const body = document.getElementById('guided-body');
    if (!body) return;
    const lines = [];

    if (r.silence1?.avgDbfs != null) {
      lines.push(['info', `Piso de ruido ahora: ${r.silence1.avgDbfs.toFixed(1)} dBFS`]);
    }
    if (r.speak?.voiceDetected) {
      lines.push(['ok', `Reaccionó a tu voz${r.speak.openedAtMs != null ? ` — tardó ~${r.speak.openedAtMs}ms en confirmarlo` : ''}`]);
    } else {
      lines.push(['warn', 'No detectó que estabas hablando en este paso']);
    }
    if (r.silence2) {
      lines.push(!r.silence2.voiceActiveAtEnd
        ? ['ok', 'Volvió a silencio correctamente después de hablar']
        : ['warn', 'Seguía "escuchando" al terminar este paso — puede ser normal si hablaste hasta el final']);
    }
    if (r.noise) {
      lines.push(!r.noise.voiceDetected
        ? ['ok', 'Ignoró el ruido corto — no lo confundió con voz']
        : ['info', 'El ruido corto activó el gate — pero un solo golpe no es representativo de todos los ruidos posibles, así que esto es solo informativo y no cambia el umbral propuesto']);
    }
    if (r.whisper) {
      lines.push(['info', r.whisper.voiceDetected
        ? 'También detecta susurros bien bajitos'
        : 'No detectó el susurro — no es necesariamente un problema, los susurros son borde a propósito']);
    }

    const suggestion = this._computeThreshold(r);
    const suggestionHtml = suggestion.ok
      ? `
        <div class="guided-suggestion${suggestion.risky ? ' risky' : ''}">
          <div class="guided-suggestion__label">Umbral propuesto${suggestion.risky ? ' — poco margen' : ''}</div>
          <div class="guided-suggestion__value">${suggestion.value} dBFS</div>
          <div class="guided-suggestion__why">${suggestion.risky ? esc(suggestion.riskyWhy) : `Deja margen entre tu voz (~${suggestion.voiceAvg.toFixed(1)}dBFS) y el piso de fondo.`}</div>
          <button class="btn-connect" id="btn-guided-apply" type="button" style="width:100%">${ICON_CHECK} Aplicar y guardar</button>
          <div id="guided-apply-result" style="margin-top:8px"></div>
        </div>
      `
      : `
        <div class="guided-suggestion blocked">
          <div class="guided-suggestion__label">Umbral propuesto</div>
          <div class="guided-suggestion__why">${esc(suggestion.why)}</div>
        </div>
      `;

    const lineIcon = { ok: ICON_CHECK, warn: ICON_WARN, info: ICON_INFO };
    body.innerHTML = `
      <div class="guided-report">
        ${suggestionHtml}
        <div class="guided-report__lines">
          ${lines.map(([type, text]) => `<div class="guided-report__line guided-report__line--${type}"><span class="guided-report__line-icon">${lineIcon[type]}</span><span>${esc(text)}</span></div>`).join('')}
        </div>
        <button class="btn-ghost" id="btn-guided-restart" type="button" style="margin-top:14px; width:100%">${ICON_REPEAT} Repetir</button>
      </div>
    `;

    document.getElementById('btn-guided-apply')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const out = document.getElementById('guided-apply-result');
      btn.disabled = true;
      btn.textContent = 'Aplicando…';
      const ok = await this._applyThreshold(suggestion.value);
      if (ok) {
        // Best-effort — el wizard aplica vía /setup/config (no pasa por
        // runCalibration()), así que sin esto nunca quedaba una fila en el
        // historial. Si esto falla no aborta nada, el umbral ya se aplicó.
        // this._unusualEnvironment: se preguntó al ARRANCAR el wizard (ver
        // start()), no acá — para cuando estás en el reporte final esa
        // pantalla con el checkbox ya no existe más en el DOM.
        const unusual = this._unusualEnvironment;
        try {
          await fetch('/diag/calibration-history', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threshold: suggestion.value, noiseFloorDbfs: suggestion.floor, unusualEnvironment: unusual }),
          });
        } catch {}
      }
      out.innerHTML = ok
        ? '<div class="flow-note ok">✔ Umbral aplicado y guardado</div>'
        : '<div class="flow-note bad">✘ No se pudo aplicar — probá de nuevo</div>';
      btn.disabled = false;
      btn.innerHTML = `${ICON_CHECK} Aplicar y guardar`;
      // Breve pausa para que se alcance a leer la confirmación antes de
      // cerrar solo — si falló, se queda abierto para que puedas reintentar.
      if (ok) setTimeout(() => document.getElementById('guided-diag-dialog')?.close(), 900);
    });
    document.getElementById('btn-guided-restart')?.addEventListener('click', () => this.start());
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

  // Popup de detalles técnicos — dialog nativo, cerrado por default. Se
  // rellena recién al abrir (no hace falta que esté en vivo mientras nadie
  // lo está mirando).
  const soundDialog = document.getElementById('sound-details-dialog');
  document.getElementById('btn-sound-details')?.addEventListener('click', () => {
    CalibrationPanorama.load();
    soundDialog?.showModal();
  });
  document.getElementById('btn-sound-details-close')?.addEventListener('click', () => soundDialog?.close());
  soundDialog?.addEventListener('click', (e) => { if (e.target === soundDialog) soundDialog.close(); }); // click afuera del contenido = cerrar

  // Diagnóstico guiado — mismo patrón de dialog. Al abrir, siempre vuelve a
  // la pantalla de intro (aunque la última vez haya quedado en el reporte
  // final) y re-engancha "Empezar" — el contenido de guided-body se
  // reemplaza dinámicamente durante el wizard, así que el botón original ya
  // no existe para cuando se vuelve a abrir.
  const guidedDialog = document.getElementById('guided-diag-dialog');
  const guidedIntroHtml = document.getElementById('guided-body')?.innerHTML;
  document.getElementById('btn-guided-diag')?.addEventListener('click', () => {
    const body = document.getElementById('guided-body');
    if (body && guidedIntroHtml) body.innerHTML = guidedIntroHtml;
    document.getElementById('btn-guided-start')?.addEventListener('click', () => GuidedDiag.start());
    guidedDialog?.showModal();
  });
  document.getElementById('btn-guided-close')?.addEventListener('click', () => { GuidedDiag.cancel(); guidedDialog?.close(); });
  guidedDialog?.addEventListener('click', (e) => { if (e.target === guidedDialog) { GuidedDiag.cancel(); guidedDialog.close(); } });
  guidedDialog?.addEventListener('cancel', () => GuidedDiag.cancel()); // tecla Esc

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
  SensitivityControls.init();
  await Recorder.show();
})();
