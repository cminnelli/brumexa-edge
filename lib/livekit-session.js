'use strict';

/**
 * lib/livekit-session.js
 *
 * Cliente LiveKit puro server-side usando @livekit/rtc-node.
 * Reemplaza al pipeline browser → WebSocket → ALSA por un flujo directo:
 *
 *   arecord (ALSA) ─► Int16 PCM ─► AudioSource.captureFrame ─► LiveKit
 *   LiveKit ─► AudioStream<AudioFrame> ─► Int16 PCM ─► aplay (ALSA)
 *
 * Sin Chrome, sin worklets, sin transferencias entre AudioContexts.
 *
 * Uso:
 *   const session = new LiveKitSession();
 *   await session.start({ token, url, micDevice: 'plughw:0,0', speakerDevice: 'plughw:0,0' });
 *   session.on('mic-stats',     ({ peak, dbfs }) => …);
 *   session.on('speaker-stats', ({ peak, dbfs }) => …);
 *   await session.stop();
 */

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');

// Lazy-load del SDK: en Windows de desarrollo el binario nativo no está
// disponible y haría crashear todo el server al import. Solo lo cargamos
// cuando realmente se llama a start() (en la Pi sí está disponible).
let _lkRtc = null;
function loadLk() {
  if (_lkRtc) return _lkRtc;
  _lkRtc = require('@livekit/rtc-node');
  return _lkRtc;
}

// ─── Configuración del audio ─────────────────────────────────────────────────
const MIC_SAMPLE_RATE     = 16000;                      // 16 kHz mono — bueno para voz, eficiente para Opus
const MIC_CHANNELS        = 1;
const MIC_FRAME_MS        = 20;                         // tamaño de frame estándar para Opus
const MIC_FRAME_SAMPLES   = MIC_SAMPLE_RATE * MIC_FRAME_MS / 1000;   // 320
const MIC_FRAME_BYTES     = MIC_FRAME_SAMPLES * 2;      // S16 = 2 B/sample

const SPEAKER_SAMPLE_RATE = 48000;                      // pedimos al SDK que resamplee — aplay nativo a 48k
const SPEAKER_CHANNELS    = 1;

const MIC_DEVICE_DEFAULT     = process.env.MIC_DEVICE     || 'plughw:0,0';
const SPEAKER_DEVICE_DEFAULT = process.env.SPEAKER_DEVICE || 'plughw:0,0';

// ─── Clase principal ─────────────────────────────────────────────────────────
class LiveKitSession extends EventEmitter {
  constructor() {
    super();
    this.room          = null;
    this.audioSource   = null;
    this.localTrack    = null;
    this.arecordProc   = null;
    this.aplayProc     = null;
    this.status        = 'idle';     // 'idle' | 'connecting' | 'connected' | 'error'
    this._micGain      = parseFloat(process.env.MIC_GAIN || '1.0');
    this._speakerDevice = SPEAKER_DEVICE_DEFAULT;
  }

  isActive() {
    return this.status === 'connecting' || this.status === 'connected';
  }

