'use strict';

/**
 * lib/sound-effects.js
 *
 * Reproduce archivos .wav estáticos de sounds/ por ALSA vía `aplay`, mismo
 * patrón que ya usa lib/audio.js para el streaming de /ws/speaker (spawn de
 * aplay, sin bloquear el event loop).
 *
 * Pensado para eventos puntuales de conexión — WiFi (AP de aprovisionamiento
 * activado, o conexión exitosa a la red real) y LiveKit (agente confirmado
 * en la sala) — no para audio continuo. Si aplay falla o no hay speaker
 * conectado, no debe tirar abajo el proceso — solo loguear.
 */

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');

// Interruptor general — apagable desde Configuración → Sonido → Ajustes
// avanzados (POST /setup/config → notificationSoundsEnabled, mismo patrón
// que MIC_GATE_ENABLED/lkSession.setMicGateEnabled). Solo en memoria acá;
// server.js es quien persiste el valor en .env y llama a setSoundsEnabled()
// tanto al arrancar como en cada cambio en vivo.
let _soundsEnabled = process.env.NOTIFICATION_SOUNDS_ENABLED !== 'false';

function setSoundsEnabled(enabled) {
  _soundsEnabled = !!enabled;
}

function getSoundsEnabled() {
  return _soundsEnabled;
}

function playFileAsIs(filePath, device, label) {
  try {
    const proc = spawn('aplay', ['-D', device, filePath]);
    proc.on('error', (err) => console.warn(`[sound-effects] aplay no disponible (${label}):`, err.message));
    proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.warn(`[sound-effects] aplay stderr (${label}):`, m); });
  } catch (e) {
    console.warn(`[sound-effects] no se pudo reproducir ${label}:`, e.message);
  }
}

function playRawPcm(pcmBuffer, { sampleRate, numChannels }, device, label) {
  try {
    const proc = spawn('aplay', ['-D', device, '-f', 'S16_LE', '-r', String(sampleRate), '-c', String(numChannels), '-t', 'raw', '-']);
    proc.on('error', (err) => console.warn(`[sound-effects] aplay no disponible (${label}):`, err.message));
    proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.warn(`[sound-effects] aplay stderr (${label}):`, m); });
    proc.stdin.on('error', () => {}); // EPIPE si aplay ya cortó — no debe tirar el proceso
    proc.stdin.end(pcmBuffer);
  } catch (e) {
    console.warn(`[sound-effects] no se pudo reproducir ${label}:`, e.message);
  }
}

// Parser WAV mínimo (RIFF/fmt /data) — solo lo necesario para poder escalar
// el volumen a mano antes de mandarlo a aplay. Devuelve null si el archivo
// no es un WAV reconocible (aplay igual lo intenta reproducir tal cual en
// ese caso, ver playSound()).
function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmt = null, data = null;
  while (offset + 8 <= buf.length) {
    const chunkId   = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ' && chunkStart + 16 <= buf.length) {
      fmt = {
        audioFormat:   buf.readUInt16LE(chunkStart),
        numChannels:   buf.readUInt16LE(chunkStart + 2),
        sampleRate:    buf.readUInt32LE(chunkStart + 4),
        bitsPerSample: buf.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      data = buf.subarray(chunkStart, Math.min(chunkStart + chunkSize, buf.length));
    }
    offset = chunkStart + chunkSize + (chunkSize % 2); // los chunks van alineados a 2 bytes
  }
  if (!fmt || !data) return null;
  return { ...fmt, data };
}

// Multiplica cada sample PCM16 por `gain`, con el mismo clip a
// [-32768, 32767] que ya usa this._speakerGain en lib/livekit-session.js.
function applyGain16(data, gain) {
  const out = Buffer.alloc(data.length - (data.length % 2));
  for (let i = 0; i + 1 < data.length; i += 2) {
    let s = data.readInt16LE(i) * gain;
    if (s > 32767)  s = 32767;
    if (s < -32768) s = -32768;
    out.writeInt16LE(Math.round(s), i);
  }
  return out;
}

// gain=1 (default) usa el camino simple: aplay reproduce el archivo tal
// cual, sin leer ni parsear nada. Con gain!==1 hay que escalar las muestras
// a mano ANTES de mandarlas a aplay (no tiene una forma simple de bajar/
// subir volumen de un archivo) — se lee el WAV, se multiplica cada sample y
// se manda el PCM crudo resultante por stdin en vez de la ruta del archivo.
function playSound(fileName, { gain = 1 } = {}) {
  if (!_soundsEnabled) return;

  const device   = process.env.SPEAKER_ALSA_DEVICE || 'plughw:0,0';
  const filePath = path.join(SOUNDS_DIR, fileName);

  if (gain === 1) {
    playFileAsIs(filePath, device, fileName);
    return;
  }

  try {
    const wav = parseWav(fs.readFileSync(filePath));
    if (!wav || wav.audioFormat !== 1 || wav.bitsPerSample !== 16) {
      // Formato no soportado para escalar (ej. alguien reemplazó el .wav por
      // uno de 24 bits o comprimido) — reproducir sin escalar es mejor que
      // no reproducir nada.
      playFileAsIs(filePath, device, fileName);
      return;
    }
    playRawPcm(applyGain16(wav.data, gain), wav, device, fileName);
  } catch (e) {
    console.warn(`[sound-effects] no se pudo aplicar gain a ${fileName}, reproduciendo sin escalar:`, e.message);
    playFileAsIs(filePath, device, fileName);
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
//
// `gain` (opcional, default 1): pensado para que server.js le pase el mismo
// speakerGain que el usuario le puso a la voz del agente (POST
// /session/speaker-gain) — así el chime no suena fuerte si bajaron la voz
// del agente, ni al revés.
function playLivekitConnectedSound(gain) {
  playSound('livekit_conectado.wav', { gain });
}

module.exports = { playSound, playWifiConnectedSound, playLivekitConnectedSound, setSoundsEnabled, getSoundsEnabled };
