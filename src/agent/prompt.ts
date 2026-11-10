/**
 * The system prompt, rebuilt every turn.
 *
 * It carries three things the model cannot know on its own:
 *   1. When "now" is, plus a calendar of recent days, so "last Tuesday" is a
 *      lookup and not arithmetic.
 *   2. What it said before: an index of every past conversation, and the full
 *      text and recorded claims of the ones recall picked for this message.
 *   3. How to behave when memory and the user disagree, or memory is empty.
 *
 * Everything is plain text in a stable order: rules first, then the volatile
 * parts (date, memory), so providers that cache prompt prefixes can reuse it.
 */
import type { Claim, Conversation, Message } from '../types.ts';
import type { Recall, RecallHit } from '../memory/recall.ts';
import { calendarTable, dayKey, describeWindow, formatDay, formatNow, formatTime } from '../time.ts';
import { domainOf } from './web-search-tool.ts';

const RULES = `You are Hindsight, a research assistant. You can search the web, and you remember every past conversation with this user, with the date it happened.

# When to search
Your training data is out of date. Search before answering anything that can change: prices and plans, product launches and features, versions, news, who holds a role, availability, rankings, laws, schedules. Also search when the user asks you to check, verify or update something.
Do not search for greetings, writing and editing, maths, code help, or settled knowledge. Answer those directly.

How to search well:
- Put several queries in one web_search call when you need several facts. They run in parallel. Use one query per product or company.
- Phrase queries the way the page you want is titled: "Pipedrive pricing", "Neon Postgres pricing plans", "HubSpot Sales Hub release notes November 2026".
- Use "since" (YYYY-MM-DD) for news, launches and changelogs after a date. Never use it to read a pricing or docs page.
- Use "deep": true when you need exact figures.
- One round of searching is normal: put every query you need into that first call. Search a second time only if the results clearly miss the answer. Then answer with what you found and say plainly what you could not confirm.
- Do not write anything before calling web_search. The user already sees your searches as they happen.

# Memory
You are given an index of past conversations and, inside <memory>, the full text of those relevant to this message. The current conversation is the chat itself. User messages carry the time they were sent in [brackets]; never write such brackets yourself.
- Answer questions about the past only from memory. Quote what the user asked and give the date.
- If the user names a day and memory holds nothing for it, say so in one sentence, name the nearest conversations you do have (if any), and still help: offer to answer the question now, or ask for the one detail you need.
- Never invent a past conversation, question or answer.
- If the user's account differs from memory (they say five tools and memory has four, they say Monday and it was Tuesday), trust memory and point out the difference in a few words.
- Memory is a record of what you said, never a source for current facts. If the question needs current information ("now", "today", "latest", prices, plans), search even when memory has an answer, then compare.
- If a related past conversation is in memory but the user did not refer to it, mention it only when it adds something, such as a change since you last answered ("On 3 Nov I said $19; it is now $15").

# Checking whether something still holds
When the user asks if a past answer is still correct, or what changed since a date:
1. Take the specific claims from memory: the "Claims recorded" list, or the answer text if there is no list.
2. Re-check every one with search, all in one parallel call: current pages for prices and plans, and "since" set to the original date for launches and news.
3. Open with the verdict in one sentence ("Two of the five changed pricing."). Then a table: Item | Then (date) | Now | Status, where Status is Changed, Unchanged, New or Could not verify. Cite the Now column.
4. If the user asked about launches or big news, add a short list of what shipped since that date, cited. Nothing else.

# How to answer
- The first sentence answers the question. No preamble, no restating the question, no compliments.
- Be brief: about 150 words unless the user asks for depth. One short paragraph, then at most one compact table or a short list. Put only the columns that decide the question in a table (four at most).
- Never use headings, horizontal rules or emoji. Bold at most one phrase.
- Cite every fact that came from search with its number, like this: [3]. Use only numbers from the results. Memory is not a source number; refer to it by date.
- Date anything volatile with the exact day from "Now": "As of 10 Nov, the Starter plan is $15 per seat a month [2]." Never "as of late 2026".
- If sources disagree or are thin, say so in one line. If you could not find something, say so rather than guess.
- Cite like [2] or [2][5], never [2, 5]. Do not cite inside table headers.
- Write in the user's language and match their register.`;

const ASSISTANT_CHARS = 1400;
const USER_CHARS = 600;

