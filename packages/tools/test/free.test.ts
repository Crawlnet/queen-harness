import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolsWith } from "../src/registry.ts";
import { rpcEndpoints } from "../src/free/solana.ts";
import { primaryUrl } from "../src/links.ts";
import { makeCtx, solKey, tableFetch } from "./helpers.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const DAY_S = 86400;
const T = NOW / 1000;

const PROTOCOLS = [
  { name: "Binance CEX", slug: "binance-cex", category: "CEX", chains: ["Ethereum"], tvl: 9e10, chainTvls: { Ethereum: 9e10 }, change_1d: 1, change_7d: 2 },
  { name: "Aave V3", slug: "aave-v3", symbol: "AAVE", category: "Lending", chains: ["Ethereum", "Base"], tvl: 3e10, chainTvls: { Ethereum: 2.5e10, Base: 5e9, "Ethereum-borrowed": 1e10 }, change_1d: 0.5, change_7d: -1, description: "long text", twitter: "aave", logo: "https://icons/x" },
  { name: "Kamino Lend", slug: "kamino-lend", category: "Lending", chains: ["Solana"], tvl: 2e9, chainTvls: { Solana: 2e9 }, change_1d: 1.5, change_7d: 3 },
  { name: "Jupiter Perpetual Exchange", slug: "jupiter-perpetual-exchange", symbol: "JUP", category: "Derivatives", chains: ["Solana"], tvl: 1.5e9, chainTvls: { Solana: 1.5e9 } },
];

const JUPITER = {
  name: "Jupiter",
  symbol: "JUP",
  mcap: 1.1e9,
  currentChainTvls: { Solana: 2.1e9, "Solana-borrowed": 1e9, borrowed: 1e9 },
  tvl: Array.from({ length: 40 }, (_, i) => ({ date: T - (39 - i) * DAY_S, totalLiquidityUSD: 2e9 + i * 1e7 })),
  tokens: [{ big: "array" }],
  raises: [{ round: "x" }],
};

