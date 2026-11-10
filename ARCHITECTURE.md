# Hindsight: architecture walkthrough

[DESIGN.md](DESIGN.md) is the one-page summary. This document is the long version: every file, every decision, and the reasoning behind it, so that any line of the code can be explained.

## The map

```
src/
  server.ts                 HTTP: JSON API, the NDJSON chat stream, static UI
  config.ts                 env → provider presets (Gemini, Groq, Claude, OpenAI, OpenRouter, custom)
  time.ts                   day keys in the user's zone, date-phrase resolution, the prompt calendar
  types.ts                  Conversation, Message, Source, Claim
  llm/client.ts             streaming chat-completions client and SSE parser, no SDK
  search/tavily.ts          Tavily search with a 10-minute cache
  memory/store.ts           JSON-file persistence with atomic writes
  memory/recall.ts          which past conversations the model sees this turn
  agent/turn.ts             one turn: save → recall → model/search loop → save → ledger
  agent/prompt.ts           the system prompt and how history is replayed
  agent/web-search-tool.ts  the one tool: schema, argument parsing, citation numbering
  agent/ledger.ts           post-answer claim extraction, title and summary
public/                     the UI: plain HTML, CSS and ES modules, no build step
  app.js  api.js  render.js  styles/
scripts/
  seed.ts                   time-travelled real conversations; records the Pages demo
  build-pages.ts            copies the UI into docs/ in replay mode
test/                       node:test, run with `npm test`
docs/                       GitHub Pages: the UI in replay mode, plus the recorded session
```

## A turn, step by step

Suppose the user types *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"* on Tuesday 10 November.

1. **The browser** (`public/app.js` → `ask()`) posts `{message, conversationId, tz, now?}` to `/api/chat`. `tz` comes from `Intl`. `now` is sent only when the user has moved the clock (time travel).
2. **The server** (`src/server.ts`) validates the input, resolves the clock, and opens an NDJSON stream. Each `emit(event)` from the agent becomes one JSON line, written in order through a promise chain, so a slow client never blocks the agent. If the browser disconnects, an `AbortController` cancels the model and search requests.
3. **Save first** (`agent/turn.ts`). The question is written to memory before anything can fail, so nothing the user said is ever lost. A retry of an unanswered question reuses it instead of duplicating it.
4. **Recall** (`memory/recall.ts`). `resolveDates` turns "Last Tuesday" into `2026-11-03`. Every conversation active that day is pulled in, ordered by topic match. The result is emitted as a `recall` event, which the UI shows as "Dated: 'Last Tuesday' as Tue 3 Nov 2026" and "Recalled: Managed Postgres hosting prices".
5. **The prompt** (`agent/prompt.ts`) is assembled in this order: the rules, the date and a 14-day calendar, the resolved dates, an index of all past conversations, then `<memory>` with the recalled transcripts and their recorded claims.
6. **The loop.** The model streams. If it calls `web_search`, every query in the call runs in parallel through Tavily. Results get turn-wide citation numbers and go back to the model as a tool message. The model then continues and answers. There are at most three search rounds, after which it must answer with what it has.
7. **Save the answer** with every source it read (cited or not), the searches it ran, and which conversations were recalled. Emit `done`. The UI unlocks the input here.
8. **The ledger** (`agent/ledger.ts`). A second, cheaper model call extracts claims such as `{subject: "Neon", attribute: "Launch plan price", value: "$19 per month", source: url, asOf: "2026-11-10"}`, plus a title and summary. Emit `remembered`. The UI shows "Remembered: 6 claims".

## The decisions, and how to defend them

### Why is memory not a tool?
The brief says the agent has one tool: web search. Beyond that, a `recall` tool would mean a full model round trip (0.5–2 s) before the agent can even begin, and the agent would only remember when it decides to. Recall in code is about a millisecond and always runs. What the model sees is decided by testable code, not by the model's mood.

### Why resolve dates in code, when the model could do it?
LLMs are unreliable at calendar arithmetic ("last Tuesday" from a Tuesday is a classic failure). `chrono-node` parses the phrase, and a few rules fix the cases it gets wrong for this use:
- A bare weekday always means the most recent past one. chrono would read "on Friday" said on a Tuesday as the coming Friday.
- "last week" is the previous Monday-to-Sunday span, not "7 days ago".
- "today" in "is it still correct today?" is not a memory date.
- "last Monday" said on a Tuesday is ambiguous, so both readings are recalled and the prompt mentions both.

All of this is covered in `test/time.test.ts`, including the three challenge prompts.

