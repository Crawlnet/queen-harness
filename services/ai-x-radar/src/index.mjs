// The AI-X radar. Commands:
//   node src/index.mjs run [--hours 24] [--to ISO]         — the daily run (by default the window is the last 24 h)
//   node src/index.mjs backtest --to ISO [--hours 24]      — the same over a past window, no state written
//   node src/index.mjs collect [--hours 24] [--to ISO]     — collect only (no LLM), to debug the queries
//   --if-missing: skip a day whose report is already written (for a run repeated on a schedule)
import fs from 'fs';
import { DATA } from './env.mjs';
import { collect } from './collect.mjs';
import { stats, hasTapi, tapiBalance } from './x.mjs';
import { prefilter, triage, cluster, enrichIdeas, finalRank } from './analyze.mjs';
import { llmStats, backend } from './llm.mjs';
import { buildMarkdown, shownPosts } from './report.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'run';
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const STATE = new URL('ideas.json', DATA);
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };

async function main() {
  const to = opt('to') ? Math.floor(Date.parse(opt('to')) / 1000) : Math.floor(Date.now() / 1000);
  const hours = +opt('hours', 24);
  const from = to - hours * 3600;
  const now = to;
  const date = new Date(to * 1000).toISOString().slice(0, 10);
  const isBack = cmd === 'backtest';
  const dir = new URL(`${isBack ? 'backtest' : 'runs'}/${date}${isBack ? '-' + new Date(to * 1000).toISOString().slice(11, 13) : ''}/`, DATA);
  // a repeated run: if today's report is there already, exit
  if (opt('if-missing') && fs.existsSync(new URL('final.json', dir))) return log("today's report is there already, skipped");
  // a lock: two runs never go at once (one older than 3 h counts as dead)
  const LOCK = new URL('run.lock', DATA);
  if (!isBack) {
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs < 3 * 3600e3) return log('another run is still going, skipped'); } catch {}
    fs.writeFileSync(LOCK, String(process.pid));
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });
  }
  fs.mkdirSync(dir, { recursive: true });
  const save =(name, obj) => fs.writeFileSync(new URL(name, dir), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));

  log(`window ${new Date(from * 1000).toISOString()} → ${new Date(to * 1000).toISOString()} · LLM ${backend()}`);
  const t0 = Date.now();
  // twitterapi.io credits: a run uses about 25k; with fewer the report may not complete, but the run is tried anyway
  const TAPI_RUN = 25000;
  const credits = !isBack && hasTapi() ? await tapiBalance() : null;
  if (credits !== null) log(`twitterapi.io: ${credits} credits (~$${(credits / 1e5).toFixed(2)})${credits < TAPI_RUN ? `, under the ~${TAPI_RUN / 1000}k a run uses` : ''}`);
  const { posts, perQuery, quality } = await collect({ from, to, log });
  const collectSec = Math.round((Date.now() - t0) / 1000);
  save('pool.json', posts); save('per-query.json', perQuery);
  if (cmd === 'collect') return;
  // the source is down (fxtwitter's /2/search answering 404 to everything, say): no "0 ideas" report;
  // a repeated run (--if-missing) tries again once search is back
  if (!isBack && quality.empty.length >= quality.queries * 0.8) {
    const creditErr = /credit|balance|insufficient|402/i.test(stats.tapiFatal || '');
    log(`the X source does not answer: ${quality.empty.length}/${quality.queries} queries empty${creditErr ? ' (twitterapi.io is out of credits)' : ''}, no report`);
    process.exitCode = 2;
    return;
  }

  const cand = prefilter(posts, now, +opt('cap', 320));
  log(`prefilter: ${cand.length} of ${posts.length}`);
  const tri = await triage(cand, now, { log });
  for (const t of cand) t.tri = tri.get(t.id);
  const kept = cand.filter(t => t.tri?.keep);
  log(`triage: ${kept.length} kept (${tri.size}/${cand.length} answered)`);
  save('triage.json', cand.map(t => ({ id: t.id, url: t.url, h: t.h, ...t.tri })));

  const state = loadState();
  const known = Object.entries(state).filter(([, v]) => v.last >= new Date((to - 7 * 86400) * 1000).toISOString().slice(0, 10)).map(([key, v]) => ({ key, title: v.title }));
  const ideas = await cluster(kept, isBack ? [] : known, now);
  log(`clusters: ${ideas.length} ideas`);
  const byId = new Map(kept.map(t => [t.id, t]));
  const { head, rest } = await enrichIdeas(ideas, byId, now, { top: +opt('top', 22), log, asOf: isBack ? to : null });
  save('ideas.json', head.map(({ posts, ...i }) => ({ ...i, posts: posts.map(p => ({ id: p.id, url: p.url, views: p.views, author: { handle: p.author.handle } })) })));
  save('rest.json', rest.map(i => ({ key: i.key, title: i.title, root: { url: i.root.url, views: i.root.views, author: { handle: i.root.author?.handle } } })));

  const fin = await finalRank(head, now, { log });
  save('final.json', fin);

  const meta = { posts: posts.length, kept: kept.length, ideas: ideas.length, collectSec, xCalls: stats.fx + stats.tapi, fxErr: stats.fxErr, tapi: stats.tapi, llmCalls: llmStats.calls, empty: quality.empty };
  const shown = isBack ? new Map() : shownPosts(date);  // the posts of earlier reports are not shown again
  const { md, strong } = buildMarkdown({ date, from, to, now, fin, head, rest, meta, state: isBack ? {} : state, shown });
  const file = new URL('report.md', dir);
  fs.writeFileSync(file, md);
  save('meta.json', { meta, window: { from, to } });
  log(`report: ${file.pathname} · ${strong.length} strong ideas`);

  if (!isBack) {
    for (const x of fin.ideas || []) {
      const i = head.find(h => h.key === x.key);
      if (!i) continue;
      const s = state[x.key] ||= { title: x.title, first: date, days: [] };
      s.title = x.title; s.last = date;
      s.days = s.days.filter(d => d.date !== date).concat({ date, score: x.score, stage: x.stage, views: i.root.views, root: i.root.url }).slice(-30);
    }
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    // cleanup: runs older than 30 days (pool.json is ~1–2 MB a day)
    const runs = new URL('runs/', DATA);
    for (const d of fs.readdirSync(runs)) if (d < new Date((to - 30 * 86400) * 1000).toISOString().slice(0, 10)) fs.rmSync(new URL(d + '/', runs), { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
