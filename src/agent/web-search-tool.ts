/**
 * The agent's one tool: web_search.
 *
 * Design choices, each aimed at fewer round trips or better citations:
 *   - `queries` is a list. "Check these five CRMs" is one tool call with five
 *     queries run in parallel, not five sequential model steps.
 *   - `since` maps to a publish-date filter, for "what shipped since Monday".
 *     The description warns the model off using it for pricing pages, which
 *     are usually undated and would be filtered out.
 *   - Every page gets one citation number for the whole turn ([1], [2], ...),
 *     deduplicated by URL across queries and steps, so the answer can cite
 *     sources from any search with no renumbering.
 */
import type { ToolSpec } from '../llm/client.ts';
import type { SearchHit, SearchProvider } from '../search/tavily.ts';
import type { SearchRecord, Source } from '../types.ts';

export const WEB_SEARCH: ToolSpec = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web. Returns numbered results ([n]) with title, site, publish date when known, and excerpts. ' +
      'Put several queries in one call when you need several facts: they run in parallel.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'One to five search queries. One query per product, company or fact works better than one query for everything.',
        },
        since: {
          type: 'string',
          description:
            'Optional YYYY-MM-DD. Only return pages published on or after this date. Use for news, launches, changelogs and announcements. ' +
            'Do not use it to read current pricing or documentation pages: they are usually undated and would be filtered out.',
        },
        deep: {
          type: 'boolean',
          description: 'Optional. Longer excerpts from each page. Use when you need exact numbers such as prices, limits or versions.',
        },
      },
      required: ['queries'],
    },
  },
};

/** Gives each distinct page one citation number for the whole turn. */
export class SourceBook {
  private byKey = new Map<string, Source>();

  add(hit: SearchHit): { source: Source; isNew: boolean } {
    const key = canonicalUrl(hit.url);
    const existing = this.byKey.get(key);
    if (existing) return { source: existing, isNew: false };
    const source: Source = {
      n: this.byKey.size + 1,
      url: hit.url,
      title: hit.title,
      domain: domainOf(hit.url),
      published: hit.published,
      excerpt: hit.content.slice(0, 400),
    };
    this.byKey.set(key, source);
    return { source, isNew: true };
  }

  all(): Source[] {
    return [...this.byKey.values()];
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/.test(p)) u.searchParams.delete(p);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
  } catch {
    return url;
  }
}

export interface ParsedSearchArgs {
  queries: string[];
  since?: string;
  deep: boolean;
}

/** Models occasionally send `query` instead of `queries`, or a bad date. Be forgiving. */
export function parseSearchArgs(raw: string, today: string): ParsedSearchArgs {
  let args: any = {};
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    args = { queries: [raw] };
  }
  const list: unknown[] = Array.isArray(args.queries) ? args.queries : [args.queries ?? args.query].filter(Boolean);
  const queries = [...new Set(list.map((q) => String(q).trim()).filter(Boolean))].slice(0, 5);
  const since = typeof args.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.since) && args.since <= today ? args.since : undefined;
  return { queries, since, deep: args.deep === true };
}

export interface SearchRun {
  /** Text handed back to the model as the tool result. */
  toolText: string;
  /** Pages this call surfaced, in citation order (new and repeat). */
  sources: Source[];
  record: SearchRecord;
  error?: string;
}

export async function runWebSearch(
  provider: SearchProvider,
  args: ParsedSearchArgs,
  book: SourceBook,
  signal?: AbortSignal,
): Promise<SearchRun> {
  const started = Date.now();
  if (!args.queries.length) {
    return {
      toolText: 'No query given. Call web_search with {"queries": ["..."]}.',
      sources: [],
      record: { queries: [], ms: 0, results: 0, cached: false },
      error: 'empty query',
    };
  }

  const outcomes = await Promise.allSettled(
    args.queries.map((q) => provider.search(q, { since: args.since, deep: args.deep, signal })),
  );

  const sections: string[] = [];
  const seenThisCall = new Map<number, Source>();
  const errors: string[] = [];
  let cachedAll = true;

  outcomes.forEach((o, i) => {
    const query = args.queries[i]!;
    const header = `Results for "${query}"${args.since ? ` (published since ${args.since})` : ''}:`;
    if (o.status === 'rejected') {
      const msg = o.reason instanceof Error ? o.reason.message : String(o.reason);
      errors.push(msg);
      sections.push(`${header}\nSearch failed: ${msg}`);
      cachedAll = false;
      return;
    }
    if (!o.value.cached) cachedAll = false;
    if (!o.value.hits.length) {
      sections.push(`${header}\nNo results.${args.since ? ' Try without "since", or a broader query.' : ' Try a broader query.'}`);
      return;
    }
    const lines = o.value.hits.map((hit) => {
      const { source, isNew } = book.add(hit);
      seenThisCall.set(source.n, source);
      const meta = [source.domain, source.published ? `published ${source.published}` : 'no publish date'].join(', ');
      return isNew
        ? `[${source.n}] ${source.title} (${meta})\n${hit.content}`
        : `[${source.n}] ${source.title} (${meta}): already shown above.`;
    });
    sections.push(`${header}\n\n${lines.join('\n\n')}`);
  });

  const sources = [...seenThisCall.values()].sort((a, b) => a.n - b.n);
  return {
    toolText: sections.join('\n\n---\n\n'),
    sources,
    record: { queries: args.queries, since: args.since, ms: Date.now() - started, results: sources.length, cached: cachedAll },
    error: errors.length === outcomes.length ? errors[0] : undefined,
  };
}
