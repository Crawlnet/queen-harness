// The X search on Grok: social_mentions answered by xAI's Grok through OpenRouter with its own X search (the web
// plugin's x_search; TOOLS_XSEARCH_KEY, else the harness's own key when it is OpenRouter's). X is read through that
// search only, never crawled.
//   - asked: the query without its since:/until: words (they become the search's dates, a week back when none), the
//     sort, the likes and followers floors; Grok answers JSON, the posts it read;
//   - kept: only posts whose link Grok's own search cited (never one it made up), within the floors, one of each, no
//     giveaway, airdrop bait or other token's promo (xposts.ts keepPosts), the most liked first (Top) or the newest
//     (Latest);
//   - one attempt a call, never sent twice, at most TOOLS_XSEARCH_DAILY_CALLS a UTC day (tools_usage), XSEARCH_PER_MIN
//     a minute. The result is a table of handle, followers, text, likes, views (and at, link).

import { parsePostUrl, src, uniqueSources, xPost } from "../links.ts";
import { DailyCounter, type WindowLimiter } from "../limits.ts";
import { cashtags, dayBefore, keepPosts, NO_POSTS_NOTE } from "./xposts.ts";
import { MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, str, take, type FreeContext } from "./common.ts";

export const OPENROUTER_HOST = "openrouter.ai";
/** X searches a minute at most, every caller together */
export const XSEARCH_PER_MIN = 20;
/**
 * Posts asked of Grok at most, and a post's text kept (characters): Grok's answer is written token by token, so its
 * length is the call's time (its reasoning effort changed nothing)
 */
const POSTS_MAX = 10;
const TEXT_MAX = 200;

