'use strict';

// NeoPixel WS2812 — 8 LEDs en GPIO 10 (SPI MOSI, Physical Pin 19)
// Requiere: npm install rpi-ws281x  (solo en la Pi, correr con sudo)

const NUM_LEDS = 8;
const GPIO_PIN = 10;

let ws281x   = null;
let _breathe = null;

function init() {
  try {
    ws281x = require('rpi-ws281x');
    ws281x.configure({ leds: NUM_LEDS, dma: 10, frequency: 800000, gpio: GPIO_PIN, brightness: 255, stripType: 'grb' });
    console.log(`[leds] NeoPixel listo — ${NUM_LEDS} LEDs en GPIO ${GPIO_PIN}`);
    breathe();
  } catch (e) {
    console.warn('[leds] rpi-ws281x no disponible:', e.message);
    ws281x = null;
  }
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

// ─── Idle: oscila entre cyan y magenta, curva orgánica ───────────────────────
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

    // Hue oscila entre cyan (180) y magenta (300) — muy IA
    const hueShift = (Math.sin(phase * Math.PI * 2) + 1) / 2;  // 0..1
    const hue      = 180 + hueShift * 120;

    const { r, g, b } = hsvToRgb(hue, 1, bright);
    _render(r, g, b);
  }, STEP);
}

// ─── Hablando: transición a verde, luego pulso rápido ────────────────────────
// 0.01 (≈ -40dBFS) era muy sensible — ruido ambiente (ej. impresora 3D
// cerca) lo disparaba como si fuera voz. 0.056 (≈ -25dBFS) es un nivel más
// razonable de "alguien claramente está hablando". Ajustable por env.
let _speakingTimeout = null;
let _isSpeaking      = false;
const SPEAK_THRESHOLD = parseFloat(process.env.LED_SPEAK_THRESHOLD) || 0.056;

function _pulseSpeaking() {
  _stopBreathe();
  let t = 0;
  const PERIOD = 600;
  const STEP   = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const bright = Math.pow(Math.sin(((t % PERIOD) / PERIOD) * Math.PI), 2);
    _render(0, Math.round(255 * bright), 0);
  }, STEP);
}

function speaking(level) {
  if (level > SPEAK_THRESHOLD) {
    if (!_isSpeaking) {
      _isSpeaking = true;
      console.log(`[mic] 🎙 hablando (level=${level.toFixed(2)})`);
      if (ws281x) _fadeTo(0, 0, 60, 0, 255, 0, 350, _pulseSpeaking);
    }
    if (_speakingTimeout) clearTimeout(_speakingTimeout);
    _speakingTimeout = setTimeout(() => {
      _isSpeaking = false;
      console.log('[mic] — dejo de hablar');
      if (ws281x) _fadeTo(0, 255, 0, 0, 0, 0, 600, _renderIdle);
    }, 300);
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
  init, on, off, breathe, brumexaError, wifiWeak, speaking, cleanup,
  setNetworkHealth,
  idle: (...args) => _renderIdle(...args),
};
