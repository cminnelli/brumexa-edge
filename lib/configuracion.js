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
const fs   = require('fs');

function setupConfiguracion(app, { lkSession, ragAuth, requestRoomToken, runCalibration, getLastCalibration, getEnvVal } = {}) {
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
    const device = (getEnvVal && getEnvVal('SPEAKER_ALSA_DEVICE')) || 'plughw:0,0';
    const { execFile } = require('child_process');
    execFile(
      'speaker-test',
      ['-D', device, '-c', '2', '-t', 'sine', '-f', '1000', '-l', '1'],
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

  // GET /configuracion/version — fecha del último commit local + si hay algo
  // nuevo en el remoto sin traer todavía. Usa "git ls-remote" para el
  // chequeo, NO "git fetch" — ls-remote solo consulta al servidor remoto
  // qué commit tiene, no escribe absolutamente nada en el .git local (a
  // diferencia de fetch, que si se corta a mitad de camino puede dejar un
  // objeto a medio escribir y corromper el repo — esto pasó de verdad en
  // producción, más de una vez, justo con este chequeo corriendo cada vez
  // que se abría la página). Como contrapartida ya no se puede mostrar
  // CUÁNTOS commits hay ni el mensaje del último sin traer los objetos —
  // ese detalle se resigna a propósito por seguridad.
  // Si no hay red o no hay upstream configurado, igual devuelve la fecha
  // local — "behind" queda en null (no sabemos, en vez de mentir "0").
  app.get('/configuracion/version', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, error: 'Solo disponible en la Raspberry (Linux) — este server está corriendo en Windows/dev' });
    }
    const { execSync } = require('child_process');
    const opts = { cwd: path.join(__dirname, '..'), timeout: 20000, encoding: 'utf8' };
    try {
      // El formato va entre comillas -- sin ellas, la shell interpreta los
      // "|" como pipes de verdad (correr git log -1 --format=%h y mandar
      // la salida a comandos literalmente llamados "%cI" y "%s", que no
      // existen -- eso es lo que tiraba "not found").
      const local = execSync('git log -1 --format="%h|%cI|%s"', opts).trim();
      const [hash, date, ...rest] = local.split('|');
      const subject = rest.join('|');

      let behind = null;
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
        const line = execSync(`git ls-remote --quiet origin refs/heads/${branch}`, { ...opts, timeout: 15000 }).trim();
        const remoteHash = line.split(/\s+/)[0];
        if (remoteHash) behind = remoteHash.startsWith(hash) || hash.startsWith(remoteHash) ? 0 : 1;
      } catch (e) {
        // sin red / sin upstream configurado — no rompe la respuesta principal
      }

      res.json({ ok: true, hash, date, subject, behind });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /configuracion/update — actualizar el código desde git (equivalente
  // a lo que antes había que hacer a mano por SSH: `git pull`). Si trajo
  // cambios reales, reinicia el proceso igual que /setup/config — pm2 lo
  // vuelve a levantar solo con el código nuevo.
  //
  // "Blue-green", no "git pull" in-place — historial real: "git pull" sobre
  // ESTA carpeta (la que está corriendo) se corrompió 3 de 3 veces en
  // producción (siempre el mismo patrón: un objeto de .git/objects vacío,
  // "bad object HEAD"), mientras que un "git clone" fresco funcionó 3 de 3
  // veces. La diferencia no es casualidad de mala suerte — son patrones de
  // escritura en disco distintos, y algo puntual de la Pi (SD, filesystem)
  // no tolera bien el de "pull". En vez de perseguir la causa exacta, se
  // esquiva el problema entero: la actualización SIEMPRE clona fresco a una
  // carpeta aparte (nunca toca el .git de la que está corriendo), se
  // verifica que quedó sana, se le copia el .env, se instalan las
  // dependencias — y RECIÉN AHÍ se reemplaza la carpeta vieja por la nueva
  // con un rename (no una escritura de git, no puede quedar a medio
  // escribir). Si cualquier paso falla, se corta en la copia descartable;
  // la carpeta que sirve el sitio no se toca hasta el último paso.
  const REPO_DIR = path.join(__dirname, '..');

  function _sh(cmd, opts) {
    return require('child_process').execSync(cmd, { encoding: 'utf8', ...opts }).trim();
  }

  // Cambios hechos a mano en la Pi (alguien editó un archivo por SSH/
  // terminal) que el swap final pisaría — mismo chequeo/mismo propósito
  // que antes tenía "git pull": avisar y ofrecer guardarlos aparte, nunca
  // pisarlos en silencio.
  function _hasLocalChanges() {
    return _sh('git status --porcelain', { cwd: REPO_DIR, timeout: 10000 }).length > 0;
  }

  function _rmDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* mejor esfuerzo */ }
  }

  // Deja solo el backup MÁS RECIENTE junto a REPO_DIR — cada actualización
  // exitosa deja la carpeta vieja como "<repo>-backup-<timestamp>" (por si
  // hace falta mirar algo ahí después); sin esto se acumularían para
  // siempre.
  function _pruneOldBackups() {
    try {
      const parentDir = path.dirname(REPO_DIR);
      const prefix = path.basename(REPO_DIR) + '-backup-';
      const backups = fs.readdirSync(parentDir).filter(n => n.startsWith(prefix)).sort();
      for (const old of backups.slice(0, -1)) _rmDir(path.join(parentDir, old));
    } catch (e) {
      console.warn('[configuracion] no se pudieron limpiar backups viejos de actualizaciones anteriores:', e.message);
    }
  }

  // onDone SIEMPRE se llama al final (éxito o error) para soltar el candado
  // — inclusive si el proceso está por reiniciarse, así el próximo arranque
  // no hereda el flag prendido.
  function runGitUpdate(res, onDone) {
    const fail = (error, extra = {}) => { res.json({ ok: false, error, ...extra }); onDone(); };

    // Cada paso loguea con console.log — ya sale en vivo por /ws/logs (ver
    // lib/log-stream.js, patchea console.* desde el arranque), así que el
    // front puede mostrar estas mismas líneas como progreso sin agregar
    // ningún mecanismo nuevo del lado del server.
    console.log('[configuracion] update: arrancando — chequeando cambios locales…');
    let hadLocalChanges;
    try {
      hadLocalChanges = _hasLocalChanges();
    } catch (e) {
      return fail(`No se pudo revisar el estado del repo actual: ${e.message}`);
    }
    if (hadLocalChanges) {
      return fail(
        'Hay cambios hechos a mano en este equipo (archivos editados por SSH/terminal) que la actualización pisaría.',
        { reason: 'local-changes' }
      );
    }

    let remoteUrl;
    try {
      remoteUrl = _sh('git config --get remote.origin.url', { cwd: REPO_DIR, timeout: 5000 });
    } catch (e) {
      return fail(`No se pudo determinar el remoto de git: ${e.message}`);
    }

    // AL LADO de REPO_DIR, no en os.tmpdir() — en la Pi /tmp suele ser un
    // filesystem distinto (tmpfs) al de ~/proyectos, y el rename final
    // (fs.renameSync) solo es atómico DENTRO del mismo filesystem; cruzando
    // filesystems tira "EXDEV: cross-device link not permitted" (visto en
    // producción). Mismo directorio padre que REPO_DIR y que los backups
    // ("<repo>-backup-<ts>") garantiza que los 2 renames de más abajo
    // siempre queden del lado correcto.
    const tmpDir = path.join(path.dirname(REPO_DIR), `${path.basename(REPO_DIR)}-update-${Date.now()}`);
    console.log(`[configuracion] update: clonando fresco en ${tmpDir}…`);
    try {
      _sh(`git clone --quiet "${remoteUrl}" "${tmpDir}"`, { timeout: 120000 });
    } catch (e) {
      _rmDir(tmpDir);
      return fail(`No se pudo traer el código nuevo (sin tocar la versión actual): ${e.message}`);
    }
    console.log('[configuracion] update: clon OK — verificando integridad…');

    // Mismos dos chequeos que antes hacía sobre la carpeta en vivo, ahora
    // sobre la copia descartable — rev-parse valida la cadena de commits
    // hasta HEAD (el caso ya visto: objeto de commit vacío/corrupto),
    // status --porcelain detecta un working tree mal escrito en el
    // checkout. Si algo de esto falla acá, no pasa nada — se tira la
    // carpeta temporal y listo, la que corre el sitio nunca se tocó.
    try {
      _sh('git rev-parse HEAD', { cwd: tmpDir, timeout: 10000 });
      const dirty = _sh('git status --porcelain', { cwd: tmpDir, timeout: 10000 });
      if (dirty) throw new Error(`working tree inconsistente en el clone nuevo:\n${dirty}`);
    } catch (checkErr) {
      console.error(`[configuracion] el clone nuevo salió corrupto (se descarta, no se tocó nada en producción): ${checkErr.message}`);
      _rmDir(tmpDir);
      return fail('La descarga del código nuevo salió corrupta — no se tocó nada, seguís en la versión anterior. Probá de nuevo en un rato.');
    }

    let oldHash, newHash;
    try {
      oldHash = _sh('git rev-parse HEAD', { cwd: REPO_DIR, timeout: 10000 });
      newHash = _sh('git rev-parse HEAD', { cwd: tmpDir, timeout: 10000 });
    } catch (e) {
      _rmDir(tmpDir);
      return fail(`No se pudieron comparar versiones: ${e.message}`);
    }

    if (oldHash === newHash) {
      console.log('[configuracion] update: ya estás al día — nada para traer.');
      _rmDir(tmpDir);
      res.json({ ok: true, upToDate: true, restarting: false });
      onDone();
      return;
    }
    console.log('[configuracion] update: integridad OK, hay cambios — copiando .env…');

    // .env no está versionado (ver .gitignore) — el clone nuevo no lo trae,
    // se copia tal cual del que está corriendo.
    try {
      fs.copyFileSync(path.join(REPO_DIR, '.env'), path.join(tmpDir, '.env'));
    } catch (e) {
      _rmDir(tmpDir);
      return fail(`No se pudo copiar .env al código nuevo (sin ese archivo el server no arranca): ${e.message}`);
    }

    // "npm install", no "npm ci" — se probó "npm ci" primero (no toca el
    // lock file, más prolijo) pero el package-lock.json commiteado hoy no
    // está en sync con package.json (le faltan rpi-ws281x y sus
    // dependencias nativas — probablemente se instaló a mano en la Pi
    // alguna vez sin commitear el lock actualizado), así que "npm ci" tira
    // EUSAGE y falla siempre. "npm install" sí reconcilia eso solo.
    //
    // Efecto secundario de "npm install": puede reescribir package-lock.json
    // al reconciliar — si no se revierte eso, la carpeta nueva queda
    // "sucia" (git status con package-lock.json modificado) apenas termina
    // de instalar, y la PRÓXIMA actualización dispara el chequeo de
    // "cambios locales" de más arriba con nada editado a mano de por medio.
    // Se descarta ese cambio puntual antes del swap — node_modules en disco
    // ya quedó bien instalado igual, lo único que se revierte es el TEXTO
    // del lock file commiteado. Ambos hallazgos son de probar el flujo
    // entero antes de subirlo, no teóricos.
    console.log('[configuracion] update: instalando dependencias en la copia nueva (npm install, puede tardar un par de minutos)…');
    try {
      _sh('npm install', { cwd: tmpDir, timeout: 240000 });
      _sh('git checkout -- package-lock.json', { cwd: tmpDir, timeout: 10000 });
    } catch (e) {
      _rmDir(tmpDir);
      return fail(`Falló "npm install" en el código nuevo — no se tocó la versión que está corriendo: ${e.message}`);
    }
    console.log('[configuracion] update: dependencias instaladas — haciendo el cambio de carpetas…');

    // Swap atómico — el ÚNICO punto que toca la carpeta que sirve el sitio,
    // y es un rename de sistema de archivos (no una escritura de git), así
    // que no puede dejar nada a medio escribir.
    const backupDir = `${REPO_DIR}-backup-${Date.now()}`;
    try {
      fs.renameSync(REPO_DIR, backupDir);
      fs.renameSync(tmpDir, REPO_DIR);
    } catch (e) {
      // Si el primer rename salió pero el segundo no, tratar de devolver la
      // carpeta original a su lugar en vez de dejar el sitio sin ninguna.
      try {
        if (fs.existsSync(backupDir) && !fs.existsSync(REPO_DIR)) fs.renameSync(backupDir, REPO_DIR);
      } catch (e2) { /* ya no hay mucho más que intentar acá */ }
      return fail(`Falló el cambio de carpetas: ${e.message}`);
    }

    _pruneOldBackups();
    console.log(`[configuracion] update: listo (${newHash.slice(0, 7)}) — reiniciando en breve…`);

    res.json({ ok: true, upToDate: false, restarting: true, hash: newHash });
    onDone();
    setTimeout(() => process.exit(0), 800);
  }

  app.post('/configuracion/update', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, output: 'Solo disponible en la Raspberry (Linux) — este server está corriendo en Windows/dev, no tocá el git de acá.' });
    }
    if (_gitBusy) {
      return res.status(409).json({ ok: false, error: 'Hay otra operación de git en curso — esperá unos segundos y probá de nuevo.' });
    }
    _gitBusy = true;
    runGitUpdate(res, () => { _gitBusy = false; });
  });

  // POST /configuracion/update/stash-and-retry — guarda los cambios locales
  // aparte (git stash) y reintenta. Solo se llama desde el botón que
  // aparece cuando /configuracion/update devuelve reason:'local-changes' —
  // nunca automático.
  //
  // OJO con el blue-green: el stash queda guardado en el .git de la carpeta
  // VIEJA — el swap la deja de lado como "<repo>-backup-<timestamp>" (no la
  // borra), así que sigue siendo recuperable con `git stash pop` entrando a
  // esa carpeta de backup por SSH, pero YA NO aparece solo en la carpeta
  // nueva que queda corriendo. Caso raro (implica haber editado archivos a
  // mano en la Pi), documentado acá por si hace falta.
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
      runGitUpdate(res, () => { _gitBusy = false; });
    });
  });

  // POST /configuracion/restart — reinicia el proceso SIN tocar código ni
  // .env (a diferencia de /configuracion/update, que solo reinicia si el
  // git pull trajo algo nuevo). Útil cuando algo se traba y "apagar y
  // prender" es más simple que ir a buscar la causa — mismo mecanismo que
  // ya usa /configuracion/update (process.exit(0), pm2 lo levanta solo),
  // no un pm2 restart/kill directo, para no depender de tener pm2 en el
  // PATH del proceso Node ni de permisos para hablarle a otro proceso.
  app.post('/configuracion/restart', (_req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, error: 'Solo disponible en la Raspberry (Linux)' });
    }
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 500);
  });

  console.log('[configuracion] Endpoints OK — /configuracion  /configuracion/status  /configuracion/mic-toggle  /configuracion/force-auth  /configuracion/force-token  /configuracion/speaker-test  /configuracion/recalibrate  /configuracion/version  /configuracion/update  /configuracion/update/stash-and-retry  /configuracion/restart');
}

module.exports = { setupConfiguracion };
