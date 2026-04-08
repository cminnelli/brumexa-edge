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
  _ws:       null,
  _audioCtx: null,

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

    this._audioCtx = audioCtx;

    // WebSocket al servidor
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl    = `${protocol}//${location.host}/ws/audio?device=${encodeURIComponent(device)}`;
    const ws       = new WebSocket(wsUrl);
    ws.binaryType  = 'arraybuffer';
    this._ws = ws;

    await new Promise((resolve, reject) => {
      ws.onopen  = () => {
        log(`WebSocket abierto — dispositivo: ${device}`, 'success');
        resolve();
      };
      ws.onerror = () => reject(new Error(`WebSocket de audio falló (${device})`));
    });

    let chunkCount = 0;
    ws.onmessage = (e) => {
      workletNode.port.postMessage(e.data, [e.data]);
      if (++chunkCount === 5) log('PCM recibiendo datos del mic Pi…', 'info');
    };

    ws.onclose = (e) => {
      if (state.active) log(`WebSocket cerrado: ${e.reason || 'sin razón'}`, 'warn');
    };

    return destination.stream;
  },

  stop() {
    this._ws?.close();
    this._ws = null;
    this._audioCtx?.close();
    this._audioCtx = null;
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
    resetSteps();
    log('Solicitando token al servidor central…');
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
      log(`Conectado a LiveKit · sala: ${tokenData.room} · participantes: ${room.remoteParticipants.size}`, 'success');
      setStep('connect', 'ok', tokenData.room);
      activateConnector(2);
      startSessionTimer();
      showReconectar(false);
      stopHealthCheck();
      updateWorkerState();
      if (room.remoteParticipants.size === 0) {
        log('Sin worker en sala — el agente brumexa-api no se unió. Verificá que esté corriendo.', 'warn');
      } else {
        const ids = [...room.remoteParticipants.values()].map(p => p.identity).join(', ');
        log(`Workers en sala: ${ids}`, 'success');
      }
    });

    room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
      log(`Worker conectado: ${participant.identity}`, 'success');
      updateWorkerState();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      log(`Worker desconectado: ${participant.identity}`, 'warn');
      updateWorkerState();
      if (room.remoteParticipants.size === 0) {
        log('Sin workers en sala — audio sin destino.', 'warn');
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

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Audio) return;
      log(`Audio recibido de "${participant.identity}"`, 'info');
      const audioEl = track.attach();
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
    });

    log(`Conectando a: ${livekitUrl}`, 'info');

    try {
      await room.connect(livekitUrl, tokenData.token);
    } catch (err) {
      setStep('connect', 'error', 'falló');
      setChannelStatus('closed', tokenData.room);   // token OK pero LiveKit no responde
      log(`Error al conectar: ${err.message}`, 'error');
      throw err;
    }

    log('Publicando micrófono…');
    setStep('publish', 'loading', 'publicando…');
    setMicStatus('requesting', 'obteniendo fuente…');

    let localTrack;
    let micStream;   // para el mini VU meter

    try {
      if (getSelectedSource() === 'pi') {
        // ── Fuente Pi: WebSocket → AudioWorklet → MediaStream → LiveKit ──────
        micStream              = await PiMicModule.start(getSelectedAlsaDevice());
        const [rawAudioTrack]  = micStream.getAudioTracks();
        // publishTrack devuelve LocalTrackPublication — guardamos pub.track (LocalAudioTrack)
        // que sí tiene .stop() para la limpieza en stop()
        const pub = await room.localParticipant.publishTrack(rawAudioTrack, {
          name:   'pi-mic',
          source: LivekitClient.Track.Source.Microphone,
        });
        localTrack = pub.track ?? pub;

      } else {
        // ── Fuente browser: API pública de LiveKit con procesadores de audio ──
        localTrack = await LivekitClient.createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        });
        await room.localParticipant.publishTrack(localTrack);
        micStream = localTrack.mediaStreamTrack
          ? new MediaStream([localTrack.mediaStreamTrack])
          : null;
        updateMicName();
      }

    } catch (err) {
      PiMicModule.stop();
      setStep('publish', 'error', 'falló');
      setMicStatus('error', 'sin permiso');
      throw err;
    }

    const sourceName = getSelectedSource() === 'pi' ? 'Pi ALSA' : 'Browser';
    setStep('publish', 'ok', 'activo');
    setMicStatus('active', sourceName);
    updateWorkerState();
    log(`Micrófono publicado — fuente: ${sourceName}`, 'success');
    if (micStream) startMiniVu(micStream);

    state.room       = room;
    state.localTrack = localTrack;
  },

  async stop() {
    PiMicModule.stop();
    stopMiniVu();
    stopSessionTimer();
    if (state.localTrack) {
      await state.room?.localParticipant?.unpublishTrack(state.localTrack);
      state.localTrack.stop();
      state.localTrack = null;
    }
    if (state.room) {
      const r  = state.room;
      state.room = null;   // marcar antes de disconnect para que el handler Disconnected no interfiera
      await r.disconnect();
    }
    setMicStatus('idle');
    setChannelStatus('closed');
    resetSteps();
    showReconectar(false);
    log('Desconectado de LiveKit', 'warn');
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

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source   = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize               = 256;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);

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
    state.audioCtx?.close();
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
let _hadSession = false;   // true después de la primera sesión

