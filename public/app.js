'use strict';

// ============================================================
// ESTADO GLOBAL
// ============================================================
const state = {
  active: false,

  // LiveKit
  room:       null,
  localTrack: null,
  lkMonitor:  null,   // { stop() } — monitor del track local (analyser)
  lkStats:    null,   // { stop() } — monitor de stats del RTCRtpSender

  // Config (from /config)
  micGain: null,
  alsaMicDevice:     null, // elegido/persistido en Configuración, no en esta página
  alsaSpeakerDevice: null,
};

// ============================================================
// REFERENCIAS DOM
// ============================================================
const ui = {
  btnMic:        document.getElementById('btn-mic'),
  btnReconectar: document.getElementById('btn-reconectar'),
  log:           document.getElementById('log'),

  // Status mini
  smDeviceDot:  document.getElementById('sm-device-dot'),
  smLkVal:      document.getElementById('sm-lk-val'),
  smLkSub:      document.getElementById('sm-lk-sub'),
  smLkDot:      document.getElementById('sm-lk-dot'),
  smMicVal:     document.getElementById('sm-mic-val'),
  smMicSub:     document.getElementById('sm-mic-sub'),
  smMicDot:     document.getElementById('sm-mic-dot'),
  smCanalCard:  document.getElementById('sm-canal-card'),
  smCanalDot:   document.getElementById('sm-canal-dot'),
  smCanalVal:   document.getElementById('sm-canal-val'),
  smCanalSub:   document.getElementById('sm-canal-sub'),

  // Steps LiveKit
  lkStepsCard:     document.getElementById('lk-steps-card'),
  stepTokenCircle: document.getElementById('step-token-circle'),
  stepTokenMsg:    document.getElementById('step-token-msg'),
  stepConnCircle:  document.getElementById('step-connect-circle'),
  stepConnMsg:     document.getElementById('step-connect-msg'),
  stepPubCircle:   document.getElementById('step-publish-circle'),
  stepPubMsg:      document.getElementById('step-publish-msg'),
  conn1:           document.getElementById('conn-1'),
  conn2:           document.getElementById('conn-2'),

  // Session uptime
  sessionUptime:  document.getElementById('session-uptime'),
  uptimeDisplay:  document.getElementById('uptime-display'),

  // Mini VU (LiveKit activo)
  miniVuWrap: document.getElementById('mini-vu-wrap'),
  miniVuBar:  document.getElementById('mini-vu-bar'),
  miniVuDb:   document.getElementById('mini-vu-db'),

  // Fuente de audio (browser / Pi) — el dispositivo ALSA específico ya no
  // se elige acá (ver getSelectedAlsaDevice/getSelectedAlsaSpeaker), pero
  // el radio browser/pi lo sigue usando LiveKitModule (modo no-Raspberry).
  audioSourceRadios: document.querySelectorAll('input[name="audio-source"]'),
};

// ============================================================
// ETIQUETA DE DISPOSITIVO (basada en datos del servidor Node.js)
// El servidor corre en el mismo dispositivo (Raspberry / PC),
// así que process.platform + os.arch() son la fuente autoritativa.
// ============================================================
function deviceLabel(platform, arch) {
  const isArm = /arm/i.test(arch);
  if (platform === 'linux'  && isArm) return { name: 'Raspberry Pi', icon: '🍓' };
  if (platform === 'linux')           return { name: 'Linux',         icon: '🐧' };
  if (platform === 'win32')           return { name: 'Windows',       icon: '💻' };
  if (platform === 'darwin')          return { name: 'macOS',         icon: '🍎' };
  return { name: platform || 'Dispositivo', icon: '🖥' };
}

// ============================================================
// PASOS LIVEKIT
// ============================================================
// state: 'idle' | 'loading' | 'ok' | 'error'
function setStep(which, stepState, msg = '') {
  const circleEl = { token: ui.stepTokenCircle, connect: ui.stepConnCircle, publish: ui.stepPubCircle }[which];
  const msgEl    = { token: ui.stepTokenMsg,    connect: ui.stepConnMsg,    publish: ui.stepPubMsg    }[which];
  if (!circleEl) return;

  circleEl.className = `step-circle ${stepState}`;
  if (stepState === 'loading') circleEl.textContent = '…';
  else if (stepState === 'ok')    circleEl.textContent = '✓';
  else if (stepState === 'error') circleEl.textContent = '✗';
  else circleEl.textContent = { token: '1', connect: '2', publish: '3' }[which];

  // Timestamp cuando completa o falla
  if (msgEl) {
    const ts = (stepState === 'ok' || stepState === 'error')
      ? new Date().toLocaleTimeString()
      : (msg || '');
    msgEl.textContent = stepState === 'ok' || stepState === 'error'
      ? (msg ? `${msg} · ${ts}` : ts)
      : msg;
  }
}

function resetSteps() {
  setStep('token',   'idle');
  setStep('connect', 'idle');
  setStep('publish', 'idle');
  ui.conn1.className = 'step-connector';
  ui.conn2.className = 'step-connector';
}

function activateConnector(n) {
  const el = n === 1 ? ui.conn1 : ui.conn2;
  el.className = 'step-connector active';
}

// ============================================================
// ESTADO GLOBAL UI — LiveKit panel
// ============================================================
// Cloud availability only — updated by checkLiveKitHealth()
function setLiveKitStatus(status, sub = '') {
  const labels = {
    idle:    'Sin configurar',
    online:  'Disponible',
    error:   'Sin respuesta',
  };
  const dotClass = {
    idle:  'idle',
    online: 'available',   // azul — cloud alcanzable
    error:  'error',
  };
  ui.smLkVal.textContent = labels[status] || status;
  if (sub) ui.smLkSub.textContent = sub;
  ui.smLkDot.className   = `stat-chip__dot ${dotClass[status] || 'idle'}`;
}

// Estado del canal/sesión activa de audio
function setChannelStatus(status, sub = '') {
  const labels = {
    closed:     'Cerrado',
    connecting: 'Conectando…',
    open:       'Abierto',
    error:      'Error',
  };
  const dotClass = {
    closed:     'idle',
    connecting: 'connecting',
    open:       'recording',   // verde pulsante — canal vivo
    error:      'error',
  };
  ui.smCanalVal.textContent = labels[status] || status;
  if (sub !== undefined) ui.smCanalSub.textContent = sub || (status === 'closed' ? 'sin sala' : '');
  ui.smCanalDot.className = `stat-chip__dot ${dotClass[status] || 'idle'}`;
}

async function checkLiveKitHealth() {
  if (state.active) return;
  ui.smLkVal.textContent = 'Verificando…';
  ui.smLkDot.className   = 'stat-chip__dot idle';
  try {
    const h = await fetch('/livekit-health').then((r) => r.json());
    if (h.online) {
      // Preservar el host en el sub, agregar latencia
      const host = ui.smLkSub.textContent.split('·')[0].trim();
      setLiveKitStatus('online', host ? `${host} · ${h.latency}ms` : `${h.latency}ms`);
    } else if (h.reason === 'no-config') {
      setLiveKitStatus('idle', '');
    } else {
      setLiveKitStatus('error', h.reason || '');
      log(`LiveKit sin respuesta: ${h.reason || ''}`, 'warn');
    }
  } catch {
    setLiveKitStatus('error', 'Express caído');
    log('Servidor Express no responde', 'error');
  }
}

// Health check automático cada 30 segundos
let _healthInterval = null;
function startHealthCheck() {
  stopHealthCheck();
  _healthInterval = setInterval(checkLiveKitHealth, 10_000);
}
function stopHealthCheck() {
  if (_healthInterval) { clearInterval(_healthInterval); _healthInterval = null; }
}

// ============================================================
// UPTIME DE SESIÓN
// ============================================================
let _sessionStart  = null;
let _uptimeInterval = null;

function startSessionTimer() {
  _sessionStart = Date.now();
  ui.sessionUptime.style.display = '';
  ui.btnReconectar.style.display = 'none';
  _uptimeInterval = setInterval(() => {
    const s   = Math.floor((Date.now() - _sessionStart) / 1000);
    const hh  = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm  = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss  = String(s % 60).padStart(2, '0');
    ui.uptimeDisplay.textContent = `${hh}:${mm}:${ss}`;
  }, 1000);
}

function stopSessionTimer() {
  if (_uptimeInterval) { clearInterval(_uptimeInterval); _uptimeInterval = null; }
  _sessionStart = null;
  ui.sessionUptime.style.display = 'none';
  ui.uptimeDisplay.textContent   = '00:00:00';
}

// ============================================================
// MINI VU METER (LiveKit activo)
// ============================================================
let _miniVuFrame = null;

function startMiniVu(stream) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source   = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize               = 128;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);

  const dataArr = new Uint8Array(analyser.frequencyBinCount);
  ui.miniVuWrap.style.display = '';

  const draw = () => {
    _miniVuFrame = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArr);
    let sum = 0;
    for (let i = 0; i < dataArr.length; i++) sum += dataArr[i];
    const pct   = (sum / dataArr.length) / 255;
    const db    = pct > 0 ? (20 * Math.log10(pct)).toFixed(1) : '-∞';
    const color = pct < 0.6 ? '#3dba76' : pct < 0.85 ? '#e0a032' : '#e05555';
    ui.miniVuBar.style.width      = `${Math.min(pct * 100, 100)}%`;
    ui.miniVuBar.style.background = color;
    ui.miniVuDb.textContent       = `${db} dB`;
  };
  draw();

  // Guardar referencia para cerrar el contexto al parar
  state._miniVuCtx = audioCtx;
}

