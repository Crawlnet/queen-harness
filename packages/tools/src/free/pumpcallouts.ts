// pump.fun's own callouts: a callout is a holder's post that calls a coin on its pump.fun page (their thesis, its time,
// the coin's price then), and it earns its author rewards from the buys it brings. Most callers post their calls there,
// so a call's exact time is pump.fun's own record, and the side wallet tools (frontrun.ts) read a callout as the call
// (fc.pumpCallout). Read from pump.fun's public web API (frontend-api-v3.pump.fun: no login, no key):
//   - GET /callout/list/{wallet}: a user's callouts, newest first, 100 a page;
//   - GET /users/{wallet or username}: who the user is; GET /users/{wallet}/callout-stats: their callouts counted (all
//     time, 30 days, 7 days; its "daily" window is left out: unreliable);
//   - GET /callout/coin/{mint}: a coin's top callouts by how far the coin rose after each, 100 at most;
//   - GET /callout/user/{wallet}/mint/{mint}: a user's live callout on a coin (one a coin: pump.fun refuses a second);
//   - GET /callout/{id}: one callout with its author;
//   - POST /coins-v2/mints: the coins' symbols; POST /users/batch: the names of a coin's callers. pump.fun limits
//     requests by IP (60 a minute on its callout routes, 30 on its users' and coins'), and its edge blocks a burst of
//     list pages for about 10 min: every request takes one limiter (PUMP_PER_MIN, every caller together), a user is
//     read one page a call, a request is sent again only after a network failure (registry.ts toolsHedge), and a 429
//     rests its route until its Retry-After.

import { MB, readCapped } from "../http.ts";
import { pumpCallout, pumpCalloutId, src, uniqueSources } from "../links.ts";
import { limitParam, SOL_ADDRESS } from "../schema.ts";
import { MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, round, take, type FreeContext } from "./common.ts";
import { cleanName, cleanThesis, retryAfterMs } from "./clean.ts";

export const PUMP_API_HOST = "frontend-api-v3.pump.fun";
const BASE = `https://${PUMP_API_HOST}`;
/** Requests a minute at most, every caller together: under pump.fun's own 30 on its users' and coins' routes */
export const PUMP_PER_MIN = 20;
/** A user's list page: pump.fun serves 100 at most */
const PAGE = 100;
/** A coin's callouts: pump.fun's top 100 at most */
const COIN_TOP = 100;
/** Callouts kept by id for a call's time (frontrun.ts): a callout's time, coin and author never change */
const KEPT_MAX = 5000;
/** A route's rest after a 429 that says no Retry-After, and the least one asked for is believed */
const REST_MS = MINUTE;
const REST_MIN_MS = 10_000;
/**
 * pump.fun's API behind its edge's bot challenge: pump_callouts is not offered for this long (ToolDef.down), so no
 * answer spends a call on it, then offered again
 */
const CHALLENGE_REST_MS = 30 * MINUTE;
/** The largest answer read */
const BODY_MAX = 2 * MB;

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** pump.fun's usernames (its site: 1-15 letters, digits or underscores; a little longer allowed for older ones) */
const USERNAME = /^[A-Za-z0-9_]{1,30}$/;
/** A coin a callout calls: a Solana mint, an EVM token, a perp's name (BTC, xyz:TSLA) */
const COIN = /^[A-Za-z0-9:._-]{1,64}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const USER_PATTERN = "^(?:@?[A-Za-z0-9_]{1,30}|[1-9A-HJ-NP-Za-km-z]{32,44}|(?:https?://)?(?:www\\.)?pump\\.fun/profile/[A-Za-z0-9_]{1,44}/?(?:[?#]\\S*)?)$";

/** One callout as read here */
export interface PumpCallout {
  id: string;
  /** The coin it calls */
  mint: string;
  /** Its author's wallet */
  wallet: string;
  /** When pump.fun recorded it, epoch ms */
  atMs: number;
  /** Its text, cleaned (clean.ts cleanThesis: none when it holds a bare link) */
  text: string | null;
  /** The coin's market cap at the call, USD */
  mcapUsd: number | null;
  /** The coin's price now over its price at the call */
  nowX: number | null;
  /** The most the price rose after the call, and when */
  peakX: number | null;
  peakAtMs: number | null;
  /** pump.fun users whose buys it credits to the callout, and their PnL over its first hour (USD); null: not tracked */
  tailBuyers: number | null;
  tailPnl1hUsd: number | null;
}

