// Who bought before a call: a coin's trades around the time someone called it, read from the chain over the launch keys
// (HELIUS_LAUNCH_KEYS, launch.ts), so side wallets that buy seconds before the call and sell minutes after show up
// whoever posted it.
//   - call_frontrun: one call (a mint and the call's time: a post's own time, an X post id's timestamp, a pump.fun
//     callout's time as pump.fun recorded it, its author the caller: pumpcallouts.ts): the wallets that bought in the
//     minutes before it (seconds before, share of supply, what they paid, the same slot as another), whether and how
//     soon after the call they sold, who funded each (the first SOL into it), the funders they share, and any tie to
//     the caller's wallet;
//   - caller_side_wallets: the same over several calls of one caller: the wallets that bought before two or more of
//     them, how early on average, how soon they sold, the funders they share, ties to the caller. Facts from the chain;
//     a pattern is never proof of who controls a wallet.

import { migrate, type Db } from "@crawlnet/shared";
import { pumpCalloutId } from "../links.ts";
import { DAY, MINUTE, type Outcome, type ToolDef } from "../types.ts";
import { isObj, type FreeContext } from "./common.ts";
import { exchangeLabel } from "./labels.ts";
import { deltas, paidOf, traderOf, type Tx } from "./launch.ts";
import { onCurve } from "./solana.ts";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * Pages one call's window reads at most, PAGE_TXS successful transactions each (10 Helius credits per 100 returned):
 * each side of the call its half (1,000 successful ones a page, 6,000 at most)
 */
const PAGE_TXS = 1000;
const PAGES_MAX = 6;
const SIDE_PAGES = PAGES_MAX / 2;
/** Pre-call buyers whose funder is read (the largest first) */
const FUNDERS_MAX = 15;
/** A wallet's first transactions read for its funder */
const FUNDER_TXS = 10;
/** Rows shown at most */
const ROWS_MAX = 25;
const CALLS_MAX = 8;
/**
 * The recurring wallets (and the caller's) whose own transfers are read for the wallets that tie them, at most, each its
 * newest LINK_TXS successful transactions; a plain SOL transfer of LINK_MIN_SOL or more counts (fees, tips and rent are
 * less, and a swap's moves never count)
 */
const LINK_WALLETS = 6;
const LINK_TXS = 100;
const LINK_MIN_SOL = 0.05;
/**
 * A bot by its own newest transactions (the same LINK_TXS read): this many a day or more, across this many coins or
 * more among them. A sniper buys every launch early, so it is early to every caller's call: its timing ties it to no
 * one; a caller's side wallet trades the calls, a few coins a day
 */
const BOT_TX_PER_DAY = 500;
const BOT_COINS = 25;
/** Quotes a swap moves beside the coin: no coin of its own */
const QUOTE_MINTS = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

/** How a wallet trades by its newest transactions: how many a day, how many swaps, how many coins */
function activityOf(txs: readonly Tx[]): { txs_read: number; span_hours: number | null; per_day: number | null; swaps: number; coins: number; bot_like: boolean } {
  const times = txs.map((t) => t.blockTime).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  const span = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
  const perDay = span !== null && span > 0 ? Math.round(txs.length / (span / 86_400)) : null;
  const balances = (t: Tx) => [...(t.meta?.preTokenBalances ?? []), ...(t.meta?.postTokenBalances ?? [])];
  const swaps = txs.filter((t) => balances(t).length > 0).length;
  const coins = new Set(txs.flatMap((t) => balances(t).flatMap((b) => (isObj(b) && typeof b.mint === "string" && !QUOTE_MINTS.has(b.mint) ? [b.mint] : [])))).size;
  return {
    txs_read: txs.length,
    span_hours: span === null ? null : Math.round((span / 3600) * 10) / 10,
    per_day: perDay,
    swaps,
    coins,
    bot_like: txs.length >= LINK_TXS / 2 && perDay !== null && perDay >= BOT_TX_PER_DAY && coins >= BOT_COINS,
  };
}
/**
 * A funder that ties the wallets it funded: never an exchange's hot wallet, whose withdrawals fund anyone (as the
 * holder links read them: sol_holder_links)
 */
