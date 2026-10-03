#!/bin/bash
set -e

# Se puede re-ejecutar: cada paso revisa el estado real del sistema y solo
# hace lo que falta. Para forzar el upgrade completo de paquetes:
#   BRUMEXA_UPGRADE=1 ./install.sh

# ─── Colores ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✔ $1${NC}"; }
info() { echo -e "${YELLOW}→ $1${NC}"; }
err()  { echo -e "${RED}✘ $1${NC}"; exit 1; }

REBOOT_NEEDED=0

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     Brumexa-Edge — Instalación       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─── 1. Verificar arquitectura ───────────────────────────────────────────────
info "Verificando arquitectura..."
ARCH=$(uname -m)
[ "$ARCH" = "aarch64" ] || err "Se necesita OS 64-bit (aarch64). Detectado: $ARCH"
ok "Arquitectura: $ARCH"

# ─── 2. Actualizar sistema ───────────────────────────────────────────────────
info "Actualizando índice de paquetes..."
sudo apt update -qq
if [ "${BRUMEXA_UPGRADE:-0}" = "1" ]; then
  info "Actualizando paquetes del sistema (BRUMEXA_UPGRADE=1)..."
  sudo apt upgrade -y -qq
  sudo apt autoremove -y -qq
  ok "Sistema actualizado"
else
  ok "Upgrade de paquetes omitido (BRUMEXA_UPGRADE=1 para forzarlo)"
fi

# ─── 3. Dependencias del sistema ─────────────────────────────────────────────
info "Instalando dependencias del sistema..."
sudo apt install -y -qq alsa-utils bluez network-manager curl python3-venv python3-pip
ok "Dependencias instaladas"

# ─── 4. Permisos de NetworkManager sin sesión activa (Polkit) ────────────────
# Encontrado real (dos veces, dos acciones de Polkit distintas): nmcli/
# NetworkManager delega en Polkit varios permisos que por default exigen una
# sesión de login activa en consola. El server de Brumexa corre como
# servicio de systemd (PM2 al boot, ver paso 13 — a propósito SIN root, así
# que tampoco lo salva ser root), sin ninguna sesión — sin esta regla:
#   - org.freedesktop.NetworkManager.wifi.scan: nmcli no podía FORZAR un
#     escaneo nuevo (--rescan yes) y SIEMPRE devolvía apenas la red ya
#     conectada (la única que ya "conoce" sin necesitar escanear), aunque un
#     "nmcli device wifi list" corrido a mano por SSH sí trajera todas las
#     redes cercanas.
#   - org.freedesktop.NetworkManager.network-control: "nmcli device wifi
#     hotspot" (el AP de emergencia de lib/wifi.js) fallaba siempre con
#     "Not authorized to control networking" — el AP de provisioning NUNCA
#     se llegaba a levantar en un dispositivo recién instalado sin WiFi
#     cargado, que es justo el caso de uso principal de esa función.
# En vez de listar acción por acción cada vez que aparece una nueva (ya van
# dos), la regla cubre TODO org.freedesktop.NetworkManager.* para este
# usuario — es exactamente lo que se necesita: este dispositivo administra
# su propia red de forma autónoma, sin que nadie esté loggeado in situ.
info "Configurando permisos de NetworkManager para servicios sin sesión (Polkit)..."
CURRENT_USER="$(whoami)"
POLKIT_RULE=/etc/polkit-1/rules.d/50-brumexa-wifi-scan.rules
POLKIT_TMP=$(mktemp)
cat > "$POLKIT_TMP" <<EOF
polkit.addRule(function(action, subject) {
    if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 &&
        subject.user == "${CURRENT_USER}") {
        return polkit.Result.YES;
    }
});
EOF
if cmp -s "$POLKIT_TMP" "$POLKIT_RULE"; then
  ok "Regla de Polkit ya instalada y al día"
else
  sudo tee "$POLKIT_RULE" < "$POLKIT_TMP" > /dev/null
  sudo systemctl restart polkit
  ok "Permisos de NetworkManager configurados para ${CURRENT_USER}"
