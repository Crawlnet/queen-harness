// The free tools a token scan stands on (packages/harness/src/scan.ts): a token's totals over all its pools (one pair's
// liquidity is never the token's), its holders by kind (wallets apart from pools and bonding curves), its creator and
// what the creator holds now, and Polymarket's open markets only (an event keeps its resolved ones beside them).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolsWith } from "../src/registry.ts";
import { metadataAddress, ORIGIN_PAGE, ORIGIN_PAGES, POOL_AUTHORITIES } from "../src/free/solana.ts";
import { deadline, shorterQuery } from "../src/free/polymarket.ts";
import { primaryUrl } from "../src/links.ts";
import { makeCtx, metadataBytes, solKey, tableFetch } from "./helpers.ts";

const NOW = Date.parse("2026-10-06T10:00:00Z");
const MINT = solKey("scan-mint");
const DEV = solKey("scan-dev");
const CURVE = solKey("scan-curve");
const SYSTEM = "11111111111111111111111111111111";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const acct = (n: number) => `Acc${String(n).padStart(2, "0")}`.padEnd(43, "1");
// wallets are keys on the curve: an address off it is a vault or a program's, whoever owns its account
const wallet = (n: number) => solKey(`wallet-${n}`);

function rpcFetch(handler: (method: string, params: unknown[]) => unknown) {
  const methods: string[] = [];
  const f = tableFetch({
    "https://rpc.example.org/": (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      methods.push(body.method);
      return { jsonrpc: "2.0", id: 1, result: handler(body.method, body.params) };
    },
  });
  return { ...f, methods };
}

const env = { SOLANA_RPC_URLS: "https://rpc.example.org/", TOOLS_MAX_CALLS_PER_ANSWER: "20" };

