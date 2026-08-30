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
const { requestRoomToken } = require('./rag-token');
const { POP_SETTLE_MS: MIC_OPEN_WARMUP_MS } = require('./mic-calibration');
const micGate = require('./mic-speech-gate');

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

// La voz del agente llega de LiveKit sin ningún boost (a diferencia de las
// grabaciones locales, que ya se normalizan al 85% del máximo en recorder.js)
// — en el HAT de audio de la Pi el volumen de ALSA al 100% se queda corto,
// así que este es el único lugar donde ganamos volumen real: multiplicando
// las muestras PCM antes de mandarlas a aplay. Default 1.0 = sin cambios.
// Solo el valor inicial sale de .env — en vivo se ajusta con setSpeakerGain()
// (this._speakerGain, mismo patrón que _micGain) para no requerir reinicio.
const SPEAKER_GAIN_DEFAULT = parseFloat(process.env.SPEAKER_GAIN) || 1.0;

// El browser siempre manda micDevice/speakerDevice explícito en POST
// /session/start (ver public/app.js) — esto es solo el fallback si alguien
// pega directo a la API sin especificar. Nunca se seteó por .env en la
// práctica, así que va hardcodeado en vez de leer una env var que no existe.
const MIC_DEVICE_DEFAULT     = 'plughw:0,0';
const SPEAKER_DEVICE_DEFAULT = 'plughw:0,0';

// Umbral que decide "está hablando" vs "silencio" — a la vez gatea el log
// legible de consola ("empezó/dejó de hablar") Y, vía lib/leds.js (que lee la
// misma env var MIC_TALK_THRESHOLD_DBFS), cuándo el LED corta el breathing y
// pasa a "hablando". Un solo umbral conectado a las dos cosas.
// Compartido entre mic y parlante. Ajustable en vivo (setTalkThreshold, sin
// reiniciar) y persistible en .env. Default -25dBFS: es el valor ya probado
// en el LED que no falsea con ruido ambiente (ver historia en leds.js — -40
// disparaba con una impresora 3D cerca).
// Más alto/menos negativo = necesita hablar más fuerte para contar como "hablando".
let TALKING_THRESHOLD_DBFS = parseFloat(process.env.MIC_TALK_THRESHOLD_DBFS) || -25;

// Cada cuánto se recalculan/emiten peak+dbfs (mic-stats/speaker-stats). El log
// de transición ("empezó/dejó de hablar") ya está gateado por cambio de estado,
// así que esto NO controla el ritmo de logueo — controla el ritmo con el que
// leds.speaking() se entera del nivel de audio. Antes eran 2000ms (pensados
// solo para no saturar la consola), pero eso hacía que el LED de "hablando"
// se apagara y prendiera en cada tick durante una sesión real (el hangover de
// leds.js es de 300-400ms, mucho más corto que 2s). 100ms iguala el ritmo del
// monitor de mic standalone (server.js) para que el LED se sienta igual con o
// sin sesión activa.
const STATS_TICK_MS = 100;

// Buffer de aplay en samples — subido de 24000 (0.5s) a 48000 (1s) porque
// en la Pi Zero 2W se vieron underruns de hasta ~1.1s bajo carga (CPU
// compartida entre Node/LiveKit/WiFi). Más buffer = más latencia pero
// menos cortes audibles. Nunca se seteó por .env en la práctica — si hace
// falta afinarlo, cambiar el número acá directo.
const APLAY_BUFFER_SIZE = 48000;

// Half-duplex: mientras el speaker está reproduciendo audio del agente, el mic
// envía silencio para evitar feedback acústico (speaker → mic → STT → interrupt).
// TIENE que cubrir el buffer de aplay ENTERO, no menos — con
// APLAY_BUFFER_SIZE=48000 @ 48000Hz eso son 1000ms (y el comentario de ahí
// arriba dice que bajo carga en la Pi Zero 2W se vieron underruns de hasta
// ~1.1s). 800ms se quedaba corto: cuando el agente terminaba de hablar, el
// mic se desmuteaba mientras todavía sonaba de verdad el resto del buffer
// por el parlante — ese resto lo agarraba el mic y se leía como "Usuario
// hablando" (falso positivo, solo durante sesión activa). 1500ms cubre el
// buffer completo + margen de cola acústica.
const MUTE_TAIL_MS = 1500;

// Corte automático por silencio: si pasan SILENCE_DISCONNECT_MS sin que NI
// vos NI el agente crucen el umbral de voz (mismo TALKING_THRESHOLD_DBFS de
// arriba), la sesión se desconecta sola — para no dejar el mic publicando y
// el VAD del agente corriendo indefinidamente si alguien se olvida la
// sesión prendida. 0 = desactivado. Ajustable en vivo (setSilenceTimeout,
// sin reiniciar) y persistible en .env (ver /configuracion → Sonido).
let SILENCE_DISCONNECT_MS = parseInt(process.env.SILENCE_DISCONNECT_MS, 10) || 20000;
const SILENCE_CHECK_TICK_MS = 1000;

// Auto-reconnect cuando el agente no está vivo:
// Si tras conectar al room no llega TrackSubscribed de audio en N ms, asumimos
// que el agent está muerto (p.ej. el worker se reinició mientras estábamos en
// el room → no recibió el job). Ciclamos stop()+start() para que el room se
// vacíe, se destruya por emptyTimeout=5s, y el nuevo start dispare auto-dispatch.
// Subido de 8000 a 13000: el arranque del agente (VAD + config del negocio)
// a veces se pasaba de los 8s y disparaba reintentos de más.
const AGENT_DETECT_TIMEOUT_MS = 13000;
const AGENT_MAX_RETRIES       = 3;
const AGENT_RETRY_DELAY_MS    = 6000;

