'use strict';

// ============================================================
// ESTADO GLOBAL
// ============================================================
const state = {
  mode: 'livekit',   // 'livekit' | 'mictest'
  active: false,

  // LiveKit
  room:       null,
  localTrack: null,

  // Test Mic — Web Audio API
  stream:    null,
  audioCtx:  null,
  analyser:  null,
  animFrame: null,

  // Config (from /config)
  micGain: null,
};

// ============================================================
// REFERENCIAS DOM
// ============================================================
const ui = {
  btnMic:        document.getElementById('btn-mic'),
  btnReconectar: document.getElementById('btn-reconectar'),
  modeBtns:      document.querySelectorAll('.mode-btn'),
  badgeMode:     document.getElementById('badge-mode'),
  log:           document.getElementById('log'),

  // Status mini
  smDeviceIcon: document.getElementById('sm-device-icon'),
  smDeviceVal:  document.getElementById('sm-device-val'),
  smDeviceSub:  document.getElementById('sm-device-sub'),
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

  // VU Meter (Test Mic)
  vumeterCard: document.getElementById('vumeter-card'),
  vuCanvas:    document.getElementById('vu-canvas'),
  vuBar:       document.getElementById('vu-bar'),
  vuDb:        document.getElementById('vu-db'),

  // Grabaciones
  recordingsCard:   document.getElementById('recordings-card'),
  recTimer:         document.getElementById('rec-timer'),
  recSeconds:       document.getElementById('rec-seconds'),
  btnRecStart:      document.getElementById('btn-rec-start'),
  btnRecStop:       document.getElementById('btn-rec-stop'),
  recordingsList:   document.getElementById('recordings-list'),

  // Fuente de audio (browser / Pi)
  audioSourceWrap:  document.getElementById('audio-source-wrap'),
  audioSourceRadios: document.querySelectorAll('input[name="audio-source"]'),
  alsaDeviceWrap:   document.getElementById('alsa-device-wrap'),
  alsaDeviceSelect: document.getElementById('alsa-device-select'),
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
  ui.smLkDot.className   = `sm-dot ${dotClass[status] || 'idle'}`;
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
  ui.smCanalDot.className = `sm-dot ${dotClass[status] || 'idle'}`;
}

