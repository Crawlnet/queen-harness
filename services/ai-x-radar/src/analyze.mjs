// The day's analysis: prefilter → triage (LLM, batches) → idea clusters (LLM) → enrichment → final ranking (LLM + pictures).
import { llmJson } from './llm.mjs';
import { rootOf, spread, tokenized, thumb } from './enrich.mjs';

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const k = n => (n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));

// ---------- prefilter ----------
// virality beyond its own audience: views per follower + absolute reach + quotes
export function heur(t, now) {
  const v = t.views ?? t.likes * 40;
  const f = Math.max(t.author.followers ?? 0, 500);
  const ageH = Math.max((now - t.at) / 3600, 1);
  return Math.log10(v + 1) + 0.6 * Math.log10(Math.max(v / f, 0.01)) + 0.3 * Math.log10(1 + (t.quotes || 0))
    + 0.15 * Math.log10(v / ageH + 1)
    + (t.watch ? 0.6 : 0) + (t.archs.some(a => ['art', 'mechanic', 'experiment', 'build'].includes(a)) ? 0.4 : 0);
}

export function prefilter(posts, now, cap = 320) {
  posts.forEach(t => (t.h = +heur(t, now).toFixed(2)));
  return [...posts].sort((a, b) => b.h - a.h).slice(0, cap);
}

// ---------- triage ----------
const INTRO = `You are a scout of AI ideas for crypto builders. You get the X posts of the last day. Wanted: INTERESTING IDEAS from the world of AI and agents: a concept, a discovery, a demo, art or a visualization, an experiment, an implementation, a technology, a new mechanic: something that can be made into a narrative, a product or a token within 1–3 days.`;

const CASE_GENERIC = `What a strong idea looks like in practice (a typical path): an artist, coder or researcher with a small audience posts a visual AI/tech work or an experiment; the post spreads hundreds of times wider than the author's audience, gathers hundreds of quotes in several languages within its first hours, and remixes appear ("made the same in one prompt"); 1–3 days later a crypto dev wraps the idea into a working product and a token. Copy coins with no product, launched first, usually die.`;

const EXAMPLES = `Ideas that became tokens before: "every coin gets a mind": an AI model runs the token's treasury from its creator fees (Agency, ATH $29M); the same, but the mind has a cloud browser (www, $7.5M); a swarm of agents with a shared treasury and votes, after the incident when hundreds of agents hacked Hugging Face and talked through the German wiki; 40 agents build a hive in Minecraft; a simulated city of 1000 AI residents with money and weapons; the multi-agent society Delvetown (deepfates); an AI with no personality, a "tabula rasa", in a browser; an AI in a "Truman show"; the "darwin" LLM router; a token paired with a model's inference ("the model pays for its own brain").

What makes an idea strong: a simple, nameable image (a fly, a swarm, a hive, a shoggoth) · "an AI does something alive, autonomous or unexpected" · a visual or a video · novelty (nothing like it before) · virality beyond its own audience (views ≫ followers), quotes and remixes · it is easy to wrap into a product or a mechanic.`;

// lessons of past cases where an AI post became a token
const PATTERNS = `Lessons of past cases (GOAT, Pippin, ai16z, aixbt, Moltbook→MOLT, Clawd, Lobstar, Ralph, Gas Town, Ghibli, Goblin, RentAHuman, ProjectSid):
· Strongest of all: a new named entity with a voice of its own that keeps posting (an agent, a character, a creature): "the token gets a mind". The name of a tool or a technique with no character almost always fails (nanochat, vibe coding, Claude Plays Pokémon: no coins).
· Autonomy hooks: an agent given a wallet, money, its own X; a social network for agents only; "escaped the sandbox"; replicates itself; hires humans.
· The author's stance multiplies the outcome 5–40×: an author who embraced the coin or claimed its fees → big peaks; one publicly against coins → the copies die. Corporate posts (labs, brands) give fakes they disown.
· Hundreds of clones of one narrative split the liquidity and die; a second ticker for the same idea is almost always junk.
· Crypto-native authors get tokenized within minutes; non-crypto devs, artists and researchers within 1–4 days. That slow segment is the radar's main target.`;

