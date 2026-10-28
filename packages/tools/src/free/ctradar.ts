// The CT calls radar: what crypto twitter is calling right now on Solana memecoins, for the harness,
// read in the background into SQLite and served by ct_calls:
//   - the calls feed: fresh X posts that call or shill a Solana memecoin (a pump.fun or other Solana contract address,
//     or a $ticker with call words: aped, sending, gem, entry, ca, low cap, bonded…) by authors with
//     TOOLS_CTRADAR_MIN_FOLLOWERS followers at least, kept 3 days in tools_ct_posts (an older post is never stored);
//   - one call a tick (TOOLS_CTRADAR_MIN): twitterapi.io's advanced search in X's own query syntax when
//     TOOLS_TWITTERAPI_KEY is set (about $0.15 per 1,000 tweets, so every 5 min: freshness wins), else Grok's X search
//     through OpenRouter on the X search's key (free/grokx.ts; $5 per 1,000 posts it fetches, so every 20 min), only
//     the posts its search cited, as social_mentions keeps them; Grok knows no follower count, so it is asked for the
//     newest calls alone and each cited post is read again on FxTwitter's status API (free, keyless; its search is
//     gone, its single posts still read): the author's followers, the likes, views and the whole text; the floor
//     after that, a count still unknown kept and marked (followers null);
//   - the top calls: every TOOLS_CTRADAR_TOP_MIN (30) on Grok whatever reads the feed, the most liked or most viewed
//     calls of the last 6 h, read on FxTwitter and screened and stored like the feed's, their ticks apart (lane "top");
//   - ct_calls: the coins CT called in the last 1, 6 or 24 h, ranked by distinct callers, then reach (their followers
//     summed), each with its first call, its 3 biggest callers, likes, the minutes since the first call and its
//     narrative label; or one coin's calls oldest first (the call times call_frontrun reads); or the narratives (view
//     narratives), computed from those calls: the called coins grouped by our own narrative label of each mint (the
//     pump.fun index's card: fc.narrativeOf, free/narratives.ts), each with its coins, callers, reach, first and newest
//     call and whether it is heating;
//   - no cap and no budget: what each tick cost is measured, logged as a `tools: ct radar` line (OpenRouter's
//     usage.cost; tweets × $0.00015 on twitterapi.io) with the posts it kept and why it dropped the rest, and kept a
//     tick a row in tools_ct_ticks. The collector runs only in a registry made with background on (never in tests). Its
//     posts stay in the tools layer's own tables for 3 days. A call is a post by its author, a claim: never advice.

import { base58Decode, migrate, type Db, type Stmt, type ToolError } from "@crawlnet/shared";
import { readCapped, statusError } from "../http.ts";
import { src, uniqueSources, xPost } from "../links.ts";
import { cleanText } from "../sanitize.ts";
import { DAY, HOUR, MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, type FreeContext } from "./common.ts";
import { answerJson, citedIds, postsOf } from "./grokx.ts";
import { cashtags, keepPosts } from "./xposts.ts";

export const TWITTERAPI_HOST = "api.twitterapi.io";
/** Posts and ticks are kept this long; an older post is never stored */
const KEPT_MS = 3 * DAY;
/** twitterapi.io bills 15 credits a tweet it returns ($1 = 100,000 credits), 15 at least a call, an empty one too */
const TWEET_USD = 0.00015;
/** A page of its advanced search: 20 tweets at most */
const PAGE_TWEETS = 20;
/** The calls feed's beat by its source, minutes (TOOLS_CTRADAR_MIN unset) */
export const CALLS_MIN_TWITTERAPI = 5;
export const CALLS_MIN_GROK = 20;
/** A call's text kept, characters */
const TEXT_MAX = 280;
/** A post's text read for its coins (a long post's address can sit past its first 280 characters) */
const SCAN_MAX = 4000;
/** A post naming more coins than this is a list (a recap, a watchlist), not a call */
const COINS_PER_POST_MAX = 5;
/** The background beat: each lane due starts its tick */
const BEAT_MS = 15_000;
/** A process's first tick waits this long at least; a restart keeps the beat from the last tick's time (tools_ct_ticks) */
const START_DELAY_MS = 20_000;
/** A tick's own time */
const TWITTERAPI_TIMEOUT_MS = 30_000;
const GROK_TIMEOUT_MS = 150_000;
/**
 * twitterapi.io's search starts a beat before the last good read (a post that reached the likes floor within a beat of its
 * posting is still in reach), never further back than this
 */
const LOOKBACK_MAX_MS = HOUR;
/** Grok is asked for the calls of twice the beat back, 6 h at most (its x_search's own date: the day that span starts in) */
const GROK_LOOKBACK_MAX_MIN = 360;
/** The top calls' beat, minutes (TOOLS_CTRADAR_TOP_MIN unset), and the hours of X a run asks about */
export const TOP_MIN = 30;
const TOP_HOURS = 6;
/** The narratives view: the coins listed under a narrative at most, and the name of the coins with no label */
const NARRATIVE_COINS_MAX = 10;
export const UNLABELLED = "unlabelled";
/**
 * FxTwitter's status API (api.fxtwitter.com/2/status/<id>, keyless and free: no cap): the posts Grok's search cited read
 * again for what Grok cannot say, FX_AT_ONCE at a time, each within FX_TIMEOUT_MS; a read that fails leaves the post as
 * Grok gave it (its failures counted in the tick's line)
 */
