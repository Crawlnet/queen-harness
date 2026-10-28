// unlock_schedule (src/free/unlocks.ts): a token's unlocks from DefiLlama's public datasets, found by name, ticker,
// address or chain; past and upcoming dates, the streams still running, and a plain "no scheduled unlocks remain". The
// fakes keep the shapes of DefiLlama's datasets (jupiter, arbitrum-foundation), trimmed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolsWith } from "../src/registry.ts";
import { unlockEvents, unlockSchedule } from "../src/free/unlocks.ts";
import { primaryUrl } from "../src/links.ts";
import { makeCtx, tableFetch } from "./helpers.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DATASETS = "https://defillama-datasets.llama.fi";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

const LIST = ["canto", "jupiter", "ether.fi", "arbitrum-exchange", "arbitrum-foundation", "optimism-foundation", "oldcoin", "kamino", "celestia", "worldcoin", "ethena", "magic-eden", "world-of-dypians", "near-protocol"];

const PROTOCOLS = [
  { name: "Jupiter Perpetual Exchange", slug: "jupiter-perpetual-exchange", symbol: "JUP", parentProtocol: "parent#jupiter", address: `solana:${JUP_MINT}`, gecko_id: "jupiter-exchange-solana", tvl: 1.5e9, chainTvls: { Solana: 1.5e9 } },
  { name: "Jupiter Lend", slug: "jupiter-lend", symbol: "JUP", parentProtocol: "parent#jupiter", address: `solana:${JUP_MINT}`, tvl: 1.1e9, chainTvls: { Solana: 1.1e9 } },
  { name: "Arbitrum Bridge", slug: "arbitrum-bridge", symbol: "-", tvl: 2e9, chainTvls: { Ethereum: 2e9 } },
  // as DefiLlama lists them: a token's unlocks filed under its parent's first part or a dotted slug, or under its own entry with
  // no TVL; MAGIC's protocols have no dataset, and Magic Eden's token is ME
  { name: "ether.fi Stake", slug: "ether.fi-stake", symbol: "ETHFI", parentProtocol: "parent#ether-fi", address: "0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb", gecko_id: null, tvl: 4.8e9 },
  { name: "Kamino Lend", slug: "kamino-lend", symbol: "KMNO", parentProtocol: "parent#kamino-finance", address: "solana:KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS", gecko_id: null, tvl: 1.3e9 },
  { name: "Magic Eden", slug: "magic-eden", symbol: "ME", gecko_id: "magic-eden", tvl: 149_180 },
  { name: "Magic Land", slug: "magic-land", symbol: "MAGIC", gecko_id: "magic-token", tvl: 36_719 },
  { name: "Treasure", slug: "treasure", symbol: "MAGIC", gecko_id: "magic", tvl: 0 },
  { name: "Celestia", slug: "celestia", symbol: "TIA", gecko_id: "celestia", tvl: null },
  { name: "world", slug: "world", symbol: "-", tvl: 156_687 },
];
const CHAINS = [
  { name: "Solana", tvl: 1e10, tokenSymbol: "SOL" },
  { name: "Arbitrum", tvl: 3e9, tokenSymbol: "ARB" },
  { name: "World Chain", tvl: 4.2e7, tokenSymbol: "WLD", gecko_id: "worldcoin-wld" },
  { name: "Near", tvl: 1.5e8, tokenSymbol: "NEAR" },
];

const cliff = (recipient: string, category: string, amount: number) => ({ recipient, category, unlockType: "cliff", amount });