function stopMiniVu() {
  if (_miniVuFrame) { cancelAnimationFrame(_miniVuFrame); _miniVuFrame = null; }
  state._miniVuCtx?.close();
  state._miniVuCtx = null;
  ui.miniVuWrap.style.display = 'none';
  ui.miniVuBar.style.width    = '0%';
  ui.miniVuDb.textContent     = '— dB';
}

// ============================================================
// BOTÓN RECONECTAR
// ============================================================
function showReconectar(show) {
  ui.btnReconectar.style.display = show ? '' : 'none';
}

ui.btnReconectar.addEventListener('click', async () => {
  if (state.active) return;
  ui.btnMic.click();
});

function setMicStatus(status, sub = '') {
  const labels = {
    idle:       'Inactivo',
    requesting: 'Solicitando…',
    active:     'Activo',
    error:      'Error',
  };
  ui.smMicVal.textContent = labels[status] || status;
  ui.smMicSub.textContent = sub;
  ui.smMicDot.className   = `stat-chip__dot ${status === 'active' ? 'recording' : status === 'requesting' ? 'connecting' : status}`;
}

// ============================================================
// FUENTE DE AUDIO — Raspberry Pi via WebSocket + AudioWorklet
// ============================================================

/**
 * PiMicModule
 *
 * Abre un WebSocket al servidor (/ws/audio?device=hw:X,Y),
 * recibe chunks de PCM Int16 y los inyecta en un AudioWorklet.
 * Devuelve un MediaStream que LiveKit puede publicar igual que getUserMedia.
 */
const PiMicModule = {
  _ws:          null,
  _audioCtx:    null,
  _workletNode: null,
  _processor:   null,
  _device:      null,

  /**
   * Inicia la captura del mic de la Pi.
   * @param {string} device  — id ALSA, ej. "hw:1,0"
   * @returns {Promise<MediaStream>}
   */
  async start(device) {
    // Sin sampleRate fijo — usar el nativo del sistema (normalmente 48000 Hz).
    // El worklet resamplifica los 16 kHz de arecord al rate real del contexto.
    const audioCtx = new AudioContext();
    await audioCtx.resume();
    log(`[mic-pi] AudioContext: ${audioCtx.sampleRate} Hz`, 'info');
    console.log(`[PiMic] AudioContext sampleRate: ${audioCtx.sampleRate} Hz`);

    // MediaStreamDestination — forzar MONO (default es stereo y LiveKit duplica canales).
    const destination = audioCtx.createMediaStreamDestination();
    try {
      destination.channelCount          = 1;
      destination.channelCountMode      = 'explicit';
      destination.channelInterpretation = 'speakers';
    } catch (err) {
      console.warn('[PiMic] no se pudo forzar canal mono:', err.message);
    }

    // Gain EN EL MISMO AudioContext que destination — ganancia digital pre-LiveKit.
    // Se persiste en localStorage. Ajustable en vivo con window.lkSetMicGain(valor).
    // Default 4.0x (+12 dB) — el Google Voice HAT captura muy bajo, Opus DTX
    // descartaba como silencio. Combinado con MIC_GAIN=4 del server → ~24 dB total.
    const gainValue = parseFloat(localStorage.getItem('lk-mic-gain')) || 4.0;
    const gainNode  = audioCtx.createGain();
    gainNode.gain.value = gainValue;
    log(`[mic-pi] GainNode: ${gainValue}x (${(20 * Math.log10(gainValue)).toFixed(1)} dB)  — window.lkSetMicGain(v) para ajustar`, 'info');

    // Analyser EN EL MISMO contexto — lee el audio REAL que sale al stream.
    // Esto evita el bug de createMediaStreamSource entre AudioContexts distintos
    // (que leía silencio aunque el track llevaba audio).
    const inCtxAnalyser = audioCtx.createAnalyser();
    inCtxAnalyser.fftSize = 512;

    this._audioCtx      = audioCtx;
    this._destination   = destination;
    this._gainNode      = gainNode;
    this._inCtxAnalyser = inCtxAnalyser;
    this._device        = device;

    // AudioWorklet requiere contexto seguro (HTTPS / localhost).
    // audioCtx.audioWorklet existe en HTTP pero addModule() lanza → usar isSecureContext.
    const useWorklet = window.isSecureContext;
    console.log(`[PiMic] modo inyección PCM: ${useWorklet ? 'AudioWorklet' : 'ScriptProcessorNode (HTTP fallback)'}`);
    log(`[mic-pi] Modo: ${useWorklet ? 'AudioWorklet' : 'ScriptProcessor (HTTP)'}`, 'info');

    let injectPcm; // función que recibe Int16Array y la inyecta al pipeline

    if (useWorklet) {
      await audioCtx.audioWorklet.addModule('/worklets/pcm-processor.js');
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor', {
        numberOfOutputs:    1,
        outputChannelCount: [1],
      });
      // worklet → gain → analyser → destination  (todo en el mismo AudioContext)
      workletNode.connect(gainNode);
      gainNode.connect(inCtxAnalyser);
      inCtxAnalyser.connect(destination);
      this._workletNode = workletNode;
      // Transfer list DEBE ser el ArrayBuffer subyacente, no el Int16Array.
      // Int16Array no es Transferable y Chrome lanza DOMException silenciosa.
      injectPcm = (int16buf) => workletNode.port.postMessage(int16buf, [int16buf.buffer]);

      // Indicador de voz con histéresis: ON >0.03, OFF <0.015, holdoff 400ms
      let _speaking = false, _lastChange = 0;
      workletNode.port.onmessage = (e) => {
        if (e.data?.type !== 'level') return;
        const now = performance.now();
        if (now - _lastChange < 400) return;
        const newActive = _speaking ? (e.data.rms > 0.015) : (e.data.rms > 0.03);
        if (newActive !== _speaking) {
          _speaking   = newActive;
          _lastChange = now;
          log(`[mic-pi] ${newActive ? '🎙 hablando' : '— silencio'}`, 'info');
          console.log(`[PiMic] voz: ${newActive ? 'ON' : 'off'}  rms=${e.data.rms.toFixed(4)}`);
        }
      };
    } else {
      // Fallback: ScriptProcessorNode con cola de Float32
      const _queue = [];
      let   _buf   = new Float32Array(0);
      let   _pos   = 0;

      // Fuente silenciosa para mantener el ScriptProcessorNode vivo
      const silence = audioCtx.createBufferSource();
      silence.buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
      silence.loop   = true;

      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      silence.connect(processor);
      // processor → gain → analyser → destination
      processor.connect(gainNode);
      gainNode.connect(inCtxAnalyser);
      inCtxAnalyser.connect(destination);
      silence.start();

      processor.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) {
          while (_pos >= _buf.length && _queue.length) { _buf = _queue.shift(); _pos = 0; }
          out[i] = _pos < _buf.length ? _buf[_pos++] : 0;
        }
      };

      this._processor = processor;
      injectPcm = (int16buf) => {
        const f32 = new Float32Array(int16buf.length);
        for (let i = 0; i < int16buf.length; i++) f32[i] = int16buf[i] / 32768;
        _queue.push(f32);
      };
    }

    // WebSocket al servidor
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl    = `${protocol}//${location.host}/ws/audio?device=${encodeURIComponent(device)}`;
    const ws       = new WebSocket(wsUrl);
    ws.binaryType  = 'arraybuffer';
    this._ws = ws;

    await new Promise((resolve, reject) => {
      ws.onopen  = () => {
        log(`[mic-pi] WebSocket abierto — ALSA device: ${device}`, 'success');
        console.log(`[PiMic] WS open — device: ${device} — sampleRate: 16000 Hz mono`);
        resolve();
      };
      ws.onerror = (ev) => {
        console.error('[PiMic] WS error', ev);
        reject(new Error(`WebSocket de audio falló (${device})`));
      };
    });

    this._frameCount  = 0;
    this._lastFrameAt = null;
    let _lastLogAt    = 0;
    let _rxPeak       = 0;
    let _rxBytes      = 0;

    ws.onmessage = (e) => {
      const int16 = new Int16Array(e.data);
      // Medir peak ANTES de injectPcm — ese transfer-lista el buffer (queda detached).
      for (let i = 0; i < int16.length; i++) {
        const s = int16[i] < 0 ? -int16[i] : int16[i];
        if (s > _rxPeak) _rxPeak = s;
      }
      _rxBytes += int16.byteLength;
      injectPcm(int16);

      this._frameCount++;
      this._lastFrameAt = Date.now();
      if (this._frameCount === 1) {
        console.log(`[PiMic] ▶ primer chunk (${e.data.byteLength} B)`);
        log('[mic-pi] Capturando audio — primer frame recibido', 'success');
      }
      const now = Date.now();
      if (now - _lastLogAt > 2000 && this._frameCount > 1) {
        const dt     = (now - _lastLogAt) / 1000;
        const kbps   = (_rxBytes * 8 / dt / 1000).toFixed(1);
        const pkDb   = _rxPeak > 0 ? (20 * Math.log10(_rxPeak / 32768)).toFixed(1) : '−∞';
        const pkPct  = (_rxPeak / 327.68).toFixed(0);
        log(`[mic-pi] PCM rx  peak: ${_rxPeak}/32767 (${pkPct}% · ${pkDb} dBFS)  ${kbps} kbps`, _rxPeak < 100 ? 'warn' : 'info');
        console.log(`[PiMic] rx  frame#${this._frameCount}  ${e.data.byteLength} B  peak=${_rxPeak} (${pkDb} dBFS)  ${kbps} kbps`);
        _lastLogAt = now;
        _rxPeak    = 0;
        _rxBytes   = 0;
      }
    };

    ws.onclose = (e) => {
      console.log(`[PiMic] WS cerrado — code: ${e.code}  reason: "${e.reason || '—'}"`);
      if (state.active) log(`[mic-pi] WebSocket cerrado: ${e.reason || 'sin razón'}`, 'warn');
    };

    // Monitor del audio que REALMENTE sale al stream LiveKit — usando el analyser
    // que está en el MISMO AudioContext (lectura confiable, sin bug cross-context).
    const tdBuf = new Uint8Array(inCtxAnalyser.fftSize);
    this._inCtxMon = setInterval(() => {
      inCtxAnalyser.getByteTimeDomainData(tdBuf);
      let peak = 0, sumSq = 0;
      for (let i = 0; i < tdBuf.length; i++) {
        const v = tdBuf[i] - 128;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sumSq += v * v;
      }
      const rms    = Math.sqrt(sumSq / tdBuf.length) / 128;
      const rmsDb  = rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : '−∞';
      const pkPct  = (peak / 1.27).toFixed(0);
      const gain   = this._gainNode?.gain?.value?.toFixed(2) ?? '?';
      if (peak < 2) {
        log(`[mic-pi→LK] ⚠ SILENCIO al stream LiveKit (peak ${peak}/127  rms ${rmsDb} dB  gain ${gain}x)`, 'warn');
      } else {
        log(`[mic-pi→LK] 🎙 al stream LiveKit: ${pkPct}%  peak ${peak}/127  rms ${rmsDb} dB  gain ${gain}x`, 'info');
      }
      console.log(`[PiMic→LK] peak=${peak}/127 rms=${rmsDb}dB gain=${gain}x`);
    }, 2000);

    return destination.stream;
  },

  stop() {
    if (this._inCtxMon) { clearInterval(this._inCtxMon); this._inCtxMon = null; }
    this._ws?.close();
    this._ws = null;
    if (this._processor) {
      this._processor.onaudioprocess = null;
      this._processor.disconnect();
      this._processor = null;
    }
    try { this._workletNode?.disconnect(); } catch {}
    try { this._gainNode?.disconnect();     } catch {}
    try { this._inCtxAnalyser?.disconnect();} catch {}
    this._audioCtx?.close();
    this._audioCtx      = null;
    this._workletNode   = null;
    this._gainNode      = null;
    this._inCtxAnalyser = null;
    this._destination   = null;
    this._device        = null;
    this._frameCount    = 0;
    this._lastFrameAt   = null;
  },
};

