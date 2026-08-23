'use strict';

// NeoPixel WS2812 — 8 LEDs en GPIO 10 (SPI MOSI, Physical Pin 19)
// Requiere: npm install rpi-ws281x  (solo en la Pi, correr con sudo)

const NUM_LEDS = 8;
const GPIO_PIN = 10;

// Colores de marca: indigo Brumexa (mismo --accent #5b6af0 de la UI web) para
// idle, ámbar (complementario del indigo, máximo contraste) para "hablando"
// (vos). Verde para "hablando" del agente — distinto a propósito, así se ve
// a simple vista quién está hablando sin tener que escuchar.
//
// Combinación de colores por variante física del dispositivo (color de la
// carcasa Brumexa — se elige en /configuracion, BRUMEXA_COLOR en .env),
// fuente única de verdad en color-schemes.json (roles + hue/sat + swatch
// real para mostrar en el picker del panel). "negro" es la combinación que
// ya está corriendo hoy en el hardware — NO se tocó — y es el default si
// BRUMEXA_COLOR no está seteado en .env, así ningún equipo ya desplegado
// cambia de luces solo por actualizar el código. Las otras 3 variantes
// (purpura/verde/blanco) tienen su propia combinación, pensada para que
// realmente se note el cambio al elegir otro color de carcasa.
//
// "voz" (tu voz) es SIEMPRE ámbar (hue 40) en las 4 variantes — antes en
// purpura/verde tenía un hue cercano al de "respiracion" (250 vs 270, 130 vs
// 150) que con el hsvToRgb de este archivo cae en el MISMO segmento de la
// rueda (mismo patrón r/g/b, solo cambia la proporción) → se veían como el
// mismo color, apenas un matiz distinto, así que costaba distinguir a simple
// vista "está respirando" de "te está escuchando". El ámbar cae en un
// segmento distinto del hue de respiración en las 4 variantes → contraste
// real (no solo numérico) y una identidad de color fija para "tu voz" que no
// cambia aunque cambies el color de la carcasa.
//
// Mutables (let, no const) — setDeviceColor() los cambia en caliente desde
// /configuracion, sin reiniciar el proceso (ver server.js POST /setup/config).
//
// OJO: en "negro", agente (hue 120) da CIAN con el hsvToRgb de este archivo
// (no es la fórmula HSV estándar, ver la función más abajo), no verde como
// dice el comentario de arriba — mismo tono que respiracion (idle). Es un
// mismatch preexistente entre intención y resultado real en la combinación
// ORIGINAL — se dejó tal cual en "negro" (documentado como "Cian" en el
// JSON) porque tocarlo cambiaría cómo se ve hoy un equipo ya andando; las
// otras 3 combinaciones nuevas ya evitan esa colisión a propósito.
const colorSchemes = require('./color-schemes.json');
let DEVICE_COLOR = colorSchemes.colors[process.env.BRUMEXA_COLOR]
  ? process.env.BRUMEXA_COLOR
  : (colorSchemes.defaultColor || 'negro');
let _activeLeds  = colorSchemes.colors[DEVICE_COLOR].leds;
let IDLE_HUE         = _activeLeds.respiracion.hue;
let IDLE_SAT         = _activeLeds.respiracion.sat ?? 1;
let SPEAK_HUE        = _activeLeds.voz.hue;
let SPEAK_SAT        = _activeLeds.voz.sat ?? 1;
let AGENT_SPEAK_HUE  = _activeLeds.agente.hue;
let AGENT_SPEAK_SAT  = _activeLeds.agente.sat ?? 1;

// Aplica un color de carcasa nuevo en caliente. breathe()/wifiWeak()/etc. ya
// leen IDLE_HUE/SAT como variables (no capturadas en closure), así que la
// PRÓXIMA vez que corran van a usar el valor nuevo solo con esto. Los
// trackers de "hablando" (speaking/agentSpeaking, más abajo) son la
// excepción — a esos había que cambiarles cómo leen hue/sat para que
// también reaccionen en caliente (ver _createSpeechTracker).
function setDeviceColor(colorKey) {
  if (!colorSchemes.colors[colorKey]) return false;
  DEVICE_COLOR    = colorKey;
  _activeLeds     = colorSchemes.colors[DEVICE_COLOR].leds;
  IDLE_HUE        = _activeLeds.respiracion.hue;
  IDLE_SAT        = _activeLeds.respiracion.sat ?? 1;
  SPEAK_HUE       = _activeLeds.voz.hue;
  SPEAK_SAT       = _activeLeds.voz.sat ?? 1;
  AGENT_SPEAK_HUE = _activeLeds.agente.hue;
  AGENT_SPEAK_SAT = _activeLeds.agente.sat ?? 1;
  console.log(`[leds] color de carcasa → ${colorKey}`);
  // Si no está hablando/en un error puntual ahora mismo, refrescar ya para
  // que se vea el cambio al toque en vez de esperar el próximo evento.
  if (!_isSpeaking) _renderIdle();
  return true;
}