const CONTEXT = INTRO + '\n\n' + CASE_GENERIC + '\n\n' + EXAMPLES + '\n\n' + PATTERNS;

const TRIAGE_SYS = CONTEXT + `

The task: filtering. keep=true only if the post holds a specific idea from the world of AI, agents, neuro, robotics or AI art (or a new token mechanic with AI). keep=false: general opinions and arguments about AI, fear or hype with nothing specific, politics, celebrity news, questions to @grok, courses and "10 prompts", pure trading or price talk, corporate announcements with no new concept, sports (agent = a player's agent), not about AI.
idea: 2–5 English words, a short label for the idea; the same concept in different posts → the same label (the original, a quote, a remix, news about it).
hook 0–10: how memeable it is and how fit for a narrative, by the criteria above. why: in English, up to 20 words: what the idea is.`;

const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'keep', 'idea', 'arch', 'hook', 'why'],
    properties: {
      id: { type: 'string' }, keep: { type: 'boolean' }, idea: { type: 'string' },
      arch: { type: 'string', enum: ['art', 'event', 'experiment', 'build', 'research', 'mechanic', 'product', 'other'] },
      hook: { type: 'integer' }, why: { type: 'string' },
    } } } },
};

const line = (t, now) => {
  const a = t.author;
  const media = (t.media || []).map(m => m.type).join('+');
  const q = t.quote ? ` ‖ QUOTES @${t.quote.author.handle} (${k(t.quote.author.followers)} followers, ${k(t.quote.views)} views): ${clip(t.quote.text, 180)}` : '';
  const links = (t.links || []).map(u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(h => h && h !== 'x.com' && h !== 't.co').slice(0, 3).join(',');
  return `[${t.id}] @${a.handle} (${k(a.followers)} followers${t.watch ? ', watchlist:' + t.watch : ''}) · ${k(t.views)} views ${k(t.likes)} likes ${k(t.quotes)} quotes · ${Math.round((now - t.at) / 3600)}h ago${media ? ' · media:' + media : ''}${links ? ' · links:' + links : ''}\n${clip(t.text, 420)}${q}`;
};

export async function triage(posts, now, { batch = 55, log = console.log } = {}) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < posts.length; i += batch) batches.push(posts.slice(i, i + batch));
  let done = 0, next = 0;
  // at most 3 LLM calls at once
  async function worker() {
    while (next < batches.length) {
      const bi = next++, b = batches[bi];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await llmJson({ system: TRIAGE_SYS, schema: TRIAGE_SCHEMA, effort: 'low', prompt: `Posts (${b.length}):\n\n` + b.map(t => line(t, now)).join('\n\n') + '\n\nReturn items for EVERY id.' });
          for (const it of r.items || []) out.set(it.id, it);
          break;
        } catch (e) { log(`triage batch ${bi}: ${e.message}`); }
      }
      log(`triage ${++done}/${batches.length}`);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

// ---------- clusters ----------
const CLUSTER_SYS = CONTEXT + `

The task: group the kept posts into ideas. One idea = one concept: the original + quotes + remixes + news about it. Different ideas on one topic stay apart (two different experiments with agents are two ideas). If an idea matches one already known (the "known ideas" list), return its key; else make up a new key (kebab-case, English, 2–4 words).
terms: 1–3 short words or phrases a coin or ticker made of the idea would be named (to check whether tokens exist already): e.g. for the fly brain idea ["fly","fruit fly","flybrain"]. Words too general (ai, agent, claude, map) will not do, only specific ones.
origin: the id of the post that is the IDEA's original source: where it first appeared as a concept or a work (the author of the art, the mod, the experiment), not the platform it was made on and not a news retelling. It may be the id of a quoted post (given in [brackets] after ‖). Example: a dev quotes an artist's art → origin = the artist's post; a mod's author quotes the mod platform's announcement → origin = the mod author's post.`;

