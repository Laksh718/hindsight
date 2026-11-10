/**
 * The HTTP app: a JSON API and one streaming endpoint. No listening here.
 *
 *   src/dev.ts runs it locally (plus the static UI from public/).
 *   On Vercel, this file's default export is the function; public/ is
 *   served by the CDN. Same code, two hosts.
 *
 * POST /api/chat streams newline-delimited JSON events (see AgentEvent).
 * NDJSON rather than SSE because the request is a POST (EventSource only does
 * GET), and because a recorded stream is a plain file the UI can replay.
 *
 * Memory by host:
 *   local          one user, data/memory.json
 *   Vercel + Redis one memory per visitor (an anonymous id the browser keeps)
 *   Vercel alone   per visitor, but only while the function instance lives
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import { config, setupProblems } from './config.ts';
import { LlmClient } from './llm/client.ts';
import { MemoryStore } from './memory/store.ts';
import { Recaller } from './memory/recall.ts';
import { RedisPersistence, VolatilePersistence } from './memory/persistence.ts';
import { TavilySearch } from './search/tavily.ts';
import { runTurn, type AgentEvent } from './agent/turn.ts';
import { isValidTimeZone } from './time.ts';

const llm = config.llm ? new LlmClient(config.llm) : null;
const search = config.tavilyKey ? new TavilySearch(config.tavilyKey) : null;

type MemoryMode = 'file' | 'redis' | 'volatile';
const memoryMode: MemoryMode = config.redis ? 'redis' : config.hosted ? 'volatile' : 'file';

let localStore: Promise<MemoryStore> | null = null;
const volatileStores = new Map<string, MemoryStore>();

/** The visitor's memory. Locally there is one user; hosted, the browser sends an anonymous id. */
async function memoryFor(c: Context): Promise<{ store: MemoryStore; recaller: Recaller }> {
  let store: MemoryStore;
  if (memoryMode === 'file') {
    localStore ??= new MemoryStore(config.dataDir).load();
    store = await localStore;
  } else {
    const raw = c.req.header('x-hindsight-user') ?? '';
    const user = /^[a-zA-Z0-9-]{8,64}$/.test(raw) ? raw : 'anonymous';
    if (memoryMode === 'redis') {
      // Fresh read per request: another function instance may have written since.
      store = await new MemoryStore(new RedisPersistence(config.redis!.url, config.redis!.token, `hindsight:user:${user}`)).load();
    } else {
      if (!volatileStores.has(user)) volatileStores.set(user, await new MemoryStore(new VolatilePersistence()).load());
      store = volatileStores.get(user)!;
    }
  }
  return { store, recaller: new Recaller(store) };
}

const app = new Hono();

// A page on another origin may call this API (CORS_ORIGINS controls which).
app.use('/api/*', cors({ origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins, allowHeaders: ['content-type', 'x-hindsight-user'], maxAge: 600 }));

app.get('/api/status', async (c) => {
  const { store } = await memoryFor(c);
  return c.json({
    ready: !!llm && !!search,
    problems: setupProblems(),
    model: config.llm ? { provider: config.llm.label, model: config.llm.model } : null,
    search: search ? 'Tavily' : null,
    memory: memoryMode,
    conversations: store.all().length,
  });
});

app.get('/api/conversations', async (c) => c.json((await memoryFor(c)).store.list()));

app.get('/api/conversations/:id', async (c) => {
  const conv = (await memoryFor(c)).store.get(c.req.param('id'));
  return conv ? c.json(conv) : c.json({ error: 'Not found' }, 404);
});

app.delete('/api/conversations/:id', async (c) => {
  const { store } = await memoryFor(c);
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
  const { store, recaller } = await memoryFor(c);

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
    await store.flush(); // a serverless function may freeze once the response ends
  });
});

app.get('/api/health', (c) => c.json({ ok: true, app: 'hindsight', time: new Date().toISOString() }));
app.notFound((c) =>
  c.json({ error: `Hindsight has no route for ${c.req.method} ${c.req.path}.`, hint: 'Pages are /, /chat and /how; the API is under /api.' }, 404),
);

export default app;
export { memoryMode };
