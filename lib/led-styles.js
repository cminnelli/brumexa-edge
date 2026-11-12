// Estilos de luces para probar (rama dev). Cada estilo dice cómo se ve cada
// estado de Brumexa; leds.js los anima. Cuando se elija uno, queda solo ese.
// Página oculta para probarlos: /luces.html.
//
// Cada estado es fn(t, i, d, x, c) → {r,g,b} para el LED i:
//   t  ms desde que arrancó el estado     d  distancia al centro (0 medio, 1 puntas)
//   x  posición 0..1 a lo largo de la tira (tira RECTA: lo que se mueve va y vuelve, nunca da la vuelta)
//   c  colores de la carcasa: c.base(v, dh) = color de marca con brillo v (corrido dh grados)
//      c.tint(v, dh, s) = igual pero con saturación s (0..1 de la de marca; bajo = más blanco)
// Los de una pasada (wake, sleep) reciben p = 0..1 en vez de t y duran wakeMs / sleepMs.
// wait recibe además fade (1 → 0 a lo largo de "te espera").
// Un estilo "builtin" usa las animaciones de siempre de leds.js para los estados
// que no defina (el clásico solo cambia "te escucha" y "te espera").
'use strict';

const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const gauss = (x, mu, w) => Math.exp(-((x - mu) ** 2) / (2 * w * w));
// Va y vuelve de 0 a 1 (para lo que se mueve a lo largo de la tira).
const pingPong = (t, periodMs) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / periodMs);

// ── "Te escucho" (firma común a todos los estilos, 2026-11-12) ──────────────
// Tiene que ser lo más marcado de todo: la tira entera arriba de 70 %, el color
// de marca lavado hacia el blanco, y ondas que entran desde las puntas hacia el
// centro, como si la luz "se acercara" a lo que decís. Nada más hace eso: dormida
// es tenue, pensando se mueve de punta a punta y en índigo.
const LISTEN_PERIOD_MS = 1100;
function listenWave(t, d) {
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * (t / LISTEN_PERIOD_MS + d * 0.85));   // la cresta viaja de las puntas al centro
}
function listenMark(t, d, c, dh = 0, strength = 1) {
  const w = listenWave(t, d);
  const v = (0.72 + 0.26 * w) * (0.3 + 0.7 * strength);
  return c.tint(clamp(v), dh, 0.22 - 0.17 * w * strength);  // casi blanco: escuchar = blanco
}
// "Te espera" es escuchar también (después de contestar): misma firma, fuerte
// la mayor parte del tiempo y recién en el último 40 % se apaga, avisando que
// se va a dormir.
function waitStrength(fade) {
  const q = -Math.log(Math.max(fade, 1e-6)) * 0.52;          // 0 → 1 a lo largo de la espera
  return q < 0.6 ? 1 : 1 - 0.75 * ease(clamp((q - 0.6) / 0.4));
}
// Al despertarse: un destello corto (se nota que te oyó) que baja a "te escucho".
function wakeFlash(p, d, c, dh = 0) {
  const open = ease(clamp((p - d * 0.4) / 0.6));            // se abre del centro a las puntas
  const flash = Math.sin(Math.PI * clamp(p / 0.55)) * (1 - d * 0.3);
  return c.tint(clamp(0.1 + 0.75 * open + 0.25 * flash), dh, 0.6 - 0.45 * ease(p));   // del color de marca al blanco de "te escucho"
}

// ── "Brumexa habla" (lo opuesto a escuchar) ─────────────────────────────────
// Color pleno (el de "habla" de la carcasa, sin lavar), una barra que nace en el
// centro y se abre hacia las puntas con el volumen de la voz, y ondas que SALEN
// del centro (al escuchar entran). Las puntas quedan oscuras en los silencios.
// level = 0..1 (volumen de la voz ya suavizado).
// Más "respiración" que vúmetro (pedido de Charlie): bordes muy difusos y un
// respirar lento de fondo, así en las pausas respira en vez de apagarse.
function speakMark(t, d, c, level, extra = 0) {
  const breath = pingPong(t, 2600);                          // respiración lenta de fondo, apenas
  const reach = 0.12 + 1.0 * level + 0.06 * breath;          // la barra se abre y se cierra con cada sílaba
  const on = clamp((reach - d) / 0.35 + 0.5);                // borde suave, sin escalón
  return c.voice(clamp(0.06 + 0.08 * breath + on * (0.22 + 0.72 * level) + extra * on));
}

