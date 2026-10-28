// Migration, a daemon: pump.fun + StonkFun migrations → runners (≥150k held 10 min), cap tiers 1/5/10/25/50M (30 min,
// at any age) → narrative analysis → a daily AI report.
//
//   node src/index.mjs watch                     — the daemon (everything below, on its schedule)
//   node src/index.mjs status [--hours 24]       — a summary from data/db.json
//   node src/index.mjs backfill                  — run the candle backfill queue to its end (no daemon)
//   node src/index.mjs analyze [--limit 30]      — classify the tokens with events
//   node src/index.mjs daily [--date YYYY-MM-DD | --hours 24]
import fs from 'fs';
import { CFG, now, fakeReason, tierLabel, BLOCKING } from './config.mjs';
import { loadDb, saveDb, newToken, armRunner, appendJsonl, dataPath } from './store.mjs';
import { pumpMigrations, assetMeta } from './sources/pump.mjs';
import { stonkMigrations } from './sources/stonk.mjs';
import { jupInfo, jupDiscover } from './sources/jup.mjs';
import { marketData } from './market.mjs';
import { candles, geckoStats } from './gecko.mjs';
import { step, minuteSeries, holdFromSeries } from './tracker.mjs';
import { analyzeQueue, lightQueue, dailyReport, dayWindow, utcDay, loadDaily, latestDailyLabel, findClusters, clusterDetailText } from './analyze.mjs';
import { dexProfileUpdates } from './sources/dexprofile.mjs';
import { tgCommandsEnabled, pollCommands, esc } from './telegram.mjs';
import { xStats } from './xinfo.mjs';
import { junkCheck, junkRelevant } from './junk.mjs';
import { aliveKeys } from './helius.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] ?? true) : d; };
const log = (...a) => console.log(new Date().toISOString().slice(5, 19).replace('T', ' '), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// a guard: no stage of a tick may hang the loop (the RPC's 25 tries, each with its timeout, can take minutes)
const guard = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw Error(`${label}: timed out after ${ms / 1000}s`); })]);
const fmt = n => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const sym = t => t.jup?.symbol || t.meta?.symbol || t.mint.slice(0, 6);
// what blocks an event: a ladder; a token with a cap ≥100k not yet checked for a ladder (the worker checks it before the window ends); a meaningless price
const blocking = (t, kind) => {
  if (t.junk?.rigged) return 'rigged';
  if (!t.junk && (t.market?.mcap || 0) >= CFG.JUNK_CHECK_MCAP) { t.junkWanted = true; return 'junk-unchecked'; }
  const r = fakeReason(t.market, kind, t.jup?.organicScore);
  return BLOCKING.includes(r) ? r : null;
};

const db = loadDb();
db.state ||= {};

// ---------- events ----------
function addEvent(t, type, thr, h, backfill = false) {
  if (t.junk?.rigged) return;
  const label = type === 'runner' ? 'runner' + tierLabel(thr) : tierLabel(thr);
  if (t.events.some(e => e.label === label)) return;
  const flag = fakeReason(t.market, type, t.jup?.organicScore) || undefined; // farm / mcap/liq / low-turnover: a flag, not a block
  const e = { type, label, tier: thr, confirmedAt: h.confirmedAt, windowStart: h.windowStart, median: h.median, attempts: h.attempts || 0, backfill, flag };
  t.events.push(e);
  appendJsonl('events.jsonl', { ...e, mint: t.mint, symbol: sym(t), platform: t.platform });
  log(`EVENT ${label.padEnd(10)} ${t.platform.padEnd(5)} ${sym(t).padEnd(12)} median $${fmt(h.median)} tries ${e.attempts}${backfill ? ' (from candles)' : ''}${flag ? ' [' + flag + ']' : ''}  ${t.mint}`);
}