async function checkLiveKitHealth() {
  if (state.active) return;
  ui.smLkVal.textContent = 'Verificando…';
  ui.smLkDot.className   = 'sm-dot idle';
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
  state.mode = 'livekit';
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
  ui.smMicDot.className   = `sm-dot ${status === 'active' ? 'recording' : status === 'requesting' ? 'connecting' : status}`;
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
  _workletNode: null,   // expuesto para conectar analyser en el mismo contexto
  _device:      null,

  /**
   * Inicia la captura del mic de la Pi.
   * @param {string} device  — id ALSA, ej. "hw:1,0"
   * @returns {Promise<MediaStream>}
   */
  async start(device) {
    // AudioContext mono a 16kHz — coincide con arecord
    const audioCtx = new AudioContext({ sampleRate: 16000 });

    // Chrome arranca el AudioContext en "suspended" — hay que resumirlo
    // explícitamente dentro del handler del click del usuario
    await audioCtx.resume();

    // Cargar el procesador PCM como AudioWorklet
    await audioCtx.audioWorklet.addModule('/worklets/pcm-processor.js');

    // outputChannelCount: [1] fuerza salida mono — sin esto puede ser silencio
    const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor', {
      numberOfOutputs:    1,
      outputChannelCount: [1],
    });

    // Capturar salida del worklet como MediaStream
    const destination = audioCtx.createMediaStreamDestination();
    workletNode.connect(destination);

    this._audioCtx    = audioCtx;
    this._workletNode = workletNode;
    this._device      = device;

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

    this._frameCount   = 0;
    this._lastFrameAt  = null;
    let _lastLogAt = 0;
    ws.onmessage = (e) => {
      workletNode.port.postMessage(e.data, [e.data]);
      this._frameCount++;
      this._lastFrameAt = Date.now();
      if (this._frameCount === 1) {
        console.log(`[PiMic] ▶ primer chunk (${e.data.byteLength} B)`);
        log('[mic-pi] Capturando audio — primer frame recibido', 'success');
      }
      const now = Date.now();
      if (now - _lastLogAt > 5000 && this._frameCount > 1) {
        _lastLogAt = now;
        console.log(`[PiMic] streaming — frame #${this._frameCount} (${e.data.byteLength} B)`);
      }
    };

    ws.onclose = (e) => {
      console.log(`[PiMic] WS cerrado — code: ${e.code}  reason: "${e.reason || '—'}"  chunks: ${chunkCount}`);
      if (state.active) log(`[mic-pi] WebSocket cerrado: ${e.reason || 'sin razón'}`, 'warn');
    };

    return destination.stream;
  },

  stop() {
    this._ws?.close();
    this._ws          = null;
    this._audioCtx?.close();
    this._audioCtx    = null;
    this._workletNode = null;
    this._device      = null;
    this._frameCount  = 0;
    this._lastFrameAt = null;
  },
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
  _ws:         null,
  _audioCtx:   null,
  _processor:  null,
  _source:     null,
  _frameCount: 0,
  _lastFrameAt: null,
  _device:     null,
  _sampleRate: null,

  // Devuelve Promise que resuelve cuando el WS está abierto y el pipeline listo
  async start(track, device) {
    // AudioContext usa la tasa nativa del sistema (típico: 48 kHz)
    const audioCtx = new AudioContext();
    this._audioCtx = audioCtx;

    // CRÍTICO: resume() — el AudioContext arranca suspended si se crea fuera
    // de un handler de gesto del usuario. Sin esto onaudioprocess nunca dispara.
    await audioCtx.resume();
    const sampleRate  = audioCtx.sampleRate;
    this._device      = device;
    this._sampleRate  = sampleRate;
    this._frameCount  = 0;
    this._lastFrameAt = null;
    console.log(`[PiSpeaker] AudioContext state: ${audioCtx.state}  rate: ${sampleRate} Hz`);

    // Crear pipeline ANTES de abrir el WS para que esté listo al conectar
    const stream    = new MediaStream([track.mediaStreamTrack]);
    const source    = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    const mute      = audioCtx.createGain();
    mute.gain.value = 0;   // silenciar en el browser — el audio va a la Pi

    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioCtx.destination);

    this._source    = source;
    this._processor = processor;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl    = `${protocol}//${location.host}/ws/speaker?device=${encodeURIComponent(device)}&rate=${sampleRate}&channels=1`;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      ws.onopen = () => {
        log(`[speaker-pi] WS abierto — ${device}  ${sampleRate} Hz`, 'success');
        console.log(`[PiSpeaker] WS open — device: ${device}  sampleRate: ${sampleRate}`);

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16   = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
          }
          ws.send(int16.buffer);
          this._frameCount++;
          this._lastFrameAt = Date.now();
          if (this._frameCount === 1) {
            console.log(`[PiSpeaker] ▶ primer chunk (${int16.byteLength} B @ ${sampleRate} Hz)`);
            log('[speaker-pi] Audio del agente llegando a la Pi — primer frame', 'success');
          }
        };
        resolve();
      };

      ws.onerror = (ev) => {
        console.error('[PiSpeaker] WS error', ev);
        log('[speaker-pi] Error en WebSocket del speaker', 'error');
        reject(new Error('WebSocket speaker falló'));
      };

      ws.onclose = (e) => {
        console.log(`[PiSpeaker] WS cerrado — code: ${e.code}  reason: "${e.reason || '—'}"`);
        processor.onaudioprocess = null;
      };
    });
  },

  stop() {
    if (this._processor) {
      this._processor.disconnect();
      this._processor.onaudioprocess = null;
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

function getSelectedAlsaDevice() {
  return ui.alsaDeviceSelect.value || 'default';
}

function getSelectedSpeakerDest() {
  const radios = document.querySelectorAll('input[name="speaker-dest"]');
  for (const r of radios) { if (r.checked) return r.value; }
  return 'browser';
}

function getSelectedAlsaSpeaker() {
  return document.getElementById('alsa-speaker-select')?.value || 'plughw:0,0';
}

/**
 * getAudioTrack()
 *
 * Abstrae la fuente: devuelve un MediaStream ya listo,
 * ya sea de getUserMedia (browser) o del WebSocket Pi.
 * LiveKit siempre recibe un MediaStream igual.
 *
 * @returns {Promise<{ stream: MediaStream, source: 'browser'|'pi' }>}
 */
async function getAudioTrack() {
  const source = getSelectedSource();

  if (source === 'pi') {
    const device = getSelectedAlsaDevice();
    log(`Capturando audio de la Pi — dispositivo: ${device}`);
    const stream = await PiMicModule.start(device);
    return { stream, source: 'pi' };
  }

  // Fuente browser (getUserMedia — comportamiento original)
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return { stream, source: 'browser' };
}

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
      log('No se pudo obtener el token — revisá TOKEN_API_URL en .env', 'error');
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
        ui.smCanalDot.className   = 'sm-dot connecting';
        ui.smCanalCard.classList.add('no-worker');
      } else {
        ui.smCanalSub.textContent = n === 1 ? '1 worker activo' : `${n} workers activos`;
        ui.smCanalDot.className   = 'sm-dot recording';
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
      log(`Track local publicado — kind: ${pub.kind} · muted: ${pub.isMuted}`, 'info');
    });

    room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, (pub) => {
      log(`Track local removido — kind: ${pub.kind}`, 'warn');
    });

    room.on(LivekitClient.RoomEvent.MediaDevicesError, (err) => {
      log(`Error de micrófono: ${err.message}`, 'error');
      setMicStatus('error', err.message);
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Audio) return;
      const speakerDest = getSelectedSpeakerDest();
      log(`Audio recibido de "${participant.identity}" — speaker: ${speakerDest}`, 'info');
      console.log(`[LiveKit] TrackSubscribed — participant: ${participant.identity}  speakerDest: ${speakerDest}  state: ${track.mediaStreamTrack?.readyState}`);

      if (speakerDest === 'pi') {
        const device = getSelectedAlsaSpeaker();
        log(`[speaker-pi] → Pi ALSA: ${device}`, 'info');
        try {
          await PiSpeakerModule.start(track, device);
        } catch (err) {
          log(`[speaker-pi] Error: ${err.message} — reproduciendo en browser como fallback`, 'warn');
          const audioEl = track.attach();
          document.body.appendChild(audioEl);
          audioEl.play().catch(() => {});
        }
      } else {
        // Browser speaker — attach() crea el <audio> y LiveKit maneja el stream
        const audioEl = track.attach();
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        // play() explícito porque autoplay policy puede bloquearlo silenciosamente
        audioEl.play().catch(err => {
          console.warn('[LiveKit] autoplay bloqueado:', err.message);
          log('Autoplay bloqueado por el browser — hacé clic en la página para habilitar audio', 'warn');
        });
      }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      PiSpeakerModule.stop();
    });

    log(`[lk] Conectando a room "${tokenData.room}" → ${livekitUrl}`, 'info');
    console.log(`[LiveKit] → connect  room: ${tokenData.room}  identity: ${tokenData.identity}  url: ${livekitUrl}`);

    try {
      await room.connect(livekitUrl, tokenData.token);
      console.log(`[LiveKit] ✔ conectado  sid: ${room.localParticipant?.sid}`);
    } catch (err) {
      setStep('connect', 'error', 'falló');
      setChannelStatus('closed', tokenData.room);
      log(`[lk] Error al conectar: ${err.message}`, 'error');
      console.error('[LiveKit] ✘ connect error:', err);
      throw err;
    }

    log('[lk] Conectado — obteniendo fuente de audio…');
    setStep('publish', 'loading', 'publicando…');
    setMicStatus('requesting', 'obteniendo fuente…');

    let localTrack;
    let micStream;   // para el mini VU meter

    const selectedSrc = getSelectedSource();
    console.log(`[LiveKit] fuente seleccionada: ${selectedSrc}`);

    try {
      if (selectedSrc === 'pi') {
        // ── Fuente Pi: WebSocket → AudioWorklet → MediaStream → LiveKit ──────
        const alsaDevice = getSelectedAlsaDevice();
        log(`[mic-pi] Iniciando captura ALSA — device: ${alsaDevice}`, 'info');
        console.log(`[LiveKit] ▶ PiMic.start() — ALSA: ${alsaDevice}`);

        micStream              = await PiMicModule.start(alsaDevice);
        const [rawAudioTrack]  = micStream.getAudioTracks();
        console.log(`[LiveKit] audio track: id=${rawAudioTrack.id} label="${rawAudioTrack.label}" state=${rawAudioTrack.readyState}`);

        log('[lk] Publicando track Pi → LiveKit…', 'info');
        console.log('[LiveKit] → publishTrack (pi-mic)');
        const pub = await room.localParticipant.publishTrack(rawAudioTrack, {
          name:   'pi-mic',
          source: LivekitClient.Track.Source.Microphone,
        });
        localTrack = pub.track ?? pub;
        console.log(`[LiveKit] ✔ publicado — trackSid: ${pub.trackSid}  muted: ${pub.isMuted}`);

      } else {
        // ── Fuente browser: API pública de LiveKit con procesadores de audio ──
        log('[mic-browser] getUserMedia — solicitando micrófono…', 'info');
        console.log('[LiveKit] ▶ createLocalAudioTrack (browser getUserMedia)');

        localTrack = await LivekitClient.createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        });
        const mt = localTrack.mediaStreamTrack;
        console.log(`[LiveKit] audio track: id=${mt?.id} label="${mt?.label}" state=${mt?.readyState}`);

        console.log('[LiveKit] → publishTrack (browser-mic)');
        const pub = await room.localParticipant.publishTrack(localTrack);
        console.log(`[LiveKit] ✔ publicado — trackSid: ${pub?.trackSid}  muted: ${pub?.isMuted}`);

        micStream = mt ? new MediaStream([mt]) : null;
        updateMicName();
      }

    } catch (err) {
      PiMicModule.stop();
      setStep('publish', 'error', 'falló');
      setMicStatus('error', 'sin permiso');
      console.error('[LiveKit] ✘ publish error:', err);
      log(`[lk] Error al publicar: ${err.message}`, 'error');
      throw err;
    }

    const sourceName = selectedSrc === 'pi' ? 'Pi ALSA' : 'Browser';
    setStep('publish', 'ok', 'activo');
    setMicStatus('active', sourceName);
    updateWorkerState();
    log(`[lk] Micrófono activo — fuente: ${sourceName}`, 'success');
    console.log(`[LiveKit] ▶ streaming activo — fuente: ${sourceName}`);
    if (micStream) startMiniVu(micStream);

    state.room       = room;
    state.localTrack = localTrack;
  },

  async stop() {
    console.log('[LiveKit] ⏹ stop() iniciado');
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
    state.room       = null;
    state.localTrack = null;
    state.active     = false;
    setMicStatus('idle');
    updateMicButton(false);
  },
};

