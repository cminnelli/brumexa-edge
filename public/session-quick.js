'use strict';

// Botón de conectar/detener rápido en el navbar — mismo POST /session/start
// y /session/stop que ya usa el botón grande del Panel (ver PiNativeModule
// en app.js), para poder arrancar o cortar una sesión de voz desde
// cualquier página sin tener que ir a "/" primero. Sin micDevice/
// speakerDevice en el body: el server ya cae solo al dispositivo guardado
// en .env (ver /session/start en server.js) — es EXACTAMENTE lo que
// necesita un atajo "rápido", no un formulario.
//
// Compartido por index.html/configuracion.html/diagnostico.html/logs.html/
// terminal.html (mismo <script src="session-quick.js">) — si el botón no
// existe en la página (no debería pasar, pero por si acaso) no hace nada.
(function () {
  const btn = document.getElementById('nav-session-btn');
  if (!btn) return;

  function render(status) {
    if (status === 'connecting') {
      btn.textContent = '… Conectando';
      btn.classList.remove('btn-ghost--accent');
      btn.disabled = true;
    } else if (status === 'connected') {
      btn.textContent = '■ Detener';
      btn.classList.add('btn-ghost--accent');
      btn.disabled = false;
    } else {
      btn.textContent = '▶ Conectar';
      btn.classList.remove('btn-ghost--accent');
      btn.disabled = false;
    }
  }

  async function refresh() {
    try {
      const s = await fetch('/session/status', { cache: 'no-store' }).then(r => r.json());
      // No pisar el estado mientras el propio click de este botón ya puso
      // "Conectando" a mano — este poll (cada 5s) es para enterarse de
      // sesiones arrancadas/cortadas desde OTRO lado (el botón grande del
      // Panel, u otra pestaña), no para competir con el propio click.
      if (!btn.dataset.pending) render(s.status);
    } catch { /* server no disponible en este instante — no romper el botón */ }
  }

  btn.addEventListener('click', async () => {
    const stopping = btn.textContent.includes('Detener');
    btn.dataset.pending = '1';
    btn.disabled = true;
    try {
      if (stopping) {
        await fetch('/session/stop', { method: 'POST' });
        render('idle');
      } else {
        render('connecting');
        const res = await fetch('/session/start', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    '{}',
        }).then(r => r.json());
        if (!res.ok) throw new Error(res.error || 'No se pudo conectar');
        render('connected');
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
      render('idle');
    }
    delete btn.dataset.pending;
  });

  refresh();
  setInterval(refresh, 5000);
})();
