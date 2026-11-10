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
