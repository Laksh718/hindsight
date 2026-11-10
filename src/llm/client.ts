/**
 * A streaming client for the OpenAI chat-completions wire format.
 *
 * No SDK, on purpose. The format is small, and owning the parser means:
 *   - one code path for Gemini, Groq, Claude, OpenAI, OpenRouter and Ollama;
 *   - provider-specific fields on tool calls survive the round trip (Gemini
 *     attaches a thought signature to each tool call and rejects the next
 *     request if it is not sent back);
 *   - the stream parser is a pure function we can unit test.
 */
import type { LlmConfig } from '../config.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  [providerField: string]: unknown;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'finish'; reason: string | null };

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface RequestOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** 'none' keeps tools defined (some providers require it once tool calls are in history) but forbids new calls. */
  toolChoice?: 'auto' | 'none';
  model?: string;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
}

function friendlyError(status: number, body: string, cfg: LlmConfig): LlmError {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    const err = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    detail = err?.message ?? detail;
  } catch {}
  if (status === 401 || status === 403) return new LlmError(`${cfg.label} rejected the API key. Check it in .env.`, status);
  if (status === 404) return new LlmError(`${cfg.label} does not offer that model. Set LLM_MODEL in .env. (${detail})`, status, true);
  if (status === 429) return new LlmError(`${cfg.label} rate limit reached (free tiers allow a few requests a minute). Try again shortly.`, status, true);
  if (status >= 500) return new LlmError(`${cfg.label} is overloaded right now (${status}). Try again in a moment.`, status, true);
  return new LlmError(`${cfg.label} error ${status}: ${detail}`, status);
}

/**
 * Free tiers are spiky: a model can return 503 "high demand" for minutes.
 * Each request walks the model chain (LLM_MODEL=a,b,c) and benches a model
 * that failed for a minute, so later turns skip it instead of paying for it.
 */
const BENCH_MS = 60_000;
const benched = new Map<string, number>();

export class LlmClient {
  constructor(readonly cfg: LlmConfig) {}

  private async post(opts: RequestOptions, stream: boolean): Promise<Response> {
    const body: Record<string, unknown> = { messages: opts.messages, stream };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? 'auto';
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.json) body.response_format = { type: 'json_object' };
    if (this.cfg.reasoning) body.reasoning_effort = this.cfg.reasoning;

    const url = new URL('chat/completions', this.cfg.baseUrl.endsWith('/') ? this.cfg.baseUrl : `${this.cfg.baseUrl}/`);
    const chain = [...new Set([opts.model ?? this.cfg.model, ...this.cfg.fallbacks])];
    const now = Date.now();
    const ready = chain.filter((m) => (benched.get(m) ?? 0) < now);
    const order = ready.length ? ready : chain; // everything benched: try anyway

    let last: LlmError | undefined;
    for (const model of order) {
      const started = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({ ...body, model }),
        signal: opts.signal,
      });
      if (res.ok) {
        this.lastModel = model;
        console.log(`[llm] ${model} ${stream ? 'stream' : 'complete'} ${res.status} in ${Date.now() - started} ms`);
        return res;
      }
      last = friendlyError(res.status, await res.text(), this.cfg);
      console.log(`[llm] ${model} ${res.status} in ${Date.now() - started} ms${last.retryable ? ', trying the next model' : ''}`);
      if (!last.retryable) throw last;
      benched.set(model, Date.now() + BENCH_MS);
    }
    throw last ?? new LlmError('No model available');
  }

  /** The model that served the most recent request, for display. */
  lastModel?: string;

  /** Stream a reply: text deltas as they arrive, tool calls once complete. */
  async *stream(opts: RequestOptions): AsyncGenerator<StreamEvent> {
    const res = await this.post(opts, true);
    if (!res.body) throw new LlmError('Empty response from model');
    yield* parseChatStream(res.body);
  }

  /** One-shot completion, for background work like claim extraction. */
  async complete(opts: RequestOptions): Promise<string> {
    let res: Response;
    try {
      res = await this.post(opts, false);
    } catch (err) {
      // Not every provider supports JSON mode; the prompt asks for JSON anyway.
      if (opts.json && err instanceof LlmError && err.status === 400) res = await this.post({ ...opts, json: false }, false);
      else throw err;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

/**
 * Parse an SSE chat-completions stream. Text is yielded immediately; tool
 * calls arrive in fragments (name first, arguments in pieces) and are
 * yielded once, assembled, when the stream ends.
 */
export async function* parseChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const calls: ToolCall[] = [];
  let finish: string | null = null;
  let buffer = '';
  const decoder = new TextDecoder();

  const absorb = (delta: any) => {
    if (typeof delta?.content === 'string' && delta.content) return { type: 'text', text: delta.content } as const;
    for (const frag of delta?.tool_calls ?? []) {
      // Most providers send `index`; some send whole calls with only an id.
      let i: number = typeof frag.index === 'number' ? frag.index : -1;
      if (i < 0 && frag.id) i = calls.findIndex((c) => c?.id === frag.id);
      if (i < 0) i = calls.length;
      const { index: _index, function: fn, ...rest } = frag;
      const call = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      Object.assign(call, rest, { type: 'function' });
      if (frag.id) call.id = frag.id;
      if (fn?.name) call.function.name += fn.name;
      if (fn?.arguments) call.function.arguments += fn.arguments;
    }
    return null;
  };

  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new LlmError(chunk.error.message ?? 'Model stream error', chunk.error.code, true);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const ev = absorb(choice.delta ?? choice.message);
        if (ev) yield ev;
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  const complete = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  if (complete.length) yield { type: 'tool_calls', calls: complete };
  yield { type: 'finish', reason: finish };
}
