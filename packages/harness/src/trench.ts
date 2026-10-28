// The trench read: how the queen reads a memecoin, one text for every place that reads a coin. Built from what trenchers
// check before a buy and the ways a buy loses money (a pulled pool, a top bought, a stop shaken out), on the one
// severity scale (@crawlnet/shared severity.ts).

import { byShare, SEVERITY, type Severity, worse, worst } from "@crawlnet/shared";
import { launchFacts, linkFacts } from "./chainfacts.ts";

const S = SEVERITY;

/**
 * The questions that decide a memecoin, in the order a trencher asks them. Every threshold it states is the one severity
 * scale's (SEVERITY), the numbers code levels the dossier's reads by
 */
const TRENCH_READ: readonly string[] = [
  `the trap first: a pool its deployer can pull (lp under ${SEVERITY.lpLockedPct}% locked or burned outside the bonding curve), live mint or freeze authority, a honeypot, transfer fees, hooks or taxes, or a pool rugcheck marks rugged already: any of them is danger, and nothing else about the coin matters.`,
  "the real coin: a hot story gets dozens of copies within the hour, and only the og runs: the first coin launched for the story (at or after its source, the post or the event) that took the flow, verified when there is a verified one. a same-name coin from before the story is an old ca, its own play, never the og; a copy launched after the og took the flow is a pass.",
  `the dev: what the dev bought at launch, holds now and where the rest went (into the pool or the curve is a sale; to wallets, side wallets whose share counts as the dev's), where the dev's money came from, and how many coins the dev made before and how they ended (${S.devCoinsWarn} or more: a serial deployer, a warning).`,
  `the hidden group: the largest cluster of wallets tied by one funder or by transfers, the top 10 without pools and exchanges, the bundle of the creation slot and the first-minute snipers and what they still hold, and the insiders rugcheck detects (a warning); many of the largest wallets holding the same bag are one hand that split its supply, a warning too. danger: the dev at ${S.devDangerPct}%, a tied cluster at ${S.clusterDangerPct}%, a bundle still holding ${S.bundleDangerPct}%, one wallet at ${S.largestDangerPct}% or the top 10 at ${S.top10DangerPct}% (on an old, large coin those two are a warning); a warning: the dev at ${S.devWarnPct}%, a cluster at ${S.clusterWarnPct}%, one wallet at ${S.largestWarnPct}%, the top 10 at ${S.top10WarnPct}%, a bundle at ${S.bundleWarnPct}% or snipers at ${S.sniperWarnPct}% still holding, 0.1-1% wallets at ${S.spreadBandPct}% from one funder or fresh (a cabal).`,
  "the stage: on its bonding curve, just graduated, or old. fresh coins move on their launch structure and their story; old ones on their holders and flows.",
  "the story: what it memes, whether that story is live today (who started it, when, how fast it spreads), which of today's metas it rides, organic or farmed.",
  "the flow: who buys now (smart money in or out, how many came in within the hour), whether the volume is real (independent buyers, not a few wallets trading with each other), and whether a caller's side wallets bought minutes before the post and sell into it.",
  "the timing: a story starting beats one that already ran 10x and fades on 5-minute volume; never a vertical candle.",
  "the exit: what selling costs at your size, and what happens to the price if the largest tied group sells.",
];

/** The trench read as prompt lines ("- …") */
export function trenchLines(): string {
  return TRENCH_READ.map((l) => `- ${l}`).join("\n");
}

// The reads behind it, by code, on the one scale: the dossier (harness.ts dossierLines) builds its lines on these

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const p1 = (v: number): string => `${Math.round(v * 10) / 10}%`;

/** A read's words and its level on the one scale */
export interface Leveled {
  level: Severity;
  words: string;
}

/** The top holders a dev sent tokens to (sol_holder_links: their first tokens came from the dev's wallet), and what they hold now */
export interface SideWallets {
  wallets: number;
  pct: number;
}

/** What a side wallet can be: a wallet or a vault (a team's allocation), never a pool, a program, an exchange or the burn */
const SIDE_KINDS = new Set(["wallet", "vault", "unknown"]);