// Helper global: ajustar gain del mic Pi en vivo desde devtools.
//   window.lkSetMicGain(4)  → 4x (+12 dB)
//   window.lkSetMicGain(1)  → 1x (sin ganancia)
window.lkSetMicGain = function (value) {
  const v = parseFloat(value);
  if (!(v > 0) || v > 32) {
    console.warn('[lkSetMicGain] valor inválido — usar (0, 32]');
    return;
  }
  localStorage.setItem('lk-mic-gain', String(v));
  if (PiMicModule._gainNode) {
    PiMicModule._gainNode.gain.value = v;
    const db = (20 * Math.log10(v)).toFixed(1);
    log(`[mic-pi] GainNode → ${v}x (${db} dB) — aplicado en vivo`, 'success');
    console.log(`[lkSetMicGain] gain → ${v}x (${db} dB)`);
  } else {
    console.log(`[lkSetMicGain] gain guardado (${v}x) — se aplica al iniciar PiMic`);
  }
};

// ============================================================
// MÓDULO SPEAKER PI — enruta audio del agente a aplay en la Pi
// ============================================================

/**
 * PiSpeakerModule
 *
 * Cuando el usuario selecciona "Raspberry Pi" como speaker:
 *  1. Abre WebSocket /ws/speaker en el servidor
 *  2. Decodifica el track de audio del agente LiveKit via ScriptProcessorNode
 *  3. Convierte Float32 → Int16 LE y envía los chunks al servidor
 *  4. El servidor los pipa a aplay → sale por el Google Voice HAT
 *
 * El audio NO se reproduce en el browser (GainNode en 0).
 */
const PiSpeakerModule = {
  _ws:          null,
  _audioCtx:    null,
  _workletNode: null,
  _processor:   null,
  _source:      null,
  _frameCount:  0,
  _lastFrameAt: null,
  _device:      null,
  _sampleRate:  null,

  // Devuelve Promise que resuelve cuando el WS está abierto y el pipeline listo
  async start(track, device) {
    log(`[speaker-pi] Creando AudioContext…`, 'info');
    const audioCtx = new AudioContext();
    this._audioCtx = audioCtx;

    await audioCtx.resume();
    const sampleRate  = audioCtx.sampleRate;
    this._device      = device;
    this._sampleRate  = sampleRate;
    this._frameCount  = 0;
    this._lastFrameAt = null;
    log(`[speaker-pi] AudioContext: ${audioCtx.state}  ${sampleRate} Hz`, 'info');
    console.log(`[PiSpeaker] AudioContext state: ${audioCtx.state}  rate: ${sampleRate} Hz`);

    const stream  = new MediaStream([track.mediaStreamTrack]);
    const source  = audioCtx.createMediaStreamSource(stream);
    const mute    = audioCtx.createGain();
    mute.gain.value = 0;   // silenciar en el browser — el audio va a la Pi
    mute.connect(audioCtx.destination);

    // AudioWorklet requiere contexto seguro (HTTPS / localhost).
    // audioCtx.audioWorklet existe en HTTP pero addModule() lanza → usar isSecureContext.
    const useWorklet = window.isSecureContext;
    console.log(`[PiSpeaker] modo captura: ${useWorklet ? 'AudioWorklet' : 'ScriptProcessorNode (HTTP fallback)'}`);
    log(`[speaker-pi] Captura: ${useWorklet ? 'AudioWorklet' : 'ScriptProcessor (HTTP)'}`, 'info');

    if (useWorklet) {
      await audioCtx.audioWorklet.addModule('/worklets/speaker-capture.js');
      const workletNode = new AudioWorkletNode(audioCtx, 'speaker-capture');
      source.connect(workletNode);
      workletNode.connect(mute);
      this._workletNode = workletNode;
    } else {
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(mute);
      this._processor = processor;
    }

    this._source = source;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl    = `${protocol}//${location.host}/ws/speaker?device=${encodeURIComponent(device)}&rate=${sampleRate}&channels=1`;
    log(`[speaker-pi] Conectando WS → ${wsUrl}`, 'info');

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      ws.onopen = () => {
        log(`[speaker-pi] WS abierto — ${device}  ${sampleRate} Hz`, 'success');
        console.log(`[PiSpeaker] WS open — device: ${device}  sampleRate: ${sampleRate}`);

        const sendChunk = (int16buf) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(int16buf);
          this._frameCount++;
          this._lastFrameAt = Date.now();
          if (this._frameCount === 1) {
            const byteLen = int16buf instanceof ArrayBuffer ? int16buf.byteLength : int16buf.buffer?.byteLength ?? '?';
            console.log(`[PiSpeaker] ▶ primer chunk (${byteLen} B @ ${sampleRate} Hz)`);
            log('[speaker-pi] Audio del agente llegando a la Pi — primer frame', 'success');
          }
        };

        if (this._workletNode) {
          this._workletNode.port.onmessage = (e) => sendChunk(e.data);
        } else if (this._processor) {
          this._processor.onaudioprocess = (e) => {
            const float32 = e.inputBuffer.getChannelData(0);
            const int16   = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
            }
            sendChunk(int16.buffer);
          };
        }
        resolve();
      };

      ws.onerror = (ev) => {
        console.error('[PiSpeaker] WS error', ev);
        log('[speaker-pi] Error en WebSocket del speaker', 'error');
        reject(new Error('WebSocket speaker falló'));
      };

      ws.onclose = (e) => {
        console.log(`[PiSpeaker] WS cerrado — code: ${e.code}  reason: "${e.reason || '—'}"`);
        if (this._workletNode) this._workletNode.port.onmessage = null;
        if (this._processor)  this._processor.onaudioprocess   = null;
      };
    });
  },

  stop() {
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._processor) {
      this._processor.onaudioprocess = null;
      this._processor.disconnect();
      this._processor = null;
    }
    if (this._source) {
      this._source.disconnect();
      this._source = null;
    }
    this._ws?.close();
    this._ws          = null;
    this._audioCtx?.close();
    this._audioCtx    = null;
    this._frameCount  = 0;
    this._lastFrameAt = null;
    this._device      = null;
    this._sampleRate  = null;
  },
};

// ─── Helpers para leer la fuente elegida en el UI ─────────────────────────────
function getSelectedSource() {
  for (const r of ui.audioSourceRadios) {
    if (r.checked) return r.value;   // 'browser' | 'pi'
  }
  return 'browser';
}

// El dispositivo ALSA específico ya NO se elige en esta página — es un
// ajuste que se guarda en Configuración y llega acá vía /config al cargar
// (ver state.alsaMicDevice/alsaSpeakerDevice en INIT). Estas dos funciones
// quedan con el mismo nombre para no tener que tocar cada lugar que las
// llama (PiNativeModule, LiveKitModule, etc.).
function getSelectedAlsaDevice() {
  return state.alsaMicDevice || 'default';
}

function getSelectedSpeakerDest() {
  const radios = document.querySelectorAll('input[name="speaker-dest"]');
  for (const r of radios) { if (r.checked) return r.value; }
  return 'browser';
}