// Laboratorio de LEDs (/diag/leds/preview-breathe): respira con un hue/sat
// cualquiera, aunque no venga de color-schemes.json — para ver cómo se ve un
// color CUALQUIERA en el patrón normal de respiración, no solo como chispazo
// sólido. Usa _startPulse con los MISMOS parámetros que breathe() pero con
// hsvToRgbStd (la fórmula correcta, no la de color-schemes.json) — así el
// color respira igual que ve el swatch/slider de la web. No toca
// IDLE_HUE/SAT (esos son solo del color de carcasa persistido); salir del
// laboratorio (/diag/leds/set/exit) llama breathe() indirecto vía
// setDeviceColor(), que corta este intervalo y vuelve al normal.
function previewBreathe(h, s) {
  if (!ws281x) return false;
  _startPulse({
    periodMs: 5600, floor: IDLE_FLOOR,
    asymmetric: { riseFraction: 0.42, riseExp: 1.6, fallExp: 1.9 },
    colorFn: b => hsvToRgbStd(h, s, b),
  });
  return true;
}

// Alertas de sistema (wifi débil, error) — no varían con el color de la
// carcasa a propósito: tienen que leerse igual sin importar la variante.
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
    // Piso de ruido ambiente EN VIVO (ver AMBIENT_TRACK_RATE más abajo en
    // el archivo) — para confirmar desde /diag/leds que de verdad está
    // subiendo cuando hay ruido sostenido de fondo (ej. una impresora 3D),
    // sin tener que ir a leer los logs de "hablando" uno por uno.
    micAmbientFloorDbfs: _micAmbientFloor > 0 ? Math.round(20 * Math.log10(_micAmbientFloor) * 10) / 10 : null,
    micEffectiveThresholdDbfs: Math.round(20 * Math.log10(_getMicThreshold()) * 10) / 10,
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

// HSV → RGB — fórmula de libro (la de arriba tiene un mismatch histórico,
// ver el comentario grande al principio del archivo: en vez de r/g/b=v/t/p
// por segmento usa v/q/p, con t y q pisados entre sí). La usa el laboratorio
// de LEDs (/diag/leds/set, previewBreathe) para que el color que elegís
// arrastrando el slider de hue sea EXACTAMENTE el que se prende — con la de
// arriba, mover el slider a "verde" prendía cian. Los 4 combos de
// color-schemes.json siguen usando hsvToRgb (no tocar, ver comentario grande).
function hsvToRgbStd(h, s, v) {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const table = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i];
  return { r: Math.round(table[0] * 255), g: Math.round(table[1] * 255), b: Math.round(table[2] * 255) };
}

// Convierte un hue "de este archivo" (hsvToRgb, la fórmula permutada) al
// hue equivalente en la rueda ESTÁNDAR (hsvToRgbStd) — mismo color exacto,
// otro número. hsvToRgb(h,s,v) === hsvToRgbStd(_toStdHue(h), s, v) siempre.
//
// Por qué hace falta: dentro de cada segmento de 60°, la fórmula de este
// archivo tiene t y q pisados entre sí (ver el comentario grande al
// principio del archivo) — eso equivale a REFLEJAR el hue dentro de su
// propio segmento, no a un simple corrimiento. El resultado es que su rueda
// de 0 a 360 NO es perceptualmente continua: dos hues numéricamente
// cercanos pero en segmentos vecinos pueden dar colores muy distintos (se
// probó interpolando de ámbar a cian: a mitad de camino saltaba de amarillo
// a magenta de un frame a otro, sin pasar por verde/turquesa como se
// esperaría). _fadeHue/_playSpeechOnset necesitan un barrido de color
// REALMENTE continuo, así que interpolan en esta rueda estándar (donde sí
// es continua) y usan esta función solo para convertir los DOS extremos
// conocidos (que sí vienen en espacio de este archivo) antes de arrancar.
function _toStdHue(h) {
  const i = Math.floor(h / 60) % 6;
  return ((i * 120 + 60 - h) % 360 + 360) % 360;
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

// Ease compartida por _fadeTo/_fadeHue/_playSpeechOnset — cubic in-out
// (arranca y frena suave, nunca lineal).
function _easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

// Transicion suave de un color a otro en durationMs, luego llama onDone
function _fadeTo(r1, g1, b1, r2, g2, b2, durationMs, onDone) {
  _stopBreathe();
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const ease = _easeInOut(Math.min(1, t / durationMs));
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

// Como _fadeTo, pero interpola en HUE (rueda de color) en vez de en RGB
// lineal — recorre el camino MÁS CORTO entre fromHue y toHue (nunca más de
// 180°), manteniendo saturación alta todo el trayecto. RGB lineal entre dos
// hues bien separados (ej. cian idle ↔ ámbar voz, la combinación real de
// "negro", el color de carcasa por default) promedia canal por canal y el
// resultado de ese promedio es un gris/blanco desaturado a mitad de camino
// — se ve como un flash blanco en medio del fundido de color, no una
// transición de color real.
//
// Recibe fromHue/fromSat/fromV YA CALCULADOS por quien llama, no un RGB
// para invertir acá adentro — se probó invertir hsvToRgb de este archivo
// (no es la fórmula estándar, es una permutada, ver su comentario) con una
// inversión genérica y rompe justo en los bordes de cada segmento de 60° y
// en saturaciones bajas (color de carcasa "blanco": sat 0.18 en
// respiración) — nada robusto. Cada uso conoce su propio origen exacto sin
// necesidad de adivinar (ver _createSpeechTracker: la salida usa el
// hue/sat/brillo REAL del propio tracker, la entrada usa el hue/sat
// conocido del estado idle actual + el brillo recuperado con
// max(r,g,b)/255, que sí es exacto para cualquier hue/sat en esta fórmula).
//
// OJO — el primer intento interpoló y renderizó con hsvToRgb (la fórmula de
// ESTE archivo) para no tener salto contra breathe()/los trackers. Se probó
// en la Pi y se veía mal igual (saltos raros de color, tipo blanco/azul sin
// sentido) — la causa real: hsvToRgb de este archivo NO es una rueda de
// color perceptualmente continua (ver _toStdHue, arriba, para el detalle:
// dentro de cada segmento de 60° tiene t/q pisados entre sí, lo que
// EQUIVALE a reflejar el hue). Interpolar sus números de hue linealmente no
// da un barrido suave — pasa de amarillo a magenta de un frame a otro sin
// pasar por el verde/turquesa del medio. La fórmula ESTÁNDAR (hsvToRgbStd)
// sí es continua, así que ahora se convierten los DOS extremos a hue
// estándar (_toStdHue) UNA sola vez al arrancar, se interpola y renderiza
// TODO en espacio estándar — los extremos coinciden exacto con lo que
// hubiera dado hsvToRgb (por construcción de _toStdHue), así que no hay
// salto contra breathe()/los trackers, y el camino del medio ahora sí es un
// barrido de color real.
function _fadeHue(fromHue, fromSat, fromV, toHue, toSat, toV, durationMs, onDone) {
  _stopBreathe();
  const fromStd  = _toStdHue(fromHue);
  const toStd    = _toStdHue(toHue);
  const deltaHue = ((toStd - fromStd + 540) % 360) - 180; // camino corto, con signo
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const ease = _easeInOut(Math.min(1, t / durationMs));
    const hue  = (fromStd + deltaHue * ease + 360) % 360;
    const sat  = fromSat + (toSat - fromSat) * ease;
    const v    = fromV + (toV - fromV) * ease;
    const { r, g, b } = hsvToRgbStd(hue, sat, v);
    _render(r, g, b);
    if (t >= durationMs) {
      clearInterval(_breathe);
      _breathe = null;
      if (onDone) onDone();
    }
  }, STEP);
}

