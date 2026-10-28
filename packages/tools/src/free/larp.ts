// The larp check's reads: what a token says it is and where it points, the code behind it, and how old its site really
// is. Facts only: the model weighs them against the coin's launch (a repo made an hour before it, a domain registered
// the same day, a site first seen after it).
//   - project_links: a token's own words and links: pump.fun's coin (its description, x, telegram, website, its
//     creator, when it was made, its "tokenized agent" mark) and DexScreener's profile (websites, socials), with the
//     github links and x handles found in them;
//   - github_repo: a repository's record (or an account's repositories): made and pushed when, its commits counted and
//     its first and newest, its contributors, its owner's age, a fork and the repository it came from, stars and forks,
//     its readme's opening, and older repositories of the same name (an original it may copy);
//   - site_age: a domain's registration (RDAP, the registry's own server from IANA's list), its first TLS certificate
//     (crt.sh's certificate transparency log) and its first capture in the Wayback Machine;
//   - x_account: an x account's own record (FxTwitter's profile with x's "about this account"): joined when, its
//     followers and posts, where x says it is based, its username changes (a bought or recycled account is an old one
//     renamed), and whether its bio names the coin's address. The narrative's own post (an x status among the coin's
//     links) is dated by its id and read again (FxTwitter): posted before the coin or after it, by whom, still there or
//     gone. A repository's first commit is looked up by its hash: found in older repositories, its history was copied.
//     GitHub is read without a key (60 calls an hour from one address: GITHUB_PER_HOUR keeps under it, a repository
//     read is kept an hour); the others are keyless public services.

import { chainIdsIn } from "@crawlnet/shared";
import { MB, readCapped } from "../http.ts";
import { WindowLimiter } from "../limits.ts";
import { SOL_ADDRESS } from "../schema.ts";
import { HOUR, MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, take, type FreeContext } from "./common.ts";
import { FXTWITTER_HOST, fxPost } from "./ctradar.ts";
import { PUMP_API_HOST } from "./pumpcallouts.ts";

const GITHUB_API_HOST = "api.github.com";
const GITHUB_RAW_HOST = "raw.githubusercontent.com";
const IANA_HOST = "data.iana.org";
const CRTSH_HOST = "crt.sh";
const WAYBACK_HOST = "web.archive.org";
const TELEGRAM_HOST = "t.me";
const VIRTUALS_HOST = "api.virtuals.io";
/** The hosts the larp reads call (registry.ts allows them; RDAP servers are allowed as IANA's list names them) */
export const LARP_HOSTS = [GITHUB_API_HOST, GITHUB_RAW_HOST, IANA_HOST, CRTSH_HOST, WAYBACK_HOST, FXTWITTER_HOST, TELEGRAM_HOST, VIRTUALS_HOST] as const;
/** The user agent the readers send, saying what they are (FxTwitter and t.me answer it) */
const READER_UA = "Mozilla/5.0 (compatible; queen-harness/0.1)";
const FX_TIMEOUT_MS = 6_000;
/** The narrative posts among a coin's links read again at most */
const X_POSTS_MAX = 2;
/** A username change this long after the account joined is a rename (one at signup is how x makes handles) */
const RENAME_AFTER_MS = 2 * 86_400_000;
/** GitHub's calls an hour at most, every caller together (its own limit without a key is 60) */
const GITHUB_PER_HOUR = 55;
/** The same with a GitHub token (ToolsConfig.githubToken: 5,000 an hour, its own, not the server IP's) */
const GITHUB_PER_HOUR_TOKEN = 4500;
/** GitHub's search calls a minute at most (its own limit without a key is 10) */
const GITHUB_SEARCH_PER_MIN = 8;
const BODY_MAX = 4 * MB;
const README_CHARS = 1_500;
const DESCRIPTION_CHARS = 600;

const GITHUB_REPO = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})(?:\/([A-Za-z0-9._-]{1,100}))?/;
const X_HANDLE = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Hosts that are no project's own site (a link-in-bio, a social network, a launchpad) */
const NOT_A_SITE = /(?:^|\.)(?:x\.com|twitter\.com|t\.me|telegram\.(?:me|org)|discord\.(?:gg|com)|github\.com|pump\.fun|dexscreener\.com|linktr\.ee|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|medium\.com|gitbook\.io)$/;

