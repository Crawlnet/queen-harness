// A detector of drawn "ladders": the 15-min closes over a pool's life.
// Live tokens: 38–51% of candles up, drawdowns of 68–92%. Ladders: 85–100% of candles up, a climb with no pullbacks,
// often a liquidity pull at the end (a $2–4k cap on millions of volume) or a single dip (VSOF: a 74% drawdown at 98% up).
// rigged =
//   ≥20 candles and ≥85% strictly up (5+ hours almost without a red one: organic coins do not move so; the drawdown does not matter), or
//   ≥16 candles up to the peak and ≥40% of the history: a drawdown before the peak < 10% and ≥85% up (a ladder pulled at the end), or
//   3–5 candles: exactly 0% drawdown and 100% up at a turnover < 20%.
import { CFG, now } from './config.mjs';
import { candles } from './gecko.mjs';

function stats(closes) {
  let peak = 0, dd = 0, up = 0;
  closes.forEach((p, i) => { peak = Math.max(peak, p); dd = Math.max(dd, 1 - p / peak); if (i && p > closes[i - 1]) up++; });
  return { n: closes.length, dd, up: closes.length > 1 ? up / (closes.length - 1) : 0 };
}

export function chartShape(cs) {
  const closes = cs.map(c => c[4]).filter(x => x > 0);
  const all = stats(closes);
  const peakIdx = closes.reduce((bi, p, i) => (p > closes[bi] ? i : bi), 0);
  const pre = stats(closes.slice(0, peakIdx + 1));
  return { ...all, pre, gain: closes.length ? closes.at(-1) / closes[0] : 1 };
}

export function isRigged(s, turnover) {
  if (s.n >= 20 && s.up >= CFG.JUNK_MIN_UP) return true;
  // a long stretch before the peak (≥4 h and ≥40% of the history): live coins may peak early, after a couple of green candles (Jane: 6 of 81)
  if (s.pre.n >= 16 && s.pre.n >= 0.4 * s.n && s.pre.dd < CFG.JUNK_MAX_DD && s.pre.up >= CFG.JUNK_MIN_UP) return true;
  return s.n >= 3 && s.n < CFG.JUNK_MIN_CANDLES && s.dd === 0 && s.up === 1 && turnover < CFG.JUNK_MAX_TURNOVER;
}

// → t.junk = { rigged, dd, up, n, pre, turnover, at } | null (failed / too few candles: check later)
export async function junkCheck(t) {
  const m = t.market;
  if (!m?.pair) return null;
  const from = Math.max(m.pairCreatedAt || t.migratedAt || now() - 10 * 86400, now() - 10 * 86400);
  const cs = await candles(m.pair, 'minute', from, now(), 1, t.mint, 15);
  if (!cs) return null;
  const s = chartShape(cs);
  const turnover = m.mcap ? (m.volume24h || 0) / m.mcap : 0;
  if (s.n < 3) return null;
  const r2 = x => Math.round(x * 100) / 100;
  return { rigged: isRigged(s, turnover), dd: r2(s.dd), up: r2(s.up), n: s.n, pre: { n: s.pre.n, dd: r2(s.pre.dd), up: r2(s.pre.up) }, turnover: r2(turnover), at: now() };
}

// whom to check: a notable cap, ATH or volume (pulled ladders: a $2–4k cap, millions of volume)
export const junkRelevant = t => (t.market?.mcap || 0) >= CFG.JUNK_CHECK_MCAP || (t.ath?.mcap || 0) >= 150_000 || (t.market?.volume24h || 0) >= 200_000;
