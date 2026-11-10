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
import { startCosmos } from './cosmos.js';

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
  const sim = clock.simulated();
  $('#clock-button').toggleAttribute('data-simulated', sim);
  const label = $('#clock-label');
  label.toggleAttribute('data-simulated', sim);
  label.textContent = sim ? `Pretending it is ${dayLabel(now)}, ${formatTime(now)}` : dayLabel(now, true);
}

function paintModel() {
  const s = state.status;
  const line = $('#model-line');
  if (!s) return (line.textContent = '');
  const chip = $('#model-chip');
  if (s.replay) {
    line.textContent = s.recorded ? 'Recorded demo: real answers, replayed' : 'Demo';
    chip.textContent = s.model?.model ?? '';
    return;
  }
  line.textContent = s.model ? `${s.model.provider} with ${s.search ?? 'no'} search` : 'Not configured yet';
  chip.textContent = s.model?.model ?? '';
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
      return `<section class="day"${rel === 'today' ? ' data-today' : ''}><h3><time datetime="${dayKey(items[0].updatedAt)}">${formatDay(items[0].updatedAt)}</time><span>${rel}</span></h3><ul>${rows}</ul></section>`;
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
  for (const b of document.querySelectorAll('[data-action="toggle-memory"]')) b.setAttribute('aria-expanded', String(next));
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

/* Views: welcome (composer centred, vortex wide) and chat (composer docked). */
function setView(view) {
  const body = document.body;
  if (body.dataset.view === view) return;
  const composer = $('#composer');
  const from = composer.getBoundingClientRect();
  body.dataset.view = view;
  // FLIP: the composer glides from where it was to where it now sits; the vortex follows it.
  const to = composer.getBoundingClientRect();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !from.width) return;
  composer.animate(
    [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }],
    { duration: 620, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

async function paintWelcome() {
  const s = state.status;
  setView('welcome');
  thread().innerHTML = '';
  const hero = $('#hero');
  const startersEl = $('#starters');
  startersEl.innerHTML = '';
  if (s && !s.ready) {
    hero.innerHTML = `<h1>Two free keys, then ask away</h1>
      <p>Hindsight needs a model and a search engine. Both have free tiers, no card needed.</p>
      <ol class="setup-steps">
        <li>1. A Gemini key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a></li>
        <li>2. A Tavily key from <a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer">app.tavily.com</a></li>
        <li>3. <code>cp .env.example .env</code>, paste both, restart <code>npm run dev</code></li>
      </ol>
      ${s.problems.map((p) => `<p class="problem">${esc(p)}</p>`).join('')}`;
    setComposer({ disabled: true });
    return;
  }
  if (s?.replay && !s.recorded) {
    hero.innerHTML = `<h1>The demo is on its way</h1>
      <p>This page replays real Hindsight answers with no server; the first session is not recorded yet. Run it yourself with two free keys: <code>npm install</code>, add keys to <code>.env</code>, <code>npm run dev</code>.</p>`;
    setComposer({ disabled: true });
    return;
  }
  hero.innerHTML = `<h1>It remembers what it told you</h1>
    <p>Ask anything current. Every answer is searched, cited and dated, so later you can ask whether it still holds.</p>`;
  const list = await starters();
  startersEl.innerHTML = list.map(([label, q], i) => `<li style="--i:${i}"><button class="starter" type="button" data-ask="${esc(q)}" title="${esc(q)}">${esc(label)}</button></li>`).join('');
  setComposer({ disabled: false });
}

function turnShell(user) {
  return el(`<article class="turn">
    <header class="turn__q"><time class="turn__time" datetime="${esc(user.at)}" title="${esc(formatDay(user.at))}">${formatTime(user.at)}</time><h2 class="turn__ask">${esc(user.content)}</h2></header>
    <ol class="pipe" aria-label="What the agent did">
      <li data-step="recall"><span class="pipe__name">recall</span><span class="pipe__meta"></span></li>
      <li data-step="search"><span class="pipe__name">search</span><span class="pipe__meta"></span></li>
      <li data-step="answer"><span class="pipe__name">answer</span><span class="pipe__meta"></span></li>
      <li data-step="remember"><span class="pipe__name">remember</span><span class="pipe__meta"></span></li>
    </ol>
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

/** Light one step of the pipeline: idle, active, done, skipped or failed, with a mono readout. */
function step(turn, name, stateName, meta) {
  const li = turn.querySelector(`.pipe [data-step="${name}"]`);
  if (!li) return;
  li.dataset.state = stateName;
  if (meta !== undefined) {
    const m = li.querySelector('.pipe__meta');
    m.textContent = meta;
    m.title = meta;
  }
}

const queriesHtml = (queries, since) => `${queries.map((q) => `<q>${esc(q)}</q>`).join(', ')}${since ? `, published since ${esc(since)}` : ''}`;

function paintFoot(turn, message, claims) {
  const foot = turn.querySelector('.turn__foot');
  foot.innerHTML = '';
  const sources = message.sources ?? [];
  const cited = citedNumbers(message.content);
  const citedSources = sources.filter((s) => cited.has(s.n));

  // The row under every answer: cited sources as chips, and a copy action.
  const chips = citedSources
    .map((s) => `<a class="chip" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}"><span class="chip__n">${s.n}</span>${esc(s.domain)}</a>`)
    .join('');
  foot.append(
    el(`<div class="answer-row">${chips ? `<div class="chips" aria-label="Sources cited">${chips}</div>` : ''}<button class="ghost ghost--small" type="button" data-copy>Copy</button></div>`),
  );
  foot.querySelector('[data-copy]').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try {
      await navigator.clipboard.writeText(message.content);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Copy failed';
    }
    setTimeout(() => (b.textContent = 'Copy'), 2500);
  });

  if (sources.length) {
    foot.append(
      el(`<details class="fold sources"><summary>sources<span class="fold__meta">${citedSources.length} cited, ${sources.length} read</span></summary><div class="fold__body">${sourcesTable(sources, cited)}</div></details>`),
    );
  }
  if (claims?.length) {
    foot.append(
      el(`<details class="fold ledger" open><summary>remembered<span class="fold__meta">${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}, as of ${esc(formatDay(claims[0].asOf + 'T12:00:00'))}</span></summary>
        <div class="fold__body"><p class="ledger__note">Ask later whether these still hold, and I will check each one again.</p>${ledgerTable(claims, domainOf)}</div></details>`),
    );
  }
}

