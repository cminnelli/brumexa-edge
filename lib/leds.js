'use strict';

// NeoPixel WS2812 — 8 LEDs en GPIO 10 (SPI MOSI, Physical Pin 19)
// Requiere: npm install rpi-ws281x  (solo en la Pi, correr con sudo)

const NUM_LEDS = 8;
const GPIO_PIN = 10;

let ws281x   = null;
let _breathe = null;  // interval del efecto respiracion

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

// Respiracion suave tipo humano — seno al cuadrado para curva natural
function breathe({ r = 0, g = 0, b = 60 } = {}) {
  if (!ws281x) return;
  _stopBreathe();

  let t = 0;
  const PERIOD_MS = 4000;  // 4 segundos por ciclo (inspirar + expirar)
  const STEP_MS   = 33;    // ~30fps

  _breathe = setInterval(() => {
    t += STEP_MS;
    const phase      = (t % PERIOD_MS) / PERIOD_MS;          // 0..1
    const brightness = Math.pow(Math.sin(phase * Math.PI), 2); // 0..1, curva suave
    const pixels     = new Uint32Array(NUM_LEDS);
    pixels.fill((Math.round(r * brightness) << 16) | (Math.round(g * brightness) << 8) | Math.round(b * brightness));
    ws281x.render(pixels);
  }, STEP_MS);
}

function _stopBreathe() {
  if (_breathe) { clearInterval(_breathe); _breathe = null; }
}

// color: { r, g, b } en 0-255
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

module.exports = { init, on, off, breathe, cleanup };
