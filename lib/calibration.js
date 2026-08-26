'use strict';

/**
 * lib/calibration.js
 *
 * Dueño único de "medir el ambiente y fijar el umbral de voz" — antes esta
 * orquestación vivía suelta en server.js (runCalibration(), el "último
 * resultado", y la decisión de si recalibrar solo al arrancar). Se junta
 * acá para que haya un solo lugar donde entender "qué pasa cuando se
 * calibra", con nombres que digan qué hacen.
 *
 * lib/mic-calibration.js (el algoritmo de medición en sí — busca el tramo
 * más silencioso de una grabación) NO se fusiona acá a propósito: también
 * lo usa lib/livekit-session.js (la constante POP_SETTLE_MS, para el
 * "pum" del HAT al abrir el mic), así que sigue siendo su propio módulo de
 * más abajo. Este archivo es la capa de arriba: usa esa medición, la
 * convierte en un umbral, lo persiste, actualiza LEDs/detector, y guarda
 * el historial.
 *
 * Dependencias inyectadas (mismo patrón que ya usa setupConfiguracion() en
 * lib/configuracion.js) en vez de leer variables globales de server.js —
 * así este módulo no depende de CÓMO server.js arma su propio estado
 * (arecord del monitor idle, etc.), solo de la interfaz que necesita.
 */

const fs = require('fs');
const { measureNoiseFloor } = require('./mic-calibration');
const calibrationHistory = require('./calibration-history');

// Margen sobre el tramo más silencioso medido. Clamps para que un
// ambiente rarísimo (ruidoso o insólitamente silencioso) no empuje el
// umbral fuera de un rango razonable.
// Ventana de 8s (no 4s): con más datos, la búsqueda del tramo contiguo más
// silencioso tiene más chances de encontrar un tramo realmente
// representativo del ambiente, no solo un instante de suerte.
// Margen de 7dB (no 10): con 10dB, en un ambiente medido real la voz
// quedaba apenas ~1dB por encima del umbral resultante (log real: piso
// -42dBFS → umbral -32dBFS, voz hablando a -31dBFS), tan pegado que
// cualquier variación normal de volumen dentro de una frase caía por
// debajo y disparaba entradas/salidas de "hablando" en vez de una sola
// detección sostenida. El colchón contra ruido puntual sigue estando — lo
// dan ONSET_MIN_STREAK (~300ms sostenidos para declarar inicio) y el
// hangover (paciencia) en lib/mic-speech-gate.js, no dependen solo de
// este margen.
const MARGIN_DB   = 7;
const DURATION_MS = 8000;
const MIN_DBFS    = -45;
const MAX_DBFS    = -12;

