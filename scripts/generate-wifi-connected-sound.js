'use strict';

/**
 * Genera sounds/wifi_conectado.wav — dos "blips" FM cortos y percusivos (no
 * un barrido de tono puro, que terminaba sonando a silbido) que suena cuando
 * el dispositivo activa su propio AP de aprovisionamiento O se conecta con
 * éxito a la red WiFi real del usuario (ver playWifiConnectedSound() en
 * lib/sound-effects.js).
 *
 * Síntesis FM (modulación de frecuencia: sin(carrier + index·sin(mod))) en
 * vez de un seno/barrido simple — es lo que le da el carácter "digital/
 * sintetizador" (metálico, inarmónico) en vez de sonar a flauta o silbido.
 * Envolvente percusiva (ataque rápido + decaimiento tipo potencia, no un
 * fade simétrico) para que suene a "blip" corto, no a tono sostenido.
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
const AMPLITUDE   = 0.4; // fracción de full-scale (int16)

// FM: sin(2π·carrierHz·t + modIndex·sin(2π·modHz·t)) — el propio seno de FM
// ya queda acotado a [-1,1] sin importar modIndex, no hace falta normalizar
// como con la suma de armónicos. attackMs = subida rápida (raised-cosine);
// el resto del blip decae como (1-rel)^decayShape — decayShape alto (2-3)
// da una caída rápida-al-principio típica de un "blip" percusivo, no un
// tono sostenido que se apaga recién al final (eso es lo que sonaba a
// silbido).
function renderFmBlip(carrierHz, modHz, modIndex, durationMs, attackMs, decayShape) {
  const n = Math.round(SAMPLE_RATE * durationMs / 1000);
  const attackSamples = Math.round(SAMPLE_RATE * attackMs / 1000);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const v = Math.sin(2 * Math.PI * carrierHz * t + modIndex * Math.sin(2 * Math.PI * modHz * t));

    let env;
    if (i < attackSamples) {
      env = 0.5 * (1 - Math.cos(Math.PI * i / attackSamples));
    } else {
      const rel = (i - attackSamples) / Math.max(1, n - attackSamples);
      env = Math.pow(1 - rel, decayShape);
    }

    const s = v * env * AMPLITUDE;
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
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
  const chunks = [
    renderFmBlip(820,  210, 3.0, 80, 3, 2.5), // blip 1
    renderSilence(35),
    renderFmBlip(1300, 340, 3.6, 90, 3, 2.2), // blip 2 — más agudo, remata "enlazado"
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
