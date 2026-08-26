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
const micGate = require('./mic-speech-gate');

// Colores personalizados por rol (ver setCustomColors más abajo) — si ya hay
// uno guardado en .env (LED_CUSTOM_COLORS, JSON), se registra ACÁ, antes de
// resolver DEVICE_COLOR más abajo, inyectándolo en colorSchemes.colors bajo
// la key sintética "custom" — así, si BRUMEXA_COLOR=custom, ya existe y
// setDeviceColor('custom') funciona con exactamente la misma lógica que un
// preset normal, sin duplicar código. Nada más requiere este JSON aparte de
// este archivo, así que mutarlo en memoria acá es seguro.
if (process.env.LED_CUSTOM_COLORS) {
  try {
    const leds = JSON.parse(process.env.LED_CUSTOM_COLORS);
    colorSchemes.colors.custom = { label: 'Personalizado', swatch: '#8888ff', leds };
  } catch (e) {
    console.warn('[leds] LED_CUSTOM_COLORS inválido en .env, se ignora:', e.message);
  }
}

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
// Color de la animación de calibración (ver calibrating()/calibrationDone()
// más abajo) — antes hardcodeada en blanco puro sin importar el preset (el
// rol "calibracion" del JSON existía pero nadie lo leía). "hue: null, sat: 0"
// (blanco) sigue siendo el default de los 4 presets — se mantiene igual para
// no cambiarle el color a un equipo ya desplegado.
let CALIB_HUE        = _activeLeds.calibracion?.hue ?? null;
let CALIB_SAT        = _activeLeds.calibracion?.sat ?? 0;
// Color de "cargando/conectando" (ver connecting() más abajo) — antes era
// un cian fijo (COMET_HUE) igual para los 4 presets y no personalizable.
// Ahora es un rol más de color-schemes.json, con el mismo cian de siempre
// como default en los 4 (?? 200/1 cubre también un LED_CUSTOM_COLORS viejo
// guardado antes de que este rol existiera) — así no cambia nada visible
// hoy, pero ya queda enchufado a "Personalizar cada color a mano".
let LOADING_HUE      = _activeLeds.loading?.hue ?? 200;
let LOADING_SAT      = _activeLeds.loading?.sat ?? 1;

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
  CALIB_HUE       = _activeLeds.calibracion?.hue ?? null;
  CALIB_SAT       = _activeLeds.calibracion?.sat ?? 0;
  LOADING_HUE     = _activeLeds.loading?.hue ?? 200;
  LOADING_SAT     = _activeLeds.loading?.sat ?? 1;
  console.log(`[leds] color de carcasa → ${colorKey}`);
  // Si no está hablando/en un error puntual ahora mismo, refrescar ya para
  // que se vea el cambio al toque en vez de esperar el próximo evento.
  if (!_isSpeaking) _renderIdle();
  return true;
}

// Colores 100% personalizados por rol, en vez de elegir entre los 4 presets
// de color-schemes.json. rolesMap: { respiracion:{hue,sat}, voz:{hue,sat},
// agente:{hue,sat}, calibracion:{hue,sat} } — mismo shape que ya usa cada
// preset (colorSchemes.colors[key].leds), así que en vez de duplicar la
// lógica de setDeviceColor esto registra un preset sintético "custom" y
// reusa setDeviceColor('custom') tal cual — una sola fuente de verdad para
// "aplicar un set de 4 colores", sea de un preset fijo o armado a mano.
function setCustomColors(rolesMap) {
  if (!rolesMap || typeof rolesMap !== 'object') return false;
  const roleKeys = colorSchemes.roles.map(r => r.key); // ['respiracion','voz','agente','calibracion']
  const leds = {};
  for (const key of roleKeys) {
    const c = rolesMap[key];
    if (!c || typeof c.hue !== 'number' || typeof c.sat !== 'number') return false;
    if (isNaN(c.hue) || c.hue < 0 || c.hue > 359 || isNaN(c.sat) || c.sat < 0 || c.sat > 1) return false;
    // swatch/name son cosméticos (los usa el grid/detalle de /configuracion
    // para mostrar la tarjeta "Personalizado") — no afectan qué se prende de
    // verdad, eso sale solo de hue/sat.
    leds[key] = {
      hue: c.hue,
      sat: c.sat,
      swatch: typeof c.swatch === 'string' ? c.swatch : '#888888',
      name: typeof c.name === 'string' ? c.name : 'Personalizado',
    };
  }
  colorSchemes.colors.custom = { label: 'Personalizado', swatch: '#8888ff', leds };
  return setDeviceColor('custom');
}

// Para precargar los sliders del panel de "colores personalizados" con lo
// último guardado, sea el preset "custom" recién armado o el que ya venía
// de .env (LED_CUSTOM_COLORS) al arrancar. null si nunca se configuró uno.
function getCustomColors() {
  return colorSchemes.colors.custom ? colorSchemes.colors.custom.leds : null;
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
    periodMs: BREATHE_PERIOD_MS, floor: IDLE_FLOOR,
    asymmetric: { riseFraction: 0.42, riseExp: 1.1, fallExp: 1.9 },
    colorFn: b => hsvToRgbStd(h, s, b),
  });
  return true;
}

// Alertas de sistema (wifi débil, error) — no varían con el color de la
// carcasa a propósito: tienen que leerse igual sin importar la variante.
const WIFI_WEAK_HUE   = 30;

