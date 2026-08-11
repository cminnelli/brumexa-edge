'use strict';

/**
 * lib/mic-calibration.js
 *
 * Mide el piso de ruido ambiente grabando un tramo corto de mic crudo
 * (mismo device/gain que usa el resto de la app) y devuelve el PEOR pico
 * observado en dBFS — no el promedio. Un umbral puesto en el promedio deja
 * la mitad de los picos de ruido por encima suyo, disparando igual; puesto
 * por encima del peor pico observado, un margen chico ya alcanza.
 *
 * Puro: no toca leds ni thresholds — server.js decide qué hacer con el
 * resultado (setTalkThreshold, persistir en .env, etc.).
 */

const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
const TICK_MS      = 100;  // mismo ritmo que STATS_TICK_MS en livekit-session.js

// arecord suele meter un pop/click de inicialización del dispositivo en los
// primeros milisegundos (artefacto de ALSA, no ruido real del ambiente) —
// como tomamos el PEOR pico de toda la ventana a propósito, ese único pico
// artificial alcanza para arruinar TODA la medición si no se descarta.
const WARMUP_MS = 300;

function measureNoiseFloor({ device = 'plughw:0,0', durationMs = 4000, warmupMs = WARMUP_MS, gain = 1.0 } = {}) {
  return new Promise((resolve, reject) => {
    const proc      = spawn('arecord', ['-D', device, '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', '1', '-t', 'raw', '-q']);
    const startedAt = Date.now();

    let tickPeak  = 0;
    let worstPeak = 0;
    let lastTick  = Date.now();
    const ticks   = [];
    let settled   = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGTERM'); } catch {}
      if (err) return reject(err);
      const noiseFloorDbfs = worstPeak > 0 ? 20 * Math.log10(worstPeak / 32767) : -120;
      resolve({ noiseFloorDbfs, worstPeak, ticks, durationMs, warmupMs });
    };

    proc.on('error', err => finish(err));
    proc.stdout.on('data', chunk => {
      if (Date.now() - startedAt < warmupMs) return;  // descartar el pop de arranque

      for (let i = 0; i < chunk.length - 1; i += 2) {
        let s = Math.abs(chunk.readInt16LE(i)) * gain;
        if (s > 32767) s = 32767;  // el gain de software puede pasarse del rango int16 — no dejar que se filtre un dBFS "imposible" (>0) al resultado
        if (s > tickPeak) tickPeak = s;
      }
      if (Date.now() - lastTick > TICK_MS) {
        ticks.push(tickPeak);
        if (tickPeak > worstPeak) worstPeak = tickPeak;
        tickPeak = 0;
        lastTick = Date.now();
      }
    });

    const timer = setTimeout(() => finish(null), durationMs);
  });
}

module.exports = { measureNoiseFloor, WARMUP_MS };
