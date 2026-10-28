// Jev for a question code's regexes read as weak (src/jev.ts): one Choice question on OpenRouter's Decisions API, its
// pick only when sure, never a throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JEV_INTENTS, JEV_MODEL, jevIntent } from "../src/jev.ts";

const reply = (choice: string, confidence: number, status = 200) => async (_u: string | URL | Request, _i?: RequestInit) =>
  new Response(JSON.stringify({ model: `${JEV_MODEL}-test`, answers: { intent: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } }, usage: { cost: 0.00003 } }), { status });

test("the request: the pinned model, the previous question then the question, one Choice over the nine kinds, the key as a bearer", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const f = (async (u: string | URL | Request, i?: RequestInit) => {
    seen = { url: String(u), init: i! };
    return reply("self", 0.9)(u, i);
  }) as typeof fetch;
  const r = await jevIntent("你是谁？", "who are you?", { key: "k-1" }, f);
  assert.equal(r?.intent, "self");
  assert.equal(r?.confidence, 0.9);
  assert.equal(seen!.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer k-1");
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(body.model, "typesafe/jev-1.14");
  assert.deepEqual(body.state, ["previous question in this chat: who are you?", "question: 你是谁？"]);
  assert.equal(body.questions.intent.type, "choice");
  assert.deepEqual(Object.keys(body.questions.intent.criteria), Object.keys(JEV_INTENTS));
  assert.equal(Object.keys(JEV_INTENTS).length, 9);
});

test("null: no key, an unsure pick, general, an unknown kind, an http error, broken JSON, a timeout", async () => {
  assert.equal(await jevIntent("hi", null, { key: "" }, reply("token", 1) as typeof fetch), null);
  assert.equal(await jevIntent("what do u think about sol", null, { key: "k" }, reply("token", 0.6) as typeof fetch), null);
  assert.equal(await jevIntent("hey", null, { key: "k" }, reply("general", 0.99) as typeof fetch), null);
  assert.equal(await jevIntent("x", null, { key: "k" }, reply("pizza", 0.99) as typeof fetch), null);
  assert.equal(await jevIntent("x", null, { key: "k" }, reply("token", 0.99, 429) as typeof fetch), null);
  assert.equal(await jevIntent("x", null, { key: "k" }, (async () => new Response("not json")) as typeof fetch), null);
  const slow = (async (_u: string | URL | Request, i?: RequestInit) =>
    new Promise<Response>((_, reject) => i?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const t0 = Date.now();
  assert.equal(await jevIntent("x", null, { key: "k", timeoutMs: 50 }, slow), null);
  assert.ok(Date.now() - t0 < 1000);
  // a sure pick of a real kind
  assert.equal((await jevIntent("compare lido and rocket pool in a table", null, { key: "k" }, reply("defi", 0.97) as typeof fetch))?.intent, "defi");
});

test("a sure general comes back only when asked for (a weak follow-up's read drops the plan it would keep); an unsure one never", async () => {
  assert.deepEqual(await jevIntent("what is a zk rollup?", "scan this token", { key: "k", general: true }, reply("general", 0.93) as typeof fetch).then((r) => r && { intent: r.intent, confidence: r.confidence }), { intent: "general", confidence: 0.93 });
  assert.equal(await jevIntent("what is a zk rollup?", "scan this token", { key: "k" }, reply("general", 0.93) as typeof fetch), null);
  assert.equal(await jevIntent("what is a zk rollup?", "scan this token", { key: "k", general: true }, reply("general", 0.5) as typeof fetch), null);
});
