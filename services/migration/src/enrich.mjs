// The site (+ a search for its docs), the metadata from json_uri, the token's picture, ATH and lifetime volume from candles.
import { candles } from './gecko.mjs';
import { now } from './config.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; queen-harness/0.1)' };
const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : '');

async function getBuf(url, maxBytes, timeout = 8000) {
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length > maxBytes ? null : buf;
}
async function getText(url, maxBytes = 600_000, timeout = 8000) {
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  if (!r.ok) return null;
  const buf = await r.arrayBuffer();
  return new TextDecoder().decode(buf.slice(0, maxBytes));
}

// the pump/stonk metadata at json_uri: socials, description, picture
export async function uriMeta(uri) {
  if (!uri || !/^https?:/.test(uri)) return null;
  try {
    const j = JSON.parse(await getText(uri, 100_000));
    return { twitter: j.twitter, website: j.website, telegram: j.telegram, description: j.description, image: j.image };
  } catch { return null; }
}

const htmlText = html => clip(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, ' '), 4000);
const pickMeta = (html, re) => clip(html.match(re)?.[1], 300);
const DOC_RE = /(\bdocs?\b|whitepaper|litepaper|gitbook|notion\.site|mirror\.xyz|paragraph\.xyz|medium\.com\/@|\/wiki\b|tokenomics)/i;
const SKIP_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mp4|woff2?)(\?|$)|(x|twitter)\.com|t\.me\/|discord\.(gg|com)|dexscreener|pump\.fun|jup\.ag|raydium/i;

function pageInfo(url, html) {
  const text = htmlText(html);
  return {
    url,
    title: pickMeta(html, /<title[^>]*>([^<]*)<\/title>/i),
    description: pickMeta(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
      || pickMeta(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i),
    text: text.slice(0, 1200),
  };
}

// the site + a try at its docs: the page's links (docs/whitepaper/gitbook/notion…), else /docs and docs.<domain>
export async function websiteInfo(url) {
  if (!url || !/^https?:\/\//.test(url) || SKIP_RE.test(url)) return null;
  let html;
  try { html = await getText(url); } catch {}
  if (!html) return { url, ok: false };
  const site = { ok: true, ...pageInfo(url, html) };
  if (site.text.length < 150) site.note = 'little text in the HTML (likely an SPA with no server rendering)';
  // the docs
  const base = new URL(url);
  const links = [...html.matchAll(/href=["']([^"'#\s]+)["']/gi)].map(m => { try { return new URL(m[1], base).href; } catch { return null; } })
    .filter(h => h && DOC_RE.test(h) && !SKIP_RE.test(h) && h.replace(/\/$/, '') !== url.replace(/\/$/, ''));
  const candidates = [...new Set(links)].slice(0, 3);
  if (!candidates.length) candidates.push(`${base.origin}/docs`, `https://docs.${base.hostname.replace(/^www\./, '')}`);
  for (const c of candidates) {
    try {
      const h = await getText(c, 600_000, 6000);
      if (!h) continue;
      const d = pageInfo(c, h);
      if (d.text.length < 200 || d.text === site.text) continue;
      site.docs = { ...d, text: d.text.slice(0, 1500) };
      break;
    } catch {}
  }
  site.docLinks = candidates.slice(0, 3);
  return site;
}

// the picture: the first candidate that downloads, ≤1 MB, its type from its signature (png/jpeg/gif/webp, what vision models take)
function mediaType(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
export async function fetchImage(urls) {
  for (const u of urls.filter(Boolean)) {
    try {
      const b = await getBuf(u, 1_000_000);
      const mt = b && mediaType(b);
      if (mt) return { mediaType: mt, data: b.toString('base64'), src: u };
    } catch {}
  }
  return null;
}
// DexScreener's CMS resizes by its parameters → a small picture
export const dexThumb = u => (u && /cdn\.dexscreener\.com/.test(u) ? u.replace(/\?.*$/, '') + '?width=256&height=256&quality=90&format=auto' : u);

// ATH (the max close) and the pool's lifetime volume. supply = mcap/price (DexScreener).
export async function historyStats(pool, supply, sinceSec, mint = 'base') {
  if (!pool || !supply) return null;
  // one request of daily candles (GeckoTerminal at ~10 req/min is the bottleneck); young tokens have an exact ATH
  // from the minute backfill/live already (t.ath), the daily close is for old tokens + the lifetime volume
  const days = await candles(pool, 'day', sinceSec, now(), 1, mint);
  if (!days) return null;
  let ath = 0, athAt = null;
  for (const c of days) if (c[4] * supply > ath) { ath = c[4] * supply; athAt = c[0]; }
  return { athClose: Math.round(ath), athAt, volumeLifetime: Math.round((days || []).reduce((s, c) => s + (c[5] || 0), 0)) };
}
