// The chat's holder map (```clusters) written by code from the chain's holder links. The model places the block; every
// node, link, share and the title are sol_holder_links' own, as the token card is the scan's, so the map never shows a
// cluster the links did not read (wallets a dev's money trail paid are no cluster unless they hold the coin).

import type { ToolsModule } from "@crawlnet/shared";

/**
 * A holder map's fence (```clusters or ```cluster, backticks or tildes), on its own lines: its
 * indent (inside a list item), its body (empty too), its closing fence of the same kind at the same indent. One in a
 * quote is never read
 */
const CLUSTERS_FENCE = /(\n*)^([ \t]*)(`{3,}|~{3,})[ \t]*clusters?\b[^\n]*\n(?:[\s\S]*?\n)??\2\3[ \t]*$(\n*)/gim;
/** How long the fill waits for the links read (the dossier's own read is cached: it usually comes back at once) */
export const CLUSTERS_FILL_MS = 8_000;
/** Common funders drawn beside the map's holders (12 at most, the read's): every one a tied cluster names, then others to this many */
const FUNDERS_MAX = 3;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const short = (a: string): string => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const pct = (v: number): string => `${v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3)}`.replace(/\.?0+$/, "");
/** The read's kinds as the block's: a vault is a team's, a program a contract */
const KIND: Record<string, string> = { wallet: "wallet", pool: "pool", exchange: "exchange", vault: "team", program: "contract", burn: "burn" };
const sentLabel = (sent: unknown): string =>
  isRec(sent)
    ? Object.entries(sent)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .map(([a, v]) => `${pct(v as number)} ${a}`)
        .slice(0, 2)
        .join(", ")
    : "";

/** The map of a coin's top holders from sol_holder_links' data: its holders, their links and common funders; null when it holds none */
export function clustersBlock(data: Rec): string | null {
  const holders = (Array.isArray(data.holders) ? data.holders : []).filter(isRec).filter((h) => str(h.owner));
  if (holders.length === 0) return null;
  const creator = isRec(data.creator) ? str(data.creator.address) : null;
  const ids = new Map<string, string>();
  const nodes: Rec[] = [];
  holders.forEach((h, i) => {
    const owner = str(h.owner)!;
    ids.set(owner, `h${i + 1}`);
    const notes = [
      owner === creator ? "the creator" : null,
      num(h.cluster) !== null ? `tied cluster ${h.cluster}` : null,
      str(h.note),
      isRec(h.tokens_from) && str(h.tokens_from.from) ? `first tokens from ${h.tokens_from.kind === "pool" ? "a pool" : short(str(h.tokens_from.from)!)}` : null,
    ].filter(Boolean);
    nodes.push({
      id: `h${i + 1}`,
      label: str(h.label) ?? short(owner),
      value: num(h.share_pct) ?? 0,
      kind: KIND[str(h.kind) ?? ""] ?? "unknown",
      ...(notes.length ? { note: notes.join("; ") } : {}),
      ...(str(h.link) ? { url: str(h.link) } : {}),
    });
  });
  const links: Rec[] = [];
  for (const l of (Array.isArray(data.links) ? data.links : []).filter(isRec)) {
    const from = ids.get(str(l.from) ?? ""), to = ids.get(str(l.to) ?? "");
    if (from && to && from !== to) links.push({ from, to, label: `${pct(num(l.amount) ?? 0)} ${str(l.asset) ?? ""}`.trim() });
  }
  // the funders a tied cluster names first, then the others; an exchange or a pool drawn as what it is, which never
  // joins a cluster (an exchange that paid two holders ties no one)
  const clusters = (Array.isArray(data.clusters) ? data.clusters : []).filter(isRec);
  const tying = new Set(clusters.flatMap((c) => (Array.isArray(c.funders) ? c.funders : []).map((f) => str(f)).filter((f): f is string => f !== null)));
  const all = (Array.isArray(data.funders) ? data.funders : []).filter(isRec).filter((f) => str(f.funder));
  const funders = [...all.filter((f) => tying.has(str(f.funder)!)), ...all.filter((f) => !tying.has(str(f.funder)!)).slice(0, Math.max(0, FUNDERS_MAX - tying.size))];
  funders.forEach((f, i) => {
    const paid = (Array.isArray(f.holders) ? f.holders : []).filter(isRec).filter((x) => ids.has(str(x.holder) ?? ""));
    if (paid.length === 0) return;
    const id = `f${i + 1}`;
    const kind = f.kind === "exchange" ? "exchange" : f.kind === "pool" ? "pool" : "funder";
    const apart = kind === "pool" ? "; a pool ties no one" : kind === "exchange" ? "; an exchange ties no one" : "";
    nodes.push({ id, label: str(f.label) ?? short(str(f.funder)!), value: 0, kind, note: `${f.role === "distributor" ? "sent this coin to" : "paid"} ${paid.length} of the holders${apart}`, ...(str(f.link) ? { url: str(f.link) } : {}) });
    for (const x of paid) links.push({ from: id, to: ids.get(str(x.holder)!)!, label: sentLabel(x.sent) });
  });
  const big = [...clusters].sort((a, b) => (num(b.share_pct) ?? 0) - (num(a.share_pct) ?? 0))[0];
  const share = big ? num(big.share_pct) : null;
  const wallets = big ? num(big.wallets) ?? (Array.isArray(big.holders) ? big.holders.length : 0) : 0;
  const cut = data.complete === false;
  const title = `${share ? `largest tied cluster ${pct(share)}% (${wallets} wallets)` : "no tied cluster among the top holders"}${cut ? `, ${num(data.transactions_read) ?? 0} transactions read, the rest unread` : ""}`;
  return `\`\`\`clusters\n${JSON.stringify({ title, unit: "pct", nodes, links })}\n\`\`\``;
}