/**
 * The dev's side wallets among the top holders, `dev` its wallet (the launch read's, the creator read's, else the one
 * the links name as the creator or likely deployer): those whose first tokens came from it; null when the links were
 * not read or the dev is unknown, so nothing settles where a bag that left its wallet went
 */
export function sideWallets(links: Record<string, unknown> | null, dev: string | null = null): SideWallets | null {
  const l = linkFacts(links);
  const who = dev ?? l?.creator ?? null;
  if (!l || !who) return null;
  const mine = l.holders.filter((h) => h.owner !== who && h.tokensFrom?.from === who && SIDE_KINDS.has(h.kind ?? "wallet"));
  return { wallets: mine.length, pct: mine.reduce((t, h) => t + (h.sharePct ?? 0), 0) };
}

/**
 * The dev's level on the dev scale: what it holds now with what its side wallets hold (their share is the dev's); a bag
 * of the danger share or more that left its wallet with nothing read of where it went is a warning, never ok
 */
function devLevel(holds: number, left: number | null, side: SideWallets | null, bought: number | null = null): Severity {
  if ((bought ?? 0) >= DEV_MAJORITY_PCT) return "danger";
  const level = byShare(holds + (side?.pct ?? 0), S.devDangerPct, S.devWarnPct);
  return side === null && (left ?? 0) >= S.devDangerPct ? worse(level, "warn") : level;
}

/**
 * A dev launch buy of this share of supply or more: one hand made most of the coin, a danger whatever it holds now.
 * Under it, a bag that left with nothing read of where it went is a warning and one the links settle as sold is the dev
 * gone
 */
export const DEV_MAJORITY_PCT = 50;

/** Where a dev's bag went, in a dossier's words: the top holders it sent tokens to, or that nothing read says where */
function sideWords(left: number | null, side: SideWallets | null): string {
  if (side && side.wallets > 0) return `, ${side.wallets} top holder${side.wallets === 1 ? "" : "s"} it sent tokens to hold ${p1(side.pct)}`;
  return side === null && (left ?? 0) >= S.devDangerPct ? ", where it went unread" : "";
}

/**
 * One role of a launch read: its words and its level (null: none of its own, as a screen's snipers under the line), what
 * it holds now (% of supply) and its wallets, for the chat's token card (scan.ts deepChecks)
 */
interface LaunchPart {
  level: Severity | null;
  words: string;
  holdsPct: number | null;
  wallets: number;
  /** What it bought at launch and what left its wallets since (sold or moved), % of supply; null when not read */
  boughtPct?: number | null;
  soldPct?: number | null;
}

/** The dev as a read gives it: a launch part with what left its wallet (sold or sent) and the top holders it sent tokens to (null: not read) */
export interface DevRead extends LaunchPart {
  leftPct: number | null;
  side: SideWallets | null;
}

/** A launch read's roles; `seen`: the seconds a screen or a cut read saw of its window, null for a whole read */
export interface LaunchParts {
  dev: DevRead | null;
  bundle: LaunchPart | null;
  snipers: LaunchPart | null;
  seen: number | null;
}

/**
 * A launch read's roles, each with its words and its level: the dev (with the side wallets it sent tokens to, from
 * `links`), the creation slot's bundle, the first-minute snipers (sol_launch)
 */