// El color del cometa de "conectando/cargando" ahora sale de LOADING_HUE/SAT
// (rol "loading" en color-schemes.json, ver más arriba), no de un hue fijo
// acá — sigue siendo cian por default en los 4 presets (mismo valor de
// siempre) pero ya es personalizable como cualquier otro rol.
// Más lento, cola más larga y caída más suave que antes — con solo 8 LEDs,
// un cometa rápido (900ms) + cola corta (3.5) + caída dura (1.6) se leía
// "tosco"/mecánico por más que el barrido en sí ya fuera con onda seno: la
// SENSACIÓN de "cometa elegante" viene tanto de la velocidad y lo larga/
// suave que es la cola como de la curva de movimiento. Ahora cubre más de
// media tira con la cola, así siempre hay 3-4 LEDs prendidos en simultáneo
// con una caída gradual, no un blob corto y duro cruzando rápido.
const COMET_PERIOD_MS  = 1300;  // tiempo de punta a punta (LED 0 → LED 7)
const COMET_TAIL_LEN   = 5.5;   // en LEDs — cuánto tarda la cola en desvanecerse detrás de la cabeza
const COMET_EXPONENT   = 1.15;  // >1 = cola se apaga más rápido cerca de la cabeza, se estira suave en la punta


// Blanco no lo usa ningún otro estado (idle=indigo, conectando=cian,
// vos=ámbar, agente=verde, error=rojo, wifi débil=naranja) — así el aviso de
// "estoy por medir el ambiente" no se confunde con nada de la paleta normal.
//
// Parpadeo corto ("che, quedate en silencio, ya arranco") y DESPUÉS un
// cometa sostenido que sigue en movimiento durante TODA la medición — antes
// el cometa solo corría un par de barridos y quedaba un pulso quieto el
// resto del tiempo; ahora el mismo "loading" en movimiento acompaña toda la
// espera, más vivo que un pulso estático.
const CALIBRATION_BLINK_COUNT  = 2;
const CALIBRATION_BLINK_ON_MS  = 200;
const CALIBRATION_BLINK_OFF_MS = 160;
// Cuánto dura el aviso de parpadeo antes de que server.js arranque a grabar
// de verdad — exportado para que quien orquesta la calibración espere
// EXACTO este tiempo en vez de duplicar el número a mano.
const CALIBRATION_COUNTDOWN_MS = CALIBRATION_BLINK_COUNT * (CALIBRATION_BLINK_ON_MS + CALIBRATION_BLINK_OFF_MS);
// Cometa de "midiendo" — más calmo que el cian de scripts/boot.js
// (connecting()): este corre varios segundos seguidos (dura lo que tarda
// measureNoiseFloor en server.js), no un instante.
const CALIBRATION_MEASURE_PERIOD_MS = 850;
const CALIBRATION_MEASURE_TAIL_LEN  = 4;
const CALIBRATION_MEASURE_EXPONENT  = 1.4;

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
    // Piso de ruido ambiente EN VIVO (ver lib/mic-speech-gate.js) — para
    // confirmar desde /diag/leds que de verdad está subiendo cuando hay
    // ruido sostenido de fondo (ej. una impresora 3D), sin tener que ir a
    // leer los logs de "hablando" uno por uno.
    micAmbientFloorDbfs: micGate.getAmbientFloorDbfs() !== null ? Math.round(micGate.getAmbientFloorDbfs() * 10) / 10 : null,
    micEffectiveThresholdDbfs: Math.round(micGate.getEffectiveThresholdDbfs() * 10) / 10,
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
// esperaría). _playSpeechWave (entrada/salida de "hablando") necesita un
// barrido de color REALMENTE continuo, así que interpola en esta rueda
// estándar (donde sí es continua) y usa esta función solo para convertir
// los DOS extremos conocidos (que sí vienen en espacio de este archivo)
// antes de arrancar.
function _toStdHue(h) {
  const i = Math.floor(h / 60) % 6;
  return ((i * 120 + 60 - h) % 360 + 360) % 360;
}

// Render directo sin tocar el intervalo activo — recuerda el último color
// realmente puesto en el hardware (_lastRGB), para que otras animaciones
// puedan arrancar un fundido desde ahí en vez de saltar de golpe.
let _lastRGB = { r: 0, g: 0, b: 0 };

// true mientras _playSpeechWave está a mitad de camino (los 8 LEDs en
// colores DISTINTOS entre sí — ver _playSpeechWave). Si una ola nueva
// interrumpe a esta antes de que termine (ej. volviste a hablar apenas
// arrancó la ola de "dejaste de hablar"), _lastRGB solo tiene el color del
// LED 0, no de los otros 7 — no alcanza para reconstruir de dónde arrancar
// la ola siguiente, y no hay forma confiable de invertir RGB→HSV por LED
// (ver el comentario grande sobre hsvToRgb más arriba). _onsetAnim/
// _offsetAnim usan esta bandera para saltar directo a un color sólido en
// vez de animar una ola desde un estado que no se puede reconstruir bien.
//
// _waveOwner distingue DE QUIÉN es la ola en vuelo ('vos' o 'agente') — los
// dos trackers comparten esta bandera y el mismo _breathe/_lastRGB (una
// sola tira física), así que el agente terminando de hablar justo cuando
// arrancás a responder (lo normal en una conversación) también cuenta como
// "ola en vuelo". Pero ESA interrupción no tiene el problema de arriba (el
// tracker que arranca ahora no depende de _lastRGB para saber su propio
// punto de partida real, solo el snap-a-mitad-de-SU-PROPIA-ola sí) — así
// que el salto a color sólido queda reservado a cuando un tracker
// interrumpe SU PROPIA ola (_waveOwner === label). Si te interrumpe el
// OTRO tracker, se sigue animando la ola normal — cortarla en seco ahí se
// sentía como "un cambio duro" en vez de la escalerita esperada.
let _waveInFlight = false;
let _waveOwner    = null;

// ─── Historial de renders — evidencia dura para diagnosticar "se tilda" ────
// Hasta acá, cazar el tildado dependía de mirar logs a mano después del
// hecho. Esto graba cada valor que Node manda de verdad a ws281x.render()
// (no lo que DEBERÍA mandar — lo que mandó) en un buffer circular chico, así
// GET /diag/leds/live puede responder la pregunta clave en el momento: ¿el
// último color realmente cambió hace poco (Node sigue calculando bien, el
// problema es de la tira/hardware — no arreglable acá) o quedó pegado en el
// mismo valor un buen rato (bug real de este código, ahora sí diagnosticable
// con la hora exacta y el valor)? RENDER_HISTORY_SIZE 600 ≈ 9.6s de historia
// a 16ms/tick — de sobra para capturar el instante justo antes de un reporte
// de "se tildó".
const RENDER_HISTORY_SIZE = 600;
const _renderHistory = [];
let _lastChangedAt = Date.now();
let _lastChangedRGB = { r: 0, g: 0, b: 0 };

