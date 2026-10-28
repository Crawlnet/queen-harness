// The redaction guard. The terms are never in the code: they come from the environment (TOOLS_REDACT_TERMS, a comma
// list, empty by default).
// Applied to every tool output and offered to the chat brain for its final answers and the sources
// under them.
//
// Matching runs on a folded copy of the text: compatibility forms folded (full-width, ligatures, styled
// letters), zero-width and other format characters and accents dropped, lower case, look-alike letters of
// other scripts read as the Latin letter they imitate. A term also matches when its words are joined by
// other separators (spaces, dots, underscores, hyphens: "a.b" also as "a-b", "a_b", "ab"; "a b" also as
// "a-b-…" slugs), and a one-word term of 5+ characters also with separators slipped inside it ("ab-cde",
// "AB CDE"). What is removed is the whole word or link of the original text around a match.

import type { ToolSource } from "@crawlnet/shared";

export interface Redactor {
  /** Folded, longest first */
  readonly terms: readonly string[];
  /** Text with every word or link holding a term removed (or replaced by `replacement`) */
  text(s: string, replacement?: string): string;
  /** Does the text hold a term (any case, look-alike letters, separators)? */
  blocked(s: string): boolean;
  /** A deep copy with every string redacted; url/link fields that held a term become null; keys holding one go */
  deep<T>(v: T): T;
  /** Sources without the ones whose title or URL holds a term */
  sources(list: ToolSource[]): ToolSource[];
}

// ───────────────────────────── folding

/** Look-alike letters of other scripts (after lower-casing), read as the Latin letter they imitate */
const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0442": "t", "\u0443": "y", "\u0445": "x",
  "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04cf": "l", "\u04bb": "h", "\u051b": "q", "\u051d": "w", "\u04af": "y",
  // Greek
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ϲ": "c",
  // Latin letters NFKD leaves alone
  "ı": "i", "ɡ": "g", "ł": "l", "ø": "o", "đ": "d", "ħ": "h",
};
const FORMAT_CHAR = /^\p{Cf}$/u;
const MARKS = /\p{M}/gu;
const ASCII_ONLY = /^[\x00-\x7f]*$/;
const foldCache = new Map<string, string>();

function foldChar(ch: string): string {
  const hit = foldCache.get(ch);
  if (hit !== undefined) return hit;
  let v = "";
  if (!FORMAT_CHAR.test(ch)) {
    for (const c of ch.normalize("NFKD").toLowerCase().normalize("NFKD").replace(MARKS, "")) v += CONFUSABLE[c] ?? c;
  }
  if (foldCache.size < 20_000) foldCache.set(ch, v);
  return v;
}

/** A folded copy of a text and, for each of its UTF-16 units, the span of the original it came from */
interface Folded {
  s: string;
  /** null: the copy is the original lower-cased unit for unit (ASCII) */
  from: number[] | null;
  to: number[] | null;
}

function fold(text: string): Folded {
  if (ASCII_ONLY.test(text)) return { s: text.toLowerCase(), from: null, to: null };
  let s = "";
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const next = i + ch.length;
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) {
      from.push(i);
      to.push(next);
    }
    s += f;
    i = next;
  }
  return { s, from, to };
}

const SEPS = "[\\s._\\-]+";
const EDGE_SEPS = /^[\s._\-]+|[\s._\-]+$/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const foldTerm = (t: string) => fold(t.trim()).s.replace(EDGE_SEPS, "");

// ───────────────────────────── terms from env

/** Words never removed although they hold a term (TOOLS_REDACT_KEEP: ordinary words that happen to contain one) */
export function redactionKeep(env: NodeJS.ProcessEnv): string[] {
  return (env.TOOLS_REDACT_KEEP ?? "")
    .split(",")
    .map(foldTerm)
    .filter(Boolean);
}

/** The TOOLS_REDACT_TERMS list (folded, 3+ characters) */
export function configuredTerms(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const t of (env.TOOLS_REDACT_TERMS ?? "").split(",")) {
    const v = foldTerm(t);
    if (v.length >= 3) out.add(v);
  }
  return [...out];
}

/** The redaction terms, longest first */
export function redactionTerms(env: NodeJS.ProcessEnv): string[] {
  return configuredTerms(env).sort((a, b) => b.length - a.length);
}

// ───────────────────────────── matching

/** A variant form only matches from a word's start */
const WORD_START = "(?<![\\p{L}\\p{N}])";
const DIGIT_END = /\p{N}$/u;
const DIGIT_START = /^\p{N}/u;

/**
 * The pattern of one folded term: the term itself anywhere (inside longer words too) or a variant form. A
 * one-word term of 5+ characters may have a separator (a space, a mark or both) between any two of its
 * letters, anywhere. A term of several words matches its variants from a word's start only: words joined
 * by a space may be joined by any separators or none; words joined by a dot, underscore or hyphen by other
 * such marks or none, but not by spaces alone ("a.b" is an identifier, "a b" may be ordinary words); next
 * to a digit a separator stays required.
 */
function termPattern(term: string): string | null {
  const t = term.replace(EDGE_SEPS, "");
  if (t.length < 3) return null;
  const parts = t.split(new RegExp(`(${SEPS})`));
  const words = parts.filter((_, i) => i % 2 === 0);
  const gaps = parts.filter((_, i) => i % 2 === 1);
  if (words.length === 1) {
    // inside longer words too ("AskAb-cde"): it takes 5+ letters in order with only separators between
    const chars = [...t];
    return chars.length >= 5 ? `${escapeRe(t)}|${chars.map(escapeRe).join("(?:\\s?[._\\-]?\\s?)")}` : escapeRe(t);
  }
  let variant = escapeRe(words[0]!);
  for (let i = 0; i < gaps.length; i++) {
    const digit = DIGIT_END.test(words[i]!) || DIGIT_START.test(words[i + 1]!);
    const gap = /\s/.test(gaps[i]!) ? (digit ? "[\\s._\\-]+" : "[\\s._\\-]*") : digit ? "\\s*[._\\-]+\\s*" : "(?:\\s*[._\\-]+\\s*)?";
    variant += gap + escapeRe(words[i + 1]!);
  }
  return `${escapeRe(t)}|${WORD_START}(?:${variant})`;
}