// ============================================================
// MÓDULO TEST MIC
// ============================================================
const MicTestModule = {

  async start() {
    log('Iniciando test de micrófono…');
    setMicStatus('requesting', 'obteniendo fuente…');

    const { stream, source: src } = await getAudioTrack();
    state.stream = stream;
    if (src === 'browser') updateMicName();

    let audioCtx, analyser;

    if (src === 'pi' && PiMicModule._workletNode && PiMicModule._audioCtx) {
      // ALSA: conectar el analyser DIRECTAMENTE al workletNode en su propio AudioContext.
      // Crear un nuevo AudioContext para analizar un stream de otro contexto no funciona
      // bien en Chrome cuando los sample rates son distintos (16kHz vs 48kHz).
      audioCtx = PiMicModule._audioCtx;
      analyser = audioCtx.createAnalyser();
      analyser.fftSize               = 256;
      analyser.smoothingTimeConstant = 0.6;
      PiMicModule._workletNode.connect(analyser);
    } else {
      // Browser mic: AudioContext normal
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize               = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
    }

    state.audioCtx = audioCtx;
    state.analyser = analyser;

    const label = src === 'pi' ? 'Pi ALSA' : 'Browser';
    log(`Micrófono capturado — fuente: ${label}. Hablá para ver el nivel.`, 'success');
    setMicStatus('active', label);
    ui.vumeterCard.style.display = 'block';

    this._renderLoop();
  },

  _renderLoop() {
    const analyser  = state.analyser;
    const canvas    = ui.vuCanvas;
    const ctx       = canvas.getContext('2d');
    const bufferLen = analyser.frequencyBinCount;
    const dataArr   = new Uint8Array(bufferLen);
    canvas.width    = canvas.offsetWidth || 440;

    const draw = () => {
      if (!state.active) return;
      state.animFrame = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArr);

      let sum = 0;
      for (let i = 0; i < bufferLen; i++) sum += dataArr[i];
      const avg   = sum / bufferLen;
      const pct   = avg / 255;
      const db    = avg > 0 ? (20 * Math.log10(avg / 255)).toFixed(1) : '-∞';
      const color = pct < 0.6 ? '#3dba76' : pct < 0.85 ? '#e0a032' : '#e05555';

      ui.vuBar.style.width      = `${Math.min(pct * 100, 100)}%`;
      ui.vuBar.style.background = color;
      ui.vuDb.textContent       = `${db} dB`;

      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const barW = W / bufferLen;
      let   x    = 0;
      for (let i = 0; i < bufferLen; i++) {
        const barH = (dataArr[i] / 255) * H;
        const hue  = Math.round(120 - (dataArr[i] / 255) * 120);
        ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
        ctx.fillRect(x, H - barH, barW - 1, barH);
        x += barW;
      }
    };

    draw();
  },

  stop() {
    PiMicModule.stop();
    if (state.animFrame) {
      cancelAnimationFrame(state.animFrame);
      state.animFrame = null;
    }
    // Solo cerrar el AudioContext si es nuestro (no el de PiMicModule)
    if (state.audioCtx && state.audioCtx !== PiMicModule._audioCtx) {
      state.audioCtx.close();
    }
    state.audioCtx = null;
    state.analyser = null;
    state.stream?.getTracks().forEach((t) => t.stop());
    state.stream = null;

    const ctx = ui.vuCanvas.getContext('2d');
    ctx.clearRect(0, 0, ui.vuCanvas.width, ui.vuCanvas.height);
    ui.vuBar.style.width = '0%';
    ui.vuDb.textContent  = '— dB';
    ui.vumeterCard.style.display = 'none';
    setMicStatus('idle');
    log('Test de micrófono detenido', 'warn');
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

ui.btnMic.addEventListener('click', async () => {
  ui.btnMic.disabled = true;
  try {
    if (!state.active) {
      state.active = true;
      updateMicButton(true);
      if (state.mode === 'livekit') await LiveKitModule.start();
      else                          await MicTestModule.start();
    } else {
      state.active = false;
      updateMicButton(false);
      if (state.mode === 'livekit') await LiveKitModule.stop();
      else                          MicTestModule.stop();
    }
  } catch (err) {
    state.active = false;
    updateMicButton(false);
    setMicStatus('error');
    log(formatError(err), 'error');
    console.error(err);
  } finally {
    ui.btnMic.disabled = false;
  }
});

// ============================================================
// SELECTOR DE MODO
// ============================================================
const modeLabels = { livekit: 'LiveKit', mictest: 'Test Mic' };

ui.modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.active) return;
    ui.modeBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    ui.lkStepsCard.style.display = state.mode === 'livekit' ? '' : 'none';
    ui.badgeMode.textContent     = modeLabels[state.mode] || state.mode;
    log(`Modo: ${modeLabels[state.mode]}`, 'info');
  });
});

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
// NOMBRE DEL MICRÓFONO
// Los labels solo están disponibles después de que el usuario
// otorgó permiso (o si ya lo otorgó antes).
// ============================================================
async function updateMicName() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mic     = devices.find((d) => d.kind === 'audioinput' && d.label);
    const label   = mic?.label || '—';
    ui.smDeviceSub.textContent = label;
  } catch {
    // sin permiso aún — no pasa nada
  }
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
  if (err.message?.includes('LIVEKIT_URL'))
    return 'LIVEKIT_URL no configurado. Revisá el .env del servidor.';
  if (err.message?.includes('HTTP 503'))
    return 'Servidor sin LiveKit configurado. Revisá API_KEY y API_SECRET.';
  return err.message || 'Error desconocido';
}

