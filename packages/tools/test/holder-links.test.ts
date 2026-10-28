// sol_holder_links: a token's top holders by owner, the links between them (any asset one sent another) and their
// common funders, read from the largest wallets' transactions; pools, programs, addresses off the curve and the burn
// address never link or cluster; each transaction is read once; the read stops while the shared RPC limiter still has
// room for the other reads, and keeps the room of what the funders are. A wallet that handed this token to two holders
// is a distributor, found through the holders' token accounts; dust makes no funder; a holder's first tokens came from
// its earliest incoming transfer, whoever sent it. One classifier for every holder read: a Squads multisig's vault is a
// vault in the holder list and the holder links alike (one holding no SOL too), a known exchange's hot wallet is named
// and ties no one, and the map keeps the large holders, then the clustered ones, then the material others, 12 at most.
// Also: an account a big AMM's program owns that holds tokens is a pool, named by its AMM
// (a Meteora vault keeping a DAMM v1 pool's tokens too); a large vault's oldest transaction names its Squads multisig
// even when the read is cut, and only a transaction calling Squads is tried; vaults filled by one wallet are one
// cluster with it; the token's verified creator, else the wallet that handed out the first big allocations, is tagged;
// the largest cluster's share and the pools' are said apart.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressKind, metadataAddress, onCurve, POOL_AUTHORITIES, programAddress, squadsVault, squadsVaultIn } from "../src/free/solana.ts";
import { POOL_PROGRAMS, SQUADS_V4 } from "../src/free/labels.ts";
import { createToolsWith } from "../src/registry.ts";
import { makeCtx, metadataBytes, solKey, tableFetch } from "./helpers.ts";

const SYSTEM = "11111111111111111111111111111111";
const MINT = solKey("holder-links-mint");
const POOL = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const BURN = "1nc1nerator11111111111111111111111111111111";
const CURVE = "CurveAccount1111111111111111111111111111111";
const CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const FUNDER = solKey("funder");
const PAYER = "CurveVau1t111111111111111111111111111111111";
// program-derived addresses from made-up seeds (off the curve)
const VAULT = programAddress([Buffer.from("launchpad-vault")], CURVE_PROGRAM)!;
const MULTISIG = programAddress([Buffer.from("multisig-vault")], SQUADS_V4)!;
const SHARED = programAddress([Buffer.from("shared-authority")], CURVE_PROGRAM)!;
// two made-up Squads v4 multisigs (each the PDA of a create key solKey("example-squads-create-key-N") as Squads derives
// it) and their first vaults, both computed once with @solana/web3.js's findProgramAddressSync; in the fakes the first
// vault holds no SOL, no account at all, and the second is a System account
const SQ_MULTISIG = "J51FQbD4oxypy4u7ozva4L4BWctNFk9Yfcioipd2mJdb";
const SQ_VAULT = "CZRFxt8YAVsUGZi7ZwXrNZMEBLCeGxMHwZSe9sfYN6iR";
const SQ_MULTISIG_2 = "ASpvFVvdGexp3GZp1qjs7Zk8P4kNKuJK8HiZS53TwkN8";
const SQ_VAULT_2 = "CPviC5tAMgmKPkrLJd9RRj9Zr7x1wrRi5KRGYWnnEBVW";
const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const W = (n: number) => solKey(`wallet-${n}`);
const SUPPLY = 1_000_000_000;
const sig = (n: number) => `${n}`.repeat(88).slice(0, 88);
const T0 = 1_790_000_000;
const tb = (accountIndex: number, mint: string, owner: string, ui: number) => ({ accountIndex, mint, owner, uiTokenAmount: { uiAmountString: String(ui) } });

interface Fake {
  /** token account → [owner, share %] */
  accounts: [string, string, number][];
  /** an address (a wallet, or a token account) → its signatures, newest first */
  sigs: Record<string, { signature: string; err: unknown }[]>;
  txs: Record<string, unknown>;
  /** owner → owning program (null: no account) */
  programs: Record<string, string | null>;
  /** what each owner is cannot be read (the RPC fails that call): every time, or only for addresses outside the holders */
  kindsDown?: boolean | "funders";
  /** every transaction read fails */
  txDown?: boolean;
  /** accounts read whole (jsonParsed) by address: the mint and its metadata account */
  infos?: Record<string, unknown>;
}

/** The fake chain over the shared RPC and the launch keys' host alike (the history call only there) */
function fakeRpc(f: Fake) {
  const counts: Record<string, number> = {};
  const read: string[] = [];
  const listed: string[] = [];
  const paged: string[] = [];
  const answer = (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    counts[body.method] = (counts[body.method] ?? 0) + 1;
    const r = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });
    switch (body.method) {
      case "getTokenLargestAccounts":
        return r({ value: f.accounts.map(([address, , pct]) => ({ address, uiAmountString: String((pct / 100) * SUPPLY) })) });
      case "getTokenSupply":
        return r({ value: { uiAmountString: String(SUPPLY), decimals: 6 } });
      case "getMultipleAccounts": {
        const list = body.params[0] as string[];
        const opts = body.params[1] as { encoding: string };
        // the token accounts' owners (jsonParsed), else what each owner is
        if (opts.encoding === "jsonParsed") return r({ value: list.map((a) => f.infos?.[a] ?? { data: { parsed: { info: { owner: f.accounts.find((x) => x[0] === a)?.[1] } } } }) });
        if (f.kindsDown === true || (f.kindsDown === "funders" && list.some((o) => !f.accounts.some((a) => a[1] === o)))) return new Response("busy", { status: 503 });
        return r({ value: list.map((o) => (f.programs[o] === null ? null : { owner: f.programs[o] ?? SYSTEM })) });
      }
      case "getSignaturesForAddress":
        listed.push(String(body.params[0]));
        return r((f.sigs[String(body.params[0])] ?? []).slice(0, (body.params[1] as { limit: number }).limit));
      case "getTransaction":
        read.push(String(body.params[0]));
        if (f.txDown) return new Response("down", { status: 503 });
        return r(f.txs[String(body.params[0])] ?? null);
      case "getAccountInfo":
        return r({ value: { lamports: 1e9, owner: SYSTEM, executable: false, space: 0, data: ["", "base64"] } });
      case "getTransactionsForAddress": {
        // an address's newest successful transactions, each with its signature, as Helius pages them
        paged.push(String(body.params[0]));
        const limit = (body.params[1] as { limit: number }).limit;
        const ok = (f.sigs[String(body.params[0])] ?? []).filter((x) => x.err === null && f.txs[x.signature]).slice(0, limit);
        const data = ok.map((x) => {
          const tx = f.txs[x.signature] as { transaction: Record<string, unknown> };
          return { ...tx, transaction: { ...tx.transaction, signatures: [x.signature] } };
        });
        return r({ data, paginationToken: null });
      }
      default:
        return r(null);
    }
  };
  const t = tableFetch({ "https://rpc.example.org/": answer, "https://mainnet.helius-rpc.com/": answer });
  return { fetch: t.fetch, counts, read, listed, paged };
}

const toolsWith = (fetch: (url: string, init?: RequestInit) => Promise<Response>, now?: () => number) =>
  createToolsWith(makeCtx({ SOLANA_RPC_URLS: "https://rpc.example.org/", TOOLS_MAX_CALLS_PER_ANSWER: "5" }), { background: false, fetch, ...(now ? { now } : {}) });

