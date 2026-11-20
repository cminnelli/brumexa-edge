'use strict';

// Pantalla "Actualizando Brumexa" — se monta sola en todas las páginas (la
// carga nav.js). Mientras se instala una versión nueva (pedida desde el admin
// o desde /configuracion) tapa la página y no deja tocar nada: al final el
// server se reinicia y cualquier cambio a medias se perdería. Muestra el paso
// real (GET /configuracion/update/status), sigue durante el reinicio y, cuando
// vuelve con la versión nueva, muestra "Lista" y recarga.
// Si hay una orden del admin esperando que termine la charla, muestra un
// aviso chico abajo.
(function () {
  if (window.__bxUpdateOverlay) return;
  window.__bxUpdateOverlay = true;

  const STEPS = {
    prepare:  { label: 'Preparando',                   pct: 4 },
    download: { label: 'Descargando la versión nueva', pct: 16 },
    verify:   { label: 'Verificando la descarga',      pct: 30 },
    install:  { label: 'Instalando componentes',       pct: 40 },
    switch:   { label: 'Cambiando a la versión nueva', pct: 88 },
    restart:  { label: 'Reiniciando',                  pct: 94 },
  };
  const ORDER = Object.keys(STEPS);
  const INSTALL_TO = 85;          // "instalando" es el paso largo: la barra avanza sola hasta acá
  const INSTALL_TAU_MS = 45000;

  let phase = 'idle';             // idle | running | restarting | done | failed
  let startVersion = null, info = {}, step = null, stepSince = 0, timer = null, root = null, pill = null;

  const css = `
  #bx-up{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;
    background:color-mix(in srgb,var(--bg,#f5f5f7) 58%,transparent);
    -webkit-backdrop-filter:blur(26px) saturate(170%);backdrop-filter:blur(26px) saturate(170%);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif;
    color:var(--text,#1d1d1f);animation:bxFade .35s ease both}
  #bx-up .card{width:min(400px,100%);box-sizing:border-box;padding:34px 30px 26px;border-radius:28px;text-align:center;
    background:color-mix(in srgb,var(--surface,#fff) 86%,transparent);
    border:1px solid color-mix(in srgb,var(--text,#000) 8%,transparent);
    box-shadow:0 30px 80px -20px rgba(0,0,0,.35),0 8px 24px -12px rgba(0,0,0,.2);animation:bxRise .5s cubic-bezier(.2,.8,.2,1) both}
  #bx-up .icon{width:76px;height:76px;margin:0 auto 20px;border-radius:22px;display:grid;place-items:center;position:relative;
    background:linear-gradient(145deg,var(--accent,#6d28d9),#2f7fe0);
    box-shadow:0 12px 28px -10px color-mix(in srgb,var(--accent,#6d28d9) 70%,transparent),inset 0 1px 0 rgba(255,255,255,.25)}
  #bx-up .leds{display:flex;gap:4px;padding:6px 7px;border-radius:99px;background:rgba(0,0,0,.22)}
  #bx-up .led{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.22);transition:background .5s,box-shadow .5s}
  #bx-up .led.on{background:#fff;box-shadow:0 0 6px 1px rgba(255,255,255,.75)}
  #bx-up .led.front{animation:bxBreath 1.4s ease-in-out infinite}
  #bx-up .check{display:none;width:40px;height:40px}
  #bx-up .check path{stroke-dasharray:30;stroke-dashoffset:30;animation:bxDraw .55s .1s ease forwards}
  #bx-up[data-phase="done"] .leds,#bx-up[data-phase="failed"] .leds{display:none}
  #bx-up[data-phase="done"] .check{display:block}
  #bx-up[data-phase="done"] .icon{background:linear-gradient(145deg,#34c759,#20a84a);box-shadow:0 12px 28px -10px rgba(52,199,89,.6)}
  #bx-up[data-phase="failed"] .icon{background:linear-gradient(145deg,#ff9f0a,#ff6b0a);box-shadow:0 12px 28px -10px rgba(255,159,10,.55)}
  #bx-up[data-phase="failed"] .icon::after{content:"!";color:#fff;font:700 34px/1 -apple-system,system-ui,sans-serif}
  #bx-up h2{margin:0;font-size:21px;font-weight:600;letter-spacing:-.02em}
  #bx-up .sub{margin:6px 0 0;font-size:13px;line-height:1.45;color:var(--muted,#86868b)}
  #bx-up .bar{height:5px;margin:24px 0 10px;border-radius:99px;overflow:hidden;background:color-mix(in srgb,var(--text,#000) 9%,transparent)}
  #bx-up .fill{height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,var(--accent,#6d28d9),#2f7fe0);transition:width .9s cubic-bezier(.4,0,.2,1)}
  #bx-up[data-phase="done"] .fill{background:#34c759}
  #bx-up[data-phase="failed"] .bar{display:none}
  #bx-up .step{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:var(--text,#1d1d1f)}
  #bx-up .step span:last-child{color:var(--muted,#86868b);font-variant-numeric:tabular-nums}
  #bx-up .note{margin:20px 0 0;padding-top:16px;border-top:1px solid color-mix(in srgb,var(--text,#000) 7%,transparent);font-size:12px;color:var(--muted,#86868b)}
  #bx-up .btn{display:none;margin:20px auto 0;padding:9px 22px;border:0;border-radius:99px;cursor:pointer;
    background:var(--accent,#6d28d9);color:#fff;font:600 13px/1 -apple-system,system-ui,sans-serif}
  #bx-up .btn:focus-visible{outline:3px solid color-mix(in srgb,var(--accent,#6d28d9) 40%,transparent);outline-offset:2px}
  #bx-up[data-phase="failed"] .btn{display:inline-block}
  #bx-up .cancel{display:none;margin:16px auto 0;padding:8px 18px;border-radius:99px;cursor:pointer;background:transparent;
    border:1px solid color-mix(in srgb,var(--text,#000) 14%,transparent);color:var(--text,#1d1d1f);font:500 13px/1 -apple-system,system-ui,sans-serif;transition:background .2s}
  #bx-up .cancel:hover:not(:disabled){background:color-mix(in srgb,var(--text,#000) 6%,transparent)}
  #bx-up .cancel:disabled{opacity:.5;cursor:default}
  #bx-up .cancel:focus-visible{outline:3px solid color-mix(in srgb,var(--accent,#6d28d9) 40%,transparent);outline-offset:2px}
  #bx-up[data-cancel="1"] .cancel{display:inline-block}
  #bx-up[data-phase="cancelled"] .icon{background:linear-gradient(145deg,#8e8e93,#636366);box-shadow:0 12px 28px -10px rgba(99,99,102,.5)}
  #bx-up[data-phase="cancelled"] .leds,#bx-up[data-phase="cancelled"] .bar,#bx-up[data-phase="cancelled"] .step{display:none}
  #bx-up[data-phase="cancelled"] .icon::after{content:"";width:22px;height:3px;border-radius:2px;background:#fff}
  #bx-up[data-phase="done"] .step,#bx-up[data-phase="failed"] .step{display:none}
  #bx-pill{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147482999;
    display:flex;align-items:center;gap:9px;max-width:calc(100% - 32px);padding:10px 16px;border-radius:99px;
    background:color-mix(in srgb,var(--surface,#fff) 82%,transparent);-webkit-backdrop-filter:blur(18px) saturate(170%);backdrop-filter:blur(18px) saturate(170%);
    border:1px solid color-mix(in srgb,var(--text,#000) 9%,transparent);box-shadow:0 10px 30px -12px rgba(0,0,0,.3);
    font:500 12.5px/1.3 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;color:var(--text,#1d1d1f);animation:bxRise .4s ease both}
  #bx-pill i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--accent,#6d28d9);animation:bxBreath 1.6s ease-in-out infinite}
  @keyframes bxFade{from{opacity:0}to{opacity:1}}
  @keyframes bxRise{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
  #bx-pill{animation-name:bxFade}
  @keyframes bxBreath{0%,100%{opacity:.35}50%{opacity:1}}
  @keyframes bxDraw{to{stroke-dashoffset:0}}
  @media (prefers-reduced-motion:reduce){#bx-up,#bx-up *,#bx-pill,#bx-pill *{animation:none!important;transition:none!important}#bx-up .check path{stroke-dashoffset:0}}`;

  function el(tag, attrs, html) {
    const e = document.createElement(tag);
    Object.assign(e, attrs || {});
    if (html != null) e.innerHTML = html;
    return e;
  }

  function mount() {
    if (root) return;
    document.head.appendChild(el('style', { id: 'bx-up-css', textContent: css }));
    root = el('div', { id: 'bx-up' });
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'bx-up-title');
    root.innerHTML = `
      <div class="card">
        <div class="icon">
          <div class="leds">${'<span class="led"></span>'.repeat(8)}</div>
          <svg class="check" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </div>
        <h2 id="bx-up-title">Actualizando Brumexa</h2>
        <p class="sub"></p>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div>
        <div class="step" aria-live="polite"><span></span><span></span></div>
        <p class="note">No la desenchufes. Tarda alrededor de un minuto y vuelve sola.</p>
        <button type="button" class="cancel">Cancelar</button>
        <button type="button" class="btn">Entendido</button>
      </div>`;
    root.querySelector('.btn').addEventListener('click', unmount);
    root.querySelector('.cancel').addEventListener('click', cancel);
    document.body.appendChild(root);
    for (const c of document.body.children) if (c !== root && c.id !== 'bx-pill') c.inert = true;
    document.documentElement.style.overflow = 'hidden';
  }

  function unmount() {
    if (!root) return;
    root.remove();
    root = null;
    for (const c of document.body.children) c.inert = false;
    document.documentElement.style.overflow = '';
    phase = 'idle';
    startVersion = null;
  }

  const short = (h) => (h ? String(h).slice(0, 7) : '');

  function render(pct, stepText, stepCount) {
    mount();
    root.dataset.phase = phase;
    const title = phase === 'done' ? 'Lista' : phase === 'failed' ? 'No se pudo actualizar'
      : phase === 'cancelled' ? 'Actualización cancelada' : 'Actualizando Brumexa';
    root.querySelector('h2').textContent = title;
    const v = short(info.newVersion || info.target);
    const channel = info.branch === 'dev' ? 'canal Pruebas' : 'canal Estable';
    const who = info.source === 'admin' ? 'pedida desde el panel de administración' : 'pedida desde esta Brumexa';
    root.querySelector('.sub').textContent =
      phase === 'done' ? `Ya tiene la versión ${short(info.doneVersion)}. Recargando…`
      : phase === 'failed' ? (info.error || 'Algo falló durante la instalación.')
      : phase === 'cancelled' ? 'No se instaló nada.'
      : `${v ? 'Versión ' + v : 'Última versión'} · ${channel} · ${who}`;
    root.querySelector('.note').textContent = phase === 'failed'
      ? 'Sigue funcionando con la versión que tenía. Podés volver a intentarlo.'
      : phase === 'cancelled' ? 'Sigue funcionando con la versión que tenía.'
      : phase === 'done' ? 'Todo listo.' : 'No la desenchufes. Tarda alrededor de un minuto y vuelve sola.';
    // Cancelar: solo mientras se puede (antes del cambio de carpetas).
    const canCancel = phase === 'running' && (info.cancellable || info.cancelling);
    root.dataset.cancel = canCancel ? '1' : '0';
    const cb = root.querySelector('.cancel');
    cb.disabled = !!info.cancelling;
    cb.textContent = info.cancelling ? 'Cancelando…' : 'Cancelar';
    root.querySelector('.fill').style.width = pct + '%';
    root.querySelector('.bar').setAttribute('aria-valuenow', String(Math.round(pct)));
    const [a, b] = root.querySelectorAll('.step span');
    a.textContent = stepText || '';
    b.textContent = stepCount || '';
    const lit = Math.min(8, Math.floor((pct / 100) * 8));
    root.querySelectorAll('.led').forEach((led, i) => {
      led.classList.toggle('on', i < lit);
      led.classList.toggle('front', i === lit && phase !== 'done');
    });
  }

  function progressPct() {
    const s = STEPS[step] || STEPS.prepare;
    if (step === 'install') {
      const k = 1 - Math.exp(-(Date.now() - stepSince) / INSTALL_TAU_MS);
      return s.pct + (INSTALL_TO - s.pct) * k;
    }
    return s.pct;
  }

  function showRunning() {
    const i = ORDER.indexOf(step);
    render(progressPct(), (STEPS[step] || STEPS.prepare).label + '…', i >= 0 ? `Paso ${i + 1} de ${ORDER.length}` : '');
  }

  function setPill(pending) {
    if (pending && !root) {
      if (!pill) {
        pill = el('div', { id: 'bx-pill' }, '<i></i><span>Hay una actualización lista: se instala cuando termine la charla.</span>');
        pill.setAttribute('role', 'status');
        if (!document.getElementById('bx-up-css')) document.head.appendChild(el('style', { id: 'bx-up-css', textContent: css }));
        document.body.appendChild(pill);
      }
    } else if (pill) { pill.remove(); pill = null; }
  }

  async function cancel() {
    info = { ...info, cancelling: true };
    showRunning();
    try {
      const r = await fetch('/configuracion/update/cancel', { method: 'POST' });
      if (!r.ok) info = { ...info, cancelling: false, cancellable: false };   // ya estaba terminando
    } catch { info = { ...info, cancelling: false }; }
    showRunning();
    poll();
  }

  async function poll() {
    let s = null;
    try {
      const r = await fetch('/configuracion/update/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (r.ok) s = await r.json();
    } catch { /* server reiniciándose o sin red */ }

    if (!s) {
      if (phase === 'running' || phase === 'restarting') { phase = 'restarting'; step = 'restart'; showRunning(); }
      return schedule();
    }
    setPill(s.pending);

    if (s.active) {
      if (phase !== 'running') { phase = 'running'; startVersion = startVersion || s.version; }
      if (s.step !== step) { step = s.step; stepSince = s.stepAt || Date.now(); }
      info = { ...info, ...s };
      showRunning();
    } else if (phase === 'running' || phase === 'restarting') {
      if (s.version && startVersion && s.version !== startVersion) {
        phase = 'done';
        info.doneVersion = s.version;
        render(100, '', '');
        setTimeout(() => location.reload(), 2400);
        return;
      }
      if (s.cancelled) {
        phase = 'cancelled';
        render(0, '', '');
        setTimeout(unmount, 2600);
        return;
      }
      if (s.failed) {
        phase = 'failed';
        info = { ...info, error: s.error };
        render(0, '', '');
        root.querySelector('.btn').focus();
        return;
      }
      if (phase === 'running') unmount();     // ya estaba al día: no había nada que instalar
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (phase === 'done' || phase === 'failed' || phase === 'cancelled') return;
    timer = setTimeout(poll, phase === 'running' || phase === 'restarting' ? 1000 : 4000);
  }

  // Si la pestaña estaba en segundo plano, mirar apenas vuelve.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && phase !== 'done' && phase !== 'failed' && phase !== 'cancelled') poll(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  else poll();
})();
