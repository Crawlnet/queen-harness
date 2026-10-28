// The launch read over the launch keys (HELIUS_LAUNCH_KEYS, src/free/launch.ts): sol_launch as a free tool from the
// mint's history oldest first: the dev, the bundle and the snipers, what they took, hold and sold, what they paid (SOL
// or a quote token), the keys in turn, its rows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "@crawlnet/shared";
import { creditsOf, readLaunch, rolesOf } from "../src/free/launch.ts";
import { createToolsWith } from "../src/registry.ts";
import { makeCtx, SIG, SOL_A, solKey } from "./helpers.ts";

const MINT = "BaTon1111111111111111111111111111111111pump".slice(0, 44);
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const DEV = "DevW1111111111111111111111111111111111111111".slice(0, 44);
const B1 = "Bund1111111111111111111111111111111111111111".slice(0, 44);
const S1 = "Snip1111111111111111111111111111111111111111".slice(0, 44);
const S2 = "Snip2222222222222222222222222222222222222222".slice(0, 44);
const LATE = "Late1111111111111111111111111111111111111111".slice(0, 44);
const CURVE = "Curv1111111111111111111111111111111111111111".slice(0, 44);
const T0 = 1_788_985_931;
const SYSTEM = "11111111111111111111111111111111";

const bal = (owner: string, mint: string, ui: number) => ({ accountIndex: 1, mint, owner, uiTokenAmount: { uiAmount: ui, uiAmountString: String(ui), decimals: 6, amount: String(ui * 1e6) } });
/** A trade: `payer` gets `got` of the mint (negative: sells), paying `sol` lamports or `pump` PUMP */
function tx(slot: number, at: number, payer: string, got: number, o: { sol?: number; pump?: number; err?: boolean } = {}) {
  const pre = [bal(payer, MINT, got > 0 ? 0 : -got), ...(o.pump ? [bal(payer, PUMP, o.pump)] : [])];
  const post = [bal(payer, MINT, got > 0 ? got : 0), ...(o.pump ? [bal(payer, PUMP, 0)] : [])];
  return {
    slot,
    blockTime: at,
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }, { pubkey: CURVE, signer: false }] } },
    meta: { err: o.err ? { InstructionError: [0, "Custom"] } : null, fee: 5000, preBalances: [10e9, 0], postBalances: [10e9 - (o.sol ?? 0) - 5000, 0], preTokenBalances: pre, postTokenBalances: post },
  };
}
const HISTORY = [
  tx(100, T0, DEV, 200_000_000, { pump: 280_000 }),
  tx(100, T0, B1, 50_000_000, { sol: 0.5e9 }),
  tx(100, T0, LATE, 1, { err: true }),
  tx(101, T0 + 1, S1, 80_000_000, { sol: 9.4e9 }),
  tx(102, T0 + 2, S2, 20_000_000, { sol: 2e9 }),
  tx(103, T0 + 5, DEV, -200_000_000),
  tx(140, T0 + 90, LATE, 10_000_000, { sol: 1e9 }),
];

