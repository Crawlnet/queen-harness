// X (Twitter) for the card. X is usually the clearest source of a project's idea, so:
//   a profile → bio + the pinned post + the last 3 posts; a post → its text + author; a community → its description + 3 posts.
// Providers: the official X API v2 (BEARER, app-only, paid reads) → twitterapi.io (KEY) → fxtwitter. Here both BEARER
// and KEY are off (null below): fxtwitter only.
// Timelines and pinned posts need auth: X's syndication answers 429, fxtwitter's timeline 404.
// The full cards try a paid provider first; the light labels of every migration try the free fxtwitter first, and a
// paid provider only when it did not answer.
import fs from 'fs';

const env = (() => { try { return fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return ''; } })();
const fromEnv = k => process.env[k] || env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
// the free fxtwitter only (no paid X reader)
const BEARER = null;
const KEY = null;
void fromEnv;
export const xProvider = () => (BEARER ? 'xapi' : KEY ? 'twitterapi' : 'fxtwitter');
export const xStats = { xapi: 0, xapiErr: 0, fx: 0 };

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; queen-harness/0.1)' };
const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : '');
const cache = new Map(); // url → {at, v}: clones often link the same post
const TTL = 6 * 3600 * 1000;

export function parseX(url) {
  const u = String(url || '');
  let m;
  if ((m = u.match(/(?:x|twitter)\.com\/i\/communities\/(\d+)/))) return { kind: 'community', id: m[1] };
  if ((m = u.match(/(?:x|twitter)\.com\/(?:i\/(?:web\/)?status|[A-Za-z0-9_]{1,15}\/status(?:es)?)\/(\d+)/))) return { kind: 'tweet', id: m[1] };
  if ((m = u.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/)) && !['home', 'search', 'intent', 'share', 'i', 'hashtag'].includes(m[1].toLowerCase())) return { kind: 'profile', handle: m[1] };
  return { kind: /(x|twitter)\.com/.test(u) ? 'other' : 'not-x' };
}

async function tapi(path) {
  const r = await fetch(`https://api.twitterapi.io${path}`, { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`twitterapi ${r.status}`);
  return r.json();
}

const slimTweet = t => t && ({
  url: t.url, text: clip(t.text, 500), at: t.createdAt,
  author: t.author?.userName, authorName: t.author?.name, authorFollowers: t.author?.followers, authorBio: clip(t.author?.description, 200) || undefined,
  likes: t.likeCount, retweets: t.retweetCount, replies: t.replyCount, views: t.viewCount,
  quote: t.quoted_tweet ? clip(`@${t.quoted_tweet.author?.userName}: ${t.quoted_tweet.text}`, 300) : undefined,
  retweetOf: t.retweeted_tweet ? clip(`@${t.retweeted_tweet.author?.userName}: ${t.retweeted_tweet.text}`, 300) : undefined,
  isReply: t.isReply || undefined,
});

async function viaTwitterapi(p, light) {
  if (p.kind === 'tweet') {
    const j = await tapi(`/twitter/tweets?tweet_ids=${p.id}`);
    return { tweet: slimTweet((j.tweets || j.data?.tweets || [])[0]) };
  }
  if (p.kind === 'profile') {
    const j = await tapi(`/twitter/user/info?userName=${p.handle}`);
    const u = j.data || j;
    const profile = { handle: u.userName || p.handle, name: u.name, bio: clip(u.description || u.profile_bio?.description, 300), followers: u.followers,
      following: u.following, tweets: u.statusesCount, createdAt: u.createdAt, verified: u.isBlueVerified || undefined, unavailable: u.unavailable || undefined };
    if (light) return { profile };
    const pinId = (u.pinnedTweetIds || [])[0];
    const [pin, last] = await Promise.all([
      pinId ? tapi(`/twitter/tweets?tweet_ids=${pinId}`).then(x => slimTweet((x.tweets || x.data?.tweets || [])[0])).catch(() => null) : null,
      tapi(`/twitter/user/last_tweets?userName=${p.handle}`).then(x => (x.tweets || x.data?.tweets || [])).catch(() => []),
    ]);
    return { profile, pinned: pin || undefined, recent: last.filter(t => t.id !== pinId).slice(0, 3).map(slimTweet) };
  }
  if (p.kind === 'community') {
    const j = await tapi(`/twitter/community/info?community_id=${p.id}`);
    const c = j.community_info || j.data || {};
    const community = { name: c.name, description: clip(c.description, 400), members: c.member_count, createdAt: c.created_at, topic: c.primary_topic?.name };
    if (light) return { community };
    const tw = await tapi(`/twitter/community/tweets?community_id=${p.id}`).then(x => x.tweets || x.data?.tweets || []).catch(() => []);
    return { community, recent: tw.slice(0, 3).map(slimTweet) };
  }
  return {};
}

// ---------- the official X API v2 ----------
async function xapi(path) {
  xStats.xapi++;
  const r = await fetch(`https://api.x.com/2/${path}`, { headers: { authorization: `Bearer ${BEARER}` }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.data) { xStats.xapiErr++; throw Error(`x api ${r.status}: ${j.title || j.detail || ''}`.trim()); }
  return j;
}
const TF = 'tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet,author_id';
const UF = 'user.fields=username,name,description,public_metrics,created_at,verified,pinned_tweet_id';
const txt = t => t?.note_tweet?.text || t?.text;
function xTweet(t, inc = {}) {
  if (!t) return null;
  const users = Object.fromEntries((inc.users || []).map(u => [u.id, u]));
  const tweets = Object.fromEntries((inc.tweets || []).map(x => [x.id, x]));
  const a = users[t.author_id];
  const ref = type => { const r = (t.referenced_tweets || []).find(x => x.type === type); const rt = r && tweets[r.id]; return rt ? clip(`@${users[rt.author_id]?.username || '?'}: ${txt(rt)}`, 300) : undefined; };
  const m = t.public_metrics || {};
  return {
    url: a ? `https://x.com/${a.username}/status/${t.id}` : `https://x.com/i/status/${t.id}`, text: clip(txt(t), 500), at: t.created_at,
    author: a?.username, authorName: a?.name, authorFollowers: a?.public_metrics?.followers_count, authorBio: clip(a?.description, 200) || undefined,
    likes: m.like_count, retweets: m.retweet_count, replies: m.reply_count, views: m.impression_count,
    quote: ref('quoted'), retweetOf: ref('retweeted'), reply: ref('replied_to') ? true : undefined,
  };
}
async function viaXapi(p, light) {
  if (p.kind === 'tweet') {
    const j = await xapi(`tweets/${p.id}?${TF}&expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id&${UF}`);
    return { tweet: xTweet(j.data, j.includes) };
  }
  if (p.kind === 'profile') {
    const j = await xapi(`users/by/username/${p.handle}?${UF}&expansions=pinned_tweet_id&${TF}`);
    const u = j.data;
    if (!u) return { error: 'profile not found' };
    const pm = u.public_metrics || {};
    const profile = { handle: u.username, name: u.name, bio: clip(u.description, 300), followers: pm.followers_count, following: pm.following_count,
      tweets: pm.tweet_count, createdAt: u.created_at, verified: u.verified || undefined };
    if (light) return { profile };
    // the pinned post's expansion often answers "Could not find tweet" for a live pinned_tweet_id → fetched by its id
    let pinned = xTweet((j.includes?.tweets || [])[0], { users: [u] });
    if (!pinned && u.pinned_tweet_id) {
      const pj = await xapi(`tweets/${u.pinned_tweet_id}?${TF}&expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id&${UF}`).catch(() => null);
      pinned = xTweet(pj?.data, pj?.includes);
    }
    const tl = await xapi(`users/${u.id}/tweets?max_results=5&exclude=replies&${TF}&expansions=referenced_tweets.id,referenced_tweets.id.author_id&${UF}`).catch(() => null);
    const inc = { users: [u, ...(tl?.includes?.users || [])], tweets: tl?.includes?.tweets || [] };
    const recent = (tl?.data || []).filter(t => t.id !== u.pinned_tweet_id).slice(0, 3).map(t => xTweet(t, inc));
    return { profile, pinned: pinned || undefined, recent };
  }
  if (p.kind === 'community') {
    const j = await xapi(`communities/${p.id}?community.fields=name,description,member_count,created_at`);
    const c = j.data || {};
    return { community: { name: c.name, description: clip(c.description, 400), members: c.member_count, createdAt: c.created_at } };
  }
  return {};
}

async function fx(path) {
  xStats.fx++;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`https://api.fxtwitter.com${path}`, { headers: UA, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.tweet || j.user) return j;
    } catch {}
  }
  return null;
}

