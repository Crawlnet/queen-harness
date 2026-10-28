// The report: a run's full markdown file (the run's JSON is written by index.mjs).
import fs from 'fs';
import { DATA } from './env.mjs';

const k = n => (n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const STAGE = {
  'pre-crypto': '🟢 crypto has not noticed yet', 'crypto-noticed': '🟡 crypto noticed, no strong tokens',
  'tokenized-junk': '🟠 small coins with no product', 'tokenized-product': '🔴 a token with a product exists', 'not-tokenizable': '⚪ not about tokens',
};
const ago = (now, at) => (at ? `${Math.round((now - at) / 3600)} h ago` : '');

// Repeats: an item whose post already stood in an earlier report is left out of the main list (the list's format stays
// as it is). Such topics, and repeated ideas in general, go in a block of their own at the very end: the topic is still alive.
// "Already shown" = the post's link is in an earlier day's report.md.
const idOf = p => p?.id || String(p?.url || '').match(/status\/(\d+)/)?.[1] || null;
export function shownPosts(date) {
  const runs = new URL('runs/', DATA), m = new Map();
  let days = [];
  try { days = fs.readdirSync(runs).filter(d => d < date).sort(); } catch {}
  for (const d of days) {
    let md = '';
    try { md = fs.readFileSync(new URL(`${d}/report.md`, runs), 'utf8'); } catch { continue; }
    for (const x of md.matchAll(/status\/(\d+)/g)) if (!m.has(x[1])) m.set(x[1], d);
  }
  return m;
}
const isNew = (p, shown) => !shown.has(idOf(p));
// the split into "shown" and "topics from earlier reports": a repeat = its post was shown already, or the idea was seen on an earlier day
function splitRepeats({ date, fin, byKey, rest, state, shown }) {
  const ranked = (fin.ideas || []).filter(x => byKey.has(x.key)).sort((a, b) => b.score - a.score);
  const show = ranked.filter(x => isNew(byKey.get(x.key).root, shown));
  const since = x => [state?.[x.key]?.first, shown.get(idOf(byKey.get(x.key).root))].filter(d => d && d < date).sort()[0];
  const repeats = ranked.filter(x => since(x)).map(x => ({ title: x.title, since: since(x) }));
  return { show, rest: rest.filter(i => isNew(i.root, shown)), repeats };
}

export function buildMarkdown({ date, from, to, now, fin, head, rest, meta, state, shown = new Map() }) {
  const byKey = new Map(head.map(i => [i.key, i]));
  const sp0 = splitRepeats({ date, fin, byKey, rest, state, shown }), ideas = sp0.show;
  rest = sp0.rest;
  const strong = ideas.filter(x => x.score >= 35), weak = ideas.filter(x => x.score < 35);
  const L = [];
  L.push(`# AI-X radar — ${date}`);
  if (from) L.push(`Window: ${new Date(from * 1000).toISOString().slice(0, 16)} → ${new Date(to * 1000).toISOString().slice(0, 16)} UTC` + (meta.posts != null ? ` · posts ${meta.posts} → kept ${meta.kept} → ideas ${meta.ideas}` : ''));
  L.push('', "## The day's meta", '', fin.summary || '—', '');
  L.push('## Ideas', '');
  strong.forEach((x, n) => {
    const i = byKey.get(x.key), r = i.root, sp = i.spread, tk = i.tokens;
    const st = state?.[x.key];
    const seen = st && st.first < date ? `seen since ${st.first}` : '🆕 new';
    const ratio = r.author?.followers ? Math.round((r.views || 0) / Math.max(r.author.followers, 1)) : null;
    L.push(`### ${n + 1}. ${x.title} — ${x.score}/100`);
    L.push(`${STAGE[x.stage] || x.stage} · ${seen} · \`${x.key}\``, '');
    L.push(`**Gist.** ${x.essence}`, '');
    L.push(`**Why it hooks.** ${x.why}`, '');
    L.push(`**Origin.** [@${r.author?.handle}](${r.url}) (${k(r.author?.followers)} followers) · ${k(r.views)} views${ratio ? ` (${ratio}× the audience)` : ''} · ${k(r.likes)} likes · ${k(r.quotes)} quotes · ${ago(now, r.at)}. ${x.origin}`);
    L.push(`> ${clip(r.text, 280)}`, '');
    if (sp) {
      const parts = [];
      const notable = sp.notable.filter(q => isNew(q, shown)), remixes = sp.remixes.filter(q => isNew(q, shown));
      if (notable.length) parts.push('notable quotes: ' + notable.slice(0, 4).map(q => `[@${q.handle}](${q.url}) ${k(q.followers)}`).join(', '));
      if (remixes.length) parts.push('remixes: ' + remixes.slice(0, 3).map(q => `[@${q.handle}](${q.url})`).join(', '));
      if (sp.langs.length) parts.push('languages: ' + sp.langs.join(' '));
      parts.push(`crypto quotes/replies ${sp.crypto}${sp.firstCryptoH != null ? ` (the first after ${sp.firstCryptoH} h)` : ''}${sp.cas.length ? `, CA ${sp.cas.length}` : ''}${sp.tickers.length ? ', tickers ' + sp.tickers.join(' ') : ''}`);
      L.push(`**Spread.** ${parts.join(' · ')}`, '');
    }
    if (tk) L.push(`**Tokens** for "${i.terms.join('", "')}" after the post: ${tk.count ? tk.top.map(t => `[${t.symbol}](${t.url}) ${t.chain} $${k(t.mcap)}`).join(', ') + (tk.count > tk.top.length ? ` … ${tk.count} in all` : '') : 'none'}`, '');
    L.push(`**Angle.** ${x.angle}`, '');
    L.push(`**Risk.** ${x.risk}`, '');
    const others = i.posts.filter(p => p && typeof p === 'object' && p.id !== r.id && isNew(p, shown)).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 4);
    if (others.length) L.push('More posts: ' + others.map(p => `[@${p.author.handle} · ${k(p.views)}](${p.url})`).join(' · '), '');
  });
  if (weak.length) {
    L.push('## Weaker (score < 35)', '');
    for (const x of weak) { const r = byKey.get(x.key).root; L.push(`- **${x.title}** (${x.score}) — ${x.essence} [@${r.author?.handle} · ${k(r.views)}](${r.url})`); }
    L.push('');
  }
  if (rest.length) {
    L.push('## Did not make the final', '');
    for (const i of rest) L.push(`- ${i.title} — [@${i.root.author?.handle} · ${k(i.root.views)}](${i.root.url})`);
    L.push('');
  }
  if (sp0.repeats.length) {
    L.push('## Topics from earlier reports (still in the feed)', '');
    for (const x of sp0.repeats) L.push(`- ${x.title} (since ${x.since})`);
    L.push('');
  }
  if (meta.collectSec != null) L.push('---', `Collect ${meta.collectSec} s · X requests ${meta.xCalls} (fx errors ${meta.fxErr}, tapi ${meta.tapi}) · LLM ${meta.llmCalls} calls`);
  if (meta.empty?.length) L.push(`⚠️ Empty queries (the source may be failing silently): ${meta.empty.join(', ')}`);
  return { md: L.join('\n'), strong, weak };
}

