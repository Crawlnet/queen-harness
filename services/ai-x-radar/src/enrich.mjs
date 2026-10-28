// Enriching an idea's cluster:
//   the root: if the top post quotes a more viewed one, the original source is the quoted post;
//   the spread: the root's quotes: notable quoters (≥10k), languages, "i built" remixes;
//   the crypto bridge: CAs, tickers and pump in the quotes, and how soon the first one came;
//   tokenized?: a DexScreener search by the terms, the pairs created after the root post.
import { quotesOf, getTweet, search } from './x.mjs';
import { excluded } from './queries.mjs';

const CA_SOL = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const CA_EVM = /\b0x[a-fA-F0-9]{40}\b/g;
const TICKER = /(?:^|\s)\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
const CRYPTO_WORDS = /\b(pump\.?fun|pumpswap|memecoin|token|coin|ca\b|contract|launch(ed)?|deploy(ed)?|creator fees?|mcap|market ?cap|ape|bags?|chart|dex(screener)?)\b/i;
const REMIX = /\b(i built|i made|we built|just built|one prompt|one-shot|vibe coded|so i built|i might steal|inspired by|my version|recreated|remix)\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function rootOf(cluster) {
  const main = [...cluster.posts].sort((a, b) => (b.views || 0) - (a.views || 0))[0];
  let root = main;
  for (const p of cluster.posts) if (p.quote && (p.quote.views || 0) > (root.views || 0)) root = p.quote;
  if (main.quote && (main.quote.views || 0) > (main.views || 0) * 0.8) root = main.quote;
  return { main, root };
}

// asOf: for a backtest, only what existed by the end of the window is seen
export async function spread(root, pages = 2, asOf = null) {
  let qs = [], cq = [];
  try { qs = await quotesOf(root.id, pages, asOf); } catch {}
  // a targeted crypto search: the last 40 quotes may miss the early CAs (on a post with hundreds of quotes the first CA can come hours in)
  const CW = '(ca OR token OR coin OR memecoin OR pump OR pumpfun OR launched OR deployed OR solana OR fees OR ticker OR mcap OR chart)';
  const until = asOf ? ` until_time:${asOf}` : '';
  try { cq.push(...await search(`quoted_tweet_id:${root.id} ${CW}${until}`, { pages: 1 })); } catch {}
  if (root.author?.handle && root.at) try { cq.push(...await search(`to:${root.author.handle} ${CW} since_time:${root.at}${until}`, { pages: 1 })); } catch {}
  if (asOf) { qs = qs.filter(q => q.at && q.at <= asOf); cq = cq.filter(q => q.at && q.at <= asOf); }
  qs = qs.filter(q => !excluded(q)); cq = cq.filter(q => !excluded(q));
  const notable = qs.filter(q => (q.author.followers || 0) >= 10000).sort((a, b) => (b.author.followers || 0) - (a.author.followers || 0));
  const langs = [...new Set(qs.map(q => q.lang).filter(l => l && !['zxx', 'und', 'qme', 'qam'].includes(l)))];
  const hasCa = s => /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(s) || /\b0x[a-fA-F0-9]{40}\b/.test(s);
  const all = [...new Map([...qs, ...cq].map(q => [q.id, q])).values()];
  const crypto = all.filter(q => hasCa(q.text) || CRYPTO_WORDS.test(q.text) || /\$[A-Za-z]{2,}/.test(q.text));
  const remixes = qs.filter(q => REMIX.test(q.text));
  const cas = new Set(), tickers = new Set();
  for (const q of crypto) {
    for (const m of q.text.matchAll(CA_SOL)) if (/[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]) && /\d/.test(m[0])) cas.add(m[0]);
    for (const m of q.text.matchAll(CA_EVM)) cas.add(m[0]);
    for (const m of q.text.matchAll(TICKER)) tickers.add('$' + m[1].toUpperCase());
  }
  const firstCrypto = crypto.sort((a, b) => a.at - b.at)[0];
  return {
    sampled: qs.length,
    notable: notable.slice(0, 6).map(q => ({ handle: q.author.handle, followers: q.author.followers, views: q.views, text: q.text.slice(0, 160), url: q.url })),
    langs,
    crypto: crypto.length,
    firstCryptoH: firstCrypto && root.at ? +((firstCrypto.at - root.at) / 3600).toFixed(1) : null,
    cas: [...cas].slice(0, 8), tickers: [...tickers].slice(0, 10),
    cryptoSamples: crypto.slice(0, 3).map(q => ({ handle: q.author.handle, h: root.at ? +((q.at - root.at) / 3600).toFixed(1) : null, text: q.text.slice(0, 140), url: q.url })),
    remixes: remixes.slice(0, 4).map(q => ({ handle: q.author.handle, followers: q.author.followers, views: q.views, text: q.text.slice(0, 160), url: q.url })),
  };
}

// DexScreener: tokens named for the idea's terms that appeared after the root post (−6 h for time zones and pre-launches)
export async function tokenized(terms, sinceTs, asOf = null) {
  const seen = new Map();
  for (const term of (terms || []).slice(0, 3)) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      for (const p of j.pairs || []) {
        const created = (p.pairCreatedAt || 0) / 1000;
        if (sinceTs && created < sinceTs - 6 * 3600) continue;
        if (asOf && created > asOf) continue;
        const key = p.baseToken?.address;
        if (!key) continue;
        const nameHit = [p.baseToken.symbol, p.baseToken.name].some(s => String(s || '').toLowerCase().includes(String(term).toLowerCase().split(' ')[0]));
        if (!nameHit) continue;
        const mc = p.marketCap || p.fdv || 0;
        const liq = p.liquidity?.usd || 0;
        if (liq < 2000 || mc > liq * 200) continue; // dead or broken pools: a $4.6B cap on a few hundred dollars of liquidity
        const cur = seen.get(key);
        if (!cur || mc > cur.mcap) seen.set(key, { symbol: p.baseToken.symbol, name: p.baseToken.name, chain: p.chainId, mcap: Math.round(mc), vol24: Math.round(p.volume?.h24 || 0), created: Math.floor(created), url: p.url, address: key });
      }
    } catch {}
    await sleep(400);
  }
  const list = [...seen.values()].filter(t => t.mcap < 5e9).sort((a, b) => b.mcap - a.mcap); // >5B: junk pools with a broken price
  return { count: list.length, top: list.slice(0, 5), firstH: list.length && sinceTs ? +((Math.min(...list.map(t => t.created)) - sinceTs) / 3600).toFixed(1) : null };
}

// a preview of the main picture or video for vision (a small jpeg)
export async function thumb(post) {
  const m = (post.media || []).find(x => x.thumb);
  if (!m) return null;
  let url = m.thumb;
  if (/pbs\.twimg\.com\/media\//.test(url)) url = url.replace(/(\?.*)?$/, '?format=jpg&name=small');
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!/image\/(jpeg|png|webp|gif)/.test(ct)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 900e3) return null;
    return { type: 'image', source: { type: 'base64', media_type: ct.split(';')[0], data: buf.toString('base64') } };
  } catch { return null; }
}

export async function refresh(id) {
  try { return await getTweet(id); } catch { return null; }
}