export const FXTWITTER_HOST = "api.fxtwitter.com";
export const FX_AT_ONCE = 5;
const FX_TIMEOUT_MS = 6_000;
/** The user agent the readers send, saying what they are (FxTwitter and t.me answer it) */
const READER_UA = "Mozilla/5.0 (compatible; queen-harness/0.1)";
/** The windows ct_calls reads */
const WINDOWS: Record<string, number> = { "1h": HOUR, "6h": 6 * HOUR, "24h": DAY };
/** A read whose last good tick is this many beats old says that calls since then are missing */
const STALE_BEATS = 3;
/** A time as the tool says it: ISO, to the second */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The calls feed's query on twitterapi.io (X's own syntax, the newest first): a post that shows its coin (the CA, a
 * launchpad, a chart or a terminal) beside a Solana or call word, 5 likes at least, no replies (the CAs reply guys drop
 * under a big account's post are noise). X's search has no follower operator: the floor is ours, after the read. A bare
 * "CA: <address>" post with none of the second group's words is missed; the one page a tick (20 tweets) is better spent on
 * posts that read as calls.
 */
export const TWITTERAPI_QUERY =
  '(ca OR "contract address" OR pump OR pumpfun OR bonk OR url:pump.fun OR url:dexscreener.com OR url:gmgn.ai OR url:axiom.trade OR url:birdeye.so OR url:jup.ag) ' +
  '(solana OR sol OR memecoin OR aped OR sending OR gem OR entry OR "low cap" OR lowcap OR bonded OR migrated OR 10x OR 100x) min_faves:5 -filter:replies';

export interface CtRadarConfig {
  /** twitterapi.io's key (TOOLS_TWITTERAPI_KEY): the calls feed's source when set */
  twitterapiKey: string | null;
  /** Grok through OpenRouter on the X search's key, model and endpoint (free/grokx.ts): the calls feed without twitterapi.io */
  grok: { key: string; model: string; baseUrl: string } | null;
  /** Minutes between the calls feed's reads (TOOLS_CTRADAR_MIN: 5 on twitterapi.io, 20 on Grok) */
  callsMin: number;
  /** Minutes between Grok's top calls (TOOLS_CTRADAR_TOP_MIN, 30), whatever reads the feed; none without Grok */
  topMin: number;
  /** Calls by authors with fewer followers are left out (TOOLS_CTRADAR_MIN_FOLLOWERS, 1000) */
  minFollowers: number;
}

/** A post as a source read it, before the radar's checks */
interface ReadPost {
  id: string;
  handle: string | null;
  followers: number | null;
  likes: number | null;
  views: number | null;
  /** ms, as its source dated it (the post's id dates it first) */
  at: number | null;
  text: string;
  /** Its links as the source expanded them (X shortens the ones in the text) */
  urls: string[];
  /** A reply or a repost: no call of its author's own */
  reply?: boolean;
}

/** A call kept in tools_ct_posts */
export interface CtPost {
  id: string;
  url: string;
  handle: string;
  followers: number | null;
  likes: number | null;
  views: number | null;
  /** ms, from the post's id */
  postedAt: number;
  text: string;
  mints: string[];
  tickers: string[];
  /** ms, the read that first kept it */
  seenAt: number;
  source: string;
}

// ─────────────────────────────── what a post names

const BASE58_RUN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const EVM_ADDRESS = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** Addresses a call may paste that are no memecoin: wrapped SOL, the stablecoins, the programs */
const NOT_COINS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
]);
/** Tickers no memecoin call is about: the majors, stablecoins and wrapped coins a call names as its market */
const MAJORS = new Set(["BTC", "ETH", "SOL", "WSOL", "WBTC", "WETH", "USD", "USDC", "USDT", "USD1", "USDE", "USDS", "DAI", "PYUSD", "BNB", "XRP", "ADA", "TRX", "TON", "SUI", "AVAX", "DOT", "LINK", "LTC", "BCH", "HYPE", "XLM", "NEAR", "APT"]);
/** An exchange pair's quote after its base ("$WIFUSDT", "$SOLPERP") */
const PAIR_QUOTE = /(?:USDT|USDC|PERP)$/;
/** The word just before an address that makes it a wallet, not the coin ("dev wallet: …", "whale: …") */
const WALLET_BEFORE = /\b(?:wallets?|dev|deployer|whale|insider|sniper|trader|kol|addy)\s*[:=>\-–—]*\s*$/i;
/**
 * Words that make a $ticker a call when no address is posted: CT's own (aped, sending, gem, entry, ca, low cap, bonded,
 * migrated, 10x…)
 */
const CALL_WORDS =
  /\b(?:ap(?:e|ed|ing)|send(?:s|ing)?|sent|gems?|entry|entries|ca|contract|low\s?caps?|micro\s?caps?|bond(?:ed|ing)|migrat(?:ed|ing|ion)|dex\s?paid|cook(?:s|ed|ing)|runners?|moon(?:s|ing)?|load(?:ed|ing)|bag(?:s|ged)?|bought|buying|accumulat(?:e|ed|ing)|early|\d{1,4}x|x\d{1,4}|lfg|alpha|called|nfa|dyor|mcap|mc|ath|chart|pumping|undervalued|dip)\b/i;
/**
 * Hosts whose links carry a coin's mint in their path or query, a referral or a quote beside it (gmgn's "<ref>_<mint>",
 * Jupiter's "SOL-<mint>"); a DEX Screener, Photon or Axiom link carries a pair's address, never read as a mint
 */
const MINT_HOSTS = new Set(["pump.fun", "gmgn.ai", "birdeye.so", "solscan.io", "jup.ag", "bullx.io", "neo.bullx.io", "bonk.fun", "letsbonk.fun", "rugcheck.xyz"]);
/** Chains other than Solana as the trading sites name them in their paths ("dexscreener.com/bsc/…", "gmgn.ai/base/…") */
const OTHER_CHAINS = new Set(["bsc", "bnb", "base", "eth", "ethereum", "arbitrum", "polygon", "avalanche", "tron", "sui", "ton", "blast", "abstract", "monad", "sonic", "hyperevm"]);
const OTHER_CHAIN_HOSTS = /(?:^|\.)(?:etherscan\.io|bscscan\.com|basescan\.org|four\.meme|pancakeswap\.finance|uniswap\.org|sunpump\.meme)$/;
const OTHER_CHAIN_WORDS = /\b(?:on\s+(?:base|bsc|bnb|eth|ethereum|tron|sui|ton|blast|monad|abstract)|bnb\s?chain)\b|#(?:bsc|bnb)\b/i;

/** A Solana address: base58 of 32 bytes */
function isSolAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  const b = base58Decode(s);
  return b !== null && b.length === 32;
}

/** A link's mints (a mint-bearing site's) and whether it is another chain's page */
function readLink(raw: string): { mints: string[]; other: boolean } {
  let url: URL;
  try {
    url = new URL(raw.replace(/[.,;:!?…)\]]+$/, ""));
  } catch {
    return { mints: [], other: false };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.split("/").filter(Boolean);
  const first = (path[0] ?? "").toLowerCase();
  if (OTHER_CHAIN_HOSTS.test(host)) return { mints: [], other: true };
  if ((host === "dexscreener.com" || host === "gmgn.ai" || host === "geckoterminal.com") && OTHER_CHAINS.has(first)) return { mints: [], other: true };
  if (host === "birdeye.so" && (url.searchParams.get("chain") ?? "solana").toLowerCase() !== "solana") return { mints: [], other: true };
  if (!MINT_HOSTS.has(host) || (host === "gmgn.ai" && first !== "sol")) return { mints: [], other: false };
  const parts = [...path, ...url.searchParams.values()].flatMap((p) => p.split(/[_\-.]/));
  return { mints: parts.filter((p) => isSolAddress(p) && !NOT_COINS.has(p)), other: false };
}

/**
 * What a post names: its Solana mints (in its text, a wallet's address aside, and in a mint-bearing site's links), its
 * tickers (cashtags, the majors and stablecoins left out, an exchange pair as its base), whether it reads as a call (a mint
 * posted, or a ticker with call words), and whether it is another chain's (an EVM address, another chain's page or words)
 * when it posts no Solana mint
 */
export function coinsIn(text: string, urls: readonly string[] = []): { mints: string[]; tickers: string[]; call: boolean; otherChain: boolean } {
  const t = text.slice(0, SCAN_MAX).replace(/\p{Cf}/gu, "");
  const plain = t.replace(URL_IN_TEXT, " ");
  const mints = new Set<string>();
  let other = false;
  for (const u of [...urls, ...(t.match(URL_IN_TEXT) ?? [])]) {
    const r = readLink(u);
    for (const m of r.mints) mints.add(m);
    other ||= r.other;
  }
  for (const m of plain.matchAll(BASE58_RUN)) {
    const a = m[0];
    if (NOT_COINS.has(a) || !isSolAddress(a) || WALLET_BEFORE.test(plain.slice(Math.max(0, m.index - 40), m.index))) continue;
    mints.add(a);
  }
  const tickers = [
    ...new Set(
      cashtags(plain).map((x) => {
        const base = x.replace(PAIR_QUOTE, "");
        return base !== x && base.length >= 2 ? base : x;
      }),
    ),
  ].filter((x) => x.length >= 2 && !MAJORS.has(x));
  other ||= EVM_ADDRESS.test(plain) || OTHER_CHAIN_WORDS.test(plain);
  const list = [...mints];
  return { mints: list, tickers, call: list.length > 0 || (tickers.length > 0 && CALL_WORDS.test(plain)), otherChain: list.length === 0 && other };
}

/** Why a post read was not kept (the counts each tick logs) */
type DropReason = "uncited" | "bad" | "reply" | "repeat" | "spam" | "old" | "followers" | "other_chain" | "no_coin" | "list";