const ok = (signature: string) => ({ signature, err: null });
const fees = (signer: string, t = T0) => ({ blockTime: t, meta: { err: null, fee: 5000, preBalances: [1e9], postBalances: [1e9 - 5000] }, transaction: { message: { accountKeys: [signer] } } });
/** `amount` of this token from one owner's token account (index 1) to another's existing one (`ta`, index 2), the sender signing */
const give = (t: number, from: string, to: string, ta: string, amount: number) => ({
  blockTime: t,
  meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0], postBalances: [1e9 - 5000, 0, 0], preTokenBalances: [tb(1, MINT, from, amount * 2), tb(2, MINT, to, 0)], postTokenBalances: [tb(1, MINT, from, amount), tb(2, MINT, to, amount)] },
  transaction: { message: { accountKeys: [from, `${ta}-src`, ta] } },
});
/** A Squads v4 multisig made, 0.001 SOL to its first vault: a large vault's first transaction */
const multisigCreate = (payer: string, multisig: string, vault: string) => ({
  blockTime: T0 - 600,
  meta: { err: null, fee: 5000, preBalances: [10e9, 0, 0, 1, 1], postBalances: [10e9 - 3_503_640, 2_498_640, 1_000_000, 1, 1] },
  transaction: { message: { accountKeys: [payer, multisig, vault, SQUADS_V4, SYSTEM] } },
});
/** SOL sent to an address, a deposit that names no multisig */
const tip = (from: string, to: string, t = T0) => ({ blockTime: t, meta: { err: null, fee: 5000, preBalances: [1e9, 1e6], postBalances: [0.99e9 - 5000, 1e6 + 0.01e9] }, transaction: { message: { accountKeys: [from, to] } } });
/** A mint and its Token Metadata account naming its creator, verified, as getMultipleAccounts returns them */
const madeBy = (creator: string) => ({
  [MINT]: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 6, mintAuthority: null } } } },
  [metadataAddress(MINT)!]: { owner: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", data: [metadataBytes(creator, MINT, "Example City", "EXCITY", [[creator, true]]).toString("base64"), "base64"] },
});

/** n wallets of falling shares, k transactions each (fees only): an active token, more than a read gets through */
function busyToken(n: number, k = 25): Fake {
  const big: Fake = { accounts: [], sigs: {}, txs: {}, programs: {} };
  for (let w = 1; w <= n; w++) {
    big.accounts.push([`tb${w}`, W(w), 20 - w]);
    big.sigs[W(w)] = Array.from({ length: k }, (_, j) => ok(`w${w}t${j}`));
    for (let j = 0; j < k; j++) big.txs[`w${w}t${j}`] = fees(W(w), T0 + j);
  }
  return big;
}

// a small token: a pool, a bonding curve, the burn address and six wallets; W1 holds two accounts
const SMALL: Fake = {
  accounts: [
    ["ta01", POOL, 40],
    ["ta02", W(1), 10],
    ["ta03", W(2), 8],
    ["ta04", W(3), 6],
    ["ta05", W(4), 5],
    ["ta06", W(5), 4],
    ["ta07", CURVE, 3],
    ["ta08", W(1), 2],
    ["ta09", BURN, 2],
    ["ta10", W(6), 1],
  ],
  sigs: {
    [W(1)]: [sig(1), sig(2)].map(ok),
    [W(2)]: [sig(1), sig(5)].map(ok),
    [W(3)]: [ok(sig(2))],
    [W(4)]: [ok(sig(3))],
    [W(5)]: [sig(3), sig(6)].map(ok),
    [W(6)]: [ok(sig(4)), ok(sig(6)), { signature: sig(7), err: { InstructionError: [0, "x"] } }],
  },
  txs: {
    // 1: W1 sends W2 5 SOL
    [sig(1)]: { blockTime: T0, meta: { err: null, fee: 5000, preBalances: [20e9, 1e9], postBalances: [15e9 - 5000, 6e9] }, transaction: { message: { accountKeys: [W(1), W(2)] } } },
    // 2: W1 sends W3 1,000,000 of the token (token accounts only: W3's own key is not in it)
    [sig(2)]: {
      blockTime: T0 + 60,
      meta: { err: null, fee: 5000, preBalances: [15e9, 0, 0], postBalances: [15e9 - 5000, 0, 0], preTokenBalances: [tb(1, MINT, W(1), 100_000_000), tb(2, MINT, W(3), 59_000_000)], postTokenBalances: [tb(1, MINT, W(1), 99_000_000), tb(2, MINT, W(3), 60_000_000)] },
      transaction: { message: { accountKeys: [W(1), "ta02", "ta04"] } },
    },
    // 3: the funder sends W4 and W5 2 SOL each, in one transaction
    [sig(3)]: { blockTime: T0 + 120, meta: { err: null, fee: 5000, preBalances: [10e9, 0, 0], postBalances: [6e9 - 5000, 2e9, 2e9] }, transaction: { message: { accountKeys: [FUNDER, W(4), W(5)] } } },
    // 4: and W6 1 SOL
    [sig(4)]: { blockTime: T0 + 180, meta: { err: null, fee: 5000, preBalances: [6e9, 0], postBalances: [5e9 - 5000, 1e9] }, transaction: { message: { accountKeys: [FUNDER, W(6)] } } },
    // 5: W2 buys the token from the pool with 1 SOL (wrapped SOL to the pool): no link, the pool is no funder
    [sig(5)]: {
      blockTime: T0 + 240,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [6e9, 2e9, 0, 0],
        postBalances: [5e9 - 5000, 3e9, 0, 0],
        preTokenBalances: [tb(1, "So11111111111111111111111111111111111111112", POOL, 2), tb(2, MINT, POOL, 400_000_000), tb(3, MINT, W(2), 80_000_000)],
        postTokenBalances: [tb(1, "So11111111111111111111111111111111111111112", POOL, 3), tb(2, MINT, POOL, 399_000_000), tb(3, MINT, W(2), 81_000_000)],
      },
      transaction: { message: { accountKeys: [W(2), "poolWsol1111111111111111111111111111111111", "poolTok11111111111111111111111111111111111", "ta03"] } },
    },
    // 6: a program account outside the top (a curve's vault) pays W5 and W6: no common funder
    [sig(6)]: { blockTime: T0 + 300, meta: { err: null, fee: 5000, preBalances: [9e9, 0, 2e9], postBalances: [7e9, 1e9, 3e9 - 5000] }, transaction: { message: { accountKeys: [PAYER, W(6), W(5)] } } },
  },
  programs: { [POOL]: null, [CURVE]: CURVE_PROGRAM, [PAYER]: CURVE_PROGRAM },
};

type Out = {
  connected_share_pct?: number;
  pools_share_pct?: number;
  creator?: { address: string; basis: string; link: string };
  holders: { owner: string; share_pct: number; accounts: number; kind: string; label?: string; tags?: string[]; read: boolean; cluster: number | null; note?: string; tokens_from?: { from: string; kind: string; tags?: string[]; amount: number; time: string } }[];
  holders_left_out?: { holders: number; share_pct: number };
  links: { from: string; to: string; asset: string; amount: number; count: number; first: string; last: string }[];
  funders: { funder: string; kind: string; label?: string; tags?: string[]; role: string; holders: { holder: string; sent: Record<string, number>; count: number }[]; sent: Record<string, number> }[];
  clusters: { cluster: number; holders: string[]; wallets: number; vaults?: number; share_pct: number; funders: string[] }[];
  wallets_read: number;
  transactions_read: number;
  rpc_calls: number;
  complete: boolean;
  why?: string;
};

describe("onCurve", () => {
  it("a key someone holds is on the curve; a program-derived address never is", () => {
    for (let n = 0; n < 20; n++) assert.equal(onCurve(W(n)), true, W(n));
    for (const pda of [VAULT, MULTISIG, SHARED, SQ_MULTISIG, SQ_VAULT, SQ_VAULT_2, ...POOL_AUTHORITIES]) assert.equal(onCurve(pda), false, pda);
    // the System Program's 32 zero bytes are a point (y = 0), as the chain reads it
    assert.equal(onCurve(SYSTEM), true);
    assert.equal(onCurve("not-base58"), false);
    assert.equal(onCurve("1111"), false, "not 32 bytes");
  });
});