// ─── Efecto de entrada al empezar a hablar: "escalerita" en los 8 LEDs ──────
// En vez de un fundido parejo (las 8 LEDs cambiando de color a la vez), cada
// LED arranca su propio fundido de hue (misma idea que _fadeHue: interpola
// en la rueda de color, nunca pasa por blanco) con un pequeño delay
// creciente respecto del anterior — LED 0 primero, LED 7 al final — así se
// ve como una ola/escalerita que recorre la tira una sola vez marcando "ya
// empezaste a hablar", en vez de un cambio de golpe parejo. Es de una sola
// pasada (no ping-pong, no se repite) así que no aplica la regla de
// rebote de los motores de cometa (esa es para animaciones que SIGUEN
// corriendo en una tira recta) — acá cada LED simplemente llega a destino y
// se queda ahí, quieto, hasta que loop() toma el control.
// Subidos (22→28ms, 220→340ms) para que se sienta más suave/lenta — igual
// que _fadeHue, interpola/renderiza en la rueda ESTÁNDAR (_toStdHue +
// hsvToRgbStd), no con la fórmula permutada de este archivo (ver el
// comentario grande de _fadeHue de por qué esa no da un barrido continuo).
const SPEECH_ONSET_STAGGER_MS = 28;  // delay entre el arranque de un LED y el siguiente
const SPEECH_ONSET_RISE_MS    = 340; // cuánto tarda CADA LED en llegar a destino una vez que le toca

function _playSpeechOnset(fromHue, fromSat, fromV, toHue, toSat, toV, onDone) {
  if (!ws281x) { if (onDone) onDone(); return; }
  _stopBreathe();
  const fromStd   = _toStdHue(fromHue);
  const toStd     = _toStdHue(toHue);
  const deltaHue  = ((toStd - fromStd + 540) % 360) - 180;
  const totalMs   = SPEECH_ONSET_STAGGER_MS * (NUM_LEDS - 1) + SPEECH_ONSET_RISE_MS;
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const colors = new Array(NUM_LEDS);
    for (let i = 0; i < NUM_LEDS; i++) {
      const localP = Math.max(0, Math.min(1, (t - i * SPEECH_ONSET_STAGGER_MS) / SPEECH_ONSET_RISE_MS));
      const eased  = localP * localP * (3 - 2 * localP); // smoothstep — mismo criterio que el tween de habla
      const hue    = (fromStd + deltaHue * eased + 360) % 360;
      const sat    = fromSat + (toSat - fromSat) * eased;
      const v      = fromV + (toV - fromV) * eased;
      colors[i] = hsvToRgbStd(hue, sat, v);
    }
    _renderPixels(colors);
    if (t >= totalMs) {
      clearInterval(_breathe);
      _breathe = null;
      if (onDone) onDone();
    }
  }, STEP);
}