export function launchParts(d: Record<string, unknown> | null, links: Record<string, unknown> | null = null): LaunchParts | null {
  const f = launchFacts(d);
  if (!f) return null;
  const out: LaunchParts = { dev: null, bundle: null, snipers: null, seen: null };
  const dev = f.roles.dev;
  if (dev) {
    const holds = dev.holdsNowPct;
    // what left the dev's wallet is what sol_launch calls sold: what it bought less what it holds now, a sale or a transfer
    const left = dev.soldSincePct;
    const side = sideWallets(links, f.wallets.find((w) => w.role === "dev")?.wallet ?? null);
    const majority = (dev.firstBuysPct ?? 0) >= DEV_MAJORITY_PCT;
    out.dev = {
      level: holds !== null ? devLevel(holds, left, side, dev.firstBuysPct) : majority ? "danger" : null,
      words: `dev bought ${dev.firstBuysPct !== null ? p1(dev.firstBuysPct) : "?"}${majority ? " (most of the supply from one hand)" : ""}, holds ${holds !== null ? p1(holds) : "?"}${left ? `, ${p1(left)} left its wallet (sold or moved)` : ""}${sideWords(left, side)}`,
      holdsPct: holds,
      wallets: 1,
      leftPct: left,
      side,
      boughtPct: dev.firstBuysPct,
      soldPct: left,
    };
  }
  const bundle = f.roles.bundle;
  if (bundle) {
    out.bundle = {
      level: bundle.holdsNowPct !== null ? byShare(bundle.holdsNowPct, S.bundleDangerPct, S.bundleWarnPct) : null,
      words: `bundle ${bundle.wallets} wallets ${bundle.firstBuysPct !== null ? p1(bundle.firstBuysPct) : "?"}, holds ${bundle.holdsNowPct !== null ? p1(bundle.holdsNowPct) : "?"}`,
      holdsPct: bundle.holdsNowPct,
      wallets: bundle.wallets,
      boughtPct: bundle.firstBuysPct,
      soldPct: bundle.soldSincePct,
    };
  }
  // a screen (the first page alone) or a read cut short saw the snipers of its first seconds only: their count is a
  // floor, never a clean read; the dev and the creation block's bundle are whole on the first page
  const seen = num(d?.seconds_read);
  const window = num(d?.window_seconds);
  const partial = seen !== null && window !== null && seen < window;
  out.seen = partial ? Math.max(1, Math.round(seen!)) : null;
  const snipers = f.roles.sniper;
  if (snipers) {
    const heavy = snipers.holdsNowPct !== null && snipers.holdsNowPct >= S.sniperWarnPct;
    out.snipers = {
      level: snipers.holdsNowPct !== null && (heavy || !partial) ? (heavy ? "warn" : "ok") : null,
      words: `${partial ? `snipers in its first ${out.seen} s (at least)` : "snipers"} ${snipers.wallets} hold ${snipers.holdsNowPct !== null ? p1(snipers.holdsNowPct) : "?"}`,
      holdsPct: snipers.holdsNowPct,
      wallets: snipers.wallets,
    };
  } else if (partial) out.snipers = { level: null, words: `snipers: none in its first ${out.seen} s read, the rest of its minute unread`, holdsPct: null, wallets: 0 };
  return out;
}

/** What left an insider's wallets since launch that says it sells: this share of supply, or this part of what it bought */
const INSIDERS_SELLING_PCT = 2;
const INSIDERS_SELLING_PART = 0.25;

/**
 * Whether a launch's insiders at a danger share (the dev, its side wallets counted, or the bundle) are selling or
 * holding: selling when what left their wallets since launch is INSIDERS_SELLING_PCT of supply or INSIDERS_SELLING_PART
 * of what they bought; holding otherwise. A coin whose insiders hold is a cabal coin (they push it high early), one
 * whose insiders sell is a dump into its buyers. Null when no insider is at a danger share or the read says nothing of
 * selling.
 */
function insidersOf(p: LaunchParts | null): "holding" | "selling" | null {
  if (!p) return null;
  const big = [p.dev, p.bundle].filter((r): r is LaunchPart => r !== null && r.level === "danger");
  if (big.length === 0) return null;
  // what left an insider's wallets less what its side wallets still hold (moved to them is held, not sold)
  const sold = (r: LaunchPart) => Math.max(0, (r.soldPct ?? 0) - ("side" in r && (r as DevRead).side ? (r as DevRead).side!.pct : 0));
  const sells = (r: LaunchPart) => sold(r) >= INSIDERS_SELLING_PCT || (r.boughtPct ? sold(r) >= r.boughtPct * INSIDERS_SELLING_PART : false);
  if (big.some(sells)) return "selling";
  return big.some((r) => r.soldPct !== null && r.soldPct !== undefined) ? "holding" : null;
}