/** X's post ids carry their time: ms since its epoch, shifted 22 bits (as frontrun.ts callTime reads a call's) */
const X_EPOCH_MS = 1_288_834_974_657;

/** A post's time: its id's, else as its source dated it */
function postedAtOf(p: ReadPost): number | null {
  if (/^\d{15,20}$/.test(p.id)) {
    const ms = Number(BigInt(p.id) >> 22n) + X_EPOCH_MS;
    if (Number.isFinite(ms)) return ms;
  }
  return p.at;
}

/**
 * The calls among the posts a source read, as kept: the author's own post (no reply or repost), one of each, no giveaway,
 * airdrop or engagement bait (xposts.ts keepPosts, as social_mentions keeps posts), at most 3 days old (a time ahead of
 * the clock is no time), its author over the follower floor when its count is known (an unknown one is kept, marked by its
 * null count, and counted in `unknown`), a Solana coin it calls (coinsIn), at most COINS_PER_POST_MAX of them; and the
 * count of each reason the rest were dropped
 */
function screenPosts(read: readonly ReadPost[], now: number, minFollowers: number, source: string): { kept: CtPost[]; dropped: Partial<Record<DropReason, number>>; unknown: number } {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (why: DropReason, n = 1) => {
    if (n > 0) dropped[why] = (dropped[why] ?? 0) + n;
  };
  const own: ReadPost[] = [];
  const ids = new Set<string>();
  for (const p of read) {
    if (!/^\d{5,25}$/.test(p.id) || !p.handle || !HANDLE.test(p.handle) || !p.text.trim()) drop("bad");
    else if (ids.has(p.id)) drop("repeat");
    else if (p.reply) drop("reply");
    else own.push(p);
    ids.add(p.id);
  }
  const shown = keepPosts(own as unknown as Record<string, unknown>[]);
  drop("spam", shown.spam);
  drop("repeat", own.length - shown.posts.length - shown.spam);
  const kept: CtPost[] = [];
  for (const p of shown.posts as unknown as ReadPost[]) {
    const postedAt = postedAtOf(p);
    if (postedAt === null || postedAt < now - KEPT_MS || postedAt > now + 5 * MINUTE) {
      drop("old");
      continue;
    }
    if (p.followers !== null && p.followers < minFollowers) {
      drop("followers");
      continue;
    }
    const c = coinsIn(p.text, p.urls);
    if (c.otherChain) drop("other_chain");
    else if (!c.call) drop("no_coin");
    else if ((c.mints.length || c.tickers.length) > COINS_PER_POST_MAX) drop("list");
    else
      kept.push({ id: p.id, url: xPost(p.handle, p.id)!, handle: p.handle!, followers: p.followers, likes: p.likes, views: p.views, postedAt, text: cleanText(p.text, TEXT_MAX) ?? "", mints: c.mints, tickers: c.tickers, seenAt: now, source });
  }
  return { kept, dropped, unknown: kept.filter((p) => p.followers === null).length };
}

// ─────────────────────────────── the sources

/**
 * twitterapi.io's advanced search page: its tweets as posts (a reply or a repost marked, the links its entities expand),
 * how many it returned (each billed), and whether a page more was there; null when it is no such page
 */
function twitterapiPosts(body: unknown): { posts: ReadPost[]; count: number; more: boolean } | null {
  if (!isObj(body) || !Array.isArray(body.tweets)) return null;
  const posts: ReadPost[] = [];
  for (const t of body.tweets) {
    if (!isObj(t) || typeof t.id !== "string") continue;
    const a = isObj(t.author) ? t.author : {};
    const at = typeof t.createdAt === "string" ? Date.parse(t.createdAt) : NaN;
    const entities = isObj(t.entities) && Array.isArray(t.entities.urls) ? t.entities.urls : [];
    posts.push({
      id: t.id,
      handle: typeof a.userName === "string" ? a.userName.replace(/^@/, "") : null,
      followers: num(a.followers),
      likes: num(t.likeCount),
      views: num(t.viewCount),
      at: Number.isNaN(at) ? null : at,
      text: typeof t.text === "string" ? t.text : "",
      urls: entities.filter(isObj).flatMap((u) => (typeof u.expanded_url === "string" ? [u.expanded_url] : [])),
      reply: t.isReply === true || isObj(t.retweeted_tweet),
    });
  }
  return { posts, count: body.tweets.length, more: body.has_next_page === true && body.tweets.length >= PAGE_TWEETS };
}

/**
 * The list in Grok's answer, forgiving: under the first of `keys` in the JSON object asked for (a fence around it
 * allowed), or a bare JSON list; null when the answer holds neither (cut at max_tokens, or prose)
 */
function answerList(content: unknown, keys: readonly string[]): Record<string, unknown>[] | null {
  if (typeof content !== "string") return null;
  const bare = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (bare.startsWith("[")) {
    try {
      const v = JSON.parse(bare) as unknown;
      if (Array.isArray(v)) return v.filter(isObj);
    } catch {
      // read as an object below
    }
  }
  const o = answerJson(content);
  if (!o) return null;
  for (const k of keys) if (Array.isArray(o[k])) return (o[k] as unknown[]).filter(isObj);
  return [];
}

/** A post's link as Grok may give it: its url or link, or its id alone */
const linkOf = (x: unknown): string | null => {
  if (typeof x === "string") return /^\d{15,20}$/.test(x.trim()) ? `https://x.com/i/status/${x.trim()}` : x;
  if (!isObj(x)) return null;
  for (const k of ["url", "link", "post", "href"]) if (typeof x[k] === "string") return x[k] as string;
  return typeof x.id === "string" || typeof x.id === "number" ? linkOf(String(x.id)) : null;
};

/**
 * Grok's answer of posts: those its search cited (grokx.ts postsOf; a post given by its link or its id alone, under
 * "posts", "calls" or "results" or as a bare list), how many it listed that it never cited, and whether its answer was
 * JSON at all (one cut at max_tokens or in prose keeps nothing: the tick's log says so). No count Grok gives is kept: it
 * knows none (FxTwitter's are read over them)
 */
function grokCallPosts(message: unknown): { posts: ReadPost[]; uncited: number; readable: boolean } | null {
  if (!isObj(message)) return null;
  const listed = answerList(message.content, ["posts", "calls", "results"]);
  const answer = { posts: (listed ?? []).map((p) => ({ ...p, url: linkOf(p) })) };
  const cited = postsOf(answer, citedIds(message), { likes: 0, followers: 0 });
  const posts = cited.map((p): ReadPost => ({ id: p.id, handle: p.handle, followers: null, likes: null, views: null, at: p.at ? Date.parse(p.at) : null, text: p.text, urls: [] }));
  return { posts, uncited: Math.max(0, answer.posts.length - posts.length), readable: listed !== null };
}

/**
 * The calls' ask, the feed's (the newest first) and the top calls' (the most liked or viewed first) alike: no follower
 * floor and no count asked, the post's link and text the only fields that matter
 */
const callsSystem = (order: string) => `you search x (twitter) with your x search tool and report only posts that search returned. never use web search.
answer json only: {"posts":[{"url":"https://x.com/<handle>/status/<id>","handle":"<handle without @>","text":"<the post as written, contract addresses whole>","at":"<YYYY-MM-DDTHH:MM:SSZ or null>"}]}
at most 20 posts, ${order}. never invent a post, a link or an address. none found: {"posts":[]}`;

/**
 * A post as FxTwitter's status API has it: the author's handle and followers, likes, views, its time (ms), its whole text
 * and the links its text's facets expand
 */
export interface FxPost {
  handle: string | null;
  followers: number | null;
  likes: number | null;
  views: number | null;
  at: number | null;
  text: string | null;
  urls: string[];
}

