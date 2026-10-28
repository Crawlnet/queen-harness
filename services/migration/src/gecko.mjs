// GeckoTerminal OHLCV (free, ~30 req/min): the holds' backfill, prior ATH, ATH and lifetime volume for the analysis.
const BASE = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
// The real limit is under the stated 30/min and drifts → an adaptive gap: a 429 → +3 s (up to 20 s), a success → −0.1 s (down to 6 s).
// The same IP may read GeckoTerminal for the harness's tools too (10/min): the service keeps to 10 a minute.
let GAP = 6000;
let nextAt = 0;
export const geckoStats = { calls: 0, r429: 0, fail: 0, gap: () => GAP };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gget(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = nextAt - Date.now();
    nextAt = Math.max(Date.now(), nextAt) + GAP; // one global limiter: every call spaced by GAP
    if (wait > 0) await sleep(wait);
    try {
      geckoStats.calls++;
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { geckoStats.r429++; GAP = Math.min(20000, GAP + 3000); nextAt = Date.now() + 30000; continue; }
      GAP = Math.max(6000, GAP - 100);
      if (!r.ok) { geckoStats.fail++; return null; }
      return await r.json();
    } catch { /* a timeout → one more try */ }
  }
  return null;
}

const STEP = { minute: 60, hour: 3600, day: 86400 };

// [[ts, o, h, l, c, v]] ascending in [fromSec, toSec]; pages back through before_timestamp.
// null = the request failed (unlike an empty array = no candles).
// token = the mint's address: the price of the tracked token itself (on pairs with stock tokens Gecko may have base and quote swapped)
export async function candles(pool, tf, fromSec, toSec, maxPages = 3, token = 'base', agg = 1) {
  const all = new Map();
  let before = toSec, ok = false;
  for (let p = 0; p < maxPages; p++) {
    const j = await gget(`${BASE}/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=1000&currency=usd&token=${token}&before_timestamp=${before}`);
    if (!j) break;
    ok = true;
    const list = j?.data?.attributes?.ohlcv_list || [];
    for (const c of list) all.set(c[0], c);
    if (list.length < 1000) break;
    const oldest = Math.min(...list.map(c => c[0]));
    if (oldest <= fromSec) break;
    before = oldest;
  }
  if (!ok) return null;
  return [...all.values()].filter(c => c[0] >= fromSec - STEP[tf] * agg && c[0] <= toSec).sort((a, b) => a[0] - b[0]);
}
