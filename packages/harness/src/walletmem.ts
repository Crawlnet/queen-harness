// What the queen has seen a wallet do: every wallet a read names in a role (a coin's dev, its bundle, its first-minute
// snipers, a tied cluster's members and the funder they share, a wallet that bought before a call and sold into it) is
// kept with the coin and the moment, so the next coin's read says where its wallets were before: "3 of its 8 snipers
// were in earlier coins: the bundle of $AAA 2 d ago …". The pattern is the queen's to read (a dev's side wallets snipe
// its next launch, a caller's wallets buy each call, a funder seeds a coin's holders again): memory gives her the
// facts, never a verdict. One row a wallet, a coin and a role (its latest moment and share), KEEP_MS kept, pruned as
// rows come in. Survives restarts. Never throws: a broken store remembers nothing and recalls nothing.

import { migrate, type Db, type ToolResult, type ToolRunContext } from "@crawlnet/shared";

export type WalletRole = "dev" | "bundle" | "sniper" | "cluster" | "funder" | "frontrun";

export interface WalletSeen {
  wallet: string;
  mint: string;
  symbol: string | null;
  role: WalletRole;
  /** When the read saw it (ms epoch) */
  at: number;
  /** Its share of the supply in that role, when the read gave one */
  sharePct: number | null;
}

const WALLET_ROLES_MIGRATION = {
  id: "harness/001_wallet_roles",
  sql: `
    CREATE TABLE queen_wallet_roles (
      wallet    TEXT NOT NULL,
      mint      TEXT NOT NULL,
      role      TEXT NOT NULL,
      symbol    TEXT,
      at        INTEGER NOT NULL,
      share_pct REAL,
      PRIMARY KEY (wallet, mint, role)
    );
    CREATE INDEX queen_wallet_roles_wallet ON queen_wallet_roles(wallet, at);
    CREATE INDEX queen_wallet_roles_at ON queen_wallet_roles(at);
  `,
};