function getSelectedAlsaSpeaker() {
  return state.alsaSpeakerDevice || 'plughw:0,0';
}

// ============================================================
// DEBUG HELPERS — LiveKit: inspeccionar track y ver qué se manda
// ============================================================

/**
 * Loguea settings / capabilities / constraints del MediaStreamTrack
 * para verificar qué formato recibe LiveKit (sampleRate, canales, etc).
 */
function logLkTrackDetails(prefix, track) {
  if (!track) { log(`${prefix} ✘ sin MediaStreamTrack`, 'error'); return; }
  const s = track.getSettings?.()     || {};
  const c = track.getCapabilities?.() || {};
  const k = track.getConstraints?.()  || {};
  log(`${prefix} track: id=${track.id.slice(0,8)} label="${track.label || '—'}" kind=${track.kind} state=${track.readyState} muted=${track.muted} enabled=${track.enabled}`, 'info');
  log(`${prefix} settings: rate=${s.sampleRate || '?'}Hz  ch=${s.channelCount || '?'}  echoCancel=${s.echoCancellation ?? '—'}  autoGain=${s.autoGainControl ?? '—'}  noiseSupp=${s.noiseSuppression ?? '—'}  latency=${s.latency ?? '—'}`, 'info');
  console.log(`[LiveKit:track] id=${track.id}`);
  console.log(`[LiveKit:track] settings:`, s);
  console.log(`[LiveKit:track] capabilities:`, c);
  console.log(`[LiveKit:track] constraints:`, k);
}

/**
 * Loguea todo lo interesante de la publication (sid, kind, source, codec).
 */
function logLkPublication(prefix, pub) {
  if (!pub) { log(`${prefix} ✘ sin Publication`, 'error'); return; }
  log(`${prefix} pub: sid=${pub.trackSid} kind=${pub.kind} source=${pub.source} muted=${pub.isMuted} encrypted=${pub.isEncrypted ?? '—'} subscribed=${pub.isSubscribed ?? '—'}`, 'info');
  log(`${prefix} simulcast=${pub.simulcasted ?? '—'} dimensions=${pub.dimensions ? `${pub.dimensions.width}x${pub.dimensions.height}` : '—'} mimeType=${pub.mimeType || '—'}`, 'info');
  console.log(`[LiveKit:pub]`, pub);
  // Sender → nos permite inspeccionar los codec-params (Opus, DTX, FEC, bitrate)
  const sender = pub.track?.sender || pub.sender;
  if (sender?.getParameters) {
    try {
      const p = sender.getParameters();
      console.log(`[LiveKit:sender] parameters:`, p);
      const codec = p?.codecs?.[0];
      if (codec) log(`${prefix} codec: ${codec.mimeType}  clockRate=${codec.clockRate}  channels=${codec.channels}  sdpFmtpLine="${codec.sdpFmtpLine || '—'}"`, 'info');
      const enc = p?.encodings?.[0];
      if (enc) log(`${prefix} encoding: maxBitrate=${enc.maxBitrate || '?'}  priority=${enc.priority || '—'}  active=${enc.active}`, 'info');
    } catch (err) { console.warn('[LiveKit:sender] getParameters error', err); }
  }
}

/**
 * Monitor del track local — attacha un AnalyserNode y loguea el peak cada 2s.
 * Así ves si lo que se está publicando a LiveKit tiene audio real o es silencio.
 */
function startLkTrackMonitor(track, label) {
  if (!track) return null;
  try {
    const ctx      = new AudioContext();
    const stream   = new MediaStream([track]);
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    // Muteado — NO conectar a destination (el track va a LiveKit, no al speaker del browser).
    const buf = new Uint8Array(analyser.fftSize);
    let peakSince = 0, nSamples = 0, sumSq = 0;
    let _voiceOn = false, _lastVoiceChange = 0;
    const VOICE_ON_THRESH  = 8;   // peak/127 ~6% — empieza a hablar
    const VOICE_OFF_THRESH = 3;   // peak/127 ~2% — dejó de hablar
    const interval = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0, sq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] - 128;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sq += v * v;
      }
      if (peak > peakSince) peakSince = peak;
      sumSq   += sq;
      nSamples += buf.length;

      // Detección inmediata de voz (sin esperar 2s)
      const now = Date.now();
      if (now - _lastVoiceChange > 300) {
        const newVoice = _voiceOn ? peak > VOICE_OFF_THRESH : peak > VOICE_ON_THRESH;
        if (newVoice !== _voiceOn) {
          _voiceOn = newVoice;
          _lastVoiceChange = now;
          log(`[${label}] ${newVoice ? '🎙 VOZ detectada' : '— silencio'} (peak ${peak}/127)`, newVoice ? 'success' : 'info');
        }
      }

      // Resumen cada 2 s
      if (nSamples >= analyser.fftSize * 40) {
        const rms    = Math.sqrt(sumSq / nSamples) / 128;
        const rmsDb  = rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : '−∞';
        const pctPk  = (peakSince / 127 * 100).toFixed(0);
        if (peakSince < 2) {
          log(`[lk-track] ⚠ ${label}: SILENCIO en el track (peak ${peakSince}/127  rms ${rmsDb} dB) — no se está mandando audio a LiveKit`, 'warn');
        } else {
          log(`[lk-track] 🎙 ${label}: nivel ${pctPk}%  peak ${peakSince}/127  rms ${rmsDb} dB`, 'info');
        }
        console.log(`[LiveKit:monitor] ${label} peak=${peakSince}/127 rms=${rmsDb}dB`);
        peakSince = 0; sumSq = 0; nSamples = 0;
      }
    }, 50);

    return {
      stop() {
        clearInterval(interval);
        try { analyser.disconnect(); source.disconnect(); ctx.close(); } catch {}
      },
    };
  } catch (err) {
    log(`[lk-track] ✘ No se pudo attachar monitor: ${err.message}`, 'warn');
    return null;
  }
}

/**
 * Monitor de stats del RTCRtpSender — cada 5s pide getStats() y loguea
 * bytesSent/packetsSent/bitrate. Si bytesSent no crece → nada llega al SFU.
 */
function startLkSenderStats(pub, label) {
  if (!pub) return null;
  let lastBytes = 0, lastPackets = 0, lastT = Date.now();
  const interval = setInterval(async () => {
    try {
      const sender = pub.track?.sender || pub.sender;
      if (!sender || !sender.getStats) { log(`[lk-stats] ${label}: sender sin getStats`, 'warn'); return; }
      const stats = await sender.getStats();
      const ob = [...stats.values()].find(s => s.type === 'outbound-rtp' && s.kind === 'audio');
      if (!ob) { log(`[lk-stats] ${label}: sin outbound-rtp audio en stats`, 'warn'); return; }
      const now      = Date.now();
      const dt       = (now - lastT) / 1000;
      const dBytes   = ob.bytesSent  - lastBytes;
      const dPackets = ob.packetsSent - lastPackets;
      const kbps     = dt > 0 ? ((dBytes * 8) / dt / 1000).toFixed(1) : '?';
      log(`[lk-stats] ${label}: +${dBytes} B / +${dPackets} pkt en ${dt.toFixed(1)}s  → ${kbps} kbps  total=${ob.bytesSent} B  nack=${ob.nackCount ?? 0}  target=${ob.targetBitrate ? (ob.targetBitrate/1000).toFixed(1)+'kbps' : '?'}`, 'info');
      if (dBytes === 0) {
        log(`[lk-stats] ⚠ ${label}: 0 bytes enviados en ${dt.toFixed(1)}s — no llega audio al SFU`, 'warn');
      }
      lastBytes = ob.bytesSent; lastPackets = ob.packetsSent; lastT = now;
    } catch (err) { console.warn('[lk-stats] error', err); }
  }, 5000);
  return { stop() { clearInterval(interval); } };
}

// Si la sesión ya está corriendo cuando se carga la página (por ejemplo la
// arrancó la wake word "Hey Brumexa" y nadie tocó el botón todavía), esto
// sincroniza el botón/UI a "Desconectar" en vez de dejarlo trabado en
// "Conectar" — mismo estado al que ya se sincroniza el catch de 409 del
// click handler (ver más abajo), solo que acá se chequea proactivamente
// al cargar en vez de esperar a que el usuario clickee y choque con un 409.
async function syncActiveSessionIfAny() {
  try {
    const s = await fetch('/session/status').then((r) => r.json());
    if (!s.isConnected) return;

    state.active = true;
    updateMicButton(true);
    resetSteps();
    setStep('token',   'ok', 'Ya estaba conectado');
    activateConnector(1);
    setStep('connect', 'ok', `Sala "${s.roomName}"`);
    activateConnector(2);
    setStep('publish', 'ok', 'Mic publicado');
    setChannelStatus('connected', `sala: ${s.roomName}`);
    setMicStatus('active', `gain ${s.micGain}x`);
    startSessionTimer();
    PiNativeModule._startPolling();
    log('[pi-native] Sesión ya activa al cargar la página — sincronizando UI', 'info');
  } catch { /* /session/status no disponible — nada que sincronizar */ }
}

