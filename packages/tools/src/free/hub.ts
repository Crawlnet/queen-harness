// The data hub (API Hub, hub.arbitron.dev; its site gives a free key): one keyed API in front of two dozen sources
// (on-chain labels, clusters and counterparties; Solana and EVM wallet PnL; OKX's holder reads and compliance check;
// CoinMarketCap, CoinGecko, DexScreener, DEXTools, GeckoTerminal; TradingView's screener; Polymarket and Kalshi;
// bridges' transfer status; X) and a JSON-RPC to 153 chains, every route a read. Three tools take all of it, and each call's route is logged, so the harness can learn
// which route answers what:
//   - hub_find: the hub's catalog (its OpenAPI, read at start and twice a day) searched by words, our own words added
//     to the routes the queen needs most (HINTS: the catalog's summary is often its path read aloud): each route's
//     method, path, what it returns, its params (the required ones, an example) and its cost; no words: the sources;
//   - hub_call: one route of the catalog: the path matched to it (a route it does not list is never sent), the required
//     params checked first, the source's own complaint handed back so the next call fixes it, the answer cut to fit
//     (lists to max_items, long text cut, empty fields left out, or only the fields asked for), the cuts said;
//   - hub_rpc: a chain's read method; one that sends, signs or broadcasts is refused here (the hub refuses it too).
//     Every call counts against TOOLS_HUB_DAILY_CALLS a UTC day and a credit-billed route's weight (the on-chain
//     labels) against TOOLS_HUB_DAILY_CREDITS (tools_usage). The key rides in a header only, never in a URL or a log
//     line. A 429 says how long to wait: that source (X search's fair share) or the whole hub pauses that long. The
//     sources behind it are named as the primary sites they are.

import type { ToolSource } from "@crawlnet/shared";
import { MB, readCapped } from "../http.ts";
import { arkhamAddress, evmAddress, evmTx, solAccount, solTx, src, uniqueSources, xPost } from "../links.ts";
import type { DailyCounter, WindowLimiter } from "../limits.ts";
import { limitParam } from "../schema.ts";
import { HOUR, MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { Dataset, isObj, num, round, str, take, type FreeContext } from "./common.ts";

export const HUB_HOST = "hub.arbitron.dev";
const BASE = `https://${HUB_HOST}`;
/** Calls a minute at most, every caller together */
export const HUB_PER_MIN = 600;
/** The catalog is read again after this */
const CATALOG_TTL_MS = 12 * HOUR;
/** An answer's JSON at most, characters (the registry refuses one over 60,000) */
export const FIT_CHARS = 40_000;
/** A 429's pause at most */
const PAUSE_MAX_MS = 10 * MINUTE;
/** A refused key: no call for this long */
const KEY_PAUSE_MS = 5 * MINUTE;
/** A source's answer read at most */
const ANSWER_MAX_BYTES = 8 * MB;

export interface HubConfig {
  key: string;
  /** Calls a UTC day (TOOLS_HUB_DAILY_CALLS) */
  dailyCalls: number;
  /** Credit-billed routes' weight a UTC day (TOOLS_HUB_DAILY_CREDITS) */
  dailyCredits: number;
}

// ───────────────────────────── the catalog

/** A route's param as the catalog gives it */
interface HubParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  enum?: string[];
  example?: string;
  about?: string;
}

interface Seg {
  /** The catalog's text of this segment ("intelligence", "{address}", "{chainId}:{pairId}") */
  text: string;
  /** null: a literal; else its params' names, matched by `re` */
  names: string[] | null;
  re: RegExp | null;
}

export interface HubRoute {
  provider: string;
  method: "GET" | "POST";
  /** After /run/{provider}: "/intelligence/address/{address}" */
  path: string;
  segs: Seg[];
  what: string;
  params: HubParam[];
  /** A POST route's JSON body: its fields (name, type, required, example) or its example; null: none */
  body: unknown;
  bodyRequired: boolean;
  /** Credit-billed: its weight a call (0: free) */
  credits: number;
  words: { provider: Set<string>; path: Set<string>; hint: Set<string>; what: Set<string>; params: Set<string> };
}

export interface HubCatalog {
  routes: HubRoute[];
  byProvider: Map<string, HubRoute[]>;
  /** Each source's own description (the catalog's tags) */
  tags: Map<string, string>;
}

const PROVIDER_RE = /^[a-z0-9_]{2,40}$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compileSeg(text: string): Seg {
  if (!text.includes("{")) return { text, names: null, re: null };
  const names: string[] = [];
  const src = text
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const m = /^\{([^}]+)\}$/.exec(part);
      if (!m) return escapeRe(part);
      names.push(m[1]!);
      return "([^/]+?)";
    })
    .join("");
  return { text, names, re: new RegExp(`^${src}$`) };
}

const exampleText = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s ? s.slice(0, 160) : undefined;
};

/** A POST route's body as the model needs it: its fields with type, required and an example; else its example */
function bodyOf(op: Record<string, unknown>): { body: unknown; required: boolean } {
  const rb = isObj(op.requestBody) ? op.requestBody : null;
  const content = rb && isObj(rb.content) && isObj(rb.content["application/json"]) ? rb.content["application/json"] : null;
  if (!content) return { body: null, required: false };
  const schema = isObj(content.schema) ? content.schema : {};
  const required = rb?.required === true;
  if (isObj(schema.properties)) {
    const req = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
    const fields: Record<string, unknown>[] = [];
    for (const [name, p] of Object.entries(schema.properties).slice(0, 20)) {
      if (!isObj(p)) continue;
      const ex = exampleText(p.example);
      const about = str(p.description, 140);
      fields.push({ name, type: typeof p.type === "string" ? p.type : "any", ...(req.has(name) ? { required: true } : {}), ...(ex !== undefined ? { example: ex } : {}), ...(about ? { about } : {}) });
    }
    return { body: { fields }, required };
  }
  const ex = exampleText(content.example ?? schema.example);
  const about = str(schema.description, 160);
  return { body: { ...(typeof schema.type === "string" ? { type: schema.type } : {}), ...(ex !== undefined ? { example: ex } : {}), ...(about ? { about } : {}) }, required };
}

function paramOf(p: unknown): HubParam | null {
  if (!isObj(p) || typeof p.name !== "string" || (p.in !== "path" && p.in !== "query")) return null;
  const schema = isObj(p.schema) ? p.schema : {};
  const en = Array.isArray(schema.enum) ? schema.enum.filter((x) => typeof x === "string" || typeof x === "number").map(String) : [];
  const ex = exampleText(p.example ?? schema.example ?? schema.default);
  const about = str(p.description, 140);
  return {
    name: p.name,
    in: p.in,
    required: p.in === "path" || p.required === true,
    ...(en.length ? { enum: en.slice(0, 16) } : {}),
    ...(ex !== undefined ? { example: ex } : {}),
    ...(about ? { about } : {}),
  };
}

