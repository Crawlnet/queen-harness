// Environment of the tools layer. Keys come only from env (no defaults); without one, that provider's tools are simply
// absent. Messages here never echo a URL or a key.

import { CALLS_MIN_GROK, CALLS_MIN_TWITTERAPI, TOP_MIN, type CtRadarConfig } from "./free/ctradar.ts";
import type { NewsSearchConfig } from "./free/grokweb.ts";
import type { XSearchConfig } from "./free/grokx.ts";
import type { LaunchConfig } from "./free/launch.ts";
import type { HubConfig } from "./free/hub.ts";
import type { NarrativeConfig } from "./free/narratives.ts";

export interface ToolsConfig {
  /** Tool calls one answer may make at most (TOOLS_MAX_CALLS_PER_ANSWER, 12) */
  maxCallsPerAnswer: number;
  /** One tool call's timeout (TOOLS_TIMEOUT_MS, 8000) */
  timeoutMs: number;
  /** Cached tool results kept (TOOLS_CACHE_MAX, 500) */
  cacheMax: number;
  /** Tools left out by the operator (TOOLS_DISABLE, a comma list of our tool names) */
  disabled: Set<string>;
  /** GeckoTerminal calls per minute (TOOLS_GECKO_PER_MIN, 10: its free API's limit) */
  geckoPerMin: number;
  /**
   * The X search on Grok through OpenRouter (free/grokx.ts): its key (TOOLS_XSEARCH_KEY, else the harness's LLM_API_KEY
   * when LLM_BASE_URL is OpenRouter's), model (TOOLS_XSEARCH_MODEL, x-ai/grok-4.3) and calls a UTC day
   * (TOOLS_XSEARCH_DAILY_CALLS, 100); null without a key or with TOOLS_XSEARCH=off
   */
  xSearch: XSearchConfig | null;
  /**
   * The web search on Grok through OpenRouter (free/grokweb.ts): the X search's key (TOOLS_XSEARCH_KEY, else the
   * harness's LLM_API_KEY when LLM_BASE_URL is OpenRouter's), model (TOOLS_NEWS_MODEL, x-ai/grok-4.3) and calls a UTC
   * day (TOOLS_NEWS_DAILY_CALLS, 100); null without a key or with TOOLS_NEWS=off
   */
  news: NewsSearchConfig | null;
  /**
   * The launch read over Helius (free/launch.ts): HELIUS_LAUNCH_KEYS, one key or a comma list of your keys, their
   * credits counted a UTC day (tools_helius_credits); null without one
   */
  launch: LaunchConfig | null;
  /**
   * The live-narrative tools over the services' data (free/narratives.ts): NARRATIVE_DIR, the folder that holds migration/
   * and ai-x-radar/ (read only); null without it
   */
  narratives: NarrativeConfig | null;
  /**
   * The security check on RugCheck (Solana) and GoPlus (EVM), both keyless (free/security.ts): our token_risk_flags
   * unless TOOLS_SECURITY=off
   */
  security: boolean;
  /**
   * The data hub (free/hub.ts): its key (API_HUB_KEY, server only), its calls a UTC day (TOOLS_HUB_DAILY_CALLS, 20000)
   * and its credit-billed routes' weight a UTC day (TOOLS_HUB_DAILY_CREDITS, 3000: the on-chain labels); null without a
   * key or with TOOLS_HUB=off: no hub_find, hub_call or hub_rpc
   */
  hub: HubConfig | null;
  /**
   * The CT calls radar (free/ctradar.ts): X posts calling Solana memecoins, read in the background by twitterapi.io
   * when its key is set (TOOLS_TWITTERAPI_KEY, server only), else by Grok on the X search's key, model and endpoint
   * (xSearch above), every TOOLS_CTRADAR_MIN minutes (5 on twitterapi.io, 20 on Grok), the authors with
   * TOOLS_CTRADAR_MIN_FOLLOWERS (1000) followers at least; and Grok's top calls, the most liked or viewed of the last 6
   * h, every TOOLS_CTRADAR_TOP_MIN (30) whenever the X search's key is there; null without either source or with TOOLS_CTRADAR=off: no ct_calls, nothing read
   */
  ctRadar: CtRadarConfig | null;
  /** A GitHub token for the larp check's API reads (GITHUB_TOKEN; a fine-grained one with public repositories read-only): 5,000 calls an hour instead of the server IP's 60, never shared with anything else on it; never logged or echoed */
  githubToken: string | null;
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v.trim() === "" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function readToolsConfig(env: NodeJS.ProcessEnv): ToolsConfig {
  const xSearch = xSearchFrom(env);
  return {
    maxCallsPerAnswer: int(env.TOOLS_MAX_CALLS_PER_ANSWER, 12, 0, 50),
    timeoutMs: int(env.TOOLS_TIMEOUT_MS, 8000, 500, 60_000),
    cacheMax: int(env.TOOLS_CACHE_MAX, 500, 0, 100_000),
    disabled: new Set(
      (env.TOOLS_DISABLE ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    geckoPerMin: int(env.TOOLS_GECKO_PER_MIN, 10, 0, 1000),
    xSearch,
    news: newsFrom(env),
    launch: launchFrom(env),
    narratives: env.NARRATIVE_DIR?.trim() ? { dir: env.NARRATIVE_DIR.trim() } : null,
    security: (env.TOOLS_SECURITY ?? "").trim().toLowerCase() !== "off",
    hub: hubFrom(env),
    ctRadar: ctRadarFrom(env, xSearch),
    githubToken: (env.GITHUB_TOKEN ?? "").trim() || null,
  };
}

/** The CT calls radar's settings (ToolsConfig.ctRadar), or null; the keys are never logged or echoed */
function ctRadarFrom(env: NodeJS.ProcessEnv, xSearch: XSearchConfig | null): CtRadarConfig | null {
  if ((env.TOOLS_CTRADAR ?? "").trim().toLowerCase() === "off") return null;
  const key = (env.TOOLS_TWITTERAPI_KEY ?? "").trim();
  const twitterapiKey = /^[\x21-\x7e]{16,512}$/.test(key) ? key : null;
  const grok = xSearch ? { key: xSearch.key, model: xSearch.model, baseUrl: xSearch.baseUrl } : null;
  if (!twitterapiKey && !grok) return null;
  return {
    twitterapiKey,
    grok,
    callsMin: int(env.TOOLS_CTRADAR_MIN, twitterapiKey ? CALLS_MIN_TWITTERAPI : CALLS_MIN_GROK, 1, 1440),
    topMin: int(env.TOOLS_CTRADAR_TOP_MIN, TOP_MIN, 5, 1440),
    minFollowers: int(env.TOOLS_CTRADAR_MIN_FOLLOWERS, 1000, 0, 10_000_000),
  };
}

/** The data hub's settings (ToolsConfig.hub), or null; the key is never logged or echoed */
function hubFrom(env: NodeJS.ProcessEnv): HubConfig | null {
  if ((env.TOOLS_HUB ?? "").trim().toLowerCase() === "off") return null;
  const key = (env.API_HUB_KEY ?? "").trim();
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(key)) return null;
  return { key, dailyCalls: int(env.TOOLS_HUB_DAILY_CALLS, 20_000, 0, 1_000_000), dailyCredits: int(env.TOOLS_HUB_DAILY_CREDITS, 3000, 0, 1_000_000) };
}

/** The launch read's Helius keys (ToolsConfig.launch), or null */
function launchFrom(env: NodeJS.ProcessEnv): LaunchConfig | null {
  const keys = (env.HELIUS_LAUNCH_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => /^[A-Za-z0-9-]{20,64}$/.test(k));
  return keys.length ? { keys } : null;
}

const GROK_MODEL = "x-ai/grok-4.3";
const ROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenRouter's key for the searches on Grok: TOOLS_XSEARCH_KEY, else the queen's when she is on OpenRouter; null for none */
function routerKey(env: NodeJS.ProcessEnv): string | null {
  const llmOnRouter = /^https:\/\/openrouter\.ai\//.test((env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").trim());
  const key = (env.TOOLS_XSEARCH_KEY ?? "").trim() || (llmOnRouter ? (env.LLM_API_KEY ?? "").trim() : "");
  return /^[\x21-\x7e]{16,512}$/.test(key) ? key : null;
}

/** A search's Grok model as set (a model id), else GROK_MODEL */
function grokModel(v: string | undefined): string {
  const model = (v ?? "").trim() || GROK_MODEL;
  return /^[\w.:/-]{3,100}$/.test(model) ? model : GROK_MODEL;
}

/** The X search on Grok's settings (ToolsConfig.xSearch), or null */
function xSearchFrom(env: NodeJS.ProcessEnv): XSearchConfig | null {
  if ((env.TOOLS_XSEARCH ?? "").trim().toLowerCase() === "off") return null;
  const key = routerKey(env);
  if (!key) return null;
  return { key, model: grokModel(env.TOOLS_XSEARCH_MODEL), baseUrl: ROUTER_BASE_URL, dailyCalls: int(env.TOOLS_XSEARCH_DAILY_CALLS, 100, 0, 100_000) };
}

/** The web search on Grok's settings (ToolsConfig.news), or null */
function newsFrom(env: NodeJS.ProcessEnv): NewsSearchConfig | null {
  if ((env.TOOLS_NEWS ?? "").trim().toLowerCase() === "off") return null;
  const key = routerKey(env);
  if (!key) return null;
  return { key, model: grokModel(env.TOOLS_NEWS_MODEL), baseUrl: ROUTER_BASE_URL, dailyCalls: int(env.TOOLS_NEWS_DAILY_CALLS, 100, 0, 100_000) };
}