// ---------- collect ----------
async function enrichNew(mints) {
  const info = await jupInfo(mints);
  const needMeta = [];
  for (const mint of mints) {
    const t = db.tokens[mint], j = info[mint];
    if (!t) continue;
    if (j) {
      t.jup = j;
      t.createdAt ||= j.createdAt;
      // StonkFun: Raydium's API lacks the exact migration time of some tokens → Jupiter's graduatedAt
      if (j.graduatedAt && t.sources.includes('migration') && (!t.migratedAt || !t.migratedAtExact)) {
        t.migratedAt = j.graduatedAt; t.migratedAtExact = true;
        if (t.runner) t.runner.armedUntil = t.migratedAt + CFG.RUNNER_ARM;
      }
    }
    if (!t.meta?.description && !t.meta?.uri) needMeta.push(mint);
  }
  if (needMeta.length) {
    const meta = await assetMeta(needMeta).catch(e => (log('meta:', e.message), {}));
    for (const mint of needMeta) if (meta[mint]) db.tokens[mint].meta = { ...(db.tokens[mint].meta || {}), ...meta[mint] };
  }
}

async function collectMigrations(full = false) {
  const st = db.state;
  if (!st.pumpSeen) { // the first start over an imported db
    st.pumpSeen = Object.values(db.tokens).map(t => t.migSig).filter(Boolean);
    st.pumpNewest = Math.max(0, ...Object.values(db.tokens).filter(t => t.platform === 'pump').map(t => t.migratedAt || 0));
  }
  const seen = new Set(st.pumpSeen);
  const since = Math.max(now() - CFG.RUNNER_ARM, (st.pumpNewest || 0) - 300);
  const pump = await pumpMigrations(since, seen).catch(e => (log('pump:', e.message), []));
  st.pumpSeen = [...seen].slice(-5000);
  for (const m of pump) st.pumpNewest = Math.max(st.pumpNewest || 0, m.migratedAt);
  let stonk = [];
  if (full || now() - (st.stonkAt || 0) >= CFG.STONK_EVERY) {
    stonk = await stonkMigrations(now() - CFG.RUNNER_ARM, full ? 10 : 2).catch(e => (log('stonk:', e.message), []));
    st.stonkAt = now();
  }
  const fresh = [];
  for (const m of [...pump, ...stonk]) {
    const t = db.tokens[m.mint];
    if (t) {
      if (!t.sources.includes('migration')) t.sources.push('migration');
      if (!t.migratedAt) t.migratedAt = m.migratedAt;
      armRunner(t);
      continue;
    }
    db.tokens[m.mint] = newToken({ ...m, source: 'migration', trackStart: m.migratedAt });
    attachDex(db.tokens[m.mint]);
    fresh.push(m.mint);
  }
  if (fresh.length) await enrichNew(fresh);
  return { fresh: fresh.length };
}

async function discover() {
  const found = await jupDiscover();
  const fresh = [];
  for (const [mint, f] of Object.entries(found)) {
    if (db.tokens[mint]) {
      db.tokens[mint].jup = f.jup;
      if (!db.tokens[mint].sources.includes('discovery')) db.tokens[mint].sources.push('discovery');
      continue;
    }
    db.tokens[mint] = newToken({ mint, platform: f.platform, source: 'discovery', migratedAt: f.jup.graduatedAt, createdAt: f.jup.createdAt, jup: f.jup });
    attachDex(db.tokens[mint]);
    fresh.push(mint);
  }
  if (fresh.length) await enrichNew(fresh);
  return { found: Object.keys(found).length, fresh: fresh.length };
}

// ---------- DexScreener profiles (the description, links and CTO set after launch) ----------
const attachDex = t => { const d = db.state.dexCache?.[t.mint]; if (d && !t.dex) t.dex = d; };
async function updateDexProfiles() {
  const ups = await dexProfileUpdates();
  db.state.dexCache ||= {};
  let n = 0;
  for (const u of ups) {
    const { mint, ...d } = u;
    const prev = db.tokens[mint]?.dex || db.state.dexCache[mint];
    const merged = { ...(prev || {}), ...Object.fromEntries(Object.entries(d).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))), at: prev?.at || now() };
    if (JSON.stringify(prev) === JSON.stringify(merged)) continue;
    db.state.dexCache[mint] = merged;
    if (db.tokens[mint]) { db.tokens[mint].dex = merged; n++; }
  }
  const keys = Object.keys(db.state.dexCache);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete db.state.dexCache[k];
  return n;
}