// ─── Motor 1: pulso a tiempo fijo ────────────────────────────────────────────
// breathe/wifiWeak/brumexaError son variaciones de la MISMA forma, con un
// piso de brillo opcional y un color fijo. En vez de varios setInterval
// copiados y pegados, un solo motor parametrizado — agregar un estado nuevo
// es una llamada de una línea, no un bloque entero. (connecting() usaba este
// motor también, pero ahora usa el Motor 3 — cometa — más abajo.)
//
// Dos formas de curva posibles:
//   - sin(fase·π·phaseMult)^exponent — simétrica, subida y bajada iguales.
//     La usan wifiWeak/brumexaError (phaseMult:1) — para una alerta no hace
//     falta que se "sienta" como una respiración real, solo un pulso parejo.
//   - asymmetric (ver _asymmetricPulse) — inhalar y exhalar con formas y
//     duraciones DISTINTAS, como una respiración real. La usa breathe(), ver
//     el comentario ahí de por qué la simétrica no alcanzaba.
//
// El piso NO recorta la curva (eso genera una meseta plana e "hace pausa"
// en el valle, nada orgánico) — la REMAPEA: la curva base sigue yendo suave
// de 0 a 1 todo el tiempo, y ese 0..1 se reescala linealmente a floor..1 al
// renderizar. Así el valle se acerca y se aleja del piso con la misma curva
// suave que el resto del ciclo, nunca se aplana.
function _asymmetricPulse(phase, { riseFraction, riseExp, fallExp }) {
  if (phase < riseFraction) {
    // Inhalar: cuarto de seno, 0→1 — arranca con más impulso y se
    // desacelera llegando arriba (round top, sin pico filoso).
    // p se clampea a [0,1]: por redondeo de punto flotante puede colarse
    // apenas afuera de ese rango, y Math.pow de un coseno/seno NEGATIVO con
    // un exponente no entero (riseExp/fallExp) da NaN en JS — un solo tick
    // así deja el LED en un color inválido hasta el próximo ciclo.
    const p = Math.min(1, phase / riseFraction);
    return Math.pow(Math.sin(p * Math.PI / 2), riseExp);
  }
  // Exhalar: cuarto de coseno, 1→0 — sale del pico con pendiente CERO (un
  // desprendimiento suave, no una caída de golpe apenas termina de inhalar)
  // y gana velocidad hacia el final, como el aire que se termina de soltar.
  const p = Math.min(1, (phase - riseFraction) / (1 - riseFraction));
  return Math.pow(Math.cos(p * Math.PI / 2), fallExp);
}

