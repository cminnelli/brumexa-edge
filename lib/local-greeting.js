'use strict';

/**
 * lib/local-greeting.js
 *
 * Frases grabadas con la voz del agente, guardadas en disco para decirlas al
 * instante sin depender de la conexión:
 *   - greeting: el saludo, al oír "ei brúmexa" (mientras se conecta de fondo).
 *   - error:    "no me pude conectar", si la conexión falla del todo.
 * Las dos se editan en el admin (agente → saludo / mensaje si no conecta).
 *
 * Se bajan de la API (GET /livekit/greeting-audio?kind=, PCM 16 bits mono
 * 48 kHz) al arrancar y al cambiar negocio/dispositivo. Si se editan en el
 * admin, el token de la próxima charla trae sus códigos (noteEtags) y se
 * bajan al terminarla — no hay consultas periódicas.
 *
 * API: load(), refresh(), get(kind) → { etag, text, pcm } | null,
 *      noteEtags({ greeting, error }), refreshIfStale().
 */

const fs   = require('fs');
const path = require('path');
const ragAuth  = require('./rag-auth');
const ragToken = require('./rag-token');

const DIR   = path.join(__dirname, '..', 'data');
const KINDS = ['greeting', 'error'];
const files = (kind) => ({ pcm: path.join(DIR, `${kind}.pcm`), meta: path.join(DIR, `${kind}.json`) });

const cached = { greeting: null, error: null };
const stale  = { greeting: false, error: false };

// Dueño de lo guardado: si la Pi pasa a otro negocio/dispositivo (desde
// /configuracion), el audio viejo no se usa más.
function _owner() {
  return `${ragAuth.getBusinessId() || ''}|${ragToken.getApiInfo().deviceId || ''}`;
}
const _secs = (pcm) => (pcm.length / 96000).toFixed(1);

function load() {
  for (const kind of KINDS) {
    try {
      const f = files(kind);
      cached[kind] = { ...JSON.parse(fs.readFileSync(f.meta, 'utf8')), pcm: fs.readFileSync(f.pcm) };
      console.log(`[greeting] ${kind} grabado cargado (${_secs(cached[kind].pcm)} s): "${cached[kind].text}"`);
    } catch {
      cached[kind] = null;
    }
  }
}

function _clear(kind) {
  cached[kind] = null;
  const f = files(kind);
  for (const p of [f.pcm, f.meta]) { try { fs.unlinkSync(p); } catch {} }
}

async function _refreshOne(kind) {
  try {
    await ragAuth.ensureAuth();
    const businessId = ragAuth.getBusinessId();
    if (!businessId) return;
    const { url, deviceId } = ragToken.getApiInfo();
    const qs = new URLSearchParams({ businessId, kind, ...(deviceId ? { deviceId } : {}) });
    const mine = cached[kind];
    const sameOwner = mine?.owner === _owner();
    const res = await fetch(`${url}/livekit/greeting-audio?${qs}`, {
      headers: { Authorization: ragAuth.getAuthHeader(), ...(sameOwner ? { 'If-None-Match': mine.etag } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 304 && sameOwner) return;
    if (res.status === 204) { if (mine) console.log(`[greeting] ${kind}: el agente no tiene esa frase grabable`); _clear(kind); return; }
    if (!res.ok) { console.warn(`[greeting] ${kind}: no se pudo bajar (HTTP ${res.status})`); return; }

    const pcm   = Buffer.from(await res.arrayBuffer());
    const etag  = res.headers.get('etag') || '';
    const text  = decodeURIComponent(res.headers.get('x-greeting-text') || '');
    const owner = _owner();
    const f = files(kind);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(f.pcm, pcm);
    fs.writeFileSync(f.meta, JSON.stringify({ etag, text, owner }));
    cached[kind] = { etag, text, owner, pcm };
    console.log(`[greeting] ${kind} grabado actualizado (${_secs(pcm)} s): "${text}"`);
  } catch (e) {
    console.warn(`[greeting] ${kind} refresh:`, e.message);
  }
}

async function refresh() {
  for (const kind of KINDS) await _refreshOne(kind);
}

function get(kind = 'greeting') {
  const c = cached[kind];
  return c && c.owner === _owner() ? c : null;
}

// Códigos actuales que vienen con el token: lo que no coincide se baja al
// terminar la charla.
function noteEtags(etags = {}) {
  for (const kind of KINDS) {
    if (!(kind in etags)) continue;
    stale[kind] = (etags[kind] ?? null) !== (get(kind)?.etag ?? null);
    if (stale[kind]) console.log(`[greeting] ${kind} cambió en el admin — se baja al terminar esta charla`);
  }
}

async function refreshIfStale() {
  for (const kind of KINDS) {
    if (!stale[kind]) continue;
    stale[kind] = false;
    await _refreshOne(kind);
  }
}

module.exports = { load, refresh, get, noteEtags, refreshIfStale };
