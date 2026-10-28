// Token unlock schedules from DefiLlama's public datasets (defillama-datasets.llama.fi, no key): a token's unlock
// events, past and upcoming, the linear streams still running and what is still to unlock, by project name, ticker or
// contract address. Sources: the token's unlocks page on defillama.com.

import { llamaUnlocks, src, uniqueSources } from "../links.ts";
import { MB } from "../http.ts";
import { limitParam, QUERY } from "../schema.ts";
import { HOUR, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { Dataset, isObj, num, round, slugify, str, take, type FreeContext } from "./common.ts";

export const DATASETS_HOST = "defillama-datasets.llama.fi";
const DATASETS = `https://${DATASETS_HOST}`;
const DAY_S = 86_400;
const WEEK_S = 7 * DAY_S;
/** A dataset's slug (some hold a dot: ether.fi) */
const SLUG = /^[a-z0-9][a-z0-9.-]{0,150}$/;
/**
 * A word DefiLlama adds to a project's name, in a protocol's slug or its dataset's (kamino-finance, near-protocol,
 * blast-l2, binance-smart-chain); a name that runs on in other words is another project's (world-of-dypians)
 */
const SUFFIX = /-(?:finance|protocol|network|labs|dao|exchange|lend|chain|token|bridge|dex|l2|mainnet|orderbook|staking|ecosystem|era)$/;

/**
 * What DefiLlama's lists say of a name, ticker or contract address (defillama.ts): the slugs of the protocols (each by
 * its parent's first) and chains that go by it, best first, and their CoinGecko ids
 */
export interface UnlockNames {
  slugs: string[];
  gecko: string[];
}
export type UnlockSlugs = (q: string, signal: AbortSignal) => Promise<UnlockNames>;

interface Allocation {
  to: string | null;
  category: string | null;
  tokens: number;
}

/** A linear stream's rate from this event on (0: it stops) */
interface Stream {
  to: string | null;
  category: string | null;
  perWeek: number;
  /** Unix seconds; null when the data gives no end */
  until: number | null;
  /**
   * `until` ends only this segment (a linear_rate_change: DefiLlama cuts a stream into monthly segments, and a rate
   * that stays the same gets no later event), so the rate runs on until the recipient's next event
   */
  segment: boolean;
}

/** One UTC day's unlocks: its cliffs and the streams whose rate changes then */
export interface UnlockEvent {
  t: number;
  cliffs: Allocation[];
  streams: Stream[];
}

const who = (a: Record<string, unknown>, to: unknown) => ({ to: str(to, 60), category: str(a.category, 30) });

/** The dataset's own list of unlock dates (its metadata.unlockEvents), one per entry */
function fromUnlockEvents(list: unknown[]): UnlockEvent[] {
  return list.filter(isObj).flatMap((e): UnlockEvent[] => {
    const t = num(e.timestamp);
    if (t === null) return [];
    const cliffs = (Array.isArray(e.cliffAllocations) ? e.cliffAllocations : []).filter(isObj).flatMap((a): Allocation[] => {
      const tokens = num(a.amount);
      return tokens !== null && tokens > 0 ? [{ ...who(a, a.recipient), tokens }] : [];
    });
    const streams = (Array.isArray(e.linearAllocations) ? e.linearAllocations : []).filter(isObj).flatMap((a): Stream[] => {
      const perWeek = num(a.newRatePerWeek);
      const segment = a.unlockType === "linear_rate_change";
      return perWeek !== null && perWeek >= 0 ? [{ ...who(a, a.recipient), perWeek, until: num(a.endTimestamp), segment }] : [];
    });
    return [{ t, cliffs, streams }];
  });
}

/**
 * Who gets an older dataset's event, from its sentence: "A cliff of {tokens[0]} tokens was unlocked from Team on
 * {timestamp}", "Linear unlock was increased from {tokens[0]} to {tokens[1]} tokens per week from Foundation on
 * {timestamp}", "On {timestamp} {tokens[0]} of Investors tokens were unlocked" (or "will be unlocked"); a name never
 * spans a placeholder
 */
const RECIPIENT = [/ from ([^{}]+?) on \{timestamp\}/, /\} of ([^{}]+?) tokens (?:were|will be) unlocked/];
const recipientOf = (d: unknown): string | null => {
  for (const re of RECIPIENT) {
    const m = typeof d === "string" ? re.exec(d) : null;
    if (m) return m[1]!;
  }
  return null;
};

