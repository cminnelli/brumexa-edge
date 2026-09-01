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

// Volumen de los 4 chimes de conexión/desconexión (WiFi + LiveKit) — mismo
// patrón que mic gain / speaker gain: ajustable en vivo desde Configuración
// → Sonido (POST /setup/config → notificationVolume), persistido en .env
// (NOTIFICATION_VOLUME), sin reiniciar el proceso. Antes el chime de LiveKit
// seguía el volumen de la VOZ DEL AGENTE (para no sonar desproporcionado);
// con este slider propio ya no hace falta esa aproximación — es su propio
// control, igual que el del agente.
let _notificationGain = parseFloat(process.env.NOTIFICATION_VOLUME) || 1.0;

function setNotificationGain(g) {
  if (typeof g !== 'number' || isNaN(g) || g < 0 || g > 3) return false;
  _notificationGain = g;
  return true;
}

function getNotificationGain() {
  return _notificationGain;
}

function playFileAsIs(filePath, device, label) {
  try {
    console.log(`[sound-effects] spawn aplay -D ${device} ${filePath}`);
    const proc = spawn('aplay', ['-D', device, filePath]);
    proc.on('error', (err) => console.warn(`[sound-effects] aplay no disponible (${label}):`, err.message));
    proc.on('close', (code) => console.log(`[sound-effects] aplay (${label}) cerró — code=${code}`));
    proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.warn(`[sound-effects] aplay stderr (${label}):`, m); });
  } catch (e) {
    console.warn(`[sound-effects] no se pudo reproducir ${label}:`, e.message);
  }
}

function playRawPcm(pcmBuffer, { sampleRate, numChannels }, device, label) {
  try {
    console.log(`[sound-effects] spawn aplay -D ${device} raw ${sampleRate}Hz/${numChannels}ch — ${pcmBuffer.length} bytes`);
    const proc = spawn('aplay', ['-D', device, '-f', 'S16_LE', '-r', String(sampleRate), '-c', String(numChannels), '-t', 'raw', '-']);
    proc.on('error', (err) => console.warn(`[sound-effects] aplay no disponible (${label}):`, err.message));
    proc.on('close', (code) => console.log(`[sound-effects] aplay (${label}) cerró — code=${code}`));
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

// Default = _notificationGain (el slider de Configuración → Sonido), no un
// 1 fijo — así los 4 chimes de conexión/desconexión respetan el volumen
// elegido sin que cada llamada tenga que pasarlo a mano. gain=1 sigue
// siendo el camino simple: aplay reproduce el archivo tal cual, sin leer ni
// parsear nada. Con gain!==1 hay que escalar las muestras a mano ANTES de
// mandarlas a aplay (no tiene una forma simple de bajar/subir volumen de un
// archivo) — se lee el WAV, se multiplica cada sample y se manda el PCM
// crudo resultante por stdin en vez de la ruta del archivo.
function playSound(fileName, { gain = _notificationGain } = {}) {
  console.log(`[sound-effects] playSound(${fileName}) — enabled=${_soundsEnabled} gain=${gain}`);
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

// Se dispara al perder la red real en caliente (transición 'ok' →
// 'disconnected' del monitor de salud, ver lib/wifi.js) — NO al activar el
// AP a propósito (eso ya tiene su propio sonido, playWifiConnectedSound, y
// no es un error).
function playWifiDisconnectedSound() {
  playSound('wifi_desconectado.wav');
}

// El chime de LiveKit NO se reproduce con playSound() como el de WiFi —
// abrir un aplay propio compite por el device ALSA con el aplay persistente
// que lib/livekit-session.js ya tiene abierto para la voz del agente (un
// dispositivo por hardware, ej. plughw:0,0, solo admite un aplay a la vez;
// el que pierde la carrera falla en silencio con "Device or resource
// busy" — así se explica que a veces no se escuche). Por eso acá solo se
// arma el PCM ya escalado; quien llama (server.js) se lo pasa a
// lkSession.playChime(), que lo escribe en ESE MISMO pipe en vez de abrir
// uno nuevo.
//
// `gain` (opcional, default _notificationGain — el slider de Configuración
// → Sonido): antes seguía el speakerGain de la VOZ del agente (para no
// sonar desproporcionado respecto de esa voz), pero ahora que hay un
// control propio de volumen de notificaciones ya no hace falta esa
// aproximación — mismo criterio que playSound() para los otros 3 chimes.
//
// `expectedFormat` ({ sampleRate, channels }, opcional): el formato exacto
// del pipe al que se va a escribir (ver lkSession.getSpeakerFormat()) — si
// el .wav no matchea (alguien lo reemplazó por uno de otro sampleRate/
// canales), sonaría a velocidad/tono incorrecto metido en ese pipe, así que
// se descarta y se loguea en vez de arriesgar eso.
function buildLivekitChimePcm(gain = _notificationGain, expectedFormat = null) {
  if (!_soundsEnabled) return null;

  const fileName = 'livekit_conectado.wav';
  const filePath = path.join(SOUNDS_DIR, fileName);
  try {
    const wav = parseWav(fs.readFileSync(filePath));
    if (!wav || wav.audioFormat !== 1 || wav.bitsPerSample !== 16) {
      console.warn(`[sound-effects] ${fileName} no es PCM16 — no se puede meter en el pipe del agente`);
      return null;
    }
    if (expectedFormat && (wav.sampleRate !== expectedFormat.sampleRate || wav.numChannels !== expectedFormat.channels)) {
      console.warn(`[sound-effects] ${fileName} es ${wav.sampleRate}Hz/${wav.numChannels}ch, pero el pipe del agente espera ${expectedFormat.sampleRate}Hz/${expectedFormat.channels}ch — se omite para no sonar a destiempo`);
      return null;
    }
    return applyGain16(wav.data, gain);
  } catch (e) {
    console.warn(`[sound-effects] no se pudo preparar ${fileName}:`, e.message);
    return null;
  }
}

module.exports = { playSound, playWifiConnectedSound, playWifiDisconnectedSound, buildLivekitChimePcm, setSoundsEnabled, getSoundsEnabled, setNotificationGain, getNotificationGain };
