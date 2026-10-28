// Jupiter tokens v2 (lite, free): launchpad, graduatedAt, createdAt, socials, holders, organicScore.
// Discovery: the top lists → pump.fun/stonkfun tokens with a big cap (long-migrated ones too).
import { CFG } from '../config.mjs';

const BASE = 'https://lite-api.jup.ag/tokens/v2';
// Jupiter's lite-api limits by IP: ~5 requests per ~10 s window (the x-ratelimit-* headers), one window for every
// process on that IP. So: a pause between requests, and on a 429 a wait for the window to reset before trying again.
let jupNext = 0;
async function jupFetch(url, gapMs, tries = 4) {
  for (let a = 0; ; a++) {
    const slot = Math.max(Date.now(), jupNext); jupNext = slot + gapMs;
    if (slot > Date.now()) await new Promise(r => setTimeout(r, slot - Date.now()));
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (r.status !== 429 || a >= tries) return r;
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    const wait = reset > 1e9 ? reset * 1000 - Date.now() + 500 : 5000;
    await r.body?.cancel();
    await new Promise(res => setTimeout(res, Math.min(Math.max(wait, 1000), 15000)));
  }
}
const get = async url => {
  const r = await jupFetch(url, 2500);
  if (!r.ok) throw Error(`jup ${r.status}`);
  return r.json();
};
const sec = iso => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

export function slim(t) {
  const vol = t.stats24h ? (t.stats24h.buyVolume || 0) + (t.stats24h.sellVolume || 0) : null;
  return {
    name: t.name, symbol: t.symbol, launchpad: t.launchpad || null, createdAt: sec(t.createdAt), graduatedAt: sec(t.graduatedAt),
    twitter: t.twitter || null, website: t.website || null, telegram: t.telegram || null, discord: t.discord || null, tiktok: t.tiktok || null,
    holders: t.holderCount ?? null, organicScore: t.organicScore ?? null, organicLabel: t.organicScoreLabel ?? null,
    mcap: t.mcap ?? null, liquidity: t.liquidity ?? null, volume24h: vol, icon: t.icon || null, at: Math.floor(Date.now() / 1000),
  };
}

export async function jupInfo(mints) {
  const res = {};
  for (let i = 0; i < mints.length; i += 100) {
    try { for (const t of await get(`${BASE}/search?query=${mints.slice(i, i + 100).join(',')}`)) res[t.id] = slim(t); }
    catch (e) { console.error('jupInfo', e.message); }
  }
  return res;
}

export async function jupDiscover() {
  const found = {};
  for (const cat of ['toptrending', 'toptraded', 'toporganicscore'])
    for (const iv of ['5m', '1h', '6h', '24h']) {
      try {
        for (const t of await get(`${BASE}/${cat}/${iv}?limit=100`)) {
          const platform = CFG.LAUNCHPADS[t.launchpad];
          if (platform && (t.mcap || 0) >= CFG.DISCOVERY_MIN_MCAP) found[t.id] = { platform, jup: slim(t) };
        }
      } catch (e) { console.error('jupDiscover', cat, iv, e.message); }
    }
  return found;
}
