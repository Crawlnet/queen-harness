// A Solana token's launch read from the chain over Helius keys (HELIUS_LAUNCH_KEYS): sol_launch, its rows as the
// dossier reads them (chainfacts.ts launchFacts). Helius's getTransactionsForAddress walks
// the mint's history oldest first, so even an old coin's launch is a page or a few away:
//   - the launch: the first successful transaction (its slot, its time); the dev: its fee payer;
//   - a buy or a sell: a transaction whose fee payer's balance of the mint went up or down; what it paid: the fee
//     payer's SOL spent, or the quote token it gave up (PUMP, USDC, USDT, wrapped SOL) when the coin trades against
//     one;
//   - the bundle: other wallets buying in the creation's own slot; the snipers: a first buy within `window_seconds`;
//   - the whole window read, up to PAGES_MAX pages; the launch kept by its window (one read after the window closed
//     until its coin is LAUNCH_KEPT_DAYS old, one short of it read on from where it stopped), so a coin read again
//     costs only its holdings;
//   - what every one of them holds now: its associated token account, read 100 at a time (getMultipleAccounts), the
//     dev's and the largest buyers' other accounts too when that one is empty (getTokenAccountsByOwner); its share of
//     supply (getTokenSupply); "sold since": what it bought at launch less what it holds now (re-buys later are not
//     seen), its first sale's second when the pages read show one. Every call goes to the next of HELIUS_LAUNCH_KEYS
//     (a key that refuses or is out of credits is skipped), never sent twice for slowness. Transactions of format v1 are live on
//     mainnet: every read asks for 1.

import { migrate, type Db } from "@crawlnet/shared";
import { readCapped, statusError } from "../http.ts";
import { solAccount, solToken, src, uniqueSources } from "../links.ts";
import type { WindowLimiter } from "../limits.ts";
import { DAY, MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, raceAbort, take, type FreeContext } from "./common.ts";
import { associatedAccount, HELIUS_RPC_BASE, slimTx } from "./solana.ts";
import { frontrunTools } from "./frontrun.ts";

export const HELIUS_LAUNCH_HOST = "mainnet.helius-rpc.com";
/**
 * History reads a minute at most, every caller together: a launch already kept, or a second asker joining a read in
 * flight, takes none
 */
export const LAUNCH_PER_MIN = 30;
/**
 * Transactions a history page asks for: Helius returns up to 1,000 full ones a call, billed the same 10 credits per 100
 * as pages of 100, in a tenth of the round trips
 */
const PAGE_LIMIT = 1000;
/**
 * The first page's: the launch and its first moments, 10 credits; a quiet launch's minute is whole in it, and a busy one
 * is read on in slices of its window only (billed for the window's transactions, never for the hours after it)
 */
const FIRST_PAGE_LIMIT = 100;
/**
 * History pages read at most (PAGE_LIMIT transactions each): 24,000 successful transactions, a busy launch's first
 * minute. Only successful ones are read: a failed one (a bot's failed snipe) is billed like any other
 */
const PAGES_MAX = 24;
/** A launch read is kept this long at least (its holdings are read again on every ask) */
const LAUNCH_KEPT_MS = 24 * 3_600_000;
/**
 * A read whose window had closed is kept until its coin is this many days old: what happened in its first minute never
 * changes
 */
const LAUNCH_KEPT_DAYS = 60;
/**
 * A window counts as closed this long after its last second: the history's pages are its finalized transactions (about
 * 13 s behind the chain), and the last ones may still be coming in
 */
const LAUNCH_SETTLE_SEC = 60;
/** A read short of its window for a passing reason (a page that failed, a window still open) is served this long, then read on */
const OPEN_KEPT_MS = 60_000;
/** Launches kept in memory at most (the oldest goes first; the database keeps every one) */
const LAUNCHES_MAX = 300;
/** First transactions kept in memory at most (the oldest goes first; the database keeps every one) */
const FIRSTS_MAX = 2000;
/** A first transaction's read, shared by its askers, has this long (an asker that gives up leaves it to the next) */
const FIRST_TX_MS = 30_000;
/**
 * The launches read, kept across restarts, and each key's credits a UTC day (Helius bills getTransactionsForAddress 10
 * credits per 100 full transactions, 10 at least; a plain RPC call 1)
 */
const LAUNCH_MIGRATIONS = [
  {
    id: "tools/008_launches",
    sql: `
      CREATE TABLE tools_launches (
        mint       TEXT NOT NULL,
        window_sec INTEGER NOT NULL,
        at         INTEGER NOT NULL,   -- ms epoch, read
        body       TEXT NOT NULL,      -- JSON: the launch, its traders, how much was read
        PRIMARY KEY (mint, window_sec)
      );
      CREATE INDEX tools_launches_at ON tools_launches(at);
      CREATE TABLE tools_helius_credits (
        day     TEXT NOT NULL,          -- UTC day
        key_ix  INTEGER NOT NULL,       -- the key's place in HELIUS_LAUNCH_KEYS (never the key)
        credits INTEGER NOT NULL,
        PRIMARY KEY (day, key_ix)
      );
    `,
  },
  {
    // by whom (the answer id's kind: chat, scan, plan…), so an audit names what spends the credits
    id: "tools/009_helius_callers",
    sql: `
      CREATE TABLE tools_helius_spend (
        day     TEXT NOT NULL,
        caller  TEXT NOT NULL,
        tool    TEXT NOT NULL,
        credits INTEGER NOT NULL,
        calls   INTEGER NOT NULL,
        PRIMARY KEY (day, caller, tool)
      );
    `,
  },
  {
    // a launch kept by its window: one read after its window closed until its coin is LAUNCH_KEPT_DAYS old, so it is
    // pruned by its launch's time
    id: "tools/010_launch_window",
    sql: `
      ALTER TABLE tools_launches ADD COLUMN launch_at INTEGER NOT NULL DEFAULT 0;   -- s epoch, the launch (0: kept before)
      CREATE INDEX tools_launches_launch_at ON tools_launches(launch_at);
    `,
  },
  {
    // an address's first transaction, kept for good (it never changes): sol_token_origin's creator and creation
    id: "tools/012_first_txs",
    sql: `
      CREATE TABLE tools_first_txs (
        address   TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        body      TEXT NOT NULL,      -- JSON: the transaction as kept (slimTx)
        at        INTEGER NOT NULL    -- ms epoch, read
      );
    `,
  },
];

