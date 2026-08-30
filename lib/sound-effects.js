'use strict';

/**
 * lib/sound-effects.js
 *
 * Reproduce archivos .wav estáticos de sounds/ por ALSA vía `aplay`, mismo
 * patrón que ya usa lib/audio.js para el streaming de /ws/speaker (spawn de
 * aplay, sin bloquear el event loop). A diferencia de ese caso, acá no hay
 * PCM en vivo — se le pasa directo la ruta del .wav como argumento.
 *
 * Pensado para eventos puntuales (ej. "AP de WiFi activado"), no para audio
 * continuo. Si aplay falla o no hay speaker conectado, no debe tirar abajo
 * el proceso — solo loguear.
 */

const { spawn } = require('child_process');
const path      = require('path');

const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');

function playSound(fileName) {
  const device  = process.env.SPEAKER_ALSA_DEVICE || 'plughw:0,0';
  const filePath = path.join(SOUNDS_DIR, fileName);

  try {
    const proc = spawn('aplay', ['-D', device, filePath]);
    proc.on('error', (err) => console.warn(`[sound-effects] aplay no disponible (${fileName}):`, err.message));
    proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.warn(`[sound-effects] aplay stderr (${fileName}):`, m); });
  } catch (e) {
    console.warn(`[sound-effects] no se pudo reproducir ${fileName}:`, e.message);
  }
}

function playApReadySound() {
  playSound('wifi_ap_activado.wav');
}

module.exports = { playSound, playApReadySound };