/** The launch: the dev, the creation slot's bundle, the first-minute snipers, and what each still holds (sol_launch; launchParts) */
export function launchOf(d: Record<string, unknown> | null, links: Record<string, unknown> | null = null): Leveled | null {
  const p = launchParts(d, links);
  const roles = p ? [p.dev, p.bundle, p.snipers].filter((r) => r !== null) : [];
  if (!p || roles.length === 0) return null;
  const insiders = insidersOf(p);
  const words = [
    ...roles.map((r) => r.words),
    ...(p.seen !== null ? [`its first ${p.seen} s read`] : []),
    ...(insiders === "holding" ? ["insiders holding, not selling: a cabal coin"] : insiders === "selling" ? ["insiders selling since launch"] : []),
  ];
  return { level: worst(roles.flatMap((r) => (r.level ? [r.level] : []))), words: words.join("; ") };
}

/** The creator read (sol_token_origin) as facts: who made the coin, what it got at creation and holds now; null when not found */
function creatorOf(d: Record<string, unknown> | null): { creator: string | null; gotPct: number | null; holdsPct: number | null } | null {
  if (!d || d.found === false) return null;
  const got = isObj(d.creator_got_at_creation) ? num(d.creator_got_at_creation.share_pct) : null;
  const holds = isObj(d.creator_holds_now) ? num(d.creator_holds_now.share_pct) : null;
  if (got === null && holds === null) return null;
  return { creator: typeof d.creator === "string" ? d.creator : null, gotPct: got, holdsPct: holds };
}

/** The dev as the creator read gives it (creatorOf, or the scan's dev), with the side wallets it sent tokens to, on the dev scale */
export function creatorRead(c: { gotPct: number | null; holdsPct: number | null }, side: SideWallets | null): DevRead {
  const { gotPct: got, holdsPct: holds } = c;
  const left = got !== null && holds !== null && got > holds ? got - holds : null;
  const majority = (got ?? 0) >= DEV_MAJORITY_PCT;
  const words = `dev got ${got !== null ? p1(got) : "?"} at creation${majority ? " (most of the supply from one hand)" : ""}, holds ${holds !== null ? p1(holds) : "?"} now${left ? `, ${p1(left)} left its wallet (sold or moved)` : ""}${sideWords(left, side)}`;
  return { level: holds === null ? (majority ? "danger" : null) : devLevel(holds, left, side, got), words, holdsPct: holds, wallets: 1, leftPct: left, side, boughtPct: got, soldPct: left };
}

/**
 * The dev from the creator read (sol_token_origin) when the launch read is down: what the creator got at creation and
 * holds now, with the top holders it sent tokens to (`links`), its level by the dev's share
 */
export function devOf(d: Record<string, unknown> | null, links: Record<string, unknown> | null = null): Leveled | null {
  const c = creatorOf(d);
  const r = c ? creatorRead(c, sideWallets(links, c.creator)) : null;
  return r ? { level: r.level ?? "note", words: r.words } : null;
}

/**
 * The dev's wallet when its launch bag left it (SEVERITY.devWarnPct of supply or more), from the launch read (sol_launch:
 * the dev its first buyer) or the creator read (sol_token_origin): whose money trail the dossier reads (scan.ts devTrail).
 * Null for a dev still holding its bag, or none named
 */
export function devGone(read: "launch" | "origin", d: Record<string, unknown> | null): string | null {
  if (read === "launch") {
    const f = launchFacts(d);
    const left = f?.roles.dev?.soldSincePct ?? null;
    const wallet = f?.wallets.find((w) => w.role === "dev")?.wallet ?? null;
    return wallet && left !== null && left >= S.devWarnPct ? wallet : null;
  }
  const c = creatorOf(d);
  const left = c && c.gotPct !== null && c.holdsPct !== null ? c.gotPct - c.holdsPct : null;
  return c?.creator && left !== null && left >= S.devWarnPct ? c.creator : null;
}

/**
 * Where the dev's bag went, from its money trail (sol_money_trail on the dev, read by code when its bag left: scan.ts
 * devTrail): of the coin it moved, the share into pools or its curve (a sale), to an exchange and to wallets (those among
 * the top holders with what they hold now, `links`), the SOL it got back from pools and where its SOL went. What went to
 * wallets outside the top holders, as a share of supply (`leftPct`: what left the dev's wallet), is a warning at the dev's
 * warning share: a split bag or side wallets, where it sits now unread (`value`: the token card's words); else context.
 * Null when its transactions read moved none of the coin
 */
