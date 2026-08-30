'use strict';

/**
 * Genera sounds/livekit_conectado.wav — barrido agudo hacia arriba seguido
 * de un remate corto hacia abajo (forma "sube-baja", distinta del "sube-sube"
 * de wifi_conectado.wav para que se puedan diferenciar a oído) con
 * armónicos, para que suene más digital/sintético que un ping de xilófono.
 * Suena cuando el agente de LiveKit confirma que está en la sala y ya se lo
 * puede escuchar (ver buildLivekitChimePcm() en lib/sound-effects.js, y el
 * evento 'agent-audio' en server.js — NO el 'connected' de la sala, que solo
 * confirma el transporte, no al agente).
 *
 * SAMPLE_RATE = 48000, a propósito, NO 44100 como wifi_conectado.wav: este
 * chime no abre su propio aplay — server.js lo escribe directo en el mismo
 * pipe que lib/livekit-session.js ya tiene abierto para la voz del agente
 * (ver playChime()/getSpeakerFormat() ahí), que corre fijo a 48000Hz mono.
 * Si este archivo no matchea ese sampleRate, sound-effects.js lo descarta
 * en vez de meterlo a destiempo/tono incorrecto en ese pipe — no cambies
 * este valor sin cambiar también SPEAKER_SAMPLE_RATE en livekit-session.js.
 *
 * Mismo enfoque que scripts/generate-wifi-connected-sound.js: sin
 * dependencias externas, sintetiza con Math.sin y escribe el WAV a mano.
 * Correr con:
 *   node scripts/generate-livekit-connected-sound.js
 *
 * Es solo un placeholder — reemplazá sounds/livekit_conectado.wav por
 * cualquier otro .wav (mismo sampleRate/mono) si querés un sonido distinto,
 * no hace falta tocar código para eso.
 */

const fs   = require('fs');
const path = require('path');

const SAMPLE_RATE = 48000;
const FADE_MS     = 8;   // raised-cosine in/out por chirp, evita clicks
const AMPLITUDE   = 0.35; // fracción de full-scale (int16) — más bajo que antes (0.6);
                          // el gain en vivo (ver server.js, Math.min(speakerGain, 1.6))
                          // sigue aplicándose arriba de este piso más bajo.

// Cada chirp barre de freqStart a freqEnd (no un tono fijo) y suma armónicos
// (múltiplos de la frecuencia instantánea) para una textura más rica que un
// seno puro — se normaliza por la suma de amplitudes de los armónicos para
// no arriesgar clipping antes de aplicar AMPLITUDE.
function renderChirp(freqStart, freqEnd, durationMs, harmonics) {
  const n = Math.round(SAMPLE_RATE * durationMs / 1000);
  const fadeSamples = Math.round(SAMPLE_RATE * FADE_MS / 1000);
  const T = durationMs / 1000;
  const harmonicsSum = harmonics.reduce((s, h) => s + h.amp, 0);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Fase instantánea integrada — el barrido de frecuencia queda continuo,
    // sin saltos de fase (ver el mismo cálculo en generate-wifi-connected-sound.js).
    const phase = 2 * Math.PI * (freqStart * t + (freqEnd - freqStart) * t * t / (2 * T));
    let v = 0;
    for (const h of harmonics) v += h.amp * Math.sin(h.mult * phase);
    v /= harmonicsSum;

    let env = 1;
    if (i < fadeSamples) env = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
    else if (i > n - fadeSamples) env = 0.5 * (1 - Math.cos(Math.PI * (n - i) / fadeSamples));
    v *= env * AMPLITUDE;
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return samples;
}

function renderSilence(durationMs) {
  return new Int16Array(Math.round(SAMPLE_RATE * durationMs / 1000));
}

function concatInt16(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function writeWavFile(filePath, samples, sampleRate) {
  const dataSize = samples.length * 2; // 16 bits = 2 bytes/sample
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);            // tamaño del sub-chunk fmt
  header.writeUInt16LE(1, 20);             // PCM
  header.writeUInt16LE(1, 22);             // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16 bits)
  header.writeUInt16LE(2, 32);              // block align
  header.writeUInt16LE(16, 34);             // bits/sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const dataBuf = Buffer.from(samples.buffer, samples.byteOffset, dataSize);
  fs.writeFileSync(filePath, Buffer.concat([header, dataBuf]));
}

function main() {
  // Armónicos con un poco más de 2º/4º que el de WiFi (salta el 3º) — le da
  // un filo levemente más metálico, para que también se distingan por
  // textura y no solo por la forma del barrido.
  const HARMONICS = [{ mult: 1, amp: 1 }, { mult: 2, amp: 0.3 }, { mult: 4, amp: 0.1 }];

  const chunks = [
    renderChirp(760, 1600, 100, HARMONICS), // barrido hacia arriba — "enlazando"
    renderSilence(10),
    renderChirp(1600, 1250, 55, HARMONICS), // remate corto hacia abajo — "listo", distinto del sube-sube de WiFi
  ];
  const samples = concatInt16(chunks);

  const outDir = path.join(__dirname, '..', 'sounds');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'livekit_conectado.wav');
  writeWavFile(outPath, samples, SAMPLE_RATE);

  const durationMs = Math.round(samples.length / SAMPLE_RATE * 1000);
  console.log(`[generate-livekit-connected-sound] Escrito ${outPath} — ${durationMs}ms, ${samples.length} samples`);
}

main();
