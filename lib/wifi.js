'use strict';

/**
 * lib/wifi.js
 *
 * Provisioning WiFi via Access Point usando NetworkManager (nmcli).
 * Objetivo: la Pi levanta un AP "Brumexa-Setup", el cliente se conecta,
 * ingresa credenciales en la página /setup y la Pi se registra al WiFi.
 *
 * Requiere: Raspberry Pi OS Bookworm (NetworkManager). nmcli debe estar disponible.
 */

const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const execAsync = promisify(exec);
// Como run() pero sin bloquear el event loop — ver getStatusAsync() más
// abajo: getStatus() (execSync × hasta 5 comandos nmcli) se descubrió
// corriendo cada HEALTH_CHECK_INTERVAL_MS (15s) SIEMPRE, esté alguien
// usando la app o no — un monitor de bloqueo del event loop instalado en
// server.js atrapó atrasos de ~180-240ms cada 15s en punto, justo la firma
// de esta cadena de nmcli síncronos.
function runAsync(cmd, timeout = 4000) {
  return execAsync(cmd, { timeout, encoding: 'utf8' })
    .then(({ stdout, stderr }) => (stdout || stderr || '').trim())
    .catch((e) => (e.stdout || e.stderr || '').toString().trim());
}

// ─── Configuración del AP (sobreescribible por .env) ─────────────────────────
// Sin WIFI_AP_SSID en .env, el nombre BASE default es el hostname del
// dispositivo (el mismo que usa mDNS/Avahi para "<hostname>.local") — así,
// con varias Brumexas cerca en modo AP a la vez, se distinguen solas por
// nombre en vez de aparecer todas como "brumexa-local".
// AP_SSID (lo que se transmite de verdad) SIEMPRE le agrega el sufijo
// "_AP" a ese nombre base — sea el hostname por default o uno elegido a
// mano desde /configuracion — para que la red de configuración se
// distinga de un simple nombre de dispositivo ("MiCasa" vs "MiCasa_AP").
// AP_BASE guarda el nombre "limpio" (lo que se persiste en .env y lo que
// ve/edita la persona en el campo de texto); AP_SSID es el derivado, el
// único que de verdad importa para nmcli.
// let, no const: setApSsid() más abajo las reasigna en caliente cuando se
// cambia desde /configuracion, sin esperar a un reinicio del proceso.
let AP_BASE      = process.env.WIFI_AP_SSID || os.hostname();
let AP_SSID      = `${AP_BASE}_AP`;
const AP_PASS    = process.env.WIFI_AP_PASS || 'brumexa123';
const AP_IP      = process.env.WIFI_AP_IP   || '10.42.0.1';
const AP_IFACE   = 'wlan0';

// ─── Monitoreo continuo de salud de WiFi (señal débil → LEDs naranja) ────────
const SIGNAL_WEAK_THRESHOLD = parseInt(process.env.WIFI_SIGNAL_WEAK_THRESHOLD, 10) || 40; // % (nmcli SIGNAL)
const HEALTH_CHECK_INTERVAL_MS = 15000;

// Cuánto esperar desconectado antes de relevantar el AP de provisioning.
// Le da margen a NetworkManager para reconectarse solo (ej: el router del
// cliente reiniciando) antes de que nosotros le saquemos el radio en modo AP.
const DISCONNECT_AP_RECOVERY_MS = parseInt(process.env.WIFI_DISCONNECT_AP_RECOVERY_MS, 10) || 45000;

// Una vez resignados al AP (nadie entró a /setup a reconfigurar), cada cuánto
// probamos en el fondo si la red de siempre volvió, para reconectarnos solos
// sin depender de que alguien entre manualmente.
const BACKGROUND_RECOVERY_MS = parseInt(process.env.WIFI_BACKGROUND_RECOVERY_MS, 10) || 3 * 60 * 1000;

// ─── Estado de la conexión en curso ──────────────────────────────────────────
let _connectState = {
  status:    'idle',   // 'idle' | 'connecting' | 'connected' | 'error'
  ssid:      null,
  ip:        null,
  error:     null,
  startedAt: null,
};

// ─── Log de debug persistente en la SD ───────────────────────────────────────
// Sobrevive a reinicios y se puede leer sacando la SD y montándola en otra PC,
// o vía GET /wifi/debug-log mientras el server esté vivo (AP o red real).
// No guardamos contraseñas en texto plano — solo su longitud.
const LOG_DIR       = path.join(__dirname, '..', 'logs');
const LOG_FILE      = path.join(LOG_DIR, 'wifi-debug.log');
const LOG_MAX_BYTES = 512 * 1024; // 512KB — si se pasa, se recorta a la mitad más reciente

