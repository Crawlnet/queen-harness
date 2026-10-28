# queen-harness

The research harness behind the queen of [crawlnet](https://crawlnet.network): a crypto research agent for traders in the
trenches. Ask it about a coin, a wallet, a caller, what is running today, a protocol or a claim, and it reads the chain,
the markets, X and today's narratives live, then answers like a trencher: the verdict first, numbers as returned, the
worst finding first.

It is a harness, not a model. Bring any model that speaks the OpenAI chat completions API with tool calls; the harness
decides what to read, reads it, hands the model a dossier and a short list of functions, and checks what comes back.

```bash
npm install
cp .env.example .env        # set LLM_API_KEY and LLM_MODEL at least
npm run ask -- "check DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
npm run serve               # POST /v1/ask on http://127.0.0.1:8790
```

Node 24 or later (the TypeScript runs as is, no build step).

## How an answer runs

1. **The kind.** Code reads what the question is about: token, wallet, caller, narrative, defi, prediction, claim, larp,
   self or general, two at most. Regexes first; where they are unsure (another language, a short follow-up, a new
   topic in a few words), [Jev](https://openrouter.ai) picks when `JEV_KEY` is set. A follow-up keeps the coin in view.
2. **Code reads first.** A coin named in the question gets its dossier before the model starts: its market, its
   authorities and lp lock, its holders by kind, its creator, then deeper beside it (its launch: the dev, the bundle and
   the first-minute snipers; holder clusters by funder and transfers; a cabal spread thin past the top; its story),
   every finding levelled on one severity scale. A narrative question gets the board of what runs now; a larp check
   gets the coin's links, code, site age, site page and x account cross-checked against its launch date.
3. **The model.** It gets one system prompt (who she is, how she works, the trench read, what is true, her voice, the
   visual blocks, the hard rules), the playbook of this kind of answer, the dossier and the reads, and only the
   functions this kind needs, with a limit of calls. A few rounds of calls, then one JSON reply.
4. **After it.** The leak check (the prompt's guarded rules, the canary, the keys, a model's name nobody brought up), function names
   taken out, the token card's level set by code to the dossier's worst, the holder map drawn by code from the chain's
   holder links, the redaction guard over the answer, its sources and its follow-ups. With no model answer, code writes
   a short one from what is in hand: people never get a bare failure.

[docs/HARNESS.md](docs/HARNESS.md) has the map: what code reads by kind, the functions offered by kind, one function a
job. [docs/BLOCKS.md](docs/BLOCKS.md) has the visual blocks an answer carries (token, clusters, flow, timeline, chart,
posts, wallet, odds) for a UI to draw.

## Layout

| Path | What |
|---|---|
| `packages/harness` | the answer: `ask.ts` (the run above), `harness.ts` (kinds, plans, playbooks, the prompt), `scan.ts` (the dossier), `trench.ts` (the trench read), `brain.ts` (the model loop, the reply's checks), `clustermap.ts`, `walletmem.ts` (wallets seen across coins), `page.ts` (the page reader), `cli.ts`, `server.ts` |
| `packages/tools` | 43 functions over free and keyed sources, argument validation, budgets per answer, minute and day, a result cache, the redaction guard |
| `packages/shared` | the types the two share, the severity scale, hedged requests |
| `services` | two background services whose files the narrative tools read: `migration` (pump.fun and StonkFun runners and metas) and `ai-x-radar` (AI ideas on X) |

## Keys

The model's key is the only one required. Every source below adds functions; without its key they are simply not
offered.

| Set | Adds |
|---|---|
| `LLM_API_KEY`, `LLM_MODEL` (`LLM_BASE_URL`, default OpenRouter) | the model |
| nothing | DefiLlama (tvl, fees, yields, stablecoins, unlocks), DEX Screener, GeckoTerminal, Jupiter, Polymarket, RugCheck and GoPlus, pump.fun's callouts, GitHub, RDAP and certificate logs, the chain over the public RPC, the page reader |
| `SOLANA_RPC_URLS` or `HELIUS_API_KEYS` | holder reads on big coins (the public RPC refuses them), the holder spread and the asset card |
| `HELIUS_LAUNCH_KEYS` | the launch read (`sol_launch`), who bought before a call (`call_frontrun`, `caller_side_wallets`) |
| `TOOLS_XSEARCH_KEY` (an OpenRouter key; else `LLM_API_KEY` on OpenRouter) | posts on X and web search through Grok, the CT calls radar |
| `API_HUB_KEY` ([API Hub](https://hub.arbitron.dev), a free key) | the data hub: wallet labels, defi positions, 153 chains' RPC |
| `NARRATIVE_DIR` (the `services` folder, with the services running) | each coin's narrative, today's metas, what just ran, the ideas on X |
| `GITHUB_TOKEN` | more GitHub reads for the larp check |

`.env.example` lists them all, and the optional tunables with their defaults. X is read through search APIs only, never
crawled.

## The HTTP API

```http
POST /v1/ask
{"question": "who holds this and is it bundled? <mint>", "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

```json
{"answer": "markdown", "sources": [{"url": "...", "title": "..."}], "followups": ["..."], "by": "model", "tools": ["sol_holder_links"], "ms": 31200}
```

With `"stream": true` it answers with server-sent events: `step` (`{"name", "phase"}`) while the research runs, then one
`answer`. `GET /health` answers `{"ok": true}`. It listens on 127.0.0.1 by default: every answer spends your keys, so put
it behind your own auth and rate limit before you open it to anyone.

As a library:

```ts
import { start } from "@crawlnet/harness";
const { harness } = start();
const a = await harness.ask({ question: "what's running on pump.fun right now?" });
```

## The persona

The prompt is the queen's persona: `harness.ts` (`HEAD`, `HOW`, `TRUE`, `VOICE`, `BLOCKS`, `HARD`,
`REPLY`, `PLAYBOOKS`), `trench.ts` (the trench read) and `say.ts`. `ABOUT_FILE` is the trusted text she answers
questions about herself from, and `OWN_MINT` the token she speaks for. Change those to make her someone else.

## Tests

```bash
npm test
```

## License

MIT.