// ============================================================
// MÓDULO PI-NATIVE LIVEKIT
// El audio NO pasa por el browser. Mic y speaker se manejan
// en la Pi via @livekit/rtc-node + arecord/aplay.
// El browser solo dispara start/stop y polea estado para la UI.
// ============================================================
const PiNativeModule = {
  _statusPoll: null,

  async start() {
    setLiveKitStatus('connecting', 'pidiendo sesión a la Pi…');
    setStep('token',   'pending', 'Pidiendo token al server central…');

    // Leer dispositivos ALSA elegidos en los dropdowns
    const micDevice     = getSelectedAlsaDevice() || 'plughw:0,0';
    const speakerDevice = getSelectedAlsaSpeaker() || 'plughw:0,0';
    log(`[pi-native] mic=${micDevice}  speaker=${speakerDevice}`, 'info');

    const r = await fetch('/session/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ micDevice, speakerDevice }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);

    setStep('token',   'ok',  'Token recibido');
    activateConnector(1);
    setStep('connect', 'ok',  `Sala "${data.roomName}"`);
    activateConnector(2);
    setStep('publish', 'ok',  `Mic publicado (${micDevice})`);
    setLiveKitStatus('connected', data.url?.replace('wss://', '') || '—');
    setChannelStatus('connected', `sala: ${data.roomName}`);
    setMicStatus('on', `arecord ${micDevice} → AudioSource (16 kHz)`);
    log(`[pi-native] Sesión iniciada en sala "${data.roomName}"`, 'success');

    startSessionTimer();
    this._startPolling();
  },

  async stop() {
    this._stopPolling();
    try {
      const r = await fetch('/session/stop', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) log(`[pi-native] stop: ${data.error || r.status}`, 'warn');
    } catch (e) {
      log(`[pi-native] stop error: ${e.message}`, 'warn');
    }
    setLiveKitStatus('idle');
    setChannelStatus('idle', 'Sin conexión');
    setMicStatus('off');
    resetSteps();
    stopSessionTimer();
    log('[pi-native] Sesión cerrada', 'info');
  },

  _startPolling() {
    if (this._statusPoll) clearInterval(this._statusPoll);
    this._reconnectLogged = false;
    this._diagTick = 0;
    this._statusPoll = setInterval(async () => {
      try {
        const s = await fetch('/session/status').then(r => r.json());

        // Pipeline de audio — log cada 8s (cada 4 ticks de 2s)
        this._diagTick = (this._diagTick || 0) + 1;
        if (s.isConnected && this._diagTick % 4 === 0) {
          const micPct  = s.lastMicPeak     ? (s.lastMicPeak     / 327.67).toFixed(0) : '0';
          const spkPct  = s.lastSpeakerPeak ? (s.lastSpeakerPeak / 327.67).toFixed(0) : '0';
          const muted   = s.micMuted ? ' [MUTED half-duplex]' : '';
          if (!s.micActive)        log('[pi-diag] ⚠ arecord NO está corriendo — mic sin audio', 'error');
          else if (!s.lastMicPeak) log(`[pi-diag] ⚠ arecord corriendo pero peak=0 — mic sin señal${muted}`, 'warn');
          else                     log(`[pi-diag] mic ${micPct}% peak  speaker ${spkPct}% peak${muted}`, 'info');
        }

        // Reflejar estado del mic/speaker en la UI
        if (s.micActive) {
          setMicStatus('on', `gain ${s.micGain}x`);
        }
        // Auto-reconnect en curso: mantener UI "viva" y loguear una sola vez por ciclo
        if (s.isReconnecting) {
          if (!this._reconnectLogged) {
            log(`[pi-native] Agent no responde — reconectando (${s.reconnectAttempt}/${s.reconnectMax})…`, 'warn');
            this._reconnectLogged = true;
          }
          return;
        }
        if (this._reconnectLogged && s.isConnected) {
          log('[pi-native] Reconectado', 'info');
          this._reconnectLogged = false;
        }
        // Si se desconectó por fuera (network drop o reintentos agotados), resetear UI
        if (!s.isConnected && state.active && state.usePiNative) {
          log('[pi-native] Sesión perdida — desconectando UI', 'warn');
          state.active = false;
          updateMicButton(false);
          this._stopPolling();
          setLiveKitStatus('idle');
          setChannelStatus('idle');
          setMicStatus('off');
          resetSteps();
          stopSessionTimer();
        }
      } catch {/* ignore */}
    }, 2000);
  },

  _stopPolling() {
    if (this._statusPoll) {
      clearInterval(this._statusPoll);
      this._statusPoll = null;
    }
  },
};

// ============================================================
// MÓDULO LIVEKIT
// ============================================================
const LiveKitModule = {

  async fetchToken() {
    const res = await fetch('/token');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  async fetchServerUrl() {
    const res = await fetch('/config');
    const cfg = await res.json();
    if (!cfg.livekitUrl) throw new Error('LIVEKIT_URL no está configurado en el servidor.');
    return cfg.livekitUrl;
  },

  async start() {
    console.log('[LiveKit] ── start() ──────────────────────────────────');
    resetSteps();
    log('[lk] Solicitando token al servidor central…');
    setStep('token', 'loading', 'obteniendo…');

    let tokenData, serverUrl;

    try {
      [tokenData, serverUrl] = await Promise.all([
        this.fetchToken(),
        this.fetchServerUrl(),   // fallback si el servidor central no devuelve url
      ]);
    } catch (err) {
      setStep('token', 'error', 'falló');
      setChannelStatus('closed', '');
      log('No se pudo obtener el token — revisá BRUMEXA_DEVICE_ID/BRUMEXA_API_KEY y que rag-api-v2 esté accesible', 'error');
      throw err;
    }

    // Usar la URL de LiveKit que devuelve el servidor central si está disponible
    const livekitUrl = tokenData.livekitUrl || serverUrl;
    log(`Token OK · room: ${tokenData.room} · identity: ${tokenData.identity} · expira: ${tokenData.expiresIn || '?'}`, 'success');
    log(`LiveKit URL: ${livekitUrl}`, 'info');

    setStep('token', 'ok', tokenData.room);
    activateConnector(1);
    setChannelStatus('connecting', tokenData.room);   // room name visible desde el token
    setStep('connect', 'loading', 'conectando…');

    const room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast:       true,
    });

    // Actualiza el indicador de Canal según workers en sala
    const updateWorkerState = () => {
      const n = room.remoteParticipants.size;
      ui.smCanalVal.textContent = tokenData.room;
      if (n === 0) {
        ui.smCanalSub.textContent = 'sin worker';
        ui.smCanalDot.className   = 'stat-chip__dot connecting';
        ui.smCanalCard.classList.add('no-worker');
      } else {
        ui.smCanalSub.textContent = n === 1 ? '1 worker activo' : `${n} workers activos`;
        ui.smCanalDot.className   = 'stat-chip__dot recording';
        ui.smCanalCard.classList.remove('no-worker');
      }
    };

    room.on(LivekitClient.RoomEvent.Connected, () => {
      const n   = room.remoteParticipants.size;
      const ids = [...room.remoteParticipants.values()].map(p => p.identity).join(', ') || '—';
      console.log(`[LiveKit] ✔ Connected — room: ${tokenData.room}  sid: ${room.localParticipant?.sid}  remote: ${n}`);
      log(`[lk] Conectado — sala: ${tokenData.room} · ${n} participante(s) remoto(s)`, 'success');
      setStep('connect', 'ok', tokenData.room);
      activateConnector(2);
      startSessionTimer();
      showReconectar(false);
      stopHealthCheck();
      updateWorkerState();
      if (n === 0) {
        log('[lk] Sin worker en sala — brumexa-api no se unió todavía.', 'warn');
      } else {
        log(`[lk] Workers en sala: ${ids}`, 'success');
        console.log(`[LiveKit] workers: ${ids}`);
      }
    });

    room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
      console.log(`[LiveKit] 👤 participante conectado: ${participant.identity} (sid: ${participant.sid})`);
      log(`[lk] Participante conectado: ${participant.identity}`, 'success');
      updateWorkerState();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      console.log(`[LiveKit] 👤 participante desconectado: ${participant.identity}`);
      log(`[lk] Participante desconectado: ${participant.identity}`, 'warn');
      updateWorkerState();
      if (room.remoteParticipants.size === 0) {
        log('[lk] Sin workers en sala — audio sin destino.', 'warn');
      }
    });

    room.on(LivekitClient.RoomEvent.Disconnected, (reason) => {
      // Si stop() ya limpió state.room, esta desconexión fue manual — no hacer nada
      if (state.room !== room) return;
      const why = disconnectReasons[reason] || reason || 'sin razón';
      log(`Desconectado de LiveKit: ${why}`, 'warn');
      setChannelStatus('closed');
      ui.smCanalCard.classList.remove('no-worker');
      stopSessionTimer();
      stopMiniVu();
      showReconectar(true);
      startHealthCheck();
      checkLiveKitHealth();
      resetSteps();
      this._resetState();
    });

    room.on(LivekitClient.RoomEvent.Reconnecting, () => {
      log('LiveKit: reconectando…', 'warn');
      setChannelStatus('connecting', tokenData.room);
      setStep('connect', 'loading', 'reconectando…');
    });

    room.on(LivekitClient.RoomEvent.Reconnected, () => {
      log('LiveKit: reconectado', 'success');
      setStep('connect', 'ok', tokenData.room);
      updateWorkerState();
    });

    const disconnectReasons = {
      0: 'desconocido', 1: 'cliente lo cerró', 2: 'identidad duplicada',
      3: 'servidor apagado', 4: 'participante removido', 5: 'sala eliminada',
      6: 'estado inconsistente', 7: 'fallo al unirse',
    };

    room.on(LivekitClient.RoomEvent.ConnectionStateChanged, (s) => {
      const stateEmoji = { connecting: '🔄', connected: '✅', disconnected: '❌', reconnecting: '🔁' };
      log(`Estado conexión: ${stateEmoji[s] || ''} ${s}`, s === 'connected' ? 'success' : 'info');
    });

    room.on(LivekitClient.RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) log(`Calidad de conexión: ${quality}`, 'info');
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (pub) => {
      log(`[lk-event] LocalTrackPublished — kind: ${pub.kind} · sid: ${pub.trackSid} · muted: ${pub.isMuted} · source: ${pub.source}`, 'info');
      console.log('[LiveKit:event] LocalTrackPublished', pub);
    });

    room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, (pub) => {
      log(`[lk-event] LocalTrackUnpublished — kind: ${pub.kind}`, 'warn');
    });

    // Track del remoto publicado — visibilidad aunque todavía no se suscriba
    room.on(LivekitClient.RoomEvent.TrackPublished, (pub, participant) => {
      log(`[lk-event] TrackPublished (${participant.identity}) — kind: ${pub.kind}  sid: ${pub.trackSid}  source: ${pub.source}  mime: ${pub.mimeType || '—'}`, 'info');
      console.log(`[LiveKit:event] TrackPublished ${participant.identity}`, pub);
    });

    // Estado de suscripción — si falla, aquí lo vemos
    room.on(LivekitClient.RoomEvent.TrackSubscriptionFailed, (trackSid, participant, reason) => {
      log(`[lk-event] ✘ TrackSubscriptionFailed  participant: ${participant.identity}  sid: ${trackSid}  reason: ${reason || '—'}`, 'error');
    });

    // Audio activo del participante local — confirma que LiveKit detecta voz
    room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const localActive  = speakers.some(s => s.isLocal);
      const ids = speakers.map(s => `${s.identity}(${(s.audioLevel ?? 0).toFixed(2)})`).join(', ') || '—';
      log(`[lk-event] ActiveSpeakers: ${ids}  [local: ${localActive ? 'SÍ' : 'no'}]`, localActive ? 'success' : 'info');
    });

    // Track publicación falló (permisos, codec, etc)
    room.on(LivekitClient.RoomEvent.TrackPublicationFailed, (err, opts) => {
      log(`[lk-event] ✘ TrackPublicationFailed: ${err?.message || err}  opts: ${JSON.stringify(opts)}`, 'error');
      console.error('[LiveKit:event] TrackPublicationFailed', err, opts);
    });

    room.on(LivekitClient.RoomEvent.MediaDevicesError, (err) => {
      log(`Error de micrófono: ${err.message}`, 'error');
      setMicStatus('error', err.message);
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
      const msState = track.mediaStreamTrack?.readyState ?? 'sin track';
      log(`[lk-event] TrackSubscribed — ${participant.identity}  kind: ${track.kind}  state: ${msState}`, 'success');
      console.log(`[LiveKit:event] TrackSubscribed`, { participant: participant.identity, kind: track.kind, state: msState, track });
      if (track.kind !== LivekitClient.Track.Kind.Audio) return;
      const speakerDest = getSelectedSpeakerDest();
      const alsaDev     = getSelectedAlsaSpeaker();
      log(`🔈 Audio de "${participant.identity}" — destino UI: ${speakerDest}  ALSA: ${alsaDev}`, 'info');
      console.log(`[LiveKit] → routear audio  dest: ${speakerDest}  alsa: ${alsaDev}`);

      if (speakerDest === 'pi') {
        const device = getSelectedAlsaSpeaker();
        log(`[speaker-pi] Iniciando → ALSA: ${device}`, 'info');
        try {
          await PiSpeakerModule.start(track, device);
          log(`[speaker-pi] ✔ Audio enrutado a Pi — ${device}`, 'success');
        } catch (err) {
          log(`[speaker-pi] ✗ Falló (${err.message}) — reproduciendo en browser como fallback`, 'error');
          const audioEl = track.attach();
          audioEl.autoplay = true;
          audioEl.style.display = 'none';
          document.body.appendChild(audioEl);
          audioEl.play().catch(() => {});
        }
      } else {
        // Browser speaker — attach() crea el <audio> y LiveKit maneja el stream.
        // ⚠ si el usuario esperaba oír por el parlante de la Pi, esto lo confunde.
        const audioEl = track.attach();
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        audioEl.play().catch(err => {
          console.warn('[LiveKit] autoplay bloqueado:', err.message);
          log('Autoplay bloqueado — hacé clic en la página para habilitar audio', 'warn');
        });
        log(`[speaker-browser] ✔ Audio del agente → browser (NO por parlante Pi). Cambiá "Salida" a Raspberry Pi para routear al parlante.`, 'warn');
      }

      // Monitor de nivel del agente remoto — detecta cuándo habla/para
      const remoteMonitor = startLkTrackMonitor(track.mediaStreamTrack, `agente(${participant.identity.slice(0,12)})`);
      track.on('ended', () => { if (remoteMonitor) remoteMonitor.stop(); });
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      PiSpeakerModule.stop();
    });

    log(`[lk] Conectando a room "${tokenData.room}" → ${livekitUrl}`, 'info');
    console.log(`[LiveKit] → connect  room: ${tokenData.room}  identity: ${tokenData.identity}  url: ${livekitUrl}`);

    try {
      await room.connect(livekitUrl, tokenData.token);
      const nRemote = room.remoteParticipants.size;
      console.log(`[LiveKit] ✔ conectado  sid: ${room.localParticipant?.sid}  remote: ${nRemote}`);
      log(`[lk] ✔ Conectado — sala: ${tokenData.room}  remote: ${nRemote}`, 'success');
    } catch (err) {
      setStep('connect', 'error', 'falló');
      setChannelStatus('closed', tokenData.room);
      log(`[lk] ✘ Error al conectar: ${err.message}`, 'error');
      throw err;
    }

    // ── Esperar al agente (auto-dispatch) — sin dispatch explícito ───────────
    // El worker se une automáticamente cuando el participante entra a la sala.
    // NO usamos dispatch explícito porque el worker no tiene agentName registrado.
    const agentAlreadyHere = room.remoteParticipants.size > 0;
    if (agentAlreadyHere) {
      const ids = [...room.remoteParticipants.values()].map(p => p.identity).join(', ');
      log(`[lk] Agente ya en sala: ${ids}`, 'success');
    } else {
      log('[lk] Sala vacía — esperando auto-dispatch del agente (máx 20 s)…', 'info');
      setStep('publish', 'loading', 'esperando agente…');
      setMicStatus('requesting', 'esperando agente…');

      await new Promise((resolve) => {
        const tid = setTimeout(() => {
          log('[lk] ⚠ Sin agente tras 20 s — verificá que el worker esté corriendo', 'warn');
          resolve();
        }, 20000);
        room.once(LivekitClient.RoomEvent.ParticipantConnected, (p) => {
          clearTimeout(tid);
          log(`[lk] ✔ Agente conectado: "${p.identity}" — activando mic`, 'success');
          console.log(`[LiveKit] agente en sala: ${p.identity}  sid: ${p.sid}`);
          resolve();
        });
      });
    }

    // ── DIAGNÓSTICO: listar tracks remotos y FORZAR suscripción si no es auto ─
    // Watchdog: si tras 4 s de agente presente no tenemos audio subscripto,
    // lo intentamos a mano con setSubscribed(true) — cubre casos donde el SFU
    // no auto-enrutó el track (timing, config del dispatch, etc).
    const dumpRemoteTracks = (tag) => {
      const parts = [...room.remoteParticipants.values()];
      log(`[lk-diag] ${tag} — remoteParticipants: ${parts.length}`, 'info');
      for (const p of parts) {
        const pubs = [...(p.trackPublications?.values?.() ?? p.tracks?.values?.() ?? [])];
        log(`[lk-diag]   · ${p.identity} (sid=${p.sid}) — ${pubs.length} publication(s)`, 'info');
        for (const pub of pubs) {
          log(`[lk-diag]     - ${pub.kind} sid=${pub.trackSid} source=${pub.source}  subscribed=${pub.isSubscribed}  muted=${pub.isMuted}  mime=${pub.mimeType || '—'}`, 'info');
          console.log('[LiveKit:diag] publication', pub);
        }
      }
    };
    dumpRemoteTracks('post-agent');
    setTimeout(() => {
      let audioSubscribed = false;
      for (const p of room.remoteParticipants.values()) {
        const pubs = [...(p.trackPublications?.values?.() ?? p.tracks?.values?.() ?? [])];
        for (const pub of pubs) {
          if (pub.kind === LivekitClient.Track.Kind.Audio) {
            if (pub.isSubscribed) audioSubscribed = true;
            else {
              log(`[lk-diag] ⚠ Forzando suscripción a ${p.identity} ${pub.trackSid} (autoSubscribe no la tomó)`, 'warn');
              try { pub.setSubscribed(true); } catch (err) { log(`[lk-diag] ✘ setSubscribed falló: ${err.message}`, 'error'); }
            }
          }
        }
      }
      if (!audioSubscribed) {
        log('[lk-diag] ⚠ Tras 4s NO hay ningún audio remoto suscripto — el agente no publicó audio o el SFU no lo enrutó', 'warn');
      }
      dumpRemoteTracks('watchdog-4s');
    }, 4000);

    // ── Iniciar mic ──────────────────────────────────────────────────────────
    log('[lk] Iniciando fuente de audio…', 'info');
    setStep('publish', 'loading', 'publicando…');
    setMicStatus('requesting', 'obteniendo fuente…');

    let localTrack;
    let micStream;

    const selectedSrc = getSelectedSource();
    log(`[lk] Fuente seleccionada: ${selectedSrc}`, 'info');

    try {
      if (selectedSrc === 'pi') {
        const alsaDevice = getSelectedAlsaDevice();
        log(`[mic-pi] Iniciando ALSA — device: ${alsaDevice}`, 'info');

        micStream = await PiMicModule.start(alsaDevice);
        const [rawAudioTrack] = micStream.getAudioTracks();

        // Debug: qué formato tiene el track ANTES de publicar
        logLkTrackDetails('[lk-pre-publish][pi]', rawAudioTrack);

        log('[mic-pi] Publicando en LiveKit…', 'info');
        const pub = await room.localParticipant.publishTrack(rawAudioTrack, {
          name: 'pi-mic', source: LivekitClient.Track.Source.Microphone,
        });
        localTrack = pub.track ?? pub;

        // Debug: qué le mandamos a LiveKit y cómo quedó la publication
        logLkPublication('[lk-post-publish][pi]', pub);
        logLkTrackDetails('[lk-post-publish][pi]', localTrack.mediaStreamTrack || rawAudioTrack);

        // Monitor del audio real + stats del sender
        state.lkMonitor = startLkTrackMonitor(localTrack.mediaStreamTrack || rawAudioTrack, 'pi-mic');
        state.lkStats   = startLkSenderStats(pub, 'pi-mic');

        log(`[mic-pi] ✔ Track publicado — sid: ${pub.trackSid}  muted: ${pub.isMuted}`, 'success');

      } else {
        log('[mic-browser] getUserMedia…', 'info');
        localTrack = await LivekitClient.createLocalAudioTrack({
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        });
        const mt = localTrack.mediaStreamTrack;

        // Debug: qué track obtuvimos del getUserMedia
        logLkTrackDetails('[lk-pre-publish][browser]', mt);

        const pub = await room.localParticipant.publishTrack(localTrack);

        // Debug: publication + track post-publish
        logLkPublication('[lk-post-publish][browser]', pub);
        logLkTrackDetails('[lk-post-publish][browser]', mt);

        state.lkMonitor = startLkTrackMonitor(mt, 'browser-mic');
        state.lkStats   = startLkSenderStats(pub, 'browser-mic');

        log(`[mic-browser] ✔ publicado — sid: ${pub?.trackSid}`, 'success');
        micStream = mt ? new MediaStream([mt]) : null;
      }

    } catch (err) {
      PiMicModule.stop();
      setStep('publish', 'error', 'falló');
      setMicStatus('error', 'error');
      log(`[lk] ✘ Error al publicar mic: ${err.message}`, 'error');
      console.error('[LiveKit] publish error:', err);
      throw err;
    }

    const sourceName = selectedSrc === 'pi' ? 'Pi ALSA' : 'Browser';
    setStep('publish', 'ok', 'activo');
    setMicStatus('active', sourceName);
    updateWorkerState();
    log(`[lk] ✔ Micrófono activo — ${sourceName}`, 'success');
    if (micStream) startMiniVu(micStream);

    state.room       = room;
    state.localTrack = localTrack;

  },

  async stop() {
    console.log('[LiveKit] ⏹ stop() iniciado');
    // Apagar monitores de debug antes de cortar el track
    try { state.lkMonitor?.stop(); } catch {}
    try { state.lkStats?.stop();   } catch {}
    state.lkMonitor = null;
    state.lkStats   = null;

    PiMicModule.stop();
    PiSpeakerModule.stop();
    stopMiniVu();
    stopSessionTimer();
    if (state.localTrack) {
      console.log('[LiveKit] → unpublishTrack');
      await state.room?.localParticipant?.unpublishTrack(state.localTrack);
      state.localTrack.stop();
      state.localTrack = null;
      console.log('[LiveKit] ✔ track detenido y removido');
    }
    if (state.room) {
      const r  = state.room;
      state.room = null;   // marcar antes de disconnect para que el handler Disconnected no interfiera
      console.log('[LiveKit] → room.disconnect()');
      await r.disconnect();
      console.log('[LiveKit] ✔ room desconectada');
    }
    setMicStatus('idle');
    setChannelStatus('closed');
    resetSteps();
    showReconectar(false);
    log('[lk] Desconectado de LiveKit', 'warn');
    startHealthCheck();
    checkLiveKitHealth();
  },

  _resetState() {
    try { state.lkMonitor?.stop(); } catch {}
    try { state.lkStats?.stop();   } catch {}
    state.lkMonitor  = null;
    state.lkStats    = null;
    state.room       = null;
    state.localTrack = null;
    state.active     = false;
    setMicStatus('idle');
    updateMicButton(false);
  },
};