fi
rm -f "$POLKIT_TMP"

# ─── 4b. WiFi sin power-saving ───────────────────────────────────────────────
# El chip WiFi se duerme para ahorrar energía; en una Pi siempre conectada eso
# causa desconexiones intermitentes (ver NOTAS-INSTALACION-PI.md, punto 8).
info "Verificando power-saving del WiFi..."
WIFI_PS_CONF=/etc/NetworkManager/conf.d/wifi-powersave-off.conf
WIFI_PS_TMP=$(mktemp)
cat > "$WIFI_PS_TMP" <<'EOF'
[connection]
wifi.powersave = 2
EOF
if cmp -s "$WIFI_PS_TMP" "$WIFI_PS_CONF"; then
  ok "Power-saving del WiFi ya desactivado"
else
  sudo tee "$WIFI_PS_CONF" < "$WIFI_PS_TMP" > /dev/null
  sudo systemctl restart NetworkManager
  ok "Power-saving del WiFi desactivado (NetworkManager reiniciado)"
fi
rm -f "$WIFI_PS_TMP"

# ─── 5. Node.js 20 ───────────────────────────────────────────────────────────
info "Verificando Node.js 20..."
if command -v node > /dev/null && node -v | grep -q '^v20\.'; then
  ok "Node.js ya instalado: $(node -v)"
else
  info "Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
  sudo apt install -y -qq nodejs
  ok "Node.js instalado: $(node -v)"
fi

# ─── 6. Git ──────────────────────────────────────────────────────────────────
info "Instalando Git..."
sudo apt install -y -qq git
ok "Git instalado: $(git --version)"

# ─── 7. Clonar repo ──────────────────────────────────────────────────────────
info "Clonando brumexa-edge..."
mkdir -p ~/proyectos
cd ~/proyectos

if [ -d "brumexa-edge" ]; then
  info "Repo ya existe — haciendo pull..."
  cd brumexa-edge
  git pull
else
  git clone https://github.com/cminnelli/brumexa-edge
  cd brumexa-edge
fi
ok "Repo listo"

# ─── 8. npm install ──────────────────────────────────────────────────────────
info "Instalando dependencias Node (puede tardar 3-5 min)..."
npm install --silent
ok "npm install completado"

# ─── 9. rpi-ws281x-native (NeoPixel) ─────────────────────────────────────────
info "Verificando librería NeoPixel..."
if npm ls rpi-ws281x --depth=0 > /dev/null 2>&1; then
  ok "rpi-ws281x ya instalado"
else
  npm install rpi-ws281x --silent 2>/dev/null && ok "rpi-ws281x instalado" || info "rpi-ws281x no disponible (se omite)"
fi

# ─── 10. Configurar .env ──────────────────────────────────────────────────────
echo ""
if [ -f ".env" ]; then
  ok ".env ya existe — no se sobreescribe"
else
  info "Configurando variables de entorno..."
  cp .env.example .env

  read -p "RAG_API_URL (ej: http://192.168.1.50:4000): " RAG_URL
  read -p "BRUMEXA_DEVICE_ID (ej: brume-1): " DEV_ID
  read -p "BRUMEXA_API_KEY (generado/rotado en brumexa-admin-v2 → Devices): " DEV_KEY

  sed -i "s|RAG_API_URL=.*|RAG_API_URL=${RAG_URL}|" .env
  sed -i "s|BRUMEXA_DEVICE_ID=.*|BRUMEXA_DEVICE_ID=${DEV_ID}|" .env
  sed -i "s|BRUMEXA_API_KEY=.*|BRUMEXA_API_KEY=${DEV_KEY}|" .env

  ok ".env configurado"
fi

# ─── 11. Configurar config.txt ───────────────────────────────────────────────
# Cambios en config.txt recién se aplican tras reiniciar la Pi.
CONFIG=/boot/firmware/config.txt
info "Configurando /boot/firmware/config.txt..."

if grep -qE "^\s*dtoverlay=googlevoicehat-soundcard" "$CONFIG"; then
  ok "config.txt ya tiene audio I2S configurado"