describe("the launch read (free/launch.ts)", () => {
  it("readLaunch and rolesOf: the dev is the creation's payer, the bundle its slot, the snipers the window; failed trades skipped", () => {
    const l = readLaunch(HISTORY as never, MINT)!;
    assert.equal(l.dev, DEV);
    assert.equal(l.launchAt, T0);
    assert.deepEqual(l.traders.get(DEV), { wallet: DEV, firstBought: 200_000_000, bought: 200_000_000, firstBuyAt: T0, firstBuySlot: 100, firstSellAt: T0 + 5, paid: 280_000, paidIn: "PUMP" });
    assert.equal(l.traders.get(S1)!.paid, 9.4);
    assert.equal(l.traders.get(S1)!.paidIn, "SOL");
    const roles = rolesOf(l, 60);
    assert.deepEqual(Object.fromEntries(roles), { [DEV]: "dev", [B1]: "bundle", [S1]: "sniper", [S2]: "sniper" }, "the late buyer (90 s) is no sniper");
  });

  it("sol_launch through the tools layer: oldest first, the supply and holdings read, its rows; one key refused, the next used", async () => {
    const calls: { key: string; method: string; params: unknown[] }[] = [];
    const holds: Record<string, number> = { [DEV]: 0, [B1]: 50_000_000, [S1]: 0, [S2]: 5_000_000 };
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const key = new URL(input).searchParams.get("api-key")!;
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push({ key, method: body.method, params: body.params });
      if (key === "key-refused-000000000000") return new Response("slow down", { status: 429 });
      const result =
        body.method === "getTransactionsForAddress"
          ? { data: HISTORY, paginationToken: null }
          : body.method === "getTokenSupply"
            ? { value: { uiAmountString: "1000000000", decimals: 6 } }
            : { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: String(holds[body.params[0] as string] ?? 0) } } } } } }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-refused-000000000000,key-good-0000000000000000" }), { fetch, background: false });
    const spec = t.list().find((s) => s.name === "sol_launch");
    assert.ok(spec, "offered");
    const r = await t.run("sol_launch", { mint: MINT }, { answerId: "l1" });
    assert.ok(r.ok, JSON.stringify(r));
    const first = calls.find((c) => c.method === "getTransactionsForAddress")!;
    assert.deepEqual((first.params[1] as Record<string, unknown>).sortOrder, "asc");
    assert.ok(calls.some((c) => c.key === "key-refused-000000000000") && calls.some((c) => c.key === "key-good-0000000000000000"), "the refused key passed to the next");
    const rows = (r.data as { content: Record<string, unknown>[] }).content;
    const sum = (role: string) => rows.find((x) => x.role === role && x.wallet === "all")!;
    assert.deepEqual([sum("dev").first_buys_pct, sum("dev").holds_now_pct, sum("dev").sold_since_pct, sum("dev").first_sell_sec, sum("dev").fully_out], [20, 0, 20, 5, 1]);
    assert.deepEqual([sum("bundle").wallets, sum("bundle").first_buys_pct, sum("bundle").holds_now_pct, sum("bundle").fully_out], [1, 5, 5, 0]);
    assert.deepEqual([sum("sniper").wallets, sum("sniper").first_buys_pct, sum("sniper").holds_now_pct, sum("sniper").sold_since_pct, sum("sniper").first_buy_sec], [2, 10, 0.5, 9.5, 1]);
    assert.equal(sum("dev").launched_utc, "2026-09-09 20:32:11");
    const devRow = rows.find((x) => x.wallet === DEV)!;
    assert.deepEqual([devRow.paid, devRow.paid_in], [280_000, "PUMP"]);
    assert.ok(r.sources.some((s) => s.url === `https://solscan.io/token/${MINT}`));
  });

  it("a busy launch: the first page, then the rest of the window page after page (billed for the window only), one of each in the chain's order; first buys apart from re-buys", async () => {
    // 100 trades in the first second (one wallet re-buying), then a slice's own trades: a sniper at 30 s, a late one at 70 s
    const busy = [tx(100, T0, DEV, 1_000_000, { sol: 1e9 }), ...Array.from({ length: 99 }, (_, i) => ({ ...tx(101 + i, T0 + 1, S1, 1_000_000, { sol: 1e9 }), transactionIndex: i, transaction: { signatures: [`sig${i}`], message: { accountKeys: [{ pubkey: S1, signer: true }] } } }))];
    const later = [tx(400, T0 + 30, S2, 5_000_000, { sol: 1e9 }), tx(900, T0 + 70, LATE, 5_000_000, { sol: 1e9 })];
    const filters: unknown[] = [];
    const asked: unknown[][] = [];
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [string, Record<string, any>] };
      let result: unknown;
      if (body.method === "getTransactionsForAddress") {
        const f = body.params[1].filters?.blockTime;
        filters.push(f ?? null);
        asked.push([body.params[1].filters?.status, body.params[1].limit]);
        result = f ? { data: later.filter((t) => t.blockTime >= f.gte && t.blockTime < f.lt), paginationToken: null } : { data: busy, paginationToken: "p1" };
      } else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else result = { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch, background: false });
    const r = await t.run("sol_launch", { mint: MINT }, { answerId: "l3" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(filters[0], null, "the first page has no time filter");
    assert.deepEqual(filters.slice(1), [{ gte: T0 + 1, lt: T0 + 61 }], "then the rest of the window, from the first page's last second");
    const rows = (r.data as { content: Record<string, unknown>[]; seconds_read: number }).content;
    const snipers = rows.find((x) => x.role === "sniper" && x.wallet === "all")!;
    assert.equal(snipers.wallets, 2, "the 70 s buyer is past the window");
    assert.equal(snipers.first_buys_pct, 0.6, "S1's first buy (0.1%) and S2's (0.5%), not S1's 99 re-buys");
    assert.equal((r.data as { seconds_read: number }).seconds_read, 60);
    // the successful transactions only (on a busy launch most are bots' failed snipes, each billed); the
    // first page a hundred (a quiet launch's minute whole for 10 credits), the rest of the window a thousand a page
    assert.ok(asked.every(([status]) => status === "succeeded"), JSON.stringify(asked));
    assert.deepEqual(asked.map(([, limit]) => limit), [100, ...asked.slice(1).map(() => 1000)]);
  });

  it("two askers of one coin at once share one history read; every read asks for transaction format v1", async () => {
    let histories = 0;
    const versions: unknown[] = [];
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [string, Record<string, unknown>] };
      let result: unknown;
      if (body.method === "getTransactionsForAddress") {
        histories++;
        versions.push(body.params[1].maxSupportedTransactionVersion);
        await new Promise((r) => setTimeout(r, 30));
        result = { data: HISTORY, paginationToken: null };
      } else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else result = { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch, background: false });
    const [a, b] = await Promise.all([t.run("sol_launch", { mint: MINT }, { answerId: "s1" }), t.run("sol_launch", { mint: MINT }, { answerId: "s2" })]);
    assert.ok(a.ok && b.ok);
    assert.equal(histories, 1, "one read of the launch for both");
    assert.deepEqual(versions, [1]);
  });

  it("every key out of credits (429 on every call): the read fails, and the next one at once, never waiting for a key", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls++;
      return new Response("max usage reached", { status: 429 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-spent-a00000000000000,key-spent-b00000000000000" }), { fetch, background: false });
    const first = await t.run("sol_launch", { mint: MINT }, { answerId: "x1" });
    assert.equal(first.ok, false);
    const before = calls;
    const t0 = Date.now();
    const second = await t.run("sol_launch", { mint: MINT.slice(0, 43) + "2" }, { answerId: "x2" });
    assert.equal(second.ok, false);
    assert.ok(Date.now() - t0 < 1_000, `failed at once (${Date.now() - t0} ms)`);
    assert.equal(calls, before, "no key asked while all are spent");
  });

  it("a launch read is kept in the database: after a restart it is served with no history read again, and the keys' credits are counted", async () => {
    const db = openDb(":memory:");
    let histories = 0;
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      let result: unknown;
      if (body.method === "getTransactionsForAddress") {
        histories++;
        result = { data: HISTORY, paginationToken: null };
      } else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else result = { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const before = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }, db), { fetch, background: false });
    assert.ok((await before.run("sol_launch", { mint: MINT }, { answerId: "p1" })).ok);
    assert.equal(histories, 1);
    const day = new Date().toISOString().slice(0, 10);
    const spent = db.prepare("SELECT SUM(credits) AS n FROM tools_helius_credits WHERE day = ?").get(day) as { n: number };
    assert.ok(spent.n >= 10, `credits counted: ${spent.n}`);
    // a new tools instance on the same database: the restart
    const after = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }, db), { fetch, background: false });
    const r = await after.run("sol_launch", { mint: MINT }, { answerId: "p2" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(histories, 1, "the history came from the database");
  });

  it("a kept launch takes no launch-limiter token: forty asks within a minute of a coin read once are all served, with no history read", async () => {
    let histories = 0;
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      let result: unknown;
      if (body.method === "getTransactionsForAddress") {
        histories++;
        result = { data: HISTORY, paginationToken: null };
      } else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else result = { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch, background: false });
    assert.ok((await t.run("sol_launch", { mint: MINT, window_seconds: 600 }, { answerId: "k0" })).ok);
    // each its own call (another window each, so none from the result cache), more than the minute's 30
    for (let w = 5; w < 45; w++) {
      const r = await t.run("sol_launch", { mint: MINT, window_seconds: w }, { answerId: `k${w}` });
      assert.ok(r.ok, `window ${w}: ${JSON.stringify(r)}`);
    }
    assert.equal(histories, 1);
  });

  it("Helius's credits: a history page by the transactions it returned (10 a hundred, 10 at least), signatures 10, a plain call 1", () => {
    assert.equal(creditsOf("getTransactionsForAddress", ["m", { transactionDetails: "full" }], { data: new Array(250) }), 30);
    assert.equal(creditsOf("getTransactionsForAddress", ["m", { transactionDetails: "full" }], { data: [] }), 10);
    assert.equal(creditsOf("getTransactionsForAddress", ["m", { transactionDetails: "signatures" }], { data: new Array(1000) }), 10);
    assert.equal(creditsOf("getMultipleAccounts", [[]], { value: [] }), 1);
  });

  it("sol_token_origin reads a mint's creator from its first transaction in one history call over the launch keys, whatever its age", async () => {
    const methods: string[] = [];
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      methods.push(`${new URL(input).searchParams.has("api-key") ? "launch" : "rpc"}:${body.method}`);
      let result: unknown;
      if (body.method === "getTransactionsForAddress") result = { data: [{ ...HISTORY[0], transaction: { signatures: ["sig-first"], message: { accountKeys: [{ pubkey: DEV, signer: true }] } } }], paginationToken: "more" };
      else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else if (body.method === "getTokenAccountsByOwner") result = { value: [] };
      else result = null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000", SOLANA_RPC_URLS: "https://rpc.example.org" }), { fetch, background: false });
    const r = await t.run("sol_token_origin", { mint: MINT }, { answerId: "o1" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((r.data as { creator: string }).creator, DEV);
    assert.ok(!methods.some((m) => m.endsWith(":getSignaturesForAddress")), methods.join(", "));
  });

  it("sol_token_origin keeps a mint's first transaction for good (a restart too): asked again after its 30 s, only the creator's holdings are read", async () => {
    const db = openDb(":memory:");
    let clock = 1_800_000_000_000;
    const methods: string[] = [];
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      methods.push(body.method);
      let result: unknown;
      if (body.method === "getTransactionsForAddress") result = { data: [{ ...HISTORY[0], transaction: { signatures: ["sig-first"], message: { accountKeys: [{ pubkey: DEV, signer: true }] } } }], paginationToken: "more" };
      else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else result = { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const make = () => createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }, db), { fetch, background: false, now: () => clock });
    const t = make();
    const first = await t.run("sol_token_origin", { mint: MINT }, { answerId: "c1" });
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal((first.data as { creator: string }).creator, DEV);
    clock += 31_000;
    methods.length = 0;
    const again = await t.run("sol_token_origin", { mint: MINT }, { answerId: "c2" });
    assert.deepEqual([again.ok && (again.data as { creator: string }).creator, methods.sort()], [DEV, ["getTokenAccountsByOwner", "getTokenSupply"]]);
    methods.length = 0;
    const restarted = await make().run("sol_token_origin", { mint: MINT }, { answerId: "c3" });
    assert.ok(restarted.ok && (restarted.data as { creator: string; created_at: string }).created_at === new Date(T0 * 1000).toISOString(), JSON.stringify(restarted));
    assert.ok(!methods.includes("getTransactionsForAddress"), methods.join(", "));
  });

  it("a creator read whose asker gave up goes on, and the next asker gets it kept, no history bought again", async () => {
    let histories = 0;
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      let result: unknown;
      if (body.method === "getTransactionsForAddress") {
        histories++;
        // 700 ms, or until the request's own signal gives up
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 700);
          init?.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))), { once: true });
        });
        result = { data: [{ ...HISTORY[0], transaction: { signatures: [SIG], message: { accountKeys: [{ pubkey: DEV, signer: true }] } } }], paginationToken: null };
      } else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else result = { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    // the tools' timeout at its least, 500 ms: shorter than the history call
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000", TOOLS_TIMEOUT_MS: "500" }), { fetch, background: false });
    await t.run("sol_token_origin", { mint: MINT }, { answerId: "g1" });
    await new Promise((r) => setTimeout(r, 400));
    const next = await t.run("sol_token_origin", { mint: MINT }, { answerId: "g2" });
    assert.ok(next.ok && (next.data as { creator: string }).creator === DEV, JSON.stringify(next));
    assert.equal(histories, 1);
  });

  it("a launch read's first page is the creator read's first transaction: sol_token_origin beside sol_launch buys no history of its own", async () => {
    const asked: number[] = [];
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [string, Record<string, unknown>] };
      let result: unknown;
      if (body.method === "getTransactionsForAddress") {
        asked.push(Number(body.params[1].limit));
        await new Promise((r) => setTimeout(r, 20));
        result = { data: HISTORY.map((h, i) => ({ ...h, transaction: { ...h.transaction, signatures: [`${SIG.slice(0, 86)}${"ABCDEFGH"[i]}${"ABCDEFGH"[i]}`] } })), paginationToken: null };
      } else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
      else result = { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch, background: false });
    // as the chat's scan asks them: at once
    const [launch, origin] = await Promise.all([t.run("sol_launch", { mint: MINT }, { answerId: "s1" }), t.run("sol_token_origin", { mint: MINT }, { answerId: "s1:origin" })]);
    assert.ok(launch.ok && origin.ok, JSON.stringify([launch, origin]).slice(0, 300));
    assert.deepEqual([(origin.data as { creator: string }).creator, (origin.data as { creation_tx: string }).creation_tx], [DEV, `https://solscan.io/tx/${SIG.slice(0, 86)}AA`]);
    assert.deepEqual(asked, [100], "the launch's first page alone");
  });

  it("no keys: no free sol_launch; a mint with no history: not found", async () => {
    const none = createToolsWith(makeCtx({}), { fetch: async () => new Response("{}"), background: false });
    assert.equal(none.list().some((s) => s.name === "sol_launch"), false);
    const empty = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), {
      fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: [], paginationToken: null } })),
      background: false,
    });
    const r = await empty.run("sol_launch", { mint: MINT }, { answerId: "l2" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "not_found");
  });
});