export function devTrailOf(trail: Record<string, unknown> | null, mint: string, leftPct: number | null, links: Record<string, unknown> | null): (Leveled & { value: string }) | null {
  if (!trail) return null;
  const rows = (key: "outgoing" | "incoming") => (Array.isArray(trail[key]) ? (trail[key] as unknown[]).filter(isObj) : []);
  const kind = (r: Record<string, unknown>) => (typeof r.counterparty === "string" ? r.counterparty : "wallet");
  const sale = (r: Record<string, unknown>) => kind(r) === "pool" || kind(r) === "program";
  const amount = (rs: Record<string, unknown>[]) => rs.reduce((t, r) => t + (num(r.amount) ?? 0), 0);
  const coin = rows("outgoing").filter((r) => r.mint === mint && (num(r.amount) ?? 0) > 0);
  const total = amount(coin);
  if (!total) return null;
  const share = (rs: Record<string, unknown>[]) => amount(rs) / total;
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const exchange = (rs: Record<string, unknown>[]) => [...new Set(rs.map((r) => (typeof r.label === "string" ? r.label : null)).filter((x): x is string => !!x))].slice(0, 2).join(", ");
  const top = new Map((linkFacts(links)?.holders ?? []).map((h) => [h.owner, h.sharePct ?? 0]));
  const sold = coin.filter(sale);
  const cex = coin.filter((r) => kind(r) === "exchange");
  const wallets = coin.filter((r) => !sale(r) && kind(r) !== "exchange");
  const held = wallets.filter((r) => top.has(String(r.to)));
  const loose = wallets.filter((r) => !top.has(String(r.to)));
  // its SOL back from pools: a move into a pool is a sale only when SOL came back; with none it is liquidity it placed
  // or a lock, still its own
  const back = amount(rows("incoming").filter((r) => r.asset === "SOL" && sale(r)));
  const parts: string[] = [];
  if (sold.length) parts.push(back > 0 ? `${pc(share(sold))} of what it moved into pools or its curve (sold)` : `${pc(share(sold))} of what it moved into a pool's or a program's account with no SOL back (liquidity it placed or a lock: still its own, a sale not read)`);
  if (cex.length) parts.push(`${pc(share(cex))} to an exchange${exchange(cex) ? ` (${exchange(cex)})` : ""}`);
  if (wallets.length) {
    const theirs = held.reduce((t, r) => t + top.get(String(r.to))!, 0);
    parts.push(`${pc(share(wallets))} to ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}${held.length ? ` (${held.length} of them top holders, holding ${p1(theirs)} now)` : ", none of them a top holder now"}`);
  }
  // its SOL: back from pools (what the sale paid), and on to exchanges
  const cashed = rows("outgoing").filter((r) => r.asset === "SOL" && kind(r) === "exchange");
  const sol = (x: number) => `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10} SOL`;
  if (back > 0) parts.push(`${sol(back)} back from pools`);
  if (amount(cashed) > 0) parts.push(`${sol(amount(cashed))} sent to an exchange${exchange(cashed) ? ` (${exchange(cashed)})` : ""}`);
  const read = num(trail.transactions_read);
  const span = `${read ?? "?"} of its transactions read${trail.complete === false ? " (cut short)" : ""}`;
  // what is still the dev's out of sight: sent to wallets outside the top holders, or placed in a pool's or a program's
  // account with nothing back; at the dev's warning share it is a warning
  const placed = sold.length && back === 0 ? sold : [];
  const out = leftPct !== null && loose.length ? leftPct * share(loose) : null;
  const parked = leftPct !== null && placed.length ? leftPct * share(placed) : null;
  const level: Severity = Math.max(out ?? 0, parked ?? 0) >= S.devWarnPct ? "warn" : "note";
  const value = (out ?? 0) >= (parked ?? 0) ? (out !== null ? `${p1(out)} of supply sent to ${loose.length} wallet${loose.length === 1 ? "" : "s"} outside the top holders` : "") : `${p1(parked!)} of supply placed in a pool's or a program's account, nothing back`;
  return { level, words: `${span}: ${parts.join("; ")}`, value };
}