  // ─── start(): conectar al room + publicar mic + preparar speaker ───────────
  async start({ token, url, roomName, micDevice, speakerDevice }) {
    if (this.isActive()) throw new Error('Sesión ya activa — detenela antes con stop()');
    if (!token || !url) throw new Error('Faltan token o url');

    this._setStatus('connecting');
    micDevice           = micDevice     || MIC_DEVICE_DEFAULT;
    speakerDevice       = speakerDevice || SPEAKER_DEVICE_DEFAULT;
    this._speakerDevice = speakerDevice;

    const { Room, TrackKind } = loadLk();

    try {
      // 1. Conectar al Room
      this.room = new Room();
      this._wireRoomEvents();
      console.log(`[lk-session] Conectando → ${url}  room=${roomName || '(auto)'}…`);
      await this.room.connect(url, token, { autoSubscribe: true, dynacast: false });
      console.log(`[lk-session] ✔ Conectado  room="${this.room.name}"  identity="${this.room.localParticipant?.identity}"`);
      this._setStatus('connected');
      this.emit('connected', { room: this.room.name, identity: this.room.localParticipant?.identity });

      // 2. Publicar mic
      await this._publishMic(micDevice);

      // 3. Pre-spawn aplay para reducir latencia inicial al recibir audio del agente
      this._startAplay(speakerDevice);

      // 4. Si el agente ya estaba en la sala con tracks, suscribirse a ellos
      for (const p of this.room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.track && pub.track.kind === TrackKind.KIND_AUDIO) {
            console.log(`[lk-session] Track existente del agente: ${p.identity}/${pub.sid}`);
            this._consumeRemoteAudio(pub.track).catch(e => console.error('[lk-session] consume:', e.message));
          }
        }
      }

    } catch (err) {
      console.error('[lk-session] start() falló:', err.message);
      this._setStatus('error');
      this.emit('error', err);
      await this.stop().catch(() => {});
      throw err;
    }
  }

  // ─── Publicar mic via arecord → AudioSource ────────────────────────────────
  async _publishMic(device) {
    const { AudioSource, AudioFrame, LocalAudioTrack, TrackSource, TrackPublishOptions } = loadLk();
    console.log(`[lk-session] arecord -D ${device}  ${MIC_SAMPLE_RATE}Hz mono S16_LE  frame=${MIC_FRAME_MS}ms (${MIC_FRAME_SAMPLES} samples)`);

    const args = [
      '-q',
      '-D', device,
      '-f', 'S16_LE',
      '-r', String(MIC_SAMPLE_RATE),
      '-c', String(MIC_CHANNELS),
      '-t', 'raw',
    ];
    const proc = spawn('arecord', args);
    this.arecordProc = proc;

    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.warn('[arecord]', msg);
    });
    proc.on('error', err => {
      console.error('[lk-session] arecord error:', err.message);
      this.emit('error', err);
    });
    proc.on('close', code => {
      console.log(`[lk-session] arecord cerrado  code=${code}`);
      if (this.arecordProc === proc) this.arecordProc = null;
    });

    // Crear AudioSource y publicar como track
    this.audioSource = new AudioSource(MIC_SAMPLE_RATE, MIC_CHANNELS);
    this.localTrack  = LocalAudioTrack.createAudioTrack('mic', this.audioSource);

    const pubOpts = new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
      dtx:    false,   // ⚠ DTX desactivado: no enviar comfort noise (perdíamos audio bajo)
      red:    true,    // redundancia para resistencia a packet loss
    });

    await this.room.localParticipant.publishTrack(this.localTrack, pubOpts);
    console.log('[lk-session] ✔ Mic track publicado');
    this.emit('mic-published');

    // ─── Bombeo del PCM: acumular hasta tener 20 ms y enviar AudioFrame ──────
    let buffer       = Buffer.alloc(0);
    let lastLog      = Date.now();
    let peakAccum    = 0;
    let framesAccum  = 0;

    proc.stdout.on('data', async (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      while (buffer.length >= MIC_FRAME_BYTES) {
        const frameBuf = buffer.subarray(0, MIC_FRAME_BYTES);
        buffer         = buffer.subarray(MIC_FRAME_BYTES);

        // Aplicar gain con clipping
        const int16 = new Int16Array(MIC_FRAME_SAMPLES);
        let peak    = 0;
        for (let i = 0; i < MIC_FRAME_SAMPLES; i++) {
          let s = frameBuf.readInt16LE(i * 2) * this._micGain;
          if (s > 32767)  s = 32767;
          if (s < -32768) s = -32768;
          int16[i] = s;
          const a = s < 0 ? -s : s;
          if (a > peak) peak = a;
        }
        if (peak > peakAccum) peakAccum = peak;
        framesAccum++;

        try {
          const frame = new AudioFrame(int16, MIC_SAMPLE_RATE, MIC_CHANNELS, MIC_FRAME_SAMPLES);
          await this.audioSource.captureFrame(frame);
        } catch (e) {
          console.error('[lk-session] captureFrame:', e.message);
        }

        // Stats cada 2 s
        if (Date.now() - lastLog > 2000) {
          const dbfs = peakAccum > 0 ? 20 * Math.log10(peakAccum / 32767) : -120;
          console.log(`[mic→LK] frames=${framesAccum}  peak=${peakAccum}/32767  ${dbfs.toFixed(1)}dBFS  gain=${this._micGain}x`);
          this.emit('mic-stats', { frames: framesAccum, peak: peakAccum, dbfs, gain: this._micGain });
          lastLog     = Date.now();
          peakAccum   = 0;
          framesAccum = 0;
        }
      }
    });
  }

  // ─── Eventos del Room ──────────────────────────────────────────────────────
  _wireRoomEvents() {
    const { RoomEvent, TrackKind } = loadLk();
    this.room.on(RoomEvent.ParticipantConnected, p => {
      console.log(`[lk-session] + Participant: ${p.identity} (kind=${p.kind})`);
      this.emit('participant-joined', { identity: p.identity, kind: p.kind });
    });

    this.room.on(RoomEvent.ParticipantDisconnected, p => {
      console.log(`[lk-session] - Participant: ${p.identity}`);
      this.emit('participant-left', { identity: p.identity });
    });

    this.room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      console.log(`[lk-session] ✔ TrackSubscribed: ${participant.identity}  kind=${track.kind}  sid=${track.sid}`);
      if (track.kind === TrackKind.KIND_AUDIO) {
        this.emit('agent-audio', { identity: participant.identity });
        this._consumeRemoteAudio(track).catch(e => console.error('[lk-session] consume:', e.message));
      }
    });

    this.room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      console.log(`[lk-session] − TrackUnsubscribed: ${participant.identity}  kind=${track.kind}`);
    });

    this.room.on(RoomEvent.TrackSubscriptionFailed, (sid, p, reason) => {
      console.error(`[lk-session] ✘ Subscription failed: ${p.identity}/${sid}  reason=${reason}`);
    });

    this.room.on(RoomEvent.Disconnected, reason => {
      console.log(`[lk-session] Desconectado del room  reason=${reason}`);
      this._setStatus('idle');
      this.emit('disconnected', { reason });
    });
  }

  // ─── Consumir audio remoto via AudioStream → aplay ─────────────────────────
  async _consumeRemoteAudio(track) {
    const { AudioStream } = loadLk();
    console.log(`[lk-session] Abriendo AudioStream  ${SPEAKER_SAMPLE_RATE}Hz mono…`);
    // El SDK resampleará lo que llegue del peer al sampleRate que pedimos
    const stream = new AudioStream(track, SPEAKER_SAMPLE_RATE, SPEAKER_CHANNELS);

    let lastLog    = Date.now();
    let bytesAccum = 0;
    let peakAccum  = 0;
    let framesAccum = 0;

    try {
      for await (const frame of stream) {
        // Asegurarnos que aplay sigue vivo
        if (!this.aplayProc || !this.aplayProc.stdin || !this.aplayProc.stdin.writable) {
          this._startAplay(this._speakerDevice);
        }

        if (this.aplayProc && this.aplayProc.stdin.writable) {
          // Tomar el ArrayBuffer directo del Int16Array
          const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
          this.aplayProc.stdin.write(buf);

          bytesAccum += buf.length;
          framesAccum++;
          for (let i = 0; i < frame.data.length; i++) {
            const a = frame.data[i] < 0 ? -frame.data[i] : frame.data[i];
            if (a > peakAccum) peakAccum = a;
          }
        }

        if (Date.now() - lastLog > 2000) {
          const dbfs = peakAccum > 0 ? 20 * Math.log10(peakAccum / 32767) : -120;
          console.log(`[LK→speaker] frames=${framesAccum}  bytes=${bytesAccum}  peak=${peakAccum}/32767  ${dbfs.toFixed(1)}dBFS`);
          this.emit('speaker-stats', { frames: framesAccum, bytes: bytesAccum, peak: peakAccum, dbfs });
          lastLog     = Date.now();
          bytesAccum  = 0;
          peakAccum   = 0;
          framesAccum = 0;
        }
      }
    } catch (err) {
      console.error('[lk-session] AudioStream error:', err.message);
    }
    console.log('[lk-session] AudioStream terminó');
  }

  // ─── Spawn aplay para reproducir lo que llega del agente ──────────────────
  _startAplay(device) {
    if (this.aplayProc) return;
    console.log(`[lk-session] aplay -D ${device}  ${SPEAKER_SAMPLE_RATE}Hz mono S16_LE`);

    const args = [
      '-q',
      '-D', device,
      '-f', 'S16_LE',
      '-r', String(SPEAKER_SAMPLE_RATE),
      '-c', String(SPEAKER_CHANNELS),
      '-t', 'raw',
      '--buffer-size=24000',  // 500 ms de buffer (en frames) — evita underruns en Pi Zero 2W
    ];
    const proc = spawn('aplay', args);
    this.aplayProc = proc;

    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.warn('[aplay]', msg);
    });
    proc.on('error', err => {
      console.error('[lk-session] aplay error:', err.message);
      this.emit('error', err);
    });
    proc.on('close', code => {
      console.log(`[lk-session] aplay cerrado  code=${code}`);
      if (this.aplayProc === proc) this.aplayProc = null;
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  setMicGain(g) {
    if (typeof g !== 'number' || isNaN(g) || g < 0 || g > 32) return false;
    this._micGain = g;
    console.log(`[lk-session] mic gain → ${g}x`);
    return true;
  }

  getMicGain() { return this._micGain; }

  getStatus() {
    return {
      status:        this.status,
      roomName:      this.room?.name || null,
      identity:      this.room?.localParticipant?.identity || null,
      isConnected:   !!this.room?.isConnected,
      remoteParticipants: this.room
        ? Array.from(this.room.remoteParticipants.values()).map(p => p.identity)
        : [],
      micActive:     !!this.arecordProc,
      speakerActive: !!this.aplayProc,
      micGain:       this._micGain,
    };
  }

  // ─── stop(): cerrar todo en orden ─────────────────────────────────────────
  async stop() {
    console.log('[lk-session] Cerrando sesión…');
    this._setStatus('idle');

    // 1. Frenar arecord
    if (this.arecordProc) {
      try { this.arecordProc.kill('SIGTERM'); } catch {}
      this.arecordProc = null;
    }

    // 2. Cerrar local track + audio source
    if (this.localTrack) {
      try { await this.localTrack.close(true); } catch (e) { console.warn('[lk-session] close track:', e.message); }
      this.localTrack = null;
    }
    if (this.audioSource) {
      try { await this.audioSource.close(); } catch {}
      this.audioSource = null;
    }

    // 3. Cerrar aplay
    if (this.aplayProc) {
      try { this.aplayProc.stdin.end(); } catch {}
      try { this.aplayProc.kill('SIGTERM'); } catch {}
      this.aplayProc = null;
    }

    // 4. Disconnect del Room
    if (this.room) {
      try { await this.room.disconnect(); } catch (e) { console.warn('[lk-session] room.disconnect:', e.message); }
      this.room = null;
    }

    console.log('[lk-session] ✔ Sesión cerrada');
    this.emit('disconnected', { reason: 'stopped' });
  }
}

// ─── Singleton compartido por toda la app ────────────────────────────────────
const session = new LiveKitSession();

module.exports = { LiveKitSession, session };