function _startPulse({ periodMs, phaseMult, exponent, floor = 0, shimmer = null, asymmetric = null, colorFn }) {
  if (!ws281x) return;
  _stopBreathe();
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const phase = (t % periodMs) / periodMs;
    let raw = asymmetric
      ? _asymmetricPulse(phase, asymmetric)
      : Math.pow(Math.sin(phase * Math.PI * phaseMult), exponent);
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
// Ahora el hue queda fijo en IDLE_HUE y solo el brillo respira, para que se
// lea siempre como indigo de marca.
//
// Curva ASIMÉTRICA (_asymmetricPulse), no sin²(fase) simétrica — una
// respiración real no sube y baja igual: inhalar es más corto/parejo,
// exhalar es más largo y sale del pico sin corte. Con sin²(fase·2π) (dos
// "humps" simétricos por período) el ciclo completo quedaba en ~2.1s
// (periodMs 4200 / 2 humps) — bastante más rápido que una respiración en
// reposo real (~4-6s por ciclo) y, al ser perfectamente simétrica, subir y
// bajar se sentían como el mismo movimiento espejado — entre eso y el
// shimmer superpuesto (pensado para "romper la monotonía" pero en la
// práctica agregaba una vibración de alta frecuencia sobre la curva
// principal) el conjunto se sentía más "mecánico/duro" que orgánico. Se
// sacó el shimmer — la asimetría real ya rompe la monotonía sin ensuciar la
// curva — y se bajó el ritmo a un ciclo completo por período (periodMs
// 5600, ~10-11 respiraciones/min, ritmo de reposo real).
//
// riseFraction 0.42: inhalar dura un poco menos que exhalar (42%/58% del
// ciclo) — como una respiración relajada real, nunca 50/50. riseExp/fallExp
// > 1 redondean el pico y el valle (nunca hay una punta filosa arriba ni
// abajo) sin necesitar una meseta plana. Punto de partida para afinar de
// oído/vista en el hardware real.
//
// Piso de brillo de la respiración — extraído a constante porque
// _idleLandingColor() (más abajo) necesita el mismo valor para que el fade
// de "dejó de hablar" aterrice EXACTO donde breathe() arranca su ciclo, sin
// salto en el handoff.
const IDLE_FLOOR = 0.15;

function breathe() {
  _startPulse({
    periodMs: 5600, floor: IDLE_FLOOR,
    asymmetric: { riseFraction: 0.42, riseExp: 1.6, fallExp: 1.9 },
    colorFn: b => hsvToRgb(IDLE_HUE, IDLE_SAT, b),
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
      setTimeout(() => {
        const landing = _idleLandingColor();
        _fadeTo(255, 0, 0, landing.r, landing.g, landing.b, 400, _renderIdle);
      }, 500);
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
    const landing = _idleLandingColor();
    _fadeTo(r, g, b, landing.r, landing.g, landing.b, 500, _renderIdle);
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
  if (durationMs) setTimeout(() => {
    const landing = _idleLandingColor();
    _fadeTo(255, 0, 0, landing.r, landing.g, landing.b, 600, _renderIdle);
  }, durationMs);
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
// Duración del tween hacia CADA muestra nueva de audio (llegan cada ~100ms,
// ver comentario de ONSET_MIN_STREAK más abajo) — no una tasa por tick como
// antes. Subir (pico real) usa una duración corta y pareja al ritmo real de
// las muestras → se siente inmediato/sensible. Bajar usa una duración mucho
// más larga → una micro-pausa entre sílabas no se ve como un apagón, cae
// como un fade suave. Ver _pushTarget más abajo.
const SPEECH_TWEEN_ATTACK_MS  = 90;
const SPEECH_TWEEN_RELEASE_MS = 550;
const SPEECH_FLOOR    = 0.10;   // brillo mínimo mientras sigue "hablando"
// La entrada usa _playSpeechOnset (ola de 8 LEDs, ver SPEECH_ONSET_* más
// abajo) en vez de una duración fija acá — cada LED tiene su propio timing.
const SPEECH_FADE_OUT = 1100;   // apagado gradual cuando el hangover expira de verdad

// feed() se llama cada ~100ms (STATS_TICK_MS en livekit-session.js, mismo
// ritmo en el monitor idle de server.js) — pedir 3 lecturas seguidas por
// encima del umbral significa exigir ~300ms sostenidos antes de declarar
// "empezó a hablar". Filtra picos de ruido de una sola ventana sin agregar
// latencia perceptible a la voz real (una sílaba dura mucho más que 300ms).
// Subido de 2 a 3: con el margen real entre piso y threshold bastante
// finito (unos pocos dB), un ruido corto de ~200ms ya alcanzaba a colarse.
const ONSET_MIN_STREAK = 3;

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
// Subido de 7 a 14: con el mic/threshold reales (voz apenas ~2-3dB arriba
// del threshold en el ambiente medido), el pico de la sílaba más fuerte
// llegaba a brillo máximo, pero el resto de la sílaba/frase (el promedio,
// no el pico) se quedaba bastante más abajo — se veía "tenue" en general
// aunque hablaras fuerte. Con 14, el rango típico de una voz ya reconocida
// como "hablando" llega a brillo pleno más seguido, sin afectar en nada la
// detección (SPEAK_THRESHOLD) ni el audio real que recibe el agente — este
// gain es puramente visual, solo entra en juego una vez que ya se cruzó el
// threshold.
const MIC_LEVEL_GAIN   = 14; // para "vos" (speaking) — nivel de mic, naturalmente más flojo
const AGENT_LEVEL_GAIN = 7;  // para "agente" (agentSpeaking) — audio TTS, naturalmente más "caliente"

// Exponente aplicado DESPUÉS de la ganancia — separa más los picos fuertes de
// los tramos flojos de una misma frase. Sin esto, con una ganancia alta
// (necesaria para que la voz no se vea tenue, ver comentario de
// MIC_LEVEL_GAIN arriba) casi cualquier sílaba ya llegaba a brillo cercano al
// máximo, y la diferencia entre "fuerte" y "suave" se perdía — se veía
// bastante parejo en vez de tener variación real entre altos y bajos. >1
// empuja los valores medios/bajos más hacia abajo que los altos (que ya
// están cerca de 1 y casi no se mueven), así que los picos siguen brillando
// a fondo pero el resto de la frase se distingue más. Punto de partida para
// afinar de oído en el hardware real: si se ve muy apagado, bajar hacia 1.2;
// si sigue muy parejo, subir hacia 1.8.
const SPEECH_CURVE = 1.4;

// Igual que el piso del motor 1 (breathe, ver ese comentario más abajo): NO
// se recorta con un max() plano — eso deja el valor pisado sin curva real
// cerca del silencio, "hace pausa" en vez de seguir variando. Se REMAPEA el
// 0..1 ya curveado hacia floor..1, así el brillo sigue moviéndose suave hasta
// el mínimo en vez de pegarse en una meseta.
function _speechBrightness(level, gain) {
  const raw    = Math.max(0, Math.min(1, level * gain));
  const curved = Math.pow(raw, SPEECH_CURVE);
  return SPEECH_FLOOR + (1 - SPEECH_FLOOR) * curved;
}

// Colchón tras la última muestra por encima del umbral antes de dar por
// terminado el habla — cubre PAUSAS reales al pensar, no solo micro-pausas
// entre palabras. Subido de 400ms a 2000ms: alguien haciendo una pausa de
// 1-1.5s para pensar y seguir la misma idea (uso normal, no un corte real)
// hacía que el LED diera por terminado el habla, se apagara, y tuviera que
// volver a arrancar la ola de entrada — un vaivén que se sentía picado en
// vez de acompañar una conversación real. 2s es más que cualquier pausa
// típica al pensar, sin llegar a sentirse "pegado" (el corte automático de
// SESIÓN por silencio, en livekit-session.js, es un timeout total aparte y
// mucho más largo — 10s por default — esto NO lo toca).
const SPEAKING_HANGOVER_MS = 2000;

// SPEAK_THRESHOLD es un ratio lineal (peak/32767) pero se configura en dBFS,
// y comparte la MISMA variable que gatea el log de "hablando" en
// lib/livekit-session.js (MIC_TALK_THRESHOLD_DBFS) — un solo umbral conecta
// el log de consola y el LED, así que mover un slider mueve los dos juntos.
// LED_SPEAK_THRESHOLD (legacy, ratio lineal) sigue soportado como override
// puntual si alguien lo seteó a mano en un deploy viejo. Es el umbral
// CALIBRADO/de base — lo sigue usando el agente tal cual (su audio no tiene
// ruido de sala), y para "vos" es el PISO mínimo del umbral efectivo en
// vivo (ver _getMicThreshold, más abajo) — nunca baja de acá, pero sí puede
// subir por encima si el ambiente real está más ruidoso que al calibrar.
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

// ─── Piso de ruido AMBIENTE en vivo (solo para "vos" — el agente no tiene
// ruido de sala) ──────────────────────────────────────────────────────────
// SPEAK_THRESHOLD es el umbral CALIBRADO — fijo hasta la próxima
// calibración manual o hasta que alguien lo cambie a mano en /configuracion.
// Sirve de piso mínimo, pero un ambiente real puede cambiar A MITAD DE
// SESIÓN de un modo que la calibración no vio (ej. una impresora 3D que
// arranca) — ahí el umbral calibrado queda pegado al ruido de fondo viejo y
// el LED dispara "hablando" con cada zumbido de motor, sin que nadie diga
// una palabra.
//
// _micAmbientFloor sigue el nivel REAL del mic (level, no solo lo que
// supera el umbral) con una constante de tiempo MUY lenta — ~25s (63% del
// camino recorrido a los 25s, prácticamente asentado a los 60-75s) — así
// que una frase o una pausa normal (segundos, no minutos) casi no lo
// mueve, pero un ruido sostenido nuevo (la impresora corriendo, no un pico
// de golpe y ya) sí lo termina absorbiendo en menos de un par de minutos,
// en vez de quedar rota hasta la próxima recalibración manual.
//
// A propósito se alimenta con TODAS las muestras, hablando o no — filtrar
// "solo si no está activo ahora" suena más prolijo, pero si el ruido de
// fondo YA es tan fuerte que dispara falsos "hablando" todo el tiempo,
// "activo" casi nunca sería false y el piso nunca podría subir a
// corregirlo — justo el caso que hay que arreglar. El costo es que hablar
// SIN PARAR más de un rato largo también arrastra el piso un poco hacia
// arriba — se autocorrige solo en la próxima pausa (uno no habla 24/7).
const AMBIENT_TRACK_RATE = 0.004; // por muestra (~100ms) → constante de tiempo ~25s (asentado del todo a los 60-75s)
const AMBIENT_MARGIN_DB  = 6;     // colchón sobre el piso ambiente EN VIVO — se suma arriba de SPEAK_THRESHOLD, no lo reemplaza (ver _getMicThreshold)
let _micAmbientFloor = 0; // ratio lineal — arranca en 0, sube solo con muestras reales

function _updateMicAmbientFloor(level) {
  _micAmbientFloor += (level - _micAmbientFloor) * AMBIENT_TRACK_RATE;
}

// Umbral EFECTIVO para "vos": nunca por debajo de SPEAK_THRESHOLD (recalibrar
// o mover el slider de sensibilidad en /configuracion sigue siendo la
// fuente de verdad principal), pero puede subir por encima si el ambiente
// en vivo está más ruidoso que cuando se calibró.
function _getMicThreshold() {
  const ambientThreshold = _micAmbientFloor * Math.pow(10, AMBIENT_MARGIN_DB / 20);
  return Math.max(SPEAK_THRESHOLD, ambientThreshold);
}

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

// Nombre lindo para el log — "vos"/"agente" siguen siendo el label interno
// (_setSpeakingFlag, _activeSpeakers), esto es solo lo que se imprime.
const _DISPLAY_NAME = { vos: 'Usuario', agente: 'Agente' };

// Fábrica: un tracker de habla independiente por fuente (mic propio / agente
// LiveKit), cada uno con su propio color, ganancia y estado, compartiendo el
// mismo motor de nivel — agregar una tercera fuente el día de mañana es una
// línea (nombre, hue, ganancia, hangover).
// getHue/getSat son funciones (no valores fijos) — así, si setDeviceColor()
// cambia SPEAK_HUE/AGENT_SPEAK_HUE después de que este tracker ya se creó
// (se crean una sola vez, más abajo), el próximo tick igual lee el hue
// actualizado en vez de quedarse pegado al que tenía en el momento de crearse.
// getThreshold: función que devuelve el umbral EFECTIVO a usar ahora mismo
// (ratio lineal) — el agente pasa () => SPEAK_THRESHOLD tal cual (sin ruido
// de sala); "vos" pasa _getMicThreshold (ver arriba), que se adapta al
// ambiente en vivo. onLevel (opcional): se llama con CADA muestra cruda,
// hablando o no — "vos" lo usa para alimentar _micAmbientFloor; el agente
// no lo necesita.
function _createSpeechTracker(label, getHue, getSat, levelGain, hangoverMs, getThreshold, onLevel) {
  const displayName = _DISPLAY_NAME[label] || label;
  let active      = false;
  let hangover    = null;
  let aboveStreak = 0;  // lecturas consecutivas por encima del umbral

  // Estado del tween de brillo — interpola en el TIEMPO entre la última
  // muestra real de audio y la nueva, en vez de perseguirla con una
  // exponencial. Con una exponencial, el "nivel objetivo" solo cambia cada
  // ~100ms (el ritmo real de las muestras del mic/agente) pero la curva
  // corre en cada tick de 16ms — alcanzaba el objetivo bastante antes de que
  // llegara la próxima muestra y se quedaba plantada ahí, un salto seguido
  // de una mesetita quieta en vez de movimiento continuo (lo que se sentía
  // "duro"). Acá en cambio SIEMPRE se interpola desde donde el LED está en
  // este instante hacia el nuevo valor real, con una curva suave (smoothstep
  // — ease-in-out, arranca y frena sin golpe) — nunca hay un tramo quieto,
  // siempre está en movimiento, como una animación real.
  let tweenFrom  = SPEECH_FLOOR;
  let tweenTo    = SPEECH_FLOOR;
  let tweenStart = 0;
  let tweenDur   = 1;

  function _tweenValue(now) {
    const p = tweenDur > 0 ? Math.min(1, (now - tweenStart) / tweenDur) : 1;
    const eased = p * p * (3 - 2 * p); // smoothstep
    return tweenFrom + (tweenTo - tweenFrom) * eased;
  }

  // Arranca un tween nuevo desde donde el LED YA está (nunca desde el último
  // objetivo "de libro") hacia el nivel real de esta muestra — así nunca hay
  // un salto, solo un cambio de rumbo suave. La duración distinta según sube
  // o baja reproduce el viejo ataque rápido/release lento, pero como tiempo
  // de tween en vez de tasa por tick (ver comentario de las constantes).
  function _pushTarget(level) {
    const now    = Date.now();
    const target = _speechBrightness(level, levelGain);
    const from   = _tweenValue(now);
    tweenFrom  = from;
    tweenTo    = target;
    tweenStart = now;
    tweenDur   = target >= from ? SPEECH_TWEEN_ATTACK_MS : SPEECH_TWEEN_RELEASE_MS;
  }

  // Bucle de render: solo dibuja _tweenValue(now) a 16ms — toda la lógica de
  // "hacia dónde ir" vive en _pushTarget, que se llama desde feed().
  //
  // startBrightness arranca desde donde el _fadeTo de feed() ya dejó el LED,
  // no de un valor bajo fijo — si arrancara siempre desde abajo, el primer
  // frame de este loop pisaría el brillo real recién logrado por el fade y
  // se vería un parpadeo hacia el piso antes de volver a subir. Arranca
  // "plano" (tweenDur=1, de==a) hasta que el próximo feed() real lo mueva.
  function loop(startBrightness) {
    if (!ws281x) return;
    _stopBreathe();
    tweenFrom  = startBrightness;
    tweenTo    = startBrightness;
    tweenStart = Date.now();
    tweenDur   = 1;
    _breathe = setInterval(() => {
      const bright = _tweenValue(Date.now());
      const { r, g, b } = hsvToRgb(getHue(), getSat(), bright);
      _render(r, g, b);
    }, 16);
  }

  return function feed(level) {
    // Mientras ya está "hablando", cada muestra (incluso bajo el umbral)
    // empuja un tween nuevo — así el brillo también baja suave hacia el piso
    // en un valle real de la voz, en vez de quedar congelado en el último
    // pico. La primerísima muestra que dispara la activación NO pasa por acá
    // (active todavía es false en ese momento) — esa arranca su propio tween
    // vía loop(startBrightness) más abajo, para no pisar el fade-in.
    if (active) _pushTarget(level);
    if (onLevel) onLevel(level);

    const threshold = getThreshold();
    if (level <= threshold) { aboveStreak = 0; return; }
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
      // de brillo sigue en lineal (_speechBrightness) porque ahí conviene
      // matemáticamente (gain = multiplicación simple); esto solo cambia lo
      // que se imprime. Threshold Y level juntos en la misma línea
      // — así se ve de un vistazo POR QUÉ se disparó el LED, sin tener que
      // ir a buscar el threshold configurado a otro lado. Se loguea el
      // umbral EFECTIVO (threshold, ya resuelto arriba) y no
      // getSpeakThresholdDbfs() — para "vos" pueden diferir si el piso
      // ambiente en vivo subió por encima del calibrado (ver
      // _getMicThreshold); loguear el calibrado ahí mentiría sobre qué
      // umbral se usó de verdad para esta detección.
      const dbfs = level > 0 ? 20 * Math.log10(level) : -120;
      const thresholdDbfs = threshold > 0 ? 20 * Math.log10(threshold) : -120;
      console.log(`[leds] 🎙 ${displayName} hablando — threshold=${thresholdDbfs.toFixed(1)}dBFS / level=${dbfs.toFixed(1)}dBFS`);
      if (ws281x) {
        const startBrightness = _speechBrightness(level, levelGain);
        const from = _currentIdleHueSat();
        const fromV = Math.max(_lastRGB.r, _lastRGB.g, _lastRGB.b) / 255;
        _playSpeechOnset(from.h, from.s, fromV, getHue(), getSat(), startBrightness, () => loop(startBrightness));
      }
    }

    if (hangover) clearTimeout(hangover);
    hangover = setTimeout(() => {
      active = false;
      _setSpeakingFlag(label, false);
      console.log(`[leds] 🔇 ${displayName} dejó de hablar`);
      if (ws281x) {
        // Origen EXACTO, no aproximado — este tracker ya sabe su propio
        // hue/sat, y _tweenValue(now) da el brillo real en el que está la
        // tira en este instante (sin invertir nada).
        const landing = _idleLandingHueSat();
        _fadeHue(getHue(), getSat(), _tweenValue(Date.now()), landing.h, landing.s, landing.v, SPEECH_FADE_OUT, _renderIdle);
      }
    }, hangoverMs);
  };
}

const speaking      = _createSpeechTracker('vos',    () => SPEAK_HUE,       () => SPEAK_SAT,       MIC_LEVEL_GAIN,   SPEAKING_HANGOVER_MS, _getMicThreshold,       _updateMicAmbientFloor);
const agentSpeaking  = _createSpeechTracker('agente', () => AGENT_SPEAK_HUE, () => AGENT_SPEAK_SAT, AGENT_LEVEL_GAIN, SPEAKING_HANGOVER_MS, () => SPEAK_THRESHOLD, null);

// ─── Estado de salud de red — decide qué animación de "idle" mostrar ─────────
// 'ok' (breathe cian/magenta) | 'weak' (naranja) | 'disconnected' (rojo fijo)
let _networkHealth = 'ok';

function _renderIdle() {
  if (_networkHealth === 'disconnected') return brumexaError();
  if (_networkHealth === 'weak')         return wifiWeak();
  return breathe();
}

// Color exacto en el que arranca _renderIdle() ahora mismo — lo usa el fade
// de "dejó de hablar" (ver _createSpeechTracker) para aterrizar AHÍ en vez
// de en negro puro. brumexaError/wifiWeak arrancan su ciclo en floor:0 (o
// sea negro) así que para esos dos no cambia nada; breathe() arranca en
// IDLE_FLOOR (indigo tenue, no negro) — sin este aterrizaje, el fade
// terminaba en negro y breathe() aparecía de golpe ahí, un salto de color
// y brillo justo en el momento en que se supone que todo se pone suave.
function _idleLandingColor() {
  if (_networkHealth === 'ok') return hsvToRgb(IDLE_HUE, IDLE_SAT, IDLE_FLOOR);
  return { r: 0, g: 0, b: 0 };
}

// Hue/sat de lo que se está mostrando en la tira ANTES de que un tracker de
// habla arranque (ver _createSpeechTracker) — para que la ola de entrada
// pueda partir interpolando en hue en vez de un RGB invertido a ciegas (ver
// el comentario grande de _fadeHue de por qué eso no es robusto). El brillo
// NO sale de acá — se recupera aparte con max(_lastRGB)/255, exacto para
// cualquier hue/sat en la fórmula de este archivo.
function _currentIdleHueSat() {
  if (_networkHealth === 'weak') return { h: WIFI_WEAK_HUE, s: 1 };
  // 'ok' Y 'disconnected' — el rojo de brumexaError no tiene un hue propio
  // en la fórmula de este archivo (ver su comentario, más abajo), así que
  // ese caso se aproxima con el indigo de marca en vez de arriesgar un
  // flash blanco tratando de inventarle uno. Es un caso raro (alguien
  // habla justo mientras hay un error de red) y como mucho cuesta un frame
  // de arranque con el hue "equivocado" pero saturado — no un flash blanco.
  return { h: IDLE_HUE, s: IDLE_SAT };
}

// Mismo criterio que _idleLandingColor pero en hue/sat/v — la usa el fundido
// de SALIDA de un tracker de habla (ver _createSpeechTracker), que sí
// necesita el destino expresado en hue para poder interpolar con _fadeHue.
function _idleLandingHueSat() {
  if (_networkHealth === 'ok') return { h: IDLE_HUE, s: IDLE_SAT, v: IDLE_FLOOR };
  return { h: IDLE_HUE, s: 0, v: 0 }; // negro puro — con v:0 el hue no importa
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
  getDeviceColor: () => DEVICE_COLOR,
  getColorSchemes: () => colorSchemes,
  setDeviceColor,
  hsvToRgb,
  hsvToRgbStd,
  previewBreathe,
};
