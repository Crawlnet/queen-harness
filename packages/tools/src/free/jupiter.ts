// The real Solana token behind a ticker, from Jupiter's own token search (lite-api.jup.ag, free, no key). Tickers are
// anyone's: DEX Screener lists copies and fakes under a real token's symbol, some with fake liquidity and wash volume;
// Jupiter marks the tokens it verified (its own flag, or its "verified" / "strict" tags) and scores how much of a
// token's trading comes from real wallets. Each match comes back under our own names, the verified ones with exactly
// the symbol asked first. Sources: the token's page on jup.ag.

import { jupToken, src, uniqueSources } from "../links.ts";
import { limitParam, QUERY } from "../schema.ts";
import { MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, round, str, take, type FreeContext } from "./common.ts";

export const JUPITER_HOSTS = ["lite-api.jup.ag"];

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Jupiter's tags that say it verified a token */
const VERIFIED_TAGS = new Set(["verified", "strict"]);
/** Tags passed on (what a token is, as Jupiter files it); every other tag (a vendor's or a list's name) is left out */
const KEPT_TAGS = new Set(["verified", "strict", "community", "lst", "stable", "meme", "defi", "yield", "rwa", "stocks", "launchpad", "token-2022", "duplicate", "unknown"]);

/** A symbol or a query as compared: letters and digits only, lower case ("$WIF" and "wif" are one ticker). */
const tickerKey = (s: unknown): string => (typeof s === "string" ? s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") : "");

/** One token of Jupiter's search as the model reads it, or null without a mint. */
function tokenRow(t: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const mint = typeof t.id === "string" && MINT_RE.test(t.id) ? t.id : null;
  if (!mint) return null;
  const tags = Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];
  const stats = isObj(t.stats24h) ? t.stats24h : {};
  const buys = num(stats.buyVolume);
  const sells = num(stats.sellVolume);
  const first = isObj(t.firstPool) ? str(t.firstPool.createdAt, 30) : null;
  return {
    mint,
    symbol: str(t.symbol, 24),
    name: str(t.name, 60),
    verified: t.isVerified === true || tags.some((x) => VERIFIED_TAGS.has(x)),
    exact_symbol: key !== "" && tickerKey(t.symbol) === key,
    organic_score: round(num(t.organicScore), 3),
    price_usd: round(num(t.usdPrice), 6),
    market_cap_usd: round(num(t.mcap)),
    fdv_usd: round(num(t.fdv)),
    liquidity_usd: round(num(t.liquidity)),
    volume_24h_usd: buys !== null || sells !== null ? round((buys ?? 0) + (sells ?? 0)) : null,
    holders: num(t.holderCount),
    first_pool_at: first && Number.isFinite(Date.parse(first)) ? new Date(Date.parse(first)).toISOString() : null,
    tags: [...new Set(tags.filter((x) => KEPT_TAGS.has(x)))],
    link: jupToken(mint),
  };
}

const capOf = (r: Record<string, unknown>): number => (r.market_cap_usd as number | null) ?? (r.fdv_usd as number | null) ?? 0;

export function jupiterTools(fc: FreeContext): ToolDef[] {
  const tickerMint: ToolDef = {
    name: "sol_ticker_mint",
    description:
      "The real Solana token behind a ticker or name, from Jupiter's verified token list: each match with its mint, symbol, name, whether Jupiter verified it, its organic score (0-100: how much of its trading comes from real wallets), price, market cap, FDV, liquidity, 24h volume, holders and first pool's date. Verified tokens with exactly that symbol come first, the largest first. Tickers are not unique (copies and fakes reuse them): only a verified match is the real one. Market facts, not investment advice.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Ticker (\"JUP\", \"$WIF\"), token name or mint", pattern: QUERY },
        limit: limitParam(5, 10, "tokens"),
      },
      required: ["query"],
      additionalProperties: false,
    },
    ttlMs: 2 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      // a cashtag is the ticker: Jupiter's search reads "WIF" and finds "$WIF"
      const q = String(args.query).trim().replace(/^[$＄]+/, "");
      if (!q) return { ok: false, error: "not_found" };
      take(fc.limit.jupiter);
      const raw = await fc.http.json(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`, { signal });
      if (!Array.isArray(raw)) throw new ToolFail("unavailable");
      const key = tickerKey(q);
      const rows = raw
        .filter(isObj)
        .map((t) => tokenRow(t, key))
        .filter((r): r is Record<string, unknown> => r !== null);
      // verified with exactly that symbol (the largest first), then the other verified ones, then the rest, each group
      // in Jupiter's own order
      const group = (r: Record<string, unknown>) => (r.verified ? (r.exact_symbol ? 0 : 1) : 2);
      const ranked = rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => group(a.r) - group(b.r) || (group(a.r) === 0 ? capOf(b.r) - capOf(a.r) || ((b.r.organic_score as number | null) ?? 0) - ((a.r.organic_score as number | null) ?? 0) : 0) || a.i - b.i)
        .map((x) => x.r)
        .slice(0, Number(args.limit ?? 5));
      if (!ranked.length) return { ok: false, error: "not_found" };
      return {
        ok: true,
        data: { query: q, note: "verified: Jupiter checked this token is the real one; a token with the same ticker that is not verified may be a copy", tokens: ranked },
        sources: uniqueSources(ranked.slice(0, 3).map((r) => src(`Jupiter: ${String(r.symbol ?? "token")}`, r.link as string | null))),
      };
    },
  };
  return [tickerMint];
}