const ties = (funder: string | null | undefined): funder is string => typeof funder === "string" && exchangeLabel(funder) === null;
/** A funder's public label, for a row: an exchange's hot wallet by name */
const funderLabel = (funder: string | null | undefined) => {
  const label = funder ? exchangeLabel(funder) : null;
  return label ? { funder_label: label } : {};
};

/** X's post ids carry their time: ms since its epoch, shifted 22 bits */
const X_EPOCH_MS = 1_288_834_974_657;

/** The launch keys' rpc; `tag` books its credits under the tool and the asker's kind (tools_helius_spend) */
type Rpc = (method: string, params: unknown[], signal: AbortSignal, tag?: { calls: number; limited: number; waitedMs: number; credits: number; caller?: string; tool?: string }) => Promise<unknown>;
const tagOf = (tool: string, caller: string | undefined) => ({ calls: 0, limited: 0, waitedMs: 0, credits: 0, tool, caller: caller ?? "" });

/**
 * The wallets' funders read, kept across restarts: a wallet's first funder never changes, nor "none" once its first
 * FUNDER_TXS transactions were all read
 */
const FUNDER_MIGRATIONS = [
  {
    id: "tools/011_funders",
    sql: `
      CREATE TABLE tools_funders (
        wallet    TEXT PRIMARY KEY,
        funder    TEXT,               -- null: none in its first transactions
        funded_at INTEGER,            -- s epoch, the funding transaction's time
        at        INTEGER NOT NULL    -- ms epoch, read
      );
    `,
  },
];

/** The funders in SQLite (FUNDER_MIGRATIONS); every call never throws */
function funderStore(db: Db) {
  migrate(db, FUNDER_MIGRATIONS);
  const put = db.prepare("INSERT INTO tools_funders (wallet, funder, funded_at, at) VALUES (?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET funder = excluded.funder, funded_at = excluded.funded_at, at = excluded.at");
  const get = db.prepare("SELECT funder, funded_at FROM tools_funders WHERE wallet = ?");
  return {
    get(wallet: string): { funder: string | null; at: number | null } | null {
      try {
        const row = get.get(wallet) as { funder: string | null; funded_at: number | null } | undefined;
        return row ? { funder: row.funder, at: row.funded_at } : null;
      } catch {
        return null;
      }
    },
    put(wallet: string, f: { funder: string | null; at: number | null }, now: number): void {
      try {
        put.run(wallet, f.funder, f.at, now);
      } catch {
        // kept in memory anyway
      }
    },
  };
}

interface Trade {
  wallet: string;
  side: "buy" | "sell";
  amount: number;
  at: number;
  slot: number;
  paid: number | null;
  paidIn: string | null;
}

interface WindowRead {
  trades: Trade[];
  /** The span read: before the call from `preFrom` (the call's side first), after it up to `postTo` */
  preFrom: number;
  postTo: number;
  full: boolean;
  pages: number;
}

