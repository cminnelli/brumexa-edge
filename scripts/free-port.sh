#!/bin/bash
# Libera el puerto de la app (default 3000) matando SOLO si el proceso que lo
# tiene es "node" -- nunca mata otra cosa (sshd, u otro servicio), por más
# que esté en el puerto. Esto evitó por las malas: un intento anterior
# mataba lo que fuera que tuviera el puerto y una vez mató el proceso
# sshd-session que sostenía el propio túnel SSH del usuario, cortando la
# conexión. Ahora chequea el nombre del proceso antes de matar nada.

PORT="${PORT:-3000}"

LINE=$(sudo ss -tlnp sport = ":${PORT}" 2>/dev/null | grep -E 'users:\(\("node')
if [ -z "$LINE" ]; then
  # O no hay nada en el puerto, o lo que hay no es "node" -- no tocamos nada.
  exit 0
fi

PID=$(echo "$LINE" | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -n "$PID" ]; then
  echo "[free-port] Matando proceso node viejo (PID $PID) que tenía el puerto $PORT…"
  sudo kill -9 "$PID"
fi
