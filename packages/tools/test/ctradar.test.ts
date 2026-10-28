// The CT calls radar (src/free/ctradar.ts): the calls feed read by twitterapi.io (X's own query, one Latest page a
// tick, on its key) or by Grok (the X search's request, only the posts its search cited), the follower floor, a post's
// mints and tickers, its spam, repeats, replies and lists out, the coins ranked by distinct callers then reach, one
// coin's calls oldest first, the 3 days kept, unavailable before anything is read, the tool's schema, each tick's cost
// logged and kept, and the collector only with background on; FxTwitter's reads of the posts Grok cited: read ok, down,
// an unknown count kept and marked; the top calls on Grok (the most liked or viewed of the last 6 h, stored as calls,
// their ticks lane "top"); and the narratives view computed from the stored calls, grouped by our own label of each
// mint (heating, steady, fading; the unlabelled last).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { coinsIn, coinsOf, FX_AT_ONCE, fxPost, narrativesFrom, rankCoins, TWITTERAPI_QUERY, UNLABELLED, type CtPost } from "../src/free/ctradar.ts";
import { createToolsWith } from "../src/registry.ts";
import { schemaProblems } from "../src/schema.ts";
import { makeCtx, solKey } from "./helpers.ts";

const TAPI_KEY = "tapi-test-0123456789abcdef";
const ROUTER_KEY = "sk-or-v1-test-0123456789abcdef";
const T0 = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60_000;
const X_EPOCH = 1_288_834_974_657n;
const MINT_A = solKey("ct-mint-a");
const MINT_B = solKey("ct-mint-b");
const MINT_D1 = solKey("ct-mint-d1");
const MINT_D2 = solKey("ct-mint-d2");
const PAIR_B = solKey("ct-pair-b");
const WALLET = solKey("ct-wallet");

/** An X post id dated `ms` (its time in its top bits), the n-th of that millisecond */
const idAt = (ms: number, n = 1): string => ((BigInt(ms) - X_EPOCH) << 22n | BigInt(n)).toString();
/** Twitter's own date, as twitterapi.io gives createdAt */
const twDate = (ms: number): string => {
  const m = /^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/.exec(new Date(ms).toUTCString())!;
  return `${m[1]} ${m[3]} ${m[2]} ${m[5]} +0000 ${m[4]}`;
};

/** A tweet as twitterapi.io's advanced search returns it */
const tweet = (ms: number, handle: string, followers: number | null, text: string, o: Record<string, unknown> = {}) => {
  const id = idAt(ms, Number(o.n ?? 1));
  return {
    type: "tweet",
    id,
    url: `https://x.com/${handle}/status/${id}`,
    text,
    createdAt: twDate(ms),
    likeCount: 12,
    retweetCount: 2,
    replyCount: 1,
    quoteCount: 0,
    viewCount: 3400,
    isReply: false,
    author: { type: "user", userName: handle, name: handle.toUpperCase(), followers, following: 300, isBlueVerified: true },
    entities: { urls: [] },
    ...o,
  };
};
const page = (tweets: unknown[], more = false) => ({ tweets, has_next_page: more, next_cursor: more ? "cursor-2" : "" });

/** A post as Grok answers it, and its citation */
const gpost = (ms: number, handle: string, text: string, followers: number | null = 5000) => {
  const id = idAt(ms);
  return { url: `https://x.com/${handle}/status/${id}`, handle, followers, text, likes: 30, reposts: 1, views: 9000, at: new Date(ms).toISOString() };
};
const cites = (posts: { url: string }[]) => posts.map((p) => ({ type: "url_citation", url_citation: { url: p.url, title: "post" } }));
const router = (content: unknown, annotations: unknown[], cost: number | null = 0.042) => ({
  id: "gen-1",
  model: "x-ai/grok-4.3",
  choices: [{ message: { role: "assistant", content: "```json\n" + JSON.stringify(content) + "\n```", annotations } }],
  usage: { prompt_tokens: 900, completion_tokens: 700, ...(cost !== null ? { cost } : {}) },
});

/** FxTwitter's status API answer for one post (its v2: {code, status}), the post's time from its id */
const FX = "api.fxtwitter.com";
const fxBody = (url: string, followers: number | null, text: string, o: { handle?: string } = {}) => {
  const [, handle, id] = /x\.com\/([^/]+)\/status\/(\d+)/.exec(url)!;
  const ms = Number((BigInt(id!) >> 22n) + X_EPOCH);
  return {
    code: 200,
    message: "OK",
    status: { id, url, text, raw_text: { text, facets: [] }, author: { screen_name: o.handle ?? handle, name: "Name", followers, following: 10 }, likes: 77, reposts: 5, views: 12_345, created_at: new Date(ms).toUTCString(), created_timestamp: Math.floor(ms / 1000) },
  };
};

interface Sent {
  url: URL;
  headers: Headers;
  body: Record<string, any> | null;
}