// createCalibrationRunner({ lkSession, leds, getEnvVal, setEnvLine, envFile,
// startMicMonitor, stopMicMonitor }) — construye las funciones de
// calibración con sus dependencias ya cerradas adentro (closure), en vez
// de pasarlas en cada llamado.
function createCalibrationRunner({ lkSession, leds, getEnvVal, setEnvLine, envFile, startMicMonitor, stopMicMonitor }) {
  // Último resultado — lo lee /configuracion/status para mostrarlo en el panel.
  let _lastCalibration = null;
  function getLastCalibration() { return _lastCalibration; }

  // triggeredBy: 'boot' (automático al arrancar) | 'manual' (botón
  // "Recalibrar ahora") | 'guided' (lo agrega el wizard aparte, ver
  // POST /diag/calibration-history en server.js — el wizard no pasa por
  // esta función, aplica el umbral directo vía /setup/config).
  async function runCalibration(triggeredBy = 'manual') {
    if (process.platform !== 'linux') throw new Error('Calibración solo disponible en Linux');
    if (lkSession.isActive()) throw new Error('Hay una sesión activa — no se puede calibrar ahora');

    await stopMicMonitor();
    leds.calibrating();  // parpadeo + cometa sostenido mientras mide
    await new Promise(r => setTimeout(r, leds.CALIBRATION_COUNTDOWN_MS));

    const device = getEnvVal('MIC_ALSA_DEVICE') || 'plughw:0,0';
    let result;
    try {
      result = await measureNoiseFloor({
        device,
        durationMs: DURATION_MS,
        gain: lkSession.getMicGain(),
      });
    } catch (err) {
      leds.calibrationDone(false);
      startMicMonitor();
      throw err;
    }

    const rawThreshold = result.noiseFloorDbfs + MARGIN_DB;
    // Redondeado a 1 decimal ACÁ, antes de aplicarlo — si no, el float con
    // toda su precisión (ej. -27.053576989202497) se cuela a los logs de
    // lk-session/leds, que loguean lo que reciben tal cual.
    const threshold = Math.round(Math.min(MAX_DBFS, Math.max(MIN_DBFS, rawThreshold)) * 10) / 10;

    lkSession.setTalkThreshold(threshold);
    leds.setSpeakThresholdDbfs(threshold);

    // Persistir para el próximo arranque — mismo patrón que /setup/config/live.
    try {
      let content = '';
      try { content = fs.readFileSync(envFile, 'utf8'); } catch {}
      content = setEnvLine(content, 'MIC_TALK_THRESHOLD_DBFS', threshold.toFixed(1));
      fs.writeFileSync(envFile, content, 'utf8');
    } catch (err) {
      console.warn('[calibration] no se pudo persistir en .env:', err.message);
    }

    _lastCalibration = {
      noiseFloorDbfs: Math.round(result.noiseFloorDbfs * 10) / 10,
      threshold:      Math.round(threshold * 10) / 10,
      marginDb:       MARGIN_DB,
      durationMs:     DURATION_MS,
      sampleCount:    result.ticks.length,
      measuredAt:     Date.now(),
      triggeredBy,
      // Serie completa (no solo el resumen) — para el sparkline en /configuracion.
      // Solo se guarda la última corrida, se pisa en la próxima (igual que el resto de este objeto).
      ticksDbfs: result.ticksDbfs.map(v => Math.round(v * 10) / 10),
    };

    console.log(`[calibration] piso=${result.noiseFloorDbfs.toFixed(1)}dBFS → umbral=${threshold.toFixed(1)}dBFS (margen ${MARGIN_DB}dB, ${triggeredBy})`);

    // Historial en disco (logs/calibration-history.jsonl) — a diferencia de
    // _lastCalibration (se pisa acá arriba en cada corrida), esto se acumula.
    // Sin ticksDbfs (la serie completa): eso es solo para el sparkline de la
    // corrida MÁS RECIENTE, no hace falta guardarlo para cada una del historial.
    calibrationHistory.appendCalibration({
      measuredAt:     _lastCalibration.measuredAt,
      triggeredBy:    _lastCalibration.triggeredBy,
      noiseFloorDbfs: _lastCalibration.noiseFloorDbfs,
      threshold:      _lastCalibration.threshold,
      marginDb:       _lastCalibration.marginDb,
    });

    leds.calibrationDone(true);
    startMicMonitor();
    return _lastCalibration;
  }

  // Se llama UNA vez, al arrancar el server (Linux). Corre la medición
  // ciega SOLO si todavía no hay ningún umbral guardado — instalación
  // nueva, primera vez que este dispositivo arranca. Si ya hay uno
  // (de un boot anterior, del wizard, o fijado a mano), lo respeta y NO
  // recalibra solo — antes esto corría siempre y pisaba en cada reinicio
  // cualquier umbral más preciso que hubiera, reportado como "no
  // persiste" (en realidad sí se guardaba bien, el problema era que se
  // volvía a pisar en el próximo arranque). runCalibration() ya arranca
  // el monitor de mic idle al final — si se salta, hay que arrancarlo acá
  // para no perder ese paso.
  function runBootCalibrationIfNeeded() {
    if (process.env.MIC_TALK_THRESHOLD_DBFS) {
      console.log(`[calibration] ya hay un umbral guardado (${process.env.MIC_TALK_THRESHOLD_DBFS}dBFS) — no se recalibra solo al arrancar`);
      startMicMonitor();
      return;
    }
    runCalibration('boot').catch(err => console.warn('[calibration] boot falló:', err.message));
  }

  return { runCalibration, getLastCalibration, runBootCalibrationIfNeeded };
}

module.exports = { createCalibrationRunner, MARGIN_DB, DURATION_MS, MIN_DBFS, MAX_DBFS };
