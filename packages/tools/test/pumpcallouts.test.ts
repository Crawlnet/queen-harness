// pump.fun's own callouts (src/free/pumpcallouts.ts): pump_callouts by a user (a wallet, a username, a profile link),
// by a coin, by both, by one callout's link; a callout's link or id as the call of call_frontrun and
// caller_side_wallets (its time as pump.fun recorded it, its coin, its author the caller); a 429 resting its route. The
// answers below keep the shapes of frontend-api-v3.pump.fun's (a user's newest callouts and his counts, one callout by
// id and on its coin, a coin's top callouts, the coins' and the callers' batch reads, the 404s and the edge's 1015);
// the users, coins, callouts and theses are made up.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calloutOf, userRef } from "../src/free/pumpcallouts.ts";
import { primaryUrl, pumpCallout, pumpCalloutId } from "../src/links.ts";
import { createToolsWith } from "../src/registry.ts";
import { schemaProblems } from "../src/schema.ts";
import { makeCtx, solKey } from "./helpers.ts";

const AUTHOR = solKey("callout-author");
const COIN_A = solKey("callout-coin-a");
const COIN_B = solKey("callout-coin-b");
const COIN_C = solKey("callout-coin-c");
const COIN_D = solKey("callout-coin-d");
/** The author's callout on COIN_A: 2026-08-30T08:04:55.017Z */
const CALL_A = "00000000-0000-4000-8000-0000000000a1";
const LINK_A = `https://pump.fun/coin/${COIN_A}?highlight_callout=${CALL_A}`;
/** His newest, on COIN_B: 2026-10-18T15:59:59.558Z */
const CALL_B = "00000000-0000-4000-8000-0000000000a2";
const NOW = Date.parse("2026-10-18T19:00:00Z");

