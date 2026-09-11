'use strict';

/**
 * lib/system-fixes.js
 *
 * /instalacion — lista curada A MANO de arreglos de sistema puntuales que
 * "actualizar" desde /configuracion no aplica solo (porque tocan cosas
 * fuera del repo: /etc/asound.conf, servicios systemd, etc — ver
 * install.sh). A propósito NO es un mapeo genérico de todo install.sh: la
 * idea es exponer solo los pasos que son idempotentes, rápidos y no tocan
 * nada del "core" (no instalan paquetes de apt, no reinstalan Node/PM2) —
 * cada fix de esta lista tiene que poder aplicarse (o re-aplicarse) sin
 * romper nada, sin necesitar SSH.
 *
 * Cada fix define su propio check() (¿ya está aplicado?) y apply() (aplicarlo
 * — siempre re-ejecutable sin efectos raros si ya estaba aplicado). El id
 * de cada fix es la ÚNICA entrada aceptada desde el POST — nunca se corre
 * un comando armado con algo que venga del body/cliente.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { timeout: 15000, encoding: 'utf8', ...opts });
}

// ─── Fix: audio sin pop (mantener el reloj I2S siempre vivo) ─────────────────
// Ver el plan/commit "eliminar el pop del HAT al conectar" — mismo contenido
// que agrega install.sh (paso 12), acá repetido para poder aplicarse solo,
// sin correr el instalador entero.
const ASOUND_PATH   = '/etc/asound.conf';
const SERVICE_NAME  = 'brumexa-audio-keepalive';
const SERVICE_SRC   = path.join(REPO_DIR, 'scripts', 'brumexa-audio-keepalive.service');
const SERVICE_DST   = `/etc/systemd/system/${SERVICE_NAME}.service`;
const ENV_PATH       = path.join(REPO_DIR, '.env');
const ASOUND_MARKER  = 'pcm.brumexa_speaker';
const ASOUND_BLOCK   = `
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
`;

const audioKeepaliveFix = {
  id: 'audio-keepalive',
  title: 'Audio sin pop al conectar',
  description: 'Mantiene el reloj I2S del HAT siempre encendido (servicio systemd + device ALSA virtual "brumexa_speaker") para que arecord/aplay no hagan un "pum" audible al abrir el dispositivo de cero.',

  async check() {
    const hasAsound = fs.existsSync(ASOUND_PATH) &&
      fs.readFileSync(ASOUND_PATH, 'utf8').includes(ASOUND_MARKER);

    let serviceActive = false;
    try { serviceActive = run('systemctl', ['is-active', SERVICE_NAME]).trim() === 'active'; }
    catch { /* systemctl is-active sale con código != 0 si no está activo — no es un error real */ }

    const envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const hasEnv = /^SPEAKER_ALSA_DEVICE=brumexa_speaker\s*$/m.test(envContent);

    return {
      applied: hasAsound && serviceActive && hasEnv,
      detail: { hasAsound, serviceActive, hasEnv },
    };
  },

  async apply() {
    const asoundContent = fs.existsSync(ASOUND_PATH) ? fs.readFileSync(ASOUND_PATH, 'utf8') : '';
    if (!asoundContent.includes(ASOUND_MARKER)) {
      run('sudo', ['tee', '-a', ASOUND_PATH], { input: ASOUND_BLOCK });
    }

    if (!fs.existsSync(SERVICE_SRC)) {
      throw new Error(`No se encontró ${SERVICE_SRC} — actualizá el código primero (botón "Actualizar")`);
    }
    // El .service en el repo trae "User=brumelab" como placeholder (mismo
    // criterio que ya usa scripts/brumexa-boot.service) — hay que
    // reemplazarlo por el usuario real que corre este proceso ANTES de
    // instalarlo. Sin esto, el keepalive corría como root y la app (como
    // el usuario normal) no podía compartir el device dmix con él —
    // "unable to create IPC semaphore" / "Permission denied" en TODOS los
    // aplay de la app, no solo en el pop. Por eso se escribe con `tee`
    // (contenido ya resuelto) en vez de `cp` del archivo tal cual.
    const currentUser = require('os').userInfo().username;
    const serviceContent = fs.readFileSync(SERVICE_SRC, 'utf8')
      .replace(/^User=brumelab$/m, `User=${currentUser}`);
    run('sudo', ['tee', SERVICE_DST], { input: serviceContent });
    run('sudo', ['systemctl', 'daemon-reload']);
    run('sudo', ['systemctl', 'enable', SERVICE_NAME]);
    // restart, no start/enable --now — si ya estaba corriendo (ej. con el
    // User= viejo/root de antes de este fix), "start" en un unit ya activo
    // no hace nada: systemd no lo recicla solo aunque el archivo cambió.
    // restart sí lo baja y lo vuelve a levantar con la config nueva.
    run('sudo', ['systemctl', 'restart', SERVICE_NAME]);

    let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    if (/^SPEAKER_ALSA_DEVICE=/m.test(envContent)) {
      envContent = envContent.replace(/^SPEAKER_ALSA_DEVICE=.*$/m, 'SPEAKER_ALSA_DEVICE=brumexa_speaker');
    } else {
      envContent += (envContent.endsWith('\n') || !envContent ? '' : '\n') + 'SPEAKER_ALSA_DEVICE=brumexa_speaker\n';
    }
    fs.writeFileSync(ENV_PATH, envContent, 'utf8');

    return { needsRestart: true, note: 'Reiniciá Brumexa (arriba en Configuración) para que tome el nuevo device de audio.' };
  },
};