// Mapeo manual del enum livekit.ConnectionQuality (@livekit/protocol) en vez
// de confiar en el reverse-mapping en runtime del objeto que exporta el SDK
// (generado por protobuf-es, no un enum de TS plano) — así queda explícito y
// no se rompe si el binding cambia de forma por dentro. Valores tal cual la
// definición del protocolo: POOR=0, GOOD=1, EXCELLENT=2, LOST=3.
const CONNECTION_QUALITY_LABELS = { 0: 'poor', 1: 'good', 2: 'excellent', 3: 'lost' };

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
    this._speakerGain   = SPEAKER_GAIN_DEFAULT;
    // Flag en memoria (no persiste en .env) para cortar la captura de mic
    // sin tocar código — útil mientras el hardware físico está roto/en
    // reemplazo. Se controla desde /local. Default: activado.
    this._micEnabled    = true;
    // Gate de ruido sobre el audio publicado — ver _publishMic más abajo y
    // lib/mic-speech-gate.js. MIC_GATE_ENABLED=false vuelve al comportamiento
    // de antes (todo se publica sin atenuar), como válvula de escape.
    this._micGateEnabled     = (process.env.MIC_GATE_ENABLED ?? 'true') !== 'false';
    this._micGateAttenuationDb = parseFloat(process.env.MIC_GATE_ATTENUATION_DB);
    if (isNaN(this._micGateAttenuationDb)) this._micGateAttenuationDb = -90;
    this._micPrerollMs = parseFloat(process.env.MIC_PREROLL_MS);
    if (isNaN(this._micPrerollMs)) this._micPrerollMs = 500;
    this._voiceActive  = false; // estado DINÁMICO (isVoiceActive() del gate), no confundir con _micGateEnabled (interruptor fijo, arriba)
    this._micPublishing = false; // true mientras _publishMic tiene su 'data' listener activo — ver stop()
    this._speakerDevice = SPEAKER_DEVICE_DEFAULT;
    this._speakerActiveUntil = 0;
    this._micMutedLogged     = false;
    this._lastMicPeak        = 0;
    this._lastSpeakerPeak    = 0;
    this._micTalking         = false; // para loguear solo transiciones silencio↔habla
    this._speakerTalking     = false;
    this._lastActivityAt     = 0;     // último cruce de umbral (vos o el agente) — corte por silencio
    this._silenceCheckTimer  = null;

    // Auto-reconnect state
    this._startArgs          = null;  // args del último start() — para reintentar
    this._agentWatchdog      = null;  // timer que dispara si el agent no aparece
    this._agentSubscribed    = false; // flag: llegó TrackSubscribed de audio
    this._reconnectAttempts  = 0;     // contador de reintentos
    this._isReconnecting     = false; // evita reintentos concurrentes

    // Single-audio-stream guard: si el agente publica dos tracks de audio
    // (republish tras reconexión, etc.) tendríamos dos AudioStream concurrentes
    // escribiendo a aplay → frames intercalados → audio robótico/lento.
    // Este token identifica al consumidor vigente: cuando llega uno nuevo,
    // el viejo detecta la diferencia y sale del for-await.
    this._activeAudioConsumer = null;
    this._activeAudioTrackSid = null;

    // Indicador de "¿estoy perdiendo datos?" — lo calcula el SDK de LiveKit
    // en base a las stats reales del transporte WebRTC (RTT, packet loss,
    // etc.), no algo que midamos nosotros: simple y de bajo costo, ver
    // RoomEvent.ConnectionQualityChanged en _wireRoomEvents(). null = sin
    // sesión activa o sin ningún cambio reportado todavía.
    this._connectionQuality = null;
  }

  isActive() {
    return this.status === 'connecting' || this.status === 'connected';
  }

  // ─── start(): conectar al room + publicar mic + preparar speaker ───────────
  async start({ token, url, roomName, micDevice, speakerDevice }) {
    if (this.isActive()) throw new Error('Sesión ya activa — detenela antes con stop()');
    if (!token || !url) throw new Error('Faltan token o url');

    this._setStatus('connecting');
    this._lastActivityAt = Date.now();
    this._startSilenceWatch();
    micDevice           = micDevice     || MIC_DEVICE_DEFAULT;
    speakerDevice       = speakerDevice || SPEAKER_DEVICE_DEFAULT;
    this._speakerDevice = speakerDevice;
    this._startArgs     = { token, url, roomName, micDevice, speakerDevice };
    this._agentSubscribed = false;
    this._connectionQuality = null; // no arrastrar la calidad de la sesión/intento anterior

    // Cada start() manual es "empezar de cero" en cuanto a reintentos. Si
    // _reconnectAttempts quedó sucio (p.ej. el usuario pegó Stop durante un
    // ciclo de reconexión → no se reseteó), heredaríamos N y el primer
    // watchdog dispararía "agotado (N/N)" sin haber reintentado nada.
    if (!this._isReconnecting) {
      this._reconnectAttempts = 0;
    }

    const { Room, TrackKind } = loadLk();

    try {
      // 1. Conectar al Room
      this.room = new Room();
      this._wireRoomEvents();
      console.log(`🔗 LiveKit → conectando a la sala "${roomName || '(auto)'}"…`);
      await this.room.connect(url, token, { autoSubscribe: true, dynacast: false });
      console.log(`✅ LiveKit → conectado (sala "${this.room.name}")`);
      console.log(`[lk-session-debug] connectionState inicial → ${this.room.connectionState}`);
      this._setStatus('connected');
      this.emit('connected', { room: this.room.name, identity: this.room.localParticipant?.identity });

      // 2. Publicar mic (salvo que esté desactivado a mano desde /local —
      // en ese caso ni siquiera abrimos arecord, para no pelear con un
      // dispositivo físicamente roto)
      if (this._micEnabled) {
        await this._publishMic(micDevice);
      } else {
        console.log('🎤 Mic → desactivado a mano, esta sesión no manda audio tuyo');
      }

      // 3. Pre-spawn aplay para reducir latencia inicial al recibir audio del agente
      this._startAplay(speakerDevice);

      // 4. Si el agente ya estaba en la sala con tracks, suscribirse a ellos
      let foundExistingAgentAudio = false;
      for (const p of this.room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.track && pub.track.kind === TrackKind.KIND_AUDIO) {
            console.log(`🤖 Agente → ya estaba en la sala, escuchándolo`);
            foundExistingAgentAudio = true;
            this._agentSubscribed = true;
            // Mismo evento que emite el TrackSubscribed más abajo — sin esto,
            // quien escucha 'agent-audio' (LED) nunca se entera cuando el
            // agente YA estaba en la sala al conectar (solo cuando se une
            // después).
            this.emit('agent-audio', { identity: p.identity });
            this._consumeRemoteAudio(pub.track).catch(e => console.error('[lk-session] consume:', e.message));
          }
        }
      }

      // 5. Armar watchdog: si el agent no se suscribe en N ms, asumimos que está
      //    muerto y ciclamos la conexión. Si ya había track existente, skip.
      if (!foundExistingAgentAudio) {
        this._armAgentWatchdog();
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
    this._micPublishing = true; // ver el guard dentro de proc.stdout.on('data', ...) más abajo
    console.log(`[lk-session] arecord -D ${device}  ${MIC_SAMPLE_RATE}Hz mono S16_LE  frame=${MIC_FRAME_MS}ms (${MIC_FRAME_SAMPLES} samples)`);

    const args = [
      '-D', device,
      '-f', 'S16_LE',
      '-r', String(MIC_SAMPLE_RATE),
      '-c', String(MIC_CHANNELS),
      '-t', 'raw',
    ];
    console.log(`[lk-session] spawn arecord ${args.join(' ')}`);
    const proc = spawn('arecord', args);
    this.arecordProc = proc;

    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.warn('[arecord stderr]', msg);
    });
    proc.on('error', err => {
      console.error('[lk-session] arecord SPAWN ERROR:', err.message);
      this.emit('error', err);
    });
    proc.stdout.on('error', err => {
      console.warn('[lk-session] arecord stdout error:', err.code || err.message);
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
    console.log('🎤 Mic → publicado, listo para escucharte');
    this.emit('mic-published');

    // ─── Bombeo del PCM: acumular hasta tener 20 ms y enviar AudioFrame ──────
    let buffer         = Buffer.alloc(0);
    let lastLog        = Date.now();
    let lastAmbientLog = Date.now();
    let lastMuteLiftedAt = 0;  // Date.now() de la última vez que speakerActive pasó de true a false
    let peakAccum      = 0;
    let rawPeakAccum   = 0;    // pico SIN gain — para distinguir "hay señal real" de "el gain lo infla"
    let framesAccum    = 0;
    let firstChunk     = true;
    const arecordStartedAt = Date.now();

    // ─── Gate de ruido sobre lo publicado a LiveKit ──────────────────────────
    // Antes de esto, TODO el audio (piso de ruido incluido) se publicaba sin
    // filtrar — el umbral de arriba solo gateaba el log/LED/timer de
    // silencio, nunca el audio real (ver comentario más abajo, en el bloque
    // de stats). Acá se usa el MISMO detector que ya filtra el LED
    // (lib/mic-speech-gate.js: piso ambiente adaptativo + debounce de onset +
    // hangover, ya probado) para decidir también qué se publica.
    //
    // Buffer de pre-roll: guarda los últimos MIC_PREROLL_MS de frames YA
    // ganeados (mismo array que se publicaría si el gate estuviera abierto)
    // — al abrir el gate se vacía ANTES de seguir con el audio en vivo, para
    // no comerse el arranque de la palabra mientras el debounce de onset
    // (ver ONSET_MIN_STREAK en mic-speech-gate.js) todavía no confirmó que
    // es voz real.
    const prerollMaxFrames = Math.max(1, Math.ceil(this._micPrerollMs / MIC_FRAME_MS));
    const prerollFrames    = [];
    let voiceActive         = false;
    let pendingPrerollFlush = false;
    const gateScratch = new Int16Array(MIC_FRAME_SAMPLES);

    proc.stdout.on('data', async (chunk) => {
      // Guard contra la carrera de cierre: stop() mata arecord con SIGTERM y
      // recién DESPUÉS cierra localTrack/audioSource — en el medio (kill no
      // es instantáneo, y localTrack.close()/audioSource.close() son awaits
      // que le ceden el control al event loop) pueden seguir llegando chunks
      // ya bufferados de este mismo 'data' listener, cada uno intentando
      // captureFrame() contra un audioSource que ya está cerrándose o cerrado
      // → RtcError InvalidState. this._micPublishing se apaga como PRIMERA
      // línea de stop(), antes de cualquier await, así que este chequeo corta
      // el procesamiento ni bien arranca el cierre, en vez de descubrirlo
      // recién al fallar el captureFrame (y ahora con el flush de pre-roll,
      // que manda varios frames de un saque, sin este guard el error se
      // multiplicaba más que antes).
      if (!this._micPublishing) return;
      if (firstChunk) {
        firstChunk = false;
        console.log(`[lk-session] ✔ arecord primer chunk recibido — ${chunk.length} bytes`);
      }
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      while (buffer.length >= MIC_FRAME_BYTES) {
        if (!this._micPublishing) return;
        const frameBuf = buffer.subarray(0, MIC_FRAME_BYTES);
        buffer         = buffer.subarray(MIC_FRAME_BYTES);

        // Half-duplex: si el speaker está reproduciendo agente, enviar silencio
        const speakerActive = Date.now() < this._speakerActiveUntil;
        if (speakerActive !== this._micMutedLogged) {
          if (!speakerActive) lastMuteLiftedAt = Date.now();
          console.log(`[lk-session] mic ${speakerActive ? 'MUTED (agente hablando)' : 'UNMUTED'}`);
          this._micMutedLogged = speakerActive;
        }

        // Aplicar gain con clipping (o silenciar si el speaker está activo)
        const int16 = new Int16Array(MIC_FRAME_SAMPLES);
        let peak    = 0;
        let rawPeak = 0;  // pico crudo, sin this._micGain — para debug (¿es señal real o el gain que la infla?)
        if (!speakerActive) {
          for (let i = 0; i < MIC_FRAME_SAMPLES; i++) {
            const raw = frameBuf.readInt16LE(i * 2);
            const rawAbs = raw < 0 ? -raw : raw;
            if (rawAbs > rawPeak) rawPeak = rawAbs;
            let s = raw * this._micGain;
            if (s > 32767)  s = 32767;
            if (s < -32768) s = -32768;
            int16[i] = s;
            const a = s < 0 ? -s : s;
            if (a > peak) peak = a;
          }
        }
        // si speakerActive: int16 queda en ceros (silencio)
        // El HAT mete un "pum" audible por el parlante cada vez que arecord
        // abre el device (no es solo un artefacto del monitor idle — pasa
        // en TODA apertura, sesiones incluidas) — durante MIC_OPEN_WARMUP_MS
        // no se cuenta ese pico para el detector de "está hablando" (mic-stats,
        // log de consola, LED), pero el audio real SÍ sigue yendo a
        // captureFrame() sin tocar — si el usuario habla justo al arrancar la
        // sesión, esa voz no se pierde, solo se retrasa hasta este punto la
        // detección de "empezó a hablar".
        if (Date.now() - arecordStartedAt >= MIC_OPEN_WARMUP_MS) {
          if (peak > peakAccum) peakAccum = peak;
          if (rawPeak > rawPeakAccum) rawPeakAccum = rawPeak;
        }
        framesAccum++;

        // Guardar SIEMPRE el frame (ya con gain aplicado) en el pre-roll,
        // gate abierto o cerrado — es lo que se flushea al abrir el gate más
        // abajo, así el arranque de la palabra (los ~300ms de debounce de
        // onset) no se pierde.
        prerollFrames.push(int16);
        if (prerollFrames.length > prerollMaxFrames) prerollFrames.shift();

        if (pendingPrerollFlush) {
          pendingPrerollFlush = false;
          const buffered = prerollFrames.splice(0);
          console.log(`[lk-session] 🔓 Gate ABIERTO — preroll flush (${buffered.length}×${MIC_FRAME_MS}ms)`);
          for (const frameSamples of buffered) {
            try {
              const pf = new AudioFrame(frameSamples, MIC_SAMPLE_RATE, MIC_CHANNELS, MIC_FRAME_SAMPLES);
              await this.audioSource.captureFrame(pf);
            } catch (e) {
              console.error('[lk-session] captureFrame (preroll):', e.message);
            }
          }
        }

        // Gate cerrado → se publica una copia atenuada en vez del audio
        // crudo (mismo lugar donde speakerActive ya deja el frame en ceros
        // arriba — atenuar ceros sigue dando cero, sin rama especial). Con
        // MIC_GATE_ENABLED=false se publica siempre el audio real, como antes.
        let outSamples = int16;
        if (this._micGateEnabled && !voiceActive) {
          const attenLin = Math.pow(10, this._micGateAttenuationDb / 20);
          for (let i = 0; i < MIC_FRAME_SAMPLES; i++) gateScratch[i] = Math.round(int16[i] * attenLin);
          outSamples = gateScratch;
        }

        try {
          const frame = new AudioFrame(outSamples, MIC_SAMPLE_RATE, MIC_CHANNELS, MIC_FRAME_SAMPLES);
          await this.audioSource.captureFrame(frame);
        } catch (e) {
          console.error('[lk-session] captureFrame:', e.message);
        }

        // Stats cada STATS_TICK_MS (100ms) — solo logueamos texto cuando CAMBIA
        // el estado (empezó/dejó de hablar), no cada tick, para no inundar la
        // consola. En la transición a "empezó a hablar" se suma contexto de
        // debug (pico crudo, hace cuánto se levantó el mute) — para poder
        // reconstruir DESPUÉS si un falso positivo coincidió con la cola del
        // mute o pasó bien lejos de cualquier actividad del agente.
        if (Date.now() - lastLog > STATS_TICK_MS) {
          const dbfs = peakAccum > 0 ? 20 * Math.log10(peakAccum / 32767) : -120;
          this._lastMicPeak = peakAccum;
          const talking = dbfs > TALKING_THRESHOLD_DBFS;
          // Cada tick que cruza el umbral cuenta como actividad para el corte
          // por silencio, no solo el primer instante — así una frase larga no
          // empieza a descontar el timer a mitad de que estás hablando.
          if (talking) this._lastActivityAt = Date.now();
          if (talking !== this._micTalking) {
            this._micTalking = talking;
            if (talking) {
              const rawDbfs = rawPeakAccum > 0 ? 20 * Math.log10(rawPeakAccum / 32767) : -120;
              const msSinceMuteLifted = lastMuteLiftedAt ? Date.now() - lastMuteLiftedAt : null;
              // Mismo umbral que el LED (MIC_TALK_THRESHOLD_DBFS, ajustable en
              // Configuración → Sonido) — este log y el timer de silencio
              // (_lastActivityAt) son independientes del gate de abajo, que
              // usa su propio detector (piso ambiente + debounce + hangover,
              // ver mic-speech-gate.js) para decidir qué audio se publica.
              console.log(`📤 EMITIENDO a LiveKit — audio por encima del umbral (dBFS=${dbfs.toFixed(1)}  raw=${rawDbfs.toFixed(1)}dBFS  muteLevantadoHace=${msSinceMuteLifted === null ? 'nunca' : msSinceMuteLifted + 'ms'})`);
            } else {
              console.log(`🔇 Dejó de emitir señal real — vuelve al piso de ruido (dBFS=${dbfs.toFixed(1)})`);
            }
          }

          // Gate de ruido: mismo detector que usa el LED (lib/mic-speech-gate.js)
          // decide ahora también qué audio se publica de verdad (ver el bloque
          // de captura más arriba) — antes solo el log/LED/timer de silencio
          // leían el umbral, el audio crudo se publicaba siempre sin filtrar.
          const level = peakAccum > 0 ? peakAccum / 32767 : 0;
          micGate.feed(level);
          const nowVoiceActive = micGate.isVoiceActive();
          if (nowVoiceActive && !voiceActive) pendingPrerollFlush = true;
          if (!nowVoiceActive && voiceActive) console.log('[lk-session] 🔒 Gate CERRADO — atenuando salida');
          voiceActive = nowVoiceActive;
          this._voiceActive = voiceActive;

          // Traza continua de fondo (no solo en las transiciones) — máximo
          // 1 línea/segundo, para poder ver la curva completa de un evento
          // aunque nunca llegue a cruzar el threshold.
          if (Date.now() - lastAmbientLog > 1000) {
            const ambientFloor = micGate.getAmbientFloorDbfs();
            console.log(`[lk-session-debug] mic ambient: ${dbfs.toFixed(1)}dBFS  muted=${speakerActive}  gate=${voiceActive ? 'OPEN' : 'CLOSED'}  ambientFloor=${ambientFloor === null ? 'n/a' : ambientFloor.toFixed(1) + 'dBFS'}  effectiveThreshold=${micGate.getEffectiveThresholdDbfs().toFixed(1)}dBFS`);
            lastAmbientLog = Date.now();
          }
          this.emit('mic-stats', { frames: framesAccum, peak: peakAccum, dbfs, gain: this._micGain });
          lastLog       = Date.now();
          peakAccum     = 0;
          rawPeakAccum  = 0;
          framesAccum = 0;
        }
      }
    });
  }

  // ─── Eventos del Room ──────────────────────────────────────────────────────
  _wireRoomEvents() {
    const { RoomEvent, TrackKind } = loadLk();

    // El "conectado" de room.connect() es solo señalización — esto muestra el
    // estado real del transporte de medios (ICE/PeerConnection). Se agregó
    // para diagnosticar un caso real: el agente nunca publicó menos de lo
    // esperado (el navegador escuchaba perfecto en la misma sala), pero el
    // cliente nativo de la Pi no recibía ni un frame de audio — causado por
    // un proceso pm2 viejo con entorno stale (ver README, sección Troubleshooting).
    // Se deja permanente por si el transporte de medios vuelve a quedarse a
    // medio conectar sin que la señalización lo refleje.
    this.room.on(RoomEvent.ConnectionStateChanged, state => {
      console.log(`[lk-session-debug] ConnectionStateChanged → ${state}`);
    });

    this.room.on(RoomEvent.ParticipantConnected, p => {
      console.log(`👤 Sala → se unió "${p.identity}"`);
      this.emit('participant-joined', { identity: p.identity, kind: p.kind });
    });

    this.room.on(RoomEvent.ParticipantDisconnected, p => {
      console.log(`👋 Sala → se fue "${p.identity}"`);
      this.emit('participant-left', { identity: p.identity });
    });

    this.room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        console.log(`🤖 Agente → conectado, ya podés escucharlo ("${participant.identity}")`);
        // Agent vivo → cancelar watchdog y resetear contador de reintentos
        this._agentSubscribed   = true;
        this._reconnectAttempts = 0;
        this._clearAgentWatchdog();
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

    // Calidad de conexión reportada por el SDK (RTT/packet loss reales del
    // transporte WebRTC, no algo que calculemos nosotros) — solo nos importa
    // la de NUESTRA propia conexión: la del agente no dice nada sobre si la
    // Pi está perdiendo datos, así que se descarta por identity. Expuesta
    // en getStatus() → session.connectionQuality, consumida por /local.
    this.room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant?.identity !== this.room?.localParticipant?.identity) return;
      const label = CONNECTION_QUALITY_LABELS[quality] ?? 'unknown';
      if (label !== this._connectionQuality) {
        const warn = (label === 'poor' || label === 'lost');
        console[warn ? 'warn' : 'log'](`[lk-session] 📶 Calidad de conexión → ${label}${warn ? ' ⚠ posible pérdida de datos' : ''}`);
      }
      this._connectionQuality = label;
    });

    this.room.on(RoomEvent.Disconnected, reason => {
      console.log(`🔌 LiveKit → desconectado (${reason})`);
      this._setStatus('idle');
      this.emit('disconnected', { reason });
    });
  }

  // ─── Consumir audio remoto via AudioStream → aplay ─────────────────────────
  async _consumeRemoteAudio(track) {
    const { AudioStream } = loadLk();

    // Reclamar la exclusividad: cualquier consumer anterior detectará este
    // cambio de token y saldrá del for-await en la siguiente iteración.
    const myToken = Symbol(`audio-consumer-${track.sid}`);
    const prevSid = this._activeAudioTrackSid;
    this._activeAudioConsumer = myToken;
    this._activeAudioTrackSid = track.sid;
    if (prevSid) {
      console.log(`[lk-session] ⚠ Nuevo track ${track.sid} reemplaza al anterior ${prevSid} (evita audio robótico por mezcla)`);
    }

    console.log(`[lk-session] Abriendo AudioStream sid=${track.sid}  ${SPEAKER_SAMPLE_RATE}Hz mono…`);
    // El SDK resampleará lo que llegue del peer al sampleRate que pedimos
    const stream = new AudioStream(track, SPEAKER_SAMPLE_RATE, SPEAKER_CHANNELS);

    let lastLog        = Date.now();
    let lastAmbientLog = Date.now();
    let bytesAccum = 0;
    let peakAccum  = 0;
    let framesAccum = 0;
    let firstFrame = true;

    try {
      for await (const frame of stream) {
        if (firstFrame) {
          firstFrame = false;
          console.log(`[lk-session] ✔ Primer frame del agente recibido — ${frame.data.byteLength} bytes`);
        }
        // Si llegó otro consumer, este quedó superseded → salir para no
        // intercalar frames en aplay.stdin (causa del "audio lento/robótico").
        if (this._activeAudioConsumer !== myToken) {
          console.log(`[lk-session] AudioStream sid=${track.sid} superseded → cerrando`);
          break;
        }

        // Asegurarnos que aplay sigue vivo
        if (!this.aplayProc || !this.aplayProc.stdin || !this.aplayProc.stdin.writable) {
          this._startAplay(this._speakerDevice);
        }

        if (this.aplayProc && this.aplayProc.stdin.writable) {
          // Aplicar speakerGain con clipping (si es 1.0, buf queda igual al
          // ArrayBuffer original — se evita la copia en el caso default).
          let buf;
          let framePeak = 0;
          if (this._speakerGain !== 1.0) {
            const boosted = Buffer.allocUnsafe(frame.data.byteLength);
            for (let i = 0; i < frame.data.length; i++) {
              let s = frame.data[i] * this._speakerGain;
              if (s > 32767)  s = 32767;
              if (s < -32768) s = -32768;
              boosted.writeInt16LE(s, i * 2);
              const a = s < 0 ? -s : s;
              if (a > framePeak) framePeak = a;
            }
            buf = boosted;
          } else {
            buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
            for (let i = 0; i < frame.data.length; i++) {
              const a = frame.data[i] < 0 ? -frame.data[i] : frame.data[i];
              if (a > framePeak) framePeak = a;
            }
          }

          try {
            this.aplayProc.stdin.write(buf);
          } catch (e) {
            // EPIPE si aplay murió entre el check writable y el write
            console.warn('[lk-session] aplay write:', e.code || e.message);
            break;
          }

          if (framePeak > peakAccum) peakAccum = framePeak;

          // Half-duplex: solo mutear si el frame tiene audio real (ignora silencio)
          // Umbral ~-36 dBFS: filtra ruido de fondo / silence frames del SDK
          if (framePeak > 500) {
            this._speakerActiveUntil = Date.now() + MUTE_TAIL_MS;
          }

          bytesAccum += buf.length;
          framesAccum++;
        }

        if (Date.now() - lastLog > STATS_TICK_MS) {
          const dbfs = peakAccum > 0 ? 20 * Math.log10(peakAccum / 32767) : -120;
          this._lastSpeakerPeak = peakAccum;
          const talking = dbfs > TALKING_THRESHOLD_DBFS;
          // El agente hablando TAMBIÉN cuenta como actividad — si no, una
          // respuesta larga del agente en silencio de tu lado dispararía el
          // corte por silencio a mitad de que te está contestando.
          if (talking) this._lastActivityAt = Date.now();
          if (talking !== this._speakerTalking) {
            this._speakerTalking = talking;
            console.log(talking ? '🔊 Agente → empezó a hablar' : '🔊 Agente → dejó de hablar');
          }
          // Traza continua de fondo — para poder confirmar (no asumir) si el
          // agente estaba realmente en silencio digital cuando el mic
          // disparó un falso "Usuario hablando".
          if (Date.now() - lastAmbientLog > 1000) {
            console.log(`[lk-session-debug] speaker ambient: ${dbfs.toFixed(1)}dBFS  mutingMic=${Date.now() < this._speakerActiveUntil}`);
            lastAmbientLog = Date.now();
          }
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
    // Liberar la "silla" si seguíamos siendo el consumer vigente
    if (this._activeAudioConsumer === myToken) {
      this._activeAudioConsumer = null;
      this._activeAudioTrackSid = null;
    }
    // Intentar cerrar el stream (si el SDK lo soporta) para liberar el buffer
    try { stream.close?.(); } catch {}
    console.log(`[lk-session] AudioStream terminó sid=${track.sid}`);
  }

  // ─── Spawn aplay para reproducir lo que llega del agente ──────────────────
  _startAplay(device) {
    if (this.aplayProc) return;
    console.log(`[lk-session] aplay -D ${device}  ${SPEAKER_SAMPLE_RATE}Hz mono S16_LE`);

    const args = [
      '-D', device,
      '-f', 'S16_LE',
      '-r', String(SPEAKER_SAMPLE_RATE),
      '-c', String(SPEAKER_CHANNELS),
      '-t', 'raw',
      `--buffer-size=${APLAY_BUFFER_SIZE}`,
    ];
    console.log(`[lk-session] spawn aplay ${args.join(' ')}`);
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
    // Evitar crash por EPIPE cuando aplay muere y nosotros seguimos escribiendo
    // frames al stdin (el error del stream es async, try/catch no lo atrapa).
    proc.stdin.on('error', err => {
      console.warn('[lk-session] aplay stdin error:', err.code || err.message);
    });
    proc.on('close', code => {
      console.log(`[lk-session] aplay cerrado  code=${code}`);
      if (this.aplayProc === proc) this.aplayProc = null;
    });
  }

  // Formato exacto que espera el aplay de arriba — expuesto para que quien
  // quiera escribirle directo al mismo pipe (ver playChime()) sepa a qué
  // sampleRate/canales tiene que venir el PCM, sin duplicar los números acá
  // y allá.
  getSpeakerFormat() {
    return { sampleRate: SPEAKER_SAMPLE_RATE, channels: SPEAKER_CHANNELS };
  }

  // Escribe un PCM16 corto (mismo sampleRate/canales de getSpeakerFormat())
  // directo al aplay del agente en vez de abrir uno propio — un dispositivo
  // ALSA por hardware (plughw:0,0) solo admite UN aplay a la vez, así que un
  // segundo proceso separado para un chime de notificación competía por el
  // device con este (el que gana la carrera es el que se escucha, el otro
  // falla en silencio con "Device or resource busy"). Reusar este pipe
  // evita la contención de raíz: si todavía no existe, lo arranca (mismo
  // _startAplay de siempre); si ya está abierto reproduciendo al agente,
  // el chime se intercala en el mismo stream.
  playChime(pcmBuffer) {
    if (!this.aplayProc || !this.aplayProc.stdin || !this.aplayProc.stdin.writable) {
      this._startAplay(this._speakerDevice);
    }
    if (this.aplayProc && this.aplayProc.stdin.writable) {
      try { this.aplayProc.stdin.write(pcmBuffer); }
      catch (e) { console.warn('[lk-session] playChime write:', e.code || e.message); }
    }
  }

  // ─── Auto-reconnect ──────────────────────────────────────────────────────
  _armAgentWatchdog() {
    this._clearAgentWatchdog();
    console.log(`[lk-session] ⏲ Watchdog armado: esperando agent ${AGENT_DETECT_TIMEOUT_MS}ms`);
    this._agentWatchdog = setTimeout(() => {
      this._agentWatchdog = null;
      if (this._agentSubscribed) return;
      console.warn(`[lk-session] ⚠ Agent no se suscribió en ${AGENT_DETECT_TIMEOUT_MS}ms → auto-reconnect`);
      this._triggerReconnect('agent-not-subscribed').catch(e =>
        console.error('[lk-session] reconnect error:', e.message));
    }, AGENT_DETECT_TIMEOUT_MS);
  }

  _clearAgentWatchdog() {
    if (this._agentWatchdog) {
      clearTimeout(this._agentWatchdog);
      this._agentWatchdog = null;
    }
  }

  async _triggerReconnect(reason) {
    if (this._isReconnecting) return;
    this._isReconnecting = true;

    if (this._reconnectAttempts >= AGENT_MAX_RETRIES) {
      console.error(`[lk-session] ✘ Auto-reconnect agotado (${this._reconnectAttempts}/${AGENT_MAX_RETRIES}). Agent muerto.`);
      this.emit('agent-dead', { attempts: this._reconnectAttempts, reason });
      this._reconnectAttempts = 0;
      this._isReconnecting    = false;
      await this.stop().catch(() => {});
      return;
    }

    this._reconnectAttempts++;
    const attempt = this._reconnectAttempts;
    console.log(`🔁 LiveKit → reintentando conexión (${attempt}/${AGENT_MAX_RETRIES}) — ${reason}`);
    this.emit('reconnecting', { attempt, reason });

    // Guardar mic/speaker antes de que stop() limpie _startArgs — el token,
    // url y roomName viejos NO sirven: la sala es efímera (una por conversación)
    // y ya quedó marcada para destruirse, así que hay que pedir credenciales
    // nuevas al rag-api en vez de reconectar con las mismas.
    const prevArgs = this._startArgs;
    await this.stop().catch(() => {});

    // Esperar a que el room vacío se destruya (emptyTimeout=5s en el token)
    console.log(`[lk-session] ⏳ Esperando ${AGENT_RETRY_DELAY_MS}ms para que el room se destruya…`);
    await new Promise(r => setTimeout(r, AGENT_RETRY_DELAY_MS));

    if (!prevArgs) {
      console.warn('[lk-session] No hay args para reconectar — abort');
      this._isReconnecting = false;
      return;
    }
    try {
      console.log('[lk-session] Pidiendo token nuevo para el reintento…');
      const { token, roomName, serverUrl: url } = await requestRoomToken();
      // Nota: mantenemos _isReconnecting=true durante el start() para que la
      // UI no muestre "sesión perdida" entre medio.
      await this.start({ token, url, roomName, micDevice: prevArgs.micDevice, speakerDevice: prevArgs.speakerDevice });
    } catch (err) {
      console.error(`[lk-session] Reintento ${attempt} falló:`, err.message);
    } finally {
      this._isReconnecting = false;
    }
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

  setSpeakerGain(g) {
    if (typeof g !== 'number' || isNaN(g) || g < 0 || g > 32) return false;
    this._speakerGain = g;
    console.log(`[lk-session] speaker gain → ${g}x`);
    return true;
  }

  getSpeakerGain() { return this._speakerGain; }

  setTalkThreshold(v) {
    if (typeof v !== 'number' || isNaN(v) || v < -80 || v > 0) return false;
    TALKING_THRESHOLD_DBFS = v;
    console.log(`[lk-session] talk threshold → ${v} dBFS`);
    return true;
  }

  getTalkThreshold() { return TALKING_THRESHOLD_DBFS; }

  // ─── Gate de ruido sobre el audio publicado (ver _publishMic) ───────────
  setMicGateEnabled(v) {
    this._micGateEnabled = !!v;
    console.log(`[lk-session] mic gate ${this._micGateEnabled ? 'ACTIVADO' : 'DESACTIVADO'}`);
    return this._micGateEnabled;
  }
  getMicGateEnabled() { return this._micGateEnabled; }

  setMicGateAttenuationDb(v) {
    if (typeof v !== 'number' || isNaN(v) || v < -90 || v > 0) return false;
    this._micGateAttenuationDb = v;
    console.log(`[lk-session] mic gate atenuación → ${v} dB`);
    return true;
  }
  getMicGateAttenuationDb() { return this._micGateAttenuationDb; }

  setMicPrerollMs(ms) {
    if (typeof ms !== 'number' || isNaN(ms) || ms < 300 || ms > 2000) return false;
    this._micPrerollMs = ms;
    console.log(`[lk-session] mic preroll → ${ms}ms`);
    return true;
  }
  getMicPrerollMs() { return this._micPrerollMs; }

  // ─── Corte automático por silencio ──────────────────────────────────────
  setSilenceTimeout(ms) {
    if (typeof ms !== 'number' || isNaN(ms) || ms < 0 || ms > 30 * 60 * 1000) return false;
    SILENCE_DISCONNECT_MS = ms;
    console.log(`[lk-session] corte por silencio → ${ms === 0 ? 'desactivado' : ms + 'ms'}`);
    return true;
  }

  getSilenceTimeout() { return SILENCE_DISCONNECT_MS; }

  _startSilenceWatch() {
    this._stopSilenceWatch();
    if (SILENCE_DISCONNECT_MS <= 0) return; // 0 = desactivado
    this._silenceCheckTimer = setInterval(() => {
      if (!this.isActive()) return;
      const silentForMs = Date.now() - this._lastActivityAt;
      if (silentForMs >= SILENCE_DISCONNECT_MS) {
        console.log(`[lk-session] 🔇 Sin actividad hace ${Math.round(silentForMs / 1000)}s (límite ${Math.round(SILENCE_DISCONNECT_MS / 1000)}s) — desconectando sola`);
        this.stop('silence-timeout').catch(e => console.error('[lk-session] stop por silencio:', e.message));
      }
    }, SILENCE_CHECK_TICK_MS);
    if (this._silenceCheckTimer.unref) this._silenceCheckTimer.unref();
  }

  _stopSilenceWatch() {
    if (this._silenceCheckTimer) {
      clearInterval(this._silenceCheckTimer);
      this._silenceCheckTimer = null;
    }
  }

  setMicEnabled(v) {
    this._micEnabled = !!v;
    console.log(`[lk-session] mic ${this._micEnabled ? 'ACTIVADO' : 'DESACTIVADO'} (toggle manual)`);
    return this._micEnabled;
  }

  getMicEnabled() { return this._micEnabled; }

  getStatus() {
    return {
      status:        this.status,
      roomName:      this.room?.name || null,
      identity:      this.room?.localParticipant?.identity || null,
      isConnected:   !!this.room?.isConnected,
      remoteParticipants: this.room
        ? Array.from(this.room.remoteParticipants.values()).map(p => p.identity)
        : [],
      micActive:        !!this.arecordProc,
      speakerActive:    !!this.aplayProc,
      lastMicPeak:      this._lastMicPeak,
      lastSpeakerPeak:  this._lastSpeakerPeak,
      micMuted:         Date.now() < this._speakerActiveUntil,
      micGain:       this._micGain,
      micEnabled:    this._micEnabled,
      talkThreshold: TALKING_THRESHOLD_DBFS,
      speakerGain:   this._speakerGain,
      micGateEnabled:       this._micGateEnabled,
      voiceActive:          this._voiceActive,
      micGateAttenuationDb: this._micGateAttenuationDb,
      micPrerollMs:         this._micPrerollMs,
      // 'poor'/'lost'/'good'/'excellent'/null — ver RoomEvent.ConnectionQualityChanged en _wireRoomEvents()
      connectionQuality:    this._connectionQuality,
      // Auto-reconnect: isReconnecting=true durante todo el ciclo stop+wait+start.
      // La UI debe mantener "sesión activa" mientras esto sea true en lugar de
      // mostrar "sesión perdida".
      isReconnecting:    this._isReconnecting,
      reconnectAttempt:  this._reconnectAttempts,
      reconnectMax:      AGENT_MAX_RETRIES,
    };
  }

  // ─── stop(): cerrar todo en orden ─────────────────────────────────────────
  async stop(reason = 'stopped') {
    console.log('[lk-session] Cerrando sesión…');
    this._micPublishing = false; // corta el guard de _publishMic ANTES de cualquier await de acá abajo
    this._setStatus('idle');
    this._clearAgentWatchdog();
    this._stopSilenceWatch();

    // Invalidar cualquier consumer de audio que siga corriendo
    this._activeAudioConsumer = null;
    this._activeAudioTrackSid = null;

    // Si es un stop manual (no desde _triggerReconnect), limpiar args y counters
    if (!this._isReconnecting) {
      this._startArgs         = null;
      this._reconnectAttempts = 0;
    }

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
    this.emit('disconnected', { reason });
  }
}

// ─── Singleton compartido por toda la app ────────────────────────────────────
const session = new LiveKitSession();

module.exports = { LiveKitSession, session };