function _recordRender(r, g, b) {
  const now = Date.now();
  if (r !== _lastChangedRGB.r || g !== _lastChangedRGB.g || b !== _lastChangedRGB.b) {
    _lastChangedAt = now;
    _lastChangedRGB = { r, g, b };
  }
  _renderHistory.push({ ts: now, r, g, b });
  if (_renderHistory.length > RENDER_HISTORY_SIZE) _renderHistory.shift();
}

// Snapshot para /diag/leds/live — pensado para pedirse EN EL MOMENTO que se
// ve algo raro, sin tener que ir a buscar logs por SSH.
function getRenderDiagnostics() {
  const now = Date.now();
  return {
    now,
    lastRender:      _renderHistory.length ? _renderHistory[_renderHistory.length - 1] : null,
    msSinceLastRender: _renderHistory.length ? now - _renderHistory[_renderHistory.length - 1].ts : null,
    // Si esto es grande (cientos de ms+) MIENTRAS la respiración debería
    // estar activa, es la prueba de que el color realmente dejó de cambiar
    // — no es solo "se ve tenue", es que Node calculó el MISMO valor tick
    // tras tick.
    msSinceLastChange: now - _lastChangedAt,
    lastChangedRGB:  _lastChangedRGB,
    breatheActive:   !!_breathe,
    history:         _renderHistory.slice(-120), // ~last 2s — suficiente para ver la forma de la curva sin mandar 600 puntos
  };
}

function _render(r, g, b) {
  if (!ws281x) return;
  _lastRGB = { r, g, b };
  _recordRender(r, g, b);
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
  _recordRender(colors[0].r, colors[0].g, colors[0].b);
  const px = new Uint32Array(NUM_LEDS);
  for (let i = 0; i < NUM_LEDS; i++) {
    const { r, g, b } = colors[i];
    px[i] = (r << 16) | (g << 8) | b;
  }
  ws281x.render(px);
}

function _stopBreathe() {
  if (_breathe) { clearInterval(_breathe); _breathe = null; }
  // CUALQUIER cosa que interrumpa la animación en curso pasa por acá — no
  // solo _playSpeechWave terminando sola. Si esto no limpiara la bandera,
  // una ola cortada por OTRA animación (ej. el fade de "sensing", que
  // también llama _stopBreathe() directo) la dejaba en true para siempre,
  // y _onsetAnim/_offsetAnim ya nunca volvían a animar la ola — quedaban
  // saltando al color sólido por el resto de la vida del proceso (bug real,
  // reportado como "se perdió la escalerita, ya no le hace más").
  _waveInFlight = false;
}

// Ease compartida por _fadeTo — cubic in-out (arranca y frena suave, nunca
// lineal). _playSpeechWave usa su propio smoothstep (ver más abajo), no
// esta.
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

// ─── Ola de color en los 8 LEDs: entrada Y salida de "hablando" ─────────────
// Cada LED interpola su propio hue/sat/brillo con un pequeño delay
// creciente respecto del anterior — se ve como una ola que recorre la tira
// UNA sola vez (no ping-pong, no se repite, así que no aplica la regla de
// rebote de los motores de cometa — esos SIGUEN corriendo en la tira recta,
// esto simplemente llega a destino y se queda quieto). reverse=false barre
// LED 0→7 (entrada: "empezaste a hablar", ver _playSpeechOnset);
// reverse=true barre 7→0, la ola "retrocediendo" (salida: "dejaste de
// hablar", ver _playSpeechOffset) — un espejo de cómo llegó.
//
// Interpola/renderiza en la rueda ESTÁNDAR (_toStdHue + hsvToRgbStd), NO
// con la fórmula permutada de este archivo (hsvToRgb) — se probó primero
// con hsvToRgb (misma fórmula que usan breathe()/los trackers, para no
// tener salto en el handoff) y en la Pi se veía mal: saltos raros de color,
// tipo blanco/azul sin sentido. La causa real: hsvToRgb de este archivo NO
// es una rueda de color perceptualmente continua — dentro de cada segmento
// de 60° tiene t/q pisados entre sí (ver el comentario grande al principio
// del archivo), lo que EQUIVALE a reflejar el hue. Interpolar sus números
// de hue linealmente no da un barrido suave — pasa de amarillo a magenta de
// un frame a otro sin pasar por el verde/turquesa del medio. La fórmula
// ESTÁNDAR (hsvToRgbStd) sí es continua, así que acá se convierten los DOS
// extremos a hue estándar (_toStdHue) UNA sola vez al arrancar, y se
// interpola/renderiza TODO en espacio estándar — los extremos coinciden
// exacto con lo que hubiera dado hsvToRgb (por construcción de _toStdHue),
// así que no hay salto contra breathe()/los trackers, y el camino del medio
// sí es un barrido de color real.
//
// fromHue/fromSat/fromV YA CALCULADOS por quien llama, no un RGB para
// invertir acá adentro — se probó invertir hsvToRgb con una inversión
// genérica y rompe justo en los bordes de cada segmento de 60° y en
// saturaciones bajas (color de carcasa "blanco": sat 0.18 en respiración)
// — nada robusto. Cada uso conoce su propio origen exacto sin adivinar (ver
// _createSpeechTracker: la salida de "hablando" usa el hue/sat/brillo REAL
// del propio tracker vía _tweenValue; la entrada usa el hue/sat conocido
// del estado idle actual + el brillo recuperado con max(r,g,b)/255, que sí
// es exacto para cualquier hue/sat en esta fórmula).
function _playSpeechWave(fromHue, fromSat, fromV, toHue, toSat, toV, { staggerMs, riseMs, reverse }, onDone) {
  if (!ws281x) { if (onDone) onDone(); return; }
  _stopBreathe();
  _waveInFlight = true;
  const fromStd  = _toStdHue(fromHue);
  const toStd    = _toStdHue(toHue);
  const deltaHue = ((toStd - fromStd + 540) % 360) - 180;
  const totalMs  = staggerMs * (NUM_LEDS - 1) + riseMs;
  let t = 0;
  const STEP = 16;
  _breathe = setInterval(() => {
    t += STEP;
    const colors = new Array(NUM_LEDS);
    for (let i = 0; i < NUM_LEDS; i++) {
      const order  = reverse ? (NUM_LEDS - 1 - i) : i;
      const localP = Math.max(0, Math.min(1, (t - order * staggerMs) / riseMs));
      const eased  = localP * localP * (3 - 2 * localP); // smoothstep — mismo criterio que el tween de habla
      const hue    = (fromStd + deltaHue * eased + 360) % 360;
      const sat    = fromSat + (toSat - fromSat) * eased;
      const v      = fromV + (toV - fromV) * eased;
      colors[i] = hsvToRgbStd(hue, sat, v);
    }
    _renderPixels(colors);
    if (t >= totalMs) {
      _stopBreathe(); // limpia _breathe Y _waveInFlight en un solo lugar
      if (onDone) onDone();
    }
  }, STEP);
}

