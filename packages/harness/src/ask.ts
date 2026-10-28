// One answer of the harness, start to end:
//   1. the question's kind, read by code (harness.ts harnessRead), Jev's pick where code is unsure (jev.ts);
//   2. code's reads before the model starts: a coin's dossier (scan.ts, its deeper reads beside it), the plan's reads (a
//      narrative's board), a larp check's first wave, the posts on x a question about sentiment needs;
//   3. the model (brain.ts brainAnswer) with the plan's functions, a few rounds, then its JSON reply;
//   4. code after it: the dossier's late checks, the holder map (clustermap.ts), the redaction guard over the answer, its
//      sources and follow-ups. With no model answer, code writes a short one from what is in hand.
// Never throws: a failure is a plain line in her voice.

import { randomUUID } from "node:crypto";
import type { ToolResult, ToolSource, ToolSpec, ToolsModule } from "@crawlnet/shared";
import { answerSources, brainAnswer, dataBrief, DATA_SOURCES_MAX, NO_DATA, nowLine, resultLog, toolContent, type AskInput, type BrainResult, type BrainTools, type Prefetched, type ScanInput, type ToolCallLog } from "./brain.ts";
import { sanitizeChat, sanitizeChatQuestion, redactKeeping, type ChatContext } from "./chat.ts";
import { CLUSTERS_FILL_MS, withClusters } from "./clustermap.ts";
import type { HarnessConfig } from "./config.ts";
import { coinInView, harnessPlan, harnessRead, larpChecks, planReads, smallTalk, xReadOf, type HarnessIntent, type HarnessPlan, type PlanRead, type SiteTx } from "./harness.ts";
import { jevIntent } from "./jev.ts";
import { chatScanResult, DEEP_TOOLS, runScan, scanAskOf, scanBrief, settleDeep, withLateChecks, type ScanAsk, type ScanCall, type ScanFacts } from "./scan.ts";
import { memoryLines, rememberingTools, rolesFromReads, WalletMemory } from "./walletmem.ts";
import type { Db } from "@crawlnet/shared";

/** One call's time at most: until the write's reserve (the tools layer's own timeouts cut a slow source sooner) */
const TOOL_CALL_MS = 150_000;
/** The time kept for the write after the last call, at most (long answers take 25-45 s to write) */
const WRITE_RESERVE_MS = 50_000;
/** A search (x, the web) gets this much more once the quick calls of its round are back, then the model writes */
const SLOW_AFTER_QUICK_MS = 50_000;
const SLOW_TOOLS: readonly string[] = ["news_pages", "social_mentions"];
/** No scan starts with less than this left of the budget */
const SCAN_MIN_LEFT_MS = 30_000;
/** The last part of the budget no scan call runs into */
const SCAN_RESERVE_MS = 25_000;
/** The plan's reads (a narrative's board) wait this long at most */
const PLAN_READ_MS = 5_000;
/** The posts on x code reads beside the dossier, and how long the model waits to join them once the dossier is in */
const X_READ_MS = 30_000;
const X_READ_JOIN_MS = 20_000;
/** A larp check's first wave, at most */
const LARP_READ_MS = 25_000;
/** A coin's deeper reads are waited for this long at most once the dossier is in */
const DEEP_WAIT_MS = 8_000;
/** The last part of the budget kept for code's short answer when the model fails */
const ASK_MARGIN_MS = 3_000;

/** A question and the chat it sits in */
export interface Question {
  question: string;
  /** The chat so far, oldest first, and attachments (sanitizeChat takes what it can) */
  chat?: Partial<ChatContext>;
  /** The asker left: every read and the model stop */
  signal?: AbortSignal;
  /** A step of the research starts or ends (a function's name), for a live status line */
  onStep?: (name: string, phase: "start" | "end") => void;
}

export interface Answer {
  /** Markdown with the visual blocks (docs/BLOCKS.md) */
  answer: string;
  /** The primary pages behind the live data the answer used */
  sources: { url: string; title: string | null }[];
  followups: string[];
  /** Who wrote it: the model, code from what was in hand, or a plain line */
  by: "model" | "code" | "canned";
  /** The functions the answer read, code's and the model's */
  tools: string[];
  ms: number;
}

