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
const WIFI_WEAK_HUE   = 30;

// Cian del cometa de "conectando" — deliberadamente distinto del cian que se
// usaba antes en el breathing de connecting() (hue 180): más azulado/turquesa
// para que no se confunda con "otro breathing", ya que ahora la FORMA de la
// animación (cometa vs pulso uniforme) ya lo distingue del idle, pero el tono
// también se corre un poco por las dudas.
const COMET_HUE        = 200;
const COMET_PERIOD_MS  = 900;   // tiempo de punta a punta (LED 0 → LED 7)
const COMET_TAIL_LEN   = 3.5;   // en LEDs — cuánto tarda la cola en desvanecerse detrás de la cabeza
const COMET_EXPONENT   = 1.6;   // >1 = cola se apaga más rápido cerca de la cabeza, se estira suave en la punta

// Blanco no lo usa ningún otro estado (idle=indigo, conectando=cian,
// vos=ámbar, agente=verde, error=rojo, wifi débil=naranja) — así el aviso de
// "estoy por medir el ambiente" no se confunde con nada de la paleta normal.
const CALIBRATION_BLINK_COUNT  = 3;
const CALIBRATION_BLINK_ON_MS  = 220;
const CALIBRATION_BLINK_OFF_MS = 180;
// Cuánto dura el aviso de blinks antes de que server.js arranque a grabar de
// verdad — exportado para que quien orquesta la calibración espere EXACTO
// este tiempo en vez de duplicar el número a mano.
const CALIBRATION_COUNTDOWN_MS = CALIBRATION_BLINK_COUNT * (CALIBRATION_BLINK_ON_MS + CALIBRATION_BLINK_OFF_MS);

// Spinner blanco de "listo" al terminar de calibrar — más lento, con cola
// más larga y caída más suave que el cometa cian de connecting() (que tiene
// que leerse urgente/activo); acá se busca lo opuesto, algo sereno/"angelical".
const CALIBRATION_DONE_PERIOD_MS   = 1400;
const CALIBRATION_DONE_TAIL_LEN    = 5;
const CALIBRATION_DONE_EXPONENT    = 1.2;
const CALIBRATION_DONE_DURATION_MS = 2200;  // ~1.5 pasadas antes de apagarse

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