function updateMicButton(active) {
  if (active) {
    ui.btnMic.textContent = 'Detener';
    ui.btnMic.classList.add('recording');
  } else {
    ui.btnMic.textContent = _hadSession ? 'Seguir' : 'Iniciar micrófono';
    ui.btnMic.classList.remove('recording');
  }
}

ui.btnMic.addEventListener('click', async () => {
  ui.btnMic.disabled = true;
  try {
    if (!state.active) {
      state.active = true;
      _hadSession  = true;
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
// MÓDULO GRABACIONES (solo Pi — requiere ALSA)
// ============================================================
const RecorderModule = {
  _interval: null,
  _elapsed:  0,

  // Mostrar la card y cargar la lista inicial
  async show() {
    ui.recordingsCard.style.display = '';
    await this.refreshList();
  },

  // Iniciar grabación en el servidor
  async start() {
    const device = getSelectedAlsaDevice();
    const res    = await fetch('/record/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ device }),
    }).then((r) => r.json());

    if (!res.ok) throw new Error(res.error);

    log(`Grabando en la Pi — ${res.filename}`, 'success');
    ui.btnRecStart.style.display = 'none';
    ui.btnRecStop.style.display  = '';
    ui.recTimer.style.display    = '';
    this._elapsed = 0;
    this._interval = setInterval(() => {
      this._elapsed++;
      ui.recSeconds.textContent = this._elapsed;
    }, 1000);
  },

  // Detener grabación
  async stop() {
    const res = await fetch('/record/stop', { method: 'POST' }).then((r) => r.json());
    if (!res.ok) throw new Error(res.error);

    clearInterval(this._interval);
    this._interval = null;
    ui.btnRecStop.style.display  = 'none';
    ui.btnRecStart.style.display = '';
    ui.recTimer.style.display    = 'none';
    ui.recSeconds.textContent    = '0';

    log(`Grabación guardada: ${res.filename} (${res.duration}s)`, 'success');
    await this.refreshList();
  },

  // Refrescar la lista de archivos guardados
  async refreshList() {
    try {
      const { files } = await fetch('/recordings').then((r) => r.json());
      if (files.length === 0) {
        ui.recordingsList.innerHTML = '<li class="rec-empty">Sin grabaciones aún.</li>';
        return;
      }
      ui.recordingsList.innerHTML = files.map((f) => {
        const kb   = (f.size / 1024).toFixed(1);
        const date = new Date(f.created).toLocaleString();
        return `
          <li class="rec-item">
            <span class="rec-item-name" title="${f.filename}">${f.filename}</span>
            <span class="rec-item-size">${kb} KB · ${date}</span>
            <a class="rec-item-dl" href="/recordings/${f.filename}" download>↓ WAV</a>
          </li>`;
      }).join('');
    } catch (err) {
      log(`Error cargando grabaciones: ${err.message}`, 'error');
    }
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
  try {
    const cfg = await fetch('/config').then((r) => r.json());

    if (cfg.server) {
      const dev = deviceLabel(cfg.server.platform, cfg.server.arch);
      ui.smDeviceIcon.textContent = dev.icon;
      ui.smDeviceVal.textContent  = dev.name;
      ui.smDeviceDot.className    = 'sm-dot connected';
      log(`Dispositivo: ${dev.name} (${cfg.server.hostname} · ${cfg.server.arch})`, 'info');

      // Detectar Raspberry por platform+arch (fuente autoritativa: Node.js en el servidor)
      isRaspberry = cfg.server.platform === 'linux' && /arm/i.test(cfg.server.arch);
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
        RecorderModule.show();
      } else {
        // Raspberry detectada pero sin dispositivos ALSA aún
        ui.alsaDeviceSelect.innerHTML = '<option value="">Sin dispositivos ALSA</option>';
        log('Raspberry detectada — sin dispositivos ALSA conectados', 'warn');
      }
    } catch {
      ui.alsaDeviceSelect.innerHTML = '<option value="">Error al leer ALSA</option>';
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

    // Mostrar/ocultar dropdown ALSA + habilitar grabación según fuente
    const updateSourceState = () => {
      const isPi = getSelectedSource() === 'pi';
      ui.alsaDeviceWrap.style.display = isPi ? '' : 'none';
      ui.btnRecStart.disabled         = !isPi;
      ui.btnRecStart.title            = isPi ? '' : 'Solo disponible con Micrófono de la Pi';
      updateDeviceCard();
    };

    ui.audioSourceRadios.forEach((radio) => {
      radio.addEventListener('change', updateSourceState);
    });

    // También actualizar si cambia el dispositivo ALSA seleccionado
    ui.alsaDeviceSelect.addEventListener('change', updateDeviceCard);

    updateSourceState(); // estado inicial
  }

  // ─── Verificar conectividad con LiveKit + arrancar chequeo periódico ─────
  checkLiveKitHealth();
  startHealthCheck();

  log('Brumexa-Edge listo. Seleccioná modo y presioná "Iniciar micrófono".', 'info');
})();
