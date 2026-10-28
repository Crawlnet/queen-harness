// The harness (src/harness.ts): the intents read from a question and the asker's earlier ones, the plan each gives
// (functions, calls, effort, the fact sheet), the prompt and its leak guard, and code's dossier of a scanned coin on the
// one severity scale.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerPrompt, brainAnswer, leaks, readShares, readsBlock, SAYABLE, scrubNames, type AskInput, type BrainStatus } from "../src/brain.ts";
import { loadLlmConfig } from "../src/config.ts";
import { SAY_RISK_READ } from "../src/say.ts";
import { coinInView, dossierLines, HARNESS_GUARDED, harnessIntents, harnessPlan, harnessRead, harnessSystem, intentMessage, namesCoin, planReads, PLAYBOOKS, sellImpact as sellImpactFor, xReadOf, type HarnessIntent } from "../src/harness.ts";
import { checksVerdict, runScan, scanAskOf, settleDeep, tokenBlock, withLateChecks, type ScanCall, type ScanFacts, type TokenBlockCheck } from "../src/scan.ts";
import { verdictLevel, type Severity } from "@crawlnet/shared";
import type { ToolResult } from "@crawlnet/shared";

const ALL = [
  "token_risk_flags", "token_pairs", "dex_pair_lookup", "sol_ticker_mint", "sol_account_basics", "sol_largest_accounts", "sol_holder_links", "sol_token_origin", "sol_launch", "sol_money_trail", "sol_asset_card",
  "meme_narrative", "meme_metas", "social_mentions", "news_pages", "call_frontrun", "page_snapshot", "hub_find", "hub_call", "hub_rpc", "sol_balance_changes", "sol_recent_signatures",
  "caller_side_wallets", "fresh_pools", "protocol_tvl", "top_protocols", "chain_tvl_ranking", "protocol_fees_revenue",
  "dex_volume_ranking", "yield_pools", "stablecoin_supply", "unlock_schedule", "prediction_odds", "pool_snapshot",
];
const MINT = "CoinMint1111111111111111111111111111111pump";
const EVM_TOKEN = "0x1111111111111111111111111111111111111111";
const EVM_WALLET = "0x2222222222222222222222222222222222222222";

describe("harness: the intents of a chat question", () => {
  it("a coin named by its address or cashtag is a coin check; a wallet, a caller, a narrative, odds, defi, a claim, crawlnet each by their words", () => {
    const cases: [string, string[]][] = [
      [`scan this token: < ${MINT} address>`, ["token"]],
      [EVM_TOKEN, ["token"]],
      ["Is this token safe from a rug pull?", ["token"]],
      [`${MINT} 这个币为什么涨了？结合媒体热度和链上数据分析一下`, ["token"]],
      [`check this wallet: ${EVM_WALLET}`, ["wallet"]],
      ["did @somecaller buy before he called $COIN?", ["caller", "token"]],
      ["what's running on pump.fun right now", ["narrative"]],
      ["will btc hit 150k by december", ["prediction"]],
      ["uniswap v3 tvl", ["defi"]],
      ["verify this claim: https://x.com/someone/status/1234567890123456789?s=20", ["claim"]],
      ["what is crawlnet?", ["self"]],
      ["Nói về dự án crawlnet này", ["self"]],
      ["what can you do?", ["self"]],
      ["what is $crawl's market cap?", ["self", "token"]],
      ["what is a zk rollup?", ["general"]],
      ["hey", ["general"]],
    ];
    for (const [q, want] of cases) assert.deepEqual(harnessIntents(q), want, q);
  });

  it("an ask for picks or lists of the market is what runs now; a coin's story or traders are the coin's", () => {
    const cases: [string, string[]][] = [
      // picks and lists: what runs now, as facts (no pick is ever made)
      ["Next 100x meme coin", ["narrative"]],
      ["Most promising meme coins rn", ["narrative"]],
      ["check the last 100 tokens launched on pumpfun", ["narrative"]],
      ["những token microcap nào đáng chú ý nhất hôm nay trên mọi chain? cho tôi top 10", ["narrative"]],
      ["what have top wallets been doing lately?", ["narrative", "wallet"]],
      ["Can you list the most profitable wallets on pump fun and check whether their PNL is consistent?", ["narrative", "wallet"]],
      ["what are the top traders buying?", ["narrative"]],
      ["what narratives are running today?", ["narrative"]],
      // what just ran
      ["what ran on pump.fun in the last few hours?", ["narrative"]],
      ["top gainers today", ["narrative"]],
      // a caller by his words alone, no handle
      ["did this caller's side wallets buy before his pump.fun callouts?", ["caller", "wallet"]],
      ["who called it first?", ["general"]],
      // a coin pointed at is no market ask
      ["is it a gem?", ["general"]],
      // a named coin's story or top traders: its own plan, never today's market reads
      [`what's the story of ${MINT}`, ["token"]],
      [`who of the top traders are in it right now? ${MINT}`, ["token"]],
      ["qu'est-ce que crawlnet ?", ["self"]],
      // a trader by handle with wallet words
      ["check @sometrader’s pnl history", ["wallet"]],
      // no coin in view: a story is the market's
      ["whats the narrative", ["narrative"]],
      ["who are you?", ["self"]],
    ];
    for (const [q, want] of cases) assert.deepEqual(harnessIntents(q), want, q);
  });

  it("a follow-up that says little keeps the last plain question's intent (another language, 'all chains', 'trace the creator')", () => {
    assert.deepEqual(harnessIntents("택스 얼마나 있어?", [`scan this token: <${EVM_TOKEN}>  이 토큰 분석해줘`]), ["token"]);
    assert.deepEqual(harnessIntents("all chains", [`check this wallet: ${EVM_WALLET}`, "what are its biggest token holdings?"]), ["wallet"]);
    assert.deepEqual(harnessIntents("trace the creator wallet", [MINT]), ["wallet", "token"], "a trace says what it is; its creator brushes the coin");
    assert.deepEqual(harnessIntents("who are the largest unlabelled holders?", [`scan ${MINT}`]), ["token"]);
    assert.deepEqual(harnessIntents("can you give wallet address of connected group wallet?", ["who are the largest unlabelled holders?"]), ["wallet", "token"]);
    assert.deepEqual(harnessIntents("hey", [`scan ${MINT}`]), ["general"], "small talk stays small talk");
  });

  it("a story, smart money or top traders asked after a coin are that coin's, the earlier questions read in the light of theirs; a market ask stays the market's", () => {
    assert.deepEqual(harnessIntents("whats the narrative", [MINT]), ["token"], "after a bare mint");
    assert.deepEqual(harnessIntents("what do you think of the narrative", [MINT, "whats the narritive"]), ["token"], "a misspelt one between is the coin's too");
    assert.deepEqual(harnessIntents("who are the top traders in it?", [`scan ${MINT}`]), ["token"]);
    assert.deepEqual(harnessIntents("is it a gem?", [`scan ${MINT}`]), ["token"], "a pointer keeps the coin");
    assert.deepEqual(harnessIntents("whats the story?", [`check this wallet: ${EVM_WALLET}`]), ["wallet"]);
    assert.deepEqual(harnessIntents("Next 100x meme coin", [`scan ${MINT}`]), ["narrative"], "a market ask is no follow-up");
  });

  it("harnessRead: whether the words said it plainly, what they brush and what was kept", () => {
    assert.deepEqual(harnessRead("compare lido and rocket pool in a table", [`scan this token: ${MINT}`]), { intents: ["token"], strong: false, brushed: [], kept: "token" });
    assert.deepEqual(harnessRead("who are the largest unlabelled holders?", [`scan ${MINT}`]), { intents: ["token"], strong: false, brushed: ["token"], kept: "token" });
    assert.deepEqual(harnessRead("can you give wallet address of connected group wallet?", [`scan ${MINT}`]), { intents: ["wallet", "token"], strong: false, brushed: ["wallet"], kept: "token" });
    assert.deepEqual(harnessRead(`scan ${MINT}`, ["what is a zk rollup?"]), { intents: ["token"], strong: true, brushed: ["token"], kept: null });
    assert.deepEqual(harnessRead("我问的是你从哪里拿到这些数据"), { intents: ["general"], strong: false, brushed: [], kept: null });
    assert.equal(harnessRead("hey", [`scan ${MINT}`]).strong, true, "small talk is plain: nothing to ask Jev");
  });

  it("coinInView: the earlier question a coin follow-up that names no coin is about, back to a question about something else; none for a subject of its own", () => {
    const scanned = `scan this token: < ${MINT} address>`;
    const T: HarnessIntent[] = ["token"];
    assert.equal(coinInView("who are the largest unlabelled holders?", T, [scanned]), scanned);
    assert.equal(coinInView("check the launch bundles and snipers", T, [MINT]), MINT, "a bare mint");
    assert.equal(coinInView("trace the creator wallet", ["wallet", "token"], [MINT, "who are the largest unlabelled holders?"]), MINT, "a coin question between keeps it in view");
    assert.equal(coinInView("택스 얼마나 있어?", T, [scanned, "what is a zk rollup?"]), scanned, "a concept between does not move it");
    assert.equal(coinInView("check this as an ethereum token", T, [EVM_TOKEN]), EVM_TOKEN, "a chain is no subject");
    assert.equal(coinInView("how much sol did the dev take out?", T, [MINT]), MINT, "an amount is no subject");
    assert.equal(coinInView("can you check this coin's LP? is the KOL dumping?", T, [MINT]), MINT, "the trenches' capitals name no coin");
    assert.equal(coinInView("wait...what did the dev do?", T, [MINT]), MINT, "an ellipsis between words is no address");
    assert.equal(coinInView("is it true the dev sold?", ["claim", "token"], [MINT]), MINT, "a claim about the coin in view");
    // what the question is about: a coin, a call or a wallet first, never what runs now, a protocol or crawlnet
    assert.equal(coinInView("can you get me a list of the most profitable wallets?", ["narrative", "wallet"], [MINT]), null);
    assert.equal(coinInView("how are protocol fees split?", ["defi", "token"], [MINT]), null);
    assert.equal(coinInView("who runs crawlnet?", ["self", "token"], [MINT]), null);
    assert.equal(coinInView("what is a zk rollup?", ["general"], [MINT]), null);
    // a question about something else since: out of view
    assert.equal(coinInView("who are the top holders?", T, [scanned, "what's running on pump.fun right now?"]), null);
    assert.equal(coinInView("and its holders?", T, [scanned, "what is crawlnet?"]), null);
    // a subject of its own: a ticker in capitals, a major, a link, a shortened address
    assert.equal(coinInView("Top FOOBAR holders", T, [scanned]), null);
    assert.equal(coinInView("check the ABC4 quote token", T, [scanned]), null);
    assert.equal(coinInView("what do u think about sol", T, [scanned]), null);
    assert.equal(coinInView("Give me everything you have on xrp", T, [scanned]), null);
    assert.equal(coinInView("https://example.com/", T, [scanned]), null);
    assert.equal(coinInView("check this wallet: Abcd12…Wxyz34", ["wallet", "token"], [scanned]), null);
    assert.equal(coinInView("check @sometrader’s pnl history", ["wallet"], [scanned]), null, "a trader by handle");
    assert.equal(coinInView("did @somecaller buy it before he called it?", ["caller", "wallet"], [scanned]), scanned, "a caller's handle asks about the coin");
    assert.equal(coinInView("who are the largest holders?", T, ["what is a zk rollup?"]), null, "no coin before");
  });

  it("majors are no coin to scan by their cashtag; $crawl is a coin like any other; an address always is", () => {
    assert.equal(namesCoin("is $SOL going up"), false);
    assert.equal(namesCoin("$crawl price"), true);
    assert.equal(namesCoin("$WIF holders"), true);
    assert.equal(namesCoin(`what about ${MINT}`), true);
  });
});

