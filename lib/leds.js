'use strict';

// NeoPixel WS2812 — 8 LEDs en GPIO 10 (SPI MOSI, Physical Pin 19)
// Requiere: npm install rpi-ws281x  (solo en la Pi, correr con sudo)

const NUM_LEDS = 8;
const GPIO_PIN = 10;

// Colores de marca: indigo Brumexa (mismo --accent #5b6af0 de la UI web) para
// idle, ámbar (complementario del indigo, máximo contraste) para "hablando".
const IDLE_HUE  = 234;
const SPEAK_HUE = 40;

let ws281x   = null;
let _breathe = null;

// Guardado para /diag/leds — así el panel puede mostrar el motivo exacto por
// el que los LEDs no prenden (ej. "Cannot find module 'rpi-ws281x'") sin
// tener que ir a buscarlo en los logs de PM2/consola.
let _lastError = null;

function init() {
  try {
    ws281x = require('rpi-ws281x');
    ws281x.configure({ leds: NUM_LEDS, dma: 10, frequency: 800000, gpio: GPIO_PIN, brightness: 255, stripType: 'grb' });
    console.log(`[leds] NeoPixel listo — ${NUM_LEDS} LEDs en GPIO ${GPIO_PIN}`);
    _lastError = null;
    breathe();
  } catch (e) {
    console.warn('[leds] rpi-ws281x no disponible:', e.message);
    _lastError = e.message;
    ws281x = null;
  }
}

// ─── Diagnóstico para /diag/leds ─────────────────────────────────────────────
// Distingue "el paquete rpi-ws281x no está instalado" de "está instalado pero
// configure() falló" (ej. sin sudo, GPIO ocupado) — son causas y arreglos
// distintos, y antes esa diferencia solo se veía leyendo el mensaje del catch
// a mano en la consola.
function getDiagnostics() {
  let packageInstalled = false;
  let packageVersion   = null;
  try {
    packageVersion = require('rpi-ws281x/package.json').version;
    packageInstalled = true;
  } catch {}

  return {
    platform:         process.platform,
    packageInstalled,
    packageVersion,
    configured:        !!ws281x,
    lastError:         _lastError,
    numLeds:           NUM_LEDS,
    gpioPin:           GPIO_PIN,
    isRoot:            typeof process.getuid === 'function' ? process.getuid() === 0 : null,
  };
}

// ─── Test visual: verde fijo por unos segundos, inconfundible con cualquier
// otra animación (idle=indigo, hablando=ámbar, error=rojo, conectando=—) ────
function test(durationMs = 2500) {
  if (!ws281x) return false;
  on({ r: 0, g: 255, b: 0 });
  setTimeout(() => _renderIdle(), durationMs);
  return true;
}

// HSV → RGB
function hsvToRgb(h, s, v) {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v,t,p,p,q,v],[q,v,v,t,p,p],[p,p,q,v,v,t]].map(ch => Math.round(ch[i] * 255));
  return { r, g, b };
}

// Render directo sin tocar el intervalo activo
function _render(r, g, b) {
  if (!ws281x) return;
  const px = new Uint32Array(NUM_LEDS);
  px.fill((r << 16) | (g << 8) | b);
  ws281x.render(px);
}

function _stopBreathe() {
  if (_breathe) { clearInterval(_breathe); _breathe = null; }
}

// Transicion suave de un color a otro en durationMs, luego llama onDone
function _fadeTo(r1, g1, b1, r2, g2, b2, durationMs, onDone) {
  _stopBreathe();
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const p    = Math.min(1, t / durationMs);
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    _render(
      Math.round(r1 + (r2 - r1) * ease),
      Math.round(g1 + (g2 - g1) * ease),
      Math.round(b1 + (b2 - b1) * ease)
    );
    if (t >= durationMs) {
      clearInterval(_breathe);
      _breathe = null;
      if (onDone) onDone();
    }
  }, STEP);
}

