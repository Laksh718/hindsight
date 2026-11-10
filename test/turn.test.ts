/**
 * The whole turn, with a scripted model and a fake search engine.
 * Proves the loop, the events, citations and the ledger without network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.ts';
import { Recaller } from '../src/memory/recall.ts';
import { runTurn, type AgentEvent } from '../src/agent/turn.ts';
import type { ChatMessage, LlmClient, StreamEvent } from '../src/llm/client.ts';
import type { SearchProvider } from '../src/search/tavily.ts';

const TZ = 'Asia/Kolkata';

/** A model that plays back a script, one entry per call, and records what it was sent. */
function scriptedModel(script: Array<StreamEvent[]>, ledgerJson: string) {
  const seen: ChatMessage[][] = [];
  const model = {
    cfg: { provider: 'test', label: 'Test', baseUrl: 'http://x', apiKey: 'k', model: 'm', fastModel: 'f' },
    async *stream(opts: { messages: ChatMessage[] }) {
      seen.push(structuredClone(opts.messages));
      for (const ev of script.shift() ?? []) yield ev;
    },
    async complete() {
      return ledgerJson;
    },
  };
  return { model: model as unknown as LlmClient, seen };
}

const fakeSearch: SearchProvider & { calls: string[] } = {
  calls: [],
  async search(q, opts) {
    this.calls.push(`${q}${opts?.since ? ` since ${opts.since}` : ''}`);
    return {
      cached: false,
      hits: [
        { url: `https://example.com/${encodeURIComponent(q)}`, title: `About ${q}`, content: `${q}: costs $15 per month.`, published: '2026-11-08' },
        { url: 'https://shared.example.com/pricing', title: 'Shared page', content: 'Shared content.' },
      ],
    };
  },
};

test('search, cite, answer, remember; then recall it a week later', async () => {
  const store = await new MemoryStore(await mkdtemp(path.join(tmpdir(), 'hindsight-'))).load();
  const recaller = new Recaller(store);

  // Turn 1, on Tue 3 Nov: the model searches two things in parallel, then answers.
  const first = scriptedModel(
    [
      [
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_calls',
          calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"queries":["Neon pricing","Supabase pricing"]}' } }],
        },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [
        { type: 'text', text: 'Neon is $15 a month [1]; ' },
        { type: 'text', text: 'Supabase is $25 [3].' },
        { type: 'finish', reason: 'stop' },
      ],
    ],
    JSON.stringify({ title: 'Postgres hosting prices', summary: 'Compared Neon and Supabase prices.', claims: [{ subject: 'Neon', attribute: 'Launch price', value: '$15 per month', source: 1 }] }),
  );
  const events: AgentEvent[] = [];
  await runTurn(
    { store, recaller, llm: first.model, search: fakeSearch },
    { text: 'Cheapest managed Postgres hosting?', now: new Date('2026-11-03T08:00:00Z'), tz: TZ },
    (e) => events.push(e),
  );

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['start', 'recall', 'text', 'aside', 'search', 'results', 'text', 'text', 'done', 'remembered']);
  assert.deepEqual(fakeSearch.calls, ['Neon pricing', 'Supabase pricing']);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done?.type === 'done');
  assert.equal(done.message.content, 'Neon is $15 a month [1]; Supabase is $25 [3].'); // the "Let me check." aside is not the answer
  // The shared page appears in both queries but gets one number.
  assert.deepEqual(done.message.sources!.map((s) => s.n), [1, 2, 3]);

  // The tool result went back to the model with the call's id.
  const toolMsg = first.seen[1]!.find((m) => m.role === 'tool');
  assert.ok(toolMsg && toolMsg.role === 'tool' && toolMsg.tool_call_id === 'c1');
  assert.match(toolMsg.content, /\[2\] Shared page/);
  assert.match(toolMsg.content, /already shown above/);

  const conv = store.all()[0]!;
  assert.equal(conv.title, 'Postgres hosting prices');
  assert.equal(conv.claims[0]!.source, 'https://example.com/Neon%20pricing');
  assert.equal(conv.claims[0]!.asOf, '2026-11-03');

  // Turn 2, a week later, new conversation: "last Tuesday" must bring turn 1 into the prompt.
  const second = scriptedModel([[{ type: 'text', text: 'On Tue 3 Nov you asked about Postgres hosting.' }, { type: 'finish', reason: 'stop' }]], '{}');
  const later: AgentEvent[] = [];
  await runTurn(
    { store, recaller, llm: second.model, search: fakeSearch },
    { text: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', now: new Date('2026-11-10T16:00:00Z'), tz: TZ },
    (e) => later.push(e),
  );
  const recall = later.find((e) => e.type === 'recall');
  assert.ok(recall?.type === 'recall');
  assert.deepEqual(recall.hits.map((h) => [h.title, h.why]), [['Postgres hosting prices', 'date']]);

  const system = second.seen[0]![0]!;
  assert.equal(system.role, 'system');
  assert.match(system.content as string, /"Last Tuesday" means Tue 3 Nov 2026/);
  assert.match(system.content as string, /Neon, Launch price: \$15 per month \(example\.com\), as of Tue 3 Nov 2026/);
  // Old citations are rewritten to domains so they cannot collide with new [n] numbers.
  assert.match(system.content as string, /Neon is \$15 a month \(example\.com\)/);
});

test('model errors reach the user as an error event, and the question is still saved', async () => {
  const store = await new MemoryStore(await mkdtemp(path.join(tmpdir(), 'hindsight-'))).load();
  const broken = {
    cfg: { provider: 'test', label: 'Test', baseUrl: 'http://x', apiKey: 'k', model: 'm', fastModel: 'f' },
    async *stream() {
      throw Object.assign(new Error('Test rate limit reached.'), { retryable: true });
    },
    async complete() {
      return '{}';
    },
  } as unknown as LlmClient;
  const events: AgentEvent[] = [];
  await runTurn({ store, recaller: new Recaller(store), llm: broken, search: fakeSearch }, { text: 'hi', now: new Date(), tz: TZ }, (e) => events.push(e));
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(store.all()[0]!.messages[0]!.content, 'hi');
});
