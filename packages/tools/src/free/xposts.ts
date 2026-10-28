// What an X search's posts are worth showing (free/grokx.ts): one of each, no giveaway, airdrop or engagement bait,
// none promoting other tokens' cashtags but not the asked project, the most liked first.

import { DAY } from "../types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const HANDLE_KEYS = ["username", "screen_name", "handle", "author_handle", "author_username", "author_name", "user_name", "user_handle", "screenName", "userName", "authorHandle", "authorUsername", "authorName"];
const TEXT_KEYS = ["text", "full_text", "fullText", "content", "body", "tweet_text"];

function handleOf(o: Obj): string | null {
  const read = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().replace(/^@/, "") : null);
  for (const k of HANDLE_KEYS) if (read(o[k])) return read(o[k]);
  for (const nest of ["author", "user", "account", "profile"]) {
    const n = o[nest];
    if (isObj(n)) for (const k of HANDLE_KEYS) if (read(n[k])) return read(n[k]);
  }
  return null;
}


/** A wallet or an address, as a giveaway asks for one */
const WALLET = String.raw`(?:wallets?|addys?|addies|address(?:es)?)`;
/** Giveaway, airdrop and engagement-bait posts; never the on-chain talk that shares their words */
const POST_SPAM = [
  /\bgive\s?aways?\b/i,
  /\bair\s?drop(?:s|ped|ping)?\b/i,
  // an ask for the reader's wallet: "drop ur addy", "comment your SOL wallet below", "send me your wallet"
  new RegExp(String.raw`\b(?:drop|comment|post|leave|send(?:\s+me)?|reply(?:\s+with)?)\s+(?:your|ur|yo|ya)\s+(?:\$?[a-z]{2,10}\s+)?${WALLET}\b`, "i"),
  // "drop sol address below", and a bare "drop wallets" at its end or before a mark or an emoji, never "drop wallets have…"
  new RegExp(String.raw`\bdrop\s+(?:\$?[a-z]{2,10}\s+)?${WALLET}(?:\s+(?:below|here)\b|\s*👇)`, "i"),
  new RegExp(String.raw`\bdrop\s+${WALLET}(?=\s*(?:$|[^\w\s]))`, "i"),
  /\breply\s+with\s+(?:your|ur|ya|their|the)\b[^\n]{0,40}?\b(?:addys?|address|wallet)/i,
  /\bfirst\s+\d[\d,]*\s+(?:people|ppl|peeps|persons|to\s+(?:reply|comment|follow|rt|retweet|like))\b/i,
  /\b(?:like|follow(?:\s+(?:me|@\w{1,15}))?|rt|retweet|repost)\s*(?:,|&|\+|and)\s*(?:like|follow|rt|retweet|repost)(?![\w-])/i,
  /\bdm\s+me\b/i,
  // "to enter:" or "to enter, follow…": a draw's rules, never "time to enter" a trade
  /\bto\s+enter\s*[:!]|\bto\s+enter\b[^\n]{0,40}\b(?:follow|like|rt|retweet|repost|tag|reply|comment)\b/i,
  /\btag\s+\d+\s+(?:friends?|frens?|people)\b/i,
];
/** A promo's words: beside another token's cashtag they push it, even in a post that names the asked project too */
const PROMO = /\b(?:next\s+\d+x|\d+x\s+(?:gem|potential|play)|the\s+one\s+to\s+watch|get\s+in\s+(?:early|now|before)|don['’]?t\s+miss|hidden\s+gem|low\s+cap\s+gem|before\s+it\s+(?:moons?|pumps?|rips?|flies|explodes?|takes\s+off)|ape\s+in)\b/i;
/** A cashtag ("$WIF"): a letter first, never an amount ("$20") */
const CASHTAG = /(?<![\w$])\$([A-Za-z][A-Za-z0-9]{0,14})(?!\w)/g;
/** Tickers a post names beside any other without promoting anything */
const MAJOR_TICKERS = new Set(["BTC", "ETH", "SOL", "USDC", "USDT"]);
/** An exchange pair's quote after its base ticker ("$WIFUSDT", "$WIFPERP") */
const PAIR_QUOTE = /(?:USDT|USDC|USD)?(?:PERP)?$/;
const LIKE_KEYS = ["likes", "like_count", "likeCount", "favorite_count", "favoriteCount", "favorites"];
const VIEW_KEYS = ["views", "view_count", "viewCount", "impressions", "impression_count"];

/** The cashtags a text names, upper case ("dogwifhat OR $WIF" → ["WIF"]) */
export function cashtags(text: string): string[] {
  return [...new Set([...text.matchAll(CASHTAG)].map((m) => m[1]!.toUpperCase()))];
}

const postText = (p: Obj): string => {
  const k = TEXT_KEYS.find((x) => typeof p[x] === "string");
  return k ? (p[k] as string) : "";
};

/** A post's count under one of `keys`, at its top or in its metrics record; 0 when it gives none */
function postCountOf(p: Obj, keys: readonly string[]): number {
  for (const src of [p, p.public_metrics, p.metrics, p.stats]) {
    if (!isObj(src)) continue;
    for (const k of keys) {
      const v = src[k];
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

/** The project a search asked about: its tickers (upper case) and its names as a post may write them */
interface Asked {
  tickers: ReadonlySet<string>;
  names: RegExp[];
}

/** A project's name in any case, its words with or without spaces between ('"dog wif hat"' finds "dogwifhat" too) */
function nameMatcher(name: string): RegExp | null {
  const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words ? new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s_-]*")}(?![\\p{L}\\p{N}])`, "iu") : null;
}

const askedOf = (tickers: readonly string[], names: readonly string[]): Asked => ({
  tickers: new Set(tickers.map((t) => t.toUpperCase())),
  names: names.map(nameMatcher).filter((re): re is RegExp => re !== null),
});

/** A post's cashtag as a ticker: an exchange pair of an asked ticker or a major as its base ("WIFUSDT" → "WIF"), else as it is */
function tickerOf(tag: string, tickers: ReadonlySet<string>): string {
  const base = tag.replace(PAIR_QUOTE, "");
  return base && base !== tag && (tickers.has(base) || MAJOR_TICKERS.has(base)) ? base : tag;
}

/** A text's cashtags as tickers, each marked when it is the asked one: its ticker or a pair of it, or one cut at the text's end that begins it */
function tagsIn(text: string, a: Asked): { ticker: string; asked: boolean }[] {
  const end = text.trimEnd().length;
  return [...text.matchAll(CASHTAG)].map((m) => {
    const ticker = tickerOf(m[1]!.toUpperCase(), a.tickers);
    return { ticker, asked: a.tickers.has(ticker) || (m.index + m[0].length === end && [...a.tickers].some((x) => x.startsWith(ticker))) };
  });
}

/** Does a text name the asked project: by one of its cashtags (tagsIn), the ticker as a word in capitals, or one of its names */
function namesAsked(text: string, a: Asked): boolean {
  if (tagsIn(text, a).some((t) => t.asked)) return true;
  return [...a.tickers].some((x) => new RegExp(`(?<![A-Za-z0-9])${x}(?![A-Za-z0-9])`).test(text)) || a.names.some((re) => re.test(text));
}

/** A post that promotes other tokens: it names cashtags (the majors aside) and not the asked project, or a promo's words */
function otherPromo(text: string, a: Asked): boolean {
  const others = tagsIn(text, a).filter((t) => !t.asked && !MAJOR_TICKERS.has(t.ticker));
  return others.length > 0 && (!namesAsked(text, a) || PROMO.test(text));
}

export interface KeptPosts {
  posts: Obj[];
  /** Left out as spam or another token's promo (a repeat is not counted) */
  spam: number;
}

/**
 * An X search's posts worth showing: one of each (same handle and text), no giveaway, airdrop or engagement bait, none
 * promoting other cashtags but not the asked project (`tickers`: the query's, none asked, no such check; `names`: the
 * names it OR-ed with them, which name the project too), the most liked first, then the most viewed.
 */
export function keepPosts(posts: readonly Obj[], tickers: readonly string[] = [], names: readonly string[] = []): KeptPosts {
  const a = askedOf(tickers, names);
  const seen = new Set<string>();
  const out: Obj[] = [];
  let spam = 0;
  for (const p of posts) {
    const text = postText(p);
    const key = `${(handleOf(p) ?? "").toLowerCase()}\n${text.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (POST_SPAM.some((re) => re.test(text)) || (a.tickers.size > 0 && otherPromo(text, a))) spam++;
    else out.push(p);
  }
  out.sort((x, y) => postCountOf(y, LIKE_KEYS) - postCountOf(x, LIKE_KEYS) || postCountOf(y, VIEW_KEYS) - postCountOf(x, VIEW_KEYS));
  return { posts: out, spam };
}

/** What the model reads when no post is left: the answer goes without its X section */
export const NO_POSTS_NOTE = "no posts worth showing (repeats, giveaways and promos left out): no x section in this answer";

/** The day `days` before `now`, as the search's operators write it (YYYY-MM-DD, UTC) */
export const dayBefore = (now: number, days: number): string => new Date(now - days * DAY).toISOString().slice(0, 10);