/** An older dataset's events (metadata.events: one row per allocation and date) */
function fromEvents(list: unknown[]): UnlockEvent[] {
  return list.filter(isObj).flatMap((e): UnlockEvent[] => {
    const t = num(e.timestamp);
    const n = Array.isArray(e.noOfTokens) ? e.noOfTokens.map(num) : [];
    if (t === null || n.length === 0) return [];
    const to = who(e, recipientOf(e.description));
    if (e.unlockType === "linear") {
      // "increased from {tokens[0]} to {tokens[1]} tokens per week" for rateDurationDays
      const perWeek = n[n.length - 1] ?? null;
      const days = num(e.rateDurationDays);
      const until = days !== null ? t + days * DAY_S : null;
      return perWeek !== null && perWeek >= 0 ? [{ t, cliffs: [], streams: [{ ...to, perWeek, until, segment: false }] }] : [];
    }
    return n[0] !== null && n[0]! > 0 ? [{ t, cliffs: [{ ...to, tokens: n[0]! }], streams: [] }] : [];
  });
}

/** Entries merged by UTC day at the day's first hour, oldest first: a date is one unlock */
function byDay(list: UnlockEvent[]): UnlockEvent[] {
  const days = new Map<number, UnlockEvent>();
  for (const e of [...list].sort((a, b) => a.t - b.t)) {
    if (!e.cliffs.length && !e.streams.length) continue;
    const d = Math.floor(e.t / DAY_S);
    const had = days.get(d);
    if (!had) days.set(d, { t: e.t, cliffs: [...e.cliffs], streams: [...e.streams] });
    else {
      had.cliffs.push(...e.cliffs);
      had.streams.push(...e.streams);
    }
  }
  return [...days.values()];
}

/** A dataset's unlock dates, oldest first: its unlockEvents, else its older events list */
export function unlockEvents(meta: Record<string, unknown>): UnlockEvent[] {
  const own = Array.isArray(meta.unlockEvents) ? byDay(fromUnlockEvents(meta.unlockEvents)) : [];
  return own.length ? own : Array.isArray(meta.events) ? byDay(fromEvents(meta.events)) : [];
}

/**
 * The streams still unlocking at `nowS` by the events alone (a dataset with no daily curve): each recipient's latest
 * rate up to then, above 0, and not ended; a segment's end is not the stream's, so it runs on with no end known
 */
function streamsAt(events: UnlockEvent[], nowS: number): Stream[] {
  const last = new Map<string, Stream>();
  for (const e of events) if (e.t <= nowS) for (const s of e.streams) last.set(`${s.to ?? ""}|${s.category ?? ""}`, s);
  return [...last.values()].flatMap((s) => {
    if (s.perWeek <= 0) return [];
    if (s.until === null || s.until > nowS) return [s];
    return s.segment ? [{ ...s, until: null }] : [];
  });
}

/** A recipient's tokens unlocked to date by the dataset's daily curve (documentedData: points at 00:00 UTC) */
interface Curve {
  to: string;
  points: { t: number; v: number }[];
}

function curves(raw: Record<string, unknown>): Curve[] {
  const doc = isObj(raw.documentedData) ? raw.documentedData : {};
  return (Array.isArray(doc.data) ? doc.data : []).filter(isObj).flatMap((s): Curve[] => {
    const to = str(s.label, 60);
    const points = (Array.isArray(s.data) ? s.data : []).filter(isObj).flatMap((p) => {
      const t = num(p.timestamp);
      const v = num(p.unlocked);
      return t !== null && v !== null ? [{ t, v }] : [];
    });
    return to && points.length ? [{ to, points: points.sort((a, b) => a.t - b.t) }] : [];
  });
}

const grows = (from: number, to: number) => to - from > Math.abs(from) * 1e-9;

