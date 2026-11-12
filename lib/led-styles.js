// Estilos de luces. Cada estilo dice cómo se ve cada estado de Brumexa; leds.js
// los anima en la tira y /configuracion → Apariencia los dibuja en el navegador
// (este archivo se sirve tal cual en /led-styles.js, sin dependencias).
//
// Cada estado es fn(t, i, d, x, c) → {r,g,b} para el LED i:
//   t  ms desde que arrancó el estado     d  distancia al centro (0 medio, 1 puntas)
//   x  posición 0..1 a lo largo de la tira (tira RECTA: lo que se mueve va y vuelve, nunca da la vuelta)
//   c  colores, uno por estado (se eligen en Apariencia):
//      c.base(v, dh)     Dormida (color de marca), corrido dh grados
//      c.listen(v, w)    Te escucha; w 0..1 lo lava más hacia el blanco
//      c.think(v, dh)    Piensa
//      c.voice(v)        Brumexa habla
// Los de una pasada (wake, sleep) reciben p = 0..1 en vez de t y duran wakeMs / sleepMs.
// wait recibe además fade (1 → 0 a lo largo de "te espera"); speak recibe level (0..1, volumen de la voz).
// Un estilo "builtin" usa las animaciones de siempre de leds.js para los estados
// que no defina (el clásico usa la respiración de siempre para dormida y dormirse).
'use strict';

const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const gauss = (x, mu, w) => Math.exp(-((x - mu) ** 2) / (2 * w * w));
// Va y vuelve de 0 a 1 (para lo que se mueve a lo largo de la tira).
const pingPong = (t, periodMs) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / periodMs);
const mix = (a, b, k) => ({ r: Math.round(a.r + (b.r - a.r) * k), g: Math.round(a.g + (b.g - a.g) * k), b: Math.round(a.b + (b.b - a.b) * k) });

// ── Se despierta (común a todos) ─────────────────────────────────────────────
// Tiene que verse distinto de "te escucha": en el color de marca PLENO, dos
// destellos salen disparados del centro a las puntas, la tira entera se prende
// a fondo y recién ahí se funde al blanco de "te escucha" (que es lo contrario:
// lavado y con ondas que ENTRAN).
const WAKE_MS = 1000;
function wakeBurst(p, d, c) {
  if (p < 0.42) {                                           // dos destellos que salen del centro
    const q = p / 0.42, front = ease(q);
    const v = 0.05 + 0.95 * gauss(d, front, 0.13) + (d < front ? 0.28 : 0);
    return c.base(clamp(v));
  }
  if (p < 0.62) return c.base(1 - 0.12 * ((p - 0.42) / 0.2));   // la tira entera a fondo
  return mix(c.base(0.88), c.listen(0.85), ease((p - 0.62) / 0.38));   // y se funde a "te escucha"
}

// ── Te escucha (común a todos) ───────────────────────────────────────────────
// Lo más marcado de todo: la tira entera arriba de 70 %, en el color de "te
// escucha" (casi blanco), con ondas que entran desde las puntas hacia el centro,
// como si la luz "se acercara" a lo que decís.
const LISTEN_PERIOD_MS = 1100;
function listenWave(t, d) {
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * (t / LISTEN_PERIOD_MS + d * 0.85));   // la cresta viaja de las puntas al centro
}
function listenMark(t, d, c, strength = 1, extra = 0) {
  const w = listenWave(t, d);
  const v = (0.72 + 0.26 * w + extra) * (0.3 + 0.7 * strength);
  return c.listen(clamp(v), w * strength);                  // en la cresta, más blanco todavía
}
// "Te espera" es escuchar también (después de contestar): misma firma, fuerte
// la mayor parte del tiempo y recién en el último 40 % se apaga, avisando que
// se va a dormir.
function waitStrength(fade) {
  const q = -Math.log(Math.max(fade, 1e-6)) * 0.52;          // 0 → 1 a lo largo de la espera
  return q < 0.6 ? 1 : 1 - 0.75 * ease(clamp((q - 0.6) / 0.4));
}

// ── Brumexa habla (común a todos; lo opuesto a escuchar) ────────────────────
// Una barra que nace en el centro y se abre hacia las puntas con el volumen de
// la voz, de bordes difusos y con un respirar lento de fondo (en las pausas
// respira en vez de apagarse).
function speakMark(t, d, c, level, extra = 0) {
  const breath = pingPong(t, 2600);
  const reach = 0.22 + 0.8 * level + 0.08 * breath;          // se abre y se cierra con la voz, sin saltos
  const on = clamp((reach - d) / 0.5 + 0.5);                 // borde bien difuso
  return c.voice(clamp(0.1 + 0.1 * breath + on * (0.32 + 0.52 * level) + extra * on));
}

