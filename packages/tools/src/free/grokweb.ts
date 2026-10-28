// The web search on Grok: news_pages answered by xAI's Grok through OpenRouter with its own web search (the web
// plugin's native engine and no x_search: web pages only; the X search's key, free/grokx.ts).
//   - asked: the query, how many results, a topic; Grok answers JSON, a short summary and
//     the pages it read (url, title, snippet, date);
//   - kept: only pages whose URL its own search cited (the answer's url_citation annotations), never a link it made up,
//     each once, linked as the citation has it (tracking parameters and the fragment dropped: links.ts webPageUrl); an
//     answer that is not the JSON asked for, or lists no cited page, keeps the cited pages themselves (their own title
//     and text); "nothing found", or no citation at all, is not_found. No text keeps a link: only the pages kept are
//     linked;
//   - one attempt a call, never sent twice (OpenRouter's host is never hedged: registry.ts XSEARCH_HEDGE), at most
//     TOOLS_NEWS_DAILY_CALLS a UTC day (tools_usage.news_calls), NEWS_PER_MIN a minute. The result: its results (title,
//     link, snippet, date) and a summary; the links are its sources (web pages,
//     kept as found: ToolDef.webSources).

import { src, uniqueSources, webPageUrl } from "../links.ts";
import type { DailyCounter, WindowLimiter } from "../limits.ts";
import { cleanText } from "../sanitize.ts";
import { DAY, MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, take, type FreeContext } from "./common.ts";
import { answerJson, type XSearchConfig } from "./grokx.ts";

/** Web searches a minute at most, every caller together */
export const NEWS_PER_MIN = 20;
/** Results a search gives: range and default */
const RESULTS_MIN = 3;
const RESULTS_MAX = 20;
const RESULTS_DEFAULT = 6;
/** Characters kept of a title, a snippet, the summary (Grok writes them token by token: their length is the call's time) */
const TITLE_MAX = 160;
const SNIPPET_MAX = 200;
const SUMMARY_MAX = 600;
/** A page dated before this is no date at all */
const OLDEST_DATE = Date.UTC(1990, 0, 1);

/** The web search's settings (config.ts): the X search's key and endpoint, its own model and calls a day */
export type NewsSearchConfig = XSearchConfig;

/** What each topic asks of the search */
const TOPICS: Record<string, string> = {
  general: "any page: news, the project's own site and docs, blogs, forums",
  news: "news articles and reports, the newest first",
  crypto: "crypto news sites and the projects' own sites, blogs, docs and announcements",
  finance: "financial and market news",
};

const system = (n: number) => `you search the web with your web search tool and report only pages that search returned.
answer json only: {"summary":"<what the pages say about the query, at most 3 short sentences>","results":[{"url":"<the page's url exactly as your search returned it>","title":"<the page's title>","snippet":"<what the page says about the query, at most ${SNIPPET_MAX} characters>","date":"<YYYY-MM-DD the page was published, or null>"}]}
at most ${n} results, the most relevant first. never invent a page, a link, a date or a number: null when you do not know it. none found: {"summary":"","results":[]}`;

/** A page its search cited: its link (cleaned), its own title and text when the citation carries them */
export interface Cited {
  link: string;
  title: string | null;
  text: string | null;
}

/** One result as the model reads it */
export interface Page {
  title: string;
  link: string;
  snippet: string | null;
  date: string | null;
}

/** Text as the model reads it: no link (only the pages kept are linked) and no inline citation mark, plain, capped; null for none */
function plain(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    // Grok's inline citations ([[1]](https://…)), a markdown link's target, a bare link (the sentence's own stop kept)
    .replace(/\[\[\d+\]\]\([^)\s]*\)/g, " ")
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)\s]*\)/gi, "$1")
    .replace(/(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi, (m) => ` ${/[.,;:!?]+$/.exec(m)?.[0] ?? ""}`)
    .replace(/[ \t]+([.,;:!?])/g, "$1");
  return cleanText(s, max) ?? null;
}

/**
 * A page's URL as it is compared with the citations: the host without www., the path decoded and without a trailing slash,
 * the query sorted (tracking parameters and the fragment dropped, http and https alike); null for a URL that is no web page
 */
export function pageKey(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const t = u.trim();
  const clean = webPageUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  if (!clean) return null;
  const url = new URL(clean);
  let path = url.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // a path that does not decode is compared as it is
  }
  url.searchParams.sort();
  const q = url.searchParams.toString();
  return `${url.hostname.replace(/^www\./, "")}${path.replace(/\/+$/, "")}${q ? `?${q}` : ""}`;
}

/** The pages Grok's search cited (its url annotations), by pageKey; null when it gave no annotations at all */
export function citedPages(message: unknown): Map<string, Cited> | null {
  if (!isObj(message) || !Array.isArray(message.annotations)) return null;
  const out = new Map<string, Cited>();
  for (const a of message.annotations) {
    const c = isObj(a) && isObj(a.url_citation) ? a.url_citation : isObj(a) ? a : null;
    const link = c ? webPageUrl(c.url) : null;
    const key = link ? pageKey(link) : null;
    if (!c || !link || !key || out.has(key)) continue;
    out.set(key, { link, title: plain(c.title, TITLE_MAX), text: plain(c.content, SNIPPET_MAX) });
  }
  return out;
}