// ============================================================
// BOTÓN PRINCIPAL
// ============================================================
function updateMicButton(active) {
  if (active) {
    ui.btnMic.textContent = 'Desconectar';
    ui.btnMic.classList.add('recording');
  } else {
    ui.btnMic.textContent = 'Conectar';
    ui.btnMic.classList.remove('recording');
  }
}

// El "Test de micrófono" (browser Web Audio API) que vivía acá se movió a
// /diagnostico — esa página ya no necesita capturar audio del browser: lee
// el nivel real que el server ya está monitoreando (GET /local/status), más
// simple y funciona igual en reposo o en medio de una sesión.
async function handleConnectClick() {
  const btn = ui.btnMic;
  btn.disabled = true;
  try {
    if (!state.active) {
      state.active = true;
      updateMicButton(true);
      if (state.usePiNative) await PiNativeModule.start();
      else                   await LiveKitModule.start();
    } else {
      state.active = false;
      updateMicButton(false);
      if (state.usePiNative) await PiNativeModule.stop();
      else                   await LiveKitModule.stop();
    }
  } catch (err) {
    // Si el server dice "sesión ya activa" (409), no es un error real —
    // significa que YA hay una sesión corriendo (quizás iniciada desde otra
    // pestaña/dispositivo) y el botón se había desincronizado. En vez de
    // dejarlo trabado en "Conectar" (que siempre va a chocar con el mismo
    // 409), lo sincronizamos a "Desconectar" para que el usuario pueda
    // frenarla desde acá.
    if (/sesión ya activa/i.test(err.message)) {
      state.active = true;
      updateMicButton(true);
      log('[pi-native] Ya había una sesión activa — sincronizando botón a "Desconectar"', 'warn');
      if (state.usePiNative) PiNativeModule._startPolling();
    } else {
      state.active = false;
      updateMicButton(false);
      setMicStatus('error');
      log(formatError(err), 'error');
      console.error(err);
    }
  } finally {
    btn.disabled = false;
  }
}

