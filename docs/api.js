/**
 * The UI talks to an Api, never to fetch directly.
 *
 * LiveApi streams from the Node server. ReplayApi plays back recorded event
 * streams from static files, which is how the GitHub Pages demo runs the real
 * UI with no server and no keys. Both yield the same events, so the UI code
 * cannot tell them apart.
 */

/** Read a newline-delimited JSON stream, one event per line. */
async function* readNdjson(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop();
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
    if (done) break;
  }
}

export class LiveApi {
  live = true;

  async status() {
    const r = await fetch('api/status');
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    return r.json();
  }

  async conversations() {
    const r = await fetch('api/conversations');
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    return r.json();
  }

  async conversation(id) {
    const r = await fetch(`api/conversations/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    return r.json();
  }

  async remove(id) {
    await fetch(`api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Yields AgentEvents as they arrive. */
  async *chat({ conversationId, message, now, tz, signal }) {
    const r = await fetch('api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, message, now, tz }),
      signal,
    });
    if (!r.ok || !r.body) {
      const body = await r.json().catch(() => ({}));
      yield { type: 'error', message: body.error ?? `The server answered ${r.status}.`, retryable: r.status >= 500 };
      return;
    }
    yield* readNdjson(r.body);
  }
}

/**
 * Plays back a recorded session: `demo/session.json` holds the conversations
 * as the server stored them, plus the raw event stream of each turn. Asking
 * one of the recorded questions replays its stream at the recorded pace.
 */
export class ReplayApi {
  live = false;

  constructor(base) {
    this.base = base;
    this.data = null;
  }

  async load() {
    if (!this.data) {
      try {
        const r = await fetch(`${this.base}/session.json`);
        if (!r.ok) throw new Error(String(r.status));
        this.data = await r.json();
      } catch {
        this.data = { missing: true, model: null, conversations: [], replays: [] };
      }
    }
    return this.data;
  }

  async status() {
    const d = await this.load();
    return { ready: true, replay: true, recorded: !d.missing, problems: [], model: d.model, search: 'Tavily', conversations: d.conversations.length };
  }

  async conversations() {
    const d = await this.load();
    return d.conversations
      .filter((c) => !c.hiddenUntilReplayed || this.replayed?.has(c.id))
      .map((c) => ({ id: c.id, title: c.title, summary: c.summary, createdAt: c.createdAt, updatedAt: c.updatedAt, simulated: c.simulated, messageCount: c.messages.length, claimCount: c.claims.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async conversation(id) {
    const d = await this.load();
    return d.conversations.find((c) => c.id === id) ?? null;
  }

  async remove() {}

  /** The recorded questions a visitor can replay. */
  async scripts() {
    const d = await this.load();
    return d.replays.map((r) => ({ label: r.label, message: r.message }));
  }

  async *chat({ message, signal }) {
    const d = await this.load();
    const replay = d.replays.find((r) => r.message === message);
    if (!replay) {
      yield { type: 'error', message: 'This demo replays recorded answers only. Pick one of the questions below, or run Hindsight locally to ask your own.', retryable: false };
      return;
    }
    (this.replayed ??= new Set()).add(replay.conversationId);
    let last = 0;
    for (const { t, e } of replay.events) {
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, Math.min(t - last, 1500)));
      last = t;
      yield e;
    }
  }
}
