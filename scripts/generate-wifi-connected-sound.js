'use strict';

/**
 * Genera sounds/wifi_conectado.wav — dos barridos ascendentes cortos (chirps,
 * no notas fijas) con armónicos, para que suene más digital/sintético que un
 * arpegio de xilófono. Suena cuando el dispositivo activa su propio AP de
 * aprovisionamiento O se conecta con éxito a la red WiFi real del usuario
 * (ver playWifiConnectedSound() en lib/sound-effects.js).
 *
 * Sin dependencias externas: sintetiza con Math.sin y escribe el WAV a mano
 * (header PCM16LE de 44 bytes). Correr con:
 *   node scripts/generate-wifi-connected-sound.js
 *
 * Es solo un placeholder — reemplazá sounds/wifi_conectado.wav por
 * cualquier otro .wav si querés un sonido distinto, no hace falta tocar
 * código para eso.
 */

const fs   = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const FADE_MS     = 10;  // raised-cosine in/out por chirp, evita clicks
const AMPLITUDE   = 0.35; // fracción de full-scale (int16) — más bajo que antes (0.6)

// Cada chirp barre de freqStart a freqEnd (no un tono fijo — eso es lo que
// le da el aire "digital/sintético" en vez de sonar a xilófono) y suma
// armónicos (múltiplos de la frecuencia instantánea) para una textura más
// rica que un seno puro. Se normaliza por la suma de amplitudes de los
// armónicos para no arriesgar clipping antes de aplicar AMPLITUDE.
function renderChirp(freqStart, freqEnd, durationMs, harmonics) {
  const n = Math.round(SAMPLE_RATE * durationMs / 1000);
  const fadeSamples = Math.round(SAMPLE_RATE * FADE_MS / 1000);
  const T = durationMs / 1000;
  const harmonicsSum = harmonics.reduce((s, h) => s + h.amp, 0);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Fase instantánea integrada (no solo 2π·f(t)·t) — así el barrido de
    // frecuencia es continuo, sin saltos de fase.
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
  // Armónicos: fundamental + 2º y 3er múltiplo, suaves — da un timbre
  // "sintetizador" en vez de un seno limpio (que suena más a flauta/campana).
  const HARMONICS = [{ mult: 1, amp: 1 }, { mult: 2, amp: 0.22 }, { mult: 3, amp: 0.09 }];

  const chunks = [
    renderChirp(420, 840,  130, HARMONICS),  // barrido 1: sube una octava
    renderSilence(20),
    renderChirp(640, 1280, 110, HARMONICS),  // barrido 2: más corto y más agudo — remata la idea de "enlazado"
  ];
  const samples = concatInt16(chunks);

  const outDir = path.join(__dirname, '..', 'sounds');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'wifi_conectado.wav');
  writeWavFile(outPath, samples, SAMPLE_RATE);

  const durationMs = Math.round(samples.length / SAMPLE_RATE * 1000);
  console.log(`[generate-wifi-connected-sound] Escrito ${outPath} — ${durationMs}ms, ${samples.length} samples`);
}

main();