/** Folded text with every whole TOOLS_REDACT_KEEP word blanked out (same length, so positions still map back) */
function keepBlanker(keepWords: readonly string[]): (s: string) => string {
  const words = [...new Set(keepWords.map(foldTerm).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return (s) => s;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  return (s) => s.replace(re, (x) => "\u0000".repeat(x.length));
}

/**
 * The numbers (1-based, in the order given, never the text) of the terms a text holds outside the kept
 * words, matched as the guard matches. For scans of files and history.
 */
export function termHits(text: string, terms: readonly string[], keepWords: readonly string[] = []): number[] {
  const folded = keepBlanker(keepWords)(fold(text).s);
  const out: number[] = [];
  terms.forEach((t, i) => {
    const p = termPattern(foldTerm(t));
    if (p && new RegExp(p, "u").test(folded)) out.push(i + 1);
  });
  return out;
}

function compile(terms: readonly string[], keepWords: readonly string[]) {
  const list = [...new Set(terms.map(foldTerm).filter((t) => t.length >= 3))].sort((a, b) => b.length - a.length);
  const source = list
    .map(termPattern)
    .filter((p): p is string => !!p)
    .map((p) => `(?:${p})`)
    .join("|");
  return { list, any: source ? new RegExp(source, "u") : null, all: source ? new RegExp(source, "gu") : null, blank: keepBlanker(keepWords) };
}

const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/giu;
const WORD_CHAR = /^[\p{L}\p{N}\p{M}\p{Cf}_\-]$/u;
const ALNUM = /^[\p{L}\p{N}]$/u;

const cpAt = (s: string, i: number): string => (i >= 0 && i < s.length ? String.fromCodePoint(s.codePointAt(i)!) : "");
function cpBefore(s: string, i: number): string {
  if (i <= 0) return "";
  const lo = s.charCodeAt(i - 1);
  if (i >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1]!;
}

/** The whole word around [a, b): letters, digits, marks, format characters, _ and -, and a dot inside a word */
function wordAround(s: string, a: number, b: number): [number, number] {
  for (;;) {
    const ch = cpBefore(s, a);
    if (ch && (WORD_CHAR.test(ch) || (ch === "." && ALNUM.test(cpAt(s, a))))) a -= ch.length;
    else break;
  }
  for (;;) {
    const ch = cpAt(s, b);
    if (ch && (WORD_CHAR.test(ch) || (ch === "." && ALNUM.test(cpAt(s, b + 1))))) b += ch.length;
    else break;
  }
  return [a, b];
}

export function createRedactor(terms: string[], keepWords: string[] = []): Redactor {
  const m = compile([...terms], keepWords);

  const blocked = (s: string): boolean => (m.any && typeof s === "string" && s ? m.any.test(m.blank(fold(s).s)) : false);

  /** The text without every word that holds a term (each one replaced by `put`) */
  const cutWords = (s: string, put = ""): string => {
    if (!m.all) return s;
    const f = fold(s);
    const spans: [number, number][] = [];
    for (const hit of m.blank(f.s).matchAll(m.all)) {
      if (!hit[0].length) continue;
      const i = hit.index;
      const j = i + hit[0].length - 1;
      spans.push(wordAround(s, f.from ? f.from[i]! : i, f.to ? f.to[j]! : j + 1));
    }
    if (!spans.length) return s;
    spans.sort((x, y) => x[0] - y[0]);
    let out = "";
    let at = 0;
    for (const [a, b] of spans) {
      if (b <= at) continue;
      out += s.slice(at, Math.max(at, a)) + (a >= at ? put : "");
      at = b;
    }
    return out + s.slice(at);
  };

  const text = (s: string, replacement = ""): string => {
    if (typeof s !== "string" || !blocked(s)) return s;
    let out = cutWords(s.replace(LINK_RE, (x) => (blocked(x) ? replacement : x)), replacement);
    // one replacement for a run of removed words ("the data service the data service")
    if (replacement) out = out.replace(new RegExp(`(?:${escapeRe(replacement)}[\\s.,_\\-/]*){2,}`, "g"), `${replacement} `);
    return out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").replace(/\(\s*\)/g, "").trim();
  };

  const linkKey = (k: string) => /^(url|link|href)$/i.test(k);
  const linkBlocked = (x: unknown): boolean =>
    !!x && typeof x === "object" && !Array.isArray(x) && Object.entries(x as Record<string, unknown>).some(([k, s]) => linkKey(k) && typeof s === "string" && blocked(s));
  function walk(v: unknown, key: string | null): unknown {
    if (typeof v === "string") {
      if (key !== null && linkKey(key) && blocked(v)) return null;
      return text(v);
    }
    // a record whose own link holds a term goes as a whole (a search result on a redacted host)
    if (Array.isArray(v)) return v.filter((x) => !linkBlocked(x)).map((x) => walk(x, null));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!blocked(k)) o[k] = walk(x, k);
      return o;
    }
    return v;
  }

  return {
    get terms() {
      return m.list;
    },
    text,
    blocked,
    deep: <T>(v: T): T => walk(v, null) as T,
    sources: (src) => src.filter((s) => s && typeof s.url === "string" && !blocked(s.url) && !blocked(s.title ?? "")),
  };
}