function _maskPassword(pw) {
  if (!pw) return '(sin contraseña)';
  return `(${pw.length} caracteres)`;
}

function _logDebug(line) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${stamp}] ${line}\n`, 'utf8');

    const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (stat && stat.size > LOG_MAX_BYTES) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, content.slice(Math.floor(content.length / 2)), 'utf8');
    }
  } catch (e) {
    console.warn('[wifi] _logDebug error:', e.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function nmcliAvailable() {
  try { execSync('which nmcli', { timeout: 2000 }); return true; }
  catch { return false; }
}

function run(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
  } catch (e) {
    return (e.stdout || e.stderr || '').toString().trim();
  }
}

// Reconecta a un perfil que NetworkManager ya tiene guardado (mismo SSID al
// que nos conectamos antes) sin volver a pedir contraseña. Se usa como
// intento rápido de recuperación, tanto antes de resignarnos al AP como en
// los reintentos de fondo mientras el AP está activo.
// Async (exec, no execSync): un intento puede tardar varios segundos y no
// queremos bloquear el proceso entero (HTTP, audio) mientras tanto.
function _tryReconnectSaved(ssid, timeout = 15000) {
  return new Promise((resolve) => {
    if (!ssid) return resolve(false);
    exec(`nmcli connection up "${ssid}" ifname ${AP_IFACE}`, { timeout }, (_err, stdout, stderr) => {
      resolve((stdout + stderr).toLowerCase().includes('successfully activated'));
    });
  });
}

// ─── Ancho de banda / uso de datos WiFi ──────────────────────────────────────
// Pedido explícito: algo simple y de bajo costo para ver velocidad y consumo
// de datos en /local, sin sumar dependencias nuevas (vnstat, etc.). Los
// contadores del kernel en /sys/class/net/<iface>/statistics son un par de
// lecturas de archivo casi instantáneas (no exec, no spawn) — mucho más
// baratas que cualquiera de los nmcli de este archivo, así que no hace
// falta la variante async ni un timer aparte: se leen directo cada vez que
// se llama a getStatus()/getStatusAsync() (cada 6s desde /local, cada 15s
// desde el monitor de salud). La velocidad instantánea sale de comparar
// contra la lectura ANTERIOR, guardada en _lastBandwidthSample.
let _lastBandwidthSample = null; // { rxBytes, txBytes, ts }

function _readBandwidthCounters() {
  try {
    const rxBytes = parseInt(fs.readFileSync(`/sys/class/net/${AP_IFACE}/statistics/rx_bytes`, 'utf8'), 10);
    const txBytes = parseInt(fs.readFileSync(`/sys/class/net/${AP_IFACE}/statistics/tx_bytes`, 'utf8'), 10);
    if (isNaN(rxBytes) || isNaN(txBytes)) return null;
    return { rxBytes, txBytes, ts: Date.now() };
  } catch {
    return null; // interfaz inexistente (dev en Windows) o sysfs no disponible
  }
}

function getBandwidth() {
  const sample = _readBandwidthCounters();
  if (!sample) return null;

  let rxKbps = null, txKbps = null;
  const prev = _lastBandwidthSample;
  if (prev && sample.ts > prev.ts) {
    const dtSec = (sample.ts - prev.ts) / 1000;
    const dRx   = sample.rxBytes - prev.rxBytes;
    const dTx   = sample.txBytes - prev.txBytes;
    // Un delta negativo pasa si el driver reinició el contador (interfaz
    // bajada/subida de nuevo, típico al pasar de AP a cliente) — se
    // descarta en vez de mostrar una velocidad absurda por un instante.
    if (dRx >= 0) rxKbps = Math.round((dRx * 8) / dtSec / 1000);
    if (dTx >= 0) txKbps = Math.round((dTx * 8) / dtSec / 1000);
  }
  _lastBandwidthSample = sample;

  return {
    rxKbps, txKbps,
    // Total acumulado desde que la interfaz se levantó (no desde el boot del
    // SO ni un "plan de datos") — igual sirve para ver de un vistazo si el
    // dispositivo viene consumiendo mucho más de lo esperado.
    rxTotalMB: Math.round(sample.rxBytes / 1024 / 1024 * 10) / 10,
    txTotalMB: Math.round(sample.txBytes / 1024 / 1024 * 10) / 10,
  };
}

// ─── Estado WiFi actual ───────────────────────────────────────────────────────
function getStatus() {
  if (!nmcliAvailable()) {
    return { available: false, apActive: false, connectedSSID: null, ipAddress: null, signal: null };
  }

  let apActive      = false;
  let connectedSSID = null;
  let ipAddress     = null;

  try {
    // Ver si hay un hotspot activo con nombre AP_SSID
    const conns = run('nmcli -t -f NAME,TYPE,DEVICE connection show --active', 4000);
    for (const line of conns.split('\n')) {
      if (line.includes(AP_SSID)) { apActive = true; break; }
    }

    // Ver SSID conectado en wlan0
    const devInfo = run(`nmcli -t -f GENERAL.CONNECTION,IP4.ADDRESS device show ${AP_IFACE}`, 4000);
    for (const line of devInfo.split('\n')) {
      if (line.startsWith('GENERAL.CONNECTION:')) {
        const conn = line.split(':').slice(1).join(':').trim();
        if (conn && conn !== '--' && conn !== AP_SSID) connectedSSID = conn;
      }
      if (line.startsWith('IP4.ADDRESS')) {
        const addr = line.split(':').slice(1).join(':').trim();
        if (addr && addr !== '--') ipAddress = addr.split('/')[0];
      }
    }
  } catch (e) {
    console.warn('[wifi] getStatus error:', e.message);
  }

  const signal = connectedSSID ? getSignalStrength() : null;

  return { available: true, apActive, connectedSSID, ipAddress, signal, bandwidth: getBandwidth() };
}

// Versión async de getStatus() — MISMA lógica, pero con runAsync (exec, no
// execSync) para no bloquear el event loop. Usada por el monitor de salud
// que corre cada 15s en segundo plano SIEMPRE (ver startHealthMonitor() más
// abajo) — con la versión síncrona, esos ~4-5 comandos nmcli encadenados
// congelaban audio/LEDs un rato cada 15s en punto, se veía como que "la
// respiración se traba" sin relación aparente con nada que hiciera el
// usuario. getStatus() (síncrona) queda igual para las rutas HTTP puntuales
// (bajo demanda, un usuario mirando /wifi/status a la vez, no vale la pena
// el riesgo de tocar ese camino también).
async function nmcliAvailableAsync() {
  return !!(await runAsync('which nmcli', 2000));
}

async function getStatusAsync() {
  if (!(await nmcliAvailableAsync())) {
    return { available: false, apActive: false, connectedSSID: null, ipAddress: null, signal: null };
  }

  let apActive      = false;
  let connectedSSID = null;
  let ipAddress     = null;

  try {
    const conns = await runAsync('nmcli -t -f NAME,TYPE,DEVICE connection show --active', 4000);
    for (const line of conns.split('\n')) {
      if (line.includes(AP_SSID)) { apActive = true; break; }
    }

    const devInfo = await runAsync(`nmcli -t -f GENERAL.CONNECTION,IP4.ADDRESS device show ${AP_IFACE}`, 4000);
    for (const line of devInfo.split('\n')) {
      if (line.startsWith('GENERAL.CONNECTION:')) {
        const conn = line.split(':').slice(1).join(':').trim();
        if (conn && conn !== '--' && conn !== AP_SSID) connectedSSID = conn;
      }
      if (line.startsWith('IP4.ADDRESS')) {
        const addr = line.split(':').slice(1).join(':').trim();
        if (addr && addr !== '--') ipAddress = addr.split('/')[0];
      }
    }
  } catch (e) {
    console.warn('[wifi] getStatusAsync error:', e.message);
  }

  const signal = connectedSSID ? await getSignalStrengthAsync() : null;

  return { available: true, apActive, connectedSSID, ipAddress, signal, bandwidth: getBandwidth() };
}

async function getSignalStrengthAsync() {
  if (!(await nmcliAvailableAsync())) return null;
  try {
    const out = await runAsync(`nmcli -t -f IN-USE,SIGNAL,SSID device wifi list ifname ${AP_IFACE}`, 4000);
    for (const line of out.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === '*') return parseInt(parts[1], 10);
    }
  } catch (e) {
    console.warn('[wifi] getSignalStrengthAsync error:', e.message);
  }
  return null;
}

// ─── Fuerza de señal (0-100) de la red actualmente asociada ──────────────────
function getSignalStrength() {
  if (!nmcliAvailable()) return null;
  try {
    // Sin --rescan: usa el scan cacheado de NetworkManager, rápido (~ms)
    const out = run(`nmcli -t -f IN-USE,SIGNAL,SSID device wifi list ifname ${AP_IFACE}`, 4000);
    for (const line of out.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === '*') return parseInt(parts[1], 10);
    }
  } catch (e) {
    console.warn('[wifi] getSignalStrength error:', e.message);
  }
  return null;
}

// ─── Escanear redes disponibles ───────────────────────────────────────────────
// Dos pasadas (caché + forzado) — defensa razonable de todos modos, pero el
// causante REAL de "solo aparece mi propia red" resultó ser otro, más de
// fondo: NetworkManager delega en Polkit el permiso para FORZAR un escaneo
// nuevo (org.freedesktop.NetworkManager.wifi.scan, el que dispara
// --rescan yes) — y por default Polkit exige una sesión de login activa
// para concederlo. Este server corre como servicio de systemd (PM2 al
// boot), sin ninguna sesión — sin el permiso explícito, nmcli desde acá
// SIEMPRE devolvía nada más que la red ya conectada (la única que ya
// "conoce" sin necesitar escanear), aunque el mismo comando corrido a mano
// por SSH sí traía todas las redes cercanas sin problema. El arreglo real
// es la regla de Polkit que agrega install.sh (paso 4,
// /etc/polkit-1/rules.d/50-brumexa-wifi-scan.rules) — sin eso, ninguna
// cantidad de reintentos/combinación de pasadas desde acá soluciona nada,
// porque nmcli ni siquiera llega a pedirle al radio que escanee de nuevo.
function scanNetworks() {
  if (!nmcliAvailable()) return [];

  const found = new Map(); // ssid -> { ssid, signal, security }
  const rawDumps = [];

  function collect(label, cmd, timeout) {
    try {
      const out = run(cmd, timeout);
      rawDumps.push(`--- ${label} ---\n${out || '(vacío)'}`);
      for (const line of out.split('\n')) {
        const parts = line.split(':');
        if (parts.length < 2) continue;
        const ssid     = parts[0].replace(/\\:/g, ':').trim();
        const signal   = parseInt(parts[1], 10) || 0;
        const security = (parts[2] || '').trim();

        if (!ssid || ssid === '--' || ssid === AP_SSID) continue; // no mostrar nuestro propio AP
        const prev = found.get(ssid);
        if (!prev || signal > prev.signal) found.set(ssid, { ssid, signal, security: security || 'open' });
      }
    } catch (e) {
      rawDumps.push(`--- ${label} ---\nERROR: ${e.message}`);
      console.error(`[wifi] scanNetworks (${label}) error:`, e.message);
    }
  }

  // Pasada 1: sin --rescan — caché de NetworkManager, casi instantánea.
  collect('caché (sin --rescan)', `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname ${AP_IFACE}`, 4000);
  // Pasada 2: --rescan yes — fuerza un escaneo nuevo (puede tardar ~5s).
  collect('forzado (--rescan yes)', `nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname ${AP_IFACE} --rescan yes`, 12000);

  const networks = Array.from(found.values());
  networks.sort((a, b) => b.signal - a.signal);
  console.log(`[wifi] scan → ${networks.length} redes`);
  networks._raw = rawDumps.join('\n\n'); // no enumerable en JSON.stringify normal — se agrega a mano en la respuesta HTTP (ver /wifi/scan)
  return networks;
}

// ─── Iniciar AP hotspot ───────────────────────────────────────────────────────
let _apUp = false; // edge-trigger para el sonido de "AP activado" — solo una vez por activación real, no en cada tick del monitor
async function startAP() {
  if (!nmcliAvailable()) {
    console.warn('[wifi] nmcli no disponible — no se puede activar AP');
    return { ok: false, error: 'nmcli no disponible' };
  }

  console.log(`[wifi] Activando AP "${AP_SSID}"…`);

  // Borrar conexión previa con el mismo nombre si existe
  run(`nmcli connection delete "${AP_SSID}" 2>/dev/null || true`, 5000);

  return new Promise((resolve) => {
    const cmd = `nmcli device wifi hotspot ifname ${AP_IFACE} ssid "${AP_SSID}" password "${AP_PASS}"`;
    exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim();
      if (err && !out.toLowerCase().includes('successfully')) {
        console.error('[wifi] startAP error:', out);
        _logDebug(`AP "${AP_SSID}" FALLÓ al activar — ${out.slice(0, 300)}`);
        resolve({ ok: false, error: out });
      } else {
        console.log(`[wifi] AP "${AP_SSID}" activo — IP: ${AP_IP}  pass: ${AP_PASS}`);
        _logDebug(`AP "${AP_SSID}" activo — IP: ${AP_IP}`);
        if (!_apUp) {
          _apUp = true;
          try { require('./sound-effects').playApReadySound(); } catch (e) { console.warn('[wifi] playApReadySound:', e.message); }
        }
        resolve({ ok: true, ssid: AP_SSID, ip: AP_IP });
      }
    });
  });
}

// ─── Cambiar el nombre (SSID) del AP ──────────────────────────────────────────
// Pedido explícito: antes AP_SSID era fijo al arrancar (env var u hostname),
// solo cambiable editando .env por SSH y reiniciando. Ahora es editable desde
// /configuracion (ver POST /setup/config → apSsid en server.js), sin
// reiniciar el proceso.
//
// A propósito NO reactiva el AP al toque aunque ya esté activo con el
// nombre viejo — antes lo hacía, y le pasó de verdad a una usuaria: sin
// WiFi real configurado, la ÚNICA forma de llegar a /configuracion es
// estando conectada a ese mismo AP, así que reiniciarlo acá le borraba la
// red a la que estaba conectada A MITAD de la operación, sin aviso previo
// y sin tiempo de ver el nombre nuevo para reconectarse — quedaba "afuera"
// del dispositivo. Ahora el cambio se PERSISTE nomás; se aplica solo la
// próxima vez que Brumexa levante el AP de verdad (reinicio del
// dispositivo, o la próxima caída de WiFi real) — nunca corta la sesión
// actual de quien está configurando.
// newBase es el nombre "limpio" (lo que escribió la persona, o el hostname
// si vino vacío desde /configuracion) — acá se le agrega el sufijo "_AP".
async function setApSsid(newBase) {
  const trimmed = (newBase || '').trim();
  if (!trimmed) return { ok: false, error: 'El nombre del AP no puede estar vacío' };
  // 29, no 32: el sufijo "_AP" (3 caracteres) se suma después — el límite
  // real de WiFi (32) aplica sobre el resultado final, no sobre lo tipeado.
  if (trimmed.length > 29) return { ok: false, error: 'Máximo 29 caracteres (se le agrega el sufijo "_AP", el límite de WiFi son 32 en total)' };

  const newSsid = `${trimmed}_AP`;
  if (newSsid === AP_SSID) return { ok: true, ssid: AP_SSID, base: AP_BASE, deferredWhileApActive: false };

  const wasActive = getStatus().apActive;
  const oldSsid   = AP_SSID;
  AP_BASE = trimmed;
  AP_SSID = newSsid;
  _logDebug(`SSID del AP cambiado (persistido): "${oldSsid}" → "${AP_SSID}"${wasActive ? ' — AP activo, no se reinicia solo (se aplica en la próxima activación)' : ''}`);

  return { ok: true, ssid: AP_SSID, base: AP_BASE, deferredWhileApActive: wasActive };
}

// ─── Detener AP ───────────────────────────────────────────────────────────────
function stopAP() {
  if (!nmcliAvailable()) return { ok: false, error: 'nmcli no disponible' };
  try {
    run(`nmcli connection delete "${AP_SSID}"`, 8000);
    console.log(`[wifi] AP "${AP_SSID}" detenido`);
    _apUp = false;
    return { ok: true };
  } catch (e) {
    console.warn('[wifi] stopAP:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── Conectar a WiFi del cliente ──────────────────────────────────────────────
// El radio wlan0 es de un solo modo: no puede ser hotspot (AP) y cliente de
// otra red a la vez. Por eso hay que apagar el AP ANTES de intentar conectar
// — si no, nmcli intenta asociar con el radio ocupado sirviendo "Brumexa-Setup"
// y el intento falla siempre, dejando el AP encendido en loop infinito.
async function connectToWifi(ssid, password) {
  if (!nmcliAvailable()) {
    _connectState = { status: 'error', ssid, ip: null, error: 'nmcli no disponible', startedAt: Date.now() };
    return;
  }

  _connectState = { status: 'connecting', ssid, ip: null, error: null, startedAt: Date.now() };
  console.log(`[wifi] Conectando a "${ssid}"…`);
  _logDebug(`Intentando conectar a SSID="${ssid}" ${_maskPassword(password)}`);

  // Liberar el radio: apagar el AP y esperar a que el driver termine la transición
  stopAP();
  await new Promise(r => setTimeout(r, 1500));

  // Borrar conexión guardada previa con el mismo SSID para evitar conflictos
  run(`nmcli connection delete "${ssid}" 2>/dev/null || true`, 4000);

  const passArg = password ? `password "${password}"` : '';
  const cmd     = `nmcli device wifi connect "${ssid}" ${passArg} ifname ${AP_IFACE}`;

  exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    const out = (stdout + stderr).toLowerCase().trim();
    console.log(`[wifi] connect result: ${out.slice(0, 200)}`);

    if (!err && (out.includes('successfully') || out.includes('activated'))) {
      // Leer IP asignada
      const ip = run(`nmcli -t -f IP4.ADDRESS device show ${AP_IFACE}`, 3000)
        .split('\n')
        .find(l => l.startsWith('IP4.ADDRESS'))
        ?.split(':')[1]?.split('/')[0]?.trim() || null;

      console.log(`[wifi] ✔ Conectado a "${ssid}" — IP: ${ip}`);
      _logDebug(`✔ Conectado a SSID="${ssid}" — IP: ${ip}`);
      _connectState = { status: 'connected', ssid, ip, error: null, startedAt: _connectState.startedAt };

    } else {
      const errMsg = out.split('\n').find(l => l.trim()) || 'No se pudo conectar';
      console.error(`[wifi] ✘ Error conectando a "${ssid}": ${errMsg} — reactivando AP de provisioning`);
      _logDebug(`✘ Falló conexión a SSID="${ssid}" — ${errMsg} — reactivando AP`);
      _connectState = { status: 'error', ssid, ip: null, error: errMsg, startedAt: _connectState.startedAt };

      // No dejar al usuario sin forma de reintentar: volver a levantar el AP
      startAP();
    }
  });
}

// ─── Auto-inicio: activar AP si no hay WiFi al arrancar ──────────────────────
async function autoStartAP() {
  if (process.platform !== 'linux') return;
  if (!nmcliAvailable()) {
    console.warn('[wifi] nmcli no disponible — omitiendo auto-AP');
    return;
  }

  // Esperar 3s a que NetworkManager termine de arrancar
  await new Promise(r => setTimeout(r, 3000));

  // Async (no getStatus síncrona) — a esta altura del boot, NetworkManager
  // puede seguir asentándose y los nmcli tardar bastante más de lo normal;
  // visto en logs reales: 1-1.5s de bloqueo del event loop entero (Node no
  // puede tickear NADA, ni la respiración de los LEDs) justo acá, en el
  // arranque, con root incluido (no era un tema de permisos).
  const status = await getStatusAsync();
  console.log(`[wifi] autoStartAP — connectedSSID: ${status.connectedSSID}  ip: ${status.ipAddress}  apActive: ${status.apActive}`);
  _logDebug(`Boot — connectedSSID=${status.connectedSSID || '(ninguno)'} ip=${status.ipAddress || '(ninguna)'} apActive=${status.apActive} signal=${status.signal ?? 'n/a'}`);

  // Chequeamos ipAddress, no solo connectedSSID: NetworkManager reporta
  // GENERAL.CONNECTION con el nombre del perfil desde que EMPIEZA a intentar
  // activarlo, no recién cuando lo logra — si quedó reintentando solo un
  // perfil guardado inalcanzable (típico al mover el dispositivo de lugar),
  // connectedSSID puede aparecer con valor sin que haya conexión real,
  // haciendo que este chequeo crea "ya hay WiFi" y nunca levante el AP.
  // ipAddress solo se completa con una conexión de verdad.
  if (!status.ipAddress && !status.apActive) {
    // Soltamos cualquier intento de NetworkManager en curso (activating un
    // perfil viejo mantiene el radio ocupado y puede hacer fallar el
    // hotspot) ANTES de pedirlo — así no dependemos de que el chequeo de
    // arriba gane o pierda la carrera contra el autoconnect de NM.
    await runAsync(`nmcli device disconnect ${AP_IFACE}`, 5000);
    console.log('[wifi] Sin WiFi real → activando AP de provisioning…');
    await startAP();
  } else if (status.ipAddress) {
    console.log(`[wifi] WiFi ya configurado: "${status.connectedSSID}" — AP no necesario`);
  }
}

// ─── Monitor continuo — corre cada HEALTH_CHECK_INTERVAL_MS, actualiza LEDs ──
// A diferencia de autoStartAP() (chequeo único al boot), esto detecta caídas
// de señal o desconexiones que pasan DESPUÉS de que el server ya arrancó.
let _lastLoggedHealth = null; // evita spamear el log cada 15s — solo loguea transiciones
let _disconnectedSince = null; // timestamp de cuándo empezó la desconexión actual
let _lastKnownSSID = null; // última red a la que nos conectamos con éxito — para reintentos automáticos
let _lastBackgroundRecoveryAttempt = 0; // throttle de los reintentos mientras estamos en AP
let _consecutiveDisconnectTicks = 0; // margen de gracia antes de pasar a rojo fijo (ver _checkHealthOnce)

let _healthCheckRunning = false; // evita solaparse con un reintento de reconexión todavía en curso

async function _checkHealth() {
  if (_healthCheckRunning) return; // el tick anterior sigue esperando un nmcli (puede tardar hasta 15s)
  _healthCheckRunning = true;
  try {
    await _checkHealthOnce();
  } finally {
    _healthCheckRunning = false;
  }
}

async function _checkHealthOnce() {
  const leds   = require('./leds');
  const status = await getStatusAsync();

  let health;
  // !status.ipAddress además de !status.connectedSSID — MISMO chequeo que ya
  // usa autoStartAP() (ver comentario ahí) y por la misma razón: nmcli
  // reporta GENERAL.CONNECTION con el nombre de un perfil guardado desde que
  // EMPIEZA a intentar activarlo, no recién cuando lo logra. Sin este
  // chequeo, si te movés de lugar y NetworkManager queda "activating" un
  // perfil guardado que ya no está en rango, connectedSSID sigue no-nulo
  // aunque no haya conexión real — este monitor (a diferencia de
  // autoStartAP, que solo corre una vez al boot) nunca entraba a la rama de
  // "desconectado" y el AP de emergencia nunca se llegaba a levantar
  // después de una caída en caliente.
  if (!status.connectedSSID || !status.ipAddress) {
    if (status.apActive) {
      // AP de aprovisionamiento activo a propósito (esperando que alguien
      // entre a /setup) — es el comportamiento esperado, NO un error: las
      // LEDs vuelven a la respiración normal en vez de quedar en rojo.
      health = 'ap';
      leds.setNetworkHealth('ap');
      _consecutiveDisconnectTicks = 0;
    } else {
      // Sin red y sin AP todavía. Margen de gracia: un solo tick fallido
      // (ventana breve entre soltar una red y asociar la siguiente) muestra
      // el cometa cian de "intentando" (leds.connecting()) en vez de saltar
      // directo a rojo fijo — recién al segundo tick consecutivo (30s, dentro
      // del margen de DISCONNECT_AP_RECOVERY_MS de abajo) se lo considera una
      // caída real.
      _consecutiveDisconnectTicks++;
      if (_consecutiveDisconnectTicks >= 2) {
        health = 'disconnected';
        leds.setNetworkHealth('disconnected');
      } else {
        health = 'connecting';
        leds.connecting();
      }
    }

    if (!_disconnectedSince) _disconnectedSince = Date.now();
    const disconnectedForMs = Date.now() - _disconnectedSince;

    if (_connectState.status === 'connecting') {
      // Ya hay una conexión en curso (disparada desde /wifi/connect) — no
      // interferir.
    } else if (!status.apActive && disconnectedForMs >= DISCONNECT_AP_RECOVERY_MS) {
      // Perdimos la conexión en caliente (no fue un boot) y ya pasó el margen
      // de gracia. Antes de resignarnos al AP, un último intento directo
      // contra el perfil guardado — NetworkManager ya reintenta solo, pero
      // por si su autoconnect está desactivado o tardando más de la cuenta.
      if (await _tryReconnectSaved(_lastKnownSSID)) {
        console.log(`[wifi] ✔ Reconectado a "${_lastKnownSSID}" antes de pasar a AP`);
        _logDebug(`Reconectado a "${_lastKnownSSID}" en el intento previo al AP`);
      } else {
        console.log(`[wifi] Sin conexión hace ${Math.round(disconnectedForMs / 1000)}s → reactivando AP de provisioning…`);
        _logDebug(`Conexión perdida en caliente (${Math.round(disconnectedForMs / 1000)}s sin red) → reactivando AP`);
        await startAP();
      }
    } else if (status.apActive && _lastKnownSSID && (Date.now() - _lastBackgroundRecoveryAttempt) >= BACKGROUND_RECOVERY_MS) {
      // Ya estamos resignados al AP y nadie entró a /setup a reconfigurar.
      // Cada BACKGROUND_RECOVERY_MS probamos en el fondo si la red de siempre
      // volvió, para reconectarnos solos sin depender de que alguien entre
      // manualmente. Implica bajar el AP un momento (el radio es de un solo
      // modo) — si en ese momento alguien está conectado configurando algo
      // en /setup, se lo interrumpe; por eso el intervalo es de minutos, no
      // segundos.
      _lastBackgroundRecoveryAttempt = Date.now();
      console.log(`[wifi] AP activo — probando en el fondo si "${_lastKnownSSID}" volvió…`);
      stopAP();
      if (await _tryReconnectSaved(_lastKnownSSID)) {
        console.log(`[wifi] ✔ "${_lastKnownSSID}" volvió — reconectado, AP apagado`);
        _logDebug(`Reconexión de fondo: "${_lastKnownSSID}" disponible de nuevo, AP apagado`);
      } else {
        console.log(`[wifi] "${_lastKnownSSID}" sigue sin estar — reactivando AP`);
        await startAP();
      }
    }
  } else if (status.signal !== null && status.signal < SIGNAL_WEAK_THRESHOLD) {
    console.log(`[wifi] señal débil: ${status.signal}% (umbral ${SIGNAL_WEAK_THRESHOLD}%)`);
    health = 'weak';
    leds.setNetworkHealth('weak');
    _consecutiveDisconnectTicks = 0;
  } else {
    health = 'ok';
    leds.setNetworkHealth('ok');
    _consecutiveDisconnectTicks = 0;
  }

  // Misma condición que arriba (connectedSSID Y ipAddress, no uno solo) — si
  // no, esto pisaba _disconnectedSince a null en CADA tick mientras
  // NetworkManager seguía "activating" un perfil inalcanzable (connectedSSID
  // no-nulo, ipAddress vacío), y el contador de disconnectedForMs de arriba
  // nunca llegaba a acumular los DISCONNECT_AP_RECOVERY_MS necesarios para
  // levantar el AP — el fix de la condición de arriba solo, sin este, no
  // alcanzaba.
  if (status.connectedSSID && status.ipAddress) {
    _disconnectedSince = null;
    _lastKnownSSID = status.connectedSSID;
  }

  if (health !== _lastLoggedHealth) {
    _logDebug(`Salud de red: ${_lastLoggedHealth ?? '(inicial)'} → ${health} — SSID=${status.connectedSSID || '(ninguno)'} signal=${status.signal ?? 'n/a'}%`);
    _lastLoggedHealth = health;
  }
}

function startHealthMonitor() {
  if (process.platform !== 'linux') return;
  const timer = setInterval(_checkHealth, HEALTH_CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[wifi] Monitor de señal activo — cada ${HEALTH_CHECK_INTERVAL_MS / 1000}s, umbral débil ${SIGNAL_WEAK_THRESHOLD}%`);
}

