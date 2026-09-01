'use strict';

/**
 * Genera los 4 sounds/*.wav de conexión/desconexión (WiFi + LiveKit).
 *
 * Reemplaza el diseño anterior (síntesis FM, "metálico/inarmónico" a
 * propósito — ver el historial de scripts/generate-*-connected-sound.js,
 * ahora retirados) por tonos casi puros (fundamental + un toque de 2do
 * armónico para calidez, sin ser flauta pura) con ataque/release suaves
 * (raised-cosine, sin cortes bruscos) — más parecido a un chime de iOS/
 * macOS que a un "blip" de sintetizador.
 *
 * Mismo lenguaje sonoro para las 4: ascendente = conexión, descendente =
 * desconexión (las MISMAS notas, en orden invertido) — así se sienten como
 * la misma familia en direcciones opuestas. WiFi usa un motivo de 2 notas
 * (más simple); LiveKit uno de 3 (arpegio mayor, un poco más "evento
 * grande" — es la sesión de voz real, no solo la red).
 *
 * Volumen general bajado (pedido explícito) — AMPLITUDE más chico que el
 * diseño anterior.
 *
 * Sin dependencias externas, igual que antes. Correr con:
 *   node scripts/generate-connection-sounds.js
 *
 * Son solo placeholders — reemplazá cualquier sounds/*.wav a mano si
 * querés un sonido distinto, no hace falta tocar código para eso.
 */

const fs   = require('fs');
const path = require('path');

// 48000, NO 44100 — livekit_conectado.wav se mete DIRECTO en el pipe de
// aplay que ya tiene abierto lib/livekit-session.js para la voz del agente
// (ver buildLivekitChimePcm en lib/sound-effects.js), y ese pipe corre fijo
// a SPEAKER_SAMPLE_RATE=48000 (lib/livekit-session.js). Si no coincide
// exacto, buildLivekitChimePcm lo descarta en silencio (deja un warning en
// el log, pero cero audio) — bug real que pasó la primera vez que se generó
// este archivo a 44100. Los 4 quedan al mismo sample rate por consistencia
// (a las de WiFi, que van por un aplay propio vía playSound(), no les
// importa cuál sea).
const SAMPLE_RATE = 48000;

// Notas estándar (A440, temperamento igual) — mismo set de 3 (LiveKit) y de
// 2 (WiFi), invertido entre conexión/desconexión.
const NOTE = { E5: 659.25, GS5: 830.61, C6: 1046.50, A5: 880.0, CS6: 1108.73 };

function renderTone(freqHz, durationMs, attackMs, releaseMs, amp) {
  const n = Math.round(SAMPLE_RATE * durationMs / 1000);
  const attackSamples  = Math.round(SAMPLE_RATE * attackMs / 1000);
  const releaseSamples = Math.round(SAMPLE_RATE * releaseMs / 1000);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Fundamental + 12% de 2do armónico — calidez tipo campana, sin el
    // carácter metálico de la FM ni sonar a flauta pura (solo fundamental).
    const v = Math.sin(2 * Math.PI * freqHz * t) + 0.12 * Math.sin(2 * Math.PI * freqHz * 2 * t);

    let env;
    if (i < attackSamples) {
      env = 0.5 * (1 - Math.cos(Math.PI * i / attackSamples)); // raised-cosine, sin golpe seco
    } else if (i > n - releaseSamples) {
      const rel = (n - i) / releaseSamples;
      env = 0.5 * (1 - Math.cos(Math.PI * rel)); // raised-cosine, sin corte brusco
    } else {
      env = 1;
    }

    const s = v * env * amp;
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return samples;
}

function renderSilence(durationMs) {
  return new Int16Array(Math.round(SAMPLE_RATE * durationMs / 1000));
}

function renderMotif(freqs, { noteMs, gapMs, attackMs, releaseMs, amp }) {
  const chunks = [];
  freqs.forEach((f, i) => {
    chunks.push(renderTone(f, noteMs, attackMs, releaseMs, amp));
    if (i < freqs.length - 1) chunks.push(renderSilence(gapMs));
  });
  return concatInt16(chunks);
}

function concatInt16(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function writeWavFile(filePath, samples, sampleRate) {
  const dataSize = samples.length * 2;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const dataBuf = Buffer.from(samples.buffer, samples.byteOffset, dataSize);
  fs.writeFileSync(filePath, Buffer.concat([header, dataBuf]));
}

function build(fileName, freqs, opts) {
  const samples = renderMotif(freqs, opts);
  const outDir  = path.join(__dirname, '..', 'sounds');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, fileName);
  writeWavFile(outPath, samples, SAMPLE_RATE);
  const durationMs = Math.round(samples.length / SAMPLE_RATE * 1000);
  console.log(`[generate-connection-sounds] ${outPath} — ${durationMs}ms`);
}

function main() {
  const wifiOpts    = { noteMs: 95, gapMs: 25, attackMs: 10, releaseMs: 75, amp: 0.22 };
  const livekitOpts = { noteMs: 90, gapMs: 22, attackMs: 10, releaseMs: 85, amp: 0.24 };

  build('wifi_conectado.wav',       [NOTE.A5, NOTE.CS6],              wifiOpts);
  build('wifi_desconectado.wav',    [NOTE.CS6, NOTE.A5],              wifiOpts);
  build('livekit_conectado.wav',    [NOTE.E5, NOTE.GS5, NOTE.C6],     livekitOpts);
  build('livekit_desconectado.wav', [NOTE.C6, NOTE.GS5, NOTE.E5],     livekitOpts);
}

main();
