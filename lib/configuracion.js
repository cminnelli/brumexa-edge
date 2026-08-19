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

  // ─── Candado de git ──────────────────────────────────────────────────────
  // /configuracion/version dispara un "git fetch" de fondo cada vez que se
  // carga la página (para el chequeo "¿hay actualizaciones?"), y el botón
  // de Actualizar dispara un "git pull"/"git stash" — los dos tocan el
  // mismo .git. Si llegan a correr pisándose (ej. entrás a Configuración
  // justo cuando el pull todavía está terminando), en una SD card lenta
  // puede quedar un objeto de git a medio escribir — esto pasó de verdad
  // una vez y corrompió el repo (server.js no arrancaba más). Con este
  // flag, nunca corre más de una operación de git a la vez.
  let _gitBusy = false;

  // GET /configuracion/version — fecha del último commit local + cuántos
  // commits nuevos hay en el remoto sin traer todavía. El "git fetch" solo
  // actualiza la referencia remota (no toca el código local) — es lo mismo
  // que hace "buscar actualizaciones" en cualquier app, sin aplicar nada.
  // Si no hay red o no hay upstream configurado, igual devuelve la fecha
  // local — "behind" queda en null (no sabemos, en vez de mentir "0").
  app.get('/configuracion/version', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, error: 'Solo disponible en la Raspberry (Linux) — este server está corriendo en Windows/dev' });
    }
    const { execSync } = require('child_process');
    const opts = { cwd: path.join(__dirname, '..'), timeout: 10000, encoding: 'utf8' };
    try {
      // El formato va entre comillas -- sin ellas, la shell interpreta los
      // "|" como pipes de verdad (correr git log -1 --format=%h y mandar
      // la salida a comandos literalmente llamados "%cI" y "%s", que no
      // existen -- eso es lo que tiraba "not found").
      const local = execSync('git log -1 --format="%h|%cI|%s"', opts).trim();
      const [hash, date, ...rest] = local.split('|');
      const subject = rest.join('|');

      // El fetch es lo único que escribe/toca red acá — si ya hay una
      // actualización corriendo, nos salteamos ESTA parte nomás (la fecha
      // del commit local de arriba es de solo lectura, sin riesgo).
      let behind = null;
      if (!_gitBusy) {
        _gitBusy = true;
        try {
          execSync('git fetch --quiet', { ...opts, timeout: 15000 });
          behind = parseInt(execSync('git rev-list --count HEAD..@{u}', opts).trim(), 10);
        } catch (e) {
          // sin red / sin upstream configurado — no rompe la respuesta principal
        } finally {
          _gitBusy = false;
        }
      }

      res.json({ ok: true, hash, date, subject, behind });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /configuracion/update — actualizar el código desde git (equivalente
  // a lo que antes había que hacer a mano por SSH: `git pull`). Si trajo
  // cambios reales (no "Already up to date"), reinicia el proceso igual que
  // /setup/config — pm2 lo vuelve a levantar solo con el código nuevo.
  //
  // Si `git pull` falla porque hay cambios locales sin commitear que se
  // pisarían (alguien tocó un archivo a mano en la Pi por SSH/terminal),
  // NO lo pisamos ni lo descartamos solos — devolvemos reason:'local-changes'
  // para que el front ofrezca "guardar aparte y actualizar" (git stash,
  // reversible) en vez de mostrar el error crudo de git.
  const REPO_DIR = path.join(__dirname, '..');

  // onDone SIEMPRE se llama al final (éxito o error) para soltar el candado
  // — inclusive si el proceso está por reiniciarse, así el próximo arranque
  // no hereda el flag prendido.
  function runGitPull(res, onDone) {
    const { exec } = require('child_process');
    exec('git pull', { cwd: REPO_DIR, timeout: 30000 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      console.log(`[configuracion] git pull → ${err ? 'FALLÓ' : 'OK'}\n${output}`);

      if (err) {
        if (/local changes.*would be overwritten|please commit your changes or stash/i.test(output)) {
          res.json({
            ok: false,
            reason: 'local-changes',
            output,
            error: 'Hay cambios hechos a mano en este equipo que la actualización pisaría.',
          });
        } else {
          res.json({ ok: false, output, error: 'No se pudo actualizar — ver detalle técnico.' });
        }
        onDone();
        return;
      }

      const upToDate = /already up[- ]to[- ]date/i.test(output);
      res.json({ ok: true, output, upToDate, restarting: !upToDate });
      onDone();
      if (!upToDate) {
        setTimeout(() => process.exit(0), 800);
      }
    });
  }

  app.post('/configuracion/update', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, output: 'Solo disponible en la Raspberry (Linux) — este server está corriendo en Windows/dev, no tocá el git de acá.' });
    }
    if (_gitBusy) {
      return res.status(409).json({ ok: false, error: 'Hay otra operación de git en curso — esperá unos segundos y probá de nuevo.' });
    }
    _gitBusy = true;
    runGitPull(res, () => { _gitBusy = false; });
  });

  // POST /configuracion/update/stash-and-retry — guarda los cambios locales
  // aparte (git stash, no los borra — quedan recuperables con `git stash pop`
  // desde /terminal si hicieran falta) y reintenta el pull. Solo se llama
  // desde el botón que aparece cuando /configuracion/update devuelve
  // reason:'local-changes' — nunca automático.
  app.post('/configuracion/update/stash-and-retry', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, output: 'Solo disponible en la Raspberry (Linux)' });
    }
    if (_gitBusy) {
      return res.status(409).json({ ok: false, error: 'Hay otra operación de git en curso — esperá unos segundos y probá de nuevo.' });
    }
    _gitBusy = true;
    const { exec } = require('child_process');
    exec('git stash', { cwd: REPO_DIR, timeout: 15000 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      console.log(`[configuracion] git stash → ${err ? 'FALLÓ' : 'OK'}\n${output}`);
      if (err) {
        _gitBusy = false;
        return res.json({ ok: false, output, error: 'No se pudieron guardar los cambios locales aparte.' });
      }
      runGitPull(res, () => { _gitBusy = false; });
    });
  });

  console.log('[configuracion] Endpoints OK — /configuracion  /configuracion/status  /configuracion/mic-toggle  /configuracion/force-auth  /configuracion/force-token  /configuracion/speaker-test  /configuracion/recalibrate  /configuracion/version  /configuracion/update  /configuracion/update/stash-and-retry');
}

module.exports = { setupConfiguracion };