const STYLES = {
  clasico: {
    label: 'Respira (el de hoy)',
    desc: 'La respiración de siempre para dormida, despertarse y pensar. Te escucha con la firma nueva: la tira entera brillante y ondas blancas que entran de las puntas al centro.',
    builtin: true,
    listen: (t, i, d, x, c) => listenMark(t, d, c),
    speak: (t, i, d, x, c, level) => speakMark(t, d, c, level),
    think: (t, i, d, x, c) => {                                // la ola de siempre, en violeta y más rápida
      const w = 0.5 + 0.5 * Math.cos(2 * Math.PI * (t / 900 - d * 0.6));
      return c.think(0.3 + 0.55 * w, -15 * (1 - w));
    },
    wait: (t, i, d, x, c, fade) => listenMark(t, d, c, 0, waitStrength(fade)),
  },

  aurora: {
    label: 'Aurora',
    desc: 'Colores que fluyen suave por la tira, como una aurora. Dormida apenas se mueve; te escucha con la firma nueva y el color fluyendo encima; piensa con el color corriendo más rápido.',
    idle: (t, i, d, x, c) => c.base(0.09 + 0.12 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 0.7 - t / 6000))), 28 * Math.sin(2 * Math.PI * (x * 0.6 - t / 9000))),
    wakeMs: 800,
    wake: (p, i, d, x, c) => wakeFlash(p, d, c, 40 * (1 - p) * Math.sin(2 * Math.PI * x)),
    listen: (t, i, d, x, c) => listenMark(t, d, c, 30 * Math.sin(2 * Math.PI * (x * 0.7 - t / 4500))),
    speak: (t, i, d, x, c, level) => speakMark(t, d, c, level, 0.08 * Math.sin(2 * Math.PI * (x * 0.8 - t / 2600))),   // con un brillo que fluye lento encima
    think: (t, i, d, x, c) => {
      const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 1.2 - t / 900));
      return c.think(0.3 + 0.55 * w, 25 * Math.sin(2 * Math.PI * (x * 0.5 - t / 1400)));
    },
    wait: (t, i, d, x, c, fade) => listenMark(t, d, c, 25 * Math.sin(2 * Math.PI * (x * 0.6 - t / 5000)), waitStrength(fade)),
    sleepMs: 1600,
    sleep: (p, i, d, x, c, from) => c.base(clamp(from * (1 - ease(clamp((p - (1 - d) * 0.4) / 0.6))) + 0.09 * p)),
  },

  escaner: {
    label: 'Escáner (tecno)',
    desc: 'Una línea de luz con estela que barre la tira de punta a punta sobre una respiración de fondo. Dormida barre muy lento; te escucha con la firma nueva y dos líneas blancas que entran de las puntas al centro; piensa barriendo rápido en índigo.',
    idle: (t, i, d, x, c) => c.base(0.05 + 0.1 * pingPong(t, 5000) + 0.28 * scanTrail(t, x, 6000, 0.07)),
    wakeMs: 600,
    wake: (p, i, d, x, c) => wakeFlash(p, d, c),
    listen: (t, i, d, x, c) => scanListen(t, d, c, 1),
    speak: (t, i, d, x, c, level) => {                         // dos líneas que SALEN del centro, más rápido cuanto más fuerte habla
      const pos = pingPong(t, 2200);                            // un brillo suave que se abre y se cierra, sin cortes
      return speakMark(t, d, c, level, 0.18 * gauss(d, pos, 0.22));
    },
    think: (t, i, d, x, c) => {
      const s = scanTrail(t, x, 900, 0.06);
      return c.think(clamp(0.12 + 0.85 * s), -15 * s);
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
// Escáner escuchando: fondo brillante + dos líneas blancas que van de las puntas
// al centro (con estela hacia afuera) al ritmo de la firma común.
function scanListen(t, d, c, strength) {
  let line = 0;
  for (let k = 0; k < 4; k++) {
    const pos = 1 - (((t - k * 45) / LISTEN_PERIOD_MS) % 1 + 1) % 1;   // 1 → 0: de las puntas al centro
    line += Math.pow(0.5, k) * gauss(d, pos, 0.09);
  }
  line = clamp(line) * strength;
  const v = (0.62 + 0.38 * line) * (0.3 + 0.7 * strength);
  return c.tint(clamp(v), 0, 0.22 - 0.2 * line);
}

module.exports = { STYLES };
