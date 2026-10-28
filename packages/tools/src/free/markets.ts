// DEX market data from free APIs (no keys): DEX Screener pair search and a token's pairs; GeckoTerminal
// new pools and one pool's snapshot (its free API allows about 10 calls a minute: TOOLS_GECKO_PER_MIN).
// Sources: the pair or pool page on dexscreener.com / geckoterminal.com.

import { dexscreenerPair, geckoPool, primaryUrl, src, uniqueSources } from "../links.ts";
import { limitParam, QUERY } from "../schema.ts";
import { ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, round, str, take, type FreeContext } from "./common.ts";

export const MARKET_HOSTS = ["api.dexscreener.com", "api.geckoterminal.com"];
const DS_CHAINS = ["solana", "ethereum", "base", "bsc", "arbitrum", "polygon", "optimism", "avalanche", "ton", "sui"];
const GT_NETWORKS = ["solana", "eth", "base", "bsc", "arbitrum", "polygon_pos", "optimism", "avax", "ton", "sui-network"];
const ADDRESS_LIKE = "^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,48}|[A-Za-z0-9_:-]{20,80})$";

const ok = (data: unknown, sources: (ReturnType<typeof src>)[]): Outcome => ({ ok: true, data, sources: uniqueSources(sources) });

const daysSince = (ms: number | null, now: number): number | null => (ms !== null && ms > 0 ? round((now - ms) / 86_400_000, 3) : null);

function pairRow(p: Record<string, unknown>, now: number): Record<string, unknown> | null {
  const chain = str(p.chainId, 30);
  const pair = str(p.pairAddress, 100);
  if (!chain || !pair || !isObj(p.baseToken)) return null;
  const base = p.baseToken;
  const quote = isObj(p.quoteToken) ? p.quoteToken : {};
  const liq = isObj(p.liquidity) ? p.liquidity : {};
  const vol = isObj(p.volume) ? p.volume : {};
  const chg = isObj(p.priceChange) ? p.priceChange : {};
  const tx = isObj(p.txns) && isObj(p.txns.h24) ? p.txns.h24 : {};
  const created = num(p.pairCreatedAt);
  return {
    chain,
    dex: str(p.dexId, 30),
    pair_address: pair,
    base: { symbol: str(base.symbol, 24), name: str(base.name, 60), address: str(base.address, 100) },
    quote: { symbol: str(quote.symbol, 24), address: str(quote.address, 100) },
    price_usd: round(num(p.priceUsd), 6),
    price_native: round(num(p.priceNative), 6),
    liquidity_usd: round(num(liq.usd)),
    volume_24h_usd: round(num(vol.h24)),
    volume_1h_usd: round(num(vol.h1)),
    price_change_1h_pct: round(num(chg.h1), 3),
    price_change_24h_pct: round(num(chg.h24), 3),
    txns_24h: { buys: num(tx.buys), sells: num(tx.sells) },
    fdv_usd: round(num(p.fdv)),
    market_cap_usd: round(num(p.marketCap)),
    pair_created_at: created ? new Date(created).toISOString() : null,
    pair_age_days: daysSince(created, now),
    link: primaryUrl(p.url) ?? dexscreenerPair(chain, pair),
  };
}

