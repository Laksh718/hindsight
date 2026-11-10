/**
 * The replay: a recorded turn (public/demo/session.json, captured from real
 * agent runs by `npm run seed -- --record public/demo`) played back through
 * a diagram of the architecture.
 *
 * Each recorded event lights the parts it touched and sends a packet along
 * the path it took:
 *   start       you -> memory          the question is saved first
 *   recall      memory -> recall -> model
 *   search      model -> web           one packet per query, in parallel
 *   results     web -> model
 *   text        model -> you           the answer streaming out
 *   done        model -> memory        the answer is saved
 *   remembered  model -> ledger -> memory
 *
 * Timestamps are the real ones. Quiet gaps are shortened unless "Real time"
 * is on, and the page says when they are.
 */
import { renderAnswer } from './render.js';

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const GAP_CAP = 2200; // ms: the longest pause shown when gaps are shortened

const state = { session: null, replay: null, timeline: [], playhead: 0, playing: false, speed: 1, i: 0, text: '', sources: new Map(), last: 0 };
const packets = [];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/* Packets: small lights travelling along a path, with a short tail. */
function send(from, to, { delay = 0, dur = 900 } = {}) {
  const path = document.getElementById(`p-${from}-${to}`);
  if (!path) return;
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'packet');
  for (let k = 0; k < 4; k++) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('r', String(4.2 - k * 0.9));
    c.setAttribute('opacity', String(1 - k * 0.24));
    g.append(c);
  }
  $('#packets').append(g);
  packets.push({ g, path, len: path.getTotalLength(), start: performance.now() + delay, dur });
  path.classList.add('is-live');
  setTimeout(() => path.classList.remove('is-live'), delay + dur + 200);
}

function drawPackets(now) {
  for (let i = packets.length - 1; i >= 0; i--) {
    const p = packets[i];
    const t = (now - p.start) / p.dur;
    if (t < 0) {
      p.g.setAttribute('opacity', '0');
      continue;
    }
    if (t > 1) {
      p.g.remove();
      packets.splice(i, 1);
      continue;
    }
    p.g.setAttribute('opacity', '1');
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    [...p.g.children].forEach((c, k) => {
      const at = p.path.getPointAtLength(Math.max(0, eased - k * 0.035) * p.len);
      c.setAttribute('cx', at.x.toFixed(1));
      c.setAttribute('cy', at.y.toFixed(1));
    });
  }
}

function light(node, mode) {
  const el = document.querySelector(`.node[data-node="${node}"]`);
  if (!el) return;
  if (mode === 'pulse') {
    el.classList.remove('is-pulse');
    void el.getBBox();
    el.classList.add('is-pulse');
    el.dataset.state = 'lit';
  } else if (mode) el.dataset.state = mode;
  else delete el.dataset.state;
}