/** GET /callout/list/{wallet}?limit=100&sortBy=TIMESTAMP&sortOrder=DESC: his newest three (of a page of 100) */
const LIST = {
  callouts: [
    { calloutId: CALL_B, userId: AUTHOR, coinMint: COIN_B, marketCap: 137743, calloutPrice: 1.3841900151283557e-6, calloutPriceUsd: 0.000141270432944, multiple: 0.1896203925631154, createdAt: 1792339199558, maxPriceSol: 1.4208569634150045e-6, maxPriceUsd: 0.00014501266168613535, thesis: "chart looks good to me", user_uuid: "", likes: 1, hasLiked: null, hasReposted: null, repostCount: 0, quoteCount: 0, updates: [], updateCount: 0, commentCount: 0, replyCount: 0, maxMultiplier: 1.0264898228465031, maxMultiplierAt: "2026-10-18T16:00:10.914Z", viewCount: 1149, mediaUrl: null, quotedCalloutId: null, quotedCallout: null, chain: null, perp: null, tailBuyers: 4, tailCohort1h: 4, tailPnl1hUsd: -94.766590728685, tailCohort4h: null, tailPnl4hUsd: null, tailCohort24h: null, tailPnl24hUsd: null },
    { calloutId: "00000000-0000-4000-8000-0000000000a3", userId: AUTHOR, coinMint: COIN_C, marketCap: 4389, calloutPrice: 4.300586645463453e-8, calloutPriceUsd: 4.38917873036e-6, multiple: 0.6534826129094551, createdAt: 1792338882844, maxPriceSol: 7.260920500833429e-8, maxPriceUsd: 7.410495463150597e-6, thesis: "an early pick in its niche", user_uuid: "", likes: 1, hasLiked: null, hasReposted: null, repostCount: 0, quoteCount: 0, updates: [], updateCount: 0, commentCount: 0, replyCount: 0, maxMultiplier: 1.6883558219883175, maxMultiplierAt: "2026-10-18T15:55:00.444Z", viewCount: 1171, mediaUrl: null, quotedCalloutId: null, quotedCallout: null, chain: null, perp: null, tailBuyers: 15, tailCohort1h: 15, tailPnl1hUsd: -146.08430383818418, tailCohort4h: null, tailPnl4hUsd: null, tailCohort24h: null, tailPnl24hUsd: null },
    { calloutId: "00000000-0000-4000-8000-0000000000a4", userId: AUTHOR, coinMint: COIN_D, marketCap: 6692, calloutPrice: 6.557133069429747e-8, calloutPriceUsd: 6.69221001066e-6, multiple: 0.43068104688811565, createdAt: 1792329771627, maxPriceSol: 1.4977160640146032e-7, maxPriceUsd: 1.528569014933304e-5, thesis: "Simple thesis: it works and it is early. \n\nOne to watch", user_uuid: "", likes: 0, hasLiked: null, hasReposted: null, repostCount: 1, quoteCount: 0, updates: [], updateCount: 0, commentCount: 0, replyCount: 4, maxMultiplier: 2.28410198200363, maxMultiplierAt: "2026-10-18T13:29:12.494Z", viewCount: 3953, mediaUrl: null, quotedCalloutId: null, quotedCallout: null, chain: null, perp: null, tailBuyers: 48, tailCohort1h: 48, tailPnl1hUsd: -229.73223626707465, tailCohort4h: 48, tailPnl4hUsd: -229.60679834555128, tailCohort24h: null, tailPnl24hUsd: null },
  ],
  nextPageToken: "eyJ2IjoyLCJwYWdlIjoxfQ",
};
/** GET /users/{wallet}/callout-stats (each window trimmed to its first fields) */
const STATS = {
  daily: { totalCallouts: 2, calloutsWithMultiple: 2, twoXPercent: 0, averageMultiple: 1.35, medianMultiple: 1.35 },
  weekly: { totalCallouts: 80, calloutsWithMultiple: 80, twoXPercent: 40, averageMultiple: 2.8, medianMultiple: 1.7 },
  monthly: { totalCallouts: 600, calloutsWithMultiple: 600, twoXPercent: 35, averageMultiple: 2.4, medianMultiple: 1.6 },
  allTime: { totalCallouts: 1200, calloutsWithMultiple: 1200, twoXPercent: 35, averageMultiple: 2.4, medianMultiple: 1.65 },
  lastRound: { totalCallouts: 20, calloutsWithMultiple: 20, twoXPercent: 38, averageMultiple: 2, medianMultiple: 1.8 },
  computedAt: "2026-10-18T19:05:58.992Z",
};
/** GET /users/{wallet or username} (the author, any case) */
const USER = {
  address: AUTHOR,
  userId: "00000000-0000-4000-8000-0000000000b1",
  is_pump_user: true,
  is_banned: false,
  username: "Caller_One",
  profile_image: "https://example.com/avatar.png",
  kind: "person",
  following: 50,
  followers: 4200,
  bio: "calls, not advice",
  x_username: "caller_one",
  canonical_svm_wallet: AUTHOR,
  canonical_evm_wallet: "0x00000000000000000000000000000000000000c1",
};
/** GET /callout/{id}: with its author */
const BY_ID = {
  callout: { calloutId: CALL_A, userId: AUTHOR, coinMint: COIN_A, marketCap: 24226832, calloutPrice: 0.0002645065101652575, calloutPriceUsd: 0.0270208195443, multiple: 3.4982391523167906, createdAt: 1788077095017, maxPriceSol: 0.00391416626837245, maxPriceUsd: 0.3998539784068046, thesis: "looks like a clean entry", user_uuid: "00000000-0000-4000-8000-0000000000b1", likes: 12, hasLiked: null, hasReposted: null, repostCount: 0, quoteCount: 0, updates: [], updateCount: 0, commentCount: 2, replyCount: 34, maxMultiplier: 14.797995958311086, maxMultiplierAt: "2026-09-21T19:45:20.674Z", viewCount: 7426, mediaUrl: null, quotedCalloutId: null, quotedCallout: null, chain: null, perp: null, userName: "Caller_One", profileImage: "https://example.com/avatar.png", isVerified: true, verifiedBadgeVisible: false, xUsername: "caller_one", xFollowerCount: 9000, accountKind: "person" },
};
/** GET /callout/{id} of his COIN_B callout: the list's row with the author's fields of the read above */
const B_BY_ID = { callout: { ...LIST.callouts[0], userName: "Caller_One", isVerified: true, verifiedBadgeVisible: false, xUsername: "caller_one", xFollowerCount: 9000, accountKind: "person" } };
/** GET /callout/user/{wallet}/mint/{mint}: his live callout on COIN_A, an update under it */
const USER_MINT = {
  callout: { ...BY_ID.callout, userName: undefined, profileImage: undefined, isVerified: undefined, verifiedBadgeVisible: undefined, xUsername: undefined, xFollowerCount: undefined, accountKind: undefined, user_uuid: "", updates: [{ id: "00000000-0000-4000-8000-0000000000a5", content: "still holding", createdAt: "2026-10-04T19:24:00.603Z", likeCount: 0, mediaUrl: null, parentMessageId: null, repostCount: 0, viewCount: 301 }], updateCount: 32 },
  quotes: [],
};
const USER_B = solKey("callout-user-b");
const USER_C = solKey("callout-user-c");
/** GET /callout/coin/{mint}?limit=100: COIN_A's top three by how far it rose after each */
const COIN = {
  callouts: [
    { calloutId: "00000000-0000-4000-8000-0000000000a6", userId: USER_B, coinMint: COIN_A, marketCap: 3936860, calloutPrice: 4.182351827452563e-5, calloutPriceUsd: 0.00427298136236, multiple: 22.12162442135015, createdAt: 1787167477327, maxPriceSol: 0.003913731129358907, maxPriceUsd: 0.3998539784068046, thesis: "early", user_uuid: "00000000-0000-4000-8000-0000000000b2", likes: 1, hasLiked: null, hasReposted: null, repostCount: 0, quoteCount: 0, updates: [], updateCount: 0, commentCount: 0, replyCount: 0, maxMultiplier: 93.5772811763359, maxMultiplierAt: "2026-09-21T19:45:20.674Z", mediaUrl: null, quotedCalloutId: null, quotedCallout: null, chain: null, perp: null },
    { calloutId: "00000000-0000-4000-8000-0000000000a7", userId: USER_C, coinMint: COIN_A, marketCap: 4135788, calloutPrice: 4.3929919487915216e-5, calloutPriceUsd: 0.00448818595293, multiple: 21.060911880410952, createdAt: 1787165444845, maxPriceSol: 0.003913731129358907, maxPriceUsd: 0.3998539784068046, thesis: "the one that makes sense to me", user_uuid: "00000000-0000-4000-8000-0000000000b3", likes: 0, hasLiked: null, hasReposted: null, repostCount: 0, quoteCount: 0, updates: [], updateCount: 0, commentCount: 0, replyCount: 1, maxMultiplier: 89.09033239716146, maxMultiplierAt: "2026-09-21T19:45:20.674Z", mediaUrl: null, quotedCalloutId: null, quotedCallout: null, chain: null, perp: null },
    { calloutId: "00000000-0000-4000-8000-0000000000a8", userId: solKey("callout-user-d"), coinMint: COIN_A, marketCap: 4577838, calloutPrice: 4.855796676828557e-5, calloutPriceUsd: 0.00496101943488, multiple: 19.053601804695095, createdAt: 1787140923615, maxPriceSol: 0.003913731129358907, maxPriceUsd: 0.39985397840680453, thesis: "needs a couple of runners to move", user_uuid: "00000000-0000-4000-8000-0000000000b4", likes: 0, hasLiked: null, hasReposted: null, repostCount: 0, quoteCount: 0, updates: [], updateCount: 0, commentCount: 0, replyCount: 2, maxMultiplier: 80.59915580969226, maxMultiplierAt: "2026-09-21T19:45:20.674Z", mediaUrl: null, quotedCalloutId: null, quotedCallout: null, chain: null, perp: null },
  ],
};
/** POST /coins-v2/mints (each coin trimmed to its first fields) */
const MINTS = [
  { mint: COIN_B, name: "Beta", symbol: "Beta", creator: solKey("coin-b-creator"), created_timestamp: 1792338216000, complete: true, usd_market_cap: 32107.585405792033, chain_id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  { mint: COIN_C, name: "Gamma Fun", symbol: "GAMMA", creator: solKey("coin-c-creator"), created_timestamp: 1792338700000, complete: false, usd_market_cap: 2868.250505672183, chain_id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  { mint: COIN_A, name: "Alpha Coin", symbol: "ALPHA", creator: solKey("coin-a-creator"), created_timestamp: 1784833617000, complete: false, usd_market_cap: 86170109.2938395, chain_id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
];
/** POST /users/batch (each user trimmed) */
const USERS = [
  { address: AUTHOR, userId: "00000000-0000-4000-8000-0000000000b1", username: "Caller_One", x_username: "caller_one", followers: 4200, is_banned: false },
  { address: USER_B, userId: "00000000-0000-4000-8000-0000000000b2", username: "user_two", x_username: "user_two_x", followers: 400, is_banned: false },
  { address: USER_C, userId: "00000000-0000-4000-8000-0000000000b3", username: "user_three", x_username: "user_three_x", followers: 3, is_banned: false },
];
const NO_USER = { statusCode: 404, timestamp: "2026-10-18T19:13:14.847Z", path: "/users/zzqqxx_no_such_user_8812", message: "User not found", error: "Not Found" };
const NO_CALLOUT = { statusCode: 404, timestamp: "2026-10-18T19:13:15.279Z", path: "/callout/00000000-0000-4000-8000-000000000000", error: "CALLOUT_NOT_FOUND", message: "callout not found" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** pump.fun's API as it answered: `over` replaces a route's answer (by "METHOD /path" prefix) */
function pumpApi(url: URL, init: RequestInit | undefined, over: Record<string, () => Response>): Response {
  const method = init?.method ?? "GET";
  const key = `${method} ${url.pathname}`;
  for (const [k, f] of Object.entries(over)) if (key.startsWith(k)) return f();
  const p = url.pathname;
  if (method === "POST" && p === "/coins-v2/mints") {
    const want = (JSON.parse(String(init?.body)) as { mints: string[] }).mints;
    return json(MINTS.filter((c) => want.includes(c.mint)), 201);
  }
  if (method === "POST" && p === "/users/batch") {
    const want = (JSON.parse(String(init?.body)) as { addresses: string[] }).addresses;
    return json(USERS.filter((u) => want.includes(u.address)), 201);
  }
  if (p === `/callout/list/${AUTHOR}`) return json(LIST);
  if (p === `/users/${AUTHOR}/callout-stats`) return json(STATS);
  if (p === `/users/${AUTHOR}` || p.toLowerCase() === "/users/caller_one") return json(USER);
  if (p === `/callout/${CALL_A}`) return json(BY_ID);
  if (p === `/callout/${CALL_B}`) return json(B_BY_ID);
  if (p === `/callout/coin/${COIN_A}`) return json(COIN);
  if (p === `/callout/user/${AUTHOR}/mint/${COIN_A}`) return json(USER_MINT);
  if (p.startsWith("/callout/user/")) return json({ callout: null, quotes: [] });
  if (p.startsWith("/callout/")) return json(NO_CALLOUT, 404);
  return json(NO_USER, 404);
}

// ─────────── the chain around a call (as frontrun.test.ts builds it)

const POOL = solKey("callout-pool-vault-owner");
const A = solKey("callout-side-a");
const B = solKey("callout-side-b");
const bal = (owner: string, mint: string, ui: number) => ({ accountIndex: 1, mint, owner, uiTokenAmount: { uiAmount: ui, uiAmountString: String(ui), decimals: 6, amount: String(ui * 1e6) } });
/** A trade of `mint`: `who` gets `got` (negative: sells) against the pool, paying `sol` lamports */
function trade(mint: string, slot: number, at: number, who: string, got: number, sol = 0) {
  const keys = [{ pubkey: who, signer: true }];
  return {
    slot,
    blockTime: at,
    transaction: { signatures: [`sig-${mint.slice(0, 4)}-${slot}-${who.slice(0, 4)}`], message: { accountKeys: keys } },
    meta: { err: null, fee: 5000, preBalances: [10e9], postBalances: [10e9 - 5000 - sol], preTokenBalances: [bal(who, mint, got > 0 ? 0 : -got), bal(POOL, mint, 1e8)], postTokenBalances: [bal(who, mint, got > 0 ? got : 0), bal(POOL, mint, 1e8 - got)] },
  };
}
/** The first SOL into `wallet`, sent by `from` */
const funding = (wallet: string, from: string, at: number) => ({
  slot: 1,
  blockTime: at,
  transaction: { signatures: [`fund-${wallet.slice(0, 6)}`], message: { accountKeys: [{ pubkey: from, signer: true }, { pubkey: wallet, signer: false }] } },
  meta: { err: null, fee: 5000, preBalances: [50e9, 0], postBalances: [50e9 - 1e9 - 5000, 1e9], preTokenBalances: [], postTokenBalances: [] },
});

/** The tools over pump.fun's API and the launch keys' rpc; every pump.fun request is recorded as "METHOD /path?query" */
function world(o: { history?: Record<string, ReturnType<typeof trade>[]>; over?: Record<string, () => Response>; clock?: { t: number } } = {}) {
  const pump: string[] = [];
  const clock = o.clock ?? { t: NOW };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.host === "frontend-api-v3.pump.fun") {
      pump.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      return pumpApi(url, init, o.over ?? {});
    }
    // the launch keys' rpc: a coin's trades in a window, a wallet's first SOL (from the author himself), the supply
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string, Record<string, any>] };
    let result: unknown = null;
    if (body.method === "getTokenSupply") result = { value: { uiAmountString: "1000000000" } };
    else if (body.method === "getTransactionsForAddress") {
      const [addr, opts] = body.params;
      const f = opts.filters?.blockTime;
      if (o.history?.[addr]) result = { data: o.history[addr]!.filter((t) => !f || (t.blockTime >= f.gte && t.blockTime < f.lt)), paginationToken: null };
      else if (addr === A || addr === B) result = { data: [funding(addr, AUTHOR, 1788000000)], paginationToken: null };
      else result = { data: [], paginationToken: null };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const ctx = makeCtx({ HELIUS_LAUNCH_KEYS: "key-good-0000000000000000", TOOLS_MAX_CALLS_PER_ANSWER: "50" });
  const tools = createToolsWith(ctx, { fetch, background: false, now: () => clock.t });
  return { tools, pump, clock, logs: ctx.logs };
}

describe("pump.fun's callouts (free/pumpcallouts.ts)", () => {
  it("a callout's id from its link (a coin page's highlight, its own page, a reply's under it) or the id itself; anything else none", () => {
    assert.equal(pumpCalloutId(LINK_A), CALL_A);
    assert.equal(pumpCalloutId(`pump.fun/callouts/${COIN_A}/${CALL_A}`), CALL_A);
    assert.equal(pumpCalloutId(`https://www.pump.fun/callouts/${COIN_A}/${CALL_A}/00000000-0000-4000-8000-0000000000a5`), CALL_A);
    assert.equal(pumpCalloutId(CALL_A.toUpperCase()), CALL_A);
    for (const v of ["https://x.com/example_caller/status/2110416437506998273", "2026-10-14T17:04:23Z", `https://evil.example/coin/${COIN_A}?highlight_callout=${CALL_A}`, `https://pump.fun/coin/${COIN_A}`, "00000000-0000-4000-8000", null]) assert.equal(pumpCalloutId(v), null, String(v));
    assert.equal(pumpCallout(COIN_A, CALL_A), LINK_A);
    assert.equal(primaryUrl(LINK_A), LINK_A, "a callout's link is a primary page, its highlight kept");
    assert.equal(primaryUrl(`https://pump.fun/coin/${COIN_A}?highlight_callout=x&ref=abc`), `https://pump.fun/coin/${COIN_A}`);
  });

  it("a user as given: a wallet, a username (an @ dropped), a profile link's name; a callout of pump.fun's own answer read", () => {
    assert.deepEqual(userRef(AUTHOR), { wallet: AUTHOR });
    assert.deepEqual(userRef("@Caller_One"), { username: "Caller_One" });
    assert.deepEqual(userRef("https://pump.fun/profile/Caller_One?tab=callouts"), { username: "Caller_One" });
    assert.deepEqual(userRef(`pump.fun/profile/${AUTHOR}`), { wallet: AUTHOR });
    assert.equal(userRef("not a user!"), null);
    const c = calloutOf(LIST.callouts[2])!;
    assert.deepEqual([c.id, c.mint, c.wallet, new Date(c.atMs).toISOString(), c.tailBuyers], ["00000000-0000-4000-8000-0000000000a4", COIN_D, AUTHOR, "2026-10-18T13:22:51.627Z", 48]);
    assert.equal(c.text, "Simple thesis: it works and it is early. One to watch", "one line");
    assert.equal(calloutOf({ ...LIST.callouts[0], thesis: "claim yours at claim-example.io now" })!.text, null, "a text with a bare link is withheld");
    assert.equal(calloutOf({ ...LIST.callouts[0], createdAt: 0 }), null, "no time, no callout");
  });

  it("a user by username: the wallet looked up, the newest page read once, pump.fun's own counts, the coins read; each callout's exact time, coin and symbol, author, text and link, newest first", async () => {
    const { tools, pump } = world();
    const r = await tools.run("pump_callouts", { user: "caller_one", limit: 2 }, { answerId: "c1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.deepEqual(d.user, { wallet: AUTHOR, username: "Caller_One", x: "@caller_one", pump_followers: 4200 });
    assert.deepEqual([d.callouts_total, d.callouts_30d, d.callouts_7d], [1200, 600, 80]);
    assert.deepEqual(d.newest, { callouts: 3, coins: 3, from: "2026-10-18T13:22:51.627Z", to: "2026-10-18T15:59:59.558Z", all: false });
    assert.deepEqual(d.callouts[0], {
      id: CALL_B,
      at: "2026-10-18T15:59:59.558Z",
      mint: COIN_B,
      symbol: "Beta",
      author: "Caller_One",
      author_wallet: AUTHOR,
      text: "chart looks good to me",
      mcap_at_call_usd: 137743,
      peak_x: 1.03,
      peak_s_after: 11,
      now_x: 0.19,
      tail_buyers: 4,
      tail_pnl_1h_usd: -94.77,
      link: `https://pump.fun/coin/${COIN_B}?highlight_callout=${CALL_B}`,
    });
    assert.deepEqual(d.callouts.map((c: { symbol: string }) => c.symbol), ["Beta", "GAMMA"]);
    assert.deepEqual(pump, [
      "GET /users/caller_one",
      `GET /callout/list/${AUTHOR}?limit=100&sortBy=TIMESTAMP&sortOrder=DESC`,
      `GET /users/${AUTHOR}/callout-stats`,
      "POST /coins-v2/mints",
    ]);
    for (const s of r.sources) assert.equal(primaryUrl(s.url), s.url);
    assert.equal(r.sources[0]?.url, `https://pump.fun/coin/${COIN_B}?highlight_callout=${CALL_B}`);
  });

  it("a coin: pump.fun's top callouts, newest first, each caller's name from one batch read; a user and a coin: that user's callout on it; one callout by its link", async () => {
    const { tools, pump } = world();
    const coin = await tools.run("pump_callouts", { mint: COIN_A }, { answerId: "c2" });
    assert.ok(coin.ok, JSON.stringify(coin));
    const d = coin.data as Record<string, any>;
    assert.deepEqual(d.coin, { mint: COIN_A, symbol: "ALPHA", name: "Alpha Coin" });
    assert.deepEqual([d.listed, d.callers, d.first_at], [3, 3, "2026-08-19T12:02:03.615Z"]);
    assert.deepEqual(d.callouts.map((c: { at: string; author: string | null }) => [c.at, c.author]), [
      ["2026-08-19T19:24:37.327Z", "user_two"],
      ["2026-08-19T18:50:44.845Z", "user_three"],
      ["2026-08-19T12:02:03.615Z", null],
    ]);
    assert.ok(pump.includes(`GET /callout/coin/${COIN_A}?limit=100`) && pump.includes("POST /users/batch"));

    const his = await tools.run("pump_callouts", { user: AUTHOR, mint: COIN_A }, { answerId: "c3" });
    assert.ok(his.ok, JSON.stringify(his));
    const h = his.data as Record<string, any>;
    assert.deepEqual([h.callouts.length, h.callouts[0].id, h.callouts[0].at, h.callouts[0].peak_x], [1, CALL_A, "2026-08-30T08:04:55.017Z", 14.8]);
    const none = await tools.run("pump_callouts", { user: AUTHOR, mint: solKey("uncalled-coin") }, { answerId: "c3" });
    assert.equal(!none.ok && none.error, "not_found");

    const one = await tools.run("pump_callouts", { callout: LINK_A }, { answerId: "c4" });
    assert.ok(one.ok, JSON.stringify(one));
    const o = one.data as Record<string, any>;
    assert.deepEqual([o.user.username, o.user.x, o.callouts[0].mint, o.callouts[0].symbol, o.callouts[0].at], ["Caller_One", "@caller_one", COIN_A, "ALPHA", "2026-08-30T08:04:55.017Z"]);
  });

  it("refusals and misses in our words: no user or coin given, a name pump.fun does not know, a callout it has no record of", async () => {
    const { tools } = world();
    const empty = await tools.run("pump_callouts", {}, { answerId: "c5" });
    assert.equal(!empty.ok && empty.error, "bad_args");
    const unknown = await tools.run("pump_callouts", { user: "zzqqxx_no_such" }, { answerId: "c5" });
    assert.deepEqual(unknown, { ok: false, error: "not_found", message: "pump.fun has no user by this name" });
    const gone = await tools.run("pump_callouts", { callout: "00000000-0000-4000-8000-000000000000" }, { answerId: "c5" });
    assert.deepEqual(gone, { ok: false, error: "not_found", message: "pump.fun has no callout with this id" });
  });

  it("a 429 rests its route until its Retry-After, no request sent meanwhile; the other routes still answer", async () => {
    let refused = 0;
    const { tools, pump, clock, logs } = world({ over: { "GET /callout/list/": () => (refused++ === 0 ? new Response("error code: 1015", { status: 429, headers: { "retry-after": "558" } }) : json(LIST)) } });
    const first = await tools.run("pump_callouts", { user: AUTHOR }, { answerId: "c6" });
    assert.equal(!first.ok && first.error, "rate_limited");
    assert.ok(logs.some((l) => l.msg === "tools: pump.fun rests a route" && l.extra?.route === "list" && l.extra?.s === 558));
    const lists = () => pump.filter((p) => p.startsWith("GET /callout/list/")).length;
    clock.t += 5 * 60_000;
    const resting = await tools.run("pump_callouts", { user: AUTHOR }, { answerId: "c7" });
    assert.equal(!resting.ok && resting.error, "rate_limited");
    assert.equal(lists(), 1, "nothing sent to a resting route");
    const other = await tools.run("pump_callouts", { mint: COIN_A }, { answerId: "c7" });
    assert.ok(other.ok, "a coin's callouts still answer");
    clock.t += 5 * 60_000;
    const after = await tools.run("pump_callouts", { user: AUTHOR }, { answerId: "c8" });
    assert.ok(after.ok, JSON.stringify(after));
    assert.equal(lists(), 2);
  });

  it("pump.fun's API behind its edge's challenge (a 403): unavailable, then left out of the offered tools for 30 min, offered again after", async () => {
    const { tools, clock, logs } = world({ over: { "GET /callout/list/": () => new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403 }) } });
    const r = await tools.run("pump_callouts", { user: AUTHOR }, { answerId: "c9" });
    assert.equal(!r.ok && r.error, "unavailable");
    assert.ok(!tools.list().some((x) => x.name === "pump_callouts"), "not offered while challenged");
    assert.ok(logs.some((l) => l.msg.startsWith("tools: pump.fun's api is behind a challenge")));
    clock.t += 31 * 60_000;
    assert.ok(tools.list().some((x) => x.name === "pump_callouts"), "offered again after the rest");
  });

  it("listed with no key, a valid definition, its description under 600 characters", () => {
    const tools = createToolsWith(makeCtx(), { background: false, fetch: async () => new Response("{}") });
    const spec = tools.list().find((s) => s.name === "pump_callouts");
    assert.ok(spec, "always offered");
    assert.deepEqual(schemaProblems(spec), []);
    assert.ok(spec.description.length <= 600, `${spec.description.length}`);
  });
});

describe("a pump.fun callout as the call (free/frontrun.ts)", () => {
  // two wallets buy the coin in one slot 20 s before the author's callout, both funded by the author's own wallet, and sell 4 min after
  const CALL_S = Math.floor(1788077095017 / 1000);
  const history = {
    [COIN_A]: [trade(COIN_A, 200, CALL_S - 20, A, 20_000_000, 3e9), trade(COIN_A, 200, CALL_S - 20, B, 15_000_000, 2e9), trade(COIN_A, 400, CALL_S + 240, A, -20_000_000), trade(COIN_A, 410, CALL_S + 245, B, -15_000_000)],
    [COIN_B]: [trade(COIN_B, 900, Math.floor(1792339199558 / 1000) - 18, A, 5_000_000, 1e9)],
  };

  it("call_frontrun: a callout's link is its time as pump.fun recorded it and its author the caller; read once, a second ask by its id costs no request", async () => {
    const { tools, pump } = world({ history });
    const r = await tools.run("call_frontrun", { mint: COIN_A, call: LINK_A }, { answerId: "f1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.called_at, "2026-08-30T08:04:55Z");
    assert.deepEqual(d.callout, { id: CALL_A, author_wallet: AUTHOR });
    assert.deepEqual([d.summary.buyers_before, d.summary.sold_after, d.summary.median_s_before, d.summary.median_sell_s_after], [2, 2, 20, 245]);
    assert.deepEqual(d.clusters, [{ funder: AUTHOR, wallets: [A, B], funder_is_caller: true }]);
    assert.ok(d.rows.every((x: { tie_to_caller?: string }) => x.tie_to_caller === "funded by the caller's wallet"), "the callout's author is the caller");
    assert.deepEqual(pump, [`GET /callout/${CALL_A}`]);
    const again = await tools.run("call_frontrun", { mint: COIN_A, call: CALL_A, after_s: 600 }, { answerId: "f2" });
    assert.ok(again.ok, JSON.stringify(again));
    assert.deepEqual(pump, [`GET /callout/${CALL_A}`], "a callout read before costs nothing");
  });

  it("call_frontrun: a callout listed by pump_callouts needs no read of its own; one on another coin, or one pump.fun does not know, is refused in our words", async () => {
    const { tools, pump } = world({ history });
    await tools.run("pump_callouts", { user: AUTHOR }, { answerId: "f3" });
    const n = pump.length;
    const second = await tools.run("call_frontrun", { mint: COIN_B, call: CALL_B }, { answerId: "f3" });
    assert.ok(second.ok, JSON.stringify(second));
    assert.equal((second.data as { called_at: string }).called_at, "2026-10-18T15:59:59Z");
    assert.equal(pump.length, n, "its time came from the list");
    const wrong = await tools.run("call_frontrun", { mint: COIN_A, call: CALL_B }, { answerId: "f3" });
    assert.deepEqual(wrong, { ok: false, error: "bad_args", message: `this callout is on another coin (${COIN_B})` });
    const gone = await tools.run("call_frontrun", { mint: COIN_A, call: "00000000-0000-4000-8000-000000000000" }, { answerId: "f3" });
    assert.deepEqual(gone, { ok: false, error: "not_found", message: "pump.fun has no callout with this id" });
  });

  it("caller_side_wallets: two of one author's callouts, the wallet that bought before both; the author the caller when none is given", async () => {
    const { tools } = world({ history });
    const r = await tools.run("caller_side_wallets", { calls: [`${COIN_A} ${LINK_A}`, `${COIN_B} https://pump.fun/callouts/${COIN_B}/${CALL_B}`] }, { answerId: "f4" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as { calls_read: number; caller_wallet?: string; rows: Record<string, unknown>[] };
    assert.deepEqual([d.calls_read, d.caller_wallet], [2, AUTHOR]);
    const { activity: _a, ...row } = d.rows[0] as Record<string, unknown>;
    assert.deepEqual(row, { wallet: A, calls_front_run: 2, of_calls: 2, median_s_before: 20, sold_after_calls: 1, median_sell_s_after: 240, funder: AUTHOR, tie_to_caller: "funded by the caller's wallet" });
  });
});
