import type { ToolsModule } from "@crawlnet/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { clustersBlock, withClusters } from "../src/clustermap.ts";

const DEV = "Dev1111111111111111111111111111111111111111";
const BIG = "Big1111111111111111111111111111111111111111";
const POOL = "Pump1111111111111111111111111111111111111111";
const TIED = "Tied111111111111111111111111111111111111111";
const MINT = "Mint1111111111111111111111111111111111111111";
// a coin's holder links: its pool, a 13% wallet tied to no one, the creator and one wallet tied to it
const links = {
  creator: { address: DEV },
  holders: [
    { owner: POOL, share_pct: 80.05, kind: "pool", label: "PumpSwap pool", cluster: null, link: `https://solscan.io/account/${POOL}` },
    { owner: BIG, share_pct: 13, kind: "wallet", cluster: null, link: `https://solscan.io/account/${BIG}` },
    { owner: DEV, share_pct: 4.611, kind: "wallet", cluster: 1, tokens_from: { from: POOL, kind: "pool" }, link: `https://solscan.io/account/${DEV}` },
    { owner: TIED, share_pct: 0.01962, kind: "wallet", cluster: 1, link: `https://solscan.io/account/${TIED}` },
  ],
  links: [{ from: DEV, to: TIED, asset: "SOL", amount: 2, count: 1 }],
  funders: [],
  clusters: [{ cluster: 1, holders: [DEV, TIED], wallets: 2, share_pct: 4.631, funders: [] }],
  complete: true,
  transactions_read: 379,
};
const tools = (data: unknown, seen: string[] = []): Pick<ToolsModule, "list" | "run"> => ({
  list: () => [{ name: "sol_holder_links", description: "", parameters: { type: "object", properties: {} } }],
  run: async (name: string, args: unknown) => (seen.push(`${name} ${JSON.stringify(args)}`), data ? { ok: true as const, data, sources: [] } : { ok: false as const, error: "unavailable" as const, message: "" }),
});
const json = (s: string) => JSON.parse(s.replace(/^```clusters\n/, "").replace(/\n```$/, ""));

test("the holder map from the chain's links: each holder its share and kind, the creator and its tie named, links only between holders on the map, the title the largest tied cluster's", () => {
  const b = json(clustersBlock(links)!);
  assert.equal(b.title, "largest tied cluster 4.63% (2 wallets)");
  assert.deepEqual(b.nodes.map((n: { label: string; value: number; kind: string }) => [n.label, n.value, n.kind]), [["PumpSwap pool", 80.05, "pool"], ["Big1…1111", 13, "wallet"], ["Dev1…1111", 4.611, "wallet"], ["Tied…1111", 0.01962, "wallet"]]);
  assert.match(b.nodes[2].note, /^the creator; tied cluster 1; first tokens from a pool$/);
  assert.equal(b.nodes[1].note, undefined, "the 13% wallet is tied to no one");
  assert.deepEqual(b.links, [{ from: "h3", to: "h4", label: "2 SOL" }]);
  const cut = json(clustersBlock({ ...links, clusters: [], complete: false, transactions_read: 60 })!);
  assert.equal(cut.title, "no tied cluster among the top holders, 60 transactions read, the rest unread");
  const funded = json(clustersBlock({ ...links, funders: [{ funder: "Fund1111111111111111111111111111", role: "funder", holders: [{ holder: BIG, sent: { SOL: 3 } }, { holder: "off-map" }] }] })!);
  assert.deepEqual(funded.nodes.at(-1), { id: "f1", label: "Fund…1111", value: 0, kind: "funder", note: "paid 1 of the holders" });
  assert.deepEqual(funded.links.at(-1), { from: "f1", to: "h2", label: "3 SOL" });
  assert.equal(clustersBlock({ holders: [] }), null);
  // kinds as the block draws them: pools as pool, programs as contract, a vault as team, the burn address as burn; labels
  // 4…4 unless named
  const kinds = json(clustersBlock({ holders: ["pool", "program", "vault", "burn", "exchange", "odd"].map((kind, i) => ({ owner: `Own${i}${"1".repeat(40)}`, share_pct: 1, kind})) })!);
  assert.deepEqual(kinds.nodes.map((n: { kind: string }) => n.kind), ["pool", "contract", "team", "burn", "exchange", "unknown"]);
  assert.equal(kinds.nodes[1].label, "Own1…1111");
});