function log(t, what, detail = '') {
  const li = document.createElement('li');
  li.innerHTML = `<span class="log__t">+${secs(t)}</span><span class="log__what">${esc(what)}</span>${detail ? `<span class="log__detail">${detail}</span>` : ''}`;
  $('#log').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

/** Apply one recorded event. `quiet` skips animation (used when seeking). */
function apply({ t, e }, quiet = false) {
  const go = (a, b, o) => !quiet && send(a, b, o);
  switch (e.type) {
    case 'start':
      light('you', 'pulse');
      go('you', 'memory');
      light('memory', 'pulse');
      log(t, 'Question saved to memory', esc(e.user.content));
      break;
    case 'recall': {
      light('recall', 'pulse');
      go('memory', 'recall', { delay: 300 });
      go('recall', 'model', { delay: 900 });
      light('model', 'thinking');
      const dates = e.windows.filter((w) => !w.alternative).map((w) => `“${esc(w.phrase)}” is ${esc(w.label)}`);
      const hits = e.hits.map((h) => `${esc(h.title)} (${esc(h.days.join(', '))})`);
      const empty = e.empty.map((x) => `nothing on ${esc(x)}`);
      log(t, hits.length ? `Recalled ${hits.length} past conversation${hits.length > 1 ? 's' : ''}` : 'Nothing to recall', [...dates, ...hits, ...empty].join('<br>'));
      break;
    }
    case 'search':
      light('model', 'lit');
      light('web', 'thinking');
      e.queries.forEach((_, k) => go('model', 'web', { delay: k * 110, dur: 750 }));
      log(t, `Searched ${e.queries.length} queries in parallel`, e.queries.map((q) => `“${esc(q)}”`).join('<br>') + (e.since ? `<br>published since ${esc(e.since)}` : ''));
      break;
    case 'results':
      for (const s of e.sources) state.sources.set(s.n, s);
      light('web', 'pulse');
      go('web', 'model', { dur: 750 });
      light('model', 'thinking');
      log(t, e.error ? 'Search failed' : `${e.sources.length} pages back in ${secs(e.ms)}`, e.error ? esc(e.error) : e.sources.slice(0, 4).map((s) => esc(s.domain)).join(', ') + (e.sources.length > 4 ? '…' : ''));
      break;
    case 'text':
      if (!state.text) {
        light('model', 'lit');
        light('you', 'lit');
        log(t, 'Answer streaming');
      }
      state.text += e.text;
      if (!quiet && Math.random() < 0.5) go('model', 'you', { dur: 650 });
      if (!quiet) renderAnswer($('#said'), state.text, state.sources);
      break;
    case 'aside':
      state.text = '';
      break;
    case 'done':
      for (const s of e.message.sources ?? []) state.sources.set(s.n, s);
      state.text = e.message.content;
      renderAnswer($('#said'), state.text, state.sources);
      light('you', 'pulse');
      go('model', 'memory');
      light('memory', 'pulse');
      light('model', 'lit');
      log(t, `Answered in ${secs(e.message.ms ?? t)}`, 'answer and every source it read saved to memory');
      break;
    case 'remembered':
      light('ledger', 'pulse');
      go('model', 'ledger');
      go('ledger', 'memory', { delay: 700 });
      log(t, `Ledger: ${e.claims.length} claim${e.claims.length === 1 ? '' : 's'} recorded`, e.claims.slice(0, 4).map((k) => `${esc(k.subject)}: ${esc(k.value)}`).join('<br>'));
      break;
    case 'error':
      log(t, 'Error', esc(e.message));
      break;
  }
}

/** Display times: the real ones, or with quiet gaps shortened. */
function buildTimeline() {
  const real = $('#realtime').checked;
  let shown = 0;
  let prev = 0;
  let shortened = 0;
  state.timeline = state.replay.events.map((ev) => {
    const gap = ev.t - prev;
    prev = ev.t;
    const step = real ? gap : Math.min(gap, GAP_CAP);
    if (step < gap) shortened += gap - step;
    shown += step;
    return { ...ev, at: shown };
  });
  const total = state.timeline.at(-1)?.at ?? 0;
  $('#note').textContent = real
    ? `Real time: ${secs(state.replay.events.at(-1).t)} from question to the last claim saved.`
    : `Quiet gaps shortened: ${secs(shortened)} of waiting skipped. Turn on Real time to sit through them. Timestamps in the log are the real ones.`;
  return total;
}

function reset() {
  state.i = 0;
  state.playhead = 0;
  state.text = '';
  state.sources = new Map();
  $('#log').innerHTML = '';
  $('#said').innerHTML = '';
  $('#clock-t').textContent = '0.0 s';
  for (const n of document.querySelectorAll('.node')) delete n.dataset.state;
  for (const p of packets.splice(0)) p.g.remove();
}

function frame(now) {
  const dt = Math.min(now - state.last, 100);
  state.last = now;
  if (state.playing) {
    state.playhead += dt * state.speed;
    while (state.i < state.timeline.length && state.timeline[state.i].at <= state.playhead) apply(state.timeline[state.i++]);
    // The clock shows real time in the recording, interpolated between events.
    const prev = state.timeline[state.i - 1];
    const next = state.timeline[state.i];
    const real = next && prev ? prev.t + ((state.playhead - prev.at) / Math.max(next.at - prev.at, 1)) * (next.t - prev.t) : (prev?.t ?? 0);
    $('#clock-t').textContent = secs(Math.max(0, real));
    const total = state.timeline.at(-1)?.at ?? 1;
    $('#scrub-fill').style.transform = `scaleX(${Math.min(state.playhead / total, 1)})`;
    if (state.i >= state.timeline.length) {
      state.playing = false;
      $('#play').textContent = 'Play again';
      $('#play').setAttribute('aria-pressed', 'false');
      for (const n of document.querySelectorAll('.node[data-state="thinking"]')) n.dataset.state = 'lit';
    }
  }
  drawPackets(now);
  requestAnimationFrame(frame);
}

function choose(index) {
  state.replay = state.session.replays[index];
  reset();
  const total = buildTimeline();
  // Tick marks for each event that moves something.
  const scrub = $('#scrub');
  scrub.querySelectorAll('.tick').forEach((t) => t.remove());
  for (const ev of state.timeline) {
    if (ev.e.type === 'text') continue;
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${(ev.at / Math.max(total, 1)) * 100}%`;
    scrub.append(tick);
  }
  $('#scrub-fill').style.transform = 'scaleX(0)';
}

function seek(fraction) {
  const total = state.timeline.at(-1)?.at ?? 0;
  const target = fraction * total;
  reset();
  while (state.i < state.timeline.length && state.timeline[state.i].at <= target) apply(state.timeline[state.i++], true);
  state.playhead = target;
  const last = state.timeline[state.i - 1];
  $('#clock-t').textContent = secs(last?.t ?? 0);
  $('#scrub-fill').style.transform = `scaleX(${fraction})`;
}

async function boot() {
  try {
    const r = await fetch('demo/session.json');
    if (!r.ok) throw new Error(String(r.status));
    state.session = await r.json();
  } catch {
    $('#note').textContent = 'No recorded session found. Record one with: npm run seed -- --record public/demo';
    $('#play').disabled = true;
    return;
  }
  $('#model-id').textContent = state.session.model?.model ?? 'turn.ts';
  $('#replay-pick').innerHTML = state.session.replays.map((r, i) => `<option value="${i}">${esc(r.message)}</option>`).join('');
  choose(0);

  $('#replay-pick').addEventListener('change', (e) => {
    state.playing = false;
    $('#play').textContent = 'Play';
    choose(Number(e.target.value));
  });
  $('#play').addEventListener('click', () => {
    if (state.i >= state.timeline.length) choose(Number($('#replay-pick').value));
    state.playing = !state.playing;
    $('#play').textContent = state.playing ? 'Pause' : 'Play';
    $('#play').setAttribute('aria-pressed', String(state.playing));
  });
  $('#speed').addEventListener('click', () => {
    state.speed = state.speed === 1 ? 2 : state.speed === 2 ? 4 : 1;
    $('#speed').textContent = `${state.speed}×`;
  });
  $('#realtime').addEventListener('change', () => {
    const fraction = state.playhead / Math.max(state.timeline.at(-1)?.at ?? 1, 1);
    buildTimeline();
    seek(Math.min(fraction, 1));
  });
  $('#scrub').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1));
  });

  // Start on its own once the stage is on screen: the page's one moving demo.
  const io = new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting) && !state.playing && state.i === 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      state.playing = true;
      $('#play').textContent = 'Pause';
      $('#play').setAttribute('aria-pressed', 'true');
      io.disconnect();
    }
  }, { threshold: 0.4 });
  io.observe($('.stage'));
  state.last = performance.now();
  requestAnimationFrame(frame);
}

boot();
