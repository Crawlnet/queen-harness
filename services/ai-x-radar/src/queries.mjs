// What the radar searches for. The window (since_time/until_time) is added at run time.
// The min_faves floors are set so that a query over a day returns tens to hundreds of posts, not thousands.
// The archetypes of idea sources:
//   art        — viral AI or tech art, or a demo, outside crypto (seen far beyond its author's following)
//   event      — an AI-world event people build "what if agents…" on (a swarm of agents hacked HF, a fly brain, Muse, Jev, nanochat)
//   experiment — an AI-culture experiment (deepfates/Delvetown, AI Village, Truth Terminal: "we gave an AI X and watch")
//   build      — "I built / one prompt / open source": remixes and implementations
//   research   — a paper, method or model with a clear hook (Dust: backprop-free pretraining)
//   mechanic   — a new mechanic of the agent-token meta (living tokens, fees→compute, AI founders, programmable fees)
import { env } from './env.mjs';

export const QUERIES = [
  // --- broad viral AI/tech ---
  { id: 'viral-ai', arch: 'event', pages: 6, q: '(ai OR llm OR gpt OR claude OR gemini OR grok OR openai OR anthropic OR deepmind OR "neural net") min_faves:3000 lang:en -"@grok" -filter:replies' },
  { id: 'viral-agents', arch: 'event', pages: 5, q: '(agent OR agents OR agentic OR autonomous OR swarm) min_faves:1000 lang:en -"free agent" -nba -nfl -mlb -filter:replies' },
  { id: 'opensource', arch: 'research', pages: 4, q: '("open source" OR "open-source" OR "open weights" OR huggingface OR "hugging face" OR github) (model OR agent OR ai OR llm) min_faves:500 -filter:replies' },
  { id: 'research', arch: 'research', pages: 4, q: '(paper OR arxiv OR "new method" OR breakthrough OR pretraining OR "we trained" OR benchmark) (ai OR llm OR transformer OR model OR neural) min_faves:800 -filter:replies' },

  // --- art / creative code / visualizations ---
  { id: 'creative-code', arch: 'art', pages: 4, q: '(#js OR #css OR #webgl OR #threejs OR #touchdesigner OR #generativeart OR #creativecoding OR "creative coding" OR shader OR p5js OR #houdini) min_faves:800 -filter:replies' },
  { id: 'visualize-ai', arch: 'art', pages: 3, q: '(visualize OR visualise OR visualized OR visualization OR "what it looks like" OR "imagined") (ai OR agent OR agents OR llm OR model OR neural OR internet) min_faves:500 -filter:replies filter:media' },
  // viral tech visuals with NO AI words are caught only by hashtags: creative coders add them out of habit,
  // and a word query without hashtags drowns in noise
  { id: 'creative-code-2', arch: 'art', pages: 3, q: '(#b3d OR #blender OR #genart OR #glsl OR #processing OR #javascript OR #codeart OR #proceduralart OR #unity3d OR #indiedev OR #gamedev OR #pixelart) min_faves:2000 -filter:replies' },
  { id: 'alife', arch: 'art', pages: 3, q: '("artificial life" OR alife OR "digital organism" OR "digital creature" OR connectome OR "fruit fly" OR neurons OR "evolved" OR "self-replicating") min_faves:300 -filter:replies' },

  // --- "gave an AI …" experiments ---
  { id: 'gave-ai', arch: 'experiment', pages: 4, q: '("gave an ai" OR "gave ai" OR "gave claude" OR "gave gpt" OR "let an ai" OR "let ai" OR "asked my agent" OR "told my agent" OR "gave my agent" OR "left an ai" OR "the ai decided" OR "agents decided") min_faves:200 -filter:replies' },
  { id: 'agent-world', arch: 'experiment', pages: 4, q: '(agents OR "ai agents" OR llms OR npcs) (society OR civilization OR town OR city OR village OR world OR simulation OR minecraft OR economy OR government OR religion) min_faves:300 -filter:replies' },

  // --- implementations / remixes ---
  { id: 'built', arch: 'build', pages: 5, q: '("i built" OR "i made" OR "we built" OR "just built" OR "just shipped" OR "one prompt" OR "one-shot" OR "one-shotted" OR "vibe coded" OR "weekend project") (ai OR agent OR agents OR claude OR codex OR llm OR gpt OR opus) min_faves:500 -filter:replies' },
  { id: 'what-if', arch: 'build', pages: 3, q: '("what if" OR "imagine if" OR "someone should build" OR "startup idea" OR "who is building") (ai OR agent OR agents OR llm) min_faves:500 -filter:replies' },

  // --- the bridge to crypto: new mechanics of the agent-token meta (low floors: novelty matters here, not reach) ---
  { id: 'mechanic', arch: 'mechanic', pages: 4, q: '(agent OR agents OR ai OR llm OR mind OR minds OR model) ("creator fees" OR "creator fee" OR launchpad OR "pump.fun" OR pumpfun OR bags OR bankr OR "x402") min_faves:150 -filter:replies' },
  { id: 'living-token', arch: 'mechanic', pages: 3, q: '("every coin" OR "every token" OR "living token" OR "living tokens" OR "pays for its own" OR "pay for their own" OR "own compute" OR "own inference" OR "agent-run" OR "ai-run" OR "run by an ai") min_faves:100 -filter:replies' },
  { id: 'so-i-built', arch: 'mechanic', pages: 3, q: '("so i built" OR "so we built" OR "inspired by" OR "turned it into" OR "went viral") (coin OR token OR ca OR launch OR pump) (ai OR agent OR agents OR llm) min_faves:100 -filter:replies' },

  // --- an entity / autonomy (past cases: Lobstar, Moltbook, claudius, Goblin, parafactual) ---
  { id: 'agent-wallet', arch: 'experiment', pages: 3, q: '("gave my agent" OR "gave claude" OR "gave opus" OR "gave gpt" OR "my agent" OR "our agent") (wallet OR sol OR eth OR usdc OR "own twitter" OR "own x account" OR "its own") min_faves:200 -filter:replies' },
  { id: 'agents-only', arch: 'experiment', pages: 2, q: '("social network for" OR "only ai agents" OR "agents only" OR "for ai agents" OR "agents can now" OR "built for agents") min_faves:300 -filter:replies' },
  { id: 'escape', arch: 'experiment', pages: 3, q: '(agent OR claude OR llm OR ai OR model) (escaped OR "out of the sandbox" OR "self-replicating" OR "replicated itself" OR "runs itself" OR "went rogue" OR "hired a human") min_faves:400 -filter:replies' },
  { id: 'model-quirk', arch: 'event', pages: 2, q: '("character model" OR "base model" OR "obsessed with" OR "keeps talking about" OR "won\'t stop") (gpt OR claude OR opus OR gemini OR grok OR model) min_faves:300 -filter:replies' },
  // the bridges' feed: someone already pulls an idea into crypto (a stage signal, not an idea source)
  { id: 'bridge-feed', arch: 'mechanic', pages: 3, q: '("@bankrbot deploy" OR "send all fees to" OR "fees go to" OR "someone made a coin" OR "someone launched a token" OR "someone created a coin" OR "made a coin for") min_faves:30 -filter:replies' },

  // --- non-English hubs (CN accounts say "new AI meme trend" outright) ---
  { id: 'zh', arch: 'event', pages: 3, q: '(AI OR 智能体 OR 大模型 OR 机器人 OR 模型) (meme OR 热门 OR 爆火 OR 刷屏 OR 叙事) min_faves:200 -filter:replies' },
];