describe("free providers (mocked fetch)", () => {
  it("protocol_tvl: a parent slug works directly; TVL, changes, chains, history, DefiLlama link", async () => {
    const f = tableFetch({ "https://api.llama.fi/protocols": PROTOCOLS, "https://api.llama.fi/protocol/jupiter": JUPITER });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("protocol_tvl", { protocol: "Jupiter", history_days: 7 }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.equal(d.slug, "jupiter");
    assert.equal(d.tvl_usd, 2.39e9);
    assert.deepEqual(d.chains, [{ chain: "Solana", tvl_usd: 2.1e9 }]);
    assert.ok((d.history as unknown[]).length >= 7 && (d.history as unknown[]).length <= 9);
    assert.equal(d.link, "https://defillama.com/protocol/jupiter");
    assert.deepEqual(r.sources, [{ title: "DefiLlama: Jupiter", url: "https://defillama.com/protocol/jupiter" }]);
    assert.ok(!JSON.stringify(r).includes("raises") && !JSON.stringify(r).includes("tokens"));
    assert.ok(!f.urls.includes("https://api.llama.fi/protocols"), "found by its slug: the list of all protocols (9 MB) is not waited for");
  });

  it("protocol_tvl: the last point, DefiLlama's live reading beside its 00:00 UTC days, is marked now; a day's close is not", async () => {
    const midnight = Math.floor(T / DAY_S) * DAY_S;
    const days = Array.from({ length: 10 }, (_, i) => ({ date: midnight - (9 - i) * DAY_S, totalLiquidityUSD: 2e9 + i * 1e7 }));
    const history = async (tvl: unknown[]) => {
      const f = tableFetch({ "https://api.llama.fi/protocol/jupiter": { ...JUPITER, tvl } });
      const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
      const r = await tools.run("protocol_tvl", { protocol: "jupiter", history_days: 7 }, { answerId: "n" });
      assert.ok(r.ok, JSON.stringify(r));
      return (r.data as { history: { date: string; tvl_usd: number; now?: true }[] }).history;
    };
    const live = await history([...days, { date: T, totalLiquidityUSD: 2.2e9 }]);
    assert.deepEqual(live.at(-1), { date: "2026-10-04", tvl_usd: 2.2e9, now: true }, "the live reading takes its day's place");
    assert.equal(live.filter((p) => p.now).length, 1);
    const closed = await history(days);
    assert.ok(closed.every((p) => !("now" in p)), "every point a day's close");
  });

  it("protocol_tvl: a list that hangs (cold, a slow network) does not hold a protocol found by its slug", async () => {
    const f = tableFetch({ "https://api.llama.fi/protocols": () => new Promise(() => {}), "https://api.llama.fi/protocol/jupiter": JUPITER });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("protocol_tvl", { protocol: "jupiter" }, { answerId: "a", signal: AbortSignal.timeout(2000) });
    assert.ok(r.ok, JSON.stringify(r));
  });

  it("protocol_tvl: an unknown slug falls back to the protocol list (symbol / name match)", async () => {
    const f = tableFetch({
      "https://api.llama.fi/protocols": PROTOCOLS,
      "https://api.llama.fi/protocol/kamino-lend": { ...JUPITER, name: "Kamino Lend" },
      "https://api.llama.fi/protocol/kamino": new Response("Protocol is not in our database", { status: 400 }),
    });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("protocol_tvl", { protocol: "kamino" }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((r.data as { slug: string }).slug, "kamino-lend");
  });

  it("protocol_tvl: a protocol page that fails (aave-v3's runs past its cap) answers from the list, without history", async () => {
    const f = tableFetch({ "https://api.llama.fi/protocols": PROTOCOLS, "https://api.llama.fi/protocol/aave-v3": new Response("too big", { status: 500 }) });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("protocol_tvl", { protocol: "Aave V3" }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.deepEqual([d.slug, d.tvl_usd, d.change_1d_pct, d.change_7d_pct, d.history], ["aave-v3", 3e10, 0.5, -1, []]);
    assert.deepEqual(d.chains, [{ chain: "Ethereum", tvl_usd: 2.5e10 }, { chain: "Base", tvl_usd: 5e9 }], "borrowed is no chain");
    assert.deepEqual(r.sources, [{ title: "DefiLlama: Aave V3", url: "https://defillama.com/protocol/aave-v3" }]);
    // not in the list either: the page's own error
    const none = await tools.run("protocol_tvl", { protocol: "nowhere-fi" }, { answerId: "b" });
    assert.equal(none.ok, false);
  });

  it("top_protocols: CEXes left out, chain filter uses that chain's TVL", async () => {
    const f = tableFetch({ "https://api.llama.fi/protocols": PROTOCOLS });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const all = await tools.run("top_protocols", {}, { answerId: "a" });
    assert.ok(all.ok);
    assert.deepEqual((all.data as { protocols: { name: string }[] }).protocols.map((p) => p.name), ["Aave V3", "Kamino Lend", "Jupiter Perpetual Exchange"]);
    const base = await tools.run("top_protocols", { chain: "base" }, { answerId: "a" });
    assert.ok(base.ok);
    assert.deepEqual((base.data as { protocols: { name: string; tvl_usd: number }[] }).protocols.map((p) => [p.name, p.tvl_usd]), [["Aave V3", 5e9]]);
  });

  it("yield_pools: filters, sort by APY without outliers, pool links", async () => {
    const pool = (o: Record<string, unknown>) => ({ chain: "Ethereum", project: "aave-v3", symbol: "USDC", tvlUsd: 5e8, apy: 4, apyBase: 4, apyReward: null, pool: "747c1d2a-c668-4682-b9f9-296708a3dd90", stablecoin: true, outlier: false, predictions: { x: 1 }, ...o });
    const f = tableFetch({
      "https://yields.llama.fi/pools": {
        status: "success",
        data: [pool({}), pool({ apy: 900, outlier: true, pool: "aaaaaaaa-0000-0000-0000-000000000001" }), pool({ apy: 7, tvlUsd: 2e6, pool: "aaaaaaaa-0000-0000-0000-000000000002" }), pool({ chain: "Solana", apy: 12, pool: "aaaaaaaa-0000-0000-0000-000000000003" }), pool({ apy: 30, tvlUsd: 1000, pool: "aaaaaaaa-0000-0000-0000-000000000004" })],
      },
    });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("yield_pools", { chain: "ethereum", symbol: "usdc" }, { answerId: "y" });
    assert.ok(r.ok, JSON.stringify(r));
    const pools = (r.data as { pools: Record<string, unknown>[] }).pools;
    assert.deepEqual(pools.map((p) => p.apy_pct), [7, 4]);
    assert.equal(pools[0]!.link, "https://defillama.com/yields/pool/aaaaaaaa-0000-0000-0000-000000000002");
    assert.ok(!JSON.stringify(r).includes("predictions"));
  });

  it("protocol_fees_revenue: one protocol's fees and revenue (two requests); the ranking from the overview", async () => {
    const sum = (k: number) => ({ name: "Uniswap", displayName: "Uniswap", total24h: 1e6 * k, total7d: 7e6 * k, total30d: 3e7 * k, total1y: 3e8 * k, totalAllTime: 6e9 * k, change_1d: -5, chainBreakdown: { big: 1 } });
    const f = tableFetch({
      "https://api.llama.fi/summary/fees/uniswap?dataType=dailyFees": sum(1),
      "https://api.llama.fi/summary/fees/uniswap?dataType=dailyRevenue": sum(0.2),
      "https://api.llama.fi/overview/fees?": { total24h: 5e7, total7d: 3e8, total30d: 1e9, protocols: [{ name: "A", displayName: "A", slug: "a", total24h: 10, total7d: 70, total30d: 300, change_1d: 1 }, { name: "B", slug: "b", total24h: 20 }] },
    });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const one = await tools.run("protocol_fees_revenue", { protocol: "Uniswap" }, { answerId: "f" });
    assert.ok(one.ok, JSON.stringify(one));
    const d = one.data as Record<string, Record<string, number>>;
    assert.equal(d.fees!["24h_usd"], 1e6);
    assert.equal(d.revenue!["24h_usd"], 2e5);
    const rank = await tools.run("protocol_fees_revenue", {}, { answerId: "f" });
    assert.ok(rank.ok);
    assert.deepEqual((rank.data as { protocols: { name: string }[] }).protocols.map((p) => p.name), ["B", "A"]);
  });

  it("dex_pair_lookup: deepest pairs first, chain filter, our fields only, DEX Screener link", async () => {
    const pair = (o: Record<string, unknown>) => ({
      chainId: "solana",
      dexId: "orca",
      url: "https://dexscreener.com/solana/c1mglojnlwbkadvu9bhdtgzz1ozx4dz5zgdgcgvvw8wz",
      pairAddress: "C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz",
      labels: ["CLMM"],
      baseToken: { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", name: "Jupiter", symbol: "JUP" },
      quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
      priceNative: "0.002701",
      priceUsd: "0.3277",
      txns: { h24: { buys: 10, sells: 11 } },
      volume: { h24: 2926171.77, h1: 5 },
      priceChange: { h1: -0.6, h24: 2.37 },
      liquidity: { usd: 862611.31 },
      fdv: 2293985129,
      marketCap: 1087801003,
      pairCreatedAt: NOW - 10 * 86_400_000,
      info: { imageUrl: "https://cdn/x.png", socials: [{ url: "https://twitter.com/x" }] },
      ...o,
    });
    const f = tableFetch({ "https://api.dexscreener.com/latest/dex/search?q=JUP": { schemaVersion: "1", pairs: [pair({ liquidity: { usd: 5 }, pairAddress: "Small1111111111111111111111111111111111111", url: "https://evil.example/x" }), pair({}), pair({ chainId: "base", pairAddress: "0x" + "1".repeat(40), url: undefined })] } });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("dex_pair_lookup", { query: "JUP", chain: "solana" }, { answerId: "d" });
    assert.ok(r.ok, JSON.stringify(r));
    const pairs = (r.data as { pairs: Record<string, unknown>[] }).pairs;
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0]!.liquidity_usd, 862611);
    assert.equal(pairs[0]!.pair_age_days, 10);
    assert.equal(pairs[1]!.link, "https://dexscreener.com/solana/small1111111111111111111111111111111111111", "a non-primary URL is rebuilt by us");
    const s = JSON.stringify(r);
    for (const bad of ["labels", "imageUrl", "socials", "evil.example"]) assert.ok(!s.includes(bad), bad);
  });

  it("fresh_pools: GeckoTerminal new pools with age and links", async () => {
    const pool = solKey("fresh-pool");
    const base = solKey("fresh-pool-coin");
    const f = tableFetch({
      "https://api.geckoterminal.com/api/v2/networks/solana/new_pools": {
        data: [
          {
            id: `solana_${pool}`,
            type: "pool",
            attributes: { base_token_price_usd: "0.0000034", address: pool, name: "EXMPL / SOL", pool_created_at: "2026-10-04T11:00:00Z", fdv_usd: "3402.76", reserve_in_usd: null, volume_usd: { h1: "9.6", h24: "9.6" }, price_change_percentage: { h1: "0", h24: "0" }, transactions: { h24: { buys: 1, sells: 0, buyers: 1, sellers: 0 } } },
            relationships: { base_token: { data: { id: `solana_${base}` } }, quote_token: { data: { id: "solana_So11111111111111111111111111111111111111112" } }, dex: { data: { id: "pump-fun" } } },
          },
        ],
      },
    });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("fresh_pools", {}, { answerId: "g" });
    assert.ok(r.ok, JSON.stringify(r));
    const p = (r.data as { pools: Record<string, unknown>[] }).pools[0]!;
    assert.equal(p.age_hours, 1);
    assert.equal(p.base_token, base);
    assert.equal(p.dex, "pump-fun");
    assert.equal(p.link, `https://www.geckoterminal.com/solana/pools/${pool}`);
  });

  it("Solana RPC: a mint's authorities and supply; endpoints from env, never in the output", async () => {
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const seen: string[] = [];
    const f = tableFetch({
      "https://mainnet.helius-rpc.com/": (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        seen.push(body.method);
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 1 },
            value: { lamports: 1461600, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false, space: 82, data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6, supply: "9000000000000000", mintAuthority: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG", freezeAuthority: null, isInitialized: true } } } },
          },
        };
      },
    });
    const ctx = makeCtx({ HELIUS_API_KEYS: "secretkey123@2" });
    const tools = createToolsWith(ctx, { background: false, fetch: f.fetch, now: () => NOW });
    assert.ok(tools.list().some((t) => t.name === "sol_asset_card"), "DAS tool with a Helius key");
    const r = await tools.run("sol_account_basics", { address: mint }, { answerId: "s" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { kind: string; mint: Record<string, unknown>; link: string };
    assert.equal(d.kind, "token_mint");
    assert.equal(d.mint.supply, 9e9);
    assert.equal(d.mint.freeze_authority, "none");
    assert.equal(d.link, `https://solscan.io/token/${mint}`);
    assert.deepEqual(seen, ["getAccountInfo"]);
    assert.ok(!JSON.stringify([r, ctx.logs]).includes("secretkey123"));
  });

  it("Solana RPC: no account is a wallet in use when it has signatures, else nothing", async () => {
    const wallet = solKey("zero-sol-wallet");
    let signatures: unknown[] = [{ signature: "5sig", blockTime: 1792350000, err: null }];
    const f = tableFetch({
      "https://mainnet.helius-rpc.com/": (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        return { jsonrpc: "2.0", id: 1, result: body.method === "getAccountInfo" ? { context: { slot: 1 }, value: null } : signatures };
      },
    });
    const tools = createToolsWith(makeCtx({ HELIUS_API_KEYS: "secretkey123@2" }), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("sol_account_basics", { address: wallet }, { answerId: "w1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.deepEqual([d.exists, d.kind, d.sol, d.in_use, d.last_tx_utc], [false, "wallet", 0, true, "2026-10-18T19:00:00Z"]);
    signatures = [];
    const unused = solKey("unused-address");
    const none = await tools.run("sol_account_basics", { address: unused }, { answerId: "w2" });
    assert.ok(none.ok);
    assert.deepEqual(none.data, { address: unused, exists: false, link: `https://solscan.io/account/${unused}` });
  });

  it("Solana RPC: a token-2022 mint's extensions from the chain: metadata only is no fee and no hook; a fee with its percent, a hook, a permanent delegate", async () => {
    const mint = solKey("t22-metadata-mint");
    let extensions: unknown[] = [{ extension: "metadataPointer", state: {} }, { extension: "tokenMetadata", state: { name: "Example", symbol: "EXMPL" } }];
    const f = tableFetch({
      "https://mainnet.helius-rpc.com/": () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { context: { slot: 1 }, value: { lamports: 1, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", executable: false, space: 400, data: { program: "spl-token-2022", parsed: { type: "mint", info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null, isInitialized: true, extensions } } } } },
      }),
    });
    const tools = createToolsWith(makeCtx({ HELIUS_API_KEYS: "k@1" }), { background: false, fetch: f.fetch, now: () => NOW });
    // each case its own mint: a result is cached by its arguments
    const mintOf = async (address: string) => ((await tools.run("sol_account_basics", { address }, { answerId: "e" })) as { data: { mint: Record<string, unknown> } }).data.mint;
    const plain = await mintOf(mint);
    assert.deepEqual([plain.token_2022, plain.extensions, plain.transfer_fee, plain.transfer_hook, plain.permanent_delegate], [true, ["metadataPointer", "tokenMetadata"], false, false, false]);
    extensions = [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 150 }, olderTransferFee: { transferFeeBasisPoints: 0 } } }, { extension: "transferHook", state: {} }, { extension: "permanentDelegate", state: {} }];
    const set = await mintOf(solKey("t22-fee-hook-mint"));
    assert.deepEqual([set.transfer_fee, set.transfer_fee_pct, set.transfer_hook, set.permanent_delegate], [true, 1.5, true, true]);
  });

  it("Solana RPC: a transaction's balance changes; a missing one is not_found", async () => {
    const sig = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
    const a = solKey("tx-signer");
    const b = solKey("tx-receiver");
    let missing = false;
    const f = tableFetch({
      "https://rpc.example.org/": () =>
        missing
          ? { jsonrpc: "2.0", id: 1, result: null }
          : {
              jsonrpc: "2.0",
              id: 1,
              result: {
                slot: 5,
                blockTime: T,
                meta: { err: null, fee: 5000, preBalances: [2e9, 0], postBalances: [1e9 - 5000, 1e9], preTokenBalances: [{ accountIndex: 1, mint: "So11111111111111111111111111111111111111112", owner: b, uiTokenAmount: { uiAmountString: "1" } }], postTokenBalances: [{ accountIndex: 1, mint: "So11111111111111111111111111111111111111112", owner: b, uiTokenAmount: { uiAmountString: "3.5" } }], logMessages: ["Program log: secret stuff"] },
                transaction: { message: { accountKeys: [{ pubkey: a, signer: true }, { pubkey: b, signer: false }], instructions: [{ programId: "11111111111111111111111111111111" }] } },
              },
            },
    });
    const tools = createToolsWith(makeCtx({ SOLANA_RPC_URLS: "https://rpc.example.org/?key=abc", TOOLS_MAX_CALLS_PER_ANSWER: "5" }), { background: false, fetch: f.fetch, now: () => NOW });
    assert.ok(!tools.list().some((t) => t.name === "sol_asset_card"), "no DAS without Helius");
    const r = await tools.run("sol_balance_changes", { signature: sig }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.equal(d.fee_sol, 0.000005);
    assert.deepEqual(d.signers, [a]);
    assert.deepEqual(d.token_changes, [{ owner: b, mint: "So11111111111111111111111111111111111111112", delta: 2.5 }]);
    assert.ok(!JSON.stringify(r).includes("secret stuff"));
    missing = true;
    const other = "4" + sig.slice(1);
    const nf = await tools.run("sol_balance_changes", { signature: other }, { answerId: "t" });
    assert.equal(!nf.ok && nf.error, "not_found");
  });

  it("Solana RPC: an endpoint's own error (overloaded) tries the next endpoint; invalid params do not", async () => {
    const sig = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
    const a = solKey("tx-signer");
    let firstError = { code: -32603, message: "account index service overloaded, please try again." };
    const f = tableFetch({
      "https://rpc1.example.org/": () => ({ jsonrpc: "2.0", id: 1, error: firstError }),
      "https://rpc2.example.org/": () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { slot: 5, blockTime: T, meta: { err: null, fee: 5000, preBalances: [2e9], postBalances: [2e9 - 5000] }, transaction: { message: { accountKeys: [{ pubkey: a, signer: true }], instructions: [] } } },
      }),
    });
    const tools = createToolsWith(makeCtx({ SOLANA_RPC_URLS: "https://rpc1.example.org/?key=a@2,https://rpc2.example.org/?key=b", TOOLS_MAX_CALLS_PER_ANSWER: "5" }), { background: false, fetch: f.fetch, now: () => NOW });
    const r = await tools.run("sol_balance_changes", { signature: sig }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(f.urls.map((u) => new URL(u).host), ["rpc1.example.org", "rpc2.example.org"]);
    firstError = { code: -32602, message: "Invalid param: not a signature" };
    f.urls.length = 0;
    const bad = await tools.run("sol_balance_changes", { signature: "4" + sig.slice(1) }, { answerId: "t" });
    assert.equal(!bad.ok && bad.error, "bad_args");
    assert.deepEqual(f.urls.map((u) => new URL(u).host), ["rpc1.example.org"], "the caller's mistake: no second endpoint");
  });

  it("rpcEndpoints: Helius keys and URLs with weights, the public RPC only when nothing is set", () => {
    assert.deepEqual(rpcEndpoints({}).map((e) => e.url), ["https://api.mainnet-beta.solana.com"]);
    const eps = rpcEndpoints({ HELIUS_API_KEYS: "k1@3,k2", SOLANA_RPC_URLS: "https://a.example/x@2", SOLANA_RPC_URL: "https://b.example/y" });
    assert.deepEqual(eps.map((e) => [e.url.replace(/api-key=.*/, "api-key=…"), e.weight, e.helius]), [
      ["https://mainnet.helius-rpc.com/?api-key=…", 3, true],
      ["https://a.example/x", 2, false],
      ["https://mainnet.helius-rpc.com/?api-key=…", 1, true],
      ["https://b.example/y", 0.5, false],
    ]);
  });

  it("only fixed hosts are ever requested; arguments cannot carry a URL", async () => {
    const f = tableFetch({});
    const tools = createToolsWith(makeCtx({ TOOLS_MAX_CALLS_PER_ANSWER: "50", TOOLS_SECURITY: "on" }), { background: false, fetch: f.fetch, now: () => NOW });
    const bad = await tools.run("dex_pair_lookup", { query: "https://evil.example/x" }, { answerId: "h" });
    assert.equal(!bad.ok && bad.error, "bad_args");
    for (const t of tools.list()) {
      const args: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(t.parameters.properties)) if (t.parameters.required?.includes(k)) args[k] = p.enum ? p.enum[0] : k.includes("signature") ? "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7" : /address|mint/.test(k) ? "So11111111111111111111111111111111111111112" : "jup";
      await tools.run(t.name, args, { answerId: "h" });
    }
    const hosts = new Set(f.urls.map((u) => new URL(u).host));
    for (const h of hosts) assert.ok(["api.llama.fi", "yields.llama.fi", "stablecoins.llama.fi", "defillama-datasets.llama.fi", "api.dexscreener.com", "api.geckoterminal.com", "gamma-api.polymarket.com", "lite-api.jup.ag", "api.mainnet-beta.solana.com", "api.rugcheck.xyz", "api.gopluslabs.io", "frontend-api-v3.pump.fun", "api.github.com", "raw.githubusercontent.com", "data.iana.org", "crt.sh", "web.archive.org", "api.fxtwitter.com", "api.virtuals.io", "t.me"].includes(h), h);
    assert.ok(hosts.has("api.rugcheck.xyz"), "the security check was asked too");
  });

  it("every source of a free tool is on a primary host", async () => {
    const f = tableFetch({ "https://api.llama.fi/protocols": PROTOCOLS, "https://api.llama.fi/v2/chains": [{ name: "Solana", tvl: 1e10, tokenSymbol: "SOL" }] });
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    for (const [name, args] of [
      ["top_protocols", { chain: "Solana" }],
      ["chain_tvl_ranking", {}],
    ] as const) {
      const r = await tools.run(name, args, { answerId: "p" });
      assert.ok(r.ok, `${name}: ${JSON.stringify(r)}`);
      for (const s of r.sources) assert.equal(primaryUrl(s.url), s.url);
    }
  });
});
