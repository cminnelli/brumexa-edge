// ¿Está la API de Brumexa (RAG_API_URL) al alcance? Si la Pi arranca con el
// servidor apagado, o se cae después, hay que notarlo solo y recuperarse solo
// cuando vuelve — antes recién se reintentaba al decir "hey brumexa".
//
//   start({ getUrl, onChange })  → empieza a chequear GET /health
//   isUp()                       → último estado conocido (true al arrancar)
//
// Mientras está caída chequea seguido (DOWN_POLL_MS) para recuperarse rápido;
// cuando está bien, cada UP_POLL_MS. onChange(up) avisa solo en los cambios.
'use strict';

const UP_POLL_MS   = 30000;
const DOWN_POLL_MS = 5000;
const TIMEOUT_MS   = 4000;
const FAILS_TO_DOWN = 2;   // un fallo suelto (un hipo de red) no cuenta como caída

let up = true;
let fails = 0;
let timer = null;

async function _check(getUrl, onChange) {
  let ok = false;
  try {
    const res = await fetch(`${getUrl()}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    ok = res.ok;
  } catch { /* inalcanzable */ }
  fails = ok ? 0 : fails + 1;
  const nowUp = ok || (up && fails < FAILS_TO_DOWN);
  if (nowUp !== up) {
    up = nowUp;
    console.log(up ? '✅ [server] la API volvió a responder' : `❌ [server] la API no responde (${getUrl()}) — reintento cada ${DOWN_POLL_MS / 1000}s`);
    try { onChange(up); } catch (e) { console.warn('[server] onChange:', e.message); }
  }
  timer = setTimeout(() => _check(getUrl, onChange), up && fails === 0 ? UP_POLL_MS : DOWN_POLL_MS);
  if (timer.unref) timer.unref();
}

function start({ getUrl, onChange }) {
  if (timer) return;
  void _check(getUrl, onChange);
}

module.exports = { start, isUp: () => up };