/** The hub's OpenAPI as routes: its read-only /run routes only */
export function parseCatalog(spec: unknown): HubCatalog {
  if (!isObj(spec) || !isObj(spec.paths)) throw new ToolFail("unavailable");
  const tags = new Map<string, string>();
  if (Array.isArray(spec.tags)) for (const t of spec.tags) if (isObj(t) && typeof t.name === "string") tags.set(t.name, str(t.description, 400) ?? "");
  const routes: HubRoute[] = [];
  for (const [full, item] of Object.entries(spec.paths)) {
    if (!full.startsWith("/run/") || !isObj(item)) continue;
    for (const m of ["get", "post"] as const) {
      const op = item[m];
      if (!isObj(op) || op["x-api-hub-read-only"] !== true) continue;
      const provider = typeof op["x-api-hub-provider"] === "string" ? op["x-api-hub-provider"] : (full.split("/")[2] ?? "");
      if (!PROVIDER_RE.test(provider) || !full.startsWith(`/run/${provider}/`)) continue;
      const path = full.slice(`/run/${provider}`.length);
      const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map(paramOf)
        .filter((p): p is HubParam => p !== null);
      const cost = isObj(op["x-api-hub-cost"]) ? op["x-api-hub-cost"] : {};
      const credits = op["x-api-hub-billing-type"] === "credits" ? Math.max(1, Math.round(num(cost.weight) ?? 1)) : 0;
      const what = str(op.summary, 200) ?? str(op.description, 200) ?? path;
      const method = m === "get" ? "GET" : "POST";
      const { body, required } = m === "post" ? bodyOf(op) : { body: null, required: false };
      routes.push({
        provider,
        method,
        path,
        segs: path.split("/").slice(1).map(compileSeg),
        what,
        params,
        body,
        bodyRequired: required,
        credits,
        words: {
          provider: new Set([provider, ...provider.split("_")].map(stem)),
          path: new Set(wordsOf(path.replace(/\{[^}]+\}/g, " "))),
          hint: new Set(wordsOf(HINTS[`${provider} ${method} ${path}`] ?? "")),
          what: new Set(wordsOf(what)),
          params: new Set(params.flatMap((p) => wordsOf(p.name))),
        },
      });
    }
  }
  if (!routes.length) throw new ToolFail("unavailable");
  const byProvider = new Map<string, HubRoute[]>();
  for (const r of routes) byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r]);
  return { routes, byProvider, tags };
}

// ───────────────────────────── the search

const STOP = new Set(["a", "an", "the", "of", "for", "by", "and", "or", "to", "in", "on", "with", "from", "at", "is", "are", "it", "its", "this", "that", "my", "me", "get", "list", "show", "all", "one", "data", "api", "run", "v1", "v2", "v3", "v4", "v5", "priapi", "dx", "web"]);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** Lower-case words of a text (camelCase split), stop words out, plurals folded */
export function wordsOf(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map(stem);
}

/** A word of an ask, and the catalog's words for the same thing */
const ALSO: Record<string, string[]> = {
  label: ["intelligence", "entity"],
  entity: ["intelligence"],
  owner: ["intelligence", "entity", "label"],
  own: ["intelligence", "entity", "label"],
  whose: ["intelligence", "entity", "label"],
  who: ["intelligence", "entity", "label"],
  identity: ["intelligence", "entity"],
  twitter: ["tweet", "x"],
  post: ["tweet"],
  profit: ["pnl"],
  unlock: ["vesting"],
  vesting: ["unlock"],
  rsi: ["scanner", "indicator"],
  macd: ["scanner", "indicator"],
  ema: ["scanner", "indicator"],
  indicator: ["scanner"],
  technical: ["scanner", "indicator"],
  bridge: ["status", "transfer"],
  crosschain: ["bridge"],
  compliance: ["precheck", "chainalysis"],
  sanction: ["precheck", "chainalysis", "compliance"],
  aml: ["precheck", "chainalysis", "compliance"],
  approval: ["approve", "allowance"],
  smart: ["smartmoney"],
  bundle: ["cluster"],
  sybil: ["cluster"],
  insider: ["cluster"],
  sniper: ["early", "buyer"],
  sentiment: ["fear", "greed"],
  odd: ["market", "event"],
  prediction: ["market", "event"],
};

/** A word of an ask that names a source by another name */
const PROVIDER_ALIASES: Record<string, string[]> = {
  okx: ["web3okx", "okxwallet", "oklink"],
  x: ["x_unified_api"],
  twitter: ["x_unified_api"],
  tweet: ["x_unified_api"],
  jupiter: ["jupiter_portfolio"],
  jup: ["jupiter_portfolio"],
  coinmarketcap: ["cmc"],
  gecko: ["geckoterminal", "coingecko"],
  llama: ["defillama"],
  tv: ["tradingview"],
  jumper: ["lifi"],
  layerzero: ["stargate"],
  bungee: ["socket"],
  skip: ["skip_go"],
  arkm: ["arkham"],
};

/**
 * Words of ours for the routes the queen needs most (the catalog's summary is often its path read aloud, arkham's
 * "address"), so a plain ask finds them: "whose wallet is this", "bundles", "unlocks"
 */