/**
 * An answer's ```clusters blocks as code writes them: the first one becomes the map of `mint` from sol_holder_links
 * (`tools.run` under `${answerId}:clusters`, at most `o.ms`), each one after it goes (one map a coin); with no coin, no
 * such function offered, or a read that failed, every one goes. The words around a removed block stay. A filled block
 * goes into `o.keep`, which the answer's guard leaves as it is. Never throws.
 */
export async function withClusters(answer: string, answerId: string, tools: Pick<ToolsModule, "list" | "run"> | null, mint: string | null, o: { signal?: AbortSignal; ms?: number; keep?: Set<string> } = {}): Promise<string> {
  if (typeof answer !== "string" || !/(`{3,}|~{3,})[ \t]*clusters?\b/i.test(answer)) return answer;
  let block: string | null = null;
  try {
    if (tools && mint && tools.list().some((t) => t.name === "sol_holder_links")) {
      const ms = Math.max(1, Math.floor(o.ms ?? CLUSTERS_FILL_MS));
      const stop = AbortSignal.timeout(ms);
      const r = await tools.run("sol_holder_links", { mint }, { answerId: `${answerId}:clusters`, signal: o.signal ? AbortSignal.any([o.signal, stop]) : stop });
      block = r && r.ok && isRec(r.data) ? clustersBlock(r.data) : null;
    }
  } catch {
    block = null;
  }
  if (block) o.keep?.add(block);
  let first = true;
  const out = answer.replace(CLUSTERS_FENCE, (m: string, pre: string, indent: string, _fence: string, post: string, at: number, whole: string) => {
    const put = first && block;
    first = false;
    // inside a list item every line of it keeps the item's indent, or the rest of the list falls into the block
    if (put) return `${pre}${put.split("\n").map((l) => `${indent}${l}`).join("\n")}${post}`;
    if (at === 0 || at + m.length === whole.length) return "";
    return pre && post ? "\n\n" : `${pre}${post}`;
  });
  return out.trim();
}