/** Sums over a set of our pair rows: pools, liquidity, 24h volume, buys and sells, the oldest pool and the dexes. */
function pairTotals(rows: Record<string, unknown>[], now: number): Record<string, unknown> {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  let oldest: number | null = null;
  const dexes = new Set<string>();
  let liquidity = 0;
  let volume = 0;
  let buys = 0;
  let sells = 0;
  // a launchpad's bonding curve has no pool liquidity DEX Screener reports: none reported is unknown, not $0
  let reported = false;
  for (const r of rows) {
    if (typeof r.liquidity_usd === "number" && r.liquidity_usd > 0) reported = true;
    liquidity += n(r.liquidity_usd);
    volume += n(r.volume_24h_usd);
    const tx = isObj(r.txns_24h) ? r.txns_24h : {};
    buys += n(tx.buys);
    sells += n(tx.sells);
    if (typeof r.dex === "string") dexes.add(r.dex);
    const t = typeof r.pair_created_at === "string" ? Date.parse(r.pair_created_at) : NaN;
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  return {
    pools: rows.length,
    liquidity_usd: reported ? round(liquidity) : null,
    volume_24h_usd: round(volume),
    txns_24h: { buys, sells },
    dexes: [...dexes].slice(0, 8),
    oldest_pool_created_at: oldest !== null ? new Date(oldest).toISOString() : null,
    oldest_pool_age_days: daysSince(oldest, now),
  };
}

/**
 * The tokens among our pair rows (each base token by chain and address), with their totals over their own pools, the most
 * traded first: a symbol search finds copycats too (they often show deep liquidity and no trading), and one pair's
 * liquidity is never the token's.
 */
function tokenTotals(rows: Record<string, unknown>[], now: number): Record<string, unknown>[] {
  const groups = new Map<string, { base: Record<string, unknown>; chain: string; rows: Record<string, unknown>[] }>();
  for (const r of rows) {
    const base = isObj(r.base) ? r.base : null;
    const address = base && typeof base.address === "string" ? base.address : null;
    if (!base || !address) continue;
    const key = `${String(r.chain)}:${address.toLowerCase()}`;
    const g = groups.get(key) ?? { base, chain: String(r.chain), rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g): Record<string, unknown> => {
      const top = g.rows.reduce((a, b) => (((b.liquidity_usd as number | null) ?? 0) > ((a.liquidity_usd as number | null) ?? 0) ? b : a));
      return {
        chain: g.chain,
        address: g.base.address,
        symbol: g.base.symbol,
        name: g.base.name,
        price_usd: top.price_usd,
        market_cap_usd: top.market_cap_usd,
        fdv_usd: top.fdv_usd,
        price_change_24h_pct: top.price_change_24h_pct,
        ...pairTotals(g.rows, now),
      };
    })
    .sort((a, b) => ((b.volume_24h_usd as number | null) ?? 0) - ((a.volume_24h_usd as number | null) ?? 0) || ((b.liquidity_usd as number | null) ?? 0) - ((a.liquidity_usd as number | null) ?? 0));
}

function poolRow(d: Record<string, unknown>, network: string, now: number): Record<string, unknown> | null {
  const a = isObj(d.attributes) ? d.attributes : null;
  if (!a) return null;
  const address = str(a.address, 100);
  if (!address) return null;
  const rel = isObj(d.relationships) ? d.relationships : {};
  const relId = (k: string): string | null => {
    const r = rel[k];
    return isObj(r) && isObj(r.data) ? str(r.data.id, 120) : null;
  };
  const stripNet = (id: string | null) => (id && id.startsWith(`${network}_`) ? id.slice(network.length + 1) : id);
  const vol = isObj(a.volume_usd) ? a.volume_usd : {};
  const chg = isObj(a.price_change_percentage) ? a.price_change_percentage : {};
  const tx = isObj(a.transactions) && isObj(a.transactions.h24) ? a.transactions.h24 : {};
  const created = typeof a.pool_created_at === "string" ? Date.parse(a.pool_created_at) : NaN;
  return {
    network,
    name: str(a.name, 80),
    address,
    dex: relId("dex"),
    base_token: stripNet(relId("base_token")),
    quote_token: stripNet(relId("quote_token")),
    price_usd: round(num(a.base_token_price_usd), 6),
    fdv_usd: round(num(a.fdv_usd)),
    market_cap_usd: round(num(a.market_cap_usd)),
    reserve_usd: round(num(a.reserve_in_usd)),
    locked_liquidity_pct: round(num(a.locked_liquidity_percentage), 3),
    volume_1h_usd: round(num(vol.h1)),
    volume_24h_usd: round(num(vol.h24)),
    price_change_1h_pct: round(num(chg.h1), 3),
    price_change_24h_pct: round(num(chg.h24), 3),
    txns_24h: { buys: num(tx.buys), sells: num(tx.sells), buyers: num(tx.buyers), sellers: num(tx.sellers) },
    created_at: Number.isFinite(created) ? new Date(created).toISOString() : null,
    age_hours: Number.isFinite(created) ? round((now - created) / 3_600_000, 3) : null,
    link: geckoPool(network, address),
  };
}

export function marketTools(fc: FreeContext): ToolDef[] {
  const ds = (path: string, signal: AbortSignal) => {
    take(fc.limit.dexscreener);
    return fc.http.json(`https://api.dexscreener.com${path}`, { signal });
  };
  const gt = (path: string, signal: AbortSignal) => {
    take(fc.limit.gecko);
    return fc.http.json(`https://api.geckoterminal.com/api/v2${path}`, { signal, headers: { accept: "application/json;version=20230302" } });
  };

  /** Every pair of the answer (on `chain`, when given) as our rows, most traded first: copycat tokens often show huge liquidity and no trading. */
  const allPairs = (raw: unknown, chain: string | null) => {
    const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.pairs) ? raw.pairs : null;
    if (!list) throw new ToolFail("unavailable");
    return list
      .filter(isObj)
      .filter((p) => !chain || p.chainId === chain)
      .map((p) => pairRow(p, fc.now()))
      .filter((p): p is Record<string, unknown> => p !== null)
      .sort((a, b) => ((b.volume_24h_usd as number | null) ?? 0) - ((a.volume_24h_usd as number | null) ?? 0) || ((b.liquidity_usd as number | null) ?? 0) - ((a.liquidity_usd as number | null) ?? 0));
  };
  const pairSources = (rows: Record<string, unknown>[]) =>
    rows.slice(0, 3).map((r) => src(`DEX Screener: ${String((r.base as { symbol: unknown }).symbol)}/${String((r.quote as { symbol: unknown }).symbol)}`, r.link as string | null));

  const lookup: ToolDef = {
    name: "dex_pair_lookup",
    // when to find a token and when to read one it has
    description:
      "Find a token by its ticker or name, or by an address whose chain you don't know (DEX Screener's search over every chain): each token found with its address and totals over all its pools (pools, liquidity, 24h volume, oldest pool's age), then the matching pairs (price, liquidity, 24h volume and price change, FDV, market cap, pair age), most traded first. Tickers are copied and the most traded match can be a copy: on Solana only a Jupiter-verified match is the real one. A token whose chain and address you have: token_pairs. Market facts, not investment advice.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Token symbol, name, or token/pair address", pattern: QUERY },
        chain: { type: "string", description: "Only pairs on this chain", enum: DS_CHAINS },
        limit: limitParam(5, 10, "pairs"),
      },
      required: ["query"],
      additionalProperties: false,
    },
    ttlMs: 45_000,
    async run(args, { signal }) {
      const raw = await ds(`/latest/dex/search?q=${encodeURIComponent(String(args.query))}`, signal);
      const all = allPairs(raw, (args.chain as string | undefined) ?? null);
      const rows = all.slice(0, Number(args.limit ?? 5));
      if (!rows.length) return { ok: false, error: "not_found" };
      const tokens = tokenTotals(all, fc.now());
      return ok({ tokens: tokens.slice(0, 5), pairs: rows }, pairSources(rows));
    },
  };

  const tokenPairs: ToolDef = {
    name: "token_pairs",
    description:
      "Every DEX pool of one token whose chain and address you have, on DEX Screener: the token's own totals over all its pools (price, market cap, FDV, liquidity, 24h volume, buys and sells, oldest pool's age), then its pairs with their pair addresses (price, liquidity, volume, FDV, market cap, pair age), most traded first. The read for a known coin's liquidity, volume, age and pools. One pair's liquidity is not the token's: use the totals. Market facts, not investment advice.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "string", description: "Chain of the token", enum: DS_CHAINS },
        token_address: { type: "string", description: "Token address (Solana mint or 0x contract)", pattern: ADDRESS_LIKE },
        limit: limitParam(5, 10, "pairs"),
      },
      required: ["chain", "token_address"],
      additionalProperties: false,
    },
    ttlMs: 45_000,
    async run(args, { signal }) {
      // every pool of the token (token-pairs answers up to 30)
      const raw = await ds(`/token-pairs/v1/${encodeURIComponent(String(args.chain))}/${encodeURIComponent(String(args.token_address))}`, signal);
      const all = allPairs(raw, String(args.chain));
      const rows = all.slice(0, Number(args.limit ?? 5));
      if (!rows.length) return { ok: false, error: "not_found" };
      // the token's own totals over every pool it trades in, its price and caps from its deepest pool as the base token
      const address = String(args.token_address).toLowerCase();
      const tokens = tokenTotals(all, fc.now());
      const own = tokens.find((t) => String(t.address).toLowerCase() === address) ?? null;
      const totals = { ...(own ? { chain: own.chain, address: own.address, symbol: own.symbol, name: own.name, price_usd: own.price_usd, market_cap_usd: own.market_cap_usd, fdv_usd: own.fdv_usd, price_change_24h_pct: own.price_change_24h_pct } : {}), ...pairTotals(all, fc.now()) };
      return ok({ totals, pairs: rows }, pairSources(rows));
    },
  };

  const freshPools: ToolDef = {
    name: "fresh_pools",
    description: "The newest DEX pools on a network from GeckoTerminal: pool, base token, price, FDV, reserve, volume, buys and sells, age. Most new tokens are unvetted; facts only, not investment advice.",
    parameters: {
      type: "object",
      properties: {
        network: { type: "string", description: "Network", enum: GT_NETWORKS, default: "solana" },
        limit: limitParam(10, 20, "pools"),
      },
      additionalProperties: false,
    },
    ttlMs: 60_000,
    async run(args, { signal }) {
      const network = String(args.network ?? "solana");
      const raw = await gt(`/networks/${encodeURIComponent(network)}/new_pools`, signal);
      if (!isObj(raw) || !Array.isArray(raw.data)) throw new ToolFail("unavailable");
      const rows = raw.data.filter(isObj).map((d) => poolRow(d, network, fc.now())).filter((r): r is Record<string, unknown> => r !== null).slice(0, Number(args.limit ?? 10));
      return ok({ network, pools: rows }, [src(`GeckoTerminal: new pools on ${network}`, `https://www.geckoterminal.com/${network}/pools`)]);
    },
  };

  const poolSnapshot: ToolDef = {
    name: "pool_snapshot",
    // the only read of a pool's unique buyers and sellers: whether a coin's volume is real (the trench read's ask)
    description:
      "One DEX pool's live read on GeckoTerminal by its pool address (a pair address token_pairs lists): its unique buyers and sellers in 24h beside its buys and sells (many trades from few wallets is farmed volume), the share of its liquidity locked, reserve, price, FDV, market cap, volume and price change over 1h and 24h, creation time. For whether a coin's volume is real and how much of its main pool is locked. Market facts, not investment advice.",
    parameters: {
      type: "object",
      properties: {
        network: { type: "string", description: "Network", enum: GT_NETWORKS, default: "solana" },
        pool_address: { type: "string", description: "Pool (pair) address", pattern: ADDRESS_LIKE },
      },
      required: ["pool_address"],
      additionalProperties: false,
    },
    ttlMs: 45_000,
    async run(args, { signal }) {
      const network = String(args.network ?? "solana");
      const raw = await gt(`/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(String(args.pool_address))}`, signal);
      const row = isObj(raw) && isObj(raw.data) ? poolRow(raw.data, network, fc.now()) : null;
      if (!row) return { ok: false, error: "not_found" };
      return ok(row, [src(`GeckoTerminal: ${String(row.name ?? "pool")}`, row.link as string | null)]);
    },
  };

  return [lookup, tokenPairs, freshPools, poolSnapshot];
}