/** A buy of `mint` by a wallet of its own, its own slot and signature (the read's place is told by both) */
const buyers: string[] = [];
const buy = (mint: string, n: number, at: number) => {
  const w = (buyers[n] ??= solKey(`buyer-${n}`));
  const t = tx(1000 + n, at, w, 1_000_000, { sol: 1e8 });
  const pre = [bal(w, mint, 0)];
  const post = [bal(w, mint, 1_000_000)];
  return { ...t, transaction: { signatures: [`sig-${mint.slice(0, 6)}-${n}`], message: t.transaction.message }, meta: { ...t.meta, preTokenBalances: pre, postTokenBalances: post } };
};

/**
 * A mint's history as Helius pages it: oldest first, `limit` a page, the window's filter, the rest behind a token (the
 * fake's offset); only what the chain had by the clock's second; a page asked with a token in `failing` answers 503
 */
function history(mint: string, all: ReturnType<typeof buy>[], clock: () => number, failing = new Set<string>()) {
  const asks: { blockTime: { gte: number; lt: number } | null; token: string | null; returned: number }[] = [];
  const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string, Record<string, any>] };
    let result: unknown;
    if (body.method === "getTransactionsForAddress" && body.params[0] === mint) {
      const p = body.params[1];
      const f = p.filters?.blockTime ?? null;
      const token = typeof p.paginationToken === "string" ? p.paginationToken : null;
      if (token && failing.has(token)) {
        asks.push({ blockTime: f, token, returned: -1 });
        return new Response("down", { status: 503 });
      }
      const list = all.filter((t) => t.blockTime < clock() / 1000 && (!f || (t.blockTime >= f.gte && t.blockTime < f.lt)));
      const from = token ? Number(token) : 0;
      const data = list.slice(from, from + Number(p.limit));
      asks.push({ blockTime: f, token, returned: data.length });
      result = { data, paginationToken: list.length > from + Number(p.limit) ? String(from + Number(p.limit)) : null };
    } else if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
    else result = { value: [] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  return { fetch, asks };
}