ui.btnMic.addEventListener('click', () => handleConnectClick());

// ============================================================
// LIMPIAR LOG
// ============================================================
document.getElementById('btn-clear-log').addEventListener('click', () => {
  ui.log.innerHTML = '';
});

// ============================================================
// LOG
// ============================================================
function log(msg, type = 'info') {
  const li = document.createElement('li');
  li.className = type;
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  ui.log.prepend(li);
  if (ui.log.children.length > 60) ui.log.lastElementChild.remove();
}

// ============================================================
// FORMATEO DE ERRORES
// ============================================================
function formatError(err) {
  const n = err.name || '';
  if (n === 'NotAllowedError'  || n === 'PermissionDeniedError')
    return 'Micrófono bloqueado. Habilitá el permiso en el navegador.';
  if (n === 'NotFoundError'    || n === 'DevicesNotFoundError')
    return 'No se encontró ningún micrófono en el dispositivo.';
  if (n === 'NotReadableError')
    return 'El micrófono está siendo usado por otra aplicación.';
  if (err.message?.includes('BRUMEXA_DEVICE_ID') || err.message?.includes('BRUMEXA_API_KEY'))
    return 'Dispositivo no configurado. Revisá BRUMEXA_DEVICE_ID/BRUMEXA_API_KEY en el .env del servidor.';
  if (err.message?.includes('HTTP 503'))
    return 'Servidor sin dispositivo configurado. Revisá BRUMEXA_DEVICE_ID/BRUMEXA_API_KEY.';
  return err.message || 'Error desconocido';
}