// ─── Registrar rutas Express ──────────────────────────────────────────────────
function setupWifi(app) {
  const jsonBody = require('express').json();

  // Redirigir captive portal — Android, iOS, Windows abren el setup automáticamente
  const portalPaths = [
    '/generate_204',
    '/hotspot-detect.html',
    '/ncsi.txt',
    '/connectivity-check.html',
    '/canonical.html',
    '/success.txt',
  ];
  app.get(portalPaths, (_req, res) => {
    res.redirect(`http://${AP_IP}:${process.env.PORT || 3000}/setup`);
  });

  // GET /setup — sirve la página de configuración WiFi
  app.get('/setup', (_req, res) => {
    const path = require('path');
    res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
  });

  // GET /wifi/status
  app.get('/wifi/status', (_req, res) => {
    res.json({ ...getStatus(), apSsid: AP_SSID, apIp: AP_IP });
  });

  // GET /wifi/scan — raw: salida cruda de los dos "nmcli device wifi list"
  // (caché + forzado) que arma la lista de abajo, para poder diagnosticar
  // "¿por qué no aparece tal red?" desde la propia UI sin ir a Terminal/SSH.
  app.get('/wifi/scan', (_req, res) => {
    const networks = scanNetworks();
    const raw      = networks._raw;
    res.json({ ok: true, networks, raw });
  });

  // POST /wifi/ap/start
  app.post('/wifi/ap/start', jsonBody, async (_req, res) => {
    const result = await startAP();
    res.json(result);
  });

  // POST /wifi/ap/stop
  app.post('/wifi/ap/stop', (_req, res) => {
    res.json(stopAP());
  });

  // POST /wifi/connect  { ssid, password }
  app.post('/wifi/connect', jsonBody, (req, res) => {
    const body     = req.body || {};
    const { ssid } = body;
    const password = body.password || '';

    if (!ssid || typeof ssid !== 'string' || ssid.length > 64) {
      return res.status(400).json({ ok: false, error: 'SSID inválido' });
    }
    if (password.length > 64) {
      return res.status(400).json({ ok: false, error: 'Contraseña demasiado larga' });
    }

    // Respondemos ANTES de arrancar connectToWifi — esta arranca con un
    // stopAP() síncrono/bloqueante (execSync) que apaga el propio AP al que
    // está conectado quien hizo este POST. Si lo llamamos directo acá, el
    // radio se apaga en medio de la respuesta HTTP y el cliente nunca la
    // recibe (parece que "no pasó nada"). setImmediate() le da a Node un
    // tick para terminar de mandar la respuesta por el socket ANTES de que
    // el bloqueo síncrono corte el AP.
    res.json({ ok: true, message: 'Conectando…' });
    setImmediate(() => connectToWifi(ssid.trim(), password));
  });

  // GET /wifi/connect/status
  app.get('/wifi/connect/status', (_req, res) => {
    res.json(_connectState);
  });

  // GET /wifi/debug-log — historial persistente (sobrevive reinicios)
  app.get('/wifi/debug-log', (_req, res) => {
    try {
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '(sin registros todavía)';
      res.type('text/plain').send(content);
    } catch (e) {
      res.status(500).type('text/plain').send(`Error leyendo el log: ${e.message}`);
    }
  });

  console.log('[wifi] Endpoints OK — /setup  /wifi/status  /wifi/scan  /wifi/connect  /wifi/debug-log');
}

module.exports = { setupWifi, autoStartAP, getStatus, getStatusAsync, startAP, stopAP, setApSsid, startHealthMonitor };