/** Old answers cite [n] against their own source list; rewrite to domains so they never collide with this turn's numbers. */
function decite(text: string, sources: Message['sources']): string {
  if (!sources?.length) return text.replace(/\[(\d+)\]/g, '');
  const byN = new Map(sources.map((s) => [s.n, s.domain]));
  return text.replace(/\[(\d+)\]/g, (_, n) => (byN.has(Number(n)) ? `(${byN.get(Number(n))})` : ''));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} [...]`;
}

const stamp = (at: string, tz: string) => `${formatDay(dayKey(at, tz))}, ${formatTime(at, tz)}`;

function renderClaims(claims: Claim[], tz: string): string {
  if (!claims.length) return '';
  const lines = claims.map(
    (k) => `- ${k.subject}, ${k.attribute}: ${k.value}${k.source ? ` (${domainOf(k.source)})` : ''}, as of ${formatDay(k.asOf)}`,
  );
  return `Claims recorded:\n${lines.join('\n')}`;
}

const WHY: Record<RecallHit['why'], string> = {
  date: 'active on a day the user named',
  'near-date': 'closest to the day the user named (nothing on that exact day)',
  topic: 'matches what the user is referring back to',
  related: 'same topic as this question',
  latest: 'the most recent conversation',
};

function renderHit(hit: RecallHit, now: Date, tz: string): string {
  const c = hit.conversation;
  const cutoff = now.toISOString();
  const visible = c.messages.filter((m) => m.at <= cutoff);
  const crowded = visible.length > 8;
  const body = visible
    .map((m) => {
      if (m.role === 'user') return `[${stamp(m.at, tz)}] User: ${clip(m.content, USER_CHARS)}`;
      return `[${stamp(m.at, tz)}] You: ${clip(decite(m.content, m.sources), crowded ? 500 : ASSISTANT_CHARS)}`;
    })
    .join('\n');
  const claims = renderClaims(
    c.claims.filter((k) => visible.some((m) => m.id === k.messageId)),
    tz,
  );
  const days = hit.days.map((d) => formatDay(d)).join(', ');
  return `<conversation title="${c.title || 'Untitled'}" days="${days}" recalled="${WHY[hit.why]}">\n${body}${claims ? `\n${claims}` : ''}\n</conversation>`;
}

function renderIndex(all: Conversation[], currentId: string, now: Date, tz: string): string {
  const cutoff = now.toISOString();
  const past = all.filter((c) => c.id !== currentId && c.createdAt <= cutoff && c.messages.length).slice(0, 40);
  if (!past.length) return 'No past conversations yet. This is the first one, so memory starts today.';
  const lines = past.map((c) => {
    const first = formatDay(dayKey(c.createdAt, tz));
    const last = formatDay(dayKey(c.updatedAt <= cutoff ? c.updatedAt : c.createdAt, tz));
    const span = first === last ? first : `${first} to ${last}`;
    return `- ${span}: ${c.title || 'Untitled'}${c.summary ? `. ${c.summary}` : ''}`;
  });
  return `${lines.join('\n')}\nMemory starts on ${formatDay(dayKey(past[past.length - 1]!.createdAt, tz))}.`;
}

export interface PromptInput {
  now: Date;
  tz: string;
  recall: Recall;
  conversation: Conversation;
  all: Conversation[];
}

export function buildSystemPrompt({ now, tz, recall, conversation, all }: PromptInput): string {
  const parts = [RULES];

  parts.push(`# Now\nIt is ${formatNow(now, tz)} (${tz}).\n\nRecent days:\n${calendarTable(now, tz)}`);

  if (recall.windows.length) {
    const lines = recall.windows.map((w) =>
      w.alternative
        ? `- "${w.phrase}" could also mean ${describeWindow(w)}.`
        : `- "${w.phrase}" means ${describeWindow(w)}.`,
    );
    parts.push(`Dates in the user's message (already resolved, use these):\n${lines.join('\n')}`);
  }

  parts.push(`# Past conversations (newest first)\n${renderIndex(all, conversation.id, now, tz)}`);

  const memory: string[] = recall.hits.map((h) => renderHit(h, now, tz));
  if (recall.emptyWindows.length) {
    memory.push(`Nothing in memory for: ${recall.emptyWindows.map(describeWindow).join('; ')}.`);
  }
  // A conversation resumed on a later day: its own earlier claims are what "is this still right?" means.
  const earlierClaims = conversation.claims.filter((k) => k.asOf < dayKey(now, tz));
  if (earlierClaims.length) memory.push(`From earlier in this conversation:\n${renderClaims(earlierClaims, tz)}`);

  if (memory.length) parts.push(`<memory>\n${memory.join('\n\n')}\n</memory>`);
  else if (recall.lookingBack) parts.push('<memory>\nNothing in memory matches what the user is referring to.\n</memory>');

  // Last word: models weight the end of the prompt most, and format rules drift first.
  parts.push(`# Reminder\nAnswer in about 150 words: the answer first, then at most one table (four columns at most) or one short list. No headings, no horizontal rules. Cite as [n]. Date volatile facts with ${formatDay(dayKey(now, tz), { year: false })}.`);

  return parts.join('\n\n');
}

/** Earlier turns of this conversation, as chat messages. Tool traffic is not replayed: answers and their sources are enough. */
export function historyMessages(conversation: Conversation, upToId: string, tz: string, keep = 16) {
  const idx = conversation.messages.findIndex((m) => m.id === upToId);
  const earlier = conversation.messages.slice(0, idx < 0 ? undefined : idx).slice(-keep);
  return earlier.map((m) => {
    if (m.role === 'user') return { role: 'user' as const, content: `[${stamp(m.at, tz)}] ${m.content}` };
    // Old [n] markers would collide with this turn's numbering, so they become domains.
    const cited = (m.sources ?? []).filter((s) => m.content.includes(`[${s.n}]`));
    const refs = cited.length ? `\n\n(Sources: ${cited.map((s) => s.url).join(' , ')})` : '';
    return { role: 'assistant' as const, content: decite(m.content, m.sources) + refs };
  });
}

export function userTurn(m: Message, tz: string) {
  return { role: 'user' as const, content: `[${stamp(m.at, tz)}] ${m.content}` };
}
