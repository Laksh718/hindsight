/**
 * Hindsight UI. Plain ES modules, no build step.
 *
 * The screen is a projection of agent events: every line in an answer's
 * trail (what it recalled, what it searched, how long it took) comes from an
 * event the server emitted, so the UI never pretends to know more than the
 * agent did.
 */
import { LiveApi, ReplayApi } from './api.js';
import { el, esc, renderAnswer, sourcesTable, ledgerTable, citedNumbers } from './render.js';

const $ = (sel) => document.querySelector(sel);
// Same UI, three back ends: this server, a hosted API (data-api), or a recording (data-replay).
const { replay: replayBase, api: apiBase } = document.documentElement.dataset;
const api = replayBase ? new ReplayApi(replayBase) : new LiveApi(apiBase ?? '');
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const state = {
  status: null,
  conversations: [],
  currentId: null,
  busy: false,
  abort: null,
  suppressRoute: false,
};

/* Clock ------------------------------------------------------------------
 * The agent's sense of "now" is an input. Time travel stores a simulated
 * start and lets it tick forward, so a session "on Monday" behaves normally.
 */
const CLOCK_KEY = 'hindsight.clock';
const clock = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(CLOCK_KEY) || 'null');
    } catch {
      return null;
    }
  },
  now() {
    const c = this.read();
    return c ? new Date(new Date(c.at).getTime() + (Date.now() - c.setAt)) : new Date();
  },
  simulated() {
    return !!this.read();
  },
  set(date) {
    try {
      localStorage.setItem(CLOCK_KEY, JSON.stringify({ at: date.toISOString(), setAt: Date.now() }));
    } catch {}
  },
  reset() {
    try {
      localStorage.removeItem(CLOCK_KEY);
    } catch {}
  },
};

