# Brumexa-Edge

Cliente de voz para LiveKit. Corre en una **Raspberry Pi** (dispositivo final, con micrófono I2S, parlante y LEDs) o en una **PC** (modo browser, para probar sin hardware).

Se conecta a `brumexa-rag-api-v2`, que le da un token de LiveKit nuevo por cada conversación.

## Requisitos

- Node.js 20+
- `brumexa-rag-api-v2` y `brumexa-livekit-agent` corriendo y accesibles desde la Raspberry (red local o remoto)
- Un dispositivo dado de alta en la plataforma de admin de Brumexa (Devices), con su `deviceId` y `apiKey` — se puede dar de alta después de instalar, ver el paso a paso más abajo
- Solo en Pi: Raspberry Pi OS 64-bit (aarch64), mic INMP441 + parlante MAX98357A por I2S, LEDs NeoPixel (opcional)

## Instalación

### Raspberry Pi (instalación completa desde cero)

Hardware ya armado (mic/parlante/LEDs cableados, ver [`cableado-diagrama.pdf`](cableado-diagrama.pdf)).

**1. Grabar la SD**
- [Raspberry Pi Imager](https://www.raspberrypi.com/software/) → insertar la SD en la PC
- Elegir dispositivo ("Choose Device") → tu modelo (Zero 2 W, 3A+, etc.)
- Elegir sistema operativo ("Choose OS") → **Raspberry Pi OS (other)** →
  **Raspberry Pi OS Lite (64-bit)**, la que NO dice "Legacy" (necesita aarch64 + NetworkManager)
- Elegir almacenamiento ("Choose Storage") → la SD
- ⚙️ Configuración avanzada ("Edit Settings") → hostname `brumexa` (anotalo, lo usás en el
  paso 2), habilitar SSH (usuario/contraseña), WiFi
- Grabar ("Write")

**2. Primer boot y SSH**
- Sacar la SD de la PC, ponerla en la Pi, conectar alimentación
- Esperar ~1 min
- Conectarte por SSH desde tu PC. En Windows no hace falta instalar nada — PowerShell o
  Windows Terminal ya traen `ssh`:
  ```
  ssh <usuario>@brumexa.local
  ```
  Reemplazá `<usuario>` y `brumexa` por lo que configuraste en el paso 1 (ej: usuario `juan`
  → `ssh juan@brumexa.local`). Pide la contraseña que pusiste ahí — no hace falta nada más,
  SSH ya quedó habilitado al grabar la SD.

**3. Instalar**

Ya adentro de la sesión SSH (no en tu PC). Raspberry Pi OS Lite no trae `git` instalado de
fábrica (sí trae `curl`), así que en vez de clonar el repo entero a mano, bajás solo
`install.sh` — el script se encarga de instalar `git`, clonar el repo y todo lo demás:

```bash
curl -O https://raw.githubusercontent.com/cminnelli/brumexa-edge/main/install.sh
bash install.sh
```

`install.sh` hace todo esto solo (10-15 min):
- Chequea que el OS sea 64-bit, actualiza el sistema, instala ALSA/Python/Node.js 20/Git
- Clona el repo en `~/proyectos/brumexa-edge` e instala las dependencias del proyecto (`npm install`)
- Arma el entorno Python de la wake word "Hey Brumexa"
- Pide `RAG_API_URL` / `BRUMEXA_DEVICE_ID` / `BRUMEXA_API_KEY` — si todavía no las tenés,
  Enter las deja en blanco, se cargan después sin reiniciar (ver paso 6)
- Habilita I2S (audio) y SPI (LEDs)
- Pregunta si querés arranque automático con PM2 → **sí**
- Deja instalado el arranque temprano (LEDs prendidos mientras bootea)

**4. Reiniciar**
```bash
sudo reboot
```
Con esto ya tenés la Pi arriba y el server corriendo (LEDs prenden solos, panel accesible en
`http://brumexa.local:3000`), aunque todavía no esté autenticada contra la API.

**5. Dar de alta el dispositivo**
- En la plataforma de admin de Brumexa → Devices → crear dispositivo → copiar el `apiKey`
  (se muestra una sola vez)
- Anotar: `RAG_API_URL`, `BRUMEXA_DEVICE_ID`, `BRUMEXA_API_KEY`

**6. Cargar las credenciales**
- Desde el navegador, `http://brumexa.local:3000/configuracion` → Credenciales → pegar los 3
  valores del paso anterior → Guardar (aplica al toque, sin reiniciar el server)

**7. Verificar**
- Entrar a `http://brumexa.local:3000` — es el panel principal del dispositivo, desde ahí se
  conecta y se prueba todo. En la card **LiveKit — Agente IA**, tocar **Conectar** inicia una
  sesión real que sirve para confirmar que anda todo junto: se escucha al agente por el
  **parlante**, los **LEDs** cambian de color mientras habla, y el **mic** lo capta si le
  hablás.

  Hoy esa es la única forma de arrancar una sesión — hay que tocar el botón. La idea a futuro
  es sacar el botón y que se dispare solo con una palabra de activación ("Hey Brumexa") u otro
  mecanismo, sin que haga falta tocar nada.

## Uso

Con PM2 configurado (lo normal, si seguiste la instalación de arriba) el server ya está
corriendo solo. PM2 es el gestor de procesos que lo mantiene vivo: lo reinicia solo si
crashea, lo vuelve a levantar si se reinicia la Pi (ver "Arranque automático (PM2)" más abajo),
y deja ver los logs sin tener que dejar una terminal con el server corriendo a mano. Los
comandos del día a día son estos, no `npm`:

```bash
pm2 list                    # ¿está corriendo? — estado, memoria, uptime
pm2 logs brumexa-edge       # logs en vivo (Ctrl+C para salir, no corta el proceso)
pm2 restart brumexa-edge    # reiniciar
pm2 stop brumexa-edge       # parar
pm2 start brumexa-edge      # volver a arrancar
```

Estos otros son solo para debug puntual, si en vez de PM2 querés correrlo vos a mano en la
terminal (parando PM2 primero con `pm2 stop brumexa-edge`, para que no compitan los dos por el
mismo puerto):

```bash
npm start          # una vez, sin autoreload
npm run brumexa    # con autoreload — se reinicia solo al editar un archivo
```

En el panel (`http://brumexa.local:3000`): la card **LiveKit — Agente IA** conecta a una
sesión real (ver Paso 7 de la instalación), y **Test Mic** es un VU meter local, sin sesión ni
internet, para probar solo el mic sin depender de la API.

## Acceso remoto a la web — no hace falta SSH

Una vez instalada, no hace falta volver a conectarte por SSH para usar Brumexa — todo se
maneja desde el navegador. El server escucha en toda la red (no solo `localhost`), así que
cualquier otro dispositivo de esa red entra directo.

**Caso normal — la Pi ya tiene WiFi:** entrás por `http://brumexa.local:3000`.
`brumexa.local` es el hostname que le pusiste a la Pi en el Paso 1 de la instalación
(Raspberry Pi Imager). Funciona por mDNS/Avahi, instalado de fábrica en Raspberry Pi OS:
cualquier otro dispositivo de la misma red resuelve ese nombre solo a la IP real de la Pi, sin
que tengas que buscarla a mano ni que sea siempre la misma.

**Si la Pi todavía no tiene WiFi cargado, o se le cortó y no logra reconectar sola:** arranca
sola un Access Point (AP) de emergencia — su propia red WiFi, para poder entrar y cargarle la
red real. Por default:
- SSID: `brumexa-local`
- Contraseña: `brumexa123`
- IP: `10.42.0.1`

(los tres son configurables — `WIFI_AP_SSID` / `WIFI_AP_PASS` / `WIFI_AP_IP` en `.env.example`).
Conectate a esa red WiFi desde tu celu/PC y entrá a `http://10.42.0.1:3000/setup` para cargar
el SSID/contraseña de tu WiFi real — apenas lo guardás, la Pi se conecta sola y volvés a
entrar por `brumexa.local` como siempre.

Esto es automático, no hace falta tocar nada: `lib/wifi.js` monitorea la señal cada 15s (LEDs
en naranja si está débil) y, si se pierde la conexión por más de 45s sin reconectar sola,
reactiva el AP de emergencia solo. Mientras está en AP, reintenta en el fondo cada 3 min por
si la red de siempre volvió. Detalle completo en [`lib/wifi.js`](lib/wifi.js).

Páginas útiles además de `/`:
- `/local` — diagnóstico de solo lectura (logs de PM2, WiFi, sistema, audio, temperatura) — para debuguear sin SSH ni teclado/pantalla (ver [`lib/local-debug.js`](lib/local-debug.js)).
- `/terminal` — terminal remota en el navegador, con atajos tipo "logs de pm2".
- `/setup` — cargar el WiFi real cuando está en modo AP.

⚠️ `/terminal` no tiene autenticación (solo bloquea por patrón algunos comandos destructivos) — cualquiera que llegue a esa IP/red puede ejecutar comandos en la Pi. Tenerlo en cuenta si el AP o la red WiFi no son de confianza.

## Variables de entorno

Ver `.env.example` para la lista completa (wake word, ganancias, umbrales). Las imprescindibles:

| Variable | Descripción |
|---|---|
| `RAG_API_URL` | URL de `brumexa-rag-api-v2` |
| `BRUMEXA_DEVICE_ID` | ID del dispositivo (dado de alta en `brumexa-admin-v2`) |
| `BRUMEXA_API_KEY` | API key del dispositivo |
| `PORT` | Puerto del servidor (default 3000) |

## Cómo funciona (resumen)

1. Al arrancar, el server se autentica contra la API (`POST /auth/device`) y obtiene un JWT de dispositivo.
2. Por cada conversación pide un token de LiveKit nuevo (`POST /livekit/token`) — nunca reutiliza uno viejo.
3. Con ese token se une a la sala: modo nativo (`@livekit/rtc-node` + ALSA) en Pi, o modo browser (`getUserMedia`) en PC.

Detalle completo en [`lib/rag-auth.js`](lib/rag-auth.js) y [`lib/rag-token.js`](lib/rag-token.js).

## Arranque automático (PM2) — sin SSH en cada reinicio

Si en el paso 3 de la instalación dijiste que sí a PM2, esto **ya está hecho** — no hace
falta repetir nada de acá. Esta sección es para armarlo a mano en un equipo que no pasó por
`install.sh`, o para diagnosticar si algo quedó mal configurado:

```bash
cd ~/proyectos/brumexa-edge
sudo npm install -g pm2          # si no está instalado

# OJO: pm2 start/save SIN sudo — tiene que correr como tu usuario normal,
# no como root. Si corrés estos comandos con sudo, PM2 guarda su estado en
# /root/.pm2 en vez de ~/.pm2, y después "pm2 list" corrido a mano (sin sudo)
# muestra la lista vacía aunque el proceso esté vivo y todo ande bien — es
# el bug más común al armar esto, ver más abajo.
pm2 start server.js --name brumexa-edge
pm2 startup
```

`pm2 startup` **no configura nada por sí solo** — solo te *imprime en pantalla* un comando que arranca con `sudo env PATH=...`. Ese paso es manual a propósito (necesita tu contraseña de sudo): copiá esa línea completa que te tira **a vos** (el usuario/ruta varían según tu instalación — el ejemplo de abajo usa `brumelab`, el del dispositivo original) y ejecutala como comando aparte:

```bash
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u brumelab --hp /home/brumelab
```

Recién ahí:

```bash
pm2 save
systemctl is-enabled pm2-$(whoami)   # tiene que decir "enabled"
```

**El error más común**: correr `pm2 startup` y saltar directo a `pm2 save` sin ejecutar el comando `sudo env PATH=...` que imprimió en el medio. El servicio `pm2-<usuario>` nunca se crea, y en el próximo reinicio no arranca nada (sin luces, sin server) aunque `pm2 save` haya dicho "Successfully saved". Confirmá siempre con `systemctl is-enabled pm2-$(whoami)` antes de dar el tema por cerrado.

Para armarlo de cero si algo quedó a medio configurar:

```bash
pm2 kill
sudo systemctl disable pm2-$(whoami) 2>/dev/null || true
sudo rm -f /etc/systemd/system/pm2-$(whoami).service
sudo systemctl daemon-reload
# ... y repetir los pasos de arriba
```

Un corte de luz real (desenchufar/enchufar) dispara exactamente el mismo camino que `sudo reboot` — no hay diferencia para este mecanismo.

## Arranque temprano (`scripts/boot.js`) — corre ANTES que PM2

Existe un tercer mecanismo de arranque, aparte de "PM2 arranca `server.js`": un proceso mínimo y genérico (`scripts/boot.js`) pensado para todo lo que Brumexa necesite hacer **antes** de que PM2/Node terminen de levantar la app completa.

**Por qué existe** — `leds.init()` en `server.js` prende los LEDs apenas el servidor arranca a escuchar, pero entre que prende la Pi y que PM2/Node terminan de bootear pasan varios segundos sin ninguna luz (kernel + systemd + PM2 + `npm install`'s de dependencias — server.js recién es lo último de esa cadena). `scripts/boot.js` corre como su propio servicio systemd (`scripts/brumexa-boot.service`), configurado para arrancar lo más temprano posible en el boot (`DefaultDependencies=no` + `sysinit.target`, en vez de depender de red/multi-user como PM2). Hoy lo único que hace es prender el mismo cometa cian de "cargando" que ya se usa al conectar a LiveKit (`leds.connecting()`), y se apaga solo apenas detecta (haciendo polling al puerto) que `server.js` ya está escuchando — así nunca hay dos procesos peleándose por el mismo GPIO/DMA del NeoPixel. Si el boot se cuelga y `server.js` nunca levanta, después de 90s pasa a la animación de error (rojo) en vez de seguir mostrando "cargando" para siempre.

**Por qué es genérico** — el `.service` de systemd no menciona LEDs para nada, solo dice "correr `scripts/boot.js` lo antes posible en el boot". Si el día de mañana hace falta que algo más corra temprano (no relacionado a LEDs), se agrega **adentro de `scripts/boot.js`**, sin crear un service nuevo ni tocar systemd de nuevo.

**Cómo activarlo** — `install.sh` (paso 12) lo deja instalado y habilitado solo en una instalación nueva. Para activarlo a mano en un equipo ya instalado:

```bash
cd ~/proyectos/brumexa-edge
git pull
sudo tee /etc/systemd/system/brumexa-boot.service > /dev/null < scripts/brumexa-boot.service
sudo systemctl daemon-reload
sudo systemctl enable brumexa-boot.service
sudo reboot
```

Después de reiniciar, confirmá que quedó bien:
```bash
systemctl is-enabled brumexa-boot.service   # tiene que decir "enabled"
systemctl status brumexa-boot.service       # se ve "active" un ratito y después termina solo (exit code 0) apenas server.js levanta — es esperado, no es que se "cayó"
```

(El `.service` trae hardcodeado el usuario `brumelab` y la ruta `/home/brumelab/proyectos/brumexa-edge` — si tu instalación usa otro usuario/ruta, ajustá esas líneas antes de copiarlo, o corré el paso 12 de `install.sh`, que las sustituye solo.)

## Levantar el ecosistema completo

Este repo es una pieza más (DB + API + Agent + Admin + este dispositivo). Para levantar todo junto, ver [`como-levantar-brumexa.txt`](como-levantar-brumexa.txt).

## Troubleshooting

Comandos útiles para diagnosticar en la Pi (red, audio ALSA, GPIO, proceso) en [`comandos_frecuentes.txt`](comandos_frecuentes.txt).

Chequeos rápidos:
- `curl -s localhost:3000/config` — ¿responde el server?
- `curl -s localhost:3000/configuracion/status` — el campo `ragAuth.authenticated` dice si el
  dispositivo está autenticado contra la API en este momento (no confundir con
  `/livekit-health`, que solo chequea si el HOST de LiveKit responde, no la autenticación).
- Si no conecta: confirmar que `brumexa-rag-api-v2` esté arriba y que las credenciales del `.env` coincidan con las del admin panel.

**Se escucha el saludo/respuesta del agente en el navegador (`meet.livekit.io` o el preview del admin) pero NO en la Pi** — con `stt`/`llm`/`tts` corriendo bien en los logs de `[agent]`, y `[lk-session] Abriendo AudioStream sid=...` en el log de la Pi pero nunca `✔ Primer frame del agente recibido`: el audio nunca cruza a nivel transporte (ICE/PeerConnection) aunque la señalización diga "conectado". Causa real encontrada una vez: el proceso de pm2 llevaba mucho tiempo corriendo con el entorno cacheado de cuando se hizo el `pm2 start` original — un `pm2 restart` normal no lo refresca. Se resuelve recreando el proceso de cero:

```bash
pm2 delete brumexa-edge
cd ~/proyectos/brumexa-edge
pm2 start server.js --name brumexa-edge
pm2 save
```

Para confirmar en el momento (sin esperar a que se repita) hay un log de diagnóstico permanente en [`lib/livekit-session.js`](lib/livekit-session.js) — buscar `[lk-session-debug] connectionState` en `pm2 logs brumexa-edge`; si queda en un estado que no sea `connected` mientras la señalización dice que todo anda bien, es la misma causa.