describe("addressKind", () => {
  it("one rule for every holder read: exchange by address, off the curve a vault or a program's, on it a wallet", () => {
    assert.equal(addressKind(BINANCE, SYSTEM), "exchange");
    assert.equal(addressKind(BINANCE, undefined), "exchange", "known without a read");
    assert.equal(addressKind(MULTISIG, SYSTEM), "vault", "off the curve, holding SOL: a multisig's or a treasury's");
    assert.equal(addressKind(MULTISIG, SQUADS_V4), "vault");
    assert.equal(addressKind(VAULT, CURVE_PROGRAM), "program");
    // as a program's its 70% left the wallets' share
    assert.equal(addressKind(SQ_VAULT, null), "vault", "off the curve with no account: a vault holding no SOL");
    assert.equal(addressKind(VAULT, undefined), "program", "not read: no key all the same (a pool's state, most often)");
    assert.equal(addressKind(W(1), SYSTEM), "wallet");
    assert.equal(addressKind(W(1), null), "unknown", "a wallet with no SOL");
    assert.equal(addressKind(W(1), CURVE_PROGRAM), "program", "a program's account on the curve");
    assert.equal(addressKind(POOL, null), "pool");
    assert.equal(addressKind(BURN, SYSTEM), "burn");
  });

  it("an account a big AMM's program owns is a pool where it holds tokens, off the curve or on it", () => {
    assert.equal(Object.keys(POOL_PROGRAMS).length, 9);
    for (const program of Object.keys(POOL_PROGRAMS)) {
      const state = programAddress([Buffer.from("pool-state")], program)!;
      assert.equal(onCurve(state), false);
      assert.equal(addressKind(state, program, true), "pool", POOL_PROGRAMS[program]);
      assert.equal(addressKind(W(1), program, true), "pool", `${POOL_PROGRAMS[program]}: a pool's account made with a key`);
      assert.equal(addressKind(state, program), "program", `${POOL_PROGRAMS[program]}: a bin or tick array`);
      assert.equal(addressKind(W(1), program), "program", `${POOL_PROGRAMS[program]}: an LP's position`);
    }
    // a DAMM v1 pool's tokens sit in a Meteora vault
    assert.equal(POOL_PROGRAMS["24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi"], "Meteora vault (pool liquidity)");
    assert.equal(addressKind(programAddress([Buffer.from("curve")], CURVE_PROGRAM)!, CURVE_PROGRAM, true), "program", "any other program's account stays a program's");
  });

  it("a Squads v4 multisig's vaults are derived from it as its program derives them (pairs computed with @solana/web3.js)", () => {
    assert.equal(squadsVault(SQ_MULTISIG, 0), SQ_VAULT);
    assert.equal(squadsVault(SQ_MULTISIG_2, 0), SQ_VAULT_2);
    assert.notEqual(squadsVault(SQ_MULTISIG, 1), SQ_VAULT, "another index, another vault");
    assert.equal(squadsVault("not-base58", 0), null);
  });

  it("a transaction proves a Squads vault only when it calls Squads, and one that does not is never derived from", () => {
    const tx = (keys: string[]) => ({ transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } } });
    assert.equal(squadsVaultIn(tx([W(9), SQ_MULTISIG, SQ_VAULT, SQUADS_V4]), SQ_VAULT), true);
    assert.equal(squadsVaultIn(tx([W(9), SQ_MULTISIG, SQ_VAULT]), SQ_VAULT), false, "the multisig among its keys, Squads not called");
    assert.equal(squadsVaultIn(tx([W(9), SQ_MULTISIG_2, SQ_VAULT, SQUADS_V4]), SQ_VAULT), false, "another multisig's");
    // 70 swaps of 30 keys off the curve each (pools, tick arrays, token accounts): ~2 s when each key was tried
    const swap = tx([W(9), ...Array.from({ length: 30 }, (_, i) => programAddress([Buffer.from(`swap-key-${i}`)], CURVE_PROGRAM)!)]);
    const t = performance.now();
    for (let i = 0; i < 70; i++) assert.equal(squadsVaultIn(swap, SQ_VAULT), false);
    assert.ok(performance.now() - t < 200, `${Math.round(performance.now() - t)} ms`);
  });
});