describe("a launch kept by its window", () => {
  const snipers = (r: { ok: boolean; data?: unknown }) => (r.data as { content: Record<string, unknown>[] }).content.find((x) => x.role === "sniper" && x.wallet === "all")?.wallets;
  const read = (r: { ok: boolean; data?: unknown }) => r.data as { seconds_read: number; note: string };

  it("one read after its window closed is kept until its coin is 60 days old: asked two days later, no history read", async () => {
    const coin = MINT.slice(0, 40) + "AAAA";
    let clock = (T0 + 3600) * 1000;
    const h = history(coin, [buy(coin, 0, T0), buy(coin, 1, T0 + 5), buy(coin, 2, T0 + 30)], () => clock);
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch: h.fetch, background: false, now: () => clock });
    assert.ok((await t.run("sol_launch", { mint: coin }, { answerId: "w1" })).ok);
    clock += 2 * 86_400_000;
    const again = await t.run("sol_launch", { mint: coin }, { answerId: "w2" });
    assert.deepEqual([again.ok, snipers(again), h.asks.length], [true, 2, 1], "served from the read two days before");
    clock = (T0 + 61 * 86_400) * 1000;
    assert.ok((await t.run("sol_launch", { mint: coin }, { answerId: "w3" })).ok);
    assert.equal(h.asks.length, 2, "its coin past 60 days and its read past a day: read again");
  });

  it("one read while its window was still open is short of it (its first seconds only), kept a minute, then read on from its last second, never from the start", async () => {
    const coin = MINT.slice(0, 40) + "BBBB";
    let clock = (T0 + 20) * 1000;
    // three buys in its first 10 s, two more at 30 s and 45 s: not on the chain yet at the first read
    const h = history(coin, [buy(coin, 0, T0), buy(coin, 1, T0 + 2), buy(coin, 2, T0 + 10), buy(coin, 3, T0 + 30), buy(coin, 4, T0 + 45)], () => clock);
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch: h.fetch, background: false, now: () => clock });
    const young = await t.run("sol_launch", { mint: coin }, { answerId: "o1" });
    assert.ok(young.ok, JSON.stringify(young));
    assert.equal(snipers(young), 2);
    assert.equal(read(young).seconds_read, 10, "never its whole minute");
    assert.match(read(young).note, /its first 10 s only/);
    assert.doesNotMatch(read(young).note, /there were more/);
    // its window closed (and settled): read on from its last second, the two later buys folded in
    clock = (T0 + 200) * 1000;
    const later = await t.run("sol_launch", { mint: coin }, { answerId: "o2" });
    assert.ok(later.ok, JSON.stringify(later));
    assert.deepEqual([snipers(later), read(later).seconds_read], [4, 60]);
    assert.deepEqual(h.asks.map((a) => a.blockTime), [null, { gte: T0 + 10, lt: T0 + 61 }], "the first page once, then on from its last second");
    // whole now: kept
    clock += 3 * 86_400_000;
    assert.ok((await t.run("sol_launch", { mint: coin }, { answerId: "o3" })).ok);
    assert.equal(h.asks.length, 2);
  });

  it("a page that fails keeps the pages read: the next ask goes on with its token, every transaction read once", async () => {
    const coin = MINT.slice(0, 40) + "CCCC";
    let clock = (T0 + 3600) * 1000;
    // 100 buys in its first second (the first page), then 2,500 in its minute: the window's second page fails
    const all = [...Array.from({ length: 100 }, (_, i) => buy(coin, i, T0)), ...Array.from({ length: 2500 }, (_, i) => buy(coin, 100 + i, T0 + 1 + Math.floor(i / 50)))];
    const failing = new Set(["1000"]);
    const h = history(coin, all, () => clock, failing);
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch: h.fetch, background: false, now: () => clock });
    const cut = await t.run("sol_launch", { mint: coin }, { answerId: "f1" });
    assert.ok(cut.ok, JSON.stringify(cut));
    assert.ok(read(cut).seconds_read < 60, "what was read, said short");
    failing.clear();
    clock += 61_000;
    const whole = await t.run("sol_launch", { mint: coin }, { answerId: "f2" });
    assert.ok(whole.ok, JSON.stringify(whole));
    assert.deepEqual([snipers(whole), read(whole).seconds_read], [2600 - 1, 60], "every buyer but the dev, once");
    // the window's pages start at the first page's last second (its 100 here: they are never folded twice)
    const window = h.asks.filter((a) => a.blockTime !== null);
    assert.deepEqual(window.map((a) => [a.token, a.returned]), [[null, 1000], ["1000", -1], ["1000", -1], ["1000", 1000], ["2000", 600]], "the failed page asked again, never the one before it");
  });

  it("a screen whose first page ran past its window is that window's whole read; a busy launch's screen is read on by a full ask from its first page's last second", async () => {
    const quiet = MINT.slice(0, 40) + "DDDD";
    const busy = MINT.slice(0, 40) + "EEEE";
    const clock = (T0 + 3600) * 1000;
    // the quiet coin: 150 buys over 10 minutes (its first 100 reach past its minute); the busy one: 100 in its first
    // second, 1,500 in its minute
    const q = history(quiet, Array.from({ length: 150 }, (_, i) => buy(quiet, i, T0 + i * 4)), () => clock);
    const b = history(busy, [...Array.from({ length: 100 }, (_, i) => buy(busy, i, T0)), ...Array.from({ length: 1500 }, (_, i) => buy(busy, 100 + i, T0 + 1 + Math.floor(i / 30)))], () => clock);
    const fetch = (input: string, init?: RequestInit) => (String(init?.body).includes(quiet) ? q.fetch(input, init) : b.fetch(input, init));
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }), { fetch, background: false, now: () => clock });
    assert.ok((await t.run("sol_launch", { mint: quiet, first_page: true }, { answerId: "s1" })).ok);
    const full = await t.run("sol_launch", { mint: quiet }, { answerId: "s2" });
    assert.deepEqual([full.ok, read(full).seconds_read, snipers(full), q.asks.length], [true, 60, 15, 1], "the full ask served from the screen");
    const screen = await t.run("sol_launch", { mint: busy, first_page: true }, { answerId: "s3" });
    assert.ok(screen.ok && read(screen).seconds_read === 0, JSON.stringify(screen).slice(0, 300));
    const minute = await t.run("sol_launch", { mint: busy }, { answerId: "s4" });
    assert.deepEqual([minute.ok, read(minute).seconds_read, snipers(minute)], [true, 60, 1600 - 1]);
    assert.deepEqual(b.asks.map((a) => [a.blockTime, a.token]), [[null, null], [{ gte: T0, lt: T0 + 61 }, null], [{ gte: T0, lt: T0 + 61 }, "1000"]], "its first page bought once");
  });

  it("a launch kept before the window was judged (its row from before) is served a day after its read, as then", async () => {
    const db = openDb(":memory:");
    const coin = MINT.slice(0, 40) + "FFFF";
    let clock = (T0 + 3600) * 1000;
    const h = history(coin, [buy(coin, 0, T0), buy(coin, 1, T0 + 5)], () => clock);
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }, db), { fetch: h.fetch, background: false, now: () => clock });
    // the row as the store wrote it before: no launch_at, no open
    const l = readLaunch([buy(coin, 0, T0), buy(coin, 1, T0 + 5)] as never, coin)!;
    const body = JSON.stringify({ at: clock, windowSec: 60, launch: { ...l, traders: [...l.traders.values()] }, txCount: 2, partial: false, secondsRead: 60 });
    db.prepare("INSERT INTO tools_launches (mint, window_sec, at, body) VALUES (?, ?, ?, ?)").run(coin, 60, clock, body);
    clock += 3_600_000;
    assert.ok((await t.run("sol_launch", { mint: coin }, { answerId: "b1" })).ok);
    assert.equal(h.asks.length, 0, "within its day");
    clock += 86_400_000;
    assert.ok((await t.run("sol_launch", { mint: coin }, { answerId: "b2" })).ok);
    assert.equal(h.asks.length, 1, "read again after it");
  });
});