/** What a recipient's curve says at `nowS`: its rate, what it has still to unlock, its last day, null when none is set */
interface CurveNow {
  to: string;
  perWeek: number;
  left: number;
  until: number | null;
}

/**
 * A curve read at `nowS`. The rate is the median of its per-day steps through the coming week, so a cliff's one-day
 * jump in it is no stream (ARB's monthly cliffs); it still unlocks until the last day it grows, and when it grows into
 * its last point about today (DefiLlama extends an emission with no end daily) no end is set and what is left is unknown
 */
function curveAt(c: Curve, nowS: number): CurveNow {
  const pts = c.points;
  const i = pts.findLastIndex((p) => p.t <= nowS);
  const at = i >= 0 ? pts[i]!.v : 0;
  const week = pts.slice(Math.max(i, 0)).filter((p) => p.t <= nowS + WEEK_S);
  const perDay = week.slice(1).map((p, k) => (p.v - week[k]!.v) / ((p.t - week[k]!.t) / DAY_S)).sort((a, b) => a - b);
  const end = pts[pts.length - 1]!;
  const rate = perDay.length ? perDay[Math.floor((perDay.length - 1) / 2)]! * 7 : 0;
  const k = pts.findLastIndex((p, j) => j > 0 && grows(pts[j - 1]!.v, p.v));
  const open = k === pts.length - 1 && end.t <= nowS + WEEK_S;
  return {
    to: c.to,
    perWeek: rate > Math.abs(end.v) * 1e-9 ? rate : 0,
    left: !open && grows(at, end.v) ? end.v - at : 0,
    until: open || k < 0 ? null : pts[k]!.t,
  };
}

const day = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10);
const share = (tokens: number, supply: number | null): number | null => (supply ? round((tokens / supply) * 100, 3) : null);
const streamRow = (s: { to: string | null; category: string | null; perWeek: number; until: number | null }) => ({
  to: s.to,
  category: s.category,
  tokens_per_week: round(s.perWeek),
  until: s.until !== null ? day(s.until) : null,
});

function cliffRow(e: UnlockEvent, supply: number | null): Record<string, unknown> {
  const tokens = e.cliffs.reduce((t, a) => t + a.tokens, 0);
  return {
    date: day(e.t),
    tokens: round(tokens),
    pct_of_supply: share(tokens, supply),
    allocations: e.cliffs.map((a) => ({ to: a.to, category: a.category, tokens: round(a.tokens) })),
  };
}

/**
 * What the model reads of one dataset at `nowMs`: the next cliff unlock, the upcoming and the latest past cliff dates
 * (`limit` each), the streams running now and what is still to unlock (from the dataset's daily curve when it has one:
 * its events miss a stream that runs on at the same rate), upcoming rate changes apart, max supply and what has no set
 * schedule; a plain note when no cliff, or nothing scheduled at all, remains
 */
