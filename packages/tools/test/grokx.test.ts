// The X search on Grok through OpenRouter (src/free/grokx.ts): social_mentions as a free tool, its request (Grok, the
// web plugin's x_search, a week back), only the posts its search cited, the floors and the cleaning, one attempt, the
// daily cap, the key.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citedIds, postsOf, splitDates } from "../src/free/grokx.ts";
import { dayBefore } from "../src/free/xposts.ts";
import { createToolsWith } from "../src/registry.ts";
import { makeCtx } from "./helpers.ts";

const KEY = "sk-or-v1-test-0123456789abcdef";
const post = (handle: string, id: string, text: string, likes: number, followers = 5000, views = 9000) => ({ url: `https://x.com/${handle}/status/${id}`, handle, followers, text, likes, reposts: 1, views, at: "2026-10-16T10:00:00Z" });
const POSTS = [
  post("wif_holder_x", "1110000000000000001", "Held $WIF since 2023, still here", 5500),
  post("perp_venue_x", "1110000000000000002", "You can now long or short $WIF here", 480),
  post("gift_acct_one", "1110000000000000003", "GIVEAWAY 🎁 $500 in $WIF to 5 winners! Follow + RT and drop your SOL address below", 310),
  post("low_likes_x", "1110000000000000004", "$WIF looks heavy today", 3),
  post("made_up_x", "1110000000000000099", "a post the search never returned", 9000),
];
const cites = (ids: string[]) => ids.map((id) => ({ type: "url_citation", url_citation: { url: `https://x.com/someone/status/${id}`, title: "post" } }));

function routerReply(posts: unknown[], cited: string[]) {
  return { id: "gen-1", model: "x-ai/grok-4.3", choices: [{ message: { role: "assistant", content: "```json\n" + JSON.stringify({ posts }) + "\n```", annotations: cites(cited) } }], usage: { cost: 0.031 } };
}

function world(env: Record<string, string> = {}, reply: (body: Record<string, unknown>) => unknown = () => routerReply(POSTS, ["1110000000000000001", "1110000000000000002", "1110000000000000003", "1110000000000000004"])) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: input, body, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(reply(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const t = createToolsWith(makeCtx({ TOOLS_XSEARCH_KEY: KEY, ...env }), { fetch, background: false });
  return { t, calls };
}

describe("the X search on Grok (free/grokx.ts)", () => {
  it("social_mentions is ours when a key is set: free, slow, Top and 20 likes by default; none without a key", () => {
    const { t } = world();
    const spec = t.list().find((s) => s.name === "social_mentions");
    assert.ok(spec, "offered");
    assert.deepEqual([spec!.parameters.properties.sort!.default, spec!.parameters.properties.min_likes!.default], ["Top", 20]);
    const off = createToolsWith(makeCtx({}), { fetch: async () => new Response("{}"), background: false });
    assert.equal(off.list().some((s) => s.name === "social_mentions"), false);
    const offed = createToolsWith(makeCtx({ TOOLS_XSEARCH_KEY: KEY, TOOLS_XSEARCH: "off" }), { fetch: async () => new Response("{}"), background: false });
    assert.equal(offed.list().some((s) => s.name === "social_mentions"), false);
  });

  it("asks Grok once through OpenRouter: the web plugin's x_search a week back, the query's words, its key", async () => {
    const { t, calls } = world();
    const r = await t.run("social_mentions", { query: "$WIF dogwifhat" }, { answerId: "a1" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(calls.length, 1, "one attempt");
    const c = calls[0]!;
    assert.equal(c.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(c.auth, `Bearer ${KEY}`);
    assert.equal(c.body.model, "x-ai/grok-4.3");
    const plugin = (c.body.plugins as Record<string, any>[])[0]!;
    assert.equal(plugin.id, "web");
    assert.equal(plugin.x_search.from_date, dayBefore(Date.now(), 7));
    assert.match(JSON.stringify(c.body.messages), /posts on x about: \$WIF dogwifhat/);
  });

  it("keeps only the posts its search cited, within the floors, no giveaway: the most liked first, as a table", async () => {
    const { t } = world();
    const r = await t.run("social_mentions", { query: "$WIF" }, { answerId: "a2" });
    assert.ok(r.ok);
    const d = r.data as { columns: string[]; rows: unknown[][]; rows_shown: number; spam_dropped?: number };
    assert.deepEqual(d.columns, ["handle", "followers", "text", "likes", "views", "at", "link"]);
    assert.deepEqual(
      d.rows.map((x) => x[0]),
      ["wif_holder_x", "perp_venue_x"],
      "the made-up post (never cited), the 3-like post (under 20) and the giveaway go",
    );
    assert.equal(d.spam_dropped, 1);
    assert.equal(d.rows[0]![6], "https://x.com/wif_holder_x/status/1110000000000000001");
    assert.ok(r.sources.some((s) => s.url === "https://x.com/wif_holder_x/status/1110000000000000001"));
  });

  it("nothing cited, nothing kept: no rows; the query's own dates are the search's", async () => {
    const { t, calls } = world({}, () => routerReply(POSTS, []));
    const r = await t.run("social_mentions", { query: "$BONK since:2026-10-01 until:2026-10-10", sort: "Latest", min_likes: 0 }, { answerId: "a3" });
    assert.ok(r.ok);
    assert.deepEqual((r.data as { rows: unknown[] }).rows, []);
    const plugin = (calls[0]!.body.plugins as Record<string, any>[])[0]!;
    assert.deepEqual(plugin.x_search, { from_date: "2026-10-01", to_date: "2026-10-10" });
    assert.match(JSON.stringify(calls[0]!.body.messages), /about: \$BONK\\nfrom 2026-10-01 to 2026-10-10; the newest first; at least 0 likes/);
  });

  it("the daily cap (TOOLS_XSEARCH_DAILY_CALLS): past it, rate_limited and nothing sent", async () => {
    const { t, calls } = world({ TOOLS_XSEARCH_DAILY_CALLS: "1" });
    assert.ok((await t.run("social_mentions", { query: "$WIF" }, { answerId: "b1" })).ok);
    const second = await t.run("social_mentions", { query: "$BONK" }, { answerId: "b2" });
    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.error, "rate_limited");
    assert.equal(calls.length, 1);
  });

  it("the key: TOOLS_XSEARCH_KEY, else the queen's when she is on OpenRouter, never a key meant for another host", () => {
    const fetch = async () => new Response("{}");
    const viaQueen = createToolsWith(makeCtx({ LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: KEY }), { fetch, background: false });
    assert.equal(viaQueen.config.xSearch?.key, KEY);
    const elsewhere = createToolsWith(makeCtx({ LLM_BASE_URL: "https://llm.example.com/v1", LLM_API_KEY: KEY }), { fetch, background: false });
    assert.equal(elsewhere.config.xSearch, null);
  });

  it("splitDates, citedIds and postsOf on their own", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    assert.deepEqual(splitDates("$WIF since:2026-10-01", now), { words: "$WIF", from: "2026-10-01", to: null });
    assert.deepEqual(splitDates("dogwifhat", now), { words: "dogwifhat", from: "2026-10-10", to: null });
    assert.equal(citedIds({ content: "x" }), null, "no annotations: nothing can be trusted");
    assert.deepEqual([...citedIds({ annotations: [...cites(["123456789012"]), { type: "url_citation", url_citation: { url: "https://example.com/a" } }] })!], ["123456789012"]);
    assert.deepEqual(postsOf({ posts: [post("a_x", "123456789012", "gm", 50)] }, null, { likes: 0, followers: 0 }), [], "no citations at all: no post kept");
  });
});
