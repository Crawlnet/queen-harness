// The tools module: every tool (the free providers, the data hub, the services' narratives, the CT radar), argument
// validation, the per-answer / per-minute / daily budgets, the result cache, the redaction guard over every output, and
// logging of tool name + ok/error + ms only (an answer with no rows: the head of its summary, redacted).

import { CtRadar, ctRadarTools, FXTWITTER_HOST, TWITTERAPI_HOST } from "./free/ctradar.ts";
import { grokWebTools, NEWS_PER_MIN } from "./free/grokweb.ts";
import { grokXTools, OPENROUTER_HOST, XSEARCH_PER_MIN } from "./free/grokx.ts";
import { HELIUS_LAUNCH_HOST, LAUNCH_PER_MIN, launchTools } from "./free/launch.ts";
import { HUB_HOST, HUB_PER_MIN, hubTools } from "./free/hub.ts";
import { narrativeTools } from "./free/narratives.ts";
import { PUMP_API_HOST, PUMP_PER_MIN, pumpCalloutsTools } from "./free/pumpcallouts.ts";
import { LARP_HOSTS, larpTools } from "./free/larp.ts";
import { GOPLUS_HOST, GOPLUS_PER_MIN, RUGCHECK_HOST, RUGCHECK_PER_MIN, securityTools } from "./free/security.ts";
import { hedgedFetch, type HedgedFetchOptions, type ModuleContext, type ToolError, type ToolResult, type ToolRunContext, type ToolSource, type ToolSpec, type ToolsModule } from "@crawlnet/shared";
import { callKey, TtlCache } from "./cache.ts";
import { readToolsConfig, type ToolsConfig } from "./config.ts";
import { raceAbort, type FreeContext } from "./free/common.ts";
import { defillamaTools, LLAMA_HOSTS } from "./free/defillama.ts";
import { JUPITER_HOSTS, jupiterTools } from "./free/jupiter.ts";
import { marketTools, MARKET_HOSTS } from "./free/markets.ts";
import { POLYMARKET_HOSTS, polymarketTools } from "./free/polymarket.ts";
import { rpcEndpoints, SolanaRpc, solanaTools } from "./free/solana.ts";
import { Http } from "./http.ts";
import { AnswerBudget, DailyCounter, WindowLimiter, type UsageColumn } from "./limits.ts";
import { primaryUrl, webPageUrl } from "./links.ts";
import { createRedactor, redactionKeep, redactionTerms, type Redactor } from "./redact.ts";
import { cleanText } from "./sanitize.ts";
import { schemaProblems, validateArgs } from "./schema.ts";
import { callerOf, GENERIC_MESSAGE, MINUTE, ToolFail, type FetchLike, type Outcome, type ToolDef } from "./types.ts";

export interface ToolsOptions {
  /** fetch for every outbound request (tests); default: the process-wide fetch */
  fetch?: FetchLike;
  now?: () => number;
  /** Run the CT radar's collector in the background (default true) */
  background?: boolean;
}

/** The module plus what tests use. */
export interface Tools extends ToolsModule {
  readonly config: ToolsConfig;
  /** The CT calls radar (null without a source key): tests drive its ticks */
  readonly ctradar: CtRadar | null;
  /** Does a text hold a redaction term? */
  blocked(text: string): boolean;
}

/** Hedging of the free sources' requests: another attempt on a fresh connection after 2.5 s without a response, 3 at most */
export const FREE_HEDGE = { waveMs: 2_500, waves: 3 } as const;
/**
 * GeckoTerminal's: only after a network failure, never for slowness (2 at most). Our limiter sits at its free limit
 * (TOOLS_GECKO_PER_MIN): a duplicate of a slow call would push it over.
 */
export const GECKO_HEDGE = { waveMs: Infinity, waves: 2 } as const;
const GECKO_HOST = "api.geckoterminal.com";
/**
 * The searches on Grok (OpenRouter): the X search billed per post it fetches, the web search per call, so one attempt,
 * never sent twice (free/grokx.ts, free/grokweb.ts)
 */
export const XSEARCH_HEDGE = { waveMs: Infinity, waves: 1 } as const;

/** Helius bills every call: a slow call is never sent again, only one that failed in the network */
function creditBilledRpc(host: string): boolean {
  return /(?:^|\.)helius-rpc\.com$|(?:^|\.)helius\.xyz$/i.test(host);
}