export function unlockSchedule(raw: Record<string, unknown>, slug: string, nowMs: number, limit: number): Record<string, unknown> {
  const meta = isObj(raw.metadata) ? raw.metadata : {};
  const metrics = isObj(raw.supplyMetrics) ? raw.supplyMetrics : {};
  const nowS = nowMs / 1000;
  const events = unlockEvents(meta);
  const documented = curves(raw);
  const read = documented.map((c) => curveAt(c, nowS));
  // a dataset with no max supply (sui's) is shared out by its curves' ends
  const supply = num(metrics.maxSupply) ?? num(meta.total) ?? (documented.length ? documented.reduce((t, c) => t + c.points[c.points.length - 1]!.v, 0) : null);
  const tbd = num(metrics.tbdAmount);
  const unscheduled = tbd !== null && tbd > 0 ? tbd : null;
  const cliffs = events.filter((e) => e.cliffs.length);
  const past = cliffs.filter((e) => e.t <= nowS);
  const upcoming = cliffs.filter((e) => e.t > nowS);
  const changes = events.filter((e) => e.t > nowS && e.streams.length).slice(0, limit);
  const categoryOf = new Map(events.flatMap((e) => [...e.cliffs, ...e.streams]).map((a) => [a.to, a.category]));
  const streaming = read.length
    ? read.filter((c) => c.perWeek > 0).map((c) => streamRow({ ...c, category: categoryOf.get(c.to) ?? null }))
    : streamsAt(events, nowS).map(streamRow);
  const leftRows = read.filter((c) => c.left > 0).sort((a, b) => b.left - a.left);
  const left = leftRows.reduce((t, c) => t + c.left, 0);
  const next = upcoming[0] ?? null;
  const last = past[past.length - 1] ?? null;
  const lastSaid = last ? `: the last unlock was on ${day(last.t)}` : "";
  const leftSaid = streaming.length
    ? `; ${streaming.length} linear stream${streaming.length === 1 ? " still unlocks" : "s still unlock"} (streaming_now)`
    : left > 0
      ? `; ${Math.round(left)} tokens are still to unlock (still_to_unlock)`
      : "";
  const tbdPct = unscheduled !== null ? share(unscheduled, supply) : null;
  const tbdSaid = unscheduled !== null ? `; ${Math.round(unscheduled)} tokens${tbdPct !== null ? ` (${tbdPct}% of max supply)` : ""} have no set schedule` : "";
  const note = next ? null : `${leftSaid ? "no cliff unlocks remain" : "no scheduled unlocks remain"}${lastSaid}${leftSaid}${tbdSaid}`;
  // the dataset's own notes say what its events do not (JUP's: burns, a paused team reserve, emissions voted to zero);
  // who supplied the data is not one
  const notes = (Array.isArray(meta.notes) ? meta.notes : [])
    .map((n) => str(n, 400))
    .filter((n): n is string => n !== null && !/^data (is )?provided by\b/i.test(n))
    .slice(0, 5);
  return {
    name: str(raw.name) ?? slug,
    slug,
    token: str(meta.token, 120),
    max_supply: round(supply),
    ...(unscheduled !== null ? { unscheduled_tokens: round(unscheduled), unscheduled_pct: tbdPct } : {}),
    // in calendar days (UTC), as its date reads: the 15th is 3 days from the 12th at any hour
    next_unlock: next ? { ...cliffRow(next, supply), days_away: Math.floor(next.t / DAY_S) - Math.floor(nowS / DAY_S) } : null,
    upcoming_count: upcoming.length,
    upcoming: upcoming.slice(0, limit).map((e) => cliffRow(e, supply)),
    streaming_now: streaming,
    ...(left > 0
      ? {
          still_to_unlock: {
            tokens: round(left),
            pct_of_supply: share(left, supply),
            until: day(Math.max(...leftRows.map((c) => c.until ?? 0))),
            by_recipient: leftRows.map((c) => ({ to: c.to, tokens: round(c.left), pct_of_supply: share(c.left, supply) })),
          },
        }
      : {}),
    ...(changes.length ? { upcoming_rate_changes: changes.flatMap((e) => e.streams.map((s) => ({ date: day(e.t), to: s.to, tokens_per_week: round(s.perWeek) }))) } : {}),
    past_count: past.length,
    past: past.slice(-limit).map((e) => cliffRow(e, supply)),
    ...(note ? { note } : {}),
    ...(notes.length ? { notes } : {}),
    link: llamaUnlocks(slug),
  };
}

/**
 * A listed dataset filed under a slug with a suffix: "<slug>-foundation", else (`any`) the only "<slug>-…" ending in a
 * word DefiLlama adds (near → near-protocol)
 */
function filedUnder(list: Set<string>, slug: string, any: boolean): string | null {
  if (list.has(`${slug}-foundation`)) return `${slug}-foundation`;
  const more = any ? [...list].filter((s) => s.startsWith(`${slug}-`) && SUFFIX.test(s)) : [];
  return more.length === 1 ? more[0]! : null;
}

/**
 * How DefiLlama may file a project by a slug or CoinGecko id of its own: its first part (kamino-lend → kamino,
 * ether.fi-stake → ether.fi, worldcoin-wld → worldcoin), a two-part one with a dot (ether-fi → ether.fi)
 */
