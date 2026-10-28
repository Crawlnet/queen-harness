// Prediction market odds from Polymarket's own public API (no key): its search over events, OPEN markets only. An event
// keeps its resolved markets next to the live ones, and a reader handed the first markets of an event reads a resolved
// 0% as the market's odds; here every closed or inactive market is left out and each open one carries its "yes" price
// as a percentage and as the price itself, 0 to 1 (the queen copies `price`). Each market carries its own deadline's
// day in New York time and the whole event's volume beside its own. Sources: the event's page on polymarket.com.

import { polymarketEvent, src, uniqueSources } from "../links.ts";
import { limitParam, QUERY } from "../schema.ts";
import { MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, round, str, take, type FreeContext } from "./common.ts";

export const POLYMARKET_HOSTS = ["gamma-api.polymarket.com"];

/** Open markets kept per event at most (a date ladder or a rate decision has 5-13). */
const MARKETS_PER_EVENT = 8;
/** Words a search drops when the whole phrase finds nothing ("what are the odds btc hits 150k this year" → "btc 150k"). */
const FILLER = new Set(
  "a an and are as at be by can could do does for from has have how i if in into is it its me my of on or the this that to what when where which who why will with would odds chance chances probability polymarket market markets prediction predictions pricing priced price bet bets betting next year this week month today right now hit hits reach reaches".split(
    " ",
  ),
);

/** A JSON string list ('["Yes", "No"]') or a list, as strings; [] when it is neither. */
function list(v: unknown): string[] {
  let x = v;
  if (typeof v === "string") {
    try {
      x = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(x) ? x.map((s) => (typeof s === "string" || typeof s === "number" ? String(s) : "")) : [];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NEW_YORK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });

/**
 * A market's deadline as its day in New York time, where Polymarket sets them: the ISO day and a short label; an end at
 * midnight there closes the day before. Null for no time.
 */
export function deadline(end: unknown): { end_date: string; ends: string } | null {
  const t = typeof end === "string" ? Date.parse(end) : NaN;
  if (!Number.isFinite(t)) return null;
  const part = Object.fromEntries(NEW_YORK.formatToParts(new Date(t)).map((p) => [p.type, Number(p.value)]));
  const midnight = part.hour === 0 && part.minute === 0;
  const d = new Date(Date.UTC(part.year!, part.month! - 1, part.day! - (midnight ? 1 : 0)));
  return { end_date: d.toISOString().slice(0, 10), ends: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}` };
}

/**
 * An open market as the model reads it: its label, each outcome's price (0 to 1, and as a percentage), its own volume and
 * liquidity beside its event's volume, its deadline's day.
 */
function marketRow(m: Record<string, unknown>, eventVolume: number | null): Record<string, unknown> | null {
  if (m.closed === true || m.active === false || m.archived === true) return null;
  const outcomes = list(m.outcomes);
  const prices = list(m.outcomePrices).map((p) => num(p));
  if (outcomes.length === 0 || outcomes.length !== prices.length || prices.some((p) => p === null)) return null;
  const pct = (p: number | null) => round((p ?? 0) * 100, 3);
  const price = (p: number | null) => round(p ?? 0, 5);
  const yes = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  const row: Record<string, unknown> = {
    question: str(m.question, 200),
    label: str(m.groupItemTitle, 80),
  };
  if (yes >= 0 && outcomes.length === 2) {
    row.yes_pct = pct(prices[yes]!);
    row.price = price(prices[yes]!);
  } else row.outcomes = outcomes.slice(0, 10).map((o, i) => ({ outcome: o.slice(0, 60), pct: pct(prices[i]!), price: price(prices[i]!) }));
  row.volume_usd = round(num(m.volume));
  row.event_volume_usd = eventVolume;
  row.volume_24h_usd = round(num(m.volume24hr));
  row.liquidity_usd = round(num(m.liquidity));
  return { ...row, ...(deadline(m.endDate) ?? { end_date: null, ends: null }) };
}

/** The search phrase without filler words, at most three words (null when nothing is left or nothing was dropped). */
export function shorterQuery(q: string): string | null {
  const ws = q.toLowerCase().replace(/[^\p{L}\p{N}$.\s-]/gu, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));
  const s = ws.slice(0, 3).join(" ");
  return s && s !== q.toLowerCase().trim() ? s : null;
}

export function polymarketTools(fc: FreeContext): ToolDef[] {
  const search = async (q: string, signal: AbortSignal): Promise<Record<string, unknown>[]> => {
    take(fc.limit.polymarket);
    const raw = await fc.http.json(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}&limit_per_type=8&events_status=active`, { signal });
    if (!isObj(raw)) throw new ToolFail("unavailable");
    return Array.isArray(raw.events) ? raw.events.filter(isObj) : [];
  };

  const odds: ToolDef = {
    name: "prediction_odds",
    description:
      "Live odds of open Polymarket prediction markets for a topic (e.g. \"bitcoin 150k\", \"fed\", \"election\"): each event with its open markets only (resolved ones left out), the yes price as 0 to 1 (price) and as a percentage (yes_pct: the market's implied probability), each market's own volume and liquidity beside the event's total volume, and its deadline's day (ends). Use one to three key words. Market facts, not investment advice.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Topic: one to three key words", pattern: QUERY },
        limit: limitParam(3, 6, "events"),
      },
      required: ["query"],
      additionalProperties: false,
    },
    ttlMs: MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const q = String(args.query);
      const limit = Number(args.limit ?? 3);
      const shape = (events: Record<string, unknown>[]) =>
        events
          .filter((e) => e.closed !== true)
          .map((e) => {
            const volume = round(num(e.volume));
            const markets = (Array.isArray(e.markets) ? e.markets.filter(isObj) : []).map((m) => marketRow(m, volume)).filter((m): m is Record<string, unknown> => m !== null);
            const slug = str(e.slug, 160);
            return {
              title: str(e.title, 200),
              ...(deadline(e.endDate) ?? { end_date: null, ends: null }),
              volume_usd: volume,
              volume_24h_usd: round(num(e.volume24hr)),
              open_markets: markets.length,
              markets: markets.slice(0, MARKETS_PER_EVENT),
              link: slug ? polymarketEvent(slug) : null,
            };
          })
          .filter((e) => e.markets.length > 0)
          .slice(0, limit);
      let events = shape(await search(q, signal));
      let asked = q;
      if (events.length === 0) {
        const shorter = shorterQuery(q);
        if (shorter) {
          events = shape(await search(shorter, signal));
          asked = shorter;
        }
      }
      if (events.length === 0) return { ok: false, error: "not_found" };
      return {
        ok: true,
        data: {
          query: asked,
          note: "price is the market's price of yes from 0 to 1, yes_pct the same as a percentage: its implied probability right now; a market's volume_usd and liquidity_usd are its own, event_volume_usd the whole event's (all its markets); ends is the deadline's day in New York time",
          events,
        },
        sources: uniqueSources(events.map((e) => src(`Polymarket: ${e.title ?? "market"}`, e.link))),
      };
    },
  };
  return [odds];
}