/** Roles are kept this long: a month of launches */
export const KEEP_MS = 30 * 86_400_000;
/** Old rows are pruned at most this often */
const PRUNE_EVERY_MS = 3_600_000;
/** Wallets recalled at once at most (a read names a few dozen) */
const RECALL_MAX = 200;
const ROLES: ReadonlySet<string> = new Set(["dev", "bundle", "sniper", "cluster", "funder", "frontrun"]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class WalletMemory {
  readonly #db: Db;
  readonly #now: () => number;
  #pruned = 0;
  #ok = true;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    try {
      migrate(db, [WALLET_ROLES_MIGRATION]);
    } catch {
      this.#ok = false;
    }
  }

  /** Keeps what a read saw: a row a wallet, a coin and a role, its latest moment and share */
  remember(rows: readonly WalletSeen[]): void {
    if (!this.#ok || rows.length === 0) return;
    try {
      const put = this.#db.prepare(
        `INSERT INTO queen_wallet_roles (wallet, mint, role, symbol, at, share_pct) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (wallet, mint, role) DO UPDATE SET at = excluded.at, symbol = coalesce(excluded.symbol, symbol),
           share_pct = coalesce(excluded.share_pct, share_pct)`,
      );
      this.#db.transaction(() => {
        for (const r of rows) {
          if (!BASE58.test(r.wallet) || !BASE58.test(r.mint) || r.wallet === r.mint || !ROLES.has(r.role)) continue;
          put.run(r.wallet, r.mint, r.role, r.symbol, Math.round(r.at), typeof r.sharePct === "number" && Number.isFinite(r.sharePct) ? r.sharePct : null);
        }
      })();
      const now = this.#now();
      if (now - this.#pruned >= PRUNE_EVERY_MS) {
        this.#pruned = now;
        this.#db.prepare(`DELETE FROM queen_wallet_roles WHERE at < ?`).run(now - KEEP_MS);
      }
    } catch {
      // a broken store remembers nothing
    }
  }

  /** Where these wallets were seen in other coins within KEEP_MS, newest first */
  recall(wallets: readonly string[], exceptMint: string): WalletSeen[] {
    if (!this.#ok) return [];
    const list = [...new Set(wallets.filter((w) => BASE58.test(w)))].slice(0, RECALL_MAX);
    if (list.length === 0) return [];
    try {
      const rows = this.#db
        .prepare(
          `SELECT wallet, mint, symbol, role, at, share_pct FROM queen_wallet_roles
           WHERE wallet IN (${list.map(() => "?").join(",")}) AND mint != ? AND at >= ? ORDER BY at DESC, rowid`,
        )
        .all(...list, exceptMint, this.#now() - KEEP_MS) as { wallet: string; mint: string; symbol: string | null; role: string; at: number; share_pct: number | null }[];
      return rows.map((r) => ({ wallet: r.wallet, mint: r.mint, symbol: r.symbol, role: r.role as WalletRole, at: r.at, sharePct: r.share_pct }));
    } catch {
      return [];
    }
  }
}

const AGE = (ms: number): string => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} d`);
const ROLE_WORDS: Record<WalletRole, string> = { dev: "the dev", bundle: "the bundle", sniper: "a sniper", cluster: "a tied cluster", funder: "the funder", frontrun: "a buyer before a call" };
const PLURAL: Record<WalletRole, string> = { dev: "dev", bundle: "bundle wallets", sniper: "snipers", cluster: "cluster wallets", funder: "funders", frontrun: "pre-call buyers" };

/**
 * The read's memory lines: for each role this coin's wallets hold, how many of them were seen in earlier coins and as
 * what (up to `coins` earlier coins a role, the newest first, with how long ago); nothing when none was seen before.
 * `coin` is this coin's wallets and their roles here; `seen` is WalletMemory.recall() of them.
 */
export function memoryLines(coin: readonly { wallet: string; role: WalletRole }[], seen: readonly WalletSeen[], now: number, coins = 3): string[] {
  const byWallet = new Map<string, WalletSeen[]>();
  for (const s of seen) byWallet.set(s.wallet, [...(byWallet.get(s.wallet) ?? []), s]);
  const out: string[] = [];
  for (const role of ["dev", "bundle", "sniper", "cluster", "funder", "frontrun"] as WalletRole[]) {
    const here = [...new Set(coin.filter((c) => c.role === role).map((c) => c.wallet))];
    if (here.length === 0) continue;
    const known = here.filter((w) => byWallet.has(w));
    if (known.length === 0) continue;
    // the earlier coins these wallets were in, each once (its newest sighting), the newest first
    const earlier = new Map<string, WalletSeen & { wallets: number }>();
    for (const w of known)
      for (const s of byWallet.get(w)!) {
        const k = `${s.mint}|${s.role}`;
        const e = earlier.get(k);
        if (e) e.wallets++;
        else earlier.set(k, { ...s, wallets: 1 });
      }
    const list = [...earlier.values()].sort((a, b) => b.at - a.at);
    const named = list
      .slice(0, coins)
      .map((s) => `${ROLE_WORDS[s.role]} of ${s.symbol ? `$${s.symbol}` : `${s.mint.slice(0, 6)}…`}${s.wallets > 1 ? ` (${s.wallets} of them)` : ""} ${AGE(now - s.at)} ago`)
      .join("; ");
    const more = list.length > coins ? `, ${list.length - coins} more coins` : "";
    const who = role === "dev" ? "the dev was" : `${known.length} of its ${here.length} ${PLURAL[role]} were`;
    out.push(`${who} in earlier coins: ${named}${more}`);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pctOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The wallets a coin's reads name and their roles there, from the functions' own data: sol_launch's rows (the dev, the
 * bundle, the snipers, one row a wallet beside each group's "all"), sol_holder_links' clusters (their holders, and the
 * funders they share) and call_frontrun's rows (the pre-call buyers, and their funders). Pools, programs and the burn
 * address never reach a cluster there; anything not shaped like a wallet is left out.
 */
export function rolesFromReads(r: { launch?: unknown; links?: unknown; frontrun?: unknown }): { wallet: string; role: WalletRole; sharePct: number | null }[] {
  const out: { wallet: string; role: WalletRole; sharePct: number | null }[] = [];
  const add = (wallet: unknown, role: WalletRole, sharePct: number | null) => {
    if (typeof wallet === "string" && BASE58.test(wallet)) out.push({ wallet, role, sharePct });
  };
  const launch = isObj(r.launch) && Array.isArray(r.launch.content) ? r.launch.content : [];
  for (const row of launch)
    if (isObj(row) && (row.role === "dev" || row.role === "bundle" || row.role === "sniper") && row.wallet !== "all") add(row.wallet, row.role, pctOf(row.first_buys_pct));
  const clusters = isObj(r.links) && Array.isArray(r.links.clusters) ? r.links.clusters : [];
  for (const c of clusters) {
    if (!isObj(c)) continue;
    for (const h of Array.isArray(c.holders) ? c.holders : []) add(h, "cluster", null);
    for (const f of Array.isArray(c.funders) ? c.funders : []) add(isObj(f) ? f.funder ?? f.wallet : f, "funder", null);
  }
  const pre = isObj(r.frontrun) && Array.isArray(r.frontrun.rows) ? r.frontrun.rows : [];
  for (const row of pre) {
    if (!isObj(row)) continue;
    add(row.wallet, "frontrun", pctOf(row.bought_pct));
    add(row.funder, "funder", null);
  }
  // a wallet once a role: the first (the read's own order: the largest first)
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.wallet}|${x.role}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The functions whose answers name wallets in roles, and which part of rolesFromReads each one's data is */
const TEACHING: Record<string, "launch" | "links" | "frontrun"> = { sol_launch: "launch", sol_holder_links: "links", call_frontrun: "frontrun" };

/**
 * The tools as the queen uses them, every answer of sol_launch, sol_holder_links and call_frontrun kept in her memory of
 * wallets on its way back, with the coin its arguments name; nothing else changes and a failure to remember never fails the call
 */
export function rememberingTools<T extends { run(name: string, args: unknown, ctx: ToolRunContext): Promise<ToolResult> }>(tools: T, memory: WalletMemory, now: () => number): T {
  return {
    ...tools,
    async run(name: string, args: unknown, ctx: ToolRunContext): Promise<ToolResult> {
      const r = await tools.run(name, args, ctx);
      const part = TEACHING[name];
      if (r.ok && part) {
        try {
          const a = typeof args === "string" ? (JSON.parse(args) as unknown) : args;
          const mint = isObj(a) && typeof a.mint === "string" ? a.mint.trim() : "";
          if (BASE58.test(mint)) memory.remember(rolesFromReads({ [part]: r.data }).map((x) => ({ ...x, mint, symbol: null, at: now() })));
        } catch {
          // a read the memory cannot use is still the caller's answer
        }
      }
      return r;
    },
  };
}