/**
 * FxTwitter's answer for one post (v1's {code, tweet}), or null for none (its code not 200: a deleted or private post)
 */
export function fxPost(body: unknown): FxPost | null {
  if (!isObj(body) || (body.code !== undefined && num(body.code) !== 200)) return null;
  const s = isObj(body.status) ? body.status : isObj(body.tweet) ? body.tweet : null;
  if (!s) return null;
  const a = isObj(s.author) ? s.author : {};
  const ts = num(s.created_timestamp);
  const raw = isObj(s.raw_text) ? s.raw_text : {};
  const urls = (Array.isArray(raw.facets) ? raw.facets : []).filter(isObj).flatMap((f) => ["replacement", "expanded_url", "url"].map((k) => f[k]).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 1));
  return {
    handle: typeof a.screen_name === "string" && HANDLE.test(a.screen_name) ? a.screen_name : null,
    followers: num(a.followers),
    likes: num(s.likes),
    views: num(s.views),
    at: ts !== null && ts > 0 ? ts * 1000 : null,
    text: typeof s.text === "string" && s.text.trim() ? s.text : typeof raw.text === "string" ? raw.text : null,
    urls,
  };
}

/** A post Grok's search cited, with what FxTwitter read of it over Grok's fields (none read: as Grok gave it) */
function withFx(p: ReadPost, fx: FxPost | null | undefined): ReadPost {
  if (!fx) return p;
  return { ...p, handle: fx.handle ?? p.handle, followers: fx.followers ?? p.followers, likes: fx.likes ?? p.likes, views: fx.views ?? p.views, at: fx.at ?? p.at, text: fx.text ?? p.text, urls: [...p.urls, ...fx.urls] };
}

/** Run `f` over `items`, `n` at a time */
async function eachAtOnce<T>(items: readonly T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await f(items[i++]!);
    }),
  );
}

/** A source's refusal or a failed read: its error as ours, its HTTP status, what it cost when it said */
class ReadFail extends Error {
  readonly code: ToolError;
  readonly status: number | null;
  readonly cost: number | null;
  constructor(code: ToolError, status: number | null = null, cost: number | null = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.cost = cost;
  }
}

/** One source's read for a tick: the posts, how many it returned (or listed), what it cost (null: not said) */
interface Read {
  posts: ReadPost[];
  count: number;
  cost: number | null;
  uncited?: number;
  more?: boolean;
  /** Grok's answer was not the JSON asked for */
  unreadable?: boolean;
  /** The posts FxTwitter could not read (Grok's lanes) */
  fxFails?: number;
}

export type CtLane = "calls" | "top";

/** What a lane's tick did */
export interface Tick {
  ok: boolean;
  kept: number;
  fresh: number;
  dropped: Partial<Record<DropReason, number>>;
  unknown: number;
  fxFails: number | null;
  cost: number | null;
}

const MIGRATIONS = [
  {
    id: "tools/010_ct_posts",
    sql: `
      CREATE TABLE tools_ct_posts (
        id        TEXT PRIMARY KEY,    -- the post's id on X
        url       TEXT NOT NULL,       -- x.com/<handle>/status/<id>
        handle    TEXT NOT NULL,
        followers INTEGER,
        likes     INTEGER,
        views     INTEGER,
        posted_at INTEGER NOT NULL,    -- ms epoch, from the post's id
        text      TEXT NOT NULL,       -- 280 characters at most, cleaned
        mints     TEXT NOT NULL,       -- JSON list of the Solana mints it names
        tickers   TEXT NOT NULL,       -- JSON list of its cashtags, upper case, the majors left out
        seen_at   INTEGER NOT NULL,    -- ms epoch, the read that first kept it
        source    TEXT NOT NULL        -- twitterapi | grok
      );
      CREATE INDEX tools_ct_posts_posted ON tools_ct_posts(posted_at);
      CREATE TABLE tools_ct_ticks (
        lane     TEXT NOT NULL,        -- calls | top
        at       INTEGER NOT NULL,     -- ms epoch, the tick's start
        source   TEXT NOT NULL,        -- twitterapi | grok
        ok       INTEGER NOT NULL,     -- 1: the source answered
        fetched  INTEGER NOT NULL,     -- posts it returned or listed
        kept     INTEGER NOT NULL,
        cost_usd REAL,                 -- OpenRouter's usage.cost, or tweets x $0.00015; null when not said
        PRIMARY KEY (lane, at)
      );
    `,
  },
];

interface PostRow {
  id: string;
  url: string;
  handle: string;
  followers: number | null;
  likes: number | null;
  views: number | null;
  posted_at: number;
  text: string;
  mints: string;
  tickers: string;
  seen_at: number;
  source: string;
}

const list = (json: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const usd = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e6) / 1e6);

/** The radar: its collector (start, the ticks) and its reads (ct_calls) over its own tables */
export class CtRadar {
  readonly cfg: CtRadarConfig;
  /** The calls feed's source: twitterapi.io when its key is set, else Grok */
  readonly callsSource: "twitterapi" | "grok";
  private readonly fc: FreeContext;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly stmt: Record<"has" | "put" | "since" | "any" | "tick" | "lastTick" | "lastOk" | "lastSeen" | "prunePosts" | "pruneTicks", Stmt> & { tx: (f: () => void) => void };
  private timer: NodeJS.Timeout | null = null;
  private stopping = new AbortController();
  private readonly busy: Record<CtLane, boolean> = { calls: false, top: false };
  private readonly nextAt: Record<CtLane, number> = { calls: 0, top: 0 };