/** The largest tied cluster of the top holders (sol_holder_links): its share, wallets and funders, on the cluster scale; null when the links were not read */
export function clusterOf(links: Record<string, unknown> | null): (Leveled & { sharePct: number | null; wallets: number; funders: number }) | null {
  const l = linkFacts(links);
  if (!l) return null;
  const big = [...l.clusters].sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0))[0];
  // a map cut short that found no cluster says how far it read, never "no tied cluster"
  if (!big || !(big.sharePct ?? 0))
    return links?.complete === false
      ? { level: "note", words: `no tied cluster in the ${num(links.transactions_read) ?? 0} transactions read, the rest unread`, sharePct: null, wallets: 0, funders: 0 }
      : { level: "ok", words: "no tied cluster in the top holders", sharePct: null, wallets: 0, funders: 0 };
  const funders = big.funders.length;
  // a map cut short that found a small cluster says how far it read too, and clears nothing
  const cut = links?.complete === false;
  const level = byShare(big.sharePct!, S.clusterDangerPct, S.clusterWarnPct);
  return {
    level: cut && level === "ok" ? "note" : level,
    words: `largest cluster ${p1(big.sharePct!)} (${big.wallets} wallets${funders ? `, ${funders} shared funder${funders === 1 ? "" : "s"}` : ""})${cut ? ` in the ${num(links.transactions_read) ?? 0} transactions read, the rest unread` : ""}`,
    sharePct: big.sharePct,
    wallets: big.wallets,
    funders,
  };
}

const short = (a: string): string => `${a.slice(0, 6)}…`;

/**
 * A cabal spread thin past the top holders (sol_holder_spread): the band of 0.1-1% wallets and who made its sample, on
 * the spread scale (SEVERITY.spreadBandPct…): `cabal` at its warning (its hands dump at once or pump it). Null when it
 * was not read, or no band wallet was
 */
export function spreadOf(d: Record<string, unknown> | null): (Leveled & { cabal: boolean; bandPct: number; wallets: number }) | null {
  const band = isObj(d?.band) ? d!.band : null;
  const sample = isObj(d?.sample) ? d!.sample : null;
  const bandPct = num(band?.share_pct);
  const wallets = num(band?.wallets) ?? 0;
  if (!band || bandPct === null || wallets === 0) return null;
  const read = num(sample?.read) ?? 0;
  const fresh = num(sample?.fresh) ?? 0;
  const top = Array.isArray(sample?.funders) ? sample!.funders.filter(isObj)[0] : undefined;
  const funded = num(top?.wallets) ?? 0;
  const funder = typeof top?.address === "string" ? top.address : null;
  const head = `${p1(bandPct)} of supply in ${wallets} wallets of 0.1-1% each`;
  if (read < S.spreadMinSample) return { level: "note", words: `${head}; ${read} of them read, too few to say who made them`, cabal: false, bandPct, wallets };
  const made = [`of ${read} sampled ${fresh} fresh`, ...(funded >= 2 && funder ? [`${funded} sent their first SOL by one wallet (${short(funder)})`] : [])].join(", ");
  const tied = funded >= S.spreadFunderWallets || (fresh / read) * 100 >= S.spreadFreshPct;
  const level: Severity = tied && bandPct >= S.spreadBandPct ? "warn" : tied && bandPct >= S.spreadNoteBandPct ? "note" : "ok";
  const cabal = level === "warn";
  return { level, words: `${cabal ? "a cabal spread thin (it dumps at once or pumps the coin): " : ""}${head}; ${made}`, cabal, bandPct, wallets };
}

/**
 * The holders: the top 10 without pools, the largest tied cluster and its funders (sol_holder_links, token_risk_flags),
 * and past the top a cabal spread thin (sol_holder_spread, `spread`). `old`: an old, large coin (SEVERITY.matureDays,
 * matureCapUsd), whose top 10 at the danger share is a warning, as on the token card (its big wallets are mostly
 * exchanges, team or treasury)
 */
