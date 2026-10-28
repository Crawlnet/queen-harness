import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { llamaUnlocks, primaryUrl, webPageUrl } from "../src/links.ts";

describe("links: no query strings from data sources", () => {
  it("a primary URL is rebuilt from host and path; a referral tag goes", () => {
    assert.equal(primaryUrl("https://solscan.io/tx/abc?ref=partnerco"), "https://solscan.io/tx/abc");
    assert.equal(primaryUrl("https://defillama.com/protocol/aave?utm_source=partnerco#x"), "https://defillama.com/protocol/aave");
    assert.equal(primaryUrl("https://dexscreener.com/solana/abc?via=partnerco"), "https://dexscreener.com/solana/abc");
  });

  it("only a parameter a host needs stays (solscan cluster)", () => {
    assert.equal(primaryUrl("https://solscan.io/tx/abc?cluster=devnet&ref=partnerco"), "https://solscan.io/tx/abc?cluster=devnet");
    assert.equal(primaryUrl("https://solscan.io/tx/abc?cluster=partnerco"), "https://solscan.io/tx/abc");
  });

  it("a token's unlocks page: a slug with a dot (ether.fi) is one, a path is not", () => {
    assert.equal(llamaUnlocks("ether.fi"), "https://defillama.com/unlocks/ether.fi");
    assert.equal(llamaUnlocks("Arbitrum-Foundation"), "https://defillama.com/unlocks/arbitrum-foundation");
    assert.equal(llamaUnlocks("../protocols"), null);
    assert.equal(llamaUnlocks("a/b"), null);
  });

  it("a web page keeps its own parameters and loses tracking and referral ones", () => {
    assert.equal(webPageUrl("https://news.example.org/a?utm_source=partnerco"), "https://news.example.org/a");
    assert.equal(webPageUrl("https://news.example.org/a?id=7&utm_medium=x&ref=partnerco&via=partnerco&aff_id=9#top"), "https://news.example.org/a?id=7");
    assert.equal(webPageUrl("https://blog.example.org/?p=123"), "https://blog.example.org/?p=123");
  });
});