// Entrada ("empezaste a hablar"): LED 0 primero, LED 7 al final. Valores
// DEFAULT (mantienen la PROPORCIÓN stagger:rise cuando se reescala desde
// /configuracion — ver setOnsetDurationMs) — no se leen directos, son la
// referencia para el escalado.
const SPEECH_ONSET_STAGGER_MS_DEFAULT = 28;
const SPEECH_ONSET_RISE_MS_DEFAULT    = 340;
const SPEECH_ONSET_DURATION_DEFAULT   = SPEECH_ONSET_STAGGER_MS_DEFAULT * (NUM_LEDS - 1) + SPEECH_ONSET_RISE_MS_DEFAULT;
let SPEECH_ONSET_STAGGER_MS = SPEECH_ONSET_STAGGER_MS_DEFAULT;
let SPEECH_ONSET_RISE_MS    = SPEECH_ONSET_RISE_MS_DEFAULT;

function _playSpeechOnset(fromHue, fromSat, fromV, toHue, toSat, toV, onDone) {
  _playSpeechWave(fromHue, fromSat, fromV, toHue, toSat, toV,
    { staggerMs: SPEECH_ONSET_STAGGER_MS, riseMs: SPEECH_ONSET_RISE_MS, reverse: false }, onDone);
}

// setOnsetDurationMs(ms) reescala stagger Y rise por igual (mismo factor),
// así que la "forma" de la ola (qué tan escalonada se ve vs. qué tan rápido
// llega cada LED) se mantiene igual a la del default, solo más rápida o
// lenta en conjunto — un solo número en la UI en vez de dos que hay que
// entender por separado.
function setOnsetDurationMs(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 150 || ms > 3000) return false;
  const scale = ms / SPEECH_ONSET_DURATION_DEFAULT;
  SPEECH_ONSET_STAGGER_MS = SPEECH_ONSET_STAGGER_MS_DEFAULT * scale;
  SPEECH_ONSET_RISE_MS    = SPEECH_ONSET_RISE_MS_DEFAULT * scale;
  return true;
}
function getOnsetDurationMs() { return Math.round(SPEECH_ONSET_STAGGER_MS * (NUM_LEDS - 1) + SPEECH_ONSET_RISE_MS); }

// Salida ("dejaste de hablar"): espejo de la entrada — LED 7 primero, LED 0
// al final, como si la ola retrocediera por donde vino.
const SPEECH_OFFSET_STAGGER_MS_DEFAULT = 35;
const SPEECH_OFFSET_RISE_MS_DEFAULT    = 720;
const SPEECH_OFFSET_DURATION_DEFAULT   = SPEECH_OFFSET_STAGGER_MS_DEFAULT * (NUM_LEDS - 1) + SPEECH_OFFSET_RISE_MS_DEFAULT;
let SPEECH_OFFSET_STAGGER_MS = SPEECH_OFFSET_STAGGER_MS_DEFAULT;
let SPEECH_OFFSET_RISE_MS    = SPEECH_OFFSET_RISE_MS_DEFAULT;

function _playSpeechOffset(fromHue, fromSat, fromV, toHue, toSat, toV, onDone) {
  _playSpeechWave(fromHue, fromSat, fromV, toHue, toSat, toV,
    { staggerMs: SPEECH_OFFSET_STAGGER_MS, riseMs: SPEECH_OFFSET_RISE_MS, reverse: true }, onDone);
}

function setOffsetDurationMs(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 150 || ms > 3000) return false;
  const scale = ms / SPEECH_OFFSET_DURATION_DEFAULT;
  SPEECH_OFFSET_STAGGER_MS = SPEECH_OFFSET_STAGGER_MS_DEFAULT * scale;
  SPEECH_OFFSET_RISE_MS    = SPEECH_OFFSET_RISE_MS_DEFAULT * scale;
  return true;
}
function getOffsetDurationMs() { return Math.round(SPEECH_OFFSET_STAGGER_MS * (NUM_LEDS - 1) + SPEECH_OFFSET_RISE_MS); }

