// The data hub (src/free/hub.ts): its catalog read from its OpenAPI, hub_find's search, hub_call's route match, checks
// before sending and answers cut to fit, the source's own complaint handed back, a 429's pause, the day's credits,
// hub_rpc's reads only, the key in a header only, the hub's name out of every answer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResult } from "@crawlnet/shared";
import { FIT_CHARS, fit, hexReading, HINTS, matchRoute, parseCatalog, pick, RPC_WRITE, timeOf, wordsOf } from "../src/free/hub.ts";
import { createToolsWith } from "../src/registry.ts";
import { schemaProblems } from "../src/schema.ts";
import { makeCtx, solKey } from "./helpers.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const KEY = "test-hub-key-0123456789abcdef";
const EVM = "0x28C6c06298d514Db089934071355E5743bf21d60";
const SOL = solKey("hub-wallet");
const HUB = "https://hub.arbitron.dev";

type P = Record<string, unknown>;
const free = { "x-api-hub-billing-type": "free", "x-api-hub-cost": { model: "free", weight: 0 } };
const op = (provider: string, summary: string, parameters: P[] = [], extra: P = {}): P => ({ summary, parameters, "x-api-hub-provider": provider, "x-api-hub-read-only": true, ...free, ...extra });
const inPath = (name: string): P => ({ name, in: "path", required: true, schema: { type: "string" } });
const inQuery = (name: string, required = false, example?: string): P => ({ name, in: "query", required, schema: { type: "string" }, ...(example ? { example } : {}) });
const credits = (weight: number): P => ({ "x-api-hub-billing-type": "credits", "x-api-hub-cost": { model: "per_call", weight } });

