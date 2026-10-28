// The larp check's reads (src/free/larp.ts): a token's own links from pump.fun and DexScreener with the github links
// and x handles in them; a repository's record; a domain's age from its registry's RDAP server (IANA's list), its first
// certificate and its first archive capture.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { githubRef, lastPage, postTime, siteDomain, xHandleOf } from "../src/free/larp.ts";
import { createToolsWith } from "../src/registry.ts";
import { makeCtx, solKey, tableFetch } from "./helpers.ts";

const MINT = solKey("larp-coin");
const NOW = Date.parse("2026-10-19T14:00:00Z");
const tools = (table: Parameters<typeof tableFetch>[0]) => {
  const t = tableFetch(table);
  return { tools: createToolsWith(makeCtx({}), { fetch: t.fetch, background: false, now: () => NOW }), urls: t.urls };
};
const withHeaders = (body: unknown, headers: Record<string, string>) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
/** A post's id on x made at `ms` (its id carries its time) */
const idAt = (ms: number) => ((BigInt(ms) - 1288834974657n) << 22n).toString();

describe("larp reads (free/larp.ts)", () => {
  it("siteDomain, githubRef and lastPage", () => {
    assert.equal(siteDomain("https://app.larp-coin.example/x?y"), "larp-coin.example");
    assert.equal(siteDomain("www.example.co.uk"), "example.co.uk");
    assert.equal(siteDomain("https://x.com/larpcoin_x"), null, "a social network is no project site");
    assert.equal(siteDomain("https://pump.fun/coin/abc"), null);
    assert.deepEqual(githubRef("https://github.com/elizaOS/eliza.git"), { owner: "elizaOS", repo: "eliza" });
    assert.deepEqual(githubRef("github.com/someone"), { owner: "someone", repo: null });
    assert.equal(githubRef("https://github.com/orgs/x"), null);
    assert.equal(lastPage('<https://api.github.com/repositories/1/commits?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/commits?per_page=1&page=4210>; rel="last"'), 4210);
    assert.equal(lastPage(null), null);
    assert.equal(postTime(idAt(Date.parse("2026-10-19T11:00:00Z"))), Date.parse("2026-10-19T11:00:00Z"));
    assert.equal(postTime("20"), null, "an id from before x dated its ids");
    assert.deepEqual(["https://x.com/larpcoin_x", "@larpcoin_x", "larpcoin_x", "https://x.com/i/status/1"].map(xHandleOf), ["larpcoin_x", "larpcoin_x", "larpcoin_x", null]);
  });

  it("project_links: the story's own posts on x, dated by their ids against the launch and read again (one gone); a post's author is no account of the coin's", async () => {
    const launch = Date.parse("2026-10-19T12:10:10Z");
    const said = idAt(Date.parse("2026-10-19T11:00:00Z"));
    const gone = idAt(Date.parse("2026-10-19T12:30:00Z"));
    const { tools: t } = tools({
      [`https://frontend-api-v3.pump.fun/coins-v2/${MINT}`]: { mint: MINT, name: "larp coin", symbol: "LARP", description: `the post: https://x.com/someone/status/${gone}`, twitter: `https://x.com/big_acct/status/${said}`, website: "https://larp-coin.example/", created_timestamp: launch },
      [`https://api.fxtwitter.com/2/status/${said}`]: { code: 200, status: { text: "big things are coming", likes: 50000, views: 9000000, created_timestamp: Math.floor(Date.parse("2026-10-19T11:00:00Z") / 1000), author: { screen_name: "big_acct", followers: 2000000 } } },
      [`https://api.fxtwitter.com/2/status/${gone}`]: { code: 404, status: null },
    });
    const r = await t.run("project_links", { mint: MINT }, { answerId: "l4" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.deepEqual(d.x_handles, [], "a post's author is not the coin's x account");
    assert.equal(d.x_posts.length, 2);
    assert.deepEqual([d.x_posts[0].posted_at, d.x_posts[0].minutes_before_launch, d.x_posts[0].by, d.x_posts[0].text], ["2026-10-19T11:00:00.000Z", 70, "big_acct", "big things are coming"]);
    assert.equal(d.x_posts[1].minutes_before_launch, -20, "posted after the launch");
    assert.match(d.x_posts[1].gone, /deleted/);
  });

  it("project_links: its telegram's page (a bot's monthly users, a channel's subscribers) and Virtuals' agent registry by its address; x handles once whatever their case", async () => {
    const bot = `<div class="tgme_page_title" dir="auto"><span dir="auto">LarpCoin Bot</span><i class="verified-icon"> ✔</i></div><div class="tgme_page_extra">\n  @larpcoin_bot\n</div><div class="tgme_page_extra">1 234 monthly users</div><div class="tgme_page_description" dir="auto">runs your <b>render</b> jobs</div>`;
    const { tools: t } = tools({
      [`https://frontend-api-v3.pump.fun/coins-v2/${MINT}`]: { mint: MINT, name: "larpcoin", symbol: "LARP", description: "", twitter: "https://x.com/LarpCoin_X", telegram: "https://t.me/larpcoin_bot", created_timestamp: Date.parse("2026-10-19T12:10:10Z") },
      [`https://api.dexscreener.com/tokens/v1/solana/${MINT}`]: [{ info: { socials: [{ type: "twitter", url: "https://x.com/larpcoin_x" }] } }],
      "https://t.me/larpcoin_bot": () => new Response(bot, { status: 200, headers: { "content-type": "text/html" } }),
      "https://api.virtuals.io/api/virtuals": { data: [{ name: "larpcoin", status: "AVAILABLE", isVerified: false, walletAddress: solKey("agent-wallet"), socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/larpcoin_x" } }, createdAt: "2026-10-19T12:00:00.000Z" }] },
    });
    const r = await t.run("project_links", { mint: MINT }, { answerId: "l5" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.deepEqual(d.x_handles, ["LarpCoin_X"]);
    assert.deepEqual(d.telegram, { link: "https://t.me/larpcoin_bot", title: "LarpCoin Bot", verified: true, kind: "bot", count: 1234, description: "runs your render jobs" });
    assert.deepEqual(d.virtuals, { name: "larpcoin", status: "AVAILABLE", verified: false, agent_wallet: solKey("agent-wallet"), x: "https://x.com/larpcoin_x", listed_at: "2026-10-19T12:00:00.000Z" });
    // a name telegram has no page for, and a coin Virtuals does not list
    const { tools: t2 } = tools({
      [`https://frontend-api-v3.pump.fun/coins-v2/${MINT}`]: { mint: MINT, name: "x", symbol: "X", description: "", telegram: "https://t.me/nobodyhere" },
      "https://t.me/nobodyhere": () => new Response("<html><div class=\"tgme_page\"></div></html>", { status: 200 }),
      "https://api.virtuals.io/api/virtuals": { data: [], meta: { pagination: { total: 0 } } },
    });
    const d2 = ((await t2.run("project_links", { mint: MINT }, { answerId: "l6" })) as { data: Record<string, any> }).data;
    assert.match(d2.telegram.gone, /no such name/);
    assert.equal(d2.virtuals, "not an agent on Virtuals");
  });

  it("x_account: x's record of the account (joined, based in, made from, its username changes), a rename long after joining, its bio naming the coin's address and another", async () => {
    const other = solKey("other-coin");
    const { tools: t, urls } = tools({
      "https://api.fxtwitter.com/2/profile/larpcoin_x": { code: 200, user: { screen_name: "larpcoin_x", name: "larpcoin", followers: 410, following: 6, statuses: 32, joined: "Mon Jan 06 12:00:00 +0000 2025", description: `made-up project. $LARP ${MINT} (old: ${other})`, website: { url: "https://larp-coin.example/" }, verification: { verified: false }, about_account: { based_in: "Canada", location_accurate: false, source: "Web", username_changes: { count: 2, last_changed_at: "2026-10-12T09:00:00.000Z" } } } },
    });
    const r = await t.run("x_account", { handle: "https://x.com/larpcoin_x", mint: MINT }, { answerId: "x1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.deepEqual([d.handle, d.followers, d.posts, d.verified, d.website], ["larpcoin_x", 410, 32, false, "https://larp-coin.example/"]);
    assert.deepEqual([d.based_in, d.based_in_accurate, d.made_from, d.username_changes], ["Canada", false, "Web", 2]);
    assert.equal(d.renamed_days_after_joining, 644);
    assert.equal(d.bio_names_mint, true);
    assert.deepEqual(d.bio_other_addresses, [other]);
    assert.ok(urls[0]!.endsWith("/2/profile/larpcoin_x?about_account=1"), "x's about-this-account asked for");
  });

  it("x_account: a rename at signup is none; FxTwitter's v1 read when its v2 has no record; a missing account is not found", async () => {
    const { tools: t } = tools({
      "https://api.fxtwitter.com/2/profile/fresh": { code: 200, user: { screen_name: "fresh", joined: "Sun Oct 19 08:00:00 +0000 2026", statuses: 3, description: "", about_account: { username_changes: { count: 1, last_changed_at: "2026-10-19T08:00:40.000Z" } } } },
      "https://api.fxtwitter.com/2/profile/plain": { code: 404, message: "User not found" },
      "https://api.fxtwitter.com/plain": { code: 200, user: { screen_name: "plain", joined: "Mon Jan 01 00:00:00 +0000 2024", statuses: 10, description: "" } },
      "https://api.fxtwitter.com/2/profile/nobody": { code: 404, message: "User not found" },
      "https://api.fxtwitter.com/nobody": { code: 404, message: "User not found" },
    });
    const fresh = (await t.run("x_account", { handle: "@fresh" }, { answerId: "x2" })) as { data: Record<string, unknown> };
    assert.equal(fresh.data.username_changes, 1);
    assert.equal("renamed_days_after_joining" in fresh.data, false, "the handle x made at signup");
    const plain = (await t.run("x_account", { handle: "plain" }, { answerId: "x3" })) as { data: Record<string, unknown> };
    assert.equal(plain.data.posts, 10);
    assert.match(String(plain.data.about), /not read/);
    assert.equal(((await t.run("x_account", { handle: "nobody" }, { answerId: "x4" })) as { error: string }).error, "not_found");
  });

  it("project_links: pump.fun's links and words beside DexScreener's, a github link in its description, its x handle and site", async () => {
    const { tools: t } = tools({
      [`https://frontend-api-v3.pump.fun/coins-v2/${MINT}`]: { mint: MINT, name: "larpcoin", symbol: "LARP", description: "made-up project. code: github.com/larpdev/larp-core", twitter: "https://x.com/larpcoin_x", website: "https://larp-coin.example/", telegram: null, created_timestamp: Date.parse("2026-10-19T12:10:10Z"), creator: solKey("dev"), tokenized_agent: false },
      [`https://api.dexscreener.com/tokens/v1/solana/${MINT}`]: [{ dexId: "pumpswap", info: { websites: [{ url: "https://larp-coin.example/", label: "Website" }, { url: "https://docs.larp-coin.example", label: "Docs" }], socials: [{ type: "twitter", url: "https://x.com/larpcoin_x" }, { type: "telegram", url: "https://t.me/larpcoin" }] } }],
    });
    const r = await t.run("project_links", { mint: MINT }, { answerId: "l1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.symbol, "LARP");
    assert.equal(d.created_at, "2026-10-19T12:10:10.000Z");
    assert.deepEqual(d.github, ["larpdev/larp-core"]);
    assert.deepEqual(d.x_handles, ["larpcoin_x"]);
    assert.deepEqual(d.site_domains, ["larp-coin.example"]);
    assert.deepEqual(
      d.links.map((l: { kind: string; url: string }) => `${l.kind} ${l.url}`),
      ["website https://larp-coin.example/", "x https://x.com/larpcoin_x", "website https://docs.larp-coin.example", "telegram https://t.me/larpcoin", "in description https://github.com/larpdev/larp-core"],
    );
  });

  it("project_links: a token neither lists is not found; one with no links says so", async () => {
    assert.equal((await tools({}).tools.run("project_links", { mint: MINT }, { answerId: "l2" })).ok, false);
    const r = await tools({ [`https://frontend-api-v3.pump.fun/coins-v2/${MINT}`]: { mint: MINT, name: "x", symbol: "X", description: "" } }).tools.run("project_links", { mint: MINT }, { answerId: "l3" });
    assert.match((r as { data: { note: string } }).data.note, /nothing of its own to verify/);
  });

  it("github_repo: its record, commits counted by the Link header and the first one read, a history older than the repo, contributors, owner, readme, an older repo of the same name", async () => {
    const commit = (date: string, login: string, message: string, sha = "f00d") => ({ sha, commit: { author: { date, name: login }, committer: { date }, message }, author: { login } });
    const { tools: t, urls } = tools({
      "https://api.github.com/repos/larpdev/larp-core/commits?per_page=1&page=37": [commit("2024-03-01T10:00:00Z", "original-dev", "initial commit", "a1b2c3")],
      "https://api.github.com/search/commits?q=hash%3Aa1b2c3": { items: [{ repository: { full_name: "original-dev/larp-core" } }, { repository: { full_name: "larpdev/larp-core" } }, { repository: { full_name: "mirror/larp-core" } }] },
      "https://api.github.com/repos/larpdev/larp-core/commits?per_page=1": () => withHeaders([commit("2026-10-19T09:00:00Z", "larpdev", "rename to larpcoin")], { link: '<https://api.github.com/repositories/9/commits?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/9/commits?per_page=1&page=37>; rel="last"' }),
      "https://api.github.com/repos/larpdev/larp-core/contributors": [{ login: "original-dev", contributions: 35, type: "User" }, { login: "larpdev", contributions: 2, type: "User" }],
      "https://api.github.com/repos/larpdev/larp-core": { full_name: "larpdev/larp-core", name: "larp-core", owner: { login: "larpdev" }, description: "made-up project", created_at: "2026-10-19T08:30:00Z", pushed_at: "2026-10-19T09:00:00Z", default_branch: "main", fork: false, stargazers_count: 240, forks_count: 1, open_issues_count: 0, size: 120, language: "TypeScript", license: null, topics: [] },
      "https://api.github.com/users/larpdev": { login: "larpdev", type: "User", created_at: "2026-10-18T22:00:00Z", public_repos: 1, followers: 0, twitter_username: "larpcoin_x" },
      "https://api.github.com/search/repositories": { items: [{ full_name: "original-dev/larp-core", name: "larp-core", created_at: "2024-03-01T09:00:00Z", stargazers_count: 12, description: "a runtime" }, { full_name: "larpdev/larp-core", name: "larp-core", created_at: "2026-10-19T08:30:00Z", stargazers_count: 240 }] },
      "https://raw.githubusercontent.com/larpdev/larp-core/main/README.md": () => new Response(`# larpcoin\nmade-up tokens meet made-up code\n${"x".repeat(3000)}\nca: ${MINT}`, { status: 200 }),
    });
    const r = await t.run("github_repo", { repo: "https://github.com/larpdev/larp-core", mint: MINT }, { answerId: "g1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.commits, 37);
    assert.deepEqual([d.first_commit.at, d.first_commit.author, d.newest_commit.message], ["2024-03-01T10:00:00Z", "original-dev", "rename to larpcoin"]);
    assert.equal(d.history_before_repo, true, "a first commit years before the repo: its history was brought in");
    assert.equal(d.contributors, 2);
    assert.equal(d.owner.created_at, "2026-10-18T22:00:00Z");
    assert.match(d.readme, /made-up code/);
    assert.deepEqual(d.older_same_name, [{ repo: "original-dev/larp-core", created_at: "2024-03-01T09:00:00Z", stars: 12, description: "a runtime" }]);
    assert.ok(urls.some((u) => u.startsWith("https://raw.githubusercontent.com/")), "the readme from the raw host");
    assert.deepEqual(d.first_commit_also_in, ["original-dev/larp-core", "mirror/larp-core"], "its first commit's hash found in other repositories: its history copied");
    assert.equal(d.first_commit.sha, "a1b2c3");
    assert.equal(d.owner.x, "larpcoin_x");
    assert.equal(d.readme_names_mint, true, "the whole readme read for the mint, past its opening");
  });

  it("github_repo: with GITHUB_TOKEN its calls carry it (5,000 an hour, not the server IP's 60); without one none does", async () => {
    const seen: (string | null)[] = [];
    const answer = (_u: string, init?: RequestInit) => (seen.push(new Headers(init?.headers).get("authorization")), new Response("{}", { status: 404 }));
    const t = tableFetch({ "https://api.github.com/": answer });
    const withToken = createToolsWith(makeCtx({ GITHUB_TOKEN: " ghtest " }), { fetch: t.fetch, background: false, now: () => NOW });
    await withToken.run("github_repo", { repo: "a/b" }, { answerId: "gt1" });
    const without = createToolsWith(makeCtx({}), { fetch: t.fetch, background: false, now: () => NOW });
    await without.run("github_repo", { repo: "a/c" }, { answerId: "gt2" });
    assert.ok(seen.length >= 2);
    assert.equal(seen[0], "Bearer ghtest");
    assert.equal(seen[seen.length - 1], null);
  });

  it("github_repo: GitHub's rate limit rests every call until its reset; a missing repo is not found; an account lists its repos", async () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { tools: t } = tools({
      "https://api.github.com/repos/a/b": () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }),
    });
    assert.equal((await t.run("github_repo", { repo: "a/b" }, { answerId: "g2" }) as { error: string }).error, "rate_limited");
    assert.equal((await t.run("github_repo", { repo: "a/c" }, { answerId: "g3" }) as { error: string }).error, "rate_limited", "rested until its reset");
    const { tools: t2 } = tools({
      "https://api.github.com/users/someone/repos": [{ name: "x", fork: true, created_at: "2026-10-19T00:00:00Z", pushed_at: "2026-10-19T01:00:00Z", stargazers_count: 0, forks_count: 0 }],
      "https://api.github.com/users/someone": { login: "someone", type: "User", created_at: "2020-01-01T00:00:00Z", public_repos: 1 },
    });
    const acct = await t2.run("github_repo", { repo: "github.com/someone" }, { answerId: "g4" });
    assert.ok(acct.ok, JSON.stringify(acct));
    assert.equal((acct.data as { repositories: { fork: boolean }[] }).repositories[0]!.fork, true);
    assert.equal((await t2.run("github_repo", { repo: "nobody/nothing" }, { answerId: "g5" })).ok, false);
  });

  it("site_age: the registry's RDAP server from IANA's list, the first certificate and the first archive capture, in days", async () => {
    const { tools: t, urls } = tools({
      "https://data.iana.org/rdap/dns.json": { services: [[["example", "test"], ["https://rdap.example.org/"]]] },
      "https://rdap.example.org/domain/larp-coin.example": { events: [{ eventAction: "registration", eventDate: "2026-10-19T08:12:44Z" }, { eventAction: "expiration", eventDate: "2027-10-19T08:12:44Z" }], entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar, Inc."]]] }], nameservers: [{ ldhName: "NS1.EXAMPLE-DNS.ORG" }] },
      "https://crt.sh/": [{ not_before: "2026-10-19T08:20:00" }, { not_before: "2026-10-19T09:00:00" }],
      "https://web.archive.org/cdx/search/cdx": [["timestamp"], ["20261019100000"]],
    });
    const r = await t.run("site_age", { site: "https://app.larp-coin.example/start" }, { answerId: "s1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.deepEqual([d.domain, d.registered_at, d.registrar, d.nameservers[0]], ["larp-coin.example", "2026-10-19T08:12:44.000Z", "Example Registrar, Inc.", "ns1.example-dns.org"]);
    assert.equal(d.registered_days_ago, 0.2);
    assert.equal(d.first_certificate_at, "2026-10-19T08:20:00.000Z");
    assert.equal(d.first_archived_at, "2026-10-19T10:00:00.000Z");
    assert.ok(urls.includes("https://rdap.example.org/domain/larp-coin.example"), "the registry's own server, no redirect");
    assert.equal((await t.run("site_age", { site: "https://x.com/someone" }, { answerId: "s2" })).ok, false, "a social network is no site");
  });
});