export const HINTS: Record<string, string> = {
  "arkham GET /intelligence/address/{address}": "who owns whose wallet label entity name exchange fund attribution",
  "arkham GET /intelligence/address_enriched/{address}": "who owns label entity tags",
  "arkham GET /cluster/address/{address}": "linked wallets same owner cluster",
  "arkham GET /counterparties/address/{address}": "counterparties who it sends to receives from top flows",
  "arkham GET /flow/address/{address}": "inflow outflow usd history",
  "arkham GET /token/holders/{chain}/{address}": "top holders labelled entities whales",
  "arkham GET /transfers": "transfers labelled flows whale moves",
  "arkham GET /tx/{hash}": "transaction labelled transfers who sent",
  "arkham GET /solana/address/{address}/pnl": "solana wallet pnl profit",
  "arkham GET /intelligence/search": "search entity name find who",
  "jupiter_portfolio GET /data/pnl-stats": "solana wallet pnl profit realized unrealized win rate trader",
  "jupiter_portfolio GET /data/pnl-token-breakdown": "solana wallet pnl per token",
  "jupiter_portfolio GET /portfolio/positions/{address}": "solana wallet defi positions staking lending lp",
  "jupiter_portfolio GET /chainalysis/{address}": "sanctions risk screening compliance",
  "web3okx GET /priapi/v1/holder-intelligence/cluster/info": "bundles insiders clusters bubble rug probability fresh wallets same funding source sybil",
  "web3okx GET /priapi/v1/dx/market/v2/holders/early-buyer/list": "early buyers snipers first buyers",
  "web3okx GET /priapi/v1/dx/market/v2/smartmoney/ranking/content": "smart money top traders ranking",
  "web3okx GET /priapi/v1/dx/market/v2/risk/new/check": "token risk honeypot contract check",
  "web3okx GET /priapi/v1/dx/market/v2/memefun/dev-analysis-summary": "dev developer history rugs launches",
  "web3okx GET /priapi/v1/dx/market/v2/pnl/wallet-profile/chain-pnl": "evm wallet pnl per chain",
  "okxwallet POST /priapi/v6/dx/trade/multi/preCheck": "compliance sanctions aml risky wallet check",
  "okxwallet POST /priapi/v6/dx/trade/multi/batchOkxApproveAllowance": "token approvals allowance spender",
  "cmc GET /api/data-api/v3/fear-greed/chart": "fear greed sentiment",
  "cmc GET /api/data-api/v3/token-unlock/listing": "unlocks vesting upcoming supply",
  "cmc GET /api/data-api/v3/global-metrics/quotes/latest": "total market cap dominance global",
  "tradingview POST /scanner/{market}/scan": "rsi macd ema sma moving average indicators technicals rating oscillators",
  "dextools GET /maker/top/{chain}/{pair}": "top traders profit pair makers",
  "dextools GET /token/audits/{chain}/{address}": "audit token risk flags",
  "lifi GET /pipeline/v1/status": "bridge transfer status cross-chain tx hash destination where funds went",
  "rubic GET /sdk/info/status": "bridge swap status cross-chain tx hash",
  "stargate GET /stats/overview/transfers/volume": "bridge volume address",
  "x_unified_api GET /2/tweets/search/recent": "search x twitter posts recent",
  "x_unified_api GET /2/tweets/search/all": "search x twitter posts archive dates since until",
  "x_unified_api GET /2/users/by/username/{username}/tweets": "x twitter user posts timeline caller",
  "dexscreener GET /metas/trending/v1": "trending narratives metas",
  "debank GET /user/total_balance": "evm wallet portfolio net worth balance per chain",
  "debank GET /portfolio/all_token_list": "evm wallet portfolio tokens holdings balances",
  "debank GET /portfolio/project_list": "evm wallet defi positions protocols",
  "polymarket GET /public-search": "polymarket odds market search event",
};

/** What each source covers, in our words (one the catalog adds later: its own description's first sentence) */
const ABOUT: Record<string, string> = {
  arkham: "on-chain labels: who owns an address (exchange, fund, entity), its cluster and counterparties, token holders by entity, labelled transfers and swaps, solana wallet pnl, polymarket and hyperliquid wallets (credit-billed)",
  web3okx: "okx web3: holder clusters (rug probability, fresh wallets, same funding), early buyers, smart money, token risk, dev history, trending memes, wallet pnl per chain",
  okxwallet: "okx wallet: compliance check of a wallet, token approvals and allowances, nft holdings, gas, swap quotes",
  oklink: "okx's explorer of 30+ chains: addresses, transactions, token and nft transfers, internal transactions",
  jupiter_portfolio: "jupiter: a solana wallet's positions across protocols, pnl stats, pnl per token, trades, transfers, token search with organic score",
  cmc: "coinmarketcap: listings, quotes, global metrics, fear and greed, token unlocks, exchanges, etfs, dex token pages",
  coingecko: "coingecko: prices, market caps, history, categories, dominance, exchanges, nfts",
  defillama: "defillama: tvl, fees, revenue, yields, stablecoins, token prices",
  dexscreener: "dex screener: pairs, prices, liquidity, token profiles, boosts, trending metas",
  dextools: "dextools: pairs, top traders of a pair, holders, audits, new and hot pools",
  geckoterminal: "geckoterminal: pools, trades, ohlcv, trending and new pools on 248 networks",
  tradingview: "tradingview: screener with indicators (rsi, macd, moving averages, ratings) for crypto and stocks, symbol search, news, economic calendar",
  polymarket: "polymarket: markets, events, prices, order books, holders, positions, leaderboards",
  kalshi: "kalshi: us event markets, events, series, order books, forecast history",
  debank: "debank: evm wallet balances, protocol positions, net worth history, profiles",
  lifi: "li.fi (jumper): bridge routes, a transfer's status by its source tx hash, the transfer feed",
  stargate: "stargate (layerzero): bridge quotes, transfer status, an address's bridge volume",
  rango: "rango: cross-chain routes, wallet balances, transaction status",
  rubic: "rubic: cross-chain quotes, a swap's status by its tx hash, trending tokens",
  socket: "bungee (socket): bridge routes, a quote's and transfer's status",
  squid: "squid: cross-chain routes and their status",
  skip_go: "skip go: cosmos and evm cross-chain routes",
  dzap: "dzap: swap and bridge quotes, chains, tokens",
  x_unified_api: "x (twitter): search posts (recent, and the archive by dates), a user's posts, mentions, quotes, profiles",
};

/** Each word of an ask with the catalog's words for it */
function askTerms(query: string): string[][] {
  const out: string[][] = [];
  for (const w of [...new Set(wordsOf(query))]) out.push([w, ...(ALSO[w] ?? []).map(stem)]);
  return out;
}

/**
 * How well a route fits an ask: a word in our words on it 4 (they are meant: "token unlocks" is the listing, not the
 * allocations beside it), in its path or its source 3, in its summary 2, a param's name 1
 */
function scoreRoute(r: HubRoute, terms: string[][]): number {
  let total = 0;
  let hit = 0;
  for (const alts of terms) {
    let best = 0;
    for (const w of alts) {
      const named = PROVIDER_ALIASES[w]?.includes(r.provider) === true;
      if (r.words.hint.has(w)) best = Math.max(best, 4);
      else if (named || r.words.provider.has(w) || r.words.path.has(w)) best = Math.max(best, 3);
      else if (r.words.what.has(w)) best = Math.max(best, 2);
      else if (r.words.params.has(w)) best = Math.max(best, 1);
      else if (w.length >= 4 && [...r.words.path, ...r.words.hint].some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) best = Math.max(best, 1);
    }
    if (best) hit++;
    total += best;
  }
  return terms.length > 1 && hit === terms.length ? total + 2 : total;
}

