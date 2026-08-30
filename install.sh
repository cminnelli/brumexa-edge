#!/bin/bash
set -e

# ─── Colores ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✔ $1${NC}"; }
info() { echo -e "${YELLOW}→ $1${NC}"; }
err()  { echo -e "${RED}✘ $1${NC}"; exit 1; }

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
info "Actualizando sistema..."
sudo apt update -qq
sudo apt upgrade -y -qq
sudo apt autoremove -y -qq
ok "Sistema actualizado"

# ─── 3. Dependencias del sistema ─────────────────────────────────────────────
info "Instalando dependencias del sistema..."
sudo apt install -y -qq alsa-utils bluez network-manager curl python3-venv python3-pip
ok "Dependencias instaladas"

# ─── 4. Permiso de escaneo WiFi sin sesión activa (Polkit) ───────────────────
# Encontrado real: nmcli/NetworkManager delega en Polkit el permiso para
# FORZAR un escaneo WiFi nuevo (--rescan yes, org.freedesktop.NetworkManager.
# wifi.scan) — y por default eso exige una sesión de login activa. El server
# de Brumexa corre como servicio de systemd (PM2 al boot), sin ninguna sesión
# — sin esta regla, nmcli desde el server SIEMPRE devolvía apenas la red ya
# conectada (la única que ya "conoce" sin necesitar escanear), aunque un
# "nmcli device wifi list" corrido a mano por SSH sí trajera todas las redes
# cercanas. Conectarse a una red SÍ funciona igual sin esto (es un permiso
# de Polkit distinto, con default más permisivo) — este problema es
# específico del escaneo/listado de redes disponibles.
info "Configurando permiso de escaneo WiFi para servicios sin sesión (Polkit)..."
CURRENT_USER="$(whoami)"
sudo tee /etc/polkit-1/rules.d/50-brumexa-wifi-scan.rules > /dev/null <<EOF
polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.NetworkManager.wifi.scan" &&
        subject.user == "${CURRENT_USER}") {
        return polkit.Result.YES;
    }
});
EOF
sudo systemctl restart polkit
ok "Permiso de escaneo WiFi configurado para ${CURRENT_USER}"

# ─── 5. Node.js 20 ───────────────────────────────────────────────────────────
info "Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
sudo apt install -y -qq nodejs
NODE_VER=$(node -v)
ok "Node.js instalado: $NODE_VER"

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
info "Instalando librería NeoPixel..."
npm install rpi-ws281x --silent 2>/dev/null && ok "rpi-ws281x instalado" || info "rpi-ws281x no disponible (se omite)"

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
CONFIG=/boot/firmware/config.txt
info "Configurando /boot/firmware/config.txt..."

if grep -qE "^\s*dtoverlay=googlevoicehat-soundcard" "$CONFIG"; then
  ok "config.txt ya tiene audio I2S configurado"
else
  echo "" | sudo tee -a "$CONFIG" > /dev/null
  echo "# Audio I2S (mic INMP441 + speaker MAX98357A)" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtparam=i2s=on" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtoverlay=googlevoicehat-soundcard" | sudo tee -a "$CONFIG" > /dev/null
  ok "Audio I2S agregado al config.txt"
fi

if grep -qE "^\s*dtparam=audio=off" "$CONFIG"; then
  ok "config.txt ya tiene dtparam=audio=off configurado"
else
  echo "dtparam=audio=off" | sudo tee -a "$CONFIG" > /dev/null
  ok "Audio onboard deshabilitado en config.txt (evita que tome la tarjeta ALSA 0 antes que el HAT I2S)"
fi

if grep -qE "^\s*dtparam=spi=on" "$CONFIG"; then
  ok "config.txt ya tiene SPI configurado"
else
  echo "" | sudo tee -a "$CONFIG" > /dev/null
  echo "# NeoPixel WS2812 (GPIO 10 SPI MOSI)" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtparam=spi=on" | sudo tee -a "$CONFIG" > /dev/null
  ok "SPI (NeoPixel) agregado al config.txt"
fi

# ─── 12. Arranque automático con PM2 ─────────────────────────────────────────
echo ""
read -p "¿Configurar arranque automático al boot con PM2? (s/n): " AUTOSTART
if [ "$AUTOSTART" = "s" ] || [ "$AUTOSTART" = "S" ]; then
  info "Instalando PM2..."
  sudo npm install -g pm2 --silent

  # OJO: pm2 start/save SIN sudo a propósito — tiene que correr como el
  # usuario actual (no root), si no PM2 guarda su estado en /root/.pm2 en vez
  # de ~/.pm2 y "pm2 list" corrido normalmente (sin sudo) después no muestra
  # nada, aunque el proceso esté vivo. El sudo va SOLO antes del bash que
  # ejecuta el comando que imprime "pm2 startup" (ese sí necesita root para
  # escribir el servicio en /etc/systemd/system/).
  pm2 start server.js --name brumexa-edge
  pm2 startup | tail -1 | sudo bash
  pm2 save
  ok "PM2 configurado — el server arranca solo al boot"
fi

# ─── 13. Arranque temprano (scripts/boot.js) ─────────────────────────────────
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
CURRENT_USER="$(whoami)"
sed -e "s|/home/brumelab/proyectos/brumexa-edge|${REPO_DIR}|g" \
    -e "s|^User=brumelab|User=${CURRENT_USER}|" \
    scripts/brumexa-boot.service \
  | sudo tee /etc/systemd/system/brumexa-boot.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable brumexa-boot.service
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
info "Para arrancar manualmente:"
echo "  cd ~/proyectos/brumexa-edge && node server.js"
echo ""
