// The page reader: page_snapshot as one more function of the tools layer. It opens a public web page with a plain
// request (no browser) and gives the model what the page says and holds: its title and description, its text,
// its links, the Solana addresses and transaction signatures it names, and the hosts its scripts load from. The larp check
// reads a coin's site with it.
//
// Anyone may name any link, so the reader only connects to public addresses: every connection's DNS answer is checked
// at connect time (no private, loopback, link-local or shared ranges, a rebinding included), only http(s) on their own
// ports, redirects followed by hand (4 at most, each checked again), 2 MB at most, HTML and text only.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { chainIdsIn, type ToolResult, type ToolRunContext, type ToolSpec, type ToolsModule } from "@crawlnet/shared";
import { Agent } from "undici";

const PAGE_TOOL = "page_snapshot";
const PAGE_SPEC: ToolSpec = {
  name: PAGE_TOOL,
  description:
    "Open one public web page and read it: its title and description, its text, its links, the Solana addresses and transaction signatures it names, and the hosts its scripts load from. For a project's own site, docs or a dashboard; never x or other social sites, and never a coin's page on a launchpad or a screener (the chain functions read those).",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The page's full http(s) link", maxLength: 2000 } },
    required: ["url"],
    additionalProperties: false,
  },
};

const TIMEOUT_MS = 15_000;
const BODY_MAX = 2 * 1024 * 1024;
const TEXT_CHARS = 6_000;
const LINKS_MAX = 40;
const REDIRECTS_MAX = 4;
const PER_ANSWER_MAX = 4;
const CACHE_MS = 10 * 60_000;
const SOCIAL = /(?:^|\.)(?:x\.com|twitter\.com|t\.co|facebook\.com|instagram\.com|tiktok\.com|t\.me|discord\.(?:gg|com))$/i;

/** Whether an IP address is one a public page never sits on */
function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return privateAddress(mapped[1]!);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8");
  }
  return true;
}

/** DNS for the reader's connections: every answer checked, a private one refused */
function guardedLookup(host: string, opts: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(host, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => privateAddress(a.address))) return cb(Object.assign(new Error("not a public address"), { code: "EPRIVATE" }), []);
    if ((opts as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

const agent = new Agent({ connect: { lookup: guardedLookup as never, timeout: TIMEOUT_MS } });

/** A link the reader may open, or why not */
function pageUrl(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "not a link";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "only http(s) links";
  if (u.username || u.password) return "a link with a password in it";
  if (u.port && u.port !== "80" && u.port !== "443") return "only the web's own ports";
  if (isIP(u.hostname.replace(/^\[|\]$/g, "")) && privateAddress(u.hostname.replace(/^\[|\]$/g, ""))) return "not a public address";
  if (SOCIAL.test(u.hostname)) return "social sites are not read here";
  return u;
}

const site = (h: string): string => h.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");
const decode = (s: string): string =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Math.min(0x10ffff, Number(n))));
const meta = (html: string, name: string): string | null => {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
  return content ? decode(content).trim().slice(0, 300) || null : null;
};

