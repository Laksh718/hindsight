/**
 * Shared by the landing page and the architecture page: the lensed sky bends
 * around whichever element carries data-lens, and sections fade in as they
 * scroll into view. Everything is visible without this script.
 */
import { startCosmos } from './cosmos.js';

const mass = document.querySelector('[data-lens]');
if (mass) {
  const strength = Number(mass.dataset.lensStrength || 2200);
  startCosmos(document.getElementById('cosmos'), () => ({
    rect: mass.getBoundingClientRect(),
    radius: Number(mass.dataset.lensRadius || 48),
    lens: strength,
    glow: 1,
    energy: 1,
    focus: 0,
    rim: 0,
    warp: 0,
    dim: 1,
  }));
}

const reveal = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  reveal.forEach((el) => io.observe(el));
} else {
  reveal.forEach((el) => el.classList.add('is-in'));
}

// The logo pops out: it tilts toward the pointer in 3D, like something with depth.
const tilt = document.querySelector('[data-tilt]');
if (tilt && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let rx = 0, ry = 0, tx = 0, ty = 0;
  addEventListener('pointermove', (e) => {
    const r = tilt.getBoundingClientRect();
    tx = ((e.clientY - (r.top + r.height / 2)) / innerHeight) * -6;
    ty = ((e.clientX - (r.left + r.width / 2)) / innerWidth) * 8;
  }, { passive: true });
  const loop = () => {
    rx += (tx - rx) * 0.08;
    ry += (ty - ry) * 0.08;
    tilt.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(30px)`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
