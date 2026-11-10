/**
 * The memory constellation: every past conversation as a star on a spiral of time.
 *
 * The spiral is drawn: "now" on its outer end, the past winding toward the
 * black hole at the centre. Conversations sit on it newest first, spaced by
 * the real time between them (long gaps take more of the curve, capped so one
 * quiet week does not swallow the map). A star's size is the number of claims
 * it left in the ledger. Curved lines join conversations whose claims share a
 * subject, which is how a past answer connects to a later one.
 *
 * Plain SVG, built once per open. Stars fade in by opacity only (a CSS
 * transform would override the SVG position), and the WebGL sky behind is
 * paused while the map is open, so nothing competes for frames.
 */
const SVGNS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 680;
const CX = W / 2;
const CY = H / 2 + 10;
const TURNS = 1.6; // how far the spiral winds, outer end to centre
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A point on the spiral, t = 0 at the outer end (now), t = 1 near the centre (the past). */
function spiral(t) {
  const theta = -Math.PI * 0.15 + t * TURNS * 2 * Math.PI;
  const r = 300 - t * 230;
  return { x: CX + Math.cos(theta) * r * 1.45, y: CY + Math.sin(theta) * r, theta };
}

function el(name, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}

function subjectsOf(c) {
  return new Set((c.claims ?? []).map((k) => k.subject.toLowerCase().split(/\s+/)[0]).filter((s) => s.length > 2));
}

let hooks = {};