/** What a page says and holds, from its HTML */
function readPage(html: string, url: string): Record<string, unknown> {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body).replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  const links: string[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const href = new URL(decode(m[1]!), url).toString();
      if (/^https?:/.test(href) && !links.includes(href)) links.push(href);
    } catch {
      // not a link
    }
    if (links.length >= LINKS_MAX) break;
  }
  const scripts = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try {
      scripts.add(new URL(decode(m[1]!), url).hostname);
    } catch {
      // not a link
    }
  }
  const ids = chainIdsIn(html, 12);
  return {
    url,
    title,
    description: meta(html, "description") ?? meta(html, "og:description"),
    text: text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)} …` : text,
    words: text.split(/\s+/).filter(Boolean).length,
    links,
    addresses: ids.addresses,
    signatures: ids.signatures,
    script_hosts: [...scripts].slice(0, 20),
  };
}

/** Open a page (redirects by hand, each hop checked); the result as the tools layer gives one */
async function fetchPage(raw: string, signal: AbortSignal): Promise<ToolResult> {
  const first = pageUrl(raw);
  if (typeof first === "string") return { ok: false, error: "bad_args", message: first };
  let url = first;
  for (let hop = 0; hop <= REDIRECTS_MAX; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal, dispatcher: agent, headers: { "user-agent": "Mozilla/5.0 (compatible; queen-harness page reader)", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" } } as RequestInit);
    } catch (err) {
      const code = String((err as { cause?: { code?: string } })?.cause?.code ?? "");
      if (code === "ENOTFOUND") return { ok: false, error: "not_found", message: "no such site" };
      if (code === "EPRIVATE") return { ok: false, error: "bad_args", message: "not a public address" };
      return { ok: false, error: "unavailable", message: "the page did not answer" };
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location");
      void res.body?.cancel();
      const next = to ? pageUrl(new URL(to, url).toString()) : "a redirect with no target";
      if (typeof next === "string") return { ok: false, error: "unavailable", message: `the page redirects where it cannot be read (${next})` };
      if (site(next.hostname) !== site(first.hostname)) return { ok: false, error: "unavailable", message: `the page redirects to ${next.toString()} (another site)` };
      url = next;
      continue;
    }
    if (res.status === 404 || res.status === 410) return { ok: false, error: "not_found", message: `http ${res.status}` };
    if (!res.ok) return { ok: false, error: "unavailable", message: `http ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      void res.body?.cancel();
      return { ok: false, error: "unavailable", message: "not a web page" };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size >= BODY_MAX) {
        void reader.cancel();
        break;
      }
    }
    const html = new TextDecoder().decode(Buffer.concat(chunks));
    const data = readPage(html, url.toString());
    return { ok: true, data, sources: [{ title: String(data.title ?? url.hostname), url: url.toString() }] };
  }
  return { ok: false, error: "unavailable", message: "too many redirects" };
}

/** The tools layer with the page reader beside its own functions (its answers go through the same redaction guard) */
export function withPageReader(tools: ToolsModule, o: { log?: (msg: string, extra?: Record<string, unknown>) => void } = {}): ToolsModule {
  const cache = new Map<string, { at: number; result: ToolResult }>();
  const perAnswer = new Map<string, number>();
  const run = async (name: string, args: unknown, ctx: ToolRunContext): Promise<ToolResult> => {
    if (name !== PAGE_TOOL) return tools.run(name, args, ctx);
    const url = args && typeof args === "object" && typeof (args as { url?: unknown }).url === "string" ? (args as { url: string }).url : "";
    if (!url) return { ok: false, error: "bad_args", message: "url is required" };
    const answer = String(ctx?.answerId ?? "").split(":")[0] ?? "";
    const n = perAnswer.get(answer) ?? 0;
    if (n >= PER_ANSWER_MAX) return { ok: false, error: "rate_limited", message: "pages for this answer are used up" };
    if (perAnswer.size > 5000) perAnswer.clear();
    perAnswer.set(answer, n + 1);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
    const t0 = Date.now();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let result = await fetchPage(url, ctx?.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout).catch((): ToolResult => ({ ok: false, error: "unavailable", message: "the page did not answer" }));
    if (result.ok && result.data && typeof result.data === "object") {
      const d = result.data as Record<string, unknown>;
      for (const k of ["title", "description", "text"]) if (typeof d[k] === "string") d[k] = tools.redact(d[k] as string);
      result = { ...result, sources: tools.redactSources(result.sources) };
    }
    if (result.ok || result.error === "not_found") {
      if (cache.size > 500) cache.clear();
      cache.set(url, { at: Date.now(), result });
    }
    o.log?.("tools: call", { tool: PAGE_TOOL, ok: result.ok, ...(result.ok ? {} : { error: result.error }), ms: Date.now() - t0 });
    return result;
  };
  return {
    list: () => [...tools.list(), PAGE_SPEC],
    run,
    redact: (t) => tools.redact(t),
    redactSources: (s) => tools.redactSources(s),
    stop: () => tools.stop(),
  };
}