const JUPITER = {
  name: "Jupiter",
  gecko_id: "jupiter-exchange-solana",
  metadata: {
    token: `solana:${JUP_MINT}`,
    total: 7_000_000_000,
    notes: [
      "Data provided by Jupiter team.",
      "The Net-Zero proposal passed by DAO vote in February 2026: Team Reserve emissions paused indefinitely.",
    ],
    unlockEvents: [
      { timestamp: 1706659200, cliffAllocations: [cliff("Airdrop", "airdrop", 1_000_000_000), cliff("Launchpool", "publicSale", 250_000_000)], linearAllocations: [], summary: { totalTokensCliff: 1_250_000_000 } },
      { timestamp: 1738281600, cliffAllocations: [cliff("Jupuary", "airdrop", 700_000_000)], linearAllocations: [] },
      { timestamp: 1771977600, cliffAllocations: [cliff("Mercurial Stakeholders", "insiders", 77_968_558.7)], linearAllocations: [], summary: { totalTokensCliff: 77_968_558.7 } },
    ],
    events: [{ description: "A cliff of {tokens[0]} tokens was unlocked from Airdrop on {timestamp}", timestamp: 1706659200, noOfTokens: [1_000_000_000], category: "airdrop", unlockType: "cliff" }],
  },
  supplyMetrics: { maxSupply: 6_999_999_999.96, adjustedSupply: 3_457_074_114.26, tbdAmount: 3_542_925_885.7 },
  unlockUsdChart: [[1706659200, 1]],
  componentData: { big: "tree" },
};

const ARBITRUM = {
  name: "Arbitrum",
  metadata: {
    token: "arbitrum:0x912CE59144191C1204E64559FE8253a0e49E6548",
    total: 10_000_000_000,
    unlockEvents: [
      { timestamp: 1681689600, cliffAllocations: [], linearAllocations: [{ recipient: "Foundation", category: "Uncategorized", unlockType: "linear_start", previousRatePerWeek: 0, newRatePerWeek: 3_593_000, endTimestamp: 1807920000 }] },
      { timestamp: 1789480833, cliffAllocations: [cliff("Team, Contributors & Advisors", "insiders", 56_125_000), cliff("Investors", "privateSale", 36_520_833.33)], linearAllocations: [] },
      { timestamp: 1794702576, cliffAllocations: [cliff("Team, Contributors & Advisors", "insiders", 56_125_000), cliff("Investors", "privateSale", 36_520_833.33)], linearAllocations: [] },
      { timestamp: 1792072833, cliffAllocations: [cliff("Team, Contributors & Advisors", "insiders", 56_125_000), cliff("Investors", "privateSale", 36_520_833.33)], linearAllocations: [] },
    ],
  },
  supplyMetrics: { maxSupply: 10_000_000_000, tbdAmount: 0 },
};

// an older dataset: no unlockEvents, one row per allocation and date, the recipient only in the sentence
const OLDCOIN = {
  name: "Oldcoin",
  metadata: {
    total: 1_000_000,
    events: [
      { description: "On {timestamp} {tokens[0]} of Investors tokens will be unlocked", timestamp: 1800000000, noOfTokens: [50_000], category: "privateSale", unlockType: "cliff" },
      { description: "Linear unlock was increased from {tokens[0]} to {tokens[1]} tokens per week from Foundation on {timestamp}", timestamp: 1700000000, noOfTokens: [0, 1_000], category: "Uncategorized", unlockType: "linear", rateDurationDays: 1461 },
      { description: "On {timestamp} {tokens[0]} of Team, Contributors & Advisors tokens were unlocked", timestamp: 1700000000, noOfTokens: [20_000], category: "insiders", unlockType: "cliff" },
      { description: "A cliff of {tokens[0]} tokens was unlocked from Airdrop on {timestamp}", timestamp: 1700000000, noOfTokens: [10_000], category: "airdrop", unlockType: "cliff" },
    ],
  },
};