// ---------- market polling + the state machine ----------
const isHolding = t => t.runner?.state === 'holding' || Object.values(t.tiers).some(h => h.state === 'holding');
const nextTier = t => CFG.TIERS.find(x => !['done', 'prior'].includes(t.tiers[x].state));

function pollPlan() {
  const ts = now(), hot = [], due = [];
  for (const t of Object.values(db.tokens)) {
    const m = t.market;
    const dead = m && m.mcap < CFG.DEAD_MCAP && m.liquidity < CFG.DEAD_LIQ;
    const runnerArmed = t.runner && t.runner.state !== 'done' && ts < t.runner.armedUntil;
    const nt = nextTier(t);
    const tierCand = nt && m && m.mcap >= nt * CFG.TIER_WATCH_FROM;
    if (t.junk?.rigged && t.lastPolledAt) { if (ts - t.lastPolledAt >= CFG.COLD_EVERY) due.push(t); continue; }
    if (!t.lastPolledAt || isHolding(t) || tierCand || (runnerArmed && !dead)) hot.push(t);
    else if (ts - t.lastPolledAt >= (dead ? CFG.DEAD_EVERY : CFG.COLD_EVERY)) due.push(t);
  }
  due.sort((a, b) => a.lastPolledAt - b.lastPolledAt);
  return { list: [...hot, ...due].slice(0, CFG.DEX_CALLS_PER_TICK * 30), hot: hot.length, due: due.length };
}

async function pollMarket() {
  const plan = pollPlan();
  const md = await marketData(plan.list.map(t => t.mint));
  const ts = now();
  let got = 0;
  for (const t of plan.list) {
    t.lastPolledAt = ts;
    const m = md[t.mint];
    if (!m || !m.mcap) continue;
    got++;
    t.market = { ...m, at: ts };
    if (m.mcap >= CFG.DEAD_MCAP || m.liquidity >= CFG.DEAD_LIQ) t.lastAliveAt = ts;
    if (!blocking(t, 'tier') && m.mcap > (t.ath?.mcap || 0)) t.ath = { mcap: Math.round(m.mcap), at: ts };
    const r = t.runner;
    // until the history is checked from candles, live does not confirm: an event must get its real hold time
    if (r && r.state !== 'done' && r.backfill !== 'needed' && (ts < r.armedUntil || r.state === 'holding')) {
      if (step(r, ts, m.mcap, CFG.RUNNER_MCAP, CFG.RUNNER_HOLD, () => blocking(t, 'runner')) === 'confirmed') addEvent(t, 'runner', CFG.RUNNER_MCAP, r);
    }
    for (const x of CFG.TIERS) {
      const h = t.tiers[x];
      if (h.state === 'unchecked') continue; // not yet known whether it hit before: wait for the backfill
      if (step(h, ts, m.mcap, x, CFG.TIER_HOLD, () => blocking(t, 'tier')) === 'confirmed') addEvent(t, 'tier', x, h);
    }
  }
  return { ...plan, polled: plan.list.length, got };
}

// ---------- ladders ----------
function applyJunk(t, res) {
  const was = t.junk?.rigged;
  t.junk = res;
  t.junkWanted = false;
  if (res.rigged && !was) {
    if (t.events.length) {
      for (const e of t.events) appendJsonl('events.jsonl', { type: 'retract', label: e.label, mint: t.mint, symbol: sym(t), reason: 'rigged', at: now() });
      log(`LADDER ${sym(t)}: drawdown ${Math.round(res.dd * 100)}%, up ${Math.round(res.up * 100)}%, turnover ${res.turnover} → events retracted (${t.events.map(e => e.label).join(' ')})  ${t.mint}`);
    }
    t.events = [];
    if (t.runner) Object.assign(t.runner, { state: 'junk', start: undefined, samples: undefined });
    for (const h of Object.values(t.tiers)) if (h.state !== 'prior') Object.assign(h, { state: 'junk', start: undefined, samples: undefined });
  } else if (!res.rigged && was) { // the verdict is lifted: tracking back on, the tier history checked again
    if (t.runner?.state === 'junk') t.runner.state = 'idle';
    for (const k of Object.keys(t.tiers)) if (t.tiers[k].state === 'junk') t.tiers[k] = { state: 'unchecked' };
    t.tierCheckedAt = 0;
  }
}
const junkDue = t => {
  if (!t.market?.pair || now() - (t.junkTriedAt || 0) < 900) return false;
  if (t.junkWanted || isHolding(t)) return !t.junk || now() - t.junk.at > 900;
  if (!junkRelevant(t)) return false;
  return !t.junk || now() - t.junk.at > (t.junk.provisional ? 900 : CFG.JUNK_RECHECK);
};