  /** Its tables made (a failure throws: the registry leaves the radar out) */
  constructor(fc: FreeContext, cfg: CtRadarConfig, db: Db, log: (msg: string, extra?: Record<string, unknown>) => void = () => {}) {
    if (!cfg.twitterapiKey && !cfg.grok) throw new Error("tools: the ct radar has no source");
    this.fc = fc;
    this.cfg = cfg;
    this.log = log;
    this.callsSource = cfg.twitterapiKey ? "twitterapi" : "grok";
    migrate(db, MIGRATIONS);
    const p = (sql: string) => db.prepare(sql);
    this.stmt = {
      has: p(`SELECT 1 AS x FROM tools_ct_posts WHERE id = ?`),
      put: p(
        `INSERT INTO tools_ct_posts (id, url, handle, followers, likes, views, posted_at, text, mints, tickers, seen_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET followers = COALESCE(excluded.followers, followers), likes = COALESCE(excluded.likes, likes), views = COALESCE(excluded.views, views)`,
      ),
      since: p(`SELECT * FROM tools_ct_posts WHERE posted_at >= ? ORDER BY posted_at, id`),
      any: p(`SELECT 1 AS x FROM tools_ct_posts LIMIT 1`),
      tick: p(`INSERT OR REPLACE INTO tools_ct_ticks (lane, at, source, ok, fetched, kept, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      lastTick: p(`SELECT at FROM tools_ct_ticks WHERE lane = ? ORDER BY at DESC LIMIT 1`),
      lastOk: p(`SELECT at FROM tools_ct_ticks WHERE lane = ? AND ok = 1 ORDER BY at DESC LIMIT 1`),
      lastSeen: p(`SELECT MAX(seen_at) AS at FROM tools_ct_posts`),
      prunePosts: p(`DELETE FROM tools_ct_posts WHERE posted_at < ?`),
      pruneTicks: p(`DELETE FROM tools_ct_ticks WHERE at < ?`),
      tx: (f) => db.transaction(f)(),
    };
  }

  /** The radar's clock (the tools layer's) */
  now(): number {
    return this.fc.now();
  }

  /** Minutes between a lane's ticks */
  beatMin(lane: CtLane): number {
    return lane === "calls" ? this.cfg.callsMin : this.cfg.topMin;
  }

  // ─────────────────────────────── the collector

  /**
   * The background collector: a beat every BEAT_MS starts each lane's tick when due, never two of a lane at once; the
   * first tick of a process at least START_DELAY_MS after its start and a beat after the last tick kept (a restart, a
   * deploy, never reads again before its time)
   */
  start(): void {
    if (this.timer) return;
    this.stopping = new AbortController();
    const now = this.fc.now();
    for (const lane of this.lanes()) this.nextAt[lane] = Math.max(now + START_DELAY_MS, (this.lastTickAt(lane, false) ?? 0) + this.beatMin(lane) * MINUTE);
    this.log("tools: ct radar on", { calls: this.callsSource, calls_min: this.cfg.callsMin, ...(this.cfg.grok ? { top_min: this.cfg.topMin } : {}), min_followers: this.cfg.minFollowers });
    this.timer = setInterval(() => this.beat(), BEAT_MS);
    this.timer.unref();
  }

  /** When a lane's next tick is due (ms; 0 before the start) */
  nextTickAt(lane: CtLane): number {
    return this.nextAt[lane];
  }

  /** The background beat runs */
  running(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping.abort();
  }

  /** The calls feed, and the top calls when Grok is there to read them */
  private lanes(): CtLane[] {
    return this.cfg.grok ? ["calls", "top"] : ["calls"];
  }

  /** One beat: each lane due and idle starts its tick, its next one a beat after this one's start */
  private beat(): void {
    const now = this.fc.now();
    for (const lane of this.lanes()) {
      if (this.busy[lane] || now < this.nextAt[lane]) continue;
      this.busy[lane] = true;
      this.nextAt[lane] = now + this.beatMin(lane) * MINUTE;
      (lane === "calls" ? this.tickCalls() : this.tickTop())
        .catch(() => {})
        .finally(() => {
          this.busy[lane] = false;
        });
    }
  }

  /**
   * One read of the calls feed: one call to its source, the posts screened (screenPosts), the calls kept stored (a post
   * seen again: its counts updated), the radar's tables pruned to 3 days; the tick logged with its cost and kept as a row.
   * Never throws.
   */
  async tickCalls(): Promise<Tick> {
    const t0 = this.fc.now();
    const source = this.callsSource;
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(source === "twitterapi" ? TWITTERAPI_TIMEOUT_MS : GROK_TIMEOUT_MS)]);
    let read: Read;
    try {
      read = source === "twitterapi" ? await this.readTwitterapi(t0, signal) : await this.readGrokCalls(t0, signal);
    } catch (e) {
      return { ok: false, kept: 0, fresh: 0, dropped: {}, unknown: 0, fxFails: null, cost: this.failed("calls", source, t0, e).cost };
    }
    return this.keep("calls", source, t0, read);
  }

  /**
   * One read of the top calls (Grok only): the most liked or most viewed calls of the last TOP_HOURS, its cited posts read
   * on FxTwitter, screened and stored as the feed's, its tick a row of its own (lane "top"). Never throws.
   */
  async tickTop(): Promise<Tick> {
    const t0 = this.fc.now();
    if (!this.cfg.grok) return { ok: false, kept: 0, fresh: 0, dropped: {}, unknown: 0, fxFails: null, cost: null };
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(GROK_TIMEOUT_MS)]);
    let read: Read;
    try {
      read = await this.readGrokTop(t0, signal);
    } catch (e) {
      return { ok: false, kept: 0, fresh: 0, dropped: {}, unknown: 0, fxFails: null, cost: this.failed("top", "grok", t0, e).cost };
    }
    return this.keep("top", "grok", t0, read);
  }

  /**
   * A lane's read kept: the posts screened (screenPosts), the calls kept stored (a post seen again: its counts updated),
   * the radar's tables pruned to 3 days; the tick logged with its cost and kept as a row
   */
  private keep(lane: CtLane, source: string, t0: number, read: Read): Tick {
    const { kept, dropped, unknown } = screenPosts(read.posts, t0, this.cfg.minFollowers, source);
    if (read.uncited) dropped.uncited = read.uncited;
    let fresh = 0;
    try {
      this.stmt.tx(() => {
        for (const p of kept) {
          if (!this.stmt.has.get(p.id)) fresh++;
          this.stmt.put.run(p.id, p.url, p.handle, p.followers, p.likes, p.views, p.postedAt, p.text, JSON.stringify(p.mints), JSON.stringify(p.tickers), p.seenAt, p.source);
        }
      });
    } catch {
      // a write that failed is read again on the next tick
      fresh = 0;
    }
    this.prune(t0);
    this.record(lane, t0, source, true, read.count, kept.length, read.cost);
    this.log("tools: ct radar", {
      lane,
      source,
      ok: true,
      fetched: read.count,
      kept: kept.length,
      new: fresh,
      ...(Object.keys(dropped).length ? { dropped } : {}),
      ...(unknown ? { unknown_followers: unknown } : {}),
      ...(read.fxFails !== undefined ? { fx_fails: read.fxFails } : {}),
      ...(read.more ? { more: true } : {}),
      ...(read.unreadable ? { unreadable: true } : {}),
      cost_usd: usd(read.cost),
      ms: this.fc.now() - t0,
    });
    return { ok: true, kept: kept.length, fresh, dropped, unknown, fxFails: read.fxFails ?? null, cost: read.cost };
  }

  /** The posts and the ticks older than KEPT_MS go */
  prune(now = this.fc.now()): void {
    try {
      this.stmt.prunePosts.run(now - KEPT_MS);
      this.stmt.pruneTicks.run(now - KEPT_MS);
    } catch {
      // pruned on the next tick
    }
  }

  /** A tick whose source failed: kept as a failed row and logged with our error, its status and its cost when said */
  private failed(lane: CtLane, source: string, t0: number, e: unknown): ReadFail {
    const f = e instanceof ReadFail ? e : new ReadFail(e instanceof ToolFail ? e.code : "unavailable");
    this.record(lane, t0, source, false, 0, 0, f.cost);
    this.log("tools: ct radar", { lane, source, ok: false, error: f.code, ...(f.status !== null ? { status: f.status } : {}), ...(f.cost !== null ? { cost_usd: usd(f.cost) } : {}), ms: this.fc.now() - t0 });
    return f;
  }

  private record(lane: CtLane, at: number, source: string, ok: boolean, fetched: number, kept: number, cost: number | null): void {
    try {
      this.stmt.tick.run(lane, at, source, ok ? 1 : 0, fetched, kept, usd(cost));
    } catch {
      // the log line has it
    }
  }

  /** A JSON answer of an allowed host: its status and body (null when not JSON); a network failure throws unavailable */
  private async getJson(url: string, init: RequestInit & { signal: AbortSignal }): Promise<{ status: number; body: unknown }> {
    const res = await this.fc.http.raw(url, init);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: null };
    }
    const text = await readCapped(res, 4 * 1024 * 1024);
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: null };
    }
  }

  /**
   * FxTwitter's read of each post (its status API), FX_AT_ONCE at a time, each within FX_TIMEOUT_MS; null for a post it
   * could not read (down, a deleted post, an answer not its own shape), never thrown
   */
  async fxRead(ids: readonly string[], signal: AbortSignal): Promise<Map<string, FxPost | null>> {
    const out = new Map<string, FxPost | null>();
    await eachAtOnce([...new Set(ids)], FX_AT_ONCE, async (id) => {
      try {
        const { status, body } = await this.getJson(`https://${FXTWITTER_HOST}/2/status/${id}`, { method: "GET", headers: { "user-agent": READER_UA, accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(FX_TIMEOUT_MS)]) });
        out.set(id, status === 200 ? fxPost(body) : null);
      } catch {
        out.set(id, null);
      }
    });
    return out;
  }

  /**
   * One page of twitterapi.io's advanced search (one attempt, never sent twice: registry.ts toolsHedge), the newest first
   * since a beat before the last good read (an hour back at most); billed at TWEET_USD a tweet, one at least
   */
  private async readTwitterapi(now: number, signal: AbortSignal): Promise<Read> {
    const since = Math.floor(Math.max(now - LOOKBACK_MAX_MS, (this.lastTickAt("calls", true) ?? 0) - this.cfg.callsMin * MINUTE) / 1000);
    const qs = new URLSearchParams({ query: `${TWITTERAPI_QUERY} since_time:${since}`, queryType: "Latest" });
    const { status, body } = await this.getJson(`https://${TWITTERAPI_HOST}/twitter/tweet/advanced_search?${qs}`, { method: "GET", headers: { "x-api-key": this.cfg.twitterapiKey!, accept: "application/json" }, signal });
    if (status !== 200) throw new ReadFail(statusError(status), status);
    const page = twitterapiPosts(body);
    if (!page) throw new ReadFail("unavailable", status, TWEET_USD);
    return { posts: page.posts, count: page.count, cost: Math.max(1, page.count) * TWEET_USD, more: page.more };
  }

  /** Grok through OpenRouter with its X search (grokx.ts' request), one attempt; OpenRouter's own cost of it in usage.cost */
  private async askGrok(system: string, ask: string, fromMs: number, maxTokens: number, signal: AbortSignal): Promise<{ message: Record<string, unknown>; cost: number | null }> {
    const g = this.cfg.grok!;
    const { status, body } = await this.getJson(`${g.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${g.key}`, "x-title": "queen-harness", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: g.model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        // OpenRouter says what the call cost in its answer: each tick's spend is logged, never capped
        usage: { include: true },
        plugins: [{ id: "web", engine: "native", max_results: 1, x_search: { from_date: new Date(fromMs).toISOString().slice(0, 10) } }],
        messages: [
          { role: "system", content: system },
          { role: "user", content: ask },
        ],
      }),
      signal,
    });
    if (status !== 200) throw new ReadFail(statusError(status), status);
    const cost = isObj(body) && isObj(body.usage) ? num(body.usage.cost) : null;
    const message = isObj(body) && Array.isArray(body.choices) && isObj(body.choices[0]) ? body.choices[0].message : null;
    if (!isObj(message)) throw new ReadFail("unavailable", status, cost);
    return { message, cost };
  }

  /**
   * The calls feed on Grok: the newest calls over twice the beat (no follower floor, no count asked), only the posts its
   * search cited, each read again on FxTwitter (fxRead: the author's followers, the likes, views, time and whole text);
   * a post FxTwitter could not read stays as Grok gave it
   */
  private async readGrokCalls(now: number, signal: AbortSignal): Promise<Read> {
    const mins = Math.min(GROK_LOOKBACK_MAX_MIN, 2 * this.cfg.callsMin);
    return this.readGrok(
      "calls",
      callsSystem("the newest first"),
      `the newest posts on x from the last ${mins} minutes that call or shill a solana memecoin: a pump.fun or other solana contract address, or a $ticker with call words (aped, sending, gem, entry, ca, low cap, bonded, migrated, 10x).\n` +
        `original posts only, no replies or reposts; each post's link and its text as written, contract addresses whole. now is ${new Date(now).toISOString()}.`,
      now - mins * MINUTE,
      signal,
    );
  }

  /** The top calls on Grok: the most liked or most viewed calls of the last TOP_HOURS, as the feed's are read */
  private async readGrokTop(now: number, signal: AbortSignal): Promise<Read> {
    return this.readGrok(
      "top",
      callsSystem("the most liked or most viewed first"),
      `the most liked or most viewed posts on x from the last ${TOP_HOURS} hours that call or shill a solana memecoin: a pump.fun or other solana contract address, or a $ticker with call words (aped, sending, gem, entry, ca, low cap, bonded, migrated, 10x).\n` +
        `original posts only, no replies or reposts; each post's link and its text as written, contract addresses whole. now is ${new Date(now).toISOString()}.`,
      now - TOP_HOURS * HOUR,
      signal,
    );
  }

  /** One ask of Grok for a lane's calls: only the posts its search cited, each read again on FxTwitter over Grok's fields */
  private async readGrok(lane: CtLane, system: string, ask: string, fromMs: number, signal: AbortSignal): Promise<Read> {
    const { message, cost } = await this.askGrok(system, ask, fromMs, 3000, signal);
    const r = grokCallPosts(message)!;
    // an answer with no posts says what it was (its first characters: Grok's own words, no secret), to see why
    if (r.posts.length === 0 && r.uncited === 0) this.log("tools: ct radar empty answer", { lane, head: String(message.content ?? "").replace(/\s+/g, " ").slice(0, 160), cited: citedIds(message)?.size ?? 0 });
    const fx = await this.fxRead(r.posts.map((p) => p.id), signal);
    const posts = r.posts.map((p) => withFx(p, fx.get(p.id)));
    const fxFails = r.posts.filter((p) => !fx.get(p.id)).length;
    return { posts, count: r.posts.length + r.uncited, cost, uncited: r.uncited, fxFails, ...(r.readable ? {} : { unreadable: true }) };
  }

  // ─────────────────────────────── the reads

  /** A lane's last tick (ms), a good one only when `ok`; null for none */
  lastTickAt(lane: CtLane, ok: boolean): number | null {
    try {
      const r = (ok ? this.stmt.lastOk : this.stmt.lastTick).get(lane) as { at: number } | undefined;
      return r?.at ?? null;
    } catch {
      return null;
    }
  }

  /** Anything collected (kept 3 days)? */
  hasPosts(): boolean {
    return this.stmt.any.get() !== undefined;
  }

  /** The calls posted since `from` (ms), oldest first */
  postsSince(from: number): CtPost[] {
    return (this.stmt.since.all(from) as PostRow[]).map((r) => ({ id: r.id, url: r.url, handle: r.handle, followers: r.followers, likes: r.likes, views: r.views, postedAt: r.posted_at, text: r.text, mints: list(r.mints), tickers: list(r.tickers), seenAt: r.seen_at, source: r.source }));
  }

  /** When the calls feed last read its source (ms): its last good tick, else its newest call's read */
  asOf(): number | null {
    const tick = this.lastTickAt("calls", true);
    if (tick !== null) return tick;
    const r = this.stmt.lastSeen.get() as { at: number | null } | undefined;
    return r?.at ?? null;
  }
}