describe("harness: the plan", () => {
  it("each intent its own functions, calls and effort; a follow-up's two intents together; only what is offered", () => {
    const token = harnessPlan(["token"], ALL);
    assert.ok(token.tools.includes("sol_holder_links") && token.tools.includes("hub_find") && !token.tools.includes("yield_pools"));
    assert.deepEqual([token.maxCalls, token.effort, token.facts], [8, "medium", false]);
    const defi = harnessPlan(["defi"], ALL);
    assert.deepEqual([defi.effort, defi.tools.includes("protocol_tvl"), defi.tools.includes("sol_launch")], ["low", true, false]);
    const self = harnessPlan(["self"], ALL);
    assert.equal(self.facts, true, "the fact sheet only comes on a question about crawlnet");
    const both = harnessPlan(["wallet", "token"], ALL);
    assert.ok(both.tools.includes("sol_money_trail") && both.tools.includes("sol_holder_links"));
    assert.equal(both.maxCalls, 10);
    assert.deepEqual(harnessPlan(["token"], ["token_pairs", "not_a_tool"]).tools, ["token_pairs"]);
    assert.equal(harnessPlan(["general"], ALL, "give me everything you have on xrp").effort, "medium", "a deep read thinks harder");
    assert.equal(harnessPlan(["general"], ALL, "what is a zk rollup?").effort, "low");
  });

  it("what how she works names comes with the hub; a coin's pools and top holders' records, a call's coin, a claim's chain", () => {
    // how she works names a chain's raw reads beside the hub's routes: every plan with the hub offers them
    for (const i of ["token", "wallet", "caller", "narrative", "defi", "prediction", "claim", "general"] as const) assert.ok(harnessPlan([i], ALL).tools.includes("hub_rpc"), i);
    assert.match(harnessSystem("q-test-0000"), /hub_rpc/);
    // whether a coin's volume is real (a pool's unique buyers and sellers)
    const token = harnessPlan(["token"], ALL).tools;
    assert.ok(token.includes("pool_snapshot"), token.join());
    // the dossier of a coin a call is on points to its story; its risk flags beside the front-run
    const caller = harnessPlan(["caller"], ALL).tools;
    assert.ok(caller.includes("meme_narrative") && caller.includes("token_risk_flags"), caller.join());
    // a pasted post's claim about a coin is settled on the chain: its functions are fixed before the post is read
    const claim = harnessPlan(["claim"], ALL).tools;
    for (const t of ["token_risk_flags", "sol_launch", "sol_holder_links", "sol_largest_accounts", "sol_token_origin", "call_frontrun"]) assert.ok(claim.includes(t), t);
    assert.equal(harnessPlan(["claim"], ALL).maxCalls, 6, "more to choose from, not more calls");
  });

  it("what runs now: the board code reads first; the newest pools only on an ask for new pairs or launches", () => {
    assert.deepEqual(planReads(["narrative"]), [
      { name: "meme_runners", args: { hours: 3 } },
      { name: "meme_metas", args: {} },
      { name: "x_ideas", args: { limit: 6 } },
      { name: "ct_calls", args: { view: "narratives" } },
      { name: "hub_call", args: { provider: "dexscreener", path: "/metas/trending/v1" } },
    ]);
    assert.deepEqual(planReads(["token"]), []);
    assert.equal(harnessPlan(["narrative"], ALL, "what's running on pump.fun right now?").tools.includes("fresh_pools"), false);
    for (const q of ["any fresh launches on pump.fun?", "check the last 100 tokens launched on pumpfun", "new pairs on base"]) assert.ok(harnessPlan(["narrative"], ALL, q).tools.includes("fresh_pools"), q);
    assert.ok(harnessPlan(["narrative"], ALL).tools.includes("fresh_pools"), "with no question, every function the plan may offer");
    const reads = planReads(["narrative"]).map((r) => ({ ...r, result: { ok: true as const, data: {}, sources: [] } }));
    assert.match(intentMessage({ ...harnessPlan(["narrative"], ALL), reads }), /the reads block holds meme_runners, meme_metas, x_ideas, ct_calls, hub_call, read by code just now: never call them again, with these or other arguments, except for a narrower read/);
    // the posts on x about the top stories, started by code and left running: the model's call with these arguments joins it
    const running = [{ name: "social_mentions", args: { query: '$ABC OR "a story" since:2026-01-01', sort: "Top" } }];
    assert.match(intentMessage({ ...harnessPlan(["narrative"], ALL), reads, running }), /running now, started by code: social_mentions \{"query":"\$ABC OR \\"a story\\" since:2026-01-01","sort":"Top"\}\. when you want them, call each with exactly these arguments: your call joins the running read\./);
  });

  it("crawlnet named beside a coin brings the fact sheet, the only real ca the copycat check has", () => {
    const copy = `is this the real crawlnet token? ${MINT}`;
    assert.deepEqual(harnessIntents(copy), ["token"], "a named coin is a coin check");
    assert.equal(harnessPlan(harnessIntents(copy), ALL, copy).facts, true);
    assert.equal(harnessPlan(["token"], ALL, `is $crawl's ca ${MINT}?`).facts, true);
    assert.equal(harnessPlan(["token"], ALL, `is ${MINT} a rug?`).facts, false, "a coin check alone needs no fact sheet");
  });

  it("a function whose description names another comes with it in every plan (the tools' descriptions name these: their schema.test.ts)", () => {
    const named: Record<string, string> = { dex_pair_lookup: "token_pairs", pool_snapshot: "token_pairs", hub_find: "hub_call", hub_call: "hub_find" };
    for (const i of ["token", "wallet", "caller", "narrative", "defi", "prediction", "claim", "self", "general"] as const) {
      const tools = harnessPlan([i], ALL).tools;
      for (const [f, other] of Object.entries(named)) if (tools.includes(f)) assert.ok(tools.includes(other), `${i}: ${f} points to ${other}`);
    }
  });
});

