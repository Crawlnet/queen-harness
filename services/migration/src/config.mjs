// Every threshold in one place. Times in seconds, market caps in USD.
export const CFG = {
  // Runners from migrations: ≥150k, the median of the per-minute prices over 10 min at or over the threshold.
  // The window restarts at each new crossing until a day has passed since the migration.
  RUNNER_MCAP: 150_000,
  RUNNER_HOLD: 600,
  RUNNER_ARM: 86_400,
  // Cap tiers (whether migrated or not): the FIRST hold of 1/5/10/25/50M, the median over 30 min at or over the threshold.
  TIERS: [1e6, 5e6, 10e6, 25e6, 50e6],
  TIER_HOLD: 1800,
  TIER_WATCH_FROM: 0.6, // a tier candidate from 60% of the nearest unresolved tier
  MIN_SAMPLE_RATIO: 0.6, // a window counts with ≥60% of its per-minute samples
  PRIOR_MINUTE_WINDOW: 48 * 3600, // minute candles over 2 days (3 pages × 1000); older, hourly closes only → "hit before"

  // Anti-fake (DexScreener: mcap, liquidity, volume.h24)
  MIN_LIQ: 15_000,
  MAX_MCAP_LIQ: 60,
  RUNNER_MIN_TURNOVER: 0.2, // vol24h/mcap: farms 0.01–0.06, live runners 0.3+
  // A farm = turnover < 10% AND mcap/liq > 5, unless Jupiter's organicScore ≥ 40 (old live coins: Fartcoin 83, Bert 65).
  // Calibrated on farmed clones ("Oil Fund", SARP, WOTF, USDF, NTDA: turnover 0.00–0.06 at 15–675×) against live runners
  // (turnover ≥ 0.14 even in their first hour). Fresh coins score an organicScore of 0, live ones too → an exception only.
  FARM_RATIO: 5,
  FARM_TURNOVER: 0.1,
  ORGANIC_OK: 40,

  TICK: 60,
  DEX_CALLS_PER_TICK: 60, // ×30 mints; DexScreener's limit is 300/min
  COLD_EVERY: 600,
  DEAD_EVERY: 7_200,
  DEAD_MCAP: 30_000,
  DEAD_LIQ: 5_000,
  ARCHIVE_DEAD_AFTER: 3 * 86_400,
  ARCHIVE_EVENT_AFTER: 30 * 86_400,
  STONK_EVERY: 120,
  BACKFILL_MIN_MCAP: 30_000, // a runner's backfill from candles only if the pool is not dead
  BACKFILL_MIN_LIQ: 8_000,

  DISCOVERY_EVERY: 300,
  DISCOVERY_MIN_MCAP: 500_000,
  LAUNCHPADS: { 'pump.fun': 'pump', stonkfun: 'stonk' },

  // A drawn ladder (left out entirely): the pool starts at an inflated cap and climbs evenly, with no pullbacks, on a tiny
  // turnover. By 15-min candles over the pool's life (GOIF/SARP/VSOF: drawdown 0%, up 100%, turnover 0.00–0.03; live
  // Jane/MICRO/COCKROACH/DOMAIN: drawdown 68–92%, up 0.38–0.51, turnover 3–27).
  JUNK_MAX_DD: 0.10, JUNK_MIN_UP: 0.85, JUNK_MIN_CANDLES: 6, JUNK_MAX_TURNOVER: 0.2,
  JUNK_CHECK_MCAP: 100_000, JUNK_RECHECK: 6 * 3600,

  ANALYZE_EVERY: 900,
  ANALYZE_BATCH: 10,
  DAILY_AT_UTC_MIN: 5, // 00:05 UTC: the report for the past day
};

export const now = () => Math.floor(Date.now() / 1000);
export const tierLabel = x => (x >= 1e6 ? x / 1e6 + 'M' : x / 1e3 + 'k');

// Why the market data counts as fake; null = fine.
export function fakeReason(m, kind, organic = null) {
  if (!m || !m.mcap) return 'no-market';
  if (m.liquidity < CFG.MIN_LIQ) return 'low-liq';
  const ratio = m.mcap / m.liquidity, turn = (m.volume24h || 0) / m.mcap;
  if (ratio > CFG.MAX_MCAP_LIQ) return 'mcap/liq';
  if (ratio > CFG.FARM_RATIO && turn < CFG.FARM_TURNOVER && !(organic >= CFG.ORGANIC_OK)) return 'farm';
  if (kind === 'runner' && turn < CFG.RUNNER_MIN_TURNOVER) return 'low-turnover';
  return null;
}

// Only the reasons that make the price meaningless block an event. A farm / mcap/liq / low turnover is NOT a block:
// farms count when people buy into their narratives → the event is flagged and reported apart.
export const BLOCKING = ['no-market', 'low-liq'];