// ============================================================
// MÓDULO BLUETOOTH (solo Linux / Raspberry)
// ============================================================
const BluetoothModule = {
  _card:      document.getElementById('bluetooth-card'),
  _list:      document.getElementById('bt-device-list'),
  _scanBtn:   document.getElementById('btn-bt-scan'),
  _refreshBtn:document.getElementById('btn-bt-refresh'),
  _scanStatus:document.getElementById('bt-scan-status'),
  _countdown: document.getElementById('bt-scan-countdown'),
  _scanning:  false,

  init() {
    this._card.style.display = '';
    this._scanBtn.addEventListener('click',    () => this.scan());
    this._refreshBtn.addEventListener('click', () => this.loadPaired());
    this.loadPaired();
  },

  async loadPaired() {
    this._list.innerHTML = '<li class="bt-empty">Cargando…</li>';
    try {
      const { devices } = await fetch('/bluetooth/devices').then(r => r.json());
      if (!devices || devices.length === 0) {
        this._list.innerHTML = '<li class="bt-empty">Sin dispositivos pareados. Usá "Buscar" para encontrar speakers.</li>';
        return;
      }
      this._renderList(devices);
    } catch {
      this._list.innerHTML = '<li class="bt-empty">Error leyendo Bluetooth.</li>';
    }
  },

  async scan() {
    if (this._scanning) return;
    this._scanning = true;
    this._scanBtn.disabled = true;
    this._scanStatus.style.display = '';
    this._list.innerHTML = '<li class="bt-empty">Escaneando…</li>';

    const SECS = 8;
    let remaining = SECS;
    this._countdown.textContent = remaining;
    const timer = setInterval(() => {
      remaining--;
      this._countdown.textContent = remaining;
      if (remaining <= 0) clearInterval(timer);
    }, 1000);

    log('Bluetooth: escaneando 8 segundos…', 'info');
    try {
      const { devices } = await fetch('/bluetooth/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: SECS }),
      }).then(r => r.json());

      clearInterval(timer);
      this._scanStatus.style.display = 'none';
      this._scanning = false;
      this._scanBtn.disabled = false;

      if (!devices || devices.length === 0) {
        this._list.innerHTML = '<li class="bt-empty">No se encontraron dispositivos con nombre. Acercá el speaker y volvé a buscar.</li>';
        return;
      }
      log(`Bluetooth: ${devices.length} dispositivo(s) encontrado(s)`, 'success');
      this._renderList(devices);
    } catch (err) {
      clearInterval(timer);
      this._scanStatus.style.display = 'none';
      this._scanning = false;
      this._scanBtn.disabled = false;
      this._list.innerHTML = '<li class="bt-empty">Error durante el escaneo.</li>';
      log(`Bluetooth scan error: ${err.message}`, 'error');
    }
  },

  _renderList(devices) {
    this._list.innerHTML = '';
    for (const d of devices) this._list.appendChild(this._renderItem(d));
  },

  _renderItem({ mac, name, connected, paired, audioCapable }) {
    const li = document.createElement('li');
    li.className = 'bt-item';
    if (audioCapable) li.classList.add('bt-audio');

    // Dot de conexión
    const dot = document.createElement('span');
    dot.className = `bt-item-dot${connected ? ' connected' : ''}`;

    // Icono de tipo de dispositivo
    const typeIcon = document.createElement('span');
    typeIcon.className = 'bt-item-type';
    if (audioCapable) {
      typeIcon.textContent = '🔊';
      typeIcon.title = 'Perfil A2DP detectado — apto para audio (altavoz / auriculares)';
    } else {
      typeIcon.textContent = '📱';
      typeIcon.title = 'Dispositivo genérico — sin perfil de audio detectado';
    }

    const nameEl = document.createElement('span');
    nameEl.className   = 'bt-item-name';
    nameEl.textContent = name;

    // Badge de audio — solo si es capaz
    const badge = document.createElement('span');
    if (audioCapable) {
      badge.className   = 'bt-item-badge bt-item-badge--audio';
      badge.textContent = 'A2DP';
      badge.title       = 'Perfil Advanced Audio Distribution — listo para reproducir audio';
    }

    const macEl = document.createElement('span');
    macEl.className   = 'bt-item-mac';
    macEl.textContent = mac;

    const btn = document.createElement('button');
    if (connected) {
      btn.className   = 'bt-item-btn disconnect';
      btn.textContent = 'Desconectar';
      btn.onclick = () => this._action('/bluetooth/disconnect', mac, name, 'Desconectando…', btn, dot, false);
    } else if (paired) {
      btn.className   = 'bt-item-btn';
      btn.textContent = 'Conectar';
      btn.onclick = () => this._action('/bluetooth/connect', mac, name, 'Conectando…', btn, dot, true);
    } else {
      btn.className   = 'bt-item-btn';
      btn.textContent = 'Parear';
      btn.onclick = () => this._pair(mac, name, btn, dot);
    }

    // Fila 2: MAC + badge juntos
    const sub = document.createElement('span');
    sub.className = 'bt-item-sub';
    sub.append(macEl);
    if (audioCapable) sub.append(badge);

    li.append(dot, typeIcon, nameEl, btn, sub);
    return li;
  },

  // Pairing con botón cancelar
  async _pair(mac, name, btn, dot) {
    btn.disabled    = true;
    btn.textContent = 'Pareando…';

    // Agregar botón cancelar al lado
    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'bt-item-btn bt-cancel';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.onclick     = async () => {
      cancelBtn.disabled = true;
      await fetch('/bluetooth/cancel-pairing', { method: 'POST' });
      log('Bluetooth: pairing cancelado', 'warn');
      btn.disabled    = false;
      btn.textContent = 'Parear';
      cancelBtn.remove();
    };
    btn.insertAdjacentElement('afterend', cancelBtn);

    log(`Bluetooth: iniciando pairing con ${name || mac} — puede pedir confirmación en el dispositivo…`, 'info');

    try {
      const res = await fetch('/bluetooth/pair-connect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mac }),
      }).then(r => r.json());

      cancelBtn.remove();

      if (res.ok) {
        dot.className   = 'bt-item-dot connected';
        btn.className   = 'bt-item-btn disconnect';
        btn.textContent = 'Desconectar';
        btn.disabled    = false;
        btn.onclick     = () => this._action('/bluetooth/disconnect', mac, name, 'Desconectando…', btn, dot, false);
        log(`Bluetooth: ${res.message} — ${name || mac}`, 'success');
      } else {
        btn.disabled    = false;
        btn.textContent = 'Parear';
        log(`Bluetooth: ${res.message}`, 'error');
      }
    } catch (err) {
      cancelBtn.remove();
      btn.disabled    = false;
      btn.textContent = 'Parear';
      log(`Bluetooth error: ${err.message}`, 'error');
    }
  },

  async _action(endpoint, mac, name, loadingText, btn, dot, willConnect) {
    btn.disabled    = true;
    btn.textContent = loadingText;
    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mac }),
      }).then(r => r.json());

      if (res.ok) {
        dot.className   = `bt-item-dot${willConnect ? ' connected' : ''}`;
        btn.className   = willConnect ? 'bt-item-btn disconnect' : 'bt-item-btn';
        btn.textContent = willConnect ? 'Desconectar' : 'Conectar';
        btn.disabled    = false;
        btn.onclick     = willConnect
          ? () => this._action('/bluetooth/disconnect', mac, name, 'Desconectando…', btn, dot, false)
          : () => this._action('/bluetooth/connect',    mac, name, 'Conectando…',    btn, dot, true);
        log(`Bluetooth: ${res.message} — ${name || mac}`, 'success');
      } else {
        log(`Bluetooth: ${res.message}`, 'error');
        btn.disabled    = false;
        btn.textContent = willConnect ? 'Conectar' : 'Desconectar';
      }
    } catch (err) {
      log(`Bluetooth error: ${err.message}`, 'error');
      btn.disabled    = false;
      btn.textContent = willConnect ? 'Conectar' : 'Desconectar';
    }
  },
};

