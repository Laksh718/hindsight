/**
 * One turn of conversation, start to finish.
 *
 *   user message
 *     -> save it (memory is written before anything can fail)
 *     -> recall: pick past conversations by date and topic (code, ~1 ms)
 *     -> model, streaming, with one tool: web_search
 *          tool call? run all its queries in parallel, feed results back,
 *          let the model continue (at most 3 search rounds)
 *     -> save the answer with every source it saw
 *     -> ledger: extract checkable claims + title (after the answer is out)
 *
 * Everything the UI shows is an event from here, so the UI never guesses.
 */
import type { LlmClient, ChatMessage, ToolCall } from '../llm/client.ts';
import { LlmError } from '../llm/client.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { Recaller } from '../memory/recall.ts';
import type { SearchProvider } from '../search/tavily.ts';
import type { Claim, Message, SearchRecord, Source } from '../types.ts';
import { dayKey, describeWindow, formatDay } from '../time.ts';
import { buildSystemPrompt, historyMessages, userTurn } from './prompt.ts';
import { WEB_SEARCH, SourceBook, parseSearchArgs, runWebSearch } from './web-search-tool.ts';
import { fallbackTitle, writeLedger } from './ledger.ts';

const MAX_SEARCH_ROUNDS = 2; // a second round only when the first clearly missed: each round is a model trip plus a search

export type AgentEvent =
  | { type: 'start'; conversationId: string; title: string; user: Message }
  | {
      type: 'recall';
      windows: Array<{ phrase: string; label: string; alternative?: boolean }>;
      hits: Array<{ id: string; title: string; days: string[]; why: string }>;
      empty: string[];
    }
  | { type: 'search'; id: string; queries: string[]; since?: string; deep?: boolean }
  | { type: 'results'; id: string; sources: Source[]; ms: number; cached: boolean; error?: string }
  | { type: 'text'; text: string }
  /** Text streamed so far was commentary before a tool call, not the answer. */
  | { type: 'aside'; text: string }
  | { type: 'done'; message: Message }
  | { type: 'remembered'; conversationId: string; title?: string; summary?: string; claims: Claim[] }
  | { type: 'error'; message: string; retryable: boolean };

export interface AgentDeps {
  store: MemoryStore;
  recaller: Recaller;
  llm: LlmClient;
  search: SearchProvider;
}

export interface TurnInput {
  conversationId?: string;
  text: string;
  now: Date;
  tz: string;
  simulated?: boolean;
  signal?: AbortSignal;
}

