/**
 * HTTP server: a JSON API, one streaming endpoint, and the static UI.
 *
 * POST /api/chat streams newline-delimited JSON events (see AgentEvent).
 * NDJSON rather than SSE because the request is a POST (EventSource only does
 * GET), and because a recorded stream is a plain file the UI can replay,
 * which is how the GitHub Pages demo works with no server at all.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config, setupProblems } from './config.ts';
import { LlmClient } from './llm/client.ts';
import { MemoryStore } from './memory/store.ts';
import { Recaller } from './memory/recall.ts';
import { TavilySearch } from './search/tavily.ts';
import { runTurn, type AgentEvent } from './agent/turn.ts';
import { isValidTimeZone } from './time.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const store = await new MemoryStore(config.dataDir).load();
const recaller = new Recaller(store);
const llm = config.llm ? new LlmClient(config.llm) : null;
const search = config.tavilyKey ? new TavilySearch(config.tavilyKey) : null;

const app = new Hono();

app.get('/api/status', (c) =>
  c.json({
    ready: !!llm && !!search,
    problems: setupProblems(),
    model: config.llm ? { provider: config.llm.label, model: config.llm.model } : null,
    search: search ? 'Tavily' : null,
    conversations: store.all().length,
  }),
);

app.get('/api/conversations', (c) => c.json(store.list()));

app.get('/api/conversations/:id', (c) => {
  const conv = store.get(c.req.param('id'));
  return conv ? c.json(conv) : c.json({ error: 'Not found' }, 404);
});

app.delete('/api/conversations/:id', async (c) => {
  const ok = await store.delete(c.req.param('id'));
  return ok ? c.body(null, 204) : c.json({ error: 'Not found' }, 404);
});

/** The clock is an input. The UI can move it for testing ("pretend it is last Monday"). */
function resolveClock(raw: unknown): { now: Date; simulated: boolean } | { error: string } {
  const real = new Date();
  if (raw === undefined || raw === null || raw === '') return { now: real, simulated: false };
  const now = new Date(String(raw));
  if (Number.isNaN(now.getTime())) return { error: 'now must be an ISO date-time' };
  if (Math.abs(now.getTime() - real.getTime()) > 2 * 365 * 86_400_000) return { error: 'now must be within two years of today' };
  return { now, simulated: Math.abs(now.getTime() - real.getTime()) > 120_000 };
}

app.post('/api/chat', async (c) => {
  if (!llm || !search) return c.json({ error: setupProblems().join(' ') }, 503);
  const body = await c.req.json().catch(() => null);
  const text = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!text) return c.json({ error: 'message is required' }, 400);
  if (text.length > 8000) return c.json({ error: 'message is too long (8,000 characters max)' }, 400);
  const tz = isValidTimeZone(body?.tz) ? body.tz : 'UTC';
  const clock = resolveClock(body?.now);
  if ('error' in clock) return c.json({ error: clock.error }, 400);

  c.header('content-type', 'application/x-ndjson; charset=utf-8');
  c.header('cache-control', 'no-cache, no-transform');
  c.header('x-accel-buffering', 'no');

  return stream(c, async (out) => {
    const abort = new AbortController();
    out.onAbort(() => abort.abort());
    // Events are queued and written in order; a slow client never blocks the agent.
    let chain = Promise.resolve();
    const emit = (e: AgentEvent) => {
      chain = chain.then(() => (out.aborted ? undefined : out.write(`${JSON.stringify(e)}\n`).then(() => undefined)));
    };
    try {
      await runTurn(
        { store, recaller, llm, search },
        { conversationId: body?.conversationId, text, now: clock.now, tz, simulated: clock.simulated, signal: abort.signal },
        emit,
      );
    } catch (err) {
      console.error('[turn]', err);
      emit({ type: 'error', message: 'Something went wrong on the server. Please try again.', retryable: true });
    }
    await chain;
  });
});

// The UI: plain HTML, CSS and ES modules, no build step.
const vendor: Record<string, string> = {
  '/vendor/marked.js': 'node_modules/marked/lib/marked.esm.js',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.es.mjs',
};
for (const [route, file] of Object.entries(vendor)) {
  app.get(route, async (c) => {
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(await readFile(path.join(root, file), 'utf8'));
  });
}
app.use('/*', serveStatic({ root: path.relative(process.cwd(), path.join(root, 'public')) || '.' }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const problems = setupProblems();
  console.log(`\n  Hindsight is running at http://localhost:${info.port}\n`);
  if (config.llm) console.log(`  model   ${config.llm.label} · ${config.llm.model}`);
  console.log(`  search  ${search ? 'Tavily' : 'not configured'}`);
  console.log(`  memory  ${config.dataDir} (${store.all().length} conversations)\n`);
  for (const p of problems) console.log(`  ! ${p}`);
  if (problems.length) console.log('');
});