// ---------- the backfill from candles (GeckoTerminal, its own limit) ----------
async function runnerBackfill(t) {
  const r = t.runner, m = t.market;
  if (!m?.pair || !m.priceUsd || (m.mcap < CFG.BACKFILL_MIN_MCAP && m.liquidity < CFG.BACKFILL_MIN_LIQ)) { r.backfill = 'skipped'; return; }
  const to = Math.min(now(), r.armedUntil);
  const cs = await candles(m.pair, 'minute', t.migratedAt - 60, to, 3, t.mint);
  if (!cs) { r.backfillTries = (r.backfillTries || 0) + 1; if (r.backfillTries >= 3) r.backfill = 'failed'; return; }
  r.backfill = 'done';
  const supply = m.mcap / m.priceUsd;
  const series = minuteSeries(cs, supply, t.migratedAt, to);
  // history: even low-liq is no block (a runner may have been dumped later)
  const peak = Math.max(0, ...series.map(s => s[1]));
  if (peak > (t.ath?.mcap || 0)) t.ath = { mcap: Math.round(peak), at: series.find(s => s[1] === peak)?.[0] };
  if (r.state === 'done') return;
  const res = holdFromSeries(series, CFG.RUNNER_MCAP, CFG.RUNNER_HOLD);
  r.attempts = (r.attempts || 0) + res.attempts;
  // history beats an open live window: the event must get its real hold time
  if (res.confirmedAt) {
    Object.assign(r, { state: 'done', confirmedAt: res.confirmedAt, windowStart: res.windowStart, median: res.median, start: undefined, samples: undefined });
    addEvent(t, 'runner', CFG.RUNNER_MCAP, r, true);
  }
}

async function tierBackfill(t) {
  t.tierCheckedAt = now();
  const m = t.market, ts = now(), supply = m.mcap / m.priceUsd;
  const unchecked = CFG.TIERS.filter(x => t.tiers[x].state === 'unchecked');
  const created = t.jup?.createdAt || t.createdAt || m.pairCreatedAt || t.migratedAt || ts - 30 * 86400;
  const minuteFrom = Math.max(created, ts - CFG.PRIOR_MINUTE_WINDOW);
  // hourly candles: older than the minute window, a close ≥ the tier → "hit before" (prior);
  // inside the window, the high as an upper bound: if it never reached the tier, no minute candles are needed
  const hs = await candles(m.oldestPair || m.pair, 'hour', created, ts, 2, t.mint);
  if (!hs) return;
  let priorMax = 0, recentHigh = m.mcap;
  for (const c of hs) {
    if (c[0] + 3600 <= minuteFrom) priorMax = Math.max(priorMax, c[4] * supply);
    else recentHigh = Math.max(recentHigh, c[2] * supply);
  }
  if (created < ts - 80 * 86400)
    for (const c of (await candles(m.oldestPair || m.pair, 'day', created, minuteFrom, 1, t.mint)) || []) if (c[0] + 86400 <= minuteFrom) priorMax = Math.max(priorMax, c[4] * supply);
  const need = unchecked.filter(x => priorMax < x && recentHigh >= x);
  let series = [];
  if (need.length) {
    const cs = await candles(m.pair, 'minute', minuteFrom, ts, 3, t.mint);
    if (!cs) return;
    series = minuteSeries(cs, supply, minuteFrom, ts);
  }
  for (const x of unchecked) {
    const h = t.tiers[x];
    if (priorMax >= x) { Object.assign(h, { state: 'prior', priorMax: Math.round(priorMax) }); continue; }
    if (!need.includes(x)) { h.state = 'idle'; continue; }
    const res = holdFromSeries(series, x, CFG.TIER_HOLD);
    if (res.confirmedAt) {
      Object.assign(h, { state: 'done', confirmedAt: res.confirmedAt, windowStart: res.windowStart, median: res.median, attempts: res.attempts });
      addEvent(t, 'tier', x, h, true);
    } else Object.assign(h, { state: 'idle', attempts: res.attempts });
  }
}

