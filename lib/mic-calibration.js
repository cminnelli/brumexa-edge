'use strict';

/**
 * lib/mic-calibration.js
 *
 * Mide el piso de ruido ambiente grabando un tramo corto de mic crudo
 * (mismo device/gain que usa el resto de la app) y busca, dentro de toda
 * la ventana grabada, el TRAMO CONTIGUO MÁS SILENCIOSO de ~1 segundo —
 * no un percentil sobre toda la ventana.
 *
 * Por qué: se probó con percentil (ignorar el X% más ruidoso de todos los
 * ticks) y se vieron DOS formas distintas de contaminación en corridas
 * reales, que un percentil fijo no cubre las dos a la vez:
 *   1. Un pop del HAT al abrir el device, que decae al principio de la
 *      ventana (los primeros ~4-9 ticks).
 *   2. Ruido real sostenido a la mitad de la ventana (alguien se mueve,
 *      habla, ruido de fondo) — en un caso ocupó casi el 50% de los ticks,
 *      mucho más de lo que cualquier percentil razonable descarta.
 * Buscar el mejor tramo contiguo de ~1s resuelve los dos casos con la
 * misma lógica, sin tener que adivinar de antemano DÓNDE va a estar el
 * problema dentro de la ventana.
 *
 * Puro: no toca leds ni thresholds — server.js decide qué hacer con el
 * resultado (setTalkThreshold, persistir en .env, etc.).
 */

const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
const TICK_MS      = 100;  // mismo ritmo que STATS_TICK_MS en livekit-session.js

// Colchón chico contra basura de los primerísimos ms de un device recién
// abierto — ya no es la defensa principal contra el pop ACÁ (eso lo hace
// la ventana deslizante de abajo, que puede ignorar el pop esté donde
// esté dentro de la ventana), solo una precaución barata para esta función.
const WARMUP_MS = 300;

// Distinto de WARMUP_MS: esto lo usan server.js (monitor de mic idle) y
// livekit-session.js (mic de sesión real) para ignorar picos justo después
// de abrir SU PROPIO arecord — esos lugares comparan en tiempo real contra
// el threshold, sin la ventana deslizante de acá, así que necesitan cubrir
// toda la cola observada del pop (~900ms-1.2s) para no leerla como voz.
// Bajado a la punta más corta del rango medido (900ms, no 1200ms): si
// alguien empieza a hablar justo al arrancar una sesión nueva, esta ventana
// es exactamente el retraso que espera antes de poder detectar "empezó a
// hablar" — a 1200ms se sentía como un segundo entero de nada antes de que
// arranque la ola de LEDs. Si el pop del HAT vuelve a colarse como falso
// "hablando" al arrancar sesión, subir de nuevo hacia 1200ms.
const POP_SETTLE_MS = 900;

// Tamaño del tramo contiguo que se busca, en ticks (~1s a 100ms/tick).
const FLOOR_WINDOW_TICKS = 10;

// Promedio del tramo de `windowTicks` ticks consecutivos con el promedio
// MÁS BAJO dentro de toda la serie — el tramo contiguo más silencioso,
// esté al principio, al medio o al final.
function _quietestWindowAvg(ticks, windowTicks) {
  if (!ticks.length) return 0;
  if (ticks.length <= windowTicks) {
    return ticks.reduce((a, b) => a + b, 0) / ticks.length;
  }
  let best = Infinity;
  for (let start = 0; start <= ticks.length - windowTicks; start++) {
    let sum = 0;
    for (let i = start; i < start + windowTicks; i++) sum += ticks[i];
    const avg = sum / windowTicks;
    if (avg < best) best = avg;
  }
  return best;
}

function measureNoiseFloor({ device = 'plughw:0,0', durationMs = 4000, warmupMs = WARMUP_MS, windowTicks = FLOOR_WINDOW_TICKS, gain = 1.0 } = {}) {
  return new Promise((resolve, reject) => {
    const proc      = spawn('arecord', ['-D', device, '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', '1', '-t', 'raw', '-q']);
    const startedAt = Date.now();

    let tickPeak  = 0;
    let lastTick  = Date.now();
    const ticks   = [];
    let settled   = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGTERM'); } catch {}
      if (err) return reject(err);
      const floorPeak       = _quietestWindowAvg(ticks, windowTicks);
      const worstPeak       = ticks.length ? Math.max(...ticks) : 0;
      const noiseFloorDbfs  = floorPeak > 0 ? 20 * Math.log10(floorPeak / 32767) : -120;
      // Serie completa en dBFS, en el mismo orden que se midió — para
      // mostrar cómo evolucionó la ventana (sparkline en /configuracion),
      // no solo el resumen de 5 números.
      const ticksDbfs = ticks.map(p => p > 0 ? 20 * Math.log10(p / 32767) : -120);
      resolve({ noiseFloorDbfs, floorPeak, worstPeak, ticks, ticksDbfs, durationMs, warmupMs, windowTicks });
    };

    proc.on('error', err => finish(err));
    proc.stdout.on('data', chunk => {
      // finish() ya mató el proceso, pero SIGTERM no corta el pipe al
      // instante — puede seguir llegando data en tránsito. Sin este guard,
      // ese resto seguía logueando/empujando a `ticks` después de haber
      // resuelto la promesa (se vio en un log real: "tick 23" apareciendo
      // DESPUÉS de la línea de resumen "[calibration] piso=...").
      if (settled) return;
      if (Date.now() - startedAt < warmupMs) return;  // colchón mínimo de arranque

      for (let i = 0; i < chunk.length - 1; i += 2) {
        let s = Math.abs(chunk.readInt16LE(i)) * gain;
        if (s > 32767) s = 32767;  // el gain de software puede pasarse del rango int16 — no dejar que se filtre un dBFS "imposible" (>0) al resultado
        if (s > tickPeak) tickPeak = s;
      }
      if (Date.now() - lastTick > TICK_MS) {
        const dbfs = tickPeak > 0 ? 20 * Math.log10(tickPeak / 32767) : -120;
        console.log(`[mic-calibration] tick ${ticks.length + 1} → ${dbfs.toFixed(1)}dBFS`);
        ticks.push(tickPeak);
        tickPeak = 0;
        lastTick = Date.now();
      }
    });

    const timer = setTimeout(() => finish(null), durationMs);
  });
}

module.exports = { measureNoiseFloor, WARMUP_MS, POP_SETTLE_MS, FLOOR_WINDOW_TICKS };
