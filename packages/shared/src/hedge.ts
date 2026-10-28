// Hedged requests: a request that is safe to send twice goes again on a fresh connection when the first is slow or
// fails, and the first good answer wins. For flaky networks and slow free APIs alike.

import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

/** A fresh dispatcher of one connection, for a leg that must not reuse a hung keep-alive socket */
function freshDispatcher(): Agent {
  return new Agent({ connections: 1 });
}

function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || /^127\./.test(h) || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

interface HedgeLeg {
  /** 0 for the first attempt */
  n: number;
  /** Aborted when another leg wins, or when the caller's signal aborts */
  signal: AbortSignal;
  /** The leg's own fresh dispatcher; undefined = use the process-wide pooled one (only the first leg, with pooledFirst) */
  dispatcher: Dispatcher | undefined;
}

interface HedgeOptions<T = unknown> {
  /**
   * Another leg starts when none has answered this long after the last one started (default 4000 ms). Infinity: never
   * for slowness, only after a leg failed in the network (for a call that may legitimately take long, or that is billed
   * or rate limited upstream).
   */
  waveMs?: number;
  /** Legs at most, the first included (default 3) */
  waves?: number;
  /** After a leg failed, the next one starts after this long (default 250 ms) */
  retryGapMs?: number;
  signal?: AbortSignal | null;
  /**
   * An error that is the server's answer (an HTTP status): no other leg can change it, so it ends the hedge at once,
   * unless an earlier leg is still waiting (a duplicate's 429 must not cancel the original): then it waits for that.
   */
  final?: (err: unknown) => boolean;
  /**
   * A result that is an answer but not a good one (an HTTP error status). Like a `final` error: it wins only when no
   * earlier leg is still waiting; otherwise it is held while the earlier legs finish (a good result from one of them
   * wins, else the held one is the answer). No new leg starts once one is held.
   */
  weak?: (value: T) => boolean;
  /** The first leg on the process-wide pooled dispatcher (keep-alive; default true); every later leg on a fresh one */
  pooledFirst?: boolean;
  /** Called with a leg's result that came after another leg won (e.g. cancel a Response's body) */
  discard?: (value: T) => void;
  /** A fresh leg's dispatcher (default freshDispatcher()) */
  dispatcher?: () => Dispatcher;
  /** Each leg as it starts: why ("first", "slow": nothing after waveMs, "failed": the previous leg failed) */
  onLeg?: (n: number, why: "first" | "slow" | "failed") => void;
  /**
   * Asked before every leg after the first (a hedge leg is a request upstream too: count it against the caller's rate
   * limit or quota); false = that leg is not sent and no other leg follows.
   */
  admitLeg?: (n: number, why: "slow" | "failed") => boolean;
}

/** setTimeout's largest delay; a longer wave (Infinity) means no leg for slowness at all. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Run `run` and, for a request that is safe to send twice, run it again on a fresh dispatcher when no leg has answered
 * within `waveMs` (or right after a leg failed), at most `waves` legs; the first good result wins and every other leg is
 * aborted and its dispatcher destroyed. The winner's own dispatcher is closed gracefully (a body still streaming
 * finishes). A `weak` result or a `final` error counts only when no earlier leg is still waiting. Rejects with the last
 * leg's error, a `final` error, or the caller's abort reason.
 */