// The order of the candle jobs: 1) dead pools, with no network call; 2) urgent ladder checks (an event's confirmation
// waits on them); 3) the routine ladder rechecks, taking turns with the tier and runner backfills. The routine queue never
// runs dry (every token from JUNK_CHECK_MCAP, every 6 h), so going first it would stall the runners' queue for hours.
let lastBackfillKind = null;
function nextBackfill() {
  const ts = now(), toks = Object.values(db.tokens);
  // dead pools are skipped with no network call: handled first, so their live tracking is not held up
  const cheap = toks.find(t => t.runner?.backfill === 'needed' && t.market && t.market.mcap < CFG.BACKFILL_MIN_MCAP && t.market.liquidity < CFG.BACKFILL_MIN_LIQ);
  if (cheap) return ['runner', cheap];
  const byCap = (a, b) => Math.max(b.market.mcap, b.market.volume24h || 0) - Math.max(a.market.mcap, a.market.volume24h || 0);
  const junk = toks.filter(junkDue);
  const urgent = junk.filter(t => isHolding(t) || t.junkWanted).sort(byCap)[0];
  if (urgent) return ['junk', urgent];
  const tierT = toks.filter(t => t.market?.pair && t.market.priceUsd && ts - (t.tierCheckedAt || 0) > 600
    && Object.values(t.tiers).some(h => h.state === 'unchecked')
    && Math.max(t.market.mcap, t.ath?.mcap || 0) >= CFG.TIERS[0] * CFG.TIER_WATCH_FROM)
    .sort((a, b) => b.market.mcap - a.market.mcap)[0];
  const runT = !tierT && toks.filter(t => t.runner?.backfill === 'needed' && t.market).sort((a, b) => (b.market.liquidity || 0) - (a.market.liquidity || 0))[0];
  const other = tierT ? ['tier', tierT] : runT ? ['runner', runT] : null;
  const routine = junk.sort(byCap)[0];
  if (routine && (!other || lastBackfillKind !== 'junk')) return ['junk', routine];
  return other;
}

function backfillProgress() {
  const toks = Object.values(db.tokens);
  return { runner: toks.filter(t => t.runner?.backfill === 'needed').length, tier: toks.filter(t => (t.market?.mcap || 0) >= CFG.TIERS[0] * CFG.TIER_WATCH_FROM && Object.values(t.tiers).some(h => h.state === 'unchecked')).length };
}

async function backfillOne() {
  const job = nextBackfill();
  if (!job) return false;
  const [kind, t] = job;
  lastBackfillKind = kind;
  if (kind === 'junk') {
    t.junkTriedAt = now();
    try { const res = await junkCheck(t); if (res) applyJunk(t, res); else if (!t.junk) applyJunk(t, { rigged: false, provisional: true, at: now() }); }
    catch (e) { log(`junk ${t.mint}: ${e.message}`); }
    return true;
  }
  try { await (kind === 'tier' ? tierBackfill(t) : runnerBackfill(t)); }
  catch (e) { log(`backfill ${kind} ${t.mint}: ${e.message}`); if (kind === 'runner') t.runner.backfill = 'failed'; else t.tierCheckedAt = now(); }
  return true;
}

