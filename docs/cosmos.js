/**
 * The backdrop: a still starfield, and a vortex of stars orbiting the composer.
 *
 * Purely decorative (the canvas is aria-hidden), and it never decides
 * layout: every frame it reads the composer's box and draws the orbit around
 * wherever the composer is, so when the composer moves from the centre of the
 * welcome screen to its dock, the vortex follows it.
 *
 * Orbits follow a superellipse, the shape of a rounded rectangle, so stars
 * hug the composer's edge. Speed falls off with distance, like a disc around
 * a heavy object: close stars streak, far ones drift. Under reduced motion it
 * draws one still frame. Colours come from CSS tokens.
 */

const TAU = Math.PI * 2;

export function startCosmos(canvas, getTarget) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const starColour = css.getPropertyValue('--color-star').trim() || css.getPropertyValue('--color-ink').trim();
  const coolColour = css.getPropertyValue('--color-star-cool').trim() || starColour;
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  let w = 0;
  let h = 0;
  let dpr = 1;
  const field = [];
  const orbit = [];

  function seed() {
    field.length = 0;
    orbit.length = 0;
    const area = (w * h) / (1440 * 900);
    for (let i = 0; i < Math.round(420 * area + 120); i++) {
      field.push({ x: Math.random(), y: Math.random(), r: Math.random() ** 3 * 1.4 + 0.25, a: Math.random() * 0.7 + 0.15, tw: Math.random() * TAU, cool: Math.random() < 0.25 });
    }
    for (let i = 0; i < 760; i++) {
      const d = Math.random() ** 2.2; // most stars hug the edge
      orbit.push({ t: Math.random() * TAU, d, len: 0.2 + Math.random() ** 2 * 3.2, a: 0.2 + Math.random() * 0.8, r: 0.3 + Math.random() ** 2 * 1.4, cool: Math.random() < 0.3 });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!field.length) seed();
  }

  /** A point on a superellipse around the box, pushed out by `out` pixels. */
  function edgePoint(box, theta, out) {
    const n = 5; // 2 is an ellipse; higher is squarer
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const ex = Math.sign(c) * Math.abs(c) ** (2 / n);
    const ey = Math.sign(s) * Math.abs(s) ** (2 / n);
    // The disc is flatter than it is wide, so it never runs over the head above the composer.
    return [box.cx + ex * (box.hw + out), box.cy + ey * (box.hh + out * 0.42)];
  }

  let last = performance.now();
  let raf = 0;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    ctx.clearRect(0, 0, w, h);

    // The still field, twinkling a little.
    for (const s of field) {
      s.tw += dt * 0.8;
      ctx.globalAlpha = s.a * (0.75 + 0.25 * Math.sin(s.tw));
      ctx.fillStyle = s.cool ? coolColour : starColour;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, TAU);
      ctx.fill();
    }

    const target = getTarget();
    if (target) {
      const r = target.rect;
      const box = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, hw: r.width / 2, hh: r.height / 2 };
      const reach = target.reach; // how far the disc extends, in px
      ctx.lineCap = 'round';
      for (const p of orbit) {
        const out = 6 + p.d * reach;
        const speed = (0.05 + 0.5 * (1 - p.d) ** 3) * target.energy;
        const before = p.t;
        p.t = (p.t + speed * dt) % TAU;
        const [x0, y0] = edgePoint(box, before - p.len * speed * 0.18, out);
        const [x1, y1] = edgePoint(box, p.t, out);
        const fade = (1 - p.d) ** 1.8;
        ctx.globalAlpha = p.a * fade * target.glow;
        ctx.strokeStyle = p.cool ? coolColour : starColour;
        ctx.lineWidth = p.r;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (!still.matches) raf = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  resize();
  start();
  window.addEventListener('resize', () => {
    resize();
    if (still.matches) start();
  });
  still.addEventListener('change', start);
  // Pause when nobody is looking.
  document.addEventListener('visibilitychange', () => (document.hidden ? cancelAnimationFrame(raf) : start()));
  return { redraw: start };
}
