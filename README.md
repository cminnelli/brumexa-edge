# Brumexa-Edge

Cliente de voz para LiveKit. Corre en una **Raspberry Pi** (dispositivo final, con micrófono I2S, parlante y LEDs) o en una **PC** (modo browser, para probar sin hardware).

Se conecta a `brumexa-rag-api-v2`, que le da un token de LiveKit nuevo por cada conversación.

## Requisitos

- Node.js 20+
- `brumexa-rag-api-v2` corriendo y accesible en la red
- Un dispositivo dado de alta en `brumexa-admin-v2` (Devices), con su `deviceId` y `apiKey`
- Solo en Pi: Raspberry Pi OS 64-bit (aarch64), mic INMP441 + parlante MAX98357A por I2S, LEDs NeoPixel (opcional)

## Instalación

### Raspberry Pi (instalación completa)

```bash
git clone https://github.com/cminnelli/brumexa-edge ~/proyectos/brumexa-edge
cd ~/proyectos/brumexa-edge
./install.sh
```

`install.sh` hace todo solo:
1. Chequea que el OS sea 64-bit
2. Instala dependencias del sistema (ALSA, Bluetooth, Python) y Node.js 20
3. Clona/actualiza el repo e instala dependencias (`npm install`)
4. Arma el entorno Python de la wake word "Hey Brumexa" (`wake-word/venv`)
5. Te pregunta `RAG_API_URL`, `BRUMEXA_DEVICE_ID`, `BRUMEXA_API_KEY` y arma el `.env`
6. Habilita I2S (audio) y SPI (LEDs) en `/boot/firmware/config.txt`
7. Opcionalmente deja el server arrancando solo al boot con PM2
8. Deja instalado y habilitado el servicio de arranque temprano (`scripts/boot.js`, ver más abajo) — este paso corre siempre, sin preguntar

**Reiniciar la Pi al terminar** (necesario para que tomen efecto I2S/SPI).

### PC (para probar sin hardware, modo browser)

```bash
cp .env.example .env
# completar RAG_API_URL / BRUMEXA_DEVICE_ID / BRUMEXA_API_KEY
npm install
npm run brumexa
```

## Uso

```bash
npm start          # producción
npm run brumexa    # desarrollo, con autoreload
```

Abrir `http://localhost:3000`.

- **LiveKit** — conecta a una sala nueva y publica el micrófono (mic real en Pi, `getUserMedia` en browser). Requiere la API arriba y el dispositivo autenticado.
- **Test Mic** — VU meter local, sin servidor ni internet. Sirve para probar que el mic anda.

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

`install.sh` (paso 11) puede dejar `server.js` arrancando solo al bootear, vía PM2 + systemd. Si preferís armarlo a mano en un equipo ya instalado:

```bash
cd ~/proyectos/brumexa-edge
sudo npm install -g pm2          # si no está instalado

# OJO: pm2 start/save SIN sudo — tiene que correr como tu usuario normal
# (brumelab), no como root. Si corrés estos comandos con sudo, PM2 guarda su
# estado en /root/.pm2 en vez de ~/.pm2, y después "pm2 list" corrido a mano
# (sin sudo) muestra la lista vacía aunque el proceso esté vivo y todo ande
# bien — es el bug más común al armar esto, ver más abajo.
pm2 start server.js --name brumexa-edge
pm2 startup
```

`pm2 startup` **no configura nada por sí solo** — solo te *imprime en pantalla* un comando que arranca con `sudo env PATH=...`. Ese paso es manual a propósito (necesita tu contraseña de sudo): copiá esa línea completa que te tira **a vos** (varía según el usuario/instalación) y ejecutala como comando aparte, por ejemplo:

```bash
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u brumelab --hp /home/brumelab
```

Recién ahí:

```bash
pm2 save
systemctl is-enabled pm2-brumelab   # tiene que decir "enabled"
```

**El error más común**: correr `pm2 startup` y saltar directo a `pm2 save` sin ejecutar el comando `sudo env PATH=...` que imprimió en el medio. El servicio `pm2-<usuario>` nunca se crea, y en el próximo reinicio no arranca nada (sin luces, sin server) aunque `pm2 save` haya dicho "Successfully saved". Confirmá siempre con `systemctl is-enabled pm2-brumelab` antes de dar el tema por cerrado.

Para armarlo de cero si algo quedó a medio configurar:

```bash
pm2 kill
sudo systemctl disable pm2-brumelab 2>/dev/null || true
sudo rm -f /etc/systemd/system/pm2-brumelab.service
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
- `curl -s localhost:3000/livekit-health` — ¿está autenticado contra la API?
- Si no conecta: confirmar que `brumexa-rag-api-v2` esté arriba y que las credenciales del `.env` coincidan con las del admin panel.