// ─── Idle: respira indigo (color de marca Brumexa), curva orgánica ──────────
// Antes el hue oscilaba entre cyan y magenta ligado a la MISMA fase que el
// brillo — eso hacía que el brillo máximo cayera justo en los extremos
// (cyan/magenta) y el brillo fuera CERO cuando el hue pasaba por el indigo
// (~240°), o sea: el ojo nunca llegaba a ver indigo, solo lo veía apagado.
// Ahora el hue queda fijo en IDLE_HUE y solo el brillo respira, para que se
// lea siempre como el indigo de marca.
function breathe() {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  const PERIOD = 4200;
  const STEP   = 16;

  _breathe = setInterval(() => {
    t += STEP;
    const phase = (t % PERIOD) / PERIOD;

    // Curva no lineal: sin^2 base + armónico sutil que rompe la monotonía
    const base    = Math.pow(Math.sin(phase * Math.PI * 2), 2);
    const shimmer = 0.07 * Math.sin(phase * Math.PI * 10 + 1.2);
    const bright  = Math.max(0.02, Math.min(1, base + shimmer));

    const { r, g, b } = hsvToRgb(IDLE_HUE, 1, bright);
    _render(r, g, b);
  }, STEP);
}

// ─── Conectando: respiración cian, más rápida que el idle ───────────────────
// Genérica a propósito — cualquier "estamos conectando a algo" (hoy LiveKit,
// mañana wifi/bluetooth si hace falta) puede llamar a esta misma función en
// vez de inventar una animación nueva. Cian queda lejos en la rueda de color
// del indigo del idle (234°) y del ámbar de "hablando" (40°), así que no se
// confunde ni de reojo; el período más corto (vs. los 4200ms del idle) suma
// una segunda señal — el ritmo — para que también se note distinto al tacto.
const CONNECTING_HUE = 180;

function connecting() {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  const PERIOD = 1400;
  const STEP   = 16;

  _breathe = setInterval(() => {
    t += STEP;
    const phase  = (t % PERIOD) / PERIOD;
    const bright = Math.max(0.05, Math.pow(Math.sin(phase * Math.PI * 2), 2));
    const { r, g, b } = hsvToRgb(CONNECTING_HUE, 1, bright);
    _render(r, g, b);
  }, STEP);
}

// ─── Hablando: transición a ámbar (color de marca), luego pulso rápido ──────
// 0.01 (≈ -40dBFS) era muy sensible — ruido ambiente (ej. impresora 3D
// cerca) lo disparaba como si fuera voz. 0.056 (≈ -25dBFS) es un nivel más
// razonable de "alguien claramente está hablando". Ajustable por env.
let _speakingTimeout = null;
let _isSpeaking      = false;

// SPEAK_THRESHOLD es un ratio lineal (peak/32767) pero se configura en dBFS,
// y comparte la MISMA variable que gatea el log de "hablando" en
// lib/livekit-session.js (MIC_TALK_THRESHOLD_DBFS) — un solo umbral conecta
// el log de consola y el LED, así que mover un slider mueve los dos juntos.
// LED_SPEAK_THRESHOLD (legacy, ratio lineal) sigue soportado como override
// puntual si alguien lo seteó a mano en un deploy viejo.
let SPEAK_THRESHOLD = process.env.LED_SPEAK_THRESHOLD
  ? parseFloat(process.env.LED_SPEAK_THRESHOLD)
  : Math.pow(10, parseFloat(process.env.MIC_TALK_THRESHOLD_DBFS || '-25') / 20);

function setSpeakThresholdDbfs(dbfs) {
  if (typeof dbfs !== 'number' || isNaN(dbfs) || dbfs < -80 || dbfs > 0) return false;
  SPEAK_THRESHOLD = Math.pow(10, dbfs / 20);
  console.log(`[leds] speak threshold → ${dbfs} dBFS (ratio ${SPEAK_THRESHOLD.toFixed(4)})`);
  return true;
}

function getSpeakThresholdDbfs() { return 20 * Math.log10(SPEAK_THRESHOLD); }