// Ethena's dataset, trimmed: no cliffs at all; the team's last event is a rate change whose end (May 2025) closes only
// its monthly segment, and its daily curve still rises 21.56M a week until 5 Apr 2028; the airdrop's stream stopped by
// a zero rate
const D = 86_400;
const at = (iso: string) => Date.parse(iso) / 1000;
/** A daily curve (00:00 UTC points) of tokens unlocked to date, as the dataset's documentedData holds one */
const curve = (label: string, from: string, to: string, f: (t: number) => number) => {
  const data: { timestamp: number; unlocked: number; rawEmission: number; burned: number }[] = [];
  for (let t = at(from); t <= at(to); t += D) data.push({ timestamp: t, unlocked: f(t), rawEmission: f(t), burned: 0 });
  return { label, data };
};
const TEAM_END = at("2028-04-05T00:00:00Z");
const rate = (recipient: string, category: string, from: number, to: number, endTimestamp: number) => ({ recipient, category, unlockType: "linear_rate_change", previousRatePerWeek: from, newRatePerWeek: to, endTimestamp });
const ETHENA = {
  name: "Ethena",
  metadata: {
    token: "ethereum:0x57e114b691db790c35207b2e685d4a43181e6061",
    unlockEvents: [
      { timestamp: 1741236516, cliffAllocations: [], linearAllocations: [rate("Team", "insiders", 0, 258_700_000, 1743866259)] },
      { timestamp: 1743866259, cliffAllocations: [], linearAllocations: [rate("Team", "insiders", 258_700_000, 21_560_000, 1746496002)] },
      { timestamp: 1762274460, cliffAllocations: [], linearAllocations: [rate("Airdrop S3", "airdrop", 3_354_000, 0, 1764904203)] },
    ],
  },
  documentedData: {
    data: [
      curve("Airdrop S3", "2026-09-01T00:00:00Z", "2028-04-06T00:00:00Z", () => 518_423_283.17),
      curve("Team", "2026-09-01T00:00:00Z", "2028-04-06T00:00:00Z", (t) => 2e9 + (3_080_000 * (Math.min(t, TEAM_END) - at("2026-09-01T00:00:00Z"))) / D),
    ],
  },
  supplyMetrics: { maxSupply: 15_000_000_000, tbdAmount: 1_667_336_190.27 },
};

const blank = (name: string) => ({ name, metadata: { unlockEvents: [] } });

function fakes(extra: Record<string, unknown> = {}) {
  return tableFetch({
    [`${DATASETS}/emissionsProtocolsList`]: LIST,
    [`${DATASETS}/emissions/jupiter`]: JUPITER,
    [`${DATASETS}/emissions/arbitrum-foundation`]: ARBITRUM,
    [`${DATASETS}/emissions/oldcoin`]: OLDCOIN,
    [`${DATASETS}/emissions/ethena`]: ETHENA,
    [`${DATASETS}/emissions/kamino`]: blank("Kamino"),
    [`${DATASETS}/emissions/ether.fi`]: blank("ether.fi"),
    [`${DATASETS}/emissions/celestia`]: blank("Celestia"),
    [`${DATASETS}/emissions/worldcoin`]: blank("Worldcoin"),
    [`${DATASETS}/emissions/near-protocol`]: blank("NEAR Protocol"),
    "https://api.llama.fi/protocols": PROTOCOLS,
    "https://api.llama.fi/v2/chains": CHAINS,
    ...extra,
  });
}

const run = async (f: ReturnType<typeof fakes>, token: string, answerId = "u", extra: Record<string, unknown> = {}) => {
  const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
  return tools.run("unlock_schedule", { token, ...extra }, { answerId });
};

/** An answer's data (it must be one) */
const dataOf = async (r: ReturnType<typeof run>): Promise<Record<string, unknown>> => {
  const out = await r;
  assert.ok(out.ok, JSON.stringify(out));
  return out.data as Record<string, unknown>;
};

