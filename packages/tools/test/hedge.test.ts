// The tools layer on a flapping network: its fetch is hedged (registry.ts FREE_HEDGE), each extra attempt counted against
// its provider's limiter; a paid search never twice.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { hedgedFetch } from "@crawlnet/shared";
import { OPENROUTER_HOST } from "../src/free/grokx.ts";
import { FREE_HEDGE, GECKO_HEDGE, toolsHedge, XSEARCH_HEDGE } from "../src/registry.ts";

describe("which requests are hedged how (toolsHedge)", () => {
  const limiter = (n: number) => {
    let left = n;
    return { take: () => left-- > 0 };
  };

  it("GeckoTerminal: only after a network failure, against its limiter; the other free sources: 2.5 s, against theirs", () => {
    const gecko = limiter(1);
    const llama = limiter(0);
    const by = (h: string) => (h === "api.geckoterminal.com" ? gecko : h === "api.llama.fi" ? llama : undefined);
    const g = toolsHedge("api.geckoterminal.com", undefined, { limiter: by });
    assert.equal(g.waveMs, GECKO_HEDGE.waveMs);
    assert.equal(g.admitLeg?.(1, "failed"), true);
    assert.equal(g.admitLeg?.(2, "failed"), false, "the limiter is spent");
    const l = toolsHedge("api.llama.fi", undefined, { limiter: by });
    assert.equal(l.waveMs, FREE_HEDGE.waveMs);
    assert.equal(l.admitLeg?.(1, "slow"), false);
    assert.equal(toolsHedge("example.org", undefined, { limiter: by }).admitLeg, undefined);
  });

  it("Helius (the launch keys and a shared Helius RPC, one host): again only after a network failure, never for slowness, each leg billed", () => {
    const rpc = limiter(5);
    const any = toolsHedge("mainnet.helius-rpc.com", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [] }), { limiter: () => rpc });
    assert.equal(any.waveMs, GECKO_HEDGE.waveMs, "never a leg for slowness");
    assert.equal(any.waves, GECKO_HEDGE.waves);
    const history = toolsHedge("mainnet.helius-rpc.com", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransactionsForAddress", params: [] }), { limiter: () => rpc });
    assert.deepEqual(history, { ...XSEARCH_HEDGE }, "a history page: one attempt");
    assert.equal(toolsHedge("api.mainnet-beta.solana.com", undefined, { limiter: () => rpc }).waveMs, FREE_HEDGE.waveMs, "a free public rpc keeps its hedge");
  });

  it("a paid search (OpenRouter): one attempt, never sent twice, slow or reset (each call is billed)", async () => {
    let taken = 0;
    const o = toolsHedge(OPENROUTER_HOST, undefined, { limiter: () => ({ take: () => (taken++, true) }) });
    assert.deepEqual([o.waves, o.waveMs, o.admitLeg], [1, Infinity, undefined]);
    assert.deepEqual(o, { ...XSEARCH_HEDGE });
    let hits = 0;
    const srv = createServer((req) => {
      req.resume();
      req.on("end", () => {
        hits++;
        req.socket.destroy();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/v1/chat/completions`;
      await assert.rejects(hedgedFetch(url, { method: "GET" }, { ...o, loopback: true }));
      assert.equal(hits, 1, "a reset one is not sent again");
      assert.equal(taken, 0);
    } finally {
      srv.close();
    }
  });
});
