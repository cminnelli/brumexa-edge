'use strict';

// Detector de "¿esto es tu voz real o piso de ruido?" — fuente única para
// dos consumidores que antes tenían cada uno su propia copia del umbral:
// el LED de "hablando" (lib/leds.js) y, ahora, el gate que decide qué audio
// se publica de verdad a LiveKit (lib/livekit-session.js, _publishMic). Antes
// esta lógica vivía SOLO en leds.js y nunca tocaba el audio publicado — ver
// el comentario de _publishMic para el porqué de por qué eso era un problema.
//
// feed(level) tiene que llamarse desde UN SOLO productor a la vez, cada
// ~100ms, con el nivel lineal (peak/32767) del MIC real (nunca del agente).
// La orquestación ya lo garantiza: server.js alimenta durante el monitor
// idle (sin sesión) y livekit-session.js durante _publishMic (sesión
// activa) — nunca los dos a la vez. Cualquier otro consumidor (LED) solo
// LEE el estado con isVoiceActive()/getLastLevel(), nunca vuelve a alimentar.

const ONSET_MIN_STREAK = 3; // ~300ms sostenidos por encima del umbral antes de declarar "empezó a hablar" — filtra un click/golpe aislado

let SPEAKING_HANGOVER_MS = process.env.LED_HANGOVER_MS
  ? parseFloat(process.env.LED_HANGOVER_MS)
  : 2000;

function setHangoverMs(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 300 || ms > 8000) return false;
  SPEAKING_HANGOVER_MS = ms;
  return true;
}
function getHangoverMs() { return SPEAKING_HANGOVER_MS; }

// Umbral CALIBRADO — fijo hasta la próxima calibración manual o hasta que
// alguien lo cambie a mano en /configuracion. Comparte la misma env var
// (MIC_TALK_THRESHOLD_DBFS) que antes leía directo livekit-session.js.
let SPEAK_THRESHOLD = process.env.LED_SPEAK_THRESHOLD
  ? parseFloat(process.env.LED_SPEAK_THRESHOLD)
  : Math.pow(10, parseFloat(process.env.MIC_TALK_THRESHOLD_DBFS || '-25') / 20);

function setSpeakThresholdDbfs(dbfs) {
  if (typeof dbfs !== 'number' || isNaN(dbfs) || dbfs < -80 || dbfs > 0) return false;
  SPEAK_THRESHOLD = Math.pow(10, dbfs / 20);
  console.log(`[mic-speech-gate] speak threshold → ${dbfs} dBFS (ratio ${SPEAK_THRESHOLD.toFixed(4)})`);
  return true;
}
function getSpeakThresholdDbfs() { return 20 * Math.log10(SPEAK_THRESHOLD); }
function getSpeakThreshold() { return SPEAK_THRESHOLD; } // ratio lineal — para "agente", que no usa el piso ambiente

// Piso de ruido ambiente EN VIVO — sigue el nivel real del mic con una
// constante de tiempo lenta (~25s, asentado del todo a los 60-75s) para que
// un ruido sostenido nuevo (ej. una impresora 3D arrancando a mitad de
// sesión) termine subiendo el umbral efectivo solo, sin esperar a la
// próxima calibración manual. Se alimenta con TODAS las muestras, hablando
// o no — si solo se alimentara "cuando no está activo", un ambiente ya tan
// ruidoso que dispara falsos positivos todo el tiempo nunca podría
// corregirse solo (justo el caso que hay que resolver).
const AMBIENT_TRACK_RATE = 0.004; // por muestra (~100ms)
const AMBIENT_MARGIN_DB  = 6;     // colchón sobre el piso ambiente — se suma arriba de SPEAK_THRESHOLD, no lo reemplaza
let _micAmbientFloor = 0;

function _updateMicAmbientFloor(level) {
  _micAmbientFloor += (level - _micAmbientFloor) * AMBIENT_TRACK_RATE;
}

