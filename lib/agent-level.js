// Nivel de la voz del agente medido en las charlas reales, para que las
// frases grabadas en la Pi (saludo, "no me pude conectar") suenen igual que
// el agente. Cada toma de ElevenLabs sale con su propio nivel: un saludo
// exclamado medía ~3 dB más que las respuestas (2026-11-06). El volumen del
// agente (speakerGain) se aplica después, igual que a la voz en vivo.
//
//   note(int16)    → suma un frame de la voz del agente (antes del volumen)
//   endSession()   → cierra la charla y actualiza el nivel guardado
//   matchGain(pcm) → cuánto multiplicar una frase grabada para igualarla
'use strict';
const fs   = require('fs');
const path = require('path');

const FILE  = path.join(__dirname, '..', 'data', 'agent-level.json');
const VOICE = 500;            // debajo de esto es silencio: no cuenta para el nivel
const MIN_SAMPLES = 48000;    // al menos 1 s de voz (48 kHz) para tomar la charla

let level = null;             // RMS de la voz del agente, promedio de las últimas charlas
try { level = JSON.parse(fs.readFileSync(FILE, 'utf8')).rms || null; } catch { /* primera vez */ }

let sum = 0, count = 0;

function note(samples) {
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s > VOICE || s < -VOICE) { sum += s * s; count++; }
  }
}

function endSession() {
  if (count >= MIN_SAMPLES) {
    const rms = Math.sqrt(sum / count);
    level = level ? level * 0.5 + rms * 0.5 : rms;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({ rms: Math.round(level), at: new Date().toISOString() }));
    } catch { /* sin disco: queda en memoria */ }
  }
  sum = 0; count = 0;
}

// RMS de voz de cada frase grabada (PCM 16 bits LE), calculado una vez.
const phraseRms = new WeakMap();
function rmsOf(pcm) {
  let r = phraseRms.get(pcm);
  if (r === undefined) {
    let s = 0, n = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i);
      if (v > VOICE || v < -VOICE) { s += v * v; n++; }
    }
    r = n ? Math.sqrt(s / n) : 0;
    phraseRms.set(pcm, r);
  }
  return r;
}

function matchGain(pcm) {
  const r = rmsOf(pcm);
  if (!level || !r) return 1;   // todavía no hubo una charla para medir
  return Math.max(0.25, Math.min(2, level / r));
}

module.exports = { note, endSession, matchGain, current: () => level };