export interface XSearchConfig {
  key: string;
  model: string;
  /** The chat completions endpoint's base, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  dailyCalls: number;
}

const SYSTEM = `you search x (twitter) with your x search tool and report only posts that search returned. never use web search.
answer json only: {"posts":[{"url":"https://x.com/<handle>/status/<id>","handle":"<handle without @>","followers":<number or null>,"text":"<the post as written, at most ${TEXT_MAX} characters>","likes":<number or null>,"views":<number or null>,"at":"<YYYY-MM-DDTHH:MM:SSZ or null>"}]}
at most ${POSTS_MAX} posts. never invent a post, a link or a number: null when you do not know it. none found: {"posts":[]}`;

/** The query's own dates (since:/until:) and the words left */
export function splitDates(query: string, now: number): { words: string; from: string; to: string | null } {
  const since = /\bsince:(\d{4}-\d{2}-\d{2})\b/i.exec(query)?.[1] ?? null;
  const until = /\buntil:(\d{4}-\d{2}-\d{2})\b/i.exec(query)?.[1] ?? null;
  const words = query.replace(/\b(?:since|until):\S+/gi, " ").replace(/\s+/g, " ").trim();
  return { words, from: since ?? dayBefore(now, 7), to: until };
}

/** The post ids Grok's search cited (its url annotations), or null when it gave none at all */
export function citedIds(message: unknown): Set<string> | null {
  if (!isObj(message) || !Array.isArray(message.annotations)) return null;
  const ids = new Set<string>();
  for (const a of message.annotations) {
    const url = isObj(a) && isObj(a.url_citation) ? a.url_citation.url : isObj(a) ? a.url : null;
    const p = typeof url === "string" ? parsePostUrl(url) : null;
    if (p) ids.add(p.id);
  }
  return ids;
}

/** The JSON object in Grok's answer (a fence around it allowed), or null (the web search reads it too: grokweb.ts) */
export function answerJson(content: unknown): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  const t = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const at = t.indexOf("{");
  if (at < 0) return null;
  try {
    const v = JSON.parse(t.slice(at, t.lastIndexOf("}") + 1)) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

interface Post {
  handle: string | null;
  followers: number | null;
  text: string;
  likes: number | null;
  views: number | null;
  at: string | null;
  link: string;
  id: string;
}

/** Grok's posts that its search cited, within the floors, as records */
export function postsOf(answer: Record<string, unknown> | null, cited: Set<string> | null, floors: { likes: number; followers: number }): Post[] {
  const raw = answer && Array.isArray(answer.posts) ? answer.posts.filter(isObj) : [];
  const out: Post[] = [];
  for (const p of raw) {
    const u = typeof p.url === "string" ? parsePostUrl(p.url) : null;
    if (!u || !cited || !cited.has(u.id)) continue;
    const handle = str(p.handle, 30)?.replace(/^@/, "") ?? u.handle;
    const text = str(p.text, TEXT_MAX);
    if (!text) continue;
    const likes = num(p.likes);
    const followers = num(p.followers);
    if ((likes !== null && likes < floors.likes) || (followers !== null && followers < floors.followers)) continue;
    const at = typeof p.at === "string" && !Number.isNaN(Date.parse(p.at)) ? new Date(Date.parse(p.at)).toISOString() : null;
    out.push({ handle: handle ?? null, followers, text, likes, views: num(p.views), at, link: xPost(handle ?? u.handle, u.id) ?? `https://x.com/i/status/${u.id}`, id: u.id });
  }
  return out;
}

export function grokXTools(fc: FreeContext & { limit: { xsearch: WindowLimiter } }, cfg: XSearchConfig, daily: DailyCounter): ToolDef[] {
  const search: ToolDef = {
    name: "social_mentions",
    slow: true,
    description:
      "Recent posts on X (Twitter) matching a query: text, author handle, time, likes and views, and the link to each post. Posts are claims by their authors, not verified facts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'What to search on X: words, a $TICKER, a contract address, from:handle, since:YYYY-MM-DD, until:YYYY-MM-DD, "exact phrase"', minLength: 2, maxLength: 300 },
        sort: { type: "string", description: "Top (the most liked first) or Latest (the newest first)", enum: ["Top", "Latest"], default: "Top" },
        min_likes: { type: "integer", description: "Only posts with at least this many likes (0 for any)", minimum: 0, maximum: 100_000, default: 20 },
        min_followers: { type: "integer", description: "Only authors with at least this many followers (0 for any)", minimum: 0, maximum: 10_000_000, default: 0 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    ttlMs: 3 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const query = String(args.query).trim();
      const sort = args.sort === "Latest" ? "Latest" : "Top";
      const floors = { likes: Math.max(0, Number(args.min_likes ?? 20)), followers: Math.max(0, Number(args.min_followers ?? 0)) };
      const { words, from, to } = splitDates(query, fc.now());
      if (words.length < 2) return { ok: false, error: "bad_args", message: "the query needs words to search" };
      take(fc.limit.xsearch);
      if (!daily.take()) throw new ToolFail("rate_limited");
      const ask =
        `posts on x about: ${words}\n` +
        `from ${from}${to ? ` to ${to}` : " to now"}; ${sort === "Top" ? "the most liked first" : "the newest first"}; ` +
        `at least ${floors.likes} likes; authors with at least ${floors.followers} followers.`;
      const raw = await fc.http.json(`${cfg.baseUrl}/chat/completions`, {
        signal,
        maxBytes: 2 * 1024 * 1024,
        headers: { authorization: `Bearer ${cfg.key}`, "x-title": "queen-harness" },
        body: {
          model: cfg.model,
          temperature: 0,
          max_tokens: 2500,
          response_format: { type: "json_object" },
          plugins: [{ id: "web", engine: "native", max_results: 1, x_search: { from_date: from, ...(to ? { to_date: to } : {}) } }],
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: ask },
          ],
        },
      });
      const message = isObj(raw) && Array.isArray(raw.choices) && isObj(raw.choices[0]) ? raw.choices[0].message : null;
      if (!isObj(message)) throw new ToolFail("unavailable");
      const posts = postsOf(answerJson(message.content), citedIds(message), floors);
      const kept = keepPosts(posts as unknown as Record<string, unknown>[], cashtags(words));
      let list = kept.posts as unknown as Post[];
      if (sort === "Latest") list = [...list].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
      if (list.length === 0) return { ok: true, data: { rows: [], ...(kept.spam ? { spam_dropped: kept.spam } : {}), note: NO_POSTS_NOTE }, sources: [] };
      const columns = ["handle", "followers", "text", "likes", "views", "at", "link"];
      return {
        ok: true,
        data: {
          columns,
          rows: list.map((p) => [p.handle, p.followers, p.text, p.likes, p.views, p.at, p.link]),
          rows_shown: list.length,
          ...(kept.spam ? { spam_dropped: kept.spam } : {}),
        },
        sources: uniqueSources(list.map((p) => src(`@${p.handle ?? "post"} on X`, p.link))),
      };
    },
  };
  return [search];
}
