// One severity scale for a token's findings. The chat's token card and the scan's facts read the same table, so an
// unlocked lp is never amber in one and danger in the other, nor the dev's holdings red at one share here and at another
// there.

//   danger it can take the money: a pool its deployer can pull or one rugcheck marks pulled, live mint or freeze
//           authority, a honeypot, transfer fees, hooks or taxes, a delegate that can move balances, the dev (its side
//           wallets counted), a tied cluster or the bundle with a big share, and on a young or small coin the largest
//           wallet or the top 10 with one
//   warn it makes the coin fragile: a heavy top 10, a cabal spread thin past the top holders (many small wallets
//           made by one funder or all fresh), a dev bag, a bundle or snipers still holding, insiders, wallets
//           holding the same bag, a serial creator, thin liquidity or farmed volume, a copied or farmed story, no pool,
//           a bad signal of the top traders
//   note context, no colour: still on its bonding curve, who of the top traders is in
//   ok read and fine

// The token block keeps its statuses' words (ok, warn, bad, na: docs/BLOCKS.md); `danger` is written `bad` there and
// `note` `na`. The trench read (packages/harness/src/trench.ts) states these numbers from this table, so the model reads the
// thresholds code levels by.

export type Severity = "danger" | "warn" | "note" | "ok";

/** Worst first */
export const SEVERITY_ORDER: readonly Severity[] = ["danger", "warn", "note", "ok"];

/** The thresholds every reader of a token uses (percent of supply unless said) */
export const SEVERITY = {
  /** Locked or burned share of the liquidity in the pools an lp can be locked in, at least (under it: a pullable pool) */
  lpLockedPct: 90,
  /** The dev's share of supply: danger at or over, warn at or over the lower */
  devDangerPct: 15,
  devWarnPct: 5,
  /** The largest wallet's share (pools, exchanges, programs and the burn left out): danger, then warn */
  largestDangerPct: 20,
  largestWarnPct: 10,
  /** The top 10 wallets' share: danger on a young coin (warn on a mature one), then warn */
  top10DangerPct: 35,
  top10WarnPct: 20,
  /**
   * A coin at least this old (days since its oldest pool) and this large (market cap, else fdv, usd) is mature: its top
   * 10's and largest wallet's danger share is a warning (its big wallets are mostly exchanges, team or treasury)
   */
  matureDays: 180,
  matureCapUsd: 50_000_000,
  /** One funder's cluster of wallets: danger, then warn */
  clusterDangerPct: 33,
  clusterWarnPct: 15,
  /**
   * A cabal spread thin past the top holders (sol_holder_spread): the band of wallets holding 0.1-1% of supply each at
   * spreadBandPct or more, and in its sample (spreadMinSample read at least) one funder (an exchange ties no one) of
   * spreadFunderWallets or more, or spreadFreshPct of them fresh (under 200 transactions and 72 h): a warning, a cabal
   * coin's size. Never danger: the same hands can dump a coin or run it; plain coins hold 25-64% of supply there with
   * 0-1 of 16 sampled fresh. On a band of spreadNoteBandPct the same hands are a note
   */
  spreadBandPct: 25,
  spreadNoteBandPct: 10,
  spreadFunderWallets: 4,
  spreadFreshPct: 70,
  spreadMinSample: 8,
  /** What the creation block's bundle still holds: danger, then warn */
  bundleDangerPct: 20,
  bundleWarnPct: 5,
  /** What the first minute's snipers still hold: a warning (many hands, not one, so never danger by itself) */
  sniperWarnPct: 10,
  /** The coins a creator made before (RugCheck's creator history), a count: a serial deployer at this many, a warning */
  devCoinsWarn: 3,
  /** A pool's liquidity, usd: danger under, warn under */
  liquidityDangerUsd: 10_000,
  liquidityWarnUsd: 20_000,
  /** Liquidity under this percent of the market cap is thin for its size, off a mature coin: a warning */
  thinLiquidityPct: 5,
  /** A day's volume over this many times the liquidity, on a coin over a day old, is often farmed: a warning */
  farmedTurnover: 50,
} as const;

/** The worse of two levels */
export function worse(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/** The worst level of a list (ok when empty) */
export function worst(levels: Iterable<Severity>): Severity {
  let w: Severity = "ok";
  for (const l of levels) w = worse(w, l);
  return w;
}

/** A share at or over `danger` is danger, at or over `warn` warn, else ok */
export function byShare(pct: number, danger: number, warn: number): Severity {
  return pct >= danger ? "danger" : pct >= warn ? "warn" : "ok";
}

/** The token block's word for a level (docs/BLOCKS.md: ok, warn, bad, na) */
export function blockStatus(l: Severity): "ok" | "warn" | "bad" | "na" {
  return l === "danger" ? "bad" : l === "note" ? "na" : l;
}

/** A level from a token block's word (and the scale's own words) */
export function severityOf(status: unknown): Severity | null {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "bad" || s === "danger") return "danger";
  if (s === "warn") return "warn";
  if (s === "na" || s === "note") return "note";
  if (s === "ok") return "ok";
  return null;
}

/** The token block's verdict level from its worst check: danger is high risk, warn mixed, else low */
export function verdictLevel(l: Severity): "high" | "mixed" | "low" {
  return l === "danger" ? "high" : l === "warn" ? "mixed" : "low";
}