// ============================================================
// DEBUG MODULE — panel de estado en tiempo real (actualiza cada 500ms)
// ============================================================
const DebugModule = {
  _interval: null,

  start() {
    if (this._interval) return;
    this._render(); // render inmediato
    this._interval = setInterval(() => this._render(), 500);
  },

  stop() {
    clearInterval(this._interval);
    this._interval = null;
  },

  // Helpers DOM — los cuadrados de estado son chicos a propósito (label +
  // valor nomás); el detalle (sub) no se ve pero queda de tooltip al pasar
  // el mouse, en vez de ocupar lugar en el cuadrado.
  _set(id, val, sub, dotClass) {
    const valEl = document.getElementById(`${id}-val`);
    const subEl = document.getElementById(`${id}-sub`);
    const dotEl = document.getElementById(`${id}-dot`);
    if (valEl && val !== undefined) valEl.textContent = val;
    if (subEl && sub !== undefined) {
      subEl.textContent = sub;
      const row = subEl.closest('.dbg-row');
      if (row) row.title = sub;
    }
    if (dotEl && dotClass !== undefined) {
      dotEl.className = `dbg-dot ${dotClass}`;
    }
  },

  // Estado de LEDs se movió a /diagnostico (LedsDiag.check), y el estado de
  // mic vivía en la card "Test de micrófono" (también movida a
  // /diagnostico) — este panel ahora es solo lo que es realmente "de la
  // conexión": LiveKit, agente, speaker.
  _render() {
    this._renderSpeaker();
    this._renderLiveKit();
    this._renderAgent();
  },

  _renderSpeaker() {
    const s = PiSpeakerModule;

    // Pi speaker activo — LiveKit → aplay via WebSocket
    if (s._ws && s._ws.readyState === WebSocket.OPEN) {
      const ago     = s._lastFrameAt ? Math.round((Date.now() - s._lastFrameAt) / 1000) : null;
      const flowing = ago !== null && ago < 2;

      const subParts = [];
      if (s._device)     subParts.push(s._device);
      if (s._sampleRate) subParts.push(`${s._sampleRate}Hz`);

      this._set('dbg-spk',
        flowing
          ? `Pi LiveKit — frame #${s._frameCount} · ${ago}s ago`
          : s._frameCount > 0
            ? `Pi LiveKit — frame #${s._frameCount} · ${ago ?? '?'}s (sin flujo)`
            : `Pi LiveKit — esperando audio…`,
        subParts.join(' · '),
        flowing ? 'ok pulse' : s._frameCount > 0 ? 'warn' : 'idle pulse'
      );
      return;
    }

    // Speaker browser (LiveKit activo, sin Pi)
    if (state.active) {
      const room = state.room;
      const hasRemote = room && room.remoteParticipants.size > 0;
      if (hasRemote) {
        this._set('dbg-spk', 'Browser — agente en sala', 'Audio via LiveKit directo', 'ok');
        return;
      }
    }

    this._set('dbg-spk', 'Inactivo', 'Sin reproducción activa', 'idle');
  },

  _renderLiveKit() {
    if (!state.active || !state.room) {
      // Mostrar health del servidor LiveKit
      const lkSub = document.getElementById('sm-lk-sub');
      const host  = lkSub?.textContent || '';
      this._set('dbg-lk',
        'Sin sesión activa',
        host ? `Servidor: ${host}` : 'No configurado',
        host ? 'idle' : 'error'
      );
      return;
    }

    const room       = state.room;
    const connState  = room.state; // 'connected' | 'connecting' | 'disconnected' | 'reconnecting'
    const localPub   = room.localParticipant?.trackPublications?.size ?? 0;
    const remotePts  = room.remoteParticipants.size;

    const dotMap = {
      connected:    'ok',
      connecting:   'warn pulse',
      reconnecting: 'warn pulse',
      disconnected: 'error',
    };

    this._set('dbg-lk',
      `${connState} · local: ${localPub} tracks`,
      `sala: ${room.name || '—'}  remotos: ${remotePts}`,
      dotMap[connState] || 'warn'
    );
  },

  _renderAgent() {
    if (!state.active || !state.room) {
      this._set('dbg-agent', 'Sin sesión', '', 'idle');
      return;
    }

    const room    = state.room;
    const remote  = [...room.remoteParticipants.values()];
    const agents  = remote.filter(p => p.identity && p.kind !== 'SIP');

    if (agents.length === 0) {
      this._set('dbg-agent', 'Sin agente en sala', `${room.remoteParticipants.size} participante(s)`, 'warn');
      return;
    }

    // Verificar si el agente tiene tracks suscritos
    let trackCount = 0;
    for (const agent of agents) {
      for (const [, pub] of agent.trackPublications) {
        if (pub.isSubscribed) trackCount++;
      }
    }

    const ids = agents.map(a => a.identity).join(', ');
    this._set('dbg-agent',
      trackCount > 0 ? `Agente activo — ${trackCount} track(s)` : 'Agente conectado — sin tracks',
      ids.slice(0, 50),
      trackCount > 0 ? 'ok' : 'warn'
    );
  },
};

// ============================================================
// INIT
// ============================================================
(async function init() {

  // ─── Detectar soporte de getUserMedia ─────────────────────────────────────
  // Sin HTTPS ni origen "localhost" el navegador ni expone navigator.mediaDevices
  // (ej. entrando por http://brumexa.local:3000 en vez del túnel SSH a
  // localhost). Antes esto cortaba TODO init() acá abajo — dejaba la página
  // entera sin inicializar (config, ALSA, etc.) aunque en Raspberry el mic
  // real lo captura la Pi por ALSA y nunca pasa por getUserMedia del browser.
  // Ahora solo deshabilitamos el botón más abajo, una vez que sabemos si es
  // modo Pi-native (que no lo necesita).
  const hasGetUserMedia = !!navigator.mediaDevices?.getUserMedia;
  if (!hasGetUserMedia) {
    log('getUserMedia no soportado (necesita HTTPS o localhost) — el mic vía navegador no va a andar.', 'warn');
  }

  // ─── Obtener config del servidor ──────────────────────────────────────────
  let isRaspberry = false;
  let isLinux     = false;
  try {
    const cfg = await fetch('/config').then((r) => r.json());

    if (cfg.server) {
      const dev = deviceLabel(cfg.server.platform, cfg.server.arch);
      ui.smDeviceDot.className = 'brand-dot connected';
      log(`Dispositivo: ${dev.name} (${cfg.server.hostname} · ${cfg.server.arch})`, 'info');

      isLinux     = cfg.server.platform === 'linux';
      isRaspberry = isLinux && /arm/i.test(cfg.server.arch);
      log(`Debug: platform=${cfg.server.platform} arch=${cfg.server.arch} isLinux=${isLinux} isRaspberry=${isRaspberry}`, 'info');
      if (cfg.micGain) state.micGain = cfg.micGain;
      state.alsaMicDevice     = cfg.alsaMicDevice     || 'default';
      state.alsaSpeakerDevice = cfg.alsaSpeakerDevice || 'plughw:0,0';
    }

    // cfg.livekitUrl es dinámico — llega recién tras la primera conexión
    // (antes de eso no hay nada configurado "de fábrica" que mostrar).
    if (cfg.livekitUrl) {
      ui.smLkSub.textContent = cfg.livekitUrl.replace('wss://', '');
    }

    if (!cfg.tokenConfigured) {
      log('BRUMEXA_DEVICE_ID/BRUMEXA_API_KEY no configurados en .env', 'warn');
    }

  } catch {
    log('No se pudo contactar al servidor Express en /config', 'warn');
    ui.smDeviceDot.className = 'brand-dot error';
  }

  // Solo deshabilitar el botón si de verdad hace falta getUserMedia (modo
  // browser) y no lo tenemos — en Raspberry con modo nativo el mic es de la
  // Pi (ALSA), no del navegador, así que igual funciona sin getUserMedia.
  if (!hasGetUserMedia && !isRaspberry) {
    ui.btnMic.disabled = true;
    log('Botón de mic deshabilitado — sin HTTPS/localhost no hay acceso al mic del navegador.', 'warn');
  }

  // ─── En Raspberry: usar el cliente nativo @livekit/rtc-node ──────────────
  // Mic y speaker los maneja la Pi directo (arecord ↔ AudioSource ↔ aplay).
  // El browser NO captura ni reproduce audio.
  // Mostramos los dropdowns de dispositivos ALSA para elegir mic/speaker.
  if (isRaspberry) {
    state.usePiNative = true;
    log('Raspberry detectada → modo Pi-native (rtc-node + ALSA, sin browser audio)', 'success');

    // El dispositivo ALSA específico (mic/parlante) ya llegó en cfg más
    // arriba (state.alsaMicDevice/alsaSpeakerDevice) — es un ajuste que se
    // elige y persiste en Configuración, no un dropdown acá. En modo
    // Pi-native no hay "fuente browser vs Pi" para elegir tampoco (el mic
    // siempre es el de la Pi), así que esta página no muestra nada de eso
    // — ver PiNativeModule.start() más abajo, que ya lee state.alsa*.
    log(`[pi-native] Dispositivos ALSA (desde Configuración): mic=${state.alsaMicDevice}  speaker=${state.alsaSpeakerDevice}`, 'info');

    // Sincronizar el botón con el estado REAL del server al cargar la
    // página — si ya había una sesión activa (p.ej. recargaste el
    // navegador), el botón tiene que arrancar en "Desconectar", no en
    // "Conectar" (que chocaría con un 409 "Sesión ya activa").
    try {
      const s = await fetch('/session/status').then(r => r.json());
      if (s.isConnected) {
        state.active = true;
        updateMicButton(true);
        setLiveKitStatus('connected', 'sesión ya activa');
        setChannelStatus('connected', s.roomName ? `sala: ${s.roomName}` : 'conectado');
        setMicStatus(s.micActive ? 'on' : 'off');
        log('[pi-native] Sesión ya estaba activa — sincronizando UI', 'info');
        startSessionTimer();
        PiNativeModule._startPolling();
      }
    } catch { /* si falla, arrancamos como si no hubiera sesión */ }
  }

  // ─── Nav — "Terminal Pi" y "Configuracion" son links normales a sus
  // propias páginas (/terminal, /configuracion); Terminal solo tiene sentido
  // en Linux (corre comandos de la Pi), así que se oculta en el resto.
  if (!isLinux) {
    const termLink = document.getElementById('nav-terminal');
    if (termLink) termLink.style.display = 'none';
  }

  // ─── Sincronizar el botón si ya hay una sesión activa (ej. arrancada por
  // wake word mientras esta página no estaba abierta) ──────────────────────
  if (isRaspberry) await syncActiveSessionIfAny();

  // ─── Verificar conectividad con LiveKit + arrancar chequeo periódico ─────
  checkLiveKitHealth();
  startHealthCheck();

  log('Brumexa-Edge listo. Seleccioná modo y presioná "Iniciar micrófono".', 'info');

  // ─── Debug panel — arrancar loop de actualización ────────────────────────
  DebugModule.start();
})();
