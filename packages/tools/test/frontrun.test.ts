// Who bought before a call (src/free/frontrun.ts): the call's time from an X post's id, the window's buyers before the
// call and their sells after, same-slot groups, the funders they share and a tie to the caller, a relayer's
// trades read as the user's (launch.ts traderOf), and one caller's recurring wallets across calls.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callTime } from "../src/free/frontrun.ts";
import { openDb, type Db } from "@crawlnet/shared";
import { createToolsWith } from "../src/registry.ts";
import { makeCtx, solKey } from "./helpers.ts";

const MINT = solKey("frontrun-mint");
const MINT2 = solKey("frontrun-mint-2");
const RELAYER = solKey("app-relayer");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const A = solKey("side-a");
const B = solKey("side-b");
const C = solKey("early-c");
const D = solKey("late-d");
const U = solKey("app-user");
const F = solKey("funder-f");
const POOL = solKey("pool-vault-owner");
/** The call: an X post whose id holds 2026-10-14T17:04:23Z */
const POST = "https://x.com/example_caller/status/2110416437506998273";
const CALL = callTime(POST)!;

const bal = (owner: string, mint: string, ui: number) => ({ accountIndex: 1, mint, owner, uiTokenAmount: { uiAmount: ui, uiAmountString: String(ui), decimals: 6, amount: String(ui * 1e6) } });
/** A trade of `mint`: `who` gets `got` (negative: sells) against the pool; `signers` sign (the first pays) */
function trade(mint: string, slot: number, at: number, who: string, got: number, o: { signers?: string[]; usdc?: number; sol?: number } = {}) {
  const signers = o.signers ?? [who];
  const pre = [bal(who, mint, got > 0 ? 0 : -got), bal(POOL, mint, 1e8), ...(o.usdc ? [bal(who, USDC, o.usdc)] : [])];
  const post = [bal(who, mint, got > 0 ? got : 0), bal(POOL, mint, 1e8 - got), ...(o.usdc ? [bal(who, USDC, 0)] : [])];
  const keys = [...signers.map((k) => ({ pubkey: k, signer: true })), ...(signers.includes(who) ? [] : [{ pubkey: who, signer: false }])];
  return {
    slot,
    blockTime: at,
    transaction: { signatures: [`sig-${mint.slice(0, 4)}-${slot}-${who.slice(0, 4)}`], message: { accountKeys: keys } },
    meta: { err: null, fee: 5000, preBalances: keys.map(() => 10e9), postBalances: keys.map((_, i) => 10e9 - (i === 0 ? 5000 + (o.sol ?? 0) : 0)), preTokenBalances: pre, postTokenBalances: post },
  };
}
/** The first SOL into `wallet`, sent by `from` */
const funding = (wallet: string, from: string, at: number) => ({
  slot: 1,
  blockTime: at,
  transaction: { signatures: [`fund-${wallet.slice(0, 6)}`], message: { accountKeys: [{ pubkey: from, signer: true }, { pubkey: wallet, signer: false }] } },
  meta: { err: null, fee: 5000, preBalances: [50e9, 0], postBalances: [50e9 - 1e9 - 5000, 1e9], preTokenBalances: [], postTokenBalances: [] },
});

/** The chain as the fake has it: each mint's history; `down`: wallets whose history reads fail; `db`: a restart keeps it */
function world(history: Record<string, ReturnType<typeof trade>[]>, o: { down?: Set<string>; db?: Db; funder?: string; sends?: Record<string, unknown[]> } = {}) {
  const calls: { method: string; address: string; returned?: number }[] = [];
  const statuses: unknown[] = [];
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string, Record<string, any>] };
    calls.push({ method: body.method, address: body.params[0] });
    if (o.down?.has(body.params[0])) return new Response("down", { status: 503 });
    let result: unknown = null;
    if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
    else if (body.method === "getTransactionsForAddress") {
      const addr = body.params[0];
      const f = body.params[1].filters?.blockTime;
      if (history[addr]) {
        // `limit` a page, the rest behind a token (the fake keeps the offset in it); the successful ones when asked
        const size = Number(body.params[1].limit ?? 100);
        statuses.push(body.params[1].filters?.status);
        const inWindow = history[addr]!.filter((t) => !f || (t.blockTime >= f.gte && t.blockTime < f.lt));
        const all = body.params[1].sortOrder === "desc" ? [...inWindow].reverse() : inWindow;
        const from = body.params[1].paginationToken ? Number(body.params[1].paginationToken) : 0;
        result = { data: all.slice(from, from + size), paginationToken: all.length > from + size ? String(from + size) : null };
        calls.at(-1)!.returned = Math.min(size, Math.max(0, all.length - from));
      }
      // a wallet's newest transactions (its links), as the fake has them
      else if (body.params[1].sortOrder === "desc" && o.sends?.[addr]) result = { data: o.sends[addr], paginationToken: null };
      else if (addr === A || addr === B) result = { data: [funding(addr, o.funder ?? F, CALL - 86_400)], paginationToken: null };
      else if (addr === C) result = { data: [funding(addr, solKey("someone"), CALL - 86_400)], paginationToken: null };
      else result = { data: [], paginationToken: null };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const tools = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }, o.db), { fetch, background: false, now: () => (CALL + 3600) * 1000 });
  return { tools, calls, statuses };
}

