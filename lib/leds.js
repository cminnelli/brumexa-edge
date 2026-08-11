'use strict';

// NeoPixel WS2812 — 8 LEDs en GPIO 10 (SPI MOSI, Physical Pin 19)
// Requiere: npm install rpi-ws281x  (solo en la Pi, correr con sudo)

const NUM_LEDS = 8;
const GPIO_PIN = 10;

// Colores de marca: indigo Brumexa (mismo --accent #5b6af0 de la UI web) para
// idle, ámbar (complementario del indigo, máximo contraste) para "hablando"
// (vos). Verde para "hablando" del agente — distinto a propósito, así se ve
// a simple vista quién está hablando sin tener que escuchar.
const IDLE_HUE        = 234;
const SPEAK_HUE       = 40;
const AGENT_SPEAK_HUE = 120;
const CONNECTING_HUE  = 180;
const WIFI_WEAK_HUE   = 30;

let ws281x   = null;
let _breathe = null;

// Guardado para /diag/leds — así el panel puede mostrar el motivo exacto por
// el que los LEDs no prenden (ej. "Cannot find module 'rpi-ws281x'") sin
// tener que ir a buscarlo en los logs de PM2/consola.
let _lastError = null;

function init() {
  try {
    ws281x = require('rpi-ws281x');
    ws281x.configure({ leds: NUM_LEDS, dma: 10, frequency: 800000, gpio: GPIO_PIN, brightness: 255, stripType: 'grb' });
    console.log(`[leds] NeoPixel listo — ${NUM_LEDS} LEDs en GPIO ${GPIO_PIN}`);
    _lastError = null;
    breathe();
  } catch (e) {
    console.warn('[leds] rpi-ws281x no disponible:', e.message);
    _lastError = e.message;
    ws281x = null;
  }
}

// ─── Diagnóstico para /diag/leds ─────────────────────────────────────────────
// Distingue "el paquete rpi-ws281x no está instalado" de "está instalado pero
// configure() falló" (ej. sin sudo, GPIO ocupado) — son causas y arreglos
// distintos, y antes esa diferencia solo se veía leyendo el mensaje del catch
// a mano en la consola.
function getDiagnostics() {
  let packageInstalled = false;
  let packageVersion   = null;
  try {
    packageVersion = require('rpi-ws281x/package.json').version;
    packageInstalled = true;
  } catch {}

  return {
    platform:         process.platform,
    packageInstalled,
    packageVersion,
    configured:        !!ws281x,
    lastError:         _lastError,
    numLeds:           NUM_LEDS,
    gpioPin:           GPIO_PIN,
    isRoot:            typeof process.getuid === 'function' ? process.getuid() === 0 : null,
  };
}

// ─── Test visual: verde fijo por unos segundos, inconfundible con cualquier
// otra animación (idle=indigo, hablando=ámbar, error=rojo, conectando=—) ────
function test(durationMs = 2500) {
  if (!ws281x) return false;
  on({ r: 0, g: 255, b: 0 });
  setTimeout(() => _renderIdle(), durationMs);
  return true;
}

// HSV → RGB
function hsvToRgb(h, s, v) {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v,t,p,p,q,v],[q,v,v,t,p,p],[p,p,q,v,v,t]].map(ch => Math.round(ch[i] * 255));
  return { r, g, b };
}

// Render directo sin tocar el intervalo activo — recuerda el último color
// realmente puesto en el hardware (_lastRGB), para que otras animaciones
// puedan arrancar un fundido desde ahí en vez de saltar de golpe.
let _lastRGB = { r: 0, g: 0, b: 0 };

function _render(r, g, b) {
  if (!ws281x) return;
  _lastRGB = { r, g, b };
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

// ─── Motor 1: pulso a tiempo fijo ────────────────────────────────────────────
// breathe/connecting/wifiWeak/brumexaError son cuatro variaciones de la MISMA
// forma: sin²(fase)^exponente, con un piso de brillo opcional y un color fijo
// (o casi — breathe le suma un shimmer sutil). En vez de cuatro setInterval
// copiados y pegados, un solo motor parametrizado — agregar un estado nuevo
// es una llamada de una línea, no un bloque entero.
//
// phaseMult IMPORTA: breathe/connecting usan phase*2π (dos "humps" por
// período), wifiWeak/brumexaError usan phase*π (uno solo) — son ritmos
// distintos a propósito, no un detalle a unificar.
function _startPulse({ periodMs, phaseMult, exponent, floor = 0, shimmer = null, colorFn }) {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const phase = (t % periodMs) / periodMs;
    let bright = Math.pow(Math.sin(phase * Math.PI * phaseMult), exponent);
    if (shimmer) bright += shimmer.amp * Math.sin(phase * Math.PI * shimmer.freq + shimmer.phaseOffset);
    bright = Math.max(floor, Math.min(1, bright));
    const { r, g, b } = colorFn(bright);
    _render(r, g, b);
  }, STEP);
}

