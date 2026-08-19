'use strict';

/**
 * lib/rag-token.js
 *
 * Pide un token de LiveKit por conversación a brumexa-rag-api-v2
 * (POST /livekit/token). Cada llamada crea una sala nueva y efímera
 * en LiveKit (no hay una sala fija por dispositivo) — por eso se llama
 * una vez por sesión, nunca se reutiliza el token entre sesiones.
 *
 * Puerto de brumexa-device-client/src/livekitToken.ts.
 */

const ragAuth = require('./rag-auth');

// let (no const) — setCredentials() los cambia en caliente junto con
// ragAuth.setCredentials() desde /configuracion, sin reiniciar el proceso.
let RAG_API_URL = process.env.RAG_API_URL || 'http://localhost:4000';
let DEVICE_ID    = process.env.BRUMEXA_DEVICE_ID;

function setCredentials({ ragApiUrl, deviceId } = {}) {
  if (ragApiUrl !== undefined && ragApiUrl !== '') RAG_API_URL = ragApiUrl;
  if (deviceId  !== undefined && deviceId  !== '') DEVICE_ID   = deviceId;
}

// Devuelve { token, roomName, serverUrl, businessId }
async function requestRoomToken() {
  await ragAuth.ensureAuth();

  const businessId = ragAuth.getBusinessId();
  const branchId    = ragAuth.getBranchId();
  if (!businessId) {
    throw new Error('No hay businessId — revisá BRUMEXA_DEVICE_ID/DEFAULT_BUSINESS_ID en .env');
  }

  console.log('🎫 API RAG → pidiendo token de LiveKit…');
  const res = await fetch(`${RAG_API_URL}/livekit/token`, {
    method:  'POST',
    headers: {
      'Authorization': ragAuth.getAuthHeader(),
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      businessId,
      deviceId: DEVICE_ID,
      ...(branchId ? { branchId } : {}),
      identity: `device-${DEVICE_ID}-${Date.now()}`,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.log(`❌ API RAG → no se pudo obtener el token (HTTP ${res.status})`);
    throw new Error(`Error obteniendo token LiveKit (${res.status}): ${body?.error || 'desconocido'}`);
  }

  const data = await res.json();
  console.log(`✅ Token LiveKit → recibido, sala "${data.roomName}"`);
  return data;
}

module.exports = { requestRoomToken, setCredentials };
