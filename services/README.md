# services

Two background services whose files the harness's narrative tools read. Point `NARRATIVE_DIR` at this folder (it holds
`migration/` and `ai-x-radar/`, each writing its own `data/`).

| Service | What it does | Tools that read it |
|---|---|---|
| `migration/` | pump.fun migrations and StonkFun graduates: runners, cap tiers, each coin's narrative, the day's metas | `meme_narrative`, `meme_metas`, `meme_runners` |
| `ai-x-radar/` | the day's AI and agent ideas on X, clustered, enriched and ranked by stage | `x_ideas` |

Both are plain Node (ES modules, no build step, no dependencies) and use the same LLM settings as the harness
(`services/llm.mjs`; each service's `src/llm.mjs` is a copy of it).
