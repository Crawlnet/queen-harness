# ai-x-radar

A daily radar of AI and agent ideas spreading on X before crypto picks them up: concepts, demos, experiments and
mechanics that turn into a narrative, a product or a token within a few days. The harness's `x_ideas` reads its runs
(`NARRATIVE_DIR`).

```bash
node src/index.mjs run [--hours 24]                 # the daily run: the last 24 hours
node src/index.mjs collect [--hours 24]             # collect only, no LLM
node src/index.mjs backtest --to ISO [--hours 24]   # a past window, kept apart in data/backtest/
```

| Step | What | Where |
|---|---|---|
| Collect | topic queries and a watchlist of accounts over the window | `queries.mjs`, `collect.mjs` |
| Prefilter | views, views per follower, quotes and speed: the top few hundred posts | `analyze.mjs` |
| Triage | the LLM keeps the posts that carry an idea, labels the idea and its archetype | `analyze.mjs` |
| Cluster | posts into ideas, joined with the ideas of the last 7 days | `analyze.mjs` |
| Enrich | each idea's root post, its quotes, the tokens made of it since (DEX Screener) | `enrich.mjs` |
| Rank | a score, a stage (pre-crypto … tokenized product), the gist and why it spreads | `analyze.mjs` |
| Report | `data/runs/<day>/report.md` and JSON; `data/ideas.json` keeps each idea across days | `report.mjs` |

- **X:** read through FxTwitter's public search, with twitterapi.io as a fallback when `TWITTERAPI_KEY` is set.
- **LLM:** `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` (any OpenAI-compatible API; `src/llm.mjs`).
- **Excluded authors:** `RADAR_EXCLUDE_AUTHORS`, a comma list of X handles (none by default). Their posts, and posts
  quoting them, are never taken as a source.

Settings go in the environment or in `.env` next to `package.json`.
