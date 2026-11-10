# Hindsight: design

The three sample prompts are about **time**, not search: "on Monday we shortlisted…", "what did I ask on 3 November?", "has pricing changed **since**?". An agent with no sense of when it said something can only search from scratch. Hindsight is built around a dated memory of what it told you, with web search as its one tool.

## How a turn works

```
message ─ save ─ recall (code, ~1 ms) ─ model ⇄ web_search (parallel queries, ≤2 rounds) ─ save answer + sources ─ ledger (after the answer)
```

1. **Time is an input.** Every turn carries `now` and the user's time zone. "Last Tuesday" and "3 November" are resolved in code (chrono-node plus past-biased rules, tested), and the model gets a 14-day calendar. Dates become a lookup, not arithmetic.
2. **Recall runs before the model, in code.** Named dates first, then look-back cues ("still correct", "since then"), then topic (a 60-line BM25 index). The prompt gets an index of past conversations, the full text and claims of the matched ones, and, when a day is empty, the instruction right beside the gap: say so, don't search for it, answer the present part with likely candidates.
3. **One tool, many queries.** `web_search` runs up to five queries in parallel, with a `since` filter for news. Citations are numbered once per turn; any `[n]` that doesn't match a page read this turn is removed before saving.
4. **The claim ledger.** After the answer streams, a cheap call extracts checkable claims (subject, value, source, date). "Is that still true?" becomes "re-verify these claims", answered as Then / Now / Status. **Recheck** does that in one tap from any answer or past conversation.
5. **Everything is an event.** The server streams NDJSON (recall, search, results, text, done, remembered). The UI draws the pipeline from them; a recorded stream replays real turns on the landing and architecture pages.

## Why this way

- **Fast:** no planner call, no recall round trip, parallel queries, a 10-minute search cache, the ledger off the critical path, Tavily's fast depth (measured ~1.3 s against ~3.8 s for advanced).
- **Correct:** deterministic dates; memory that can't be skipped; no citation without a source; memory is never treated as a source for current facts.
- **Robust on free tiers:** a model chain (Gemini 3.5 Flash, 3.8 Flash, Flash-Lite). A model that returns 429/5xx is benched for a minute; a call with no response in 25 s, or silent for 30 s mid-stream, moves to the next. Measured: free-tier calls did hang for 300 s, Node's default.
- **Good to talk to:** answer first, about 150 words, a trail of what it recalled and searched, honest when memory is empty and still useful.

## Considered and rejected

| Option | Why not |
| --- | --- |
| Memory as a second tool | The brief says one tool; it also costs a round trip, and a model can forget to call it. |
| Vector DB / embeddings | Dates are the key for these questions; lexical search over model-written summaries is enough for one person's history. |
| Agent framework / LLM SDK | The loop is ~100 lines; owning the stream parser keeps Gemini's tool-call signatures intact. |
| A library for topic search | MiniSearch's CommonJS typings broke the Vercel build; the 60-line BM25 needs no explaining. |
| Planner model before the answer | 0.5–1 s on every turn for decisions the main model already makes. |
| Provider-native search grounding | No freshness filter, no cache, no source records for the ledger, and vendor lock-in. |
| SQLite | Native builds can break `npm install`. Memory is a JSON snapshot behind a `Persistence` interface: a file locally, Upstash Redis per visitor on Vercel. |

**Trade-offs accepted:** web search can't time-travel, so seeded past conversations see today's web (flagged as simulated). Claim extraction can miss a claim; the transcript remains. Free-tier quotas mean answers may come from Flash-Lite on a busy day.

## With another week

1. **A proactive watch:** recheck the ledger overnight and open with "two things changed since we last spoke".
2. **Page snapshots:** keep excerpts of cited pages, so a recheck shows exactly what changed on the page.
3. **Evals in CI:** a dated scenario suite scoring date resolution, recall precision and citation faithfulness with an LLM judge.
4. **Recall:** an embedding signal for paraphrased topics, and rolling summaries for long threads.
5. **Accounts:** sign-in, and a Postgres `Persistence` beside the file and Redis ones.
