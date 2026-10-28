// The web search on Grok through OpenRouter (src/free/grokweb.ts): news_pages as a free tool, offered only with a key,
// its request (Grok, the web plugin's native search with no x_search, one attempt, never hedged), only the pages its
// search cited, the daily cap, not_found when no page is left. The fakes answer in OpenRouter's shape for the X search:
// the content JSON (fenced), the citations as url_citation annotations. Pages, project and news are made up.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb, type Db } from "@crawlnet/shared";
import { citedPages, dateOf, pageKey, pagesOf } from "../src/free/grokweb.ts";
import { createToolsWith, toolsHedge, XSEARCH_HEDGE } from "../src/registry.ts";
import { makeCtx } from "./helpers.ts";

const KEY = "sk-or-v1-test-0123456789abcdef";
const NOW = Date.parse("2026-10-17T12:00:00Z");

const PAGE_A = "https://www.news-one.example.com/post/371234/dao-buyback-vote";
const PAGE_B = "https://news-two.example.com/350001/airdrop-season-three";
const PAGE_C = "https://news-three.example.com/news/perps-volume";
const PAGE_D = "https://www.news-four.example.com/tech/2026/10/14/second-client-live";
const MADE_UP = "https://exf-airdrop-news.example.com/claim-now";

/** Grok's JSON answer: a summary and the pages it says it read */
const ANSWER = {
  summary: `Examplefi's DAO passed an EXF buyback and a third airdrop season is confirmed [[1]](${PAGE_A}).`,
  results: [
    { url: PAGE_A, title: "EXF buyback passes", snippet: `The DAO voted to route half of the fees to EXF buybacks [[1]](${PAGE_A}) ([details](https://made-up.example.com/x)).`, date: "2026-10-16" },
    // written without its scheme and with a trailing slash: the citation's own link is the one kept
    { url: "news-two.example.com/350001/airdrop-season-three/", title: "Airdrop season three", snippet: "Examplefi confirmed a third airdrop season.", date: "2026-10-15T09:30:00Z" },
    // never cited: a link it made up
    { url: MADE_UP, title: "Claim your EXF now", snippet: "a page the search never returned", date: "2026-10-17" },
    // the first page again, with a tag
    { url: `${PAGE_A}?utm_source=grok`, title: "again", snippet: "again", date: "2026-10-16" },
    // dated next year: no date
    { url: PAGE_C, title: "Examplefi perps volume", snippet: "Perps volume hit $2B in a day.", date: "2027-01-01" },
  ],
};

const cite = (url: string, title: string, content = "") => ({ type: "url_citation", url_citation: { url, title, content, start_index: 0, end_index: 10 } });
/** What its search cited: the first page with a tracking tag, a bare number and a host for titles, a page it did not list */
const CITES = [
  cite(`${PAGE_A}?utm_source=openrouter`, "Examplefi DAO votes to buy back EXF | News One", "Examplefi DAO approved..."),
  cite(PAGE_B, "1"),
  cite(`${PAGE_C}#top`, "news-three.example.com", "Perps on Examplefi..."),
  cite(PAGE_D, "A second client goes live on mainnet", "The second client..."),
];

