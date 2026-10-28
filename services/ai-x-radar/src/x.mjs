// The X data layer. Providers:
//   fx   — the FxTwitter API v2 (api.fxtwitter.com), free, no key. /2/search takes X's syntax:
//          from:, to:, quoted_tweet_id:, url:, since_time:, until_time:, min_faves:, lang:, filter:media, -filter:replies, OR.
//          20 posts a page, a cursor. A limit of 1000 req/min per IP. Uptime over 7–30 days ~80%, so a fallback is needed.
//   tapi — twitterapi.io (TWITTERAPI_KEY), $0.15 per 1k tweets, the same advanced-search syntax. Used when fx fails
//          (a circuit breaker) or returns nothing where it should not.
// A limit of X search: the posts of NEW accounts (days old) do not show up in search.
// For those: profileStatuses() (fx /2/profile/:h/statuses, which works only at times) or tapi's last_tweets.
import { env } from './env.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; queen-harness/0.1)' };
// FxTwitter's search goes down for days at a time: the radar reads X reliably only with TWITTERAPI_KEY set
const TAPI_KEY = env('TWITTERAPI_KEY') || null;
export const stats = { fx: 0, fxErr: 0, fxEmpty: 0, tapi: 0, tapiErr: 0, tweets: 0 };

// the canary: a query that must return something; 0 → fx is degraded
export async function canary() {
  try { return (await search('from:karpathy OR from:OpenAI OR from:AnthropicAI', { pages: 1, retryEmpty: true })).length; } catch { return 0; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- normalization ----------
const urlsIn = s => [...new Set((String(s || '').match(/https?:\/\/[^\s)]+/g) || []).map(u => u.replace(/[.,;:!?…]+$/, '')))];

function fxNorm(t) {
  if (!t?.id) return null;
  const a = t.author || {};
  const q = t.quote;
  return {
    id: t.id, url: t.url || `https://x.com/${a.screen_name}/status/${t.id}`,
    text: t.text || '', at: t.created_timestamp, lang: t.lang,
    author: { handle: a.screen_name, name: a.name, followers: a.followers ?? null, bio: a.description, joined: a.joined, verified: a.verification?.verified || undefined },
    views: t.views ?? null, likes: t.likes ?? 0, rts: t.reposts ?? 0, quotes: t.quotes ?? 0, replies: t.replies ?? 0, bookmarks: t.bookmarks ?? 0,
    replyTo: t.replying_to ? (t.replying_to.screen_name || t.replying_to) : undefined,
    repostedBy: t.reposted_by ? (t.reposted_by.screen_name || true) : undefined,
    quote: q ? fxNorm(q) : undefined,
    media: (t.media?.all || []).map(m => ({ type: m.type, url: m.url, thumb: m.thumbnail_url || (m.type === 'photo' ? m.url : undefined) })),
    links: urlsIn(t.text).concat(t.embed_card?.url ? [t.embed_card.url] : []),
    src: 'fx',
  };
}

function tapiNorm(t) {
  if (!t?.id) return null;
  const a = t.author || {};
  const q = t.quoted_tweet;
  return {
    id: t.id, url: t.url || `https://x.com/${a.userName}/status/${t.id}`,
    text: t.text || '', at: t.createdAt ? Math.floor(Date.parse(t.createdAt) / 1000) : null, lang: t.lang,
    author: { handle: a.userName, name: a.name, followers: a.followers ?? null, bio: a.description, joined: a.createdAt, verified: a.isBlueVerified || undefined },
    views: t.viewCount ?? null, likes: t.likeCount ?? 0, rts: t.retweetCount ?? 0, quotes: t.quoteCount ?? 0, replies: t.replyCount ?? 0, bookmarks: t.bookmarkCount ?? 0,
    replyTo: t.isReply ? (t.inReplyToUsername || true) : undefined,
    quote: q ? tapiNorm(q) : undefined,
    media: (t.extendedEntities?.media || []).map(m => ({ type: m.type, url: m.media_url_https, thumb: m.media_url_https })),
    links: urlsIn(t.text),
    src: 'tapi',
  };
}

// ---------- transport ----------
let fxDownUntil = 0; // the circuit breaker: after a run of failures fx rests and the requests go to tapi
let fxFails = 0;

async function fxGet(path) {
  for (let i = 0; i < 3; i++) {
    stats.fx++;
    try {
      const r = await fetch(`https://api.fxtwitter.com${path}`, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) throw Error(`fx ${r.status}`);
      const j = await r.json();
      fxFails = 0;
      return j;
    } catch (e) {
      stats.fxErr++;
      if (++fxFails >= 6) { fxDownUntil = Date.now() + 10 * 60e3; fxFails = 0; }
      if (i === 2) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

// twitterapi.io: 0.2 QPS without a balance, 3–20 with one → one throttle for all workers + a long backoff on a 429
const TAPI_GAP = +(env('TWITTERAPI_GAP_MS') || 600);
let tapiNext = 0;
async function tapiGet(path) {
  if (!TAPI_KEY) throw Error('fx is unavailable and TWITTERAPI_KEY is not set');
  for (let i = 0; i < 4; i++) {
    const wait = tapiNext - Date.now();
    tapiNext = Math.max(Date.now(), tapiNext) + TAPI_GAP;
    if (wait > 0) await sleep(wait);
    stats.tapi++;
    try {
      const r = await fetch(`https://api.twitterapi.io${path}`, { headers: { 'x-api-key': TAPI_KEY }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) throw Error(`tapi ${r.status}`);
      if (!r.ok) { const e = Object.assign(Error(`tapi ${r.status}: ${(await r.text()).slice(0, 150)}`), { fatal: true }); stats.tapiFatal = e.message; throw e; }
      return await r.json();
    } catch (e) {
      stats.tapiErr++;
      if (e.fatal || i === 3) throw e;
      await sleep(5000 * 2 ** i);
    }
  }
}

const fxUp = () => Date.now() > fxDownUntil;
export const hasTapi = () => !!TAPI_KEY;
// the twitterapi.io credits left (1 tweet ≈ 15 credits, $1 = 100k); null: could not tell
export async function tapiBalance() {
  if (!TAPI_KEY) return null;
  try {
    const r = await fetch('https://api.twitterapi.io/oapi/my/info', { headers: { 'x-api-key': TAPI_KEY }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    return (+j.recharge_credits || 0) + (+j.total_bonus_credits || 0);
  } catch { return null; }
}
// fx "up, but answering 404 or nothing" is no failure to the breaker, so the canary switches it explicitly
export const forceTapi = (ms = 6 * 3600e3) => { fxDownUntil = Date.now() + ms; };

// ---------- search ----------
// q: a query in X's syntax. pages: how many pages of ~20. feed: 'latest' | 'top'.
// retryEmpty: only for the collect queries, where empty is suspicious; in enrichment empty is normal
export async function search(q, { pages = 1, feed = 'latest', retryEmpty = false } = {}) {
  const out = [], seen = new Set();
  let cursor = null;
  for (let p = 0; p < pages; p++) {
    let batch = [], next = null, viaTapi = !fxUp() || cursor?.startsWith('tapi:');
    if (!viaTapi) {
      try {
        const qs = new URLSearchParams({ q, ...(feed !== 'latest' ? { feed } : {}), ...(cursor ? { cursor } : {}) });
        let j = await fxGet(`/2/search?${qs}`);
        // fx's silent failure: a 200 with an empty first page (its account pool ran out) → two retries with a pause
        for (let r = 0; retryEmpty && p === 0 && !(j.results || []).length && r < 2; r++) {
          stats.fxEmpty++;
          await sleep(6000 * (r + 1));
          j = await fxGet(`/2/search?${qs}`);
        }
        batch = (j.results || []).map(fxNorm).filter(Boolean);
        next = j.cursor?.bottom || null;
      } catch (e) { if (!TAPI_KEY) throw e; viaTapi = true; cursor = null; }
    }
    if (viaTapi) { // fx is down → the same query to twitterapi.io (the cursors differ, so the pages start over)
      const qs = new URLSearchParams({ query: q, queryType: feed === 'top' ? 'Top' : 'Latest', ...(cursor?.startsWith('tapi:') ? { cursor: cursor.slice(5) } : {}) });
      const j = await tapiGet(`/twitter/tweet/advanced_search?${qs}`);
      batch = (j.tweets || []).map(tapiNorm).filter(Boolean);
      next = j.has_next_page && j.next_cursor ? 'tapi:' + j.next_cursor : null;
    }
    const fresh = batch.filter(t => !seen.has(t.id));
    fresh.forEach(t => seen.add(t.id));
    out.push(...fresh);
    if (!fresh.length || !next) break;
    cursor = next;
    await sleep(300);
  }
  stats.tweets += out.length;
  return out;
}

export async function getTweet(id) {
  if (fxUp()) {
    try { const j = await fxGet(`/2/status/${id}`); return fxNorm(j.status); } catch (e) { if (!TAPI_KEY) throw e; }
  }
  const j = await tapiGet(`/twitter/tweets?tweet_ids=${id}`);
  return tapiNorm((j.tweets || [])[0]);
}

// a post's quotes: quoted_tweet_id: through search
export const quotesOf = (id, pages = 3, asOf = null) => search(`quoted_tweet_id:${id}` + (asOf ? ` until_time:${asOf}` : ''), { pages });

// the timeline of an account search does not show (a new account): fx statuses → tapi last_tweets
export async function profileStatuses(handle) {
  if (fxUp()) {
    try {
      const j = await fxGet(`/2/profile/${handle}/statuses`);
      const r = (j.results || []).map(fxNorm).filter(Boolean);
      if (r.length) return r;
    } catch {}
  }
  if (!TAPI_KEY) return [];
  const j = await tapiGet(`/twitter/user/last_tweets?userName=${handle}`);
  return (j.tweets || j.data?.tweets || []).map(tapiNorm).filter(Boolean);
}

export async function profile(handle) {
  try { const j = await fxGet(`/${handle}`); return j.user || null; } catch { return null; }
}
