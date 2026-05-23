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
let _speakingTimeout = null;
let _isSpeaking      = false;
const SPEAK_THRESHOLD = 0.01;

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
  if (!ws281x) return;

  if (level > SPEAK_THRESHOLD) {
    if (!_isSpeaking) {
      _isSpeaking = true;
      console.log(`[leds] hablando → transición a pulso verde (level=${level.toFixed(2)})`);
      // Transición 350ms al verde y arranca pulso
      _fadeTo(0, 0, 60, 0, 255, 0, 350, _pulseSpeaking);
    }
    if (_speakingTimeout) clearTimeout(_speakingTimeout);
    _speakingTimeout = setTimeout(() => {
      _isSpeaking = false;
      console.log('[leds] dejo de hablar → fadeout y breathe cyan-magenta');
      // Fadeout a negro en 600ms, luego breathe
      _fadeTo(0, 255, 0, 0, 0, 0, 600, breathe);
    }, 300);
  }
}

// ─── Error: respiración roja rápida ──────────────────────────────────────────
function brumexaError() {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  _breathe = setInterval(() => {
    t += 16;
    const bright = Math.pow(Math.sin(((t % 2000) / 2000) * Math.PI), 2.2);
    _render(Math.round(255 * bright), 0, 0);
  }, 16);
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

module.exports = { init, on, off, breathe, brumexaError, speaking, cleanup };