// ---------- the archive ----------
function archive() {
  const ts = now();
  let n = 0;
  for (const t of Object.values(db.tokens)) {
    if (isHolding(t) || (t.runner && t.runner.state !== 'done' && ts < t.runner.armedUntil)) continue;
    const deadLong = ts - t.lastAliveAt > CFG.ARCHIVE_DEAD_AFTER;
    const lastEv = Math.max(0, ...t.events.map(e => e.confirmedAt));
    if (deadLong && (!t.events.length || ts - lastEv > CFG.ARCHIVE_EVENT_AFTER)) {
      appendJsonl('archive.jsonl', t);
      delete db.tokens[t.mint];
      n++;
    }
  }
  return n;
}

// the daemon and the one-off commands may write the db at once → the analysis is merged from disk (the newer by analysis.at)
function saveMerged() {
  let disk;
  try { disk = JSON.parse(fs.readFileSync(dataPath('db.json'), 'utf8')); } catch {}
  if (disk) {
    for (const [mint, d] of Object.entries(disk.tokens)) {
      const t = db.tokens[mint];
      if (t && (d.analysis?.at || 0) > (t.analysis?.at || 0)) t.analysis = d.analysis;
    }
    if ((disk.state?.lastDaily || '') > (db.state.lastDaily || '')) db.state.lastDaily = disk.state.lastDaily;
  }
  saveDb(db);
}

// for the one-off commands: only their results (analysis) go to disk, the rest is taken fresh from disk
function saveAnalysisOnly() {
  const disk = loadDb();
  for (const [mint, t] of Object.entries(db.tokens)) if (disk.tokens[mint] && (t.analysis?.at || 0) >= (disk.tokens[mint].analysis?.at || 0)) disk.tokens[mint].analysis = t.analysis;
  if ((db.state.lastDaily || '') > (disk.state.lastDaily || '')) disk.state.lastDaily = db.state.lastDaily;
  saveDb(disk);
}

// ---------- the daemon ----------
async function watch() {
  log(`start: ${Object.keys(db.tokens).length} tokens, ${aliveKeys()} live Helius keys`);
  await collectMigrations(true);
  const noJup = Object.values(db.tokens).filter(t => !t.jup).map(t => t.mint);
  if (noJup.length) { await enrichNew(noJup); log(`Jupiter enrichment: ${noJup.length}`); }
  saveMerged();
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; log('stopping…'); saveMerged(); process.exit(0); });

  (async () => { // the backfill: a loop of its own, at GeckoTerminal's pace (gecko.mjs)
    for (;;) { if (!(await backfillOne().catch(e => (log('backfill:', e.message), false)))) await sleep(5000); }
  })();

  if (tgCommandsEnabled()) { log('Telegram commands: /narratives, /narr <meta>'); pollCommands(tgCommand, log); }

  let analyzeAt = 0, analyzeBackoff = 0, dailyRunning = false;
  (async () => { // the analysis every 15 min; with no LLM access, an hour's backoff
    for (;;) {
      await sleep(30_000);
      if (dailyRunning || now() - analyzeAt < Math.max(CFG.ANALYZE_EVERY, analyzeBackoff)) continue;
      analyzeAt = now();
      const r = await analyzeQueue(db, { limit: 30, log }).catch(e => ({ error: e.message }));
      const l = r.error ? { done: 0 } : await lightQueue(db, { limit: 120, log }).catch(e => ({ error: e.message }));
      if (r.done || r.error || l.done || l.error) log(`analysis: full +${r.done || 0} (queue ${r.pending ?? '?'}), light +${l.done || 0} (queue ${l.pending ?? '?'})${r.error || l.error ? ' | ' + String(r.error || l.error).slice(0, 160) : ''}`);
      analyzeBackoff = r.error || l.error ? 3600 : 0;
    }
  })();

  while (!stopping) {
    const t0 = Date.now();
    try {
      let t1 = Date.now();
      const c = await guard(collectMigrations(), 90_000, 'migrations').catch(e => (log(e.message), { fresh: 0 }));
      const tMig = Date.now() - t1;
      let d = null;
      if (now() - (db.state.discoveryAt || 0) >= CFG.DISCOVERY_EVERY) { d = await guard(discover(), 90_000, 'discovery').catch(e => (log(e.message), null)); db.state.discoveryAt = now(); }
      t1 = Date.now();
      const p = await guard(pollMarket(), 90_000, 'market').catch(e => (log(e.message), { got: 0, polled: 0, hot: 0 }));
      const tPoll = Date.now() - t1;
      const dexN = await guard(updateDexProfiles(), 30_000, 'dex profiles').catch(e => (log(e.message), 0));
      const arch = archive();
      saveMerged();
      const holding = Object.values(db.tokens).filter(isHolding).length, bf = backfillProgress();
      log(`tick ${((Date.now() - t0) / 1000).toFixed(1)}s (migr ${(tMig / 1000).toFixed(1)}, market ${(tPoll / 1000).toFixed(1)}) | +migr ${c.fresh}${d ? ` | discovery ${d.found}/+${d.fresh}` : ''} | polled ${p.got}/${p.polled} (hot ${p.hot}) | windows ${holding} | tokens ${Object.keys(db.tokens).length}${bf.runner + bf.tier ? ` | backfill r${bf.runner}/t${bf.tier}` : ''}${arch ? ` | archived ${arch}` : ''} | helius ${aliveKeys()} | gecko ${geckoStats.calls}/429:${geckoStats.r429}${dexN ? ` | dex profiles +${dexN}` : ''}${xStats.xapi ? ` | X api ${xStats.xapi}/err ${xStats.xapiErr}` : ''} | ladders ${Object.values(db.tokens).filter(t => t.junk?.rigged).length}`);
      // yesterday's daily report at 00:05 UTC
      const ts = now(), yday = utcDay(ts - 86400);
      if (!dailyRunning && (ts % 86400) / 60 >= CFG.DAILY_AT_UTC_MIN && db.state.lastDaily !== yday) {
        dailyRunning = true;
        const [from, to] = dayWindow(yday);
        dailyReport(db, from, to, { log, send: true }).then(r => { db.state.lastDaily = yday; log('DAILY', r.file.pathname, r.sent ? '→ telegram' : r.sent === false ? '(telegram failed)' : ''); })
          .catch(e => log('daily:', e.message)).finally(() => (dailyRunning = false));
      }
    } catch (e) { log('tick error:', e.stack || e.message); }
    await sleep(Math.max(1000, CFG.TICK * 1000 - (Date.now() - t0)));
  }
}