describe("the tools' rpc pool with the launch keys", () => {
  it("the launch keys first, in turn, call after call; the shared RPC's key only when they fail", async () => {
    const { rpcEndpoints, SolanaRpc } = await import("../src/free/solana.ts");
    const eps = rpcEndpoints({ SOLANA_RPC_URLS: "https://mainnet.helius-rpc.com/?api-key=rpc-key-00000000000000000", HELIUS_LAUNCH_KEYS: "key-a-00000000000000000000,key-b-00000000000000000000,key-c-00000000000000000000" });
    assert.deepEqual(eps.map((e) => [e.url.split("api-key=")[1], e.weight]), [["key-a-00000000000000000000", 2], ["key-b-00000000000000000000", 2], ["key-c-00000000000000000000", 2], ["rpc-key-00000000000000000", 1]]);
    const pool = new SolanaRpc({} as never, eps);
    const firsts = [0, 1, 2, 3].map(() => pool.order(eps)[0]!.url.split("api-key=")[1]);
    assert.deepEqual(firsts, ["key-a-00000000000000000000", "key-b-00000000000000000000", "key-c-00000000000000000000", "key-a-00000000000000000000"]);
    // a call's third try reaches the shared RPC's key after two launch keys
    assert.deepEqual(pool.order(eps).slice(0, 3).map((e) => e.url.split("api-key=")[1]), ["key-b-00000000000000000000", "key-c-00000000000000000000", "rpc-key-00000000000000000"]);
  });

  it("a call's tries take two limiter tokens each at most on Helius (sent again only after a network failure), three elsewhere: the room a long read keeps for its calls in flight", async () => {
    const { rpcEndpoints, SolanaRpc } = await import("../src/free/solana.ts");
    const keys = "key-a-00000000000000000000,key-b-00000000000000000000";
    assert.equal(new SolanaRpc({} as never, rpcEndpoints({ SOLANA_RPC_URLS: "https://mainnet.helius-rpc.com/?api-key=rpc-key-00000000000000000", HELIUS_LAUNCH_KEYS: keys })).tokensPerCall, 3 * 2);
    assert.equal(new SolanaRpc({} as never, rpcEndpoints({ SOLANA_RPC_URLS: "https://rpc.example.org/", HELIUS_LAUNCH_KEYS: keys })).tokensPerCall, 3 * 3);
    assert.equal(new SolanaRpc({} as never, rpcEndpoints({ SOLANA_RPC_URLS: "https://rpc.example.org/" })).tokensPerCall, 3);
  });

  it("a launch key out of credits is never tried again by the pool, one resting goes last, a call that two launch keys fail is answered by the shared RPC's key", async () => {
    const KEYS = ["key-a-00000000000000000000", "key-b-00000000000000000000", "key-c-00000000000000000000"];
    const asked: string[] = [];
    const fetch = async (input: string): Promise<Response> => {
      const key = new URL(input).searchParams.get("api-key")!;
      asked.push(key);
      if (key === KEYS[0]) return new Response("max usage reached", { status: 429 });
      if (key === KEYS[1]) return new Response("slow down", { status: 429 });
      if (key === KEYS[2]) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { lamports: 1e9, owner: SYSTEM, executable: false, space: 0, data: ["", "base64"] } } }), { status: 200 });
    };
    const now = () => 1_800_000_000_000;
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: KEYS.join(","), SOLANA_RPC_URLS: "https://mainnet.helius-rpc.com/?api-key=rpc-key-00000000000000000" }), { fetch, background: false, now });
    const read = async (n: number) => {
      asked.length = 0;
      const r = await t.run("sol_account_basics", { address: solKey(`pool-${n}`) }, { answerId: `pool-${n}` });
      assert.ok(r.ok, JSON.stringify(r));
      return [...asked];
    };
    // a's 429 says it is out of credits (spent), b's 429 that it is busy (resting): the shared RPC's key answers the third try
    assert.deepEqual(await read(1), [KEYS[0], KEYS[1], "rpc-key-00000000000000000"]);
    // a is never asked again; b, resting, goes after the shared RPC's key: c (down), then the shared RPC's key
    assert.deepEqual(await read(2), [KEYS[2], "rpc-key-00000000000000000"]);
    assert.deepEqual(await read(3), [KEYS[2], "rpc-key-00000000000000000"]);
  });

  it("every answer of a launch key is booked under the key, the tool and the asker: the pool's calls, a DAS call at 10, the creator read's history call", async () => {
    const db = openDb(":memory:");
    const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      const result =
        body.method === "getAccountInfo"
          ? { value: { lamports: 1e9, owner: SYSTEM, executable: false, space: 0, data: ["", "base64"] } }
          : body.method === "getAsset"
            ? { interface: "FungibleToken", content: { metadata: { name: "Baton", symbol: "BATON" } }, token_info: { decimals: 6, supply: 1e15 } }
            : body.method === "getTransactionsForAddress"
              ? { data: [{ ...HISTORY[0], transaction: { signatures: ["sig-first"], message: { accountKeys: [{ pubkey: DEV, signer: true }] } } }], paginationToken: null }
              : body.method === "getTokenSupply"
                ? { value: { uiAmountString: "1000000000" } }
                : { value: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    };
    const t = createToolsWith(makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000" }, db), { fetch, background: false });
    assert.ok((await t.run("sol_account_basics", { address: SOL_A }, { answerId: "chat:1" })).ok);
    assert.ok((await t.run("sol_asset_card", { mint: MINT }, { answerId: "cli:1" })).ok);
    assert.ok((await t.run("sol_token_origin", { mint: MINT }, { answerId: "scan:1" })).ok);
    const spend = db.prepare("SELECT caller, tool, credits, calls FROM tools_helius_spend ORDER BY tool").all();
    // the creator read: its first transaction (10), the creator's token accounts and the supply (1 each)
    assert.deepEqual(spend, [
      { caller: "chat", tool: "sol_account_basics", credits: 1, calls: 1 },
      { caller: "cli", tool: "sol_asset_card", credits: 10, calls: 1 },
      { caller: "scan", tool: "sol_token_origin", credits: 12, calls: 3 },
    ]);
    assert.deepEqual(db.prepare("SELECT key_ix, credits FROM tools_helius_credits").all(), [{ key_ix: 0, credits: 23 }]);
  });
});

describe("the history in json encoding (plain string keys, the signers by the header)", () => {
  it("the dev, the bundle and the snipers read the same as from jsonParsed", () => {
    const asJson = (t: ReturnType<typeof tx>) => ({ ...t, transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: t.transaction.message.accountKeys.map((k: { pubkey: string }) => k.pubkey) } } });
    const l = readLaunch(HISTORY.map(asJson) as never, MINT)!;
    assert.equal(l.dev, DEV);
    assert.deepEqual(Object.fromEntries(rolesOf(l, 60)), { [DEV]: "dev", [B1]: "bundle", [S1]: "sniper", [S2]: "sniper" });
    assert.equal(l.traders.get(S1)!.paidIn, "SOL", "its SOL spent read by its key's place");
  });
});