/** The tools on a fake fetch and a clock the test moves, background off */
function world(env: Record<string, string>, reply: (s: Sent) => unknown) {
  const ctx = makeCtx(env);
  const clock = { t: T0 };
  const sent: Sent[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const s: Sent = { url: new URL(input), headers: new Headers(init?.headers), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
    sent.push(s);
    const r = await reply(s);
    return r instanceof Response ? r : Response.json(r);
  };
  const t = createToolsWith(ctx, { fetch, background: false, now: () => clock.t });
  return { t, ctx, clock, sent, radar: t.ctradar! };
}

const radarLines = (ctx: ReturnType<typeof makeCtx>) => ctx.logs.filter((l) => l.msg === "tools: ct radar").map((l) => l.extra!);
const rows = (ctx: ReturnType<typeof makeCtx>) => ctx.db.prepare(`SELECT * FROM tools_ct_posts ORDER BY posted_at, id`).all() as Record<string, any>[];

describe("the CT radar's calls feed on twitterapi.io (free/ctradar.ts)", () => {
  it("one Latest page of X's own query on its key a tick: since_time an hour back cold, a beat before the last good read after", async () => {
    const { radar, sent, clock } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([tweet(T0 - 3 * MIN, "alice_calls", 5000, `$AAA sending, CA: ${MINT_A}`)]));
    const r = await radar.tickCalls();
    assert.equal(r.ok, true);
    assert.equal(sent.length, 1, "one call a tick");
    const s = sent[0]!;
    assert.equal(s.url.host, "api.twitterapi.io");
    assert.equal(s.url.pathname, "/twitter/tweet/advanced_search");
    assert.equal(s.url.searchParams.get("queryType"), "Latest");
    assert.equal(s.url.searchParams.get("query"), `${TWITTERAPI_QUERY} since_time:${(T0 - 60 * MIN) / 1000}`);
    assert.match(TWITTERAPI_QUERY, /min_faves:5/);
    assert.match(TWITTERAPI_QUERY, /-filter:replies/);
    assert.equal(s.headers.get("x-api-key"), TAPI_KEY);
    clock.t += 5 * MIN;
    await radar.tickCalls();
    assert.equal(sent[1]!.url.searchParams.get("query"), `${TWITTERAPI_QUERY} since_time:${(T0 - 5 * MIN) / 1000}`);
  });

  it("its tweets as calls: the post's time from its id, the follower count, likes, views, the link, 280 characters, the source", async () => {
    const long = `$AAA aped ${MINT_A} ` + "gm ".repeat(150);
    const { radar, ctx } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([tweet(T0 - 7 * MIN, "alice_calls", 5200, long, { likeCount: 41, viewCount: 9100 })]));
    await radar.tickCalls();
    const [row] = rows(ctx);
    assert.ok(row);
    assert.equal(row.id, idAt(T0 - 7 * MIN));
    assert.equal(row.url, `https://x.com/alice_calls/status/${idAt(T0 - 7 * MIN)}`);
    assert.equal(row.handle, "alice_calls");
    assert.deepEqual([row.followers, row.likes, row.views, row.posted_at, row.seen_at, row.source], [5200, 41, 9100, T0 - 7 * MIN, T0, "twitterapi"]);
    assert.ok(row.text.length <= 280, `${row.text.length}`);
    assert.deepEqual([JSON.parse(row.mints), JSON.parse(row.tickers)], [[MINT_A], ["AAA"]]);
  });

  it("a post seen again: its counts updated, its first read kept, new only once", async () => {
    let likes = 10;
    const { radar, ctx, clock } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([tweet(T0 - MIN, "alice_calls", 5000, `CA ${MINT_A} sending`, { likeCount: likes })]));
    assert.equal((await radar.tickCalls()).fresh, 1);
    likes = 90;
    clock.t += 5 * MIN;
    assert.equal((await radar.tickCalls()).fresh, 0);
    const all = rows(ctx);
    assert.equal(all.length, 1);
    assert.deepEqual([all[0]!.likes, all[0]!.seen_at], [90, T0]);
  });

  it("each tick's cost: the tweets returned x $0.00015, one at least (an empty page is billed); logged and kept, no key anywhere", async () => {
    const tweets = [0, 1, 2, 3].map((i) => tweet(T0 - (i + 1) * MIN, `caller_${i}`, 3000, `$AAA sending CA ${MINT_A}`));
    let reply: unknown = page(tweets, true);
    const { radar, ctx, clock } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => reply);
    await radar.tickCalls();
    reply = page([]);
    clock.t += 5 * MIN;
    await radar.tickCalls();
    const lines = radarLines(ctx);
    assert.deepEqual(
      lines.map((l) => [l.lane, l.source, l.ok, l.fetched, l.kept, l.cost_usd]),
      [
        ["calls", "twitterapi", true, 4, 4, 0.0006],
        ["calls", "twitterapi", true, 0, 0, 0.00015],
      ],
    );
    assert.equal(lines[0]!.more, undefined, "a page under 20 tweets has no more");
    const ticks = ctx.db.prepare(`SELECT lane, at, source, ok, fetched, kept, cost_usd FROM tools_ct_ticks ORDER BY at`).all();
    assert.deepEqual(ticks, [
      { lane: "calls", at: T0, source: "twitterapi", ok: 1, fetched: 4, kept: 4, cost_usd: 0.0006 },
      { lane: "calls", at: T0 + 5 * MIN, source: "twitterapi", ok: 1, fetched: 0, kept: 0, cost_usd: 0.00015 },
    ]);
    assert.equal(JSON.stringify(ctx.logs).includes(TAPI_KEY), false, "the key is never logged");
  });

  it("a full page says more were there; a refusal is logged with its status, kept as a failed tick, never thrown", async () => {
    const full = Array.from({ length: 20 }, (_, i) => tweet(T0 - (i + 1) * 10_000, `caller_${i}`, 3000, `aped $AAA CA ${MINT_A}`));
    let status = 200;
    const { radar, ctx, clock } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => (status === 200 ? page(full, true) : new Response(JSON.stringify({ error: "Unauthorized", key: TAPI_KEY }), { status })));
    await radar.tickCalls();
    assert.equal(radarLines(ctx)[0]!.more, true);
    status = 402;
    clock.t += 5 * MIN;
    const r = await radar.tickCalls();
    assert.equal(r.ok, false);
    const line = radarLines(ctx)[1]!;
    assert.deepEqual([line.ok, line.error, line.status], [false, "unavailable", 402]);
    assert.deepEqual(ctx.db.prepare(`SELECT ok, fetched, kept FROM tools_ct_ticks WHERE at = ?`).get(T0 + 5 * MIN), { ok: 0, fetched: 0, kept: 0 });
    assert.equal(JSON.stringify(ctx.logs).includes(TAPI_KEY), false, "nothing the source said is logged");
  });
});