/** A page's date as YYYY-MM-DD when it reads as one, no later than a day from now; else null */
export function dateOf(v: unknown, now: number): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isNaN(t) || t > now + DAY || t < OLDEST_DATE ? null : new Date(t).toISOString().slice(0, 10);
}

const hostOf = (link: string): string => new URL(link).hostname.replace(/^www\./, "");
/** A citation's own title, when it is one: not a bare number, a link or the page's host */
const ownTitle = (c: Cited): string | null => (c.title && !/^\[?\d+\]?$/.test(c.title) && c.title.toLowerCase().replace(/^www\./, "") !== hostOf(c.link) ? c.title : null);

/**
 * Grok's results that its search cited, at most `max`, each once, linked as the citation has it (its own title first); the
 * cited pages themselves when its answer lists none of them (not the JSON asked for, or no listed link cited); none when it
 * gave no citation at all or said it found nothing
 */
export function pagesOf(answer: Record<string, unknown> | null, cited: Map<string, Cited> | null, max: number, now: number): Page[] {
  if (!cited || cited.size === 0) return [];
  const listed = answer ? (Array.isArray(answer.results) ? answer.results : Array.isArray(answer.pages) ? answer.pages : null) : null;
  // nothing found: the pages it cited are pages it read and left out
  if (listed && listed.length === 0) return [];
  const out: Page[] = [];
  const seen = new Set<string>();
  for (const r of (listed ?? []).filter(isObj)) {
    if (out.length >= max) break;
    const key = pageKey(r.url ?? r.link);
    const c = key ? cited.get(key) : undefined;
    if (!key || !c || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: ownTitle(c) ?? plain(r.title, TITLE_MAX) ?? hostOf(c.link), link: c.link, snippet: plain(r.snippet, SNIPPET_MAX) ?? c.text, date: dateOf(r.date, now) });
  }
  if (out.length > 0) return out;
  return [...cited.values()].slice(0, max).map((c) => ({ title: ownTitle(c) ?? hostOf(c.link), link: c.link, snippet: c.text, date: null }));
}

export function grokWebTools(fc: FreeContext & { limit: { news: WindowLimiter } }, cfg: NewsSearchConfig, daily: DailyCounter): ToolDef[] {
  const search: ToolDef = {
    name: "news_pages",
    slow: true,
    webSources: true,
    description:
      "Web search for recent crypto news and pages: title, link, snippet and date of each result, and a short summary of what they say. Ask with a few distinctive words (a project's name, the claim), not exact numbers in quotes, addresses or site: filters. Results are leads to read, not verified facts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'What to search the web for: a project, a token, an event, a claim to check; "exact phrase" allowed', minLength: 2, maxLength: 300 },
        max_results: { type: "integer", description: `How many results to return (${RESULTS_MIN}-${RESULTS_MAX}, default ${RESULTS_DEFAULT})`, minimum: RESULTS_MIN, maximum: RESULTS_MAX, default: RESULTS_DEFAULT },
        topic: {
          type: "string",
          description: "What kind of pages: general (any page), news (news articles, the newest first), crypto (crypto news sites and the projects' own sites, blogs and docs) or finance (market and finance news)",
          enum: Object.keys(TOPICS),
          default: "general",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const query = String(args.query).replace(/\s+/g, " ").trim();
      const n = Math.min(RESULTS_MAX, Math.max(RESULTS_MIN, Math.trunc(Number(args.max_results ?? RESULTS_DEFAULT)) || RESULTS_DEFAULT));
      const kind = TOPICS[String(args.topic)] ?? TOPICS.general!;
      take(fc.limit.news);
      if (!daily.take()) throw new ToolFail("rate_limited");
      const ask = `web pages about: ${query}\nwhat kind: ${kind}; at most ${n} results; today is ${new Date(fc.now()).toISOString().slice(0, 10)}.`;
      const raw = await fc.http.json(`${cfg.baseUrl}/chat/completions`, {
        signal,
        maxBytes: 2 * 1024 * 1024,
        headers: { authorization: `Bearer ${cfg.key}`, "x-title": "queen-harness" },
        body: {
          model: cfg.model,
          temperature: 0,
          max_tokens: 4000,
          response_format: { type: "json_object" },
          // the native engine is Grok's own web search; no x_search: web pages only
          plugins: [{ id: "web", engine: "native", max_results: n }],
          messages: [
            { role: "system", content: system(n) },
            { role: "user", content: ask },
          ],
        },
      });
      const message = isObj(raw) && Array.isArray(raw.choices) && isObj(raw.choices[0]) ? raw.choices[0].message : null;
      if (!isObj(message)) throw new ToolFail("unavailable");
      const answer = answerJson(message.content);
      const results = pagesOf(answer, citedPages(message), n, fc.now());
      // a query of exact numbers in quotes, an address or a site: filter finds nothing; the message says how to ask
      // again
      if (results.length === 0) return { ok: false, error: "not_found", message: "no page found: search again once with a few distinctive words (the project's name, the claim), without exact numbers in quotes, addresses or site: filters" };
      // its summary; an answer in prose (not the JSON asked for) is its own summary
      const summary = answer ? plain(answer.summary, SUMMARY_MAX) : typeof message.content === "string" && !/^\s*(?:```|\{)/.test(message.content) ? plain(message.content, SUMMARY_MAX) : null;
      return {
        ok: true,
        data: { ...(summary ? { summary } : {}), results },
        sources: uniqueSources(results.map((p) => src(p.title, p.link)), results.length),
      };
    },
  };
  return [search];
}