/* Dates, in the viewer's zone -------------------------------------------- */
const partsFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
/** "Tue 3 Nov" or "Tue 3 Nov 2026", the same shape the agent uses. */
function dayLabel(d, withYear) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}${withYear ? ` ${p.year}` : ''}`;
}
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d) => keyFmt.format(new Date(d));
const formatDay = (d) => dayLabel(d, new Date(d).getFullYear() !== clock.now().getFullYear());
const formatTime = (d) => timeFmt.format(new Date(d));
function relativeDay(d) {
  const diff = Math.round((new Date(dayKey(clock.now())) - new Date(dayKey(d))) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return '';
}
const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/* The bar ---------------------------------------------------------------- */
function paintClock() {
  const now = clock.now();
  const button = $('#clock-button');
  const sim = clock.simulated();
  button.toggleAttribute('data-simulated', sim);
  $('#clock-label').innerHTML = `${sim ? '<span class="clock__long">Pretending it is </span>' : ''}${dayLabel(now)}<span class="clock__long"> ${now.getFullYear()}${sim ? `, ${formatTime(now)}` : ''}</span>`;
}

function paintModel() {
  const s = state.status;
  const line = $('#model-line');
  if (!s) return (line.textContent = '');
  if (s.replay) return (line.textContent = s.recorded ? 'Recorded demo: replays real answers, no server' : 'Demo');
  line.textContent = s.model ? `${s.model.provider}, ${s.model.model}, with ${s.search ?? 'no'} search` : 'Not configured yet';
}

/* Memory sidebar ----------------------------------------------------------- */
function paintMemory() {
  const list = $('#memory-list');
  list.removeAttribute('aria-busy');
  const convs = state.conversations;
  $('#memory-count').textContent = convs.length ? `${convs.length}` : '';
  if (!convs.length) {
    list.innerHTML = `<p class="memory__empty">Nothing yet. Every conversation lands here under the day it happened, so you can ask about it later.</p>`;
    return;
  }
  const byDay = new Map();
  for (const c of convs) {
    const k = dayKey(c.updatedAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(c);
  }
  list.innerHTML = [...byDay.values()]
    .map((items) => {
      const rel = relativeDay(items[0].updatedAt);
      const rows = items
        .map(
          (c) => `<li><a class="conv" href="#/c/${esc(c.id)}" ${c.id === state.currentId ? 'aria-current="page"' : ''}>
            <span class="conv__title">${esc(c.title || 'Untitled')}</span>
            <span class="conv__time">${formatTime(c.updatedAt)}</span>
            ${c.simulated ? '<span class="conv__sim">time-travelled</span>' : ''}
          </a></li>`,
        )
        .join('');
      return `<section class="day"><h3><time datetime="${dayKey(items[0].updatedAt)}">${formatDay(items[0].updatedAt)}</time><span>${rel}</span></h3><ul>${rows}</ul></section>`;
    })
    .join('');
}

async function refreshMemory() {
  try {
    state.conversations = await api.conversations();
    paintMemory();
  } catch {
    $('#memory-list').innerHTML = `<p class="memory__error">Could not load memory. Is the server still running?</p>`;
  }
}

function toggleDrawer(open) {
  const m = $('#memory');
  const next = open ?? !m.hasAttribute('data-open');
  m.toggleAttribute('data-open', next);
  $('[data-action="toggle-memory"]').setAttribute('aria-expanded', String(next));
}

/* The thread -------------------------------------------------------------- */
const thread = () => $('#thread');

/** Suggested first questions: a short label, and the full question it asks. */
async function starters() {
  if (!api.live) return (await api.scripts()).map((r) => [r.label ?? r.message, r.message]);
  const base = [
    ['Compare Postgres hosting prices', 'Compare managed Postgres hosting prices for a five-person team.'],
    ['Shortlist CRMs for a sales team', 'Shortlist 5 CRM tools for a 20-person sales team, with current prices.'],
    ['This month in AI model releases', 'What were the biggest AI model releases this month?'],
  ];
  // Offer to look back at the most recent day that is not today.
  const today = dayKey(clock.now());
  const latest = state.conversations.find((c) => dayKey(c.createdAt) < today);
  if (!latest) return base;
  const when = relativeDay(latest.createdAt) === 'yesterday' ? 'yesterday' : `on ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' }).format(new Date(latest.createdAt))}`;
  const label = when === 'yesterday' ? 'Recheck what I asked yesterday' : `Recheck what I asked ${when}`;
  return [[label, `What did I ask you ${when}? Is your answer still correct today?`], ...base.slice(0, 2)];
}

async function paintWelcome() {
  const s = state.status;
  if (s && !s.ready) {
    thread().innerHTML = `<section class="welcome setup">
      <h1>Two free keys, then ask away</h1>
      <p class="lead">Hindsight needs a model and a search engine. Both have free tiers, no card needed.</p>
      <ol>
        <li>Get a Gemini key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a></li>
        <li>Get a Tavily key at <a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer">app.tavily.com</a></li>
        <li>Run <code>cp .env.example .env</code>, paste both keys in, and restart <code>npm run dev</code></li>
      </ol>
      ${s.problems.map((p) => `<p class="setup__problem">${esc(p)}</p>`).join('')}
    </section>`;
    setComposer({ disabled: true });
    return;
  }
  if (s?.replay && !s.recorded) {
    thread().innerHTML = `<section class="welcome setup">
      <h1>The recorded demo is on its way</h1>
      <p class="lead">This page replays real Hindsight answers with no server. The first session has not been recorded yet. Meanwhile, run it yourself with two free keys.</p>
      <ol>
        <li><code>git clone https://github.com/Laksh718/hindsight</code></li>
        <li><code>npm install</code>, then <code>cp .env.example .env</code> and add a Gemini and a Tavily key</li>
        <li><code>npm run dev</code> and open <code>localhost:3000</code></li>
      </ol>
      <p>How it works: <a href="https://github.com/Laksh718/hindsight/blob/main/DESIGN.md">DESIGN.md</a></p>
    </section>`;
    setComposer({ disabled: true });
    return;
  }
  const list = await starters();
  thread().innerHTML = `<section class="welcome">
    <h1>What should I look up?</h1>
    <p class="lead">I search the web and cite every source. I also keep a dated record of what I told you, so you can ask later whether it still holds.</p>
    <ul class="starters">${list.map(([label, q]) => `<li><button class="starter" type="button" data-ask="${esc(q)}" title="${esc(q)}">${esc(label)}</button></li>`).join('')}</ul>
  </section>`;
  setComposer({ disabled: false });
}