/** A route as hub_find shows it */
function routeView(r: HubRoute): Record<string, unknown> {
  return {
    provider: r.provider,
    method: r.method,
    path: r.path,
    what: r.what,
    ...(r.params.length
      ? { params: r.params.map((p) => ({ name: p.name, ...(p.in === "path" ? { in: "path" } : {}), ...(p.required ? { required: true } : {}), ...(p.enum ? { one_of: p.enum } : {}), ...(p.example !== undefined ? { example: p.example } : {}), ...(p.about ? { about: p.about } : {}) })) }
      : {}),
    ...(r.body !== null ? { body: r.body, ...(r.bodyRequired ? { body_required: true } : {}) } : {}),
    cost: r.credits ? `${r.credits} credit${r.credits > 1 ? "s" : ""}` : "free",
  };
}

// ───────────────────────────── a call

/** A path's {placeholders} filled from params; the names filled and the ones left */
function fillPath(path: string, given: Map<string, string[]>): { path: string; filled: Set<string>; missing: string[] } {
  const filled = new Set<string>();
  const missing: string[] = [];
  const out = path.replace(/\{([^}/]+)\}/g, (whole, name: string) => {
    const v = given.get(name)?.[0];
    if (v === undefined) {
      missing.push(name);
      return whole;
    }
    filled.add(name);
    return v;
  });
  return { path: out, filled, missing };
}

/** The catalog route a concrete path is (its literal segments as written, then in any case), with its params' values */
export function matchRoute(routes: readonly HubRoute[], method: "GET" | "POST", path: string): { route: HubRoute; values: Record<string, string> } | null {
  const segs = path.split("/").slice(1);
  for (const anyCase of [false, true]) {
    let best: { route: HubRoute; values: Record<string, string>; lit: number } | null = null;
    for (const r of routes) {
      if (r.method !== method || r.segs.length !== segs.length) continue;
      const values: Record<string, string> = {};
      let lit = 0;
      let ok = true;
      for (let i = 0; i < segs.length && ok; i++) {
        const t = r.segs[i]!;
        const s = segs[i]!;
        if (!t.names) {
          if (t.text === s || (anyCase && t.text.toLowerCase() === s.toLowerCase())) lit++;
          else ok = false;
          continue;
        }
        const m = t.re!.exec(s);
        if (!m) ok = false;
        else t.names.forEach((n, k) => (values[n] = m[k + 1]!));
      }
      if (ok && (!best || lit > best.lit)) best = { route: r, values, lit };
    }
    if (best) return { route: best.route, values: best.values };
  }
  return null;
}

/** A path param's value: one segment, no traversal, no query or fragment */
const SEG_VALUE = /^[^\s/?#\\%]{1,300}$/u;

/** A param value's characters kept as they are in a path (the rest percent-encoded) */
const encodeSeg = (v: string): string => encodeURIComponent(v).replace(/%3A/gi, ":").replace(/%2C/gi, ",").replace(/%40/g, "@");

/** The concrete path to send: the catalog's literal segments, each param's value encoded */
function pathToSend(route: HubRoute, values: Record<string, string>): string | null {
  const out: string[] = [];
  for (const s of route.segs) {
    if (!s.names) {
      out.push(s.text);
      continue;
    }
    let text = s.text;
    for (const n of s.names) {
      const v = values[n] ?? "";
      if (!SEG_VALUE.test(v) || v === "." || v === "..") return null;
      text = text.replace(`{${n}}`, encodeSeg(v));
    }
    out.push(text);
  }
  return `/${out.join("/")}`;
}

/** "name=value" pairs, by name (a name given twice: both values) */
function parsePairs(list: unknown): Map<string, string[]> | string {
  const out = new Map<string, string[]>();
  for (const item of Array.isArray(list) ? list : []) {
    const s = String(item);
    const at = s.indexOf("=");
    const name = at > 0 ? s.slice(0, at).trim() : "";
    if (!/^[A-Za-z0-9_.[\]-]{1,64}$/.test(name)) return `params take name=value pairs ("${s.slice(0, 40)}" is not one)`;
    const value = s.slice(at + 1).trim();
    if (/[\u0000-\u001f]/.test(value)) return `${name} holds control characters`;
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

// ───────────────────────────── an answer cut to fit

interface Shrink {
  items: number;
  chars: number;
  depth: number;
}

/** A picture's field (a logo, an icon, a banner): nothing an answer can use, left out */
const IMAGE_KEY = /(logo|icon|image|img|avatar|banner|thumbnail)/i;
const IMAGE_URL = /^https?:\/\/\S+\.(png|jpe?g|gif|svg|webp|ico)(\?\S*)?$/i;
const TIME_KEY = /(time|date|timestamp)$/i;
const AT_KEY = /(_at|At|_ts|Active|Seen)$/;

/**
 * A time field's epoch (seconds or milliseconds, a number or digits) as an ISO time, so no answer converts one by
 * itself; null for anything else
 */
export function timeOf(key: string, v: unknown): string | null {
  if (!TIME_KEY.test(key) && !AT_KEY.test(key)) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{10}(\d{3})?(\.\d+)?$/.test(v) ? Number(v) : null;
  if (n === null || !Number.isFinite(n)) return null;
  const ms = n >= 1e12 && n < 2.2e12 ? n : n >= 1e9 && n < 2.2e9 ? n * 1000 : null;
  return ms === null ? null : new Date(Math.round(ms)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A long decimal shortened: 4 places from 1 up (a price keeps its cents), 6 significant digits below */
const shorter = (v: number): number => (Math.abs(v) >= 1 ? Math.round(v * 1e4) / 1e4 : (round(v, 6) ?? v));

/**
 * A copy cut to `o`: lists to `items` (the cut noted by its path), text to `chars`, objects below `depth` left out, empty
 * fields and pictures out, epoch times as ISO
 */
function shrink(v: unknown, o: Shrink, path: string, cuts: Map<string, { kept: number; of: number }>, depth: number, deep: { cut: boolean }): unknown {
  if (typeof v === "string") return v.length > o.chars ? `${v.slice(0, o.chars)}…` : v;
  if (typeof v === "number") return Number.isInteger(v) ? v : shorter(v);
  if (Array.isArray(v)) {
    if (v.length > o.items) {
      const prev = cuts.get(path);
      cuts.set(path, { kept: o.items, of: Math.max(v.length, prev?.of ?? 0) });
    }
    return v.slice(0, o.items).map((x) => shrink(x, o, `${path}[]`, cuts, depth + 1, deep));
  }
  if (isObj(v)) {
    if (depth >= o.depth) {
      deep.cut = true;
      return "…";
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined || x === "" || (Array.isArray(x) && x.length === 0) || (isObj(x) && Object.keys(x).length === 0)) continue;
      if ((IMAGE_KEY.test(k) && (typeof x === "string" || isObj(x))) || (typeof x === "string" && IMAGE_URL.test(x))) continue;
      out[k] = timeOf(k, x) ?? shrink(x, o, path ? `${path}.${k}` : k, cuts, depth + 1, deep);
    }
    return out;
  }
  return v;
}

const LADDER: Shrink[] = [
  { items: Infinity, chars: 500, depth: 14 },
  { items: 10, chars: 300, depth: 10 },
  { items: 5, chars: 160, depth: 8 },
  { items: 3, chars: 100, depth: 6 },
  { items: 2, chars: 60, depth: 4 },
];

/** An answer cut until its JSON fits FIT_CHARS (lists to `maxItems` at most), with what was cut; null: it never fits */
export function fit(v: unknown, maxItems: number): { data: unknown; cut: string[] } | null {
  for (const step of LADDER) {
    const o = { items: Math.min(maxItems, step.items), chars: step.chars, depth: step.depth };
    const cuts = new Map<string, { kept: number; of: number }>();
    const deep = { cut: false };
    const data = shrink(v, o, "", cuts, 0, deep);
    if ((JSON.stringify(data) ?? "null").length > FIT_CHARS) continue;
    const cut = [...cuts].slice(0, 12).map(([p, c]) => `${p || "the list"}: ${c.kept} of ${c.of}`);
    if (deep.cut) cut.push(`fields deeper than ${o.depth} levels left out`);
    return { data, cut };
  }
  return null;
}

/** Only the fields asked for ("data.items.address": lists are walked through); the ones that matched nothing */
export function pick(v: unknown, fields: string[]): { data: unknown; missed: string[] } {
  type Tree = Map<string, Tree | true>;
  const tree: Tree = new Map();
  for (const f of fields) {
    const keys = f.replace(/\[\]/g, "").split(".").filter(Boolean);
    let t = tree;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) t.set(k, true);
      else {
        const next = t.get(k);
        if (next === true) return;
        const sub: Tree = next ?? new Map();
        t.set(k, sub);
        t = sub;
      }
    });
  }
  const hits = new Set<string>();
  const walk = (x: unknown, t: Tree, at: string): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y, t, at));
    if (!isObj(x)) return x;
    const out: Record<string, unknown> = {};
    for (const [k, sub] of t) {
      if (!Object.hasOwn(x, k)) continue;
      const p = at ? `${at}.${k}` : k;
      if (sub === true) {
        hits.add(p);
        out[k] = x[k];
      } else out[k] = walk(x[k], sub, p);
    }
    return out;
  };
  const data = walk(v, tree, "");
  const missed = fields.filter((f) => !hits.has(f.replace(/\[\]/g, "").split(".").filter(Boolean).join(".")));
  return { data, missed };
}

