'use strict';

/**
 * Genera sounds/wifi_ap_activado.wav — arpegio ascendente corto (3 notas)
 * que suena cuando el dispositivo activa su propio Access Point de
 * aprovisionamiento (ver playApReadySound() en lib/sound-effects.js).
 *
 * Sin dependencias externas: sintetiza el tono con Math.sin y escribe el
 * WAV a mano (header PCM16LE de 44 bytes). Correr con:
 *   node scripts/generate-ap-ready-sound.js
 *
 * Es solo un placeholder — reemplazá sounds/wifi_ap_activado.wav por
 * cualquier otro .wav si querés un sonido distinto, no hace falta tocar
 * código para eso.
 */

const fs   = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const NOTES_HZ    = [523.25, 659.25, 783.99]; // Do5 - Mi5 - Sol5
const NOTE_MS     = 120;
const GAP_MS      = 20;
const FADE_MS     = 12; // raised-cosine in/out por nota, evita clicks
const AMPLITUDE   = 0.6; // fracción de full-scale (int16)

function renderNote(freqHz, durationMs) {
  const n = Math.round(SAMPLE_RATE * durationMs / 1000);
  const fadeSamples = Math.round(SAMPLE_RATE * FADE_MS / 1000);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < fadeSamples) env = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
    else if (i > n - fadeSamples) env = 0.5 * (1 - Math.cos(Math.PI * (n - i) / fadeSamples));
    const t = i / SAMPLE_RATE;
    const v = Math.sin(2 * Math.PI * freqHz * t) * env * AMPLITUDE;
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
  const chunks = [];
  NOTES_HZ.forEach((freq, i) => {
    chunks.push(renderNote(freq, NOTE_MS));
    if (i < NOTES_HZ.length - 1) chunks.push(renderSilence(GAP_MS));
  });
  const samples = concatInt16(chunks);

  const outDir = path.join(__dirname, '..', 'sounds');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'wifi_ap_activado.wav');
  writeWavFile(outPath, samples, SAMPLE_RATE);

  const durationMs = Math.round(samples.length / SAMPLE_RATE * 1000);
  console.log(`[generate-ap-ready-sound] Escrito ${outPath} — ${durationMs}ms, ${samples.length} samples`);
}

main();