// ---------- commands on metas ----------
function narrativeCmd(query, label) {
  label ||= latestDailyLabel();
  const a = label && loadDaily(label);
  if (!a) return `no daily report${label ? ' ' + label : ''}: run node src/index.mjs daily first`;
  if (!a.clustersByVolume) return `the report ${label} is in the old format, rebuild it: node src/index.mjs daily --date ${label}`;
  const found = findClusters(a, query);
  if (!found.length) return `${label}: no meta matches "${query}"`;
  return `${label}\n\n` + found.slice(0, 5).map(clusterDetailText).join('\n\n────────\n\n');
}
function narrativesList(label) {
  label ||= latestDailyLabel();
  const a = label && loadDaily(label);
  if (!a?.clustersByVolume) return 'no daily report in the new format';
  return `${label}: ${a.clustersByVolume.length} metas\n` + a.clustersByVolume.slice(0, 60)
    .map((c, i) => `${i + 1}. ${c.name} — $${fmt(c.volume24h)}, ${c.tokens} tokens, ${c.migrations} migrations${c.runners ? ', ' + c.runners + ' runners' : ''}`).join('\n');
}
async function tgCommand(text) {
  const [cmd0, ...rest] = text.split(/\s+/);
  const c = cmd0.replace(/@\w+$/, '').toLowerCase();
  const arg = rest.join(' ');
  const date = arg.match(/\b(rolling-\d{4}-\d\d-\d\d|\d{4}-\d\d-\d\d)\b/)?.[1];
  const q = arg.replace(date || '', '').trim();
  if (c === '/narratives') return `<pre>${esc(narrativesList(date))}</pre>`;
  if (c === '/narr') return q ? `<pre>${esc(narrativeCmd(q, date))}</pre>` : 'usage: /narr &lt;meta or ticker&gt; [YYYY-MM-DD]';
  return null;
}