/**
 * Helius's credits for a call that answered: a history page by the transactions it returned (10 per 100, 10 at least;
 * signatures alone 10), a DAS call (getAsset) 10, any other call 1
 */
export function creditsOf(method: string, params: unknown, result: unknown): number {
  if (method === "getAsset") return 10;
  if (method !== "getTransactionsForAddress") return 1;
  const o = Array.isArray(params) && isObj(params[1]) ? params[1] : {};
  if (o.transactionDetails === "signatures") return 10;
  const n = isObj(result) && Array.isArray(result.data) ? result.data.length : 0;
  return Math.max(10, Math.ceil(n / 100) * 10);
}
/** Wallets whose other token accounts are read when their associated one is empty: the dev and the largest buyers */
const RECHECK_MAX = 12;
/** Calls in flight per key at most (a key answers 429 past its plan's rate) */
const KEY_IN_FLIGHT = 4;
/** A key rests this long after a 429, doubled for each in a row up to KEY_REST_MAX_MS */
const KEY_REST_MS = 500;
const KEY_REST_MAX_MS = 8_000;
/** A call waits for a free key this long at most */
const CALL_WAIT_MAX_MS = 20_000;
/**
 * A key that answers 429 this many times in a row is taken out: it rests KEY_SPENT_MS, and while every key does a
 * read fails at once
 */
const KEY_SPENT_AFTER = 5;
const KEY_SPENT_MS = 10 * 60_000;
/** Helius's answer to a key out of credits */
const SPENT_BODY = /max usage|credits? (?:exhausted|exceeded)|quota/i;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Wallet rows listed per group at most, the largest first buys first */
const ROWS_PER_ROLE = 8;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Quote tokens a launch may be bought with besides SOL */
const QUOTES: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: "PUMP",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

export interface LaunchConfig {
  keys: string[];
}

type Role = "dev" | "bundle" | "sniper";

/** One wallet's launch trades, from the pages read */
export interface Trader {
  wallet: string;
  /** Its first buy alone (first_buys_pct) */
  firstBought: number;
  /** Every buy in the transactions read (sold since: this less what it holds now) */
  bought: number;
  firstBuyAt: number;
  firstBuySlot: number;
  firstSellAt: number | null;
  paid: number | null;
  paidIn: string | null;
}

/** A transaction as the history gives it (jsonParsed): what this read needs */
export interface Tx {
  slot: number;
  transactionIndex?: number;
  blockTime: number | null;
  meta?: { err?: unknown; fee?: number; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: unknown[]; postTokenBalances?: unknown[] } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: unknown[]; header?: { numRequiredSignatures?: number } } } | null;
}

/** Each owner's balance change of `mint` in a transaction */
export function deltas(tx: Tx, mint: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (list: unknown[] | undefined, sign: number) => {
    for (const b of list ?? []) {
      if (!isObj(b) || b.mint !== mint || typeof b.owner !== "string" || !isObj(b.uiTokenAmount)) continue;
      const v = num(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount);
      if (v !== null) out.set(b.owner, (out.get(b.owner) ?? 0) + sign * v);
    }
  };
  add(tx.meta?.postTokenBalances, 1);
  add(tx.meta?.preTokenBalances, -1);
  return out;
}

/**
 * The transaction's signers, the fee payer first: jsonParsed keys say so each, json's are the first
 * numRequiredSignatures of them
 */
function signersOf(tx: Tx): string[] {
  const out: string[] = [];
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const signed = tx.transaction?.message?.header?.numRequiredSignatures;
  keys.forEach((k, i) => {
    const key = isObj(k) ? k.pubkey : k;
    const signer = isObj(k) ? k.signer === true : typeof signed === "number" ? i < signed : i === 0;
    if (signer && typeof key === "string" && BASE58.test(key)) out.push(key);
  });
  return out;
}

/** The fee payer: the first signer */
function payerOf(tx: Tx): string | null {
  return signersOf(tx)[0] ?? null;
}

/** Who traded `mint` in a transaction: the signer whose balance of it moved, else the fee payer */
export function traderOf(tx: Tx, d: Map<string, number>): string | null {
  const signers = signersOf(tx);
  for (const s of signers) if ((d.get(s) ?? 0) !== 0) return s;
  return signers[0] ?? null;
}

/** What `wallet` gave for a buy: a quote token it spent, else its own SOL spent (past the fee when it paid it) */
export function paidOf(tx: Tx, wallet: string): { paid: number | null; paidIn: string | null } {
  for (const [mint, symbol] of Object.entries(QUOTES)) {
    const d = deltas(tx, mint).get(wallet);
    if (d !== undefined && d < 0) return { paid: Math.round(-d * 1e4) / 1e4, paidIn: symbol };
  }
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const at = keys.findIndex((k) => (isObj(k) ? k.pubkey : k) === wallet);
  const pre = at >= 0 ? tx.meta?.preBalances?.[at] : undefined;
  const post = at >= 0 ? tx.meta?.postBalances?.[at] : undefined;
  if (typeof pre === "number" && typeof post === "number") {
    const sol = (pre - post - (at === 0 ? (tx.meta?.fee ?? 0) : 0)) / 1e9;
    if (sol > 0) return { paid: Math.round(sol * 1e4) / 1e4, paidIn: "SOL" };
  }
  return { paid: null, paidIn: null };
}

/** The mint's token program, from its balances in the transactions read (Token-2022 for a pump.fun coin since CreateV2) */
function tokenProgramOf(txs: Tx[], mint: string): string {
  for (const tx of txs)
    for (const b of [...(tx.meta?.postTokenBalances ?? []), ...(tx.meta?.preTokenBalances ?? [])])
      if (isObj(b) && b.mint === mint && typeof b.programId === "string" && BASE58.test(b.programId)) return b.programId;
  return TOKEN_PROGRAM;
}