### What happens when memory has nothing?
Recall reports `emptyWindows`, and the prompt literally says "Nothing in memory for: Sat 7 Nov 2026". The nearest conversations within four days are included, so the agent can say "nothing on Saturday, but on Monday you asked about CRMs". The prompt forbids inventing past conversations and asks the model to still help: answer now, or ask for the one missing detail.

### Why a claim ledger?
"Has any pricing changed since then?" needs to know what the prices were. Re-reading the old answer works, but structured claims make the recheck precise: one search per claim, a Then/Now table, and a status per row. The extraction runs after the answer is delivered, so it costs no latency. If it fails or misses something, the full transcript is still in memory.

### Why store every source, even uncited ones?
A later recheck should compare against what was actually read. It also lets the UI show "3 cited, 11 read", which is honest about how the answer was formed.

### Why parallel queries inside one tool call?
Multi-entity questions (five CRMs, four databases) are the norm here. One call with five queries is one round trip. Five sequential calls would be five model turns, each adding latency.

### Why `since`, and why warn against it for pricing?
Tavily's `start_date` keeps only pages published after a date, which is perfect for "what shipped since Monday". Pricing pages usually have no publish date and would be filtered out, so the tool description tells the model to read pricing pages without `since` and use `since` for news. The recheck instructions say the same.

### Why no LLM SDK?
Every provider exposes the OpenAI chat-completions format, so one roughly 80-line streaming client covers Gemini, Groq, Claude, OpenAI, OpenRouter and Ollama. Owning the parser also solved a real problem: Gemini attaches a thought signature to each tool call and rejects the next request if it is not echoed back. The parser keeps any provider fields on tool calls (tested in `test/llm-stream.test.ts`).

### Why Gemini by default?
It has a free tier (the challenge setup asked for free keys), it is fast, and it handles tool calling and long context well. Thinking is set to the minimum, because latency matters more than deliberation for this job. Any other provider is one line in `.env`.

### Why Tavily?
It returns clean excerpts and publish dates in one call, supports a date filter, and has a 1,000-search free tier. Search sits behind a `SearchProvider` interface, so Brave or Exa would be one more class.

### Why a JSON file and not a database?
One user, at most a few thousand messages, and `npm install` must work everywhere, with no native builds. Writes are atomic (temp file plus rename) and serialised. The store is a small class; replacing it with Postgres touches one file.

### Why NDJSON and not SSE or WebSockets?
The request is a POST, and `EventSource` only does GET. NDJSON over `fetch` is about 15 lines to parse. A recorded stream is a file, and the GitHub Pages demo replays exactly that file through the same UI code (`ReplayApi` in `public/api.js`).

### Why does old citation text get rewritten?
Each answer numbers its sources from [1]. If an old answer's "[3]" appeared in the prompt next to a new search result "[3]", the model could cite the wrong thing. Old answers are therefore shown with domains instead: "(neon.tech)".

### Why is the clock injectable from the UI?
Temporal features are otherwise untestable in a weekend. You cannot wait until Monday. The time-travel control and `npm run seed` create real conversations on past dates. Everything simulated is flagged, and memory never shows a turn anything "from its future".

## The UI

Designed with the Hallmark skill, Almanac theme. The conversation is printed on a pale sheet over slate. Interface text is Hanken Grotesk, answers are Newsreader, and figures are Plex Mono. Magenta is the one signal colour, used for the primary action, citation links and the word "Changed" in recheck tables. Each answer shows:

- **the trail:** dates read, conversations recalled, searches run with page counts and timings, total time;
- **the answer:** markdown, sanitised with DOMPurify because search results are untrusted text. Citations become links, and figure columns align right in mono;
- **sources:** cited first, then the rest that were read;
- **remembered:** the claims ledger for that answer.

States covered: setup (missing keys), loading (skeletons), empty (welcome and starters), error (inline, with retry), streaming, and full.

## Testing

`npm test` runs 19 tests, about 250 ms, no network:
- `time.test.ts`: date resolution, including the three challenge prompts, ambiguous weekdays, spans and time zones;
- `recall.test.ts`: date, look-back, topic and empty-day recall, and no recall from the future;
- `llm-stream.test.ts`: the SSE parser on OpenAI-style fragmented tool calls and Gemini-style whole calls with thought signatures;
- `turn.test.ts`: a full turn with a scripted model and fake search. It checks event order, citation dedup, the ledger, and recall a week later with old citations rewritten.

## Known limits

- Web search cannot time-travel, so simulated past answers reflect today's web.
- Tavily excerpts sometimes miss the exact number on a pricing page. `deep: true` helps; a fetch-the-page fallback is the next step.
- There are no evals yet, only tests of the deterministic parts. See DESIGN.md, "With another week".