// ============================================================
// MÓDULO PLAYBACK — reproduce grabaciones en browser o Pi speaker
// ============================================================
const PlaybackModule = {
  _audio:        null,   // HTMLAudioElement (browser)
  _activeBtn:    null,   // botón ▶ activo, para restaurarlo al parar
  _pollInterval: null,   // polling de /recordings/play-status (Pi)
  _piActive:     false,  // si hay un aplay corriendo en la Pi
  _busy:         false,  // evita operaciones concurrentes
  _playStartAt:  0,      // timestamp cuando empezó el aplay (para detectar fallos rápidos)

  async play(filename, btn) {
    if (this._busy) return;
    this._busy = true;
    try {
      await this._stop();
      this._activeBtn = btn || null;
      if (btn) { btn.textContent = '⏹'; btn.classList.add('playing'); }

      const dest       = getSelectedSpeakerDest();
      const isBrowserRec = filename.includes('_browser_');  // WebM — aplay no soporta

      if (dest === 'pi' && !isBrowserRec) {
        log(`▶ Pi ALSA: "${filename}"`, 'info');
        await this._playOnPi(filename, getSelectedAlsaSpeaker());
      } else {
        if (dest === 'pi' && isBrowserRec) {
          log(`▶ Browser (WebM — aplay no compatible): "${filename}"`, 'info');
        } else {
          log(`▶ Browser: "${filename}"`, 'info');
        }
        this._playInBrowser(filename);
      }
    } finally {
      this._busy = false;
    }
  },

  _playInBrowser(filename) {
    const audio = new Audio(`/recordings/${encodeURIComponent(filename)}`);
    this._audio   = audio;
    this._piActive = false;
    audio.onended = () => this._finish();
    audio.onerror = () => {
      log(`Error reproduciendo "${filename}" en browser`, 'error');
      this._finish();
    };
    audio.play().catch(err => {
      log(`Error audio: ${err.message}`, 'error');
      this._finish();
    });
  },

  async _playOnPi(filename, device) {
    try {
      const res = await fetch('/recordings/play', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filename, device }),
      }).then(r => r.json());

      if (!res.ok) {
        log(`[Pi] Error aplay: ${res.error}`, 'error');
        this._finish();
        return;
      }

      this._piActive    = true;
      this._playStartAt = Date.now();
      log(`▶ aplay iniciado — ${device}: "${res.filename}"`, 'success');

      // Pollear hasta que aplay termine (máx. 30 min)
      let ticks = 0;
      this._pollInterval = setInterval(async () => {
        ticks++;
        if (ticks > 2250) { // 30 min a 800ms/tick
          this._stopPoll();
          this._finish();
          return;
        }
        try {
          const { playing, result } = await fetch('/recordings/play-status').then(r => r.json());
          if (!playing) {
            this._stopPoll();
            if (result && result.exitCode !== 0) {
              // aplay falló — mostrar error claro
              const detail = result.stderr ? `: ${result.stderr.split('\n')[0]}` : '';
              log(`[Pi] Error reproduciendo "${filename}"${detail}`, 'error');
            } else {
              log(`✔ Reproducción completa: "${filename}"`, 'info');
            }
            this._finish();
          }
        } catch { this._stopPoll(); this._finish(); }
      }, 800);

    } catch (err) {
      log(`Error Pi: ${err.message}`, 'error');
      this._piActive = false;
      this._finish();
    }
  },

  async stop() {
    if (this._busy) return;
    this._busy = true;
    try { await this._stop(); } finally { this._busy = false; }
  },

  // stop interno — sin guardia _busy (llamado desde play que ya la tiene)
  async _stop() {
    this._stopPoll();
    if (this._audio) {
      this._audio.pause();
      this._audio.src = '';
      this._audio = null;
    }
    // Solo llama al servidor si había un aplay Pi activo
    if (this._piActive) {
      this._piActive = false;
      try { await fetch('/recordings/stop-play', { method: 'POST' }); } catch {}
    }
    this._finish();
  },

  _stopPoll() {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  },

  _finish() {
    if (this._activeBtn) {
      this._activeBtn.textContent = '▶';
      this._activeBtn.classList.remove('playing');
      this._activeBtn = null;
    }
  },
};