/** Whether a JSON-RPC body asks Helius for a history page (getTransactionsForAddress: 10 credits per 100 transactions) */
function isHistoryCall(body: unknown): boolean {
  return typeof body === "string" && body.includes('"getTransactionsForAddress"');
}

/**
 * How one outbound request of the tools layer is hedged (every request here is a read). A hedge leg is a request
 * upstream like any other, so every extra one is counted (admitLeg) the way a call is, against the provider's limiter;
 * refused = not sent.
 */
export function toolsHedge(host: string, body: unknown, o: { limiter: (host: string) => { take(): boolean } | undefined }): HedgedFetchOptions {
  if (host === OPENROUTER_HOST) return { ...XSEARCH_HEDGE };
  // twitterapi.io bills every tweet a call returns (15 credits at least a call), so one attempt (free/ctradar.ts)
  if (host === TWITTERAPI_HOST) return { ...XSEARCH_HEDGE };
  // a launch read's history page: never sent twice, a network failure included (its pages are many)
  if (host === HELIUS_LAUNCH_HOST && isHistoryCall(body)) return { ...XSEARCH_HEDGE };
  const l = o.limiter(host);
  // every other Helius call: again only after a network failure, never for slowness (each leg is billed)
  if (creditBilledRpc(host)) return { ...GECKO_HEDGE, ...(l ? { admitLeg: () => l.take() } : {}) };
  // the data hub: a label read is credit-billed and a slow source answers slowly anyway, so again only after a network
  // failure (free/hub.ts); pump.fun's API too: its edge blocks a burst for minutes (free/pumpcallouts.ts); FxTwitter's
  // status reads as well: each has its own short timeout and a slow one is left as Grok gave it (free/ctradar.ts)
  return { ...(host === GECKO_HOST || host === HUB_HOST || host === PUMP_API_HOST || host === FXTWITTER_HOST ? GECKO_HEDGE : FREE_HEDGE), ...(l ? { admitLeg: () => l.take() } : {}) };
}

/** Answer-level budget message (ours, generic) */
const BUDGET_MESSAGE = "the tool call limit for this answer is reached";
/** A call without an answer id (a harness bug: every call must belong to one answer) */
const NO_ANSWER_MESSAGE = "this call has no answer id";
/** Brief caching of a not-found or empty answer, or of a read cut short */
const SHORT_TTL_MS = 60_000;
/** Largest tool output passed to the brain, in characters of JSON */
const MAX_OUTPUT_CHARS = 60_000;
/** Characters of an ok result's summary its log line carries when its rows came back empty */
const SUMMARY_LOG_CHARS = 120;

/** The head of a summary for a call's log line, redacted, on one line: an ok result's when its rows came back empty */
function summaryHead(r: ToolResult, redact: (text: string) => string): string | null {
  let summary: unknown;
  if (r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data)) {
    const d = r.data as { rows?: unknown; summary?: unknown };
    if (Array.isArray(d.rows) && d.rows.length === 0 && typeof d.summary === "string") summary = d.summary;
  }
  if (typeof summary !== "string") return null;
  const s = redact(summary).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, SUMMARY_LOG_CHARS) : null;
}

/** A wallet's live balances are reused this long at most */
const WALLET_LIVE_TTL_MS = 30_000;
/**
 * Free tools that read a wallet's live balance: reused WALLET_LIVE_TTL_MS at most (sol_token_origin: what a token's
 * creator holds of it now)
 */
const WALLET_LIVE_FREE = new Set(["sol_account_basics", "sol_token_origin"]);
/** A slow tool's own timeout at least (a search on Grok: 20-40 s by nature) */
export const SLOW_TOOL_TIMEOUT_MS = 80_000;

/** A cached result and how long it is kept */
interface Cached {
  result: ToolResult;
  ttlMs: number;
}

