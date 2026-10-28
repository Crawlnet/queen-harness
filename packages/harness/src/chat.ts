// The chat's own text: a question and the chat so far as the harness takes them (control characters out, within the
// limits, earlier answers' visual blocks collapsed to a line), and the guard's pass that keeps the blocks code filled.

import { QUEEN_CHAT_FILES_MAX, QUEEN_CHAT_HISTORY_CHARS_MAX, QUEEN_CHAT_HISTORY_MAX, QUEEN_CHAT_QUESTION_MAX, QUEEN_CHAT_TURN_MAX, type QueenChatTurn } from "@crawlnet/shared";

/** The chat so far and its text attachments, as the harness takes them */
export interface ChatContext {
  history: QueenChatTurn[];
  texts: { name: string; text: string }[];
}

const CHAT_CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;
/** A chat text: control characters out, line ends kept and unified, runs of blank lines cut to one. */
function cleanChatText(q: string): string {
  return q
    .replace(/\r\n?/g, "\n")
    .replace(CHAT_CTRL, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A chat question: control characters out, line ends kept, at most QUEEN_CHAT_QUESTION_MAX. */
export function sanitizeChatQuestion(q: unknown): string {
  return typeof q === "string" ? cleanChatText(q).slice(0, QUEEN_CHAT_QUESTION_MAX) : "";
}

/** The fenced blocks an answer carries for a UI to draw (harness.ts BLOCKS): JSON an earlier answer carried. */
const VISUAL_BLOCK = /(?:```|~~~)[ \t]*(flow|chart|posts|token|wallet|clusters|timeline|odds)[^\n]*\n([\s\S]*?)(?:```|~~~|$)/gi;
/** A whole Solana or EVM address in a block (an explorer link's too); a transaction id is longer and stays out. */
const BLOCK_ADDRESS = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])|(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
/** Addresses one collapsed block keeps at most. */
const BLOCK_ADDRESSES_MAX = 6;

/** What a visual block's JSON holds, in a few words: its parts by kind ("12 addresses, 14 flows"), or "". */
function visualSize(kind: string, j: Record<string, unknown>): string {
  const n = (k: string): number => (Array.isArray(j[k]) ? (j[k] as unknown[]).length : 0);
  switch (kind) {
    case "flow":
      return `${n("nodes")} addresses, ${n("edges")} flows`;
    case "chart":
      return Array.isArray(j.items) ? `${n("items")} parts` : `${n("series")} series`;
    case "clusters":
      return `${n("nodes")} holders and funders, ${n("links")} links`;
    case "posts":
      return `${n("posts")} posts`;
    case "timeline":
      return `${n("events")} events`;
    case "odds":
      return `${n("outcomes")} outcomes`;
    case "wallet":
      return `${n("holdings")} holdings`;
    default:
      return "";
  }
}

/**
 * An earlier answer's visual blocks (every kind: JSON a UI drew) as one line each in the conversation:
 * their title, size and the whole addresses they showed (a flow's sit only in its nodes' links), so a follow-up ("trace
 * the dev wallet") knows what was shown without the JSON taking the context.
 */
function withoutVisuals(text: string): string {
  return text.replace(VISUAL_BLOCK, (_m, as: string, body: string) => {
    const kind = as.toLowerCase();
    let title = "";
    let size = "";
    try {
      const j = JSON.parse(body) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) {
        const o = j as Record<string, unknown>;
        const name = [o.title, o.question, o.symbol, o.label].find((v): v is string => typeof v === "string" && v.trim() !== "");
        title = name ? ` "${name.slice(0, 80)}"` : "";
        size = visualSize(kind, o);
      }
    } catch {
      // as it was shown: a block that did not read
    }
    const addresses = [...new Set(body.match(BLOCK_ADDRESS) ?? [])].slice(0, BLOCK_ADDRESSES_MAX);
    return `(${kind === "odds" ? "an" : "a"} ${kind} block was shown here${title}${size ? `, ${size}` : ""}${addresses.length ? `; addresses: ${addresses.map((a) => `\`${a}\``).join(", ")}` : ""})`;
  });
}

const keptMark = (i: number): string => `K${i}`;
/**
 * The answer through the guard (`redact`) with the blocks code filled (`keep`: the holder map) set aside and put back
 * as filled: each was checked against the guard as it was filled. A block whose place the guard took (or that the
 * answer no longer holds) is gone; the model's own text never comes back.
 */
export function redactKeeping(text: string, keep: Iterable<string>, redact: (s: string) => string): string {
  let swapped = text.replace(/[]/g, "");
  const blocks = [...new Set(keep)].filter((b) => b && !/[]/.test(b) && swapped.includes(b));
  if (blocks.length === 0) return redact(text);
  blocks.forEach((b, i) => {
    swapped = swapped.split(b).join(keptMark(i));
  });
  let out = redact(swapped);
  blocks.forEach((b, i) => {
    out = out.split(keptMark(i)).join(b);
  });
  return out.replace(/K\d+|[]/g, "");
}

/**
 * The chat's context: only its own fields, within the QUEEN_CHAT_* limits (the oldest turns dropped first), strings
 * only. Its text stays untrusted (the brain fences it). A turn's visual blocks are collapsed before it is cut to
 * QUEEN_CHAT_TURN_MAX, so a caller can hand a stored chat's turns over whole.
 */
export function sanitizeChat(v: unknown): ChatContext {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof ChatContext, unknown>>;
  const turns = (Array.isArray(o.history) ? o.history : [])
    .filter((t): t is { role: unknown; content: unknown } => !!t && typeof t === "object")
    .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .map((t) => ({ role: t.role as "user" | "assistant", content: withoutVisuals(cleanChatText(t.content as string)).slice(0, QUEEN_CHAT_TURN_MAX) }))
    .filter((t) => t.content.length > 0);
  const kept: ChatContext["history"] = [];
  let total = 0;
  for (const t of turns.slice(-QUEEN_CHAT_HISTORY_MAX).reverse()) {
    if (total + t.content.length > QUEEN_CHAT_HISTORY_CHARS_MAX) break;
    total += t.content.length;
    kept.unshift(t);
  }
  const name = (n: unknown) => (typeof n === "string" ? n.replace(CHAT_CTRL, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "") || "file";
  const texts = (Array.isArray(o.texts) ? o.texts : [])
    .filter((t): t is { name: unknown; text: unknown } => !!t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string")
    .slice(0, QUEEN_CHAT_FILES_MAX)
    .map((t) => ({ name: name(t.name), text: (t.text as string).replace(CHAT_CTRL, " ").slice(0, 60_000) }));
  return { history: kept, texts };
}