function getAmbientFloorDbfs() {
  return _micAmbientFloor > 0 ? 20 * Math.log10(_micAmbientFloor) : null;
}

// Umbral EFECTIVO: nunca por debajo del calibrado (SPEAK_THRESHOLD sigue
// siendo la fuente de verdad principal), pero sube si el ambiente en vivo
// está más ruidoso que cuando se calibró.
function getEffectiveThreshold() {
  const ambientThreshold = _micAmbientFloor * Math.pow(10, AMBIENT_MARGIN_DB / 20);
  return Math.max(SPEAK_THRESHOLD, ambientThreshold);
}
function getEffectiveThresholdDbfs() {
  const t = getEffectiveThreshold();
  return t > 0 ? 20 * Math.log10(t) : -120;
}

let _active        = false;
let _aboveStreak    = 0;
let _hangoverTimer  = null;
let _lastLevel      = 0;

// "Sensing" — aviso visual INSTANTÁNEO (1 sola muestra por encima del
// umbral, sin esperar el streak de ONSET_MIN_STREAK) para que el LED
// reaccione ya, sin tener que bajar el umbral de confirmación real (eso
// reabriría la puerta a que un ruido corto dispare el gate de audio, que es
// justo lo que ONSET_MIN_STREAK evita — ver su comentario arriba). Nunca
// gatea audio ni cuenta como "está hablando" confirmado — es SOLO una señal
// de "algo se está escuchando" para que el LED no se sienta con delay,
// mientras la confirmación real (isVoiceActive(), lo único que abre el gate y
// dispara la animación completa) sigue exigiendo el streak entero. Hangover
// propio y corto: si no llega a confirmarse, se apaga solo enseguida.
const SENSING_HANGOVER_MS = 250;
let _sensing       = false;
let _sensingTimer  = null;

// Onset (streak) + hangover (setTimeout real, no polling) — mismo
// comportamiento que tenía leds.js antes de este módulo. El hangover es un
// timer de verdad (no "se cierra en el próximo feed()") para que, si el
// productor dejara de llamar feed() (ej. arecord se cae), el gate igual
// termine cerrándose solo en vez de quedar pegado "abierto" para siempre.
function feed(level) {
  _lastLevel = level;
  _updateMicAmbientFloor(level);

  const threshold = getEffectiveThreshold();
  if (level <= threshold) {
    _aboveStreak = 0;
    return _active;
  }
  _aboveStreak++;

  _sensing = true;
  if (_sensingTimer) clearTimeout(_sensingTimer);
  _sensingTimer = setTimeout(() => { _sensing = false; }, SENSING_HANGOVER_MS);
  if (_sensingTimer.unref) _sensingTimer.unref();

  if (!_active) {
    if (_aboveStreak < ONSET_MIN_STREAK) return _active;
    _active = true;
  }

  if (_hangoverTimer) clearTimeout(_hangoverTimer);
  _hangoverTimer = setTimeout(() => { _active = false; }, getHangoverMs());
  if (_hangoverTimer.unref) _hangoverTimer.unref();

  return _active;
}

// Nombre elegido a propósito distinto de micGateEnabled (el interruptor
// FIJO de configuración, ver lib/livekit-session.js) — "Enabled" es el
// switch que prendés/apagás a mano; "isVoiceActive" es el estado que sube y
// baja solo, muestra a muestra, según tu voz cruce el umbral o no. Antes
// se llamaba isOpen(), fácil de confundir con micGateEnabled al leer el
// código de corrido.
function isVoiceActive() { return _active; }
function isSensing() { return _sensing; }
function getLastLevel() { return _lastLevel; }

module.exports = {
  feed, isVoiceActive, isSensing, getLastLevel,
  ONSET_MIN_STREAK,
  setSpeakThresholdDbfs, getSpeakThresholdDbfs, getSpeakThreshold,
  setHangoverMs, getHangoverMs,
  getAmbientFloorDbfs, getEffectiveThreshold, getEffectiveThresholdDbfs,
};