export function createToolsWith(ctx: ModuleContext, opts: ToolsOptions = {}): Tools {
  const cfg = readToolsConfig(ctx.env);
  const now = opts.now ?? Date.now;
  // per-provider limiters (a hedge leg is counted against them too: toolsHedge)
  const limit: FreeContext["limit"] = {
    llama: new WindowLimiter(60, MINUTE, now),
    dexscreener: new WindowLimiter(120, MINUTE, now),
    gecko: new WindowLimiter(cfg.geckoPerMin, MINUTE, now),
    rpc: new WindowLimiter(240, MINUTE, now),
    polymarket: new WindowLimiter(60, MINUTE, now),
    // Jupiter's keyless API (its free tier's rate, about one call a second)
    jupiter: new WindowLimiter(60, MINUTE, now),
    // the X search on Grok, paid per post fetched (free/grokx.ts)
    xsearch: new WindowLimiter(XSEARCH_PER_MIN, MINUTE, now),
    // the web search on Grok, paid per call (free/grokweb.ts)
    news: new WindowLimiter(NEWS_PER_MIN, MINUTE, now),
    // the launch read over HELIUS_LAUNCH_KEYS (free/launch.ts)
    launch: new WindowLimiter(LAUNCH_PER_MIN, MINUTE, now),
    // the security check's keyless sources (free/security.ts), well under their own limits
    rugcheck: new WindowLimiter(RUGCHECK_PER_MIN, MINUTE, now),
    goplus: new WindowLimiter(GOPLUS_PER_MIN, MINUTE, now),
    // the data hub, every route and the chains' RPC together (free/hub.ts)
    hub: new WindowLimiter(HUB_PER_MIN, MINUTE, now),
    // pump.fun's own API, under its per-IP limits (free/pumpcallouts.ts)
    pump: new WindowLimiter(PUMP_PER_MIN, MINUTE, now),
  };
  const endpoints = rpcEndpoints(ctx.env);
  const limiterByHost = new Map<string, WindowLimiter>([
    ...LLAMA_HOSTS.map((h) => [h, limit.llama] as const),
    ["api.dexscreener.com", limit.dexscreener],
    [GECKO_HOST, limit.gecko],
    ...POLYMARKET_HOSTS.map((h) => [h, limit.polymarket] as const),
    ...JUPITER_HOSTS.map((h) => [h, limit.jupiter] as const),
    [RUGCHECK_HOST, limit.rugcheck],
    [GOPLUS_HOST, limit.goplus],
    [HUB_HOST, limit.hub],
    [PUMP_API_HOST, limit.pump],
    ...endpoints.map((e) => [new URL(e.url).host.toLowerCase(), limit.rpc] as const),
  ]);
  // Every request of the tools layer is a read (GETs of the free APIs, JSON-RPC reads), so it is safe to send twice:
  // hedged against a slow or flaky network (@crawlnet/shared hedgedFetch), each extra attempt counted against the same limits as a
  // call (toolsHedge). GeckoTerminal and the hub are repeated only after a network failure, never because they are slow.
  const fetchImpl: FetchLike =
    opts.fetch ??
    ((input, init) => {
      let host = "";
      try {
        host = new URL(input).host.toLowerCase();
      } catch {
        // Http.raw refuses a bad URL before it gets here
      }
      return hedgedFetch(input, init, toolsHedge(host, init?.body, { limiter: (h) => limiterByHost.get(h) }));
    });
  const log = ctx.log;
  const http = new Http(fetchImpl);
  for (const h of [...LLAMA_HOSTS, ...MARKET_HOSTS, ...POLYMARKET_HOSTS, ...JUPITER_HOSTS]) http.allow(h);
  const redactor: Redactor = createRedactor(redactionTerms(ctx.env), redactionKeep(ctx.env));

  // ─────────────── free providers
  const fc: FreeContext = {
    http,
    now,
    limit,
    warm: opts.background !== false && !opts.fetch,
    log: ctx.log,
  };
  for (const e of endpoints) http.allow(new URL(e.url).host);
  const rpc = new SolanaRpc(fc, endpoints);
  // pump.fun's callouts, keyless; they set fc.pumpCallout, a callout's time for the side wallet tools (free/frontrun.ts)
  http.allow(PUMP_API_HOST);
  // the larp check's reads: a token's own links, its code on GitHub, its site's age (keyless public services)
  for (const h of LARP_HOSTS) http.allow(h);
  const free: ToolDef[] = [...defillamaTools(fc), ...marketTools(fc), ...jupiterTools(fc), ...polymarketTools(fc), ...solanaTools(fc, rpc), ...pumpCalloutsTools(fc), ...larpTools(fc, cfg.githubToken)];
  // a paid provider's calls a UTC day, kept in tools_usage (in memory only when the db cannot take it)
  const usage = (limit: number, column: UsageColumn): DailyCounter => {
    try {
      return new DailyCounter(limit, ctx.db, now, column);
    } catch {
      return new DailyCounter(limit, null, now, column);
    }
  };
  // the X and web searches on Grok
  if (cfg.xSearch) {
    http.allow(new URL(cfg.xSearch.baseUrl).host);
    free.push(...grokXTools(fc, cfg.xSearch, usage(cfg.xSearch.dailyCalls, "xsearch_calls")));
  }
  if (cfg.news) {
    http.allow(new URL(cfg.news.baseUrl).host);
    free.push(...grokWebTools(fc, cfg.news, usage(cfg.news.dailyCalls, "news_calls")));
  }
  // the launch read over HELIUS_LAUNCH_KEYS
  if (cfg.launch) {
    http.allow(HELIUS_LAUNCH_HOST);
    free.push(...launchTools(fc, cfg.launch, ctx.db));
  }
  // the live narratives: the pump.fun index's labels and metas (the services' files, read-only)
  if (cfg.narratives) free.push(...narrativeTools(fc, cfg.narratives));
  // the security check on RugCheck and GoPlus (TOOLS_SECURITY=off leaves it out)
  if (cfg.security) {
    http.allow(RUGCHECK_HOST);
    http.allow(GOPLUS_HOST);
    free.push(...securityTools(fc));
  }
  // the data hub: its catalog's routes (hub_find, hub_call) and the chains' RPC (hub_rpc); none without its key
  if (cfg.hub) {
    http.allow(HUB_HOST);
    free.push(...hubTools(fc, cfg.hub, usage(cfg.hub.dailyCalls, "hub_calls"), usage(cfg.hub.dailyCredits, "hub_credits")));
  }
  // the CT calls radar: X posts calling Solana memecoins, read in the background (twitterapi.io when its key is set, else
  // Grok on the X search's key) into its own tables, and ct_calls over them; none without a source key
  let ctradar: CtRadar | null = null;
  if (cfg.ctRadar) {
    if (cfg.ctRadar.twitterapiKey) http.allow(TWITTERAPI_HOST);
    // Grok's lanes, and FxTwitter's status reads of the posts its search cites
    if (cfg.ctRadar.grok) {
      http.allow(new URL(cfg.ctRadar.grok.baseUrl).host);
      http.allow(FXTWITTER_HOST);
    }
    try {
      ctradar = new CtRadar(fc, cfg.ctRadar, ctx.db, log);
      free.push(...ctRadarTools(ctradar, fc));
    } catch {
      log("tools: ct radar left out (its tables could not be made)");
    }
  }

  // definitions that do not validate are left out (and the tests fail on them)
  const broken = new Set<string>();
  for (const d of free) {
    const p = schemaProblems(d);
    if (p.length) {
      broken.add(d.name);
      log("tools: broken tool definition left out", { tool: d.name });
    }
  }
  const freeByName = new Map(free.filter((d) => !broken.has(d.name)).map((d) => [d.name, d]));

  const budget = new AnswerBudget(cfg.maxCallsPerAnswer, now);
  const cache = new TtlCache<Cached>(cfg.cacheMax, now);

  // the CT radar's collector in the background (never in tests), and only while ct_calls is offered: nothing read for no one
  if (ctradar && opts.background !== false && freeByName.has("ct_calls") && !cfg.disabled.has("ct_calls")) ctradar.start();

  type Spec = ToolSpec & {
    ttlMs: number;
    webSources: boolean;
    /** A search: its own longer timeout */
    slow: boolean;
    /** A wallet's live balances: WALLET_LIVE_TTL_MS at most */
    walletLive: boolean;
  };

  function specs(): Spec[] {
    const out: Spec[] = [];
    for (const d of freeByName.values())
      if (!cfg.disabled.has(d.name) && !d.down?.()) out.push({ name: d.name, description: d.description, parameters: d.parameters, ttlMs: d.ttlMs, webSources: d.webSources === true, slow: d.slow === true, walletLive: WALLET_LIVE_FREE.has(d.name) });
    return out;
  }

  /** How long an ok result of this call is reused: a wallet's live balances 30 s at most */
  const ttlOf = (spec: Spec): number => (spec.walletLive ? Math.min(spec.ttlMs, WALLET_LIVE_TTL_MS) : spec.ttlMs);

  const fail = (error: ToolError, message?: string): ToolResult => ({ ok: false, error, message: message ?? GENERIC_MESSAGE[error] });

  function finalize(outcome: Outcome, webSources: boolean): ToolResult {
    // our own refusal, or what the source said was wrong (redacted), for the model to fix its arguments
    if (!outcome.ok) return fail(outcome.error, outcome.message ?? (outcome.detail ? `the query failed: ${redactor.text(outcome.detail)}` : undefined));
    const data = redactor.deep(outcome.data);
    const sources: ToolSource[] = [];
    for (const s of redactor.sources(outcome.sources)) {
      const url = primaryUrl(s.url) ?? (webSources ? webPageUrl(s.url) : null);
      if (!url) continue;
      sources.push({ title: redactor.text(cleanText(s.title, 120) ?? "source"), url });
    }
    let size = 0;
    try {
      size = JSON.stringify(data).length;
    } catch {
      return fail("unavailable");
    }
    if (size > MAX_OUTPUT_CHARS) return fail("unavailable");
    return { ok: true, data, sources };
  }

  /** One call to its provider (no cache): the result and how long to keep it */
  async function load(spec: Spec, args: Record<string, unknown>, caller = ""): Promise<Cached> {
    const signal = AbortSignal.timeout(spec.slow ? Math.max(cfg.timeoutMs, SLOW_TOOL_TIMEOUT_MS) : cfg.timeoutMs);
    let outcome: Outcome;
    try {
      outcome = await freeByName.get(spec.name)!.run(args, { signal, ...(caller ? { caller } : {}) });
    } catch (err) {
      outcome = { ok: false, error: err instanceof ToolFail ? err.code : "unavailable" };
    }
    const result = finalize(outcome, spec.webSources);
    const ttl = ttlOf(spec);
    // a read cut short for a passing reason is kept briefly, so the next caller gets further; one cut at its own size
    // is not, or every caller would read it again each minute
    const brief = outcome.ok && outcome.brief === true;
    // ok: the tool's TTL (a read cut for a passing reason briefly); not found briefly; anything else not at all
    const ttlMs = result.ok ? (brief ? Math.min(SHORT_TTL_MS, ttl) : ttl) : result.error === "not_found" ? Math.min(SHORT_TTL_MS, ttl) : 0;
    return { result, ttlMs };
  }

  async function exec(name: string, rawArgs: unknown, ctxRun: ToolRunContext): Promise<{ result: ToolResult; cached: boolean }> {
    const spec = specs().find((s) => s.name === name);
    if (!spec) return { result: fail("bad_args", "there is no such tool now"), cached: false };
    if (!budget.take(ctxRun.answerId)) return { result: fail("rate_limited", BUDGET_MESSAGE), cached: false };
    const v = validateArgs(spec.parameters, rawArgs);
    if (!v.ok) return { result: fail("bad_args", v.message), cached: false };
    const key = callKey(name, v.args);
    const hit = cache.get(key);
    if (hit) return { result: hit.result, cached: true };
    // identical calls in flight at once (parallel tool calls, two answers about the same token) share one request
    const shared = cache.through(key, () => load(spec, v.args, callerOf(ctxRun.answerId)), (c) => c.ttlMs);
    const c = ctxRun.signal ? await raceAbort(shared, ctxRun.signal) : await shared;
    return { result: c.result, cached: false };
  }

  const tools: Tools = {
    config: cfg,
    ctradar,
    list: () => specs().map(({ name, description, parameters }) => ({ name, description, parameters })),
    async run(name, args, ctxRun) {
      const t0 = now();
      let out: { result: ToolResult; cached: boolean };
      try {
        const answerId = ctxRun && typeof ctxRun.answerId === "string" ? ctxRun.answerId.trim() : "";
        // every call belongs to one answer; no shared bucket for calls without one
        out = answerId ? await exec(String(name), args, { ...ctxRun, answerId }) : { result: fail("bad_args", NO_ANSWER_MESSAGE), cached: false };
      } catch {
        out = { result: fail("unavailable"), cached: false };
      }
      const { result } = out;
      const known = /^[a-z][a-z0-9_]{2,47}$/.test(String(name)) && specs().some((s) => s.name === name);
      const head = summaryHead(result, tools.redact);
      log("tools: call", {
        tool: known ? String(name) : "(unknown)",
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
        ms: now() - t0,
        ...(out.cached ? { cached: true } : {}),
        ...(head ? { summary: head } : {}),
      });
      return result;
    },
    redact: (text) => redactor.text(text),
    redactSources: (sources) => redactor.sources(sources),
    stop() {
      ctradar?.stop();
    },
    blocked: (text) => redactor.blocked(text),
  };
  log("tools: ready", { tools: freeByName.size, ...(ctradar ? { ct_radar: ctradar.callsSource } : {}) });
  return tools;
}
