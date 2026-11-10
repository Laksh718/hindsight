/**
 * Recall: decide which past conversations the model gets to see this turn.
 *
 * This runs *before* the model is called, in plain code, in about a
 * millisecond. It is not a tool the model can choose to call:
 *   - the brief says the agent has one tool, web search;
 *   - a recall tool costs a full model round trip before any answer;
 *   - a model that forgets to call it answers "I don't remember" wrongly.
 *
 * Three signals, in priority order:
 *   1. Dates. "On 3 November", "last Tuesday" resolve to day windows and
 *      pull every conversation active on those days. Dates are the primary
 *      key of the questions this agent is built for.
 *   2. Look-back cues. "you said", "I asked", "still correct", "since then"
 *      mean the user is pointing at a past exchange, so the best topic
 *      matches come along even with no date.
 *   3. Topic. A new question about something discussed before (two or more
 *      shared terms) pulls in that conversation, so the agent can say what
 *      changed since it last answered.
 */
import MiniSearch from 'minisearch';
import type { Conversation } from '../types.ts';
import type { MemoryStore } from './store.ts';
import { dayKey, daysBetween, resolveDates, type DayKey, type DayWindow } from '../time.ts';

export type RecallReason = 'date' | 'near-date' | 'topic' | 'related' | 'latest';

export interface RecallHit {
  conversation: Conversation;
  why: RecallReason;
  days: DayKey[]; // days (user's zone) this conversation was active, as of now
  window?: DayWindow;
}

export interface Recall {
  windows: DayWindow[];
  hits: RecallHit[];
  /** The user is referring to something said before. */
  lookingBack: boolean;
  /** Days the user named where memory holds nothing. The model must say so, not guess. */
  emptyWindows: DayWindow[];
}

const LOOK_BACK = new RegExp(
  [
    String.raw`\b(?:you|u) (?:said|told|recommended|suggested|mentioned|answered|found|gave|listed|picked)`,
    String.raw`\bi (?:asked|told you|mentioned|said)`,
    String.raw`\bwe (?:discussed|talked|spoke|chatted|shortlisted|compared|looked at|decided|picked|chose|went through|covered|listed)`,
    String.raw`\b(?:last time|earlier|previous(?:ly)?|before|the other day|our (?:chat|conversation|discussion))\b`,
    String.raw`\bsince (?:then|we|you|i|last)\b`,
    String.raw`\bstill (?:correct|true|accurate|valid|right|the case|current|up to date)\b`,
    String.raw`\b(?:has|have|did) (?:anything|any of them|it|they|that|those|the prices?|pricing) changed\b`,
    String.raw`\bwhat did (?:i|we|you)\b`,
    String.raw`\bremember\b`,
  ].join('|'),
  'i',
);