const status: BrainStatus = { about: "the about sheet: crawl's only ca is X." };
const ask = (o: Partial<AskInput> = {}): AskInput => ({ question: "is $COIN a rug?", status, harness: { history: [], texts: [] }, ...o });

describe("harness: the prompt", () => {
  it("its own system prompt, the status without the fact sheet off crawlnet, the playbook; within its size; an input with no plan gets the one code reads", () => {
    const plan = harnessPlan(["token"], ALL);
    const p = answerPrompt(ask({ harness: { history: [], texts: [], plan } }), null);
    assert.equal(p.system.length, 3);
    assert.match(p.system[0]!, /^\[q-[0-9a-f]{8}\]\nyou are the queen of crawlnet/, "the canary is new each process");
    assert.match(p.system[0]!, /the trench read/);
    assert.doesNotMatch(p.system[1]!, /about crawlnet \(trusted/, "no fact sheet on a coin check");
    assert.match(p.system[2]!, /^this question: token/);
    assert.match(p.system[2]!, /at most 8 calls/);
    const tools = { module: { run: async () => ({ ok: false as const, error: "unavailable" as const }) }, specs: [{ name: "token_pairs", description: "pairs", parameters: { type: "object" } }], answerId: "a1" };
    const size = p.system.join("").length;
    assert.ok(size < 20_500, `${size}`);
    // an input with no plan (a caller that builds none): the same prompt, the plan read by code from the question, the
    // functions offered and the calls the brain lets it make (TOOL_CALLS_PER_ANSWER_MAX with no maxCalls given)
    const planless = answerPrompt(ask(), tools as never);
    assert.equal(planless.system.length, 3);
    assert.equal(planless.system[0], p.system[0]);
    assert.match(planless.system[2]!, /^this question: token\n/);
    assert.match(planless.system[2]!, /\n- at most 4 calls for this answer\.$/);
    assert.doesNotMatch(answerPrompt(ask(), null).system[2]!, /calls for this answer/, "none offered: nothing said of calls");
    const self = answerPrompt(ask({ question: "what is crawlnet?", harness: { history: [], texts: [], plan: harnessPlan(["self"], ALL) } }), null);
    assert.match(self.system[1]!, /about crawlnet \(trusted, current\):\nthe about sheet/);
  });

  it("the leak check guards how she works, the hard rules and the reply format, never the lines she says or her trench read", () => {
    const sys = harnessSystem("q-test-0000");
    for (const say of SAYABLE) assert.ok(sys.includes(say), say.slice(0, 40));
    const how = HARNESS_GUARDED[0]!;
    assert.equal(leaks(how.slice(40, 200), []), true, "a run of how she works is a leak");
    assert.equal(leaks(`answer: ${SAYABLE[2]}`, []), false, "no financial advice, said in her words");
    assert.equal(leaks("the trap first: a pool its deployer can pull (lp under 90% locked or burned outside the bonding curve), live mint or freeze authority", []), false, "her read words her answers");
  });

  it("a coin check that ends on her risk read is no leak; the rest of that rule's line still is", () => {
    const hard = HARNESS_GUARDED[1]!;
    assert.ok(hard.includes(SAY_RISK_READ) && SAYABLE.includes(SAY_RISK_READ));
    assert.equal(leaks(`**clean on-chain.** lp burned, authorities revoked, no tied cluster among the top 20 holders.\n\n${SAY_RISK_READ}`, []), false);
    assert.equal(leaks('"next 100x" or "what should i buy" gets no pick: you read, you don\'t pick; offer what is running today, as facts.', []), true);
  });

  it("the limits are said as the forms to use, never as disclaimers to write", () => {
    const prompt = [harnessSystem("q-test-0000"), ...Object.values(PLAYBOOKS)].join("\n");
    for (const hedge of [/never certain ownership/, /never proven identity/, /for certain/, /never call its counts totals/, /unverified/, /a label read off the coin/, /no hedges \(/]) assert.doesNotMatch(prompt, hedge);
    assert.match(prompt, /the limits in these rules bind what you claim, never lines to write: no sentence about what a read does not show, prove, establish, settle or rule out, and no correction of a claim nobody made/);
    assert.match(prompt, /a clean read is said clean with its scope \("no tied cluster among the top 20 holders"\), a claim with its owner \("the team claims"\)/);
    assert.match(prompt, /say what ties them to the caller and stop there/);
    assert.match(prompt, /or that nothing settles it yet, with the deciding fact/);
    assert.match(SAY_RISK_READ, /never the word "safe"; a clean check says what read clean/);
  });

  it("the intent message names each intent's playbook and the calls", () => {
    const m = intentMessage(harnessPlan(["wallet", "token"], ALL));
    assert.match(m, /this question: wallet\n- a wallet\./);
    assert.match(m, /this question: token\n- a coin\./);
    assert.match(m, /at most 10 calls/);
    assert.match(m, /whether it is the og \(its launch against the story's first post, then its volume against the copies': an older coin with the same name is an old ca, never the og\)/, "how a coin check settles the og");
    assert.match(m, /a dev bag that left its wallet and the dossier does not place: sol_money_trail on the dev \(into the pool or the curve is a sale; to wallets, side wallets whose share counts as the dev's\)/);
  });
});

const facts = (o: Partial<ScanFacts> = {}): ScanFacts => ({
  kind: "token",
  chain: "solana",
  symbol: "fres",
  resolved: "address",
  via: null,
  address: MINT,
  market: { priceUsd: 0.0001, mcapUsd: 40_000, fdvUsd: 40_000, liquidityUsd: 25_000, volume24hUsd: 100_000, pools: 1, oldestPoolAgeDays: 0.2, buys24h: 100, sells24h: 80, curve: false } as ScanFacts["market"],
  authorities: { mint: "revoked", freeze: "revoked" },
  program: "spl",
  security: null,
  holders: null,
  dev: null,
  wallet: null,
  flags: [],
  goods: [],
  notes: [],
  unreliable: [],
  results: [],
  calls: [],
  ...o,
});

describe("harness: the dossier", () => {
  it("the checks with their levels, the deeper reads on the same scale, the worst of all; a read still running says how to get it", () => {
    const lines = dossierLines(
      facts({
        deep: {
          launch: { rows: [{ role: "dev", wallet: "all", first_buys_pct: 3, holds_now_pct: 16, sold_since_pct: 0, wallets: 1 }] },
          links: "running",
          narrative: { tracked: true, narrative: { narrative: "oil reserve", group: "macro" } },
          metas: { groups: [{ group: "macro", narratives: [{ narrative: "oil reserve fund" }] }] },
        },
      }),
    );
    const text = lines.join("\n");
    assert.match(text, /- checks: dev holds 16% \[DANGER\]; mint authority revoked \[ok\]; freeze authority revoked \[ok\]/, "the launch read's dev is the card's");
    assert.match(text, /- launch: dev bought 3%, holds 16%; insiders holding, not selling: a cabal coin \[DANGER\]/);
    assert.match(text, /- holders tied together: still running \(call sol_holder_links with only the mint: it joins the running read\)/);
    assert.match(text, /- story: "oil reserve" \(macro\), a live meta today \("oil reserve fund"\) \[ok\]/);
    assert.match(text, /- today's metas: oil reserve fund; groups running: macro/);
    assert.match(text, /- worst: DANGER$/);
  });

  it("the launch's dev with the top holders it sent tokens to, from the holder links in the same dossier", () => {
    const DEV = "Dev1111111111111111111111111111111111111111";
    const lines = dossierLines(
      facts({
        deep: {
          launch: { rows: [{ role: "dev", wallet: "all", first_buys_pct: 37, holds_now_pct: 0, sold_since_pct: 37, wallets: 1 }, { role: "dev", wallet: DEV, first_buys_pct: 37, holds_now_pct: 0, sold_since_pct: 37 }] },
          links: { holders: [{ owner: "A1", share_pct: 12, kind: "wallet", tokens_from: { from: DEV, kind: "wallet" } }, { owner: "A2", share_pct: 7, kind: "wallet", tokens_from: { from: DEV, kind: "wallet" } }], clusters: [], connected_share_pct: 0 },
        },
      }),
    ).join("\n");
    assert.match(lines, /- launch: dev bought 37%, holds 0%, 37% left its wallet \(sold or moved\), 2 top holders it sent tokens to hold 19%; insiders selling since launch \[DANGER\]/);
  });

  it("past the top holders: a cabal spread thin is a warning in the dossier and on the card; a wide band of old wallets is said ok and stays off the card", () => {
    const spread = (fresh: number, funded: number) => ({ band: { wallets: 198, share_pct: 62 }, sample: { read: 16, fresh, funders: funded ? [{ address: "Fund1111111111111111111111111111111111111111", wallets: funded }] : [] } });
    const cabal = facts({ deep: { spread: spread(16, 15) } });
    assert.match(dossierLines(cabal).join("\n"), /- past the top holders: a cabal spread thin \(it dumps at once or pumps the coin\): 62% of supply in 198 wallets of 0\.1-1% each; of 16 sampled 16 fresh, 15 sent their first SOL by one wallet \(Fund11…\) \[warn\]/);
    const checks = (f: ScanFacts) => (tokenBlock(f)!.checks ?? []) as TokenBlockCheck[];
    assert.deepEqual(checks(cabal).find((c) => c.label === "cabal"), { label: "cabal", status: "warn", value: "62% in 198 small wallets" });
    const plain = facts({ deep: { spread: spread(1, 0) } });
    assert.match(dossierLines(plain).join("\n"), /- past the top holders: 62% of supply in 198 wallets of 0\.1-1% each; of 16 sampled 1 fresh \[ok\]/);
    assert.equal(checks(plain).some((c) => c.label === "cabal"), false);
    assert.match(dossierLines(facts({ deep: { spread: "running" } })).join("\n"), /- past the top holders: still running \(call sol_holder_spread with only the mint/);
  });

  it("a read that failed says so; no deeper reads, only the checks; nothing for what is no token", () => {
    assert.match(dossierLines(facts({ deep: { links: null } })).join("\n"), /- holders tied together: down right now/);
    const plain = dossierLines(facts());
    assert.equal(plain.some((l) => l.startsWith("- launch")), false);
    assert.equal(plain.at(-1), "- worst: ok");
    assert.deepEqual(dossierLines(facts({ kind: "wallet" })), []);
  });

  it("the scan block: the dossier, the token block whose verdict level is code's, the address for follow-up calls", () => {
    const plan = harnessPlan(["token"], ALL);
    const p = answerPrompt(ask({ harness: { history: [], texts: [], plan }, scan: { facts: facts() } }), null);
    const user = p.userFor(null);
    assert.match(user, /the dossier: code read this just now/);
    assert.match(user, /its oldest pool 5 hours old/);
    assert.match(user, new RegExp(`its address: ${MINT}`));
    assert.match(user, /adding only "verdict": \{"text": "your risk read in one line"\}/);
    assert.match(user, /```token\n\{"symbol":"FRES"/);
  });
});

describe("harness: the dossier's market and exit", () => {
  it("liquidity against the cap, turnover, buys and sells; the exit at three sizes and the largest tied cluster selling; nothing on a curve", () => {
    const cpmm = (usd: number, quote: number) => Math.round(sellImpactFor(usd, quote).slip * 10) / 10;
    assert.equal(cpmm(1_000, 100_000), 1, "a $1k sell into a $100k quote side gets about 1% less");
    const lines = dossierLines(
      facts({
        market: { priceUsd: 0.001, mcapUsd: 1_770_000, fdvUsd: 1_770_000, liquidityUsd: 60_000, volume24hUsd: 3_460_000, pools: 2, oldestPoolAgeDays: 4, buys24h: 9000, sells24h: 8000, curve: false } as ScanFacts["market"],
        deep: { links: { holders: [{ owner: "a", share_pct: 9 }], clusters: [{ cluster: 1, holders: ["a", "b"], wallets: 6, share_pct: 9, funders: ["f"] }], connected_share_pct: 9 } },
      }),
    ).join("\n");
    assert.match(lines, /- market: liquidity 3\.4% of its cap; thin for its size; 24h volume 58x its liquidity; turnover that high on a coin this old is often farmed; 9000 buys, 8000 sells in 24h \[warn\]/);
    assert.match(lines, /- exit \(rough, as one constant-product pool\): \$1\.0k sells about 3\.2% under its value, \$5\.0k sells about 14% under its value, \$25\.0k sells about 45% under its value; the largest tied cluster \(9%\) selling at once would drop it about 9\d% \[note\]/);
    const curve = dossierLines(facts({ market: { priceUsd: 0.00001, mcapUsd: 12_000, fdvUsd: 12_000, liquidityUsd: null, volume24hUsd: 200_000, pools: 2, oldestPoolAgeDays: 0.04, buys24h: 900, sells24h: 700, curve: true } as ScanFacts["market"] })).join("\n");
    assert.doesNotMatch(curve, /- market:|- exit/);
  });
});

describe("harness: the dev from the creator read when the launch read has none", () => {
  const ORIGIN = { found: true, creator: "Dev1111111111111111111111111111111111111111", age_days: 0.2, creator_got_at_creation: { share_pct: 37.23 }, creator_holds_now: { share_pct: 0 } };

  it("the launch read down or still running: the creator read's dev, on the dev scale; a launch read with its dev says it once", () => {
    const down = dossierLines(facts({ deep: { launch: null, origin: ORIGIN } })).join("\n");
    assert.match(down, /- launch: down right now/);
    assert.match(down, /- dev \(creator\): dev got 37\.2% at creation, holds 0% now, 37\.2% left its wallet \(sold or moved\), where it went unread \[warn\]/);
    assert.match(down, /- worst: warn$/);
    const running = dossierLines(facts({ deep: { launch: "running", origin: "running" } })).join("\n");
    assert.match(running, /- dev \(creator\): still running \(call sol_token_origin with only the mint: it joins the running read\)/);
    const launched = dossierLines(facts({ deep: { launch: { rows: [{ role: "dev", wallet: "all", first_buys_pct: 3, holds_now_pct: 0, sold_since_pct: 3, wallets: 1 }] }, origin: ORIGIN } })).join("\n");
    assert.doesNotMatch(launched, /dev \(creator\)/);
    assert.match(dossierLines(facts({ deep: { launch: null, origin: { found: false } } })).join("\n"), /- dev \(creator\): its creator not found/);
  });

  it("the scan reads the creator into the dossier; one back after the scan still reaches the answer's token block", { timeout: 15_000 }, async () => {
    const MINT2 = "Ab3dEf5gHjKmNpQrStUvWxYz12345678ABCDEFpump";
    const okr = (data: unknown): ToolResult => ({ ok: true, data, sources: [] });
    const data: Record<string, ToolResult> = {
      sol_account_basics: okr({ kind: "token_mint", mint: { mint_authority: "none", freeze_authority: "none", token_2022: false } }),
      token_pairs: okr({ totals: { symbol: "NEW", pools: 1, liquidity_usd: 6e4, volume_24h_usd: 5e4, market_cap_usd: 3e5, oldest_pool_age_days: 0.2, txns_24h: { buys: 300, sells: 200 }, dexes: ["pumpswap"] } }),
      sol_largest_accounts: okr({ top10_share_pct: 30, top10_wallets_share_pct: 12, largest_wallet_share_pct: 3, program_accounts_share_pct: 18 }),
      sol_token_origin: okr({ ...ORIGIN, creator_holds_now: { share_pct: 16 } }),
    };
    const scan = async (late: boolean) => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const call: ScanCall = async (name) => {
        if (late && name === "sol_token_origin") await held;
        const result = data[name] ?? { ok: false as const, error: "unavailable" as const, message: "down" };
        return { result, log: { tool: name, ok: result.ok, ms: 1, round: 0 } };
      };
      const f = await runScan({ address: MINT2, ticker: null, family: "solana", chain: "solana", from: "question", dev: false, holders: false }, call, () => true, Date.now(), { behind: true, deep: true });
      return { f, release };
    };
    const quick = await scan(false);
    assert.equal(quick.f.deep?.launch, null, "the launch read failed");
    assert.equal((quick.f.deep?.origin as Record<string, unknown>).found, true);
    assert.match(dossierLines(quick.f).join("\n"), /- dev \(creator\): dev got 37\.2% at creation, holds 16% now, 21\.2% left its wallet \(sold or moved\), where it went unread \[DANGER\]/);
    const late = await scan(true);
    assert.equal(late.f.deep?.origin, "running");
    assert.equal(late.f.dev, null);
    const block = { address: MINT2, symbol: "NEW", checks: [{ label: "mint authority", status: "ok", value: "revoked" }], verdict: { level: "low", text: "clean on-chain" } };
    const answer = `**clean on-chain.**\n\n\`\`\`token\n${JSON.stringify(block)}\n\`\`\``;
    late.release();
    await new Promise((r) => setImmediate(r));
    const dev = late.f.dev as ScanFacts["dev"];
    assert.equal(dev?.found && dev.holdsPct, 16, "landed in the facts after the scan");
    const merged = JSON.parse(withLateChecks(answer, late.f).match(/```token\n(.+)\n```/)![1]!) as { checks: TokenBlockCheck[]; verdict: { level: string } };
    assert.ok(merged.checks.some((c) => c.label === "dev holds" && c.status === "bad"), JSON.stringify(merged.checks));
    assert.equal(merged.verdict.level, "high");
  });
});

describe("harness: the token card carries the dossier's deeper reads, so its level is the dossier's worst", () => {
  const DEV = "Dev1111111111111111111111111111111111111111";
  const WORST: Record<string, Severity> = { DANGER: "danger", warn: "warn", note: "note", ok: "ok" };
  const dossierWorst = (f: ScanFacts) => WORST[dossierLines(f).at(-1)!.replace("- worst: ", "")]!;
  const checksOf = (f: ScanFacts) => (tokenBlock(f)!.checks as TokenBlockCheck[]).map((c) => `${c.label}: ${c.value} (${c.status})`);
  const clean = { lpLocked: true, lpLockedPct: 100, honeypot: null, taxed: null, hook: null, nonTransferable: null, balanceMutable: null };
  const cluster = (share: number, wallets = 31) => ({ holders: [{ owner: "A1", share_pct: 3, kind: "wallet" }], clusters: [{ cluster: 1, holders: ["A1", "A2"], wallets, share_pct: share, funders: ["F1"] }], connected_share_pct: share });
  const launch = (o: { devHolds?: number; devBought?: number; bundleHolds?: number; snipersHold?: number; seen?: number } = {}) => ({
    ...(o.seen !== undefined ? { window_seconds: 60, seconds_read: o.seen } : {}),
    rows: [
      { role: "dev", wallet: "all", first_buys_pct: o.devBought ?? 2, holds_now_pct: o.devHolds ?? 0, sold_since_pct: (o.devBought ?? 2) - (o.devHolds ?? 0), wallets: 1 },
      { role: "dev", wallet: DEV, first_buys_pct: o.devBought ?? 2, holds_now_pct: o.devHolds ?? 0, sold_since_pct: (o.devBought ?? 2) - (o.devHolds ?? 0) },
      { role: "bundle", wallet: "all", first_buys_pct: 30, holds_now_pct: o.bundleHolds ?? 0, wallets: 12 },
      { role: "sniper", wallet: "all", first_buys_pct: 20, holds_now_pct: o.snipersHold ?? 1, wallets: 40 },
    ],
  });
  const coin = (deep: NonNullable<ScanFacts["deep"]>, o: Partial<ScanFacts> = {}) => facts({ security: clean, holders: { top10Pct: 30, top10WalletsPct: 14, largestWalletPct: 3, programPct: 16 }, deep, ...o });

  it("a coin whose scan checks are all ok, with a 38% tied cluster and a bundle holding 24%: DANGER in the dossier, high risk on the card and in the line it orders", () => {
    const f = coin({ links: cluster(38), launch: launch({ bundleHolds: 24 }) });
    assert.equal(dossierWorst(f), "danger");
    const checks = checksOf(f);
    assert.ok(checks.includes("tied cluster: 38% in 31 wallets, 1 funder (bad)") && checks.includes("bundle: 24% held, 12 wallets (bad)"), checks.join(", "));
    assert.equal(checks.findIndex((c) => c.endsWith("(ok)")) > checks.findIndex((c) => c.startsWith("bundle")), true, "worst first");
    assert.equal(checksVerdict(tokenBlock(f)!.checks as TokenBlockCheck[]), "high");
    const p = answerPrompt(ask({ harness: { history: [], texts: [], plan: harnessPlan(["token"], ALL) }, scan: { facts: f } }), null);
    assert.match(p.userFor(null), /its level is code's, the read's worst: high risk, so your line and your answer's first line read as that/);
  });

  it("the stamped level cannot fall back: a block the model copied without the deeper reads gets them back, and its level with them", () => {
    const f = coin({ links: cluster(38), launch: launch({ bundleHolds: 24 }) });
    const block = { ...tokenBlock(f)!, checks: [{ label: "mint authority", status: "ok", value: "revoked" }], verdict: { level: "low", text: "clean on-chain" } };
    const out = JSON.parse(withLateChecks(`\`\`\`token\n${JSON.stringify(block)}\n\`\`\``, f).match(/```token\n(.+)\n```/)![1]!) as { checks: TokenBlockCheck[]; verdict: { level: string } };
    assert.ok(out.checks.some((c) => c.label === "tied cluster" && c.status === "bad"));
    assert.equal(out.verdict.level, "high");
    // the model's own check of a kind code has (its own launch call) stands, never doubled
    const own = { ...block, checks: [{ label: "bundles", status: "bad", value: "24% still held" }] };
    const kept = JSON.parse(withLateChecks(`\`\`\`token\n${JSON.stringify(own)}\n\`\`\``, f).match(/```token\n(.+)\n```/)![1]!) as { checks: TokenBlockCheck[] };
    assert.equal(kept.checks.filter((c) => /bundl/.test(c.label)).length, 1);
  });

  it("the dev on the card is the dossier's: the launch's with its side wallets, else the creator's, a big bag gone unplaced a warning", () => {
    const side = { holders: [1, 2, 3].map((i) => ({ owner: `S${i}`, share_pct: 7, kind: "wallet", tokens_from: { from: DEV, kind: "wallet" } })), clusters: [], connected_share_pct: 0 };
    const sent = coin({ launch: launch({ devBought: 37, devHolds: 1 }), links: side });
    assert.ok(checksOf(sent).includes("dev holds: 22% with 3 side wallets (bad)"), checksOf(sent).join(", "));
    assert.equal(dossierWorst(sent), "danger");
    const unplaced = coin({ launch: null, origin: { found: true, creator: DEV, creator_got_at_creation: { share_pct: 37.23 }, creator_holds_now: { share_pct: 0 } } }, { dev: { found: true, ageDays: 0.2, gotPct: 37.23, holdsPct: 0, creator: DEV } });
    assert.ok(checksOf(unplaced).includes("dev holds: 0%, 37% sold or sent (warn)"), checksOf(unplaced).join(", "));
    assert.equal(dossierWorst(unplaced), "warn");
    const small = coin({ launch: launch({ devBought: 3, devHolds: 0 }) });
    assert.ok(checksOf(small).includes("dev holds: 0% (ok)"));
  });

  it("snipers on the card once read whole, or once a screen's floor is over the line; a copied or farmed story and a thin or farmed market as warnings", () => {
    assert.ok(checksOf(coin({ launch: launch({ snipersHold: 12 }) })).includes("snipers: 12% held, 40 wallets (warn)"));
    assert.ok(checksOf(coin({ launch: launch({ snipersHold: 12, seen: 4 }) })).includes("snipers: 12%+ held, 40 wallets (warn)"));
    assert.ok(!checksOf(coin({ launch: launch({ snipersHold: 3, seen: 4 }) })).some((c) => c.startsWith("snipers")), "a floor under the line says nothing");
    assert.ok(checksOf(coin({ launch: launch({ bundleHolds: 6, seen: 4 }) })).includes("bundle: 6% held, 12 wallets (warn)"), "the creation block's bundle is whole on a screen");
    const copied = coin({ narrative: { tracked: true, narrative: { narrative: "oil reserve", group: "macro", copycat_of: "OIL" } } });
    assert.ok(checksOf(copied).includes("story: a copy of another coin (warn)"));
    const market = { priceUsd: 0.001, mcapUsd: 1_770_000, fdvUsd: 1_770_000, liquidityUsd: 60_000, volume24hUsd: 3_460_000, pools: 2, oldestPoolAgeDays: 4, buys24h: 9000, sells24h: 8000, curve: false };
    assert.ok(checksOf(coin({}, { market })).includes("market: thin, volume 58x liquidity (warn)"));
    assert.ok(checksOf(coin({}, { market: { ...market, volume24hUsd: 100_000 } })).includes("market: thin: liquidity 3.4% of cap (warn)"));
    const old = { ...market, mcapUsd: 220_400_000, fdvUsd: 220_500_000, liquidityUsd: 6_470_000, volume24hUsd: 3_100_000, oldestPoolAgeDays: 1056 };
    assert.ok(!checksOf(coin({}, { market: old })).some((c) => c.startsWith("market")), "an old, large coin's pools are never thin by their share of its cap");
    assert.doesNotMatch(dossierLines(coin({}, { market: old })).join("\n"), /thin for its size/);
    assert.ok(!checksOf(facts()).some((c) => /^(market|story|bundle|snipers|tied cluster):/.test(c)), "no deeper reads, no such checks");
    const evm = facts({ chain: "base", address: EVM_TOKEN, authorities: null, program: null, market });
    assert.ok(checksOf(evm).includes("market: thin, volume 58x liquidity (warn)"), "an evm coin's market too: the dossier says it of one");
    assert.equal(checksVerdict(tokenBlock(evm)!.checks as TokenBlockCheck[]), verdictLevel(dossierWorst(evm)));
  });

  it("the scan's red flags and warnings say the deeper reads too: never 'red flags: none found' under a dossier's DANGER", async () => {
    const PUMP = "Ab3dEf5gHjKmNpQrStUvWxYz12345678ABCDEFpump";
    const okr = (data: unknown): ToolResult => ({ ok: true, data, sources: [] });
    const side = { holders: [1, 2].map((i) => ({ owner: `S${i}`, share_pct: 9, kind: "wallet", tokens_from: { from: DEV, kind: "wallet" } })), clusters: [{ cluster: 1, holders: ["S1", "S2"], wallets: 31, share_pct: 38, funders: ["F1"] }], connected_share_pct: 38 };
    const data: Record<string, ToolResult> = {
      sol_account_basics: okr({ kind: "token_mint", mint: { mint_authority: "none", freeze_authority: "none", token_2022: false } }),
      token_pairs: okr({ totals: { symbol: "NEW", pools: 1, liquidity_usd: 6e4, volume_24h_usd: 5e4, market_cap_usd: 3e5, oldest_pool_age_days: 0.2, txns_24h: { buys: 300, sells: 200 }, dexes: ["pumpswap"] } }),
      sol_holder_links: okr(side),
      sol_launch: okr(launch({ devBought: 30, devHolds: 0, snipersHold: 12 })),
    };
    const call: ScanCall = async (name) => {
      const result = data[name] ?? { ok: false as const, error: "unavailable" as const, message: "no" };
      return { result, log: { tool: name, ok: result.ok, ms: 1, round: 0 } };
    };
    const f = await runScan({ address: PUMP, ticker: null, family: "solana", chain: "solana", from: "question", dev: true, holders: false }, call, () => true, Date.now(), { behind: true, deep: true });
    assert.ok(f.flags.includes("the dev: 18% with 2 side wallets") && f.flags.includes("tied cluster: 38% in 31 wallets, 1 funder"), f.flags.join(" | "));
    assert.ok(f.notes.includes("a warning: snipers: 12% held, 40 wallets"), f.notes.join(" | "));
    assert.equal(dossierWorst(f), "danger");
  });

  it("whatever the reads, the card's verdict is the dossier's worst", () => {
    const cases: ScanFacts[] = [
      coin({ links: cluster(38), launch: launch({ bundleHolds: 24 }) }),
      coin({ links: cluster(20) }),
      coin({ links: cluster(5), launch: launch({ devHolds: 16, devBought: 16 }) }),
      coin({ launch: launch({ bundleHolds: 6 }) }),
      coin({ launch: launch({ snipersHold: 11, seen: 3 }), links: "running" }),
      coin({ launch: "running", origin: "running", links: null }),
      coin({ narrative: { tracked: true, narrative: { narrative: "x", group: "other", copycat_of: "Y" } } }),
      coin({ links: cluster(2) }, { market: { priceUsd: 0.001, mcapUsd: 2_000_000, fdvUsd: 2_000_000, liquidityUsd: 50_000, volume24hUsd: 100_000, pools: 1, oldestPoolAgeDays: 3, buys24h: 10, sells24h: 9, curve: false } }),
      coin({ links: cluster(2) }),
    ];
    for (const f of cases) assert.equal(checksVerdict(tokenBlock(f)!.checks as TokenBlockCheck[]), verdictLevel(dossierWorst(f)), dossierLines(f).join(" | "));
  });
});

describe("harness: a deeper read back after the scan lands in its dossier, and the dev's money trail is read by code", () => {
  const PUMP = "Ab3dEf5gHjKmNpQrStUvWxYz12345678ABCDEFpump";
  const DEV = "Dev1111111111111111111111111111111111111111";
  const okr = (data: unknown): ToolResult => ({ ok: true, data, sources: [] });
  const base: Record<string, ToolResult> = {
    sol_account_basics: okr({ kind: "token_mint", mint: { mint_authority: "none", freeze_authority: "none", token_2022: false } }),
    token_pairs: okr({ totals: { symbol: "NEW", pools: 1, liquidity_usd: 6e4, volume_24h_usd: 5e4, market_cap_usd: 3e5, oldest_pool_age_days: 0.2, txns_24h: { buys: 300, sells: 200 }, dexes: ["pumpswap"] } }),
  };
  const launch = (bought: number, holds: number) =>
    okr({
      rows: [
        { role: "dev", wallet: "all", first_buys_pct: bought, holds_now_pct: holds, sold_since_pct: bought - holds, wallets: 1 },
        { role: "dev", wallet: DEV, first_buys_pct: bought, holds_now_pct: holds, sold_since_pct: bought - holds },
      ],
    });
  const trail = (outgoing: Record<string, unknown>[], back = 0) => okr({ address: DEV, transactions_read: 40, outgoing, incoming: back ? [{ from: "Pool1", asset: "SOL", amount: back, counterparty: "pool" }] : [], complete: true });
  const checksOf = (f: ScanFacts) => (tokenBlock(f)!.checks as TokenBlockCheck[]).map((c) => `${c.label}: ${c.value} (${c.status})`);
  const scan = async (data: Record<string, ToolResult>, hold: string | null = null) => {
    const asked: { name: string; args: Record<string, unknown> }[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const call: ScanCall = async (name, args) => {
      asked.push({ name, args });
      if (name === hold) await held;
      const result = data[name] ?? { ok: false as const, error: "unavailable" as const, message: "no" };
      return { result, log: { tool: name, ok: result.ok, ms: 1, round: 0 } };
    };
    const f = await runScan({ address: PUMP, ticker: null, family: "solana", chain: "solana", from: "question", dev: false, holders: false }, call, () => true, Date.now(), { behind: true, deep: true });
    return { f, asked, release };
  };

  it("a read back after the scan: in the same dossier when it lands, in its data and red flags once settled, once", { timeout: 15_000 }, async () => {
    const links = okr({ holders: [{ owner: "A1", share_pct: 9, kind: "wallet" }], clusters: [{ cluster: 1, holders: ["A1", "A2"], wallets: 31, share_pct: 38, funders: ["F1"] }], connected_share_pct: 38 });
    const { f, release } = await scan({ ...base, sol_holder_links: links }, "sol_holder_links");
    assert.equal(f.deep?.links, "running");
    assert.match(dossierLines(f).join("\n"), /- holders tied together: still running/);
    assert.ok(!f.flags.some((x) => x.startsWith("tied cluster")));
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal((f.deep?.links as unknown as Record<string, unknown>).connected_share_pct, 38, "landed in the same dossier (narrowed to running above)");
    assert.match(dossierLines(f).join("\n"), /- holders tied together: largest cluster 38% \(31 wallets, 1 shared funder\) \[DANGER\]/);
    settleDeep(f);
    assert.ok(f.results.some((r) => r.name === "sol_holder_links"), "its data joins the scan's");
    assert.ok(f.flags.includes("tied cluster: 38% in 31 wallets, 1 funder"), f.flags.join(" | "));
    settleDeep(f);
    assert.equal(f.flags.filter((x) => x.startsWith("tied cluster")).length, 1);
    assert.equal(f.results.filter((r) => r.name === "sol_holder_links").length, 1);
    assert.equal(f.deep?.trail, undefined, "no dev named: no trail");
  });

  it("the dev's bag gone: its money trail read beside the rest by its address and the coin's mint (the model's own call joins it), said in the dossier", async () => {
    const rows = [
      { to: "Pool1", asset: "NEW", mint: PUMP, amount: 104_000_000, transfers: 3, counterparty: "pool" },
      { to: "W1", asset: "NEW", mint: PUMP, amount: 26_000_000, transfers: 1, counterparty: "wallet" },
      { to: "Cex1", asset: "SOL", amount: 9.5, transfers: 1, counterparty: "exchange", label: "Binance" },
    ];
    const { f, asked } = await scan({ ...base, sol_launch: launch(13, 0), sol_money_trail: trail(rows, 12.34) });
    assert.deepEqual(asked.find((a) => a.name === "sol_money_trail")?.args, { address: DEV, mint: PUMP });
    assert.equal(f.deep?.devWallet, DEV);
    assert.ok(f.results.some((r) => r.name === "sol_money_trail"), "its data with the scan's");
    assert.equal(
      dossierLines(f).find((l) => l.startsWith("- the dev's money:")),
      "- the dev's money: 40 of its transactions read: 80% of what it moved into pools or its curve (sold); 20% to 1 wallet, none of them a top holder now; 12.3 SOL back from pools; 9.5 SOL sent to an exchange (Binance) [note]",
    );
    // a fifth of the 13% that left is 2.6% of supply: under the dev's warning share
    assert.ok(!checksOf(f).some((c) => c.startsWith("dev's bag")), checksOf(f).join(", "));
  });

  it("a bag sent on to wallets outside the top holders: the dev's warning, on the card and in the notes as in the dossier", async () => {
    const rows = [1, 2, 3].map((i) => ({ to: `W${i}`, asset: "NEW", mint: PUMP, amount: 100_000_000, transfers: 1, counterparty: "wallet" }));
    const { f } = await scan({ ...base, sol_launch: launch(30, 0), sol_money_trail: trail(rows) });
    assert.match(dossierLines(f).join("\n"), /- the dev's money: 40 of its transactions read: 100% to 3 wallets, none of them a top holder now \[warn\]/);
    assert.ok(checksOf(f).includes("dev's bag: 30% of supply sent to 3 wallets outside the top holders (warn)"), checksOf(f).join(", "));
    assert.ok(f.notes.includes("a warning: dev's bag: 30% of supply sent to 3 wallets outside the top holders"), f.notes.join(" | "));
  });

  it("a bag moved into a pool's or a program's account with no SOL back is no sale: liquidity it placed or a lock, still its own, a warning at the dev's share", async () => {
    const rows = [{ to: "Prog1", asset: "NEW", mint: PUMP, amount: 130_000_000, transfers: 1, counterparty: "program" }];
    const { f } = await scan({ ...base, sol_launch: launch(13, 0), sol_money_trail: trail(rows) });
    assert.equal(
      dossierLines(f).find((l) => l.startsWith("- the dev's money:")),
      "- the dev's money: 40 of its transactions read: 100% of what it moved into a pool's or a program's account with no SOL back (liquidity it placed or a lock: still its own, a sale not read) [warn]",
    );
    assert.ok(checksOf(f).includes("dev's bag: 13% of supply placed in a pool's or a program's account, nothing back (warn)"), checksOf(f).join(", "));
  });

  it("a dev still holding its bag: no trail asked, no line", async () => {
    const { f, asked } = await scan({ ...base, sol_launch: launch(13, 13), sol_money_trail: trail([]) });
    assert.ok(!asked.some((a) => a.name === "sol_money_trail"));
    assert.equal(f.deep?.trail, undefined);
    assert.ok(!dossierLines(f).some((l) => l.startsWith("- the dev's money")));
  });

  it("a trail still running is named with its address so the model's call joins it; one that moved none of the coin says so", () => {
    assert.ok(dossierLines(facts({ deep: { trail: "running", devWallet: DEV } })).includes(`- the dev's money: still running (call sol_money_trail with the address ${DEV} and the coin's mint: it joins the running read)`));
    assert.ok(!dossierLines(facts({ deep: { trail: "running" } })).some((l) => l.startsWith("- the dev's money")), "no dev named yet: no line");
    assert.ok(dossierLines(facts({ deep: { trail: { transactions_read: 40, outgoing: [], incoming: [] }, devWallet: DEV } })).includes("- the dev's money: none of the coin moved in its transactions read"));
  });
});

describe("harness: the launch read by depth", () => {
  const PUMP = "Ab3dEf5gHjKmNpQrStUvWxYz12345678ABCDEFpump";
  const okr = (data: unknown): ToolResult => ({ ok: true, data, sources: [] });
  const data: Record<string, ToolResult> = {
    sol_account_basics: okr({ kind: "token_mint", mint: { mint_authority: "none", freeze_authority: "none", token_2022: false } }),
    token_pairs: okr({ totals: { symbol: "NEW", pools: 1, liquidity_usd: 6e4, volume_24h_usd: 5e4, market_cap_usd: 3e5, oldest_pool_age_days: 0.2, txns_24h: { buys: 300, sells: 200 }, dexes: ["pumpswap"] } }),
  };
  const launchArgs = async (question: string) => {
    const asked: { name: string; args: Record<string, unknown> }[] = [];
    const call: ScanCall = async (name, args) => {
      asked.push({ name, args });
      const result = data[name] ?? { ok: false as const, error: "unavailable" as const, message: "no" };
      return { result, log: { tool: name, ok: result.ok, ms: 1, round: 0 } };
    };
    const f = await runScan(scanAskOf(question, "", { named: true })!, call, () => true, Date.now(), { behind: true, deep: true });
    return { args: asked.find((a) => a.name === "sol_launch")?.args, screen: f.deep?.screen === true };
  };

  it("a question that asks nothing about the dev, the holders or the launch reads its first page; one that does, the whole minute", async () => {
    assert.deepEqual(await launchArgs(`price of ${PUMP}`), { args: { mint: PUMP, first_page: true }, screen: true });
    assert.deepEqual(await launchArgs(`is ${PUMP} a rug?`), { args: { mint: PUMP, first_page: true }, screen: true });
    for (const q of [`did the dev sell ${PUMP}`, `who are the holders of ${PUMP}`, `any snipers on ${PUMP}?`, `is ${PUMP} a cabal coin?`, `how did ${PUMP} launch`]) assert.deepEqual(await launchArgs(q), { args: { mint: PUMP }, screen: false }, q);
  });

  it("the dossier says how to join a screen still running: the same arguments", () => {
    assert.match(dossierLines(facts({ deep: { launch: "running", screen: true } })).join("\n"), /- launch: still running \(call sol_launch with the mint and first_page true: it joins the running read\)/);
    assert.match(dossierLines(facts({ deep: { launch: "running" } })).join("\n"), /- launch: still running \(call sol_launch with only the mint: it joins the running read\)/);
  });
});

describe("harness: RugCheck's creator history, insiders and rug mark, and one hand split into same-size bags", () => {
  const PUMP = "Ab3dEf5gHjKmNpQrStUvWxYz12345678ABCDEFpump";
  const okr = (data: unknown): ToolResult => ({ ok: true, data, sources: [] });
  const wallets = (n: number, share: number, kind = "wallet") => Array.from({ length: n }, (_, i) => ({ token_account: `T${kind}${share}-${i}`, owner: `O${kind}${share}-${i}`, share_pct: share, holder: kind }));
  const scan = async (flags: Record<string, unknown>, accounts: unknown[]) => {
    const data: Record<string, ToolResult> = {
      sol_account_basics: okr({ kind: "token_mint", mint: { mint_authority: "none", freeze_authority: "none", token_2022: false } }),
      token_pairs: okr({ totals: { symbol: "TEST", pools: 1, liquidity_usd: 8e4, volume_24h_usd: 9e4, market_cap_usd: 6e5, oldest_pool_age_days: 3, txns_24h: { buys: 300, sells: 250 }, dexes: ["pumpswap"] } }),
      sol_largest_accounts: okr({ top10_share_pct: 60, top10_wallets_share_pct: 1.1, largest_wallet_share_pct: 0.1111, program_accounts_share_pct: 58, accounts }),
      token_risk_flags: okr({ lp_locked_pct_lockable: 100, ...flags }),
    };
    const call: ScanCall = async (name) => {
      const result = data[name] ?? { ok: false as const, error: "unavailable" as const, message: "no" };
      return { result, log: { tool: name, ok: result.ok, ms: 1, round: 0 } };
    };
    return runScan({ address: PUMP, ticker: null, family: "solana", chain: "solana", from: "question", dev: false, holders: false }, call, () => true, Date.now(), { behind: true });
  };
  const checksOf = (f: ScanFacts) => (tokenBlock(f)!.checks as TokenBlockCheck[]).map((c) => `${c.label}: ${c.value} (${c.status})`);

  it("a coin rugcheck marks rugged is danger; its insiders and a creator of three coins or more a warning; fewer coins a note", async () => {
    const f = await scan({ rugged: true, insider_wallets_detected: 4, creator_other_tokens: 12 }, wallets(3, 2));
    assert.deepEqual([f.security?.rugged, f.security?.insiders, f.security?.creatorOther], [true, 4, 12]);
    const checks = checksOf(f);
    for (const c of ["rugged: marked by rugcheck (bad)", "insiders: 4 wallets (warn)", "dev's other coins: 12 (warn)"]) assert.ok(checks.includes(c), `${c} in ${checks.join(", ")}`);
    assert.ok(f.flags.includes("rugcheck marks it rugged: its liquidity was pulled"));
    assert.ok(f.notes.includes("a warning: rugcheck detects 4 insider wallets") && f.notes.includes("a warning: its creator made 12 other coins"), f.notes.join(" | "));
    const two = await scan({ insiders_in_top_holders: 0, creator_other_tokens: 2 }, wallets(3, 2));
    assert.ok(checksOf(two).includes("dev's other coins: 2 (na)"));
    assert.ok(!checksOf(two).some((c) => c.startsWith("insiders") || c.startsWith("rugged")));
  });

  it("five of the largest wallets or more holding the same bag are one hand that split it: a warning; pools and programs never count", async () => {
    const f = await scan({}, [...wallets(10, 0.1111), ...wallets(2, 30, "program"), ...wallets(3, 0.5)]);
    assert.deepEqual(f.holders?.equalBags, { wallets: 10, pctEach: 0.1111 });
    assert.ok(checksOf(f).includes("same-size bags: 10 wallets at 0.1% each (warn)"), checksOf(f).join(", "));
    assert.ok(f.notes.includes("a warning: 10 of the largest wallets hold 0.1% each: one hand split it"));
    assert.equal((await scan({}, [...wallets(4, 1), ...wallets(6, 5, "pool")])).holders?.equalBags, undefined, "four wallets alike, the pools aside");
    assert.equal((await scan({}, [1, 1.5, 2, 2.5, 3, 3.5].map((x, i) => ({ owner: `W${i}`, share_pct: x, holder: "wallet" })))).holders?.equalBags, undefined, "different bags");
  });

  it("the risk flags out: the lp lock read from the chain, on the card as the flags' would be", async () => {
    const data: Record<string, ToolResult> = {
      sol_account_basics: okr({ kind: "token_mint", mint: { mint_authority: "none", freeze_authority: "none", token_2022: false } }),
      token_pairs: okr({ totals: { symbol: "TEST", pools: 1, liquidity_usd: 8e4, volume_24h_usd: 9e4, market_cap_usd: 6e5, oldest_pool_age_days: 3, txns_24h: { buys: 300, sells: 250 }, dexes: ["pumpswap"] } }),
      sol_largest_accounts: okr({ top10_share_pct: 20, top10_wallets_share_pct: 10, largest_wallet_share_pct: 2, program_accounts_share_pct: 10, accounts: [] }),
      sol_lp_lock: okr({ pools: [], lp_locked_pct_lockable: 100, lp_locked_usd: 80_000, lp_unread_usd: 0, dlmm_liquidity_usd: 0, source: "chain" }),
    };
    const asked: string[] = [];
    const call: ScanCall = async (name) => {
      asked.push(name);
      const result = data[name] ?? { ok: false as const, error: "unavailable" as const, message: "rugcheck down" };
      return { result, log: { tool: name, ok: result.ok, ms: 1, round: 0 } };
    };
    const f = await runScan({ address: PUMP, ticker: null, family: "solana", chain: "solana", from: "question", dev: false, holders: false }, call, () => true, Date.now(), { behind: true });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(asked.includes("token_risk_flags") && asked.includes("sol_lp_lock"), asked.join(", "));
    assert.deepEqual([f.security?.lpLocked, f.security?.lpLockedPct], [true, 100]);
  });

  it("the dev's other coins never stand in for its holdings on a block the model copied (their kinds differ)", async () => {
    const f = await scan({ creator_other_tokens: 12 }, wallets(3, 2));
    const block = { address: PUMP, checks: [{ label: "dev holds", status: "ok", value: "0%" }], verdict: { level: "low", text: "x" } };
    const out = JSON.parse(withLateChecks(`\`\`\`token\n${JSON.stringify(block)}\n\`\`\``, f).match(/```token\n(.+)\n```/)![1]!) as { checks: TokenBlockCheck[] };
    assert.ok(out.checks.some((c) => c.label === "dev's other coins"));
  });
});

describe("harness: an answer is scrubbed of every function's name, not only the plan's", () => {
  const scanned = facts({
    results: [{ name: "sol_largest_accounts", args: { mint: MINT }, result: { ok: true, data: {}, sources: [] } }],
    calls: [{ tool: "pool_snapshot", ok: true, ms: 1, round: 0 }],
    deep: { launch: "running" },
  });
  const plan = { ...harnessPlan(["defi"], ALL), reads: [{ name: "meme_metas", args: {} }] };
  const spec = (name: string) => ({ name, description: name, parameters: { type: "object" as const, properties: {} } });

  it("the names it scrubs: those offered, those the tools layer lists, and those the prompt names (the scan's calls, its reads still running, the plan's reads)", () => {
    const names = scrubNames(ask({ scan: { facts: scanned }, harness: { history: [], texts: [], plan }, tools: { module: { run: async () => ({ ok: false, error: "unavailable", message: "no" }), list: () => [spec("caller_side_wallets")] }, specs: plan.tools.map(spec), answerId: "a" } }));
    for (const n of ["protocol_tvl", "caller_side_wallets", "sol_largest_accounts", "pool_snapshot", "sol_launch", "meme_metas"]) assert.ok(names.includes(n), n);
    assert.ok(!names.includes("sol_holder_links"), "a read not asked is named nowhere");
  });

  it("an answer, offered the defi plan's functions, loses the scan's too; a reply that still carries \"pages\" is read", async () => {
    const answer = "jupiter's fees ran $1.2m yesterday; per sol_largest_accounts its top 10 hold 14%, and `pool_snapshot` shows 3 of its top traders in.";
    const llm = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ answer, pages: [], followups: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })) as unknown as typeof fetch;
    const cfg = { ...loadLlmConfig({ LLM_API_KEY: "sk-test-not-a-real-key", LLM_MODEL: "test-model", LLM_THINKING: "off" } as NodeJS.ProcessEnv), timeoutMs: 30_000 };
    const tools = { module: { run: async () => ({ ok: false as const, error: "unavailable" as const, message: "no" }) }, specs: plan.tools.map(spec), answerId: "b", maxCalls: 6 };
    const r = await brainAnswer(cfg, ask({ question: "what are jupiter's fees?", scan: { facts: scanned }, harness: { history: [], texts: [], plan }, tools }), llm);
    assert.equal(r.ok && r.answer, "jupiter's fees ran $1.2m yesterday; per its top 10 hold 14%, and shows 3 of its top traders in.");
  });
});

it("xReadOf: a question about what people say of a coin reads its posts on x by its cashtag (the question's own, else the dossier's ticker), Top; any other question none", () => {
  const x = (query: string) => ({ name: "social_mentions", args: { query, sort: "Top" } });
  assert.deepEqual(xReadOf("what is crypto twitter saying about $wif this week?"), x("$WIF"));
  assert.deepEqual(xReadOf("any news on $BONK?"), x("$BONK"));
  assert.deepEqual(xReadOf("why did $popcat pump today"), x("$POPCAT"));
  // no cashtag: the dossier's ticker
  assert.deepEqual(xReadOf("what are people saying about this coin?", "examplecoin"), x("$EXAMPLECOIN"));
  assert.equal(xReadOf("what are people saying about this coin?"), null, "no ticker yet");
  // its name beside its cashtag, as HOW searches
  assert.deepEqual(xReadOf("what are people on x saying about this coin?", "loan", "loanmeme"), x("loanmeme OR $LOAN"));
  assert.deepEqual(xReadOf("what are people on x saying about this coin?", "wif", "dog wif hat"), x('"dog wif hat" OR $WIF'));
  assert.deepEqual(xReadOf("what are people on x saying about this coin?", "bonk", "bonk"), x("$BONK"), "a name that is its ticker adds nothing");
  // no ask about what people say: none
  assert.equal(xReadOf("is $COIN a rug?"), null);
  assert.equal(xReadOf("who holds $WIF?", "wif"), null);
  // a price is no cashtag
  assert.equal(xReadOf("what is ct saying about the $5 coin?"), null);
});

it("\"what are the trends today\" is what runs now too", () => {
  assert.deepEqual(harnessIntents("what are the trends today"), ["narrative"]);
  assert.deepEqual(harnessIntents("what narratives are running today?"), ["narrative"]);
});

describe("harness: the reads block's room", () => {
  it("a short read is shown whole and leaves the rest to the long ones, which share it by weight, none past the cap", () => {
    // the two short reads whole; the metas twice the others' share of what is left
    assert.deepEqual(readShares([600, 600, 7_000, 9_000, 9_000], [1, 1, 2, 1, 1], 12_000), [600, 600, 5_400, 2_700, 2_700]);
    // room for all: each whole, the cap still binds
    assert.deepEqual(readShares([500, 3_000, 9_000], [1, 1, 1], 24_000, 7_000), [500, 3_000, 7_000]);
    assert.deepEqual(readShares([], [], 24_000), []);
  });

  it("the metas of a narrative's board keep their stories whole beside ten other reads", () => {
    const big = (n: number) => ({ ok: true as const, data: { rows: Array.from({ length: n }, (_, i) => ({ i, text: "x".repeat(80) })) }, sources: [] });
    const metas = { ok: true as const, data: { top_narratives: Array.from({ length: 8 }, (_, i) => ({ narrative: `story ${i}`, coins: [{ symbol: `C${i}` }] })), groups: big(60).data.rows }, sources: [] };
    const reads = [
      { name: "meme_metas", args: {}, result: metas },
      ...["meme_runners", "dex_pair_lookup", "token_pairs", "x_ideas", "ct_calls", "hub_call"].map((name) => ({ name, args: {}, result: big(60) })),
      ...["fresh_pools", "news_pages", "social_mentions"].map((name) => ({ name, args: {}, result: big(3) })),
    ];
    const block = readsBlock(reads, "n1");
    assert.ok(block.includes('"narrative":"story 7"'), "every story of the metas is in");
    assert.ok(block.length < 26_000, String(block.length));
  });
});
