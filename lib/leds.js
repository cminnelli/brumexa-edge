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

// Convierte HSV (h: 0-360, s: 0-1, v: 0-1) a { r, g, b } 0-255
function hsvToRgb(h, s, v) {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p, p, q, v],
    [q, v, v, t, p, p],
    [p, p, q, v, v, t],
  ].map(ch => Math.round(ch[i] * 255));
  return { r, g, b };
}

// Respiracion con colores que rotan — cada ciclo cambia de color
function breathe() {
  if (!ws281x) return;
  _stopBreathe();

  let t = 0;
  const PERIOD_MS = 3500;
  const HUE_STEP  = 30;
  const STEP_MS   = 33;
  const startHue  = 200;  // arranca en azul

  _breathe = setInterval(() => {
    t += STEP_MS;
    const cycle      = Math.floor(t / PERIOD_MS);
    const phase      = (t % PERIOD_MS) / PERIOD_MS;
    const brightness = Math.pow(Math.sin(phase * Math.PI), 2.2);
    const { r, g, b } = hsvToRgb((startHue + cycle * HUE_STEP) % 360, 1, brightness);
    const pixels = new Uint32Array(NUM_LEDS);
    pixels.fill((r << 16) | (g << 8) | b);
    ws281x.render(pixels);
  }, STEP_MS);
}

// Sin WiFi o error crítico — respiracion roja
function brumexaError() {
  if (!ws281x) return;
  _stopBreathe();

  let t = 0;
  const PERIOD_MS = 2000;  // más rápido que idle para transmitir urgencia
  const STEP_MS   = 33;

  _breathe = setInterval(() => {
    t += STEP_MS;
    const phase      = (t % PERIOD_MS) / PERIOD_MS;
    const brightness = Math.pow(Math.sin(phase * Math.PI), 2.2);
    const val        = Math.round(255 * brightness);
    const pixels     = new Uint32Array(NUM_LEDS);
    pixels.fill((val << 16) | 0);  // rojo puro
    ws281x.render(pixels);
  }, STEP_MS);
}

// Llamar con level 0-1 (peak del mic) — flash cyan y vuelve a breathe
let _speakingTimeout = null;
function speaking(level) {
  if (!ws281x) return;

  const brightness = Math.min(1, level * 3);
  const val        = Math.round(255 * brightness);
  console.log(`[leds] speaking level=${level.toFixed(2)} brightness=${brightness.toFixed(2)}`);

  // Flash cyan brillante
  _stopBreathe();
  const pixels = new Uint32Array(NUM_LEDS);
  pixels.fill((0 << 16) | (val << 8) | val);
  ws281x.render(pixels);

  // Volver a breathe despues de 3s sin nueva llamada
  if (_speakingTimeout) clearTimeout(_speakingTimeout);
  _speakingTimeout = setTimeout(() => { breathe(); }, 3000);
}

function _stopBreathe() {
  if (_breathe) { clearInterval(_breathe); _breathe = null; }
}

function on({ r = 0, g = 0, b = 50 } = {}) {
  if (!ws281x) return;
  _stopBreathe();
  const pixels = new Uint32Array(NUM_LEDS);
  pixels.fill((r << 16) | (g << 8) | b);
  ws281x.render(pixels);
}

function off() {
  if (!ws281x) return;
  _stopBreathe();
  ws281x.render(new Uint32Array(NUM_LEDS));
}

function cleanup() {
  off();
  if (ws281x) ws281x.reset();
}

module.exports = { init, on, off, breathe, brumexaError, speaking, cleanup };
