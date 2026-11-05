'use strict';

/**
 * lib/local-greeting.js
 *
 * Saludo grabado del agente: se baja de la API (GET /livekit/greeting-audio,
 * PCM 16 bits mono 48 kHz) y se guarda en disco. Al oír "ei brúmexa" la Pi lo
 * dice al instante, mientras la conexión a LiveKit se arma de fondo — antes
 * el saludo llegaba recién cuando el agente estaba listo (3 a 9 s).
 *
 * API: load() al arrancar, refresh() para traer cambios (ETag: solo baja el
 * audio si cambió el saludo o la voz), get() → { etag, text, pcm } | null.
 */

const fs   = require('fs');
const path = require('path');
const ragAuth  = require('./rag-auth');
const ragToken = require('./rag-token');

const DIR  = path.join(__dirname, '..', 'data');
const PCM  = path.join(DIR, 'greeting.pcm');
const META = path.join(DIR, 'greeting.json');

let cached = null;

// Dueño del saludo guardado: si la Pi pasa a otro negocio/dispositivo
// (desde /configuracion), el audio viejo no se usa más.
function _owner() {
  return `${ragAuth.getBusinessId() || ''}|${ragToken.getApiInfo().deviceId || ''}`;
}

function load() {
  try {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    cached = { ...meta, pcm: fs.readFileSync(PCM) };
    console.log(`[greeting] saludo grabado cargado (${(cached.pcm.length / 96000).toFixed(1)} s): "${cached.text}"`);
  } catch {
    cached = null;
  }
}

function clear() {
  cached = null;
  for (const f of [PCM, META]) { try { fs.unlinkSync(f); } catch {} }
}

async function refresh() {
  try {
    await ragAuth.ensureAuth();
    const businessId = ragAuth.getBusinessId();
    if (!businessId) return;
    const { url, deviceId } = ragToken.getApiInfo();
    const qs = new URLSearchParams({ businessId, ...(deviceId ? { deviceId } : {}) });
    const sameOwner = cached?.owner === _owner();
    const res = await fetch(`${url}/livekit/greeting-audio?${qs}`, {
      headers: { Authorization: ragAuth.getAuthHeader(), ...(sameOwner ? { 'If-None-Match': cached.etag } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    // 304 solo cuenta si el guardado es de este mismo negocio/dispositivo.
    if (res.status === 304 && cached?.owner === _owner()) return;
    if (res.status === 204) { if (cached) console.log('[greeting] el agente no tiene saludo grabable — se usa el del agente'); clear(); return; }
    if (!res.ok) { console.warn(`[greeting] no se pudo bajar el saludo (HTTP ${res.status})`); return; }

    const pcm  = Buffer.from(await res.arrayBuffer());
    const etag = res.headers.get('etag') || '';
    const text = decodeURIComponent(res.headers.get('x-greeting-text') || '');
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(PCM, pcm);
    const owner = _owner();
    fs.writeFileSync(META, JSON.stringify({ etag, text, owner }));
    cached = { etag, text, owner, pcm };
    console.log(`[greeting] saludo grabado actualizado (${(pcm.length / 96000).toFixed(1)} s): "${text}"`);
  } catch (e) {
    console.warn('[greeting] refresh:', e.message);
  }
}

function get() { return cached && cached.owner === _owner() ? cached : null; }

module.exports = { load, refresh, get };