// ─────────────────────────────── calls by coin

/** One coin's call: the post, and whether it posted the coin's address (else its ticker, read as that address) */
interface CoinCall {
  post: CtPost;
  ca: boolean;
}

export interface Coin {
  /** "m:<mint>" or "t:<TICKER>" */
  key: string;
  mint: string | null;
  ticker: string | null;
  /** Oldest first, one a post */
  calls: CoinCall[];
}

/**
 * The coins of the calls read (oldest first): each post's mints, else its tickers. A ticker only one mint was posted with
 * (in a post naming that ticker and that mint alone) stands for that mint: a call naming the ticker alone counts for it;
 * a ticker posted with several mints (copies share tickers) or with none stays a coin of its own. A mint's ticker is the
 * one posted beside it alone the most. `pairs`: each ticker's mints so posted.
 */
export function coinsOf(posts: readonly CtPost[]): { coins: Map<string, Coin>; pairs: Map<string, Map<string, number>> } {
  const pairs = new Map<string, Map<string, number>>();
  const labels = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, a: string, b: string) => {
    const inner = m.get(a) ?? new Map<string, number>();
    inner.set(b, (inner.get(b) ?? 0) + 1);
    m.set(a, inner);
  };
  for (const p of posts)
    if (p.mints.length === 1 && p.tickers.length === 1) {
      bump(pairs, p.tickers[0]!, p.mints[0]!);
      bump(labels, p.mints[0]!, p.tickers[0]!);
    }
  const coins = new Map<string, Coin>();
  const add = (key: string, mint: string | null, ticker: string | null, post: CtPost, ca: boolean) => {
    let c = coins.get(key);
    if (!c) coins.set(key, (c = { key, mint, ticker, calls: [] }));
    if (c.calls.at(-1)?.post.id !== post.id) c.calls.push({ post, ca });
  };
  const sorted = [...posts].sort((a, b) => a.postedAt - b.postedAt || a.id.localeCompare(b.id));
  for (const p of sorted) {
    if (p.mints.length) for (const m of p.mints) add(`m:${m}`, m, null, p, true);
    else
      for (const t of p.tickers) {
        const ms = pairs.get(t);
        const only = ms && ms.size === 1 ? [...ms.keys()][0]! : null;
        if (only) add(`m:${only}`, only, null, p, false);
        else add(`t:${t}`, null, t, p, false);
      }
  }
  for (const c of coins.values()) {
    if (!c.mint) continue;
    const named = [...(labels.get(c.mint) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    c.ticker = named[0]?.[0] ?? null;
  }
  return { coins, pairs };
}

/**
 * The callers of some calls (a coin's, a narrative's), one each (the first call's link, the most followers any of its
 * posts gave; null when none of them said: not known), oldest first
 */
function callersOf(posts: readonly CtPost[]): { handle: string; followers: number | null; url: string; at: number }[] {
  const by = new Map<string, { handle: string; followers: number | null; url: string; at: number }>();
  for (const post of posts) {
    const k = post.handle.toLowerCase();
    const cur = by.get(k);
    if (!cur) by.set(k, { handle: post.handle, followers: post.followers, url: post.url, at: post.postedAt });
    else if (post.followers !== null) cur.followers = Math.max(cur.followers ?? 0, post.followers);
  }
  return [...by.values()];
}

/** One coin as the ranking shows it */
export interface CoinRow {
  mint: string | null;
  ticker: string | null;
  callers: number;
  reach: number;
  posts: number;
  likes: number;
  first_call: { handle: string; followers: number | null; at: string; url: string };
  top_callers: { handle: string; followers: number | null; url: string }[];
  minutes_since_first: number;
  /** Its callers whose follower count is not known (reach leaves them out) */
  followers_unknown?: number;
}

/**
 * The coins ranked: by distinct callers, then reach (their known followers summed: a count not known adds nothing and is
 * counted in followers_unknown), then the earliest first call
 */
export function rankCoins(coins: Iterable<Coin>, now: number): CoinRow[] {
  const rows = [...coins].map((c) => {
    const callers = callersOf(c.calls.map((x) => x.post));
    const first = c.calls[0]!.post;
    return {
      at: first.postedAt,
      key: c.key,
      row: {
        mint: c.mint,
        ticker: c.ticker ? `$${c.ticker}` : null,
        callers: callers.length,
        reach: callers.reduce((s, x) => s + (x.followers ?? 0), 0),
        posts: c.calls.length,
        likes: c.calls.reduce((s, x) => s + (x.post.likes ?? 0), 0),
        first_call: { handle: first.handle, followers: first.followers, at: iso(first.postedAt), url: first.url },
        top_callers: [...callers].sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1) || a.at - b.at).slice(0, 3).map(({ handle, followers, url }) => ({ handle, followers, url })),
        minutes_since_first: Math.max(0, Math.round((now - first.postedAt) / MINUTE)),
        ...(callers.some((x) => x.followers === null) ? { followers_unknown: callers.filter((x) => x.followers === null).length } : {}),
      } satisfies CoinRow,
    };
  });
  rows.sort((a, b) => b.row.callers - a.row.callers || b.row.reach - a.row.reach || a.at - b.at || a.key.localeCompare(b.key));
  return rows.map((r) => r.row);
}

