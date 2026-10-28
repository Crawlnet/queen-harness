// sol_holder_spread (free/solana.ts): every holder by owner over DAS getTokenAccounts, the band of 0.1-1% wallets
// (pools, vaults, programs and exchanges out), 16 of them sampled evenly by size, each one's history and the wallet
// that sent its first SOL; the fee payer alone is no funder.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolsWith } from "../src/registry.ts";
import { firstSolFrom } from "../src/free/solana.ts";
import { makeCtx, solKey, tableFetch } from "./helpers.ts";

const NOW = Date.parse("2026-10-20T09:00:00Z");
const MINT = solKey("spread-mint");
const SUPPLY = 1_000_000_000_000_000;
/** Raydium's AMM v4 authority: a pool's, off the curve */
const POOL = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const FUNDER = solKey("funder");
const RPC = "https://mainnet.helius-rpc.com/";

interface Wallet {
  owner: string;
  pct: number;
  /** its signatures: a whole history under 1000, else a full page */
  sigs: number;
  ageH: number;
  /** who sent its first SOL (null: none sent, its fees paid by a relayer) */
  from: string | null;
}

/** A first transaction: `payer` signs and pays, `from` sends the wallet SOL (or nothing) */
function firstTx(wallet: string, payer: string, from: string | null): Record<string, unknown> {
  const keys = [...new Set([payer, wallet, ...(from ? [from] : [])])];
  const pre = keys.map(() => 10_000_000_000);
  const post = keys.map((k) => (k === wallet && from ? 10_050_000_000 : k === from ? 9_950_000_000 : k === payer ? 9_999_995_000 : 10_000_000_000));
  return { meta: { err: null, preBalances: pre, postBalances: post }, transaction: { signatures: [`first-${wallet}`], message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })) } } };
}

function world(wallets: Wallet[], o: { pages?: number } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const holders = [{ owner: POOL, pct: 40 }, ...wallets.map((w) => ({ owner: w.owner, pct: w.pct }))];
  const byOwner = new Map(wallets.map((w) => [w.owner, w]));
  const f = tableFetch({
    [RPC]: (_url: string, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      calls.push({ method, params });
      let result: unknown = null;
      if (method === "getTokenSupply") result = { value: { amount: String(SUPPLY), decimals: 6 } };
      else if (method === "getTokenAccounts") {
        const page = (params as { page: number }).page;
        // a full first page when asked for more pages: the rest of the holders on the next
        const full = (o.pages ?? 1) > page;
        const rows = full ? Array.from({ length: 1000 }, (_, i) => ({ owner: solKey(`dust-${page}-${i}`), amount: "1000" })) : holders.map((h) => ({ owner: h.owner, amount: String(Math.round((h.pct / 100) * SUPPLY)) }));
        result = { total: rows.length, limit: 1000, page, token_accounts: rows.map((r, i) => ({ address: `acct-${page}-${i}`, mint: MINT, ...r })) };
      } else if (method === "getSignaturesForAddress") {
        const w = byOwner.get((params as [string])[0]);
        const n = w ? Math.min(1000, w.sigs) : 0;
        result = Array.from({ length: n }, (_, i) => ({ signature: i === n - 1 ? `first-${w!.owner}` : `sig-${w!.owner}-${i}`, slot: 1, err: null, blockTime: Math.round(NOW / 1000 - w!.ageH * 3600 * ((n - i) / n)) }));
      } else if (method === "getTransaction") {
        const sig = (params as [string])[0];
        const w = byOwner.get(sig.replace(/^first-/, ""));
        result = w ? firstTx(w.owner, w.from ?? solKey("relayer"), w.from) : null;
      }
      return { jsonrpc: "2.0", id: 1, result };
    },
  });
  const tools = createToolsWith(makeCtx({ HELIUS_API_KEYS: "k1" }), { background: false, fetch: f.fetch, now: () => NOW });
  return { tools, calls };
}