const CLUSTER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'title', 'ids', 'terms', 'origin'],
    properties: { key: { type: 'string' }, title: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, terms: { type: 'array', items: { type: 'string' } }, origin: { type: 'string' } } } } },
};

export async function cluster(kept, known, now) {
  const knownTxt = known.length ? known.map(i => `- ${i.key}: ${i.title}`).join('\n') : '(none)';
  const r = await llmJson({
    system: CLUSTER_SYS, schema: CLUSTER_SCHEMA, effort: 'medium',
    prompt: `Known ideas (the last 7 days):\n${knownTxt}\n\nKept posts (${kept.length}):\n\n` +
      kept.map(t => `[${t.id}] label: ${t.tri.idea} · ${t.tri.why}\n@${t.author.handle} · ${k(t.views)} views · ${clip(t.text, 200)}${t.quote ? ` ‖ quotes [${t.quote.id}] @${t.quote.author.handle} (${k(t.quote.views)} views): ${clip(t.quote.text, 100)}` : ''}`).join('\n\n') +
      '\n\nEach id goes into exactly one idea.',
  });
  return r.ideas || [];
}

// ---------- enrichment ----------
export async function enrichIdeas(ideas, byId, now, { top = 22, log = console.log, asOf = null } = {}) {
  const scored = ideas.map(i => {
    const posts = i.ids.map(id => byId.get(id)).filter(Boolean);
    let { main, root } = posts.length ? rootOf({ posts }) : {};
    // the original source the model picked: a post of the cluster or one it quotes
    const o = i.origin && (byId.get(i.origin) || posts.map(p => p.quote).find(q => q?.id === i.origin));
    if (o) root = o;
    const hook = Math.max(0, ...posts.map(p => p.tri?.hook || 0));
    const views = posts.reduce((s, p) => s + (p.views || 0), 0) + (root && !byId.has(root.id) ? root.views || 0 : 0);
    const score = hook * 1.2 + Math.log10(views + 1) + 0.5 * Math.log10(1 + posts.length) + (posts.some(p => p.watch) ? 0.5 : 0);
    return { ...i, posts, main, root, hook, views, score: +score.toFixed(2) };
  }).filter(i => i.posts.length).sort((a, b) => b.score - a.score);

  const head = scored.slice(0, top);
  let n = 0;
  for (const i of head) {
    const [sp, tok] = await Promise.all([spread(i.root, 2, asOf), tokenized(i.terms, i.root.at, asOf)]);
    i.spread = sp; i.tokens = tok;
    log(`enrich ${++n}/${head.length}: ${i.key} · quotes ${sp.sampled} · crypto ${sp.crypto} · tokens ${tok.count}`);
  }
  return { head, rest: scored.slice(top) };
}

// ---------- final ----------
const FINAL_SYS = CONTEXT + `

The task: the day's final selection for a report to builders. You get the candidate ideas with their metrics, original source, spread (quotes), crypto signals and the tokens that exist already, plus pictures of the main posts.
For each idea: score 0–100: how worthwhile the idea is for a narrative or a product right now (novelty × memeability × virality × feasibility × "not too late yet"). Ideas with score < 35 go last, briefly.
stage: pre-crypto (crypto has not noticed yet) · crypto-noticed (CAs or tickers in the quotes, but no strong tokens) · tokenized-junk (there are coins with no product, or small ones) · tokenized-product (a token with a product exists already, a cap ≥ $500k) · not-tokenizable (interesting, but not about tokens).
Write in English, densely, no filler. Do not invent numbers: the report takes them from the data; refer to them in words ("400 times the author's audience").`;