describe("free tools for scans (mocked fetch)", () => {
  it("token_pairs: the token's totals over every pool it trades in, not one pair's liquidity", async () => {
    const pair = (n: number, liq: number, vol: number, ageDays: number, dex = "raydium") => ({
      chainId: "solana",
      dexId: dex,
      pairAddress: `Pair${n}`.padEnd(43, "3"),
      baseToken: { address: MINT, name: "Example", symbol: "EXMPL" },
      quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
      priceUsd: "0.0012",
      liquidity: { usd: liq },
      volume: { h24: vol },
      txns: { h24: { buys: 10, sells: 4 } },
      marketCap: 1_200_000,
      fdv: 1_200_000,
      pairCreatedAt: NOW - ageDays * 86_400_000,
    });
    const f = tableFetch({ [`https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`]: [pair(1, 179_410, 900_000, 2), pair(2, 6_840_000, 400_000, 30, "orca"), pair(3, 20_000, 1_000, 1, "meteora")] });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("token_pairs", { chain: "solana", token_address: MINT, limit: 1 }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { totals: Record<string, unknown>; pairs: Record<string, unknown>[] };
    assert.equal(d.pairs.length, 1, "the rows keep the limit");
    assert.equal(d.pairs[0]!.liquidity_usd, 179_410, "the most traded pair first");
    assert.equal(d.totals.pools, 3, "the totals count every pool");
    assert.equal(d.totals.liquidity_usd, 7_039_410);
    assert.equal(d.totals.volume_24h_usd, 1_301_000);
    assert.equal(d.totals.oldest_pool_age_days, 30);
    assert.deepEqual(d.totals.txns_24h, { buys: 30, sells: 12 });
    assert.deepEqual(d.totals.dexes, ["raydium", "orca", "meteora"]);
    assert.equal(d.totals.symbol, "EXMPL");
    assert.equal(d.totals.market_cap_usd, 1_200_000, "the token's own caps, from its deepest pool");
    // a token on its launchpad's curve: no pool liquidity reported is unknown, never $0
    const curve = tableFetch({ [`https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`]: [{ ...pair(9, 0, 10_000, 0.5, "pumpfun"), liquidity: undefined }] });
    const t2 = createToolsWith(makeCtx(), { background: false, fetch: curve.fetch, now: () => NOW });
    const c = await t2.run("token_pairs", { chain: "solana", token_address: MINT }, { answerId: "a2" });
    assert.ok(c.ok, JSON.stringify(c));
    assert.equal((c.data as { totals: Record<string, unknown> }).totals.liquidity_usd, null);
  });

  it("dex_pair_lookup: each token found with its own totals, the most traded first (a copycat's deep pool with no trading after)", async () => {
    const pair = (addr: string, liq: number, vol = liq / 10) => ({ chainId: "solana", dexId: "raydium", pairAddress: `P${addr}${liq}`.slice(0, 43).padEnd(43, "4"), baseToken: { address: addr, symbol: "BONK", name: "Bonk" }, quoteToken: { symbol: "SOL" }, liquidity: { usd: liq }, volume: { h24: vol } });
    const real = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const fake = "Fake1111111111111111111111111111111111111111".slice(0, 44);
    const f = tableFetch({ "https://api.dexscreener.com/latest/dex/search?q=BONK": { pairs: [pair(fake, 50_000), pair(fake, 9_000_000, 138), pair(real, 3_000_000), pair(real, 1_000_000)] } });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("dex_pair_lookup", { query: "BONK" }, { answerId: "b" });
    assert.ok(r.ok, JSON.stringify(r));
    const tokens = (r.data as { tokens: Record<string, unknown>[] }).tokens;
    assert.deepEqual(
      tokens.map((t) => [t.address, t.pools, t.liquidity_usd]),
      [
        [real, 2, 4_000_000],
        [fake, 2, 9_050_000],
      ],
    );
  });

  it("sol_largest_accounts: holders by kind; the top 10 with and without pools and curves; one wallet's accounts together", async () => {
    // 12 accounts: #0 a bonding curve's (a program account), #1 a raydium vault (a pool authority with no account),
    // #2 and #3 one wallet's two accounts, the rest wallets
    const amounts = [400, 150, 60, 40, 30, 20, 20, 20, 10, 10, 10, 10];
    const ownerOf = (i: number) => (i === 0 ? CURVE : i === 1 ? [...POOL_AUTHORITIES][0]! : i === 3 ? wallet(2) : wallet(i));
    const { fetch, methods } = rpcFetch((method, params) => {
      if (method === "getTokenLargestAccounts") return { value: amounts.map((a, i) => ({ address: acct(i), uiAmountString: String(a) })) };
      if (method === "getTokenSupply") return { value: { uiAmountString: "1000", decimals: 6 } };
      if (method === "getMultipleAccounts") {
        const [keys, opts] = params as [string[], { encoding: string }];
        if (opts.encoding === "jsonParsed") return { value: keys.map((k) => ({ data: { parsed: { info: { owner: ownerOf(Number(k.slice(3, 5))) } } } })) };
        return { value: keys.map((k) => (k === CURVE ? { owner: PUMP } : POOL_AUTHORITIES.has(k) ? null : { owner: SYSTEM })) };
      }
      return null;
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_largest_accounts", { mint: MINT, limit: 5 }, { answerId: "c" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown> & { accounts: { holder: string; owner: string }[] };
    assert.deepEqual(methods.sort(), ["getMultipleAccounts", "getMultipleAccounts", "getTokenLargestAccounts", "getTokenSupply"], "two batched owner reads, never one call per account");
    assert.equal(d.accounts.length, 5);
    assert.deepEqual(d.accounts.slice(0, 3).map((a) => a.holder), ["program", "pool", "wallet"]);
    assert.equal(d.top10_share_pct, 76, "the top 10 accounts, pools included");
    assert.equal(d.program_accounts_share_pct, 55);
    // wallets: wallet 2 holds 60 + 40, then 30, 20, 20, 20, 10, 10, 10, 10 (ten owners at most)
    assert.equal(d.top10_wallets_share_pct, 23);
    assert.equal(d.largest_wallet_share_pct, 10);
  });

  it("sol_largest_accounts: a vault holding no SOL (no account, off the curve) counts with the wallets, never as a program's", async () => {
    // a Squads v4 multisig's first vault (a made-up multisig's): tokens only, no account of its own
    const VAULT = "CZRFxt8YAVsUGZi7ZwXrNZMEBLCeGxMHwZSe9sfYN6iR";
    const owners = [VAULT, wallet(1), wallet(2)];
    const { fetch } = rpcFetch((method, params) => {
      if (method === "getTokenLargestAccounts") return { value: [700, 50, 30].map((a, i) => ({ address: acct(i), uiAmountString: String(a) })) };
      if (method === "getTokenSupply") return { value: { uiAmountString: "1000", decimals: 6 } };
      if (method === "getMultipleAccounts") {
        const [keys, opts] = params as [string[], { encoding: string }];
        if (opts.encoding === "jsonParsed") return { value: keys.map((k) => ({ data: { parsed: { info: { owner: owners[Number(k.slice(3, 5))] } } } })) };
        return { value: keys.map((k) => (k === VAULT ? null : { owner: SYSTEM })) };
      }
      return null;
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_largest_accounts", { mint: MINT }, { answerId: "c3" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown> & { accounts: { holder: string }[] };
    assert.deepEqual(d.accounts.map((a) => a.holder), ["vault", "wallet", "wallet"]);
    // the scan's "top 10 wallets hold 78%" stands (as a program's, the 70% read as 8%)
    assert.deepEqual([d.top10_wallets_share_pct, d.largest_wallet_share_pct, d.program_accounts_share_pct], [78, 70, 0]);
  });

  it("sol_largest_accounts: owners that cannot be read leave the plain shares", async () => {
    const { fetch } = rpcFetch((method) => {
      if (method === "getTokenLargestAccounts") return { value: [{ address: acct(0), uiAmountString: "500" }] };
      if (method === "getTokenSupply") return { value: { uiAmountString: "1000", decimals: 6 } };
      throw new Error("down");
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_largest_accounts", { mint: MINT }, { answerId: "c2" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.equal(d.top10_share_pct, 50);
    assert.ok(!("top10_wallets_share_pct" in d), "no wallet share without the owners");
  });

  it("sol_token_origin: the creator is the fee payer of the mint's first transaction; what it got then and holds now", async () => {
    const first = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
    const sigs = (n: number, tail?: string) => Array.from({ length: n }, (_, i) => ({ signature: i === n - 1 && tail ? tail : `${"4".repeat(80)}${String(i).padStart(8, "0")}` }));
    let page = 0;
    const { fetch, methods } = rpcFetch((method, params) => {
      if (method === "getSignaturesForAddress") return page++ === 0 ? sigs(ORIGIN_PAGE) : sigs(321, first);
      if (method === "getTransaction") {
        assert.equal((params as string[])[0], first);
        return {
          blockTime: (NOW - 3_600_000) / 1000,
          meta: { postTokenBalances: [{ mint: MINT, owner: DEV, uiTokenAmount: { uiAmountString: "35000000" } }, { mint: MINT, owner: CURVE, uiTokenAmount: { uiAmountString: "965000000" } }] },
          transaction: { message: { accountKeys: [{ pubkey: DEV, signer: true }, { pubkey: CURVE, signer: false }] } },
        };
      }
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTokenSupply") return { value: { uiAmountString: "1000000000", decimals: 6 } };
      return null;
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_token_origin", { mint: MINT }, { answerId: "d" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown> & { creator_got_at_creation: Record<string, unknown>; creator_holds_now: Record<string, unknown> };
    assert.equal(d.found, true);
    assert.equal(d.creator, DEV);
    assert.equal(d.age_days, 0.0417, "an hour old (3 significant digits)");
    assert.deepEqual(d.creator_got_at_creation, { amount: 35_000_000, share_pct: 3.5 });
    assert.deepEqual(d.creator_holds_now, { amount: 0, share_pct: 0, token_accounts: 0 });
    assert.equal(d.transactions_read, ORIGIN_PAGE + 321);
    assert.equal(methods.filter((m) => m === "getSignaturesForAddress").length, 2);
    assert.ok(r.sources.some((s) => s.url === `https://solscan.io/tx/${first}`));
  });

  it("sol_token_origin: exactly a full page of history, then an empty page: that page's last signature is the first", async () => {
    const first = "2j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
    let page = 0;
    const { fetch } = rpcFetch((method) => {
      if (method === "getSignaturesForAddress") return page++ === 0 ? Array.from({ length: ORIGIN_PAGE }, (_, i) => ({ signature: i === ORIGIN_PAGE - 1 ? first : `${"6".repeat(80)}${String(i).padStart(8, "0")}` })) : [];
      if (method === "getTransaction") return { blockTime: (NOW - 7_200_000) / 1000, meta: { postTokenBalances: [] }, transaction: { message: { accountKeys: [{ pubkey: DEV }] } } };
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTokenSupply") return { value: { uiAmountString: "1000000000", decimals: 6 } };
      return null;
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_token_origin", { mint: MINT }, { answerId: "f" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((r.data as { found: boolean }).found, true, "not 'more than 1000 transactions'");
    assert.equal((r.data as { creator: string }).creator, DEV);
  });

  it("sol_token_origin: a history longer than it reads, and a metadata naming no one, says so (found false); no more than its pages and the metadata's one", async () => {
    const asked: unknown[] = [];
    const { fetch, methods } = rpcFetch((method, params) => {
      asked.push(params[0]);
      return method === "getSignaturesForAddress" ? Array.from({ length: ORIGIN_PAGE }, (_, i) => ({ signature: `${"3".repeat(80)}${String(i).padStart(8, "0")}` })) : null;
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_token_origin", { mint: MINT }, { answerId: "e" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((r.data as { found: boolean }).found, false);
    assert.deepEqual(methods.slice(0, ORIGIN_PAGES), Array(ORIGIN_PAGES).fill("getSignaturesForAddress"));
    assert.deepEqual(methods.slice(ORIGIN_PAGES).sort(), ["getMultipleAccounts", "getSignaturesForAddress"], "then the mint's metadata, and a page of its history");
    assert.ok(asked.includes(metadataAddress(MINT)));
  });

  it("sol_token_origin: a history too long to reach its first transaction names the creator its metadata names, and when its metadata was made", async () => {
    // a token with a long history; its metadata names its creator, verified, and its own history is 5 transactions
    const CREATOR = solKey("city-creator");
    const META = metadataAddress(MINT)!;
    const made = "3j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
    const full = Array.from({ length: ORIGIN_PAGE }, (_, i) => ({ signature: `${"5".repeat(80)}${String(i).padStart(8, "0")}` }));
    const { fetch } = rpcFetch((method, params) => {
      const [p0] = params as [unknown];
      if (method === "getSignaturesForAddress") return p0 === META ? [...Array.from({ length: 4 }, (_, i) => ({ signature: `${"7".repeat(80)}${String(i).padStart(8, "0")}` })), { signature: made }] : full;
      if (method === "getMultipleAccounts")
        return {
          value: [
            { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 9, mintAuthority: null } } } },
            { owner: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", data: [metadataBytes(CREATOR, MINT, "Example City", "EXCITY", [[CREATOR, true]]).toString("base64"), "base64"] },
          ],
        };
      if (method === "getTransaction") {
        assert.equal(p0, made);
        // the metadata made by the creator, no tokens minted in it
        return { blockTime: (NOW - 10 * 86_400_000) / 1000, meta: { postTokenBalances: [] }, transaction: { message: { accountKeys: [{ pubkey: CREATOR, signer: true }] } } };
      }
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTokenSupply") return { value: { uiAmountString: "1000000000", decimals: 9 } };
      return null;
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_token_origin", { mint: MINT }, { answerId: "m" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.deepEqual([d.found, d.creator, d.basis], [true, CREATOR, "the verified creator in its token metadata; created_at: when that metadata was made"]);
    assert.deepEqual([d.age_days, d.creation_tx, d.transactions_read], [10, `https://solscan.io/tx/${made}`, ORIGIN_PAGE * ORIGIN_PAGES]);
    assert.ok(!("creator_got_at_creation" in d), "nothing minted in the metadata's transaction: what it got is not known, never 0");
    assert.deepEqual(d.creator_holds_now, { amount: 0, share_pct: 0, token_accounts: 0 });
  });

  it("sol_token_origin: with no wallet as creator in its metadata, the payer of the metadata's first transaction made it (a launchpad's token)", async () => {
    // a launchpad's own authority verified as the creator: off the curve, no one's
    const LAUNCHPAD = [...POOL_AUTHORITIES][2]!;
    const META = metadataAddress(MINT)!;
    const made = "4j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
    const { fetch } = rpcFetch((method, params) => {
      const [p0] = params as [unknown];
      if (method === "getSignaturesForAddress") return p0 === META ? [{ signature: made }] : Array.from({ length: ORIGIN_PAGE }, (_, i) => ({ signature: `${"8".repeat(80)}${String(i).padStart(8, "0")}` }));
      if (method === "getMultipleAccounts") return { value: [{ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 6, mintAuthority: null } } } }, { owner: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", data: [metadataBytes(CURVE, MINT, "Example", "EXMPL", [[LAUNCHPAD, true]]).toString("base64"), "base64"] }] };
      if (method === "getTransaction")
        return {
          blockTime: (NOW - 3_600_000) / 1000,
          meta: { postTokenBalances: [{ mint: MINT, owner: DEV, uiTokenAmount: { uiAmountString: "35000000" } }, { mint: MINT, owner: CURVE, uiTokenAmount: { uiAmountString: "965000000" } }] },
          transaction: { message: { accountKeys: [{ pubkey: DEV, signer: true }, { pubkey: CURVE, signer: false }] } },
        };
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTokenSupply") return { value: { uiAmountString: "1000000000", decimals: 6 } };
      return null;
    });
    const tools = createToolsWith(makeCtx(env), { background: false, fetch, now: () => NOW });
    const r = await tools.run("sol_token_origin", { mint: MINT }, { answerId: "p" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.deepEqual([d.found, d.creator, d.basis], [true, DEV, "the fee payer of its token metadata's first transaction; created_at: when that metadata was made"]);
    assert.deepEqual(d.creator_got_at_creation, { amount: 35_000_000, share_pct: 3.5 });
  });

  it("sol_ticker_mint: Jupiter's search under our names, verified tokens with exactly that symbol first (the largest first); a cashtag is the ticker", async () => {
    const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const FAKE = "JUPrJXKVfakeJupiterCopy".padEnd(44, "1");
    const SMALL = "JUPsmaLLverifiedNamesake".padEnd(44, "2");
    const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
    const tok = (o: Record<string, unknown>) => ({
      decimals: 6,
      icon: "https://cdn.example/x.png",
      twitter: "https://x.com/someone",
      website: "https://evil.example",
      dev: DEV,
      audit: { mintAuthorityDisabled: true },
      stats24h: { buyVolume: 6_067_946.5, sellVolume: 6_298_796.8, numBuys: 69_252 },
      ...o,
    });
    const f = tableFetch({
      "https://lite-api.jup.ag/tokens/v2/search?query=JUP": [
        tok({ id: JUPSOL, symbol: "JupSOL", name: "Jupiter Staked SOL", isVerified: true, organicScore: 86.03, mcap: 6.29e8, tags: ["verified", "lst"] }),
        tok({ id: FAKE, symbol: "JUP", name: "Jupiter", isVerified: null, organicScore: 0, mcap: 5.694e12, liquidity: 40e6, tags: ["unknown", "token-2022"] }),
        tok({ id: SMALL, symbol: "jup", name: "Jup namesake", organicScore: 40, mcap: 2e6, tags: ["strict"] }),
        tok({ id: JUP, symbol: "JUP", name: "Jupiter", isVerified: true, organicScore: 98.96224434, mcap: 1_173_629_975.9, fdv: 2_426_016_970.5, liquidity: 5_998_709.17, usdPrice: 0.35357018, holderCount: 838_415, firstPool: { id: "2pspvjWWaf3dNgt3jsgSzFCNvMGPb7t8FrEYvLGjvcCe", createdAt: "2024-01-29T17:33:29Z" }, tags: ["moonshot-verified", "strict", "verified", "defi", "birdeye-trending", "community"] }),
        { id: "not a mint", symbol: "JUP", isVerified: true },
        "junk",
      ],
    });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    assert.ok(tools.list().some((t) => t.name === "sol_ticker_mint"));
    const r = await tools.run("sol_ticker_mint", { query: "$JUP", limit: 3 }, { answerId: "j" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(f.urls, ["https://lite-api.jup.ag/tokens/v2/search?query=JUP"], "the cashtag's \"$\" goes");
    const d = r.data as { query: string; tokens: Record<string, unknown>[] };
    assert.equal(d.query, "JUP");
    assert.deepEqual(
      d.tokens.map((t) => [t.mint, t.verified, t.exact_symbol]),
      [
        [JUP, true, true],
        [SMALL, true, true],
        [JUPSOL, true, false],
      ],
      "verified with exactly that symbol, the largest first; a strict tag is verified; the copy after the limit",
    );
    assert.deepEqual(d.tokens[0], {
      mint: JUP,
      symbol: "JUP",
      name: "Jupiter",
      verified: true,
      exact_symbol: true,
      organic_score: 99,
      price_usd: 0.35357,
      market_cap_usd: 1_173_629_976,
      fdv_usd: 2_426_016_971,
      liquidity_usd: 5_998_709,
      volume_24h_usd: 12_366_743,
      holders: 838_415,
      first_pool_at: "2024-01-29T17:33:29.000Z",
      tags: ["strict", "verified", "defi", "community"],
      link: `https://jup.ag/tokens/${JUP}`,
    });
    const s = JSON.stringify(r);
    for (const bad of ["icon", "twitter", "website", "evil.example", "audit", "moonshot", "birdeye", DEV, "numBuys", "2pspvj"]) assert.ok(!s.includes(bad), bad);
    assert.deepEqual(r.sources.map((x) => x.url), [`https://jup.ag/tokens/${JUP}`, `https://jup.ag/tokens/${SMALL}`, `https://jup.ag/tokens/${JUPSOL}`]);
    for (const x of r.sources) assert.equal(primaryUrl(x.url), x.url);
    // the same call again: from the cache
    await tools.run("sol_ticker_mint", { query: "$JUP", limit: 3 }, { answerId: "j2" });
    assert.equal(f.urls.length, 1);
  });

  it("sol_ticker_mint: nothing found, a bad answer, a busy or broken upstream; its own rate limit", async () => {
    const f = tableFetch({
      "https://lite-api.jup.ag/tokens/v2/search?query=NONE": [],
      "https://lite-api.jup.ag/tokens/v2/search?query=ODD": { error: "not a list" },
      "https://lite-api.jup.ag/tokens/v2/search?query=BUSY": new Response("slow down", { status: 429 }),
      "https://lite-api.jup.ag/tokens/v2/search?query=DOWN": new Response("oops", { status: 502 }),
      "https://lite-api.jup.ag/tokens/v2/search?query=T": [],
    });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const err = async (query: string, id: string) => {
      const r = await tools.run("sol_ticker_mint", { query }, { answerId: id });
      return r.ok ? "ok" : r.error;
    };
    assert.equal(await err("NONE", "e1"), "not_found");
    assert.equal(await err("ODD", "e2"), "unavailable");
    assert.equal(await err("BUSY", "e3"), "rate_limited");
    assert.equal(await err("DOWN", "e4"), "unavailable");
    assert.equal(await err("$", "e5"), "not_found", "a bare cashtag asks nothing");
    assert.equal(await err("https://evil.example/x", "e6"), "bad_args");
    assert.equal(f.urls.length, 4);
    // Jupiter's keyless API: 60 calls a minute at most, the next one never sent
    let sent = 0;
    for (let i = 0; i < 61; i++) if ((await err(`T${i}`, `r${i}`)) !== "rate_limited") sent++;
    assert.equal(sent, 60 - 4, "the four calls above count too");
    assert.equal(f.urls.length, 60);
  });

  it("prediction_odds: open markets only, the yes price from 0 to 1 and as a percentage, the event's page; a long question retried short", async () => {
    const event = {
      title: "When will Bitcoin hit $150k?",
      slug: "when-will-bitcoin-hit-150k",
      endDate: "2027-01-01T05:00:00Z",
      closed: false,
      volume: 27_294_748.7,
      markets: [
        { question: "Will Bitcoin hit $150k by September 30?", closed: true, active: true, outcomes: '["Yes", "No"]', outcomePrices: '["0", "1"]' },
        { question: "Will Bitcoin hit $150k by December 31, 2026?", closed: false, active: true, outcomes: '["Yes", "No"]', outcomePrices: '["0.025", "0.975"]', volume: "2865074.73", liquidity: 71221.1, endDate: "2027-01-01T05:00:00Z" },
        { question: "Will Bitcoin hit $150k by June 30, 2027?", closed: false, active: true, outcomes: '["Yes", "No"]', outcomePrices: '["0.17", "0.83"]' },
      ],
    };
    const f = tableFetch({
      "https://gamma-api.polymarket.com/public-search?q=what%20are%20the%20polymarket%20odds%20btc%20hits%20150k%20this%20year": { events: [] },
      "https://gamma-api.polymarket.com/public-search?q=btc%20150k": {
        events: [
          event,
          { title: "Old", slug: "old", closed: true, markets: [] },
          // a long shot under 1%: its price stays a price
          { title: "Who buys the most BTC?", slug: "who-buys-btc", closed: false, markets: [{ question: "Who buys the most BTC?", closed: false, active: true, outcomes: '["A", "B", "C"]', outcomePrices: '["0.62", "0.372", "0.008"]' }] },
        ],
      },
    });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("prediction_odds", { query: "what are the polymarket odds btc hits 150k this year" }, { answerId: "f" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { query: string; events: { markets: Record<string, unknown>[]; link: string; open_markets: number }[] };
    assert.equal(d.query, "btc 150k");
    assert.equal(d.events.length, 2);
    assert.equal(d.events[0]!.open_markets, 2, "the resolved market is left out");
    assert.deepEqual(d.events[0]!.markets.map((m) => m.yes_pct), [2.5, 17]);
    assert.deepEqual(d.events[0]!.markets.map((m) => m.price), [0.025, 0.17]);
    assert.deepEqual(d.events[1]!.markets[0]!.outcomes, [
      { outcome: "A", pct: 62, price: 0.62 },
      { outcome: "B", pct: 37.2, price: 0.372 },
      { outcome: "C", pct: 0.8, price: 0.008 },
    ]);
    // each market its own deadline's day in New York time, the event's volume beside its own
    const dec = d.events[0]!.markets[0]!;
    assert.deepEqual([dec.end_date, dec.ends, dec.volume_usd, dec.event_volume_usd, dec.liquidity_usd], ["2026-12-31", "dec 31 2026", 2_865_075, 27_294_749, 71_221]);
    assert.deepEqual([d.events[0]!.markets[1]!.ends, d.events[0]!.markets[1]!.event_volume_usd], [null, 27_294_749], "no end date: none made up");
    assert.equal(d.events[1]!.markets[0]!.event_volume_usd, null);
    assert.equal(d.events[0]!.link, "https://polymarket.com/event/when-will-bitcoin-hit-150k");
    assert.deepEqual(r.sources.map((s) => s.url), ["https://polymarket.com/event/when-will-bitcoin-hit-150k", "https://polymarket.com/event/who-buys-btc"]);
    const none = await tools.run("prediction_odds", { query: "btc 150k" }, { answerId: "f2" });
    assert.ok(none.ok, "the short query itself answers");
    assert.equal(shorterQuery("fed"), null, "a short query is not retried");
  });

  it("deadline: the day in New York time; an end at midnight there closes the day before, in summer time too", () => {
    assert.deepEqual(deadline("2027-01-01T05:00:00Z"), { end_date: "2026-12-31", ends: "dec 31 2026" });
    assert.deepEqual(deadline("2026-07-01T04:00:00Z"), { end_date: "2026-06-30", ends: "jun 30 2026" });
    assert.deepEqual(deadline("2026-10-15T16:00:00Z"), { end_date: "2026-10-15", ends: "oct 15 2026" });
    assert.deepEqual(deadline("2026-03-01T04:59:00Z"), { end_date: "2026-02-28", ends: "feb 28 2026" }, "11:59 pm there is still that day");
    assert.equal(deadline("soon"), null);
    assert.equal(deadline(undefined), null);
  });
});