const bundle = (): Wallet[] => Array.from({ length: 70 }, (_, i) => ({ owner: solKey(`bundle-${i}`), pct: 0.4, sigs: 11, ageH: 15, from: i % 5 === 4 ? solKey(`other-${i}`) : FUNDER }));
const organic = (): Wallet[] => Array.from({ length: 70 }, (_, i) => ({ owner: solKey(`trader-${i}`), pct: 0.1 + (i % 9) * 0.1, sigs: 1000, ageH: 2000, from: null }));

describe("sol_holder_spread: a bundle spread thin past the top holders", () => {
  it("a bundle's shape: 28% in 70 wallets of 0.4%, the sample all fresh, most made by one wallet", async () => {
    const { tools } = world(bundle());
    const r = await tools.run("sol_holder_spread", { mint: MINT }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.holders, 71);
    assert.equal(d.complete, true);
    assert.deepEqual([d.band.wallets, d.band.share_pct], [70, 28]);
    assert.deepEqual([d.sample.read, d.sample.fresh], [16, 16]);
    assert.equal(d.sample.funders[0].address, FUNDER);
    assert.ok(d.sample.funders[0].wallets >= 12, JSON.stringify(d.sample.funders));
    assert.equal(d.sample.median_transactions, 11);
    assert.equal(d.wallets.length, 16);
    assert.equal(d.wallets[0].transactions, 11);
  });

  it("plain traders: old wallets with full histories, no funder read, nothing fresh", async () => {
    const { tools, calls } = world(organic());
    const r = await tools.run("sol_holder_spread", { mint: MINT }, { answerId: "b" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.band.wallets, 70);
    assert.deepEqual([d.sample.read, d.sample.fresh, d.sample.funders.length], [16, 0, 0]);
    assert.equal(d.wallets[0].transactions, "1000+");
    // a history that did not come back whole has no first transaction to read
    assert.equal(calls.filter((c) => c.method === "getTransaction").length, 0);
  });

  it("the sample spans the band by size, the largest first", async () => {
    const { tools } = world(organic());
    const r = await tools.run("sol_holder_spread", { mint: MINT }, { answerId: "c" });
    assert.ok(r.ok, JSON.stringify(r));
    const shares = (r.data as Record<string, any>).wallets.map((w: { share_pct: number }) => w.share_pct);
    assert.equal(shares[0], 0.9);
    assert.ok(shares.at(-1) <= 0.2, JSON.stringify(shares));
  });

  it("reads the next page while a page comes back full, five at most", async () => {
    const { tools, calls } = world(organic(), { pages: 3 });
    const r = await tools.run("sol_holder_spread", { mint: MINT }, { answerId: "d" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(calls.filter((c) => c.method === "getTokenAccounts").map((c) => (c.params as { page: number }).page), [1, 2, 3]);
    assert.equal((r.data as Record<string, any>).complete, true);
    const many = world(organic(), { pages: 9 });
    const m = await many.tools.run("sol_holder_spread", { mint: MINT }, { answerId: "e" });
    assert.ok(m.ok, JSON.stringify(m));
    assert.equal(many.calls.filter((c) => c.method === "getTokenAccounts").length, 5);
    assert.equal((m.data as Record<string, any>).complete, false);
  });

  it("no Helius endpoint: no such tool (DAS only)", () => {
    const tools = createToolsWith(makeCtx({ SOLANA_RPC_URLS: "https://rpc.example.org/" }), { background: false, fetch: tableFetch({}).fetch, now: () => NOW });
    assert.equal(tools.list().some((t) => t.name === "sol_holder_spread"), false);
  });
});

describe("firstSolFrom: who sent a wallet its first SOL", () => {
  it("the account whose balance fell the most while the wallet's rose; a relayer paying its fees is none", () => {
    const w = solKey("w");
    assert.equal(firstSolFrom(firstTx(w, FUNDER, FUNDER), w), FUNDER);
    // a payer apart from the sender (a bot signing for its funder's wallet)
    assert.equal(firstSolFrom(firstTx(w, solKey("payer"), FUNDER), w), FUNDER);
    assert.equal(firstSolFrom(firstTx(w, solKey("relayer"), null), w), null);
    assert.equal(firstSolFrom({}, w), null);
  });
});
