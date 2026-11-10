/**
 * Seed memory with real, time-travelled conversations, so the questions this
 * agent is built for ("On Monday we shortlisted...", "Last Tuesday I asked
 * you...") have something to point at on a fresh install.
 *
 *   npm run seed                      add two past conversations to ./data
 *   npm run seed -- --record docs/demo  also ask the follow-up questions now,
 *                                       and record every event for the Pages demo
 *
 * Nothing here is invented: each seeded conversation is a real agent run with
 * the clock moved back. Web search cannot time-travel, so a seeded "last
 * Tuesday" answer reflects the web as of today, and the conversation is
 * flagged `simulated` everywhere it shows.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config, setupProblems } from '../src/config.ts';
import { LlmClient } from '../src/llm/client.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { Recaller } from '../src/memory/recall.ts';
import { TavilySearch } from '../src/search/tavily.ts';
import { runTurn, type AgentEvent } from '../src/agent/turn.ts';
import { addDays, dayKey, tzOffsetMinutes, weekday, type DayKey } from '../src/time.ts';

const args = process.argv.slice(2);
const recordDir = args.includes('--record') ? args[args.indexOf('--record') + 1] : undefined;
const tz = process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

const problems = setupProblems();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

/** The most recent given weekday strictly before today. */
function lastWeekday(today: DayKey, wd: number): DayKey {
  let d = addDays(today, -1);
  while (weekday(d) !== wd) d = addDays(d, -1);
  return d;
}

/** A wall-clock time on a day in the user's zone, as an instant. */
function at(day: DayKey, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h, m));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60_000);
}

const now = new Date();
const today = dayKey(now, tz);
const tuesday = lastWeekday(today, 2);
const monday = lastWeekday(today, 1);
const longDate = (d: DayKey) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

const seeds = [
  {
    when: at(tuesday, '14:05'),
    text: 'What is the cheapest managed Postgres hosting for a five-person startup? Compare Neon, Supabase, Render and Railway on price.',
  },
  {
    when: at(monday, '11:20'),
    text: 'Shortlist 5 CRM tools for a 20-person sales team, with current per-seat prices.',
  },
];

const followUps = [
  { label: `Recheck what I asked on ${longDate(tuesday)}`, text: `What did I ask you on ${longDate(tuesday)}? Is your answer still correct today?` },
  { label: 'Did any CRM change since Monday?', text: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?' },
  { label: 'Postgres prices since last Tuesday', text: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?' },
  { label: 'What did I ask on Saturday?', text: 'What did I ask you on Saturday?' },
];

const dataDir = recordDir ? await mkdtemp(path.join(tmpdir(), 'hindsight-record-')) : config.dataDir;
const store = await new MemoryStore(dataDir).load();
const deps = { store, recaller: new Recaller(store), llm: new LlmClient(config.llm!), search: new TavilySearch(config.tavilyKey!) };

// Free tiers allow a handful of requests a minute, and one turn makes two or three.
const PACE_MS = Number(process.env.SEED_PACE_MS ?? 15_000);
let turnsRun = 0;

/** A recording should not keep a rate-limit error: retry the turn after a pause. */
async function turn(text: string, when: Date, simulated: boolean) {
  for (let attempt = 1; ; attempt++) {
    const r = await turnOnce(text, when, simulated);
    const failed = r.events.some((x) => x.e.type === 'error');
    if (!failed || attempt >= 3) return r;
    console.log(`  (failed, retrying in 60 s)`);
    await store.delete(r.conversationId);
    await new Promise((res) => setTimeout(res, 60_000));
  }
}

async function turnOnce(text: string, when: Date, simulated: boolean) {
  if (turnsRun++) await new Promise((r) => setTimeout(r, PACE_MS));
  const events: Array<{ t: number; e: AgentEvent }> = [];
  const started = Date.now();
  let conversationId = '';
  await runTurn(deps, { text, now: when, tz, simulated }, (e) => {
    events.push({ t: Date.now() - started, e });
    if (e.type === 'start') conversationId = e.conversationId;
    if (e.type === 'text') process.stdout.write(e.text);
    if (e.type === 'search') console.log(`\n  [search] ${e.queries.join(' | ')}${e.since ? ` since ${e.since}` : ''}`);
    if (e.type === 'error') console.error(`\n  [error] ${e.message}`);
  });
  console.log(`\n  (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
  return { conversationId, events };
}

console.log(`Seeding as ${tz}. Today is ${today}; "last Tuesday" is ${tuesday}, "Monday" is ${monday}.\n`);
for (const s of seeds) {
  console.log(`> [${s.when.toISOString()}] ${s.text}\n`);
  await turn(s.text, s.when, true);
}

if (!recordDir) {
  console.log(`Seeded ${seeds.length} conversations into ${dataDir}. Start the app and try:`);
  for (const f of followUps) console.log(`  - ${f.text}`);
  process.exit(0);
}

const seededIds = new Set(store.all().map((c) => c.id));
const replays = [];
for (const f of followUps) {
  console.log(`> [now] ${f.text}\n`);
  const r = await turn(f.text, new Date(), false);
  replays.push({ label: f.label, message: f.text, conversationId: r.conversationId, events: r.events });
}

const session = {
  recordedAt: now.toISOString(),
  tz,
  model: { provider: config.llm!.label, model: config.llm!.model },
  note: 'Recorded from real runs. The two earlier conversations ran with the clock moved back; web search always sees the day of recording.',
  conversations: store.all().map((c) => ({ ...c, hiddenUntilReplayed: !seededIds.has(c.id) || undefined })),
  replays,
};
await mkdir(recordDir, { recursive: true });
await writeFile(path.join(recordDir, 'session.json'), JSON.stringify(session));
console.log(`Recorded ${replays.length} replays to ${path.join(recordDir, 'session.json')}`);
