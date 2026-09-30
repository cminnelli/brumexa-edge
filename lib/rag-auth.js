'use strict';

/**
 * lib/rag-auth.js
 *
 * Login del dispositivo contra brumexa-rag-api-v2 (POST /auth/device).
 * Reemplaza al LIVEKIT_TOKEN estático: en vez de un JWT de LiveKit
 * hardcodeado en .env, este módulo obtiene un JWT de DISPOSITIVO (24h,
 * se auto-renueva) que después se usa como Authorization Bearer para
 * pedir tokens de LiveKit (ver lib/rag-token.js) uno por conversación.
 *
 * Puerto de brumexa-device-client/src/auth.ts, adaptado a CommonJS y a
 * un servidor Express de larga vida (no un proceso standalone con loop):
 * si el login falla al boot (RAG API caído), no tira el proceso —
 * se reintenta on-demand la próxima vez que se pida un token.
 */

// let (no const) — setCredentials() los cambia en caliente desde
// /configuracion sin reiniciar el proceso (ver server.js POST /setup/config).
// Las URLs se arman después pegando "${RAG_API_URL}/auth/device" — una
// barra final en lo que se guarda (típico al tipearla a mano, ej.
// "http://host:4000/") da "http://host:4000//auth/device" (doble barra), que
// puede fallar según el servidor. Sacarla acá, una sola vez, evita que
// dependa de cómo la haya escrito quien la configuró.
function _stripTrailingSlash(url) { return url ? url.replace(/\/+$/, '') : url; }

const fs   = require('fs');
const path = require('path');

// Caché en disco del token de dispositivo — sin esto, cada reinicio del
// proceso (reboot de la Pi, o una actualización vía /configuracion/update)
// perdía el token JWT cacheado en memoria y forzaba un login nuevo contra
// rag-api antes de poder atender el primer "hey brumexa" (viaje de red
// extra, ~1-1.3s). El token en sí no cambia de naturaleza por guardarse acá:
// sigue siendo el mismo JWT de 24hs que ya viaja en cada pedido como
// Authorization Bearer — la API key real (la credencial de verdad, de
// "por vida") sigue viviendo solo en .env, nunca en este archivo. data/ ya
// sobrevive las actualizaciones de blue-green (ver lib/configuracion.js,
// mismo mecanismo que logs/ y recordings/).
const TOKEN_CACHE_PATH = path.join(__dirname, '..', 'data', 'device-token-cache.json');

function _loadTokenCache() {
  try {
    const raw    = fs.readFileSync(TOKEN_CACHE_PATH, 'utf8');
    const cached = JSON.parse(raw);
    if (!cached || typeof cached.expiresAt !== 'number' || cached.expiresAt <= Date.now()) return null;
    // Si cambiaron las credenciales (otro deviceId) desde que se guardó este
    // caché, no es válido para el dispositivo actual — descartarlo.
    if (cached.deviceId !== DEVICE_ID) return null;
    return cached;
  } catch {
    return null; // no existe, corrupto, o cualquier otro error — no es fatal, se loguea normal
  }
}

function _saveTokenCache() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({
      token: state.token, businessId: state.businessId, branchId: state.branchId,
      expiresAt: state.expiresAt, deviceId: DEVICE_ID,
    }));
  } catch (e) {
    console.warn('[rag-auth] no se pudo guardar el caché de token en disco (no es fatal):', e.message);
  }
}

function _clearTokenCache() {
  try { fs.unlinkSync(TOKEN_CACHE_PATH); } catch {}
}

let RAG_API_URL        = _stripTrailingSlash(process.env.RAG_API_URL) || 'http://localhost:4000';
let DEVICE_ID           = process.env.BRUMEXA_DEVICE_ID;
let API_KEY             = process.env.BRUMEXA_API_KEY;
const DEFAULT_BUSINESS_ID = process.env.DEFAULT_BUSINESS_ID || null;

// Aplica credenciales nuevas en caliente y tira la sesión vieja — el
// próximo ensureAuth()/login() (o el refresh ya agendado) va a autenticar
// con las credenciales nuevas. No hace falta reiniciar el proceso.
function setCredentials({ ragApiUrl, deviceId, apiKey } = {}) {
  if (ragApiUrl !== undefined && ragApiUrl !== '') RAG_API_URL = _stripTrailingSlash(ragApiUrl);
  if (deviceId  !== undefined && deviceId  !== '') DEVICE_ID   = deviceId;
  if (apiKey    !== undefined && apiKey    !== '') API_KEY     = apiKey;
  state = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  lastError = null;
  _clearTokenCache(); // credenciales nuevas → el token cacheado (si había) quedó para el dispositivo/API key viejos
}

let state        = null;  // { token, businessId, branchId, expiresAt }
let refreshTimer = null;
let lastError    = null;  // { message, at } — último fallo de login/refresh, para diagnóstico

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp * 1000;
  } catch {
    return Date.now() + 23 * 60 * 60 * 1000;
  }
}

