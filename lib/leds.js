'use strict';

// NeoPixel WS2812 — 8 LEDs en GPIO 10 (SPI MOSI, Physical Pin 19)
// Requiere: npm install rpi-ws281x  (solo en la Pi, correr con sudo)
// Pin elegido para evitar conflicto con audio PWM (GPIO 18) e I2S (GPIO 21)

const NUM_LEDS = 8;
const GPIO_PIN = 10;

let ws281x = null;

function init() {
  try {
    ws281x = require('rpi-ws281x');
    ws281x.configure({ leds: NUM_LEDS, dma: 10, frequency: 800000, gpio: GPIO_PIN, brightness: 255, stripType: 'ws2812' });
    console.log(`[leds] NeoPixel listo — ${NUM_LEDS} LEDs en GPIO ${GPIO_PIN}`);
  } catch (e) {
    console.warn('[leds] rpi-ws281x no disponible:', e.message);
    ws281x = null;
  }
}

// color: { r, g, b } en 0-255
function on({ r = 0, g = 0, b = 50 } = {}) {
  if (!ws281x) return;
  const pixels = new Uint32Array(NUM_LEDS);
  pixels.fill((r << 16) | (g << 8) | b);
  ws281x.render(pixels);
}

function off() {
  if (!ws281x) return;
  ws281x.render(new Uint32Array(NUM_LEDS));
}

function cleanup() {
  off();
  if (ws281x) ws281x.reset();
}

module.exports = { init, on, off, cleanup };