describe("the CT radar's calls feed on Grok (no twitterapi.io key)", () => {
  it("the X search's request on its key, OpenRouter's cost asked for: x_search from twice the beat back, Grok's model", async () => {
    const p = gpost(T0 - 4 * MIN, "bob_calls", `CA: ${MINT_A} aped`);
    const { radar, sent, ctx } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, (x) => (x.url.host === FX ? fxBody(p.url, 2200, p.text) : router({ posts: [p] }, cites([p]))));
    assert.equal(radar.callsSource, "grok");
    assert.equal(radar.cfg.callsMin, 20, "every 20 min on Grok");
    await radar.tickCalls();
    const grok = sent.filter((x) => x.url.host === "openrouter.ai");
    assert.equal(grok.length, 1, "one call to Grok a tick");
    const s = grok[0]!;
    assert.equal(s.url.href, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(s.headers.get("authorization"), `Bearer ${ROUTER_KEY}`);
    assert.equal(s.body!.model, "x-ai/grok-4.3");
    assert.deepEqual(s.body!.usage, { include: true });
    assert.deepEqual(s.body!.plugins, [{ id: "web", engine: "native", max_results: 1, x_search: { from_date: "2026-10-18" } }]);
    assert.match(JSON.stringify(s.body!.messages), /the last 40 minutes/);
    assert.doesNotMatch(JSON.stringify(s.body!.messages), /follower/i, "no floor and no count asked: Grok knows none");
    assert.equal(radarLines(ctx)[0]!.cost_usd, 0.042, "OpenRouter's usage.cost");
    assert.equal(JSON.stringify(ctx.logs).includes(ROUTER_KEY), false);
  });

  it("only the posts its search cited: the made-up one goes, counted as uncited", async () => {
    const real = gpost(T0 - 4 * MIN, "bob_calls", `CA: ${MINT_A} aped`);
    const made = gpost(T0 - 5 * MIN, "made_up_x", `CA: ${MINT_B} sending`);
    const { radar, ctx } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, () => router({ posts: [real, made] }, cites([real])));
    const r = await radar.tickCalls();
    assert.deepEqual(r.dropped, { uncited: 1 });
    assert.deepEqual(rows(ctx).map((x) => [x.handle, x.source]), [["bob_calls", "grok"]]);
    // no citation at all: nothing can be trusted
    const none = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, () => router({ posts: [real] }, []));
    assert.equal((await none.radar.tickCalls()).kept, 0);
    assert.equal(rows(none.ctx).length, 0);
  });

  it("an answer that is not the JSON asked for (cut at max_tokens, or prose) keeps nothing and its log says so", async () => {
    const p = gpost(T0 - 4 * MIN, "bob_calls", `CA: ${MINT_A} aped`);
    const cut = { ...router({}, cites([p])), choices: [{ message: { role: "assistant", content: '{"posts":[{"url":"' + p.url + '","handle":"bob_ca', annotations: cites([p]) } }] };
    const { radar, ctx } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, () => cut);
    assert.equal((await radar.tickCalls()).kept, 0);
    assert.deepEqual([radarLines(ctx)[0]!.ok, radarLines(ctx)[0]!.unreadable], [true, true]);
  });

  it("each cited post read again on FxTwitter (its status API, our own agent): the author's handle and followers, likes, views and whole text over Grok's", async () => {
    const p = gpost(T0 - 4 * MIN, "mixed_caller", "aped this one, CA in the next line…");
    const full = `aped this one\nCA: ${MINT_A}\nsending`;
    const { radar, sent, ctx } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, (s) => (s.url.host === FX ? fxBody(p.url, 1200, full, { handle: "Mixed_Caller" }) : router({ posts: [p] }, cites([p]))));
    const r = await radar.tickCalls();
    assert.deepEqual([r.kept, r.unknown, r.fxFails], [1, 0, 0]);
    const fx = sent.filter((x) => x.url.host === FX);
    assert.deepEqual(fx.map((x) => x.url.pathname), [`/2/status/${idAt(T0 - 4 * MIN)}`]);
    assert.match(fx[0]!.headers.get("user-agent")!, /queen-harness/);
    const [row] = rows(ctx);
    assert.deepEqual([row!.handle, row!.followers, row!.likes, row!.views, JSON.parse(row!.mints)], ["Mixed_Caller", 1200, 77, 12_345, [MINT_A]], "the CA from FxTwitter's whole text; Grok's cut one had none");
    assert.equal(row!.url, `https://x.com/Mixed_Caller/status/${idAt(T0 - 4 * MIN)}`);
    assert.equal(radarLines(ctx)[0]!.fx_fails, 0);
  });

  it("fxPost reads FxTwitter's status as it answers (no code, v2's status), and the links its text's facets expand", () => {
    // the shape of api.fxtwitter.com/2/status/20's answer, cut to what is read
    const live = { status: { type: "status", url: "https://x.com/jack/status/20", id: "20", text: "just setting up my twttr", raw_text: { text: "just setting up my twttr", display_text_range: [0, 24], facets: [] }, author: { screen_name: "jack", followers: 12_537_385 }, replies: 18_095, reposts: 124_616, likes: 309_256, created_at: "Tue Mar 21 20:50:14 +0000 2006", created_timestamp: 1_142_974_214, views: null }, thread: null };
    assert.deepEqual(fxPost(live), { handle: "jack", followers: 12_537_385, likes: 309_256, views: null, at: 1_142_974_214_000, text: "just setting up my twttr", urls: [] });
    const linked = { code: 200, status: { text: "chart", raw_text: { text: "chart https://t.co/x", facets: [{ type: "url", indices: [6, 20], original: "https://t.co/x", replacement: `https://pump.fun/coin/${MINT_A}` }] }, author: { screen_name: "a_x", followers: 5 } } };
    assert.deepEqual(fxPost(linked)!.urls, [`https://pump.fun/coin/${MINT_A}`]);
    assert.equal(fxPost({ code: 404, message: "NOT_FOUND" }), null, "a deleted or private post");
    assert.equal(fxPost({ message: "x" }), null);
  });

  it(`FxTwitter is read ${FX_AT_ONCE} posts at a time`, async () => {
    const posts = Array.from({ length: 12 }, (_, i) => gpost(T0 - (i + 1) * MIN, `caller_${i}`, `aped CA ${MINT_A}`));
    let inFlight = 0;
    let peak = 0;
    const { radar } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, (s) => {
      if (s.url.host !== FX) return router({ posts }, cites(posts));
      inFlight++;
      peak = Math.max(peak, inFlight);
      const p = posts.find((x) => x.url.endsWith(`/${s.url.pathname.split("/").at(-1)}`))!;
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight--;
          resolve(fxBody(p.url, 3000, p.text));
        }, 10),
      );
    });
    assert.equal((await radar.tickCalls()).kept, 12);
    assert.equal(peak, FX_AT_ONCE);
  });

  it("FxTwitter down: the posts kept as Grok gave them, their follower count unknown and marked (none of Grok's), its failures in the tick's line", async () => {
    const a = gpost(T0 - 4 * MIN, "bob_calls", `CA: ${MINT_A} aped`);
    const b = gpost(T0 - 6 * MIN, "carol_calls", `$PNUT sending, CA: ${MINT_A}`);
    const { radar, ctx, t } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, (s) => {
      if (s.url.host !== FX) return router({ posts: [a, b] }, cites([a, b]));
      return s.url.pathname.endsWith(idAt(T0 - 4 * MIN)) ? new Response("upstream down", { status: 503 }) : Promise.reject(new Error("ECONNRESET"));
    });
    const r = await radar.tickCalls();
    assert.deepEqual([r.kept, r.unknown, r.fxFails], [2, 2, 2]);
    assert.deepEqual(
      rows(ctx).map((x) => [x.handle, x.followers, x.likes]),
      [
        ["carol_calls", null, null],
        ["bob_calls", null, null],
      ],
      "Grok's own 5000 followers never kept",
    );
    const line = radarLines(ctx)[0]!;
    assert.deepEqual([line.ok, line.fx_fails, line.unknown_followers], [true, 2, 2]);
    const out = await t.run("ct_calls", {}, { answerId: "fx1" });
    assert.ok(out.ok, JSON.stringify(out));
    const coin = (out.data as { coins: { mint: string; callers: number; reach: number; followers_unknown?: number; first_call: { followers: number | null } }[] }).coins[0]!;
    assert.deepEqual([coin.mint, coin.callers, coin.reach, coin.followers_unknown, coin.first_call.followers], [MINT_A, 2, 0, 2, null]);
  });

  it("the floor after FxTwitter: a known count under it goes, an unknown one is kept", async () => {
    const small = gpost(T0 - 3 * MIN, "small_acct", `CA ${MINT_A} aped`);
    const big = gpost(T0 - 4 * MIN, "big_acct", `CA ${MINT_A} aped`);
    const unread = gpost(T0 - 5 * MIN, "unread_acct", `CA ${MINT_A} aped`);
    const { radar, ctx } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, (s) => {
      if (s.url.host !== FX) return router({ posts: [small, big, unread] }, cites([small, big, unread]));
      if (s.url.pathname.endsWith(idAt(T0 - 3 * MIN))) return fxBody(small.url, 500, small.text);
      if (s.url.pathname.endsWith(idAt(T0 - 4 * MIN))) return fxBody(big.url, 48_000, big.text);
      return { code: 404, message: "NOT_FOUND" };
    });
    const r = await radar.tickCalls();
    assert.deepEqual([r.dropped, r.unknown, r.fxFails], [{ followers: 1 }, 1, 1]);
    assert.deepEqual(
      rows(ctx).map((x) => [x.handle, x.followers]),
      [
        ["unread_acct", null],
        ["big_acct", 48_000],
      ],
    );
  });

  it("Grok's answer read forgivingly: a bare list, a post by its link or its id alone", async () => {
    const id = idAt(T0 - 4 * MIN);
    const content = JSON.stringify([{ link: `https://x.com/bob_calls/status/${id}`, text: `CA ${MINT_A} aped` }, { id: idAt(T0 - 5 * MIN), text: `CA ${MINT_B} sending` }]);
    const reply = { ...router({}, cites([{ url: `https://x.com/bob_calls/status/${id}` }, { url: `https://x.com/i/status/${idAt(T0 - 5 * MIN)}` }])) };
    reply.choices = [{ message: { role: "assistant", content, annotations: reply.choices[0]!.message.annotations } }];
    const { radar, ctx } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, (s) => (s.url.host === FX ? fxBody(s.url.pathname.endsWith(id) ? `https://x.com/bob_calls/status/${id}` : `https://x.com/dana_calls/status/${idAt(T0 - 5 * MIN)}`, 4000, s.url.pathname.endsWith(id) ? `CA ${MINT_A} aped` : `CA ${MINT_B} sending`) : reply));
    assert.equal((await radar.tickCalls()).kept, 2);
    assert.deepEqual(rows(ctx).map((x) => x.handle), ["dana_calls", "bob_calls"], "the handle a bare id lacked, from FxTwitter");
  });

  it("with both keys the calls come from twitterapi.io, every 5 min; TOOLS_CTRADAR_MIN sets the beat", () => {
    const both = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY, TOOLS_XSEARCH_KEY: ROUTER_KEY }, () => page([]));
    assert.deepEqual([both.radar.callsSource, both.radar.cfg.callsMin], ["twitterapi", 5]);
    const set = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY, TOOLS_CTRADAR_MIN: "7" }, () => page([]));
    assert.equal(set.radar.cfg.callsMin, 7);
  });
});