else
  echo "" | sudo tee -a "$CONFIG" > /dev/null
  echo "# Audio I2S (mic INMP441 + speaker MAX98357A)" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtparam=i2s=on" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtoverlay=googlevoicehat-soundcard" | sudo tee -a "$CONFIG" > /dev/null
  REBOOT_NEEDED=1
  ok "Audio I2S agregado al config.txt"
fi

if grep -qE "^\s*dtparam=audio=off" "$CONFIG"; then
  ok "config.txt ya tiene dtparam=audio=off configurado"
else
  echo "dtparam=audio=off" | sudo tee -a "$CONFIG" > /dev/null
  REBOOT_NEEDED=1
  ok "Audio onboard deshabilitado en config.txt (evita que tome la tarjeta ALSA 0 antes que el HAT I2S)"
fi

if grep -qE "^\s*dtparam=spi=on" "$CONFIG"; then
  ok "config.txt ya tiene SPI configurado"
else
  echo "" | sudo tee -a "$CONFIG" > /dev/null
  echo "# NeoPixel WS2812 (GPIO 10 SPI MOSI)" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtparam=spi=on" | sudo tee -a "$CONFIG" > /dev/null
  REBOOT_NEEDED=1
  ok "SPI (NeoPixel) agregado al config.txt"
fi

# ─── 12. Audio: mantener el reloj I2S vivo (evita el "pum" al abrir mic/speaker) ─
# El HAT (Google AIY Voice HAT / MAX98357A) hace un pop audible cada vez que
# arecord/aplay abren el dispositivo de cero — el reloj I2S tiene que
# arrancar desde parado. Confirmado leyendo el driver del kernel
# (googlevoicehat-codec.c): no hay ningún control de ALSA que la app pueda
# tocar desde afuera para arreglarlo. El arreglo que usa toda la comunidad
# de HATs I2S parecidos (ReSpeaker/seeed-voicecard, Adafruit, Volumio) es
# mantener un stream de reproducción corriendo SIEMPRE, para que el reloj
# compartido nunca se pare — así cuando la app abre su propio aplay/arecord
# por sesión, el hardware ya estaba prendido, sin arranque en frío. dmix
# deja que ese stream permanente y los aplay normales de la app compartan
# el dispositivo sin pelearse por él (ver brumexa_speaker más abajo).
echo ""
info "Configurando mantenimiento de reloj I2S (evita pop del HAT)..."

ASOUND=/etc/asound.conf
if grep -q "pcm.brumexa_speaker" "$ASOUND" 2>/dev/null; then
  ok "asound.conf ya tiene el device brumexa_speaker"
else
  sudo tee -a "$ASOUND" > /dev/null <<'EOF'

pcm.dmix_brumexa {
    type dmix
    ipc_key 1027
    slave {
        pcm "hw:0,0"
        rate 48000
        channels 1
        format S16_LE
        period_size 1024
        buffer_size 8192
    }
}
pcm.brumexa_speaker {
    type plug
    slave.pcm "dmix_brumexa"
}
EOF
  ok "asound.conf configurado (device brumexa_speaker)"
fi

KEEPALIVE_UNIT=/etc/systemd/system/brumexa-audio-keepalive.service
KEEPALIVE_TMP=$(mktemp)
KEEPALIVE_CHANGED=0
sed -e "s|^User=brumelab|User=${CURRENT_USER}|" \
    scripts/brumexa-audio-keepalive.service > "$KEEPALIVE_TMP"
if ! cmp -s "$KEEPALIVE_TMP" "$KEEPALIVE_UNIT"; then
  sudo tee "$KEEPALIVE_UNIT" < "$KEEPALIVE_TMP" > /dev/null
  sudo systemctl daemon-reload
  KEEPALIVE_CHANGED=1
fi
rm -f "$KEEPALIVE_TMP"
if ! systemctl is-enabled --quiet brumexa-audio-keepalive.service; then
  sudo systemctl enable brumexa-audio-keepalive.service