interface PumpUser {
  wallet: string;
  username: string | null;
  x: string | null;
  followers: number | null;
}

type Coins = Map<string, { symbol: string | null; name: string | null }>;

/** A user as given: a wallet, a pump.fun username (an @ dropped) or a profile link's name or wallet; null for anything else */
export function userRef(v: unknown): { wallet: string } | { username: string } | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const named = (/^(?:https?:\/\/)?(?:www\.)?pump\.fun\/profile\/([^/?#\s]+)/i.exec(s)?.[1] ?? s).replace(/^@/, "");
  if (WALLET.test(named)) return { wallet: named };
  return USERNAME.test(named) ? { username: named } : null;
}

/** One callout of pump.fun's answer as read here; null without an id, a coin, an author's wallet or a time */
export function calloutOf(v: unknown): PumpCallout | null {
  if (!isObj(v)) return null;
  const id = pumpCalloutId(v.calloutId);
  const mint = typeof v.coinMint === "string" && COIN.test(v.coinMint) ? v.coinMint : null;
  const wallet = typeof v.userId === "string" && WALLET.test(v.userId) ? v.userId : null;
  const atMs = num(v.createdAt);
  if (!id || !mint || !wallet || atMs === null || atMs <= 0) return null;
  const peakAt = typeof v.maxMultiplierAt === "string" ? Date.parse(v.maxMultiplierAt) : NaN;
  return {
    id,
    mint,
    wallet,
    atMs,
    text: typeof v.thesis === "string" ? cleanThesis(v.thesis) : null,
    mcapUsd: num(v.marketCap),
    nowX: num(v.multiple),
    peakX: num(v.maxMultiplier),
    peakAtMs: Number.isFinite(peakAt) ? peakAt : null,
    tailBuyers: num(v.tailBuyers),
    tailPnl1hUsd: num(v.tailPnl1hUsd),
  };
}

/** A user row of pump.fun (GET /users/{id}, POST /users/batch) as read here; null without a wallet */
function userOfRow(v: unknown): PumpUser | null {
  if (!isObj(v)) return null;
  const wallet = [v.address, v.canonical_svm_wallet].find((w): w is string => typeof w === "string" && WALLET.test(w));
  if (!wallet) return null;
  const x = typeof v.x_username === "string" && X_HANDLE.test(v.x_username) ? v.x_username : null;
  return { wallet, username: typeof v.username === "string" ? cleanName(v.username) : null, x, followers: num(v.followers) };
}

/** pump.fun's own counts of a user's callouts (callout-stats): all time, 30 days, 7 days; null for a window it left out */
function countsOf(v: unknown): { total: number | null; d30: number | null; d7: number | null } {
  const of = (w: unknown) => (isObj(v) && isObj(w) ? num(w.totalCallouts) : null);
  return isObj(v) ? { total: of(v.allTime), d30: of(v.monthly), d7: of(v.weekly) } : { total: null, d30: null, d7: null };
}

const iso = (ms: number) => new Date(ms).toISOString();

export function pumpCalloutsTools(fc: FreeContext): ToolDef[] {
  /** Callouts read, by id (the oldest first): a call's time for frontrun.ts, read once */
  const kept = new Map<string, PumpCallout>();
  const keep = (rows: PumpCallout[]): void => {
    for (const r of rows) {
      kept.delete(r.id);
      kept.set(r.id, r);
    }
    while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
  };
  /** Until when each route rests after pump.fun's 429 */
  const resting = new Map<string, number>();
  /** Until when pump.fun's API is taken as behind its challenge */
  let challengedUntil = 0;

  /** One request to pump.fun's API: its JSON; null for a 404 or a 400 (no such user, callout or coin) */
  async function get(route: string, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    if (fc.now() < (resting.get(route) ?? 0)) throw new ToolFail("rate_limited");
    take(fc.limit.pump);
    const res = await fc.http.raw(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 404 || res.status === 400) return null;
      if (res.status === 403) {
        if (fc.now() >= challengedUntil) fc.log?.("tools: pump.fun's api is behind a challenge; pump_callouts is not offered", { min: CHALLENGE_REST_MS / MINUTE });
        challengedUntil = fc.now() + CHALLENGE_REST_MS;
        throw new ToolFail("unavailable");
      }
      if (res.status === 429) {
        const asked = res.headers.get("retry-after");
        const ms = Math.max(REST_MIN_MS, asked ? retryAfterMs(asked, fc.now()) : REST_MS);
        resting.set(route, fc.now() + ms);
        fc.log?.("tools: pump.fun rests a route", { route, s: Math.round(ms / 1000) });
        throw new ToolFail("rate_limited");
      }
      throw new ToolFail("unavailable");
    }
    try {
      return JSON.parse(await readCapped(res, BODY_MAX)) as unknown;
    } catch (err) {
      if (err instanceof ToolFail) throw err;
      throw new ToolFail("unavailable");
    }
  }

  const callouts = (v: unknown): PumpCallout[] => (isObj(v) && Array.isArray(v.callouts) ? v.callouts.map(calloutOf).filter((c): c is PumpCallout => c !== null) : []);
  const userOf = async (id: string, signal: AbortSignal): Promise<PumpUser | null> => userOfRow(await get("users", `/users/${encodeURIComponent(id)}`, signal));

  /** The coins' symbols and names, one request (pump.fun's registry: a mint it cannot read is left out); none when it fails */
  async function coinsOf(mints: string[], signal: AbortSignal): Promise<Coins> {
    const out: Coins = new Map();
    const want = [...new Set(mints)].filter((m) => WALLET.test(m) || /^0x[0-9a-fA-F]{40}$/.test(m));
    if (!want.length) return out;
    try {
      const raw = await get("coins", "/coins-v2/mints", signal, { mints: want, includeLiveStreamInfo: false });
      for (const c of Array.isArray(raw) ? raw.filter(isObj) : []) {
        if (typeof c.mint === "string" && want.includes(c.mint)) out.set(c.mint, { symbol: cleanName(typeof c.symbol === "string" ? c.symbol : null, 20), name: cleanName(typeof c.name === "string" ? c.name : null, 40) });
      }
    } catch {
      // symbols left out
    }
    return out;
  }

  /** The users behind wallets, one request; none when it fails */
  async function usersOf(wallets: string[], signal: AbortSignal): Promise<Map<string, PumpUser>> {
    const out = new Map<string, PumpUser>();
    const want = [...new Set(wallets)].slice(0, 100);
    if (!want.length) return out;
    try {
      const raw = await get("users", "/users/batch", signal, { addresses: want });
      for (const u of (Array.isArray(raw) ? raw : []).map(userOfRow)) if (u) out.set(u.wallet, u);
    } catch {
      // names left out
    }
    return out;
  }

  /** One callout by its id, with its author: kept for the next ask */
  async function byId(id: string, signal: AbortSignal): Promise<{ callout: PumpCallout; author: PumpUser } | null> {
    const raw = await get("callout", `/callout/${id}`, signal);
    const c = isObj(raw) ? calloutOf(raw.callout) : null;
    if (!c || !isObj(raw) || !isObj(raw.callout)) return null;
    keep([c]);
    const a = raw.callout;
    const x = typeof a.xUsername === "string" && X_HANDLE.test(a.xUsername) ? a.xUsername : null;
    return { callout: c, author: { wallet: c.wallet, username: typeof a.userName === "string" ? cleanName(a.userName) : null, x, followers: null } };
  }

  // a call's time for call_frontrun and caller_side_wallets: a callout read before costs nothing
  fc.pumpCallout = async (given, signal) => {
    const id = pumpCalloutId(given);
    const c = id ? (kept.get(id) ?? (await byId(id, signal))?.callout ?? null) : null;
    return c ? { id: c.id, mint: c.mint, wallet: c.wallet, atMs: c.atMs } : null;
  };

  const userOut = (u: PumpUser | null, wallet: string) => ({ wallet, username: u?.username ?? null, x: u?.x ? `@${u.x}` : null, pump_followers: u?.followers ?? null });

  /** A callout as the model reads it */
  function row(c: PumpCallout, coins: Coins, author: PumpUser | null | undefined) {
    return {
      id: c.id,
      at: iso(c.atMs),
      mint: c.mint,
      symbol: coins.get(c.mint)?.symbol ?? null,
      author: author?.username ?? null,
      author_wallet: c.wallet,
      text: c.text,
      mcap_at_call_usd: round(c.mcapUsd),
      peak_x: round(c.peakX, 3),
      peak_s_after: c.peakAtMs !== null && c.peakAtMs >= c.atMs ? Math.round((c.peakAtMs - c.atMs) / 1000) : null,
      now_x: round(c.nowX, 3),
      ...(c.tailBuyers !== null ? { tail_buyers: c.tailBuyers } : {}),
      ...(c.tailPnl1hUsd !== null ? { tail_pnl_1h_usd: round(c.tailPnl1hUsd) } : {}),
      link: pumpCallout(c.mint, c.id),
    };
  }

  const NOTE =
    "a callout is a holder's post calling a coin on its pump.fun page, in their own words (claims, not facts). at: when pump.fun recorded it, the call's exact time (its link or id is a call for call_frontrun and caller_side_wallets); mcap_at_call_usd: the market cap then; peak_x: the most the price rose after it, peak_s_after seconds later; now_x: the price now against the call's; tail_buyers: pump.fun users whose buys it credits to the callout, tail_pnl_1h_usd their PnL in its first hour";

  function answer(data: Record<string, unknown>, shown: PumpCallout[], coins: Coins): Outcome {
    const sources = uniqueSources(shown.slice(0, 3).map((c) => src(`pump.fun callout: ${coins.get(c.mint)?.symbol ?? "coin"}`, pumpCallout(c.mint, c.id))));
    return { ok: true, data: { ...data, note: NOTE }, sources };
  }

  const tool: ToolDef = {
    name: "pump_callouts",
    description:
      "pump.fun's own callouts (a holder's post calling a coin on its pump.fun page) with their exact times: a user's (wallet, pump.fun username or profile link) newest first, with how many callouts they made and on how many coins; a coin's top callouts; one user's callout on a coin; or one callout by its link. Each: when (ISO), the coin's mint and symbol, the author, their text, the market cap then, the peak after, the buyers it brought, its link. A callout's link or id is a call's exact time: who bought before it is read from it.",
    parameters: {
      type: "object",
      properties: {
        user: { type: "string", description: "The caller on pump.fun: their wallet, pump.fun username (often their X handle, not always: the answer's user.x is the X account it linked) or profile link (pump.fun/profile/<name>)", pattern: USER_PATTERN, maxLength: 120 },
        mint: { type: "string", description: "A coin's mint: its top callouts; with user, that user's callout on it", pattern: SOL_ADDRESS },
        callout: { type: "string", description: "One callout: its link (pump.fun/coin/<mint>?highlight_callout=<id> or pump.fun/callouts/<mint>/<id>) or id", minLength: 36, maxLength: 200 },
        limit: limitParam(20, 50, "callouts"),
      },
      additionalProperties: false,
    },
    ttlMs: 2 * MINUTE,
    down: () => fc.now() < challengedUntil,
    async run(args, { signal }): Promise<Outcome> {
      const limit = Number(args.limit ?? 20);
      const mint = typeof args.mint === "string" ? args.mint : null;
      const one = typeof args.callout === "string" ? pumpCalloutId(args.callout) : null;
      if (typeof args.callout === "string" && !one) return { ok: false, error: "bad_args", message: "callout must be a pump.fun callout's link or id" };
      const ref = typeof args.user === "string" ? userRef(args.user) : null;
      if (typeof args.user === "string" && !ref) return { ok: false, error: "bad_args", message: "user must be a pump.fun wallet, username or profile link" };

      // one callout by its link or id
      if (one) {
        const r = await byId(one, signal);
        if (!r) return { ok: false, error: "not_found", message: "pump.fun has no callout with this id" };
        const coins = await coinsOf([r.callout.mint], signal);
        return answer({ user: userOut(r.author, r.callout.wallet), callouts: [row(r.callout, coins, r.author)] }, [r.callout], coins);
      }

      // a coin's top callouts: pump.fun's order (how far the coin rose after each), the first `limit`, newest first
      if (!ref) {
        if (!mint) return { ok: false, error: "bad_args", message: "give a user (a wallet, a pump.fun username or profile link), a coin's mint or a callout's link" };
        const [raw, coins] = await Promise.all([get("coin", `/callout/coin/${mint}?limit=${COIN_TOP}`, signal), coinsOf([mint], signal)]);
        const listed = callouts(raw);
        if (!listed.length) return { ok: false, error: "not_found", message: "no callout of this coin on pump.fun" };
        keep(listed);
        const shown = listed.slice(0, limit).sort((a, b) => b.atMs - a.atMs);
        const names = await usersOf(shown.map((c) => c.wallet), signal);
        return answer(
          {
            coin: { mint, symbol: coins.get(mint)?.symbol ?? null, name: coins.get(mint)?.name ?? null },
            listed: listed.length,
            callers: new Set(listed.map((c) => c.wallet)).size,
            first_at: iso(Math.min(...listed.map((c) => c.atMs))),
            order: `pump.fun's top callouts of this coin (100 at most) by how far it rose after each; the top ${shown.length} here, newest first`,
            callouts: shown.map((c) => row(c, coins, names.get(c.wallet))),
          },
          shown,
          coins,
        );
      }

      // a user: a name is looked up first (pump.fun lists callouts by wallet)
      const named = "username" in ref ? await userOf(ref.username, signal) : null;
      if ("username" in ref && !named) return { ok: false, error: "not_found", message: "pump.fun has no user by this name" };
      const wallet = "wallet" in ref ? ref.wallet : named!.wallet;
      const who = named ? Promise.resolve(named) : userOf(wallet, signal).catch(() => null);

      // their callout on one coin
      if (mint) {
        const [user, raw] = await Promise.all([who, get("callout", `/callout/user/${wallet}/mint/${mint}`, signal)]);
        const c = isObj(raw) ? calloutOf(raw.callout) : null;
        if (!c) return { ok: false, error: "not_found", message: "this user has no live callout on this coin on pump.fun" };
        keep([c]);
        const coins = await coinsOf([c.mint], signal);
        return answer({ user: userOut(user, wallet), callouts: [row(c, coins, user)] }, [c], coins);
      }

      // their newest page (one a call: pump.fun's edge blocks a burst of pages) and pump.fun's counts
      const [user, page, stats] = await Promise.all([who, get("list", `/callout/list/${wallet}?limit=${PAGE}&sortBy=TIMESTAMP&sortOrder=DESC`, signal), get("users", `/users/${wallet}/callout-stats`, signal).catch(() => null)]);
      const read = callouts(page).sort((a, b) => b.atMs - a.atMs);
      if (!read.length) return { ok: false, error: "not_found", message: "no callout by this user on pump.fun" };
      keep(read);
      const shown = read.slice(0, limit);
      const coins = await coinsOf(shown.map((c) => c.mint), signal);
      const counts = countsOf(stats);
      const all = !(isObj(page) && typeof page.nextPageToken === "string" && page.nextPageToken !== "");
      return answer(
        {
          user: userOut(user, wallet),
          callouts_total: counts.total,
          callouts_30d: counts.d30,
          callouts_7d: counts.d7,
          newest: { callouts: read.length, coins: new Set(read.map((c) => c.mint)).size, from: iso(read.at(-1)!.atMs), to: iso(read[0]!.atMs), all },
          counts_note: `callouts_total, _30d and _7d are pump.fun's own counts; newest: the ${all ? "user's callouts, all of them" : "newest callouts read"} and the coins they call (pump.fun takes one live callout a coin); user.x is the X account this pump.fun user linked (a username is anyone's: check it is the caller meant)`,
          callouts: shown.map((c) => row(c, coins, user)),
        },
        shown,
        coins,
      );
    },
  };
  return [tool];
}