async function viaFx(p) {
  if (p.kind === 'tweet') {
    const t = (await fx(`/status/${p.id}`))?.tweet;
    return t ? { tweet: { url: t.url, text: clip(t.text, 500), at: t.created_timestamp, author: t.author?.screen_name, authorName: t.author?.name,
      authorFollowers: t.author?.followers, likes: t.likes, retweets: t.retweets, views: t.views, quote: t.quote ? clip(`@${t.quote.author?.screen_name}: ${t.quote.text}`, 300) : undefined } } : {};
  }
  if (p.kind === 'profile') {
    const u = (await fx(`/2/profile/${p.handle}`))?.user;
    return u ? { profile: { handle: u.screen_name, name: u.name, bio: clip(u.description, 300), followers: u.followers, tweets: u.statuses, createdAt: u.joined } } : {};
  }
  return {}; // fxtwitter has no communities
}

// light = only what is cheap (for the light labels of every migration): a post / a profile without its timeline / a community without its posts
export async function xInfo(url, { light = false } = {}) {
  if (!url) return null;
  const p = parseX(url);
  if (p.kind === 'not-x') return null;
  const key = `${light ? 'l' : 'f'}:${p.kind}:${p.id || p.handle || url}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.v;
  let data = {}, via = null;
  const ok = d => d && (d.tweet || d.profile || d.community);
  if (p.kind !== 'other') {
    // light: the free fxtwitter first; full: a paid provider first (only those have the pinned post and the timeline)
    const chain = light ? ['fx', BEARER && 'xapi', KEY && 'twitterapi'] : [BEARER && 'xapi', KEY && 'twitterapi', 'fx'];
    for (const prov of chain.filter(Boolean)) {
      try {
        const d = prov === 'xapi' ? await viaXapi(p, light) : prov === 'twitterapi' ? await viaTwitterapi(p, light) : await viaFx(p);
        if (ok(d)) { data = d; via = prov; break; }
        if (d?.error) data = d;
      } catch (e) { data = { error: e.message }; }
    }
  }
  const v = { url, kind: p.kind, via, ...data };
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return v;
}