describe("who bought before a call (free/frontrun.ts)", () => {
  it("callTime: an X post's link or id holds its time; an ISO time as written; anything else none", () => {
    assert.equal(new Date(CALL * 1000).toISOString(), "2026-10-14T17:04:23.000Z");
    assert.equal(callTime("2110416437506998273"), CALL);
    assert.equal(callTime("2026-10-14T17:04:23Z"), CALL);
    assert.equal(callTime("yesterday-ish"), null);
  });

  it("call_frontrun: two wallets in one slot 20 s before the call, one funder, selling 3 min after; an earlier buyer apart; a buyer after the call is none; the caller's funding a tie", async () => {
    const { tools } = world({
      [MINT]: [
        trade(MINT, 100, CALL - 300, C, 5_000_000, { sol: 1e9 }),
        trade(MINT, 200, CALL - 20, A, 20_000_000, { sol: 3e9 }),
        trade(MINT, 200, CALL - 20, B, 15_000_000, { sol: 2e9 }),
        trade(MINT, 300, CALL + 30, D, 1_000_000, { sol: 1e8 }),
        trade(MINT, 400, CALL + 180, A, -20_000_000),
        trade(MINT, 410, CALL + 240, B, -7_500_000),
      ],
    });
    const r = await tools.run("call_frontrun", { mint: MINT, call: POST, caller_wallet: F }, { answerId: "f1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.called_at, "2026-10-14T17:04:23Z");
    assert.deepEqual([d.summary.buyers_before, d.summary.bought_before_pct, d.summary.sold_after, d.summary.same_slot_groups, d.summary.shared_funders], [3, 4, 2, 1, 1]);
    assert.deepEqual(d.same_slot, [{ slot: 200, wallets: [A, B] }]);
    assert.deepEqual(d.clusters, [{ funder: F, wallets: [A, B], funder_is_caller: true }]);
    const a = d.rows.find((x: { wallet: string }) => x.wallet === A);
    assert.deepEqual([a.bought_s_before, a.bought_pct, a.paid, a.paid_in, a.sold_after_pct, a.first_sell_s_after, a.tie_to_caller], [20, 2, 3, "SOL", 100, 180, "funded by the caller's wallet"]);
    assert.equal(d.rows.find((x: { wallet: string }) => x.wallet === B).sold_after_pct, 50);
    assert.ok(!d.rows.some((x: { wallet: string }) => x.wallet === D), "a buyer after the call is no front-runner");
  });

  it("an exchange's hot wallet that funded two of them ties no one: no cluster, its name on their rows", async () => {
    const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
    const { tools } = world(
      {
        [MINT]: [trade(MINT, 200, CALL - 20, A, 20_000_000, { sol: 3e9 }), trade(MINT, 200, CALL - 20, B, 15_000_000, { sol: 2e9 }), trade(MINT, 400, CALL + 180, A, -20_000_000)],
        [MINT2]: [trade(MINT2, 500, CALL - 40, A, 10_000_000, { sol: 1e9 }), trade(MINT2, 500, CALL - 40, B, 10_000_000, { sol: 1e9 })],
      },
      { funder: BINANCE },
    );
    const r = await tools.run("call_frontrun", { mint: MINT, call: POST }, { answerId: "fx1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.deepEqual(d.clusters, []);
    assert.equal(d.summary.shared_funders, 0);
    assert.deepEqual(d.same_slot, [{ slot: 200, wallets: [A, B] }], "the same slot still says it");
    assert.deepEqual(
      d.rows.map((x: { funder: string; funder_label?: string }) => [x.funder, x.funder_label]),
      [
        [BINANCE, "Binance hot wallet"],
        [BINANCE, "Binance hot wallet"],
      ],
    );
    const s = await tools.run("caller_side_wallets", { calls: [`${MINT} ${POST}`, `${MINT2} 2026-10-14T17:04:23Z`] }, { answerId: "fx2" });
    assert.ok(s.ok, JSON.stringify(s));
    const sd = s.data as Record<string, any>;
    assert.equal(sd.recurring_wallets, 2);
    assert.deepEqual(sd.clusters, []);
    assert.equal(sd.rows[0].funder_label, "Binance hot wallet");
  });

  it("a busy window: the first page full, each side then page by page from the call, a thousand successful ones a page; every trade read once, the window full", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => trade(MINT, 1000 + i, CALL - 500 + Math.floor(i / 5) * 2, solKey(`crowd-${i}`), 100_000, { sol: 1e7 }));
    const { tools, calls, statuses } = world({ [MINT]: many });
    const r = await tools.run("call_frontrun", { mint: MINT, call: POST, before_s: 600, after_s: 600 }, { answerId: "f4" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { summary: { buyers_before: number }; window: { full: boolean; pages: number } };
    assert.equal(d.summary.buyers_before, 1250);
    assert.equal(d.window.full, true);
    assert.ok(d.window.pages > 2 && calls.filter((c) => c.method === "getTransactionsForAddress" && c.address === MINT).length === d.window.pages);
    assert.ok(statuses.every((x) => x === "succeeded"), "a failed snipe is never read, nor billed");
  });

  it("a launch's burst far before the call never takes the budget: the seconds next to the call and the sells after it are read first", async () => {
    const burst = Array.from({ length: 5000 }, (_, i) => trade(MINT, 5000 + i, CALL - 600 + Math.floor(i / 20), solKey(`burst-${i}`), 10_000, { sol: 1e7 }));
    const { tools } = world({ [MINT]: [...burst, trade(MINT, 90_000, CALL - 20, A, 20_000_000, { sol: 3e9 }), trade(MINT, 91_000, CALL + 180, A, -20_000_000)] });
    const r = await tools.run("call_frontrun", { mint: MINT, call: POST, before_s: 600, after_s: 600 }, { answerId: "f5" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { window: { full: boolean; read_from: string; read_to: string; pages: number }; rows: { wallet: string; bought_s_before: number; sold_after_pct: number; first_sell_s_after: number }[] };
    const a = d.rows.find((x) => x.wallet === A)!;
    assert.deepEqual([a.bought_s_before, a.sold_after_pct, a.first_sell_s_after], [20, 100, 180]);
    assert.equal(d.window.full, false);
    assert.ok(Date.parse(d.window.read_from) > (CALL - 600) * 1000, "the burst's start left unread, said");
    assert.ok(d.window.pages <= 7, `${d.window.pages} pages`);
  });

  it("a busy window's first page is kept: the side before the call read back to its last second only, every transaction bought once", async () => {
    // 2,500 buys in the 500 s before the call, 400 after it
    const before = Array.from({ length: 2500 }, (_, i) => trade(MINT, 1000 + i, CALL - 500 + Math.floor(i / 5), solKey(`pre-${i}`), 100_000, { sol: 1e7 }));
    const after = Array.from({ length: 400 }, (_, i) => trade(MINT, 9000 + i, CALL + 1 + Math.floor(i / 2), solKey(`post-${i}`), 100_000, { sol: 1e7 }));
    const { tools, calls } = world({ [MINT]: [...before, ...after] });
    const r = await tools.run("call_frontrun", { mint: MINT, call: POST, before_s: 600, after_s: 600 }, { answerId: "f6" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { summary: { buyers_before: number }; window: { full: boolean } };
    assert.deepEqual([d.summary.buyers_before, d.window.full], [2500, true]);
    // the first page's last second is read again by the side before the call (5 buys), nothing else twice
    const returned = calls.filter((c) => c.method === "getTransactionsForAddress" && c.address === MINT).reduce((n, c) => n + (c.returned ?? 0), 0);
    assert.equal(returned, 2500 + 400 + 5);
  });

  it("a first page that reaches past the call holds the side before it whole: the side after is read from its last second", async () => {
    const before = Array.from({ length: 300 }, (_, i) => trade(MINT, 1000 + i, CALL - 300 + i, solKey(`pre-${i}`), 100_000, { sol: 1e7 }));
    const after = Array.from({ length: 1500 }, (_, i) => trade(MINT, 9000 + i, CALL + Math.floor(i / 3), solKey(`post-${i}`), 100_000, { sol: 1e7 }));
    const { tools, calls } = world({ [MINT]: [...before, ...after] });
    const r = await tools.run("call_frontrun", { mint: MINT, call: POST, before_s: 600, after_s: 600 }, { answerId: "f7" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { summary: { buyers_before: number }; window: { full: boolean; pages: number } };
    assert.deepEqual([d.summary.buyers_before, d.window.full, d.window.pages], [300, true, 2]);
    const pages = calls.filter((c) => c.method === "getTransactionsForAddress" && c.address === MINT);
    // the first page ends on the first of its last second's three buys: the side after reads that one again, nothing else
    assert.equal(pages.reduce((n, c) => n + (c.returned ?? 0), 0), 1800 + 1);
  });

  it("a funder read that failed is read again by the next call; one found is kept across a restart (tools_funders)", async () => {
    const db = openDb(":memory:");
    const history = { [MINT]: [trade(MINT, 200, CALL - 20, A, 20_000_000, { sol: 3e9 }), trade(MINT, 200, CALL - 20, B, 15_000_000, { sol: 2e9 })] };
    const down = new Set([A]);
    const first = world(history, { down, db });
    const r1 = await first.tools.run("call_frontrun", { mint: MINT, call: POST }, { answerId: "u1" });
    assert.ok(r1.ok, JSON.stringify(r1));
    const funderOf = (r: { ok: boolean; data?: unknown }, w: string) => (r.data as { rows: { wallet: string; funder: string | null }[] }).rows.find((x) => x.wallet === w)!.funder;
    assert.deepEqual([funderOf(r1, A), funderOf(r1, B)], [null, F]);
    down.clear();
    // another window of the same coin (not the window kept): A's funder asked again, B's kept
    const r2 = await first.tools.run("call_frontrun", { mint: MINT, call: POST, before_s: 300 }, { answerId: "u2" });
    assert.deepEqual([funderOf(r2, A), funderOf(r2, B)], [F, F]);
    assert.equal(first.calls.filter((c) => c.address === A).length, 2 + 1, "A: its failed read (asked twice), then once more");
    assert.equal(first.calls.filter((c) => c.address === B).length, 1);
    // a restart: the funders from the database, none read again
    const second = world(history, { db });
    const r3 = await second.tools.run("call_frontrun", { mint: MINT, call: POST }, { answerId: "u3" });
    assert.deepEqual([funderOf(r3, A), funderOf(r3, B)], [F, F]);
    assert.equal(second.calls.filter((c) => c.address === A || c.address === B).length, 0);
  });

  it("an app buy (the relayer pays and signs first) is the user's, paid in USDC", async () => {
    const { tools } = world({ [MINT]: [trade(MINT, 200, CALL - 10, U, 3_000_000, { signers: [RELAYER, U], usdc: 250 })] });
    const r = await tools.run("call_frontrun", { mint: MINT, call: POST }, { answerId: "f2" });
    assert.ok(r.ok, JSON.stringify(r));
    const rows = (r.data as { rows: { wallet: string; paid: number; paid_in: string }[] }).rows;
    assert.deepEqual(rows.map((x) => [x.wallet, x.paid, x.paid_in]), [[U, 250, "USDC"]]);
  });

  it("caller_side_wallets: the wallets that tie them, a deposit address two of them sent their SOL to and one paying another; a swap's fee never ties", async () => {
    const DEP = solKey("deposit-address");
    const FEE = solKey("fee-account");
    /** a plain SOL transfer of `sol` from `from` to `to` */
    const send = (from: string, to: string, sol: number, slot: number) => ({
      slot,
      blockTime: CALL + slot,
      transaction: { signatures: [`send-${from.slice(0, 4)}-${slot}`], message: { accountKeys: [{ pubkey: from, signer: true }, { pubkey: to, signer: false }] } },
      meta: { err: null, fee: 5000, preBalances: [10e9, 1e9], postBalances: [10e9 - sol * 1e9 - 5000, 1e9 + sol * 1e9], preTokenBalances: [], postTokenBalances: [] },
    });
    // a swap that paid a fee account 0.1 SOL: tokens moved, so no tie
    const swap = (who: string, slot: number) => ({ ...trade(MINT, slot, CALL + slot, who, 1_000, { sol: 1e8 }), transaction: { signatures: [`swap-${who.slice(0, 4)}-${slot}`], message: { accountKeys: [{ pubkey: who, signer: true }, { pubkey: FEE, signer: false }] } } });
    const { tools } = world(
      {
        [MINT]: [trade(MINT, 200, CALL - 20, A, 20_000_000, { sol: 3e9 }), trade(MINT, 200, CALL - 20, B, 15_000_000, { sol: 2e9 })],
        [MINT2]: [trade(MINT2, 500, CALL - 40, A, 10_000_000, { sol: 1e9 }), trade(MINT2, 500, CALL - 40, B, 10_000_000, { sol: 1e9 })],
      },
      { sends: { [A]: [send(A, DEP, 2, 900), send(A, B, 0.5, 910), swap(A, 920)], [B]: [send(B, DEP, 3, 930), swap(B, 940)] } },
    );
    const r = await tools.run("caller_side_wallets", { calls: [`${MINT} ${POST}`, `${MINT2} 2026-10-14T17:04:23Z`] }, { answerId: "fl" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { links_read: number; links: Record<string, unknown>[] };
    assert.equal(d.links_read, 2);
    assert.deepEqual(d.links, [
      { wallet: DEP, tied: [A, B], sol_from_them: 5, sol_to_them: 0 },
      { wallet: B, tied: [A], sol_from_them: 0.5, sol_to_them: 0, one_of_them: true },
    ]);
    assert.ok(!d.links.some((x) => x.wallet === FEE), "a swap's fee ties no one");
  });

  it("caller_side_wallets: a wallet that trades hundreds of times a day across many coins is a bot (a sniper early to every launch: its timing ties it to no caller); a side wallet that trades a few coins is not", async () => {
    // B: 80 swaps in 2 hours over 40 coins; A: 6 swaps of 2 coins over a day
    const coin = (i: number) => solKey(`sniped-${i}`);
    const botTxs = Array.from({ length: 80 }, (_, i) => trade(coin(i % 40), 1000 + i, CALL - i * 90, B, 1_000, { sol: 1e8 }));
    const sideTxs = Array.from({ length: 6 }, (_, i) => trade(i % 2 ? MINT : MINT2, 2000 + i, CALL - i * 14_400, A, 1_000, { sol: 1e8 }));
    const { tools } = world(
      {
        [MINT]: [trade(MINT, 200, CALL - 20, A, 20_000_000, { sol: 3e9 }), trade(MINT, 200, CALL - 25, B, 15_000_000, { sol: 2e9 })],
        [MINT2]: [trade(MINT2, 500, CALL - 40, A, 10_000_000, { sol: 1e9 }), trade(MINT2, 500, CALL - 45, B, 10_000_000, { sol: 1e9 })],
      },
      { sends: { [A]: sideTxs, [B]: botTxs } },
    );
    const r = await tools.run("caller_side_wallets", { calls: [`${MINT} ${POST}`, `${MINT2} 2026-10-14T17:04:23Z`] }, { answerId: "fb" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { rows: Record<string, any>[]; bots?: string[] };
    const rowOf = (w: string) => d.rows.find((x) => x.wallet === w)!;
    assert.deepEqual(d.bots, [B]);
    assert.equal(rowOf(B).bot_like, true);
    assert.deepEqual([rowOf(B).activity.txs_read, rowOf(B).activity.coins, rowOf(B).activity.per_day], [80, 40, 972]);
    assert.equal("bot_like" in rowOf(A), false, "a few coins over a day: no bot");
    assert.equal(rowOf(A).activity.coins, 2);
  });

  it("caller_side_wallets: the wallet that bought before both calls, with its funder; a one-off buyer left out", async () => {
    const { tools } = world({
      [MINT]: [trade(MINT, 200, CALL - 20, A, 20_000_000, { sol: 3e9 }), trade(MINT, 210, CALL - 60, C, 1_000_000, { sol: 1e8 }), trade(MINT, 400, CALL + 120, A, -20_000_000)],
      [MINT2]: [trade(MINT2, 500, CALL - 40, A, 9_000_000, { sol: 1e9 })],
    });
    const r = await tools.run("caller_side_wallets", { calls: [`${MINT} ${POST}`, `${MINT2} 2026-10-14T17:04:23Z`] }, { answerId: "f3" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { calls_read: number; recurring_wallets: number; rows: Record<string, unknown>[] };
    assert.deepEqual([d.calls_read, d.recurring_wallets], [2, 1]);
    const { activity: _a, ...row } = d.rows[0] as Record<string, unknown>;
    assert.deepEqual(row, { wallet: A, calls_front_run: 2, of_calls: 2, median_s_before: 40, sold_after_calls: 1, median_sell_s_after: 120, funder: F });
  });
});