// Como _render pero con un color distinto por LED — lo necesita el cometa
// (motor 3), a diferencia de los motores 1 y 2 que siempre pintan las 8 LEDs
// igual. _lastRGB queda en el color de la cabeza (colors[0]), así que si algo
// arranca un _fadeTo justo después de un cometa, sale de un color real y no
// de un valor viejo/negro.
function _renderPixels(colors) {
  if (!ws281x) return;
  _lastRGB = colors[0];
  const px = new Uint32Array(NUM_LEDS);
  for (let i = 0; i < NUM_LEDS; i++) {
    const { r, g, b } = colors[i];
    px[i] = (r << 16) | (g << 8) | b;
  }
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
// breathe/wifiWeak/brumexaError son tres variaciones de la MISMA forma:
// sin²(fase)^exponente, con un piso de brillo opcional y un color fijo (o
// casi — breathe le suma un shimmer sutil). En vez de tres setInterval
// copiados y pegados, un solo motor parametrizado — agregar un estado nuevo
// es una llamada de una línea, no un bloque entero. (connecting() usaba este
// motor también, pero ahora usa el Motor 3 — cometa — más abajo.)
//
// phaseMult IMPORTA: breathe usa phase*2π (dos "humps" por período),
// wifiWeak/brumexaError usan phase*π (uno solo) — son ritmos distintos a
// propósito, no un detalle a unificar.
//
// El piso NO recorta la curva (eso genera una meseta plana e "hace pausa"
// en el valle, nada orgánico) — la REMAPEA: la curva base sin²(fase) sigue
// yendo suave de 0 a 1 todo el tiempo, y ese 0..1 se reescala linealmente a
// floor..1 al renderizar. Así el valle se acerca y se aleja del piso con la
// misma curva suave que el resto del ciclo, nunca se aplana.
function _startPulse({ periodMs, phaseMult, exponent, floor = 0, shimmer = null, colorFn }) {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const phase = (t % periodMs) / periodMs;
    let raw = Math.pow(Math.sin(phase * Math.PI * phaseMult), exponent);
    if (shimmer) raw += shimmer.amp * Math.sin(phase * Math.PI * shimmer.freq + shimmer.phaseOffset);
    raw = Math.max(0, Math.min(1, raw));
    const bright = floor + (1 - floor) * raw;
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
// El piso (floor) evita que en el valle de cada ciclo llegue a apagarse del
// todo — la idea es que "respire", nunca que parpadee a negro.
function breathe() {
  _startPulse({
    periodMs: 4200, phaseMult: 2, exponent: 2, floor: 0.15,
    shimmer: { amp: 0.07, freq: 10, phaseOffset: 1.2 },
    colorFn: b => hsvToRgb(IDLE_HUE, 1, b),
  });
}

// ─── Motor 3: cometa — cabeza + cola que se desvanece, rebota en la tira ────
// La tira es RECTA (8 LEDs en línea, no un anillo) y así va a ser siempre —
// por eso el rebote es ping-pong (0→7→0…), nunca wrap-around: en un anillo la
// cabeza podría "dar la vuelta" del LED 7 al 0 sin cortar, pero en una tira
// recta eso significaría un salto imposible de LED 7 a LED 0, así que en los
// extremos se invierte el sentido en vez de wrappear.
// La cola solo se dibuja HACIA ATRÁS del sentido de marcha actual (nunca por
// delante de la cabeza) — así se ve como un cometa que "arrastra" su cola, no
// un brillo simétrico que la rodea de los dos lados.
// colorFn(bright) en vez de un hue fijo con saturación 1 — así el cometa
// puede ser blanco (saturación 0, imposible de expresar como hue+sat) además
// de un color de la paleta normal.
function _startComet({ periodMs, tailLen, exponent, colorFn }) {
  if (!ws281x) return;
  _stopBreathe();
  const STEP = 16;
  let pos = 0;
  let dir = 1;
  const speed = (NUM_LEDS - 1) * STEP / periodMs; // LEDs por tick
  _breathe = setInterval(() => {
    pos += dir * speed;
    if (pos >= NUM_LEDS - 1) { pos = NUM_LEDS - 1; dir = -1; }
    else if (pos <= 0)       { pos = 0;             dir = 1; }

    const colors = new Array(NUM_LEDS);
    for (let i = 0; i < NUM_LEDS; i++) {
      const behind = dir > 0 ? pos - i : i - pos;
      const bright = behind < 0 ? 0 : Math.pow(Math.max(0, 1 - behind / tailLen), exponent);
      colors[i] = colorFn(bright);
    }
    _renderPixels(colors);
  }, STEP);
}

// ─── Conectando: cometa cian recorriendo la tira ────────────────────────────
// Genérica a propósito — cualquier "estamos conectando a algo" (hoy LiveKit,
// mañana wifi/bluetooth si hace falta) puede llamar a esta misma función en
// vez de inventar una animación nueva. La forma (cometa en movimiento) ya la
// distingue a simple vista del breathing uniforme del idle, y el tono
// (COMET_HUE) también se corre del resto de la paleta.
function connecting() {
  _startComet({
    periodMs: COMET_PERIOD_MS, tailLen: COMET_TAIL_LEN, exponent: COMET_EXPONENT,
    colorFn: b => hsvToRgb(COMET_HUE, 1, b),
  });
}

// ─── Calibración de ruido ambiente: aviso + espera en blanco ────────────────
// 3 blinks ("1, 2, 3, ya arranco") y después una respiración blanca suave y
// sostenida mientras server.js graba el tramo de silencio — la respiración
// sigue corriendo indefinidamente hasta que se llama a calibrationDone(),
// server.js no tiene que sincronizar nada más que esperar
// CALIBRATION_COUNTDOWN_MS antes de empezar a grabar.
function calibrating() {
  if (!ws281x) return;
  _stopBreathe();
  let step = 0;
  const totalSteps = CALIBRATION_BLINK_COUNT * 2;
  function blinkStep() {
    if (step >= totalSteps) {
      _startPulse({
        periodMs: 2600, phaseMult: 2, exponent: 2, floor: 0.25,
        colorFn: b => ({ r: Math.round(255 * b), g: Math.round(255 * b), b: Math.round(255 * b) }),
      });
      return;
    }
    const on = step % 2 === 0;
    _render(on ? 255 : 0, on ? 255 : 0, on ? 255 : 0);
    step++;
    setTimeout(blinkStep, on ? CALIBRATION_BLINK_ON_MS : CALIBRATION_BLINK_OFF_MS);
  }
  blinkStep();
}

// Confirmación al terminar de medir. Si salió bien: un spinner blanco suave
// ("angelical" — lento, cola larga, caída sin brusquedad) por un par de
// pasadas y después se apaga solo. Si falló: flash rojo directo, sin
// ambigüedad de que algo no anduvo. En ambos casos vuelve solo al idle normal
// (breathe/wifiWeak/error según corresponda en ese momento).
function calibrationDone(ok = true) {
  if (!ws281x) return;
  if (!ok) {
    const from = _lastRGB;
    _fadeTo(from.r, from.g, from.b, 255, 0, 0, 250, () => {
      setTimeout(() => _fadeTo(255, 0, 0, 0, 0, 0, 400, _renderIdle), 500);
    });
    return;
  }
  _startComet({
    periodMs: CALIBRATION_DONE_PERIOD_MS, tailLen: CALIBRATION_DONE_TAIL_LEN,
    exponent: CALIBRATION_DONE_EXPONENT,
    colorFn: b => { const v = Math.round(255 * b); return { r: v, g: v, b: v }; },
  });
  setTimeout(() => {
    const { r, g, b } = _lastRGB;
    _fadeTo(r, g, b, 0, 0, 0, 500, _renderIdle);
  }, CALIBRATION_DONE_DURATION_MS);
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

// feed() se llama cada ~100ms (STATS_TICK_MS en livekit-session.js, mismo
// ritmo en el monitor idle de server.js) — pedir 2 lecturas seguidas por
// encima del umbral significa exigir ~200ms sostenidos antes de declarar
// "empezó a hablar". Filtra picos de ruido de una sola ventana sin agregar
// latencia perceptible a la voz real (una sílaba dura mucho más que 200ms).
const ONSET_MIN_STREAK = 2;

// El nivel crudo (peak/32767) es una amplitud lineal, y la voz normal rara
// vez se acerca a 1.0 ahí. Como el brillo (HSV "value") es lineal, mapear el
// nivel crudo directo se ve tenue. Cada tracker amplifica con SU PROPIA
// ganancia antes de convertir a brillo — hacen falta dos separadas porque
// las dos fuentes tienen niveles crudos muy distintos por naturaleza: el
// audio del agente (TTS) sale ya cerca del máximo digital, mientras que el
// mic capta una voz humana real a distancia, con mucho más margen/headroom.
// Usar una sola ganancia compartida dejaba al ámbar (vos) siempre más tenue
// que el verde (agente) aunque las dos "sonaran bien" al oído. Si alguna se
// ve tenue/débil, subir su número; si satura a brillo máximo muy rápido,
// bajarlo — se ajustan independientemente sin afectar a la otra fuente.
const MIC_LEVEL_GAIN   = 7;  // para "vos" (speaking) — nivel de mic, naturalmente más flojo
const AGENT_LEVEL_GAIN = 7;  // para "agente" (agentSpeaking) — audio TTS, naturalmente más "caliente"

function _speechBrightness(level, gain) {
  return Math.max(SPEECH_FLOOR, Math.min(1, level * gain));
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
// LiveKit), cada uno con su propio color, ganancia y estado, compartiendo el
// mismo motor de nivel — agregar una tercera fuente el día de mañana es una
// línea (nombre, hue, ganancia, hangover).
function _createSpeechTracker(label, hue, levelGain, hangoverMs) {
  let active      = false;
  let levelLive   = 0;
  let hangover    = null;
  let aboveStreak = 0;  // lecturas consecutivas por encima del umbral

  // Bucle de render: sigue levelLive con ataque/release asimétrico. Vive
  // adentro de la fábrica porque necesita "hue"/"levelGain"/"levelLive" por closure.
  function loop() {
    if (!ws281x) return;
    _stopBreathe();
    let smoothed = 0.02;
    _breathe = setInterval(() => {
      const target = _speechBrightness(levelLive, levelGain);
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
    if (level <= SPEAK_THRESHOLD) { aboveStreak = 0; return; }
    aboveStreak++;

    if (!active) {
      // Exigir ONSET_MIN_STREAK lecturas seguidas por encima del umbral antes
      // de declarar "empezó a hablar" — un pico aislado de ruido (click
      // eléctrico, golpe) cruza el umbral por una sola ventana de ~100ms y
      // se cae solo en la siguiente; la voz real se sostiene mucho más que
      // eso. Sin esto, con el piso de ruido pegado al umbral (gain aplicado
      // antes de comparar), un solo tick alcanzaba para un ciclo completo de
      // "empezó/dejó" — el patrón de falsos positivos en silencio que se veía.
      if (aboveStreak < ONSET_MIN_STREAK) return;
      active = true;
      _setSpeakingFlag(label, true);
      // dBFS acá, no el ratio lineal — mismo idioma que el threshold
      // configurado y que loguea lib/mic-calibration.js. El cálculo interno
      // de brillo sigue en lineal (levelLive/_speechBrightness) porque ahí
      // conviene matemáticamente (gain = multiplicación simple); esto solo
      // cambia lo que se imprime.
      const dbfs = level > 0 ? 20 * Math.log10(level) : -120;
      console.log(`[leds] 🎙 ${label} → empezó a hablar (${dbfs.toFixed(1)}dBFS)`);
      if (ws281x) {
        const from = _lastRGB;
        const to   = hsvToRgb(hue, 1, _speechBrightness(level, levelGain));
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

const speaking      = _createSpeechTracker('vos',    SPEAK_HUE,       MIC_LEVEL_GAIN,   SPEAKING_HANGOVER_MS);
const agentSpeaking  = _createSpeechTracker('agente', AGENT_SPEAK_HUE, AGENT_LEVEL_GAIN, SPEAKING_HANGOVER_MS);

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
  calibrating, calibrationDone, CALIBRATION_COUNTDOWN_MS,
  setNetworkHealth, setSpeakThresholdDbfs, getSpeakThresholdDbfs,
  getDiagnostics, test,
  idle: (...args) => _renderIdle(...args),
};
