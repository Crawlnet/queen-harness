// The services' LLM: any OpenAI-compatible chat completions API, the harness's own settings (LLM_BASE_URL, LLM_API_KEY,
// LLM_MODEL), read from the environment or the service's .env. Two calls:
// llmJson({ system, prompt, schema, effort }) → the parsed object, llmText({ system, prompt, effort }) → the text. A prompt
// of content blocks (pictures) goes as its text parts only. A 429 or a 5xx is tried again, up to TRIES times.
// services/llm.mjs is the one source; each service's src/llm.mjs is an identical copy.
import fs from 'fs';

const envText = (() => { try { return fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return ''; } })();
const get = (k) => process.env[k] ?? envText.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();

const TRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const backend = () => 'api';
export const llmStats = { calls: 0, errors: 0, busy: 0, lastError: '' };

const textOf = (prompt) =>
  Array.isArray(prompt) ? prompt.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n\n') : String(prompt ?? '');

async function ask({ system, prompt, schema, effort, timeoutMs }) {
  const key = get('LLM_API_KEY');
  const model = get('LLM_MODEL');
  if (!key || !model) throw Error('llm: LLM_API_KEY and LLM_MODEL are not set');
  const base = (get('LLM_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const instructions = String(system || 'You are a careful analyst.');
  const body = {
    model,
    messages: [
      { role: 'system', content: schema ? `${instructions}\n\nReply with one JSON object that matches this JSON schema, and nothing else:\n${JSON.stringify(schema)}` : instructions },
      { role: 'user', content: textOf(prompt) },
    ],
    ...(schema ? { response_format: { type: 'json_object' } } : {}),
    ...(base.includes('openrouter.ai') ? { reasoning: { effort: ['low', 'medium', 'high'].includes(effort) ? effort : 'low' } } : {}),
  };
  for (let i = 0; ; i++) {
    llmStats.calls++;
    let res, j;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(900_000, Math.max(20_000, timeoutMs))),
      });
      j = await res.json().catch(() => null);
    } catch (e) {
      llmStats.errors++;
      llmStats.lastError = String(e?.message || e).slice(0, 300);
      throw Error(`llm: ${llmStats.lastError}`);
    }
    const text = j?.choices?.[0]?.message?.content;
    if (res.ok && typeof text === 'string') return text;
    if ((res.status === 429 || res.status >= 500) && i < TRIES - 1) {
      llmStats.busy++;
      await sleep(2_000 * 2 ** i);
      continue;
    }
    llmStats.errors++;
    llmStats.lastError = String(j?.error?.message || `http ${res.status}`).slice(0, 300);
    throw Error(`llm: ${llmStats.lastError}`);
  }
}

export async function llmJson({ system, prompt, schema, effort = 'low', timeoutMs = 300_000 }) {
  const text = await ask({ system, prompt, schema: schema || { type: 'object', properties: {} }, effort, timeoutMs });
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw Error('llm: the reply is not JSON');
  }
}

export async function llmText({ system, prompt, effort = 'high', timeoutMs = 900_000 }) {
  return ask({ system, prompt, schema: null, effort, timeoutMs });
}
