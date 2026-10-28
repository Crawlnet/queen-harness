// The live-narrative tools, read from the data the services write (services/migration: the pump.fun and StonkFun
// index; services/ai-x-radar: the X radar; NARRATIVE_DIR is the folder that holds both). Nothing is fetched and nothing
// written: each file is re-read at most once a FILE_TTL_MS, and only when it changed.
//   - meme_narrative: one Solana coin's story as the index labelled it (its narrative, group and gist, what it copies,
//     where its hype comes from, organic or farmed), the events it confirmed (a runner: a $150k market cap held 10 min
//     within a day of migrating; a first hold of a $1M-50M tier), the ladder and farm flags, its market;
//   - meme_metas: what migrates now, by group and narrative (the last 24 h), and the last closed day's metas;
//   - meme_runners: the coins that just ran, and how clean;
//   - x_ideas: the day's AI and agent ideas spreading on X as the X radar read them, each with its stage (pre-crypto …
//     tokenized-junk), its root post and spread, and the tokens already made of it.
// Facts as the index labelled them: a narrative is its reading, never a verdict on the coin.

import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { src, uniqueSources } from "../links.ts";
import { MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import type { FreeContext } from "./common.ts";

const FILE_TTL_MS = MINUTE;
const SOL_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY_S = 86_400;

/** A JSON file read at most once a FILE_TTL_MS, and only when it changed; the last good read kept on a failure */
class JsonFile<T> {
  private value: T | null = null;
  private mtime = -1;
  private checked = 0;
  private reading: Promise<T | null> | null = null;
  private readonly path: string;
  private readonly now: () => number;
  constructor(path: string, now: () => number) {
    this.path = path;
    this.now = now;
  }
  /**
   * The file as last read. Past FILE_TTL_MS a read is due: a copy in hand goes at once and the read lands for the next
   * caller; only the first read is waited for
   */
  get(): Promise<T | null> {
    if (this.now() - this.checked < FILE_TTL_MS) return Promise.resolve(this.value);
    const reading = (this.reading ??= this.read());
    return this.value !== null ? Promise.resolve(this.value) : reading;
  }
  /** The file read again when it changed (missing or half-written: the last good read stays) */
  private async read(): Promise<T | null> {
    try {
      const s = await stat(this.path);
      if (s.mtimeMs !== this.mtime) {
        this.value = JSON.parse(await readFile(this.path, "utf8")) as T;
        this.mtime = s.mtimeMs;
      }
    } catch {
      // the last good read stays
    } finally {
      this.checked = this.now();
      this.reading = null;
    }
    return this.value;
  }
  /** The file as it is now, waited for (a caller that must see the latest write) */
  fresh(): Promise<T | null> {
    if (this.now() - this.checked < FILE_TTL_MS) return Promise.resolve(this.value);
    return (this.reading ??= this.read());
  }
  /** What it last read, at once (null before its first read); a read due starts for the next caller */
  peek(): T | null {
    if (this.now() - this.checked >= FILE_TTL_MS) void this.get();
    return this.value;
  }
}

// ─────────── the pump.fun index's shapes (services/migration)

interface Card {
  narrative?: string;
  tags?: string[];
  group?: string;
  essence?: string;
  idea_source?: string;
  hype_source?: string;
  copycat_of?: string;
  traction?: string;
  legitimacy?: string;
  confidence?: number;
}
interface MigToken {
  mint: string;
  platform?: string;
  migratedAt?: number;
  createdAt?: number;
  meta?: { name?: string; symbol?: string; description?: string };
  jup?: { name?: string; symbol?: string; holders?: number | null; organicScore?: number | null; twitter?: string | null; website?: string | null };
  market?: { mcap?: number; liquidity?: number; volume24h?: number; priceUsd?: number; txns24h?: number; url?: string; dex?: string; change?: { h1?: number; h24?: number } };
  ath?: { mcap?: number; at?: number };
  events?: { type: string; label: string; confirmedAt?: number; median?: number; flag?: string }[];
  junk?: { rigged?: boolean };
  /**
   * Its narrative label: the full analysis's fields on the analysis itself, the light label beside them; an older card
   * held them
   */
  analysis?: Card & { light?: Card; card?: Card; cardV2?: boolean };
}
interface MigDb {
  tokens: Record<string, MigToken>;
}
interface DailyCluster {
  name: string;
  description?: string;
  tokens: number;
  migrations: number;
  runners: number;
  volume24h: number;
  athMax: number;
  farms: number;
  top?: string[];
}
interface MigDaily {
  day: string;
  migrations?: Record<string, { migrations: number; runners: number; runnerRate: number; volume24hSum: number }>;
  clustersByVolume?: DailyCluster[];
}
/** One line of events.jsonl: a runner or tier the index confirmed, or its retraction (a drawn ladder) */
interface MigEvent {
  type: string;
  label?: string;
  tier?: number;
  confirmedAt?: number;
  at?: number;
  median?: number;
  flag?: string;
  backfill?: boolean;
  mint: string;
  symbol?: string;
  platform?: string;
}
/** The tail of events.jsonl read (a day is ~90 KB): days of runners, their retractions with them */
const EVENTS_TAIL_BYTES = 512 * 1024;
/** What the index's flags on a runner mean */
const RUN_FLAGS: Record<string, string> = {
  farm: "its volume farmed (wash trades)",
  "mcap/liq": "its market cap far above its liquidity",
  "low-turnover": "little real turnover for its size",
  "low-liq": "thin liquidity",
};
/** The events' tiers, smallest first, as the tool names them */
const RUN_TIERS: Record<string, number> = { "150k": 150_000, "1M": 1_000_000, "5M": 5_000_000, "10M": 10_000_000, "25M": 25_000_000, "50M": 50_000_000 };

/** events.jsonl's tail, re-read at most once a FILE_TTL_MS and only when the file changed; the last good read kept */
class EventsTail {
  private rows: MigEvent[] = [];
  private size = -1;
  private mtime = -1;
  private checked = 0;
  private reading: Promise<MigEvent[]> | null = null;
  private readonly path: string;
  private readonly now: () => number;
  constructor(path: string, now: () => number) {
    this.path = path;
    this.now = now;
  }
  get(): Promise<MigEvent[]> {
    if (this.now() - this.checked < FILE_TTL_MS) return Promise.resolve(this.rows);
    this.reading ??= (async () => {
      try {
        const s = await stat(this.path);
        if (s.size !== this.size || s.mtimeMs !== this.mtime) {
          const len = Math.min(s.size, EVENTS_TAIL_BYTES);
          const buf = Buffer.alloc(len);
          const fh = await open(this.path, "r");
          try {
            await fh.read(buf, 0, len, s.size - len);
          } finally {
            await fh.close();
          }
          let text = buf.toString("utf8");
          if (len < s.size) text = text.slice(text.indexOf("\n") + 1);
          const rows: MigEvent[] = [];
          for (const line of text.split("\n")) {
            if (!line) continue;
            try {
              const e = JSON.parse(line) as MigEvent;
              if (e && typeof e.mint === "string" && typeof e.type === "string") rows.push(e);
            } catch {
              // a line cut by a write in progress
            }
          }
          this.rows = rows;
          this.size = s.size;
          this.mtime = s.mtimeMs;
        }
      } catch {
        // missing: the last good read stays
      } finally {
        this.checked = this.now();
        this.reading = null;
      }
      return this.rows;
    })();
    return this.reading;
  }
}

// ─────────── the X radar (services/ai-x-radar)

interface RadarPost {
  url?: string;
  text?: string;
  at?: number;
  author?: { handle?: string; followers?: number };
  views?: number;
}
/** One idea as the run enriched it (runs/<day>/ideas.json): its posts, how it spread, the tokens already made of it */
interface RadarIdea {
  key: string;
  title?: string;
  terms?: string[];
  root?: RadarPost;
  views?: number;
  spread?: {
    notable?: { handle?: string; followers?: number; url?: string; text?: string }[];
    langs?: string[];
    crypto?: number;
    firstCryptoH?: number | null;
    cas?: string[];
    tickers?: string[];
  };
  tokens?: { count?: number; firstH?: number | null; top?: { symbol?: string; name?: string; chain?: string; mcap?: number; vol24?: number; created?: number; url?: string; address?: string }[] };
}
/** The run's verdicts (runs/<day>/final.json): the day's summary and the ideas it kept, scored, with their stage */
interface RadarFinal {
  summary?: string;
  ideas?: { key: string; score?: number; title?: string; essence?: string; why?: string; origin?: string; stage?: string; angle?: string; risk?: string }[];
}
interface RadarRun {
  meta?: { posts?: number; ideas?: number };
  window?: { from?: number; to?: number };
}
/** data/ideas.json: every idea the radar ever kept, by key, with the days it came back */
type RadarHistory = Record<string, { first?: string; last?: string; days?: { date?: string }[] }>;

/** What a stage says, for the model (the radar's own) */
const RADAR_STAGES: Record<string, string> = {
  "pre-crypto": "no token and next to no crypto talk yet",
  "crypto-noticed": "crypto accounts talk about it, tokens few or none",
  "tokenized-junk": "only small tokens with no product so far",
  "tokenized-product": "a token with a product behind it exists",
  "not-tokenizable": "spreads, but nothing a coin can carry",
};

const usd0 = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);
const iso = (s: number | null | undefined): string | null => (typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null);
const clip = (s: unknown, n: number): string | null => (typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim().slice(0, n) : null);
/**
 * A coin's narrative label: its full analysis (the fields on the analysis itself), else an older card that holds them,
 * else its light label
 */
