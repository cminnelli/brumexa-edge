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

# ─── 4. Node.js 20 ───────────────────────────────────────────────────────────
info "Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
sudo apt install -y -qq nodejs
NODE_VER=$(node -v)
ok "Node.js instalado: $NODE_VER"

# ─── 5. Git ──────────────────────────────────────────────────────────────────
info "Instalando Git..."
sudo apt install -y -qq git
ok "Git instalado: $(git --version)"

# ─── 6. Clonar repo ──────────────────────────────────────────────────────────
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

# ─── 7. npm install ──────────────────────────────────────────────────────────
info "Instalando dependencias Node (puede tardar 3-5 min)..."
npm install --silent
ok "npm install completado"

# ─── 8. rpi-ws281x-native (NeoPixel) ─────────────────────────────────────────
info "Instalando librería NeoPixel..."
npm install rpi-ws281x --silent 2>/dev/null && ok "rpi-ws281x instalado" || info "rpi-ws281x no disponible (se omite)"

# ─── 8b. Wake word "Hey Brumexa" — Python aislado en wake-word/venv ──────────
# openWakeWord es la única opción open source que puede aprender un nombre de
# marca inventado (no es un reconocedor de voz de diccionario como Vosk) —
# por eso es Python y no un paquete npm. Vive en su propia carpeta con su
# propio entorno virtual, sin tocar el Python del sistema.
info "Armando entorno Python para la wake word (wake-word/)..."
python3 -m venv wake-word/venv
wake-word/venv/bin/pip install --quiet --upgrade pip
wake-word/venv/bin/pip install --quiet -r wake-word/requirements.txt
ok "Entorno Python listo"

info "Descargando modelos base de openWakeWord..."
wake-word/venv/bin/python -c "from openwakeword.utils import download_models; download_models()" > /dev/null 2>&1
ok "Modelos base descargados"

# ─── 9. Configurar .env ──────────────────────────────────────────────────────
echo ""
if [ -f ".env" ]; then
  ok ".env ya existe — no se sobreescribe"
else
  info "Configurando variables de entorno..."
  cp .env.example .env

  read -p "RAG_API_URL (ej: http://192.168.1.50:4000): " RAG_URL
  read -p "BRUMEXA_DEVICE_ID (ej: brume-1): " DEV_ID
  read -p "BRUMEXA_API_KEY (generado/rotado en brumexa-admin-v2 → Devices): " DEV_KEY
  read -p "Ruta al modelo de wake word entrenado (.onnx/.tflite — Enter para omitir por ahora): " WW_MODEL

  sed -i "s|RAG_API_URL=.*|RAG_API_URL=${RAG_URL}|" .env
  sed -i "s|BRUMEXA_DEVICE_ID=.*|BRUMEXA_DEVICE_ID=${DEV_ID}|" .env
  sed -i "s|BRUMEXA_API_KEY=.*|BRUMEXA_API_KEY=${DEV_KEY}|" .env
  [ -n "$WW_MODEL" ] && sed -i "s|WAKE_WORD_MODEL_PATH=.*|WAKE_WORD_MODEL_PATH=${WW_MODEL}|" .env

  ok ".env configurado"
fi

# ─── 10. Configurar config.txt ───────────────────────────────────────────────
CONFIG=/boot/firmware/config.txt
info "Configurando /boot/firmware/config.txt..."

if grep -q "googlevoicehat-soundcard" "$CONFIG"; then
  ok "config.txt ya tiene audio I2S configurado"
else
  echo "" | sudo tee -a "$CONFIG" > /dev/null
  echo "# Audio I2S (mic INMP441 + speaker MAX98357A)" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtparam=i2s=on" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtoverlay=googlevoicehat-soundcard" | sudo tee -a "$CONFIG" > /dev/null
  ok "Audio I2S agregado al config.txt"
fi

if grep -q "dtparam=spi=on" "$CONFIG"; then
  ok "config.txt ya tiene SPI configurado"
else
  echo "" | sudo tee -a "$CONFIG" > /dev/null
  echo "# NeoPixel WS2812 (GPIO 10 SPI MOSI)" | sudo tee -a "$CONFIG" > /dev/null
  echo "dtparam=spi=on" | sudo tee -a "$CONFIG" > /dev/null
  ok "SPI (NeoPixel) agregado al config.txt"
fi

# ─── 11. Arranque automático con PM2 ─────────────────────────────────────────
echo ""
read -p "¿Configurar arranque automático al boot con PM2? (s/n): " AUTOSTART
if [ "$AUTOSTART" = "s" ] || [ "$AUTOSTART" = "S" ]; then
  info "Instalando PM2..."
  sudo npm install -g pm2 --silent
  sudo pm2 start server.js --name brumexa-edge
  sudo pm2 startup | tail -1 | sudo bash
  sudo pm2 save
  ok "PM2 configurado — el server arranca solo al boot"
fi

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