function _pulseSpeaking() {
  _stopBreathe();
  let t = 0;
  const PERIOD = 600;
  const STEP   = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const bright = Math.pow(Math.sin(((t % PERIOD) / PERIOD) * Math.PI), 2);
    const { r, g, b } = hsvToRgb(SPEAK_HUE, 1, bright);
    _render(r, g, b);
  }, STEP);
}

// Colchón tras la última muestra de mic por encima del umbral antes de dar
// por terminado el habla — cubre micro-pausas naturales entre palabras
// (antes 300ms, muy corto comparado con pausas típicas de 150-350ms).
const SPEAKING_HANGOVER_MS = 400;

function speaking(level) {
  if (level > SPEAK_THRESHOLD) {
    if (!_isSpeaking) {
      _isSpeaking = true;
      console.log(`[mic] 🎙 hablando (level=${level.toFixed(2)})`);
      if (ws281x) {
        const idleDim = hsvToRgb(IDLE_HUE, 1, 0.25);
        const speak   = hsvToRgb(SPEAK_HUE, 1, 1);
        _fadeTo(idleDim.r, idleDim.g, idleDim.b, speak.r, speak.g, speak.b, 350, _pulseSpeaking);
      }
    }
    if (_speakingTimeout) clearTimeout(_speakingTimeout);
    _speakingTimeout = setTimeout(() => {
      _isSpeaking = false;
      console.log('[mic] — dejo de hablar');
      if (ws281x) {
        const speak = hsvToRgb(SPEAK_HUE, 1, 1);
        _fadeTo(speak.r, speak.g, speak.b, 0, 0, 0, 600, _renderIdle);
      }
    }, SPEAKING_HANGOVER_MS);
  }
}

// ─── Error: respiración roja rápida, vuelve al idle si se pasa durationMs ────
function brumexaError(durationMs) {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  _breathe = setInterval(() => {
    t += 16;
    const bright = Math.pow(Math.sin(((t % 2000) / 2000) * Math.PI), 2.2);
    _render(Math.round(255 * bright), 0, 0);
  }, 16);
  if (durationMs) setTimeout(() => { _fadeTo(255, 0, 0, 0, 0, 0, 600, _renderIdle); }, durationMs);
}

// ─── WiFi señal débil: respiración naranja (mismo patrón que brumexaError) ───
function wifiWeak() {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  _breathe = setInterval(() => {
    t += 16;
    const bright = Math.pow(Math.sin(((t % 2000) / 2000) * Math.PI), 2.2);
    const { r, g, b } = hsvToRgb(30, 1, bright); // naranja
    _render(r, g, b);
  }, 16);
}

// ─── Estado de salud de red — decide qué animación de "idle" mostrar ─────────
// 'ok' (breathe cian/magenta) | 'weak' (naranja) | 'disconnected' (rojo fijo)
let _networkHealth = 'ok';

function _renderIdle() {
  if (_networkHealth === 'disconnected') return brumexaError();
  if (_networkHealth === 'weak')         return wifiWeak();
  return breathe();
}

// Llamado por lib/wifi.js cuando cambia la señal/conexión. Si no está
// hablando ni mostrando un error de sesión puntual, aplica el cambio ya.
function setNetworkHealth(state) {
  if (state !== 'ok' && state !== 'weak' && state !== 'disconnected') return;
  if (_networkHealth === state) return;
  _networkHealth = state;
  if (!_isSpeaking) _renderIdle();
}

function on({ r = 0, g = 0, b = 50 } = {}) {
  if (!ws281x) return;
  _stopBreathe();
  _render(r, g, b);
}

function off() {
  if (!ws281x) return;
  _stopBreathe();
  _render(0, 0, 0);
}

function cleanup() {
  off();
  if (ws281x) ws281x.reset();
}

module.exports = {
  init, on, off, breathe, connecting, brumexaError, wifiWeak, speaking, cleanup,
  setNetworkHealth, setSpeakThresholdDbfs, getSpeakThresholdDbfs,
  getDiagnostics, test,
  idle: (...args) => _renderIdle(...args),
};
