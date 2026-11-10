/**
 * Web search, via Tavily.
 *
 * Tavily is built for agents: one call returns ranked pages with clean text
 * excerpts, publish dates and a date filter, so there is no second "fetch the
 * page" round trip in the common case. The free tier is 1,000 searches a month.
 *
 * Results are cached for 10 minutes. Repeated and follow-up questions are
 * common in chat, and a cache hit is both instant and free.
 */

export interface SearchHit {
  url: string;
  title: string;
  content: string;
  published?: string; // YYYY-MM-DD
}

export interface SearchOptions {
  since?: string; // YYYY-MM-DD: only pages published on or after
  deep?: boolean; // longer excerpts, for exact figures
  signal?: AbortSignal;
}

export interface SearchOutcome {
  hits: SearchHit[];
  cached: boolean;
}

export interface SearchProvider {
  search(query: string, opts?: SearchOptions): Promise<SearchOutcome>;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 300;

export class TavilySearch implements SearchProvider {
  private cache = new Map<string, { at: number; hits: SearchHit[] }>();

  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
    const key = JSON.stringify([query.toLowerCase().trim(), opts.since ?? '', !!opts.deep]);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return { hits: hit.hits, cached: true };

    const body: Record<string, unknown> = {
      query,
      search_depth: opts.deep ? 'advanced' : 'basic',
      chunks_per_source: opts.deep ? 3 : 2,
      max_results: opts.deep ? 5 : 6,
      include_published_date: true,
      topic: 'general',
    };
    if (opts.since) body.start_date = opts.since;

    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Tavily rejected the API key. Check TAVILY_API_KEY in .env.');
      if (res.status === 429 || res.status === 432) throw new Error('Tavily search quota or rate limit reached.');
      throw new Error(`Tavily error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ url: string; title?: string; content?: string; published_date?: string | null }>;
    };
    const limit = opts.deep ? 2400 : 1200;
    const hits: SearchHit[] = (data.results ?? []).map((r) => ({
      url: r.url,
      title: (r.title ?? '').trim() || r.url,
      content: (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, limit),
      published: normaliseDate(r.published_date),
    }));

    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: Date.now(), hits });
    return { hits, cached: false };
  }
}

function normaliseDate(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}