export async function openConstellation({ api, now, onOpen, onRecheck, formatDay, onShow, onHide }) {
  hooks = { onHide };
  const root = document.getElementById('sky-map');
  const svg = root.querySelector('svg');
  const card = root.querySelector('.sky-map__card');
  root.hidden = false;
  onShow?.();
  requestAnimationFrame(() => root.classList.add('is-open'));
  svg.replaceChildren();
  card.hidden = true;

  // The spiral itself, and its two ends.
  const path = [];
  for (let i = 0; i <= 160; i++) {
    const p = spiral(i / 160);
    path.push(`${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  svg.append(el('path', { d: path.join(' '), class: 'sky-path' }));
  svg.append(el('circle', { cx: CX, cy: CY, r: 34, class: 'sky-hole' }));
  const start = spiral(0);
  svg.append(el('text', { x: start.x + 14, y: start.y - 12, class: 'sky-end' }, 'now'));
  svg.append(el('text', { x: CX, y: CY + 5, 'text-anchor': 'middle', class: 'sky-end' }, 'the past'));

  const list = await api.conversations();
  const full = (await Promise.all(list.slice(0, 24).map((c) => api.conversation(c.id).catch(() => null)))).filter(Boolean);
  full.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (!full.length) {
    svg.append(el('text', { x: CX, y: CY + 70, 'text-anchor': 'middle', class: 'sky-empty' }, 'No memories yet. Ask something, and it lands here.'));
    return;
  }

  // Spacing along the curve from real time gaps: an hour apart sits close, a day apart further.
  const nowMs = now().getTime();
  const gaps = full.map((c, i) => {
    const prev = i === 0 ? nowMs : new Date(full[i - 1].createdAt).getTime();
    const hours = Math.max(0, (prev - new Date(c.createdAt).getTime()) / 3_600_000);
    return 0.6 + Math.min(Math.log1p(hours), 4);
  });
  const total = gaps.reduce((a, b) => a + b, 0);
  let acc = 0;
  const stars = full.map((c, i) => {
    acc += gaps[i];
    const t = 0.04 + (acc / total) * 0.86;
    return { c, ...spiral(t), subjects: subjectsOf(c) };
  });

  // Links: curved toward the centre, so they read as constellation lines, not a web.
  const links = el('g', { class: 'sky-lines' });
  svg.append(links);
  let li = 0;
  for (let a = 0; a < stars.length; a++) {
    for (let b = a + 1; b < stars.length; b++) {
      if (![...stars[a].subjects].some((s) => stars[b].subjects.has(s))) continue;
      const mx = (stars[a].x + stars[b].x) / 2;
      const my = (stars[a].y + stars[b].y) / 2;
      const qx = mx + (CX - mx) * 0.35;
      const qy = my + (CY - my) * 0.35;
      const line = el('path', { d: `M${stars[a].x.toFixed(1)} ${stars[a].y.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${stars[b].x.toFixed(1)} ${stars[b].y.toFixed(1)}`, 'data-a': stars[a].c.id, 'data-b': stars[b].c.id });
      line.style.setProperty('--i', String(li++));
      links.append(line);
    }
  }

  const show = (s) => {
    const first = s.c.messages.find((m) => m.role === 'user')?.content ?? '';
    card.innerHTML = `<p class="sky-card__date">${esc(formatDay(s.c.createdAt))}${s.c.simulated ? ', time-travelled' : ''}</p>
      <h3>${esc(s.c.title || 'Untitled')}</h3>
      <p class="sky-card__q">“${esc(first.slice(0, 160))}${first.length > 160 ? '…' : ''}”</p>
      <p class="sky-card__meta">${s.c.claims.length} ${s.c.claims.length === 1 ? 'claim' : 'claims'} in the ledger</p>
      <div class="sky-card__actions">
        <button class="pill pill--small" type="button" data-sky-open="${esc(s.c.id)}">Open</button>
        ${s.c.claims.length ? `<button class="pill pill--small recheck" type="button" data-sky-recheck="${esc(s.c.id)}">Recheck now</button>` : ''}
      </div>`;
    card.hidden = false;
    for (const l of links.children) l.classList.toggle('is-lit', l.dataset.a === s.c.id || l.dataset.b === s.c.id);
    for (const g of svg.querySelectorAll('.sky-star')) g.classList.toggle('is-current', g.dataset.id === s.c.id);
  };

  stars.forEach((s, i) => {
    const size = 4 + Math.sqrt(s.c.claims.length) * 1.8;
    const g = el('g', { class: `sky-star${s.c.simulated ? ' is-sim' : ''}`, transform: `translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`, tabindex: 0, role: 'button', 'aria-label': `${s.c.title || 'Untitled'}, ${formatDay(s.c.createdAt)}`, 'data-id': s.c.id });
    // The fade lives on an inner group: animating the outer one would override its position.
    const inner = el('g', { class: 'sky-star__in' });
    inner.style.setProperty('--i', String(i));
    inner.append(el('circle', { class: 'sky-star__halo', r: (size * 2.6).toFixed(1) }), el('circle', { class: 'sky-star__core', r: size.toFixed(1) }));
    // Labels sit outward from the centre, on whichever side the star is.
    const right = s.x >= CX;
    const dy = s.y < CY ? -2 : 12;
    const label = el('text', { x: right ? size + 10 : -(size + 10), y: dy, 'text-anchor': right ? 'start' : 'end', class: 'sky-star__label' }, (s.c.title || 'Untitled').slice(0, 30));
    const date = el('text', { x: right ? size + 10 : -(size + 10), y: dy + 14, 'text-anchor': right ? 'start' : 'end', class: 'sky-star__date' }, formatDay(s.c.createdAt));
    inner.append(label, date);
    g.append(inner);
    g.addEventListener('mouseenter', () => show(s));
    g.addEventListener('focus', () => show(s));
    g.addEventListener('click', () => onOpen(s.c.id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(s.c.id);
      }
    });
    svg.append(g);
  });

  card.onclick = (e) => {
    const open = e.target.closest('[data-sky-open]');
    const re = e.target.closest('[data-sky-recheck]');
    if (open) onOpen(open.dataset.skyOpen);
    if (re) {
      const s = stars.find((x) => x.c.id === re.dataset.skyRecheck);
      onRecheck(s.c.title, s.c.createdAt);
    }
  };
  show(stars[0]);
  root.querySelector('.sky-map__close').focus();
}

export function closeConstellation() {
  const root = document.getElementById('sky-map');
  root.classList.remove('is-open');
  hooks.onHide?.();
  setTimeout(() => (root.hidden = true), 300);
}