function turnShell(user) {
  return el(`<article class="turn">
    <header class="turn__q"><time class="turn__time" datetime="${esc(user.at)}" title="${esc(formatDay(user.at))}">${formatTime(user.at)}</time><h2 class="turn__ask">${esc(user.content)}</h2></header>
    <ol class="trail"></ol>
    <div class="prose answer"></div>
    <div class="turn__foot"></div>
  </article>`);
}

function trailItem(turn, verb, whatHtml, meta = '', stateName = '') {
  const li = el(`<li${stateName ? ` data-state="${stateName}"` : ''}><span class="trail__verb">${esc(verb)}</span><span class="trail__what">${whatHtml}</span><span class="trail__meta">${esc(meta)}</span></li>`);
  turn.querySelector('.trail').append(li);
  return li;
}

const queriesHtml = (queries, since) => `${queries.map((q) => `<q>${esc(q)}</q>`).join(', ')}${since ? `, published since ${esc(since)}` : ''}`;

function paintFoot(turn, message, claims) {
  const foot = turn.querySelector('.turn__foot');
  foot.innerHTML = '';
  const sources = message.sources ?? [];
  if (sources.length) {
    const cited = citedNumbers(message.content);
    const citedCount = sources.filter((s) => cited.has(s.n)).length;
    foot.append(
      el(`<details class="fold sources"><summary>Sources<span class="fold__meta">${citedCount} cited, ${sources.length} read</span></summary><div class="fold__body">${sourcesTable(sources, cited)}</div></details>`),
    );
  }
  if (claims?.length) {
    foot.append(
      el(`<details class="fold ledger" open><summary>Remembered<span class="fold__meta">${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}, as of ${esc(formatDay(claims[0].asOf + 'T12:00:00'))}</span></summary>
        <div class="fold__body"><p class="ledger__note">Ask later whether these still hold, and I will check each one again.</p>${ledgerTable(claims, domainOf)}</div></details>`),
    );
  }
}

function paintStoredTurn(user, answer, conversation) {
  const turn = turnShell(user);
  if (answer) {
    const titles = new Map(state.conversations.map((c) => [c.id, c.title]));
    for (const id of answer.recalled ?? []) {
      trailItem(turn, 'Recalled', `<a href="#/c/${esc(id)}">${esc(titles.get(id) || 'a past conversation')}</a>`);
    }
    for (const s of answer.searches ?? []) {
      trailItem(turn, 'Searched', queriesHtml(s.queries, s.since), s.cached ? 'cached' : `${s.results} pages, ${seconds(s.ms)}`);
    }
    if (answer.ms) trailItem(turn, 'Answered', `${formatDay(answer.at)}, ${formatTime(answer.at)}`, seconds(answer.ms));
    renderAnswer(turn.querySelector('.answer'), answer.content, new Map((answer.sources ?? []).map((s) => [s.n, s])));
    paintFoot(turn, answer, conversation.claims.filter((k) => k.messageId === answer.id));
  }
  return turn;
}

function paintConversation(c) {
  const root = thread();
  root.innerHTML = '';
  for (let i = 0; i < c.messages.length; i++) {
    const m = c.messages[i];
    if (m.role !== 'user') continue;
    const next = c.messages[i + 1]?.role === 'assistant' ? c.messages[i + 1] : null;
    root.append(paintStoredTurn(m, next, c));
  }
  document.title = `${c.title || 'Conversation'}, Hindsight`;
}