/** When an answer completes, its table rows settle in one after another. */
function settle(turn) {
  turn.querySelectorAll('.answer tbody tr').forEach((tr, i) => tr.style.setProperty('--r', String(i)));
  turn.classList.add('is-settled');
}

function paintStoredTurn(user, answer, conversation) {
  const turn = turnShell(user);
  if (answer) {
    const recalled = answer.recalled ?? [];
    const searches = answer.searches ?? [];
    const queries = searches.reduce((n, x) => n + x.queries.length, 0);
    const pages = searches.reduce((n, x) => n + x.results, 0);
    const claims = conversation.claims.filter((k) => k.messageId === answer.id);
    step(turn, 'recall', recalled.length ? 'done' : 'skipped', recalled.length ? `${recalled.length} past` : 'nothing needed');
    step(turn, 'search', searches.length ? 'done' : 'skipped', searches.length ? `${queries} queries, ${pages} pages` : 'not needed');
    step(turn, 'answer', 'done', answer.ms ? seconds(answer.ms) : '');
    step(turn, 'remember', claims.length ? 'done' : 'skipped', claims.length ? `${claims.length} claims` : 'nothing to keep');
    const titles = new Map(state.conversations.map((c) => [c.id, c.title]));
    for (const id of answer.recalled ?? []) {
      trailItem(turn, 'Recalled', `<a href="#/c/${esc(id)}">${esc(titles.get(id) || 'a past conversation')}</a>`);
    }
    for (const s of answer.searches ?? []) {
      trailItem(turn, 'Searched', queriesHtml(s.queries, s.since), s.cached ? 'cached' : `${s.results} pages, ${seconds(s.ms)}`);
    }
    renderAnswer(turn.querySelector('.answer'), answer.content, new Map((answer.sources ?? []).map((s) => [s.n, s])));
    paintFoot(turn, answer, claims);
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
    document.title = 'Hindsight, the agent';
    paintMemory();
    await paintWelcome();
    $('#ask').focus();
    return;
  }
  state.currentId = decodeURIComponent(m[1]);
  setView('chat');
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
    thread().innerHTML = `<div class="failure"><p>Could not load that conversation. Is the server still running?</p><button class="pill" type="button" data-action="reload">Try again</button></div>`;
  }
}

