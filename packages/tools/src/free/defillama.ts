// DefiLlama's public API (no key): protocol TVL and history, top protocols and chains, fees and
// revenue, DEX volumes, yield pools, stablecoins; token unlocks from its datasets (unlocks.ts). Sources: the matching
// defillama.com pages.

import { LLAMA_PAGES, llamaChain, llamaProtocol, llamaYieldPool, src, uniqueSources } from "../links.ts";
import { limitParam, QUERY } from "../schema.ts";
import { MB } from "../http.ts";
import { HOUR, MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { Dataset, isObj, num, pctChange, round, slugify, str, take, type FreeContext } from "./common.ts";
import { DATASETS_HOST, unlockScheduleTool, type UnlockNames } from "./unlocks.ts";

export const LLAMA_HOSTS = ["api.llama.fi", "yields.llama.fi", "stablecoins.llama.fi", DATASETS_HOST];
const API = "https://api.llama.fi";

/** Chain TVL keys that are not chains (borrowed, staking…) */
const NOT_CHAINS = new Set(["borrowed", "staking", "pool2", "vesting", "treasury", "doublecounted", "liquidstaking", "dcandlsoverlap", "offers", "ownTokens".toLowerCase()]);
const realChain = (k: string) => !k.includes("-") && !NOT_CHAINS.has(k.toLowerCase());

interface ProtoRow {
  name: string;
  slug: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl: number;
  change1d: number | null;
  change7d: number | null;
  mcap: number | null;
  chainTvls: Record<string, number>;
  /** The parent's slug ("parent#jupiter" → jupiter): a token's unlocks are filed under it */
  parent: string | null;
  /** The token's address without its chain ("solana:JUP…" → JUP…), and its CoinGecko id */
  address: string | null;
  gecko: string | null;
}

interface VolumeRow {
  name: string;
  slug: string;
  category: string | null;
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  change1d: number | null;
}

interface VolumeOverview {
  rows: VolumeRow[];
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
}

interface PoolRow {
  pool: string;
  project: string;
  chain: string;
  symbol: string;
  tvl: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  stablecoin: boolean;
  ilRisk: string | null;
  outlier: boolean;
}

interface StableRow {
  name: string;
  symbol: string;
  pegType: string | null;
  mechanism: string | null;
  circulating: number;
  prevDay: number | null;
  prevWeek: number | null;
  price: number | null;
  chains: { chain: string; usd: number }[];
}

const ok = (data: unknown, sources: (ReturnType<typeof src>)[]): Outcome => ({ ok: true, data, sources: uniqueSources(sources) });

export function defillamaTools(fc: FreeContext): ToolDef[] {
  const get = (url: string, signal: AbortSignal, maxBytes = 4 * MB) => {
    take(fc.limit.llama);
    return fc.http.json(url, { signal, maxBytes });
  };

  // the list of all protocols; apart, its entries with no TVL, a token's own (Celestia, Worldcoin, Sui Foundation),
  // which only unlock_schedule reads
  const protocolList = new Dataset<{ rows: ProtoRow[]; tokens: ProtoRow[] }>(
    15 * MINUTE,
    async (signal) => {
      const raw = await get(`${API}/protocols`, signal, 24 * MB);
      if (!Array.isArray(raw)) throw new ToolFail("unavailable");
      const out: { rows: ProtoRow[]; tokens: ProtoRow[] } = { rows: [], tokens: [] };
      for (const p of raw.filter(isObj)) {
        const name = str(p.name);
        const slug = str(p.slug, 120);
        const tvl = num(p.tvl);
        if (!name || !slug) continue;
        const chainTvls: Record<string, number> = {};
        if (isObj(p.chainTvls)) for (const [k, v] of Object.entries(p.chainTvls)) if (realChain(k) && num(v) !== null) chainTvls[k] = num(v)!;
        (tvl === null ? out.tokens : out.rows).push({
          name,
          slug,
          symbol: str(p.symbol, 20),
          category: str(p.category, 40),
          chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === "string").slice(0, 60) : [],
          tvl: tvl ?? 0,
          change1d: num(p.change_1d),
          change7d: num(p.change_7d),
          mcap: num(p.mcap),
          chainTvls,
          parent: str(p.parentProtocol, 130)?.replace(/^parent#/, "") ?? null,
          address: str(p.address, 120)?.replace(/^[a-z0-9_-]+:/i, "") ?? null,
          gecko: str(p.gecko_id, 80),
        });
      }
      return out;
    },
    fc.now,
  );
  const protocols = {
    get: async (signal: AbortSignal): Promise<ProtoRow[]> => (await protocolList.get(signal)).rows,
    peek: (): ProtoRow[] | null => protocolList.peek()?.rows ?? null,
  };

  const chains = new Dataset<{ name: string; tvl: number; symbol: string | null; gecko: string | null }[]>(
    30 * MINUTE,
    async (signal) => {
      const raw = await get(`${API}/v2/chains`, signal);
      if (!Array.isArray(raw)) throw new ToolFail("unavailable");
      return raw.filter(isObj).flatMap((c) => {
        const name = str(c.name, 40);
        const tvl = num(c.tvl);
        return name && tvl !== null ? [{ name, tvl, symbol: str(c.tokenSymbol, 12), gecko: str(c.gecko_id, 80) }] : [];
      });
    },
    fc.now,
  );

  const volumeOverview = (kind: "fees" | "dexs") => {
    const sets = new Map<string, Dataset<VolumeOverview>>();
    return (chain: string | null) => {
      const key = chain ?? "";
      let d = sets.get(key);
      if (!d) {
        const url = `${API}/overview/${kind}${chain ? `/${encodeURIComponent(chain)}` : ""}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`;
        d = new Dataset<VolumeOverview>(
          30 * MINUTE,
          async (signal) => {
            const raw = await get(url, signal, 16 * MB);
            if (!isObj(raw) || !Array.isArray(raw.protocols)) throw new ToolFail("unavailable");
            const rows = raw.protocols.filter(isObj).flatMap((p): VolumeRow[] => {
              const name = str(p.displayName) ?? str(p.name);
              const slug = str(p.slug, 120);
              if (!name || !slug) return [];
              return [{ name, slug, category: str(p.category, 40), total24h: num(p.total24h), total7d: num(p.total7d), total30d: num(p.total30d), change1d: num(p.change_1d) }];
            });
            return { rows, total24h: num(raw.total24h), total7d: num(raw.total7d), total30d: num(raw.total30d) };
          },
          fc.now,
        );
        sets.set(key, d);
        if (sets.size > 40) sets.delete(sets.keys().next().value!);
      }
      return d;
    };
  };
  const feesOverview = volumeOverview("fees");
  const dexsOverview = volumeOverview("dexs");

  const pools = new Dataset<PoolRow[]>(
    30 * MINUTE,
    async (signal) => {
      take(fc.limit.llama);
      const raw = await fc.http.json("https://yields.llama.fi/pools", { signal, maxBytes: 32 * MB });
      if (!isObj(raw) || !Array.isArray(raw.data)) throw new ToolFail("unavailable");
      return raw.data.filter(isObj).flatMap((p): PoolRow[] => {
        const pool = str(p.pool, 64);
        const project = str(p.project, 60);
        const chain = str(p.chain, 40);
        const symbol = str(p.symbol, 60);
        const tvl = num(p.tvlUsd);
        if (!pool || !project || !chain || !symbol || tvl === null) return [];
        return [{
          pool,
          project,
          chain,
          symbol,
          tvl,
          apy: num(p.apy),
          apyBase: num(p.apyBase),
          apyReward: num(p.apyReward),
          apyMean30d: num(p.apyMean30d),
          stablecoin: p.stablecoin === true,
          ilRisk: str(p.ilRisk, 10),
          outlier: p.outlier === true,
        }];
      });
    },
    fc.now,
    40_000,
  );

  const stables = new Dataset<StableRow[]>(
    HOUR,
    async (signal) => {
      take(fc.limit.llama);
      const raw = await fc.http.json("https://stablecoins.llama.fi/stablecoins?includePrices=true", { signal, maxBytes: 8 * MB });
      if (!isObj(raw) || !Array.isArray(raw.peggedAssets)) throw new ToolFail("unavailable");
      const pegged = (o: unknown): number | null => (isObj(o) ? Object.values(o).map(num).find((x) => x !== null) ?? null : null);
      return raw.peggedAssets.filter(isObj).flatMap((s): StableRow[] => {
        const name = str(s.name);
        const symbol = str(s.symbol, 20);
        const circulating = pegged(s.circulating);
        if (!name || !symbol || circulating === null) return [];
        const chainsOut: { chain: string; usd: number }[] = [];
        if (isObj(s.chainCirculating)) {
          for (const [chain, v] of Object.entries(s.chainCirculating)) {
            const usd = isObj(v) ? pegged(v.current) : null;
            if (usd !== null && usd > 0) chainsOut.push({ chain, usd });
          }
        }
        chainsOut.sort((a, b) => b.usd - a.usd);
        return [{ name, symbol, pegType: str(s.pegType, 20), mechanism: str(s.pegMechanism, 30), circulating, prevDay: pegged(s.circulatingPrevDay), prevWeek: pegged(s.circulatingPrevWeek), price: num(s.price), chains: chainsOut.slice(0, 10) }];
      });
    },
    fc.now,
  );

  /** A protocol in the list by slug, name or symbol (biggest TVL first) */
  function findProtocol(list: ProtoRow[], q: string): ProtoRow | null {
    const s = slugify(q);
    const low = q.toLowerCase();
    return (
      list.find((p) => p.slug === s) ??
      list.find((p) => p.name.toLowerCase() === low) ??
      [...list].filter((p) => p.symbol?.toLowerCase() === low).sort((a, b) => b.tvl - a.tvl)[0] ??
      [...list].filter((p) => p.name.toLowerCase().includes(low)).sort((a, b) => b.tvl - a.tvl)[0] ??
      null
    );
  }

  /**
   * protocol_tvl when the protocol's own page fails: today's numbers from the list of all protocols (TVL, 1-day and
   * 7-day change, TVL per chain), no history; the page's own error when the list has no such protocol either.
   */
  async function fromList(slug: string, q: string, err: unknown, signal: AbortSignal): Promise<Outcome> {
    const list = await protocols.get(signal).catch(() => [] as ProtoRow[]);
    const row = list.find((p) => p.slug === slug) ?? findProtocol(list, q);
    if (!row) throw err;
    const link = llamaProtocol(row.slug);
    return ok(
      {
        name: row.name,
        slug: row.slug,
        symbol: row.symbol,
        category: row.category,
        tvl_usd: Math.round(row.tvl),
        as_of: null,
        change_1d_pct: round(row.change1d, 3),
        change_7d_pct: round(row.change7d, 3),
        mcap_usd: round(row.mcap),
        chains: Object.entries(row.chainTvls)
          .filter(([, v]) => v > 0)
          .map(([chain, v]) => ({ chain, tvl_usd: Math.round(v) }))
          .sort((a, b) => b.tvl_usd - a.tvl_usd)
          .slice(0, 10),
        history: [],
        note: "today's numbers only: the daily history did not load",
        link,
      },
      [src(`DefiLlama: ${row.name}`, link)],
    );
  }

  async function protocolDetail(slug: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const raw = await get(`${API}/protocol/${encodeURIComponent(slug)}`, signal, 24 * MB);
    if (!isObj(raw) || !Array.isArray(raw.tvl)) throw new ToolFail("not_found");
    return raw;
  }

  // the list of all protocols (9 MB), of chains and the yield pools (11 MB) load in the background at start: a cold
  // load can outlast a call, and every lookup by name waits for the list
  if (fc.warm) {
    protocolList.warm(60_000);
    chains.warm(60_000);
    pools.warm(60_000);
  }

  const findChain = async (name: string, signal: AbortSignal) => {
    const list = await chains.get(signal);
    const low = name.toLowerCase();
    return list.find((c) => c.name.toLowerCase() === low) ?? list.find((c) => c.name.toLowerCase().startsWith(low)) ?? null;
  };

  /**
   * unlock_schedule's names for a name, ticker or address: the protocols and token entries that go by it (name, ticker,
   * CoinGecko id, token address), biggest TVL first, each by its parent's slug first (JUP: jupiter-lend → jupiter); then
   * a chain of that name or token and the protocols of its token (Arbitrum or ARB → arbitrum, its token's protocols);
   * and their CoinGecko ids (WLD: World Chain's worldcoin-wld)
   */
  const unlockSlugs = async (q: string, signal: AbortSignal): Promise<UnlockNames> => {
    const low = q.trim().toLowerCase();
    const { rows, tokens } = await protocolList.get(signal).catch(() => ({ rows: [] as ProtoRow[], tokens: [] as ProtoRow[] }));
    const list = [...rows, ...tokens];
    const by = (k: string) => list.filter((p) => p.name.toLowerCase() === k || p.symbol?.toLowerCase() === k || p.gecko === k || p.address?.toLowerCase() === k).sort((a, b) => b.tvl - a.tvl);
    const slugs = (ps: ProtoRow[]) => ps.flatMap((p) => (p.parent ? [p.parent, p.slug] : [p.slug]));
    const chain = (await chains.get(signal).catch(() => [])).find((c) => c.name.toLowerCase() === low || c.symbol?.toLowerCase() === low);
    const own = by(low);
    const ofToken = chain?.symbol ? by(chain.symbol.toLowerCase()) : [];
    const gecko = [...own, ...ofToken].map((p) => p.gecko).concat(chain?.gecko ?? null).filter((g): g is string => g !== null);
    return { slugs: [...new Set([...slugs(own), ...(chain ? [slugify(chain.name)] : []), ...slugs(ofToken)])], gecko: [...new Set(gecko)] };
  };

  const protocolTvl: ToolDef = {
    name: "protocol_tvl",
    description: "A DeFi protocol's total value locked (TVL) from DefiLlama: current TVL, 1-day and 7-day change, TVL per chain and a daily history (its last point, now: true, is the live reading).",
    parameters: {
      type: "object",
      properties: {
        protocol: { type: "string", description: "Protocol name or DefiLlama slug, e.g. Aave or jupiter", pattern: QUERY },
        history_days: { type: "integer", description: "Days of daily TVL history (0-365, default 30)", minimum: 0, maximum: 365, default: 30 },
      },
      required: ["protocol"],
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal }) {
      const q = String(args.protocol);
      const days = Number(args.history_days ?? 30);
      const exactIn = (l: ProtoRow[]) => l.find((p) => p.slug === slugify(q)) ?? l.find((p) => p.name.toLowerCase() === q.toLowerCase());
      // the protocol's own page first, by its slug (the list when it is loaded, else the name as a slug): the list of
      // all protocols is waited for only when that page is not found
      let list = protocols.peek();
      let slug = (list && exactIn(list)?.slug) ?? slugify(q);
      let detail: Record<string, unknown> | null = null;
      try {
        detail = await protocolDetail(slug, signal);
      } catch (err) {
        if (!(err instanceof ToolFail) || err.code !== "not_found") return fromList(slug, q, err, signal);
      }
      if (!detail) {
        list = await protocols.get(signal).catch(() => [] as ProtoRow[]);
        const exact = exactIn(list);
        const found = exact && exact.slug !== slug ? exact : findProtocol(list, q);
        if (!found || found.slug === slug) return { ok: false, error: "not_found" };
        slug = found.slug;
        try {
          detail = await protocolDetail(slug, signal);
        } catch (err) {
          return fromList(slug, q, err, signal);
        }
      }
      const series = (detail.tvl as unknown[]).filter(isObj).map((p) => ({ t: num(p.date), v: num(p.totalLiquidityUSD) })).filter((p): p is { t: number; v: number } => p.t !== null && p.v !== null);
      const last = series[series.length - 1] ?? null;
      const at = (daysAgo: number) => (last ? [...series].reverse().find((p) => p.t <= last.t - daysAgo * 86400 + 3600) ?? null : null);
      const chainTvls = isObj(detail.currentChainTvls)
        ? Object.entries(detail.currentChainTvls)
            .filter(([k, v]) => realChain(k) && num(v) !== null && num(v)! > 0)
            .map(([chain, v]) => ({ chain, tvl_usd: Math.round(num(v)!) }))
            .sort((a, b) => b.tvl_usd - a.tvl_usd)
            .slice(0, 10)
        : [];
      let history: { date: string; tvl_usd: number; now?: true }[] = [];
      if (days > 0 && last) {
        const since = last.t - days * 86400;
        const pts = series.filter((p) => p.t >= since);
        const step = Math.max(1, Math.ceil(pts.length / 31));
        const byDate = new Map<string, number>(); // one point per day, the latest
        for (const p of pts.filter((_, i) => i % step === 0 || i === pts.length - 1)) byDate.set(new Date(p.t * 1000).toISOString().slice(0, 10), Math.round(p.v));
        history = [...byDate].map(([date, tvl_usd]) => ({ date, tvl_usd }));
        // DefiLlama's daily points are at 00:00 UTC and its last one is the live reading: said so, for a chart's "now"
        // point
        if (last.t % 86400 !== 0 && history.length) history[history.length - 1]!.now = true;
      }
      const row = list?.find((p) => p.slug === slug);
      const link = llamaProtocol(slug);
      return ok(
        {
          name: str(detail.name) ?? row?.name ?? q,
          slug,
          symbol: str(detail.symbol, 20),
          category: str(detail.category, 40) ?? row?.category ?? null,
          tvl_usd: last ? Math.round(last.v) : null,
          as_of: last ? new Date(last.t * 1000).toISOString() : null,
          change_1d_pct: pctChange(last?.v ?? null, at(1)?.v ?? null),
          change_7d_pct: pctChange(last?.v ?? null, at(7)?.v ?? null),
          mcap_usd: round(num(detail.mcap)),
          chains: chainTvls,
          history,
          link,
        },
        [src(`DefiLlama: ${str(detail.name) ?? slug}`, link)],
      );
    },
  };

  const topProtocols: ToolDef = {
    name: "top_protocols",
    description: "The largest DeFi protocols by TVL from DefiLlama, optionally on one chain or in one category (e.g. Lending, Dexs, Liquid Staking).",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "string", description: "Only protocols on this chain, e.g. Solana", pattern: QUERY },
        category: { type: "string", description: "Only this category, e.g. Lending", pattern: QUERY },
        limit: limitParam(10, 25, "protocols"),
      },
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal }) {
      const list = await protocols.get(signal);
      const chain = args.chain ? String(args.chain).toLowerCase() : null;
      const cat = args.category ? String(args.category).toLowerCase() : null;
      const val = (p: ProtoRow) => (chain ? Object.entries(p.chainTvls).find(([k]) => k.toLowerCase() === chain)?.[1] ?? 0 : p.tvl);
      const rows = list
        .filter((p) => (cat ? p.category?.toLowerCase() === cat : p.category !== "CEX"))
        .filter((p) => !chain || p.chains.some((c) => c.toLowerCase() === chain))
        .map((p) => ({ p, v: val(p) }))
        .filter((x) => x.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, Number(args.limit ?? 10))
        .map(({ p, v }, i) => ({
          rank: i + 1,
          name: p.name,
          slug: p.slug,
          category: p.category,
          tvl_usd: Math.round(v),
          change_1d_pct: round(p.change1d, 3),
          change_7d_pct: round(p.change7d, 3),
          link: llamaProtocol(p.slug),
        }));
      if (!rows.length) return { ok: false, error: "not_found" };
      const page = chain ? llamaChain(String(args.chain)) : LLAMA_PAGES.protocols;
      return ok({ chain: args.chain ?? null, category: args.category ?? null, protocols: rows }, [src("DefiLlama: protocol rankings", page)]);
    },
  };

  const chainTvl: ToolDef = {
    name: "chain_tvl_ranking",
    description: "Blockchains ranked by DeFi TVL from DefiLlama, or one chain's current TVL with its daily history.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "string", description: "One chain, e.g. Solana (leave out for the ranking)", pattern: QUERY },
        limit: limitParam(15, 40, "chains"),
      },
      additionalProperties: false,
    },
    ttlMs: 15 * MINUTE,
    async run(args, { signal }) {
      if (!args.chain) {
        const list = await chains.get(signal);
        const rows = [...list].sort((a, b) => b.tvl - a.tvl).slice(0, Number(args.limit ?? 15)).map((c, i) => ({ rank: i + 1, chain: c.name, tvl_usd: Math.round(c.tvl), token: c.symbol }));
        return ok({ chains: rows }, [src("DefiLlama: chains", LLAMA_PAGES.chains)]);
      }
      const c = await findChain(String(args.chain), signal);
      if (!c) return { ok: false, error: "not_found" };
      const raw = await get(`${API}/v2/historicalChainTvl/${encodeURIComponent(c.name)}`, signal, 8 * MB);
      if (!Array.isArray(raw)) throw new ToolFail("unavailable");
      const pts = raw.filter(isObj).map((p) => ({ t: num(p.date), v: num(p.tvl) })).filter((p): p is { t: number; v: number } => p.t !== null && p.v !== null);
      const last = pts[pts.length - 1] ?? null;
      const at = (d: number) => (last ? [...pts].reverse().find((p) => p.t <= last.t - d * 86400 + 3600) ?? null : null);
      const recent = pts.slice(-31).map((p) => ({ date: new Date(p.t * 1000).toISOString().slice(0, 10), tvl_usd: Math.round(p.v) }));
      const link = llamaChain(c.name);
      return ok(
        { chain: c.name, tvl_usd: Math.round(c.tvl), change_1d_pct: pctChange(last?.v ?? null, at(1)?.v ?? null), change_7d_pct: pctChange(last?.v ?? null, at(7)?.v ?? null), change_30d_pct: pctChange(last?.v ?? null, at(30)?.v ?? null), history: recent, link },
        [src(`DefiLlama: ${c.name}`, link)],
      );
    },
  };

  const volumeTool = (o: {
    name: string;
    description: string;
    noun: string;
    overview: (chain: string | null) => Dataset<VolumeOverview>;
    summaryPath: string;
    dataTypes: { key: string; type: string }[];
    page: string;
  }): ToolDef => ({
    name: o.name,
    description: o.description,
    parameters: {
      type: "object",
      properties: {
        protocol: { type: "string", description: "One protocol by name or DefiLlama slug (leave out for the ranking)", pattern: QUERY },
        chain: { type: "string", description: "Ranking on one chain only, e.g. Solana", pattern: QUERY },
        limit: limitParam(10, 25, "protocols"),
      },
      additionalProperties: false,
    },
    ttlMs: 15 * MINUTE,
    async run(args, { signal }) {
      if (args.protocol) {
        const q = String(args.protocol);
        let slug = slugify(q);
        const one = async (type: string) => {
          const raw = await get(`${API}/${o.summaryPath}/${encodeURIComponent(slug)}?dataType=${type}&excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`, signal, 8 * MB);
          if (!isObj(raw)) throw new ToolFail("unavailable");
          return raw;
        };
        let first: Record<string, unknown>;
        try {
          first = await one(o.dataTypes[0]!.type);
        } catch (err) {
          if (!(err instanceof ToolFail) || err.code !== "not_found") throw err;
          const ov = await o.overview(null).get(signal);
          const low = q.toLowerCase();
          const hit = ov.rows.find((r) => r.name.toLowerCase() === low) ?? ov.rows.filter((r) => r.name.toLowerCase().includes(low)).sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))[0];
          if (!hit) return { ok: false, error: "not_found" };
          slug = hit.slug;
          first = await one(o.dataTypes[0]!.type);
        }
        const totals = (raw: Record<string, unknown>) => ({
          "24h_usd": round(num(raw.total24h)),
          "7d_usd": round(num(raw.total7d)),
          "30d_usd": round(num(raw.total30d)),
          "1y_usd": round(num(raw.total1y)),
          all_time_usd: round(num(raw.totalAllTime)),
          change_1d_pct: round(num(raw.change_1d), 3),
        });
        const data: Record<string, unknown> = { name: str(first.displayName) ?? str(first.name) ?? q, slug, [o.dataTypes[0]!.key]: totals(first) };
        for (const dt of o.dataTypes.slice(1)) {
          try {
            data[dt.key] = totals(await one(dt.type));
          } catch {
            data[dt.key] = null;
          }
        }
        const link = llamaProtocol(slug);
        data.link = link;
        return ok(data, [src(`DefiLlama: ${String(data.name)}`, link)]);
      }
      const chain = args.chain ? String(args.chain) : null;
      let chainName: string | null = null;
      if (chain) {
        const c = await findChain(chain, signal);
        if (!c) return { ok: false, error: "not_found" };
        chainName = c.name;
      }
      const ov = await o.overview(chainName).get(signal);
      const rows = ov.rows
        .filter((r) => (r.total24h ?? 0) > 0)
        .sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))
        .slice(0, Number(args.limit ?? 10))
        .map((r, i) => ({
          rank: i + 1,
          name: r.name,
          slug: r.slug,
          category: r.category,
          [`${o.noun}_24h_usd`]: round(r.total24h),
          [`${o.noun}_7d_usd`]: round(r.total7d),
          [`${o.noun}_30d_usd`]: round(r.total30d),
          change_1d_pct: round(r.change1d, 3),
          link: llamaProtocol(r.slug),
        }));
      return ok(
        { chain: chainName, total_24h_usd: round(ov.total24h), total_7d_usd: round(ov.total7d), total_30d_usd: round(ov.total30d), protocols: rows },
        [src(`DefiLlama: ${o.noun}`, o.page)],
      );
    },
  });

  const fees = volumeTool({
    name: "protocol_fees_revenue",
    description: "Fees and revenue from DefiLlama: one protocol's fees and revenue (24h, 7d, 30d, 1y, all time), or the top protocols by fees, optionally on one chain.",
    noun: "fees",
    overview: feesOverview,
    summaryPath: "summary/fees",
    dataTypes: [
      { key: "fees", type: "dailyFees" },
      { key: "revenue", type: "dailyRevenue" },
    ],
    page: LLAMA_PAGES.fees,
  });

  const dexs = volumeTool({
    name: "dex_volume_ranking",
    description: "DEX trading volume from DefiLlama: the top DEXs by 24h volume (optionally on one chain), or one DEX's volume over 24h, 7d, 30d, 1y.",
    noun: "volume",
    overview: dexsOverview,
    summaryPath: "summary/dexs",
    dataTypes: [{ key: "volume", type: "dailyVolume" }],
    page: LLAMA_PAGES.dexs,
  });

  const yields: ToolDef = {
    name: "yield_pools",
    description: "DeFi yield pools from DefiLlama with APY and TVL, filtered by chain, project, token symbol or stablecoins only. APYs change constantly; facts, not investment advice.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "string", description: "Chain, e.g. Ethereum or Solana", pattern: QUERY },
        project: { type: "string", description: "Project slug, e.g. aave-v3 or kamino-lend", pattern: QUERY },
        symbol: { type: "string", description: "Token symbol in the pool, e.g. USDC", pattern: QUERY },
        stablecoin_only: { type: "boolean", description: "Only stablecoin pools (default false)", default: false },
        min_tvl_usd: { type: "number", description: "Minimum pool TVL in USD (default 1000000)", minimum: 0, maximum: 1e12, default: 1_000_000 },
        sort: { type: "string", description: "Order by apy or tvl (default apy)", enum: ["apy", "tvl"], default: "apy" },
        limit: limitParam(10, 25, "pools"),
      },
      additionalProperties: false,
    },
    ttlMs: 15 * MINUTE,
    async run(args, { signal }) {
      const list = await pools.get(signal);
      const chain = args.chain ? String(args.chain).toLowerCase() : null;
      const project = args.project ? slugify(String(args.project)) : null;
      const symbol = args.symbol ? String(args.symbol).toUpperCase() : null;
      const minTvl = Number(args.min_tvl_usd ?? 1_000_000);
      const byTvl = args.sort === "tvl";
      const rows = list
        .filter((p) => p.tvl >= minTvl)
        .filter((p) => !chain || p.chain.toLowerCase() === chain)
        .filter((p) => !project || p.project === project || p.project.startsWith(project))
        .filter((p) => !symbol || p.symbol.toUpperCase().split(/[-/ ]/).includes(symbol) || p.symbol.toUpperCase() === symbol)
        .filter((p) => !args.stablecoin_only || p.stablecoin)
        .filter((p) => byTvl || (!p.outlier && p.apy !== null))
        .sort((a, b) => (byTvl ? b.tvl - a.tvl : (b.apy ?? 0) - (a.apy ?? 0)))
        .slice(0, Number(args.limit ?? 10))
        .map((p) => ({
          project: p.project,
          chain: p.chain,
          symbol: p.symbol,
          tvl_usd: Math.round(p.tvl),
          apy_pct: round(p.apy, 4),
          apy_base_pct: round(p.apyBase, 4),
          apy_reward_pct: round(p.apyReward, 4),
          apy_mean_30d_pct: round(p.apyMean30d, 4),
          stablecoin: p.stablecoin,
          il_risk: p.ilRisk,
          link: llamaYieldPool(p.pool),
        }));
      if (!rows.length) return { ok: false, error: "not_found" };
      return ok({ pools: rows }, [src("DefiLlama: yields", LLAMA_PAGES.yields)]);
    },
  };

  const stablecoins: ToolDef = {
    name: "stablecoin_supply",
    description: "Stablecoins by circulating supply from DefiLlama (peg type, mechanism, 1-day and 7-day change, price), or one stablecoin with its supply per chain.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "One stablecoin, e.g. USDC (leave out for the ranking)", pattern: QUERY },
        limit: limitParam(10, 25, "stablecoins"),
      },
      additionalProperties: false,
    },
    ttlMs: 30 * MINUTE,
    async run(args, { signal }) {
      const list = await stables.get(signal);
      const shape = (s: StableRow, i?: number) => ({
        ...(i !== undefined ? { rank: i + 1 } : {}),
        name: s.name,
        symbol: s.symbol,
        peg_type: s.pegType,
        mechanism: s.mechanism,
        circulating_usd: Math.round(s.circulating),
        change_1d_pct: pctChange(s.circulating, s.prevDay),
        change_7d_pct: pctChange(s.circulating, s.prevWeek),
        price_usd: round(s.price, 5),
      });
      if (args.symbol) {
        const sym = String(args.symbol).toUpperCase();
        const s = list.filter((x) => x.symbol.toUpperCase() === sym).sort((a, b) => b.circulating - a.circulating)[0];
        if (!s) return { ok: false, error: "not_found" };
        return ok({ ...shape(s), chains: s.chains.map((c) => ({ chain: c.chain, circulating_usd: Math.round(c.usd) })) }, [src("DefiLlama: stablecoins", LLAMA_PAGES.stablecoins)]);
      }
      const rows = [...list].sort((a, b) => b.circulating - a.circulating).slice(0, Number(args.limit ?? 10)).map((s, i) => shape(s, i));
      return ok({ stablecoins: rows }, [src("DefiLlama: stablecoins", LLAMA_PAGES.stablecoins)]);
    },
  };

  return [protocolTvl, topProtocols, chainTvl, fees, dexs, yields, stablecoins, unlockScheduleTool(fc, unlockSlugs)];
}
