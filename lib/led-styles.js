// Estilos de luces para probar (2026-11-12, rama dev). Cada estilo dice cómo se
// ve cada estado de Brumexa; leds.js los anima. Cuando se elija uno, queda solo
// ese. Página oculta para probarlos: /luces.html.
//
// Cada estado es fn(t, i, d, x, c) → {r,g,b} para el LED i:
//   t  ms desde que arrancó el estado     d  distancia al centro (0 medio, 1 puntas)
//   x  posición 0..1 a lo largo de la tira (tira RECTA: lo que se mueve va y vuelve, nunca da la vuelta)
//   c  colores de la carcasa: c.base(v, dh) = color de marca con brillo v (corrido dh grados)
// Los de una pasada (wake, sleep) reciben p = 0..1 en vez de t y duran wakeMs / sleepMs.
// wait recibe además fade (1 → 0 a lo largo de "te espera").
'use strict';

const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const gauss = (x, mu, w) => Math.exp(-((x - mu) ** 2) / (2 * w * w));
// Pseudo-azar estable por LED (las chispas no se repiten igual en todos).
const rnd = (i, k) => { const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };
// Va y vuelve de 0 a 1 (para lo que se mueve a lo largo de la tira).
const pingPong = (t, periodMs) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / periodMs);

// Latido: dos golpes ("lub-dub") por ciclo, el segundo más chico.
const heartbeat = (phase) => gauss(phase, 0.08, 0.035) + 0.6 * gauss(phase, 0.24, 0.035);