test("an answer's clusters block becomes code's map of the scanned coin; a second one goes; with no coin or a failed read every one goes, the words stay", async () => {
  const model = 'the dev paid 12 wallets.\n\n```clusters\n{"title":"made up: dev-linked cluster holds 18.97%","nodes":[]}\n```\n\nwatch the 13% wallet.';
  const seen: string[] = [];
  const keep = new Set<string>();
  const out = await withClusters(model, "a1", tools(links, seen), MINT, { keep });
  assert.doesNotMatch(out, /18\.97/);
  assert.match(out, /^the dev paid 12 wallets\.\n\n```clusters\n\{"title":"largest tied cluster 4\.63% \(2 wallets\)"/);
  assert.match(out, /\n```\n\nwatch the 13% wallet\.$/);
  assert.deepEqual(seen, [`sol_holder_links {"mint":"${MINT}"}`]);
  assert.equal(keep.size, 1, "the guard leaves it as filled");
  const two = await withClusters(`${model}\n\n\`\`\`clusters\n{}\n\`\`\``, "a2", tools(links), MINT);
  assert.equal((two.match(/```clusters/g) ?? []).length, 1, "one map a coin");
  assert.equal(await withClusters(model, "a3", tools(null), MINT), "the dev paid 12 wallets.\n\nwatch the 13% wallet.", "a failed read: the block goes");
  assert.equal(await withClusters(model, "a4", tools(links), null), "the dev paid 12 wallets.\n\nwatch the 13% wallet.", "no coin scanned");
  assert.equal(await withClusters("no map here", "a5", null, MINT), "no map here");
});

test("the map's funders: an exchange drawn as one, which ties no one; every funder a tied cluster names drawn", () => {
  const H = (i: number) => `Hold${i}${"1".repeat(39)}`;
  const holders = [1, 2, 3, 4].map((i) => ({ owner: H(i), share_pct: 5, kind: "wallet", cluster: i >= 3 ? 1 : null }));
  const ex = { funder: "Bina1111111111111111111111111111", kind: "exchange", label: "Binance", role: "funder", holders: [{ holder: H(1), sent: { SOL: 1 } }, { holder: H(2), sent: { SOL: 1 } }] };
  const other = (n: number) => ({ funder: `Othr${n}${"2".repeat(27)}`, kind: "wallet", role: "funder", holders: [{ holder: H(1) }, { holder: H(2) }] });
  const tie = { funder: "Tie11111111111111111111111111111", kind: "wallet", role: "funder", holders: [{ holder: H(3), sent: { SOL: 2 } }, { holder: H(4), sent: { SOL: 2 } }] };
  const b = json(clustersBlock({ holders, funders: [ex, other(1), other(2), tie], clusters: [{ cluster: 1, holders: [H(3), H(4)], wallets: 2, share_pct: 10, funders: [tie.funder] }] })!);
  const fnodes = b.nodes.filter((n: { id: string }) => n.id.startsWith("f"));
  assert.equal(fnodes[0].label, "Tie1…1111", "the cluster's own funder first");
  assert.ok(fnodes.some((n: { label: string; kind: string; note: string }) => n.label === "Binance" && n.kind === "exchange" && /an exchange ties no one$/.test(n.note)));
  assert.equal(fnodes.length, 3, "the cluster's funder, then others to three");
  assert.equal(b.title, "largest tied cluster 10% (2 wallets)");
});

test("the map's fence: inside a list it keeps the item's indent; ```cluster, tildes and an empty block are filled; a quoted one is never read", async () => {
  const listed = await withClusters("- holders:\n  ```clusters\n  {}\n  ```\n- dev sold 40%\n- lp burned", "b1", tools(links), MINT);
  const lines = listed.split("\n");
  assert.equal(lines[0], "- holders:");
  assert.ok(lines.slice(1, 4).every((l) => l.startsWith("  ")), "every line of the block indented under its item");
  assert.deepEqual(lines.slice(-2), ["- dev sold 40%", "- lp burned"]);
  for (const fence of ["```cluster\n{\"title\":\"made up\"}\n```", "~~~clusters\n{\"title\":\"made up\"}\n~~~", "```clusters\n```"]) {
    const out = await withClusters(`map:\n\n${fence}\n\nend.`, "b2", tools(links), MINT);
    assert.doesNotMatch(out, /made up/);
    assert.match(out, /^map:\n\n```clusters\n\{"title":"largest tied cluster 4\.63% \(2 wallets\)"/, fence.slice(0, 12));
    assert.match(out, /\n```\n\nend\.$/);
  }
  const quoted = "> ```clusters\n> {}\n> ```\n\nthe dev sold.\n\n```token\n{}\n```";
  assert.equal(await withClusters(quoted, "b3", tools(links), MINT), quoted, "the words and the token card stay");
});