// Valores de arranque desde .env (LED_ONSET_MS/LED_OFFSET_MS) — mismo
// patrón que SPEAK_THRESHOLD más abajo: si no están seteados, se queda con
// el default de fábrica. Los setters ya validan rango y no tienen efectos
// colaterales (no tocan hardware), así que llamarlos acá antes de init()
// es seguro.
if (process.env.LED_ONSET_MS)  setOnsetDurationMs(parseFloat(process.env.LED_ONSET_MS));
if (process.env.LED_OFFSET_MS) setOffsetDurationMs(parseFloat(process.env.LED_OFFSET_MS));

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
// exhalar es más largo y sale del pico sin corte. Antes (sin²(fase·2π), dos
// "humps" simétricos por período de 4200ms) el ciclo quedaba en ~2.1s y,
// al ser perfectamente simétrica, subir y bajar se sentían como el mismo
// movimiento espejado — entre eso y el shimmer superpuesto (pensado para
// "romper la monotonía" pero en la práctica agregaba una vibración de alta
// frecuencia sobre la curva principal) el conjunto se sentía más
// "mecánico/duro" que orgánico. Se sacó el shimmer — la asimetría real ya
// rompe la monotonía sin ensuciar la curva.
//
// periodMs 1900: se probó primero bajar el ritmo a un ciclo completo cada
// 5600ms (~10-11 resp/min, ritmo de reposo "de libro") pero en el
// hardware real se sentía mucho más lento que antes — la velocidad
// original (~2.1s) se sentía mejor como pulso del dispositivo, aunque no
// sea fisiológicamente "de reposo". 1900ms queda un poco más rápido que
// esa original.
//
// riseFraction 0.42: inhalar dura un poco menos que exhalar (42%/58% del
// ciclo) — como una respiración relajada real, nunca 50/50. fallExp > 1
// redondea el valle (nunca hay una punta filosa abajo) sin necesitar una
// meseta plana.
//
// riseExp bajado de 1.6 a 1.1: con 1.6, sin(fase)^1.6 sale MUY chato cerca
// de fase 0 (es matemáticamente continuo — pendiente cero justo al
// arrancar — pero en la práctica, apenas 100ms después de "aterrizar" ahí
// la ola de salida (_playSpeechOffset, que TAMBIÉN frena hasta pendiente
// cero al llegar), el brillo casi no se había movido — 0.15→0.21 en
// 100ms). Dos tramos "frenando hasta pararse" pegados uno al otro justo en
// el empalme wave→respiración se sentían tosco/trabado, aunque el color y
// el brillo de arranque coincidan exacto (que siguen coincidiendo: fase 0
// sigue dando IDLE_FLOOR con cualquier riseExp). Con 1.1 el brillo ya se
// nota moviéndose bastante más rápido apenas arranca (0.15→0.29 en 100ms)
// sin dejar de salir en el mismo punto exacto. Punto de partida para
// afinar de oído/vista en el hardware real.
//
// Piso de brillo de la respiración — extraído a constante porque
// _idleLandingColor() (más abajo) necesita el mismo valor para que el fade
// de "dejó de hablar" aterrice EXACTO donde breathe() arranca su ciclo, sin
// salto en el handoff.
// Subido de 0.15 a 0.32: con fallExp=1.9 (ver _asymmetricPulse), la curva
// se queda pegada cerca del piso durante buena parte del tramo final del
// exhalar (~400ms de los 1900ms del ciclo default) — a propósito, para que
// se sienta relajada, pero en la práctica ese valle se reportó como "se
// tilda"/"se pone tenue" sin relación con nada (era el ciclo normal, no un
// corte real — confirmado con el monitor de bloqueo del event loop
// corriendo en paralelo sin detectar nada en el momento exacto reportado).
// Con el piso más alto, ese mismo tramo se ve tenue pero nunca "apagado",
// mucho menos ambiguo a simple vista.
const IDLE_FLOOR = 0.32;

// Configurable desde /configuracion (setBreathePeriodMs) — cuánto dura un
// ciclo completo de inhalar+exhalar. breathe() lee esta variable en cada
// llamada (no queda "pegada" al valor que tenía al arrancar), así que un
// cambio se nota recién la PRÓXIMA vez que arranca el ciclo de respiración
// (setBreathePeriodMs fuerza eso llamando _renderIdle() si no está
// hablando ahora mismo — ver más abajo).
let BREATHE_PERIOD_MS = process.env.LED_BREATHE_PERIOD_MS
  ? parseFloat(process.env.LED_BREATHE_PERIOD_MS)
  : 1900;

function setBreathePeriodMs(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 600 || ms > 8000) return false;
  BREATHE_PERIOD_MS = ms;
  if (!_isSpeaking) _renderIdle();
  return true;
}
function getBreathePeriodMs() { return BREATHE_PERIOD_MS; }

