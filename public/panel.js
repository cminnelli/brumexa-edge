'use strict';

// Tarjeta grande del Panel: lee GET /panel/status cada 3 s y la pinta.
// Solo muestra — no conecta ni cambia nada.
(function () {
  const hero = document.getElementById('hero');
  if (!hero) return;
  const $ = (id) => document.getElementById(id);

  const STATES = {
    ready:       { title: 'Lista para charlar', sub: 'Decí "Ei, Brumexa" para empezar.' },
    talking:     { title: 'Charlando',          sub: 'Brumexa está en una conversación.' },
    'weak-wifi': { title: 'Lista, con Wi-Fi débil', sub: 'Puede tardar un poco más en responder.' },
    'no-server': { title: 'Sin servidor',       sub: 'Hay Wi-Fi, pero no llega a la nube de Brumexa. Se reconecta sola.' },
    'no-wifi':   { title: 'Sin Wi-Fi',          sub: 'Revisá la red en Configuración.' },
  };

  function ago(iso) {
    if (!iso) return null;
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'recién';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return `hace ${Math.round(s / 86400)} d`;
  }
  function uptime(s) {
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} d`;
  }
  // Color de la tira a brillo pleno (la tira respira; el orbe ya respira solo).
  function orbColor(led) {
    if (!led) return null;
    const m = Math.max(led.r, led.g, led.b);
    if (m < 8) return null;
    const k = 255 / m;
    return [led.r, led.g, led.b].map(c => Math.round(c * k)).join(', ');
  }
  function tile(id, dot, val, sub) {
    $(`${id}-dot`).className = `tile__dot ${dot || ''}`;
    $(`${id}-val`).textContent = val;
    $(`${id}-sub`).textContent = sub || '';
  }

  async function refresh() {
    let st;
    try { st = await (await fetch('/panel/status', { cache: 'no-store' })).json(); }
    catch { return; }

    const s = STATES[st.state] || STATES.ready;
    hero.dataset.state = st.state;
    $('hero-title').textContent = s.title;
    $('hero-sub').textContent = s.sub;
    const c = orbColor(st.led);
    if (c) hero.style.setProperty('--orb', c);

    const w = st.wifi;
    if (!w || !w.ssid) tile('t-wifi', 'bad', 'Sin red', '');
    else tile('t-wifi', w.health === 'weak' ? 'warn' : 'ok', w.ssid, w.signal != null ? `Señal ${w.signal}%` : '');

    tile('t-server', st.serverUp ? 'ok' : 'bad', st.serverUp ? 'Conectado' : 'Sin conexión', 'Nube de Brumexa');

    tile('t-talk', st.state === 'talking' ? 'ok' : '', st.state === 'talking' ? 'Ahora' : (ago(st.lastConversationAt) || 'Todavía no'),
      st.uptimeS != null ? `Encendida hace ${uptime(st.uptimeS)}` : '');

    const ch = st.branch === 'main' ? 'Estable' : st.branch === 'dev' ? 'Pruebas' : (st.branch || '');
    tile('t-ver', st.branch === 'main' ? 'ok' : 'warn', (st.version || '—').slice(0, 7), ch);
  }

  refresh();
  setInterval(refresh, 3000);
})();
