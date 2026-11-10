# Hindsight: design

The three sample prompts are about **time**, not search: "on Monday we shortlisted…", "what did I ask on 3 November?", "has pricing changed **since**?". A good search agent with no sense of when it said something can only answer them by searching from scratch. So Hindsight is built around a dated memory of what it told you, with web search as its one tool.

## How a turn works

```
message ─ save ─ recall (code, ~1 ms) ─ model ⇄ web_search (≤3 rounds, parallel queries) ─ save answer + sources ─ ledger (after the answer)
```

1. **Time is an input.** Every turn carries `now` and the user's time zone. Phrases like "last Tuesday" and "3 November" are resolved in code (chrono-node plus past-biased rules, unit-tested), and the model also gets a 14-day calendar table. Dates become a lookup, not arithmetic, which models get wrong. Because the clock is injected, tests and the UI's time-travel switch can run the agent on any date.
2. **Recall runs before the model, in plain code.** It matches named dates first, then look-back cues ("you said", "still correct", "since then"), then topic (MiniSearch, BM25). The prompt gets an index of every past conversation, the full text and claims of the matched ones, and an explicit line like "Nothing in memory for Sat 7 Nov", so the model never has to guess whether it remembers.
3. **One tool, many queries.** `web_search` takes up to five queries and runs them in parallel, so "check these five CRMs" costs one round trip. A `since` date filters news, and the tool description warns the model off using it on pricing pages, which are usually undated. Citation numbers are deduplicated by URL and stay stable for the whole turn. Results are cached for 10 minutes.
4. **The claim ledger.** Once the answer has streamed, a cheap model call pulls out the checkable claims (subject, attribute, value, source URL, date) and writes a title and summary. "Is that still true?" then becomes "re-verify these seven facts", answered as a Then / Now / Status table.
5. **Everything the UI shows is an event.** The server streams NDJSON events: recall, search, results, text, done, remembered. The UI renders the trail of what the agent did. A recorded stream is just a file, which is how the GitHub Pages demo runs the real UI with no server.

## Why this way

- **Fast:** no planner call, no recall tool round trip, parallel queries in one call, a search cache, the ledger off the critical path, and minimal thinking settings. The first visible event arrives in milliseconds.
- **Correct:** dates are resolved deterministically, and memory cannot be skipped. Every search source is stored with the answer, so later rechecks compare against what was actually read. The prompt says to cite only result numbers and to say when something could not be verified.
- **Good to talk to:** the answer comes first, and the trail shows what was recalled and searched. When memory is empty, the agent says so plainly and still helps. When the user's memory and the agent's disagree, the agent says which it trusts.

## Considered and rejected

| Option | Why not |
| --- | --- |
| Memory as a second tool (`recall`) | The brief says one tool. It also costs a model round trip before any answer, and a model that forgets to call it answers "I don't remember" wrongly. |
| Vector DB / embeddings | Dates are the primary key for these questions. At personal scale, lexical search over model-written summaries is enough, and embeddings add a key, latency and opacity. |
| Agent framework (LangChain, AI SDK) | The loop is ~100 lines. A framework would hide the part being judged, and owning the stream parser keeps Gemini's tool-call thought signatures intact. |
| Planner / router model before the main call | Adds 0.5–1 s to every turn for decisions the main model makes anyway. |
| Provider-native search grounding | No freshness filter, no cache, no source records for the ledger, and it locks the agent to one vendor. |
| SQLite | A native build step can break `npm install` on a reviewer's machine. A JSON file behind a small store interface is enough for one user. |
| SSE | `EventSource` cannot POST. NDJSON over fetch is simpler and replayable as a file. |

**Trade-offs accepted:** web search cannot time-travel, so seeded "past" conversations see today's web, and they are flagged as simulated. Claim extraction can miss a claim, but the transcript stays in memory as a fallback. The memory is single-user and local.

## With another week

1. **A proactive watch:** re-check ledger claims overnight and open the next chat with "two things changed since we last spoke".
2. **Page snapshots:** store excerpts and hashes of cited pages, so a recheck can show exactly what changed on the page, not just the extracted value.
3. **Evals in CI:** a dated scenario suite (seeded memory plus scripted questions) scoring date resolution, recall precision and citation faithfulness with an LLM judge.
4. **Better recall:** an embedding signal for paraphrased topics, and rolling summaries for very long threads.
5. **Multi-user:** auth, and a Postgres store behind the same interface.
