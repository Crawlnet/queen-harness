// The harness's settings, from env. The model is any OpenAI-compatible chat completions API with tool calls:
// LLM_BASE_URL, LLM_API_KEY and LLM_MODEL. Messages here never echo a key.

import { readFileSync } from "node:fs";

export interface QueenLlmConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Extra JSON fields merged into each request (provider options); a null drops a field */
  extraBody: Record<string, unknown>;
  /** Output tokens for the answer itself; the JSON reply around it gets JSON_REPLY_TOKENS more (brain.ts) */
  maxTokens: number;
  /** Reasoning before the answer: off | low | high | max (LLM_THINKING, default high) */
  thinking: "off" | "low" | "high" | "max";
  /** Extra max_tokens for the reasoning when thinking is on (LLM_REASONING_TOKENS, default 2000) */
  reasoningTokens: number;
  temperature: number;
  /** Time for one model call, retries included */
  timeoutMs: number;
}

export interface HarnessConfig {
  llm: QueenLlmConfig;
  /** The whole answer's time, calls and the write included (HARNESS_ANSWER_MS, 240000) */
  answerMs: number;
  /** An OpenRouter key for Jev, the intent model read where code's regexes are unsure (JEV_KEY; none = code's read only) */
  jevKey: string | null;
  /** The token the harness speaks for (OWN_MINT): a scan of it says it is hers, and the self kind reads the about text */
  ownMint: string | null;
  /** What the harness says about itself, trusted (ABOUT_FILE: a text file; none = no about block) */
  about: string | null;
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Provider options for reasoning: OpenRouter's `reasoning`, DeepSeek's `thinking`, nothing for any other host */
function reasoningBody(baseUrl: string, thinking: QueenLlmConfig["thinking"]): Record<string, unknown> {
  const host = baseUrl.toLowerCase();
  if (host.includes("openrouter.ai")) return thinking === "off" ? { reasoning: { enabled: false } } : { reasoning: { effort: thinking === "max" ? "high" : thinking } };
  if (host.includes("api.deepseek.com")) return thinking === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: thinking };
  return {};
}

export function loadLlmConfig(env: NodeJS.ProcessEnv): QueenLlmConfig {
  const baseUrl = (env.LLM_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const raw = (env.LLM_THINKING ?? "").trim().toLowerCase();
  const thinking: QueenLlmConfig["thinking"] = raw === "off" || raw === "low" || raw === "max" ? raw : "high";
  const extraBody = reasoningBody(baseUrl, thinking);
  const rawExtra = env.LLM_EXTRA_BODY?.trim();
  if (rawExtra) {
    try {
      const parsed = JSON.parse(rawExtra) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(extraBody, parsed);
    } catch {
      // a typo here never silences the harness
    }
  }
  return {
    baseUrl,
    apiKey: env.LLM_API_KEY?.trim() || null,
    model: env.LLM_MODEL?.trim() || "",
    extraBody,
    maxTokens: Math.max(32, Math.floor(num(env.LLM_MAX_TOKENS, 4500))),
    thinking,
    reasoningTokens: Math.max(0, Math.floor(num(env.LLM_REASONING_TOKENS, 2000))),
    temperature: num(env.LLM_TEMPERATURE, 0.6),
    timeoutMs: Math.max(1000, num(env.LLM_TIMEOUT_MS, 180_000)),
  };
}

export function loadHarnessConfig(env: NodeJS.ProcessEnv): HarnessConfig {
  const aboutFile = env.ABOUT_FILE?.trim();
  let about: string | null = null;
  if (aboutFile) {
    try {
      about = readFileSync(aboutFile, "utf8").trim() || null;
    } catch {
      about = null;
    }
  }
  const mint = env.OWN_MINT?.trim() ?? "";
  return {
    llm: loadLlmConfig(env),
    answerMs: Math.max(30_000, num(env.HARNESS_ANSWER_MS, 240_000)),
    jevKey: env.JEV_KEY?.trim() || null,
    ownMint: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? mint : null,
    about,
  };
}
