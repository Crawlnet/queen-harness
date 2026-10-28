// The live-narrative tools (src/free/narratives.ts) over the services' files: meme_narrative (a coin's label, events and
// flags), meme_metas (groups and narratives of the last 24 h, the last day's metas, ladders left out), meme_runners and
// x_ideas (the X radar's runs: the newest first, an idea seen on several days kept once, a query over its terms, tickers
// and tokens, a stage).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createToolsWith } from "../src/registry.ts";
import { makeCtx, solKey } from "./helpers.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const S = NOW / 1000;
const OIL = solKey("narr-oil");
const LADDER = solKey("narr-ladder");
const AGENT = solKey("narr-agent");

function world() {
  const dir = mkdtempSync(join(tmpdir(), "narr-"));
  const mig = join(dir, "migration/data");
  mkdirSync(join(mig, "daily"), { recursive: true });
  writeFileSync(
    join(mig, "db.json"),
    JSON.stringify({
      tokens: {
        [OIL]: {
          mint: OIL,
          platform: "pump",
          migratedAt: S - 3600,
          createdAt: S - 7200,
          meta: { name: "Oil Reserve", symbol: "OIL" },
          jup: { holders: 900, organicScore: 12 },
          market: { mcap: 900_000, liquidity: 60_000, volume24h: 1_200_000, change: { h1: 12, h24: 300 } },
          ath: { mcap: 1_100_000 },
          events: [{ type: "runner", label: "runner", confirmedAt: S - 3000, median: 210_000, flag: "farm" }],
          // the index's full analysis as it keeps it since its cardV2: the narrative's fields on the analysis itself,
          // the card a profile of the coin, the light label beside them
          analysis: {
            light: { narrative: "oil", group: "commodities/macro" },
            card: { mint: OIL, descriptions: { onchain: "the strategic reserve" }, metrics: { athMcap: 1_100_000 } } as Record<string, unknown>,
            cardV2: true,
            narrative: "strategic oil reserve",
            tags: ["oil", "macro"],
            group: "commodities/macro",
            essence: "a meme on the US oil reserve",
            hype_source: "news/event",
            copycat_of: "",
            legitimacy: "mixed",
            confidence: 0.7,
          },
        },
        [LADDER]: { mint: LADDER, platform: "pump", migratedAt: S - 600, meta: { symbol: "STAIR" }, market: { volume24h: 5_000_000 }, junk: { rigged: true }, analysis: { light: { narrative: "strategic oil reserve", group: "commodities/macro" } } },
        [AGENT]: { mint: AGENT, platform: "stonk", migratedAt: S - 7000, meta: { symbol: "AGNT" }, market: { mcap: 200_000, volume24h: 300_000 }, analysis: { light: { narrative: "ai trading agent", tags: ["ai"], group: "ai" } } },
      },
      state: {},
    }),
  );
  const ev = (o: Record<string, unknown>) => JSON.stringify(o);
  writeFileSync(
    join(mig, "events.jsonl"),
    [
      ev({ type: "runner", label: "runner150k", tier: 150000, confirmedAt: S - 30 * 3600, median: 200_000, mint: AGENT, symbol: "AGNT", platform: "stonk" }),
      ev({ type: "runner", label: "runner150k", tier: 150000, confirmedAt: S - 3000, median: 210_000, flag: "farm", mint: OIL, symbol: "OIL", platform: "pump" }),
      ev({ type: "runner", label: "runner150k", tier: 150000, confirmedAt: S - 2000, median: 400_000, mint: LADDER, symbol: "STAIR", platform: "pump" }),
      ev({ type: "retract", label: "runner150k", mint: LADDER, symbol: "STAIR", reason: "rigged", at: S - 1500 }),
      ev({ type: "tier", label: "1M", tier: 1_000_000, confirmedAt: S - 600, median: 1_300_000, backfill: true, mint: AGENT, symbol: "AGNT", platform: "stonk" }),
      ev({ type: "runner", label: "runner150k", tier: 150000, confirmedAt: S - 500, median: 180_000, mint: AGENT, symbol: "AGNT", platform: "stonk" }),
      '{"type":"runner","cut',
    ].join("\n") + "\n",
  );
  writeFileSync(join(mig, "daily/2026-10-17.json"), JSON.stringify({ day: "2026-10-17", migrations: { pump: { migrations: 1300, runners: 40, runnerRate: 3.1, volume24hSum: 9e6 } }, clustersByVolume: [{ name: "oil reserve fund", description: "us oil reserve memes", tokens: 12, migrations: 9, runners: 3, volume24h: 4e6, athMax: 2e6, farms: 2, top: ["OIL", "SPR"] }] }));
  const tools = createToolsWith(makeCtx({ NARRATIVE_DIR: dir }), { fetch: async () => new Response("{}"), background: false, now: () => NOW });
  return { tools, dir };
}