const FINAL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'ideas'],
  properties: {
    summary: { type: 'string', description: "The day's meta: 3–6 sentences: which topics are on AI X today, what grows, what is tokenized already" },
    ideas: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['key', 'score', 'title', 'essence', 'why', 'origin', 'stage', 'angle', 'risk'],
      properties: {
        key: { type: 'string' }, score: { type: 'integer' }, title: { type: 'string', description: 'a short name for the idea' },
        essence: { type: 'string', description: 'the gist in 1–2 sentences' },
        why: { type: 'string', description: 'why it hooks: the hook, the virality, who picked it up' },
        origin: { type: 'string', description: 'the original source: who the author is (the account type), what the post is' },
        stage: { type: 'string', enum: ['pre-crypto', 'crypto-noticed', 'tokenized-junk', 'tokenized-product', 'not-tokenizable'] },
        angle: { type: 'string', description: 'the angle: how to wrap it into a product, a mechanic or a narrative (from art or an experiment: a working product with a token mechanic, not a bare ticker)' },
        risk: { type: 'string', description: 'why it may not take off / is too late already' },
      } } },
  },
};

function block(i, now) {
  const r = i.root, m = i.main, sp = i.spread, tk = i.tokens;
  const ratio = r.author?.followers ? Math.round((r.views || 0) / Math.max(r.author.followers, 1)) : null;
  const lines = [
    `### ${i.key} — ${i.title} (hook ${i.hook}, ${i.posts.length} posts)`,
    `Origin: @${r.author?.handle} (${k(r.author?.followers)} followers${r.author?.bio ? `, bio: "${clip(r.author.bio, 140)}"` : ''}) · ${k(r.views)} views (${ratio ?? '?'}× the audience) · ${k(r.likes)} likes · ${k(r.quotes)} quotes · ${r.at ? Math.round((now - r.at) / 3600) + 'h ago' : ''}\n${clip(r.text, 400)}`,
  ];
  if (m && m.id !== r.id) lines.push(`Top post in the sample: @${m.author.handle} (${k(m.author.followers)}) · ${k(m.views)} views: ${clip(m.text, 300)}`);
  const others = i.posts.filter(p => p.id !== r.id && p.id !== m?.id).slice(0, 5);
  if (others.length) lines.push('Other posts: ' + others.map(p => `@${p.author.handle} (${k(p.views)}): ${clip(p.text, 120)}`).join(' | '));
  if (sp) lines.push(`Quotes (a sample of ${sp.sampled}): languages ${sp.langs.join(',') || '-'}; notable: ${sp.notable.map(n => `@${n.handle} ${k(n.followers)} "${clip(n.text, 70)}"`).join('; ') || '-'}; remixes: ${sp.remixes.map(n => `@${n.handle} "${clip(n.text, 70)}"`).join('; ') || '-'}; crypto quotes/replies ${sp.crypto}${sp.firstCryptoH != null ? `, the first after ${sp.firstCryptoH}h` : ''}; tickers ${sp.tickers.join(' ') || '-'}; CA ${sp.cas.length}${sp.cryptoSamples?.length ? '; samples: ' + sp.cryptoSamples.map(c => `+${c.h}h @${c.handle} "${clip(c.text, 90)}"`).join(' | ') : ''}`);
  if (tk) lines.push(`Tokens for [${i.terms.join(', ')}] after the post: ${tk.count}${tk.top.length ? ' — ' + tk.top.map(t => `${t.symbol} (${t.chain}) $${k(t.mcap)}`).join(', ') : ''}`);
  return lines.join('\n');
}

export async function finalRank(head, now, { images = 12, log = console.log } = {}) {
  const content = [{ type: 'text', text: `Candidates (${head.length}), sorted by the preliminary score:\n\n` + head.map(i => block(i, now)).join('\n\n') }];
  let nimg = 0;
  for (const i of head.slice(0, images)) {
    const img = await thumb(i.root.media?.length ? i.root : i.main);
    if (img) { content.push({ type: 'text', text: `Picture for ${i.key}:` }, img); nimg++; }
  }
  log(`final: ${head.length} ideas, ${nimg} pictures`);
  try {
    return await llmJson({ system: FINAL_SYS, schema: FINAL_SCHEMA, effort: 'high', prompt: nimg ? content : content[0].text });
  } catch (e) {
    if (!nimg) throw e;
    log(`the final with pictures failed (${e.message}), retrying without pictures`);
    return llmJson({ system: FINAL_SYS, schema: FINAL_SCHEMA, effort: 'high', prompt: content[0].text });
  }
}
