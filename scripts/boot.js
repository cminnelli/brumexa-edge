'use strict';

// scripts/boot.js
//
// Entrypoint genérico de "arranque temprano" — lo que Brumexa necesita hacer
// ANTES de que PM2/Node terminen de levantar server.js (ver
// scripts/brumexa-boot.service: arranca lo antes posible en el boot, mucho
// antes que PM2, que depende de red/multi-user.target). Si en el futuro hay
// otra cosa que necesite correr temprano (no LEDs), agregarla ACÁ — así el
// service de systemd queda genérico y no hay que tocarlo de nuevo.
//
// Por ahora lo único que hace es dar señal visual (cometa cian — la misma
// animación de "conectando" que se ve al unirse a LiveKit, leds.connecting())
// mientras arranca — sin esto, entre que prende la Pi y que server.js llega a
// `leds.init()` (ver server.js), pasan varios segundos sin ninguna luz.
// Reusar esa misma animación (en vez de inventar una nueva) es a propósito:
// el usuario ya sabe leerla como "esperá, algo está cargando".
//
// Se apaga SOLO apenas detecta que server.js ya está escuchando en el puerto
// — el NeoPixel es un solo GPIO/DMA, no lo pueden manejar dos procesos a la
// vez, así que este script tiene que soltarlo antes de que leds.init() en
// server.js intente tomarlo.
//
// Si el boot se cuelga y server.js nunca levanta, después de MAX_WAIT_MS pasa
// a la animación de error (rojo) en vez de seguir "respirando" como si nada
// — sino el usuario ve una luz de "todo bien" con el dispositivo en realidad
// colgado.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const net  = require('net');
const leds = require('../lib/leds');

const PORT           = parseInt(process.env.PORT, 10) || 3000;
const POLL_MS         = 500;
const MAX_WAIT_MS     = 90000; // si server.js no levantó en 90s, algo está mal
const INIT_RETRY_MS   = 400;
const INIT_MAX_RETRIES = 8; // ~3.2s de margen por si /dev/spidev0.0 todavía no está listo tan temprano en el boot

// Tan temprano en el boot, el device node de SPI puede no estar listo todavía
// — reintenta un par de veces en vez de rendirse en el primer intento.
function initLedsWithRetry(retriesLeft = INIT_MAX_RETRIES) {
  leds.init(); // configura ws281x (arranca breathe() por default, lo pisamos abajo)
  if (leds.getDiagnostics().configured) {
    leds.connecting(); // cometa cian de "cargando", lo antes posible
    return;
  }
  if (retriesLeft <= 0) return;
  setTimeout(() => initLedsWithRetry(retriesLeft - 1), INIT_RETRY_MS);
}

initLedsWithRetry();

const startedAt = Date.now();
let stopped = false;

function checkServerUp() {
  if (stopped) return;

  const sock = net.createConnection({ port: PORT, host: '127.0.0.1', timeout: 800 });

  sock.once('connect', () => {
    sock.end();
    stopped = true;
    clearInterval(_poll);
    // server.js ya está escuchando y va a llamar a su PROPIO leds.init() de
    // un momento a otro — mismo GPIO/DMA, pero desde un proceso de Node
    // DISTINTO. Antes se salía con process.exit(0) directo, sin soltar el
    // recurso de verdad (ws281x.reset(), que hace leds.cleanup()) — un
    // "no hace falta, server.js va a pisar el estado visual igual" que
    // confundía "se ve bien" con "el DMA quedó bien liberado". Si el driver
    // nativo no libera ese canal DMA prolijamente antes de que el OTRO
    // proceso lo vuelva a configurar, el hardware puede quedar en un estado
    // raro que se manifiesta como glitches intermitentes más adelante, no
    // necesariamente en el momento — coincide con el patrón reportado
    // ("tarda en aparecer, sin relación con nada que se esté haciendo").
    // El brevísimo cuadro negro que esto agrega antes de salir es un costo
    // aceptable frente a arrancar con el DMA en un estado potencialmente
    // inconsistente durante toda la sesión.
    leds.cleanup();
    process.exit(0);
  });

  sock.once('error',   () => sock.destroy());
  sock.once('timeout', () => sock.destroy());
}

const _poll = setInterval(() => {
  if (Date.now() - startedAt >= MAX_WAIT_MS) {
    stopped = true;
    clearInterval(_poll);
    console.warn(`[boot] server.js no levantó en ${MAX_WAIT_MS / 1000}s — paso a aviso de error`);
    leds.brumexaError();
    return; // dejamos el proceso vivo mostrando el rojo hasta que alguien reinicie o mate el servicio
  }
  checkServerUp();
}, POLL_MS);

// Si systemd corta este proceso por otra vía (stop/restart del servicio,
// no el handoff normal de arriba) — mismo motivo: soltar el DMA prolijo
// en vez de dejar que el proceso muera sin avisarle al driver nativo.
process.on('SIGTERM', () => { leds.cleanup(); process.exit(0); });
process.on('SIGINT',  () => { leds.cleanup(); process.exit(0); });