/** The registered domain of a site's URL ("app.example.app" → "example.app"; "x.co.uk" kept whole), or null */
export function siteDomain(url: string): string | null {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!DOMAIN.test(host) || NOT_A_SITE.test(host)) return null;
  const parts = host.split(".");
  // a second-level public suffix (co.uk, com.au, …) keeps three labels
  const keep = parts.length >= 3 && /^(?:co|com|net|org|gov|edu|ac)$/.test(parts.at(-2)!) && parts.at(-1)!.length === 2 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** A GitHub link's owner and repository (repository null for an account's page) */
export function githubRef(url: string): { owner: string; repo: string | null } | null {
  const m = GITHUB_REPO.exec(url);
  if (!m) return null;
  const owner = m[1]!;
  if (/^(?:orgs|topics|features|about|marketplace|sponsors|settings|login|search)$/i.test(owner)) return null;
  const repo = m[2] ? m[2].replace(/\.git$/i, "") : null;
  return { owner, repo: repo && repo !== "." && repo !== ".." ? repo : null };
}

const iso = (ms: number | null) => (ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const time = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(t) ? t : null;
};
const clip = (v: unknown, n: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;
};
/** The last page a GitHub list's Link header names (its count of items at per_page=1), or null */
export function lastPage(link: string | null): number | null {
  const m = link ? /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link) : null;
  return m ? Number(m[1]) : null;
}