/** The X radar's runs: two days, the fly idea on both, the junk-token idea on the first */
function radar(dir: string) {
  const runs = join(dir, "ai-x-radar/data/runs");
  const day = (d: string, final: unknown, ideas: unknown, from: number) => {
    mkdirSync(join(runs, d), { recursive: true });
    writeFileSync(join(runs, d, "final.json"), JSON.stringify(final));
    writeFileSync(join(runs, d, "ideas.json"), JSON.stringify(ideas));
    writeFileSync(join(runs, d, "meta.json"), JSON.stringify({ meta: { posts: 485, ideas: 40 }, window: { from, to: from + 86_400 } }));
  };
  const fly = (views: number) => ({
    key: "fruit-fly-world-model",
    title: "fly brain in a world model",
    terms: ["fruit fly", "lil guy"],
    root: { url: "https://x.com/lab_x/status/1", text: "a simulated fly brain inside a generated world", at: S - 20 * 3600, author: { handle: "lab_x", followers: 40000 }, views },
    views,
    spread: { notable: [{ handle: "big", followers: 356578, url: "https://x.com/big/status/2" }], langs: ["en", "ja"], crypto: 1, firstCryptoH: 6, cas: [], tickers: [] },
    tokens: { count: 0, firstH: null, top: [] },
  });
  day("2026-10-17", { summary: "yesterday", ideas: [{ key: "fruit-fly-world-model", score: 70, title: "fly, day one", stage: "pre-crypto" }, { key: "swarm-decompiles-linux", score: 50, title: "a swarm decompiles linux", essence: "agents decompiled linux in 9 h", stage: "tokenized-junk" }] }, [fly(900_000), { key: "swarm-decompiles-linux", terms: ["decompile linux", "swarm"], root: { url: "https://x.com/dev_x/status/3", at: S - 40 * 3600, views: 875_000 }, spread: { crypto: 3, firstCryptoH: 3, tickers: ["HIVE"] }, tokens: { count: 1, firstH: 10.1, top: [{ symbol: "HIVE", name: "HIVEPAD", chain: "robinhood", mcap: 4173, vol24: 0, created: S - 30 * 3600, url: "https://dexscreener.com/robinhood/0xd6", address: "0x93" }] } }], S - 2 * 86_400);
  day("2026-10-18", { summary: "the fly in the matrix leads the day", ideas: [{ key: "fruit-fly-world-model", score: 88, title: "fly in the matrix", essence: "a fly's brain flies through imagined worlds", why: "a simple image, 34x its audience", stage: "pre-crypto", angle: "a live stream of the fly", risk: "the window is 1-2 days" }] }, [fly(1_600_000)], S - 86_400);
  mkdirSync(join(runs, "2026-10-19"), { recursive: true }); // a run in progress: no final.json yet
  writeFileSync(join(dir, "ai-x-radar/data/ideas.json"), JSON.stringify({ "fruit-fly-world-model": { first: "2026-10-17", last: "2026-10-18", days: [{ date: "2026-10-17" }, { date: "2026-10-18" }] } }));
}