/** A call's time: an ISO time, or an X post's link or id (its id holds its time) */
export function callTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const id = /(?:status(?:es)?\/)?(\d{15,20})(?:\D*$)/.exec(t)?.[1];
  if (id && /^\d{15,20}$/.test(id) && (/x\.com|twitter\.com/.test(t) || /^\d{15,20}$/.test(t))) {
    const ms = Number(BigInt(id) >> 22n) + X_EPOCH_MS;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export function frontrunTools(fc: FreeContext, rpc: Rpc, db: Db | null = null): ToolDef[] {
  const store = db ? funderStore(db) : null;
  /** One window of a mint's trades: kept 30 min by mint and window, shared while it is read */
  const kept = new Map<string, { at: number; read: Promise<WindowRead> }>();

  /**
   * The trades around a call: before it from the call backwards (the seconds next to the call read first: a busy launch
   * can fill the budget long before the call) and after it forwards, each side SIDE_PAGES pages at most; what each side
   * covered is said
   */
  function readWindow(mint: string, calledAt: number, from: number, to: number, signal: AbortSignal, tag?: ReturnType<typeof tagOf>): Promise<WindowRead> {
    const key = `${mint}|${calledAt}|${from}|${to}`;
    const hit = kept.get(key);
    if (hit && fc.now() - hit.at < 30 * MINUTE) return hit.read;
    const read = (async (): Promise<WindowRead> => {
      const txs: Tx[] = [];
      let pages = 0;
      const page = async (gte: number, lt: number, next: string | null, order: "asc" | "desc" = "asc") => {
        pages++;
        // the successful ones only (a failed snipe traded nothing and is billed like a buy), in json (a third smaller)
        const r = await rpc("getTransactionsForAddress", [mint, { transactionDetails: "full", sortOrder: order, limit: PAGE_TXS, encoding: "json", maxSupportedTransactionVersion: 1, filters: { status: "succeeded", blockTime: { gte, lt } }, ...(next ? { paginationToken: next } : {}) }], signal, tag);
        const data = isObj(r) && Array.isArray(r.data) ? (r.data as Tx[]) : [];
        txs.push(...data);
        return { data, next: isObj(r) && typeof r.paginationToken === "string" && data.length >= PAGE_TXS ? r.paginationToken : null };
      };
      /**
       * One side page by page from the call outwards (before it newest first, after it oldest first), `budget` pages at
       * most: no empty slice costs a page, the seconds next to the call come first. Returns how far it got: the side's
       * far end when it read it all, else the time of the last transaction read
       */
      const side = async (gte: number, lt: number, order: "asc" | "desc", budget: number): Promise<number> => {
        let next: string | null = null;
        let reached = order === "desc" ? lt : gte;
        for (let used = 0; used < budget; used++) {
          const pg = await page(gte, lt, next, order);
          const edge = pg.data.at(-1)?.blockTime;
          if (typeof edge === "number") reached = edge;
          next = pg.next;
          if (!next) return order === "desc" ? gte : lt;
        }
        return reached;
      };
      // a quiet coin: one page for the whole window; a busy one: that page kept, then each side on its own budget, both
      // at once: before the call back to its last second only, or, when it reaches past the call, the side after from
      // its last second
      const first = await page(from, to, null);
      let preFrom = from;
      let postTo = to;
      if (first.next) {
        const lastFirst = first.data.at(-1)?.blockTime ?? from;
        if (lastFirst < calledAt) {
          const [pre, post] = await Promise.all([side(lastFirst, calledAt, "desc", SIDE_PAGES), side(calledAt, to, "asc", SIDE_PAGES)]);
          preFrom = pre <= lastFirst ? from : pre;
          postTo = post;
        } else postTo = await side(lastFirst, to, "asc", SIDE_PAGES);
      }
      const seen = new Set<string>();
      const trades: Trade[] = [];
      for (const tx of txs.sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0))) {
        const sig = tx.transaction?.signatures?.[0];
        if (sig) {
          if (seen.has(sig)) continue;
          seen.add(sig);
        }
        if (tx.meta?.err || typeof tx.blockTime !== "number") continue;
        const d = deltas(tx, mint);
        const who = traderOf(tx, d);
        const amount = who ? (d.get(who) ?? 0) : 0;
        if (!who || amount === 0) continue;
        trades.push({ wallet: who, side: amount > 0 ? "buy" : "sell", amount: Math.abs(amount), at: tx.blockTime, slot: tx.slot, ...(amount > 0 ? paidOf(tx, who) : { paid: null, paidIn: null }) });
      }
      return { trades, preFrom, postTo, full: preFrom === from && postTo === to, pages };
    })();
    kept.set(key, { at: fc.now(), read });
    read.catch(() => kept.delete(key));
    for (const [k, v] of kept) if (fc.now() - v.at > 30 * MINUTE) kept.delete(k);
    return read;
  }

  async function supplyOf(mint: string, signal: AbortSignal, tag?: ReturnType<typeof tagOf>): Promise<number | null> {
    try {
      const r = await rpc("getTokenSupply", [mint], signal, tag);
      const v = isObj(r) && isObj(r.value) ? Number(r.value.uiAmountString ?? r.value.uiAmount) : NaN;
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * Who sent a wallet its first SOL: the fee payer of its earliest transaction that raised its SOL, other than itself.
   * An answer is kept (in memory, and in tools_funders once it never changes: a funder found, or none in its first
   * FUNDER_TXS); a read that failed never is, the next asker reads it again
   */
  const funders = new Map<string, Promise<{ funder: string | null; at: number | null }>>();
  function funderOf(wallet: string, signal: AbortSignal, tag?: ReturnType<typeof tagOf>): Promise<{ funder: string | null; at: number | null }> {
    const hit = funders.get(wallet);
    if (hit) return hit;
    const kept = store?.get(wallet);
    if (kept) return Promise.resolve(kept);
    const read = (async (): Promise<{ funder: string | null; at: number | null; final: boolean }> => {
      const r = await rpc("getTransactionsForAddress", [wallet, { transactionDetails: "full", sortOrder: "asc", limit: FUNDER_TXS, encoding: "json", maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }], signal, tag);
      const first = isObj(r) && Array.isArray(r.data) ? (r.data as Tx[]) : [];
      for (const tx of first) {
        if (tx.meta?.err) continue;
        const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (isObj(k) ? k.pubkey : k));
        const at = keys.indexOf(wallet);
        const pre = at >= 0 ? tx.meta?.preBalances?.[at] : undefined;
        const post = at >= 0 ? tx.meta?.postBalances?.[at] : undefined;
        if (typeof pre !== "number" || typeof post !== "number" || post <= pre) continue;
        // the account whose SOL fell the most in it: the sender (the fee payer when it is not the wallet itself)
        let best: string | null = null;
        let drop = 0;
        keys.forEach((k, i) => {
          const a = tx.meta?.preBalances?.[i];
          const b = tx.meta?.postBalances?.[i];
          if (typeof k === "string" && k !== wallet && typeof a === "number" && typeof b === "number" && a - b > drop) {
            drop = a - b;
            best = k;
          }
        });
        if (best) return { funder: best, at: tx.blockTime ?? null, final: true };
      }
      // none: for good once its first FUNDER_TXS were read, else its history may still bring one
      return { funder: null, at: null, final: first.length >= FUNDER_TXS };
    })();
    const p = read.then(
      ({ final, ...f }) => {
        if (final) store?.put(wallet, f, fc.now());
        return f;
      },
      () => {
        // unread: no funder said, and asked again by the next caller
        if (funders.get(wallet) === p) funders.delete(wallet);
        return { funder: null, at: null };
      },
    );
    funders.set(wallet, p);
    if (funders.size > 5000) funders.clear();
    return p;
  }

  /**
   * The wallets one sent SOL to or got SOL from in plain transfers (no token moved in the transaction), from its newest
   * LINK_TXS successful transactions: each counterparty's SOL in and out. A side wallet's profits go home to its
   * owner's wallet or to the same exchange deposit address; an exchange's hot wallet and a program's account tie no
   * one. Null when the read failed
   */
  async function transfersOf(wallet: string, signal: AbortSignal, tag?: ReturnType<typeof tagOf>): Promise<{ links: Map<string, { in: number; out: number }>; activity: ReturnType<typeof activityOf> } | null> {
    let r: unknown;
    try {
      r = await rpc("getTransactionsForAddress", [wallet, { transactionDetails: "full", sortOrder: "desc", limit: LINK_TXS, encoding: "json", maxSupportedTransactionVersion: 1, filters: { status: "succeeded" } }], signal, tag);
    } catch {
      return null;
    }
    if (!isObj(r) || !Array.isArray(r.data)) return null;
    const out = new Map<string, { in: number; out: number }>();
    const activity = activityOf(r.data as Tx[]);
    for (const tx of r.data as Tx[]) {
      if (tx.meta?.err || (tx.meta?.preTokenBalances?.length ?? 0) > 0 || (tx.meta?.postTokenBalances?.length ?? 0) > 0) continue;
      const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (isObj(k) ? k.pubkey : k));
      const moved = (i: number) => ((tx.meta?.postBalances?.[i] ?? 0) - (tx.meta?.preBalances?.[i] ?? 0)) / 1e9;
      const me = keys.indexOf(wallet);
      const mine = me >= 0 ? moved(me) : 0;
      if (Math.abs(mine) < LINK_MIN_SOL) continue;
      keys.forEach((k, i) => {
        const theirs = moved(i);
        if (i === me || typeof k !== "string" || !BASE58.test(k) || Math.sign(theirs) === Math.sign(mine) || Math.abs(theirs) < LINK_MIN_SOL) return;
        if (exchangeLabel(k) !== null || !onCurve(k)) return;
        const e = out.get(k) ?? { in: 0, out: 0 };
        if (mine < 0) e.out += Math.min(-mine, theirs);
        else e.in += Math.min(mine, -theirs);
        out.set(k, e);
      });
    }
    return { links: out, activity };
  }

  function readCall(trades: Trade[], calledAt: number, supply: number | null) {
    const by = new Map<string, { wallet: string; boughtBefore: number; paidBefore: number; paidIn: string | null; firstBuyAt: number; firstBuySlot: number; boughtAfter: number; soldAfter: number; firstSellAfter: number | null }>();
    for (const t of trades) {
      let w = by.get(t.wallet);
      if (!w) by.set(t.wallet, (w = { wallet: t.wallet, boughtBefore: 0, paidBefore: 0, paidIn: null, firstBuyAt: Infinity, firstBuySlot: 0, boughtAfter: 0, soldAfter: 0, firstSellAfter: null }));
      if (t.side === "buy" && t.at < calledAt) {
        w.boughtBefore += t.amount;
        if (t.paid !== null) {
          w.paidBefore += t.paid;
          w.paidIn ??= t.paidIn;
        }
        if (t.at < w.firstBuyAt) {
          w.firstBuyAt = t.at;
          w.firstBuySlot = t.slot;
        }
      } else if (t.side === "buy") w.boughtAfter += t.amount;
      else if (t.at >= calledAt) {
        w.soldAfter += t.amount;
        w.firstSellAfter ??= t.at;
      }
    }
    const pre = [...by.values()].filter((w) => w.boughtBefore > 0).sort((a, b) => b.boughtBefore - a.boughtBefore);
    const slots = new Map<number, string[]>();
    for (const w of pre) slots.set(w.firstBuySlot, [...(slots.get(w.firstBuySlot) ?? []), w.wallet]);
    const pct = (x: number) => (supply ? r4((x / supply) * 100) : null);
    return { pre, slots, pct };
  }

  /**
   * A call's time in seconds: an X post or an ISO time as callTime reads it, or a pump.fun callout (its link or id) as
   * pump.fun recorded it (fc.pumpCallout), with the callout's coin and its author's wallet; null when it is none of
   * these, "unknown" for a callout pump.fun has no record of (a read that fails throws its error)
   */
  async function callOf(v: unknown, signal: AbortSignal): Promise<{ at: number; callout: { id: string; mint: string; wallet: string } | null } | "unknown" | null> {
    const id = pumpCalloutId(v);
    if (id === null) {
      const at = callTime(v);
      return at === null ? null : { at, callout: null };
    }
    const c = fc.pumpCallout ? await fc.pumpCallout(id, signal) : null;
    return c ? { at: Math.floor(c.atMs / 1000), callout: { id: c.id, mint: c.mint, wallet: c.wallet } } : "unknown";
  }

  const frontrun: ToolDef = {
    name: "call_frontrun",
    slow: true,
    description:
      "Who bought a Solana coin just before someone called it, read from the chain: the wallets that bought in the minutes before the call (seconds before, share of supply, what they paid, several in one slot), whether and how soon after the call they sold, who funded each, the funders they share, a tie to the caller's wallet. The call: an X post's link or id (its id holds its time), a pump.fun callout's link or id (its author the caller), or an ISO time. For side wallets buying ahead of a caller; a pattern, never proof of who controls a wallet.",
    parameters: {
      type: "object",
      properties: {
        mint: { type: "string", description: "The coin's mint address (base58)", pattern: BASE58.source },
        call: { type: "string", description: "When the call went out: the X post's link or id, a pump.fun callout's link or id, or an ISO 8601 time", minLength: 6, maxLength: 200 },
        caller_wallet: { type: "string", description: "The caller's known wallet, to look for ties (optional)", pattern: BASE58.source },
        before_s: { type: "integer", description: "Seconds before the call to read", minimum: 30, maximum: 3600, default: 600 },
        after_s: { type: "integer", description: "Seconds after the call to read", minimum: 60, maximum: 3600, default: 900 },
      },
      required: ["mint", "call"],
      additionalProperties: false,
    },
    ttlMs: 30 * MINUTE,
    async run(args, { signal, caller: asker }): Promise<Outcome> {
      const mint = String(args.mint);
      const call = await callOf(args.call, signal);
      if (call === "unknown") return { ok: false, error: "not_found", message: "pump.fun has no callout with this id" };
      if (call === null) return { ok: false, error: "bad_args", message: "call must be an X post's link or id, a pump.fun callout's link or id, or an ISO time" };
      if (call.callout && call.callout.mint !== mint) return { ok: false, error: "bad_args", message: `this callout is on another coin (${call.callout.mint})` };
      const calledAt = call.at;
      const nowS = Math.floor(fc.now() / 1000);
      if (calledAt > nowS || calledAt < nowS - 90 * (DAY / 1000)) return { ok: false, error: "bad_args", message: "the call must be within the last 90 days" };
      const before = Math.max(30, Math.min(3600, Number(args.before_s ?? 600)));
      const after = Math.max(60, Math.min(3600, Number(args.after_s ?? 900)));
      // a callout's author is the caller when no wallet is given
      const caller = typeof args.caller_wallet === "string" ? args.caller_wallet : (call.callout?.wallet ?? null);
      const tag = tagOf("call_frontrun", asker);
      const [w, supply] = await Promise.all([readWindow(mint, calledAt, calledAt - before, Math.min(nowS, calledAt + after), signal, tag), supplyOf(mint, signal, tag)]);
      if (!w.trades.length) return { ok: false, error: "not_found", message: "no trade of this coin read in that window" };
      const { pre, slots, pct } = readCall(w.trades, calledAt, supply);
      const top = pre.slice(0, FUNDERS_MAX);
      const funded = await Promise.all(top.map((x) => funderOf(x.wallet, signal, tag)));
      const funderOfWallet = new Map(top.map((x, i) => [x.wallet, funded[i]!]));
      const shared = new Map<string, string[]>();
      for (const [wallet, f] of funderOfWallet) if (ties(f.funder)) shared.set(f.funder, [...(shared.get(f.funder) ?? []), wallet]);
      const clusters = [...shared].filter(([, ws]) => ws.length >= 2).map(([funder, ws]) => ({ funder, wallets: ws, ...(funder === caller ? { funder_is_caller: true } : {}) }));
      const sameSlot = [...slots].filter(([, ws]) => ws.length >= 2).map(([slot, ws]) => ({ slot, wallets: ws }));
      const rows = pre.slice(0, ROWS_MAX).map((x) => {
        const f = funderOfWallet.get(x.wallet);
        return {
          wallet: x.wallet,
          bought_s_before: calledAt - x.firstBuyAt,
          bought_pct: pct(x.boughtBefore),
          paid: x.paidBefore ? r4(x.paidBefore) : null,
          paid_in: x.paidIn,
          sold_after_pct: x.boughtBefore ? Math.min(100, Math.round((x.soldAfter / x.boughtBefore) * 1000) / 10) : 0,
          first_sell_s_after: x.firstSellAfter !== null ? x.firstSellAfter - calledAt : null,
          funder: f?.funder ?? null,
          ...funderLabel(f?.funder),
          ...(caller && (x.wallet === caller || f?.funder === caller) ? { tie_to_caller: x.wallet === caller ? "is the caller's wallet" : "funded by the caller's wallet" } : {}),
        };
      });
      const sold = pre.filter((x) => x.soldAfter > 0);
      const data = {
        mint,
        called_at: iso(calledAt),
        ...(call.callout ? { callout: { id: call.callout.id, author_wallet: call.callout.wallet } } : {}),
        window: { from: iso(calledAt - before), to: iso(Math.min(nowS, calledAt + after)), read_from: iso(w.preFrom), read_to: iso(w.postTo), full: w.full, pages: w.pages },
        summary: {
          buyers_before: pre.length,
          bought_before_pct: supply ? r2((pre.reduce((s, x) => s + x.boughtBefore, 0) / supply) * 100) : null,
          sold_after: sold.length,
          median_s_before: median(pre.map((x) => calledAt - x.firstBuyAt)),
          median_sell_s_after: median(sold.map((x) => x.firstSellAfter! - calledAt)),
          same_slot_groups: sameSlot.length,
          shared_funders: clusters.length,
        },
        rows,
        same_slot: sameSlot.slice(0, 10),
        clusters: clusters.slice(0, 10),
        note: "buys in the window before the call and sells after it, from the chain; a funder is who sent each wallet its first SOL (an exchange's hot wallet ties no one). A pattern, never proof of who controls a wallet.",
      };
      return { ok: true, data, sources: [] };
    },
  };

  const sideWallets: ToolDef = {
    name: "caller_side_wallets",
    slow: true,
    description:
      "One caller's side wallets across several of their calls, from the chain: the wallets that bought before two or more of the calls (how many, how early on average, how soon after the call they sold), the funders they share, the wallets that tie them (paid or paid by two of them in plain transfers: a consolidation wallet, one exchange deposit address; one paying another) and ties to the caller's wallet. Each call is a coin and the call's time (an X post's link or id, a pump.fun callout's link or id, or an ISO time). A pattern, never proof.",
    parameters: {
      type: "object",
      properties: {
        calls: { type: "array", description: "The calls, each `<mint> <X post link or id, pump.fun callout link or id, or ISO time>` (2 to 8)", items: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}\\s+\\S{6,220}$" }, minItems: 2, maxItems: CALLS_MAX },
        caller_wallet: { type: "string", description: "The caller's known wallet, to look for ties (optional)", pattern: BASE58.source },
      },
      required: ["calls"],
      additionalProperties: false,
    },
    ttlMs: 30 * MINUTE,
    async run(args, { signal, caller: asker }): Promise<Outcome> {
      const nowS = Math.floor(fc.now() / 1000);
      // one at a time: a callout not read before is a request to pump.fun, whose edge blocks bursts
      const given: ({ mint: string; at: number; author: string | null } | null)[] = [];
      for (const c of args.calls as unknown[]) {
        const [mint = "", when] = String(c).trim().split(/\s+/);
        const call = await callOf(when, signal).catch(() => null);
        // a callout on another coin than its mint is no call of that coin
        given.push(call && call !== "unknown" && (!call.callout || call.callout.mint === mint) ? { mint, at: call.at, author: call.callout?.wallet ?? null } : null);
      }
      const calls = given.filter((c): c is { mint: string; at: number; author: string | null } => c !== null && BASE58.test(c.mint) && c.at <= nowS);
      if (calls.length < 2) return { ok: false, error: "bad_args", message: "give 2 to 8 calls, each '<mint> <X post link or id, pump.fun callout link or id, or ISO time>'" };
      // the callouts' author is the caller when every call is a callout of one author and no wallet is given
      const authors = new Set(calls.map((c) => c.author));
      const byAuthor = typeof args.caller_wallet !== "string" && authors.size === 1 && !authors.has(null);
      const caller = typeof args.caller_wallet === "string" ? args.caller_wallet : byAuthor ? calls[0]!.author : null;
      const tag = tagOf("caller_side_wallets", asker);
      const reads = await Promise.all(calls.map((c) => readWindow(c.mint, c.at, c.at - 600, Math.min(nowS, c.at + 900), signal, tag).then((w) => ({ c, w })).catch(() => null)));
      const seen = new Map<string, { calls: number; sBefore: number[]; sellAfter: number[]; mints: string[] }>();
      let read = 0;
      for (const r of reads) {
        if (!r || !r.w.trades.length) continue;
        read++;
        const { pre } = readCall(r.w.trades, r.c.at, null);
        for (const x of pre) {
          const s = seen.get(x.wallet) ?? { calls: 0, sBefore: [], sellAfter: [], mints: [] };
          s.calls++;
          s.sBefore.push(r.c.at - x.firstBuyAt);
          if (x.firstSellAfter !== null) s.sellAfter.push(x.firstSellAfter - r.c.at);
          s.mints.push(r.c.mint);
          seen.set(x.wallet, s);
        }
      }
      if (!read) return { ok: false, error: "not_found", message: "no trade read around any of the calls" };
      const recurring = [...seen].filter(([, s]) => s.calls >= 2).sort((a, b) => b[1].calls - a[1].calls || median(a[1].sBefore)! - median(b[1].sBefore)!);
      const top = recurring.slice(0, FUNDERS_MAX);
      const funded = await Promise.all(top.map(([w]) => funderOf(w, signal, tag)));
      const shared = new Map<string, string[]>();
      top.forEach(([w], i) => {
        const f = funded[i]!.funder;
        if (ties(f)) shared.set(f, [...(shared.get(f) ?? []), w]);
      });
      // what ties them beyond timing: the wallets they paid or were paid by in plain SOL transfers, shared by two of them or
      // more, or one of them paying another (the caller's wallet among them when known): a consolidation wallet, one
      // exchange deposit address
      const linkable = [...recurring.slice(0, LINK_WALLETS).map(([w]) => w), ...(caller && !recurring.slice(0, LINK_WALLETS).some(([w]) => w === caller) ? [caller] : [])];
      const sent = await Promise.all(linkable.map((w) => transfersOf(w, signal, tag)));
      const through = new Map<string, { wallets: string[]; in: number; out: number }>();
      sent.forEach((m, i) => {
        for (const [party, f] of m?.links ?? []) {
          const e = through.get(party) ?? { wallets: [], in: 0, out: 0 };
          e.wallets.push(linkable[i]!);
          // SOL into it from them, and out of it to them
          e.in += f.out;
          e.out += f.in;
          through.set(party, e);
        }
      });
      const links = [...through]
        .filter(([party, e]) => e.wallets.length >= 2 || linkable.includes(party))
        .sort((a, b) => b[1].wallets.length - a[1].wallets.length || b[1].in + b[1].out - (a[1].in + a[1].out))
        .slice(0, 10)
        .map(([party, e]) => ({
          wallet: party,
          tied: e.wallets,
          sol_from_them: r4(e.in),
          sol_to_them: r4(e.out),
          ...(party === caller ? { is_caller: true } : linkable.includes(party) ? { one_of_them: true } : {}),
        }));
      const activityOfWallet = new Map(linkable.flatMap((w, i) => (sent[i] ? [[w, sent[i]!.activity] as const] : [])));
      const rows = recurring.slice(0, ROWS_MAX).map(([wallet, s], i) => {
        const f = i < top.length ? funded[i]!.funder : null;
        const act = activityOfWallet.get(wallet);
        return {
          wallet,
          calls_front_run: s.calls,
          of_calls: read,
          median_s_before: median(s.sBefore),
          sold_after_calls: s.sellAfter.length,
          median_sell_s_after: median(s.sellAfter),
          funder: f,
          ...funderLabel(f),
          ...(caller && (wallet === caller || f === caller) ? { tie_to_caller: wallet === caller ? "is the caller's wallet" : "funded by the caller's wallet" } : {}),
          ...(act ? { activity: { txs_read: act.txs_read, span_hours: act.span_hours, per_day: act.per_day, swaps: act.swaps, coins: act.coins }, ...(act.bot_like ? { bot_like: true } : {}) } : {}),
        };
      });
      const bots = rows.filter((x) => "bot_like" in x).map((x) => x.wallet);
      return {
        ok: true,
        data: {
          calls_read: read,
          calls_given: calls.length,
          ...(byAuthor ? { caller_wallet: caller } : {}),
          recurring_wallets: recurring.length,
          rows,
          clusters: [...shared].filter(([, ws]) => ws.length >= 2).map(([funder, wallets]) => ({ funder, wallets, ...(funder === caller ? { funder_is_caller: true } : {}) })).slice(0, 10),
          links_read: sent.filter((m) => m !== null).length,
          links,
          ...(bots.length ? { bots } : {}),
          note: "a wallet that bought in the 10 min before two or more of the calls; sells read up to 15 min after each; an exchange's hot wallet as a funder ties no one; links: a wallet two or more of them (or the caller) sent SOL to or got SOL from in plain transfers (a consolidation wallet, one exchange deposit address), or one of them paying another; activity: the top wallets' newest 100 transactions, and bot_like one that trades hundreds of times a day across many coins (a sniper early to every launch: its timing ties it to no caller). A pattern, never proof of who controls a wallet.",
        },
        sources: [],
      };
    },
  };

  return [frontrun, sideWallets];
}

