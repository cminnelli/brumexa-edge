'use strict';

/**
 * lib/configuracion.js
 *
 * Panel de configuración y acciones — todo lo EDITABLE (credenciales,
 * toggle de mic) y todo lo ACCIONABLE (forzar auth, forzar token, probar
 * parlante) vive acá. Distinto de lib/local-debug.js (/local), que es
 * solo lectura/diagnóstico — esa página no tiene ni un botón que cambie
 * estado, esta página no tiene ni un dato que no se pueda tocar.
 *
 * La edición de credenciales (.env) reusa GET/POST /setup/config, que ya
 * existe en server.js para la página /setup — no se duplica esa lógica acá.
 */

const path = require('path');

function setupConfiguracion(app, { lkSession, ragAuth, requestRoomToken, runCalibration, getLastCalibration } = {}) {
  app.get('/configuracion', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'configuracion.html'));
  });

  // GET /configuracion/status — estado actual para poblar la página al
  // cargar (auth, mic on/off, último resultado de calibración). Las
  // credenciales editables se leen aparte desde GET /setup/config (ya existente).
  app.get('/configuracion/status', (_req, res) => {
    let auth = null;
    try { auth = ragAuth ? ragAuth.getStatus() : null; } catch (e) { auth = { error: e.message }; }

    let micEnabled = null;
    try { micEnabled = lkSession ? lkSession.getMicEnabled() : null; } catch (e) { /* noop */ }

    let calibration = null;
    try { calibration = getLastCalibration ? getLastCalibration() : null; } catch (e) { /* noop */ }

    res.json({ ragAuth: auth, micEnabled, calibration });
  });

  // POST /configuracion/recalibrate — repite a mano la calibración de ruido
  // ambiente que corre sola al boot (mismo aviso de LEDs, misma medición de
  // 4s). Útil si el arranque agarró un mal momento (alguien hablando cerca,
  // TV prendida) o si el ambiente cambió después.
  app.post('/configuracion/recalibrate', async (_req, res) => {
    if (!runCalibration) return res.status(400).json({ ok: false, error: 'Calibración no disponible' });
    try {
      const result = await runCalibration('manual');
      res.json({ ok: true, calibration: result });
    } catch (e) {
      res.status(409).json({ ok: false, error: e.message });
    }
  });

  // POST /configuracion/mic-toggle { enabled: bool } — activa/desactiva la
  // captura de mic en las próximas sesiones LiveKit (no afecta una sesión
  // ya conectada, solo aplica desde el próximo start()). Flag en memoria,
  // no persiste en .env — vuelve a "activado" si se reinicia el proceso.
  app.post('/configuracion/mic-toggle', require('express').json(), (req, res) => {
    if (!lkSession) return res.status(400).json({ ok: false, error: 'lkSession no disponible' });
    const { enabled } = req.body || {};
    const result = lkSession.setMicEnabled(enabled);
    res.json({ ok: true, micEnabled: result });
  });

  // POST /configuracion/force-auth — dispara ragAuth.login() a mano, mismo
  // llamado que hace initAuth() al boot. Sirve para ver el resultado (o el
  // error exacto) del paso de autenticación sin arrancar una sesión.
  app.post('/configuracion/force-auth', async (_req, res) => {
    if (!ragAuth) return res.status(400).json({ ok: false, error: 'rag-auth no disponible' });
    try {
      await ragAuth.login();
      res.json({ ok: true, status: ragAuth.getStatus() });
    } catch (e) {
      res.json({ ok: false, error: e.message, status: ragAuth.getStatus() });
    }
  });

  // POST /configuracion/force-token — dispara requestRoomToken() a mano (el
  // mismo llamado que hace /session/start). No devuelve el token completo
  // por seguridad, solo confirmación + metadata de la sala asignada.
  app.post('/configuracion/force-token', async (_req, res) => {
    if (!requestRoomToken) return res.status(400).json({ ok: false, error: 'rag-token no disponible' });
    try {
      const data = await requestRoomToken();
      res.json({
        ok: true,
        roomName:     data.roomName,
        serverUrl:    data.serverUrl,
        tokenPreview: data.token ? `${data.token.slice(0, 16)}…` : null,
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // POST /configuracion/speaker-test — dispara un tono de prueba por el
  // parlante. No requiere liberar el mic (captura y reproducción son
  // sub-devices distintos del mismo HAT) — corre con la app funcionando normal.
  app.post('/configuracion/speaker-test', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, error: 'Solo disponible en Linux' });
    }
    const { exec } = require('child_process');
    exec(
      'speaker-test -D plughw:0,0 -c 2 -t sine -f 1000 -l 1',
      { timeout: 6000 },
      (err, stdout, stderr) => {
        // speaker-test a veces no corta solo al terminar el loop — el
        // timeout de exec lo mata igual; eso no es una falla real.
        if (err && err.killed) {
          return res.json({ ok: true, note: 'Tono reproducido (cortado por timeout de seguridad)' });
        }
        res.json({ ok: !err, output: (stdout + stderr).trim().slice(-500) || null });
      }
    );
  });

  console.log('[configuracion] Endpoints OK — /configuracion  /configuracion/status  /configuracion/mic-toggle  /configuracion/force-auth  /configuracion/force-token  /configuracion/speaker-test  /configuracion/recalibrate');
}

module.exports = { setupConfiguracion };
