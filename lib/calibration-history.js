'use strict';

/**
 * lib/calibration-history.js
 *
 * Registro de cada corrida de calibración (boot o manual) — a diferencia de
 * _lastCalibration en server.js (que solo guarda la ÚLTIMA, se pisa en la
 * siguiente), esto persiste una línea por corrida para poder comparar cómo
 * cambió el umbral entre distintos días/ambientes con el tiempo. Mismo lugar
 * (logs/) y espíritu que logs/wifi-debug.log (lib/wifi.js), pero JSON-Lines
 * en vez de texto libre — acá cada línea es un objeto completo, así que el
 * cap se hace por CANTIDAD de líneas (recortar a la mitad de un JSON a mitad
 * de línea, como hace wifi-debug.log con bytes, lo rompería).
 */

const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'logs', 'calibration-history.jsonl');
const MAX_ENTRIES   = 500; // de sobra para ver tendencia — como mucho una corrida por día

function appendCalibration(entry) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');

    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_ENTRIES) {
      fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf8');
    }
  } catch (e) {
    console.warn('[calibration-history] no se pudo guardar:', e.message);
  }
}

function readCalibrationHistory(limit = 200) {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { appendCalibration, readCalibrationHistory };