// ─── Idle: respira indigo (color de marca Brumexa), curva orgánica ──────────
// Antes el hue oscilaba entre cyan y magenta ligado a la MISMA fase que el
// brillo — eso hacía que el brillo máximo cayera justo en los extremos
// (cyan/magenta) y el brillo fuera CERO cuando el hue pasaba por el indigo
// (~240°), o sea: el ojo nunca llegaba a ver indigo, solo lo veía apagado.
// Ahora el hue queda fijo en IDLE_HUE y solo el brillo respira (+ un shimmer
// sutil que rompe la monotonía), para que se lea siempre como indigo de marca.
function breathe() {
  _startPulse({
    periodMs: 4200, phaseMult: 2, exponent: 2, floor: 0.02,
    shimmer: { amp: 0.07, freq: 10, phaseOffset: 1.2 },
    colorFn: b => hsvToRgb(IDLE_HUE, 1, b),
  });
}

// ─── Conectando: respiración cian, más rápida que el idle ───────────────────
// Genérica a propósito — cualquier "estamos conectando a algo" (hoy LiveKit,
// mañana wifi/bluetooth si hace falta) puede llamar a esta misma función en
// vez de inventar una animación nueva. Cian queda lejos en la rueda de color
// del indigo del idle (234°), el ámbar/verde de "hablando" y el rojo/naranja
// de error, así que no se confunde ni de reojo; el período más corto suma
// una segunda señal — el ritmo — para que también se note distinto al tacto.
function connecting() {
  _startPulse({
    periodMs: 1400, phaseMult: 2, exponent: 2, floor: 0.05,
    colorFn: b => hsvToRgb(CONNECTING_HUE, 1, b),
  });
}

// ─── Error: respiración roja rápida, vuelve al idle si se pasa durationMs ────
// No pasa por hsvToRgb a propósito: con la implementación de hsvToRgb de este
// archivo, hue=0 con saturación 1 da AMARILLO (r=v,g=v,b=0), no rojo — así
// que el rojo se renderiza directo.
function brumexaError(durationMs) {
  _startPulse({
    periodMs: 2000, phaseMult: 1, exponent: 2.2, floor: 0,
    colorFn: b => ({ r: Math.round(255 * b), g: 0, b: 0 }),
  });
  if (durationMs) setTimeout(() => { _fadeTo(255, 0, 0, 0, 0, 0, 600, _renderIdle); }, durationMs);
}

// ─── WiFi señal débil: mismo patrón que brumexaError, en naranja ────────────
function wifiWeak() {
  _startPulse({
    periodMs: 2000, phaseMult: 1, exponent: 2.2, floor: 0,
    colorFn: b => hsvToRgb(WIFI_WEAK_HUE, 1, b),
  });
}

// ─── Motor 2: respiración que sigue el nivel real de audio ──────────────────
// A diferencia del motor 1 (pulso a tiempo fijo), acá el brillo sigue el
// nivel de audio en vivo — con ataque rápido (reacciona ya a un pico) y
// release lento (NO cae de golpe ante un valle pasajero de la voz). Un piso
// de brillo evita que llegue a negro mientras sigue "hablando" (colchón de
// hangover); solo al terminar de verdad hay un apagado gradual, no un corte.
const SPEECH_ATTACK   = 0.35;   // qué tan rápido sube hacia un pico nuevo
const SPEECH_RELEASE  = 0.045;  // qué tan rápido baja — lento = sin caídas abruptas
const SPEECH_FLOOR    = 0.10;   // brillo mínimo mientras sigue "hablando"
const SPEECH_FADE_IN  = 300;    // transición suave al arrancar a hablar
const SPEECH_FADE_OUT = 1100;   // apagado gradual cuando el hangover expira de verdad

// El nivel crudo (peak/32767) es una amplitud lineal, y la voz normal rara
// vez se acerca a 1.0 ahí — suele rondar 0.05-0.3. Como el brillo (HSV
// "value") es lineal, mapear el nivel crudo directo se ve tenue aunque se
// hable fuerte. SPEECH_LEVEL_GAIN amplifica el nivel antes de convertirlo en
// brillo, así el rango típico de una voz normal se ve realmente brillante.
// Si sigue viéndose tenue/débil, subir este número; si satura a brillo
// máximo muy rápido con voz normal, bajarlo.
const SPEECH_LEVEL_GAIN = 4;

function _speechBrightness(level) {
  return Math.max(SPEECH_FLOOR, Math.min(1, level * SPEECH_LEVEL_GAIN));
}

// Colchón tras la última muestra por encima del umbral antes de dar por
// terminado el habla — cubre micro-pausas naturales entre palabras (antes
// 300ms, muy corto comparado con pausas típicas de 150-350ms).
const SPEAKING_HANGOVER_MS = 400;