const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its
  just me my of on or our so than that the their them then there these they this those to too us was we were
  what when where which who why will with would you your yours about any anything since still today now
  asked ask told said tell say correct true right changed change changes some something more most get got
  last next week weeks day days month months year years ago yesterday monday tuesday wednesday thursday friday
  saturday sunday january february march april may june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec please thanks hey hi ok okay answer question one ones also
  them shipped big new compare previous earlier time again back look looked`
    .split(/\s+/)
    .filter(Boolean),
);

/** Days a conversation was active, ignoring anything "in the future" of the turn's clock. */
function activeDays(c: Conversation, now: Date, tz: string): DayKey[] {
  const cutoff = now.toISOString();
  const days = new Set<DayKey>();
  for (const m of c.messages) if (m.at <= cutoff) days.add(dayKey(m.at, tz));
  return [...days].sort();
}

function inWindow(day: DayKey, w: DayWindow): boolean {
  return day >= w.from && day <= w.to;
}

export class Recaller {
  private index: MiniSearch | null = null;
  private indexedRevision = -1;

  constructor(private readonly store: MemoryStore) {}

  private search(text: string): Map<string, { score: number; terms: number }> {
    if (!this.index || this.indexedRevision !== this.store.revision) {
      this.index = new MiniSearch({
        fields: ['title', 'summary', 'asked', 'subjects'],
        processTerm: (t) => {
          const term = t.toLowerCase();
          return term.length < 2 || STOPWORDS.has(term) ? null : term;
        },
      });
      this.index.addAll(
        this.store.all().map((c) => ({
          id: c.id,
          title: c.title,
          summary: c.summary,
          asked: c.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
          subjects: c.claims.map((k) => `${k.subject} ${k.attribute}`).join('\n'),
        })),
      );
      this.indexedRevision = this.store.revision;
    }
    const out = new Map<string, { score: number; terms: number }>();
    for (const r of this.index.search(text, {
      prefix: (term) => term.length > 3,
      fuzzy: (term) => (term.length > 5 ? 0.2 : false),
      boost: { title: 3, subjects: 2, summary: 1.5, asked: 1 },
    })) {
      out.set(r.id as string, { score: r.score, terms: new Set(r.queryTerms).size });
    }
    return out;
  }

  recall(input: { text: string; now: Date; tz: string; excludeId?: string }): Recall {
    const { text, now, tz, excludeId } = input;
    const windows = resolveDates(text, now, tz);
    const lookingBack = windows.length > 0 || LOOK_BACK.test(text);

    const pool = this.store
      .all()
      .filter((c) => c.id !== excludeId)
      .map((conversation) => ({ conversation, days: activeDays(conversation, now, tz) }))
      .filter((x) => x.days.length > 0);
    const topic = this.search(text);
    const topicScore = (id: string) => topic.get(id)?.score ?? 0;

    const hits: RecallHit[] = [];
    const take = (h: RecallHit) => {
      if (!hits.some((x) => x.conversation.id === h.conversation.id)) hits.push(h);
    };
    const emptyWindows: DayWindow[] = [];

    if (windows.length) {
      // Every conversation active inside a named window, best topic match first.
      const dated = pool
        .flatMap(({ conversation, days }) => {
          const w = windows.find((win) => days.some((d) => inWindow(d, win)));
          return w ? [{ conversation, days, window: w }] : [];
        })
        .sort(
          (a, b) =>
            Number(a.window.alternative ?? false) - Number(b.window.alternative ?? false) ||
            topicScore(b.conversation.id) - topicScore(a.conversation.id) ||
            b.conversation.updatedAt.localeCompare(a.conversation.updatedAt),
        );
      for (const d of dated.slice(0, 4)) take({ ...d, why: 'date' });

      for (const w of windows) {
        if (w.alternative) continue;
        if (!dated.some((d) => d.window === w)) emptyWindows.push(w);
      }

      // Named a day with nothing on it? Show the closest days that do have
      // something, so the agent can ask "did you mean Tuesday?" instead of
      // flatly saying it remembers nothing.
      if (!dated.length) {
        const distance = (days: DayKey[]) =>
          Math.min(...windows.flatMap((w) => days.map((d) => Math.min(Math.abs(daysBetween(d, w.from)), Math.abs(daysBetween(d, w.to))))));
        pool
          .map((x) => ({ ...x, distance: distance(x.days) }))
          .filter((x) => x.distance <= 4)
          .sort((a, b) => a.distance - b.distance || topicScore(b.conversation.id) - topicScore(a.conversation.id) || b.conversation.updatedAt.localeCompare(a.conversation.updatedAt))
          .slice(0, 2)
          .forEach((x) => take({ conversation: x.conversation, days: x.days, why: 'near-date' }));
      }
    }

    const byTopic = pool
      .filter((x) => topic.has(x.conversation.id))
      .sort((a, b) => topicScore(b.conversation.id) - topicScore(a.conversation.id));

    if (lookingBack) {
      // Topic can rescue a misremembered date ("Tuesday" when it was Wednesday).
      const strong = byTopic.filter((x) => (topic.get(x.conversation.id)?.terms ?? 0) >= (windows.length ? 2 : 1));
      for (const x of strong.slice(0, windows.length ? 1 : 2)) take({ ...x, why: 'topic' });
      // "Is your previous answer still right?" with nothing else to go on: the latest conversation.
      if (!hits.length && !windows.length && pool[0]) take({ ...pool[0], why: 'latest' });
    } else {
      const related = byTopic.find((x) => (topic.get(x.conversation.id)?.terms ?? 0) >= 2);
      if (related) take({ ...related, why: 'related' });
    }

    return { windows, hits, lookingBack, emptyWindows };
  }
}

/** Earliest day memory holds anything, for "my memory starts on ..." answers. */
export function memoryStart(store: MemoryStore, tz: string): DayKey | undefined {
  let first: string | undefined;
  for (const c of store.all()) if (!first || c.createdAt < first) first = c.createdAt;
  return first ? dayKey(first, tz) : undefined;
}
