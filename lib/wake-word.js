'use strict';

/**
 * lib/wake-word.js
 *
 * Escucha "Hey Brumexa" arrancando wake-word/listen.py (Python, openWakeWord)
 * como proceso hijo y mandándole el mismo audio que ya usa el monitor de mic
 * idle (startMicMonitor() en server.js). Ese script avisa por stdout cuando
 * la escucha.
 *
 * Este módulo NO sabe nada de LiveKit, tokens ni sesiones — solo sabe
 * "prender el proceso, mandarle audio, avisar cuando detecta". Es el mismo
 * patrón que este repo ya usa para arecord/aplay (ver lib/livekit-session.js):
 * spawn + leer stdout, nada nuevo para el codebase.
 *
 * Por qué Python: "Hey Brumexa" es un nombre de marca inventado — hace
 * falta un motor entrenado específicamente en esa frase (openWakeWord), no
 * un reconocedor de voz de diccionario genérico. openWakeWord es Python
 * puro, sin binding de Node — por eso vive en su propia carpeta (wake-word/)
 * con su propio venv, aislado del resto del proyecto Node.
 *
 * Uso:
 *   const wakeWord = require('./lib/wake-word');
 *   wakeWord.start();          // una vez, al boot — arranca el proceso Python
 *   wakeWord.feed(pcmChunk);   // por cada chunk de audio (16kHz mono S16LE)
 *   wakeWord.on('wake', () => …);
 */

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');
const readline          = require('readline');
const path              = require('path');
const fs                = require('fs');

const WAKE_WORD_DIR   = path.join(__dirname, '..', 'wake-word');
const LISTEN_SCRIPT   = path.join(WAKE_WORD_DIR, 'listen.py');
const VENV_PYTHON_WIN = path.join(WAKE_WORD_DIR, 'venv', 'Scripts', 'python.exe');
const VENV_PYTHON_NIX = path.join(WAKE_WORD_DIR, 'venv', 'bin', 'python3');

// Preferimos el Python del venv aislado (wake-word/venv) si existe — evita
// pisar/depender del Python global del sistema. Si no existe, caemos al
// "python3" del PATH (útil en dev si alguien no armó el venv todavía).
function findPython() {
  if (process.env.WAKE_WORD_PYTHON) return process.env.WAKE_WORD_PYTHON;
  if (fs.existsSync(VENV_PYTHON_WIN)) return VENV_PYTHON_WIN;
  if (fs.existsSync(VENV_PYTHON_NIX)) return VENV_PYTHON_NIX;
  return 'python3';
}

class WakeWord extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
  }

  // Arranca el proceso Python. Se llama una sola vez, al boot.
  start() {
    if (this._proc) return;
    if (!process.env.WAKE_WORD_MODEL_PATH) {
      console.warn('[wake-word] falta WAKE_WORD_MODEL_PATH en .env — wake word deshabilitada');
      return;
    }

    const python = findPython();
    console.log(`[wake-word] arrancando ${python} ${LISTEN_SCRIPT}`);
    const proc = spawn(python, [LISTEN_SCRIPT], { env: process.env });
    this._proc = proc;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._handleLine(line));

    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log('[wake-word:py]', msg);
    });

    proc.on('error', (err) => {
      console.error('[wake-word] no se pudo arrancar Python:', err.message);
      this._proc = null;
    });

    proc.on('exit', (code) => {
      console.warn(`[wake-word] el proceso Python terminó (code=${code})`);
      if (this._proc === proc) this._proc = null;
    });
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'wake') {
      console.log('[wake-word] 👂 detectada');
      this.emit('wake');
    }
  }

  get isEnabled() {
    return !!this._proc;
  }

  // Recibe un chunk crudo de PCM (Int16 S16LE mono, 16kHz — el mismo audio
  // que ya arma startMicMonitor() para el LED) y se lo pasa directo al
  // proceso Python por su stdin.
  feed(chunk) {
    if (!this._proc || !this._proc.stdin.writable) return;
    this._proc.stdin.write(chunk);
  }
}

// Singleton compartido, mismo patrón que lib/livekit-session.js
module.exports = new WakeWord();