function hedge<T>(run: (leg: HedgeLeg) => Promise<T>, opts: HedgeOptions<T> = {}): Promise<T> {
  const waveMs = Math.max(0, opts.waveMs ?? 4_000);
  const waves = Math.max(1, Math.floor(opts.waves ?? 3));
  const gapMs = Math.max(0, opts.retryGapMs ?? 250);
  const pooledFirst = opts.pooledFirst !== false;
  const make = opts.dispatcher ?? (() => freshDispatcher());
  const signal = opts.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    interface Leg {
      n: number;
      ac: AbortController;
      d: Dispatcher | undefined;
      pending: boolean;
    }
    type Outcome = { ok: true; v: T } | { ok: false; err: unknown };
    const legs: Leg[] = [];
    let done = false;
    /** No more legs: one is held, or a leg was refused by admitLeg */
    let closed = false;
    let held: { leg: Leg; out: Outcome } | null = null;
    let lastErr: unknown;
    let waveTimer: NodeJS.Timeout | undefined;
    let gapTimer: NodeJS.Timeout | undefined;
    const release = (l: Leg) => {
      l.ac.abort();
      if (l.d) void l.d.destroy().catch(() => {});
    };
    const dropHeld = (h: { leg: Leg; out: Outcome }) => {
      if (h.out.ok) opts.discard?.(h.out.v);
      release(h.leg);
    };
    /** The answer: `winner`'s outcome (or a plain rejection); every other leg is aborted, a held result discarded. */
    const settle = (winner: Leg | null, out: Outcome) => {
      done = true;
      clearTimeout(waveTimer);
      clearTimeout(gapTimer);
      signal?.removeEventListener("abort", onAbort);
      if (held && held.leg !== winner) dropHeld(held);
      held = null;
      for (const l of legs) if (l !== winner) release(l);
      if (out.ok) {
        if (winner?.d) void winner.d.close().catch(() => {});
        resolve(out.v);
      } else reject(out.err);
    };
    const earlierPending = (n: number) => legs.some((l) => l.n < n && l.pending);
    const anyPending = () => legs.some((l) => l.pending);
    /** A weak result or a final error: the answer unless an earlier leg is still waiting, then held (the earliest kept). */
    const answerOrHold = (leg: Leg, out: Outcome) => {
      if (!earlierPending(leg.n)) return settle(leg, out);
      closed = true;
      clearTimeout(waveTimer);
      clearTimeout(gapTimer);
      if (held && held.leg.n < leg.n) {
        if (out.ok) opts.discard?.(out.v);
        return release(leg);
      }
      if (held) dropHeld(held);
      held = { leg, out };
    };
    /** Nothing more can come from a new leg: the held answer when every earlier leg is done, the last error when all are. */
    const settleIfOver = () => {
      if (done) return;
      if (held && !earlierPending(held.leg.n)) return settle(held.leg, held.out);
      if (!anyPending() && (closed || legs.length >= waves)) settle(null, { ok: false, err: lastErr });
    };
    const onAbort = () => {
      if (done) return;
      settle(null, { ok: false, err: signal!.reason });
    };
    const launch = (why: "first" | "slow" | "failed") => {
      if (done || closed || legs.length >= waves) return;
      clearTimeout(gapTimer);
      gapTimer = undefined;
      const n = legs.length;
      if (n > 0 && why !== "first" && opts.admitLeg && !opts.admitLeg(n, why)) {
        closed = true;
        clearTimeout(waveTimer);
        return settleIfOver();
      }
      const leg: Leg = { n, ac: new AbortController(), d: n === 0 && pooledFirst ? undefined : make(), pending: true };
      legs.push(leg);
      clearTimeout(waveTimer);
      if (legs.length < waves && waveMs < MAX_TIMER_MS) waveTimer = setTimeout(() => launch("slow"), waveMs);
      opts.onLeg?.(n, why);
      const s = signal ? AbortSignal.any([signal, leg.ac.signal]) : leg.ac.signal;
      let p: Promise<T>;
      try {
        p = Promise.resolve(run({ n, signal: s, dispatcher: leg.d }));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (v) => {
          leg.pending = false;
          if (done) {
            opts.discard?.(v);
            if (leg.d) void leg.d.destroy().catch(() => {});
            return;
          }
          if (opts.weak?.(v)) {
            answerOrHold(leg, { ok: true, v });
            return settleIfOver();
          }
          settle(leg, { ok: true, v });
        },
        (err: unknown) => {
          leg.pending = false;
          if (leg.d) void leg.d.destroy().catch(() => {});
          if (done) return;
          if (signal?.aborted) return onAbort();
          if (opts.final?.(err)) {
            answerOrHold(leg, { ok: false, err });
            return settleIfOver();
          }
          lastErr = err;
          if (!closed && legs.length < waves) {
            // more legs may start, so nothing is held (a held answer closes the hedge)
            if (!gapTimer) gapTimer = setTimeout(() => launch("failed"), gapMs);
            return;
          }
          settleIfOver();
        },
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    launch("first");
  });
}

export interface HedgedFetchOptions {
  /**
   * Another attempt starts when no response (status and headers) came this long after the last one (default 4000 ms).
   * Infinity: only after an attempt failed in the network, never because one is slow.
   */
  waveMs?: number;
  /** Attempts at most (default 3) */
  waves?: number;
  /** The first attempt on the process-wide pooled dispatcher (keep-alive; default true) */
  pooledFirst?: boolean;
  /** Hedge a loopback URL too (tests; default false: loopback gets one plain fetch) */
  loopback?: boolean;
  /** Asked before every attempt after the first (count it against a rate limit or quota); false = not sent, none follows */
  admitLeg?: HedgeOptions["admitLeg"];
}

/** A body that can be sent again as it is (a stream cannot). */
function replayable(body: unknown): boolean {
  return body == null || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof URLSearchParams;
}

/**
 * fetch() for a request that is SAFE TO SEND TWICE (a GET, an RPC read, a read-only data tool): when no response came
 * `waveMs` after the last attempt started, or an attempt failed (a reset after the request went out), the request goes
 * again on a FRESH connection, at most `waves` attempts; the first response wins and every other attempt is cancelled
 * (hedge()). A response with an error status (a 429, a 5xx) is the answer only when no earlier attempt is still waiting:
 * a duplicate's 429 never cancels the original. A cancelled attempt may still be billed by the server, so this only adds
 * requests when one is already slow (or failed); `admitLeg` counts them against the caller's limits. Never for a request
 * whose lost response may have succeeded (a post, a message, a transaction). Loopback URLs and stream bodies get one
 * plain fetch.
 */
export async function hedgedFetch(url: string, init: RequestInit = {}, opts: HedgedFetchOptions = {}): Promise<Response> {
  if ((isLoopbackUrl(url) && !opts.loopback) || !replayable(init.body)) return (await undiciFetch(url, init as never)) as unknown as Response;
  return await hedge<Response>(
    ({ signal, dispatcher }) => undiciFetch(url, { ...(init as object), signal, ...(dispatcher ? { dispatcher } : {}) } as never) as unknown as Promise<Response>,
    {
      waveMs: opts.waveMs ?? 4_000,
      waves: opts.waves ?? 3,
      signal: init.signal ?? null,
      pooledFirst: opts.pooledFirst ?? true,
      weak: (r) => !r.ok,
      discard: (r) => void r.body?.cancel().catch(() => {}),
      ...(opts.admitLeg ? { admitLeg: opts.admitLeg } : {}),
    },
  );
}