// ============================================================
// MÓDULO GRABACIONES — ALSA (Pi) + Browser MediaRecorder
// ============================================================
const RecorderModule = {
  _interval:   null,
  _elapsed:    0,
  _statusPoll: null,   // detecta si arecord muere durante la grabación ALSA
  // Browser recording state
  _mediaRec:   null,
  _chunks:     [],
  _brFilename: null,

  async show() {
    ui.recordingsCard.style.display = '';
    await this.refreshList();
  },

  // ── Arrancar: elige ALSA o browser según la fuente activa ────────────────
  async start() {
    const source = getSelectedSource();

    if (source === 'pi') {
      // ── ALSA: arecord server-side ──────────────────────────────────────
      const device = getSelectedAlsaDevice();
      console.log(`[rec] Iniciando grabación ALSA — device: ${device}`);

      const res = await fetch('/record/start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ device }),
      }).then(r => r.json());

      if (!res.ok) throw new Error(res.error);
      log(`⏺ Grabando Pi ALSA — ${res.filename} (${device})`, 'success');

      // Detectar si arecord muere antes de que el usuario detenga la grabación
      this._statusPoll = setInterval(async () => {
        try {
          const s = await fetch('/record/status').then(r => r.json());
          if (!s.recording && this._interval !== null) {
            // arecord salió inesperadamente
            this._clearStatusPoll();
            clearInterval(this._interval);
            this._interval = null;
            ui.btnRecStop.style.display  = 'none';
            ui.btnRecStart.style.display = '';
            ui.recTimer.style.display    = 'none';
            ui.recSeconds.textContent    = '0';
            log(`arecord terminó inesperadamente. Verificá que el dispositivo "${device}" sea correcto (probá en terminal: arecord -D ${device} -f S16_LE -r 16000 test.wav)`, 'error');
            await this.refreshList();
          }
        } catch { /* servidor reconectando, ignorar */ }
      }, 2000);

    } else {
      // ── Browser: MediaRecorder client-side ────────────────────────────
      console.log('[rec] Iniciando grabación Browser — getUserMedia');
      log('[Debug] Grabación Browser — getUserMedia (mic del dispositivo que abre la página)', 'info');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Obtener nombre reservado del servidor
      const { filename } = await fetch('/record/reserve-browser', { method: 'POST' }).then(r => r.json());
      this._brFilename = filename;
      this._chunks     = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';

      this._mediaRec = new MediaRecorder(stream, { mimeType });
      this._mediaRec.ondataavailable = (e) => { if (e.data.size > 0) this._chunks.push(e.data); };
      this._mediaRec.start(500);

      log(`⏺ Grabando Browser — ${filename}`, 'success');
    }

    // Timer común
    ui.btnRecStart.style.display = 'none';
    ui.btnRecStop.style.display  = '';
    ui.recTimer.style.display    = '';
    this._elapsed  = 0;
    this._interval = setInterval(() => {
      this._elapsed++;
      ui.recSeconds.textContent = this._elapsed;
    }, 1000);
  },

  _clearStatusPoll() {
    if (this._statusPoll) { clearInterval(this._statusPoll); this._statusPoll = null; }
  },

  // ── Detener ───────────────────────────────────────────────────────────────
  async stop() {
    this._clearStatusPoll();
    clearInterval(this._interval);
    this._interval = null;
    ui.btnRecStop.style.display  = 'none';
    ui.btnRecStart.style.display = '';
    ui.recTimer.style.display    = 'none';
    ui.recSeconds.textContent    = '0';

    if (this._mediaRec) {
      // ── Browser: subir blob al servidor ──────────────────────────────
      await new Promise(resolve => {
        this._mediaRec.onstop = resolve;
        this._mediaRec.stop();
        this._mediaRec.stream.getTracks().forEach(t => t.stop());
      });

      const blob    = new Blob(this._chunks, { type: this._mediaRec.mimeType });
      const buffer  = await blob.arrayBuffer();
      console.log(`[rec] Subiendo grabación browser — ${this._brFilename} (${(buffer.byteLength/1024).toFixed(1)} KB)`);

      const res = await fetch(`/record/upload/${this._brFilename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body:   buffer,
      }).then(r => r.json());

      this._mediaRec = null;
      this._chunks   = [];

      if (!res.ok) throw new Error(res.error || 'Error al guardar grabación');
      log(`✔ Guardado browser: ${res.filename}`, 'success');

    } else {
      // ── ALSA: detener arecord ─────────────────────────────────────────
      const res = await fetch('/record/stop', { method: 'POST' }).then(r => r.json());
      if (!res.ok) throw new Error(res.error);
      log(`✔ Guardado ALSA: ${res.filename} (${res.duration}s)`, 'success');
      // Esperar que arecord termine de escribir el WAV antes de listar
      await new Promise(r => setTimeout(r, 400));
    }

    await this.refreshList();
  },

  async refreshList() {
    try {
      const { files } = await fetch('/recordings').then(r => r.json());
      ui.recordingsList.innerHTML = '';
      if (files.length === 0) {
        ui.recordingsList.innerHTML = '<li class="rec-empty">Sin grabaciones aún.</li>';
        return;
      }
      for (const f of files) ui.recordingsList.appendChild(this._makeRecItem(f));
    } catch (err) {
      log(`Error cargando grabaciones: ${err.message}`, 'error');
    }
  },

  _makeRecItem(f) {
    const kb        = (f.size / 1024).toFixed(1);
    const date      = new Date(f.created).toLocaleString();
    const isBrowser = f.filename.includes('_browser_');

    const li = document.createElement('li');
    li.className = 'rec-item';

    const srcEl = document.createElement('span');
    srcEl.title       = isBrowser ? 'Browser mic' : 'Pi ALSA mic';
    srcEl.textContent = isBrowser ? '🌐' : '🍓';

    const nameEl = document.createElement('span');
    nameEl.className = 'rec-item-name';
    nameEl.title     = f.filename;
    nameEl.textContent = f.filename;

    const sizeEl = document.createElement('span');
    sizeEl.className   = 'rec-item-size';
    sizeEl.textContent = `${kb} KB · ${date}`;

    const playBtn = document.createElement('button');
    playBtn.className        = 'rec-item-play';
    playBtn.dataset.filename = f.filename;
    playBtn.textContent      = '▶';
    playBtn.title            = 'Reproducir';
    playBtn.addEventListener('click', () => {
      if (playBtn.classList.contains('playing')) {
        PlaybackModule.stop();
      } else {
        PlaybackModule.play(f.filename, playBtn);
      }
    });

    const dlLink = document.createElement('a');
    dlLink.className = 'rec-item-dl';
    dlLink.href      = `/recordings/${encodeURIComponent(f.filename)}`;
    dlLink.download  = f.filename;
    dlLink.textContent = '↓';

    const delBtn = document.createElement('button');
    delBtn.className   = 'rec-item-del';
    delBtn.textContent = '🗑';
    delBtn.title       = 'Eliminar';
    delBtn.addEventListener('click', async () => {
      if (delBtn.disabled) return;
      if (!confirm(`¿Eliminar "${f.filename}"?`)) return;
      delBtn.disabled = true;
      try {
        const res = await fetch(`/recordings/${encodeURIComponent(f.filename)}`, { method: 'DELETE' }).then(r => r.json());
        if (!res.ok) throw new Error(res.error);
        log(`🗑 Eliminado: ${f.filename}`, 'info');
        await RecorderModule.refreshList();
      } catch (err) {
        log(`Error al eliminar: ${err.message}`, 'error');
        delBtn.disabled = false;
      }
    });

    li.append(srcEl, nameEl, sizeEl, playBtn, dlLink, delBtn);
    return li;
  },
};

// Botones de grabación
document.getElementById('btn-rec-start').addEventListener('click', async () => {
  try { await RecorderModule.start(); }
  catch (err) { log(`Error al grabar: ${err.message}`, 'error'); }
});
document.getElementById('btn-rec-stop').addEventListener('click', async () => {
  try { await RecorderModule.stop(); }
  catch (err) { log(`Error al detener: ${err.message}`, 'error'); }
});

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

  // Helpers DOM
  _set(id, val, sub, dotClass) {
    const valEl = document.getElementById(`${id}-val`);
    const subEl = document.getElementById(`${id}-sub`);
    const dotEl = document.getElementById(`${id}-dot`);
    if (valEl && val !== undefined) valEl.textContent = val;
    if (subEl && sub !== undefined) subEl.textContent = sub;
    if (dotEl && dotClass !== undefined) {
      dotEl.className = `dbg-dot ${dotClass}`;
    }
  },

  _render() {
    this._renderMic();
    this._renderSpeaker();
    this._renderLiveKit();
    this._renderAgent();
  },

  _renderMic() {
    const m = PiMicModule;

    // Pi mic activo
    if (m._ws && m._ws.readyState === WebSocket.OPEN) {
      const ago     = m._lastFrameAt ? Math.round((Date.now() - m._lastFrameAt) / 1000) : null;
      const flowing = ago !== null && ago < 2;
      const ctxState = m._audioCtx?.state || '—';
      const gain    = state.micGain ? `gain ${state.micGain}x` : '';

      const subParts = [];
      if (m._device)     subParts.push(m._device);
      if (gain)          subParts.push(gain);
      if (ctxState !== '—') subParts.push(`ctx:${ctxState}`);

      this._set('dbg-mic',
        flowing
          ? `Pi — frame #${m._frameCount} · ${ago}s ago`
          : m._frameCount > 0
            ? `Pi — frame #${m._frameCount} · ${ago ?? '?'}s (sin flujo)`
            : `Pi — conectando…`,
        subParts.join(' · '),
        flowing ? 'ok pulse' : m._frameCount > 0 ? 'warn' : 'idle pulse'
      );
      return;
    }

    // Mic test browser (modo mictest, no Pi)
    if (state.mode === 'mictest' && state.stream) {
      const tracks = state.stream.getAudioTracks();
      const active = tracks.length > 0 && tracks[0].readyState === 'live';
      this._set('dbg-mic',
        active ? 'Browser mic — activo' : 'Browser mic — sin señal',
        tracks[0]?.label?.slice(0, 40) || '',
        active ? 'ok' : 'warn'
      );
      return;
    }

    // LiveKit local track publicado
    if (state.active && state.localTrack) {
      const track = state.localTrack;
      const ms    = track.mediaStreamTrack;
      const alive = ms?.readyState === 'live';
      this._set('dbg-mic',
        alive ? 'LiveKit mic — publicado' : 'LiveKit mic — track inactivo',
        ms?.label?.slice(0, 40) || '',
        alive ? 'ok' : 'warn'
      );
      return;
    }

    this._set('dbg-mic', 'Inactivo', 'Sin fuente de audio', 'idle');
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

    // Pi speaker activo — reproducción de grabación via aplay
    if (PlaybackModule._piActive) {
      const pb = PlaybackModule;
      const filename = pb._activeBtn?.dataset?.filename || '—';
      const elapsed  = pb._playStartAt ? Math.round((Date.now() - pb._playStartAt) / 1000) : 0;
      this._set('dbg-spk',
        `Pi aplay — ${elapsed}s`,
        filename,
        'ok pulse'
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
  if (!navigator.mediaDevices?.getUserMedia) {
    log('getUserMedia no soportado. Usá un navegador moderno (HTTPS o localhost).', 'error');
    ui.btnMic.disabled = true;
    return;
  }

  // ─── Obtener config del servidor ──────────────────────────────────────────
  let isRaspberry = false;
  let isLinux     = false;
  try {
    const cfg = await fetch('/config').then((r) => r.json());

    if (cfg.server) {
      const dev = deviceLabel(cfg.server.platform, cfg.server.arch);
      ui.smDeviceIcon.textContent = dev.icon;
      ui.smDeviceVal.textContent  = dev.name;
      ui.smDeviceDot.className    = 'sm-dot connected';
      log(`Dispositivo: ${dev.name} (${cfg.server.hostname} · ${cfg.server.arch})`, 'info');

      isLinux     = cfg.server.platform === 'linux';
      isRaspberry = isLinux && /arm/i.test(cfg.server.arch);
      log(`Debug: platform=${cfg.server.platform} arch=${cfg.server.arch} isLinux=${isLinux} isRaspberry=${isRaspberry}`, 'info');
      if (cfg.micGain) state.micGain = cfg.micGain;
    }

    if (!cfg.livekitUrl) {
      log('LIVEKIT_URL no configurado en .env', 'warn');
    } else {
      ui.smLkSub.textContent = cfg.livekitUrl.replace('wss://', '');
    }

    if (!cfg.tokenApiConfigured) {
      log('TOKEN_API_URL no configurado en .env', 'warn');
    }

  } catch {
    log('No se pudo contactar al servidor Express en /config', 'warn');
    ui.smDeviceVal.textContent = 'Sin respuesta';
    ui.smDeviceDot.className   = 'sm-dot error';
  }

  // ─── Nombre del micrófono (si ya hay permiso previo) ─────────────────────
  updateMicName();

  // ─── Selector de fuente de audio (siempre visible en Raspberry) ──────────
  if (isRaspberry) {
    ui.audioSourceWrap.style.display = '';

    // Cargar dispositivos ALSA en el dropdown
    try {
      const { devices } = await fetch('/audio-devices').then((r) => r.json());
      if (devices.length > 0) {
        ui.alsaDeviceSelect.innerHTML = devices
          .map((d) => `<option value="${d.id}">${d.name} (${d.id})</option>`)
          .join('');
        log(`${devices.length} dispositivo(s) ALSA: ${devices.map((d) => d.id).join(', ')}`, 'info');
      } else {
        ui.alsaDeviceSelect.innerHTML = '<option value="">Sin dispositivos ALSA</option>';
        log('Raspberry detectada — sin dispositivos ALSA conectados', 'warn');
      }
    } catch {
      ui.alsaDeviceSelect.innerHTML = '<option value="">Error al leer ALSA</option>';
    }

    // ── Selector de speaker (Pi o browser) ──────────────────────────────────
    const speakerDestWrap  = document.getElementById('speaker-dest-wrap');
    const alsaSpeakerWrap  = document.getElementById('alsa-speaker-wrap');
    const alsaSpeakerSel   = document.getElementById('alsa-speaker-select');

    if (speakerDestWrap) {
      speakerDestWrap.style.display = '';

      // Cargar dispositivos ALSA de reproducción
      try {
        const { devices: pbDevices } = await fetch('/audio-playback-devices').then(r => r.json());
        if (pbDevices.length > 0) {
          alsaSpeakerSel.innerHTML = pbDevices
            .map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`)
            .join('');
          log(`${pbDevices.length} dispositivo(s) ALSA playback: ${pbDevices.map(d => d.id).join(', ')}`, 'info');
        } else {
          alsaSpeakerSel.innerHTML = '<option value="plughw:0,0">plughw:0,0 (default)</option>';
        }
      } catch {
        alsaSpeakerSel.innerHTML = '<option value="plughw:0,0">plughw:0,0 (default)</option>';
      }

      // Mostrar/ocultar dropdown ALSA playback
      const updateSpeakerState = () => {
        alsaSpeakerWrap.style.display = getSelectedSpeakerDest() === 'pi' ? '' : 'none';
      };
      document.querySelectorAll('input[name="speaker-dest"]').forEach(r => {
        r.addEventListener('change', updateSpeakerState);
      });
      updateSpeakerState();
    }

    // Actualizar tarjeta Dispositivo según la fuente seleccionada
    const updateDeviceCard = () => {
      const isPi = getSelectedSource() === 'pi';
      if (isPi) {
        const deviceName = ui.alsaDeviceSelect.options[ui.alsaDeviceSelect.selectedIndex]?.text || 'ALSA';
        ui.smDeviceSub.textContent = deviceName;
      } else {
        updateMicName();   // lee el mic del browser con enumerateDevices
      }
    };

    // Mostrar/ocultar dropdown ALSA — grabación disponible en ambas fuentes
    const updateSourceState = () => {
      const isPi = getSelectedSource() === 'pi';
      ui.alsaDeviceWrap.style.display = isPi ? '' : 'none';
      ui.btnRecStart.disabled         = false;
      ui.btnRecStart.title            = '';
      updateDeviceCard();
    };

    ui.audioSourceRadios.forEach((radio) => {
      radio.addEventListener('change', updateSourceState);
    });

    // También actualizar si cambia el dispositivo ALSA seleccionado
    ui.alsaDeviceSelect.addEventListener('change', updateDeviceCard);

    updateSourceState(); // estado inicial

  }

  // ─── Grabaciones — siempre visible (browser recording funciona en cualquier plataforma) ──
  await RecorderModule.show();

  // ─── Bluetooth y terminal (solo Linux) ───────────────────────────────────
  if (isLinux) {
    BluetoothModule.init();
    const tabNav = document.getElementById('tab-nav');
    if (tabNav) {
      tabNav.style.display = 'flex';
      let terminalInited = false;
      tabNav.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          tabNav.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const tab = btn.dataset.tab;
          document.getElementById('panel-section').style.display    = tab === 'panel'    ? '' : 'none';
          document.getElementById('terminal-section').style.display = tab === 'terminal' ? '' : 'none';
          if (tab === 'terminal' && !terminalInited) {
            terminalInited = true;
            TerminalModule.init();
          }
        });
      });
    }
  }

  // ─── Verificar conectividad con LiveKit + arrancar chequeo periódico ─────
  checkLiveKitHealth();
  startHealthCheck();

  log('Brumexa-Edge listo. Seleccioná modo y presioná "Iniciar micrófono".', 'info');

  // ─── Debug panel — arrancar loop de actualización ────────────────────────
  DebugModule.start();
})();
