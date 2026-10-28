// The brain's "think first" switch in each provider's own words: DeepSeek's chat API takes `thinking: {type}` (and
// `reasoning_effort`), OpenRouter takes `reasoning: {effort}` or `reasoning: {enabled: false}` (config.ts loadLlmConfig
// writes them). No imports, so any module can read it.

/** Whether provider options ask the model to think first: DeepSeek's `thinking: {type: "enabled"}`, OpenRouter's `reasoning` (not `enabled: false`). */
export function thinksIn(extraBody: Record<string, unknown>): boolean {
  if ((extraBody.thinking as { type?: string } | null | undefined)?.type === "enabled") return true;
  const r = extraBody.reasoning as { enabled?: boolean; effort?: string } | null | undefined;
  return !!r && typeof r === "object" && r.enabled !== false && r.effort !== "none";
}

/** The same provider options with thinking off (OpenRouter: `reasoning: {enabled: false}`). */
export function withoutThinkingBody(extraBody: Record<string, unknown>): Record<string, unknown> {
  if (extraBody.reasoning !== undefined && extraBody.reasoning !== null) return { ...extraBody, reasoning: { enabled: false } };
  return { ...extraBody, thinking: { type: "disabled" }, reasoning_effort: null };
}
