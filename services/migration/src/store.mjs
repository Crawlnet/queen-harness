// data/db.json = { tokens: {mint: Token}, state: {...} }; the events and the archive are jsonl.
import fs from 'fs';
import { CFG, now } from './config.mjs';

const DIR = new URL('../data/', import.meta.url);
fs.mkdirSync(DIR, { recursive: true });
export const dataPath = name => new URL(name, DIR);

export function newToken(o) {
  const t = {
    mint: o.mint, platform: o.platform, sources: [o.source], trackStart: o.trackStart ?? now(),
    migratedAt: o.migratedAt ?? null, migratedAtExact: o.migratedAtExact ?? true, migSig: o.sig ?? null,
    createdAt: o.createdAt ?? null,
    meta: o.meta ?? null, jup: o.jup ?? null, market: null, ath: { mcap: 0, at: null },
    lastPolledAt: 0, lastAliveAt: now(),
    runner: null, tiers: Object.fromEntries(CFG.TIERS.map(x => [x, { state: 'unchecked' }])),
    tierCheckedAt: 0, events: [], analysis: null,
  };
  armRunner(t);
  return t;
}

// runner tracking: only a day from the migration
export function armRunner(t) {
  if (t.runner || !t.migratedAt || now() - t.migratedAt >= CFG.RUNNER_ARM) return;
  // found late (the first start / a downtime) → the missed stretch is checked from candles
  t.runner = { state: 'idle', armedUntil: t.migratedAt + CFG.RUNNER_ARM, backfill: now() - t.migratedAt > 180 ? 'needed' : 'none' };
}

export function loadDb() {
  try { return JSON.parse(fs.readFileSync(dataPath('db.json'), 'utf8')); } catch {}
  const db = { tokens: {}, state: {} };
  try { // an import of the parser's first-version format
    for (const r of Object.values(JSON.parse(fs.readFileSync(dataPath('migrations.json'), 'utf8')))) {
      const t = newToken({ ...r, source: 'migration', trackStart: r.migratedAt });
      t.market = r.market || null;
      db.tokens[r.mint] = t;
    }
  } catch {}
  return db;
}

export function saveDb(db) {
  const tmp = dataPath('db.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, dataPath('db.json'));
}

export const appendJsonl = (name, obj) => fs.appendFileSync(dataPath(name), JSON.stringify(obj) + '\n');
export function readJsonl(name) {
  try { return fs.readFileSync(dataPath(name), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}