const X_STATUS = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{6,20})/;
/** When a post on x was made, from its id (x's ids carry their time since late 2010), or null */
export function postTime(id: string): number | null {
  if (!/^\d{15,20}$/.test(id)) return null;
  const ms = Number((BigInt(id) >> 22n) + 1288834974657n);
  return ms > Date.UTC(2010, 10, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}
const TELEGRAM_LINK = /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?(?:[?#].*)?$/i;
const html = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
/**
 * A public Telegram page's record (t.me/<name>): its title, what it is by the count it shows (a bot's monthly users, a
 * channel's subscribers, a group's members) and its description; null when the page names nothing (no such name)
 */
function telegramPage(page: string): { title: string; verified: boolean; kind: "bot" | "channel" | "group" | "account"; count: number | null; description: string | null } | null {
  const raw = /class="tgme_page_title"[^>]*>([\s\S]*?)<\/div>/.exec(page)?.[1];
  const verified = raw !== undefined && /verified-icon/.test(raw);
  const title = raw?.replace(/<i class="verified-icon"[^>]*>[\s\S]*?<\/i>/g, "");
  if (!title || !html(title)) return null;
  // its extras: its @name, then the count it shows
  const extras = [...page.matchAll(/class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => html(m[1]!));
  const n = extras.map((e) => /(\d[\d\s,.]*)\s+(monthly users|subscribers?|members?)/i.exec(e)).find((m) => m !== null) ?? null;
  const count = n ? Number(n[1]!.replace(/[\s,.]/g, "")) : null;
  const kind = !n ? "account" : /monthly/i.test(n[2]!) ? "bot" : /subscriber/i.test(n[2]!) ? "channel" : "group";
  const desc = /class="tgme_page_description"[^>]*>([\s\S]*?)<\/div>/.exec(page)?.[1];
  return { title: html(title).slice(0, 80), verified, kind, count: count !== null && Number.isFinite(count) ? count : null, description: desc ? html(desc).slice(0, 200) || null : null };
}

/** An x handle from a link, "@name" or the name */
export function xHandleOf(s: string): string | null {
  const t = s.trim();
  const m = X_HANDLE.exec(t) ?? /^@?([A-Za-z0-9_]{1,15})$/.exec(t);
  const h = m?.[1] ?? null;
  return h && !/^(?:home|search|i|intent|share|status)$/i.test(h) ? h : null;
}

export function larpTools(fc: FreeContext, githubToken: string | null = null): ToolDef[] {
  const github = new WindowLimiter(githubToken ? GITHUB_PER_HOUR_TOKEN : GITHUB_PER_HOUR, HOUR, fc.now);
  const auth: Record<string, string> = githubToken ? { authorization: `Bearer ${githubToken}` } : {};
  const githubSearch = new WindowLimiter(GITHUB_SEARCH_PER_MIN, MINUTE, fc.now);
  /** Until when GitHub refuses us (its rate limit's reset) */
  let githubRestUntil = 0;

  async function getJson(url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; link: string | null }> {
    const res = await fc.http.raw(url, { headers: { accept: "application/json", ...headers }, signal });
    const link = res.headers.get("link");
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: null, link };
    }
    try {
      return { status: res.status, body: JSON.parse(await readCapped(res, BODY_MAX)) as unknown, link };
    } catch (err) {
      if (err instanceof ToolFail) throw err;
      throw new ToolFail("unavailable");
    }
  }

  /** One FxTwitter read (`path` after its host), FX_TIMEOUT_MS at most: its body, null when it has none (a 404 is a body too) */
  async function fx(path: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const res = await fc.http.raw(`https://${FXTWITTER_HOST}${path}`, { headers: { accept: "application/json", "user-agent": READER_UA }, signal: AbortSignal.any([signal, AbortSignal.timeout(FX_TIMEOUT_MS)]) });
    try {
      const body = JSON.parse(await readCapped(res, MB)) as unknown;
      return isObj(body) ? body : null;
    } catch {
      return null;
    }
  }

  /** One GitHub API call (its limiter taken; a 403 or 429 of its rate limit rests every call until its reset) */
  async function gh(path: string, signal: AbortSignal, search = false): Promise<{ status: number; body: unknown; link: string | null }> {
    if (fc.now() < githubRestUntil) throw new ToolFail("rate_limited");
    take(github);
    if (search) take(githubSearch);
    const res = await fc.http.raw(`https://${GITHUB_API_HOST}${path}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...auth }, signal });
    const link = res.headers.get("link");
    if (res.status === 403 || res.status === 429) {
      const reset = num(res.headers.get("x-ratelimit-reset"));
      if (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429) {
        githubRestUntil = reset ? reset * 1000 : fc.now() + 10 * MINUTE;
        await res.body?.cancel().catch(() => {});
        throw new ToolFail("rate_limited");
      }
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: null, link };
    }
    try {
      return { status: res.status, body: JSON.parse(await readCapped(res, BODY_MAX)) as unknown, link };
    } catch (err) {
      if (err instanceof ToolFail) throw err;
      throw new ToolFail("unavailable");
    }
  }

  // ─────────────────────────────── project_links

  const links: ToolDef = {
    name: "project_links",
    // the project's own site and pages are its sources as found (no primary source stands in for them)
    webSources: true,
    description:
      "A Solana token's own words and links, as its launchpad and DexScreener list them: its description, website, x account, telegram (with its bot's monthly users or its subscribers), github and other links, its creator and when it was made, pump.fun's agent mark, Virtuals' agent record, and the story's own posts on x dated against the launch (still there or gone). The start of a larp check: what the coin claims to be and where to verify it.",
    parameters: {
      type: "object",
      properties: { mint: { type: "string", description: "The token's mint address (base58)", pattern: SOL_ADDRESS } },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const mint = String(args.mint).trim();
      const [pump, dex, virtuals] = await Promise.all([
        (async () => {
          take(fc.limit.pump);
          const r = await getJson(`https://${PUMP_API_HOST}/coins-v2/${mint}`, signal);
          if (r.status === 429) return null;
          return isObj(r.body) ? r.body : null;
        })().catch(() => null),
        (async () => {
          take(fc.limit.dexscreener);
          const r = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, signal);
          const pairs = Array.isArray(r.body) ? r.body.filter(isObj) : [];
          return pairs.find((p) => isObj(p.info))?.info as Record<string, unknown> | undefined;
        })().catch(() => undefined),
        // Virtuals' agent registry by the coin's address: an agent it lists (its wallet, its verified x) or none
        (async () => {
          const r = await getJson(`https://${VIRTUALS_HOST}/api/virtuals?filters%5BtokenAddress%5D=${mint}`, AbortSignal.any([signal, AbortSignal.timeout(FX_TIMEOUT_MS)]));
          if (!isObj(r.body) || !Array.isArray(r.body.data)) return undefined;
          const a = r.body.data.find(isObj);
          if (!a) return null;
          const socials = isObj(a.socials) && isObj(a.socials.VERIFIED_LINKS) ? a.socials.VERIFIED_LINKS : null;
          return {
            name: clip(a.name, 60),
            status: typeof a.status === "string" ? a.status : null,
            verified: a.isVerified === true,
            agent_wallet: typeof a.walletAddress === "string" ? a.walletAddress : null,
            x: socials && typeof socials.TWITTER === "string" ? socials.TWITTER : null,
            listed_at: typeof a.createdAt === "string" ? a.createdAt : null,
          };
        })().catch(() => undefined),
      ]);
      if (!pump && !dex) return { ok: false, error: "not_found", message: "neither pump.fun nor DexScreener lists this token" };
      const urls: { url: string; kind: string; from: string }[] = [];
      const add = (url: unknown, kind: string, from: string) => {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim()) || url.length > 300) return;
        const u = url.trim();
        if (!urls.some((x) => x.url === u)) urls.push({ url: u, kind, from });
      };
      if (pump) {
        add(pump.website, "website", "pump.fun");
        add(pump.twitter, "x", "pump.fun");
        add(pump.telegram, "telegram", "pump.fun");
      }
      for (const w of Array.isArray(dex?.websites) ? dex!.websites.filter(isObj) : []) add(w.url, "website", "dexscreener");
      for (const s of Array.isArray(dex?.socials) ? dex!.socials.filter(isObj) : []) add(s.url, s.type === "twitter" ? "x" : String(s.type ?? "social"), "dexscreener");
      const description = clip(pump?.description, DESCRIPTION_CHARS);
      // links written into its description (a github, a site): pump.fun's form has no field for them
      for (const m of (description ?? "").matchAll(/https?:\/\/[^\s)"'<>]{4,200}/g)) add(m[0], "in description", "pump.fun");
      for (const m of (description ?? "").matchAll(/(?<![\w/.])(?:github\.com\/[A-Za-z0-9-]{1,39}(?:\/[A-Za-z0-9._-]{1,100})?)/g)) add(`https://${m[0]}`, "in description", "pump.fun");
      const githubs = [...new Map(urls.map((u) => githubRef(u.url)).filter((g): g is { owner: string; repo: string | null } => g !== null).map((g) => [`${g.owner}/${g.repo ?? ""}`, g])).values()];
      // its own accounts: a post's link is someone's post (the story's source), not the coin's account
      const seenHandle = new Set<string>();
      const handles = urls
        .filter((u) => !X_STATUS.test(u.url))
        .map((u) => X_HANDLE.exec(u.url)?.[1])
        .filter((h): h is string => !!h && !/^(?:home|search|i|intent|share)$/i.test(h) && !seenHandle.has(h.toLowerCase()) && !!seenHandle.add(h.toLowerCase()));
      const sites = [...new Set(urls.filter((u) => u.kind === "website" || u.kind === "in description").map((u) => siteDomain(u.url)).filter((d): d is string => d !== null))];
      const created = num(pump?.created_timestamp);
      // the story's own posts on x among its links (pump.fun's x field is often one): dated by their ids against the
      // launch, and read again for who posted them, what they say and whether they are still there
      const statuses = [...new Map(urls.flatMap((u) => {
        const m = X_STATUS.exec(u.url);
        return m ? [[m[2]!, { id: m[2]!, url: u.url }] as const] : [];
      })).values()].slice(0, X_POSTS_MAX);
      // its telegram's page: a bot's monthly users, a channel's subscribers, a group's members
      const tgLink = urls.find((u) => TELEGRAM_LINK.test(u.url))?.url;
      const telegram = tgLink
        ? fc.http
            .raw(tgLink.replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)/i, `https://${TELEGRAM_HOST}`), { headers: { "user-agent": READER_UA, accept: "text/html" }, signal: AbortSignal.any([signal, AbortSignal.timeout(FX_TIMEOUT_MS)]) })
            .then(async (res) => (res.ok ? telegramPage(await readCapped(res, MB)) : (await res.body?.cancel().catch(() => {}), null)))
            .catch(() => undefined)
        : Promise.resolve(undefined);
      const posts = await Promise.all(
        statuses.map(async (s) => {
          const at = postTime(s.id);
          const body = await fx(`/2/status/${s.id}`, signal).catch(() => null);
          const p = body ? fxPost(body) : null;
          return {
            url: s.url,
            posted_at: iso(at),
            ...(at !== null && created !== null ? { minutes_before_launch: Math.round((created - at) / 60_000) } : {}),
            ...(p
              ? { by: p.handle, author_followers: p.followers, text: clip(p.text, 280), likes: p.likes, views: p.views }
              : body !== null && num(body.code) === 404
                ? { gone: "x has no such post now: deleted, or its account private or suspended" }
                : { read: "unavailable" }),
          };
        }),
      );
      return {
        ok: true,
        data: {
          mint,
          name: clip(pump?.name, 60),
          symbol: clip(pump?.symbol, 24),
          description,
          created_at: iso(created),
          creator: typeof pump?.creator === "string" ? pump.creator : null,
          tokenized_agent: pump?.tokenized_agent === true,
          links: urls,
          github: githubs.map((g) => (g.repo ? `${g.owner}/${g.repo}` : g.owner)),
          x_handles: handles,
          ...(posts.length ? { x_posts: posts } : {}),
          ...(await telegram.then((tg) => (tgLink ? { telegram: tg ? { link: tgLink, ...tg } : tg === null ? { link: tgLink, gone: "telegram shows no such name" } : { link: tgLink, read: "unavailable" } } : {}))),
          ...(virtuals !== undefined ? { virtuals: virtuals ?? "not an agent on Virtuals" } : {}),
          site_domains: sites,
          ...(urls.length ? {} : { note: "no website, x account or github listed: nothing of its own to verify" }),
        },
        sources: urls.slice(0, 6).map((u) => ({ title: u.kind, url: u.url })),
      };
    },
  };

  // ─────────────────────────────── github_repo

  /** An account's record: its age and size, and its repositories newest pushed first */
  async function account(owner: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const u = await gh(`/users/${owner}`, signal);
    if (u.status === 404 || !isObj(u.body)) return null;
    return { login: u.body.login, type: u.body.type, created_at: u.body.created_at, public_repos: u.body.public_repos, followers: u.body.followers, bio: clip(u.body.bio, 200), blog: clip(u.body.blog, 120), x: typeof u.body.twitter_username === "string" ? u.body.twitter_username : null };
  }

  const repoTool: ToolDef = {
    name: "github_repo",
    slow: true,
    description:
      "A GitHub repository's record, or an account's repositories, for a larp check: made and last pushed when, its commits counted with the first and the newest, contributors, its owner's age and x account, a fork and of what, stars, forks, issues, its readme's opening (with the coin's mint: whether it names it), older repositories with the same name and the ones its first commit is also in (its history copied). Weigh against the launch: a repo made hours before it, one squashed commit, a fresh fork renamed.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "A GitHub link or owner/name (an account's link or name alone lists its repositories)", minLength: 1, maxLength: 300 },
        mint: { type: "string", description: "The coin's mint (base58), to say whether its readme names it", pattern: SOL_ADDRESS },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    ttlMs: HOUR,
    async run(args, { signal }): Promise<Outcome> {
      const raw = String(args.repo).trim();
      const mint = typeof args.mint === "string" ? args.mint.trim() : null;
      const ref = githubRef(raw.includes("github.com") ? raw : `github.com/${raw.replace(/^@/, "")}`);
      if (!ref) return { ok: false, error: "bad_args", message: "give a GitHub link or owner/name" };
      if (!ref.repo) {
        const [acct, repos] = await Promise.all([account(ref.owner, signal), gh(`/users/${ref.owner}/repos?sort=pushed&per_page=10`, signal)]);
        if (!acct) return { ok: false, error: "not_found", message: "no such GitHub account" };
        const list = Array.isArray(repos.body) ? repos.body.filter(isObj) : [];
        return {
          ok: true,
          data: {
            account: acct,
            repositories: list.map((r) => ({ name: r.name, fork: r.fork === true, created_at: r.created_at, pushed_at: r.pushed_at, stars: r.stargazers_count, forks: r.forks_count, language: r.language, description: clip(r.description, 160) })),
          },
          sources: [{ title: `github: ${ref.owner}`, url: `https://github.com/${ref.owner}` }],
        };
      }
      const path = `/repos/${ref.owner}/${ref.repo}`;
      const r = await gh(path, signal);
      if (r.status === 404 || !isObj(r.body)) return { ok: false, error: "not_found", message: "no such public repository (deleted, private or never made)" };
      const repo = r.body;
      const owner = isObj(repo.owner) && typeof repo.owner.login === "string" ? repo.owner.login : ref.owner;
      const branch = typeof repo.default_branch === "string" ? repo.default_branch : "main";
      const parent = isObj(repo.parent) ? repo.parent : isObj(repo.source) ? repo.source : null;
      const name = typeof repo.name === "string" ? repo.name : ref.repo;
      // the newest commit and the count (its Link header at per_page=1), then the first; contributors; the owner; the
      // readme from the raw host (no API call); older repositories of the same name
      const [newest, contributors, acct, readme, same] = await Promise.all([
        gh(`${path}/commits?per_page=1`, signal).catch(() => null),
        gh(`${path}/contributors?per_page=100&anon=1`, signal).catch(() => null),
        account(owner, signal).catch(() => null),
        (async () => {
          for (const file of ["README.md", "readme.md", "README"]) {
            const res = await fc.http.raw(`https://${GITHUB_RAW_HOST}/${owner}/${name}/${branch}/${file}`, { signal }).catch(() => null);
            if (res?.ok) {
              const text = await readCapped(res, MB).catch(() => "");
              return { opening: clip(text, README_CHARS), namesMint: mint !== null && text.includes(mint) };
            }
            await res?.body?.cancel().catch(() => {});
          }
          return null;
        })(),
        gh(`/search/repositories?q=${encodeURIComponent(`${name} in:name`)}&sort=stars&order=desc&per_page=8`, signal, true).catch(() => null),
      ]);
      const commitOf = (c: unknown) =>
        isObj(c) && isObj(c.commit)
          ? {
              at: isObj(c.commit.author) ? c.commit.author.date : null,
              pushed_by_at: isObj(c.commit.committer) ? c.commit.committer.date : null,
              author: isObj(c.author) && typeof c.author.login === "string" ? c.author.login : isObj(c.commit.author) ? clip(c.commit.author.name, 40) : null,
              message: clip(c.commit.message, 140),
              sha: typeof c.sha === "string" ? c.sha : null,
            }
          : null;
      const commits = lastPage(newest?.link ?? null) ?? (Array.isArray(newest?.body) ? newest!.body.length : null);
      const newestCommit = Array.isArray(newest?.body) ? commitOf(newest!.body[0]) : null;
      let firstCommit: ReturnType<typeof commitOf> = newestCommit;
      if (commits !== null && commits > 1) {
        const f = await gh(`${path}/commits?per_page=1&page=${commits}`, signal).catch(() => null);
        firstCommit = Array.isArray(f?.body) ? commitOf(f!.body[0]) : null;
      }
      // its first commit by its hash: found in other repositories, its history came from them (a copy keeps the hashes)
      const rootIn = firstCommit?.sha
        ? await gh(`/search/commits?q=${encodeURIComponent(`hash:${firstCommit.sha}`)}&per_page=10`, signal, true)
            .then((s) => (isObj(s.body) && Array.isArray(s.body.items) ? s.body.items.filter(isObj) : []).map((i) => (isObj(i.repository) ? String(i.repository.full_name ?? "") : "")).filter((n) => n && n.toLowerCase() !== String(repo.full_name).toLowerCase()))
            .catch(() => null)
        : null;
      const people = Array.isArray(contributors?.body) ? contributors!.body.filter(isObj) : [];
      const created = time(repo.created_at);
      const originals = (isObj(same?.body) && Array.isArray(same!.body.items) ? same!.body.items.filter(isObj) : [])
        .filter((x) => x.full_name !== repo.full_name && typeof x.name === "string" && x.name.toLowerCase() === name.toLowerCase())
        .filter((x) => created === null || (time(x.created_at) ?? Infinity) < created)
        .slice(0, 5)
        .map((x) => ({ repo: x.full_name, created_at: x.created_at, stars: x.stargazers_count, description: clip(x.description, 140) }));
      const firstAt = time(firstCommit?.at);
      return {
        ok: true,
        data: {
          repo: repo.full_name,
          description: clip(repo.description, 300),
          homepage: clip(repo.homepage, 200),
          created_at: repo.created_at,
          pushed_at: repo.pushed_at,
          default_branch: branch,
          fork: repo.fork === true,
          ...(parent ? { fork_of: { repo: parent.full_name, created_at: parent.created_at, stars: parent.stargazers_count } } : {}),
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          open_issues: repo.open_issues_count,
          watchers: repo.subscribers_count ?? null,
          size_kb: repo.size,
          language: repo.language,
          license: isObj(repo.license) ? repo.license.spdx_id : null,
          topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 10) : [],
          archived: repo.archived === true,
          commits,
          first_commit: firstCommit,
          newest_commit: newestCommit,
          // a first commit dated before the repository was made: its history was brought in (a copy, or rewritten dates)
          ...(firstAt !== null && created !== null && firstAt < created - 2 * 86_400_000 ? { history_before_repo: true } : {}),
          contributors: people.length,
          top_contributors: people.slice(0, 5).map((p) => ({ login: p.login ?? clip(p.name, 40), commits: p.contributions, kind: p.type === "Anonymous" ? "anonymous" : "account" })),
          owner: acct,
          readme: readme?.opening ?? null,
          ...(mint && readme ? { readme_names_mint: readme.namesMint } : {}),
          older_same_name: originals,
          ...(rootIn && rootIn.length ? { first_commit_also_in: [...new Set(rootIn)].slice(0, 6) } : {}),
        },
        sources: [{ title: `github: ${repo.full_name}`, url: `https://github.com/${repo.full_name}` }],
      };
    },
  };

  // ─────────────────────────────── site_age

  /** IANA's RDAP servers by top-level domain (its bootstrap file), read once a day; their hosts allowed as read */
  let bootstrap: { at: number; byTld: Map<string, string> } | null = null;
  async function rdapBase(tld: string, signal: AbortSignal): Promise<string | null> {
    if (!bootstrap || fc.now() - bootstrap.at > 24 * HOUR) {
      const r = await getJson(`https://${IANA_HOST}/rdap/dns.json`, signal);
      const byTld = new Map<string, string>();
      for (const s of isObj(r.body) && Array.isArray(r.body.services) ? r.body.services : []) {
        if (!Array.isArray(s) || !Array.isArray(s[0]) || !Array.isArray(s[1])) continue;
        const base = (s[1] as unknown[]).find((u): u is string => typeof u === "string" && u.startsWith("https://"));
        if (!base) continue;
        for (const t of s[0] as unknown[]) if (typeof t === "string") byTld.set(t.toLowerCase(), base.endsWith("/") ? base : `${base}/`);
      }
      if (byTld.size) bootstrap = { at: fc.now(), byTld };
    }
    const base = bootstrap?.byTld.get(tld) ?? null;
    if (base) fc.http.allow(new URL(base).host);
    return base;
  }

  const siteAge: ToolDef = {
    name: "site_age",
    slow: true,
    webSources: true,
    description:
      "How old a project's website really is, for a larp check: its domain's registration date, registrar and expiry (RDAP), its first TLS certificate (certificate transparency) and its first capture in the Wayback Machine. Weigh them against the coin's launch: a domain registered or first certified the same day is made for the coin; one years old may be bought or pointed at someone else's work.",
    parameters: {
      type: "object",
      properties: { site: { type: "string", description: "The site's link or domain (example.app)", minLength: 3, maxLength: 300 } },
      required: ["site"],
      additionalProperties: false,
    },
    ttlMs: 6 * HOUR,
    async run(args, { signal }): Promise<Outcome> {
      const domain = siteDomain(String(args.site));
      if (!domain) return { ok: false, error: "bad_args", message: "give a website's link or domain (not a social network's)" };
      const tld = domain.split(".").at(-1)!;
      const now = fc.now();
      const days = (ms: number | null) => (ms === null ? null : Math.max(0, Math.round(((now - ms) / 86_400_000) * 10) / 10));
      const [rdap, cert, archive] = await Promise.all([
        (async () => {
          const base = await rdapBase(tld, signal);
          if (!base) return null;
          const r = await getJson(`${base}domain/${domain}`, signal, { accept: "application/rdap+json" });
          if (!isObj(r.body)) return null;
          const events = Array.isArray(r.body.events) ? r.body.events.filter(isObj) : [];
          const at = (action: string) => time(events.find((e) => e.eventAction === action)?.eventDate);
          const registrar = (Array.isArray(r.body.entities) ? r.body.entities.filter(isObj) : []).find((e) => Array.isArray(e.roles) && e.roles.includes("registrar"));
          const vcard = isObj(registrar) && Array.isArray(registrar.vcardArray) && Array.isArray(registrar.vcardArray[1]) ? (registrar.vcardArray[1] as unknown[]) : [];
          const fn = vcard.find((x): x is unknown[] => Array.isArray(x) && x[0] === "fn");
          return {
            registered: at("registration"),
            expires: at("expiration"),
            changed: at("last changed"),
            registrar: fn && typeof fn[3] === "string" ? clip(fn[3], 80) : null,
            nameservers: (Array.isArray(r.body.nameservers) ? r.body.nameservers.filter(isObj) : []).map((n) => String(n.ldhName ?? "").toLowerCase()).filter(Boolean).slice(0, 4),
          };
        })().catch(() => null),
        (async () => {
          const r = await getJson(`https://${CRTSH_HOST}/?q=${encodeURIComponent(domain)}&output=json&exclude=expired&deduplicate=Y`, AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
          const list = Array.isArray(r.body) ? r.body.filter(isObj) : [];
          const firsts = list.map((c) => time(typeof c.not_before === "string" ? `${c.not_before}Z` : null)).filter((t): t is number => t !== null);
          return firsts.length ? { first: Math.min(...firsts), count: list.length } : null;
        })().catch(() => null),
        (async () => {
          const r = await getJson(`https://${WAYBACK_HOST}/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp`, AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
          const rows = Array.isArray(r.body) ? r.body.filter(Array.isArray) : [];
          const ts = rows.length > 1 && typeof rows[1]![0] === "string" ? (rows[1]![0] as string) : null;
          return ts && /^\d{14}$/.test(ts) ? Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12)) : null;
        })().catch(() => null),
      ]);
      if (!rdap && !cert && archive === null) return { ok: false, error: "unavailable", message: "no registry, certificate log or archive answered for it" };
      return {
        ok: true,
        data: {
          domain,
          registered_at: iso(rdap?.registered ?? null),
          registered_days_ago: days(rdap?.registered ?? null),
          expires_at: iso(rdap?.expires ?? null),
          registrar: rdap?.registrar ?? null,
          nameservers: rdap?.nameservers ?? [],
          first_certificate_at: iso(cert?.first ?? null),
          first_certificate_days_ago: days(cert?.first ?? null),
          first_archived_at: iso(archive),
          first_archived_days_ago: days(archive),
          ...(rdap ? {} : { note: "its registry has no RDAP server (or it did not answer): judge by the certificate and the archive" }),
        },
        sources: [{ title: `domain: ${domain}`, url: `https://${domain}` }],
      };
    },
  };

  // ─────────────────────────────── x_account

  const xAccount: ToolDef = {
    name: "x_account",
    description:
      "An x account's own record, for a larp check: when it joined, followers, following and posts, its verification, bio and website, where x says it is based and the app it was made from, and its username changes (how many, the last one's date: an old account renamed is a bought or recycled one, a change at signup is not). With the coin's mint: whether its bio names this coin's address, or other addresses.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "The account's handle or its x link", minLength: 1, maxLength: 120 },
        mint: { type: "string", description: "The coin's mint (base58), to say whether the bio names it", pattern: SOL_ADDRESS },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    ttlMs: 30 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const handle = xHandleOf(String(args.handle));
      if (!handle) return { ok: false, error: "bad_args", message: "give an x handle or an x account's link" };
      const mint = typeof args.mint === "string" ? args.mint.trim() : null;
      // x's "about this account" comes with the profile on FxTwitter's v2 read; its v1 read has the profile alone
      const v2 = await fx(`/2/profile/${handle}?about_account=1`, signal).catch(() => null);
      const body = isObj(v2?.user) ? v2 : await fx(`/${handle}`, signal).catch(() => null);
      const u = isObj(body?.user) ? body!.user : null;
      if (!u) return num(body?.code) === 404 ? { ok: false, error: "not_found", message: "x has no such account (never made, renamed away, or suspended)" } : { ok: false, error: "unavailable", message: "x's record of the account could not be read" };
      const about = isObj(u.about_account) ? u.about_account : null;
      const changes = about && isObj(about.username_changes) ? about.username_changes : null;
      const joined = time(u.joined);
      const lastChange = time(changes?.last_changed_at);
      const now = fc.now();
      const bio = typeof u.description === "string" ? u.description : "";
      const website = isObj(u.website) && typeof u.website.url === "string" ? u.website.url : null;
      const ids = chainIdsIn(`${bio} ${website ?? ""}`, 6);
      const verification = isObj(u.verification) ? u.verification : null;
      return {
        ok: true,
        data: {
          handle: typeof u.screen_name === "string" ? u.screen_name : handle,
          name: clip(u.name, 60),
          joined_at: iso(joined),
          joined_days_ago: joined === null ? null : Math.round(((now - joined) / 86_400_000) * 10) / 10,
          followers: num(u.followers),
          following: num(u.following),
          posts: num(u.statuses ?? u.tweets),
          verified: verification?.verified === true ? (typeof verification.type === "string" ? verification.type : "yes") : false,
          bio: clip(bio, 300),
          website,
          ...(about
            ? {
                based_in: typeof about.based_in === "string" ? about.based_in : null,
                // x's own warning: the place may be off (a VPN or a proxy)
                ...(about.location_accurate === false ? { based_in_accurate: false } : {}),
                made_from: typeof about.source === "string" ? about.source : null,
                username_changes: num(changes?.count),
                last_username_change_at: iso(lastChange),
                ...(lastChange !== null && joined !== null && lastChange - joined > RENAME_AFTER_MS ? { renamed_days_after_joining: Math.round((lastChange - joined) / 86_400_000) } : {}),
              }
            : { about: "x's about-this-account record was not read" }),
          ...(mint ? { bio_names_mint: ids.addresses.includes(mint), ...(ids.addresses.some((a) => a !== mint) ? { bio_other_addresses: ids.addresses.filter((a) => a !== mint) } : {}) } : {}),
        },
        sources: [{ title: `@${handle} on x`, url: `https://x.com/${handle}` }],
      };
    },
  };

  return [links, repoTool, siteAge, xAccount];
}