const STYLES = {
  clasico: {
    label: 'Respira (el de hoy)',
    desc: 'Respiración pareja; al despertarse se abre desde el centro; piensa con una ola.',
    builtin: true,   // usa las animaciones de siempre de leds.js
  },

  latido: {
    label: 'Latido',
    desc: 'Dormida late lento como un corazón en reposo. Te escucha con un latido que viaja del centro a las puntas; piensa con el corazón más rápido y cambiando de tono.',
    idle: (t, i, d, x, c) => c.base(0.07 + 0.3 * heartbeat((t % 2200) / 2200) * (1 - 0.35 * d)),
    wakeMs: 650,
    wake: (p, i, d, x, c) => {
      const ring = gauss(d, p * 1.15, 0.16);                 // onda que sale del centro
      return c.base(clamp(0.15 + 0.6 * ease(p) + 0.45 * ring * (1 - p)));
    },
    listen: (t, i, d, x, c) => {
      const ph = ((t / 1600) - d * 0.25) % 1;                // el latido viaja hacia afuera
      return c.base(0.62 + 0.22 * heartbeat(ph < 0 ? ph + 1 : ph));
    },
    think: (t, i, d, x, c) => {
      const ph = ((t / 800) - d * 0.3) % 1;
      const b = heartbeat(ph < 0 ? ph + 1 : ph);
      return c.base(0.32 + 0.55 * b, -30 * b);              // al latir se va al índigo
    },
    wait: (t, i, d, x, c, fade) => {
      const period = 1500 + 1300 * (1 - fade);               // el corazón se va calmando
      return c.base((0.1 + 0.45 * fade) * (0.35 + 0.65 * heartbeat((t % period) / period)));
    },
    sleepMs: 1600,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * (1 - ease(clamp((p - (1 - d) * 0.35) / 0.65))) + 0.07 * p)),
  },

  aurora: {
    label: 'Aurora',
    desc: 'Colores que fluyen suave por la tira, como una aurora. Dormida apenas se mueve; te escucha brillante y calma; piensa con el color corriendo más rápido.',
    idle: (t, i, d, x, c) => c.base(0.09 + 0.12 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 0.7 - t / 6000))), 28 * Math.sin(2 * Math.PI * (x * 0.6 - t / 9000))),
    wakeMs: 800,
    wake: (p, i, d, x, c) => {
      const open = ease(clamp((p - d * 0.5) / 0.5));         // se despliega desde el centro
      return c.base(0.12 + 0.6 * open, 40 * (1 - p) * Math.sin(2 * Math.PI * x));
    },
    listen: (t, i, d, x, c) => c.base(0.6 + 0.15 * Math.sin(2 * Math.PI * (x * 0.8 - t / 3500)), 30 * Math.sin(2 * Math.PI * (x * 0.7 - t / 4500))),
    think: (t, i, d, x, c) => {
      const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 1.2 - t / 900));
      return c.base(0.3 + 0.5 * w, -45 + 70 * Math.sin(2 * Math.PI * (x * 0.5 - t / 1400)));
    },
    wait: (t, i, d, x, c, fade) => c.base((0.12 + 0.4 * fade) * (0.7 + 0.3 * Math.sin(2 * Math.PI * (x * 0.7 - t / (3000 + 4000 * (1 - fade))))), 25 * fade * Math.sin(2 * Math.PI * (x * 0.6 - t / 5000))),
    sleepMs: 1600,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * (1 - ease(clamp((p - (1 - d) * 0.4) / 0.6))) + 0.09 * p)),
  },

  mirada: {
    label: 'Mirada',
    desc: 'Un "ojo" de luz. Dormida es un punto chiquito que respira y parpadea; al despertarse el ojo se abre; te escucha mirando de frente y moviéndose apenas; piensa mirando de lado a lado.',
    idle: (t, i, d, x, c) => {
      const blink = (t % 7000) < 160 ? 0.25 : 1;             // parpadeo cada 7 s
      const v = (0.1 + 0.18 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 4200))) * blink;
      return c.base(v * gauss(i, 3.5, 0.75));
    },
    wakeMs: 700,
    wake: (p, i, d, x, c) => { const w = 0.6 + 1.9 * ease(p); return c.base(clamp((0.25 + 0.6 * ease(p)) * gauss(i, 3.5, w) + 0.06)); },
    listen: (t, i, d, x, c) => {
      const pos = 3.5 + 0.5 * Math.sin((2 * Math.PI * t) / 5000);   // mira apenas a los costados
      return c.base(clamp(0.85 * gauss(i, pos, 2.4) + 0.06));
    },
    think: (t, i, d, x, c) => {
      const pos = 0.6 + 5.8 * pingPong(t, 1700);             // recorre la tira y vuelve
      return c.base(clamp(0.8 * gauss(i, pos, 1.1) + 0.08), -25 * gauss(i, pos, 1.1));
    },
    wait: (t, i, d, x, c, fade) => c.base(clamp((0.2 + 0.55 * fade) * gauss(i, 3.5, 0.8 + 1.6 * fade) + 0.04)),   // el ojo se va cerrando
    sleepMs: 1200,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * gauss(i, 3.5, Math.max(0.35, 2.4 * (1 - ease(p))))  * (1 - 0.6 * p) + 0.04 * p)),
  },

  chispas: {
    label: 'Chispas',
    desc: 'Luciérnagas: cada LED titila a su ritmo. Dormida, pocas y suaves; al despertarse se encienden todas de golpe; te escucha con un brillo vivo y titilante; piensa con chispas que corren del centro a las puntas.',
    idle: (t, i, d, x, c) => {
      const per = 2600 + 2400 * rnd(i, 1);
      const ph = ((t + rnd(i, 2) * per) % per) / per;
      return c.base(0.04 + 0.32 * Math.pow(Math.max(0, Math.sin(Math.PI * ph)), 6), 20 * (rnd(i, 3) - 0.5));
    },
    wakeMs: 700,
    wake: (p, i, d, x, c) => c.base(clamp(0.7 * ease(p) + 0.5 * Math.max(0, Math.sin(Math.PI * clamp(p * 1.4 - rnd(i, 4) * 0.4))) * (1 - p))),
    listen: (t, i, d, x, c) => {
      const per = 900 + 900 * rnd(i, 5);
      const tw = Math.pow(0.5 + 0.5 * Math.sin((2 * Math.PI * (t + rnd(i, 6) * per)) / per), 3);
      return c.base(0.5 + 0.3 * tw, 15 * (rnd(i, 7) - 0.5));
    },
    think: (t, i, d, x, c) => {
      const ph = ((t / 700) - d) % 1;                        // chispa que sale del centro
      const s = Math.pow(Math.max(0, Math.cos(Math.PI * (ph < 0 ? ph + 1 : ph))), 8);
      return c.base(0.2 + 0.7 * s, -35 * s);
    },
    wait: (t, i, d, x, c, fade) => {
      const per = 1500 + 2500 * rnd(i, 8);
      const tw = Math.pow(Math.max(0, Math.sin((2 * Math.PI * (t + rnd(i, 9) * per)) / per)), 4);
      return c.base((0.06 + 0.4 * fade) * (0.3 + 0.7 * tw));
    },
    sleepMs: 1500,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * (1 - ease(clamp((p - rnd(i, 10) * 0.5) / 0.5))) + 0.04 * p)),
  },

  // ── Tecno (2026-11-12, segunda tanda) ─────────────────────────────────────

  neon: {
    label: 'Neón',
    desc: 'Un tubo de neón que respira. Dormida respira lento y cada tanto titila; al despertarse se enciende titilando como un neón; te escucha encendido con un zumbido sutil; piensa con una corriente eléctrica que va y vuelve.',
    idle: (t, i, d, x, c) => {
      const k = t % 9000;                                       // cada 9 s, un titileo corto
      const fl = k < 300 && rnd(Math.floor(k / 50), 11) > 0.5 ? 0.35 : 1;
      return c.base((0.08 + 0.22 * pingPong(t, 4800)) * fl);
    },
    wakeMs: 900,
    wake: (p, i, d, x, c) => {                                 // se enciende titilando y queda fijo
      if (p < 0.55) return c.base(rnd(Math.floor(p * 900 / 60), 12) > 0.45 ? 0.65 : 0.04);
      return c.base(0.45 + 0.25 * ease((p - 0.55) / 0.45));
    },
    listen: (t, i, d, x, c) => c.base(0.68 + 0.08 * pingPong(t, 3200) + 0.035 * Math.sin((2 * Math.PI * t) / 110)),
    think: (t, i, d, x, c) => {
      const pos = pingPong(t, 1100);
      const g = gauss(x, pos, 0.17);
      const zap = rnd(Math.floor(t / 70), i + 20) > 0.93 ? 0.25 : 0;   // chispazos sueltos
      return c.base(clamp(0.22 + 0.62 * g + zap), -55 * g);
    },
    wait: (t, i, d, x, c, fade) => c.base((0.1 + 0.5 * fade) * (0.75 + 0.25 * pingPong(t, 2600 + 2400 * (1 - fade))) + 0.02 * Math.sin((2 * Math.PI * t) / 110)),
    sleepMs: 1100,
    sleep: (p, i, d, x, c, from) => {
      if (p < 0.08) return c.base(clamp(from + 0.25));          // último fogonazo
      if (p < 0.4) return c.base(rnd(Math.floor(p * 1100 / 55), 13) > 0.5 ? from * 0.8 : 0.03);   // se apaga titilando
      return c.base(clamp(0.08 * ease((p - 0.4) / 0.6)));       // y queda respirando bajito
    },
  },

  escaner: {
    label: 'Escáner',
    desc: 'Una línea de luz con estela que barre la tira de punta a punta sobre una respiración de fondo. Dormida barre muy lento; te escucha con dos líneas espejadas que se abren y cierran; piensa barriendo rápido.',
    idle: (t, i, d, x, c) => c.base(0.05 + 0.1 * pingPong(t, 5000) + 0.28 * scanTrail(t, x, 6000, 0.07)),
    wakeMs: 600,
    wake: (p, i, d, x, c) => c.base(clamp(0.1 + 0.4 * ease(p) + 0.7 * gauss(d, ease(p), 0.1))),   // dos líneas que salen del centro
    listen: (t, i, d, x, c) => c.base(clamp(0.4 + 0.08 * pingPong(t, 3000) + 0.45 * mirrorTrail(t, d, 2400, 0.12))),
    think: (t, i, d, x, c) => {
      const s = scanTrail(t, x, 900, 0.06);
      return c.base(clamp(0.12 + 0.85 * s), -35 * s);
    },
    wait: (t, i, d, x, c, fade) => c.base(clamp((0.06 + 0.3 * fade) + 0.5 * fade * scanTrail(t, x, 2200 + 3000 * (1 - fade), 0.08))),
    sleepMs: 900,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * (1 - ease(p)) * 0.6 + 0.4 * (1 - p) * gauss(d, 1 - ease(p), 0.1) + 0.05 * p)),   // las líneas vuelven al centro
  },

  ecualizador: {
    label: 'Ecualizador',
    desc: 'Barra de nivel que crece desde el centro, como un ecualizador. Dormida la barra respira chiquita; al despertarse se llena; te escucha alta y estable; piensa con la barra saltando al ritmo, como música.',
    idle: (t, i, d, x, c) => bar(c, d, 0.18 + 0.4 * pingPong(t, 5000), 0.28),
    wakeMs: 550,
    wake: (p, i, d, x, c) => bar(c, d, 1.15 * ease(p), 0.25 + 0.5 * p),
    listen: (t, i, d, x, c) => bar(c, d, 0.82 + 0.14 * Math.sin((2 * Math.PI * t) / 1400), 0.7),
    think: (t, i, d, x, c) => {
      const beat = t / 170, k = Math.floor(beat), f = ease(beat - k);
      const lvl = 0.25 + 0.75 * (rnd(k, 14) * (1 - f) + rnd(k + 1, 14) * f);   // salta a un nivel nuevo cada golpe
      return bar(c, d, lvl, 0.8);
    },
    wait: (t, i, d, x, c, fade) => bar(c, d, (0.2 + 0.7 * fade) * (0.85 + 0.15 * pingPong(t, 2400)), 0.18 + 0.45 * fade),
    sleepMs: 1000,
    sleep: (p, i, d, x, c, from) => bar(c, d, 1.05 * (1 - ease(p)) + 0.15 * p, Math.max(0.25, from)),
  },

  plasma: {
    label: 'Plasma',
    desc: 'Dos ondas que se cruzan y mezclan colores, como plasma. Dormida se mueve lento y oscuro; te escucha brillante y calma; piensa con las ondas acelerando y el color corriendo al violeta.',
    idle: (t, i, d, x, c) => { const w = plasma(t, x, 1); return c.base(0.07 + 0.2 * w, 40 * (w - 0.5)); },
    wakeMs: 750,
    wake: (p, i, d, x, c) => { const w = plasma(p * 750, x, 3); return c.base(clamp(0.1 + 0.55 * ease(clamp((p - d * 0.4) / 0.6)) + 0.2 * w * (1 - p)), 50 * (w - 0.5)); },
    listen: (t, i, d, x, c) => { const w = plasma(t, x, 1.6); return c.base(0.5 + 0.3 * w, 35 * (w - 0.5)); },
    think: (t, i, d, x, c) => { const w = plasma(t, x, 4.5); return c.base(0.25 + 0.6 * w, -60 * w + 15); },
    wait: (t, i, d, x, c, fade) => { const w = plasma(t, x, 0.8 + 0.8 * fade); return c.base((0.08 + 0.45 * fade) * (0.55 + 0.45 * w), 35 * fade * (w - 0.5)); },
    sleepMs: 1500,
    sleep: (p, i, d, x, c, from) => { const w = plasma(p * 1500, x, 1); return c.base(clamp(from * (1 - ease(p)) * (0.6 + 0.4 * w) + 0.07 * p)); },
  },

  digital: {
    label: 'Digital',
    desc: 'Respiración "en bits": el brillo sube y baja de a escalones, LED por LED. Al despertarse se prenden uno por uno desde el centro; te escucha con bits que parpadean; piensa con datos que corren del centro hacia las puntas.',
    idle: (t, i, d, x, c) => c.base(0.05 + 0.25 * steps(pingPong(t - d * 400, 5000), 5)),   // la escalera viaja hacia afuera
    wakeMs: 520,
    wake: (p, i, d, x, c) => c.base(p * 4 > Math.round(d * 3.5 - 0.5) ? 0.15 + 0.5 * steps(p, 4) : 0.04),
    listen: (t, i, d, x, c) => {
      const tick = Math.floor(t / 220);
      const bit = rnd(tick, i + 30) > 0.8 ? 0.22 : 0;           // algún bit que parpadea
      return c.base(0.5 + 0.12 * steps(pingPong(t, 3000), 3) + bit);
    },
    think: (t, i, d, x, c) => {
      const tick = Math.floor(t / 110);
      const on = rnd(Math.round(d * 3.5 - 0.5) - tick, 15) > 0.5;   // los datos se corren hacia afuera
      return on ? c.base(0.85, -30) : c.base(0.1);
    },
    wait: (t, i, d, x, c, fade) => c.base(steps(0.06 + 0.5 * fade, 6) * (0.6 + 0.4 * steps(pingPong(t - d * 500, 3000 + 3000 * (1 - fade)), 3))),
    sleepMs: 800,
    sleep: (p, i, d, x, c, from) => c.base((1 - p) * 4 > 3 - Math.round(d * 3.5 - 0.5) ? from : 0.05 * p),   // se apagan de las puntas al centro
  },
};

