'use strict';

/**
 * lib/clap-connect.js
 *
 * Detector de "doble aplauso" para conectar a LiveKit sin tocar la pantalla.
 * PEDIDO PUNTUAL PARA UN EVENTO — pensado para sacarse después sin dejar
 * rastro: todo el detector vive en este único archivo; en server.js solo hay
 * un require() y dos líneas más, las tres marcadas con "CLAP-CONNECT" — para
 * desarmar la función, alcanza con borrar esas tres líneas y este archivo.
 *
 * Cómo funciona: reusa el MISMO nivel de mic (0-1, ya calculado cada ~100ms
 * por el monitor de mic idle de server.js — no abre un segundo arecord, que
 * de todos modos ALSA no dejaría con el device ya tomado) y busca un pico
 * corto y agudo — sube fuerte y baja rápido — a diferencia de hablar o
 * música, que se sostienen en el tiempo. Dos de esos picos separados por
 * menos de CLAP_WINDOW_MS entre sí cuentan como "doble aplauso" y disparan
 * el callback (ver onDoubleClap()).
 *
 * Los umbrales de acá abajo son un punto de partida razonable, no medidos en
 * el hardware real — puede hacer falta ajustarlos una vez probado en la Pi
 * (mic/HAT, distancia, ruido ambiente del lugar del evento).
 */

const PEAK_THRESHOLD  = 0.55; // nivel (0-1) que un aplauso típico cruza de sobra
const QUIET_THRESHOLD = 0.15; // tiene que volver a bajar de esto para dar el pico por "cerrado"
const REFRACTORY_MS   = 250;  // ignora picos nuevos un rato después de cerrar uno — evita contar la cola/eco del mismo aplauso como uno aparte
const CLAP_WINDOW_MS  = 1500; // los 2 aplausos tienen que caer dentro de esta ventana entre sí
const COOLDOWN_MS     = 4000; // después de disparar, no vuelve a intentar detectar por un rato — evita loop si algo sigue sonando fuerte (el propio "conectando" del agente, aplausos de gente alrededor, etc.)

let _armed         = true;  // setEnabled(false) lo desarma (ej. mientras ya hay sesión activa)
let _awaitingQuiet  = false; // true = ya cruzó el pico de arriba, esperando que baje para contarlo como un aplauso completo
let _lastClapAt     = 0;
let _firstClapAt    = 0;
let _lastTriggerAt  = 0;
let _onDoubleClap   = null;

function onDoubleClap(fn) { _onDoubleClap = fn; }

function setEnabled(v) {
  _armed = !!v;
  if (!_armed) { _awaitingQuiet = false; _firstClapAt = 0; }
}

// Llamar con el nivel de mic (0-1) en cada tick — pensado para engancharse
// al mismo loop que ya alimenta a leds.speaking() en el monitor de mic idle.
function feed(level) {
  if (!_armed) return;
  const now = Date.now();
  if (now - _lastTriggerAt < COOLDOWN_MS) return;

  if (!_awaitingQuiet) {
    if (level >= PEAK_THRESHOLD && now - _lastClapAt >= REFRACTORY_MS) {
      _awaitingQuiet = true;
    }
    return;
  }

  if (level <= QUIET_THRESHOLD) {
    _awaitingQuiet = false;
    _lastClapAt = now;
    if (!_firstClapAt || now - _firstClapAt > CLAP_WINDOW_MS) {
      _firstClapAt = now; // primer aplauso de una posible pareja
    } else {
      _firstClapAt = 0;
      _lastTriggerAt = now;
      console.log('[clap-connect] 👏👏 doble aplauso detectado — conectando');
      if (_onDoubleClap) {
        try { _onDoubleClap(); } catch (e) { console.warn('[clap-connect] callback error:', e.message); }
      }
    }
  }
}

module.exports = { feed, onDoubleClap, setEnabled };
