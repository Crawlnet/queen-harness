// A coin's launch and its holders' ties as facts code reads: sol_launch's rows (the dev, the bundle, the first minute's
// snipers: who is out and what they still hold) and sol_holder_links' clusters (tied holders, common funders, tokens
// passed from one holder to another). The dossier and the trench read build their lines on them.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A launch's role (sol_launch "all" rows): the dev, the bundle (the creation block's other buyers), the first minute's snipers */
interface LaunchRole {
  wallets: number;
  firstBuySec: number | null;
  firstBuysPct: number | null;
  soldSincePct: number | null;
  holdsNowPct: number | null;
  fullyOut: number | null;
  firstSellSec: number | null;
  /**
   * The trades say it holds what it bought less what it sold, but the read's largest holders say it holds far less: its
   * tokens left by transfer, not by a sale (knownWallets checks; then holdsNowPct is null)
   */
  movedOut?: boolean;
}
/** One wallet of a launch (sol_launch's largest per role) */
interface LaunchWallet extends LaunchRole {
  role: "dev" | "bundle" | "sniper";
  wallet: string;
  paidSol: number | null;
}
export interface LaunchFacts {
  launched: string | null;
  roles: Partial<Record<"dev" | "bundle" | "sniper", LaunchRole>>;
  wallets: LaunchWallet[];
}
/** A cluster of tied holders (sol_holder_links) */
interface LinkCluster {
  n: number;
  holders: string[];
  wallets: number;
  sharePct: number | null;
  funders: string[];
}
export interface LinkFacts {
  /** the largest tied group's share, and the pools' */
  connectedPct: number | null;
  poolsPct: number | null;
  clusters: LinkCluster[];
  /** per holder: what it is (wallet, exchange, vault, pool, program, burn, unknown), its cluster and where its first tokens came from */
  holders: { owner: string; sharePct: number | null; kind?: string | null; cluster: number | null; tokensFrom: { from: string; kind: string } | null }[];
  /** who made the token as the read names it: its verified creator, else the likely deployer (the first big allocations') */
  creator?: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** sol_launch's rows (its result: data.content or data.rows) as facts; null without a dev row */
export function launchFacts(data: unknown): LaunchFacts | null {
  const d = isObj(data) ? data : null;
  const rows = d ? (Array.isArray(d.content) ? d.content : Array.isArray(d.rows) ? d.rows : null) : Array.isArray(data) ? data : null;
  if (!rows) return null;
  const out: LaunchFacts = { launched: null, roles: {}, wallets: [] };
  for (const r of rows.filter(isObj)) {
    const role = r.role === "dev" || r.role === "bundle" || r.role === "sniper" ? r.role : null;
    if (!role || typeof r.wallet !== "string") continue;
    const base: LaunchRole = {
      wallets: num(r.wallets) ?? 1,
      firstBuySec: num(r.first_buy_sec),
      firstBuysPct: num(r.first_buys_pct),
      soldSincePct: num(r.sold_since_pct),
      holdsNowPct: num(r.holds_now_pct),
      fullyOut: num(r.fully_out),
      firstSellSec: num(r.first_sell_sec),
    };
    if (r.wallet === "all") {
      out.roles[role] = base;
      if (typeof r.launched_utc === "string" && r.launched_utc) out.launched = r.launched_utc;
    } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)) out.wallets.push({ ...base, role, wallet: r.wallet, paidSol: r.paid_in === "SOL" ? num(r.paid) : null });
  }
  return out.roles.dev || out.roles.sniper || out.roles.bundle ? out : null;
}

/** sol_holder_links' result as facts; null without holders */
export function linkFacts(data: unknown): LinkFacts | null {
  if (!isObj(data) || !Array.isArray(data.holders)) return null;
  return {
    connectedPct: num(data.connected_share_pct),
    poolsPct: num(data.pools_share_pct),
    clusters: (Array.isArray(data.clusters) ? data.clusters.filter(isObj) : []).map((c) => ({
      n: num(c.cluster) ?? 0,
      holders: Array.isArray(c.holders) ? c.holders.filter((h): h is string => typeof h === "string") : [],
      wallets: num(c.wallets) ?? 0,
      sharePct: num(c.share_pct),
      funders: Array.isArray(c.funders) ? c.funders.filter((h): h is string => typeof h === "string") : [],
    })),
    holders: data.holders.filter(isObj).flatMap((h) =>
      typeof h.owner === "string"
        ? [{ owner: h.owner, sharePct: num(h.share_pct), kind: typeof h.kind === "string" ? h.kind : null, cluster: num(h.cluster), tokensFrom: isObj(h.tokens_from) && typeof h.tokens_from.from === "string" ? { from: h.tokens_from.from, kind: String(h.tokens_from.kind ?? "wallet") } : null }]
        : [],
    ),
    creator: isObj(data.creator) && typeof data.creator.address === "string" ? data.creator.address : null,
  };
}