// ── Ayudas de los estilos tecno ──────────────────────────────────────────────

// Línea con estela que va y vuelve por la tira (ancho w en 0..1).
function scanTrail(t, x, periodMs, w) {
  let v = 0;
  for (let k = 0; k < 5; k++) v += Math.pow(0.5, k) * gauss(x, pingPong(t - k * periodMs * 0.025, periodMs), w);
  return clamp(v);
}
// Dos líneas espejadas: salen del centro hacia las puntas y vuelven.
function mirrorTrail(t, d, periodMs, w) {
  let v = 0;
  for (let k = 0; k < 4; k++) v += Math.pow(0.5, k) * gauss(d, pingPong(t - k * periodMs * 0.03, periodMs), w);
  return clamp(v);
}
// Barra de nivel desde el centro (borde suave), el centro en color de marca y las puntas corridas.
function bar(c, d, level, bright) {
  const on = clamp((level - d) / 0.2 + 0.5);
  return c.base(clamp(0.03 + bright * on), -40 * d);
}
// Dos ondas que se cruzan; speed multiplica la velocidad. Devuelve 0..1.
function plasma(t, x, speed) {
  const a = Math.sin(2 * Math.PI * (x * 1.3 - (t * speed) / 5200));
  const b = Math.sin(2 * Math.PI * (x * 0.7 + (t * speed) / 7300) + 1.7);
  return 0.5 + 0.25 * a + 0.25 * b;
}
// Cuantiza v (0..1) en n escalones.
function steps(v, n) { return Math.round(clamp(v) * n) / n; }

module.exports = { STYLES };