// ─────────────────────────────── narratives from the calls

/** A coin's narrative label in our own index (FreeContext.narrativeOf: the pump.fun index's card), or null */
export type LabelOf = (mint: string) => { narrative: string | null; group: string | null } | null;

/** A call as a narrative's row shows it */
interface CallAt {
  handle: string;
  followers: number | null;
  at: string;
  url: string;
}
const callAt = (p: CtPost): CallAt => ({ handle: p.handle, followers: p.followers, at: iso(p.postedAt), url: p.url });

/** One narrative as the view shows it */
export interface NarrativeRow {
  narrative: string;
  group: string | null;
  /** Its coins, the most callers first */
  coins: { mint: string | null; ticker: string | null; callers: number }[];
  more_coins?: number;
  callers: number;
  reach: number;
  posts: number;
  first_call: CallAt;
  newest_call: CallAt;
  trend: "heating" | "steady" | "fading";
  /** Its callers whose follower count is not known (reach leaves them out) */
  followers_unknown?: number;
}

/**
 * The called coins grouped by our own narrative label of each mint (its narrative, else its group; a coin with no label,
 * a ticker never posted with a mint among them, under UNLABELLED, listed last): per narrative its coins (the most callers
 * first), its distinct callers and reach over all of them, its posts (a post naming two of its coins once), its first and
 * newest call, and its trend: heating when more of its calls fall in the window's last third than in its first, fading
 * when fewer, else steady; the most distinct callers first, then reach, then the earliest first call
 */
export function narrativesFrom(coins: Iterable<Coin>, now: number, windowMs: number, labelOf: LabelOf | undefined): NarrativeRow[] {
  const by = new Map<string, { narrative: string; group: string | null; coins: Coin[] }>();
  for (const c of coins) {
    const l = c.mint && labelOf ? labelOf(c.mint) : null;
    const name = l?.narrative ?? l?.group ?? null;
    const key = name ? name.toLowerCase() : "";
    let n = by.get(key);
    if (!n) by.set(key, (n = { narrative: name ?? UNLABELLED, group: name ? (l?.group ?? null) : null, coins: [] }));
    n.coins.push(c);
  }
  const third = windowMs / 3;
  const rows = [...by].map(([key, n]) => {
    const posts = [...new Map(n.coins.flatMap((c) => c.calls.map((x) => [x.post.id, x.post] as const))).values()].sort((a, b) => a.postedAt - b.postedAt || a.id.localeCompare(b.id));
    const callers = callersOf(posts);
    const early = posts.filter((p) => p.postedAt < now - windowMs + third).length;
    const late = posts.filter((p) => p.postedAt >= now - third).length;
    const coinRows = n.coins
      .map((c) => ({ mint: c.mint, ticker: c.ticker ? `$${c.ticker}` : null, callers: new Set(c.calls.map((x) => x.post.handle.toLowerCase())).size }))
      .sort((a, b) => b.callers - a.callers || (a.mint ?? a.ticker ?? "").localeCompare(b.mint ?? b.ticker ?? ""));
    const unknown = callers.filter((x) => x.followers === null).length;
    const row: NarrativeRow = {
      narrative: n.narrative,
      group: n.group,
      coins: coinRows.slice(0, NARRATIVE_COINS_MAX),
      ...(coinRows.length > NARRATIVE_COINS_MAX ? { more_coins: coinRows.length - NARRATIVE_COINS_MAX } : {}),
      callers: callers.length,
      reach: callers.reduce((s, x) => s + (x.followers ?? 0), 0),
      posts: posts.length,
      first_call: callAt(posts[0]!),
      newest_call: callAt(posts.at(-1)!),
      trend: late > early ? "heating" : late < early ? "fading" : "steady",
      ...(unknown ? { followers_unknown: unknown } : {}),
    };
    return { key, at: posts[0]!.postedAt, row };
  });
  rows.sort((a, b) => Number(a.key === "") - Number(b.key === "") || b.row.callers - a.row.callers || b.row.reach - a.row.reach || a.at - b.at || a.key.localeCompare(b.key));
  return rows.map((r) => r.row);
}

