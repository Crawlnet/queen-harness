# migration

A daemon that indexes pump.fun migrations and StonkFun graduates on Solana, confirms which coins really ran, labels
each coin's narrative with the LLM, and writes the day's metas. The harness's `meme_narrative`, `meme_metas` and
`meme_runners` read its files (`NARRATIVE_DIR`).

```bash
node src/index.mjs watch                  # the daemon: everything on its schedule, log to stdout
node src/index.mjs status [--hours 24]    # events, windows, backfill, analysis
node src/index.mjs analyze [--limit 30]   # label the coins with events
node src/index.mjs daily [--hours 24]     # the day's report
```

- **Runner:** a migrated coin whose median price over 10 minutes holds a $150k market cap within a day of migrating.
- **Cap tier:** the first hold of $1M, $5M, $10M, $25M or $50M over 30 minutes, at any age.
- **Fake markets** (`src/config.mjs`): liquidity under $15k, market cap over 60× liquidity, farmed volume (low turnover
  at a high cap-to-liquidity ratio), and drawn "ladder" charts are flagged or left out.
- **Sources:** the chain (Helius: `HELIUS_KEYS`, a comma list; with no live key, the public Solana RPC or
  `PUBLIC_RPC_URL`), DEX Screener, GeckoTerminal, Jupiter.
- **LLM:** `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` (any OpenAI-compatible API; `src/llm.mjs`).
- **Data:** `data/db.json` (the index), `data/events.jsonl`, `data/daily/<day>.json`, `data/reports/<day>.md`.

Settings go in the environment or in `.env` next to `package.json`.
