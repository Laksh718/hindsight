/**
 * The landing page's live card: real recorded turns (public/demo/session.json),
 * replayed one after another. The question types itself, the pipeline lights
 * as each recorded event arrives, and the answer streams with its real
 * citations. Quiet gaps are shortened; nothing is invented. It plays only
 * while on screen, and under reduced motion it shows a finished answer.
 */
import { renderAnswer } from './render.js';

const q = document.getElementById('live-q');
const out = document.getElementById('live-answer');
const card = document.querySelector('.live');
const steps = (name) => card.querySelector(`[data-step="${name}"]`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
let visible = false;

function setStep(name, state, meta) {
  const li = steps(name);
  if (!li) return;
  if (state) li.dataset.state = state;
  else delete li.dataset.state;
  if (meta !== undefined) li.querySelector('b').textContent = meta;
}

async function until(cond) {
  while (!cond()) await wait(250);
}

async function play(replay) {
  for (const n of ['recall', 'search', 'answer', 'remember']) setStep(n, '', '');
  out.innerHTML = '';
  q.textContent = '';
  // Type the question.
  for (const ch of replay.message) {
    q.textContent += ch;
    await wait(still ? 0 : 22);
  }
  await wait(500);
  const sources = new Map();
  let text = '';
  let last = 0;
  let queries = 0;
  for (const { t, e } of replay.events) {
    await until(() => visible);
    if (!still) await wait(Math.min(t - last, e.type === 'text' ? 120 : 900));
    last = t;
    if (e.type === 'recall') {
      setStep('recall', 'done', e.hits.length ? `${e.hits.length} past, ${e.windows[0]?.label ?? ''}` : e.empty.length ? `nothing on ${e.empty[0]}` : 'nothing needed');
      setStep('answer', 'active', 'thinking');
    } else if (e.type === 'search') {
      queries += e.queries.length;
      setStep('search', 'active', `${queries} queries in parallel`);
    } else if (e.type === 'results') {
      for (const s of e.sources) sources.set(s.n, s);
      setStep('search', 'done', `${queries} queries, ${sources.size} pages`);
      setStep('answer', 'active', 'writing');
    } else if (e.type === 'text') {
      text += e.text;
      renderAnswer(out, text, sources);
    } else if (e.type === 'done') {
      for (const s of e.message.sources ?? []) sources.set(s.n, s);
      renderAnswer(out, e.message.content, sources);
      setStep('answer', 'done', `${(e.message.ms / 1000).toFixed(1)} s`);
      if (!steps('search').dataset.state) setStep('search', 'done', 'not needed');
      setStep('remember', 'active', 'reading the answer');
    } else if (e.type === 'remembered') {
      setStep('remember', 'done', `${e.claims.length} claims`);
    }
  }
  if (steps('remember').dataset.state === 'active') setStep('remember', 'done', 'nothing to keep');
}

async function boot() {
  let session;
  try {
    session = await (await fetch('demo/session.json')).json();
  } catch {
    card.hidden = true;
    return;
  }
  new IntersectionObserver((entries) => (visible = entries.some((x) => x.isIntersecting)), { threshold: 0.25 }).observe(card);
  for (let i = 0; ; i = (i + 1) % session.replays.length) {
    await until(() => visible);
    await play(session.replays[i]);
    await wait(6000);
  }
}

boot();