export function holdersOf(links: Record<string, unknown> | null, risk: Record<string, unknown> | null, old = false, spread: Record<string, unknown> | null = null): Leveled | null {
  const top10 = num(risk?.top10_holders_pct);
  const parts: string[] = [];
  const levels: Severity[] = [];
  if (top10 !== null) {
    parts.push(`top 10 ${p1(top10)}`);
    const level = byShare(top10, S.top10DangerPct, S.top10WarnPct);
    levels.push(old && level === "danger" ? "warn" : level);
  }
  const cluster = clusterOf(links);
  if (cluster) {
    parts.push(cluster.words);
    levels.push(cluster.level);
  }
  // the insider wallets RugCheck detects (its graph), else those it marks among the top holders
  const insiders = num(risk?.insider_wallets_detected) ?? num(risk?.insiders_in_top_holders);
  if (insiders !== null && insiders > 0) {
    parts.push(`${insiders} insider wallet${insiders === 1 ? "" : "s"} (rugcheck)`);
    levels.push("warn");
  }
  // an old, large coin's band is its market, never a bundle
  const thin = old ? null : spreadOf(spread);
  if (thin) {
    parts.push(thin.words);
    levels.push(thin.level);
  }
  return parts.length ? { level: worst(levels), words: parts.join(", ") } : null;
}

/**
 * Words that tie a coin's story to a meta: whole words of 3 letters or more, a plural as its singular ("cats" is
 * "cat"), none of those every label shares
 */
const STORY_STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "about", "its", "his", "her", "their", "your", "our", "new", "one", "all", "who", "you", "coin", "token", "meme", "memecoin", "other", "solana", "pump", "community", "based", "themed", "style"]);
const storyWords = (s: string): string[] =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => w.length >= 3 && !STORY_STOP.has(w));

/**
 * The story: the narrative index's label of the coin, what it copies, organic or farmed (meme_narrative); a live meta
 * when its narrative or tags share a word with one of today's narratives or the last day's metas, else its group running
 * today when it is the busiest group or one with runners (a group alone is no meta: the busiest groups hold most coins)
 */
export function storyOf(d: Record<string, unknown> | null, metas: TodaysMetas): (Leveled & { copied: boolean; farmed: boolean }) | null {
  if (!d || d.tracked === false) return null;
  const n = isObj(d.narrative) ? d.narrative : null;
  const label = typeof n?.narrative === "string" ? n.narrative : null;
  if (!label) return null;
  const group = typeof n?.group === "string" ? n.group : null;
  const copy = typeof n?.copycat_of === "string" && n.copycat_of ? n.copycat_of : null;
  const flags = Array.isArray(d.flags) ? d.flags.filter((x): x is string => typeof x === "string") : [];
  const farmed = flags.some((f) => /farm|ladder|rig/.test(f)) || n?.legitimacy === "farmed";
  const tags = Array.isArray(n?.tags) ? n!.tags.filter((t): t is string => typeof t === "string") : [];
  const mine = new Set(storyWords([label, ...tags].join(" ")));
  const meta = metas.narratives.find((m) => storyWords(m).some((w) => mine.has(w))) ?? null;
  const groupRuns = !meta && group !== null && metas.groups.includes(group.toLowerCase());
  const live = meta === null ? null : meta === label.toLowerCase() ? "a live meta today" : `a live meta today ("${meta}")`;
  const parts = [`"${label}"${group ? ` (${group})` : ""}`, live ?? (groupRuns ? "its group runs today" : null), copy ? `copies ${copy}` : null, farmed ? "farmed" : null].filter(Boolean);
  return { level: copy || farmed ? "warn" : "ok", words: parts.join(", "), copied: copy !== null, farmed };
}

/**
 * Today's metas (meme_metas), lower case: the narratives migrating in the last 24 h and the last closed day's metas, by
 * name; and the groups running, the busiest by 24 h volume and those with runners, never "other" (the index's catch-all)
 */
export interface TodaysMetas {
  narratives: string[];
  groups: string[];
}