// Agregar acá futuros fixes puntuales — mismo criterio: idempotente, sin
// apt install, sin tocar Node/PM2/el repo en sí.
const FIXES = [audioKeepaliveFix];

// ─── Registrar rutas Express ──────────────────────────────────────────────────
function setupSystemFixes(app) {
  const jsonBody = require('express').json();

  app.get('/instalacion', (_req, res) => {
    res.sendFile(path.join(REPO_DIR, 'public', 'instalacion.html'));
  });

  app.get('/instalacion/fixes', async (_req, res) => {
    if (process.platform !== 'linux') {
      return res.json({ ok: true, fixes: FIXES.map(f => ({ id: f.id, title: f.title, description: f.description, applied: false, detail: { note: 'Solo disponible en Linux' } })) });
    }
    const fixes = await Promise.all(FIXES.map(async (f) => {
      try {
        const { applied, detail } = await f.check();
        return { id: f.id, title: f.title, description: f.description, applied, detail };
      } catch (e) {
        return { id: f.id, title: f.title, description: f.description, applied: false, detail: { error: e.message } };
      }
    }));
    res.json({ ok: true, fixes });
  });

  // El :id llega por la URL pero SOLO se usa para buscar en la whitelist de
  // arriba (FIXES.find) — nunca se arma un comando ni un path con esto.
  app.post('/instalacion/fixes/:id/apply', jsonBody, async (req, res) => {
    if (process.platform !== 'linux') {
      return res.status(400).json({ ok: false, error: 'Solo disponible en Linux' });
    }
    const fix = FIXES.find(f => f.id === req.params.id);
    if (!fix) return res.status(404).json({ ok: false, error: 'Fix desconocido' });

    try {
      const result = await fix.apply();
      console.log(`[system-fixes] "${fix.id}" aplicado`);
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error(`[system-fixes] "${fix.id}" falló:`, e.message);
      // Node corre sin terminal/TTY — un "sudo" que no esté en el archivo de
      // permisos acotado (ver install.sh, paso 12 → /etc/sudoers.d/
      // brumexa-system-fixes) siempre falla así. Mensaje claro en vez del
      // stderr crudo de sudo, que no dice qué hacer.
      const needsSudoSetup = /password is required|terminal is required/i.test(e.message);
      const error = needsSudoSetup
        ? 'Falta un permiso de sudo puntual para este fix — hace falta correr, una sola vez por terminal, el paso "Permisos para /instalacion" de install.sh (o pedirle a Claude el comando exacto).'
        : e.message;
      res.status(500).json({ ok: false, error });
    }
  });

  console.log('[system-fixes] Endpoints OK — /instalacion  /instalacion/fixes');
}

module.exports = { setupSystemFixes, FIXES };