/** A slice of the hub's OpenAPI: the shapes its catalog has (credit routes, POST bodies, a param inside a segment…) */
const SPEC = {
  openapi: "3.1.0",
  tags: [
    { name: "arkham", description: "On-chain intelligence platform. Tracks wallet ownership." },
    { name: "newsrc", description: "A source we have no words for. It does more." },
  ],
  paths: {
    "/run/arkham/intelligence/address/{address}": { get: op("arkham", "address", [inPath("address")], credits(1)) },
    "/run/arkham/token/holders/{chain}/{address}": { get: op("arkham", "token holders by chain", [inPath("chain"), inPath("address")], credits(30)) },
    "/run/jupiter_portfolio/data/pnl-stats": { get: op("jupiter_portfolio", "Realized/unrealized PnL aggregates for one wallet", [inQuery("address", true, SOL)]) },
    "/run/tradingview/scanner/{market}/scan": {
      post: op("tradingview", "Screener rows for one market", [{ ...inPath("market"), schema: { type: "string", enum: ["crypto", "america"] } }], {
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { columns: { type: "array", description: "Column names", example: ["close", "RSI"] } } } } } },
      }),
    },
    "/run/okxwallet/priapi/v6/dx/trade/multi/preCheck": {
      post: op("okxwallet", "Compliance precheck for a wallet address", [], {
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { chainId: { type: "integer", example: 1 } }, required: ["chainId"] } } } },
      }),
    },
    "/run/dexscreener/web/hype/reactions/dexPair/{chainId}:{pairId}": { get: op("dexscreener", "reactions of a pair", [inPath("chainId"), inPath("pairId")]) },
    "/run/kalshi/events/": { get: op("kalshi", "events") },
    "/run/x_unified_api/2/tweets/search/recent": { get: op("x_unified_api", "Search recent X posts", [inQuery("query", true, "from:jack")]) },
    "/run/x_unified_api/2/tweets/{tweet_id}/quote_tweets": { get: op("x_unified_api", "Read quotes of an X post", [inPath("tweet_id")]) },
    "/run/newsrc/things": { get: op("newsrc", "things") },
    "/run/arkham/write/thing": { post: { ...op("arkham", "a write"), "x-api-hub-read-only": false } },
  },
};

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
/** The hub's envelope around a source's answer */
const envelope = (source: string, path: string, data: unknown, status = 200): P => ({ source, path, params: {}, status, data, cached: false, ttl: 1, latency_ms: 5 });

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function world(o: { env?: Record<string, string>; answer?: (url: string, body: unknown) => Response } = {}) {
  const sent: Sent[] = [];
  const clock = { t: NOW };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (url === `${HUB}/openapi.json`) return json(SPEC);
    sent.push({ url, method: init?.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    return o.answer ? o.answer(url, body !== undefined ? JSON.parse(body) : undefined) : json(envelope("x", "/", { ok: 1 }));
  };
  const ctx = makeCtx({ API_HUB_KEY: KEY, ...(o.env ?? {}) });
  const tools = createToolsWith(ctx, { fetch, background: false, now: () => clock.t });
  return { tools, sent, ctx, clock };
}

const err = (r: unknown): { error: string; message: string } => r as { error: string; message: string };
/** An ok result's data (an error fails the test with it) */
function dataOf(r: ToolResult): unknown {
  assert.ok(r.ok, JSON.stringify(r));
  return r.data;
}

describe("the data hub (free/hub.ts)", () => {
  it("offered only with API_HUB_KEY (TOOLS_HUB=off leaves it out), each definition valid", () => {
    const none = createToolsWith(makeCtx({}), { fetch: async () => json({}), background: false });
    assert.equal(none.list().some((s) => s.name.startsWith("hub_")), false);
    assert.equal(world({ env: { TOOLS_HUB: "off" } }).tools.list().some((s) => s.name.startsWith("hub_")), false);
    const hub = world().tools.list().filter((s) => s.name.startsWith("hub_"));
    assert.deepEqual(hub.map((s) => s.name).sort(), ["hub_call", "hub_find", "hub_rpc"]);
    for (const s of hub) assert.deepEqual(schemaProblems(s), [], s.name);
  });

  it("the catalog: read-only /run routes by source, a credit route's weight, a POST body's fields; a concrete path matched (a param inside a segment, any case)", () => {
    const cat = parseCatalog(SPEC);
    assert.equal(cat.routes.some((r) => r.path === "/write/thing"), false, "a route not marked read-only is never offered");
    assert.equal(cat.routes.find((r) => r.path === "/token/holders/{chain}/{address}")!.credits, 30);
    const pre = cat.routes.find((r) => r.provider === "okxwallet")!;
    assert.deepEqual([pre.body, pre.bodyRequired], [{ fields: [{ name: "chainId", type: "integer", required: true, example: "1" }] }, true]);
    assert.deepEqual(matchRoute(cat.byProvider.get("arkham")!, "GET", `/intelligence/address/${EVM}`)?.values, { address: EVM });
    assert.deepEqual(matchRoute(cat.byProvider.get("dexscreener")!, "GET", "/web/hype/reactions/dexPair/solana:abc")?.values, { chainId: "solana", pairId: "abc" });
    assert.equal(matchRoute(cat.byProvider.get("okxwallet")!, "POST", "/priapi/v6/dx/trade/multi/precheck")?.route.path, "/priapi/v6/dx/trade/multi/preCheck");
    assert.equal(matchRoute(cat.byProvider.get("arkham")!, "GET", "/intelligence/address"), null);
    assert.deepEqual(wordsOf("getHolderAddresses for activities"), ["holder", "address", "activity"]);
  });

  it("hub_find: a plain ask finds its route (our words on it), with its params and cost; no words: the sources; one source's routes in short", async () => {
    const { tools } = world();
    const who = await tools.run("hub_find", { query: "whose wallet is this" }, { answerId: "f1" });
    assert.ok(who.ok, JSON.stringify(who));
    const first = (who.data as { routes: P[] }).routes[0]!;
    assert.deepEqual(first, { provider: "arkham", method: "GET", path: "/intelligence/address/{address}", what: "address", params: [{ name: "address", in: "path", required: true }], cost: "1 credit" });
    const pnl = await tools.run("hub_find", { query: "solana wallet pnl" }, { answerId: "f2" });
    assert.equal((dataOf(pnl) as { routes: P[] }).routes[0]!.path, "/data/pnl-stats");
    const rsi = await tools.run("hub_find", { query: "rsi of btc" }, { answerId: "f3" });
    assert.deepEqual((dataOf(rsi) as { routes: P[] }).routes[0]!.body, { fields: [{ name: "columns", type: "array", example: '["close","RSI"]', about: "Column names" }] });
    const sources = await tools.run("hub_find", {}, { answerId: "f4" });
    const list = (dataOf(sources) as { sources: { name: string; routes: number; covers: string }[] }).sources;
    assert.match(list.find((s) => s.name === "arkham")!.covers, /^on-chain labels: who owns an address/);
    assert.equal(list.find((s) => s.name === "newsrc")!.covers, "A source we have no words for.", "a source we have no words for: its own first sentence");
    const ark = await tools.run("hub_find", { provider: "arkham" }, { answerId: "f5" });
    assert.deepEqual((dataOf(ark) as { routes: string[] }).routes, ["GET /intelligence/address/{address}: address (1 credits)", "GET /token/holders/{chain}/{address}: token holders by chain (30 credits)"]);
    const bad = await tools.run("hub_find", { provider: "nosuch" }, { answerId: "f6" });
    assert.match(err(bad).message, /^no source nosuch: one of arkham, /);
  });

  it("hub_call: the key in a header only, the path's params filled from params; the source's answer without empty fields; arkham's page as the source; the route logged, never the params or the key", async () => {
    const { tools, sent, ctx } = world({ answer: () => json(envelope("arkham", "/intelligence/address/x", { address: EVM, arkhamEntity: { name: "Binance", type: "cex", note: "" }, arkhamLabel: { name: "Hot Wallet" }, tags: [], service: null })) });
    const r = await tools.run("hub_call", { provider: "arkham", path: "/intelligence/address/{address}", params: [`address=${EVM}`] }, { answerId: "c1" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, `${HUB}/run/arkham/intelligence/address/${EVM}`, "the path param in the path, not in the query");
    assert.equal(sent[0]!.headers["x-hub-key"], KEY);
    assert.deepEqual((r.data as P).data, { address: EVM, arkhamEntity: { name: "Binance", type: "cex" }, arkhamLabel: { name: "Hot Wallet" } });
    assert.equal((r.data as P).route, "arkham GET /intelligence/address/{address}");
    assert.deepEqual(r.sources.map((s) => s.url), [`https://intel.arkm.com/explorer/address/${EVM}`]);
    const line = ctx.logs.find((l) => l.msg === "tools: hub call")!;
    assert.deepEqual([line.extra!.route, line.extra!.status, line.extra!.credits], ["arkham GET /intelligence/address/{address}", 200, 1]);
    assert.ok(!JSON.stringify(ctx.logs).includes(KEY) && !JSON.stringify(ctx.logs).includes(EVM));
  });

  it("hub_call: a concrete path, query params passed, a POST body sent as JSON; an X post's id linked, a user's id never", async () => {
    const { tools, sent } = world({ answer: (url) => json(envelope("x", url, { data: [{ s: "BINANCE:BTCUSDT", d: [81348.03, 45.735034926195354] }] })) });
    const tv = await tools.run("hub_call", { provider: "tradingview", path: "/scanner/crypto/scan", method: "POST", body: '{"symbols": {"tickers": ["BINANCE:BTCUSDT"]}, "columns": ["close", "RSI"]}' }, { answerId: "c2" });
    assert.ok(tv.ok, JSON.stringify(tv));
    assert.deepEqual([sent[0]!.url, sent[0]!.method, JSON.parse(sent[0]!.body!)], [`${HUB}/run/tradingview/scanner/crypto/scan`, "POST", { symbols: { tickers: ["BINANCE:BTCUSDT"] }, columns: ["close", "RSI"] }]);
    assert.deepEqual(((tv.data as P).data as { data: { d: number[] }[] }).data[0]!.d, [81348.03, 45.735], "long decimals rounded");
    const pnl = await tools.run("hub_call", { provider: "jupiter_portfolio", path: "/data/pnl-stats", params: [`address=${SOL}`] }, { answerId: "c3" });
    assert.ok(pnl.ok);
    assert.equal(sent[1]!.url, `${HUB}/run/jupiter_portfolio/data/pnl-stats?address=${SOL}`);
    assert.deepEqual(pnl.sources.map((s) => s.url), [`https://solscan.io/account/${SOL}`]);
    const quotes = await tools.run("hub_call", { provider: "x_unified_api", path: "/2/tweets/2110416437506998273/quote_tweets" }, { answerId: "c4" });
    assert.ok(quotes.ok, JSON.stringify(quotes));
    assert.deepEqual(quotes.sources.map((s) => s.url), ["https://x.com/i/status/2110416437506998273"]);
    const pair = await tools.run("hub_call", { provider: "dexscreener", path: "/web/hype/reactions/dexPair/{chainId}:{pairId}", params: ["chainId=solana", "pairId=abc"] }, { answerId: "c5" });
    assert.ok(pair.ok);
    assert.equal(sent.at(-1)!.url, `${HUB}/run/dexscreener/web/hype/reactions/dexPair/solana:abc`);
  });

  it("hub_call: refused before sending: a required param missing, an unfilled {param}, a route the catalog does not list (the near ones named), a GET with a body, a POST without its body", async () => {
    const { tools, sent } = world();
    const run = (args: P, id: string) => tools.run("hub_call", args, { answerId: id });
    assert.match(err(await run({ provider: "jupiter_portfolio", path: "/data/pnl-stats" }, "b1")).message, /needs address=… in params/);
    assert.match(err(await run({ provider: "arkham", path: "/intelligence/address/{address}" }, "b2")).message, /^fill \{address\} in the path or give address=… in params$/);
    assert.match(err(await run({ provider: "arkham", path: `/intelligence/adress/${EVM}` }, "b3")).message, /^arkham has no GET route .*; near it: GET \/intelligence\/address\/\{address\}/);
    assert.match(err(await run({ provider: "jupiter_portfolio", path: "/data/pnl-stats", params: [`address=${SOL}`], body: "{}" }, "b4")).message, /a GET route takes no body/);
    assert.match(err(await run({ provider: "okxwallet", path: "/priapi/v6/dx/trade/multi/preCheck", method: "POST" }, "b5")).message, /takes a JSON body: \{"fields"/);
    assert.match(err(await run({ provider: "nosuch", path: "/x" }, "b6")).message, /^no source nosuch/);
    assert.equal(err(await run({ provider: "arkham", path: "/intelligence/address/{address}", params: ["address=a b"] }, "b7")).error, "bad_args");
    assert.equal(sent.length, 0, "nothing sent");
  });

  it("hub_call: the source's own complaint on a 400 handed back, its 404 not found, an error inside a 200 handed back", async () => {
    const { tools } = world({
      answer: (url) =>
        url.includes("pnl-stats")
          ? json(envelope("jupiter_portfolio", "/data/pnl-stats", { status: 400, message: "Param: '/addresses', Message: 'Expected required property'" }, 400), 400)
          : url.includes("holders")
            ? json(envelope("arkham", "/token/holders", null, 404), 404)
            : json(envelope("okxwallet", "/x", { code: 51000, msg: "Parameter chainId error", data: [] })),
    });
    const pnl = await tools.run("hub_call", { provider: "jupiter_portfolio", path: "/data/pnl-stats", params: [`address=${SOL}`] }, { answerId: "e1" });
    assert.deepEqual([err(pnl).error, err(pnl).message], ["bad_args", "the query failed: Param: '/addresses', Message: 'Expected required property'"]);
    const holders = await tools.run("hub_call", { provider: "arkham", path: `/token/holders/ethereum/${EVM}` }, { answerId: "e2" });
    assert.equal(err(holders).error, "not_found");
    const pre = await tools.run("hub_call", { provider: "okxwallet", path: "/priapi/v6/dx/trade/multi/preCheck", method: "POST", body: '{"chainId": 999}' }, { answerId: "e3" });
    assert.deepEqual([err(pre).error, err(pre).message], ["bad_args", "the query failed: Parameter chainId error"]);
  });

  it("a 429: that source waits as long as the hub says (X search's fair share), others still answer; the whole hub on a rate reason", async () => {
    let reason = "x_search_fairness";
    const { tools, sent, clock } = world({ answer: (url) => (url.includes("x_unified_api") || reason === "rate" ? json({ error: "rate limit exceeded", reason, retry_after_s: 95 }, 429, { "retry-after": "95" }) : json(envelope("jupiter_portfolio", "/", { ok: 1 }))) });
    const x = (q: string, id: string) => tools.run("hub_call", { provider: "x_unified_api", path: "/2/tweets/search/recent", params: [`query=${q}`] }, { answerId: id });
    const first = await x("$JUP", "r1");
    assert.deepEqual([err(first).error, err(first).message], ["rate_limited", "this source is busy for about 95 s more: answer without it or try it later"]);
    assert.equal(err(await x("$BONK", "r2")).error, "rate_limited");
    assert.equal(sent.length, 1, "the wait is kept: not sent again");
    assert.ok((await tools.run("hub_call", { provider: "jupiter_portfolio", path: "/data/pnl-stats", params: [`address=${SOL}`] }, { answerId: "r3" })).ok, "another source answers");
    clock.t += 96_000;
    await x("$WIF", "r4");
    assert.equal(sent.length, 3, "sent again once the wait is over");
    reason = "rate";
    clock.t += 200_000;
    await tools.run("hub_call", { provider: "jupiter_portfolio", path: "/data/pnl-stats", params: [`address=${solKey("other")}`] }, { answerId: "r5" });
    const n = sent.length;
    assert.equal(err(await tools.run("hub_call", { provider: "arkham", path: `/intelligence/address/${EVM}` }, { answerId: "r6" })).error, "rate_limited");
    assert.equal(sent.length, n, "a hub-wide 429 holds every source");
  });

  it("the day's credits: a credit route's weight counted; past them refused unsent, free routes still answer", async () => {
    const { tools, sent } = world({ env: { TOOLS_HUB_DAILY_CREDITS: "40" }, answer: () => json(envelope("arkham", "/", { ok: 1 })) });
    const holders = (addr: string, id: string) => tools.run("hub_call", { provider: "arkham", path: `/token/holders/ethereum/${addr}` }, { answerId: id });
    assert.ok((await holders(EVM, "k1")).ok);
    const over = await holders("0x0000000000000000000000000000000000000001", "k2");
    assert.deepEqual([err(over).error, err(over).message], ["rate_limited", "today's on-chain label reads are used up; other routes still answer"]);
    assert.ok((await tools.run("hub_call", { provider: "arkham", path: `/intelligence/address/${EVM}` }, { answerId: "k3" })).ok, "a 1-credit read still fits");
    assert.ok((await tools.run("hub_call", { provider: "jupiter_portfolio", path: "/data/pnl-stats", params: [`address=${SOL}`] }, { answerId: "k4" })).ok);
    assert.equal(sent.length, 3);
  });

  it("an answer cut to fit: lists to max_items (the cut said), long text cut, then shorter until it fits; fields walk through lists; a field not found said", async () => {
    const big = { data: { items: Array.from({ length: 500 }, (_, i) => ({ address: `w${i}`, balance: i * 1.123456789, note: "x".repeat(900) })), total: 500 } };
    const f = fit(big, 20)!;
    const items = (f.data as { data: { items: { note: string }[] } }).data.items;
    assert.equal(items.length, 20);
    assert.equal(items[0]!.note.length, 501, "500 characters and an ellipsis");
    assert.deepEqual(f.cut, ["data.items: 20 of 500"]);
    const tight = fit(big, 100)!;
    assert.ok(JSON.stringify(tight.data).length <= FIT_CHARS && (tight.data as { data: { items: unknown[] } }).data.items.length < 100, "cut further to fit");
    const p = pick(big, ["data.items[].address", "data.nothing"]);
    assert.deepEqual([(p.data as { data: { items: unknown[] } }).data.items[1], p.missed], [{ address: "w1" }, ["data.nothing"]]);
    // times read as ISO (seconds, milliseconds, digits), pictures out, a duration or an amount left alone
    const row = { nextUnlock: { date: 1792281600000, createdAt: 1792281600, lastTime: "1790868863000", holdSeconds: 3600, amount: 1792281600 }, chainIconUrl: "https://static.example/a.png", logoURI: "https://x/y", banner: "https://pic.example/b.webp?v=2", url: "https://example.com/a.png" };
    assert.deepEqual(fit(row, 20)!.data, { nextUnlock: { date: "2026-10-18T00:00:00Z", createdAt: "2026-10-18T00:00:00Z", lastTime: "2026-10-01T15:34:23Z", holdSeconds: 3600, amount: 1792281600 } });
    assert.equal(timeOf("blockTime", 99), null);
    const { tools } = world({ answer: () => json(envelope("arkham", "/", big.data)) });
    const r = await tools.run("hub_call", { provider: "arkham", path: `/intelligence/address/${EVM}`, fields: ["items.address", "total"], max_items: 3 }, { answerId: "t1" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual((r.data as P).data, { items: [{ address: "w0" }, { address: "w1" }, { address: "w2" }], total: 500 });
    assert.deepEqual((r.data as P).cut, ["items: 3 of 500"]);
  });

  it("hub_rpc: a read sent as JSON-RPC 2.0; a method that sends or signs refused unsent; the chain's refusal of a method handed back", async () => {
    const { tools, sent } = world({
      answer: (_url, body) => ((body as { method: string }).method === "getBalance" ? json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: 5 } }) : json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not in the read allowlist" } })),
    });
    const r = await tools.run("hub_rpc", { chain: "solana", method: "getBalance", params: JSON.stringify([SOL]) }, { answerId: "p1" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([sent[0]!.url, JSON.parse(sent[0]!.body!), sent[0]!.headers["x-hub-key"]], [`${HUB}/rpc/solana`, { jsonrpc: "2.0", id: 1, method: "getBalance", params: [SOL] }, KEY]);
    assert.deepEqual((r.data as P).result, { context: { slot: 1 }, value: 5 });
    assert.deepEqual(r.sources.map((s) => s.url), [`https://solscan.io/account/${SOL}`]);
    for (const m of ["eth_sendRawTransaction", "sendTransaction", "eth_sign", "personal_sign", "/wallet/broadcasttransaction", "submit", "requestAirdrop"]) {
      assert.equal(err(await tools.run("hub_rpc", { chain: "ethereum", method: m, params: '["0x00"]' }, { answerId: `p-${m}` })).error, "bad_args", m);
    }
    assert.equal(sent.length, 1, "no write sent");
    for (const m of ["getSignaturesForAddress", "getSignatureStatuses", "eth_getBalance", "/wallet/getaccount", "suix_getAllBalances"]) assert.equal(RPC_WRITE.test(m), false, m);
    const no = await tools.run("hub_rpc", { chain: "ethereum", method: "eth_mining", params: "[]" }, { answerId: "p2" });
    assert.match(err(no).message, /^eth_mining is not a read method of this chain \(method not in the read allowlist\)$/);
    assert.match(err(await tools.run("hub_rpc", { chain: "ethereum", method: "eth_blockNumber", params: "not json" }, { answerId: "p3" })).message, /params must be JSON/);
  });

  it("a chain's hex quantity read as a decimal (a balance also in its coin), never an address, a hash or call data", () => {
    assert.deepEqual(hexReading("eth_getBalance", "0x50122e9e75120cc5"), { decimal: "5769725330718854341", native: "5.769725" });
    assert.deepEqual(hexReading("eth_getBalance", "0xde0b6b3a7640000"), { decimal: "1000000000000000000", native: "1" });
    assert.deepEqual(hexReading("eth_blockNumber", "0x1"), { decimal: "1" });
    assert.equal(hexReading("eth_call", "0x01"), null);
    assert.equal(hexReading("eth_getBalance", EVM), null);
    assert.equal(hexReading("getBalance", { value: 5 }), null);
  });

  it("a refused key: unavailable, logged once, no call for a while", async () => {
    const { tools, sent, ctx } = world({ answer: () => json({ error: "issued-key state unavailable" }, 503) });
    assert.equal(err(await tools.run("hub_call", { provider: "arkham", path: `/intelligence/address/${EVM}` }, { answerId: "q1" })).error, "unavailable");
    assert.equal(err(await tools.run("hub_rpc", { chain: "ethereum", method: "eth_blockNumber" }, { answerId: "q2" })).error, "rate_limited");
    assert.equal(sent.length, 1);
    assert.equal(ctx.logs.filter((l) => l.msg === "tools: hub key refused").length, 1);
  });

  it("our words on a route name routes the catalog has", () => {
    for (const k of Object.keys(HINTS)) assert.match(k, /^[a-z0-9_]+ (GET|POST) \/\S+$/, k);
  });
});
