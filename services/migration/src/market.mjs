// DexScreener: mcap / liquidity / volume. 30 mints a request, free (a limit of 300 req/min).
async function chunkData(chunk, res) {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error('http ' + r.status);
    for (const p of (await r.json()) || []) {
      const m = p.baseToken?.address;
      if (!chunk.includes(m)) continue;
      const cur = res[m] || { volume24h: 0, pairs: 0, pairCreatedAt: null };
      cur.volume24h += p.volume?.h24 || 0;
      cur.pairs++;
      // the token's DexScreener profile (sites, socials, picture) is the same on every pair: the first non-empty one
      if (p.info && !cur.info) cur.info = {
        imageUrl: p.info.imageUrl || null, header: p.info.header || null,
        websites: (p.info.websites || []).map(w => w.url).filter(Boolean),
        socials: (p.info.socials || []).map(s => ({ type: s.type, url: s.url })).filter(s => s.url),
      };
      // the oldest pool, for the "hit before" check (the most liquid one may be younger than the token)
      if (p.pairCreatedAt && Math.floor(p.pairCreatedAt / 1000) < (cur.pairCreatedAt ?? Infinity)) { cur.pairCreatedAt = Math.floor(p.pairCreatedAt / 1000); cur.oldestPair = p.pairAddress; }
      // the main pair = the most liquid one
      if (!cur.liquidity || (p.liquidity?.usd || 0) > cur.liquidity) {
        Object.assign(cur, {
          mcap: p.marketCap ?? p.fdv ?? 0, liquidity: p.liquidity?.usd || 0, priceUsd: +p.priceUsd || 0,
          change: p.priceChange || {}, pair: p.pairAddress, txns24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0), url: p.url, dex: p.dexId,
        });
      }
      res[m] = cur;
    }
  } catch (e) { console.error('dexscreener', e.message); }
}

export async function marketData(mints, concurrency = 4) {
  const res = {}, chunks = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  for (let i = 0; i < chunks.length; i += concurrency)
    await Promise.all(chunks.slice(i, i + concurrency).map(c => chunkData(c, res)));
  return res;
}
