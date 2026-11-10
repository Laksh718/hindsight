/**
 * The claim ledger: after an answer is sent, write down what it asserted.
 *
 * This runs after the user already has their answer, so it adds no latency.
 * A small model call reads the answer and returns:
 *   - a title (first turn only) and a one-line summary, for the memory index;
 *   - the checkable claims: prices, limits, versions, dates, who-does-what,
 *     each tied to its source URL and dated today.
 *
 * Later, "has any pricing changed since Tuesday?" becomes "re-check these
 * seven claims", which is a precise, parallel, diffable job instead of a
 * vague re-search.
 */
import type { LlmClient } from '../llm/client.ts';
import type { Claim, Conversation, Message } from '../types.ts';

const INSTRUCTIONS = `You keep the memory of a research assistant. Read the exchange and reply with JSON only:
{"title": string|null, "summary": string, "claims": [{"subject": string, "attribute": string, "value": string, "source": number|null}]}

title: only when asked for one. Three to six words naming the topic, sentence case, no quotes, no trailing full stop. Otherwise null.
summary: one sentence covering the whole conversation so far: what the user wanted and the gist of the answer, with the key names.
claims: specific facts stated in the ASSISTANT ANSWER that could change and can be re-checked later:
  prices, plan limits, version numbers, release or launch dates, features shipped or missing, who holds a role, rankings, statistics.
  - One fact per claim. subject is the product, company or person ("HubSpot Sales Hub Starter"); attribute is what about it ("price per seat per month").
  - value keeps units, currency and period exactly as stated ("$15 per seat per month, billed annually").
  - source is the [n] number the answer cited for that fact, or null.
  - Skip opinions, advice and settled knowledge. At most 15. An empty list is fine.`;

export interface LedgerUpdate {
  title?: string;
  summary?: string;
  claims: Claim[];
}

export async function writeLedger(
  llm: LlmClient,
  conversation: Conversation,
  user: Message,
  answer: Message,
  asOf: string,
): Promise<LedgerUpdate> {
  const needsTitle = !conversation.title;
  const sources = (answer.sources ?? []).map((s) => `[${s.n}] ${s.url}`).join('\n');
  const prompt = [
    needsTitle ? 'Title: needed.' : `Title: already set ("${conversation.title}"), return null.`,
    conversation.summary ? `Summary so far: ${conversation.summary}` : '',
    `USER: ${user.content}`,
    `ASSISTANT ANSWER:\n${answer.content}`,
    sources ? `SOURCES:\n${sources}` : 'SOURCES: none',
  ]
    .filter(Boolean)
    .join('\n\n');

  const raw = await llm.complete({
    model: llm.cfg.fastModel,
    json: true,
    temperature: 0,
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: prompt },
    ],
  });

  const parsed = parseJson(raw);
  const byN = new Map((answer.sources ?? []).map((s) => [s.n, s.url]));
  const claims: Claim[] = (Array.isArray(parsed?.claims) ? parsed.claims : [])
    .filter((k: any) => k && typeof k.subject === 'string' && typeof k.value === 'string' && k.subject && k.value)
    .slice(0, 15)
    .map((k: any) => ({
      subject: String(k.subject).trim(),
      attribute: String(k.attribute ?? '').trim(),
      value: String(k.value).trim(),
      source: typeof k.source === 'number' ? byN.get(k.source) : undefined,
      messageId: answer.id,
      asOf,
    }));

  return {
    title: needsTitle ? cleanTitle(parsed?.title) ?? fallbackTitle(user.content) : undefined,
    summary: typeof parsed?.summary === 'string' ? parsed.summary.trim() : undefined,
    claims,
  };
}

/** Models wrap JSON in fences or prose now and then; take the outermost object. */
export function parseJson(raw: string): any {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanTitle(t: unknown): string | undefined {
  if (typeof t !== 'string') return undefined;
  const s = t.replace(/^["'\s]+|["'.\s]+$/g, '').trim();
  return s ? s.slice(0, 80) : undefined;
}

export function fallbackTitle(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
  return words.length < text.trim().length ? `${words}...` : words;
}