describe("what the radar keeps of a post", () => {
  it("the follower floor (TOOLS_CTRADAR_MIN_FOLLOWERS, 1000): fewer out; an unknown count kept, marked by its null; a floor of 0 keeps any", async () => {
    const tweets = [
      tweet(T0 - MIN, "small_acct", 999, `aped $AAA CA ${MINT_A}`),
      tweet(T0 - 2 * MIN, "no_count", null, `aped $AAA CA ${MINT_A}`),
      tweet(T0 - 3 * MIN, "just_enough", 1000, `aped $AAA CA ${MINT_A}`),
      tweet(T0 - 4 * MIN, "big_acct", 50_000, `aped $AAA CA ${MINT_A}`),
    ];
    const { radar, ctx } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page(tweets));
    const r = await radar.tickCalls();
    assert.deepEqual([r.dropped, r.unknown], [{ followers: 1 }, 1]);
    assert.deepEqual(rows(ctx).map((x) => [x.handle, x.followers]).sort(), [
      ["big_acct", 50_000],
      ["just_enough", 1000],
      ["no_count", null],
    ]);
    const any = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY, TOOLS_CTRADAR_MIN_FOLLOWERS: "0" }, () => page(tweets));
    assert.equal((await any.radar.tickCalls()).kept, 4);
  });

  it("coinsIn: a CA in the text or a launchpad's link, never a pair's link or a wallet's; the majors no ticker; a ticker a call with call words only", () => {
    assert.deepEqual(coinsIn(`$AAA sending 🚀\nCA: ${MINT_A}`), { mints: [MINT_A], tickers: ["AAA"], call: true, otherChain: false });
    assert.deepEqual(coinsIn(`dev wallet: ${WALLET} keeps buying`).mints, [], "a wallet's address is no coin");
    assert.deepEqual(coinsIn(`dev doxxed, CA: ${MINT_A}`).mints, [MINT_A], "a CA named after the dev is the coin");
    assert.deepEqual(coinsIn("chart looks clean", [`https://pump.fun/coin/${MINT_A}`]).mints, [MINT_A]);
    assert.deepEqual(coinsIn(`entry here https://gmgn.ai/sol/token/r3fC0de_${MINT_B}`).mints, [MINT_B], "gmgn's referral prefix aside");
    assert.deepEqual(coinsIn("aped", [`https://jup.ag/swap/SOL-${MINT_B}`]).mints, [MINT_B]);
    assert.deepEqual(coinsIn(`$BBB chart https://dexscreener.com/solana/${PAIR_B}`).mints, [], "a pair's address is no mint");
    assert.deepEqual(coinsIn("So11111111111111111111111111111111111111112 and EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").mints, [], "wrapped SOL and USDC");
    const news = coinsIn("$WIF $SOL $BTC: what the ETF means for the market");
    assert.deepEqual([news.tickers, news.call], [["WIF"], false], "a ticker without call words is no call");
    assert.deepEqual([coinsIn("aped $wif at 2m mc").tickers, coinsIn("aped $wif at 2m mc").call], [["WIF"], true]);
    assert.deepEqual(coinsIn("$WIFUSDT longs loading").tickers, ["WIF"], "an exchange pair as its base");
    assert.deepEqual(coinsIn("$20 entry, $SOL to the moon").tickers, [], "an amount and a major");
  });

  it("another chain's call is out: an EVM address, another chain's page or words, unless it posts a Solana mint", async () => {
    assert.equal(coinsIn(`aped $XYZ 0x${"ab".repeat(20)}`).otherChain, true);
    assert.equal(coinsIn("aped $XYZ", ["https://dexscreener.com/bsc/0xabc"]).otherChain, true);
    assert.equal(coinsIn("aped $XYZ on base, low cap gem").otherChain, true);
    assert.equal(coinsIn(`bridged from base, CA ${MINT_A}`).otherChain, false);
    const { radar } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([tweet(T0 - MIN, "bsc_caller", 9000, "aped $XYZ on bsc, send it")]));
    assert.deepEqual((await radar.tickCalls()).dropped, { other_chain: 1 });
  });

  it("no giveaway, no repeat, no reply or repost, no list of many coins, no post without a coin", async () => {
    const tweets = [
      tweet(T0 - MIN, "gift_acct", 9000, `GIVEAWAY 🎁 $500 of $AAA to 5 winners! Follow + RT and drop your SOL address below. CA ${MINT_A}`),
      tweet(T0 - 2 * MIN, "alice_calls", 9000, `aped $AAA CA ${MINT_A}`),
      tweet(T0 - 2 * MIN, "alice_calls", 9000, `aped $AAA CA ${MINT_A}`, { n: 2 }),
      tweet(T0 - 3 * MIN, "reply_guy", 9000, `CA ${MINT_A} sending`, { isReply: true }),
      tweet(T0 - 4 * MIN, "rt_acct", 9000, `RT CA ${MINT_A}`, { retweeted_tweet: { id: "1" } }),
      tweet(T0 - 5 * MIN, "list_acct", 9000, "my bags, all sending: $AAA $BBB $CCC $DDD $EEE $FFF"),
      tweet(T0 - 6 * MIN, "chatter", 9000, "solana is so back, gm"),
      tweet(T0 - 2 * MIN, "alice_calls", 9000, `aped $AAA, CA ${MINT_A} (edited)`),
    ];
    const { radar, ctx } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page(tweets));
    const r = await radar.tickCalls();
    assert.deepEqual(r.dropped, { reply: 2, spam: 1, repeat: 2, list: 1, no_coin: 1 }, "a repeat by its id or by its words");
    assert.deepEqual(rows(ctx).map((x) => x.handle), ["alice_calls"]);
  });
});

