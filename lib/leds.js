'use strict';

// NeoPixel WS2812 — 8 LEDs en GPIO 10 (SPI MOSI, Physical Pin 19)
// Requiere: npm install rpi-ws281x  (solo en la Pi, correr con sudo)

const NUM_LEDS = 8;
const GPIO_PIN = 10;

// Colores de marca: indigo Brumexa (mismo --accent #5b6af0 de la UI web) para
// idle, ámbar (complementario del indigo, máximo contraste) para "hablando".
const IDLE_HUE  = 234;
const SPEAK_HUE = 40;

let ws281x   = null;
let _breathe = null;

function init() {
  try {
    ws281x = require('rpi-ws281x');
    ws281x.configure({ leds: NUM_LEDS, dma: 10, frequency: 800000, gpio: GPIO_PIN, brightness: 255, stripType: 'grb' });
    console.log(`[leds] NeoPixel listo — ${NUM_LEDS} LEDs en GPIO ${GPIO_PIN}`);
    booting();  // blanco pulsando: "estoy iniciando" — leds.idle() lo reemplaza cuando el server termina de arrancar
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

// Render directo sin tocar el intervalo activo — recuerda el último color
// renderizado (_lastRGB) para que otras animaciones puedan arrancar un fade
// desde donde quedó la luz, en vez de saltar de golpe a un color fijo.
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

// ─── Idle: respira indigo (color de marca Brumexa), curva orgánica ──────────
// Antes el hue oscilaba entre cyan y magenta ligado a la MISMA fase que el
// brillo — eso hacía que el brillo máximo cayera justo en los extremos
// (cyan/magenta) y el brillo fuera CERO cuando el hue pasaba por el indigo
// (~240°), o sea: el ojo nunca llegaba a ver indigo, solo lo veía apagado.
// Ahora el hue queda fijo en IDLE_HUE y solo el brillo respira, para que se
// lea siempre como el indigo de marca.
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

    const { r, g, b } = hsvToRgb(IDLE_HUE, 1, bright);
    _render(r, g, b);
  }, STEP);
}

// ─── Booting: blanco pulsando rápido — "estoy iniciando" ────────────────────
// Se dispara desde init(), que ahora se llama apenas arranca el proceso (ver
// server.js, antes de levantar el HTTP server), así que esta es la primera
// luz que se ve al correr "npm run brumexa" — sin esperar a que termine todo
// el resto del arranque (wifi, wake word, etc). leds.idle() la reemplaza por
// la respiración normal una vez que el server está listo.
function booting() {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  const PERIOD = 1100;
  _breathe = setInterval(() => {
    t += 16;
    const bright = Math.max(0.05, Math.pow(Math.sin(((t % PERIOD) / PERIOD) * Math.PI), 2));
    const { r, g, b } = hsvToRgb(0, 0, bright); // sat=0 → blanco, solo brillo varía
    _render(r, g, b);
  }, 16);
}

// ─── Conectando a LiveKit: respiración azul ──────────────────────────────────
// Distinta del indigo idle y del blanco de booting — cubre el tramo entre
// "arrancó la sesión" (pedir token + room.connect(), 1-3s típico) y el evento
// 'connected'/'error' de lib/livekit-session.js, que ya disparan idle()/
// brumexaError() y así reemplazan esta animación.
const CONNECTING_HUE = 205;

function connecting() {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  const PERIOD = 1800;
  _breathe = setInterval(() => {
    t += 16;
    const phase  = (t % PERIOD) / PERIOD;
    const bright = Math.max(0.05, Math.pow(Math.sin(phase * Math.PI * 2), 2));
    const { r, g, b } = hsvToRgb(CONNECTING_HUE, 1, bright);
    _render(r, g, b);
  }, 16);
}

// ─── Hablando: respiración ámbar (color de marca) que sigue el nivel real ───
// 0.01 (≈ -40dBFS) era muy sensible — ruido ambiente (ej. impresora 3D
// cerca) lo disparaba como si fuera voz. 0.056 (≈ -25dBFS) es un nivel más
// razonable de "alguien claramente está hablando". Ajustable por env.

// SPEAK_THRESHOLD es un ratio lineal (peak/32767) pero se configura en dBFS,
// y comparte la MISMA variable que gatea el log de "hablando" en
// lib/livekit-session.js (MIC_TALK_THRESHOLD_DBFS) — un solo umbral conecta
// el log de consola y el LED, así que mover un slider mueve los dos juntos.
// LED_SPEAK_THRESHOLD (legacy, ratio lineal) sigue soportado como override
// puntual si alguien lo seteó a mano en un deploy viejo.
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

// ─── Motor de "respiración por nivel" ────────────────────────────────────────
// Sigue el nivel de audio real (mic propio o el del agente) en vez de un
// pulso a tiempo fijo — así hay concordancia real entre lo que se escucha y
// lo que se ve. Ataque rápido (reacciona ya a un pico) + release lento (no
// cae de golpe entre palabras) = un VU meter con memoria, que es lo que lee
// el ojo como "respirar" en vez de "parpadear". LEVEL_FLOOR evita que caiga a
// negro en las micro-pausas mientras sigue "hablando".
const LEVEL_ATTACK_STEP  = 0.35;
const LEVEL_RELEASE_STEP = 0.045;
const LEVEL_FLOOR        = 0.10;