fi
if [ "$KEEPALIVE_CHANGED" = "1" ] || ! systemctl is-active --quiet brumexa-audio-keepalive.service; then
  sudo systemctl restart brumexa-audio-keepalive.service
  ok "Servicio de keepalive activo — brumexa-audio-keepalive"
else
  ok "Servicio de keepalive ya activo — brumexa-audio-keepalive"
fi

# La app tiene que reproducir por brumexa_speaker (no el hw crudo) para que
# el pop no vuelva — se fuerza en .env sí o sí, incluso si .env ya existía
# de antes (ej. autoDetectAlsaDevices en server.js ya había guardado la
# tarjeta cruda en una instalación previa a este fix — ver ese comentario
# en server.js, se salta la autodetección si la variable ya está seteada).
if grep -q "^SPEAKER_ALSA_DEVICE=" .env; then
  sed -i "s|^SPEAKER_ALSA_DEVICE=.*|SPEAKER_ALSA_DEVICE=brumexa_speaker|" .env
else
  echo "SPEAKER_ALSA_DEVICE=brumexa_speaker" >> .env
fi
ok "SPEAKER_ALSA_DEVICE=brumexa_speaker en .env"

# Permisos para que /instalacion (lib/system-fixes.js) pueda re-aplicar este
# mismo arreglo desde el panel web, sin terminal — Node corre sin ninguna
# sesión/TTY, así que un "sudo" normal ahí SIEMPRE pide contraseña y falla.
# En vez de darle sudo sin restricciones (inseguro), un archivo de sudoers
# ACOTADO a los comandos exactos que necesita ese fix puntual — nada de
# "ALL". Si el día de mañana se suma otro fix a esa lista que necesite sudo,
# hay que agregarle su propia línea acá (comando exacto, no un permiso
# genérico).
echo ""
info "Configurando permisos para /instalacion (sudoers acotado)..."
TEE_BIN=$(command -v tee)
SYSTEMCTL_BIN=$(command -v systemctl)
SUDOERS_TMP=$(mktemp)
cat > "$SUDOERS_TMP" <<EOF
# Brumexa — /instalacion (ver lib/system-fixes.js). Comandos exactos, no ALL.
${CURRENT_USER} ALL=(root) NOPASSWD: ${TEE_BIN} -a /etc/asound.conf
${CURRENT_USER} ALL=(root) NOPASSWD: ${TEE_BIN} /etc/systemd/system/brumexa-audio-keepalive.service
${CURRENT_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} daemon-reload
${CURRENT_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} enable brumexa-audio-keepalive
${CURRENT_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} restart brumexa-audio-keepalive
EOF
if sudo visudo -cf "$SUDOERS_TMP" > /dev/null; then
  sudo cp "$SUDOERS_TMP" /etc/sudoers.d/brumexa-system-fixes
  sudo chmod 0440 /etc/sudoers.d/brumexa-system-fixes
  ok "Permisos de /instalacion configurados"
else
  # No usar err() acá — aborta TODO install.sh con exit 1, y esto no es
  # crítico para que Brumexa funcione (solo para que /instalacion no
  # necesite terminal). visudo ya validó y rechazó antes de tocar nada real.
  echo -e "${RED}✘ El archivo de sudoers generado no pasó la validación — no se instaló nada (visudo lo rechazó, no se rompió el sudoers real)${NC}"
fi
rm -f "$SUDOERS_TMP"

# ─── 13. Arranque automático con PM2 ─────────────────────────────────────────
echo ""
if systemctl is-enabled --quiet "pm2-${CURRENT_USER}" 2>/dev/null; then
  ok "PM2 ya está configurado para arrancar al boot"
  AUTOSTART=s
else
  read -p "¿Configurar arranque automático al boot con PM2? (s/n): " AUTOSTART
