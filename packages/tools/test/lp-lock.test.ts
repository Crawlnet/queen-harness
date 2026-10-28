// sol_lp_lock (free/solana.ts): a coin's pools from DexScreener, a PumpSwap pool's lp mint read from the chain: none
// out (burned) or all of it in the incinerator is locked, any other holder can pull it; DLMM bins are positions; other
// pools unread.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base58Decode } from "@crawlnet/shared";
import { createToolsWith } from "../src/registry.ts";
import { PUMPSWAP_PROGRAM, pumpswapLpMint } from "../src/free/solana.ts";
import { makeCtx, solKey, tableFetch } from "./helpers.ts";

const NOW = Date.parse("2026-10-19T04:30:00Z");
const MINT = solKey("lp-coin");
const SOL = "So11111111111111111111111111111111111111112";
const POOL_A = solKey("pool-a");
const POOL_B = solKey("pool-b");
const LP_A = solKey("lp-a");
const LP_B = solKey("lp-b");
const env = { SOLANA_RPC_URLS: "https://rpc.example.org/", TOOLS_MAX_CALLS_PER_ANSWER: "20" };

/** A PumpSwap pool account as the chain has it: the base and quote mints at 43 and 75, the lp mint at 107 */
function poolData(base: string, quote: string, lp: string): string {
  const b = Buffer.alloc(301);
  Buffer.from(base58Decode(base)!).copy(b, 43);
  Buffer.from(base58Decode(quote)!).copy(b, 75);
  Buffer.from(base58Decode(lp)!).copy(b, 107);
  return b.toString("base64");
}

const pair = (dex: string, pool: string, usd: number, labels: string[] = []) => ({ chainId: "solana", dexId: dex, pairAddress: pool, labels, liquidity: { usd } });

function world(pairs: unknown[], lp: Record<string, { supply: string; holders?: { amount: string; owner: string }[] }>) {
  const accounts: Record<string, { owner: string; data: [string, string] }> = {
    [POOL_A]: { owner: PUMPSWAP_PROGRAM, data: [poolData(MINT, SOL, LP_A), "base64"] },
    // the other side's order: SOL first
    [POOL_B]: { owner: PUMPSWAP_PROGRAM, data: [poolData(SOL, MINT, LP_B), "base64"] },
  };
  const f = tableFetch({
    [`https://api.dexscreener.com/tokens/v1/solana/${MINT}`]: pairs,
    "https://rpc.example.org/": (_url: string, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      let result: unknown = null;
      if (method === "getMultipleAccounts") {
        const [keys, opts] = params as [string[], { encoding: string }];
        result = { value: keys.map((k) => (opts.encoding === "jsonParsed" ? { data: { parsed: { info: { owner: k.split(":")[1] ?? "?" } } } } : (accounts[k] ?? null))) };
      } else if (method === "getTokenSupply") result = { value: { amount: lp[String(params[0])]?.supply ?? "0", decimals: 9 } };
      else if (method === "getTokenLargestAccounts") result = { value: (lp[String(params[0])]?.holders ?? []).map((h, i) => ({ address: `acct${i}:${h.owner}`, amount: h.amount })) };
      return { jsonrpc: "2.0", id: 1, result };
    },
  });
  return createToolsWith(makeCtx(env), { background: false, fetch: f.fetch, now: () => NOW });
}

describe("sol_lp_lock: a coin's lp lock from the chain", () => {
  it("a pool account's lp mint by the coin on either side; another coin's pool none", () => {
    assert.equal(pumpswapLpMint(Buffer.from(poolData(MINT, SOL, LP_A), "base64"), MINT), LP_A);
    assert.equal(pumpswapLpMint(Buffer.from(poolData(SOL, MINT, LP_B), "base64"), MINT), LP_B);
    assert.equal(pumpswapLpMint(Buffer.from(poolData(SOL, solKey("other"), LP_B), "base64"), MINT), null);
  });

  it("pump.fun's migration pool, its lp burned (none out): locked; DLMM bins apart; a pool its creator holds the lp of: pullable", async () => {
    const t = world([pair("pumpswap", POOL_A, 73_000), pair("meteora", solKey("dlmm"), 9_000, ["DLMM"])], { [LP_A]: { supply: "0" } });
    const r = await t.run("sol_lp_lock", { mint: MINT }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown> & { pools: { lp: string }[] };
    assert.deepEqual(d.pools.map((p) => p.lp), ["burned", "dlmm"]);
    assert.deepEqual([d.lp_locked_pct_lockable, d.lp_locked_usd, d.dlmm_liquidity_usd, d.lp_unread_usd], [100, 73_000, 9_000, 0]);
    // the deployer's own pool: its lp out, held by a wallet that can pull it; a quarter in the incinerator is burned
    const held = world([pair("pumpswap", POOL_B, 52_000)], { [LP_B]: { supply: "100", holders: [{ amount: "75", owner: solKey("deployer") }, { amount: "25", owner: "1nc1nerator11111111111111111111111111111111" }] } });
    const h = await held.run("sol_lp_lock", { mint: MINT }, { answerId: "b" });
    assert.ok(h.ok, JSON.stringify(h));
    const hd = h.data as Record<string, unknown> & { pools: { lp: string; lp_burned_pct: number }[] };
    assert.deepEqual([hd.pools[0]!.lp, hd.pools[0]!.lp_burned_pct, hd.lp_locked_pct_lockable], ["held", 25, 25]);
  });

  it("a pool of another dex is unread: no share when every lockable pool is; counted against the share beside a read one", async () => {
    const t = world([pair("raydium", solKey("ray"), 40_000)], {});
    const r = await t.run("sol_lp_lock", { mint: MINT }, { answerId: "c" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([(r.data as Record<string, unknown>).lp_locked_pct_lockable, (r.data as Record<string, unknown>).lp_unread_usd], [null, 40_000]);
    const mixed = world([pair("pumpswap", POOL_A, 60_000), pair("raydium", solKey("ray"), 40_000)], { [LP_A]: { supply: "0" } });
    const m = await mixed.run("sol_lp_lock", { mint: MINT }, { answerId: "d" });
    assert.ok(m.ok, JSON.stringify(m));
    assert.equal((m.data as Record<string, unknown>).lp_locked_pct_lockable, 60, "the unread pool's 40% may be pulled");
    const none = world([], {});
    const n = await none.run("sol_lp_lock", { mint: MINT }, { answerId: "e" });
    assert.deepEqual([n.ok, !n.ok && n.error], [false, "not_found"]);
  });
});
