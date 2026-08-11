'use strict';

/**
 * lib/mic-calibration.js
 *
 * Mide el piso de ruido ambiente grabando un tramo corto de mic crudo
 * (mismo device/gain que usa el resto de la app) y devuelve un percentil
 * alto de los picos observados en dBFS — no el promedio (dejaría la mitad
 * de los picos por encima suyo, disparando igual) ni el máximo absoluto
 * (este HAT de audio mete un "pum" audible por el parlante, que el mic
 * capta, CADA VEZ que se abre arecord — no es un evento único de arranque,
 * así que el máximo absoluto queda contaminado por ese pop con demasiada
 * frecuencia). El percentil 90 ignora ese puñado de ticks anómalos sin
 * dejar de ser conservador contra el ruido ambiente real y sostenido.
 *
 * Puro: no toca leds ni thresholds — server.js decide qué hacer con el
 * resultado (setTalkThreshold, persistir en .env, etc.).
 */

const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
const TICK_MS      = 100;  // mismo ritmo que STATS_TICK_MS en livekit-session.js

// El pop del códec al abrir el device puede seguir sonando (con la cola
// acústica del ambiente) más de lo esperado — 500ms de margen antes de
// empezar a contar, sumado al percentil (no el máximo) como segunda red.
const WARMUP_MS = 500;

// Qué percentil de los ticks se usa como "piso de ruido" — 0.9 = ignora el
// 10% más alto de las lecturas.
const FLOOR_PERCENTILE = 0.9;

function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx];
}

function measureNoiseFloor({ device = 'plughw:0,0', durationMs = 4000, warmupMs = WARMUP_MS, percentile = FLOOR_PERCENTILE, gain = 1.0 } = {}) {
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
      const floorPeak       = _percentile([...ticks].sort((a, b) => a - b), percentile);
      const worstPeak       = ticks.length ? Math.max(...ticks) : 0;
      const noiseFloorDbfs  = floorPeak > 0 ? 20 * Math.log10(floorPeak / 32767) : -120;
      // Serie completa en dBFS, en el mismo orden que se midió — para
      // mostrar cómo evolucionó la ventana (sparkline en /configuracion),
      // no solo el resumen de 5 números.
      const ticksDbfs = ticks.map(p => p > 0 ? 20 * Math.log10(p / 32767) : -120);
      resolve({ noiseFloorDbfs, floorPeak, worstPeak, ticks, ticksDbfs, durationMs, warmupMs, percentile });
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

module.exports = { measureNoiseFloor, WARMUP_MS, FLOOR_PERCENTILE };