// The watchlist: accounts whose posts are a signal in themselves. Searched in batches of from:a OR from:b (a lower floor).
// NOTE: X search does not return the posts of brand-new accounts; profileStatuses() reads those.
export const WATCH = {
  'ai-research': ['karpathy', 'DrJimFan', '_akhaliq', 'arankomatsuzaki', 'rohanpaul_ai', 'omarsar0', 'emollick', 'swyx', 'simonw', 'hardmaru', 'goodside', 'natolambert', 'teortaxesTex', 'Teknium1', 'NousResearch', 'jeffclune', 'polynoamial', 'nearcyan', 'tszzl', 'jd_pressman', 'OfficialLoganK', 'ClementDelangue', '_philschmid', 'alexalbert__', 'mattshumer_', 'levelsio', 'mckaywrigley', 'AravSrinivas'],
  labs: ['OpenAI', 'AnthropicAI', 'GoogleDeepMind', 'xai', 'AIatMeta', 'MistralAI', 'deepseek_ai', 'Alibaba_Qwen', 'huggingface', 'cursor_ai', 'typesafeai', 'OpenAIDevs', 'claudeai'],
  'ai-culture': ['deepfates', 'repligate', 'AndyAyrey', 'truth_terminal', 'aidigest_', 'grove_research', 'liminal_bardo', 'AISafetyMemes', 'voooooogel', 'kalomaze', 'anthrupad', 'amplifiedamp', 'parafactual', 'doomslide', 'xlr8harder', 'TetraspaceWest', 'Sauers_', 'arb8020', 'elder_plinius'],
  // builders whose posts have already become coins
  'agent-origin': ['steipete', 'openclaw', 'MattPRD', 'moltbook', 'GeoffreyHuntley', 'Steve_Yegge', 'KyeGomezB', '0rxbt', 'pashmerepat', 'LobstarWilde', 'austingriffith', 'clawdbotatg', 'Alezander9', 'AlexanderTw33ts', 'marvin_tong', 'GuangyuRobert'],
  // bridges: their quotes = the idea is moving into crypto (a stage), a lower floor
  bridges: ['StriderEVM', 'CutterDegen', 'esotericpigeon', 'claudiuswrld', 'earlTrades', 'will8bit', 'nigski77', 'LyvoCrypto', 'stitchdegen', 'bitecong', 'jaxkahuna', 'bread_makr', 'JTC00KS', 'gudmansachs', 'PumpfunClaims', 'clanker_world', 'LaunchOnBags', 'Clawnch_Bot'],
  'creative-code': ['mrdoob', 'steveruizok', 'zachlieberman', 'mattdesl', 'akella', 'Cabbibo'],
  'agent-builders': ['yoheinakajima', 'shawmakesmagic', 'hwchase17', 'jerryjliu0', 'browserbasehq', 'e2b_dev', 'firecrawl_dev', 'amasad'],
  'crypto-ai': ['frankdegods', 'blknoiz06', 'notthreadguy', '0xDeployer', 'bankrbot', 'clawpumptech', 'tryagency', 'virtuals_io', 'ponsdotfamily', 'musebooklol', 'a1lon9', 'aixbt_agent'],
};
export const WATCH_MIN_FAVES = 40;
export const WATCH_BATCH = 14;

// Authors never taken as a source (RADAR_EXCLUDE_AUTHORS: a comma list of X handles, none by default): their posts are
// dropped, and so are other people's posts quoting them.
export const EXCLUDE_AUTHORS = new Set((env('RADAR_EXCLUDE_AUTHORS') || '').split(',').map(h => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean));
export const excluded = t => EXCLUDE_AUTHORS.has(t?.author?.handle?.toLowerCase()) || EXCLUDE_AUTHORS.has(t?.quote?.author?.handle?.toLowerCase());

export const watchQueries = () => Object.entries(WATCH).flatMap(([cat, hs]) => {
  const out = [];
  for (let i = 0; i < hs.length; i += WATCH_BATCH)
    out.push({ id: `watch-${cat}-${i / WATCH_BATCH}`, arch: 'watch', cat, pages: 3, q: `(${hs.slice(i, i + WATCH_BATCH).map(h => 'from:' + h).join(' OR ')}) min_faves:${WATCH_MIN_FAVES} -filter:replies` });
  return out;
});

export const watchCategory = Object.fromEntries(Object.entries(WATCH).flatMap(([c, hs]) => hs.map(h => [h.toLowerCase(), c])));