function breathe() {
  _startPulse({
    periodMs: BREATHE_PERIOD_MS, floor: IDLE_FLOOR,
    asymmetric: { riseFraction: 0.42, riseExp: 1.1, fallExp: 1.9 },
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
// Posición en el tiempo: antes velocidad CONSTANTE con un rebote instantáneo
// en cada punta (onda triangular) — se sentía mecánico/tosco, sobre todo en
// los extremos donde la cabeza frenaba en seco y salía disparada para el
// otro lado de un frame a otro. Ahora es una onda seno: acelera al arrancar
// de cada punta, frena sola ANTES de llegar a la otra — mismo criterio de
// "nunca un corte, siempre en movimiento suave" que ya usan el tween de
// habla (smoothstep) y la respiración (curva asimétrica). periodMs sigue
// siendo el tiempo de punta a punta (un solo sentido); una vuelta completa
// ida+vuelta tarda 2×periodMs.
function _startComet({ periodMs, tailLen, exponent, colorFn }) {
  if (!ws281x) return;
  _stopBreathe();
  const STEP = 16;
  const roundTripMs = periodMs * 2;
  let t = 0;
  _breathe = setInterval(() => {
    t = (t + STEP) % roundTripMs;
    const theta = (t / roundTripMs) * Math.PI * 2;
    const pos   = (NUM_LEDS - 1) * (1 - Math.cos(theta)) / 2;
    const dir   = Math.sin(theta) >= 0 ? 1 : -1; // de qué lado de la cabeza va la cola

    const colors = new Array(NUM_LEDS);
    for (let i = 0; i < NUM_LEDS; i++) {
      const behind = dir > 0 ? pos - i : i - pos;
      const bright = behind < 0 ? 0 : Math.pow(Math.max(0, 1 - behind / tailLen), exponent);
      colors[i] = colorFn(bright);
    }
    _renderPixels(colors);
  }, STEP);
}

// ─── "Cargando/conectando": el ÚNICO cometa de loading de todo Brumexa ──────
// Genérica a propósito — todo "estoy cargando/conectando algo" pasa por
// ACÁ, nunca se inventa una animación nueva para un caso puntual: arrancar
// la Pi (scripts/boot.js, antes de que server.js exista), pedir token y
// conectar a LiveKit (server.js). Un solo lugar → un solo "vibe" de carga
// en toda la experiencia, en vez de que cada momento de espera se sienta
// distinto. La forma (cometa en movimiento) ya la distingue a simple vista
// del breathing uniforme del idle; el color (LOADING_HUE/SAT, rol "loading"
// en color-schemes.json) también se corre del resto de la paleta por
// default, pero es un color más para elegir en "Personalizar cada color a
// mano" — no un tono pegado al código.
function connecting() {
  _startComet({
    periodMs: COMET_PERIOD_MS, tailLen: COMET_TAIL_LEN, exponent: COMET_EXPONENT,
    colorFn: b => hsvToRgb(LOADING_HUE, LOADING_SAT, b),
  });
}

// Color de la animación de calibración, resuelto desde CALIB_HUE/SAT (ver
// arriba) — con sat=0 (default de los 4 presets) da blanco puro sin importar
// el hue, igual que el hardcodeo anterior; con un hue/sat personalizado
// (setCustomColors) da ese color en su lugar.
function _calibColor(brightness) {
  return hsvToRgb(CALIB_HUE ?? 0, CALIB_SAT, brightness);
}

// ─── Calibración de ruido ambiente: parpadeo ("che, silencio") + cometa en
// movimiento mientras se mide ─────────────────────────────────────────────
// CALIBRATION_BLINK_COUNT parpadeos ("ya voy a medir, quedate en silencio")
// y después un cometa sostenido en el color de calibración (blanco por
// default) que sigue en movimiento todo el tiempo que server.js graba el
// tramo de silencio — corre indefinidamente hasta que se llama a
// calibrationDone(), server.js no tiene que sincronizar nada más que
// esperar CALIBRATION_COUNTDOWN_MS antes de empezar a grabar.
function calibrating() {
  if (!ws281x) return;
  _stopBreathe();
  let step = 0;
  const totalSteps = CALIBRATION_BLINK_COUNT * 2;
  function blinkStep() {
    if (step >= totalSteps) {
      _startComet({
        periodMs: CALIBRATION_MEASURE_PERIOD_MS, tailLen: CALIBRATION_MEASURE_TAIL_LEN,
        exponent: CALIBRATION_MEASURE_EXPONENT, colorFn: _calibColor,
      });
      return;
    }
    const on = step % 2 === 0;
    const { r, g, b } = _calibColor(on ? 1 : 0);
    _render(r, g, b);
    step++;
    setTimeout(blinkStep, on ? CALIBRATION_BLINK_ON_MS : CALIBRATION_BLINK_OFF_MS);
  }
  blinkStep();
}

// Confirmación al terminar de medir. Si salió bien: un spinner suave en el
// color de calibración ("angelical" — lento, cola larga, caída sin
// brusquedad) por un par de pasadas y después se apaga solo. Si falló: flash
// rojo directo, sin ambigüedad de que algo no anduvo (el rojo de error NO se
// personaliza — es una convención fija, distinta a propósito de cualquier
// otro color del dispositivo). En ambos casos vuelve solo al idle normal
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
    colorFn: _calibColor,
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

// "Sensing" (ver isSensing() en mic-speech-gate.js): un brillo plano y tenue
// que arranca en 1 sola muestra (~100ms), antes de que se confirme del todo
// que sos vos hablando — así el LED no se siente con delay, sin bajar el
// umbral real de confirmación (que sigue exigiendo el streak entero, tanto
// para el LED como para lo que se publica a LiveKit). A propósito bien
// distinto de la ola de 8 LEDs de _playSpeechOnset (confirmado): acá es un
// fade plano y tenue en toda la tira, para que de un vistazo se note la
// diferencia entre "por ahí es algo" y "confirmado, mandando tu voz".
const SENSING_BRIGHTNESS = 0.18;
const SENSING_FADE_MS    = 120;
// Entrada y salida usan _playSpeechOnset/_playSpeechOffset (ola de 8 LEDs,
// ver SPEECH_ONSET_*/SPEECH_OFFSET_* más abajo) en vez de una duración fija
// acá — cada LED tiene su propio timing.

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

// Umbral, hangover y piso de ruido ambiente para "vos" viven ahora en
// lib/mic-speech-gate.js — es el mismo módulo que decide qué audio se
// publica de verdad a LiveKit (ver _publishMic en livekit-session.js), así
// que hay una sola fuente de verdad en vez de dos umbrales que podrían
// desincronizarse. Estos wrappers existen solo para no tener que cambiar
// ningún caller existente (server.js sigue llamando leds.setHangoverMs(),
// leds.setSpeakThresholdDbfs(), etc. exactamente igual que antes).
function setHangoverMs(ms) { return micGate.setHangoverMs(ms); }
function getHangoverMs() { return micGate.getHangoverMs(); }
function setSpeakThresholdDbfs(dbfs) { return micGate.setSpeakThresholdDbfs(dbfs); }
function getSpeakThresholdDbfs() { return micGate.getSpeakThresholdDbfs(); }

// Hangover PROPIO del agente, separado del de "vos" (arriba) — antes
// compartían el mismo valor (getHangoverMs), así que subir la "paciencia con
// las pausas" de tu voz (pensada para pausas al pensar, 2s por defecto)
// también dejaba el LED del agente prendido de más entre frases de su
// respuesta, sintiéndose pegado/no sincronizado con lo que en verdad se
// estaba escuchando. El TTS del agente no tiene pausas para "pensar" — un
// valor corto y fijo alcanza. No expuesto en /configuracion (es un detalle
// de timing interno, no algo que haga falta ajustar seguido) pero sí
// override-able por .env para no bloquear un ajuste puntual sin código.
const AGENT_HANGOVER_MS = process.env.AGENT_HANGOVER_MS
  ? parseFloat(process.env.AGENT_HANGOVER_MS)
  : 600;
function getAgentHangoverMs() { return AGENT_HANGOVER_MS; }

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
// getThreshold: función que devuelve el umbral (ratio lineal) a usar — solo
// la usa la rama SIN sharedGate (agente: () => micGate.getSpeakThreshold(),
// sin ruido de sala). sharedGate (opcional): cuando se pasa (solo "vos"),
// es lib/mic-speech-gate.js — YA decide onset/hangover/piso ambiente (lo
// alimenta quien llama a sharedGate.feed(), no este tracker), así que este
// solo lee sharedGate.isVoiceActive() para animar. getHangoverMs: función (no un
// número) — se lee EN VIVO en cada setTimeout, así setHangoverMs() desde
// /configuracion se aplica ya, sin esperar a que este tracker (creado una
// sola vez al arrancar el módulo) se vuelva a crear.
function _createSpeechTracker(label, getHue, getSat, levelGain, getHangoverMs, getThreshold, sharedGate) {
  const displayName = _DISPLAY_NAME[label] || label;
  let active      = false;
  let hangover    = null;      // solo usado en la rama SIN sharedGate (agente)
  let aboveStreak = 0;         // ídem — lecturas consecutivas por encima del umbral

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

  // dBFS acá, no el ratio lineal — mismo idioma que el threshold configurado
  // y que loguea lib/mic-calibration.js. El cálculo interno de brillo sigue
  // en lineal (_speechBrightness) porque ahí conviene matemáticamente (gain
  // = multiplicación simple); esto solo cambia lo que se imprime. Threshold
  // Y level juntos en la misma línea — así se ve de un vistazo POR QUÉ se
  // disparó el LED. Se loguea el umbral EFECTIVO (threshold, ya resuelto por
  // quien llama) y no getSpeakThresholdDbfs() — para "vos" pueden diferir si
  // el piso ambiente en vivo subió por encima del calibrado.
  function _onsetAnim(level, threshold) {
    active = true;
    _setSpeakingFlag(label, true);
    const dbfs = level > 0 ? 20 * Math.log10(level) : -120;
    const thresholdDbfs = threshold > 0 ? 20 * Math.log10(threshold) : -120;
    console.log(`[leds] 🎙 ${displayName} hablando — threshold=${thresholdDbfs.toFixed(1)}dBFS / level=${dbfs.toFixed(1)}dBFS`);
    if (ws281x) {
      const startBrightness = _speechBrightness(level, levelGain);
      if (_waveInFlight && _waveOwner === label) {
        // Volviste a hablar mientras TU PROPIA ola de "dejaste de hablar"
        // seguía a mitad de camino (paciencia/hangover corto + pausas
        // cortas al hablar hacen esto frecuente) — la tira tiene 8 colores
        // distintos ahora mismo, no uno solo, así que animar OTRA ola desde
        // ahí daría un salto de color raro. Se salta directo al color
        // sólido de "hablando" en vez de arrancar una ola sobre un estado
        // que no se puede reconstruir bien.
        _stopBreathe();
        const { r, g, b } = hsvToRgb(getHue(), getSat(), startBrightness);
        _render(r, g, b);
        loop(startBrightness);
        return;
      }
      // Si hay una ola en vuelo pero es del OTRO tracker (ej. el agente
      // recién terminando de hablar justo cuando empezás a responder), se
      // sigue animando la ola normal — este tracker no depende de
      // _lastRGB[0] para saber de dónde viene, así que no hay estado ajeno
      // que reconstruir mal.
      //
      // El hue/sat de partida NO es _currentIdleHueSat() para "vos": el eco
      // de "sensing" (mic-speech-gate.js) ya arrancó un fundido HACIA
      // getHue()/getSat() unas muestras antes de que esto se confirme (2
      // muestras de sensing vs. 3 del streak de onset — sensing SIEMPRE va
      // primero), así que la tira YA no está en el hue idle cuando esto se
      // dispara. Asumir que sí (como antes) hacía que el primer frame de la
      // ola saltara del hue real (~el de habla, por el fundido de sensing)
      // al hue idle de un salto, y de ahí otra vez hacia el de habla — un
      // titileo justo al arrancar. Para "agente" (sin sensing) sigue
      // siendo el idle real. El brillo (fromV) sí sigue leyendo _lastRGB
      // en los dos casos — eso es exacto siempre, lo único que fallaba era
      // el hue.
      const from  = sharedGate ? { h: getHue(), s: getSat() } : _currentIdleHueSat();
      const fromV = Math.max(_lastRGB.r, _lastRGB.g, _lastRGB.b) / 255;
      _waveOwner = label;
      _playSpeechOnset(from.h, from.s, fromV, getHue(), getSat(), startBrightness, () => loop(startBrightness));
    }
  }

  function _offsetAnim() {
    active = false;
    _setSpeakingFlag(label, false);
    console.log(`[leds] 🔇 ${displayName} dejó de hablar`);
    if (ws281x) {
      // Origen EXACTO, no aproximado — este tracker ya sabe su propio
      // hue/sat, y _tweenValue(now) da el brillo real en el que está la
      // tira en este instante (sin invertir nada).
      const landing = _idleLandingHueSat();
      if (_waveInFlight && _waveOwner === label) {
        // Espejo del caso de arriba: dejaste de hablar mientras TU PROPIA
        // ola de "empezaste a hablar" todavía estaba a mitad de camino.
        _stopBreathe();
        const { r, g, b } = hsvToRgb(landing.h, landing.s, landing.v);
        _render(r, g, b);
        _renderIdle();
        return;
      }
      _waveOwner = label;
      _playSpeechOffset(getHue(), getSat(), _tweenValue(Date.now()), landing.h, landing.s, landing.v, _renderIdle);
    }
  }

  if (sharedGate) {
    // 'vos': lib/mic-speech-gate.js ya decide onset/hangover/piso ambiente
    // (es el mismo gate que filtra qué audio se publica de verdad a
    // LiveKit, ver _publishMic) — este tracker solo REFLEJA isVoiceActive()
    // en la animación, sin volver a alimentar el detector (lo alimenta quien
    // llama a sharedGate.feed(): _publishMic durante sesión, startMicMonitor
    // en idle — nunca los dos a la vez).
    let sensing = false; // eco visual de isSensing() — nunca cuenta como "hablando" confirmado (_setSpeakingFlag no se toca acá)
    return function feed(level) {
      if (active) _pushTarget(level);

      const open = sharedGate.isVoiceActive();
      if (open !== active) {
        sensing = false; // la transición confirmada manda, pisa cualquier fade de sensing en curso
        if (open) _onsetAnim(level, sharedGate.getEffectiveThreshold());
        else _offsetAnim();
        return;
      }

      if (active) return; // ya confirmado y sostenido — nada que decidir sobre sensing
      const nowSensing = sharedGate.isSensing();
      if (nowSensing === sensing) return;
      sensing = nowSensing;
      if (!ws281x) return;
      _stopBreathe();
      if (nowSensing) {
        const idle  = _currentIdleHueSat();
        const fromV = Math.max(_lastRGB.r, _lastRGB.g, _lastRGB.b) / 255;
        const from  = hsvToRgb(idle.h, idle.s, fromV);
        const to    = hsvToRgb(getHue(), getSat(), SENSING_BRIGHTNESS);
        _fadeTo(from.r, from.g, from.b, to.r, to.g, to.b, SENSING_FADE_MS);
      } else {
        // BUG real encontrado acá: este _fadeTo no le pasaba onDone. Cuando
        // el fundido termina, _fadeTo limpia _breathe (lo deja en null) y
        // llama onDone SI EXISTE — sin onDone, nada volvía a arrancar la
        // respiración, y la tira quedaba congelada en el color de llegada
        // (el de idle, bien tenue) hasta que algo AJENO la reiniciara de
        // rebote (hablar de verdad, entrar a probar los LEDs, etc.). Esto
        // pasa cada vez que el "eco" de sensing se prende con un ruido que
        // NUNCA llega a confirmarse como voz real — no hace falta que
        // sostengas la voz, alcanza con un pico que cruce el umbral 2
        // muestras (~200ms) y después baje. Coincide con "se traba sin
        // razón aparente, se despega solo": confirmado con getRenderDiagnostics()
        // mostrando breatheActive:false en un momento sin nadie hablando.
        const landing = _idleLandingHueSat();
        const to      = hsvToRgb(landing.h, landing.s, landing.v);
        _fadeTo(_lastRGB.r, _lastRGB.g, _lastRGB.b, to.r, to.g, to.b, SENSING_FADE_MS, _renderIdle);
      }
    };
  }

  // 'agente' (o cualquier fuente sin ruido de sala): onset/hangover propios
  // — el audio del agente no tiene ruido de sala que trackear, así que no
  // necesita el piso ambiente del gate compartido.
  return function feed(level) {
    // Mientras ya está "hablando", cada muestra (incluso bajo el umbral)
    // empuja un tween nuevo — así el brillo también baja suave hacia el piso
    // en un valle real de la voz, en vez de quedar congelado en el último
    // pico. La primerísima muestra que dispara la activación NO pasa por acá
    // (active todavía es false en ese momento) — esa arranca su propio tween
    // vía loop(startBrightness) más abajo, para no pisar el fade-in.
    if (active) _pushTarget(level);

    const threshold = getThreshold();
    if (level <= threshold) { aboveStreak = 0; return; }
    aboveStreak++;

    if (!active) {
      // Exigir ONSET_MIN_STREAK lecturas seguidas por encima del umbral antes
      // de declarar "empezó a hablar" — un pico aislado de ruido (click
      // eléctrico, golpe) cruza el umbral por una sola ventana de ~100ms y
      // se cae solo en la siguiente; la voz real se sostiene mucho más que
      // eso.
      if (aboveStreak < micGate.ONSET_MIN_STREAK) return;
      _onsetAnim(level, threshold);
    }

    if (hangover) clearTimeout(hangover);
    hangover = setTimeout(_offsetAnim, getHangoverMs());
  };
}

const speaking      = _createSpeechTracker('vos',    () => SPEAK_HUE,       () => SPEAK_SAT,       MIC_LEVEL_GAIN,   getHangoverMs, null,                       micGate);
const agentSpeaking  = _createSpeechTracker('agente', () => AGENT_SPEAK_HUE, () => AGENT_SPEAK_SAT, AGENT_LEVEL_GAIN, getAgentHangoverMs, () => micGate.getSpeakThreshold(), null);

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
// el comentario grande de _playSpeechWave de por qué eso no es robusto). El brillo
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

// Mismo criterio que _idleLandingColor pero en hue/sat/v — la usa la ola de
// SALIDA de un tracker de habla (_playSpeechOffset, ver _createSpeechTracker),
// que sí necesita el destino expresado en hue para poder interpolar.
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
  setBreathePeriodMs, getBreathePeriodMs,
  setHangoverMs, getHangoverMs,
  setOnsetDurationMs, getOnsetDurationMs,
  setOffsetDurationMs, getOffsetDurationMs,
  getDiagnostics, getRenderDiagnostics, test,
  idle: (...args) => _renderIdle(...args),
  getDeviceColor: () => DEVICE_COLOR,
  getColorSchemes: () => colorSchemes,
  setDeviceColor,
  setCustomColors,
  getCustomColors,
  hsvToRgb,
  hsvToRgbStd,
  previewBreathe,
};