/** Today's metas from meme_metas' answer (its groups come the busiest first) */
export function metaWords(d: Record<string, unknown> | null): TodaysMetas {
  const narratives: string[] = [];
  const groups: string[] = [];
  (Array.isArray(d?.groups) ? (d!.groups as unknown[]) : []).filter(isObj).forEach((g, i) => {
    const name = typeof g.group === "string" ? g.group.toLowerCase() : null;
    if (name && name !== "other" && (i === 0 || (num(g.runners) ?? 0) > 0)) groups.push(name);
    for (const n of Array.isArray(g.narratives) ? g.narratives : []) if (isObj(n) && typeof n.narrative === "string") narratives.push(n.narrative.toLowerCase());
  });
  const day = isObj(d?.last_day) ? d!.last_day : null;
  for (const m of Array.isArray(day?.metas) ? (day!.metas as unknown[]) : []) if (isObj(m) && typeof m.meta === "string") narratives.push(m.meta.toLowerCase());
  return { narratives: [...new Set(narratives)].slice(0, 30), groups: [...new Set(groups)] };
}

/** Today's metas as a dossier says them: the narratives first (the stories), then the groups running; "" for none */
export function metaText(m: TodaysMetas, max = 12): string {
  const groups = m.groups.length ? `groups running: ${m.groups.join(", ")}` : "";
  return [m.narratives.slice(0, max).join("; "), groups].filter(Boolean).join("; ");
}

const kOf = (n: number): string => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}m` : n >= 1_000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n)));
const agoOf = (iso: unknown, now: number): string | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, (now - t) / 60_000);
  return m < 60 ? `${Math.round(m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/**
 * Who on crypto twitter called the coin (ct_calls of its mint, the CT radar): how many accounts, their reach, the first
 * call and how long ago, the last; context, never a level (a call is its author's claim, and calls can be paid). Null for
 * no calls read.
 */
export function callsOf(d: Record<string, unknown> | null, now: number): string | null {
  if (!d) return null;
  const callers = num(d.callers);
  if (!callers) return null;
  const first = isObj(d.first_call) ? d.first_call : null;
  const firstWho = first && typeof first.handle === "string" ? `@${first.handle}${num(first.followers) ? ` (${kOf(num(first.followers)!)})` : ""}` : null;
  const firstAgo = first ? agoOf(first.at, now) : null;
  const lastAgo = agoOf(d.last_call_at, now);
  const reach = num(d.reach);
  return `called by ${callers} account${callers === 1 ? "" : "s"}${reach ? `, reach ${kOf(reach)}` : ""}${firstWho ? `, first ${firstWho}${firstAgo ? ` ${firstAgo}` : ""}` : ""}${lastAgo && callers > 1 ? `, last ${lastAgo}` : ""}`;
}

/** The X radar's run is said with its age once this old (it runs once a day) */
const IDEAS_STALE_MS = 20 * 3_600_000;

/**
 * The ideas on x the coin rides (x_ideas by its ticker, the X radar): each idea's name, stage, reach and age, the run's
 * own age first once it is IDEAS_STALE_MS old; context, never a level. Null for none.
 */
export function ideasOf(d: Record<string, unknown> | null, now = Date.now()): string | null {
  const ideas = d && Array.isArray(d.ideas) ? d.ideas.filter(isObj) : [];
  if (!ideas.length) return null;
  const ran = isObj(d!.window) && typeof d!.window.to === "string" ? Date.parse(d!.window.to) : NaN;
  const stale = Number.isFinite(ran) && now - ran >= IDEAS_STALE_MS ? `from the radar's run of ${Math.round((now - ran) / 3_600_000)} h ago: ` : "";
  return stale + ideas
    .slice(0, 2)
    .map((i) => {
      const views = num(i.views);
      const age = num(i.age_h_at_run);
      return `"${String(i.idea ?? i.key ?? "an idea").slice(0, 60)}" (${String(i.stage ?? "stage unknown")}${views ? `, ${kOf(views)} views` : ""}${age !== null ? `, ${Math.round(age)} h old at the radar's run` : ""})`;
    })
    .join("; ");
}
