// What the free providers share: the guarded HTTP client, a limiter per provider, bulk datasets kept
// in memory (stale-while-revalidate, never older than 24 h) and small value helpers.

import type { Http } from "../http.ts";
import type { WindowLimiter } from "../limits.ts";
import { DAY, ToolFail } from "../types.ts";

export interface FreeContext {
  http: Http;
  now: () => number;
  /** Per-provider limiters; a call over the limit is "rate_limited" (rugcheck, goplus: the security check, free/security.ts; hub: the data hub, free/hub.ts; pump: pump.fun's API, free/pumpcallouts.ts) */
  limit: { llama: WindowLimiter; dexscreener: WindowLimiter; gecko: WindowLimiter; rpc: WindowLimiter; polymarket: WindowLimiter; jupiter: WindowLimiter; xsearch: WindowLimiter; news: WindowLimiter; launch: WindowLimiter; rugcheck: WindowLimiter; goplus: WindowLimiter; hub: WindowLimiter; pump: WindowLimiter };
  /** Load the big shared lists in the background at start (never in tests) */
  warm?: boolean;
  /** The module's log (a provider's own line: the launch read's pages and refusals) */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * Our own narrative label of a Solana coin (free/narratives.ts sets it): the pump.fun index's card, as its file last read
   * (a read due starts for the next ask); null for a coin it does not label. The CT radar's narratives group the called
   * coins by it (free/ctradar.ts)
   */
  narrativeOf?: (mint: string) => { narrative: string | null; group: string | null } | null;
  /**
   * An address's first transaction (jsonParsed, as getTransaction gives it) in one call of Helius's history read,
   * oldest first, over the launch keys (free/launch.ts sets it): a mint's creator whatever its age, where paging its
   * signatures newest first gave up past 5,000; absent without the keys
   */
  firstTx?: (address: string, signal: AbortSignal, tag?: CallTag) => Promise<{ signature: string; tx: Record<string, unknown> } | null>;
  /**
   * An address's newest successful transactions, `limit` at most (jsonParsed, as getTransaction gives them), in one
   * call of Helius's history read over the launch keys (free/launch.ts sets it; absent without the keys): 10 credits
   * for up to 100, where its signatures and each transaction alone cost 1 + `limit`
   */
  newestTxs?: (address: string, limit: number, signal: AbortSignal, tag?: CallTag) => Promise<Record<string, unknown>[]>;
  /**
   * The launch keys as the launch read holds them (free/launch.ts sets it; absent without the keys), for the tools' rpc
   * pool, which carries them too (LAUNCH_KEY_WEIGHT): a key's state by its URL (null for any other endpoint), a 429 it
   * answered (a key out of credits says so in its body), and an answer it gave, booked under the key, the tool and the
   * asker
   */
  launchKeys?: {
    state(url: string): "ready" | "resting" | "spent" | null;
    limited(url: string, body: string): void;
    answered(url: string, method: string, params: unknown, result: unknown, tag?: CallTag): void;
  };
  /**
   * A pump.fun callout by its id (free/pumpcallouts.ts sets it): when pump.fun recorded it (epoch ms), its coin and its
   * author's wallet, read once and kept; null when pump.fun has no such callout. call_frontrun and caller_side_wallets
   * read a callout as the call (frontrun.ts)
   */
  pumpCallout?: (id: string, signal: AbortSignal) => Promise<{ id: string; mint: string; wallet: string; atMs: number } | null>;
}

/** What a Helius call's credits are booked under (tools_helius_spend): the tool, and the asker's kind (RunIO.caller) */
export interface CallTag {
  tool: string;
  caller?: string;
}

/** Reject with "unavailable" when the signal fires first. */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolFail("unavailable"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ToolFail("unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * A bulk download (all protocols, all yield pools…) kept trimmed in memory for `ttlMs`. A stale copy
 * (up to 24 h old) is served while a refresh runs; the download has its own longer timeout so a slow
 * first load still lands in memory for the next call even when this call gave up.
 */
export class Dataset<T> {
  private value: T | null = null;
  private at = 0;
  private loading: Promise<T> | null = null;

  private readonly ttlMs: number;
  private readonly load: (signal: AbortSignal) => Promise<T>;
  private readonly now: () => number;
  private readonly loadTimeoutMs: number;

  constructor(ttlMs: number, load: (signal: AbortSignal) => Promise<T>, now: () => number, loadTimeoutMs = 25_000) {
    this.ttlMs = ttlMs;
    this.load = load;
    this.now = now;
    this.loadTimeoutMs = loadTimeoutMs;
  }

  async get(signal: AbortSignal): Promise<T> {
    const age = this.now() - this.at;
    if (this.value !== null && age < this.ttlMs) return this.value;
    if (!this.loading) this.start(this.loadTimeoutMs);
    if (this.value !== null && age < DAY) return this.value;
    return raceAbort(this.loading!, signal);
  }

  /** What is loaded (fresh, or stale under a day) without waiting; null before the first load. */
  peek(): T | null {
    return this.value !== null && this.now() - this.at < DAY ? this.value : null;
  }

  /** Load now, in the background (at start: the first call then finds it loaded); a failure waits for the next get(). */
  warm(timeoutMs = this.loadTimeoutMs): void {
    if (this.value === null && !this.loading) this.start(timeoutMs);
  }

  private start(timeoutMs: number): void {
    const p = this.load(AbortSignal.timeout(timeoutMs)).then((v) => {
      this.value = v;
      this.at = this.now();
      return v;
    });
    this.loading = p;
    p.catch(() => {}).finally(() => {
      if (this.loading === p) this.loading = null;
    });
  }
}

export function take(l: WindowLimiter): void {
  if (!l.take()) throw new ToolFail("rate_limited");
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** Round to a sensible number of significant digits for the model (keeps tokens down). */
export function round(v: number | null | undefined, digits = 4): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v);
  const p = Math.pow(10, Math.max(0, digits - Math.ceil(Math.log10(abs))));
  return Math.round(v * p) / p;
}

export const pctChange = (now: number | null, then: number | null): number | null =>
  now !== null && then !== null && then !== 0 ? round(((now - then) / then) * 100, 3) : null;

/** A trimmed, capped string without format characters (zero-width, bidi controls), or null */
export const str = (v: unknown, max = 80): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\p{Cf}/gu, "").trim();
  return s ? s.slice(0, max) : null;
};

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