/* Routing: #/ is a new conversation, #/c/<id> an existing one ------------- */
async function route() {
  if (state.suppressRoute) {
    state.suppressRoute = false;
    return;
  }
  toggleDrawer(false);
  const m = location.hash.match(/^#\/c\/(.+)$/);
  if (state.abort) state.abort.abort();
  if (!m) {
    state.currentId = null;
    document.title = 'Hindsight';
    paintMemory();
    await paintWelcome();
    $('#ask').focus();
    return;
  }
  state.currentId = decodeURIComponent(m[1]);
  paintMemory();
  thread().innerHTML = `<div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>`;
  try {
    const c = await api.conversation(state.currentId);
    if (!c) {
      thread().innerHTML = `<section class="welcome"><h1>That conversation is gone</h1><p class="lead">It may have been deleted. Start a new one, or pick another from memory.</p></section>`;
      return;
    }
    paintConversation(c);
    window.scrollTo({ top: document.body.scrollHeight });
  } catch {
    thread().innerHTML = `<div class="failure"><p>Could not load that conversation. Is the server still running?</p><button class="btn" type="button" data-action="reload">Try again</button></div>`;
  }
}

/* Asking ------------------------------------------------------------------ */
function setComposer({ disabled = false, busy = false } = {}) {
  const ask = $('#ask');
  const send = $('#send');
  ask.disabled = disabled;
  send.disabled = disabled;
  send.textContent = busy ? 'Stop' : 'Ask';
  send.classList.toggle('btn--primary', !busy);
  send.classList.toggle('btn--quiet', busy);
  send.setAttribute('aria-busy', String(busy));
}

const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;

async function ask(text) {
  text = text.trim();
  if (!text || state.busy) return;
  state.busy = true;
  setComposer({ busy: true });
  if (!state.currentId) thread().innerHTML = '';

  const now = clock.now();
  const turn = turnShell({ content: text, at: now.toISOString() });
  thread().append(turn);
  turn.scrollIntoView({ block: 'start', behavior: 'smooth' });

  const answerEl = turn.querySelector('.answer');
  const sources = new Map();
  const searchRows = new Map();
  let draft = '';
  let frame = 0;
  const paint = () => {
    frame = 0;
    const follow = nearBottom();
    renderAnswer(answerEl, draft, sources);
    if (follow) window.scrollTo({ top: document.documentElement.scrollHeight });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  answerEl.setAttribute('aria-busy', 'true');
  const working = trailItem(turn, 'Reading', 'memory and the question', '', 'working');
  const ac = new AbortController();
  state.abort = ac;

  try {
    for await (const ev of api.chat({ conversationId: state.currentId, message: text, now: clock.simulated() ? now.toISOString() : undefined, tz, signal: ac.signal })) {
      switch (ev.type) {
        case 'start': {
          if (state.currentId !== ev.conversationId) {
            state.currentId = ev.conversationId;
            state.suppressRoute = true;
            location.hash = `#/c/${ev.conversationId}`;
          }
          turn.querySelector('.turn__time').textContent = formatTime(ev.user.at);
          break;
        }
        case 'recall': {
          working.remove();
          for (const w of ev.windows) {
            trailItem(turn, w.alternative ? 'Or' : 'Dated', `<q>${esc(w.phrase)}</q> as ${esc(w.label)}`);
          }
          const verbs = { 'near-date': 'Nearest', related: 'Related' };
          for (const h of ev.hits) {
            trailItem(turn, verbs[h.why] ?? 'Recalled', `<a href="#/c/${esc(h.id)}">${esc(h.title)}</a>, ${esc(h.days.join(', '))}`);
          }
          for (const e of ev.empty) trailItem(turn, 'Memory', `nothing on ${esc(e)}`);
          break;
        }
        case 'search': {
          searchRows.set(ev.id, trailItem(turn, 'Searching', queriesHtml(ev.queries, ev.since), '', 'working'));
          break;
        }
        case 'results': {
          for (const s of ev.sources) sources.set(s.n, s);
          const row = searchRows.get(ev.id);
          if (row) {
            row.removeAttribute('data-state');
            row.querySelector('.trail__verb').textContent = 'Searched';
            if (ev.error) {
              row.dataset.state = 'failed';
              row.querySelector('.trail__meta').textContent = 'failed';
              row.querySelector('.trail__what').insertAdjacentHTML('beforeend', `. ${esc(ev.error)}`);
            } else {
              row.querySelector('.trail__meta').textContent = ev.cached ? 'cached' : `${ev.sources.length} pages, ${seconds(ev.ms)}`;
            }
          }
          break;
        }
        case 'aside': {
          draft = '';
          answerEl.innerHTML = '';
          trailItem(turn, 'Note', `<span class="trail__aside">${esc(ev.text.trim())}</span>`);
          break;
        }
        case 'text': {
          working.remove();
          draft += ev.text;
          schedule();
          break;
        }
        case 'done': {
          if (frame) cancelAnimationFrame(frame);
          draft = ev.message.content;
          for (const s of ev.message.sources ?? []) sources.set(s.n, s);
          renderAnswer(answerEl, draft, sources);
          answerEl.removeAttribute('aria-busy');
          trailItem(turn, 'Answered', '', seconds(ev.message.ms ?? 0));
          paintFoot(turn, ev.message, []);
          turn.dataset.messageId = ev.message.id;
          $('#announcer').textContent = 'Answer ready.';
          state.busy = false;
          setComposer();
          break;
        }
        case 'remembered': {
          const done = { content: draft, sources: [...sources.values()] };
          if (ev.claims?.length) paintFoot(turn, done, ev.claims);
          await refreshMemory();
          break;
        }
        case 'error': {
          working.remove();
          answerEl.removeAttribute('aria-busy');
          turn.querySelector('.turn__foot').replaceChildren(
            el(`<div class="failure"><p>${esc(ev.message)}</p><button class="btn" type="button" data-retry="${esc(text)}">Try again</button></div>`),
          );
          break;
        }
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      turn.querySelector('.turn__foot').replaceChildren(
        el(`<div class="failure"><p>The connection to the server dropped. Your question was saved.</p><button class="btn" type="button" data-retry="${esc(text)}">Try again</button></div>`),
      );
    }
  } finally {
    working.remove();
    answerEl.removeAttribute('aria-busy');
    state.busy = false;
    state.abort = null;
    setComposer();
    refreshMemory();
  }
}

/* Wiring ------------------------------------------------------------------ */
function wire() {
  const input = $('#ask');
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) {
      state.abort?.abort();
      return;
    }
    const text = input.value;
    input.value = '';
    ask(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ask], [data-retry], [data-action]');
    if (!t) return;
    if (t.dataset.ask) ask(t.dataset.ask);
    else if (t.dataset.retry) {
      t.closest('.turn')?.remove();
      ask(t.dataset.retry);
    } else if (t.dataset.action === 'toggle-memory') toggleDrawer();
    else if (t.dataset.action === 'reload') route();
    else if (t.dataset.action === 'clock-reset') {
      clock.reset();
      paintClock();
      paintMemory();
      $('#clock-panel').hidePopover?.();
    }
  });

  const panel = $('#clock-panel');
  panel.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    const d = clock.now();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('#clock-input').value = local;
  });
  $('#clock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#clock-input').value;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return;
    if (Math.abs(d.getTime() - Date.now()) < 120_000) clock.reset();
    else clock.set(d);
    paintClock();
    paintMemory();
    panel.hidePopover?.();
  });

  window.addEventListener('hashchange', route);
  setInterval(paintClock, 30_000);
}

async function boot() {
  wire();
  paintClock();
  try {
    state.status = await api.status();
  } catch {
    state.status = { ready: false, problems: ['Cannot reach the Hindsight server. Start it with npm run dev.'] };
  }
  paintModel();
  await refreshMemory();
  await route();
}

boot();
