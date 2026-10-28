// A question's kind from Jev (TypeSafe's decision model, through OpenRouter's Decisions API) where code's regexes read
// it as weak (harness.ts harnessRead: no words that say plainly what it is about; such a follow-up keeps the last plain
// question's intent until Jev is sure). It reads the questions the regexes miss (Chinese, Vietnamese, short follow-ups,
// a new topic in few words); its thresholds were set on a held-out set of questions in six languages. One Choice
// question, about 0.3 s. It never writes text, so nothing it says reaches an answer. Never throws: no key, a timeout, an
// error or an unsure pick is null (the read stays code's).

/** Pinned, not the alias: the thresholds were set on this version */
export const JEV_MODEL = "typesafe/jev-1.14";
const JEV_URL = "https://openrouter.ai/api/alpha/decisions";
const JEV_MIN_CONFIDENCE = 0.65;
const JEV_TIMEOUT_MS = 800;

/** The kinds as Jev reads them (harness.ts HarnessIntent's names) */
export const JEV_INTENTS: Readonly<Record<string, string>> = {
  token:
    "one coin or token, named by its address or ticker or earlier in the chat: is it safe or a rug, its holders, dev, launch, bundles, snipers, taxes, liquidity, chart, volume, story, who holds it; also how to check a coin",
  wallet: "one wallet or address: who owns it, its holdings, balances, pnl, positions, where its money came from or went, tracing funds, a deployer's other launches",
  caller: "a caller or influencer on x: did side wallets buy before their call, a kol's track record",
  narrative: "what runs in the market right now: metas, trending coins, hot narratives, what top traders or smart money buy, fresh launches, lists of promising coins",
  defi: "a protocol's or market's numbers: tvl, yields, fees, revenue, stablecoins, unlocks, funding, open interest, comparing protocols",
  prediction: "prediction market odds: polymarket, kalshi, the chances of an event",
  claim: "checking whether a post, a link, news or a website is true, real or working",
  self: "the assistant itself: who she is, the project and token she speaks for, what she can do",
  general: "anything else: greetings, concepts, opinions, requests for advice or picks, off-topic, tests",
};

export interface JevConfig {
  /** The OpenRouter key; empty = off */
  key: string;
  model?: string;
  url?: string;
  timeoutMs?: number;
  minConfidence?: number;
  /**
   * A sure "general" comes back too (a weak follow-up's read: a concept or a new topic after a coin drops the plan it
   * would keep); without it, "general" is null like an unsure pick
   */
  general?: boolean;
}

export interface JevPick {
  intent: string;
  confidence: number;
  ms: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The kind of `question` (with the chat's `previous` question for a follow-up), or null: no key, no answer in time, an
 * error, a pick under the confidence floor, or "general" unless `cfg.general` asks for it
 */
export async function jevIntent(question: string, previous: string | null, cfg: JevConfig, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<JevPick | null> {
  if (!cfg.key || typeof question !== "string" || question.trim() === "") return null;
  const t0 = now();
  const state = [...(previous ? [`previous question in this chat: ${previous.slice(0, 300)}`] : []), `question: ${question.slice(0, 400)}`];
  const body = {
    model: cfg.model ?? JEV_MODEL,
    state,
    questions: { intent: { type: "choice", instructions: "which kind of crypto research question is this? for a short follow-up, use the previous question", criteria: JEV_INTENTS } },
  };
  try {
    const resp = await fetchFn(cfg.url ?? JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? JEV_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const j: unknown = await resp.json();
    const a = isObj(j) && isObj(j.answers) && isObj(j.answers.intent) ? j.answers.intent : null;
    const intent = typeof a?.choice === "string" ? a.choice : null;
    const confidence = typeof a?.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0;
    if (!intent || !(intent in JEV_INTENTS) || (intent === "general" && cfg.general !== true) || confidence < (cfg.minConfidence ?? JEV_MIN_CONFIDENCE)) return null;
    return { intent, confidence, ms: now() - t0 };
  } catch {
    return null;
  }
}