const STYLES = {
  clasico: {
    label: 'Respira',
    desc: 'Calmo y simple: respira mientras duerme, piensa con una ola suave.',
    builtin: true,                                            // dormida y dormirse: la respiración de siempre
    wakeMs: WAKE_MS,
    wake: (p, i, d, x, c) => wakeBurst(p, d, c),
    listen: (t, i, d, x, c) => listenMark(t, d, c),
    think: (t, i, d, x, c) => {                               // una ola que va del centro a las puntas
      const w = 0.5 + 0.5 * Math.cos(2 * Math.PI * (t / 900 - d * 0.6));
      return c.think(0.3 + 0.55 * w, -15 * (1 - w));
    },
    speak: (t, i, d, x, c, level) => speakMark(t, d, c, level),
    wait: (t, i, d, x, c, fade) => listenMark(t, d, c, waitStrength(fade)),
  },

  aurora: {
    label: 'Aurora',
    desc: 'Orgánico: los colores fluyen por la tira como una aurora.',
    idle: (t, i, d, x, c) => c.base(0.09 + 0.12 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 0.7 - t / 6000))), 28 * Math.sin(2 * Math.PI * (x * 0.6 - t / 9000))),
    wakeMs: WAKE_MS,
    wake: (p, i, d, x, c) => wakeBurst(p, d, c),
    listen: (t, i, d, x, c) => listenMark(t, d, c, 1, 0.06 * Math.sin(2 * Math.PI * (x * 0.7 - t / 4500))),
    think: (t, i, d, x, c) => {
      const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 1.2 - t / 900));
      return c.think(0.3 + 0.55 * w, 25 * Math.sin(2 * Math.PI * (x * 0.5 - t / 1400)));
    },
    speak: (t, i, d, x, c, level) => speakMark(t, d, c, level, 0.08 * Math.sin(2 * Math.PI * (x * 0.8 - t / 2600))),
    wait: (t, i, d, x, c, fade) => listenMark(t, d, c, waitStrength(fade), 0.05 * Math.sin(2 * Math.PI * (x * 0.6 - t / 5000))),
    sleepMs: 1600,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * (1 - ease(clamp((p - (1 - d) * 0.4) / 0.6))) + 0.09 * p)),
  },

  escaner: {
    label: 'Escáner',
    desc: 'Tecno: una línea de luz con estela barre la tira de punta a punta.',
    idle: (t, i, d, x, c) => c.base(0.05 + 0.1 * pingPong(t, 5000) + 0.28 * scanTrail(t, x, 6000, 0.07)),
    wakeMs: WAKE_MS,
    wake: (p, i, d, x, c) => wakeBurst(p, d, c),
    listen: (t, i, d, x, c) => scanListen(t, d, c, 1),
    think: (t, i, d, x, c) => {
      const s = scanTrail(t, x, 900, 0.06);
      return c.think(clamp(0.12 + 0.85 * s), -15 * s);
    },
    speak: (t, i, d, x, c, level) => {                         // un brillo suave que se abre y se cierra encima de la voz
      const pos = pingPong(t, 2200);
      return speakMark(t, d, c, level, 0.18 * gauss(d, pos, 0.22));
    },
    wait: (t, i, d, x, c, fade) => scanListen(t, d, c, waitStrength(fade)),
    sleepMs: 900,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * (1 - ease(p)) * 0.6 + 0.4 * (1 - p) * gauss(d, 1 - ease(p), 0.1) + 0.05 * p)),   // las líneas vuelven al centro
  },
};

// Línea con estela que va y vuelve por la tira (ancho w en 0..1).
function scanTrail(t, x, periodMs, w) {
  let v = 0;
  for (let k = 0; k < 5; k++) v += Math.pow(0.5, k) * gauss(x, pingPong(t - k * periodMs * 0.025, periodMs), w);
  return clamp(v);
}
// Escáner escuchando: fondo brillante + dos líneas que van de las puntas al
// centro (con estela hacia afuera) al ritmo de la firma común.
function scanListen(t, d, c, strength) {
  let line = 0;
  for (let k = 0; k < 4; k++) {
    const pos = 1 - (((t - k * 45) / LISTEN_PERIOD_MS) % 1 + 1) % 1;   // 1 → 0: de las puntas al centro
    line += Math.pow(0.5, k) * gauss(d, pos, 0.09);
  }
  line = clamp(line) * strength;
  const v = (0.62 + 0.38 * line) * (0.3 + 0.7 * strength);
  return c.listen(clamp(v), line);
}

if (typeof module !== 'undefined') module.exports = { STYLES };