describe("sol_holder_links", () => {
  it("holders by owner with kinds; links between holders in any asset; a common funder; clusters with their shares", async () => {
    const f = fakeRpc(SMALL);
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    const h = (o: string) => d.holders.find((x) => x.owner === o)!;
    assert.deepEqual([h(W(1)).share_pct, h(W(1)).accounts], [12, 2], "a wallet's accounts are one holder");
    assert.deepEqual([h(POOL).kind, h(CURVE).kind, h(BURN).kind, h(W(3)).kind], ["pool", "program", "burn", "wallet"]);
    assert.ok(h(CURVE).note && !h(W(3)).note);
    assert.deepEqual([h(POOL).read, h(W(1)).read, h(POOL).cluster], [false, true, null], "pools are neither read nor clustered");
    assert.equal(d.wallets_read, 6);

    const link = (from: string, to: string) => d.links.find((x) => x.from === from && x.to === to);
    assert.deepEqual([link(W(1), W(2))?.asset, link(W(1), W(2))?.amount, link(W(1), W(2))?.count], ["SOL", 5, 1]);
    assert.equal(link(W(1), W(2))?.first, new Date(T0 * 1000).toISOString());
    assert.deepEqual([link(W(1), W(3))?.asset, link(W(1), W(3))?.amount], ["this token", 1_000_000], "a token sent to a holder's token account");
    assert.ok(!d.links.some((x) => x.from === POOL || x.to === POOL), "a swap through the pool is no link");
    assert.equal(d.links.length, 2);
    assert.deepEqual(h(W(3)).tokens_from, { from: W(1), kind: "wallet", amount: 1_000_000, time: new Date((T0 + 60) * 1000).toISOString() });
    assert.deepEqual(h(W(2)).tokens_from, { from: POOL, kind: "pool", amount: 1_000_000, time: new Date((T0 + 240) * 1000).toISOString() }, "bought from the pool");
    assert.equal(h(POOL).tokens_from, undefined, "a pool's tokens came from everyone who sold into it");

    assert.equal(d.funders.length, 1, "the pool and a program account are no funders");
    assert.deepEqual([d.funders[0]!.funder, d.funders[0]!.role], [FUNDER, "funder"]);
    assert.deepEqual(d.funders[0]!.holders.map((x) => [x.holder, x.sent]), [[W(4), { SOL: 2 }], [W(5), { SOL: 2 }], [W(6), { SOL: 1 }]]);
    assert.deepEqual(d.funders[0]!.sent, { SOL: 5 });

    assert.deepEqual(
      d.clusters.map((c) => [c.cluster, c.wallets, c.share_pct, c.funders.length]),
      [
        [1, 3, 26, 0],
        [2, 3, 10, 1],
      ],
    );
    assert.deepEqual(new Set(d.clusters[0]!.holders), new Set([W(1), W(2), W(3)]));
    assert.equal(h(W(5)).cluster, 2);
    // each transaction once (1 and 3 are in two wallets' lists), the failed one never
    assert.equal(f.counts.getTransaction, 6);
    assert.equal(d.transactions_read, 6);
    assert.ok(!f.read.includes(sig(7)));
    assert.equal(d.complete, true);
    assert.ok(r.sources.some((x) => x.url.includes(MINT)));
  });

  it("the read stops while the shared RPC limiter keeps room for other reads; round-robin, so every wallet is read as deep", async () => {
    // 16 wallets, 25 transactions each: only the largest 15 are read, and not to the end
    const big = busyToken(16);
    const f = fakeRpc(big);
    const tools = toolsWith(f.fetch);
    const r = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.equal(d.complete, false);
    assert.match(d.why ?? "", /data calls/);
    assert.equal(f.listed.filter((a) => big.sigs[a]).length, 15, "the 16th wallet is not read");
    assert.ok(!f.listed.includes(W(16)) && !f.listed.includes("tb16"));
    // 240 a minute: 40 kept, and what the calls in flight could still take (3 a call on one endpoint: its hedge legs)
    const total = Object.values(f.counts).reduce((x, n) => x + n, 0);
    assert.ok(total <= 200 && total >= 175, `rpc calls: ${total}`);
    assert.equal(d.rpc_calls, total);
    // every read wallet's newest transactions first
    const depth = (w: number) => f.read.filter((s) => s.startsWith(`w${w}t`)).length;
    const depths = Array.from({ length: 15 }, (_, i) => depth(i + 1));
    assert.ok(Math.max(...depths) - Math.min(...depths) <= 1, depths.join(","));
    // the room left is still there: another read goes through
    const other = await tools.run("sol_account_basics", { address: W(1) }, { answerId: "t2" });
    assert.ok(other.ok, JSON.stringify(other));
  });

  it("a wallet that sent this token to two holders' token accounts is a distributor; each holder's first tokens are read first", async () => {
    const DIST = solKey("distributor");
    const SPAM = solKey("spammer");
    const SPAM_MINT = solKey("spam-mint");
    // the distributor's account (index 1) to a holder's existing account (index 2): the holder's own key is not in it
    const handOut = (t: number, to: string, ta: string, amount: number, left: number) => ({
      blockTime: t,
      meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0], postBalances: [1e9 - 5000, 0, 0], preTokenBalances: [tb(1, MINT, DIST, left + amount), tb(2, MINT, to, 0)], postTokenBalances: [tb(1, MINT, DIST, left), tb(2, MINT, to, amount)] },
      transaction: { message: { accountKeys: [DIST, "distTa", ta] } },
    });
    const busy = Array.from({ length: 30 }, (_, k) => `busy${k}`);
    const dist: Fake = {
      accounts: [
        ["tm01", MULTISIG, 70],
        ["td01", W(1), 10],
        ["td02", W(2), 8],
        ["td03", W(3), 5],
      ],
      sigs: {
        // a busy wallet: its first tokens are older than its newest 25 transactions
        [W(1)]: [...busy, "spam"].map(ok),
        [W(2)]: [ok("spam")],
        [W(3)]: [ok("spam")],
        tm01: [ok("d1")],
        td01: [ok("d2")],
        td02: [ok("d3")],
      },
      txs: {
        d1: handOut(T0, MULTISIG, "tm01", 700_000_000, 300_000_000),
        d2: handOut(T0 + 60, W(1), "td01", 100_000_000, 200_000_000),
        d3: handOut(T0 + 120, W(2), "td02", 80_000_000, 120_000_000),
        // a spam token dropped on every large holder at once: its sender is nobody's funder
        spam: {
          blockTime: T0 + 600,
          meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0, 0], postBalances: [1e9 - 5000, 0, 0, 0], preTokenBalances: [tb(1, SPAM_MINT, SPAM, 1000)], postTokenBalances: [tb(1, SPAM_MINT, SPAM, 700), tb(2, SPAM_MINT, W(1), 100), tb(3, SPAM_MINT, W(2), 100), tb(4, SPAM_MINT, W(3), 100)] },
          transaction: { message: { accountKeys: [SPAM, W(1), W(2), W(3)] } },
        },
        ...Object.fromEntries(busy.map((s) => [s, fees(W(1))])),
      },
      // the multisig's vault holds SOL: the System Program owns it, yet no one holds its key
      programs: {},
    };
    const f = fakeRpc(dist);
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    const h = (o: string) => d.holders.find((x) => x.owner === o)!;
    const DEPLOYER = ["handed out the first big allocations: the likely deployer"];
    assert.deepEqual(d.funders.map((x) => [x.funder, x.role, x.sent, x.tags]), [[DIST, "distributor", { "this token": 880_000_000 }, DEPLOYER]], "the spammer is no funder");
    assert.deepEqual(d.funders[0]!.holders.map((x) => [x.holder, x.sent]), [[MULTISIG, { "this token": 700_000_000 }], [W(1), { "this token": 100_000_000 }], [W(2), { "this token": 80_000_000 }]]);
    // the 70% holder is a multisig's vault: no key, never read, but its allocation ties it to the wallet that sent it
    assert.deepEqual(d.clusters.map((c) => [c.share_pct, c.wallets, c.vaults, c.funders]), [[88, 2, 1, [DIST]]]);
    assert.deepEqual([d.connected_share_pct, d.pools_share_pct], [88, 0]);
    assert.equal(h(W(3)).cluster, null);
    assert.deepEqual([h(MULTISIG).kind, h(MULTISIG).cluster, h(MULTISIG).read], ["vault", 1, false]);
    assert.match(h(MULTISIG).note ?? "", /no private key: a multisig's or a treasury's vault/);
    assert.deepEqual(h(MULTISIG).tokens_from, { from: DIST, kind: "wallet", tags: DEPLOYER, amount: 700_000_000, time: new Date(T0 * 1000).toISOString() });
    assert.equal(h(W(1)).tokens_from?.from, DIST);
    // its metadata names no creator: the wallet that handed out the first big allocations is the likely deployer
    assert.deepEqual(d.creator, { address: DIST, basis: DEPLOYER[0], link: `https://solscan.io/account/${DIST}` });
    // the first tokens are read before anything else (the vault has no history of its own here), and W1's own list is cut
    // at 25: the hand-out came from its token account
    assert.deepEqual(f.read.slice(0, 3), ["d1", "d2", "d3"]);
    assert.ok(!f.read.includes("busy29"));
    assert.equal(d.complete, true);
  });

  it("an address off the curve with no account (a launchpad's vault) never links, clusters or funds the wallets that traded with it", async () => {
    const buy = (n: number, t: number) => ({
      blockTime: t,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [3e9, 10e9, 0, 0],
        postBalances: [2e9 - 5000, 11e9, 0, 0],
        preTokenBalances: [tb(1, "So11111111111111111111111111111111111111112", VAULT, 10), tb(2, MINT, VAULT, 700_000_000), tb(3, MINT, W(n), 0)],
        postTokenBalances: [tb(1, "So11111111111111111111111111111111111111112", VAULT, 11), tb(2, MINT, VAULT, 690_000_000), tb(3, MINT, W(n), 10_000_000)],
      },
      transaction: { message: { accountKeys: [W(n), "vaultWsol", "vaultTok", `tw0${n}`] } },
    });
    // another authority off the curve paid W1 and W2 for something they sold through it
    const paid = (n: number, t: number) => ({ blockTime: t, meta: { err: null, fee: 5000, preBalances: [9e9, 1e9], postBalances: [8e9, 2e9] }, transaction: { message: { accountKeys: [SHARED, W(n)] } } });
    const launch: Fake = {
      accounts: [
        ["tv01", VAULT, 70],
        ["tw01", W(1), 5],
        ["tw02", W(2), 4],
        ["tw03", W(3), 3],
      ],
      sigs: { [W(1)]: ["b1", "p1"].map(ok), [W(2)]: ["b2", "p2"].map(ok), [W(3)]: [ok("b3")] },
      txs: { b1: buy(1, T0), b2: buy(2, T0 + 1), b3: buy(3, T0 + 2), p1: paid(1, T0 + 3), p2: paid(2, T0 + 4) },
      programs: { [VAULT]: null, [SHARED]: null },
    };
    const f = fakeRpc(launch);
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    const h = (o: string) => d.holders.find((x) => x.owner === o)!;
    assert.deepEqual([h(VAULT).kind, h(VAULT).cluster], ["vault", null]);
    assert.match(h(VAULT).note ?? "", /no private key and no SOL account/, "whose vault it is, less sure");
    assert.deepEqual([d.links, d.funders, d.clusters], [[], [], []], "no 82% cluster of a vault and its buyers");
    assert.deepEqual([h(W(1)).tokens_from?.from, h(W(1)).tokens_from?.kind], [VAULT, "vault"], "bought from the vault: no wallet's");
    assert.equal(d.complete, true);
  });

  it("when what the owners are cannot be read, the holders come back with nothing linked (complete: false)", async () => {
    const f = fakeRpc({ ...SMALL, kindsDown: true });
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.equal(d.holders.length, 9);
    assert.deepEqual([d.links, d.funders, d.clusters, d.wallets_read], [[], [], [], 0]);
    assert.equal(d.complete, false);
    assert.match(d.why ?? "", /could not be read/);
    const w1 = d.holders.find((x) => x.owner === W(1))!;
    assert.deepEqual([w1.kind, w1.note, w1.cluster], ["unknown", undefined, null]);
    assert.equal(f.counts.getSignaturesForAddress ?? 0, 0, "nothing more is read");
  });

  it("a cut read is kept a minute, a whole one ten", async () => {
    let clock = 1_800_000_000_000;
    const down = fakeRpc({ ...SMALL, kindsDown: true });
    const t1 = toolsWith(down.fetch, () => clock);
    await t1.run("sol_holder_links", { mint: MINT }, { answerId: "a" });
    clock += 30_000;
    await t1.run("sol_holder_links", { mint: MINT }, { answerId: "b" });
    assert.equal(down.counts.getTokenLargestAccounts, 1, "from the cache within the minute");
    clock += 31_000;
    await t1.run("sol_holder_links", { mint: MINT }, { answerId: "c" });
    assert.equal(down.counts.getTokenLargestAccounts, 2, "read again after it");

    const whole = fakeRpc(SMALL);
    const t2 = toolsWith(whole.fetch, () => clock);
    await t2.run("sol_holder_links", { mint: MINT }, { answerId: "d" });
    clock += 9 * 60_000;
    const again = await t2.run("sol_holder_links", { mint: MINT }, { answerId: "e" });
    assert.ok(again.ok && (again.data as Out).complete);
    assert.equal(whole.counts.getTokenLargestAccounts, 1);
  });

  it("a cut read keeps the room of what its common funders are: they are listed and clustered", async () => {
    const big = busyToken(15);
    // the funder's 2 SOL each to W1 and W2 is their newest transaction
    big.txs.fund = { blockTime: T0 + 100, meta: { err: null, fee: 5000, preBalances: [10e9, 0, 0], postBalances: [6e9 - 5000, 2e9, 2e9] }, transaction: { message: { accountKeys: [FUNDER, W(1), W(2)] } } };
    big.sigs[W(1)]!.unshift(ok("fund"));
    big.sigs[W(2)]!.unshift(ok("fund"));
    const f = fakeRpc(big);
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual([d.complete, /data calls/.test(d.why ?? "")], [false, true]);
    assert.deepEqual(d.funders.map((x) => [x.funder, x.kind, x.sent]), [[FUNDER, "wallet", { SOL: 4 }]]);
    assert.deepEqual(d.clusters.map((c) => [new Set(c.holders), c.share_pct, c.funders]), [[new Set([W(1), W(2)]), 37, [FUNDER]]]);
    assert.equal(f.counts.getMultipleAccounts, 4, "the token's metadata, the token accounts' owners, what they are, what the funder is");
  });

  it("when what the common funders are cannot be read, they are listed as unknown (complete: false)", async () => {
    const f = fakeRpc({ ...SMALL, kindsDown: "funders" });
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual(d.funders.map((x) => [x.funder, x.kind]), [[FUNDER, "unknown"]]);
    assert.equal(d.clusters.length, 2);
    assert.equal(d.complete, false);
    assert.match(d.why ?? "", /what the common funders are could not be read/);
  });

  it("a holder's first tokens came from its earliest incoming transfer, a pool's included; dust makes no funder and no origin", async () => {
    const OTHER = solKey("other");
    const DUST = solKey("duster");
    const MICRO = solKey("micro");
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    // `amount` of a mint from one owner's token account (index 1) to another's (index 2), the first key signing
    const send = (t: number, mint: string, from: string, to: string, amount: number, keys: string[]) => ({
      blockTime: t,
      meta: { err: null, fee: 5000, preBalances: keys.map(() => 1e9), postBalances: keys.map((_, i) => (i === 0 ? 1e9 - 5000 : 1e9)), preTokenBalances: [tb(1, mint, from, amount * 2), tb(2, mint, to, 0)], postTokenBalances: [tb(1, mint, from, amount), tb(2, mint, to, amount)] },
      transaction: { message: { accountKeys: keys } },
    });
    const filler = Array.from({ length: 99 }, (_, k) => `f3_${k}`);
    const first: Fake = {
      accounts: [
        ["tp01", POOL, 40],
        ["t001", W(1), 10],
        ["t002", W(2), 8],
        ["t003", W(3), 6],
      ],
      sigs: {
        [W(1)]: ["micro", "sell"].map(ok),
        [W(2)]: ["micro", "buy"].map(ok),
        t001: ["dust1", "sell"].map(ok),
        // W2's first transaction buys from the pool; later another wallet sends it some, then a duster 1 token
        t002: ["dust2", "more", "buy"].map(ok),
        // W3's account history is longer than what is read: its first tokens are out of reach
        t003: ["more3", ...filler].map(ok),
      },
      txs: {
        // W1 sells 1M into the pool: the pool's tokens did not come from W1
        sell: send(T0 + 10, MINT, W(1), POOL, 1_000_000, [W(1), "t001", "tp01"]),
        buy: send(T0, MINT, POOL, W(2), 80_000_000, [W(2), "tp01", "t002"]),
        more: send(T0 + 500, MINT, OTHER, W(2), 5_000_000, [OTHER, "otherTa", "t002"]),
        more3: send(T0 + 520, MINT, OTHER, W(3), 5_000_000, [OTHER, "otherTa", "t003"]),
        dust1: send(T0 + 600, MINT, DUST, W(1), 1, [DUST, "dustTa", "t001"]),
        dust2: send(T0 + 601, MINT, DUST, W(2), 1, [DUST, "dustTa", "t002"]),
        // a millionth of a dollar to two holders at once
        micro: {
          blockTime: T0 + 700,
          meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0, 0], postBalances: [1e9 - 5000, 0, 0, 0], preTokenBalances: [tb(1, USDC, MICRO, 1)], postTokenBalances: [tb(1, USDC, MICRO, 0.999998), tb(2, USDC, W(1), 0.000001), tb(3, USDC, W(2), 0.000001)] },
          transaction: { message: { accountKeys: [MICRO, "microTa", "w1Usdc", "w2Usdc"] } },
        },
        ...Object.fromEntries(filler.map((s) => [s, fees(W(3))])),
      },
      programs: { [POOL]: null },
    };
    const f = fakeRpc(first);
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    const h = (o: string) => d.holders.find((x) => x.owner === o)!;
    assert.equal(h(POOL).tokens_from, undefined, "a pool is not traced");
    assert.deepEqual(h(W(2)).tokens_from, { from: POOL, kind: "pool", amount: 80_000_000, time: new Date(T0 * 1000).toISOString() }, "the first buy, not a later sender");
    assert.equal(h(W(3)).tokens_from, undefined, "its first transactions were out of reach");
    assert.equal(h(W(1)).tokens_from, undefined, "1 token is dust");
    assert.deepEqual(d.funders.map((x) => [x.funder, x.role, x.sent]), [[OTHER, "distributor", { "this token": 10_000_000 }]], "no duster, no micro sender");
    assert.deepEqual(d.clusters.map((c) => [new Set(c.holders), c.share_pct]), [[new Set([W(2), W(3)]), 14]]);
    assert.equal(d.complete, true);
  });

  it("transactions that could not be read make it incomplete, kept a minute", async () => {
    let clock = 1_800_000_000_000;
    const f = fakeRpc({ ...SMALL, txDown: true });
    const tools = toolsWith(f.fetch, () => clock);
    const r = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual([d.links, d.funders, d.clusters, d.complete, d.why], [[], [], [], false, "6 of 6 transactions could not be read"]);
    clock += 61_000;
    await tools.run("sol_holder_links", { mint: MINT }, { answerId: "b" });
    assert.equal(f.counts.getTokenLargestAccounts, 2, "not from the cache");
  });

  it("a map read again reads only the transactions it never read: its holders' lists again, a new transfer alone", async () => {
    let clock = 1_800_000_000_000;
    const fake: Fake = { ...SMALL, sigs: Object.fromEntries(Object.entries(SMALL.sigs).map(([k, v]) => [k, [...v]])), txs: { ...SMALL.txs } };
    const f = fakeRpc(fake);
    const tools = toolsWith(f.fetch, () => clock);
    const first = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "a" });
    assert.ok(first.ok, JSON.stringify(first));
    const lists = f.counts.getSignaturesForAddress!;
    assert.equal(f.counts.getTransaction, 6);
    // past the map's ten minutes: its lists again, none of its transactions
    clock += 11 * 60_000;
    const again = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "b" });
    assert.ok(again.ok, JSON.stringify(again));
    assert.deepEqual([(again.data as Out).links, (again.data as Out).clusters, (again.data as Out).transactions_read], [(first.data as Out).links, (first.data as Out).clusters, 6]);
    assert.deepEqual([f.counts.getTransaction, f.counts.getSignaturesForAddress], [6, 2 * lists]);
    // W1 sends W4 1 SOL: that transaction alone is read
    fake.sigs[W(1)]!.unshift(ok(sig(8)));
    fake.txs[sig(8)] = { blockTime: T0 + 400, meta: { err: null, fee: 5000, preBalances: [10e9, 0], postBalances: [9e9 - 5000, 1e9] }, transaction: { message: { accountKeys: [W(1), W(4)] } } };
    clock += 11 * 60_000;
    const third = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "c" });
    assert.ok(third.ok, JSON.stringify(third));
    assert.equal(f.counts.getTransaction, 7);
    assert.ok((third.data as Out).links.some((l) => l.from === W(1) && l.to === W(4) && l.asset === "SOL"));
  });

  it("with the launch keys a wallet read for the first time is its newest page in one history call, its list and transactions at once: the map says what the classic read says; read again, its lists and nothing more", async () => {
    const classic = await toolsWith(fakeRpc(SMALL).fetch).run("sol_holder_links", { mint: MINT }, { answerId: "c" });
    assert.ok(classic.ok, JSON.stringify(classic));
    let clock = 1_800_000_000_000;
    const f = fakeRpc(SMALL);
    const tools = createToolsWith(makeCtx({ SOLANA_RPC_URLS: "https://rpc.example.org/", HELIUS_LAUNCH_KEYS: "key-good-0000000000000000", TOOLS_MAX_CALLS_PER_ANSWER: "5" }), { background: false, fetch: f.fetch, now: () => clock });
    const first = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "p" });
    assert.ok(first.ok, JSON.stringify(first));
    const facts = (d: Out) => ({ holders: d.holders, links: d.links, funders: d.funders, clusters: d.clusters, wallets_read: d.wallets_read, transactions_read: d.transactions_read, complete: d.complete });
    assert.deepEqual(facts(first.data as Out), facts(classic.data as Out));
    const wallets = [1, 2, 3, 4, 5, 6].map(W);
    // six wallets: a page each, none of their lists or transactions on their own
    assert.deepEqual([[...f.paged].sort(), f.counts.getTransaction ?? 0, f.listed.filter((a) => wallets.includes(a)).length], [[...wallets].sort(), 0, 0]);
    clock += 11 * 60_000;
    const again = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "q" });
    assert.ok(again.ok, JSON.stringify(again));
    assert.deepEqual(facts(again.data as Out), facts(classic.data as Out));
    assert.deepEqual([f.paged.length, f.counts.getTransaction ?? 0, f.listed.filter((a) => wallets.includes(a)).length], [6, 0, 6], "their lists, every transaction kept");
  });

  it("with the launch keys an active token's map, cut by the rpc limiter when every transaction is its own call, is whole in one read", async () => {
    const classic = await toolsWith(fakeRpc(busyToken(15)).fetch).run("sol_holder_links", { mint: MINT }, { answerId: "c" });
    assert.ok(classic.ok && !(classic.data as Out).complete, JSON.stringify(classic).slice(0, 300));
    const f = fakeRpc(busyToken(15));
    const tools = createToolsWith(makeCtx({ SOLANA_RPC_URLS: "https://rpc.example.org/", HELIUS_LAUNCH_KEYS: "key-good-0000000000000000", TOOLS_MAX_CALLS_PER_ANSWER: "5" }), { background: false, fetch: f.fetch });
    const r = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "p" });
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    const d = r.data as Out;
    assert.deepEqual([d.complete, d.wallets_read, d.transactions_read], [true, 15, 15 * 25]);
    assert.ok(d.rpc_calls <= 40 && (classic.data as Out).rpc_calls >= 175, `${d.rpc_calls} calls, ${(classic.data as Out).rpc_calls} before`);
  });

  it("a map cut at its own size is kept ten minutes; one cut while other reads held the limiter, a minute", async () => {
    let clock = 1_800_000_000_000;
    // alone: ~200 calls, as far as any read of it gets, so read again a minute later it would stop there again
    const f = fakeRpc(busyToken(15));
    const tools = toolsWith(f.fetch, () => clock);
    const r = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "a" });
    assert.ok(r.ok && !(r.data as Out).complete && (r.data as Out).rpc_calls > 150, JSON.stringify(r).slice(0, 300));
    clock += 61_000;
    await tools.run("sol_holder_links", { mint: MINT }, { answerId: "b" });
    assert.equal(f.counts.getTokenLargestAccounts, 1, "from the cache");

    // other reads hold most of the limiter: once they are done, it is read again and gets further
    const g = fakeRpc(busyToken(15));
    const t2 = toolsWith(g.fetch, () => clock);
    for (let i = 0; i < 130; i++) assert.ok((await t2.run("sol_account_basics", { address: W(100 + i) }, { answerId: `o${i}` })).ok);
    const cut = await t2.run("sol_holder_links", { mint: MINT }, { answerId: "c" });
    assert.ok(cut.ok && !(cut.data as Out).complete && (cut.data as Out).rpc_calls < 100, JSON.stringify(cut).slice(0, 300));
    clock += 61_000;
    const again = await t2.run("sol_holder_links", { mint: MINT }, { answerId: "d" });
    assert.equal(g.counts.getTokenLargestAccounts, 2);
    assert.ok(again.ok && (again.data as Out).rpc_calls > (cut.data as Out).rpc_calls * 2);
  });

  it("the holder list and the holder links say the same of every holder; a vault is named a Squads multisig's only when its multisig derives it", async () => {
    // a vault's payment: its multisig, the vault and Squads among the keys
    const pay = (multisig: string, vault: string, to: string) => ({ blockTime: T0, meta: { err: null, fee: 5000, preBalances: [5e9, 0, 0, 0, 1e9, 0, 0], postBalances: [5e9 - 5000, 0, 0, 0, 0, 0, 1e9] }, transaction: { message: { accountKeys: [W(9), multisig, "proposal", "transaction", vault, SQUADS_V4, to] } } });
    const fake: Fake = {
      accounts: [
        ["ts01", SQ_VAULT, 70],
        ["tx01", BINANCE, 10],
        ["tw01", W(1), 5],
        ["tp01", POOL, 4],
        ["tc01", CURVE, 3],
        ["tv01", VAULT, 2],
        ["tm01", MULTISIG, 1],
      ],
      sigs: {
        // the Squads vault: a deposit (its token account made), then a payment of its multisig's
        [SQ_VAULT]: [ok("sq-in"), ok("sq-pay")],
        // another multisig's vault paid this one: Squads is called, yet no key derives it
        [MULTISIG]: [ok("ms-paid")],
      },
      txs: {
        "sq-in": { blockTime: T0 + 60, meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0], postBalances: [1e9 - 2044280, 2039280, 0] }, transaction: { message: { accountKeys: [W(7), "sqVaultTa", SQ_VAULT, MINT, SYSTEM] } } },
        "sq-pay": pay(SQ_MULTISIG, SQ_VAULT, W(8)),
        "ms-paid": pay(SQ_MULTISIG_2, SQ_VAULT_2, MULTISIG),
      },
      // the Squads vault holds no SOL: no account, as on the chain
      programs: { [SQ_VAULT]: null, [POOL]: null, [CURVE]: CURVE_PROGRAM, [VAULT]: null },
    };
    const f = fakeRpc(fake);
    const tools = toolsWith(f.fetch);
    const list = await tools.run("sol_largest_accounts", { mint: MINT }, { answerId: "a" });
    const map = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "b" });
    assert.ok(list.ok && map.ok, JSON.stringify([list, map]));
    const rows = (list.data as { accounts: { owner: string; holder: string; label?: string }[] }).accounts;
    const d = map.data as Out;
    assert.deepEqual(rows.map((a) => [a.owner, a.holder]), d.holders.map((x) => [x.owner, x.kind]), "one answer from both");
    assert.deepEqual(d.holders.map((x) => x.kind), ["vault", "exchange", "wallet", "pool", "program", "vault", "vault"]);
    const h = (o: string) => d.holders.find((x) => x.owner === o)!;
    assert.deepEqual([h(SQ_VAULT).label, h(MULTISIG).label, h(BINANCE).label, rows[1]!.label], ["Squads multisig vault", undefined, "Binance hot wallet", "Binance hot wallet"]);
    assert.match(h(BINANCE).note ?? "", /exchange's hot wallet/);
    assert.match(h(MULTISIG).note ?? "", /no private key: a multisig's or a treasury's vault/);
    // the exchange is never read as a wallet; the vaults' own histories are, their newest and oldest transactions
    assert.deepEqual([h(BINANCE).read, f.listed.includes(BINANCE), f.listed.includes(SQ_VAULT), f.listed.includes(MULTISIG)], [false, false, true, true]);
    assert.deepEqual(["sq-in", "sq-pay", "ms-paid"].map((sg) => f.read.includes(sg)), [true, true, true]);
    assert.equal(d.complete, true);
  });

  it("an exchange's hot wallet that paid two holders is named and ties no one; what it is needs no read", async () => {
    const fake: Fake = {
      accounts: [
        ["tw01", W(1), 10],
        ["tw02", W(2), 8],
        ["tw03", W(3), 6],
      ],
      sigs: { [W(1)]: [ok("cex")], [W(2)]: [ok("cex")] },
      txs: { cex: { blockTime: T0, meta: { err: null, fee: 5000, preBalances: [1000e9, 0, 0], postBalances: [996e9 - 5000, 2e9, 2e9] }, transaction: { message: { accountKeys: [BINANCE, W(1), W(2)] } } } },
      programs: {},
    };
    const f = fakeRpc(fake);
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual(d.funders.map((x) => [x.funder, x.kind, x.label, x.role, x.sent]), [[BINANCE, "exchange", "Binance hot wallet", "funder", { SOL: 4 }]]);
    assert.deepEqual(d.clusters, [], "two customers of one exchange are no cluster");
    assert.equal(f.counts.getMultipleAccounts, 3, "the token's metadata, the token accounts' owners and what they are; nothing for the exchange");
    assert.equal(d.complete, true);
  });

  it("the map: the clustered holders, then the largest others of at least 0.5%, 12 in all; the rest counted", async () => {
    // W1 sent W2 and W19 1 SOL each; W3..W12 hold 1% each, W13..W20 0.1%
    const shares = [10, 8, ...Array<number>(10).fill(1), ...Array<number>(8).fill(0.1)];
    const pay = (to: string) => ({ blockTime: T0, meta: { err: null, fee: 5000, preBalances: [20e9, 1e9], postBalances: [19e9 - 5000, 2e9] }, transaction: { message: { accountKeys: [W(1), to] } } });
    const fake: Fake = { accounts: shares.map((p, i) => [`tk${i + 1}`, W(i + 1), p] as [string, string, number]), sigs: { [W(1)]: ["l2", "l19"].map(ok) }, txs: { l2: pay(W(2)), l19: pay(W(19)) }, programs: {} };
    const r = await toolsWith(fakeRpc(fake).fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual(
      d.holders.map((h) => h.owner),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 19].map(W),
      "the clustered ones (a dust one too), then the largest of 0.5% and more",
    );
    assert.deepEqual(d.holders_left_out, { holders: 8, share_pct: 1.7 });
    assert.deepEqual(d.clusters.map((c) => [new Set(c.holders), c.share_pct]), [[new Set([W(1), W(2), W(19)]), 18.1]]);
    const small = await toolsWith(fakeRpc(SMALL).fetch).run("sol_holder_links", { mint: MINT }, { answerId: "s" });
    assert.ok(small.ok && !("holders_left_out" in (small.data as Out)), "nothing left out: nothing said");
  });

  it("the map keeps the largest holders whatever they are when a bundle could fill it; a bundle past the places is counted", async () => {
    // a 40% pool, a 20% vault, then 13 wallets of 1% each, every one paid 1 SOL by one funder in one transaction
    const bundle = Array.from({ length: 13 }, (_, i) => W(i + 1));
    const fake: Fake = {
      accounts: [["tp01", POOL, 40], ["tm01", MULTISIG, 20], ...bundle.map((w, i) => [`tb${i + 1}`, w, 1] as [string, string, number])],
      sigs: Object.fromEntries(bundle.map((w) => [w, [ok("bundle")]])),
      txs: { bundle: { blockTime: T0, meta: { err: null, fee: 5000, preBalances: [20e9, ...bundle.map(() => 0)], postBalances: [7e9 - 5000, ...bundle.map(() => 1e9)] }, transaction: { message: { accountKeys: [FUNDER, ...bundle] } } } },
      programs: { [POOL]: null },
    };
    const r = await toolsWith(fakeRpc(fake).fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual(d.holders.map((h) => h.owner), [POOL, MULTISIG, ...bundle.slice(0, 10)], "the pool and the vault first, then the bundle as far as it fits");
    assert.deepEqual(d.holders_left_out, { holders: 3, share_pct: 3 }, "3 of the bundle: never the 60%");
    assert.deepEqual(d.clusters.map((c) => [c.wallets, c.share_pct, c.funders]), [[13, 13, [FUNDER]]], "the cluster itself is whole");
  });

  it("holders an exchange paid are not tied: dust it paid takes no place from holders of 1%, and an exchange that paid only those is left out", async () => {
    // W1 10%, W2..W12 1% each, W13..W15 0.1% each, each of those paid 2 SOL by an exchange's hot wallet
    const shares = [10, ...Array<number>(11).fill(1), 0.1, 0.1, 0.1];
    const dust = [W(13), W(14), W(15)];
    const fake: Fake = {
      accounts: shares.map((p, i) => [`tk${i + 1}`, W(i + 1), p] as [string, string, number]),
      sigs: Object.fromEntries(dust.map((w) => [w, [ok("cex")]])),
      txs: { cex: { blockTime: T0, meta: { err: null, fee: 5000, preBalances: [1000e9, 0, 0, 0], postBalances: [994e9 - 5000, 2e9, 2e9, 2e9] }, transaction: { message: { accountKeys: [BINANCE, ...dust] } } } },
      programs: {},
    };
    const r = await toolsWith(fakeRpc(fake).fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual(d.holders.map((h) => h.owner), Array.from({ length: 12 }, (_, i) => W(i + 1)), "every holder of 1% and more");
    assert.deepEqual(d.holders_left_out, { holders: 3, share_pct: 0.3 });
    assert.deepEqual([d.clusters, d.funders], [[], []], "no cluster, and no exchange dot with no line on it");
  });

  it("five vaults one creator filled, and DLMM pools: pools named, the 70% vault's multisig named, one cluster of the vaults, the creator tagged, the shares said", async () => {
    const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    const CREATOR = solKey("city-creator");
    // the third a Meteora vault keeping a DAMM v1 pool's tokens
    const METEORA_VAULT = "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi";
    const pools = [...[1, 2].map((n) => programAddress([Buffer.from(`lb-pair-${n}`)], DLMM)!), programAddress([Buffer.from("vault")], METEORA_VAULT)!];
    const vaults = [SQ_VAULT, MULTISIG, SHARED, VAULT, programAddress([Buffer.from("treasury")], SQUADS_V4)!];
    const shares = [70, 8, 5, 5, 4];
    const fake: Fake = {
      accounts: [...vaults.map((v, i) => [`tv${i}`, v, shares[i]!] as [string, string, number]), ["tp0", pools[0]!, 2.9], ["tp1", pools[1]!, 1], ["tp2", pools[2]!, 1]],
      sigs: {
        ...Object.fromEntries(vaults.map((_, i) => [`tv${i}`, [ok(`alloc${i}`)]])),
        // the 70% vault: a deposit, 120 more, and first its multisig's creation, past what a smaller vault's list reaches
        [SQ_VAULT]: [ok("sq-in"), ...Array.from({ length: 120 }, (_, k) => ok(`sq${k}`)), ok("sq-create")],
      },
      txs: {
        ...Object.fromEntries(vaults.map((v, i) => [`alloc${i}`, give(T0 + i * 60, CREATOR, v, `tv${i}`, (shares[i]! / 100) * SUPPLY)])),
        "sq-in": tip(W(7), SQ_VAULT),
        "sq-create": multisigCreate(W(9), SQ_MULTISIG, SQ_VAULT),
      },
      programs: { [SQ_VAULT]: null, [pools[0]!]: DLMM, [pools[1]!]: DLMM, [pools[2]!]: METEORA_VAULT },
      infos: madeBy(CREATOR),
    };
    const f = fakeRpc(fake);
    const tools = toolsWith(f.fetch);
    const r = await tools.run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    const h = (o: string) => d.holders.find((x) => x.owner === o)!;
    assert.deepEqual(d.holders.map((x) => x.kind), ["vault", "vault", "vault", "vault", "vault", "pool", "pool", "pool"]);
    const POOL_LABELS = ["Meteora DLMM pool", "Meteora DLMM pool", "Meteora vault (pool liquidity)"];
    assert.deepEqual(pools.map((p) => h(p).label), POOL_LABELS);
    assert.match(h(pools[0]!).note ?? "", /liquidity pool/);
    assert.equal(h(SQ_VAULT).label, "Squads multisig vault", "from its first transaction, 122 back");
    assert.equal(f.read[0], "sq-create", "the vault's first transaction is read before anything else");
    const CREATED = "creator of this token (verified in its metadata)";
    assert.deepEqual(d.clusters.map((c) => [c.share_pct, c.wallets, c.vaults, c.funders]), [[92, 0, 5, [CREATOR]]]);
    assert.deepEqual([d.connected_share_pct, d.pools_share_pct], [92, 4.9]);
    assert.deepEqual(d.funders.map((x) => [x.funder, x.role, x.tags]), [[CREATOR, "distributor", [CREATED, "handed out the first big allocations"]]]);
    assert.deepEqual(d.creator, { address: CREATOR, basis: CREATED, link: `https://solscan.io/account/${CREATOR}` });
    assert.deepEqual(h(SQ_VAULT).tokens_from?.tags, [CREATED, "handed out the first big allocations"]);
    assert.equal(d.complete, true);
    // the holder list says the same of the pools, and leaves them out of the wallets' share
    const list = await tools.run("sol_largest_accounts", { mint: MINT }, { answerId: "l" });
    assert.ok(list.ok, JSON.stringify(list));
    const ld = list.data as { accounts: { holder: string; label?: string }[]; program_accounts_share_pct: number };
    assert.deepEqual(ld.accounts.slice(5).map((a) => [a.holder, a.label]), POOL_LABELS.map((l) => ["pool", l]));
    assert.equal(ld.program_accounts_share_pct, 4.9);
  });

  it("a large vault's own history is read first and whole: its multisig is named from its first transaction when the read is cut", async () => {
    const big = busyToken(15);
    big.accounts.unshift(["tsq", SQ_VAULT, 70]);
    big.programs[SQ_VAULT] = null;
    big.sigs[SQ_VAULT] = [ok("sq-in"), ...Array.from({ length: 150 }, (_, k) => ok(`sq${k}`)), ok("sq-create")];
    big.txs["sq-in"] = tip(W(7), SQ_VAULT);
    big.txs["sq-create"] = multisigCreate(W(9), SQ_MULTISIG, SQ_VAULT);
    const f = fakeRpc(big);
    const r = await toolsWith(f.fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    assert.deepEqual([d.complete, /data calls/.test(d.why ?? "")], [false, true]);
    assert.equal(d.holders.find((x) => x.owner === SQ_VAULT)!.label, "Squads multisig vault");
    assert.deepEqual([f.listed[0], f.read.slice(0, 2)], [SQ_VAULT, ["sq-create", "sq-in"]], "its oldest, then its newest");
  });

  it("a vault's allocation from a top holder's wallet links them; less than 0.5% of supply ties no one", async () => {
    const fake: Fake = {
      accounts: [
        ["tm01", MULTISIG, 60],
        ["ts01", SHARED, 10],
        ["tw01", W(1), 3],
      ],
      // W1 sent the vault its 600M; another wallet sent the second vault 0.1% of supply, its first tokens all the same
      sigs: { tm01: [ok("a1")], ts01: [ok("a2")] },
      txs: { a1: give(T0, W(1), MULTISIG, "tm01", 600_000_000), a2: give(T0 + 60, W(2), SHARED, "ts01", 1_000_000) },
      programs: {},
    };
    const r = await toolsWith(fakeRpc(fake).fetch).run("sol_holder_links", { mint: MINT }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Out;
    const h = (o: string) => d.holders.find((x) => x.owner === o)!;
    assert.deepEqual(d.links.map((l) => [l.from, l.to, l.asset, l.amount]), [[W(1), MULTISIG, "this token", 600_000_000]]);
    assert.deepEqual(d.clusters.map((c) => [c.share_pct, c.wallets, c.vaults]), [[63, 1, 1]]);
    assert.deepEqual([h(SHARED).cluster, h(SHARED).tokens_from?.from, d.funders], [null, W(2), []], "where its first tokens came from is still said");
    assert.equal(d.creator, undefined, "one holder's first tokens make no deployer, and no metadata names a creator");
  });

  it("sol_account_basics says of a vault and an exchange's wallet what the holder reads say", async () => {
    const tools = toolsWith(fakeRpc(SMALL).fetch);
    const read = async (address: string) => {
      const r = await tools.run("sol_account_basics", { address }, { answerId: address });
      assert.ok(r.ok, JSON.stringify(r));
      return r.data as { kind: string; note?: string; label?: string };
    };
    const vault = await read(MULTISIG);
    assert.deepEqual([vault.kind, vault.label], ["wallet", undefined], "still a System account to the scan");
    assert.match(vault.note ?? "", /no private key: a multisig's or a treasury's vault/);
    const cex = await read(BINANCE);
    assert.deepEqual([cex.kind, cex.label, cex.note], ["wallet", "Binance hot wallet", undefined]);
    const wallet = await read(W(1));
    assert.deepEqual([wallet.note, wallet.label], [undefined, undefined]);
  });
});