export async function runTurn(deps: AgentDeps, input: TurnInput, emit: (e: AgentEvent) => void): Promise<void> {
  const { store, recaller, llm, search } = deps;
  const { now, tz, signal } = input;
  const started = Date.now();
  const at = now.toISOString();
  const today = dayKey(now, tz);

  // 1. Persist the question first, so nothing the user said is ever lost.
  let conversation = input.conversationId ? store.get(input.conversationId) : undefined;
  conversation ??= await store.create({ at, tz, simulated: input.simulated });
  // A retry of a question that got no answer reuses it instead of asking twice.
  const last = conversation.messages.at(-1);
  const user =
    last?.role === 'user' && last.content === input.text
      ? last
      : await store.addMessage(conversation.id, { role: 'user', content: input.text, at });
  emit({ type: 'start', conversationId: conversation.id, title: conversation.title, user });

  // 2. Recall, in code, before the model runs.
  const recall = recaller.recall({ text: input.text, now, tz, excludeId: conversation.id });
  emit({
    type: 'recall',
    windows: recall.windows.map((w) => ({ phrase: w.phrase, label: describeWindow(w), alternative: w.alternative })),
    hits: recall.hits.map((h) => ({ id: h.conversation.id, title: h.conversation.title || 'Untitled', days: h.days.map((d) => formatDay(d)), why: h.why })),
    empty: recall.emptyWindows.map(describeWindow),
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ now, tz, recall, conversation, all: store.all() }) },
    ...historyMessages(conversation, user.id, tz),
    userTurn(user, tz),
  ];

  // 3. The loop: stream, run searches, repeat until the model answers.
  const book = new SourceBook();
  const searches: SearchRecord[] = [];
  let answer = '';
  try {
    for (let round = 0; ; round++) {
      const mayCallTools = round < MAX_SEARCH_ROUNDS;
      if (!mayCallTools) {
        messages.push({ role: 'system', content: 'No more searches. Answer now from the results above, and say what you could not confirm.' });
      }
      let text = '';
      let calls: ToolCall[] = [];
      for await (const ev of llm.stream({ messages, tools: [WEB_SEARCH], toolChoice: mayCallTools ? 'auto' : 'none', signal })) {
        if (ev.type === 'text') {
          text += ev.text;
          emit({ type: 'text', text: ev.text });
        } else if (ev.type === 'tool_calls') {
          calls = ev.calls.filter((c) => c.function.name === WEB_SEARCH.function.name);
        }
      }

      if (!calls.length || !mayCallTools) {
        answer = text;
        break;
      }
      if (text.trim()) emit({ type: 'aside', text });

      messages.push({ role: 'assistant', content: text || null, tool_calls: calls });
      const runs = await Promise.all(
        calls.map(async (call) => {
          const args = parseSearchArgs(call.function.arguments, today);
          emit({ type: 'search', id: call.id, queries: args.queries, since: args.since, deep: args.deep });
          const run = await runWebSearch(search, args, book, signal);
          emit({ type: 'results', id: call.id, sources: run.sources, ms: run.record.ms, cached: run.record.cached, error: run.error });
          return { call, run };
        }),
      );
      for (const { call, run } of runs) {
        searches.push(run.record);
        messages.push({ role: 'tool', tool_call_id: call.id, content: run.toolText });
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      answer ||= '';
    } else {
      const retryable = err instanceof LlmError ? err.retryable : true;
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err), retryable });
      return;
    }
  }

  // A citation must point at a page read in this turn. Anything else is invented, so it goes.
  answer = stripUnknownCitations(answer, new Set(book.all().map((s) => s.n)));

  if (!answer.trim() && !signal?.aborted) {
    answer = 'I could not put an answer together that time. Please try again, or rephrase the question.';
    emit({ type: 'text', text: answer });
  }

  // 4. Persist the answer with every source it saw (cited or not), for later rechecks.
  const assistant = await store.addMessage(conversation.id, {
    role: 'assistant',
    content: answer.trim() + (signal?.aborted ? '\n\n*(stopped)*' : ''),
    at: new Date(now.getTime() + (Date.now() - started)).toISOString(),
    sources: book.all(),
    searches,
    recalled: recall.hits.map((h) => h.conversation.id),
    ms: Date.now() - started,
  });
  emit({ type: 'done', message: assistant });
  if (signal?.aborted) return;

  // 5. Write down what was claimed. The user already has the answer.
  if (searches.length || !conversation.title) {
    try {
      const update = await writeLedger(llm, conversation, user, assistant, today);
      await store.annotate(conversation.id, update);
      emit({ type: 'remembered', conversationId: conversation.id, ...update });
    } catch (err) {
      console.warn('[ledger] skipped:', err instanceof Error ? err.message : err);
      if (!conversation.title) {
        const title = fallbackTitle(user.content);
        await store.annotate(conversation.id, { title });
        emit({ type: 'remembered', conversationId: conversation.id, title, claims: [] });
      }
    }
  }
}

/** Remove [n] markers (and [n, m] lists) whose numbers match no source read this turn. */
export function stripUnknownCitations(text: string, known: Set<number>): string {
  return text.replace(/\s?\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, list: string) => {
    const kept = list.split(',').map((n) => Number(n.trim())).filter((n) => known.has(n));
    if (!kept.length) return '';
    return match.replace(/\[.*\]/, kept.map((n) => `[${n}]`).join(''));
  });
}