function _startLevelFollow(hue, getLevel) {
  _stopBreathe();
  let smoothed = 0.02;
  _breathe = setInterval(() => {
    const target = Math.max(LEVEL_FLOOR, Math.min(1, getLevel()));
    const rate   = target > smoothed ? LEVEL_ATTACK_STEP : LEVEL_RELEASE_STEP;
    smoothed += (target - smoothed) * rate;
    const { r, g, b } = hsvToRgb(hue, 1, smoothed);
    _render(r, g, b);
  }, 16);
}

// Colchón tras la última muestra por encima del umbral antes de dar por
// terminado el habla — cubre micro-pausas naturales entre palabras (antes
// 300ms, muy corto comparado con pausas típicas de 150-350ms).
const SPEAKING_HANGOVER_MS = 400;

// Fade final al dejar de hablar: largo y a propósito (antes 600ms desde
// brillo máximo) — "no que cuando dejo de hablar se apague la luz rápido".
// Arranca desde _lastRGB (el color/brillo real en ese instante, no siempre
// el máximo), así el apagado se siente continuo con lo que se venía viendo.
const SPEAK_FADE_OUT_MS = 1100;

// Cuántos trackers (mic propio / agente) están "hablando" ahora mismo — lo
// usa setNetworkHealth() para no pisar la animación de habla con un cambio
// de estado de red mientras hay voz activa en cualquiera de las dos fuentes.
let _speakingCount = 0;

// Fábrica: un tracker de habla independiente por fuente (mic propio / agente
// LiveKit), cada uno con su propio estado, pero compartiendo el mismo motor
// de respiración y la misma curva de fade — evita duplicar la lógica dos
// veces para lo que es el mismo comportamiento con distinta fuente de nivel.
function _createSpeechTracker(label, hangoverMs) {
  let isSpeaking = false;
  let timeout    = null;
  let levelLive  = 0;

  return function feed(level) {
    levelLive = level;
    if (level <= SPEAK_THRESHOLD) return;

    if (!isSpeaking) {
      isSpeaking = true;
      _speakingCount++;
      console.log(`[leds] 🎙 ${label} → empezó a hablar (level=${level.toFixed(2)})`);
      if (ws281x) {
        const from = _lastRGB;
        const to   = hsvToRgb(SPEAK_HUE, 1, Math.max(LEVEL_FLOOR, Math.min(1, level)));
        // Transición suave (no un salto directo) desde el color actual hacia
        // el ámbar de "hablando", y desde ahí el motor de nivel toma la posta.
        _fadeTo(from.r, from.g, from.b, to.r, to.g, to.b, 300, () => _startLevelFollow(SPEAK_HUE, () => levelLive));
      }
    }

    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      isSpeaking = false;
      _speakingCount = Math.max(0, _speakingCount - 1);
      console.log(`[leds] — ${label} → dejó de hablar`);
      if (ws281x) {
        const { r, g, b } = _lastRGB;
        _fadeTo(r, g, b, 0, 0, 0, SPEAK_FADE_OUT_MS, _renderIdle);
      }
    }, hangoverMs);
  };
}

const speaking      = _createSpeechTracker('vos',    SPEAKING_HANGOVER_MS);
const agentSpeaking  = _createSpeechTracker('agente', SPEAKING_HANGOVER_MS);

// ─── Wake word escuchada: flash corto blanco antes de conectar ──────────────
// Distinto de speaking() (ámbar) e idle() (indigo) — es la confirmación de
// "te escuché, dame un segundo" mientras se pide el token y se conecta a
// LiveKit (puede tardar 1-2s, y sin este flash el usuario no tiene ninguna
// señal de que la wake word funcionó hasta que arranca la sesión).
function wakeHeard() {
  if (!ws281x) return;
  _stopBreathe();
  _fadeTo(0, 0, 0, 255, 255, 255, 200, () => {
    _fadeTo(255, 255, 255, 0, 0, 0, 200, _renderIdle);
  });
}

// ─── Error: respiración roja rápida, vuelve al idle si se pasa durationMs ────
function brumexaError(durationMs) {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  _breathe = setInterval(() => {
    t += 16;
    const bright = Math.pow(Math.sin(((t % 2000) / 2000) * Math.PI), 2.2);
    _render(Math.round(255 * bright), 0, 0);
  }, 16);
  if (durationMs) setTimeout(() => { _fadeTo(255, 0, 0, 0, 0, 0, 600, _renderIdle); }, durationMs);
}

// ─── WiFi señal débil: respiración naranja (mismo patrón que brumexaError) ───
function wifiWeak() {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  _breathe = setInterval(() => {
    t += 16;
    const bright = Math.pow(Math.sin(((t % 2000) / 2000) * Math.PI), 2.2);
    const { r, g, b } = hsvToRgb(30, 1, bright); // naranja
    _render(r, g, b);
  }, 16);
}

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
  if (_speakingCount === 0) _renderIdle();
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
  init, on, off, breathe, booting, connecting, brumexaError, wifiWeak,
  speaking, agentSpeaking, cleanup, wakeHeard,
  setNetworkHealth, setSpeakThresholdDbfs, getSpeakThresholdDbfs,
  idle: (...args) => _renderIdle(...args),
};