describe("unlock_schedule (mocked fetch)", () => {
  it("JUP by its ticker: the parent's dataset; no scheduled unlocks remain, the past cliffs to draw, a defillama.com source", async () => {
    const f = fakes();
    const r = await run(f, "JUP");
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Record<string, unknown>;
    assert.equal(d.slug, "jupiter");
    assert.equal(d.token, `solana:${JUP_MINT}`);
    assert.equal(d.next_unlock, null);
    assert.deepEqual(d.upcoming, []);
    assert.equal(d.note, "no scheduled unlocks remain: the last unlock was on 2026-02-25; 3542925886 tokens (50.6% of max supply) have no set schedule");
    assert.equal(d.past_count, 3);
    const past = d.past as Record<string, unknown>[];
    assert.deepEqual(past.map((e) => e.date), ["2024-01-31", "2025-01-31", "2026-02-25"]);
    assert.deepEqual([past[0]!.tokens, past[0]!.pct_of_supply], [1_250_000_000, 17.9]);
    assert.deepEqual(past[2]!.allocations, [{ to: "Mercurial Stakeholders", category: "insiders", tokens: 77_968_559 }]);
    assert.deepEqual(d.notes, ["The Net-Zero proposal passed by DAO vote in February 2026: Team Reserve emissions paused indefinitely."], "who supplied the data is no note");
    assert.equal(d.link, "https://defillama.com/unlocks/jupiter");
    assert.deepEqual(r.sources, [{ title: "DefiLlama: Jupiter unlocks", url: "https://defillama.com/unlocks/jupiter" }]);
    for (const s of r.sources) assert.equal(primaryUrl(s.url), s.url);
    assert.ok(!JSON.stringify(r).includes("componentData") && !JSON.stringify(r).includes("unlockUsdChart"));
  });

  it("found by name, CoinGecko id or mint the same way; the name as written asks nothing more than the list", async () => {
    const f = fakes();
    assert.equal((await dataOf(run(f, "Jupiter"))).slug, "jupiter");
    assert.ok(!f.urls.some((u) => u.startsWith("https://api.llama.fi/")), "a listed slug needs no list of protocols");
    for (const q of ["jupiter-exchange-solana", JUP_MINT]) assert.equal((await dataOf(run(fakes(), q))).slug, "jupiter", q);
  });

  it("ARB or Arbitrum: the chain's token, filed under its foundation; the next unlock in days, upcoming in order, the stream still running", async () => {
    for (const q of ["ARB", "Arbitrum"]) {
      const r = await run(fakes(), q);
      assert.ok(r.ok, `${q}: ${JSON.stringify(r)}`);
      const d = r.data as Record<string, unknown>;
      assert.equal(d.slug, "arbitrum-foundation", q);
      assert.deepEqual(d.next_unlock, {
        date: "2026-10-15",
        tokens: 92_645_833,
        pct_of_supply: 0.926,
        allocations: [
          { to: "Team, Contributors & Advisors", category: "insiders", tokens: 56_125_000 },
          { to: "Investors", category: "privateSale", tokens: 36_520_833 },
        ],
        days_away: 3,
      });
      assert.deepEqual((d.upcoming as { date: string }[]).map((e) => e.date), ["2026-10-15", "2026-11-15"]);
      assert.deepEqual(d.streaming_now, [{ to: "Foundation", category: "Uncategorized", tokens_per_week: 3_593_000, until: "2027-04-17" }]);
      assert.equal(d.note, undefined, "unlocks remain: no note");
      assert.equal(d.unscheduled_tokens, undefined);
    }
  });

  it("an older dataset's events: grouped by date, each recipient from its sentence, a linear rate with its end", () => {
    const ev = unlockEvents(OLDCOIN.metadata);
    assert.deepEqual(
      ev.map((e) => [e.t, e.cliffs.map((c) => c.to), e.streams.map((s) => [s.to, s.perWeek])]),
      [
        [1700000000, ["Team, Contributors & Advisors", "Airdrop"], [["Foundation", 1000]]],
        [1800000000, ["Investors"], []],
      ],
    );
    const d = unlockSchedule(OLDCOIN, "oldcoin", NOW, 12);
    assert.deepEqual((d.next_unlock as Record<string, unknown>).date, "2027-01-15");
    assert.equal((d.past as Record<string, unknown>[])[0]!.pct_of_supply, 3);
    assert.deepEqual(d.streaming_now, [{ to: "Foundation", category: "Uncategorized", tokens_per_week: 1000, until: "2027-11-14" }]);
  });

  it("only streams left: no cliff unlocks remain, the streams said; nothing at all: no scheduled unlocks remain", () => {
    const streams = unlockSchedule({ name: "S", metadata: { unlockEvents: [ARBITRUM.metadata.unlockEvents[0]] }, supplyMetrics: { maxSupply: 1e10 } }, "s", NOW, 12);
    assert.equal(streams.note, "no cliff unlocks remain; 1 linear stream still unlocks (streaming_now)");
    assert.deepEqual(streams.past, [], "a stream's start is no cliff");
    const ended = unlockSchedule({ name: "S", metadata: { unlockEvents: [ARBITRUM.metadata.unlockEvents[0]] } }, "s", Date.parse("2027-05-01T00:00:00Z"), 12);
    assert.equal(ended.note, "no scheduled unlocks remain", "a linear_start's end is the stream's");
    assert.deepEqual(ended.streaming_now, []);
    assert.equal(unlockSchedule({ metadata: {} }, "none", NOW, 12).note, "no scheduled unlocks remain");
  });

  it("ENA: a stream that runs on past its last rate change's end is still unlocking, by the daily curve; never 'no scheduled unlocks remain'", async () => {
    const d = await dataOf(run(fakes(), "ethena"));
    assert.deepEqual(d.streaming_now, [{ to: "Team", category: "insiders", tokens_per_week: 21_560_000, until: "2028-04-05" }]);
    assert.deepEqual(d.still_to_unlock, {
      tokens: 1_666_280_000,
      pct_of_supply: 11.1,
      until: "2028-04-05",
      by_recipient: [{ to: "Team", tokens: 1_666_280_000, pct_of_supply: 11.1 }],
    });
    assert.equal(d.next_unlock, null);
    assert.deepEqual([d.upcoming, d.past, d.upcoming_rate_changes], [[], [], undefined], "rate changes are no unlock dates");
    assert.equal(d.note, "no cliff unlocks remain; 1 linear stream still unlocks (streaming_now); 1667336190 tokens (11.1% of max supply) have no set schedule");
    // with no daily curve, the events alone: the rate change's end closed a segment, so the team's rate runs on, no end known
    const bare = unlockSchedule({ ...ETHENA, documentedData: undefined }, "ethena", NOW, 12);
    assert.deepEqual(bare.streaming_now, [{ to: "Team", category: "insiders", tokens_per_week: 21_560_000, until: null }]);
    assert.equal(bare.still_to_unlock, undefined);
  });

  it("the daily curve: a cliff in the coming week is no stream; a curve that grows into its last point about today has no end set and is left out of what remains", () => {
    const cliffDays = ["2026-09-15", "2026-10-15", "2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15", "2027-03-15"].map((s) => at(`${s}T00:00:00Z`));
    const raw = {
      name: "Mixed",
      metadata: { unlockEvents: cliffDays.map((t) => ({ timestamp: t, cliffAllocations: [cliff("Investors", "privateSale", 36_520_000)], linearAllocations: [] })) },
      documentedData: {
        data: [
          curve("Investors", "2026-09-01T00:00:00Z", "2027-04-01T00:00:00Z", (t) => 1e9 + 36_520_000 * cliffDays.filter((c) => c <= t).length),
          curve("Community", "2026-09-01T00:00:00Z", "2027-04-01T00:00:00Z", (t) => 7_000 * (Math.min(t, at("2027-01-01T00:00:00Z")) - at("2026-09-01T00:00:00Z")) / D),
          curve("Rewards", "2026-09-01T00:00:00Z", "2026-10-13T00:00:00Z", (t) => 1e6 + 10_000 * (t - at("2026-09-01T00:00:00Z")) / D),
        ],
      },
      supplyMetrics: { maxSupply: 1e10 },
    };
    const d = unlockSchedule(raw, "mixed", NOW, 12);
    assert.deepEqual(d.streaming_now, [
      { to: "Community", category: null, tokens_per_week: 49_000, until: "2027-01-01" },
      { to: "Rewards", category: null, tokens_per_week: 70_000, until: null },
    ]);
    const left = d.still_to_unlock as { tokens: number; until: string; by_recipient: { to: string; tokens: number }[] };
    assert.deepEqual(left.by_recipient.map((r) => [r.to, r.tokens]), [["Investors", 6 * 36_520_000], ["Community", 81 * 7_000]]);
    assert.deepEqual([left.tokens, left.until], [6 * 36_520_000 + 81 * 7_000, "2027-03-15"]);
    assert.equal((d.next_unlock as { date: string }).date, "2026-10-15");
  });

  it("WLD: a rate change years out is no next unlock, listed apart; the next cliff is the next unlock", () => {
    const wld = (more: unknown[]) => ({
      name: "Worldcoin",
      metadata: {
        unlockEvents: [
          { timestamp: at("2024-07-23T05:48:00Z"), cliffAllocations: [], linearAllocations: [rate("Community", "noncirculating", 6_842_000, 33_540_000, at("2026-07-23T17:26:00Z"))] },
          { timestamp: at("2026-07-23T17:26:00Z"), cliffAllocations: [], linearAllocations: [rate("Community", "noncirculating", 33_540_000, 11_180_000, at("2029-07-23T10:52:00Z"))] },
          { timestamp: at("2029-07-23T10:52:00Z"), cliffAllocations: [], linearAllocations: [rate("Community", "noncirculating", 11_180_000, 5_590_000, at("2032-07-23T04:18:00Z"))] },
          ...more,
        ],
      },
      supplyMetrics: { maxSupply: 1e10 },
    });
    const d = unlockSchedule(wld([]), "worldcoin", NOW, 12);
    assert.equal(d.next_unlock, null);
    assert.deepEqual([d.upcoming, d.upcoming_count], [[], 0]);
    assert.deepEqual(d.upcoming_rate_changes, [{ date: "2029-07-23", to: "Community", tokens_per_week: 5_590_000 }]);
    assert.deepEqual(d.streaming_now, [{ to: "Community", category: "noncirculating", tokens_per_week: 11_180_000, until: "2029-07-23" }]);
    assert.equal(d.note, "no cliff unlocks remain; 1 linear stream still unlocks (streaming_now)");
    const withCliff = unlockSchedule(wld([{ timestamp: at("2027-03-01T00:00:00Z"), cliffAllocations: [cliff("Investors", "privateSale", 1_000_000)], linearAllocations: [] }]), "worldcoin", NOW, 12);
    assert.deepEqual([(withCliff.next_unlock as { date: string }).date, (withCliff.next_unlock as { days_away: number }).days_away], ["2027-03-01", 140]);
    assert.equal(withCliff.note, undefined);
  });

  it("entries on one UTC day are one unlock: their tokens summed, counted and limited as dates (sui files each cliff at its own hour)", () => {
    const raw = {
      name: "Sui",
      metadata: {
        unlockEvents: [
          { timestamp: 1793420700, cliffAllocations: [cliff("Community Reserve", "noncirculating", 4_000_000)], linearAllocations: [] },
          { timestamp: 1793413860, cliffAllocations: [cliff("Mysten Labs Treasury", "insiders", 2_069_367)], linearAllocations: [] },
          { timestamp: 1793523600, cliffAllocations: [cliff("Community Reserve", "noncirculating", 7_300_000)], linearAllocations: [] },
          { timestamp: 1793530800, cliffAllocations: [cliff("Series A", "privateSale", 7_050_000)], linearAllocations: [] },
        ],
      },
      supplyMetrics: { maxSupply: 1e10 },
    };
    const d = unlockSchedule(raw, "sui-foundation", NOW, 1);
    assert.deepEqual(d.next_unlock, {
      date: "2026-10-31",
      tokens: 6_069_367,
      pct_of_supply: 0.0607,
      allocations: [
        { to: "Mysten Labs Treasury", category: "insiders", tokens: 2_069_367 },
        { to: "Community Reserve", category: "noncirculating", tokens: 4_000_000 },
      ],
      days_away: 19,
    });
    assert.equal(d.upcoming_count, 2);
    assert.deepEqual((d.upcoming as { date: string; tokens: number }[]).map((e) => [e.date, e.tokens]), [["2026-10-31", 6_069_367]]);
    // the older events list the same way
    const old = unlockEvents({
      events: [
        { description: "On {timestamp} {tokens[0]} of Community Reserve tokens will be unlocked", timestamp: 1793420700, noOfTokens: [4_000_000] },
        { description: "On {timestamp} {tokens[0]} of Mysten Labs Treasury tokens will be unlocked", timestamp: 1793413860, noOfTokens: [2_069_367] },
      ],
    });
    assert.deepEqual(old.map((e) => [e.t, e.cliffs.map((c) => c.to)]), [[1793413860, ["Mysten Labs Treasury", "Community Reserve"]]]);
  });

  it("limit: the latest past and the nearest upcoming dates; the count of each is kept", async () => {
    const d = await dataOf(run(fakes(), "jupiter", "l", { limit: 1 }));
    assert.deepEqual((d.past as { date: string }[]).map((e) => e.date), ["2026-02-25"]);
    assert.equal(d.past_count, 3);
  });

  it("found as DefiLlama files a project: KMNO and Kamino Finance → kamino, ETHFI → ether.fi, TIA by its own entry with no TVL, WLD by its chain's CoinGecko id, NEAR → near-protocol, $JUP as JUP", async () => {
    for (const [q, slug] of [["KMNO", "kamino"], ["Kamino Finance", "kamino"], ["ETHFI", "ether.fi"], ["TIA", "celestia"], ["WLD", "worldcoin"], ["NEAR", "near-protocol"], ["$JUP", "jupiter"]] as const) {
      assert.equal((await dataOf(run(fakes(), q))).slug, slug, q);
    }
  });

  it("never another token's dataset filed under the query or a protocol's slug as a prefix: MAGIC is not Magic Eden, world (a protocol too) is not World of Dypians", async () => {
    for (const q of ["MAGIC", "world"]) {
      const f = fakes();
      const r = await run(f, q);
      assert.deepEqual([r.ok, !r.ok && r.error], [false, "not_found"], q);
      assert.ok(!f.urls.some((u) => u.startsWith(`${DATASETS}/emissions/`)), `${q}: ${f.urls.join(" ")}`);
    }
  });

  it("a token with no dataset is not found, without asking for one; a list that fails asks under the name as written", async () => {
    const f = fakes();
    const r = await run(f, "BONK");
    assert.deepEqual([r.ok, !r.ok && r.error], [false, "not_found"]);
    assert.ok(!f.urls.some((u) => u.startsWith(`${DATASETS}/emissions/`)), f.urls.join(" "));
    const down = fakes({ [`${DATASETS}/emissionsProtocolsList`]: new Response("down", { status: 502 }) });
    const maha = await run(down, "maha.xyz");
    assert.equal(maha.ok, false, "no dataset faked for it");
    assert.ok(down.urls.includes(`${DATASETS}/emissions/maha.xyz`), down.urls.join(" "));
  });

  it("cached like the other DefiLlama reads: the same ask again sends nothing; the list loads once", async () => {
    const f = fakes();
    const tools = createToolsWith(makeCtx(), { background: false, fetch: f.fetch, now: () => NOW });
    assert.ok((await tools.run("unlock_schedule", { token: "jupiter" }, { answerId: "c1" })).ok);
    assert.ok((await tools.run("unlock_schedule", { token: "jupiter" }, { answerId: "c2" })).ok);
    assert.ok((await tools.run("unlock_schedule", { token: "oldcoin" }, { answerId: "c3" })).ok);
    assert.deepEqual(f.urls.filter((u) => u.startsWith(DATASETS)), [`${DATASETS}/emissionsProtocolsList`, `${DATASETS}/emissions/jupiter`, `${DATASETS}/emissions/oldcoin`]);
  });

  it("offered with the free tools, its description naming what the model picks it for", () => {
    const tools = createToolsWith(makeCtx(), { background: false, fetch: fakes().fetch, now: () => NOW });
    const t = tools.list().find((x) => x.name === "unlock_schedule");
    assert.ok(t, "listed");
    assert.match(t.description, /unlock/i);
    assert.match(t.description, /no scheduled unlocks remain/);
    assert.match(t.description, /vesting/);
  });
});