// SPEAK_THRESHOLD es un ratio lineal (peak/32767) pero se configura en dBFS,
// y comparte la MISMA variable que gatea el log de "hablando" en
// lib/livekit-session.js (MIC_TALK_THRESHOLD_DBFS) — un solo umbral conecta
// el log de consola y el LED, así que mover un slider mueve los dos juntos.
// LED_SPEAK_THRESHOLD (legacy, ratio lineal) sigue soportado como override
// puntual si alguien lo seteó a mano en un deploy viejo. Compartido por las
// dos fuentes (mic propio / agente) — un solo umbral, no uno por instancia.
let SPEAK_THRESHOLD = process.env.LED_SPEAK_THRESHOLD
  ? parseFloat(process.env.LED_SPEAK_THRESHOLD)
  : Math.pow(10, parseFloat(process.env.MIC_TALK_THRESHOLD_DBFS || '-25') / 20);

function setSpeakThresholdDbfs(dbfs) {
  if (typeof dbfs !== 'number' || isNaN(dbfs) || dbfs < -80 || dbfs > 0) return false;
  SPEAK_THRESHOLD = Math.pow(10, dbfs / 20);
  console.log(`[leds] speak threshold → ${dbfs} dBFS (ratio ${SPEAK_THRESHOLD.toFixed(4)})`);
  return true;
}

function getSpeakThresholdDbfs() { return 20 * Math.log10(SPEAK_THRESHOLD); }

// Cuántas fuentes (mic propio / agente) están "hablando" ahora mismo — antes
// era un solo booleano porque solo existía una fuente; ahora dos trackers
// independientes pueden estar activos, así que setNetworkHealth() necesita
// saber si CUALQUIERA de las dos sigue activa antes de pisar la animación.
const _activeSpeakers = new Set();
let _isSpeaking = false;
function _setSpeakingFlag(label, isActive) {
  if (isActive) _activeSpeakers.add(label); else _activeSpeakers.delete(label);
  _isSpeaking = _activeSpeakers.size > 0;
}

// Fábrica: un tracker de habla independiente por fuente (mic propio / agente
// LiveKit), cada uno con su propio color y estado, compartiendo el mismo
// motor de nivel — agregar una tercera fuente el día de mañana es una línea.
function _createSpeechTracker(label, hue, hangoverMs) {
  let active    = false;
  let levelLive = 0;
  let hangover  = null;

  // Bucle de render: sigue levelLive con ataque/release asimétrico. Vive
  // adentro de la fábrica porque necesita "hue" y "levelLive" por closure.
  function loop() {
    if (!ws281x) return;
    _stopBreathe();
    let smoothed = 0.02;
    _breathe = setInterval(() => {
      const target = _speechBrightness(levelLive);
      const rate   = target > smoothed ? SPEECH_ATTACK : SPEECH_RELEASE;
      smoothed += (target - smoothed) * rate;
      const { r, g, b } = hsvToRgb(hue, 1, smoothed);
      _render(r, g, b);
    }, 16);
  }

  return function feed(level) {
    // Se actualiza SIEMPRE, incluso bajo el umbral — así el brillo puede
    // bajar suavemente hacia el piso en un valle real de la voz, en vez de
    // quedar congelado en el último pico (el release lento ya evita que esa
    // bajada sea abrupta; congelar el nivel no hacía falta para eso).
    levelLive = level;
    if (level <= SPEAK_THRESHOLD) return;

    if (!active) {
      active = true;
      _setSpeakingFlag(label, true);
      console.log(`[leds] 🎙 ${label} → empezó a hablar (level=${level.toFixed(2)})`);
      if (ws281x) {
        const from = _lastRGB;
        const to   = hsvToRgb(hue, 1, _speechBrightness(level));
        _fadeTo(from.r, from.g, from.b, to.r, to.g, to.b, SPEECH_FADE_IN, loop);
      }
    }

    if (hangover) clearTimeout(hangover);
    hangover = setTimeout(() => {
      active = false;
      _setSpeakingFlag(label, false);
      console.log(`[leds] — ${label} → dejó de hablar`);
      if (ws281x) {
        const { r, g, b } = _lastRGB;
        _fadeTo(r, g, b, 0, 0, 0, SPEECH_FADE_OUT, _renderIdle);
      }
    }, hangoverMs);
  };
}

const speaking      = _createSpeechTracker('vos',    SPEAK_HUE,       SPEAKING_HANGOVER_MS);
const agentSpeaking  = _createSpeechTracker('agente', AGENT_SPEAK_HUE, SPEAKING_HANGOVER_MS);

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
  init, on, off, breathe, connecting, brumexaError, wifiWeak,
  speaking, agentSpeaking, cleanup,
  setNetworkHealth, setSpeakThresholdDbfs, getSpeakThresholdDbfs,
  getDiagnostics, test,
  idle: (...args) => _renderIdle(...args),
};