// ---------- the summary ----------
function status() {
  const H = +opt('hours', 24), since = now() - H * 3600;
  const toks = Object.values(db.tokens);
  const mig = toks.filter(t => t.migratedAt >= since);
  const evs = toks.flatMap(t => t.events.filter(e => e.confirmedAt >= since).map(e => ({ ...e, t })));
  const rb = toks.filter(t => t.runner).reduce((c, t) => ((c[t.runner.backfill] = (c[t.runner.backfill] || 0) + 1), c), {});
  console.log(`\nTokens ${toks.length} | migrations in ${H}h: pump ${mig.filter(t => t.platform === 'pump').length}, stonk ${mig.filter(t => t.platform === 'stonk').length} | discovery ${toks.filter(t => t.sources.includes('discovery')).length}`);
  console.log(`Runner backfills: ${JSON.stringify(rb)} | candidates with unchecked tiers: ${toks.filter(t => (t.market?.mcap || 0) >= 600_000 && Object.values(t.tiers).some(h => h.state === 'unchecked')).length}`);
  console.log(`Ladders: ${toks.filter(t => t.junk?.rigged).length} (${toks.filter(t => t.junk?.rigged).map(sym).slice(0, 20).join(', ')}), checked ${toks.filter(t => t.junk).length}`);
  console.log(`Windows now: ${toks.filter(isHolding).map(t => sym(t)).join(', ') || '—'}`);
  console.log(`Analysis: full ${toks.filter(t => t.analysis?.narrative).length}, light ${toks.filter(t => t.analysis?.light).length}, cards ${toks.filter(t => t.analysis?.card).length}, with events ${toks.filter(t => t.events.length).length}\n`);
  console.log(`== Events in ${H}h: ${evs.length} ==`);
  for (const e of evs.sort((a, b) => b.median - a.median)) {
    const t = e.t, a = t.analysis || {};
    console.log(`${e.label.padEnd(11)} ${t.platform.padEnd(5)} ${sym(t).padEnd(12)} median $${fmt(e.median).padEnd(7)} ATH $${fmt(t.ath?.mcap).padEnd(7)} now $${fmt(t.market?.mcap).padEnd(7)} vol $${fmt(t.market?.volume24h).padEnd(7)} ${new Date(e.confirmedAt * 1000).toISOString().slice(5, 16)}${e.backfill ? '*' : ' '} ${a.narrative ? '[' + a.narrative + ']' : ''} ${t.mint}`);
  }
}

// ---------- CLI ----------
if (cmd === 'watch') await watch();
else if (cmd === 'status') status();
else if (cmd === 'backfill') {
  let n = 0;
  while (await backfillOne()) { if (++n % 20 === 0) { log(`backfill ${n}…`); saveMerged(); } }
  saveMerged();
  log(`backfill done: ${n} jobs`);
  status();
} else if (cmd === 'analyze') {
  const r = await analyzeQueue(db, { limit: +opt('limit', 30) });
  saveAnalysisOnly();
  console.log(r);
} else if (cmd === 'daily') {
  let from, to, label;
  if (opt('hours')) { to = now(); from = to - +opt('hours') * 3600; label = `rolling-${utcDay(to)}`; }
  else { label = opt('date', utcDay(now() - 86400)); [from, to] = dayWindow(label); }
  const r = await dailyReport(db, from, to, { label, send: !!opt('send') });
  if (!opt('hours')) db.state.lastDaily = label;
  saveAnalysisOnly();
  console.log(`report: ${r.file.pathname}\nclassified: ${JSON.stringify(r.classified)}\ntelegram: ${r.sent}`);
} else if (cmd === 'narrative') {
  console.log(narrativeCmd(args.filter(a => !a.startsWith('--') && a !== opt('date')).slice(1).join(' '), opt('date')));
} else if (cmd === 'narratives') {
  console.log(narrativesList(opt('date')));
} else if (cmd === 'light') {
  const r = await lightQueue(db, { limit: +opt('limit', 120) });
  saveAnalysisOnly();
  console.log(r);
} else console.log('commands: watch | status | backfill | analyze | light | daily | narratives | narrative <meta>');
