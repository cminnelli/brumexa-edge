'use strict';

/**
 * Genera sounds/livekit_conectado.wav — dos "blips" FM cortos y percusivos,
 * contorno inverso al de wifi_conectado.wav (agudo→grave en vez de
 * grave→agudo, para que se puedan diferenciar a oído) que suena cuando el
 * agente de LiveKit confirma que está en la sala y ya se lo puede escuchar
 * (ver buildLivekitChimePcm() en lib/sound-effects.js, y el evento
 * 'agent-audio' en server.js — NO el 'connected' de la sala, que solo
 * confirma el transporte, no al agente).
 *
 * Mismo enfoque que scripts/generate-wifi-connected-sound.js: síntesis FM
 * (sin(carrier + index·sin(mod))) con envolvente percusiva en vez de un
 * barrido de tono puro (sonaba a silbido) — ver los comentarios ahí para el
 * detalle de por qué.
 *
 * SAMPLE_RATE = 48000, a propósito, NO 44100 como wifi_conectado.wav: este
 * chime no abre su propio aplay — server.js lo escribe directo en el mismo
 * pipe que lib/livekit-session.js ya tiene abierto para la voz del agente
 * (ver playChime()/getSpeakerFormat() ahí), que corre fijo a 48000Hz mono.
 * Si este archivo no matchea ese sampleRate, sound-effects.js lo descarta
 * en vez de meterlo a destiempo/tono incorrecto en ese pipe — no cambies
 * este valor sin cambiar también SPEAKER_SAMPLE_RATE en livekit-session.js.
 *
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
const AMPLITUDE   = 0.4; // fracción de full-scale (int16) — el gain en vivo
                          // (ver server.js, Math.min(speakerGain, 1.6)) sigue
                          // aplicándose arriba de este piso.

// Ver el comentario grande en generate-wifi-connected-sound.js — misma
// síntesis FM + envolvente percusiva (ataque rápido, decaimiento tipo
// potencia) acá.
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
    renderFmBlip(1500, 380, 3.4, 55, 2, 2.6), // blip 1 — agudo y corto
    renderSilence(25),
    renderFmBlip(1050, 260, 2.6, 70, 2, 2.2), // blip 2 — más grave, "asienta" (contorno inverso al de WiFi)
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
