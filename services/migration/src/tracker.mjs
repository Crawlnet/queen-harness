// Holding a threshold. Candles are not checked one by one: the price at every minute of the window, and its median.
// A window opens when the threshold is crossed. A failure → wait for the next crossing
// (or a new window at once, if the cap is still over the threshold at the window's end).
import { CFG } from './config.mjs';

export function median(a) {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
}

// a live step on one sample (h is mutated) → 'confirmed' | 'failed' | null
export function step(h, ts, mcap, thr, holdSec, fakeNow) {
  if (h.state !== 'idle' && h.state !== 'holding') return null;
  if (h.state === 'idle') {
    if (mcap >= thr) Object.assign(h, { state: 'holding', start: ts, samples: [mcap] });
    return null;
  }
  h.samples.push(mcap);
  if (ts - h.start < holdSec) return null;
  const med = median(h.samples), need = Math.ceil((holdSec / 60) * CFG.MIN_SAMPLE_RATIO);
  const fake = fakeNow();
  if (h.samples.length >= need && med >= thr && !fake) {
    Object.assign(h, { state: 'done', confirmedAt: ts, median: Math.round(med), windowStart: h.start, samples: undefined, start: undefined });
    return 'confirmed';
  }
  h.attempts = (h.attempts || 0) + 1;
  h.lastFail = { at: ts, median: Math.round(med), n: h.samples.length, why: med < thr ? 'median' : fake || 'samples' };
  if (mcap >= thr) Object.assign(h, { start: ts, samples: [mcap] });
  else Object.assign(h, { state: 'idle', start: undefined, samples: undefined });
  return 'failed';
}

// The same from candles (the backfill): minute closes, forward-filled = the price at every minute.
export function minuteSeries(candles, supply, from, to) {
  const out = [];
  let i = 0, price = null;
  for (let t = Math.floor(from / 60) * 60; t <= to; t += 60) {
    while (i < candles.length && candles[i][0] <= t) price = candles[i++][4];
    if (price != null) out.push([t, price * supply]);
  }
  return out;
}

export function holdFromSeries(series, thr, holdSec) {
  const n = holdSec / 60;
  let attempts = 0;
  for (let k = 0; k < series.length; k++) {
    if (series[k][1] < thr) continue;
    const win = series.slice(k, k + n + 1);
    if (win.length < n + 1) return { confirmedAt: null, attempts, open: true }; // the window has not closed: live will finish it
    const med = median(win.map(x => x[1]));
    if (med >= thr) return { confirmedAt: win.at(-1)[0], windowStart: win[0][0], median: Math.round(med), attempts };
    attempts++;
    k += n - 1;
  }
  return { confirmedAt: null, attempts };
}
