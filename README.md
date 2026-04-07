# Brumexa-Edge

Cliente de voz para LiveKit que corre en **Raspberry Pi** (Ubuntu ARM) o **PC** (Windows/Linux/macOS). Captura el micrófono del sistema operativo y lo publica a una sala de LiveKit.

## Arquitectura

```
Browser (frontend)
  │
  ├── GET /config        → info del dispositivo y URL de LiveKit
  ├── GET /token         → pide token al servidor central → lo reenvía al browser
  └── (estático)         → sirve index.html / app.js / style.css
        │
        └── WebSocket wss://livekit.cloud  (browser conecta directo con el token)
              └── getUserMedia() → publica audio vía WebRTC
```

El servidor Express **no genera tokens localmente** — los solicita al servidor central de Brumexa, que tiene la lógica de LiveKit y el API Key/Secret.

## Requisitos

- Node.js 20+
- Acceso al servidor central de Brumexa en la red local

## Instalación

```bash
cp .env.example .env
# completar los valores en .env
npm install
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `LIVEKIT_URL` | URL WebSocket del servidor LiveKit (`wss://...`) |
| `LIVEKIT_ROOM_NAME` | Nombre de sala por defecto (fallback) |
| `PORT` | Puerto del servidor Express (default: 3000) |
| `TOKEN_API_URL` | Endpoint del servidor central para obtener tokens |
| `BRUMEXA_API_KEY` | API key para autenticarse con el servidor central |

## Uso

```bash
npm start          # producción
npm run brumexa    # desarrollo con nodemon
```

Abrir `http://localhost:3000` en el browser.

## Modos

- **LiveKit** — conecta a la sala LiveKit y publica el micrófono del OS. Requiere servidor central activo.
- **Test Mic** — verifica el micrófono localmente con un VU meter. Sin servidor, sin internet.

## Detección de dispositivo

El servidor detecta automáticamente si está corriendo en una **Raspberry Pi** (Linux ARM) o una **PC**, y envía ese `deviceType` al servidor central al pedir el token. El servidor central construye el `roomName` como `{deviceType}-{deviceId}` (ej: `raspberry-brumexa` o `pc-DESKTOP-ABC`).

## Token flow

1. Browser llama a `GET /token` en el Express local
2. Express hace `POST TOKEN_API_URL` con `{ deviceType, deviceId }` y header `x-api-key`
3. Servidor central responde con `{ token, url, roomName, participantName, expiresIn }`
4. Express reenvía el token al browser
5. Browser conecta directamente a LiveKit con ese token vía WebSocket