/** The launch and every wallet's trades in the transactions read (oldest first): null without a successful one */
export function readLaunch(txs: Tx[], mint: string): { launchAt: number; launchSlot: number; dev: string | null; tokenProgram: string; traders: Map<string, Trader> } | null {
  const ok = txs.filter((t) => t && !t.meta?.err && typeof t.blockTime === "number");
  const first = ok[0];
  if (!first) return null;
  const traders = new Map<string, Trader>();
  foldTrades(traders, ok, mint);
  return { launchAt: first.blockTime!, launchSlot: first.slot, dev: payerOf(first), tokenProgram: tokenProgramOf(ok, mint), traders };
}

/** Each wallet's trades of `mint` in transactions read oldest first, folded into `traders` (a read gone on folds its new pages) */
function foldTrades(traders: Map<string, Trader>, txs: Tx[], mint: string): void {
  for (const tx of txs) {
    if (!tx || tx.meta?.err || typeof tx.blockTime !== "number") continue;
    const dl = deltas(tx, mint);
    const trader = traderOf(tx, dl);
    if (!trader) continue;
    const d = dl.get(trader) ?? 0;
    if (d > 0) {
      const t = traders.get(trader);
      if (t) t.bought += d;
      else traders.set(trader, { wallet: trader, firstBought: d, bought: d, firstBuyAt: tx.blockTime!, firstBuySlot: tx.slot, firstSellAt: null, ...paidOf(tx, trader) });
    } else if (d < 0) {
      const t = traders.get(trader);
      if (t && t.firstSellAt === null) t.firstSellAt = tx.blockTime!;
    }
  }
}

/** Who is who: the dev, the bundle (the creation's slot), the snipers (a first buy within the window) */
export function rolesOf(l: NonNullable<ReturnType<typeof readLaunch>>, windowSec: number): Map<string, Role> {
  const roles = new Map<string, Role>();
  if (l.dev) roles.set(l.dev, "dev");
  for (const t of l.traders.values()) {
    if (roles.has(t.wallet)) continue;
    if (t.firstBuySlot === l.launchSlot) roles.set(t.wallet, "bundle");
    else if (t.firstBuyAt - l.launchAt <= windowSec) roles.set(t.wallet, "sniper");
  }
  return roles;
}

const pct = (x: number, supply: number) => Math.round((x / supply) * 100 * 1000) / 1000;
const utc = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19);

/** Where a read of a launch's window goes on from: its next page, past the last transaction folded */
interface ReadOn {
  /** The window pages' filter start (blockTime gte, s) */
  from: number;
  /** The next page's token under that filter; null when a page came back short, or the first page alone was read */
  token: string | null;
  /**
   * The last transaction folded: its block time, slot and index in the slot, and the signatures folded in that slot (a
   * page that starts in it never folds one twice)
   */
  time: number;
  slot: number;
  index: number;
  sigs: string[];
  /** History pages read so far (PAGES_MAX in all) */
  pages: number;
}

/** Whether a transaction comes after the last one a read folded: a later slot, or in that slot one not folded yet */
function after(tx: Tx, on: ReadOn): boolean {
  if (tx.slot !== on.slot) return tx.slot > on.slot;
  const sig = tx.transaction?.signatures?.[0];
  return sig ? !on.sigs.includes(sig) : (tx.transactionIndex ?? 0) > on.index;
}

/** A transaction folded: the read's place moves to it */
function mark(on: ReadOn, tx: Tx): void {
  if (tx.slot !== on.slot) on.sigs = [];
  const sig = tx.transaction?.signatures?.[0];
  if (sig) on.sigs.push(sig);
  on.slot = tx.slot;
  on.index = tx.transactionIndex ?? 0;
  if (typeof tx.blockTime === "number") on.time = tx.blockTime;
}

/** A launch read and kept: the window it covered, the read itself, how much of it was read, where it goes on from */
interface KeptLaunch {
  at: number;
  /** The window it covered, 0 for a screen (the first page alone) */
  windowSec: number;
  /** The first page alone (sol_launch first_page): the dev, the creation slot's bundle, the earliest snipers */
  screen?: boolean;
  launch: NonNullable<ReturnType<typeof readLaunch>>;
  txCount: number;
  partial: boolean;
  secondsRead: number;
  /** Where its window goes on from (a screen's first page, a read short of its window's end); none once whole or cut at PAGES_MAX */
  on?: ReadOn;
  /**
   * Short of its window for a passing reason (a page that failed, the window still open when read): served
   * OPEN_KEPT_MS, then read on. Absent: served LAUNCH_KEPT_MS after its read
   */
  open?: boolean;
}

/** A read kept until its coin is LAUNCH_KEPT_DAYS old, a day at least after it */
const keptLong = (k: KeptLaunch, now: number): boolean => now - k.at <= LAUNCH_KEPT_MS || now - k.launch.launchAt * 1000 <= LAUNCH_KEPT_DAYS * DAY;

/**
 * Whether a kept launch is served as it is: one short for a passing reason OPEN_KEPT_MS, one kept before the window was
 * judged a day, any other kept long
 */
function servable(k: KeptLaunch, now: number): boolean {
  if (k.open) return now - k.at <= OPEN_KEPT_MS;
  if (k.open === undefined) return now - k.at <= LAUNCH_KEPT_MS;
  return keptLong(k, now);
}

/**
 * Whether a kept launch answers an ask of `windowSec` (0: a screen) as it is: a screen any servable read; a full ask a
 * servable read of this window or a longer one, or one short of a longer window that went past this one (its first
 * seconds were read whole and never change)
 */
function answers(k: KeptLaunch, windowSec: number, now: number): boolean {
  if (windowSec === 0) return servable(k, now);
  if (!k.screen && k.windowSec >= windowSec && servable(k, now)) return true;
  return k.open !== undefined && k.partial && k.secondsRead > windowSec && keptLong(k, now);
}