describe("ct_calls: the coins CT calls", () => {
  /** A call as kept, `min` minutes before T0 */
  const call = (min: number, handle: string, followers: number, mints: string[], tickers: string[], likes = 10): CtPost => {
    const id = idAt(T0 - min * MIN);
    return { id, url: `https://x.com/${handle}/status/${id}`, handle, followers, likes, views: 1000, postedAt: T0 - min * MIN, text: "…", mints, tickers, seenAt: T0, source: "twitterapi" };
  };
  const POSTS = [
    call(50, "alice_calls", 5000, [MINT_A], ["AAA"], 20),
    call(40, "bob_calls", 20_000, [MINT_A], [], 30),
    call(30, "carol_calls", 2000, [], ["AAA"], 5),
    call(35, "dave_whale", 100_000, [MINT_B], ["BBB"], 300),
    call(20, "erin_kol", 50_000, [MINT_B], [], 100),
    call(10, "frank_x", 3000, [], ["CCC"], 7),
    call(25, "alice_calls", 5000, [MINT_A], ["AAA"], 15),
    call(15, "gina_x", 4000, [MINT_D1], ["DUP"]),
    call(14, "hank_x", 4000, [MINT_D2], ["DUP"]),
    call(5, "ivan_x", 4000, [], ["DUP"]),
  ];

  it("ranked by distinct callers, then reach; a ticker-only call counts for the one mint posted with that ticker", () => {
    const ranked = rankCoins(coinsOf(POSTS).coins.values(), T0);
    assert.deepEqual(
      ranked.map((r) => [r.mint ?? r.ticker, r.callers, r.reach]),
      [
        [MINT_A, 3, 27_000],
        [MINT_B, 2, 150_000],
        [MINT_D1, 1, 4000],
        [MINT_D2, 1, 4000],
        ["$DUP", 1, 4000],
        ["$CCC", 1, 3000],
      ],
      "a tie goes to the earliest first call",
    );
    const a = ranked[0]!;
    assert.equal(a.ticker, "$AAA");
    assert.deepEqual(a.first_call, { handle: "alice_calls", followers: 5000, at: new Date(T0 - 50 * MIN).toISOString().replace(".000Z", "Z"), url: POSTS[0]!.url });
    assert.deepEqual(
      a.top_callers.map((c) => [c.handle, c.followers]),
      [
        ["bob_calls", 20_000],
        ["alice_calls", 5000],
        ["carol_calls", 2000],
      ],
    );
    assert.deepEqual([a.posts, a.likes, a.minutes_since_first], [4, 70, 50]);
    assert.equal(ranked.find((r) => r.ticker === "$DUP" && !r.mint)!.first_call.handle, "ivan_x", "a ticker two mints share stays its own coin");
  });

  /** The posts above stored as a tick of twitterapi.io would keep them */
  function stocked() {
    const w = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([]));
    const put = w.ctx.db.prepare(`INSERT INTO tools_ct_posts (id, url, handle, followers, likes, views, posted_at, text, mints, tickers, seen_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of POSTS) put.run(p.id, p.url, p.handle, p.followers, p.likes, p.views, p.postedAt, p.text, JSON.stringify(p.mints), JSON.stringify(p.tickers), p.seenAt, p.source);
    w.ctx.db.prepare(`INSERT INTO tools_ct_ticks (lane, at, source, ok, fetched, kept, cost_usd) VALUES ('calls', ?, 'twitterapi', 1, 10, 10, 0.0015)`).run(T0 - 2 * MIN);
    return w;
  }

  it("the tool: the coins in the window, what was read when, their first calls as sources; 1h leaves an older call out", async () => {
    const { t, ctx } = stocked();
    const old = call(90, "old_caller", 7000, [MINT_D1], []);
    ctx.db.prepare(`INSERT INTO tools_ct_posts (id, url, handle, followers, likes, views, posted_at, text, mints, tickers, seen_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(old.id, old.url, old.handle, old.followers, old.likes, old.views, old.postedAt, old.text, JSON.stringify(old.mints), "[]", old.seenAt, old.source);
    const r = await t.run("ct_calls", {}, { answerId: "c1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { window: string; as_of: string; posts_read: number; coins: { mint: string | null; callers: number }[]; more: number };
    assert.deepEqual([d.window, d.as_of, d.posts_read, d.coins.length, d.more], ["6h", "2026-10-18T11:58:00Z", 11, 6, 0]);
    assert.equal(d.coins.find((c) => c.mint === MINT_D1)!.callers, 2, "the 90-minute-old call within 6 h");
    assert.equal(r.sources[0]!.url, POSTS[0]!.url);
    assert.equal(r.sources[0]!.title, "@alice_calls on X");
    const hour = await t.run("ct_calls", { window: "1h" }, { answerId: "c2" });
    assert.ok(hour.ok);
    const h = hour.data as { posts_read: number; coins: { mint: string | null; callers: number }[] };
    assert.deepEqual([h.posts_read, h.coins.find((c) => c.mint === MINT_D1)!.callers], [10, 1]);
    const two = await t.run("ct_calls", { window: "1h", limit: 2 }, { answerId: "c3" });
    assert.ok(two.ok);
    assert.deepEqual([(two.data as { coins: unknown[] }).coins.length, (two.data as { more: number }).more], [2, 4]);
  });

  it("one coin's calls oldest first: by its mint (a ticker-only call marked), by its ticker, a ticker several mints share lists them", async () => {
    const { t } = stocked();
    const byMint = await t.run("ct_calls", { mint: MINT_A }, { answerId: "m1" });
    assert.ok(byMint.ok, JSON.stringify(byMint));
    const d = byMint.data as { mint: string; ticker: string; callers: number; calls: { handle: string; ca: boolean; at: string; url: string }[]; first_call: { handle: string } };
    assert.deepEqual([d.mint, d.ticker, d.callers, d.first_call.handle], [MINT_A, "$AAA", 3, "alice_calls"]);
    assert.deepEqual(
      d.calls.map((c) => [c.handle, c.ca]),
      [
        ["alice_calls", true],
        ["bob_calls", true],
        ["carol_calls", false],
        ["alice_calls", true],
      ],
    );
    assert.ok(d.calls.every((c, i) => i === 0 || c.at >= d.calls[i - 1]!.at), "oldest first");
    assert.deepEqual(byMint.sources.map((s) => s.url).slice(0, 2), [POSTS[0]!.url, POSTS[1]!.url]);
    const byTicker = await t.run("ct_calls", { ticker: "$aaa" }, { answerId: "m2" });
    assert.ok(byTicker.ok);
    assert.equal((byTicker.data as { mint: string }).mint, MINT_A, "the ticker's one mint");
    const dup = await t.run("ct_calls", { ticker: "DUP" }, { answerId: "m3" });
    assert.ok(dup.ok);
    const dd = dup.data as { mint: string | null; mints: { mint: string; posts: number }[]; calls: unknown[] };
    assert.equal(dd.mint, null);
    assert.equal(dd.calls.length, 3);
    assert.deepEqual(dd.mints.map((m) => m.mint).sort(), [MINT_D1, MINT_D2].sort());
    const none = await t.run("ct_calls", { mint: WALLET }, { answerId: "m4" });
    assert.equal(!none.ok && none.error, "not_found");
  });

  it("an old last read says calls since then are missing", async () => {
    const { t, clock } = stocked();
    clock.t = T0 + 30 * MIN;
    const r = await t.run("ct_calls", {}, { answerId: "s1" });
    assert.ok(r.ok);
    assert.match(String((r.data as { stale?: string }).stale), /last read was 32 min ago/);
  });
});

describe("the radar's store and its tool", () => {
  it("3 days kept: an older post is never stored, the stored ones and the ticks go once 3 days old", async () => {
    let tweets: unknown[] = [tweet(T0 - 3 * 24 * 60 * MIN - 60 * MIN, "late_x", 9000, `CA ${MINT_A} aped`), tweet(T0 - 2 * 24 * 60 * MIN, "two_days", 9000, `CA ${MINT_B} aped`)];
    const { radar, ctx, clock } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page(tweets));
    const r = await radar.tickCalls();
    assert.deepEqual(r.dropped, { old: 1 });
    assert.deepEqual(rows(ctx).map((x) => x.handle), ["two_days"]);
    tweets = [];
    clock.t += 36 * 60 * MIN;
    await radar.tickCalls();
    assert.deepEqual(rows(ctx), [], "pruned at 3 days");
    clock.t += 3 * 24 * 60 * MIN + MIN;
    await radar.tickCalls();
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM tools_ct_ticks`).get() as { n: number }).n, 1, "the ticks too");
  });

  it("unavailable before anything is read; offered only with a source key (twitterapi.io's or the X search's), never with TOOLS_CTRADAR=off", async () => {
    const { t } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([]));
    const r = await t.run("ct_calls", {}, { answerId: "u1" });
    assert.deepEqual(r, { ok: false, error: "unavailable", message: "this data is not available right now" });
    const offered = (env: Record<string, string>) => createToolsWith(makeCtx(env), { fetch: async () => new Response("{}"), background: false }).list().some((s) => s.name === "ct_calls");
    assert.equal(offered({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }), true);
    assert.equal(offered({ TOOLS_XSEARCH_KEY: ROUTER_KEY }), true);
    assert.equal(offered({ LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: ROUTER_KEY }), true, "the harness's key on OpenRouter, as the X search takes it");
    assert.equal(offered({}), false);
    assert.equal(offered({ TOOLS_TWITTERAPI_KEY: "short" }), false);
    assert.equal(offered({ TOOLS_TWITTERAPI_KEY: TAPI_KEY, TOOLS_CTRADAR: "off" }), false);
    assert.equal(offered({ TOOLS_XSEARCH_KEY: ROUTER_KEY, TOOLS_XSEARCH: "off" }), false, "no X search, no Grok");
  });

  it("ct_calls is a valid function-calling definition, its description under 600 characters, saying the narratives view, naming no other function", () => {
    for (const floor of ["1000", "0", "2500000"]) {
      const t = createToolsWith(makeCtx({ TOOLS_TWITTERAPI_KEY: TAPI_KEY, TOOLS_XSEARCH_KEY: ROUTER_KEY, TOOLS_CTRADAR_MIN_FOLLOWERS: floor }), { fetch: async () => new Response("{}"), background: false });
      const spec = t.list().find((s) => s.name === "ct_calls")!;
      assert.deepEqual(schemaProblems(spec), []);
      assert.ok(spec.description.length < 600, `${spec.description.length}`);
      assert.match(spec.description, /view narratives: the called coins grouped by our narrative label/);
      for (const other of t.list().filter((s) => s.name !== "ct_calls")) assert.equal(spec.description.includes(other.name), false, other.name);
    }
  });

  it("the collector runs only with background on and ct_calls offered, its first tick 20 s after the start or a beat after the last tick", async () => {
    const fetched: string[] = [];
    const fetch = async (input: string) => {
      fetched.push(input);
      return Response.json(page([]));
    };
    const ctx = makeCtx({ TOOLS_TWITTERAPI_KEY: TAPI_KEY });
    const off = createToolsWith(ctx, { fetch, background: false, now: () => T0 });
    assert.equal(off.ctradar!.running(), false);
    await off.ctradar!.tickCalls();
    const on = createToolsWith(ctx, { fetch, now: () => T0 + MIN });
    assert.equal(on.ctradar!.running(), true);
    assert.equal(on.ctradar!.nextTickAt("calls"), T0 + 5 * MIN, "a restart keeps the beat");
    on.stop();
    assert.equal(on.ctradar!.running(), false);
    const cold = createToolsWith(makeCtx({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }), { fetch, now: () => T0 });
    assert.equal(cold.ctradar!.nextTickAt("calls"), T0 + 20_000);
    cold.stop();
    const disabled = createToolsWith(makeCtx({ TOOLS_TWITTERAPI_KEY: TAPI_KEY, TOOLS_DISABLE: "ct_calls" }), { fetch, now: () => T0 });
    assert.equal(disabled.ctradar!.running(), false, "ct_calls left out (TOOLS_DISABLE): nothing read for no one");
    assert.equal(fetched.length, 1, "only the test's own tick read anything");
  });
});

describe("the CT radar's top calls on Grok", () => {
  it("a run every 30 min on the X search's key whatever reads the feed: the most liked or viewed calls of the last 6 h, in the calls' own format, read on FxTwitter and stored as calls, its tick lane top", async () => {
    const p = gpost(T0 - 3 * 60 * MIN, "big_caller", `the biggest call today: $PNUT, CA ${MINT_A}`);
    const { radar, sent, ctx } = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY, TOOLS_XSEARCH_KEY: ROUTER_KEY }, (s) => (s.url.host === FX ? fxBody(p.url, 250_000, p.text) : router({ posts: [p] }, cites([p]), 0.064)));
    assert.deepEqual([radar.callsSource, radar.cfg.topMin], ["twitterapi", 30], "the feed on twitterapi.io, the top calls on Grok");
    const r = await radar.tickTop();
    assert.deepEqual([r.ok, r.kept, r.fresh, r.fxFails], [true, 1, 1, 0]);
    const grok = sent.filter((x) => x.url.host === "openrouter.ai");
    assert.equal(grok.length, 1, "one call to Grok a run");
    const body = grok[0]!.body!;
    assert.deepEqual(body.plugins, [{ id: "web", engine: "native", max_results: 1, x_search: { from_date: "2026-10-18" } }]);
    assert.deepEqual(body.usage, { include: true });
    const [system, ask] = (body.messages as { content: string }[]).map((m) => m.content);
    assert.match(system!, /\{"posts":\[\{"url":"https:\/\/x\.com\/<handle>\/status\/<id>"/, "the calls' own format");
    assert.match(system!, /the most liked or most viewed first/);
    assert.match(ask!, /the most liked or most viewed posts on x from the last 6 hours that call or shill a solana memecoin/);
    assert.doesNotMatch(system! + ask!, /follower/i);
    assert.deepEqual(rows(ctx).map((x) => [x.handle, x.followers, x.source, JSON.parse(x.mints)]), [["big_caller", 250_000, "grok", [MINT_A]]]);
    assert.deepEqual(ctx.db.prepare(`SELECT lane, source, ok, fetched, kept, cost_usd FROM tools_ct_ticks`).all(), [{ lane: "top", source: "grok", ok: 1, fetched: 1, kept: 1, cost_usd: 0.064 }]);
    const line = radarLines(ctx)[0]!;
    assert.deepEqual([line.lane, line.source, line.ok, line.kept, line.fx_fails, line.cost_usd], ["top", "grok", true, 1, 0, 0.064]);
    assert.equal(sent.some((x) => x.url.host === "api.twitterapi.io"), false, "the feed's source untouched");
  });

  it("its ticks apart from the feed's: each lane its own beat after a restart; a failed run logged as top; no top calls without Grok", async () => {
    const { radar, ctx } = world({ TOOLS_XSEARCH_KEY: ROUTER_KEY }, () => new Response("{}", { status: 502 }));
    assert.equal((await radar.tickTop()).ok, false);
    assert.deepEqual([radarLines(ctx)[0]!.lane, radarLines(ctx)[0]!.status], ["top", 502]);
    assert.deepEqual(ctx.db.prepare(`SELECT lane, ok FROM tools_ct_ticks`).all(), [{ lane: "top", ok: 0 }]);
    const fetch = async () => Response.json(page([]));
    const restart = createToolsWith(ctx, { fetch, now: () => T0 + MIN });
    assert.deepEqual([restart.ctradar!.nextTickAt("top"), restart.ctradar!.nextTickAt("calls")], [T0 + 30 * MIN, T0 + MIN + 20_000], "the top calls a beat after their last run, the feed (never read) 20 s after the start");
    restart.stop();
    const tapi = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([]));
    assert.deepEqual(await tapi.radar.tickTop(), { ok: false, kept: 0, fresh: 0, dropped: {}, unknown: 0, fxFails: null, cost: null });
    assert.equal(tapi.sent.length, 0, "nothing asked");
    const on = createToolsWith(makeCtx({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }), { fetch, now: () => T0 });
    assert.equal(on.ctradar!.nextTickAt("top"), 0, "never scheduled");
    on.stop();
  });

  it("TOOLS_CTRADAR_TOP_MIN sets its beat", () => {
    assert.equal(world({ TOOLS_XSEARCH_KEY: ROUTER_KEY, TOOLS_CTRADAR_TOP_MIN: "45" }, () => ({})).radar.cfg.topMin, 45);
  });
});

describe("ct_calls view narratives: the called coins grouped by our own label of each mint", () => {
  const MINT_C = solKey("ct-mint-c");
  const MINT_E = solKey("ct-mint-e");
  /** A call as kept, `min` minutes before T0 (each its own id) */
  let seq = 0;
  const call = (min: number, handle: string, followers: number | null, mints: string[], tickers: string[] = []): CtPost => {
    const id = idAt(T0 - min * MIN, ++seq);
    return { id, url: `https://x.com/${handle}/status/${id}`, handle, followers, likes: 10, views: 1000, postedAt: T0 - min * MIN, text: "…", mints, tickers, seenAt: T0, source: "twitterapi" };
  };
  const LABELS: Record<string, { narrative: string | null; group: string | null }> = {
    [MINT_A]: { narrative: "squirrel season", group: "animals" },
    [MINT_B]: { narrative: "Squirrel Season", group: "animals" },
    [MINT_C]: { narrative: null, group: "ai agents" },
    [MINT_D1]: { narrative: "oil reserve", group: "macro" },
  };
  const labelOf = (mint: string) => LABELS[mint] ?? null;

  it("grouped by label (its narrative, else its group, any case): coins, distinct callers and reach, first and newest call, heating, steady or fading; the unlabelled last", () => {
    // a 6 h window in thirds: [6 h, 4 h) the first, [2 h, now] the last
    const posts = [
      call(300, "ann", 5000, [MINT_A], ["SQRL"]),
      call(100, "bob", 20_000, [MINT_A], ["SQRL"]),
      call(60, "cat", 1000, [MINT_B], ["NUT"]),
      call(30, "bob", 20_000, [MINT_B], ["NUT"]),
      call(320, "dan", 3000, [MINT_C]),
      call(310, "eve", 4000, [MINT_C]),
      call(20, "fay", null, [MINT_C]),
      call(200, "gus", 9000, [MINT_D1]),
      call(150, "hal", 2000, [MINT_E]),
      call(10, "ivy", 7000, [], ["LOOSE"]),
    ];
    const rows = narrativesFrom(coinsOf(posts).coins.values(), T0, 6 * 60 * MIN, labelOf);
    assert.deepEqual(
      rows.map((r) => [r.narrative, r.group, r.callers, r.reach, r.posts, r.trend]),
      [
        ["squirrel season", "animals", 3, 26_000, 4, "heating"],
        ["ai agents", "ai agents", 3, 7000, 3, "fading"],
        ["oil reserve", "macro", 1, 9000, 1, "steady"],
        [UNLABELLED, null, 2, 9000, 2, "heating"],
      ],
    );
    const sq = rows[0]!;
    assert.deepEqual(
      sq.coins.map((c) => [c.mint, c.ticker, c.callers]),
      [
        [MINT_A, "$SQRL", 2],
        [MINT_B, "$NUT", 2],
      ],
    );
    assert.deepEqual([sq.first_call.handle, sq.newest_call.handle], ["ann", "bob"]);
    assert.equal(rows[1]!.followers_unknown, 1, "a caller whose count is not known");
    assert.deepEqual(rows[3]!.coins.map((c) => c.mint ?? c.ticker).sort(), [MINT_E, "$LOOSE"].sort(), "no label, and a ticker never posted with a mint");
    assert.deepEqual(narrativesFrom(coinsOf(posts).coins.values(), T0, 6 * 60 * MIN, undefined).map((r) => r.narrative), [UNLABELLED], "no labels at all: one group");
  });

  /** The services' files (the pump.fun index's db.json), as free/narratives.ts reads them */
  function services(): string {
    const dir = mkdtempSync(join(tmpdir(), "ctradar-narr-"));
    mkdirSync(join(dir, "migration/data"), { recursive: true });
    writeFileSync(
      join(dir, "migration/data/db.json"),
      JSON.stringify({ tokens: { [MINT_A]: { mint: MINT_A, analysis: { card: { narrative: "squirrel season", group: "animals" } } }, [MINT_B]: { mint: MINT_B, analysis: { light: { narrative: "squirrel season", group: "animals" } } }, [MINT_C]: { mint: MINT_C, analysis: { card: { narrative: "ai agents", group: "ai" } } } } }),
    );
    return dir;
  }

  it("the tool: our pump.fun index's card of each coin (fc.narrativeOf, narratives.ts); the calls and a coin's carry the label too", async () => {
    const w = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY, NARRATIVE_DIR: services() }, () => page([]));
    const put = w.ctx.db.prepare(`INSERT INTO tools_ct_posts (id, url, handle, followers, likes, views, posted_at, text, mints, tickers, seen_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of [call(300, "ann", 5000, [MINT_A]), call(30, "bob", 20_000, [MINT_B]), call(20, "cat", 1000, [MINT_B]), call(200, "dan", 3000, [MINT_C]), call(100, "eve", 2000, [MINT_E])])
      put.run(p.id, p.url, p.handle, p.followers, p.likes, p.views, p.postedAt, p.text, JSON.stringify(p.mints), JSON.stringify(p.tickers), p.seenAt, p.source);
    // the services' files read once, as any of their tools reads them
    await w.t.run("meme_narrative", { mint: MINT_A }, { answerId: "warm" });
    const r = await w.t.run("ct_calls", { view: "narratives" }, { answerId: "nv1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { window: string; posts_read: number; narratives: { narrative: string; group: string | null; callers: number; trend: string }[]; note: string };
    assert.deepEqual([d.window, d.posts_read], ["6h", 5]);
    assert.deepEqual(
      d.narratives.map((n) => [n.narrative, n.group, n.callers, n.trend]),
      [
        ["squirrel season", "animals", 3, "heating"],
        ["ai agents", "ai", 1, "steady"],
        [UNLABELLED, null, 1, "heating"],
      ],
      "a call 3 h 20 min old is the window's middle third: steady; 100 min old its last: heating",
    );
    assert.match(d.note, /grouped by our own narrative label/);
    assert.equal(r.sources[0]!.title, "@ann on X");
    const one = await w.t.run("ct_calls", { view: "narratives", mint: MINT_C }, { answerId: "nv2" });
    assert.ok(one.ok);
    assert.deepEqual((one.data as { narratives: { narrative: string }[] }).narratives.map((n) => n.narrative), ["ai agents"], "a coin asked: its narrative alone");
    const calls = await w.t.run("ct_calls", {}, { answerId: "nv3" });
    assert.ok(calls.ok);
    const coins = (calls.data as { coins: { mint: string; narrative?: string }[] }).coins;
    assert.deepEqual(coins.map((c) => [c.mint, c.narrative ?? null]).sort(), [
      [MINT_A, "squirrel season"],
      [MINT_B, "squirrel season"],
      [MINT_C, "ai agents"],
      [MINT_E, null],
    ].sort());
    const coin = await w.t.run("ct_calls", { mint: MINT_C }, { answerId: "nv4" });
    assert.ok(coin.ok);
    assert.equal((coin.data as { narrative?: string }).narrative, "ai agents");
  });

  it("unavailable before anything is read; with no services' files every coin is unlabelled", async () => {
    const none = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([]));
    assert.deepEqual(await none.t.run("ct_calls", { view: "narratives" }, { answerId: "u1" }), { ok: false, error: "unavailable", message: "this data is not available right now" });
    const w = world({ TOOLS_TWITTERAPI_KEY: TAPI_KEY }, () => page([tweet(T0 - 5 * MIN, "alice_calls", 5000, `aped CA ${MINT_A}`)]));
    await w.radar.tickCalls();
    const r = await w.t.run("ct_calls", { view: "narratives" }, { answerId: "u2" });
    assert.ok(r.ok);
    assert.deepEqual((r.data as { narratives: { narrative: string; coins: unknown[] }[] }).narratives.map((n) => [n.narrative, n.coins.length]), [[UNLABELLED, 1]]);
  });
});