/** The source's own words on a refused call (a 400): its message, short */
function complaint(j: unknown): string | null {
  const data = isObj(j) ? j.data : null;
  for (const v of [isObj(data) ? (data.message ?? data.msg ?? data.error ?? data.detail ?? data.error_message) : data, isObj(j) ? j.hint : null]) {
    const s = typeof v === "string" ? v : isObj(v) || Array.isArray(v) ? JSON.stringify(v) : null;
    const t = str(s, 300);
    if (t) return t;
  }
  return null;
}

/** An OKX-style answer that failed inside a 200: a code other than 0 or 200, a message, no data */
function failedInside(data: unknown): string | null {
  if (!isObj(data) || !("code" in data)) return null;
  const code = String(data.code);
  if (code === "0" || code === "200") return null;
  const inner = data.data;
  if (inner !== undefined && inner !== null && !(Array.isArray(inner) && inner.length === 0)) return null;
  return str(data.msg ?? data.message ?? data.error_message, 300);
}

// ───────────────────────────── sources

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** A chain param's value as our explorer names (an EVM chain's name or id) */
const CHAIN_NAMES: Record<string, string> = {
  "1": "ethereum", eth: "ethereum", ethereum: "ethereum", mainnet: "ethereum",
  "56": "bsc", bsc: "bsc", bnb: "bsc", binance: "bsc",
  "8453": "base", base: "base",
  "42161": "arbitrum", arbitrum: "arbitrum", arb: "arbitrum",
  "10": "optimism", optimism: "optimism", op: "optimism",
  "137": "polygon", polygon: "polygon", matic: "polygon",
  "43114": "avalanche", avalanche: "avalanche", avax: "avalanche",
};

