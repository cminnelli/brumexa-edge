#!/bin/bash
# Libera el puerto de la app (default 3000) matando SOLO si el proceso que lo
# tiene es "node" -- nunca mata otra cosa (sshd, u otro servicio), por más
# que esté en el puerto. Esto evitó por las malas: un intento anterior
# mataba lo que fuera que tuviera el puerto y una vez mató el proceso
# sshd-session que sostenía el propio túnel SSH del usuario, cortando la
# conexión. Ahora chequea el nombre del proceso antes de matar nada.
#
# Sin sudo a propósito: el proceso viejo siempre lo arrancó el mismo usuario
# (brumelab, via npm run brumexa), y un usuario puede ver/matar sus propios
# procesos y sockets sin privilegios — pedir sudo acá solo interrumpe el
# arranque con un prompt de contraseña que no hace falta.

PORT="${PORT:-3000}"

LINE=$(ss -tlnp sport = ":${PORT}" 2>/dev/null | grep -E 'users:\(\("node')
if [ -z "$LINE" ]; then
  # O no hay nada en el puerto, o lo que hay no es "node" -- no tocamos nada.
  exit 0
fi

PID=$(echo "$LINE" | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -n "$PID" ]; then
  echo "[free-port] Matando proceso node viejo (PID $PID) que tenía el puerto $PORT…"
  kill -9 "$PID"
fi