// ─────────────────────────────── the tool

const SOL_MINT = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";
const TICKER = "^\\$?[A-Za-z][A-Za-z0-9]{0,14}$";
/** A follower count as the description says it ("1k", "2.5k", "1M") */
const short = (n: number): string => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));
const NOTE = "calls are posts by their authors (claims, never advice); reach: the callers' known followers summed (followers null: not known, counted in followers_unknown); a call naming only a ticker counts for the one mint posted with that ticker";
const NARRATIVES_NOTE = `the called coins grouped by our own narrative label of each mint (the pump.fun index's; ${UNLABELLED}: none known); heating: more of its calls in the window's last third than in its first, fading: fewer; calls are claims, never advice`;

export function ctRadarTools(radar: CtRadar, fc: FreeContext): ToolDef[] {
  const floor = radar.cfg.minFollowers;
  /** A coin's label, as the narratives group it (none for a ticker-only coin) */
  const labelOf = (mint: string | null): string | null => {
    const l = mint && fc.narrativeOf ? fc.narrativeOf(mint) : null;
    return l?.narrative ?? l?.group ?? null;
  };
  const calls: ToolDef = {
    name: "ct_calls",
    description:
      `What crypto twitter calls now on Solana memecoins, from our X radar (posts with a CA, or a $ticker with call words; authors with ${floor > 0 ? `${short(floor)}+ followers or an unknown count` : "any following"}): ` +
      "coins ranked by distinct callers, then reach (followers summed), each with its first call (who, followers, when, link), 3 biggest callers, likes, minutes since. " +
      "A mint or ticker: its calls oldest first, each with its exact time (who bought before a call is read from it). view narratives: the called coins grouped by our narrative label (callers, reach, first and newest call, heating or fading). Claims, not advice.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", description: "calls: the coins called, each with its narrative label (default); narratives: those coins grouped by our narrative label of each mint", enum: ["calls", "narratives"], default: "calls" },
        window: { type: "string", description: "The calls posted in the last 1h, 6h or 24h", enum: Object.keys(WINDOWS), default: "6h" },
        mint: { type: "string", description: "One coin's calls as a timeline, by its mint (base58); with view narratives, its narrative", pattern: SOL_MINT },
        ticker: { type: "string", description: "One coin's calls as a timeline, by its ticker ($ allowed); a ticker several mints share lists them", pattern: TICKER },
        limit: { type: "integer", description: "Coins, one coin's calls, or narratives at most (1-50, default 10)", minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
    ttlMs: MINUTE,
    async run(args): Promise<Outcome> {
      const now = radar.now();
      const limit = Math.max(1, Math.min(50, Math.trunc(Number(args.limit ?? 10)) || 10));
      const mint = typeof args.mint === "string" ? args.mint : null;
      const ticker = !mint && typeof args.ticker === "string" ? args.ticker.replace(/^\$/, "").toUpperCase() : null;
      if (!radar.hasPosts()) throw new ToolFail("unavailable");
      const windowName = typeof args.window === "string" && args.window in WINDOWS ? args.window : "6h";
      const posts = radar.postsSince(now - WINDOWS[windowName]!);
      const { coins, pairs } = coinsOf(posts);
      const asOf = radar.asOf();
      const fresh = {
        window: windowName,
        as_of: asOf !== null ? iso(asOf) : null,
        ...(asOf !== null && now - asOf > STALE_BEATS * radar.cfg.callsMin * MINUTE ? { stale: `the radar's last read was ${Math.round((now - asOf) / MINUTE)} min ago: calls since then are missing` } : {}),
      };
      if (args.view === "narratives") {
        // computed from the calls in the window, each coin under its own label (a coin asked: its narrative alone)
        const all = narrativesFrom(coins.values(), now, WINDOWS[windowName]!, fc.narrativeOf);
        const list = mint || ticker ? all.filter((n) => n.coins.some((c) => (mint !== null && c.mint === mint) || (ticker !== null && c.ticker === `$${ticker}`))) : all;
        const shown = list.slice(0, limit);
        return {
          ok: true,
          data: { ...fresh, posts_read: posts.length, narratives: shown, more: Math.max(0, list.length - shown.length), note: NARRATIVES_NOTE },
          sources: uniqueSources(shown.map((n) => src(`@${n.first_call.handle} on X`, n.first_call.url))),
        };
      }
      if (!mint && !ticker) {
        const rows = rankCoins(coins.values(), now);
        const shown = rows.slice(0, limit);
        return {
          ok: true,
          data: {
            ...fresh,
            posts_read: posts.length,
            coins: shown.map((r) => {
              const label = labelOf(r.mint);
              return label ? { ...r, narrative: label } : r;
            }),
            more: Math.max(0, rows.length - shown.length),
            note: NOTE,
          },
          sources: uniqueSources(shown.map((r) => src(`@${r.first_call.handle} on X`, r.first_call.url))),
        };
      }
      // one coin: its calls oldest first; a ticker only one mint was posted with is that mint's coin
      const paired = ticker ? pairs.get(ticker) : undefined;
      const asMint = mint ?? (paired && paired.size === 1 ? [...paired.keys()][0]! : null);
      let timeline: CoinCall[];
      let mints: { mint: string; posts: number }[] | null = null;
      if (asMint) timeline = coins.get(`m:${asMint}`)?.calls ?? [];
      else {
        timeline = posts.filter((p) => p.tickers.includes(ticker!)).map((post) => ({ post, ca: post.mints.length > 0 }));
        const counted = new Map<string, number>();
        for (const { post } of timeline) for (const m of post.mints) counted.set(m, (counted.get(m) ?? 0) + 1);
        mints = [...counted].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => ({ mint: m, posts: n }));
      }
      if (!timeline.length) return { ok: false, error: "not_found", message: `no call of this coin in the last ${windowName}` };
      const coin: Coin = { key: asMint ? `m:${asMint}` : `t:${ticker}`, mint: asMint, ticker: asMint ? (coins.get(`m:${asMint}`)?.ticker ?? null) : ticker, calls: timeline };
      const row = rankCoins([coin], now)[0]!;
      const shown = timeline.slice(0, limit);
      const label = labelOf(coin.mint);
      return {
        ok: true,
        data: {
          ...fresh,
          mint: row.mint,
          ticker: row.ticker,
          callers: row.callers,
          reach: row.reach,
          posts: row.posts,
          likes: row.likes,
          first_call: row.first_call,
          last_call_at: iso(timeline.at(-1)!.post.postedAt),
          calls: shown.map(({ post, ca }) => ({ at: iso(post.postedAt), handle: post.handle, followers: post.followers, likes: post.likes, views: post.views, url: post.url, text: post.text, ca })),
          more: Math.max(0, timeline.length - shown.length),
          ...(mints ? { mints } : {}),
          ...(label ? { narrative: label } : {}),
          note: NOTE,
        },
        sources: uniqueSources(shown.map(({ post }) => src(`@${post.handle} on X`, post.url))),
      };
    },
  };
  return [calls];
}