async function login() {
  if (!DEVICE_ID || !API_KEY) {
    const err = new Error('BRUMEXA_DEVICE_ID / BRUMEXA_API_KEY no configurados en .env');
    lastError = { message: err.message, at: Date.now() };
    throw err;
  }

  console.log(`🔑 API RAG → verificando API key del dispositivo "${DEVICE_ID}"…`);
  console.log(`   POST ${RAG_API_URL}/auth/device  device_id="${DEVICE_ID}"  api_key=${maskApiKey(API_KEY)}`);
  let res;
  try {
    res = await fetch(`${RAG_API_URL}/auth/device`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ device_id: DEVICE_ID, api_key: API_KEY }),
    });
  } catch (e) {
    // Fallo de red (RAG_API_URL inalcanzable, DNS, conexión rechazada, etc.)
    // — distinto de un 4xx/5xx de la API, que sí respondió pero rechazó.
    console.log(`❌ API RAG → no se pudo conectar a ${RAG_API_URL}`);
    const err = new Error(`No se pudo conectar a ${RAG_API_URL} — ${e.message}`);
    lastError = { message: err.message, at: Date.now() };
    throw err;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.log(`❌ API RAG → API key rechazada (HTTP ${res.status})`);
    console.log(`   respuesta: ${JSON.stringify(body)}`);
    const err  = new Error(`[rag-auth] Login fallido (${res.status}): ${body?.error || 'error desconocido'}`);
    lastError = { message: err.message, at: Date.now() };
    throw err;
  }

  const data = await res.json();
  const exp  = decodeJwtExp(data.token);

  state = {
    token:      data.token,
    businessId: data.device?.businessId,
    branchId:   data.device?.branchId || null,
    expiresAt:  exp,
  };
  lastError = null;
  _saveTokenCache();

  scheduleRefresh(exp);
  console.log(`✅ API RAG → autorizado (negocio "${state.businessId}") — token válido hasta ${new Date(exp).toLocaleTimeString()}`);
}

function scheduleRefresh(expiresAt) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const refreshIn = Math.max(0, expiresAt - Date.now() - 30 * 60 * 1000);
  refreshTimer = setTimeout(async () => {
    console.log('[rag-auth] Renovando token de dispositivo…');
    try {
      await login();
    } catch (e) {
      console.error(`[rag-auth] Error renovando: ${e.message} — reintento en 2 min`);
      refreshTimer = setTimeout(() => login().catch(err => console.error('[rag-auth]', err.message)), 2 * 60 * 1000);
    }
  }, refreshIn);
  if (refreshTimer.unref) refreshTimer.unref();
}

// Login inicial al boot del servidor. No lanza: si el RAG API está
// caído en ese momento, queda sin autenticar y se reintenta on-demand
// (ver ensureAuth) la próxima vez que alguien pida un token.
//
// Antes de pedir un token nuevo por red, se intenta el caché en disco
// (_loadTokenCache) — si el proceso se reinició pero el token de la vez
// anterior todavía es válido (dura 24hs), se reusa tal cual y el primer
// "hey brumexa" después de un reinicio no paga el login extra. Si no hay
// caché válido (primera vez, venció, o cambiaron las credenciales), cae al
// login normal como siempre.
async function initAuth() {
  const cached = _loadTokenCache();
  if (cached) {
    state = { token: cached.token, businessId: cached.businessId, branchId: cached.branchId, expiresAt: cached.expiresAt };
    scheduleRefresh(cached.expiresAt);
    console.log(`✅ API RAG → token de dispositivo recuperado del caché en disco (negocio "${state.businessId}") — válido hasta ${new Date(cached.expiresAt).toLocaleTimeString()}`);
    return;
  }

  try {
    await login();
  } catch (e) {
    console.error(`[rag-auth] ✘ initAuth falló: ${e.message} — se reintentará al pedir un token`);
  }
}

// Garantiza que haya una sesión vigente antes de pedir un token de LiveKit.
async function ensureAuth() {
  if (!state) await login();
}

function isAuthenticated() {
  return !!state;
}

function getAuthHeader() {
  if (!state) throw new Error('[rag-auth] No autenticado — llamá ensureAuth()/login() primero');
  return `Bearer ${state.token}`;
}

function getBusinessId() {
  return state?.businessId || DEFAULT_BUSINESS_ID;
}

function getBranchId() {
  return state?.branchId || null;
}

function maskApiKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(10)}${key.slice(-4)} (${key.length} caracteres)`;
}

function getStatus() {
  return {
    ragApiUrl:      RAG_API_URL,
    deviceId:       DEVICE_ID || null,
    deviceIdSet:    !!DEVICE_ID,
    apiKeySet:      !!API_KEY,
    apiKeyMasked:   maskApiKey(API_KEY),
    businessIdEnv:  DEFAULT_BUSINESS_ID,
    authenticated:  !!state,
    businessId:     state?.businessId || null,
    branchId:       state?.branchId || null,
    tokenExpiresAt: state?.expiresAt || null,
    lastError,
  };
}

module.exports = {
  initAuth,
  ensureAuth,
  isAuthenticated,
  getAuthHeader,
  getBusinessId,
  getBranchId,
  getStatus,
  login,
  setCredentials,
};