const cardOf = (t: MigToken): Card | null => {
  const a = t.analysis;
  if (!a) return null;
  if (typeof a.narrative === "string" && a.narrative.trim()) return a;
  if (typeof a.card?.narrative === "string" && a.card.narrative.trim()) return a.card;
  return a.light ?? null;
};
/** Whether its label is the index's full analysis (or an older full card), not a light one */
const fullCard = (t: MigToken | undefined): boolean => !!t?.analysis && cardOf(t) !== (t.analysis.light ?? null);
const symbolOf = (t: MigToken | undefined): string | null => clip(t?.meta?.symbol ?? t?.jup?.symbol, 24);

export interface NarrativeConfig {
  /** Where the services' folders are (migration/, ai-x-radar/) */
  dir: string;
}

export function narrativeTools(fc: FreeContext, cfg: NarrativeConfig): ToolDef[] {
  const now = fc.now;
  const db = new JsonFile<MigDb>(join(cfg.dir, "migration/data/db.json"), now);
  const dailyDir = join(cfg.dir, "migration/data/daily");
  const events = new EventsTail(join(cfg.dir, "migration/data/events.jsonl"), now);
  // a coin's narrative label, the CT radar's narratives' groups (free/ctradar.ts): the pump.fun index's card, as the file
  // last read (at once: the radar groups many coins a call; a read due starts meanwhile)
  fc.narrativeOf = (mint) => {
    const t = db.peek()?.tokens?.[mint];
    const card = t ? cardOf(t) : null;
    const narrative = clip(card?.narrative, 80);
    const group = clip(card?.group, 30);
    return narrative || group ? { narrative, group } : null;
  };
  // the index is read at start, so the first ask finds the labels (never in tests)
  if (fc.warm) void db.get();

  const narrative: ToolDef = {
    name: "meme_narrative",
    description:
      "One Solana memecoin's story as our pump.fun and StonkFun index labelled it: its narrative, group and gist, what it copies, where its hype comes from, organic or farmed; the events it confirmed (a runner: a $150k market cap held 10 min within a day of migrating; a first hold of a $1M-$50M tier), ladder and farm flags, its market.",
    parameters: {
      type: "object",
      properties: { mint: { type: "string", description: "The token's mint address (base58)", pattern: SOL_MINT.source } },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: MINUTE,
    async run(args): Promise<Outcome> {
      const mint = String(args.mint).trim();
      if (!SOL_MINT.test(mint)) return { ok: false, error: "bad_args", message: "mint must be a Solana address" };
      const d = await db.get();
      if (!d) throw new ToolFail("unavailable");
      const t = d.tokens?.[mint];
      const nowS = Math.floor(now() / 1000);
      if (!t) return { ok: true, data: { mint, tracked: false, note: "not in the pump.fun/StonkFun index (it tracks migrations of the last days and coins over $500k)" }, sources: [] };
      const card = cardOf(t);
      const flags = [...(t?.junk?.rigged ? ["ladder: a drawn staircase chart"] : []), ...new Set((t?.events ?? []).map((e) => e.flag).filter((x): x is string => !!x))];
      const data: Record<string, unknown> = {
        mint,
        tracked: true,
        symbol: symbolOf(t),
        name: clip(t?.meta?.name ?? t?.jup?.name, 60),
        platform: t?.platform ?? null,
        migrated_at: iso(t?.migratedAt),
        age_h: t?.createdAt ? Math.round((nowS - t.createdAt) / 360) / 10 : null,
        narrative: card
          ? {
              narrative: clip(card.narrative, 80),
              group: clip(card.group, 30),
              tags: (card.tags ?? []).slice(0, 5).map((x) => clip(x, 30)).filter(Boolean),
              gist: clip(card.essence, 300),
              idea_source: clip(card.idea_source, 200),
              hype_source: clip(card.hype_source, 40),
              copycat_of: clip(card.copycat_of, 80),
              traction: clip(card.traction, 200),
              legitimacy: clip(card.legitimacy, 30),
              confidence: typeof card.confidence === "number" ? Math.round(card.confidence * 100) / 100 : null,
              labelled: fullCard(t) ? "full card" : "light label",
            }
          : null,
        events: (t?.events ?? []).slice(0, 8).map((e) => ({ kind: e.type, label: e.label, at: iso(e.confirmedAt), median_mcap_usd: usd0(e.median), flag: e.flag ?? null })),
        flags,
        market: t?.market
          ? {
              mcap_usd: usd0(t.market.mcap),
              liquidity_usd: usd0(t.market.liquidity),
              volume_24h_usd: usd0(t.market.volume24h),
              change_1h_pct: t.market.change?.h1 ?? null,
              change_24h_pct: t.market.change?.h24 ?? null,
              ath_mcap_usd: usd0(t.ath?.mcap),
              holders: t.jup?.holders ?? null,
              organic_score: t.jup?.organicScore ?? null,
            }
          : null,
      };
      const sources = uniqueSources([src("DEX Screener", `https://dexscreener.com/solana/${mint}`), ...(t?.platform === "pump" || mint.endsWith("pump") ? [src("pump.fun", `https://pump.fun/coin/${mint}`)] : [])]);
      return { ok: true, data, sources };
    },
  };

  const metas: ToolDef = {
    name: "meme_metas",
    description:
      "What is migrating on pump.fun and StonkFun now, by narrative as our index labels each coin: the stories heating now first (coins migrated in the last 6 h and 24 h, runners clean and farmed, when the story started and its newest coin, its og coin), then per group its coins, runners and volume; and the last closed UTC day's metas. For which metas, narratives or themes are running now.",
    parameters: {
      type: "object",
      properties: {
        group: { type: "string", description: "Only this group (ai, politics, animals, celebrity/influencer, news/event, stocks/rwa, commodities/macro, gaming, culture/meme, tech/product, crypto-meta, religion/spiritual, sports, country/nation, other)" },
        query: { type: "string", description: "Only coins whose narrative, tags or symbol hold this word", maxLength: 40 },
        limit: { type: "integer", description: "Groups (and the day's metas) at most", minimum: 1, maximum: 15, default: 8 },
      },
      additionalProperties: false,
    },
    ttlMs: 2 * MINUTE,
    async run(args): Promise<Outcome> {
      const d = await db.get();
      if (!d) throw new ToolFail("unavailable");
      const limit = Math.max(1, Math.min(15, Number(args.limit ?? 8)));
      const group = typeof args.group === "string" ? args.group.trim().toLowerCase() : null;
      const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : null;
      const nowS = Math.floor(now() / 1000);
      const recent = Object.values(d.tokens ?? {}).filter((t) => (t.migratedAt ?? 0) >= nowS - DAY_S && !t.junk?.rigged);
      const labelled = recent.map((t) => ({ t, c: cardOf(t) })).filter((x): x is { t: MigToken; c: Card } => !!x.c?.narrative);
      const match = (x: { t: MigToken; c: Card }) =>
        (!group || (x.c.group ?? "other").toLowerCase() === group) && (!q || [x.c.narrative, ...(x.c.tags ?? []), x.t.meta?.symbol].some((s) => typeof s === "string" && s.toLowerCase().includes(q)));
      const rows = labelled.filter(match);
      const by = new Map<string, { t: MigToken; c: Card }[]>();
      for (const x of rows) by.set(x.c.group ?? "other", [...(by.get(x.c.group ?? "other") ?? []), x]);
      const vol = (t: MigToken) => t.market?.volume24h ?? 0;
      const groups = [...by]
        .map(([g, xs]) => {
          const narr = new Map<string, { t: MigToken; c: Card }[]>();
          for (const x of xs) narr.set(x.c.narrative!.toLowerCase(), [...(narr.get(x.c.narrative!.toLowerCase()) ?? []), x]);
          return {
            group: g,
            coins: xs.length,
            runners: xs.filter((x) => (x.t.events ?? []).some((e) => e.type === "runner")).length,
            volume_24h_usd: usd0(xs.reduce((s, x) => s + vol(x.t), 0)),
            narratives: [...narr]
              .map(([n, ys]) => ({ narrative: n, coins: ys.length, volume_24h_usd: usd0(ys.reduce((s, y) => s + vol(y.t), 0)), best: ys.sort((a, b) => vol(b.t) - vol(a.t)).slice(0, 2).map((y) => ({ symbol: clip(y.t.meta?.symbol, 24), mint: y.t.mint, mcap_usd: usd0(y.t.market?.mcap), runner: (y.t.events ?? []).some((e) => e.type === "runner") })) }))
              .sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0))
              .slice(0, 5),
          };
        })
        .sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0))
        .slice(0, limit);
      // the stories heating now: each narrative's coins of the day, the ones of the last 6 h, its runners clean and
      // farmed, when it started and its newest coin, its og (the first one made); ranked by what is fresh and clean, never
      // by one big coin's volume
      const stories = new Map<string, { t: MigToken; c: Card }[]>();
      for (const x of rows) stories.set(x.c.narrative!.toLowerCase(), [...(stories.get(x.c.narrative!.toLowerCase()) ?? []), x]);
      const ranRunner = (t: MigToken) => (t.events ?? []).filter((e) => e.type === "runner");
      const top_narratives = [...stories]
        .map(([n, xs]) => {
          const at = (t: MigToken) => t.migratedAt ?? 0;
          const made = (t: MigToken) => t.createdAt ?? t.migratedAt ?? 0;
          const runners = xs.filter((x) => ranRunner(x.t).length > 0);
          const farmed = runners.filter((x) => ranRunner(x.t).some((e) => !!e.flag)).length;
          const og = [...xs].sort((a, b) => made(a.t) - made(b.t))[0]!;
          return {
            narrative: n,
            group: clip(xs[0]!.c.group, 30),
            coins_24h: xs.length,
            coins_6h: xs.filter((x) => at(x.t) >= nowS - 6 * 3600).length,
            runners_clean: runners.length - farmed,
            runners_farmed: farmed,
            started_at: iso(Math.min(...xs.map((x) => made(x.t)))),
            newest_at: iso(Math.max(...xs.map((x) => at(x.t)))),
            og: { symbol: clip(og.t.meta?.symbol, 24), mint: og.t.mint, mcap_usd: usd0(og.t.market?.mcap) },
            // its biggest coins of the day, so a story is read whole
            coins: [...xs]
              .sort((a, b) => vol(b.t) - vol(a.t))
              .slice(0, 3)
              .map((y) => ({ symbol: clip(y.t.meta?.symbol, 24), mint: y.t.mint, mcap_usd: usd0(y.t.market?.mcap), change_1h_pct: y.t.market?.change?.h1 ?? null, age_h: made(y.t) ? Math.round((nowS - made(y.t)) / 360) / 10 : null, runner: ranRunner(y.t).length > 0 })),
          };
        })
        // fresh coins and clean runners first; a story of one coin is no story
        .filter((s) => s.coins_24h >= 2)
        .sort((a, b) => b.coins_6h * 2 + b.runners_clean * 3 + b.coins_24h - (a.coins_6h * 2 + a.runners_clean * 3 + a.coins_24h))
        .slice(0, limit);
      let day: MigDaily | null = null;
      try {
        const files = (await readdir(dailyDir)).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
        const last = files.at(-1);
        if (last) day = JSON.parse(await readFile(join(dailyDir, last), "utf8")) as MigDaily;
      } catch {
        day = null;
      }
      const data = {
        window: "24h",
        migrations_24h: recent.length,
        labelled_24h: labelled.length,
        top_narratives,
        groups,
        last_day: day
          ? {
              day: day.day,
              migrations: day.migrations ?? null,
              metas: (day.clustersByVolume ?? []).slice(0, limit).map((c) => ({ meta: clip(c.name, 60), about: clip(c.description, 200), coins: c.tokens, migrations: c.migrations, runners: c.runners, volume_24h_usd: usd0(c.volume24h), ath_max_usd: usd0(c.athMax), farms: c.farms, top: (c.top ?? []).slice(0, 5) })),
            }
          : null,
        note: "narratives are the index's labels; top_narratives: stories of two coins or more, the freshest and cleanest first (coins of the last 6 h, clean runners); a farmed runner is wash volume; coins drawn as ladders are left out",
      };
      return { ok: true, data, sources: [] };
    },
  };

  const runners: ToolDef = {
    name: "meme_runners",
    description:
      "The pump.fun and StonkFun coins that just ran, as our index confirmed them, newest first: a runner (a $150k market cap held 10 min within a day of migrating) or a first hold of a $1M, $5M, $10M, $25M or $50M tier; each with when, the market cap it held, its flag (farm: farmed volume; mcap/liq: market cap far above liquidity; low turnover; low liquidity), its narrative and its market now; drawn ladders taken back. For what is running right now and how clean it is.",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "The last hours", minimum: 1, maximum: 48, default: 3 },
        tier: { type: "string", description: "Only events at this tier or higher", enum: Object.keys(RUN_TIERS) },
        clean: { type: "boolean", description: "Only coins with no flag", default: false },
        limit: { type: "integer", description: "Coins at most", minimum: 1, maximum: 30, default: 15 },
      },
      additionalProperties: false,
    },
    ttlMs: MINUTE,
    async run(args): Promise<Outcome> {
      const [rows, d] = await Promise.all([events.get(), db.get()]);
      if (!rows.length && !d) throw new ToolFail("unavailable");
      const hours = Math.max(1, Math.min(48, Number(args.hours ?? 3)));
      const limit = Math.max(1, Math.min(30, Number(args.limit ?? 15)));
      const minTier = typeof args.tier === "string" && args.tier in RUN_TIERS ? RUN_TIERS[args.tier]! : 0;
      const clean = args.clean === true;
      const nowS = Math.floor(now() / 1000);
      const fromS = nowS - hours * 3600;
      const takenBack = new Set(rows.filter((e) => e.type === "retract").map((e) => `${e.mint}|${e.label}`));
      const live = rows.filter((e) => (e.type === "runner" || e.type === "tier") && (e.confirmedAt ?? 0) >= fromS);
      const kept = live.filter((e) => !takenBack.has(`${e.mint}|${e.label}`) && !d?.tokens?.[e.mint]?.junk?.rigged);
      // a coin once, at its newest event; the tiers it held in the window said with it
      const byMint = new Map<string, { last: MigEvent; tiers: Set<string> }>();
      for (const e of kept.sort((a, b) => (b.confirmedAt ?? 0) - (a.confirmedAt ?? 0))) {
        const name = e.type === "runner" ? "150k" : (e.label ?? "");
        const c = byMint.get(e.mint);
        if (c) c.tiers.add(name);
        else byMint.set(e.mint, { last: e, tiers: new Set([name]) });
      }
      const all = [...byMint.values()].map(({ last: e, tiers }) => {
        const t = d?.tokens?.[e.mint];
        const card = t ? cardOf(t) : null;
        const top = Math.max(...[...tiers].map((x) => RUN_TIERS[x] ?? 0));
        return {
          symbol: clip(e.symbol ?? t?.meta?.symbol, 24),
          mint: e.mint,
          platform: e.platform ?? t?.platform ?? null,
          ran: e.type === "runner" ? "runner" : `${e.label} tier`,
          tiers_in_window: [...tiers].sort((a, b) => (RUN_TIERS[a] ?? 0) - (RUN_TIERS[b] ?? 0)),
          top_tier_usd: top,
          confirmed: iso(e.confirmedAt),
          minutes_ago: e.confirmedAt ? Math.round((nowS - e.confirmedAt) / 60) : null,
          held_mcap_usd: usd0(e.median),
          flag: e.flag ?? t?.events?.find((x) => x.label === e.label)?.flag ?? null,
          confirmed_late: e.backfill === true,
          narrative: clip(card?.narrative, 80),
          group: clip(card?.group, 30),
          copies: clip(card?.copycat_of, 80),
          mcap_now_usd: usd0(t?.market?.mcap),
          liquidity_usd: usd0(t?.market?.liquidity),
          change_1h_pct: t?.market?.change?.h1 ?? null,
          volume_24h_usd: usd0(t?.market?.volume24h),
        };
      });
      const shown = all.filter((r) => r.top_tier_usd >= minTier && (!clean || !r.flag));
      const groups = new Map<string, number>();
      for (const r of all) if (r.group) groups.set(r.group, (groups.get(r.group) ?? 0) + 1);
      return {
        ok: true,
        data: {
          window_h: hours,
          coins: all.length,
          flagged: all.filter((r) => r.flag).length,
          taken_back: live.length - kept.length,
          by_group: [...groups].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g, n]) => ({ group: g, coins: n })),
          runners: shown.slice(0, limit),
          flags: RUN_FLAGS,
          note: "a runner is the index's confirmation, never a call: most are flagged farm; a clean one with its liquidity holding is the rare read",
        },
        sources: uniqueSources(shown.slice(0, 5).map((r) => src(`${r.symbol ?? "coin"} on DEX Screener`, `https://dexscreener.com/solana/${r.mint}`))),
      };
    },
  };

  // the X ideas radar: the day's run, its files re-read like the others; the run's days newest first
  const radarDir = join(cfg.dir, "ai-x-radar/data");
  const radarFiles = new Map<string, JsonFile<unknown>>();
  const radarFile = <T>(path: string): Promise<T | null> => {
    let f = radarFiles.get(path);
    if (!f) radarFiles.set(path, (f = new JsonFile<unknown>(join(radarDir, path), now)));
    return f.get() as Promise<T | null>;
  };
  const radarHistory = new JsonFile<RadarHistory>(join(radarDir, "ideas.json"), now);
  /** The last n days with a finished run (its final.json read), newest first */
  async function radarDays(n: number): Promise<string[]> {
    let names: string[];
    try {
      names = (await readdir(join(radarDir, "runs"))).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)).sort().reverse();
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const d of names) {
      if (out.length >= n) break;
      if ((await radarFile<RadarFinal>(`runs/${d}/final.json`))?.ideas) out.push(d);
    }
    return out;
  }

  const ideas: ToolDef = {
    name: "x_ideas",
    description:
      "The day's AI and agent ideas spreading on X before or as crypto picks them up (our X radar, daily): per idea its gist, why it spreads, the root post (views, author), notable quoters, its stage (pre-crypto: no token yet; crypto-noticed; tokenized-junk: only small tokens; tokenized-product; not-tokenizable), tickers crypto posts named, the tokens already made of it (chain, market cap, volume, when) and hours from post to first token; the day's summary. For where an idea stands and whether a coin's story is new.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Only ideas whose title, terms, tickers or tokens hold this word (a coin's name or ticker, a topic)", maxLength: 40 },
        stage: { type: "string", description: "Only ideas at this stage", enum: Object.keys(RADAR_STAGES) },
        days: { type: "integer", description: "The last runs to read (one a day); an idea seen on several keeps its newest", minimum: 1, maximum: 7, default: 1 },
        limit: { type: "integer", description: "Ideas at most", minimum: 1, maximum: 25, default: 10 },
      },
      additionalProperties: false,
    },
    ttlMs: 5 * MINUTE,
    async run(args): Promise<Outcome> {
      const n = Math.max(1, Math.min(7, Number(args.days ?? 1)));
      const limit = Math.max(1, Math.min(25, Number(args.limit ?? 10)));
      const stage = typeof args.stage === "string" && args.stage in RADAR_STAGES ? args.stage : null;
      const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const days = await radarDays(n);
      if (!days.length) throw new ToolFail("unavailable");
      const history = await radarHistory.get();
      const seen = new Set<string>();
      const rows: Record<string, unknown>[] = [];
      let first: { day: string; fin: RadarFinal | null; run: RadarRun | null } | null = null;
      for (const day of days) {
        const [fin, enriched, run] = await Promise.all([radarFile<RadarFinal>(`runs/${day}/final.json`), radarFile<RadarIdea[]>(`runs/${day}/ideas.json`), radarFile<RadarRun>(`runs/${day}/meta.json`)]);
        first ??= { day, fin, run };
        const byKey = new Map((Array.isArray(enriched) ? enriched : []).filter((i) => i?.key).map((i) => [i.key, i]));
        const ranAt = run?.window?.to ?? null;
        for (const f of fin?.ideas ?? []) {
          if (!f?.key || seen.has(f.key)) continue;
          seen.add(f.key);
          if (stage && f.stage !== stage) continue;
          const e = byKey.get(f.key);
          const tickers = (e?.spread?.tickers ?? []).slice(0, 8);
          const tokens = (e?.tokens?.top ?? []).slice(0, 5).map((t) => ({ symbol: clip(t.symbol, 24), name: clip(t.name, 60), chain: clip(t.chain, 20), mcap_usd: usd0(t.mcap), volume_24h_usd: usd0(t.vol24), created: iso(t.created), address: clip(t.address, 64), url: clip(t.url, 200) }));
          const terms = (e?.terms ?? []).slice(0, 6).map((t) => clip(t, 40)).filter((t): t is string => !!t);
          if (q && ![f.title, e?.title, f.key, f.essence, ...terms, ...tickers, ...tokens.flatMap((t) => [t.symbol, t.name])].some((s) => typeof s === "string" && s.toLowerCase().includes(q))) continue;
          const root = e?.root;
          const h = history?.[f.key];
          rows.push({
            idea: clip(f.title ?? e?.title, 120),
            key: f.key,
            run_day: day,
            score: typeof f.score === "number" ? f.score : null,
            stage: f.stage ?? null,
            gist: clip(f.essence, 400),
            why_it_spreads: clip(f.why, 400),
            origin: clip(f.origin, 200),
            angle: clip(f.angle, 300),
            risk: clip(f.risk, 300),
            terms,
            root_post: root?.url ? { url: root.url, author: clip(root.author?.handle, 30), author_followers: root.author?.followers ?? null, views: usd0(root.views), posted: iso(root.at), text: clip(root.text, 280) } : null,
            views: usd0(e?.views),
            age_h_at_run: ranAt && root?.at ? Math.round((ranAt - root.at) / 360) / 10 : null,
            notable_quoters: (e?.spread?.notable ?? []).slice(0, 3).map((x) => ({ handle: clip(x.handle, 30), followers: x.followers ?? null, url: clip(x.url, 200) })),
            languages: (e?.spread?.langs ?? []).slice(0, 8),
            crypto: { mentions: e?.spread?.crypto ?? 0, first_after_h: e?.spread?.firstCryptoH ?? null, tickers, contracts: (e?.spread?.cas ?? []).slice(0, 5) },
            tokens: { count: e?.tokens?.count ?? tokens.length, first_after_h: e?.tokens?.firstH ?? null, top: tokens },
            days_seen: h?.days?.length ?? 1,
            first_seen: h?.first ?? day,
          });
        }
      }
      const shown = rows.slice(0, limit);
      const sources = uniqueSources(
        shown.flatMap((r) => {
          const p = r.root_post as { url: string; author: string | null } | null;
          return p ? [src(p.author ? `@${p.author} on X` : "X post", p.url)] : [];
        }),
      );
      return {
        ok: true,
        data: {
          run_day: first?.day ?? null,
          window: { from: iso(first?.run?.window?.from), to: iso(first?.run?.window?.to) },
          posts_read: first?.run?.meta?.posts ?? null,
          summary: clip(first?.fin?.summary, 1500),
          ideas: shown,
          more: Math.max(0, rows.length - shown.length),
          stages: RADAR_STAGES,
          note: "say it in the asker's language. tokens are what its search found for the idea, never a pick; an idea's age counts from its root post to the run",
        },
        sources,
      };
    },
  };

  return [narrative, metas, runners, ideas];
}