/** OpenRouter's answer: Grok's content and the citations (null: no annotations at all) */
function routerReply(content: unknown, annotations: unknown[] | null = CITES) {
  const text = typeof content === "string" ? content : "```json\n" + JSON.stringify(content) + "\n```";
  return { id: "gen-1", model: "x-ai/grok-4.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: text, ...(annotations ? { annotations } : {}) } }], usage: { cost: 0.021 } };
}

function world(env: Record<string, string> = {}, reply: (body: Record<string, unknown>) => unknown = () => routerReply(ANSWER), db: Db = openDb(":memory:")) {
  const calls: { url: string; body: Record<string, unknown>; raw: string; auth: string | null }[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = String(init?.body ?? "{}");
    calls.push({ url: input, body: JSON.parse(raw) as Record<string, unknown>, raw, auth: new Headers(init?.headers).get("authorization") });
    const r = reply(JSON.parse(raw) as Record<string, unknown>);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  const t = createToolsWith(makeCtx({ TOOLS_XSEARCH_KEY: KEY, ...env }, db), { fetch, background: false, now: () => NOW });
  return { t, calls, db };
}

interface Page {
  title: string;
  link: string;
  snippet: string | null;
  date: string | null;
}
const pagesIn = (r: { ok: boolean; data?: unknown }) => (r.data as { results: Page[] }).results;

describe("the web search on Grok (free/grokweb.ts)", () => {
  it("news_pages only with a key: free, its arguments (query, max_results 3-20 default 6, topic); none without one", () => {
    const { t } = world();
    const spec = t.list().find((s) => s.name === "news_pages");
    assert.ok(spec, "offered");
    const p = spec!.parameters;
    assert.deepEqual(p.required, ["query"]);
    assert.deepEqual([p.properties.max_results!.minimum, p.properties.max_results!.maximum, p.properties.max_results!.default], [3, 20, 6]);
    assert.deepEqual(p.properties.topic!.enum, ["general", "news", "crypto", "finance"]);
    assert.equal(p.properties.topic!.default, "general");

    const fetch = async () => new Response("{}");
    const none = createToolsWith(makeCtx({}), { fetch, background: false });
    assert.equal(none.config.news, null);
    assert.equal(none.list().some((s) => s.name === "news_pages"), false, "no key: not offered");
    const off = createToolsWith(makeCtx({ TOOLS_XSEARCH_KEY: KEY, TOOLS_NEWS: "off" }), { fetch, background: false });
    assert.equal(off.list().some((s) => s.name === "news_pages"), false, "TOOLS_NEWS=off");
    assert.equal(off.list().some((s) => s.name === "social_mentions"), true, "the X search apart");
    const viaQueen = createToolsWith(makeCtx({ LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: KEY }), { fetch, background: false });
    assert.equal(viaQueen.config.news?.key, KEY, "the queen's key when she is on OpenRouter");
    const elsewhere = createToolsWith(makeCtx({ LLM_BASE_URL: "https://llm.example.com/v1", LLM_API_KEY: KEY }), { fetch, background: false });
    assert.equal(elsewhere.config.news, null, "never a key meant for another host");
  });

  it("asks Grok once through OpenRouter: the web plugin's native search, no x_search, JSON at temperature 0, never hedged", async () => {
    const { t, calls } = world();
    const r = await t.run("news_pages", { query: "examplefi  exf\nbuyback", max_results: 5, topic: "news" }, { answerId: "a1" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(calls.length, 1, "one attempt");
    const c = calls[0]!;
    assert.equal(c.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(c.auth, `Bearer ${KEY}`);
    assert.equal(c.body.model, "x-ai/grok-4.3");
    assert.equal(c.body.temperature, 0);
    assert.deepEqual(c.body.response_format, { type: "json_object" });
    assert.deepEqual(c.body.plugins, [{ id: "web", engine: "native", max_results: 5 }], "web pages only");
    assert.doesNotMatch(c.raw, /x_search/);
    const user = (c.body.messages as { role: string; content: string }[]).find((m) => m.role === "user")!.content;
    assert.match(user, /^web pages about: examplefi exf buyback\nwhat kind: news articles and reports, the newest first; at most 5 results; today is 2026-10-17\.$/);
    // the process-wide fetch sends a request to OpenRouter once, never a second leg (registry.ts toolsHedge)
    assert.deepEqual(toolsHedge(new URL(c.url).host, c.raw, { limiter: () => undefined }), { ...XSEARCH_HEDGE });
    assert.equal(XSEARCH_HEDGE.waves, 1);

    // defaults: 6 results, any page
    await t.run("news_pages", { query: "solana second client" }, { answerId: "a2" });
    assert.deepEqual(calls[1]!.body.plugins, [{ id: "web", engine: "native", max_results: 6 }]);
    assert.match(JSON.stringify(calls[1]!.body.messages), /what kind: any page/);

    // a failed request is not sent again
    const failing = world({}, () => new Response("upstream error", { status: 502 }));
    const bad = await failing.t.run("news_pages", { query: "examplefi" }, { answerId: "a3" });
    assert.equal(!bad.ok && bad.error, "unavailable");
    assert.equal(failing.calls.length, 1);
  });

  it("keeps only the pages its search cited: the made-up link and the repeat go, each linked as its citation, no link in any text", async () => {
    const { t } = world();
    const r = await t.run("news_pages", { query: "examplefi" }, { answerId: "b1" });
    assert.ok(r.ok, JSON.stringify(r));
    const pages = pagesIn(r);
    assert.deepEqual(
      pages.map((p) => p.link),
      [PAGE_A, PAGE_B, PAGE_C],
      "the uncited page goes, the repeat goes, the cited page it did not list is not added; tracking tag and fragment dropped",
    );
    assert.deepEqual(pages[0], { title: "Examplefi DAO votes to buy back EXF | News One", link: PAGE_A, snippet: "The DAO voted to route half of the fees to EXF buybacks (details).", date: "2026-10-16" });
    assert.equal(pages[1]!.title, "Airdrop season three", "a citation titled by a number: its own title");
    assert.equal(pages[1]!.date, "2026-10-15");
    assert.equal(pages[2]!.title, "Examplefi perps volume", "a citation titled by its host: its own title");
    assert.equal(pages[2]!.date, null, "a date next year is none");
    assert.equal((r.data as { summary?: string }).summary, "Examplefi's DAO passed an EXF buyback and a third airdrop season is confirmed.");
    const all = JSON.stringify(r);
    assert.doesNotMatch(all, /made-up|exf-airdrop-news|utm_|#top/);
    assert.deepEqual(
      r.sources,
      pages.map((p) => ({ title: p.title, url: p.link })),
      "its sources are the pages kept, web pages as found",
    );
  });

  it("a page on a redacted host goes whole, its source too", async () => {
    const answer = { summary: "", results: [{ url: "https://news.acmedata.io/exf", title: "EXF", snippet: "exf", date: null }, ...ANSWER.results] };
    const { t } = world({ TOOLS_REDACT_TERMS: "acmedata" }, () => routerReply(answer, [cite("https://news.acmedata.io/exf", "EXF"), ...CITES]));
    const r = await t.run("news_pages", { query: "examplefi" }, { answerId: "b2" });
    assert.ok(r.ok);
    assert.deepEqual(pagesIn(r).map((p) => p.link), [PAGE_A, PAGE_B, PAGE_C]);
    assert.doesNotMatch(JSON.stringify(r), /acmedata/);
  });

  it("an answer that is not the JSON asked for, or lists no cited page: the cited pages themselves", async () => {
    const prose = world({}, () => routerReply(`Examplefi's DAO passed a buyback [[1]](${PAGE_A}); see ${MADE_UP}.`));
    const r = await prose.t.run("news_pages", { query: "examplefi", max_results: 3 }, { answerId: "c1" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(pagesIn(r), [
      { title: "Examplefi DAO votes to buy back EXF | News One", link: PAGE_A, snippet: "Examplefi DAO approved...", date: null },
      { title: "news-two.example.com", link: PAGE_B, snippet: null, date: null },
      { title: "news-three.example.com", link: PAGE_C, snippet: "Perps on Examplefi...", date: null },
    ]);
    assert.equal((r.data as { summary?: string }).summary, "Examplefi's DAO passed a buyback; see.", "its prose is the summary, without links");

    const cut = world({}, () => routerReply('{"summary":"Examplefi","results":[{"url":"https://www.news-one.example.com/po'));
    const c = await cut.t.run("news_pages", { query: "examplefi" }, { answerId: "c2" });
    assert.ok(c.ok);
    assert.equal(pagesIn(c).length, 4, "a cut answer: every cited page");
    assert.equal((c.data as { summary?: string }).summary, undefined, "no summary from a cut answer");

    const strays = world({}, () => routerReply({ summary: "x", results: [{ url: MADE_UP, title: "made up", snippet: "made up", date: null }] }));
    const s = await strays.t.run("news_pages", { query: "examplefi" }, { answerId: "c3" });
    assert.ok(s.ok);
    assert.deepEqual(pagesIn(s).map((p) => p.link), [PAGE_A, PAGE_B, PAGE_C, PAGE_D], "no link of its own cited: the cited pages, never its own");
  });

  it("not_found when no page is left: nothing cited, no citations at all, or it said it found nothing", async () => {
    for (const [why, reply] of [
      ["nothing cited", () => routerReply(ANSWER, [])],
      ["no annotations", () => routerReply(ANSWER, null)],
      ["it found nothing", () => routerReply({ summary: "", results: [] })],
    ] as const) {
      const { t, calls } = world({}, reply);
      const r = await t.run("news_pages", { query: "examplecoin v2 launch" }, { answerId: `d-${why}` });
      assert.equal(r.ok, false, why);
      assert.equal(!r.ok && r.error, "not_found", why);
      assert.equal(calls.length, 1, why);
    }
  });

  it("the daily cap (TOOLS_NEWS_DAILY_CALLS) in tools_usage.news_calls, apart from the X search's: past it, rate_limited and nothing sent", async () => {
    const db = openDb(":memory:");
    const env = { TOOLS_NEWS_DAILY_CALLS: "1", TOOLS_XSEARCH_DAILY_CALLS: "0" };
    const { t, calls } = world(env, undefined, db);
    assert.ok((await t.run("news_pages", { query: "examplefi" }, { answerId: "e1" })).ok, "the X search's cap is its own");
    const second = await t.run("news_pages", { query: "solana" }, { answerId: "e2" });
    assert.equal(!second.ok && second.error, "rate_limited");
    assert.equal(calls.length, 1);
    assert.deepEqual(db.prepare(`SELECT day, news_calls, xsearch_calls FROM tools_usage`).all(), [{ day: "2026-10-17", news_calls: 1, xsearch_calls: 0 }]);
    const restarted = world(env, undefined, db);
    const third = await restarted.t.run("news_pages", { query: "bonk" }, { answerId: "e3" });
    assert.equal(!third.ok && third.error, "rate_limited", "the day's count survives a restart");
    assert.equal(restarted.calls.length, 0);
  });

  it("pageKey, citedPages, dateOf and pagesOf on their own", () => {
    assert.equal(pageKey("https://www.news-one.example.com/post/1/?utm_source=x&b=2&a=1#top"), "news-one.example.com/post/1?a=1&b=2");
    assert.equal(pageKey("news-one.example.com/post/1"), pageKey("http://news-one.example.com/post/1/"));
    assert.equal(pageKey("https://example.com/caf%C3%A9"), pageKey("https://example.com/café"));
    assert.equal(pageKey("javascript:alert(1)"), null);
    assert.equal(pageKey("http://127.0.0.1:8080/admin"), null);
    assert.equal(citedPages({ content: "x" }), null, "no annotations: nothing can be trusted");
    const cited = citedPages({ annotations: [...CITES, { type: "url_citation", url_citation: { url: "http://localhost/x" } }, { type: "file" }] })!;
    assert.deepEqual([...cited.values()].map((c) => c.link), [PAGE_A, PAGE_B, PAGE_C, PAGE_D]);
    assert.equal(dateOf("2026-10-16", NOW), "2026-10-16");
    assert.equal(dateOf("2026-10-18T06:00:00Z", NOW), "2026-10-18", "tomorrow (time zones) is a date");
    assert.equal(dateOf("2026-10-20", NOW), null);
    assert.equal(dateOf("October 16, 2026", NOW), null);
    assert.equal(dateOf(null, NOW), null);
    assert.deepEqual(pagesOf(ANSWER, null, 10, NOW), [], "no citations at all: no page kept");
    assert.equal(pagesOf(ANSWER, cited, 2, NOW).length, 2, "at most max");
  });
});
