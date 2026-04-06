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
  btnMic:    document.getElementById('btn-mic'),
  modeBtns:  document.querySelectorAll('.mode-btn'),
  badgeMode: document.getElementById('badge-mode'),
  log:       document.getElementById('log'),
  alertsArea:document.getElementById('alerts-area'),

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

  // Cards
  vumeterCard: document.getElementById('vumeter-card'),
  vuCanvas:    document.getElementById('vu-canvas'),
  vuBar:       document.getElementById('vu-bar'),
  vuDb:        document.getElementById('vu-db'),
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
// TOAST ALERTS
// ============================================================
let _toastId = 0;
function showAlert(msg, type = 'info', duration = 4000) {
  const id = ++_toastId;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.id = `toast-${id}`;

  const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${msg}</span><button class="toast-close" onclick="this.parentElement.remove()">×</button>`;

  ui.alertsArea.prepend(el);

  if (duration > 0) {
    setTimeout(() => el.remove(), duration);
  }
  return id;
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

  if (msgEl) msgEl.textContent = msg || '';
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
function setLiveKitStatus(status, sub = '') {
  const labels = {
    idle:        'Sin conexión',
    online:      'En línea',
    connecting:  'Conectando…',
    connected:   'Conectado',
    recording:   'Grabando',
    error:       'Sin respuesta',
  };
  const dotClass = {
    idle:       'idle',
    online:     'connected',
    connecting: 'connecting',
    connected:  'connected',
    recording:  'recording',
    error:      'error',
  };
  ui.smLkVal.textContent = labels[status] || status;
  if (sub) ui.smLkSub.textContent = sub;
  ui.smLkDot.className   = `sm-dot ${dotClass[status] || 'idle'}`;
}

async function checkLiveKitHealth() {
  ui.smLkVal.textContent = 'Verificando…';
  ui.smLkDot.className   = 'sm-dot connecting';
  try {
    const h = await fetch('/livekit-health').then((r) => r.json());
    if (h.online) {
      setLiveKitStatus('online', `${ui.smLkSub.textContent} · ${h.latency}ms`);
      log(`LiveKit en línea · latencia: ${h.latency}ms`, 'success');
    } else if (h.reason === 'no-config') {
      setLiveKitStatus('idle', 'sin configurar');
    } else {
      setLiveKitStatus('error', h.reason || 'sin respuesta');
      log(`LiveKit no responde: ${h.reason || ''}`, 'warn');
      showAlert('LiveKit no responde — verificá LIVEKIT_URL', 'warn', 6000);
    }
  } catch {
    setLiveKitStatus('error', 'error de red');
    log('No se pudo verificar LiveKit', 'warn');
  }
}

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
// MÓDULO LIVEKIT
// ============================================================
const LiveKitModule = {

  async fetchToken() {
    const identity = `client-${Date.now()}`;
    const res = await fetch(`/token?identity=${identity}`);
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
    log('Solicitando token al servidor…');
    setLiveKitStatus('connecting');
    setStep('token', 'loading', 'obteniendo…');

    let tokenData, serverUrl;

    try {
      [tokenData, serverUrl] = await Promise.all([
        this.fetchToken(),
        this.fetchServerUrl(),
      ]);
    } catch (err) {
      setStep('token', 'error', 'falló');
      setLiveKitStatus('error', 'error de conexión');
      showAlert('No se pudo obtener el token. Revisá el .env del servidor.', 'error', 0);
      throw err;
    }

    setStep('token', 'ok', tokenData.room);
    activateConnector(1);
    log(`Token OK · sala: "${tokenData.room}"`);

    setStep('connect', 'loading', 'conectando…');

    const room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast:       true,
    });

    room.on(LivekitClient.RoomEvent.Connected, () => {
      log('Conectado a LiveKit', 'success');
      setStep('connect', 'ok', tokenData.room);
      activateConnector(2);
      setLiveKitStatus('connected', `sala: ${tokenData.room}`);
      showAlert(`Conectado a sala "${tokenData.room}"`, 'success');
    });

    room.on(LivekitClient.RoomEvent.Disconnected, (reason) => {
      log(`Desconectado: ${reason || 'sin razón'}`, 'warn');
      checkLiveKitHealth();   // vuelve a verificar si el server sigue en línea
      resetSteps();
      showAlert(`Desconectado de LiveKit${reason ? ': ' + reason : ''}`, 'warn');
      this._resetState();
    });

    room.on(LivekitClient.RoomEvent.MediaDevicesError, (err) => {
      log(`Error de dispositivo: ${err.message}`, 'error');
      setMicStatus('error', err.message);
      showAlert('Error de micrófono: ' + err.message, 'error', 0);
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

    try {
      await room.connect(serverUrl, tokenData.token);
    } catch (err) {
      setStep('connect', 'error', 'falló');
      setLiveKitStatus('error', 'error de conexión');
      showAlert('No se pudo conectar a LiveKit. Verificá la URL y credenciales.', 'error', 0);
      throw err;
    }

    log('Publicando micrófono…');
    setStep('publish', 'loading', 'publicando…');
    setMicStatus('requesting', 'getUserMedia…');
    updateMicName();

    let localTrack;
    try {
      localTrack = await LivekitClient.createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      });
      await room.localParticipant.publishTrack(localTrack);
    } catch (err) {
      setStep('publish', 'error', 'falló');
      setMicStatus('error', 'sin permiso');
      showAlert('No se pudo publicar el micrófono: ' + err.message, 'error', 0);
      throw err;
    }

    setStep('publish', 'ok', 'activo');
    setMicStatus('active', 'LiveKit');
    setLiveKitStatus('recording', `sala: ${tokenData.room}`);
    log('Micrófono publicado en la sala', 'success');
    showAlert('Micrófono activo en LiveKit', 'success');

    state.room       = room;
    state.localTrack = localTrack;
  },

  async stop() {
    if (state.localTrack) {
      await state.room?.localParticipant?.unpublishTrack(state.localTrack);
      state.localTrack.stop();
      state.localTrack = null;
    }
    if (state.room) {
      await state.room.disconnect();
      state.room = null;
    }
    setMicStatus('idle');
    resetSteps();
    log('Desconectado de LiveKit', 'warn');
    showAlert('Desconectado de LiveKit', 'warn');
    checkLiveKitHealth();   // vuelve a mostrar "En línea" si el server sigue up
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
    log('Solicitando micrófono para test…');
    setMicStatus('requesting', 'getUserMedia');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.stream = stream;
    updateMicName();

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source   = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize               = 256;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);

    state.audioCtx = audioCtx;
    state.analyser = analyser;

    log('Micrófono capturado. Hablá para ver el nivel.', 'success');
    setMicStatus('active', 'Test directo');
    showAlert('Test de micrófono activo — sin servidor, sin internet', 'success');
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
function updateMicButton(active) {
  ui.btnMic.textContent = active ? 'Detener' : 'Iniciar micrófono';
  ui.btnMic.classList.toggle('recording', active);
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
// INIT
// ============================================================
(async function init() {

  // ─── Detectar soporte de getUserMedia ─────────────────────────────────────
  if (!navigator.mediaDevices?.getUserMedia) {
    log('getUserMedia no soportado. Usá un navegador moderno (HTTPS o localhost).', 'error');
    ui.btnMic.disabled = true;
    showAlert('Navegador no soportado — getUserMedia no disponible', 'error', 0);
    return;
  }

  // ─── Obtener config del servidor ──────────────────────────────────────────
  // El servidor corre en el mismo dispositivo (Raspberry / PC),
  // así que su info de plataforma es la fuente correcta.
  try {
    const cfg = await fetch('/config').then((r) => r.json());

    if (cfg.server) {
      const dev = deviceLabel(cfg.server.platform, cfg.server.arch);
      ui.smDeviceIcon.textContent = dev.icon;
      ui.smDeviceVal.textContent  = dev.name;
      ui.smDeviceDot.className    = 'sm-dot connected';
      log(`Dispositivo: ${dev.name} (${cfg.server.hostname} · ${cfg.server.arch})`, 'info');
    }

    if (!cfg.livekitUrl) {
      log('LiveKit no configurado (LIVEKIT_URL faltante)', 'warn');
      showAlert('LIVEKIT_URL no configurado en el .env', 'warn', 0);
    } else {
      ui.smLkSub.textContent = cfg.livekitUrl.replace('wss://', '');
    }

    if (!cfg.apiKeyConfigured || !cfg.apiSecretConfigured) {
      showAlert('API Key o Secret no configurados en el .env', 'error', 0);
    }

  } catch {
    log('No se pudo contactar al servidor en /config', 'warn');
    ui.smDeviceVal.textContent = 'Sin respuesta';
    ui.smDeviceDot.className   = 'sm-dot error';
    showAlert('No se pudo contactar al servidor Express', 'error');
  }

  // ─── Nombre del micrófono (si ya hay permiso previo) ─────────────────────
  updateMicName();

  // ─── Verificar conectividad con LiveKit ───────────────────────────────────
  checkLiveKitHealth();

  log('Brumexa-Edge listo. Seleccioná modo y presioná "Iniciar micrófono".', 'info');
})();
