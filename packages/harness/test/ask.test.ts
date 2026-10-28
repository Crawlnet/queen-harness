// The whole answer over a fake model and a fake tools layer: the plan's functions offered, a call run, the JSON reply
// read, markdown accepted when the model ignores the format, code's short answer when the model fails, the guard over
// what goes out.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResult, ToolSpec, ToolsModule } from "@crawlnet/shared";
import { createHarness } from "../src/ask.ts";
import { loadHarnessConfig } from "../src/config.ts";

const spec = (name: string): ToolSpec => ({ name, description: `${name} (test)`, parameters: { type: "object", properties: {}, additionalProperties: false } });

function fakeTools(results: Record<string, ToolResult>, calls: string[] = []): ToolsModule {
  return {
    list: () => Object.keys(results).map(spec),
    run: async (name) => {
      calls.push(name);
      return results[name] ?? { ok: false, error: "unavailable", message: "no such tool" };
    },
    redact: (t) => t.replaceAll("SECRET-TERM", "…"),
    redactSources: (s) => s.filter((x) => !x.url.includes("secret")),
    stop() {},
  };
}

/** A chat completions endpoint that plays the given replies in order: a tool call, or the content */
function fakeModel(replies: ({ call: string } | { content: string } | { status: number })[], seen: unknown[] = []): typeof fetch {
  let i = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body ?? "{}")));
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if ("status" in r) return new Response("down", { status: r.status });
    const message = "call" in r ? { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: r.call, arguments: "{}" } }] } : { role: "assistant", content: r.content };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: "call" in r ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const env = { LLM_API_KEY: "sk-test-not-a-real-key", LLM_MODEL: "test-model", LLM_BASE_URL: "https://llm.test/v1", LLM_THINKING: "off" } as NodeJS.ProcessEnv;
const TVL: ToolResult = { ok: true, data: { protocol: "aave", tvl_usd: 17_570_000_000 }, sources: [{ title: "DefiLlama: Aave", url: "https://defillama.com/protocol/aave" }] };

describe("ask", () => {
  it("a defi question: the plan's function called, the JSON reply read, its sources and follow-ups out through the guard", async () => {
    const calls: string[] = [];
    const seen: unknown[] = [];
    const h = createHarness({
      cfg: loadHarnessConfig(env),
      tools: fakeTools({ protocol_tvl: TVL }, calls),
      fetch: fakeModel([{ call: "protocol_tvl" }, { content: JSON.stringify({ answer: "aave's tvl is **$17.57b** right now on defillama. SECRET-TERM", pages: [], followups: ["show its fees"] }) }], seen),
    });
    const a = await h.ask({ question: "what is aave's tvl?" });
    assert.equal(a.by, "model");
    assert.deepEqual(calls, ["protocol_tvl"]);
    assert.match(a.answer, /\$17\.57b/);
    assert.doesNotMatch(a.answer, /SECRET-TERM/, "the guard runs over the answer");
    assert.doesNotMatch(a.answer, /protocol_tvl/);
    assert.deepEqual(a.sources, [{ url: "https://defillama.com/protocol/aave", title: "DefiLlama: Aave" }]);
    assert.deepEqual(a.followups, ["show its fees"]);
    const first = seen[0] as { tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    assert.deepEqual(first.tools?.map((t) => t.function.name), ["protocol_tvl"], "only the plan's functions are offered");
    assert.match(first.messages[0]!.content, /you are the queen of crawlnet/);
  });

  it("markdown with a visual block is the answer when the model ignores the reply format", async () => {
    const md = 'aave sits at **$17.57b**.\n\n```chart\n{"type": "line", "title": "aave tvl", "unit": "usd", "x": ["oct 1"], "series": [{"name": "tvl", "values": [1.9e10]}]}\n```';
    const h = createHarness({ cfg: loadHarnessConfig(env), tools: fakeTools({ protocol_tvl: TVL }), fetch: fakeModel([{ content: md }]) });
    const a = await h.ask({ question: "what is aave's tvl?" });
    assert.equal(a.by, "model");
    assert.match(a.answer, /```chart\n\{"type": "line"/);
  });

  it("the model down: code's short answer from what the rounds fetched, never a bare failure", async () => {
    const h = createHarness({ cfg: loadHarnessConfig(env), tools: fakeTools({ protocol_tvl: TVL }), fetch: fakeModel([{ call: "protocol_tvl" }, { status: 503 }]) });
    const a = await h.ask({ question: "what is aave's tvl?" });
    assert.notEqual(a.by, "model");
    assert.ok(a.answer.length > 0);
  });

  it("no key or no model: a plain line, nothing called", async () => {
    const calls: string[] = [];
    const h = createHarness({ cfg: loadHarnessConfig({} as NodeJS.ProcessEnv), tools: fakeTools({ protocol_tvl: TVL }, calls), fetch: fakeModel([{ content: "x" }]) });
    const a = await h.ask({ question: "what is aave's tvl?" });
    assert.equal(a.by, "canned");
    assert.deepEqual(calls, []);
  });

  it("an empty question asks for one", async () => {
    const h = createHarness({ cfg: loadHarnessConfig(env), tools: fakeTools({}), fetch: fakeModel([{ content: "x" }]) });
    assert.equal((await h.ask({ question: "   " })).answer, "ask me something.");
  });
});