/* Asking ------------------------------------------------------------------ */
function setComposer({ disabled = false, busy = false } = {}) {
  const ask = $('#ask');
  const send = $('#send');
  ask.disabled = disabled;
  send.disabled = disabled;
  send.setAttribute('aria-busy', String(busy));
  send.setAttribute('aria-label', busy ? 'Stop' : 'Ask');
}

const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;

async function ask(text) {
  text = text.trim();
  if (!text || state.busy) return;
  state.busy = true;
  setComposer({ busy: true });
  if (!state.currentId) thread().innerHTML = '';
  setView('chat');

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
  step(turn, 'recall', 'active', 'reading memory');
  let queryCount = 0;
  let pageCount = 0;
  const searchStarted = Date.now();
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
          step(turn, 'recall', ev.hits.length ? 'done' : 'skipped', ev.hits.length ? `${ev.hits.length} past` : ev.windows.length ? 'nothing that day' : 'nothing needed');
          step(turn, 'answer', 'active', 'thinking');
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
          queryCount += ev.queries.length;
          step(turn, 'search', 'active', `${queryCount} ${queryCount === 1 ? 'query' : 'queries'}`);
          step(turn, 'answer', '', '');
          searchRows.set(ev.id, trailItem(turn, 'Searching', queriesHtml(ev.queries, ev.since), '', 'working'));
          break;
        }
        case 'results': {
          for (const s of ev.sources) sources.set(s.n, s);
          pageCount = sources.size;
          step(turn, 'search', ev.error ? 'failed' : 'done', ev.error ? 'failed' : `${queryCount} queries, ${pageCount} pages, ${seconds(Date.now() - searchStarted)}`);
          step(turn, 'answer', 'active', 'writing');
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
          if (turn.querySelector('.pipe [data-step="search"]').dataset.state === undefined) step(turn, 'search', 'skipped', 'not needed');
          step(turn, 'answer', 'active', 'writing');
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
          settle(turn);
          step(turn, 'answer', 'done', seconds(ev.message.ms ?? 0));
          step(turn, 'remember', 'active', 'reading the answer');
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
          step(turn, 'remember', ev.claims?.length ? 'done' : 'skipped', ev.claims?.length ? `${ev.claims.length} claims` : 'nothing to keep');
          await refreshMemory();
          break;
        }
        case 'error': {
          for (const li of turn.querySelectorAll('.pipe [data-state="active"]')) step(turn, li.dataset.step, 'failed', 'failed');
          answerEl.removeAttribute('aria-busy');
          turn.querySelector('.turn__foot').replaceChildren(
            el(`<div class="failure"><p>${esc(ev.message)}</p><button class="pill" type="button" data-retry="${esc(text)}">Try again</button></div>`),
          );
          break;
        }
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      turn.querySelector('.turn__foot').replaceChildren(
        el(`<div class="failure"><p>The connection to the server dropped. Your question was saved.</p><button class="pill" type="button" data-retry="${esc(text)}">Try again</button></div>`),
      );
    }
  } finally {
    answerEl.removeAttribute('aria-busy');
    // A stream that ended without 'remembered' (no claims to keep, or stopped) settles the last step.
    const remember = turn.querySelector('.pipe [data-step="remember"]');
    if (remember.dataset.state === 'active') step(turn, 'remember', 'skipped', 'nothing to keep');
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

/** What the lens bends around: the composer's box, plus state that eases between views. */
function cosmosTarget() {
  const composer = $('#composer');
  const welcome = document.body.dataset.view === 'welcome';
  const focused = composer.matches(':focus-within');
  const goal = {
    lens: welcome ? 2200 : 1000,
    reach: welcome ? 240 : 90,
    glow: welcome ? 1 : 0.55,
    // The flow quickens while the agent works: the sky shows it is thinking.
    energy: state.busy ? 4 : 1,
    focus: focused ? 1 : 0,
  };
  const t = (cosmosTarget.now ??= { ...goal });
  for (const k of Object.keys(goal)) t[k] += (goal[k] - t[k]) * 0.05;
  return { rect: composer.getBoundingClientRect(), radius: parseFloat(getComputedStyle(composer).borderTopLeftRadius) || 26, ...t };
}

async function boot() {
  wire();
  startCosmos($('#cosmos'), cosmosTarget);
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
