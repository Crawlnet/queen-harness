// Collect: every query over the window [from, to] → a pool of unique posts, each marked with the queries that found it.
// The window is in unix seconds; both fx and twitterapi.io take since_time/until_time.
// Against fx's silent failures (a 200 with nothing in it): a canary before the start, empty answers tried again (x.mjs),
// and a second pass over the queries that found nothing, after a pause. The quality summary goes into the report.
import { search, stats, canary, hasTapi, forceTapi } from './x.mjs';
import { QUERIES, watchQueries, watchCategory, excluded } from './queries.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function collect({ from, to, log = console.log, only } = {}) {
  const qs = [...QUERIES, ...watchQueries()].filter(q => !only || only.some(o => q.id.startsWith(o)));
  const pool = new Map();
  const perQuery = {};
  const window = ` since_time:${from}` + (to ? ` until_time:${to}` : '');

  for (let i = 0; i < 4; i++) {
    const c = await canary();
    if (c) break;
    log(`canary: fx returned nothing (${i + 1}/4)`);
    // with a twitterapi.io key, after two empty canaries the whole run goes through it
    if (i >= 1 && hasTapi()) {
      forceTapi();
      const t = await canary();
      log(`canary: fx is down → twitterapi.io (${t ? 'answers' : 'empty too'})`);
      if (t) break;
    }
    if (i === 3) {
      // the source is dead: rather than spend hours retrying every query, return "all empty" at once
      log('canary: fx does not answer, collect skipped');
      return { posts: [], perQuery: {}, quality: { queries: qs.length, empty: qs.map(q => q.id), fxEmpty: stats.fxEmpty, fxErr: stats.fxErr, down: true } };
    }
    await sleep(60e3);
  }

  async function run(q) {
    try {
      const res = await search(q.q + window, { pages: q.pages, retryEmpty: true });
      perQuery[q.id] = res.length;
      for (const t of res) {
        if (t.repostedBy || excluded(t)) continue;
        if (t.at && (t.at < from || (to && t.at > to))) continue;
        const cur = pool.get(t.id) || { ...t, hits: [], archs: [] };
        if (!cur.hits.includes(q.id)) cur.hits.push(q.id);
        if (!cur.archs.includes(q.arch)) cur.archs.push(q.arch);
        const wc = watchCategory[t.author.handle?.toLowerCase()];
        if (wc) cur.watch = wc;
        pool.set(t.id, cur);
      }
    } catch (e) {
      perQuery[q.id] = 'ERR ' + e.message;
      log(`query ${q.id}: ${e.message}`);
    }
  }

  // 2 workers: fx allows 1000 req/min, but its pool of X accounts for search runs out sooner
  let i = 0;
  const worker = async () => { while (i < qs.length) { await run(qs[i++]); await sleep(500); } };
  await Promise.all([worker(), worker()]);

  // a second pass: the queries with zero or an error, one at a time after a pause (fx's silent failure usually passes within a minute)
  for (let round = 0; round < 2; round++) {
    const zero = qs.filter(q => !(perQuery[q.id] > 0));
    if (!zero.length) break;
    log(`retrying ${zero.length} empty queries in 45 s: ${zero.map(q => q.id).join(', ')}`);
    await sleep(45e3);
    for (const q of zero) { await run(q); await sleep(1500); }
  }

  const empty = qs.filter(q => !(perQuery[q.id] > 0)).map(q => q.id);
  const quality = { queries: qs.length, empty, fxEmpty: stats.fxEmpty, fxErr: stats.fxErr };
  log(`collect: ${qs.length} queries, ${pool.size} unique posts, ${empty.length} empty | fx ${stats.fx}/err ${stats.fxErr}/empty ${stats.fxEmpty} tapi ${stats.tapi}/err ${stats.tapiErr}`);
  return { posts: [...pool.values()], perQuery, quality };
}