/** The launches and the keys' credits in SQLite (LAUNCH_MIGRATIONS); every call never throws */
function launchStore(db: Db) {
  migrate(db, LAUNCH_MIGRATIONS);
  const put = db.prepare("INSERT INTO tools_launches (mint, window_sec, at, launch_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mint, window_sec) DO UPDATE SET at = excluded.at, launch_at = excluded.launch_at, body = excluded.body");
  const all = db.prepare("SELECT body FROM tools_launches WHERE mint = ? ORDER BY window_sec");
  // a row read a day ago or more whose coin is past LAUNCH_KEPT_DAYS (one kept before the window was judged has 0)
  const prune = db.prepare("DELETE FROM tools_launches WHERE at < ? AND launch_at < ?");
  const spend = db.prepare("INSERT INTO tools_helius_credits (day, key_ix, credits) VALUES (?, ?, ?) ON CONFLICT(day, key_ix) DO UPDATE SET credits = credits + excluded.credits");
  const used = db.prepare("SELECT credits FROM tools_helius_credits WHERE day = ? AND key_ix = ?");
  const by = db.prepare("INSERT INTO tools_helius_spend (day, caller, tool, credits, calls) VALUES (?, ?, ?, ?, 1) ON CONFLICT(day, caller, tool) DO UPDATE SET credits = credits + excluded.credits, calls = calls + 1");
  const putFirst = db.prepare("INSERT INTO tools_first_txs (address, signature, body, at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO NOTHING");
  const getFirst = db.prepare("SELECT signature, body FROM tools_first_txs WHERE address = ?");
  let puts = 0;
  return {
    put(mint: string, k: KeptLaunch): void {
      try {
        const body = JSON.stringify({ ...k, launch: { ...k.launch, traders: [...k.launch.traders.values()] } });
        put.run(mint, k.windowSec, k.at, k.launch.launchAt, body);
        if (++puts % 100 === 0) prune.run(k.at - LAUNCH_KEPT_MS, Math.floor(k.at / 1000) - LAUNCH_KEPT_DAYS * 86_400);
      } catch {
        // a launch not kept is read again, never a failed read
      }
    },
    /** Every launch kept of a mint, the shortest window first */
    all(mint: string): KeptLaunch[] {
      try {
        return (all.all(mint) as { body: string }[]).map((row) => {
          const b = JSON.parse(row.body) as Omit<KeptLaunch, "launch"> & { launch: Omit<KeptLaunch["launch"], "traders"> & { traders: Trader[] } };
          return { ...b, launch: { ...b.launch, traders: new Map(b.launch.traders.map((t) => [t.wallet, t])) } };
        });
      } catch {
        return [];
      }
    },
    spend(day: string, key: number, credits: number, caller = "", tool = ""): void {
      try {
        spend.run(day, key, credits);
        by.run(day, (caller || "-").slice(0, 40), (tool || "-").slice(0, 40), credits);
      } catch {
        // counted in memory anyway
      }
    },
    credits(day: string, key: number): number {
      try {
        return (used.get(day, key) as { credits: number } | undefined)?.credits ?? 0;
      } catch {
        return 0;
      }
    },
    firstTx(address: string): FirstTx | null {
      try {
        const row = getFirst.get(address) as { signature: string; body: string } | undefined;
        return row ? { signature: row.signature, tx: JSON.parse(row.body) as Record<string, unknown> } : null;
      } catch {
        return null;
      }
    },
    putFirst(address: string, f: FirstTx, at: number): void {
      try {
        putFirst.run(address, f.signature, JSON.stringify(f.tx), at);
      } catch {
        // kept in memory anyway
      }
    },
  };
}

/** An address's first transaction, as the creator read takes it */
type FirstTx = { signature: string; tx: Record<string, unknown> };

/** The first successful transaction of a page read oldest first, as kept (slimTx); null without one */
function firstOkOf(txs: Tx[]): FirstTx | null {
  const tx = txs.find((t) => t && !t.meta?.err && typeof t.blockTime === "number");
  const sig = tx?.transaction?.signatures?.[0];
  return tx && typeof sig === "string" ? { signature: sig, tx: slimTx(tx as unknown as Record<string, unknown>) } : null;
}

