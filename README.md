# Hindsight

A chat agent with one tool, web search, and a dated memory. It cites what it finds, remembers what it told you and when, and can check whether that still holds.

> "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
>
> Hindsight reads "last Tuesday" as Tue 3 Nov, recalls that conversation and the prices it recorded, searches each one again in parallel, and answers with a Then / Now table.

**Live demo (recorded, no server):** https://laksh718.github.io/hindsight/

## Run it

```bash
npm install
cp .env.example .env     # add two free keys, see below
npm run dev              # http://localhost:3000
```

Two keys, both free with no card:

| Key | What for | Get one |
| --- | --- | --- |
| `GEMINI_API_KEY` | the model (Gemini Flash) | https://aistudio.google.com/apikey |
| `TAVILY_API_KEY` | web search, 1,000 a month free | https://app.tavily.com |

Prefer another model? Set `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` instead (see [.env.example](.env.example)). Any OpenAI-compatible endpoint works, Ollama included.

### Try the time questions straight away

```bash
npm run seed
```

This runs two real conversations with the clock moved back: Postgres hosting "last Tuesday" and a CRM shortlist "on Monday". Then start the app and ask:

- *What did I ask you on 3 November? Is your answer still correct today?* (use the date seed prints)
- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*

You can also move the clock yourself: click the date in the top bar.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | server and UI with reload |
| `npm test` | 19 tests: dates, recall, the stream parser, a full scripted turn |
| `npm run typecheck` | TypeScript, strict |
| `npm run seed` | time-travelled real conversations into `./data` |
| `npm run seed -- --record docs/demo` | record a demo session for GitHub Pages |
| `npm run pages` | copy the UI into `docs/app` in replay mode |

## How it works

[DESIGN.md](DESIGN.md) is the one-page design: how it works, why, what was rejected, and what comes next. [ARCHITECTURE.md](ARCHITECTURE.md) walks through every file and decision.

In one line: **save → recall (in code) → model ⇄ web_search (parallel queries) → save → ledger of dated claims.**

## Memory and privacy

Conversations and the claim ledger live in `data/memory.json` on your machine, which is gitignored. Delete the file to forget everything.
