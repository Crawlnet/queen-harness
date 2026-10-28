import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolsWith } from "../src/registry.ts";
import { schemaProblems, validateArgs } from "../src/schema.ts";
import { makeCtx } from "./helpers.ts";

function allSpecs() {
  // a Helius key brings the DAS tool, a twitterapi.io key the CT radar's ct_calls
  const tools = createToolsWith(makeCtx({ HELIUS_API_KEYS: "k", TOOLS_TWITTERAPI_KEY: "tapi-test-0123456789abcdef" }), { background: false, fetch: async () => new Response("{}") });
  return { free: tools.list() };
}

/** Every function, each provider keyed (keys of a valid shape, none real; nothing is fetched) */
function everySpec() {
  const key = "k".repeat(32);
  const env = { HELIUS_API_KEYS: key, HELIUS_LAUNCH_KEYS: key, API_HUB_KEY: key, TOOLS_XSEARCH_KEY: key, NARRATIVE_DIR: "/nonexistent-narratives", TOOLS_SECURITY: "on" };
  return createToolsWith(makeCtx(env), { background: false, fetch: async () => new Response("{}") }).list();
}

describe("tool schemas", () => {
  it("every tool is a valid function-calling definition", () => {
    const { free } = allSpecs();
    assert.ok(free.length >= 16, `free tools: ${free.length}`);
    for (const s of free) assert.deepEqual(schemaProblems(s), [], s.name);
  });

  it("names are unique", () => {
    const { free } = allSpecs();
    const names = free.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("market-facing tools say they are not investment advice", () => {
    const { free } = allSpecs();
    for (const s of free) {
      if (/market|yield|pool|pair|perps|exchange|risk/.test(s.name)) assert.match(s.description, /not investment advice/i, s.name);
    }
  });

  it("the coin reads say what each is for, so a plan that offers several leaves no guess", () => {
    const specs = everySpec();
    const d = (name: string) => specs.find((s) => s.name === name)?.description ?? "";
    // a token found by its ticker or name (copies reuse tickers) against one whose chain and address are known
    assert.match(d("dex_pair_lookup"), /^Find a token by its ticker or name, or by an address whose chain you don't know/);
    assert.match(d("dex_pair_lookup"), /on Solana only a Jupiter-verified match is the real one/);
    assert.match(d("token_pairs"), /^Every DEX pool of one token whose chain and address you have/);
    // who holds it, quick, against whether the holders are one group, slower
    assert.match(d("sol_largest_accounts"), /^The ranked holder list of a Solana token mint, one quick chain read/);
    assert.match(d("sol_holder_links"), /^Whether a Solana token's top holders are one group in disguise/);
    // whether its volume is real; what an address is; a token's name; what no other function covers
    assert.match(d("pool_snapshot"), /unique buyers and sellers in 24h/);
    assert.match(d("sol_account_basics"), /^What a Solana address is/);
    assert.match(d("sol_asset_card"), /^A Solana token's name, symbol and metadata/);
    assert.match(d("hub_rpc"), /for a chain or a read no other function covers/);
  });

  it("the functions a description names: only these, each offered wherever the one naming it is (harness-v2.test.ts keeps the pairs in the chat's plans)", () => {
    const specs = everySpec();
    const names = new Set(specs.map((s) => s.name));
    const named = specs.flatMap((s) => [...new Set(s.description.match(/[a-z]+(?:_[a-z0-9]+)+/g) ?? [])].filter((w) => names.has(w) && w !== s.name).map((w) => `${s.name} -> ${w}`));
    assert.deepEqual(named.sort(), ["dex_pair_lookup -> token_pairs", "hub_call -> hub_find", "hub_find -> hub_call", "pool_snapshot -> token_pairs"]);
  });

  it("a definition with problems is reported", () => {
    const p = schemaProblems({
      name: "Bad-Name",
      description: "",
      parameters: { type: "object", properties: { x: { type: "string", description: "", pattern: "(" } }, required: ["y"] } as never,
    });
    assert.ok(p.length >= 5, p.join("; "));
  });
});

describe("validateArgs", () => {
  const schema = {
    type: "object" as const,
    properties: {
      q: { type: "string" as const, description: "q", minLength: 1, maxLength: 10 },
      n: { type: "integer" as const, description: "n", minimum: 1, maximum: 5, default: 2 },
      e: { type: "string" as const, description: "e", enum: ["klines", "trades"] },
      b: { type: "boolean" as const, description: "b" },
      a: { type: "string" as const, description: "a", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" },
    },
    required: ["q"],
    additionalProperties: false as const,
  };

  it("trims, applies defaults, matches enums case-insensitively, drops unknown fields, reads a JSON string", () => {
    assert.deepEqual(validateArgs(schema, { q: "  jup ", e: "KLINES", extra: 1 }), { ok: true, args: { q: "jup", n: 2, e: "klines" } });
    assert.deepEqual(validateArgs(schema, '{"q":"x","n":"3","b":"true"}'), { ok: true, args: { q: "x", n: 3, b: true } });
  });

  it("reads lists: a JSON list, a single value as a list of one, each item checked", () => {
    const list = {
      type: "object" as const,
      properties: { xs: { type: "array" as const, description: "xs", items: { type: "string" as const, enum: ["a", "b"] }, maxItems: 2 } },
      additionalProperties: false as const,
    };
    assert.deepEqual(validateArgs(list, { xs: ["A", "b"] }), { ok: true, args: { xs: ["a", "b"] } });
    assert.deepEqual(validateArgs(list, { xs: "a" }), { ok: true, args: { xs: ["a"] } });
    assert.deepEqual(validateArgs(list, '{"xs":"[\\"b\\"]"}'), { ok: true, args: { xs: ["b"] } });
    assert.equal(validateArgs(list, { xs: ["a", "b", "a"] }).ok, false);
    assert.equal(validateArgs(list, { xs: ["c"] }).ok, false);
  });

  it("brings a number past its bounds to them: 30 rows of 5 at most is 5, 0 of 1 at least is 1", () => {
    assert.deepEqual(validateArgs(schema, { q: "x", n: 9 }), { ok: true, args: { q: "x", n: 5 } });
    assert.deepEqual(validateArgs(schema, { q: "x", n: "0" }), { ok: true, args: { q: "x", n: 1 } });
  });

  it("refuses what does not fit, with our own messages", () => {
    assert.deepEqual(validateArgs(schema, {}), { ok: false, message: "q is required" });
    assert.equal(validateArgs(schema, { q: "x", n: 1.5 }).ok, false);
    assert.equal(validateArgs(schema, { q: "x", e: "candles" }).ok, false);
    assert.equal(validateArgs(schema, { q: "x", a: "0xnot-base58" }).ok, false);
    assert.equal(validateArgs(schema, "[1,2]").ok, false);
    assert.equal(validateArgs(schema, { q: "this is far too long" }).ok, false);
  });
});
