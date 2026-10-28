// StonkFun = Raydium LaunchLab with two platform configs. Raydium's public launch API returns
// the graduated tokens by platformId with their description → no RPC needed.
const PLATFORMS = {
  '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7': 'standard',
  '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt': 'reward',
};
const API = 'https://launch-mint-v1.raydium.io/get/list';

// sort=lastTrade, 100 a page: the freshly migrated always come first → 2 pages do in the loop, 10 at the start
export async function stonkMigrations(sinceSec, maxPages = 10) {
  const out = [];
  for (const [pid, kind] of Object.entries(PLATFORMS)) {
    let nextPageId;
    for (let p = 0; p < maxPages; p++) {
      const q = new URLSearchParams({ platformId: pid, sort: 'lastTrade', size: '100', mintType: 'graduated', includeNsfw: 'true' });
      if (nextPageId) q.set('nextPageId', nextPageId);
      const j = await (await fetch(`${API}?${q}`, { signal: AbortSignal.timeout(15000) })).json();
      const rows = j?.data?.rows || [];
      let fresh = 0;
      for (const t of rows) {
        if (t.finishingRate < 100 || !t.migrateAmmId) continue;
        const migratedAt = Math.floor(t.priceFinalTime || t.createAt / 1000); // not every token has priceFinalTime → createAt as a lower bound
        if (migratedAt < sinceSec) continue;
        fresh++;
        out.push({
          platform: 'stonk', kind, mint: t.mint, sig: null, migratedAt, migratedAtExact: !!t.priceFinalTime,
          pool: t.migrateAmmId, quote: t.mintB?.symbol,
          meta: { name: t.name, symbol: t.symbol, description: t.description || '', twitter: t.twitter, website: t.website, image: t.imgUrl, createdAt: Math.floor(t.createAt / 1000) },
        });
      }
      nextPageId = j?.data?.nextPageId;
      if (!nextPageId || !rows.length || (fresh === 0 && p >= 2)) break;
    }
  }
  return out;
}
