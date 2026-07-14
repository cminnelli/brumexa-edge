# Brumexa-Edge

Cliente de voz para LiveKit que corre en **Raspberry Pi** (Ubuntu ARM) o **PC** (Windows/Linux/macOS). Captura el micrófono del sistema operativo y lo publica a una sala de LiveKit.

## Arquitectura

```
Browser (frontend)
  │
  ├── GET /config        → info del dispositivo (estado de auth, última URL LiveKit conocida)
  ├── GET /token         → pide un token NUEVO a brumexa-rag-api-v2 → lo reenvía al browser
  ├── POST /session/*    → modo nativo Pi (arecord/aplay + @livekit/rtc-node, sin pasar por el browser)
  └── (estático)         → sirve index.html / app.js / style.css
        │
        └── WebSocket wss://...  (browser o proceso Node conecta con el token recién emitido)
              └── getUserMedia() / arecord → publica audio vía WebRTC
```

El servidor Express **no genera tokens localmente** — se autentica como dispositivo contra `brumexa-rag-api-v2` (`POST /auth/device`) y le pide un token de LiveKit nuevo por cada conversación (`POST /livekit/token`). Ver `lib/rag-auth.js` y `lib/rag-token.js`.

## Requisitos

- Node.js 20+
- `brumexa-rag-api-v2` corriendo y accesible en la red (local o LAN)
- Un dispositivo dado de alta en `brumexa-admin-v2` (Devices) con su `deviceId` y `apiKey`

## Instalación

```bash
cp .env.example .env
# completar RAG_API_URL / BRUMEXA_DEVICE_ID / BRUMEXA_API_KEY en .env
npm install
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `RAG_API_URL` | URL del servidor central `brumexa-rag-api-v2` |
| `BRUMEXA_DEVICE_ID` | ID del dispositivo, dado de alta en `brumexa-admin-v2` |
| `BRUMEXA_API_KEY` | API key del dispositivo (se genera/rota desde el admin panel) |
| `DEFAULT_BUSINESS_ID` | Fallback opcional si `/auth/device` no devolviera `businessId` |
| `PORT` | Puerto del servidor Express (default: 3000) |
| `MIC_GAIN` | Ganancia de software del micrófono |

## Uso

```bash
npm start          # producción
npm run brumexa    # desarrollo con nodemon
```

Abrir `http://localhost:3000` en el browser.

## Modos

- **LiveKit** — conecta a una sala LiveKit nueva y publica el micrófono del OS. Requiere `brumexa-rag-api-v2` activo y el dispositivo autenticado.
- **Test Mic** — verifica el micrófono localmente con un VU meter. Sin servidor, sin internet.

Funciona igual corriendo en una Raspberry Pi (modo nativo, `@livekit/rtc-node` + ALSA) que en una PC de desarrollo (modo browser, `getUserMedia`) — las credenciales de dispositivo son las mismas, no hay lógica distinta por plataforma.

## Token flow

1. Al bootear, el servidor llama `POST {RAG_API_URL}/auth/device` con `{ device_id, api_key }` → obtiene un JWT de dispositivo (24h, se renueva solo ~30min antes de vencer). Ver `lib/rag-auth.js`.
2. Al iniciar una sesión (`GET /token` o `POST /session/start`), pide un token de LiveKit **nuevo** con `POST {RAG_API_URL}/livekit/token` (`Authorization: Bearer <JWT device>`, body `{ businessId, deviceId, branchId?, identity }`). Ver `lib/rag-token.js`.
3. `rag-api-v2` responde `{ token, roomName, serverUrl, businessId, ... }` — la sala es efímera, una nueva por cada conversación.
4. El servidor reenvía esas credenciales al browser (modo LiveKit) o las usa directo con `@livekit/rtc-node` (modo nativo Pi).
5. Si la sesión se corta y hay que reconectar, se pide un token nuevo — nunca se reutiliza uno viejo.
