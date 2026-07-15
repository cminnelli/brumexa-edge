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

const RAG_API_URL        = process.env.RAG_API_URL || 'http://localhost:4000';
const DEVICE_ID           = process.env.BRUMEXA_DEVICE_ID;
const API_KEY             = process.env.BRUMEXA_API_KEY;
const DEFAULT_BUSINESS_ID = process.env.DEFAULT_BUSINESS_ID || null;

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
async function initAuth() {
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
};