fi
if [ "$AUTOSTART" = "s" ] || [ "$AUTOSTART" = "S" ]; then
  if ! command -v pm2 > /dev/null; then
    info "Instalando PM2..."
    sudo npm install -g pm2 --silent
  fi

  # OJO: pm2 start/save SIN sudo a propósito — tiene que correr como el
  # usuario actual (no root), si no PM2 guarda su estado en /root/.pm2 en vez
  # de ~/.pm2 y "pm2 list" corrido normalmente (sin sudo) después no muestra
  # nada, aunque el proceso esté vivo. El sudo va SOLO antes del bash que
  # ejecuta el comando que imprime "pm2 startup" (ese sí necesita root para
  # escribir el servicio en /etc/systemd/system/).
  if pm2 describe brumexa-edge > /dev/null 2>&1; then
    pm2 restart brumexa-edge --update-env
  else
    pm2 start server.js --name brumexa-edge
  fi
  if ! systemctl is-enabled --quiet "pm2-${CURRENT_USER}" 2>/dev/null; then
    pm2 startup | tail -1 | sudo bash
  fi
  pm2 save
  ok "PM2 configurado — el server arranca solo al boot"
fi

# ─── 14. Arranque temprano (scripts/boot.js) ─────────────────────────────────
# Entre que prende la Pi y que PM2/Node terminan de bootear y llegan a
# leds.init() dentro de server.js, pasan varios segundos sin ninguna luz. Este
# servicio systemd corre ANTES que PM2 (DefaultDependencies=no + sysinit.target,
# ver scripts/brumexa-boot.service) y ejecuta scripts/boot.js — hoy eso prende
# el cometa cian de "cargando" (mismo leds.connecting() que al conectar a
# LiveKit) y se apaga solo apenas detecta que server.js ya está escuchando en
# el puerto, para no pelearse por el mismo GPIO/DMA del NeoPixel. Es un
# service GENÉRICO a propósito — si el día de mañana hace falta correr algo
# más temprano en el boot (no LEDs), va adentro de scripts/boot.js, sin tocar
# este service de nuevo.
echo ""
info "Instalando servicio de arranque temprano..."
REPO_DIR="$(pwd)"
BOOT_UNIT=/etc/systemd/system/brumexa-boot.service
BOOT_TMP=$(mktemp)
sed -e "s|/home/brumelab/proyectos/brumexa-edge|${REPO_DIR}|g" \
    -e "s|^User=brumelab|User=${CURRENT_USER}|" \
    scripts/brumexa-boot.service > "$BOOT_TMP"
if cmp -s "$BOOT_TMP" "$BOOT_UNIT"; then
  ok "Servicio de arranque temprano ya instalado y al día"
else
  sudo tee "$BOOT_UNIT" < "$BOOT_TMP" > /dev/null
  sudo systemctl daemon-reload
fi
rm -f "$BOOT_TMP"
if ! systemctl is-enabled --quiet brumexa-boot.service; then
  sudo systemctl enable brumexa-boot.service
fi
ok "Arranque temprano configurado — servicio: brumexa-boot"

# ─── Resumen ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════╗"
echo "║         Instalación completa         ║"
echo "╚══════════════════════════════════════╝"
echo ""
ok "Node.js $(node -v)"
ok "Repo en ~/proyectos/brumexa-edge"
ok ".env configurado"
echo ""
info "Tarjetas de audio detectadas (/proc/asound/cards):"
cat /proc/asound/cards || true
if [ -e /dev/spidev0.0 ]; then
  ok "SPI disponible (/dev/spidev0.0)"
else
  info "SPI todavía no disponible (/dev/spidev0.0) — suele requerir reinicio"
  REBOOT_NEEDED=1
fi
if systemctl is-active --quiet brumexa-audio-keepalive.service; then
  ok "Keepalive de audio activo"
else
  info "Keepalive de audio NO está activo"
fi
if [ "$REBOOT_NEEDED" = "1" ]; then
  echo ""
  echo -e "${YELLOW}⚠ Hay cambios de hardware pendientes de aplicar — reiniciá la Pi con: sudo reboot${NC}"
fi
echo ""
info "Para arrancar manualmente:"
echo "  cd ~/proyectos/brumexa-edge && node server.js"
echo ""