const alike = (s: string): string[] => {
  const parts = s.split("-");
  return parts.length > 1 ? [parts[0]!, ...(parts.length === 2 ? [parts.join(".")] : [])] : [];
};

export function unlockScheduleTool(fc: FreeContext, slugsFor: UnlockSlugs): ToolDef {
  // the slugs DefiLlama has an unlock dataset for (370 or so, 4 KB)
  const listed = new Dataset<Set<string>>(
    6 * HOUR,
    async (signal) => {
      take(fc.limit.llama);
      const raw = await fc.http.json(`${DATASETS}/emissionsProtocolsList`, { signal, maxBytes: MB });
      if (!Array.isArray(raw)) throw new ToolFail("unavailable");
      return new Set(raw.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase()));
    },
    fc.now,
  );

  /**
   * The dataset's slug for a name, ticker or address ("$JUP" as JUP): as written, or without a suffix word ("jupiter",
   * "ether.fi", "Kamino Finance" → kamino) or filed as "<it>-foundation" (sui → sui-foundation); else a protocol's or
   * chain's that goes by it, or its CoinGecko id (JUP → jupiter, TIA → celestia), else as DefiLlama files their
   * products (KMNO → kamino-lend → kamino, ETHFI → ether-fi → ether.fi, WLD → worldcoin-wld → worldcoin), else one of
   * theirs filed as "<slug>-foundation" or as the only "<slug>-…" (ARB → arbitrum → arbitrum-foundation); as written
   * when the list does not load. Never the only "<query>-…": MAGIC is not Magic Eden
   */
  async function slugFor(q: string, signal: AbortSignal): Promise<string | null> {
    const name = q.trim().replace(/^\$\s*/, "");
    const forms = [name.toLowerCase().replace(/\s+/g, "-"), slugify(name)];
    const own = [...new Set([...forms, ...forms.map((s) => s.replace(SUFFIX, ""))])].filter((s) => SLUG.test(s));
    let list: Set<string>;
    try {
      list = await listed.get(signal);
    } catch {
      return own[0] ?? null;
    }
    const direct = own.find((s) => list.has(s)) ?? own.map((s) => filedUnder(list, s, false)).find((s) => s !== null);
    if (direct) return direct;
    const names = await slugsFor(name, signal).catch((): UnlockNames => ({ slugs: [], gecko: [] }));
    const theirs = [...names.slugs, ...names.gecko].map((s) => s.toLowerCase());
    return (
      theirs.find((s) => list.has(s)) ??
      theirs.flatMap(alike).find((s) => list.has(s)) ??
      names.slugs.map((s) => filedUnder(list, s.toLowerCase(), true)).find((s) => s !== null) ??
      null
    );
  }

  return {
    name: "unlock_schedule",
    description:
      "A token's unlock schedule from DefiLlama: the next cliff unlock and upcoming and past ones with tokens, share of max supply and who gets them (team, investors, airdrop...), linear streams unlocking now per week, how much is still to unlock and until when, tokens with no set schedule. Says plainly when no scheduled unlocks remain. By project name, ticker or contract address. Use first for unlocks or vesting.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Project name, ticker or contract address, e.g. jupiter, JUP, ARB", pattern: QUERY },
        limit: limitParam(12, 40, "unlock dates on each side of today"),
      },
      required: ["token"],
      additionalProperties: false,
    },
    ttlMs: HOUR,
    async run(args, { signal }): Promise<Outcome> {
      const slug = await slugFor(String(args.token), signal);
      if (!slug) return { ok: false, error: "not_found" };
      take(fc.limit.llama);
      const raw = await fc.http.json(`${DATASETS}/emissions/${encodeURIComponent(slug)}`, { signal, maxBytes: 16 * MB });
      if (!isObj(raw) || !isObj(raw.metadata)) throw new ToolFail("not_found");
      const data = unlockSchedule(raw, slug, fc.now(), Number(args.limit ?? 12));
      return { ok: true, data, sources: uniqueSources([src(`DefiLlama: ${String(data.name)} unlocks`, data.link as string | null)]) };
    },
  };
}
