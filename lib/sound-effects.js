'use strict';

/**
 * lib/sound-effects.js
 *
 * Reproduce archivos .wav estáticos de sounds/ por ALSA vía `aplay`, mismo
 * patrón que ya usa lib/audio.js para el streaming de /ws/speaker (spawn de
 * aplay, sin bloquear el event loop). A diferencia de ese caso, acá no hay
 * PCM en vivo — se le pasa directo la ruta del .wav como argumento.
 *
 * Pensado para eventos puntuales de conexión — WiFi (AP de aprovisionamiento
 * activado, o conexión exitosa a la red real) y LiveKit (agente confirmado
 * en la sala) — no para audio continuo. Si aplay falla o no hay speaker
 * conectado, no debe tirar abajo el proceso — solo loguear.
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

// Un mismo chime genérico para "hay WiFi disponible" — se dispara tanto al
// activar el AP de aprovisionamiento como al conectarse con éxito a la red
// real del usuario (ver lib/wifi.js: startAP() y connectToWifi()).
function playWifiConnectedSound() {
  playSound('wifi_conectado.wav');
}

// Distinto del de WiFi a propósito, para que se puedan diferenciar a oído.
// Se dispara cuando el agente de LiveKit confirma presencia en la sala (ver
// lkSession.on('agent-audio', ...) en server.js) — NO con la conexión de la
// sala en sí, que puede resolverse bastante antes de que el agente aparezca.
function playLivekitConnectedSound() {
  playSound('livekit_conectado.wav');
}

module.exports = { playSound, playWifiConnectedSound, playLivekitConnectedSound };
