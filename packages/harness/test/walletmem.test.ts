// What the queen has seen a wallet do (src/walletmem.ts): a wallet's roles in coins kept a month, recalled for the next
// coin's wallets, said as lines a role.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "@crawlnet/shared";
import { createHash } from "node:crypto";
import { KEEP_MS, memoryLines, rememberingTools, rolesFromReads, WalletMemory, type WalletSeen } from "../src/walletmem.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A Solana-shaped key from a seed (44 base58 characters) */
const solKey = (seed: string): string => [...createHash("sha256").update(seed).digest("hex").repeat(2)].slice(0, 44).map((c, i) => B58[(parseInt(c, 16) * 3 + i) % 58]).join("");

const W = (i: number) => solKey(`walletmem-wallet-${i}`);
const M = (i: number) => solKey(`walletmem-mint-${i}`);
const H = 3_600_000;
const D = 24 * H;

describe("the queen's memory of wallets", () => {
  it("keeps a wallet's role in a coin (its latest moment), recalls it for other coins only, newest first", () => {
    let t = 100 * D;
    const mem = new WalletMemory(openDb(":memory:"), () => t);
    mem.remember([
      { wallet: W(1), mint: M(1), symbol: "AAA", role: "bundle", at: t - 2 * D, sharePct: 4.2 },
      { wallet: W(1), mint: M(2), symbol: "BBB", role: "sniper", at: t - 3 * H, sharePct: null },
      { wallet: W(2), mint: M(2), symbol: "BBB", role: "sniper", at: t - 3 * H, sharePct: 1 },
      { wallet: "not a wallet", mint: M(2), symbol: null, role: "sniper", at: t, sharePct: null },
      { wallet: W(3), mint: M(3), symbol: null, role: "nonsense" as never, at: t, sharePct: null },
    ]);
    // the same wallet, coin and role again: its moment moves, its symbol and share stay when the new read has none
    mem.remember([{ wallet: W(1), mint: M(1), symbol: null, role: "bundle", at: t - D, sharePct: null }]);
    const seen = mem.recall([W(1), W(2), W(3)], M(9));
    assert.deepEqual(
      seen.map((s) => [s.wallet === W(1) ? 1 : 2, s.symbol, s.role, (t - s.at) / H, s.sharePct]),
      [
        [1, "BBB", "sniper", 3, null],
        [2, "BBB", "sniper", 3, 1],
        [1, "AAA", "bundle", 24, 4.2],
      ],
    );
    assert.deepEqual(mem.recall([W(1)], M(2)).map((s) => s.symbol), ["AAA"], "the coin being read is left out");
    t += KEEP_MS;
    mem.remember([{ wallet: W(4), mint: M(4), symbol: "NEW", role: "dev", at: t, sharePct: 30 }]);
    assert.deepEqual(mem.recall([W(1), W(2)], M(9)), [], "a month old: gone");
  });

  it("memoryLines: per role of this coin, how many of its wallets were in earlier coins and as what; nothing when none", () => {
    const now = 100 * D;
    const coin = [
      { wallet: W(1), role: "sniper" as const },
      { wallet: W(2), role: "sniper" as const },
      { wallet: W(3), role: "sniper" as const },
      { wallet: W(9), role: "dev" as const },
      { wallet: W(5), role: "bundle" as const },
    ];
    const seen: WalletSeen[] = [
      { wallet: W(1), mint: M(1), symbol: "AAA", role: "bundle", at: now - 2 * D, sharePct: null },
      { wallet: W(2), mint: M(1), symbol: "AAA", role: "bundle", at: now - 2 * D, sharePct: null },
      { wallet: W(2), mint: M(2), symbol: null, role: "sniper", at: now - 30 * 60_000, sharePct: null },
      { wallet: W(9), mint: M(3), symbol: "DEV1", role: "dev", at: now - 5 * D, sharePct: 20 },
      { wallet: W(9), mint: M(4), symbol: "DEV2", role: "dev", at: now - 6 * D, sharePct: 20 },
      { wallet: W(9), mint: M(5), symbol: "DEV3", role: "funder", at: now - 7 * D, sharePct: null },
      { wallet: W(9), mint: M(6), symbol: "DEV4", role: "dev", at: now - 8 * D, sharePct: null },
    ];
    assert.deepEqual(memoryLines(coin, seen, now), [
      "the dev was in earlier coins: the dev of $DEV1 5 d ago; the dev of $DEV2 6 d ago; the funder of $DEV3 7 d ago, 1 more coins",
      `2 of its 3 snipers were in earlier coins: a sniper of ${M(2).slice(0, 6)}… 30 min ago; the bundle of $AAA (2 of them) 2 d ago`,
    ]);
    assert.deepEqual(memoryLines(coin, [], now), []);
  });

  it("a broken store remembers and recalls nothing, never throws", () => {
    const db = openDb(":memory:");
    const mem = new WalletMemory(db, () => 0);
    db.exec("DROP TABLE queen_wallet_roles");
    mem.remember([{ wallet: W(1), mint: M(1), symbol: null, role: "dev", at: 0, sharePct: null }]);
    assert.deepEqual(mem.recall([W(1)], M(2)), []);
  });

  it("rolesFromReads: the dev, bundle and snipers of a launch read (not its \"all\" rows), a holder map's cluster holders and funders, the pre-call buyers and their funders, each once", () => {
    const launch = { content: [
      { role: "bundle", wallet: "all", wallets: 2, first_buys_pct: 9 },
      { role: "bundle", wallet: W(1), first_buys_pct: 5 },
      { role: "dev", wallet: W(2), first_buys_pct: 3 },
      { role: "sniper", wallet: W(3), first_buys_pct: 1.5 },
      { role: "sniper", wallet: "nope", first_buys_pct: 1 },
    ] };
    const links = { clusters: [{ cluster: 1, holders: [W(4), W(5)], funders: [W(6)] }, { cluster: 2, holders: [W(5), W(7)], funders: [{ funder: W(8) }] }] };
    const frontrun = { rows: [{ wallet: W(3), bought_pct: 0.4, funder: W(6) }, { wallet: W(9), bought_pct: null, funder: null }] };
    const got = rolesFromReads({ launch, links, frontrun }).map((x) => [x.wallet, x.role, x.sharePct]);
    assert.deepEqual(got, [
      [W(1), "bundle", 5],
      [W(2), "dev", 3],
      [W(3), "sniper", 1.5],
      [W(4), "cluster", null],
      [W(5), "cluster", null],
      [W(6), "funder", null],
      [W(7), "cluster", null],
      [W(8), "funder", null],
      [W(3), "frontrun", 0.4],
      [W(9), "frontrun", null],
    ]);
    assert.deepEqual(rolesFromReads({}), []);
  });

  it("rememberingTools: a launch read on its way back is kept with the coin its arguments name (an object or a JSON string); other functions, failures and broken reads change nothing", async () => {
    const t = 50 * D;
    const mem = new WalletMemory(openDb(":memory:"), () => t);
    const launch = { content: [{ role: "dev", wallet: W(2), first_buys_pct: 12 }, { role: "sniper", wallet: W(3), first_buys_pct: 2 }] };
    const inner = {
      list: () => [],
      async run(name: string, _args?: unknown, _ctx?: unknown): Promise<{ ok: true; data: unknown; sources: [] } | { ok: false; error: "unavailable"; message: string }> {
        if (name === "broken") return { ok: false, error: "unavailable", message: "down" };
        return { ok: true, data: name === "sol_launch" ? launch : { content: "not rows" }, sources: [] };
      },
    };
    const tools = rememberingTools(inner, mem, () => t);
    const ctx = { answerId: "a1" };
    const r = await tools.run("sol_launch", { mint: M(1) }, ctx);
    assert.ok(r.ok && r.data === launch, "the caller gets the answer as it was");
    await tools.run("sol_launch", JSON.stringify({ mint: M(2) }), ctx);
    await tools.run("token_pairs", { mint: M(3) }, ctx);
    await tools.run("broken", { mint: M(4) }, ctx);
    await tools.run("sol_launch", { mint: "not a mint" }, ctx);
    assert.deepEqual(mem.recall([W(2), W(3)], M(9)).map((s) => [s.wallet === W(2) ? "dev" : "sniper", s.mint === M(1) ? 1 : 2, s.role, s.sharePct]).sort(), [
      ["dev", 1, "dev", 12],
      ["dev", 2, "dev", 12],
      ["sniper", 1, "sniper", 2],
      ["sniper", 2, "sniper", 2],
    ]);
    assert.equal(typeof tools.list, "function", "the rest of the tools stays");
  });
});
