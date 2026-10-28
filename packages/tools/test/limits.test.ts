import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "@crawlnet/shared";
import { AnswerBudget, ANSWER_WINDOW_MS, DailyCounter, WindowLimiter } from "../src/limits.ts";
import { TtlCache } from "../src/cache.ts";
import { createToolsWith, SLOW_TOOL_TIMEOUT_MS } from "../src/registry.ts";
import { makeCtx, tableFetch } from "./helpers.ts";

const STABLES = {
  peggedAssets: [
    { name: "Tether", symbol: "USDT", pegType: "peggedUSD", pegMechanism: "fiat-backed", circulating: { peggedUSD: 180e9 }, circulatingPrevDay: { peggedUSD: 179e9 }, circulatingPrevWeek: { peggedUSD: 178e9 }, price: 1, chainCirculating: {} },
  ],
};

describe("budgets and caps", () => {
  it("AnswerBudget: at most N calls per answer id", () => {
    const b = new AnswerBudget(2);
    assert.equal(b.take("a"), true);
    assert.equal(b.take("a"), true);
    assert.equal(b.take("a"), false);
    assert.equal(b.take("b"), true);
  });

  it("AnswerBudget: an id gets its budget back 30 min after its first call", () => {
    let t = 0;
    const b = new AnswerBudget(4, () => t);
    for (let i = 0; i < 4; i++) assert.equal(b.take("chat-123"), true);
    assert.equal(b.take("chat-123"), false);
    t = ANSWER_WINDOW_MS - 1;
    assert.equal(b.take("chat-123"), false, "still the same answer");
    t = 5 * 3600_000;
    assert.equal(b.usedBy("chat-123"), 0);
    assert.equal(b.take("chat-123"), true, "an old id is a new answer");
    assert.equal(b.usedBy("chat-123"), 1);
  });

  it("run() without an answer id is refused (no shared bucket that would lock every such call out)", async () => {
    const f = tableFetch({ "https://stablecoins.llama.fi/stablecoins": STABLES });
    const tools = createToolsWith(makeCtx({}), { background: false, fetch: f.fetch });
    const noId = { ok: false, error: "bad_args", message: "this call has no answer id" };
    assert.deepEqual(await tools.run("stablecoin_supply", {}, { answerId: "" }), noId);
    assert.deepEqual(await tools.run("stablecoin_supply", {}, { answerId: "   " }), noId);
    assert.deepEqual(await (tools.run as (n: string, a: unknown, c?: unknown) => Promise<unknown>)("stablecoin_supply", {}), noId);
    assert.equal(f.urls.length, 0);
    for (let i = 0; i < 6; i++) assert.equal((await tools.run("stablecoin_supply", {}, { answerId: `own-${i}` })).ok, true, "answers with ids are unaffected");
  });

  it("WindowLimiter: a sliding minute", () => {
    let t = 0;
    const l = new WindowLimiter(2, 60_000, () => t);
    assert.equal(l.take(), true);
    assert.equal(l.take(), true);
    assert.equal(l.take(), false);
    t = 60_001;
    assert.equal(l.take(), true);
  });

  it("DailyCounter: capped per UTC day and kept in SQLite across restarts", () => {
    const db = openDb(":memory:");
    let t = Date.parse("2026-10-04T10:00:00Z");
    const a = new DailyCounter(3, db, () => t, "xsearch_calls");
    assert.equal(a.take(), true);
    assert.equal(a.take(), true);
    const b = new DailyCounter(3, db, () => t, "xsearch_calls"); // a restart
    assert.equal(b.count(), 2);
    assert.equal(b.take(), true);
    assert.equal(b.take(), false);
    t = Date.parse("2026-10-05T00:00:01Z");
    assert.equal(b.take(), true, "a new UTC day");
    const row = db.prepare(`SELECT day, xsearch_calls FROM tools_usage ORDER BY day`).all();
    assert.deepEqual(row, [
      { day: "2026-10-04", xsearch_calls: 3 },
      { day: "2026-10-05", xsearch_calls: 1 },
    ]);
  });

  it("each paid provider's day in a column of its own: news_calls (tools/003_usage_news) never counts as the X search's", () => {
    const db = openDb(":memory:");
    const t = Date.parse("2026-10-17T10:00:00Z");
    const news = new DailyCounter(2, db, () => t, "news_calls");
    const x = new DailyCounter(5, db, () => t, "xsearch_calls");
    assert.equal(news.take(), true);
    assert.equal(news.take(), true);
    assert.equal(news.take(), false, "the web search's own cap");
    assert.equal(x.take(), true);
    assert.deepEqual(db.prepare(`SELECT xsearch_calls, news_calls FROM tools_usage`).get(), { xsearch_calls: 1, news_calls: 2 });
    assert.equal(new DailyCounter(2, db, () => t, "news_calls").count(), 2, "a restart keeps the web search's count");
    assert.equal(new DailyCounter(5, db, () => t, "xsearch_calls").count(), 1, "and the X search's its own");
    const ids = (db.prepare(`SELECT id FROM _migrations WHERE id LIKE 'tools/%' ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    assert.deepEqual(ids, ["tools/001_usage", "tools/002_usage_xsearch", "tools/003_usage_news", "tools/004_usage_hub"]);
    assert.throws(() => new DailyCounter(1, db, () => t, "other_calls" as never));
  });

  it("the data hub's credits: a call's weight at once (take(n)), refused whole past the cap, kept across a restart", () => {
    const db = openDb(":memory:");
    const t = Date.parse("2026-10-18T10:00:00Z");
    const credits = new DailyCounter(40, db, () => t, "hub_credits");
    const calls = new DailyCounter(100, db, () => t, "hub_calls");
    assert.equal(credits.take(30), true);
    assert.equal(credits.take(30), false, "30 more would pass 40: nothing counted");
    assert.equal(credits.count(), 30);
    assert.equal(credits.take(10), true);
    assert.equal(calls.take(), true);
    assert.deepEqual(db.prepare(`SELECT hub_calls, hub_credits FROM tools_usage`).get(), { hub_calls: 1, hub_credits: 40 });
    assert.equal(new DailyCounter(40, db, () => t, "hub_credits").count(), 40, "a restart keeps the day's credits");
  });

  it("per-answer cap through run(): the 13th call of one answer is refused (default 12), cache hits count too", async () => {
    const f = tableFetch({ "https://stablecoins.llama.fi/stablecoins": STABLES });
    const tools = createToolsWith(makeCtx({}), { background: false, fetch: f.fetch });
    for (let i = 0; i < 12; i++) assert.equal((await tools.run("stablecoin_supply", {}, { answerId: "one" })).ok, true);
    const r = await tools.run("stablecoin_supply", {}, { answerId: "one" });
    assert.deepEqual(r, { ok: false, error: "rate_limited", message: "the tool call limit for this answer is reached" });
    assert.equal((await tools.run("stablecoin_supply", {}, { answerId: "two" })).ok, true);
    assert.equal(f.urls.length, 1, "one request, the rest from the cache");
  });

  it("a slow tool (a search) gets SLOW_TOOL_TIMEOUT_MS at least: past TOOLS_TIMEOUT_MS it still answers, a quick tool does not", async () => {
    const late = (body: string) => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(body, { status: 200 })), 1200));
    const page = "https://www.news-one.example.com/post/371234/second-client-live";
    const answer = { summary: `The second client is live [[1]](${page}).`, results: [{ url: page, title: "A second client goes live", snippet: "The second client is live.", date: "2026-10-16" }] };
    const cite = { type: "url_citation", url_citation: { url: page, title: "A second client goes live", content: "", start_index: 0, end_index: 10 } };
    const grok = JSON.stringify({ id: "g", model: "x-ai/grok-4.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "```json\n" + JSON.stringify(answer) + "\n```", annotations: [cite] } }], usage: { cost: 0.02 } });
    const fetch = async (url: string) => (url.includes("openrouter.ai") ? late(grok) : late(JSON.stringify(STABLES)));
    const tools = createToolsWith(makeCtx({ TOOLS_XSEARCH_KEY: "sk-or-v1-test-0123456789abcdef", TOOLS_TIMEOUT_MS: "600" }), { background: false, fetch, now: () => Date.parse("2026-10-17T12:00:00Z") });
    assert.equal((await tools.run("news_pages", { query: "solana second client" }, { answerId: "slow" })).ok, true, "the search waits it out");
    assert.equal((await tools.run("stablecoin_supply", {}, { answerId: "quick" })).ok, false, "a quick tool keeps TOOLS_TIMEOUT_MS");
    assert.ok(SLOW_TOOL_TIMEOUT_MS >= 80_000);
  });

  it("TOOLS_MAX_CALLS_PER_ANSWER changes the cap", async () => {
    const f = tableFetch({ "https://stablecoins.llama.fi/stablecoins": STABLES });
    const tools = createToolsWith(makeCtx({ TOOLS_MAX_CALLS_PER_ANSWER: "1" }), { background: false, fetch: f.fetch });
    assert.equal((await tools.run("stablecoin_supply", {}, { answerId: "x" })).ok, true);
    assert.equal((await tools.run("stablecoin_supply", {}, { answerId: "x" })).ok, false);
  });

  it("GeckoTerminal is held to TOOLS_GECKO_PER_MIN", async () => {
    const f = tableFetch({ "https://api.geckoterminal.com/": { data: [] } });
    const tools = createToolsWith(makeCtx({ TOOLS_GECKO_PER_MIN: "1", TOOLS_MAX_CALLS_PER_ANSWER: "10" }), { background: false, fetch: f.fetch });
    assert.equal((await tools.run("fresh_pools", { network: "solana" }, { answerId: "g" })).ok, true);
    const r = await tools.run("fresh_pools", { network: "base" }, { answerId: "g" });
    assert.equal(!r.ok && r.error, "rate_limited");
    assert.equal(f.urls.length, 1);
  });
});

describe("cache", () => {
  it("TtlCache: expires after its TTL, never more than 24 h, evicts the least recent", () => {
    let t = 0;
    const c = new TtlCache<number>(2, () => t);
    c.set("a", 1, 1000);
    c.set("b", 2, 48 * 3600_000);
    t = 999;
    assert.equal(c.get("a"), 1);
    t = 1000;
    assert.equal(c.get("a"), undefined);
    t = 24 * 3600_000;
    assert.equal(c.get("b"), undefined, "capped at 24 h");
    c.set("x", 1, 10_000);
    c.set("y", 2, 10_000);
    c.get("x");
    c.set("z", 3, 10_000);
    assert.equal(c.get("y"), undefined, "least recently used went");
    assert.equal(c.get("x"), 1);
  });

  it("run(): a result is reused within the tool's TTL and fetched again after it", async () => {
    let t = Date.parse("2026-10-04T10:00:00Z");
    const f = tableFetch({ "https://api.dexscreener.com/latest/dex/search": { pairs: [] } });
    const tools = createToolsWith(makeCtx({ TOOLS_MAX_CALLS_PER_ANSWER: "10" }), { background: false, fetch: f.fetch, now: () => t });
    await tools.run("dex_pair_lookup", { query: "JUP" }, { answerId: "c" });
    await tools.run("dex_pair_lookup", { query: "JUP" }, { answerId: "c" });
    assert.equal(f.urls.length, 1, "not found is cached briefly too");
    t += 61_000;
    await tools.run("dex_pair_lookup", { query: "JUP" }, { answerId: "c" });
    assert.equal(f.urls.length, 2);
  });
});