const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** A post's id among an X route's params (a user's id is a number too: only these names) */
const X_POST_PARAM = /^(tweet_id|id|ids)$/;

/**
 * Links to what a call was about, from its params (name, value): an address or a transaction on its explorer (arkham's
 * labels: its own page), a post on x
 */
function sourcesOf(provider: string, params: [string, string][], chain: string | null): ToolSource[] {
  const evm = chain ? (CHAIN_NAMES[chain.toLowerCase()] ?? null) : "ethereum";
  const out: (ToolSource | null)[] = [];
  for (const [name, v] of params) {
    if (EVM_ADDR.test(v)) out.push(provider === "arkham" ? src(`${short(v)} on arkham`, arkhamAddress(v)) : evm ? src(`${short(v)} on the explorer`, evmAddress(evm, v)) : null);
    else if (EVM_HASH.test(v)) out.push(evm ? src("the transaction on the explorer", evmTx(evm, v)) : null);
    else if (SOL_SIG.test(v)) out.push(src("the transaction on solscan", solTx(v)));
    else if (SOL_ADDR.test(v)) out.push(provider === "arkham" ? src(`${short(v)} on arkham`, arkhamAddress(v)) : src(`${short(v)} on solscan`, solAccount(v)));
    else if (provider === "x_unified_api" && X_POST_PARAM.test(name)) for (const id of v.split(",")) out.push(src("the post on x", xPost(null, id.trim())));
  }
  return uniqueSources(out, 4);
}

/** A chain named in a call's params (chain, chainId, network…) */
function chainOf(params: Map<string, string[]>, values: Record<string, string>): string | null {
  for (const k of ["chain", "chainId", "chainIndex", "network", "blockchain", "chain_id"]) {
    const v = values[k] ?? params.get(k)?.[0];
    if (v) return v;
  }
  return null;
}

// ───────────────────────────── the RPC

/** A method that sends, signs or broadcasts (the hub allows reads only and refuses these itself) */
export const RPC_WRITE = /(^|[_/])(send|sign|submit|broadcast|create|deploy|import|unlock)|requestAirdrop|^(personal|admin|miner|debug|trace|engine)_/i;
/**
 * A hex quantity a chain answered (a balance in wei, a block number, a gas price) as a decimal, and a balance in its
 * native coin (18 decimals: every EVM chain's), so no answer reads hex by itself; null for anything else (an address, a
 * hash, data)
 */
export function hexReading(method: string, result: unknown): Record<string, string> | null {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(result) || result.length === 42 || result.length === 66 || method === "eth_call" || method === "eth_getStorageAt" || method === "eth_getCode") return null;
  const n = BigInt(result);
  const out: Record<string, string> = { decimal: n.toString() };
  if (method === "eth_getBalance") {
    const whole = n / 10n ** 18n;
    const frac = (n % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    out.native = frac ? `${whole}.${frac}` : whole.toString();
  }
  return out;
}

/** A JSON-RPC error's code, as ours */
const RPC_BAD_ARGS = new Set([-32600, -32601, -32602, -32004, -32000, -32001, -32015]);

// ───────────────────────────── the tools

export function hubTools(fc: FreeContext & { limit: { hub: WindowLimiter } }, cfg: HubConfig, calls: DailyCounter, credits: DailyCounter): ToolDef[] {
  const headers = (json: boolean): Record<string, string> => ({ accept: "application/json", "x-hub-key": cfg.key, ...(json ? { "content-type": "application/json" } : {}) });
  const catalog = new Dataset<HubCatalog>(
    CATALOG_TTL_MS,
    async (signal) => {
      const res = await fc.http.raw(`${BASE}/openapi.json`, { method: "GET", headers: headers(false), signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new ToolFail("unavailable");
      }
      try {
        return parseCatalog(JSON.parse(await readCapped(res, 16 * MB)) as unknown);
      } catch (err) {
        if (err instanceof ToolFail) throw err;
        throw new ToolFail("unavailable");
      }
    },
    fc.now,
    60_000,
  );
  if (fc.warm) catalog.warm();

  // a 429's wait: the whole hub ("*") or one source; a refused key stops every call a while
  const paused = new Map<string, number>();
  const waitLeft = (scope: string): number => Math.max(0, (paused.get("*") ?? 0) - fc.now(), (paused.get(scope) ?? 0) - fc.now());
  const pause = (scope: string, ms: number) => paused.set(scope, Math.max(paused.get(scope) ?? 0, fc.now() + Math.min(PAUSE_MAX_MS, Math.max(1000, ms))));
  const busy = (ms: number): Outcome => ({ ok: false, error: "rate_limited", message: `this source is busy for about ${Math.ceil(ms / 1000)} s more: answer without it or try it later` });
  let keyRefusedLogged = false;
  const keyRefused = (): Outcome => {
    pause("*", KEY_PAUSE_MS);
    if (!keyRefusedLogged) fc.log?.("tools: hub key refused");
    keyRefusedLogged = true;
    return { ok: false, error: "unavailable" };
  };

  /** One request to the hub, counted: its status, retry-after and JSON (null: not JSON) */
  async function send(url: string, scope: string, init: { method: "GET" | "POST"; body?: string }, signal: AbortSignal, weight: number): Promise<{ status: number; retryS: number | null; json: unknown } | Outcome> {
    const wait = waitLeft(scope);
    if (wait > 0) return busy(wait);
    take(fc.limit.hub);
    if (weight > 0 && credits.count() + weight > credits.limit) return { ok: false, error: "rate_limited", message: "today's on-chain label reads are used up; other routes still answer" };
    if (!calls.take()) throw new ToolFail("rate_limited");
    if (weight > 0) credits.take(weight);
    const res = await fc.http.raw(url, { method: init.method, headers: headers(init.body !== undefined), ...(init.body !== undefined ? { body: init.body } : {}), signal });
    let json: unknown = null;
    try {
      json = JSON.parse(await readCapped(res, ANSWER_MAX_BYTES)) as unknown;
    } catch (err) {
      if (err instanceof ToolFail && res.ok) throw err;
    }
    const retry = num(res.headers.get("retry-after")) ?? (isObj(json) ? num(json.retry_after_s) : null);
    return { status: res.status, retryS: retry, json };
  }

  /** A hub-wide refusal (a 429, the key): its outcome, else null */
  function refused(r: { status: number; retryS: number | null; json: unknown }, scope: string): Outcome | null {
    if (r.status === 429) {
      const reason = isObj(r.json) && typeof r.json.reason === "string" ? r.json.reason : "";
      const ms = (r.retryS ?? 30) * 1000;
      pause(["rate", "client_concurrency", "shared_concurrency", "client_state_capacity"].includes(reason) ? "*" : scope, ms);
      return busy(Math.min(PAUSE_MAX_MS, ms));
    }
    const err = isObj(r.json) && typeof r.json.error === "string" ? r.json.error : "";
    if (r.status === 401 || r.status === 403 || (r.status === 503 && /key/i.test(err))) return keyRefused();
    return null;
  }

  const maxItemsParam = { type: "integer" as const, description: "Rows kept of each list in the answer (1-100, default 20): fewer when you need one figure, more for a full table", minimum: 1, maximum: 100, default: 20 };
  const fieldsParam = {
    type: "array" as const,
    description: 'Only these fields of the answer, as dotted paths (lists are walked through): ["data.items.address", "data.items.balance"]; leave out for the whole answer',
    items: { type: "string" as const, pattern: "^[A-Za-z0-9_.$\\[\\]-]{1,120}$" },
    maxItems: 20,
  };

  /** The answer cut to fit, the fields asked for, what was cut */
  function shaped(data: unknown, args: Record<string, unknown>): { data: unknown; cut: string[]; missed: string[] } | Outcome {
    const fields = Array.isArray(args.fields) ? args.fields.map(String) : [];
    const picked = fields.length ? pick(data, fields) : { data, missed: [] as string[] };
    const fitted = fit(picked.data, Math.max(1, Number(args.max_items ?? 20)));
    if (!fitted) return { ok: false, error: "bad_args", message: "the answer is too large: ask for fewer rows (a limit param, max_items) or only the fields you need" };
    return { data: fitted.data, cut: fitted.cut, missed: picked.missed };
  }

  const find: ToolDef = {
    name: "hub_find",
    description:
      "Find the data hub's route for what you need, then call it with hub_call: a few words in, the best routes out (method, path, what it returns, params with the required ones and an example, cost). No words: the sources and what each covers. For what no other function has: whose wallet an address is, a wallet's pnl, cluster or counterparties, okx's holder clusters and early buyers, unlocks, fear and greed, rsi or macd, kalshi odds, a bridge transfer's status, evm portfolios, x posts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'What you need in a few words: "whose wallet is this", "solana wallet pnl", "holder clusters", "token unlocks", "rsi", "bridge transfer status"; leave out for the list of sources', maxLength: 120 },
        provider: { type: "string", description: "Only this source's routes (a name from the list of sources: arkham, web3okx, okxwallet, jupiter_portfolio, cmc, tradingview, x_unified_api…); with no query, all its routes in short", pattern: "^[a-z0-9_]{2,40}$" },
        limit: limitParam(6, 15, "routes"),
      },
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const cat = await catalog.get(signal);
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const provider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
      const limit = Math.max(1, Number(args.limit ?? 6));
      if (provider && !cat.byProvider.has(provider)) return { ok: false, error: "bad_args", message: `no source ${provider}: one of ${[...cat.byProvider.keys()].join(", ")}` };
      const pool = provider ? cat.byProvider.get(provider)! : cat.routes;
      if (!query && !provider) {
        const sources = [...cat.byProvider].map(([name, list]) => ({ name, routes: list.length, covers: ABOUT[name] ?? str((cat.tags.get(name) ?? "").split(/(?<=\.)\s/)[0], 200) ?? name }));
        return { ok: true, data: { sources, next: "hub_find with a few words (and a source) for its routes, then hub_call" }, sources: [] };
      }
      if (!query) return { ok: true, data: { provider, routes: pool.map((r) => `${r.method} ${r.path}: ${r.what.slice(0, 90)}${r.credits ? ` (${r.credits} credits)` : ""}`), next: "hub_find with words and this source for a route's params, then hub_call" }, sources: [] };
      const terms = askTerms(query);
      if (!terms.length) return { ok: false, error: "bad_args", message: "the query needs words to search" };
      const ranked = pool
        .map((r) => ({ r, s: scoreRoute(r, terms) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.r.params.filter((p) => p.required).length - b.r.params.filter((p) => p.required).length || a.r.credits - b.r.credits || a.r.path.length - b.r.path.length)
        .slice(0, limit);
      if (!ranked.length) return { ok: true, data: { routes: [], note: "no route matched: try other words or a source (no words: the list of sources)" }, sources: [] };
      return { ok: true, data: { routes: ranked.map((x) => routeView(x.r)), next: "hub_call with the provider, the path (its {params} filled in or given in params) and the params" }, sources: [] };
    },
  };

  const call: ToolDef = {
    name: "hub_call",
    description:
      "Call one route of the data hub, found with hub_find: on-chain labels, clusters and counterparties (arkham), a solana wallet's defi positions (jupiter), okx's holder clusters, early buyers and compliance check, coinmarketcap, tradingview's screener, polymarket and kalshi, bridges' transfer status, dextools, debank, x. Reads only. Give the path as hub_find showed it, its {params} filled in or given in params. A refused call says what the source wanted: fix it once.",
    parameters: {
      type: "object",
      properties: {
        provider: { type: "string", description: "The route's source as hub_find gave it (arkham, web3okx, jupiter_portfolio, cmc, tradingview…)", pattern: "^[a-z0-9_]{2,40}$" },
        path: { type: "string", description: 'The route\'s path as hub_find gave it, its {params} filled in ("/intelligence/address/0x28c6c06298d514db089934071355e5743bf21d60") or left for params', pattern: "^/[^\\s?#]{0,600}$" },
        method: { type: "string", description: "GET, or POST for a route hub_find lists as POST", enum: ["GET", "POST"], default: "GET" },
        params: {
          type: "array",
          description: 'Query and {path} params as name=value pairs: ["address=5tzF…", "timeFrame=7d"]',
          items: { type: "string", pattern: "^[A-Za-z0-9_.\\[\\]-]{1,64}=.{0,1000}$" },
          maxItems: 30,
        },
        body: { type: "string", description: "A POST route's JSON body as text, e.g. {\"chainId\": 1, \"userWalletAddress\": \"0x…\"}", maxLength: 20_000 },
        fields: fieldsParam,
        max_items: maxItemsParam,
      },
      required: ["provider", "path"],
      additionalProperties: false,
    },
    ttlMs: 2 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const cat = await catalog.get(signal);
      const provider = String(args.provider).trim().toLowerCase();
      const method = args.method === "POST" ? "POST" : "GET";
      const routes = cat.byProvider.get(provider);
      if (!routes) return { ok: false, error: "bad_args", message: `no source ${provider}: one of ${[...cat.byProvider.keys()].join(", ")}` };
      const given = parsePairs(args.params);
      if (typeof given === "string") return { ok: false, error: "bad_args", message: given };
      const filled = fillPath(String(args.path).trim(), given);
      if (filled.missing.length) return { ok: false, error: "bad_args", message: `fill ${filled.missing.map((n) => `{${n}}`).join(", ")} in the path or give ${filled.missing.map((n) => `${n}=…`).join(", ")} in params` };
      const hit = matchRoute(routes, method, filled.path) ?? matchRoute(routes, method, filled.path.endsWith("/") ? filled.path.slice(0, -1) : `${filled.path}/`);
      if (!hit) {
        const near = routes
          .map((r) => ({ r, s: scoreRoute(r, askTerms(filled.path.replace(/\/[^/]*[0-9][^/]{20,}/g, "/"))) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 3)
          .map((x) => `${x.r.method} ${x.r.path}`);
        return { ok: false, error: "bad_args", message: `${provider} has no ${method} route ${filled.path.slice(0, 120)}${near.length ? `; near it: ${near.join("; ")}` : ""} (hub_find lists them)` };
      }
      const { route, values } = hit;
      const pathNames = new Set(route.segs.flatMap((s) => s.names ?? []));
      const query = new URLSearchParams();
      for (const [name, vs] of given) if (!pathNames.has(name) && !filled.filled.has(name)) for (const v of vs) query.append(name, v);
      const missing = route.params.filter((p) => p.in === "query" && p.required && !query.has(p.name)).map((p) => p.name);
      if (missing.length) return { ok: false, error: "bad_args", message: `${route.path} needs ${missing.map((n) => `${n}=…`).join(", ")} in params` };
      let body: string | undefined;
      if (typeof args.body === "string" && args.body.trim()) {
        if (method !== "POST") return { ok: false, error: "bad_args", message: "a GET route takes no body: its inputs go in params" };
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.body) as unknown;
        } catch {
          return { ok: false, error: "bad_args", message: "body must be JSON" };
        }
        if (!isObj(parsed) && !Array.isArray(parsed)) return { ok: false, error: "bad_args", message: "body must be a JSON object or list" };
        body = JSON.stringify(parsed);
      } else if (method === "POST" && route.bodyRequired) return { ok: false, error: "bad_args", message: `${route.path} takes a JSON body: ${JSON.stringify(route.body).slice(0, 400)}` };
      const sendPath = pathToSend(route, values);
      if (!sendPath) return { ok: false, error: "bad_args", message: "a path param holds a character a path cannot (/ ? # % or a space)" };
      const qs = query.toString();
      const t0 = fc.now();
      const r = await send(`${BASE}/run/${provider}${sendPath}${qs ? `?${qs}` : ""}`, provider, { method, ...(body !== undefined ? { body } : {}) }, signal, route.credits);
      if (!("status" in r)) return r;
      fc.log?.("tools: hub call", { route: `${provider} ${method} ${route.path}`, status: r.status, ms: fc.now() - t0, ...(route.credits ? { credits: route.credits } : {}) });
      const stop = refused(r, provider);
      if (stop) return stop;
      const env = isObj(r.json) && "source" in r.json && "status" in r.json ? r.json : null;
      const status = num(env?.status) ?? r.status;
      // a route the catalog lists that the hub no longer runs (the catalog is read twice a day)
      if (r.status === 404 && !env) return { ok: false, error: "bad_args", message: "this route is not served now: pick another with hub_find" };
      if (r.status >= 500 || status >= 500) return { ok: false, error: "unavailable" };
      if (status === 404 || status === 410) return { ok: false, error: "not_found" };
      if (status >= 400) {
        const said = complaint(r.json);
        return status === 400 || status === 422 ? { ok: false, error: "bad_args", ...(said ? { detail: said } : { message: "the source refused these params: check them with hub_find" }) } : { ok: false, error: "unavailable" };
      }
      if (r.status >= 300 || !env) return { ok: false, error: "unavailable" };
      const inside = failedInside(env.data);
      if (inside) return { ok: false, error: "bad_args", detail: inside };
      const out = shaped(env.data, args);
      if ("ok" in out) return out;
      const age = num(env.age_s);
      const chain = chainOf(given, values);
      return {
        ok: true,
        data: {
          route: `${provider} ${method} ${route.path}`,
          ...(age !== null && age >= 60 ? { age_s: Math.round(age) } : {}),
          data: out.data,
          ...(out.cut.length ? { cut: out.cut } : {}),
          ...(out.missed.length ? { fields_not_found: out.missed } : {}),
        },
        sources: sourcesOf(provider, [...Object.entries(values), ...[...given].flatMap(([n, vs]) => vs.map((v): [string, string] => [n, v]))], chain),
      };
    },
  };

  const rpc: ToolDef = {
    name: "hub_rpc",
    description:
      "Read any of 153 chains over its JSON-RPC (reads only), for a chain or a read no other function covers (a contract on a chain the token functions lack, a raw transaction or log): evm chains' eth_ methods (eth_getBalance, eth_call, eth_getLogs, eth_getTransactionReceipt, eth_getCode), solana's (getAccountInfo, getSignaturesForAddress, getTransaction, getTokenLargestAccounts), bitcoin's (getrawtransaction, getblock), tron's (/wallet/getaccount), ton's (getAddressInformation), sui's, aptos', cosmos', xrp's.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "string", description: "The chain's name (ethereum, base, arbitrum, bsc, polygon, solana, bitcoin, tron, ton, sui, aptos, xrp) or its chain id (56)", pattern: "^[A-Za-z0-9_:.-]{1,40}$" },
        method: { type: "string", description: "The read method (eth_getBalance, getAccountInfo, getrawtransaction, /wallet/getaccount…)", pattern: "^[A-Za-z0-9_/{}.-]{1,100}$" },
        params: { type: "string", description: 'Its params as JSON text: a list for JSON-RPC (["0xd8da…", "latest"]), an object for a REST-style chain ({"address": "T…"})', maxLength: 4000, default: "[]" },
        fields: fieldsParam,
        max_items: maxItemsParam,
      },
      required: ["chain", "method"],
      additionalProperties: false,
    },
    ttlMs: 30_000,
    async run(args, { signal }): Promise<Outcome> {
      const chain = String(args.chain).trim().toLowerCase();
      const method = String(args.method).trim();
      if (RPC_WRITE.test(method)) return { ok: false, error: "bad_args", message: "reads only: this method sends, signs or changes state" };
      let params: unknown;
      try {
        params = JSON.parse(String(args.params ?? "[]")) as unknown;
      } catch {
        return { ok: false, error: "bad_args", message: "params must be JSON: a list or an object" };
      }
      if (!Array.isArray(params) && !isObj(params)) return { ok: false, error: "bad_args", message: "params must be JSON: a list or an object" };
      const t0 = fc.now();
      const r = await send(`${BASE}/rpc/${encodeURIComponent(chain)}`, "rpc", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, signal, 0);
      if (!("status" in r)) return r;
      fc.log?.("tools: hub call", { route: `rpc ${chain} ${method}`, status: r.status, ms: fc.now() - t0 });
      const stop = refused(r, "rpc");
      if (stop) return stop;
      const j = isObj(r.json) ? r.json : null;
      if (j && isObj(j.error)) {
        const code = num(j.error.code);
        const said = str(j.error.message, 300);
        if (code === -32004) return { ok: false, error: "bad_args", message: "unknown chain: use its name (ethereum, base, bsc, solana, bitcoin, tron…) or chain id" };
        if (code === -32601) return { ok: false, error: "bad_args", message: `${method} is not a read method of this chain${said ? ` (${said})` : ""}` };
        if (code !== null && RPC_BAD_ARGS.has(code)) return { ok: false, error: "bad_args", ...(said ? { detail: said } : { message: "the chain refused these params" }) };
        return { ok: false, error: "unavailable" };
      }
      if (!r.status || r.status >= 400 || !j || !("result" in j)) return { ok: false, error: r.status === 404 ? "not_found" : "unavailable" };
      const out = shaped(j.result, args);
      if ("ok" in out) return out;
      const values = (Array.isArray(params) ? params : Object.values(params)).filter((x): x is string => typeof x === "string").map((v): [string, string] => ["param", v]);
      const sol = ["solana", "sol", "mainnet-beta"].includes(chain);
      return {
        ok: true,
        data: { chain, method, result: out.data, ...(hexReading(method, j.result) ? { reads_as: hexReading(method, j.result) } : {}), ...(out.cut.length ? { cut: out.cut } : {}), ...(out.missed.length ? { fields_not_found: out.missed } : {}) },
        sources: sol ? sourcesOf("solana", values.filter(([, v]) => SOL_ADDR.test(v) || SOL_SIG.test(v)), null) : CHAIN_NAMES[chain] ? sourcesOf("evm", values.filter(([, v]) => EVM_ADDR.test(v) || EVM_HASH.test(v)), chain) : [],
      };
    },
  };

  return [find, call, rpc];
}