describe("the live-narrative tools (free/narratives.ts)", () => {
  it("a file rewritten past the minute: its copy in hand answers at once and the new one lands for the next call; the first read is waited for", async () => {
    const { dir } = world();
    let clock = NOW;
    const tools = createToolsWith(makeCtx({ NARRATIVE_DIR: dir }), { fetch: async () => new Response("{}"), background: false, now: () => clock });
    // the best coin of the oil story as meme_metas lists it (each call its own arguments: a tool's result is kept by them)
    const best = async (query: string) => ((await tools.run("meme_metas", { query }, { answerId: `swr-${query}` })) as { data: { groups: { narratives: { best: { symbol: string }[] }[] }[] } }).data.groups[0]!.narratives[0]!.best[0]!.symbol;
    assert.equal(await best("oil"), "OIL", "the first read, waited for");
    const db = JSON.parse(readFileSync(join(dir, "migration/data/db.json"), "utf8")) as { tokens: Record<string, { meta: { symbol: string } }> };
    db.tokens[OIL]!.meta.symbol = "OIL2";
    writeFileSync(join(dir, "migration/data/db.json"), JSON.stringify(db));
    clock += 61_000;
    assert.equal(await best("reserve"), "OIL", "past the minute: the copy in hand, at once");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await best("strategic"), "OIL2", "the new file for the next call");
  });

  it("offered only with NARRATIVE_DIR", () => {
    const none = createToolsWith(makeCtx({}), { fetch: async () => new Response("{}"), background: false });
    assert.equal(none.list().some((s) => s.name === "meme_narrative"), false);
    const { tools } = world();
    assert.deepEqual(tools.list().filter((s) => ["meme_narrative", "meme_metas", "meme_runners", "x_ideas"].includes(s.name)).map((s) => s.name).sort(), ["meme_metas", "meme_narrative", "meme_runners", "x_ideas"]);
  });

  it("meme_narrative: the index's card, its events and flags, its market", async () => {
    const { tools } = world();
    const r = await tools.run("meme_narrative", { mint: OIL }, { answerId: "n1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.symbol, "OIL");
    assert.deepEqual([d.narrative.narrative, d.narrative.group, d.narrative.hype_source, d.narrative.labelled], ["strategic oil reserve", "commodities/macro", "news/event", "full card"]);
    assert.deepEqual(d.events, [{ kind: "runner", label: "runner", at: "2026-10-18T11:10:00Z", median_mcap_usd: 210_000, flag: "farm" }]);
    assert.deepEqual(d.flags, ["farm"]);
    assert.equal(d.market.ath_mcap_usd, 1_100_000);
    assert.ok(r.sources.some((s) => s.url === `https://pump.fun/coin/${OIL}`));
    const untracked = await tools.run("meme_narrative", { mint: solKey("narr-nobody") }, { answerId: "n2" });
    assert.ok(untracked.ok && (untracked.data as { tracked: boolean }).tracked === false);
  });

  it("meme_metas: groups and narratives of the last 24 h by volume, ladders left out; the last day's metas", async () => {
    const { tools } = world();
    const r = await tools.run("meme_metas", {}, { answerId: "m1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.migrations_24h, 2, "the ladder is not counted");
    assert.deepEqual(d.groups.map((g: { group: string }) => g.group), ["commodities/macro", "ai"]);
    assert.deepEqual(d.groups[0].narratives[0], { narrative: "strategic oil reserve", coins: 1, volume_24h_usd: 1_200_000, best: [{ symbol: "OIL", mint: OIL, mcap_usd: 900_000, runner: true }] });
    assert.equal(d.last_day.metas[0].meta, "oil reserve fund");
    const ai = await tools.run("meme_metas", { query: "agent" }, { answerId: "m2" });
    assert.ok(ai.ok, JSON.stringify(ai));
    assert.deepEqual((ai.data as { groups: { group: string }[] }).groups.map((g) => g.group), ["ai"]);
  });

  it("x_ideas: the newest finished run, its ideas with their stage, root post, spread and tokens; a query, a stage, several days, an idea once", async () => {
    const { tools, dir } = world();
    const none = await tools.run("x_ideas", {}, { answerId: "x0" });
    assert.equal(none.ok, false, "no runs: unavailable");
    radar(dir);
    const r = await tools.run("x_ideas", {}, { answerId: "x1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.equal(d.run_day, "2026-10-18", "the run in progress (no final.json) is passed over");
    assert.equal(d.summary, "the fly in the matrix leads the day");
    assert.equal(d.window.to, new Date((S) * 1000).toISOString().replace(/\.\d+Z$/, "Z"));
    assert.deepEqual(d.ideas.map((i: { key: string }) => i.key), ["fruit-fly-world-model"]);
    const fly = d.ideas[0];
    assert.deepEqual([fly.idea, fly.stage, fly.score, fly.views, fly.age_h_at_run, fly.days_seen, fly.first_seen], ["fly in the matrix", "pre-crypto", 88, 1_600_000, 20, 2, "2026-10-17"]);
    assert.deepEqual(fly.root_post, { url: "https://x.com/lab_x/status/1", author: "lab_x", author_followers: 40000, views: 1_600_000, posted: new Date((S - 20 * 3600) * 1000).toISOString().replace(/\.\d+Z$/, "Z"), text: "a simulated fly brain inside a generated world" });
    assert.deepEqual(fly.crypto, { mentions: 1, first_after_h: 6, tickers: [], contracts: [] });
    assert.ok(r.sources.some((x) => x.url === "https://x.com/lab_x/status/1"));
    const two = await tools.run("x_ideas", { days: 3 }, { answerId: "x2" });
    assert.ok(two.ok);
    const t = two.data as Record<string, any>;
    assert.deepEqual(t.ideas.map((i: { key: string; run_day: string }) => [i.key, i.run_day]), [["fruit-fly-world-model", "2026-10-18"], ["swarm-decompiles-linux", "2026-10-17"]], "an idea seen on both days keeps its newest read");
    const swarm = t.ideas[1];
    assert.deepEqual(swarm.tokens, { count: 1, first_after_h: 10.1, top: [{ symbol: "HIVE", name: "HIVEPAD", chain: "robinhood", mcap_usd: 4173, volume_24h_usd: 0, created: new Date((S - 30 * 3600) * 1000).toISOString().replace(/\.\d+Z$/, "Z"), address: "0x93", url: "https://dexscreener.com/robinhood/0xd6" }] });
    const q = await tools.run("x_ideas", { days: 3, query: "hive" }, { answerId: "x3" });
    assert.deepEqual(((q as { data?: unknown }).data as Record<string, any>).ideas.map((i: { key: string }) => i.key), ["swarm-decompiles-linux"], "a ticker or token matches");
    const st = await tools.run("x_ideas", { days: 3, stage: "pre-crypto" }, { answerId: "x4" });
    assert.deepEqual(((st as { data?: unknown }).data as Record<string, any>).ideas.map((i: { key: string }) => i.key), ["fruit-fly-world-model"]);
  });

  it("meme_runners: the coins that just ran, newest first, a coin once with the tiers it held; ladders taken back, flags said, clean and tier filters", async () => {
    const { tools } = world();
    const r = await tools.run("meme_runners", {}, { answerId: "r1" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, any>;
    assert.deepEqual(d.runners.map((x: { symbol: string }) => x.symbol), ["AGNT", "OIL"], "the ladder taken back, the day-old runner out of the 3 h window");
    assert.deepEqual([d.coins, d.flagged, d.taken_back], [2, 1, 1]);
    const agnt = d.runners[0];
    assert.deepEqual([agnt.ran, agnt.tiers_in_window, agnt.top_tier_usd, agnt.minutes_ago, agnt.held_mcap_usd, agnt.flag, agnt.narrative], ["runner", ["150k", "1M"], 1_000_000, 8, 180_000, null, "ai trading agent"]);
    assert.equal(d.runners[1].flag, "farm");
    assert.equal(d.flags.farm, "its volume farmed (wash trades)");
    const clean = await tools.run("meme_runners", { clean: true }, { answerId: "r2" });
    assert.deepEqual(((clean as { data?: unknown }).data as Record<string, any>).runners.map((x: { symbol: string }) => x.symbol), ["AGNT"]);
    const big = await tools.run("meme_runners", { tier: "1M", hours: 48 }, { answerId: "r3" });
    assert.deepEqual(((big as { data?: unknown }).data as Record<string, any>).runners.map((x: { symbol: string }) => x.symbol), ["AGNT"], "only a coin that held $1M");
  });

  it("meme_metas: the stories heating now first: coins of the last 6 h and 24 h, runners clean and farmed, its start and its og; a story of one coin left out", async () => {
    const { tools, dir } = world();
    const one = await tools.run("meme_metas", {}, { answerId: "h0" });
    assert.ok(one.ok, JSON.stringify(one));
    assert.deepEqual((one as unknown as { data: { top_narratives: unknown[] } }).data.top_narratives, [], "every story has one coin");
    // a second coin of the oil story, migrated 30 min ago, no runner yet
    const file = join(dir, "migration/data/db.json");
    const db = JSON.parse(readFileSync(file, "utf8")) as { tokens: Record<string, unknown> };
    const SPR = solKey("narr-spr");
    db.tokens[SPR] = { mint: SPR, platform: "pump", migratedAt: S - 1800, createdAt: S - 2000, meta: { symbol: "SPR" }, market: { mcap: 120_000, volume24h: 90_000 }, analysis: { light: { narrative: "strategic oil reserve", group: "commodities/macro" } } };
    writeFileSync(file, JSON.stringify(db));
    // a fresh reader: the clock stands still, so the first one never looks at the file again
    const fresh = createToolsWith(makeCtx({ NARRATIVE_DIR: dir }), { fetch: async () => new Response("{}"), background: false, now: () => NOW });
    const r = await fresh.run("meme_metas", {}, { answerId: "h1" });
    assert.ok(r.ok, JSON.stringify(r));
    const top = (r as unknown as { data: { top_narratives: Record<string, unknown>[] } }).data.top_narratives;
    assert.equal(top.length, 1);
    assert.deepEqual(top[0], {
      narrative: "strategic oil reserve",
      group: "commodities/macro",
      coins_24h: 2,
      coins_6h: 2,
      runners_clean: 0,
      runners_farmed: 1,
      started_at: new Date((S - 7200) * 1000).toISOString().replace(".000Z", "Z"),
      newest_at: new Date((S - 1800) * 1000).toISOString().replace(".000Z", "Z"),
      og: { symbol: "OIL", mint: OIL, mcap_usd: 900_000 },
      // its biggest coins of the day, whole, so the model never asks for them one by one
      coins: [
        { symbol: "OIL", mint: OIL, mcap_usd: 900_000, change_1h_pct: 12, age_h: 2, runner: true },
        { symbol: "SPR", mint: SPR, mcap_usd: 120_000, change_1h_pct: null, age_h: 0.6, runner: false },
      ],
    });
  });
});