export function launchTools(fc: FreeContext & { limit: { launch: WindowLimiter } }, cfg: LaunchConfig, db: Db | null = null): ToolDef[] {
  let turn = 0;
  const store = db ? launchStore(db) : null;
  /** Each key's credits today (the database's count after a restart): counted and logged, never a cap */
  let creditDay = "";
  const credits = cfg.keys.map(() => 0);
  const today = (): string => new Date(fc.now()).toISOString().slice(0, 10);
  const syncDay = (): void => {
    const d = today();
    if (d === creditDay) return;
    creditDay = d;
    cfg.keys.forEach((_, i) => (credits[i] = store ? store.credits(d, i) : 0));
  };

  /** Launches read lately, by mint (the oldest first): LAUNCH_KEPT_MS each */
  const launches = new Map<string, KeptLaunch>();
  const remember = (mint: string, kept: KeptLaunch): void => {
    launches.delete(mint);
    launches.set(mint, kept);
    while (launches.size > LAUNCHES_MAX) launches.delete(launches.keys().next().value!);
  };
  /**
   * A launch read before, in memory or else the database (a restart keeps it): `use`, one that answers this ask as it is
   * (servable: a read of this window or a longer one, any read for a screen); else `from`, one a full read goes on from (a
   * screen's first page, or a read of this window or a longer one short of its end), so no page is bought twice
   */
  const keptOf = (mint: string, windowSec: number): { use?: KeptLaunch; from?: KeptLaunch } => {
    const now = fc.now();
    const mem = launches.get(mint);
    if (mem && answers(mem, windowSec, now)) return { use: mem };
    const rows = store?.all(mint) ?? [];
    const use = rows.find((k) => answers(k, windowSec, now));
    if (use) {
      remember(mint, use);
      return { use };
    }
    const from = windowSec === 0 ? undefined : [...(mem ? [mem] : []), ...rows].find((k) => k.on && (k.screen || k.windowSec >= windowSec));
    return from ? { from } : {};
  };
  /** A launch being read now, by mint and window: a second asker waits for it */
  const reading = new Map<string, Promise<KeptLaunch | null>>();
  /**
   * Each address's first transaction (fc.firstTx), kept for good once read, in memory and the database; and those coming
   * with a launch read's first page now (its first successful transaction is the same one: the chat's scan reads both at
   * once)
   */
  const firsts = new Map<string, FirstTx>();
  const firstsComing = new Map<string, Promise<FirstTx | null>>();
  const firstReading = new Map<string, Promise<FirstTx | null>>();
  const keepFirst = (address: string, f: FirstTx, write = true): void => {
    firsts.delete(address);
    firsts.set(address, f);
    while (firsts.size > FIRSTS_MAX) firsts.delete(firsts.keys().next().value!);
    if (write) store?.putFirst(address, f, fc.now());
  };
  const firstKept = (address: string): FirstTx | null => {
    const mem = firsts.get(address);
    if (mem) return mem;
    const row = store?.firstTx(address) ?? null;
    if (row) keepFirst(address, row, false);
    return row;
  };
  /** Calls in flight per key, and until when a key rests after a 429 */
  const busy = cfg.keys.map(() => 0);
  const restUntil = cfg.keys.map(() => 0);
  const restMs = cfg.keys.map(() => 0);
  /** 429s in a row per key, and until when a spent one rests (KEY_SPENT_AFTER) */
  const limitedInRow = cfg.keys.map(() => 0);
  const spentUntil = cfg.keys.map(() => 0);
  /** Each key by its URL as the tools' rpc pool has it (rpcEndpoints) */
  const keyAt = new Map(cfg.keys.map((k, i) => [HELIUS_RPC_BASE + k, i] as const));
  /** One read's counts for its log line (each read its own: reads of two coins run at once) */
  type ReadStats = { calls: number; limited: number; waitedMs: number; credits: number; caller?: string; tool?: string };

  /**
   * A 429 from key k: it rests KEY_REST_MS, doubled for each in a row up to KEY_REST_MAX_MS, and is spent (KEY_SPENT_MS)
   * after KEY_SPENT_AFTER in a row, or at once when it says it is out of credits
   */
  function limitedKey(k: number, outOfCredits: boolean): void {
    if (outOfCredits) limitedInRow[k] = KEY_SPENT_AFTER - 1;
    restMs[k] = Math.min(KEY_REST_MAX_MS, restMs[k] ? restMs[k]! * 2 : KEY_REST_MS);
    restUntil[k] = fc.now() + restMs[k]!;
    if (++limitedInRow[k]! >= KEY_SPENT_AFTER) {
      spentUntil[k] = fc.now() + KEY_SPENT_MS;
      restUntil[k] = spentUntil[k]!;
      limitedInRow[k] = 0;
    }
  }

  /** An answer's credits on key k: the key's day, and the day by caller and tool (counted and logged, never a cap) */
  function book(k: number, method: string, params: unknown, result: unknown, stats: ReadStats): void {
    const c = creditsOf(method, params, result);
    syncDay();
    credits[k]! += c;
    stats.credits += c;
    store?.spend(creditDay, k, c, stats.caller ?? "", stats.tool ?? "");
  }

  // the tools' rpc pool on the same keys (solana.ts SolanaRpc): what the launch read knows of each key, and its book
  fc.launchKeys = {
    state(url) {
      const k = keyAt.get(url);
      if (k === undefined) return null;
      const now = fc.now();
      return spentUntil[k]! > now ? "spent" : restUntil[k]! > now ? "resting" : "ready";
    },
    limited(url, body) {
      const k = keyAt.get(url);
      if (k !== undefined) limitedKey(k, SPENT_BODY.test(body));
    },
    answered(url, method, params, result, tag) {
      const k = keyAt.get(url);
      if (k === undefined) return;
      restMs[k] = 0;
      limitedInRow[k] = 0;
      book(k, method, params, result, { calls: 0, limited: 0, waitedMs: 0, credits: 0, caller: tag?.caller ?? "", tool: tag?.tool ?? "" });
    },
  };

  /** The key to use now: one not resting and under KEY_IN_FLIGHT, the least busy from `turn` on; null when none is */
  function pickKey(): number | null {
    const now = fc.now();
    let best: number | null = null;
    for (let i = 0; i < cfg.keys.length; i++) {
      const k = (turn + i) % cfg.keys.length;
      if (restUntil[k]! > now || busy[k]! >= KEY_IN_FLIGHT) continue;
      if (best === null || busy[k]! < busy[best]!) best = k;
    }
    return best;
  }

  /**
   * One JSON-RPC call: on the least busy key that is not resting (KEY_IN_FLIGHT calls each at most); a 429 rests that key
   * (KEY_REST_MS, doubled for each in a row up to KEY_REST_MAX_MS) and the call goes to another, or waits for one; an error
   * of the RPC's own (a refused method or parameter) fails at once; a call that cannot start before CALL_WAIT_MAX_MS fails
   */
  async function rpc(method: string, params: unknown[], signal: AbortSignal, stats: ReadStats = { calls: 0, limited: 0, waitedMs: 0, credits: 0 }): Promise<unknown> {
    const t0 = fc.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      if (spentUntil.every((u) => u > fc.now())) throw new ToolFail("unavailable");
      let k = pickKey();
      while (k === null) {
        if (signal.aborted || fc.now() - t0 > CALL_WAIT_MAX_MS || spentUntil.every((u) => u > fc.now())) throw new ToolFail("unavailable");
        const soonest = Math.min(...restUntil.map((r, i) => (busy[i]! < KEY_IN_FLIGHT ? Math.max(r, fc.now()) : fc.now() + 50)));
        const wait = Math.max(20, Math.min(1000, soonest - fc.now()));
        stats.waitedMs += wait;
        await new Promise((r) => setTimeout(r, wait));
        k = pickKey();
      }
      busy[k]!++;
      turn = (k + 1) % cfg.keys.length;
      stats.calls++;
      let outOfCredits = false;
      try {
        const res = await fc.http.raw(`https://${HELIUS_LAUNCH_HOST}/?api-key=${cfg.keys[k]}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal });
        if (!res.ok) {
          // a key out of credits says so in its 429 ("max usage reached"): spent at once, never rested and asked again
          const text = res.status === 429 ? await readCapped(res, 4096).catch(() => "") : (await res.body?.cancel().catch(() => {}), "");
          outOfCredits = res.status === 429 && SPENT_BODY.test(text);
          throw new ToolFail(statusError(res.status));
        }
        let r: unknown;
        try {
          r = JSON.parse(await readCapped(res, 64 * 1024 * 1024)) as unknown;
        } catch (e) {
          throw e instanceof ToolFail ? e : new ToolFail("unavailable");
        }
        restMs[k] = 0;
        limitedInRow[k] = 0;
        if (isObj(r) && isObj(r.error)) throw new ToolFail("unavailable");
        const result = isObj(r) ? r.result : null;
        book(k, method, params, result, stats);
        return result;
      } catch (e) {
        if (signal.aborted) throw e instanceof ToolFail ? e : new ToolFail("unavailable");
        if (e instanceof ToolFail && e.code === "rate_limited") {
          stats.limited++;
          limitedKey(k, outOfCredits);
          continue;
        }
        if (e instanceof ToolFail && e.code === "unavailable" && attempt === 0) continue;
        throw e instanceof ToolFail ? e : new ToolFail("unavailable");
      } finally {
        busy[k]!--;
      }
    }
    throw new ToolFail("unavailable");
  }

  /**
   * The launch's history read: the first page (a screen stops there), then the window page after page from its last
   * second; or, `prior` given, on from where an earlier read stopped, its traders folded on, so no page is bought
   * twice. A page that fails keeps what was read, and a window still open is kept short of its end: both are read on
   * later (open). null when the mint has no history
   */
  async function readHistory(mint: string, windowSec: number, signal: AbortSignal, screen = false, caller = "", prior: KeptLaunch | null = null): Promise<KeptLaunch | null> {
    const startedAt = fc.now();
    const stats: ReadStats = { calls: 0, limited: 0, waitedMs: 0, credits: 0, caller, tool: "sol_launch" };
    // the successful transactions only (a failed one bought nothing, and it is billed like any other)
    const history = (blockTime: Record<string, number> | null, paginationToken: string | null, limit = PAGE_LIMIT) =>
      rpc("getTransactionsForAddress", [mint, { transactionDetails: "full", sortOrder: "asc", limit, encoding: "json", maxSupportedTransactionVersion: 1, filters: { status: "succeeded", ...(blockTime ? { blockTime } : {}) }, ...(paginationToken ? { paginationToken } : {}) }], signal, stats);
    const pageOf = (r: unknown) => ({ data: isObj(r) && Array.isArray(r.data) ? (r.data as Tx[]) : [], next: isObj(r) && typeof r.paginationToken === "string" ? r.paginationToken : null });
    const inOrder = (txs: Tx[]) => [...txs].sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0));
    let launch: KeptLaunch["launch"];
    let txCount: number;
    let on: ReadOn;
    /** The history goes on past what was read (as far as the window goes) */
    let more: boolean;
    if (prior?.on) {
      // its traders a copy: the kept launch stays as it is for those reading it now
      launch = { ...prior.launch, traders: new Map([...prior.launch.traders].map(([w, t]) => [w, { ...t }])) };
      txCount = prior.txCount;
      on = { ...prior.on, sigs: [...prior.on.sigs] };
      more = true;
    } else {
      // the first page gives the launch, and its first transaction the creator read's (fc.firstTx: kept for it, and waited
      // for by one asking meanwhile)
      const page = history(null, null, FIRST_PAGE_LIMIT).then(pageOf);
      const coming = page.then(
        (pg) => {
          const f = firstKept(mint) ? null : firstOkOf(inOrder(pg.data));
          if (f) keepFirst(mint, f);
          return f ?? firstKept(mint);
        },
        () => null,
      );
      firstsComing.set(mint, coming);
      void coming.finally(() => {
        if (firstsComing.get(mint) === coming) firstsComing.delete(mint);
      });
      const first = await page;
      const data = inOrder(first.data);
      const l = readLaunch(data, mint);
      if (!l) return null;
      launch = l;
      txCount = data.length;
      on = { from: 0, token: null, time: l.launchAt, slot: -1, index: 0, sigs: [], pages: 1 };
      for (const tx of data) mark(on, tx);
      on.from = on.time;
      more = first.next !== null;
    }
    const end = launch.launchAt + windowSec;
    // the pages read went past the window's end: it is whole in them
    let whole = on.time > end;
    let failed = false;
    // the rest of the window page after page, from the first page's last second; a screen reads the first page alone
    if (!screen && !whole && more) {
      const fresh: Tx[] = [];
      for (;;) {
        if (on.pages >= PAGES_MAX) break;
        let pg: { data: Tx[]; next: string | null };
        try {
          pg = pageOf(await history({ gte: on.from, lt: end + 1 }, on.token));
        } catch {
          failed = true;
          break;
        }
        on.pages++;
        for (const tx of inOrder(pg.data))
          if (after(tx, on)) {
            fresh.push(tx);
            mark(on, tx);
          }
        on.token = pg.next;
        if (!pg.next || pg.data.length < PAGE_LIMIT) {
          // read to the window's end as far as the chain has it now: a read on starts at its last second
          more = false;
          on.from = on.time;
          on.token = null;
          break;
        }
      }
      foldTrades(launch.traders, fresh, mint);
      txCount += fresh.length;
      if (launch.tokenProgram === TOKEN_PROGRAM) launch.tokenProgram = tokenProgramOf(fresh, mint);
    }
    const nowSec = fc.now() / 1000;
    // read to the end of a window that has closed: whole; of one still open: short of it, read on later
    if (!whole && !more && !failed && nowSec >= end + LAUNCH_SETTLE_SEC) whole = true;
    const waiting = !whole && !more && !failed;
    // cut at PAGES_MAX: as far as a read gets, never read on (a screen stops at its first page by itself)
    const cut = !whole && !failed && more && !screen;
    const seen = waiting ? Math.max(on.time, Math.floor(nowSec) - LAUNCH_SETTLE_SEC) : on.time;
    const asScreen = screen && !whole;
    const kept: KeptLaunch = {
      at: fc.now(),
      windowSec: asScreen ? 0 : windowSec,
      ...(asScreen ? { screen: true } : {}),
      launch,
      txCount,
      partial: !whole,
      secondsRead: whole ? windowSec : Math.max(0, Math.min(windowSec, seen - launch.launchAt)),
      ...(!whole && !cut ? { on } : {}),
      open: failed || waiting,
    };
    remember(mint, kept);
    store?.put(mint, kept);
    syncDay();
    fc.log?.("tools: launch read", { mint: mint.slice(0, 8), ...(asScreen ? { screen: true } : {}), ...(prior ? { readOn: true } : {}), caller: caller || "-", txs: kept.txCount, pages: stats.calls, credits: stats.credits, creditsToday: credits.reduce((a, b) => a + b, 0), limited: stats.limited, waitedMs: stats.waitedMs, partial: kept.partial, ...(kept.open ? { open: true } : {}), ms: fc.now() - startedAt });
    return kept;
  }

  // an address's newest transactions in one call (10 credits for up to 100): a holder map's or a money trail's wallet read
  // for the first time (solana.ts)
  fc.newestTxs = async (address, limit, signal, tag) => {
    const r = await rpc("getTransactionsForAddress", [address, { transactionDetails: "full", sortOrder: "desc", limit, encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed", filters: { status: "succeeded" } }], signal, { calls: 0, limited: 0, waitedMs: 0, credits: 0, tool: tag?.tool ?? "", caller: tag?.caller ?? "" });
    return isObj(r) && Array.isArray(r.data) ? r.data.filter(isObj) : [];
  };

  // an address's first transaction in one call (10 credits): sol_token_origin's creator for a token of any age; kept for
  // good, one asker's read shared by the others
  fc.firstTx = async (address, signal, tag) => {
    const kept = firstKept(address);
    if (kept) return kept;
    const coming = firstsComing.get(address);
    const came = coming ? await raceAbort(coming, signal) : null;
    if (came) return came;
    let p = firstReading.get(address);
    if (!p) {
      const own = AbortSignal.timeout(FIRST_TX_MS);
      p = (async () => {
        const r = await rpc("getTransactionsForAddress", [address, { transactionDetails: "full", sortOrder: "asc", limit: 1, encoding: "jsonParsed", maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }], own, { calls: 0, limited: 0, waitedMs: 0, credits: 0, tool: tag?.tool ?? "sol_token_origin", caller: tag?.caller ?? "" });
        const f = firstOkOf(isObj(r) && Array.isArray(r.data) ? (r.data as Tx[]) : []);
        if (f) keepFirst(address, f);
        return f;
      })().finally(() => firstReading.delete(address));
      firstReading.set(address, p);
    }
    return raceAbort(p, signal);
  };

  const launch: ToolDef = {
    name: "sol_launch",
    slow: true,
    description:
      "A Solana token's launch read from the chain (pump.fun and DEXes): the dev (the creation transaction's fee payer), the bundle (other wallets buying in the creation's own slot) and the snipers (a first buy within 60 s, adjustable). Per group: wallets, the share of supply their first buys took, the share sold since (what they bought less what they hold now), the share held now, how many are fully out, seconds to the first sale seen; then the largest wallets and what their first buy cost. For snipers, bundles, dev dumps, cabal or organic.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string", description: "The token's mint address (base58)", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" },
        window_seconds: { type: "integer", description: "Seconds after the launch that count as sniping (5-600, default 60)", minimum: 5, maximum: 600, default: 60 },
        first_page: { type: "boolean", description: "The launch's first moments only (its creation, the dev, the creation block's bundle, the earliest snipers): a quick screen of a coin among many; the full window otherwise", default: false },
      },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: 5 * MINUTE,
    async run(args, { signal, caller }): Promise<Outcome> {
      const mint = String(args.mint);
      const windowSec = Math.min(600, Math.max(5, Number(args.window_seconds ?? 60)));
      // a screen: the first page alone, 10 credits
      const screen = args.first_page === true;
      // the launch: kept from an earlier read that answers this ask (one cut at PAGES_MAX is as far as a read gets: never
      // read again for it; a full read serves a screen), else read on from a kept one short of this window (a screen's
      // first page, a read cut short for a passing reason), else the history oldest first until the window has passed
      const { use, from } = keptOf(mint, screen ? 0 : windowSec);
      let kept = use;
      if (!kept) {
        // a read gone on from a longer window's reads to that window's end; one read of a launch at a time: a second asker
        // of the same coin waits for it (its own timeout, not its caller's)
        const readSec = from && !from.screen ? from.windowSec : windowSec;
        const key = `${mint}:${screen ? "screen" : readSec}`;
        let p = reading.get(key);
        if (!p) {
          // the launch limiter counts the history reads alone
          take(fc.limit.launch);
          p = readHistory(mint, readSec, AbortSignal.timeout(90_000), screen, caller ?? "", from ?? null).finally(() => reading.delete(key));
          reading.set(key, p);
        }
        kept = (await p) ?? undefined;
        if (!kept) return { ok: false, error: "not_found" };
      }
      const l = kept.launch;
      const roles = rolesOf(l, windowSec);
      const held0: ReadStats = { calls: 0, limited: 0, waitedMs: 0, credits: 0, caller: caller ?? "", tool: "sol_launch" };
      const supplyR = await rpc("getTokenSupply", [mint], signal, held0);
      const supply = isObj(supplyR) && isObj(supplyR.value) ? num(supplyR.value.uiAmountString ?? supplyR.value.uiAmount) : null;
      if (!supply || supply <= 0) throw new ToolFail("unavailable");
      // what every one of them holds now: its associated account, 100 a call; the dev's and the largest buyers' other
      // accounts when that one is empty
      const members = [...roles.entries()].map(([wallet, role]) => ({ wallet, role, t: l.traders.get(wallet) ?? null }));
      members.sort((a, b) => (a.role === "dev" ? -1 : b.role === "dev" ? 1 : (b.t?.bought ?? 0) - (a.t?.bought ?? 0)));
      const held = new Map<string, number>();
      const ata = members.map((m) => ({ wallet: m.wallet, account: associatedAccount(m.wallet, mint, l.tokenProgram) }));
      for (let i = 0; i < ata.length; i += 100) {
        const batch = ata.slice(i, i + 100).filter((a) => a.account);
        if (batch.length === 0) continue;
        const r = await rpc("getMultipleAccounts", [batch.map((a) => a.account), { encoding: "jsonParsed" }], signal, held0).catch(() => null);
        const values = isObj(r) && Array.isArray(r.value) ? r.value : null;
        if (!values) continue;
        batch.forEach((a, k) => {
          const v = values[k];
          const info = isObj(v) && isObj(v.data) && isObj(v.data.parsed) && isObj(v.data.parsed.info) ? v.data.parsed.info : null;
          const amount = info && isObj(info.tokenAmount) ? num(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount) : null;
          held.set(a.wallet, v === null ? 0 : (amount ?? 0));
        });
      }
      const recheck = members.filter((m) => (held.get(m.wallet) ?? 0) <= 0).slice(0, RECHECK_MAX);
      await Promise.all(
        recheck.map(async ({ wallet }) => {
          const r = await rpc("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed" }], signal, held0).catch(() => null);
          const accounts = isObj(r) && Array.isArray(r.value) ? r.value : null;
          if (!accounts) return;
          let n = 0;
          for (const a of accounts) {
            const info = isObj(a) && isObj(a.account) && isObj(a.account.data) && isObj(a.account.data.parsed) && isObj(a.account.data.parsed.info) ? a.account.data.parsed.info : null;
            const v = info && isObj(info.tokenAmount) ? num(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount) : null;
            if (v !== null) n += v;
          }
          held.set(wallet, n);
        }),
      );
      const launched = utc(l.launchAt);
      const rows: Record<string, unknown>[] = [];
      for (const role of ["bundle", "dev", "sniper"] as Role[]) {
        const group = members.filter((m) => m.role === role);
        if (group.length === 0) continue;
        const seen = group.filter((m) => held.has(m.wallet));
        const bought = group.reduce((sum, m) => sum + (m.t?.firstBought ?? 0), 0);
        const holds = seen.reduce((sum, m) => sum + held.get(m.wallet)!, 0);
        const sold = seen.reduce((sum, m) => sum + Math.max(0, (m.t?.bought ?? 0) - held.get(m.wallet)!), 0);
        const firstBuys = group.map((m) => (m.t ? m.t.firstBuyAt - l.launchAt : null)).filter((x): x is number => x !== null);
        const firstSells = group.map((m) => (m.t?.firstSellAt ? m.t.firstSellAt - l.launchAt : null)).filter((x): x is number => x !== null);
        rows.push({
          role,
          wallet: "all",
          wallets: group.length,
          holdings_read: seen.length,
          first_buy_sec: firstBuys.length ? Math.min(...firstBuys) : null,
          first_buys_pct: pct(bought, supply),
          paid: null,
          sold_since_pct: pct(sold, supply),
          holds_now_pct: pct(holds, supply),
          fully_out: seen.filter((m) => held.get(m.wallet)! <= 0).length,
          first_sell_sec: firstSells.length ? Math.min(...firstSells) : null,
          launched_utc: launched,
        });
        for (const m of group.filter((g) => g.t).slice(0, ROWS_PER_ROLE)) {
          const h = held.get(m.wallet);
          rows.push({
            role,
            wallet: m.wallet,
            wallets: 1,
            first_buy_sec: m.t!.firstBuyAt - l.launchAt,
            first_buys_pct: pct(m.t!.firstBought, supply),
            paid: m.t!.paid,
            paid_in: m.t!.paidIn,
            sold_since_pct: h === undefined ? null : pct(Math.max(0, m.t!.bought - h), supply),
            holds_now_pct: h === undefined ? null : pct(h, supply),
            fully_out: h === undefined ? null : h <= 0 ? 1 : 0,
            first_sell_sec: m.t!.firstSellAt ? m.t!.firstSellAt - l.launchAt : null,
          });
        }
      }
      if (rows.length === 0) return { ok: false, error: "not_found" };
      // short of this window: a read cut at PAGES_MAX or a screen (there were more), or one short for a passing reason (a
      // page that failed, a window still open), kept briefly so the next asker reads on
      const short = kept.secondsRead < windowSec;
      return {
        ok: true,
        data: {
          status: "success",
          title: "Solana launch",
          summary: `Returned ${rows.length} rows of data.`,
          window_seconds: windowSec,
          seconds_read: short ? kept.secondsRead : windowSec,
          note:
            `read from the mint's first ${kept.txCount} transactions` +
            (short ? `, its first ${kept.secondsRead} s only: the snipers counted are those of those seconds${kept.open ? "" : ", there were more"}` : "") +
            "; sold_since_pct is what a wallet bought at launch less what it holds now (re-buys later are not seen)",
          content: rows,
        },
        sources: uniqueSources([src("Solscan: token", solToken(mint)), ...(l.dev ? [src("Solscan: dev wallet", solAccount(l.dev))] : [])]),
        ...(short && kept.open ? { brief: true } : {}),
      };
    },
  };
  // who bought before a call, on the same keys (free/frontrun.ts)
  return [launch, ...frontrunTools(fc, rpc, db)];
}