export interface HarnessDeps {
  cfg: HarnessConfig;
  tools: ToolsModule;
  /** The wallet memory's store (the tools' database is fine); none = no memory of wallets across coins */
  db?: Db | null;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Harness {
  ask(q: Question): Promise<Answer>;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createHarness(deps: HarnessDeps): Harness {
  const { cfg } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const memory = deps.db ? new WalletMemory(deps.db, now) : null;
  const tools: ToolsModule = memory ? rememberingTools(deps.tools, memory, now) : deps.tools;
  const memoryOf = memory
    ? (mint: string, reads: { launch: Record<string, unknown> | null; links: Record<string, unknown> | null }): string[] => {
        const roles = rolesFromReads(reads);
        return roles.length ? memoryLines(roles, memory.recall(roles.map((r) => r.wallet), mint), now()) : [];
      }
    : null;

  const specsNow = (): ToolSpec[] => {
    try {
      const l = tools.list();
      return Array.isArray(l) ? l : [];
    } catch {
      return [];
    }
  };
  const redact = (text: string, keep: Iterable<string> = []): string => {
    try {
      return redactKeeping(text, keep, (s) => tools.redact(s)).trim() || "...";
    } catch {
      return "...";
    }
  };
  /** The data links the redaction guard lets through, deduplicated */
  const linksOf = (data: ToolSource[]): Answer["sources"] => {
    let passed: ToolSource[] = [];
    try {
      passed = tools.redactSources(data);
    } catch {
      passed = [];
    }
    const seen = new Set<string>();
    const out: Answer["sources"] = [];
    for (const d of passed) {
      if (out.length >= DATA_SOURCES_MAX || seen.has(d.url)) continue;
      seen.add(d.url);
      out.push({ url: d.url, title: d.title.trim() || null });
    }
    return out;
  };

  /**
   * A coin's dossier (scan.ts): code's calls through the tools layer, each its own answer id and capped, none running
   * into the last SCAN_RESERVE_MS of the budget; its risk flags and the creator lookup left running (the answer starts
   * once the chain and the listings are read). Null without time for it or when nothing answered. Never throws.
   */
  async function scanFor(ask: ScanAsk, specs: ToolSpec[], deadline: number, o: { signal?: AbortSignal; deep: boolean; onCall?: (name: string, phase: "start" | "end") => void }): Promise<ScanInput | null> {
    if (deadline - now() < SCAN_MIN_LEFT_MS) return null;
    const names = new Set(specs.map((t) => t.name));
    const scanId = randomUUID();
    const call: ScanCall = async (name, args, ms) => {
      const started = now();
      const cap = Math.max(1, Math.min(ms, deadline - now() - SCAN_RESERVE_MS));
      const timeout = AbortSignal.timeout(cap);
      let result: ToolResult;
      o.onCall?.(name, "start");
      try {
        result = await tools.run(name, args, { answerId: `${scanId}:${name}`, signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
      } catch {
        result = NO_DATA;
      } finally {
        o.onCall?.(name, "end");
      }
      if (!result || typeof result !== "object") result = NO_DATA;
      const line: ToolCallLog = { tool: name, ok: result.ok, ...(result.ok ? {} : { error: result.error }), ms: now() - started, round: 0, args: JSON.stringify(args), ...resultLog(result, toolContent(result)) };
      return { result, log: line };
    };
    try {
      const facts = await runScan(ask, call, (n) => names.has(n), now(), { behind: true, ...(o.deep ? { deep: true, ...(memoryOf ? { memory: memoryOf } : {}) } : {}) });
      // the model reads totals and the key rows, not the raw pool and holder lists; trimmed in place: the checks left
      // running land in these same facts after the scan, and the answer's token block is built again from them
      facts.results = facts.results.map((r) => ({ ...r, result: chatScanResult(r.name, r.result, facts.address) }));
      if (cfg.ownMint && facts.address === cfg.ownMint) return { facts, own: true };
      if (facts.calls.length > 0 && facts.calls.every((c) => !c.ok && c.error !== "not_found")) {
        log("harness: scan got nothing", { calls: facts.calls.length });
        return null;
      }
      log("harness: scan", { kind: facts.kind, chain: facts.chain, by: facts.resolved, calls: facts.calls.length, flags: facts.flags.length, ms: now() - (deadline - cfg.answerMs) });
      return { facts };
    } catch (err) {
      log("harness: scan failed", { error: String(err).slice(0, 200) });
      return null;
    }
  }

  async function ask(q: Question): Promise<Answer> {
    const t0 = now();
    const deadline = t0 + cfg.answerMs - ASK_MARGIN_MS;
    const signal = q.signal;
    const step = (name: string, phase: "start" | "end"): void => {
      try {
        q.onStep?.(name, phase);
      } catch {
        // a status line never breaks an answer
      }
    };
    const question = sanitizeChatQuestion(q.question);
    const chat = sanitizeChat(q.chat ?? {});
    const canned = (answer: string): Answer => ({ answer, sources: [], followups: [], by: "canned", tools: [], ms: now() - t0 });
    if (!question) return canned("ask me something.");
    if (!cfg.llm.model || !cfg.llm.apiKey) return canned("my model is not connected: set LLM_API_KEY and LLM_MODEL.");

    const specs = specsNow();
    const asked = chat.history.filter((t) => t.role === "user").map((t) => t.content);
    // the question's kind: code's read, then Jev's where code is unsure (a short follow-up, another language)
    const read0 = harnessRead(question, asked);
    let intents: HarnessIntent[] = read0.intents;
    if (!read0.strong && cfg.jevKey && specs.length > 0 && !smallTalk(question)) {
      const pick = await jevIntent(question, asked.at(-1) ?? null, { key: cfg.jevKey, general: true }, doFetch);
      log("harness: jev", pick ? { intent: pick.intent, confidence: Math.round(pick.confidence * 100) / 100, ms: pick.ms } : { intent: null });
      if (pick) intents = pick.intent === "general" ? (read0.brushed.length > 0 ? read0.brushed : ["general"]) : [...new Set([pick.intent as HarnessIntent, ...read0.brushed])].slice(0, 2);
    }

    // a coin the question names gets its dossier; a follow-up that names none, the coin of the earlier question
    const scanWanted = specs.length > 0 ? scanAskOf(question, "", { named: true }) : null;
    const followUp = !scanWanted && specs.length > 0 ? coinInView(question, intents, asked) : null;
    const scanAsk = scanWanted ?? (followUp ? scanAskOf(question, followUp, { named: true }) : null);
    // the scan's calls end with the answer: nobody reads them after it
    const answered = new AbortController();
    const scanSignal = signal ? AbortSignal.any([signal, answered.signal]) : answered.signal;
    const deep = intents.some((i) => i === "token" || i === "caller" || i === "wallet");
    const scanning: Promise<ScanInput | null> = scanAsk ? scanFor(scanAsk, specs, deadline, { signal: scanSignal, deep, onCall: step }) : Promise.resolve(null);

    // the posts on x a question about what people say needs, read by code beside the dossier: at once by the question's
    // cashtag, else once the dossier names the coin's ticker; one not back when the model starts is named to it as running,
    // so its own call with the same arguments joins it
    const xOffered = specs.some((t) => t.name === "social_mentions");
    let xStarted: PlanRead | null = null;
    let xBack = false;
    const xRun = async (r: PlanRead): Promise<PlanRead> => {
      xStarted = { name: r.name, args: r.args };
      const cap = AbortSignal.timeout(Math.max(1, Math.min(X_READ_MS, deadline - now() - SCAN_RESERVE_MS)));
      let result: ToolResult | undefined;
      try {
        result = await tools.run(r.name, r.args, { answerId: `${randomUUID()}:plan:x`, signal: AbortSignal.any([scanSignal, cap]) });
      } catch {
        result = undefined;
      }
      xBack = true;
      return { ...r, ...(result ? { result } : {}) };
    };
    const xEarly = xOffered ? xReadOf(question) : null;
    const xReading: Promise<PlanRead | null> = !xOffered
      ? Promise.resolve(null)
      : xEarly
        ? xRun(xEarly)
        : scanning.then((s) => {
            const r = s?.facts.kind === "token" ? xReadOf(question, s.facts.symbol, s.facts.name ?? null) : null;
            return r ? xRun(r) : null;
          });

    /**
     * The plan once the scan is in: what the scan found decides between a coin and a wallet (a bare address read as a coin
     * that is a wallet gets the wallet's functions; a coin's address asked about in a wallet's words leads with the coin's;
     * any other question about a scanned coin gets the coin's functions beside its own)
     */
    const planOf = (scan: ScanInput | null): HarnessPlan => {
      const kind = scan?.facts.kind;
      const kinds: HarnessIntent[] =
        kind === "wallet" && intents[0] === "token"
          ? ["wallet", ...intents.slice(1)]
          : kind !== "token" || intents.includes("token")
            ? intents
            : intents[0] === "wallet" && scanAsk === scanWanted
              ? (["token", ...intents] as HarnessIntent[]).slice(0, 2)
              : [intents[0]!, "token"];
      const planned = harnessPlan(kinds, specs.map((t) => t.name), question);
      const p = scan?.own ? { ...planned, facts: true } : planned;
      log("harness: plan", { intents: p.intents.join("+"), tools: p.tools.length, calls: p.maxCalls, effort: p.effort, scan: kind ?? "none", deep });
      return p;
    };

    /** A coin's deeper reads waited for (DEEP_WAIT_MS at most), each landing in the dossier as it comes back */
    const deepSettled = async (s: ScanInput | null): Promise<void> => {
      const d = s?.facts.deep;
      if (!s || !d) return;
      const running = () => (Object.keys(DEEP_TOOLS) as (keyof typeof DEEP_TOOLS)[]).some((k) => d[k] === "running");
      const until = Date.now() + Math.max(0, Math.min(DEEP_WAIT_MS, deadline - now() - SCAN_RESERVE_MS));
      while (running() && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
      settleDeep(s.facts);
    };

    /**
     * A larp check's first wave, read by code before the model starts: the coin's own links and words (project_links),
     * then at once its code's record, its site's age, its site's page, its x account, the posts on x that test its story
     * and the news of its site, then the transactions its site shows looked up on the chain; the ok ones join the plan's
     * reads with code's cross-checks of them (larpChecks)
     */
    const larpReads = async (mint: string, offeredTools: readonly string[]): Promise<PlanRead[]> => {
      if (!offeredTools.includes("project_links")) return [];
      const id = `${randomUUID()}:larp`;
      const until = Date.now() + Math.max(1, Math.min(LARP_READ_MS, deadline - now() - SCAN_RESERVE_MS));
      const read = async (name: string, args: Record<string, unknown>, i: number): Promise<PlanRead> => {
        const cap = AbortSignal.timeout(Math.max(1, until - Date.now()));
        try {
          const result = await tools.run(name, args, { answerId: `${id}:${name}:${i}`, signal: signal ? AbortSignal.any([signal, cap]) : cap });
          return { name, args, result };
        } catch {
          return { name, args };
        }
      };
      const links = await read("project_links", { mint }, 0);
      const d = links.result?.ok && isRec(links.result.data) ? links.result.data : null;
      const list = (k: string) => (d && Array.isArray(d[k]) ? (d[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
      const site = d && Array.isArray(d.links) ? (d.links as Record<string, unknown>[]).find((l) => l && l.kind === "website" && typeof l.url === "string")?.url : undefined;
      const offered = (n: string) => offeredTools.includes(n);
      const symbol = d && typeof d.symbol === "string" && /^[A-Za-z0-9]{1,12}$/.test(d.symbol) ? d.symbol.toUpperCase() : null;
      const launch = d && typeof d.created_at === "string" ? Date.parse(d.created_at) : NaN;
      const own = list("x_handles");
      const storyBy = (d && Array.isArray(d.x_posts) ? (d.x_posts as Record<string, unknown>[]) : [])
        .map((x) => x.by)
        .find((b): b is string => typeof b === "string" && /^[A-Za-z0-9_]{1,15}$/.test(b) && !own.some((h) => h.toLowerCase() === b.toLowerCase()));
      // the back-link: did the account its story's post is by ever name the coin (a borrowed story: never); with no such
      // post, what the coin's own account says since a week before the launch
      const xQuery = storyBy ? `from:${storyBy} (${[symbol ? `$${symbol}` : null, mint].filter(Boolean).join(" OR ")})` : own[0] ? `from:${own[0]}` : null;
      const since = Number.isFinite(launch) ? new Date(launch - (storyBy ? 1 : 7) * 86_400_000).toISOString().slice(0, 10) : null;
      const domain = list("site_domains")[0];
      const next = await Promise.all([
        ...list("github")
          .slice(0, 2)
          .map((g, i) => (offered("github_repo") ? read("github_repo", { repo: g, mint }, i) : null)),
        offered("site_age") && domain ? read("site_age", { site: domain }, 0) : null,
        offered("page_snapshot") && typeof site === "string" ? read("page_snapshot", { url: site }, 0) : null,
        offered("x_account") && own[0] ? read("x_account", { handle: own[0], mint }, 0) : null,
        offered("social_mentions") && xQuery ? read("social_mentions", { query: `${xQuery}${since ? ` since:${since}` : ""}`, sort: storyBy ? "Top" : "Latest", min_likes: 0 }, 0) : null,
        offered("news_pages") && domain ? read("news_pages", { query: `"${domain}"`, topic: "general", max_results: 5 }, 0) : null,
      ]);
      const reads = [links, ...next.filter((r): r is PlanRead => r !== null)];
      // a site that sends its visitors to another site: that site's page, once (the redirect itself a fact for the checks)
      const sitePage = reads.find((r) => r.name === "page_snapshot");
      const away = sitePage?.result && !sitePage.result.ok ? /redirects to (https?:\/\/\S+) \(another site\)/.exec(sitePage.result.message)?.[1] : undefined;
      if (away) reads.push(await read("page_snapshot", { url: away }, 1));
      // the transactions its site shows, on the chain or never seen there (a made-up feed of "live" trades)
      const page = reads.find((r) => r.name === "page_snapshot" && r.result?.ok);
      const shown = page?.result?.ok && isRec(page.result.data) ? page.result.data.signatures : undefined;
      const sigs = Array.isArray(shown) ? shown.filter((s): s is string => typeof s === "string").slice(0, 2) : [];
      const txs: SiteTx[] = await Promise.all(
        sigs.map(async (signature, i) => {
          const r = await read("sol_balance_changes", { signature }, i);
          return { signature, onChain: r.result?.ok ? true : r.result?.ok === false && r.result.error === "not_found" ? false : null };
        }),
      );
      const crossed = larpChecks(mint, reads, txs);
      const checks = away ? { site_redirects_to: away, ...(crossed ?? {}) } : crossed;
      // a read that found nothing is a fact of the check: a coin no launchpad lists, a repository or an x account gone
      const found = reads.flatMap((r): PlanRead[] =>
        r.result?.ok ? [r] : r.result?.error === "not_found" ? [{ ...r, result: { ok: true as const, data: { not_found: true, note: r.result.message || "nothing found" }, sources: [] } }] : [],
      );
      return [...found, ...(checks ? [{ name: "larp_checks", args: {}, result: { ok: true as const, data: checks, sources: [] } }] : [])];
    };
    // the larp check's first wave starts beside the scan, not after it
    const larpOffered = intents.includes("larp") ? harnessPlan(["larp"], specs.map((t) => t.name), question).tools : null;
    const larpEarly: Promise<PlanRead[]> = !larpOffered
      ? Promise.resolve([])
      : scanAsk?.family === "solana" && scanAsk.address
        ? larpReads(scanAsk.address, larpOffered)
        : scanning.then((s) => (s?.facts.kind === "token" && s.facts.chain === "solana" && s.facts.address ? larpReads(s.facts.address, larpOffered) : []));
    larpEarly.catch(() => {});

    /** The plan's reads at once (PLAN_READ_MS at most), the ok ones onto the plan; the x read and the larp wave joined */
    const withReads = async (p: HarnessPlan, scan: ScanInput | null): Promise<HarnessPlan> => {
      const metas = scan?.facts.deep?.metas;
      const inDossier = (name: string): boolean => name === "meme_metas" && metas !== undefined && metas !== null && metas !== "running";
      const want = planReads(p.intents).filter((r) => specs.some((t) => t.name === r.name) && !inDossier(r.name));
      const [xr, larp] = await Promise.all([
        p.tools.includes("social_mentions") ? Promise.race([xReading, new Promise<null>((r) => setTimeout(() => r(null), X_READ_JOIN_MS).unref?.())]) : Promise.resolve(null),
        p.intents.includes("larp") ? larpEarly : Promise.resolve([] as PlanRead[]),
      ]);
      const early: PlanRead[] = [...(xr?.result?.ok ? [xr] : []), ...larp];
      const started: PlanRead | null = xStarted;
      const running: PlanRead[] = !xr && !xBack && started !== null && p.tools.includes("social_mentions") ? [started] : [];
      const id = `${randomUUID()}:plan`;
      const reads: PlanRead[] = await Promise.all(
        want.map(async (r, i) => {
          const cap = AbortSignal.timeout(Math.max(1, Math.min(PLAN_READ_MS, deadline - now() - SCAN_RESERVE_MS)));
          try {
            return { ...r, result: await tools.run(r.name, r.args, { answerId: `${id}:${r.name}:${i}`, signal: signal ? AbortSignal.any([signal, cap]) : cap }) };
          } catch {
            return { ...r };
          }
        }),
      );
      const ok = [...early, ...reads.filter((r) => r.result?.ok)];
      return { ...p, ...(ok.length > 0 ? { reads: ok } : {}), ...(running.length > 0 ? { running } : {}) };
    };

    try {
      step("thinking", "start");
      const scan = await scanning;
      await deepSettled(scan);
      const plan = await withReads(planOf(scan), scan);
      const offered = specs.filter((t) => plan.tools.includes(t.name));
      const budget = deadline - now();
      const reserve = Math.max(0, Math.min(WRITE_RESERVE_MS, Math.floor(budget / 3)));
      const brainTools: BrainTools | null =
        offered.length > 0
          ? {
              module: tools,
              specs: offered,
              answerId: randomUUID(),
              maxCalls: plan.maxCalls,
              leash: (name: string) => (SLOW_TOOLS.includes(name) ? SLOW_AFTER_QUICK_MS : null),
              reserve,
              callMs: () => TOOL_CALL_MS,
              onCall: step,
            }
          : null;
      const input: AskInput = {
        question,
        status: { now: nowLine(now()), about: cfg.about },
        tools: brainTools,
        ...(scan ? { scan } : {}),
        harness: { history: chat.history, texts: chat.texts, plan },
      };
      const r: BrainResult = await brainAnswer({ ...cfg.llm, timeoutMs: Math.max(1000, deadline - now()) }, input, doFetch, now, signal ? AbortSignal.any([signal]) : undefined);
      step("thinking", "end");
      answered.abort();
      const fromScan = (scan?.facts.calls ?? []).filter((c) => c.ok).map((c) => c.tool);
      if (r.ok) {
        // the dossier's token block with what its risk checks left running brought since the prompt was built, then the
        // holder map code draws from the chain's holder links
        const keep = new Set<string>();
        const coin: ScanFacts | null = scan?.facts ?? null;
        let text = scan ? withLateChecks(r.answer, scan.facts) : r.answer;
        const mint = coin && coin.kind === "token" && coin.chain === "solana" ? coin.address : null;
        text = await withClusters(text, randomUUID(), tools, mint, { ...(signal ? { signal } : {}), ms: Math.max(1_500, Math.min(CLUSTERS_FILL_MS, deadline - now())), keep });
        log("harness: answered", { by: "model", calls: (r.calls ?? []).length, ms: now() - t0 });
        return {
          answer: redact(text, keep),
          sources: linksOf(r.data ?? []),
          followups: (r.followups ?? []).map((f) => redact(f)).filter((f) => f && f !== "..."),
          by: "model",
          tools: [...new Set([...fromScan, ...(r.calls ?? []).map((c) => c.tool)])],
          ms: now() - t0,
        };
      }
      log("harness: model failed", { error: r.error, attempts: r.attempts, ms: now() - t0 });
      if (signal?.aborted) return canned("...");
      // people never get a bare failure: code writes a short answer from what is in hand (the dossier, or what the model's
      // rounds fetched), with the data links behind it
      const fetched: Prefetched[] = r.fetched ?? [];
      const brief = scan ? scanBrief(scan.facts) : dataBrief(fetched);
      if (!brief) return canned("i couldn't put a full answer together just now. ask me again in a minute.");
      const results = [...(scan?.facts.results ?? []).map((x) => x.result), ...fetched.map((p) => p.result)];
      return { answer: redact(brief), sources: linksOf(answerSources(results, brief)), followups: [], by: "code", tools: [...new Set([...fromScan, ...fetched.map((p) => p.name)])], ms: now() - t0 };
    } catch (err) {
      log("harness: answer failed", { error: String(err).slice(0, 200) });
      return canned("i couldn't put a full answer together just now. ask me again in a minute.");
    } finally {
      answered.abort();
    }
  }

  return { ask };
}

