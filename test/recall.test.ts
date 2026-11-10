import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.ts';
import { Recaller } from '../src/memory/recall.ts';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T16:00:00Z'); // Tue 10 Nov 2026
let store: MemoryStore;
let recaller: Recaller;
const ids: Record<string, string> = {};

async function seed(key: string, at: string, title: string, asked: string, subjects: string[] = []) {
  const c = await store.create({ at, tz: TZ });
  await store.addMessage(c.id, { role: 'user', content: asked, at });
  await store.addMessage(c.id, { role: 'assistant', content: 'answer', at });
  await store.annotate(c.id, {
    title,
    summary: title,
    claims: subjects.map((s) => ({ subject: s, attribute: 'price', value: '$1', messageId: 'm', asOf: at.slice(0, 10) })),
  });
  ids[key] = c.id;
}

before(async () => {
  store = await new MemoryStore(await mkdtemp(path.join(tmpdir(), 'hindsight-'))).load();
  recaller = new Recaller(store);
  await seed('postgres', '2026-11-03T08:00:00Z', 'Managed Postgres hosting prices', 'Cheapest managed Postgres hosting for a small team?', ['Neon', 'Supabase']);
  await seed('crm', '2026-11-09T06:00:00Z', 'CRM shortlist for a 20-person sales team', 'Shortlist 5 CRM tools for a 20-person sales team', ['HubSpot', 'Pipedrive']);
  await seed('recipe', '2026-11-05T12:00:00Z', 'Weeknight dal recipe', 'Give me a quick dal recipe');
  // Written "after" NOW: invisible to a turn running at NOW (time travel).
  await seed('future', '2026-11-12T12:00:00Z', 'Postgres backups', 'How do Postgres backups work?');
});

const recall = (text: string, now = NOW) => recaller.recall({ text, now, tz: TZ });
const hitIds = (r: ReturnType<typeof recall>) => r.hits.map((h) => `${Object.keys(ids).find((k) => ids[k] === h.conversation.id)}:${h.why}`);

test('a named day recalls what happened that day', () => {
  assert.deepEqual(hitIds(recall('What did I ask you on 3 November? Is your answer still correct today?')), ['postgres:date']);
  assert.deepEqual(hitIds(recall('On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?')), ['crm:date']);
  assert.deepEqual(hitIds(recall('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?')), ['postgres:date']);
});

test('an empty day is reported, with the nearest days offered instead', () => {
  const r = recall('What did I ask you on Saturday?'); // Sat 7 Nov: nothing
  assert.equal(r.emptyWindows.length, 1);
  assert.deepEqual(hitIds(r), ['crm:near-date', 'recipe:near-date']); // tie on distance: most recent first
});

test('look-back cues without a date use topic', () => {
  assert.deepEqual(hitIds(recall('You recommended a Postgres host, is that still the cheapest?')), ['postgres:topic']);
});

test('a new question on an old topic brings the old answer along', () => {
  const r = recall('Which managed Postgres hosting is best for a startup?');
  assert.equal(r.lookingBack, false);
  assert.deepEqual(hitIds(r), ['postgres:related']);
});

test('unrelated questions recall nothing', () => {
  assert.deepEqual(hitIds(recall('What is the capital of Australia?')), []);
});

test('memory never leaks from the future of the turn clock', () => {
  const r = recall('What did you tell me about Postgres backups?');
  assert.ok(!hitIds(r).includes('future:topic'));
});
