// A coin's dossier. Code, not the model, decides that a question names a coin or a wallet (scanAskOf: an address or a
// ticker in the question), fetches the core of it at once (runScan: the token on the chain, its pools, its holders by
// kind, its creator, all in parallel, each call capped), reads deeper beside it (its launch, holder links, story) and
// levels each finding on the one severity scale; the model builds its answer on it. Nothing here invents a number: a
// line is said only from a value a source returned, and never one that cannot be true (marketDoubts: DEX Screener lists copies and fakes
// with fake liquidity and wash volume). A solana ticker is the token Jupiter verified with that symbol
// (sol_ticker_mint), DEX Screener's most traded one only when there is none. Token names and symbols come from listings
// anyone can write: only letters and digits of a symbol are ever printed.

import type { Severity, ToolResult } from "@crawlnet/shared";
import { blockStatus, byShare, SEVERITY, SEVERITY_ORDER, severityOf, verdictLevel, worst } from "@crawlnet/shared";
import type { ToolCallLog } from "./brain.ts";
import { clusterOf, creatorRead, DEV_MAJORITY_PCT, devGone, devTrailOf, launchParts, sideWallets, spreadOf, storyOf, type DevRead } from "./trench.ts";

/** What a question asks to scan: an address (with its chain) or a ticker, and what the asker cares about most. */
export interface ScanAsk {
  /** A Solana address (a mint or a wallet) or an EVM contract, as written */
  address: string | null;
  /** A ticker without its "$", lower case (only without an address) */
  ticker: string | null;
  /** "solana" for a base58 address, "evm" for 0x, null for a ticker */
  family: "solana" | "evm" | null;
  /** A chain the question names (DEX Screener's id: solana, ethereum, base, bsc, arbitrum, polygon, optimism, avalanche) */
  chain: string | null;
  /** Where the address or ticker was found: the question, or the earlier question it follows (`post`) */
  from: "question" | "post";
  /** The question asks about the dev / creator (did the dev sell, a serial launcher) */
  dev: boolean;
  /** The question asks about holders */
  holders: boolean;
  /** The question asks about the launch (cabal, insiders, early buyers, organic or not; absent: it does not) */
  launch?: boolean;
}

/** A Solana address in text: base58, 32-44 characters, with digits and both cases or a launchpad ending ("…pump"). */
const SOL_ADDRESS = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const solLike = (s: string): boolean => (/\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) || /(?:pump|bonk|moon)$/.test(s);
const EVM_ADDRESS = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
/** A cashtag: "$BONK", "$wif" (letters first, 2-10 characters). */
const CASHTAG = /(?<![\p{L}\p{N}_$＄])[$＄]([A-Za-z][A-Za-z0-9]{1,9})(?![\p{L}\p{N}_])/gu;
/** The words that ask for a scan (a bare contract address gets no scan). Honeypot is asked as "scam?" too. */
const ASK = /(?<![\p{L}\p{N}_])(?:scan\w*|rug\w*|legit\w*|safe(?:ty)?|scam\w*|honey\s?pot\w*)(?![\p{L}\p{N}_])/iu;
const DEV_WORDS = /(?<![\p{L}\p{N}_])(?:devs?|deployer|creator|team\s+wallet|sold|sell(?:ing)?|dump(?:ed|ing)?|serial|launcher|launches)(?![\p{L}\p{N}_])/iu;
const HOLDER_WORDS = /(?<![\p{L}\p{N}_])(?:holders?|holds|holding|top\s?10|whales?|distribution|bundled?|bundles|snipers?|concentrat\w*)(?![\p{L}\p{N}_])/iu;
/** Words that ask about a coin's launch: who bought it first and whether they were one group */
const LAUNCH_WORDS = /(?<![\p{L}\p{N}_])(?:launch(?:ed)?|cabal|insiders?|early\s+buyers?|first\s+buyers?|organic|sniped)(?![\p{L}\p{N}_])/iu;
/** Chains a question names, as DEX Screener calls them. */
const CHAIN_WORDS: [RegExp, string][] = [
  [/(?<![\p{L}\p{N}_])(?:sol|solana)(?![\p{L}\p{N}_])/iu, "solana"],
  [/(?<![\p{L}\p{N}_])(?:eth|ethereum|mainnet|erc-?20)(?![\p{L}\p{N}_])/iu, "ethereum"],
  [/(?<![\p{L}\p{N}_])base(?:\s+chain)?(?![\p{L}\p{N}_])/iu, "base"],
  [/(?<![\p{L}\p{N}_])(?:bsc|bnb\s+chain|bnb|bep-?20)(?![\p{L}\p{N}_])/iu, "bsc"],
  [/(?<![\p{L}\p{N}_])(?:arb|arbitrum)(?![\p{L}\p{N}_])/iu, "arbitrum"],
  [/(?<![\p{L}\p{N}_])(?:polygon|matic)(?![\p{L}\p{N}_])/iu, "polygon"],
  [/(?<![\p{L}\p{N}_])optimism(?![\p{L}\p{N}_])/iu, "optimism"],
  [/(?<![\p{L}\p{N}_])(?:avax|avalanche)(?![\p{L}\p{N}_])/iu, "avalanche"],
];
/** A post or question that hands out an address to send funds to, or a giveaway, airdrop or claim: a claim to check, no scan. */
const GIVEAWAY = /(?<![\p{L}\p{N}_])(?:send|deposit|transfer)\b[^.!?\n]{0,120}\b(?:get|receive|back|double|2x|return)|(?<![\p{L}\p{N}_])(?:giveaway|give\s?away|airdrop|claim\s+(?:your|yours|it|now|here|free|the))(?![\p{L}\p{N}_])/iu;
/** Tickers that are no token to scan: stablecoins and the majors (a scan of $SOL or $USDC answers nothing asked). */
const NOT_SCANNED = new Set(["btc", "eth", "sol", "usdc", "usdt", "usd", "bnb", "xrp", "dai", "wbtc", "weth", "wsol"]);

function addressIn(text: string): { address: string; family: "solana" | "evm" } | null {
  const evm = text.match(EVM_ADDRESS);
  const sol = [...text.matchAll(SOL_ADDRESS)].map((m) => m[0]).find(solLike);
  // the first one written
  const ie = evm ? text.indexOf(evm[0]) : -1;
  const is = sol ? text.indexOf(sol) : -1;
  if (ie >= 0 && (is < 0 || ie < is)) return { address: evm![0], family: "evm" };
  if (is >= 0) return { address: sol!, family: "solana" };
  return null;
}

function tickerIn(text: string): string | null {
  for (const m of text.matchAll(CASHTAG)) {
    const t = m[1]!.toLowerCase();
    if (!NOT_SCANNED.has(t)) return t;
  }
  return null;
}

/**
 * What a question asks to scan, or null when it is no scan: an address in the question, else a ticker in it ("scan
 * $BONK", "is $WIF safe", "check $BRETT on base"), else an address or a ticker in `post` (the earlier question a
 * follow-up is about: harness.ts coinInView). Without `named` only a question with a scan word (rug, scan, legit, safe,
 * scam, honeypot) is scanned; with it, any question that names a coin. Never a giveaway, an airdrop or a claim page (a
 * scam to call out, not a wallet to scan); never the majors or stablecoins by ticker.
 */
export function scanAskOf(question: string, post = "", o: { named?: boolean } = {}): ScanAsk | null {
  const q = typeof question === "string" ? question.normalize("NFKC") : "";
  const p = typeof post === "string" ? post.normalize("NFKC") : "";
  // a giveaway or a claim page is checked as a claim ("send 1 sol, get 2 back" is a scam, not a wallet to scan)
  if (GIVEAWAY.test(q) || GIVEAWAY.test(p)) return null;
  const chainOf = (text: string): string | null => CHAIN_WORDS.find(([re]) => re.test(text))?.[1] ?? null;
  const base = { dev: DEV_WORDS.test(q), holders: HOLDER_WORDS.test(q), ...(LAUNCH_WORDS.test(q) ? { launch: true } : {}) };
  // no scan word, no scan: a bare address, "dev?", "holders?" or "check $X" go to the model and its functions; `named`
  // scans a coin the question names whatever its words (code's dossier before the model starts)
  if (!ASK.test(q) && !o.named) return null;
  const inQ = addressIn(q);
  if (inQ) return { ...base, address: inQ.address, ticker: null, family: inQ.family, chain: inQ.family === "solana" ? "solana" : chainOf(q), from: "question" };
  const tq = tickerIn(q);
  if (tq) return { ...base, address: null, ticker: tq, family: null, chain: chainOf(q), from: "question" };
  // in the earlier question: its address, else its ticker
  const inP = addressIn(p);
  if (inP) return { ...base, address: inP.address, ticker: null, family: inP.family, chain: inP.family === "solana" ? "solana" : (chainOf(q) ?? chainOf(p)), from: "post" };
  const tp = tickerIn(p);
  if (tp) return { ...base, address: null, ticker: tp, family: null, chain: chainOf(q) ?? chainOf(p), from: "post" };
  return null;
}

/** The deeper reads of a solana token, as the dossier shows them (ScanFacts.deep) */
interface ScanDeep {
  /** sol_launch: the dev, the creation slot's bundle, the first-minute snipers; absent for a coin too old to read it */
  launch?: Record<string, unknown> | null | "running";
  /**
   * The launch read was its first page alone (sol_launch first_page: the dev, the creation block's bundle, the earliest
   * snipers, 10 credits): the question asked nothing about the dev, the holders or the launch; the model's own call
   * with the same arguments joins it
   */
  screen?: boolean;
  /** sol_holder_links: the top holders tied by a funder or by transfers */
  links?: Record<string, unknown> | null | "running";
  /**
   * sol_holder_spread: past the top holders, the band of 0.1-1% wallets and who made a sample of them (a cabal spread
   * thin); read for a young coin, as the launch is
   */
  spread?: Record<string, unknown> | null | "running";
  /** meme_narrative: its story as the narrative index labelled it */
  narrative?: Record<string, unknown> | null | "running";
  /** meme_metas: what migrates now, by group and narrative */
  metas?: Record<string, unknown> | null | "running";
  /**
   * sol_token_origin: the creator, what it got at creation and holds now, for a young coin or a question about the dev:
   * the dossier's dev when the launch read is down or still running
   */
  origin?: Record<string, unknown> | null | "running";
  /** ct_calls: who on crypto twitter called it and when (the CT radar) */
  calls?: Record<string, unknown> | null | "running";
  /** x_ideas: the ideas on x its ticker rides, with their stage (the X radar) */
  ideas?: Record<string, unknown> | null | "running";
  /**
   * sol_money_trail on the dev, read once the creator read or the launch read says its bag left its wallet (devTrail):
   * where it went; absent for a dev still holding, or none named
   */
  trail?: Record<string, unknown> | null | "running";
  /** The dev's wallet the trail reads (the first of the creator read and the launch read to name its bag gone) */
  devWallet?: string;
  /**
   * Her memory of wallets (walletmem.ts): where the wallets its launch and holder reads name were seen in earlier coins,
   * as lines a role; absent when none was seen or the memory was not asked
   */
  memory?: string[];
}

/**
 * The deeper reads of a solana token wait this long at most, beside its risk checks (the launch, the holder links, the
 * story and today's metas, read by code before the model starts so its first round goes deeper): the links come back in
 * about 2.5 s, the story in about 2 s once its reader is warm; the launch takes 20 s and more, and a read not back runs
 * on for the model's own call to join
 */
const SCAN_DEEP_MS = 6_000;
/** A deeper read's cap (it runs on past the scan; the tools layer keeps what it returns) */
const SCAN_DEEP_CALL_MS = 60_000;

/** One call of a scan, as runScan makes it: the result (never throws) and its log line. */
export type ScanCall = (name: string, args: Record<string, unknown>, ms: number) => Promise<{ result: ToolResult; log: ToolCallLog }>;

/** What the scan found, read from the results by code (each value as a source returned it, or null). */
export interface ScanFacts {
  /** "token" (a mint or a contract with pools), "wallet", "other" (a program, a token account…), "none" (nothing found) */
  kind: "token" | "wallet" | "other" | "none";
  chain: string | null;
  /** Letters and digits only, lower case (listings are anyone's text) */
  symbol: string | null;
  /** Its name as DEX Screener lists it, letters, digits and spaces only (coinName): the posts search's other word */
  name?: string | null;
  resolved: "address" | "ticker";
  /**
   * How a ticker was resolved: "verified" = Jupiter's verified token with exactly that symbol (sol_ticker_mint), "dex" =
   * the most traded token with exactly that symbol on DEX Screener (the fallback: copies and fakes are listed there too);
   * null for an address.
   */
  via: "verified" | "dex" | null;
  /** The address scanned (for the model's follow-up calls; never printed: the reply guard holds addresses) */
  address: string | null;
  market: {
    priceUsd: number | null;
    mcapUsd: number | null;
    fdvUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    pools: number | null;
    oldestPoolAgeDays: number | null;
    buys24h: number | null;
    sells24h: number | null;
    /** Still on a launchpad's bonding curve (its only pool is the curve) */
    curve: boolean;
  } | null;
  /** Solana mint: "revoked" or "on" */
  authorities: { mint: "revoked" | "on"; freeze: "revoked" | "on" } | null;
  /**
   * A solana mint's token program (sol_account_basics' mint.token_2022): a classic spl mint can charge no transfer tax
   * and run no transfer hook; a token-2022 mint may do both
   */
  program: "spl" | "token-2022" | null;
  /** A token-2022 mint's extensions as the chain lists them (sol_account_basics): what the flags leave unsaid, they settle */
  ext?: { fee: boolean; feePct: number | null; hook: boolean; permanentDelegate: boolean; nonTransferable: boolean } | null;
  /**
   * What the risk flags (token_risk_flags) said that the token block shows (readSecurity): an evm contract's honeypot and
   * taxes; a solana mint's transfer fee (taxed), transfer hook, non-transferable and balance authority (token-2022
   * extensions); the pool's lp lock. Null each when not said
   */
  security: {
    honeypot: boolean | null;
    taxed: boolean | null;
    hook: boolean | null;
    nonTransferable: boolean | null;
    balanceMutable: boolean | null;
    lpLocked: boolean | null;
    /** The locked or burned share of the lockable pools' liquidity (lp_locked_pct_lockable), else of all pools', % */
    lpLockedPct?: number | null;
    /**
     * RugCheck's reads a trencher checks first: the coins its creator made before (creator_other_tokens), the insider
     * wallets it detects (insider_wallets_detected, else insiders_in_top_holders), and whether it marks the coin rugged
     */
    creatorOther?: number | null;
    insiders?: number | null;
    rugged?: boolean | null;
  } | null;
  /**
   * The largest holders (sol_largest_accounts); `equalBags`: five wallets or more among them holding the same bag
   * (within EQUAL_BAG_SPREAD of each other): one hand split its supply
   */
  holders: { top10Pct: number | null; top10WalletsPct: number | null; largestWalletPct: number | null; programPct: number | null; equalBags?: { wallets: number; pctEach: number } | null } | null;
  /** The creator read (sol_token_origin): its age, what the creator got at creation and holds now, and the creator's address (the dev's side wallets are found by it) */
  dev: { found: true; ageDays: number | null; gotPct: number | null; holdsPct: number | null; creator?: string | null } | { found: false; why: string } | null;
  wallet: { sol: number | null; lastTxAgoMin: number | null; recentTxs: number; spanMin: number | null } | null;
  /** Red flags in code's words ("mint authority still on", "top 10 wallets hold 41%") */
  flags: string[];
  /** The strongest facts in code's words ("mint and freeze authority revoked") */
  goods: string[];
  /** What else code knows ("its dev sold or moved all of the 3.5% it got at launch") */
  notes: string[];
  /**
   * Why the market's dollar numbers were left out (marketDoubts: they cannot be true): "cap", "liquidity", "deep",
   * "idle"; [] when they stand. Logged as these words only, never a value.
   */
  unreliable: string[];
  /**
   * The deeper reads of a solana token (ScanOptions.deep): each one's data, null when it failed, "running" when it was
   * not back by the scan's end (it runs on: the model's own call of it joins it); absent when not asked
   */
  deep?: ScanDeep;
  /** What each call returned, for the model's data (untrusted) */
  results: { name: string; args: Record<string, unknown>; result: ToolResult }[];
  calls: ToolCallLog[];
}

/** Per call of a scan, at most (its own timeout; a slow source never holds the answer). */
const SCAN_CALL_MS = 10_000;
/** sol_token_origin reads up to five pages of history and a transaction: a little longer. */
const SCAN_ORIGIN_MS = 14_000;
/**
 * A call the scan leaves running (a solana token's risk flags, the lp lock read in their place): the answer does not
 * wait for it, and the model's own call of it (same function, same arguments) joins it or reads it from the tools
 * layer's cache.
 */
const SCAN_BEHIND_MS = 150_000;
/**
 * A call left running that is back already or nearly gets this moment at the scan's read; later ones are read when
 * they land (runScan whenBack).
 */
const SCAN_LAND_MS = 300;
/** A launchpad's mint: pump.fun's and bonk.fun's addresses end in their name, so the address is a token's before any read. */
const KNOWN_MINT = /(?:pump|bonk)$/;
/** A token is young enough for its creator to be looked up when its oldest pool is at most this old (or the dev is asked about). */
const SCAN_DEV_MAX_AGE_DAYS = 30;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const okData = (r: ToolResult | undefined): Record<string, unknown> | null => (r && r.ok && isObj(r.data) ? r.data : null);

/** A coin's name for a search: letters, digits and single spaces, 3-40 characters, else null (listings are anyone's text) */
function coinName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFKC").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return s.length >= 3 && s.length <= 40 ? s : null;
}

/** A symbol as it may be printed: letters and digits of it, lower case, 12 at most; null when nothing is left. */
function cleanSymbol(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  return s.length >= 1 ? s : null;
}

/** How runScan runs (all off by default: every call is waited for). */
export interface ScanOptions {
  /** The inner scan of a trading pair's token (it never looks for a pair again) */
  viaPair?: boolean;
  /**
   * A solana token's risk flags (SCAN_BEHIND_MS) and its creator lookup are asked but not waited for: the answer starts
   * once the chain and the listings are read; what they return is read only when it is back by then
   */
  behind?: boolean;
  /**
   * With `behind`: a solana token's launch (a young one's, or on a question about its dev), holder links, story and
   * today's metas are read beside its risk checks, SCAN_DEEP_MS at most (ScanFacts.deep)
   */
  deep?: boolean;
  /**
   * Her memory of wallets: the coin's launch and holder reads in, the lines saying where their wallets were seen before
   * out (ScanDeep.memory)
   */
  memory?: (mint: string, reads: { launch: Record<string, unknown> | null; links: Record<string, unknown> | null }) => string[];
}

/**
 * Runs the scan of `ask` (each call through `call`, capped; the calls of a stage in parallel) and reads what came back.
 * `has`: the functions this answer may use (those offered): a scan never calls one outside it. A ticker on solana or
 * with no chain named is the token Jupiter verified with exactly that symbol (verifiedPick), else, and on an evm chain,
 * the most traded token with exactly that symbol on DEX Screener. An address that is a trading pair's (a pasted DEX
 * Screener link) is scanned as the pair's token (ScanOptions.viaPair). Never throws.
 */
export async function runScan(ask: ScanAsk, call: ScanCall, has: (name: string) => boolean, nowMs: number, opts: ScanOptions = {}): Promise<ScanFacts> {
  const viaPair = opts.viaPair === true;
  const behind = opts.behind === true;
  const facts: ScanFacts = {
    kind: "none",
    chain: ask.family === "solana" ? "solana" : ask.chain,
    symbol: null,
    resolved: ask.address ? "address" : "ticker",
    via: null,
    address: ask.address,
    market: null,
    authorities: null,
    program: null,
    security: null,
    holders: null,
    dev: null,
    wallet: null,
    flags: [],
    goods: [],
    notes: [],
    unreliable: [],
    results: [],
    calls: [],
  };
  /** The scan's data is what its calls return before it is done (a call left running past it changes only its facts: whenBack) */
  let reading = true;
  const run = async (name: string, args: Record<string, unknown>, ms = SCAN_CALL_MS): Promise<ToolResult | undefined> => {
    if (!has(name)) return undefined;
    try {
      const { result, log } = await call(name, args, ms);
      if (reading) {
        facts.results.push({ name, args, result });
        facts.calls.push(log);
      }
      return result;
    } catch {
      return undefined;
    }
  };
  /**
   * A solana token's risk flags, never waited for (the evm path asks them already). Asked for SCAN_BEHIND_MS, its
   * caller released with the answer; the model's own call of it joins it
   */
  // the risk flags out, the lp lock read from the chain in their place, its shares in the flags' own keys
  const runFlags = (address: string): Tracked<ToolResult | undefined> | null =>
    behind
      ? tracked(
          run("token_risk_flags", { address, chain: "solana" }, SCAN_BEHIND_MS).then(async (r) => {
            if (r?.ok) return r;
            const chain = await run("sol_lp_lock", { mint: address }, SCAN_BEHIND_MS);
            return chain?.ok ? chain : r;
          }),
        )
      : null;
  /** What a call returned: waited for, or with `behind` (a call left running: the creator) only if back */
  const landed = async (r: Tracked<ToolResult | undefined>): Promise<ToolResult | undefined> => (behind && !r.settled() ? undefined : await r.promise);
  /**
   * A call left running is read whenever it lands: during the scan into its facts and data, after it into its facts
   * only, from which the token block the answer ends with is built again (withLateChecks)
   */
  const whenBack = (r: Tracked<ToolResult | undefined>, read: (d: Record<string, unknown> | null) => void): void => {
    void r.promise.then((res) => read(okData(res)));
  };
  /** With `behind`, SCAN_LAND_MS for calls left running that are not back yet (a quick or cached answer lands meanwhile) */
  const moment = async (rs: (Tracked<ToolResult | undefined> | null)[]): Promise<void> => {
    const pending = rs.filter((r): r is Tracked<ToolResult | undefined> => r !== null && !r.settled());
    if (!behind || pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(pending.map((r) => r.promise)), new Promise<void>((res) => (timer = setTimeout(res, SCAN_LAND_MS)))]);
    clearTimeout(timer);
  };
  /**
   * A token's risk flags are read when they land (whenBack), after a moment for those nearly back (`others` too: the
   * creator lookup)
   */
  const readChecks = async (flagged: Tracked<ToolResult | undefined> | null, ...others: (Tracked<ToolResult | undefined> | null)[]): Promise<void> => {
    if (!behind) return;
    if (flagged) whenBack(flagged, (d) => readSecurity(facts, d));
    await moment([flagged, ...others]);
  };
  /**
   * The deeper reads of a solana mint, each left running, as the model would call them: only the mint; the launch
   * (`launch`) its first page alone unless the question is about the dev, the holders or the launch (`whole`): Helius
   * credits spent by depth, a screen by default and the whole first minute when it is asked about
   */
  const deepReads = (mint: string, launch: boolean, whole: boolean) => {
    const t0 = Date.now();
    const read = (k: DeepRead, args: Record<string, unknown>): DeepCall => [k, tracked(run(DEEP_TOOLS[k], args, SCAN_DEEP_CALL_MS)), args];
    const reads: DeepCall[] = [
      read("links", { mint }),
      read("narrative", { mint }),
      read("metas", {}),
      // who on crypto twitter called it (the CT radar's own store: no outside call) and the ideas on x its ticker rides
      read("calls", { mint, window: "24h" }),
      ...(facts.symbol ? [read("ideas", { query: facts.symbol, days: 3, limit: 3 })] : []),
      ...(launch ? [read("launch", whole ? { mint } : { mint, first_page: true }), read("spread", { mint })] : []),
    ];
    const deep: ScanDeep = launch && !whole ? { screen: true } : {};
    return { t0, reads, deep };
  };
  /**
   * The dev's money trail (sol_money_trail on the dev with the coin's mint: its moves of the coin whatever their age)
   * once the creator read or the launch read, whichever is back first, says its bag left its wallet: where it went is
   * the dev's first question. Unasked for a dev still holding, or none named; the dossier names its arguments while it
   * runs, so the model's own call joins it
   */
  const devTrail = (d: ReturnType<typeof deepReads>, mint: string): void => {
    const named = d.reads.filter((r): r is DeepCall & { 0: "launch" | "origin" } => r[0] === "launch" || r[0] === "origin");
    if (!named.length) return;
    const args: Record<string, unknown> = {};
    const trail = new Promise<string | null>((res) => {
      let left = named.length;
      for (const [k, r] of named)
        void r.promise.then((x) => {
          const dev = devGone(k, okData(x));
          if (dev) res(dev);
          else if (--left === 0) res(null);
        });
    }).then((dev) => {
      if (!dev) return undefined;
      args.address = dev;
      args.mint = mint;
      d.deep.devWallet = dev;
      return run(DEEP_TOOLS.trail, args, SCAN_DEEP_CALL_MS);
    });
    d.reads.push(["trail", tracked(trail), args]);
  };
  /** The deeper reads back within SCAN_DEEP_MS (the risk flags and the creator too, when they land meanwhile), into the facts */
  const readDeep = async (d: ReturnType<typeof deepReads>, also: (Tracked<ToolResult | undefined> | null)[]): Promise<void> => {
    const pending = [...d.reads.map(([, r]) => r), ...also.filter((r): r is Tracked<ToolResult | undefined> => r !== null)].filter((r) => !r.settled());
    const wait = SCAN_DEEP_MS - (Date.now() - d.t0);
    if (pending.length > 0 && wait > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled(pending.map((r) => r.promise)), new Promise<void>((res) => (timer = setTimeout(res, wait)))]);
      clearTimeout(timer);
    }
    const deep = d.deep;
    // where its launch's and holders' wallets were seen before (her memory of wallets), from the reads that are back
    const remember = (): void => {
      if (!opts.memory || !facts.address) return;
      const data = (v: ScanDeep["launch"]) => (v && v !== "running" ? v : null);
      try {
        const lines = opts.memory(facts.address, { launch: data(deep.launch), links: data(deep.links) });
        if (lines.length) deep.memory = lines;
      } catch {
        // no memory read is no dossier line
      }
    };
    for (const [k, r, args] of d.reads) {
      if (r.settled()) {
        const res = await r.promise;
        // a trail never asked (its dev still holding) is no read
        if (res !== undefined || k !== "trail") deep[k] = okData(res);
        continue;
      }
      // one not back lands in this same dossier when it is, so the model never calls it again
      deep[k] = "running";
      void r.promise.then((res) => {
        if (res === undefined && k === "trail") delete deep[k];
        else deep[k] = okData(res);
        if (res && !facts.results.some((x) => x.result === res)) LATE.set(facts, [...(LATE.get(facts) ?? []), { name: DEEP_TOOLS[k], args, result: res }]);
        if (k === "launch" || k === "links") remember();
      });
    }
    remember();
    facts.deep = deep;
  };
  /** The token of a trading pair at `pair` on `chain` (DEX Screener's search reads a pair's address), or null. */
  const pairBase = async (pair: string, chain: string): Promise<string | null> => {
    const r = okData(await run("dex_pair_lookup", { query: pair, chain, limit: 5 }));
    const hit = (Array.isArray(r?.pairs) ? r!.pairs.filter(isObj) : []).find((x) => x.pair_address === pair);
    return hit && isObj(hit.base) && typeof hit.base.address === "string" ? hit.base.address : null;
  };
  try {
    let address = ask.address;
    let family = ask.family;
    // a ticker on DEX Screener: the most traded token with exactly that symbol (on the chain named, if one is)
    let found: Record<string, unknown> | null = null;
    // the token's age when it is known before its scan (a ticker's oldest pool or first pool), else undefined
    let ageBefore: number | null | undefined;
    if (!address && ask.ticker) {
      const ticker = ask.ticker;
      // a solana ticker (or one with no chain named): Jupiter's verified list first; DEX Screener's search by the
      // ticker and by its cashtag at the same time (some listings carry the "$" in the symbol, "$WIF", and a search for
      // "wif" finds only the copies named "WIF"): the fallback, and with no chain named it shows a ticker that is a
      // much larger token's on an evm chain (PEPE's, whose solana copy is verified too)
      const solanaFirst = ask.chain === null || ask.chain === "solana";
      const [verifiedResult, found2] = await Promise.all([
        solanaFirst ? run("sol_ticker_mint", { query: ticker, limit: 5 }) : Promise.resolve(undefined),
        Promise.all([ticker, `$${ticker}`].map(async (query) => okData(await run("dex_pair_lookup", { query, ...(ask.chain ? { chain: ask.chain } : {}), limit: 10 })))),
      ]);
      const seen = new Set<string>();
      const tokens = found2
        .flatMap((r) => (Array.isArray(r?.tokens) ? r!.tokens.filter(isObj) : []))
        .filter((t) => {
          const k = `${String(t.chain)}:${String(t.address).toLowerCase()}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .filter((t) => cleanSymbol(t.symbol) === ticker && typeof t.address === "string");
      // the most traded first, as the search ranks them: a copycat often shows a deep pool and no trading
      const byTrading = (a: Record<string, unknown>, b: Record<string, unknown>) => (numOf(b.volume_24h_usd) ?? 0) - (numOf(a.volume_24h_usd) ?? 0) || (numOf(b.liquidity_usd) ?? 0) - (numOf(a.liquidity_usd) ?? 0);
      const verified = solanaFirst ? verifiedPick(okData(verifiedResult), ticker, nowMs) : null;
      // no chain named: an evm token with that ticker that outweighs the verified one (evmOutweighs; the most traded
      // such) is the one asked about
      const evm = verified && ask.chain === null ? ([...tokens].filter((t) => t.chain !== "solana" && evmOutweighs(t, verified)).sort(byTrading)[0] ?? null) : null;
      if (verified && !evm) {
        address = verified.mint;
        family = "solana";
        facts.chain = "solana";
        facts.via = "verified";
        ageBefore = verified.ageDays ?? undefined;
        // the data the scan rests on: the verified token, not the listings it was picked over
        facts.results = facts.results.filter((r) => r.name !== "dex_pair_lookup");
      } else {
        found = evm ?? [...tokens].sort(byTrading)[0] ?? null;
        if (!found) {
          facts.notes.push(`no token with the ticker ${ticker} found on a dex${ask.chain ? ` on ${ask.chain}` : ""}`);
          return finish(facts);
        }
        address = found.address as string;
        family = found.chain === "solana" ? "solana" : "evm";
        facts.chain = typeof found.chain === "string" ? found.chain : null;
        facts.via = "dex";
        ageBefore = numOf(found.oldest_pool_age_days);
        if (!verified) facts.results = facts.results.filter((r) => r.name !== "sol_ticker_mint");
      }
      facts.address = address;
    }
    if (!address) return finish(facts);

    if (family === "solana") {
      // stage 1: the account, its pools and its holders at once (a wallet's "holders" call just fails)
      const young = (age: number | null) => ask.dev || age === null || age <= SCAN_DEV_MAX_AGE_DAYS;
      const stage1 = Promise.all([
        run("sol_account_basics", { address }),
        run("token_pairs", { chain: "solana", token_address: address, limit: 10 }),
        run("sol_largest_accounts", { mint: address, limit: 20 }),
      ]);
      // surely a token's: its risk flags are asked now, beside stage 1, not after it
      const early = facts.resolved === "ticker" || KNOWN_MINT.test(address);
      const earlyFlags = early ? runFlags(address) : null;
      // by ticker the token's age is known already: a young token's creator is looked up in the same stage. With
      // `behind` it is never waited for: asked as early as it is surely wanted (a launchpad's mint, a question about the
      // dev), read if back by the end of the scan; the model's own call of it (same function, same arguments) joins it
      // or reads the cache
      const originEarly = ageBefore !== undefined ? young(ageBefore) : behind && (KNOWN_MINT.test(address) || ask.dev);
      const origin = originEarly ? tracked(run("sol_token_origin", { mint: address }, SCAN_ORIGIN_MS)) : null;
      const [basics, pairs, largest] = await stage1;
      if (origin && !behind) await origin.promise;
      const b = okData(basics);
      const kind = typeof b?.kind === "string" ? b.kind : null;
      readMarket(facts, okData(pairs));
      if (kind === "token_mint") {
        facts.kind = "token";
        const m = isObj(b!.mint) ? b!.mint : {};
        facts.authorities = { mint: m.mint_authority === "none" ? "revoked" : "on", freeze: m.freeze_authority === "none" ? "revoked" : "on" };
        facts.program = m.token_2022 === true ? "token-2022" : m.token_2022 === false ? "spl" : null;
        if (m.token_2022 === true && Array.isArray(m.extensions))
          facts.ext = { fee: m.transfer_fee === true, feePct: typeof m.transfer_fee_pct === "number" ? m.transfer_fee_pct : null, hook: m.transfer_hook === true, permanentDelegate: m.permanent_delegate === true, nonTransferable: m.non_transferable === true };
        readHolders(facts, okData(largest));
        // the deeper reads, beside stage 2: what is back within SCAN_DEEP_MS goes into the dossier
        const deep = opts.deep === true && behind ? deepReads(address, young(facts.market?.oldestPoolAgeDays ?? ageBefore ?? null), ask.dev || ask.holders || ask.launch === true) : null;
        // stage 2: its creator, for a young token or a question about the dev; its risk flags, unless asked already
        const flagged = early ? earlyFlags : runFlags(address);
        const dev = origin ?? (ageBefore === undefined && young(facts.market?.oldestPoolAgeDays ?? null) ? tracked(run("sol_token_origin", { mint: address }, SCAN_ORIGIN_MS)) : null);
        // the creator read is one of the dossier's, and one that lands after the scan still reaches the token block the
        // answer ends with (withLateChecks), as the risk flags do
        if (deep && dev) {
          deep.reads.push(["origin", dev, { mint: address }]);
          whenBack(dev, (d) => readDev(facts, d));
        }
        if (deep) devTrail(deep, address);
        await readChecks(flagged, dev);
        if (deep) await readDeep(deep, [flagged]);
        readDev(facts, okData(dev ? await landed(dev) : undefined));
      } else if (kind === "wallet") {
        facts.kind = "wallet";
        facts.market = null;
        const sigs = okData(await run("sol_recent_signatures", { address, limit: 20 }));
        readWallet(facts, b!, sigs, nowMs);
        // what its newest transactions moved (SOL and tokens in and out), for the model's line about what it is doing
        const newest = (Array.isArray(sigs?.transactions) ? sigs!.transactions.filter(isObj) : [])
          .filter((t) => t.ok !== false && typeof t.signature === "string")
          .slice(0, WALLET_TXS_READ);
        await Promise.all(newest.map((t) => run("sol_balance_changes", { signature: t.signature })));
      } else if (facts.market) {
        // pools but no mint read (the chain call failed): still a token, and risk flags asked early still count
        facts.kind = "token";
        await readChecks(earlyFlags);
      } else if (b && b.exists === false) {
        facts.kind = "none";
        facts.notes.push("no account at this address on solana and no dex pools");
      } else if (kind === "other" && !viaPair) {
        // an account a program owns: often a trading pair's (a pasted DEX Screener link carries the pair's address, not
        // the token's): its pair's token is scanned instead, once
        const base = await pairBase(address, "solana");
        if (base && base !== address) {
          const inner = await runScan({ ...ask, address: base, ticker: null, family: "solana" }, call, has, nowMs, { ...opts, viaPair: true });
          inner.calls.unshift(...facts.calls);
          inner.results.unshift(...facts.results);
          inner.notes.unshift("the address asked is a trading pair's: its token was scanned");
          return inner;
        }
        facts.kind = "other";
        facts.notes.push("it is not a token mint or a wallet");
      } else if (kind) {
        facts.kind = "other";
        facts.notes.push(kind === "program" ? "it is a program, not a token or a wallet" : kind === "token_account" ? "it is a token account (one holder's balance), not the token's mint" : "it is not a token mint or a wallet");
      }
    } else {
      // an evm contract: its pools on any chain (DEX Screener's search reads an address on every chain; a ticker's search
      // found them already), then its contract facts where they can be had
      let mine = found;
      if (!mine) {
        const r = okData(await run("dex_pair_lookup", { query: address, ...(ask.chain ? { chain: ask.chain } : {}), limit: 10 }));
        const tokens = Array.isArray(r?.tokens) ? r!.tokens.filter(isObj) : [];
        const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
        mine = tokens.find((t) => same(t.address, address!)) ?? null;
        // a trading pair's address (a pasted DEX Screener link): its token, as the search found it
        const pair = mine ? null : (Array.isArray(r?.pairs) ? r!.pairs.filter(isObj) : []).find((x) => same(x.pair_address, address!));
        const base = pair && isObj(pair.base) && typeof pair.base.address === "string" ? pair.base.address : null;
        if (base) {
          mine = tokens.find((t) => same(t.address, base)) ?? null;
          if (mine) {
            address = base;
            facts.address = base;
            facts.notes.push("the address asked is a trading pair's: its token was scanned");
          }
        }
      }
      if (mine) {
        facts.kind = "token";
        facts.chain = typeof mine.chain === "string" ? mine.chain : facts.chain;
        readMarket(facts, { totals: mine });
        const flags = run("token_risk_flags", { address, chain: facts.chain ?? "ethereum" });
        readSecurity(facts, okData(await flags));
      } else {
        facts.notes.push(`no dex pools for this contract${ask.chain ? ` on ${ask.chain}` : " on any chain"}`);
      }
    }
  } catch {
    // whatever was read stands
  } finally {
    reading = false;
  }
  return finish(facts);
}

/** A deeper read of ScanDeep (its data, null or "running") */
type DeepRead = Exclude<keyof ScanDeep, "screen" | "memory" | "devWallet">;

/** A deeper read as the scan asked it: which, its call, its arguments */
type DeepCall = [DeepRead, Tracked<ToolResult | undefined>, Record<string, unknown>];

/**
 * Beside a scan's facts, never in them (ScanFacts stays plain data): its deeper reads back after it was done and not in its
 * data yet (readDeep; settleDeep takes them in), and the deeper reads' rows among its red flags and notes (deepRows), read
 * again when one left running lands
 */
const LATE = new WeakMap<ScanFacts, ScanFacts["results"]>();
const DEEP_ROWS = new WeakMap<ScanFacts, { flags: string[]; notes: string[] }>();

/**
 * A scan's deeper reads that landed after it (readDeep left them running), taken in as the model's prompt is built:
 * their data joins the scan's and its red flags and notes say them, as for a read back in time
 */
export function settleDeep(f: ScanFacts): void {
  const late = LATE.get(f);
  LATE.delete(f);
  if (late) f.results.push(...late.filter((r) => !f.results.some((x) => x.result === r.result)));
  const was = DEEP_ROWS.get(f);
  if (!was || !f.deep) return;
  const rows = deepRows(f, was);
  f.flags = [...f.flags.filter((x) => !was.flags.includes(x)), ...rows.flags];
  f.notes = [...f.notes.filter((x) => !was.notes.includes(x)), ...rows.notes];
  DEEP_ROWS.set(f, rows);
}

/** The function of each deeper read (the scan asks them, the dossier names those still running, an answer never names one) */
export const DEEP_TOOLS: Readonly<Record<DeepRead, string>> = {
  launch: "sol_launch",
  links: "sol_holder_links",
  spread: "sol_holder_spread",
  narrative: "meme_narrative",
  metas: "meme_metas",
  origin: "sol_token_origin",
  calls: "ct_calls",
  ideas: "x_ideas",
  trail: "sol_money_trail",
};

/** A call and whether it is back yet (a call left running is read only when it is). */
interface Tracked<T> {
  promise: Promise<T>;
  settled: () => boolean;
}

function tracked<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  return { promise, settled: () => done };
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The token Jupiter verified with exactly `ticker` as its symbol, from sol_ticker_mint's answer. */
interface VerifiedToken {
  mint: string;
  capUsd: number | null;
  liquidityUsd: number | null;
  /** Days since its first pool (null: unknown) */
  ageDays: number | null;
}

/**
 * The real token behind a solana ticker in sol_ticker_mint's answer: a token with exactly that symbol ("$" and case
 * aside) that Jupiter verified (its flag, or a "verified" / "strict" tag), the largest by market cap (else fdv), then by
 * organic score; null when there is none (the scan falls back to DEX Screener).
 */
function verifiedPick(d: Record<string, unknown> | null, ticker: string, nowMs: number): VerifiedToken | null {
  const tokens = d && Array.isArray(d.tokens) ? d.tokens.filter(isObj) : [];
  const verified = (t: Record<string, unknown>) => t.verified === true || (Array.isArray(t.tags) && t.tags.some((x) => x === "verified" || x === "strict"));
  const cap = (t: Record<string, unknown>) => numOf(t.market_cap_usd) ?? numOf(t.fdv_usd) ?? 0;
  const best = tokens
    .filter((t) => typeof t.mint === "string" && MINT.test(t.mint) && cleanSymbol(t.symbol) === ticker && verified(t))
    .sort((a, b) => cap(b) - cap(a) || (numOf(b.organic_score) ?? 0) - (numOf(a.organic_score) ?? 0))[0];
  if (!best) return null;
  const first = typeof best.first_pool_at === "string" ? Date.parse(best.first_pool_at) : NaN;
  return {
    mint: best.mint as string,
    capUsd: numOf(best.market_cap_usd) ?? numOf(best.fdv_usd),
    liquidityUsd: numOf(best.liquidity_usd),
    ageDays: Number.isFinite(first) ? Math.max(0, (nowMs - first) / 86_400_000) : null,
  };
}

/** How many times the verified solana token's market cap an evm token with the same ticker needs to be the one asked about. */
const EVM_CAP_OUTWEIGHS = 20;

/**
 * With no chain named, a ticker whose verified solana token is a small copy of a large evm token (PEPE, SHIB, LINK, UNI
 * and BRETT have verified bridged or namesake tokens on solana): the evm token is the one asked about when DEX
 * Screener's numbers for it can be true (marketDoubts, as for a fallback pick: no idle deep pool), its market cap is
 * EVM_CAP_OUTWEIGHS times the solana token's on Jupiter, its pools are at least as deep as the solana token's, and they
 * hold at most FAKE_POOL_SHARE of its market cap (however shallow). A market cap alone is a fake's easiest number (a
 * thin pool at any price); its volume is no measure.
 */
function evmOutweighs(evm: Record<string, unknown>, sol: VerifiedToken): boolean {
  const m = { mcapUsd: numOf(evm.market_cap_usd), fdvUsd: numOf(evm.fdv_usd), liquidityUsd: numOf(evm.liquidity_usd), volume24hUsd: numOf(evm.volume_24h_usd) };
  if (marketDoubts(m, true).length || m.liquidityUsd === null) return false;
  const cap = m.mcapUsd ?? m.fdvUsd ?? 0;
  return cap >= EVM_CAP_OUTWEIGHS * Math.max(sol.capUsd ?? 0, 1) && m.liquidityUsd >= Math.max(sol.liquidityUsd ?? 0, 1) && m.liquidityUsd <= FAKE_POOL_SHARE * cap;
}

/** A market cap or fdv above this cannot be true (no token is worth $4 trillion). */
const SANE_CAP_MAX_USD = 4e12;
/** Liquidity more than this many times the larger of market cap and fdv cannot be true (above SANE_FLOOR_USD of liquidity). */
const SANE_LIQ_OVER_CAP = 1.5;
/** Liquidity at least this large for the liquidity checks (a small new pool may hold most of a token). */
const SANE_FLOOR_USD = 1_000_000;
/** A fallback pick's deep pool trading under this share of its liquidity in 24h is a fake deep pool. */
const IDLE_VOLUME_SHARE = 0.001;
/**
 * A fallback pick whose pools hold more than this share of its market cap is a fake deep pool too: a real token's pools
 * hold a few percent of it, a fake's about all of it.
 */
const FAKE_POOL_SHARE = 0.5;

/**
 * Why a token's market numbers cannot be true ([] when they can): "cap" = market cap or fdv above SANE_CAP_MAX_USD;
 * "liquidity" = over SANE_FLOOR_USD of liquidity and more than SANE_LIQ_OVER_CAP times the larger of market cap and
 * fdv; for `fallback` (a ticker picked on DEX Screener, not a verified token) also "deep" = over SANE_FLOOR_USD of
 * liquidity and more than FAKE_POOL_SHARE of the larger cap, and "idle" = over SANE_FLOOR_USD of liquidity and 24h
 * volume under IDLE_VOLUME_SHARE of it (fake deep pools). DEX Screener lists copies and fakes with fake liquidity and
 * wash volume.
 */
function marketDoubts(m: { mcapUsd: number | null; fdvUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null }, fallback: boolean): string[] {
  const out: string[] = [];
  const caps = [m.mcapUsd, m.fdvUsd].filter((n): n is number => n !== null && n > 0);
  if (caps.some((c) => c > SANE_CAP_MAX_USD)) out.push("cap");
  const liq = m.liquidityUsd;
  if (liq !== null && liq > SANE_FLOOR_USD && caps.length) {
    if (liq > SANE_LIQ_OVER_CAP * Math.max(...caps)) out.push("liquidity");
    else if (fallback && liq > FAKE_POOL_SHARE * Math.max(...caps)) out.push("deep");
  }
  if (fallback && liq !== null && liq > SANE_FLOOR_USD && (m.volume24hUsd ?? 0) < IDLE_VOLUME_SHARE * liq) out.push("idle");
  return out;
}

/** The note for the model when a scan's market numbers are left out. */
const UNRELIABLE_NOTE = "its market numbers on dex screener look unreliable (left off the card: never quote them)";

/** A launchpad's bonding curve as DEX Screener names its dex */
const LAUNCHPAD_DEX = /^pump(?:fun)?$|launchlab|moonshot|bonk|boop/i;
/** A graduated pump.fun coin's own pool */
const GRADUATED_DEX = /^pumpswap$/i;
/** Pools beside a curve holding less than this in all are a bot's side pools, never a graduation */
const CURVE_SIDE_DUST_USD = 1_000;

/** The market from token_pairs (or one token of dex_pair_lookup as `totals`). */
function readMarket(facts: ScanFacts, d: Record<string, unknown> | null): void {
  const t = d && isObj(d.totals) ? d.totals : null;
  if (!t || !(numOf(t.pools) ?? 0)) return;
  const tx = isObj(t.txns_24h) ? t.txns_24h : {};
  const dexes = Array.isArray(t.dexes) ? t.dexes.map(String) : [];
  const liquidity = numOf(t.liquidity_usd);
  const onlyCurve = dexes.length > 0 && dexes.every((x) => LAUNCHPAD_DEX.test(x)) && (numOf(t.pools) ?? 0) <= 1;
  // a curve with a bot's dust pool beside it is still on its curve (DEX Screener gives the curve no liquidity): no
  // liquidity read then, the curve's own depth is not in the listing
  const besideDust = !onlyCurve && dexes.some((x) => LAUNCHPAD_DEX.test(x)) && !dexes.some((x) => GRADUATED_DEX.test(x)) && (liquidity ?? 0) < CURVE_SIDE_DUST_USD;
  facts.symbol = cleanSymbol(t.symbol) ?? facts.symbol;
  facts.name = coinName(t.name) ?? facts.name ?? null;
  facts.market = {
    priceUsd: numOf(t.price_usd),
    mcapUsd: numOf(t.market_cap_usd),
    fdvUsd: numOf(t.fdv_usd),
    liquidityUsd: besideDust ? null : liquidity,
    volume24hUsd: numOf(t.volume_24h_usd),
    pools: numOf(t.pools),
    oldestPoolAgeDays: numOf(t.oldest_pool_age_days),
    buys24h: numOf(tx.buys),
    sells24h: numOf(tx.sells),
    curve: onlyCurve || besideDust,
  };
}

/** Wallets holding the same bag: this many at least, each within EQUAL_BAG_SPREAD of the smallest of them */
const EQUAL_BAG_WALLETS = 5;
const EQUAL_BAG_SPREAD = 0.01;

/**
 * The largest bag that five wallets or more among the largest holders hold alike: their count and the smallest share of
 * them; null when none do
 */
function equalBags(accounts: unknown): { wallets: number; pctEach: number } | null {
  const byOwner = new Map<string, number>();
  for (const a of Array.isArray(accounts) ? accounts.filter(isObj) : []) {
    const share = numOf(a.share_pct);
    if (share === null || share <= 0 || (a.holder !== "wallet" && a.holder !== "unknown")) continue;
    const owner = typeof a.owner === "string" ? a.owner : typeof a.token_account === "string" ? a.token_account : null;
    if (owner) byOwner.set(owner, (byOwner.get(owner) ?? 0) + share);
  }
  const shares = [...byOwner.values()].sort((a, b) => a - b);
  let best: { wallets: number; pctEach: number } | null = null;
  for (let i = 0, j = 0; i < shares.length; i++) {
    while (j < shares.length && shares[j]! <= shares[i]! * (1 + EQUAL_BAG_SPREAD)) j++;
    const n = j - i;
    if (n >= EQUAL_BAG_WALLETS && (!best || n > best.wallets || (n === best.wallets && shares[i]! > best.pctEach))) best = { wallets: n, pctEach: shares[i]! };
  }
  return best;
}

function readHolders(facts: ScanFacts, d: Record<string, unknown> | null): void {
  if (!d) return;
  const bags = equalBags(d.accounts);
  facts.holders = {
    top10Pct: numOf(d.top10_share_pct),
    top10WalletsPct: numOf(d.top10_wallets_share_pct),
    largestWalletPct: numOf(d.largest_wallet_share_pct),
    programPct: numOf(d.program_accounts_share_pct),
    ...(bags ? { equalBags: bags } : {}),
  };
}

/** A yes or no a check returned (true or false, 1 or 0, "yes" or "no"…, or a {status} holding one), null for anything else */
function yesNo(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (isObj(v) && "status" in v) return yesNo(v.status);
  const t = typeof v === "string" ? v.trim().toLowerCase() : v;
  if (t === 1 || t === "1" || t === "true" || t === "yes") return true;
  if (t === 0 || t === "0" || t === "false" || t === "no") return false;
  return null;
}

/** A number a check returned (0 or more), or a string of one; null for anything else */
function amountOf(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** A tax or fee a check returned: an amount, yes or no as 1 or 0, an empty {} or [] as none; null for anything else */
function taxOf(v: unknown): number | null {
  if ((Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0)) return 0;
  const yes = yesNo(v);
  return amountOf(v) ?? (yes === null ? null : yes ? 1 : 0);
}

const HONEYPOT_KEY = /(?:^|_)honeypot$/;
/** An evm contract's buy, sell or transfer tax, a token-2022 mint's transfer fee */
const TAX_KEY = /(?:^|_)(?:buy|sell|transfer)_?(?:tax|fee)(?:_pct|_percent|_bps|_rate)?$/;
const HOOK_KEY = /(?:^|_)transfer_hook$/;
const NON_TRANSFERABLE_KEY = /(?:^|_)non_transferable$/;
const BALANCE_KEY = /(?:^|_)balance_mutable(?:_authority)?$/;
const LOCKED_KEY = /^(?:is_)?(?:lp|liquidity)_(?:is_)?locked$/;
/** The share of the pool's lp tokens locked, a percent (a solana token's, as rugcheck reads it) */
const LOCKED_PCT_KEY = /^(?:lp|liquidity)_locked_(?:pct|percent)$/;
/** Over the pools an lp can be locked in (free/security.ts): the share that says whether the deployer can pull it */
const LOCKABLE_PCT_KEY = /^(?:lp|liquidity)_locked_(?:pct|percent)_lockable$/;
/** At least this share of the lp locked reads as locked, under LP_LOOSE_PCT as not locked; between, the model reads it */
const LP_LOCKED_PCT = 90;
const LP_LOOSE_PCT = 10;

/**
 * What the risk flags (token_risk_flags) said, read from their own keys, at the top or up to two levels down (the upstream
 * nests them: an evm contract's flat, a solana mint's in goplus and rugcheck, a report sometimes wrapped once more): a
 * honeypot, any buy, sell or transfer tax or transfer fee above 0 (all of them 0: none), a transfer hook (a hook program
 * listed), non-transferable, an authority that can change balances, the pool's liquidity locked (or the share locked:
 * LP_LOCKED_PCT, LP_LOOSE_PCT); only yes or no values and numbers they returned, nothing read from their text.
 */
function readSecurity(facts: ScanFacts, d: Record<string, unknown> | null): void {
  if (!d) return;
  const entries: (readonly [string, unknown])[] = [];
  const walk = (o: Record<string, unknown>, depth: number): void => {
    for (const [k, v] of Object.entries(o)) {
      entries.push([k.toLowerCase().replace(/[^a-z0-9]+/g, "_"), v]);
      if (depth < 2 && isObj(v)) walk(v, depth + 1);
    }
  };
  walk(d, 0);
  const values = (key: RegExp): unknown[] => entries.filter(([k]) => key.test(k)).map(([, v]) => v);
  const first = <T>(key: RegExp, read: (v: unknown) => T | null): T | null => values(key).map(read).find((v) => v !== null) ?? null;
  const taxes = values(TAX_KEY).map(taxOf).filter((v): v is number => v !== null);
  const lockedPct = first(LOCKABLE_PCT_KEY, amountOf) ?? first(LOCKED_PCT_KEY, amountOf);
  const lpLocked = first(LOCKED_KEY, yesNo) ?? (lockedPct === null ? null : lockedPct >= LP_LOCKED_PCT ? true : lockedPct < LP_LOOSE_PCT ? false : null);
  const security = {
    honeypot: first(HONEYPOT_KEY, yesNo),
    taxed: taxes.length ? taxes.some((t) => t > 0) : null,
    hook: first(HOOK_KEY, (v) => (Array.isArray(v) ? v.length > 0 : yesNo(v))),
    nonTransferable: first(NON_TRANSFERABLE_KEY, yesNo),
    balanceMutable: first(BALANCE_KEY, yesNo),
    lpLocked,
    lpLockedPct: lockedPct,
  };
  // RugCheck's creator history, insiders and rug mark, each only when it said it
  const creatorOther = first(/^creator_other_tokens$/, amountOf);
  const insiders = first(/^insider_wallets_detected$/, amountOf) ?? first(/^insiders_in_top_holders$/, amountOf);
  const rugged = first(/^rugged$/, yesNo);
  const said = { ...(creatorOther !== null ? { creatorOther } : {}), ...(insiders !== null ? { insiders } : {}), ...(rugged !== null ? { rugged } : {}) };
  if (Object.values(security).some((v) => v !== null) || Object.keys(said).length > 0) facts.security = { ...security, ...said };
}

function readDev(facts: ScanFacts, d: Record<string, unknown> | null): void {
  if (!d) return;
  if (d.found !== true) {
    facts.dev = { found: false, why: "its history is too long to find its first transaction here" };
    return;
  }
  const got = isObj(d.creator_got_at_creation) ? numOf(d.creator_got_at_creation.share_pct) : null;
  const holds = isObj(d.creator_holds_now) ? numOf(d.creator_holds_now.share_pct) : null;
  facts.dev = { found: true, ageDays: numOf(d.age_days), gotPct: got, holdsPct: holds, ...(typeof d.creator === "string" ? { creator: d.creator } : {}) };
}

function readWallet(facts: ScanFacts, basics: Record<string, unknown>, sigs: Record<string, unknown> | null, nowMs: number): void {
  const txs = sigs && Array.isArray(sigs.transactions) ? sigs.transactions.filter(isObj) : [];
  const times = txs.map((t) => (typeof t.time === "string" ? Date.parse(t.time) : NaN)).filter(Number.isFinite);
  const last = times.length ? Math.max(...times) : null;
  const firstOf = times.length ? Math.min(...times) : null;
  facts.wallet = {
    sol: numOf(basics.sol),
    lastTxAgoMin: last !== null ? Math.max(0, Math.round((nowMs - last) / 60_000)) : null,
    recentTxs: txs.length,
    spanMin: last !== null && firstOf !== null ? Math.max(0, Math.round((last - firstOf) / 60_000)) : null,
  };
}

/** A wallet's newest successful transactions whose balance changes a scan reads (what it is doing, for the model's line). */
const WALLET_TXS_READ = 3;

/** A token at least this old (its oldest pool) and this large (market cap, else fdv) is "old and large" for its holders (SEVERITY). */
const MATURE_DAYS = SEVERITY.matureDays;
const MATURE_CAP_USD = SEVERITY.matureCapUsd;

/** At least MATURE_DAYS old and MATURE_CAP_USD large: its holders' concentration is a note, not a red flag. */
function mature(m: ScanFacts["market"]): boolean {
  const cap = m ? (m.mcapUsd ?? m.fdvUsd) : null;
  return m !== null && (m.oldestPoolAgeDays ?? 0) >= MATURE_DAYS && (cap ?? 0) >= MATURE_CAP_USD;
}

/** The scan's words for what can take the money */
const TAX_FLAG = "the risk flags show a buy, sell or transfer tax";
const HOOK_FLAG = "the risk flags show a transfer hook: a program runs on every transfer";
const LP_FLAG = "its pools' lp is not locked or burned: the deployer can pull it";
const RUGGED_FLAG = "rugcheck marks it rugged: its liquidity was pulled";

/** The flags, the strong facts and the notes code reads from the facts (thresholds on numbers a source returned). */
function finish(facts: ScanFacts): ScanFacts {
  // market numbers that cannot be true are never printed nor read for a flag: the dollar figures go (the price behind
  // them is the listing's too), pools, age and trades stay
  if (facts.market) {
    const doubts = marketDoubts(facts.market, facts.via === "dex");
    if (doubts.length) {
      facts.unreliable = doubts;
      facts.market = { ...facts.market, priceUsd: null, mcapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd: null };
      facts.notes.push(UNRELIABLE_NOTE);
    }
  }
  const { market: m, authorities: a, holders: h, dev, security: sec } = facts;
  if (a) {
    if (a.mint === "on") facts.flags.push("mint authority still on");
    if (a.freeze === "on") facts.flags.push("freeze authority on");
    if (a.mint === "revoked" && a.freeze === "revoked") facts.goods.push("mint and freeze authority revoked");
  }
  // a token-2022 mint's fee and hook as the risk flags read them (a classic mint has none of these extensions)
  const extensions = facts.program !== "spl";
  if (facts.program === "spl") facts.goods.push("a classic spl token: no transfer tax or transfer hook is possible");
  if (facts.ext && !facts.ext.fee && !facts.ext.hook) facts.goods.push("a token-2022 mint with no transfer fee and no transfer hook");
  if (facts.ext?.permanentDelegate) facts.flags.push("a permanent delegate can move any holder's tokens");
  if (facts.ext?.nonTransferable) facts.flags.push("its tokens cannot be transferred");
  else if (facts.program === "token-2022" && sec?.taxed === false && sec.hook === false) facts.goods.push("a token-2022 mint with no transfer fee or transfer hook (the risk flags)");
  else if (facts.program === "token-2022" && !sec?.taxed && !sec?.hook) facts.notes.push("a token-2022 mint: it may charge a transfer fee or run a transfer hook (not read here)");
  if (sec?.honeypot === true) facts.flags.push("the risk flags call it a honeypot");
  else if (sec?.honeypot === false) facts.goods.push("the risk flags find no honeypot");
  // a tax, a fee or a hook takes from every trade or can block it: danger on the one scale (@crawlnet/shared severity.ts)
  if (sec?.taxed === true && extensions) facts.flags.push(TAX_FLAG);
  if (sec?.hook === true && extensions) facts.flags.push(HOOK_FLAG);
  if (sec?.nonTransferable === true && extensions) facts.flags.push("the risk flags say it cannot be transferred");
  if (sec?.balanceMutable === true && extensions) facts.flags.push("the risk flags say an authority can change holders' balances");
  // RugCheck's own reads: a coin it marks rugged can take the money; insiders and a serial creator make it fragile
  if (sec?.rugged === true) facts.flags.push(RUGGED_FLAG);
  if ((sec?.insiders ?? 0) > 0) facts.notes.push(`a warning: rugcheck detects ${sec!.insiders} insider wallet${sec!.insiders === 1 ? "" : "s"}`);
  if ((sec?.creatorOther ?? 0) >= SEVERITY.devCoinsWarn) facts.notes.push(`a warning: its creator made ${sec!.creatorOther} other coins`);
  // a pool its deployer can pull: danger; on its curve there is no lp yet
  const lockedPct = sec?.lpLockedPct ?? null;
  const pullable = m?.curve ? false : lockedPct !== null ? lockedPct < SEVERITY.lpLockedPct : sec?.lpLocked === false;
  if (pullable) facts.flags.push(lockedPct !== null ? `${LP_FLAG}: ${pct(lockedPct)} of its lockable liquidity is locked or burned` : LP_FLAG);
  if (m) {
    if (m.liquidityUsd !== null && m.liquidityUsd < SEVERITY.liquidityDangerUsd && !m.curve) facts.flags.push(`only ${usd(m.liquidityUsd)} of liquidity`);
    else if (m.liquidityUsd !== null && m.liquidityUsd >= 1_000_000) facts.goods.push(`${usd(m.liquidityUsd)} of liquidity across ${m.pools} pool${m.pools === 1 ? "" : "s"}`);
    // fresh is context, never a red flag by itself (fresh pairs are a trencher's hunting ground)
    if (m.oldestPoolAgeDays !== null && m.oldestPoolAgeDays < 1) facts.notes.push(`${age(m.oldestPoolAgeDays)} old: fresh`);
    else if (m.oldestPoolAgeDays !== null && m.oldestPoolAgeDays >= 365) facts.goods.push(`${age(m.oldestPoolAgeDays)} old`);
    if ((m.buys24h ?? 0) >= 10 && m.sells24h === 0) facts.flags.push(`${m.buys24h} buys and no sells in 24h`);
    if (m.curve) facts.notes.push("still on its launchpad's bonding curve (not graduated to a dex pool)");
  }
  if (h) {
    // an old, large token's big wallets are mostly exchanges' and its team's or treasury's (JUP, BONK, WIF): a
    // concentration there is a note, a red flag only on a young or small one (a rug's shape)
    const concentrated = (text: string): void => {
      if (mature(m)) facts.notes.push(`${text} (an old, large token: its biggest wallets are often exchanges, team or treasury)`);
      else facts.flags.push(text);
    };
    if (h.top10WalletsPct !== null) {
      // the card's own thresholds (tokenChecks), so its flags and its checks say the same
      if (h.top10WalletsPct >= SEVERITY.top10DangerPct) concentrated(`top 10 wallets hold ${pct(h.top10WalletsPct)}`);
      else if (h.top10WalletsPct < SEVERITY.top10WarnPct) facts.goods.push(`top 10 wallets hold ${pct(h.top10WalletsPct)}`);
      if (h.largestWalletPct !== null && h.largestWalletPct >= SEVERITY.largestDangerPct && h.top10WalletsPct < SEVERITY.top10DangerPct) concentrated(`one wallet holds ${pct(h.largestWalletPct)}`);
      else if (h.largestWalletPct !== null && h.largestWalletPct >= SEVERITY.largestWarnPct && h.top10WalletsPct < SEVERITY.top10DangerPct) facts.notes.push(`a warning: one wallet holds ${pct(h.largestWalletPct)}`);
      if (h.programPct !== null && h.programPct >= 1) facts.notes.push(`pools, curves and other program accounts hold ${pct(h.programPct)} of supply, left out of the wallets' share`);
    } else if (h.top10Pct !== null && h.top10Pct >= 50) {
      concentrated(`top 10 accounts hold ${pct(h.top10Pct)} (pools included)`);
    }
    if (h.equalBags) facts.notes.push(`a warning: ${h.equalBags.wallets} of the largest wallets hold ${pct(h.equalBags.pctEach)} each: one hand split it`);
  }
  if (dev?.found) {
    if (dev.holdsPct !== null && dev.holdsPct >= SEVERITY.devDangerPct) facts.flags.push(`dev still holds ${pct(dev.holdsPct)}`);
    else if (dev.holdsPct !== null && dev.holdsPct >= SEVERITY.devWarnPct) facts.notes.push(`a warning: dev still holds ${pct(dev.holdsPct)}`);
    if ((dev.gotPct ?? 0) > 0 && dev.holdsPct === 0) facts.notes.push(`its dev (creator) sold or moved all of the ${pct(dev.gotPct!)} it got at launch`);
    else if ((dev.gotPct ?? 0) > 0 && dev.holdsPct !== null && dev.holdsPct < dev.gotPct!) facts.notes.push(`its dev got ${pct(dev.gotPct!)} at launch and holds ${pct(dev.holdsPct)} now`);
    else if (dev.gotPct === 0 && dev.holdsPct === 0) facts.notes.push("its dev (creator) got none at launch and holds none now");
  } else if (dev && !dev.found) facts.notes.push(`its dev could not be read: ${dev.why}`);
  if (facts.deep) {
    const rows = deepRows(facts);
    facts.flags.push(...rows.flags);
    facts.notes.push(...rows.notes);
    DEEP_ROWS.set(facts, rows);
  }
  if (facts.kind === "none" && facts.notes.length === 0) facts.notes.push("nothing found for it");
  return facts;
}

/**
 * The deeper reads as the card says them (scanDev, deepChecks), for the scan's red flags and notes:
 * what can take the money is a red flag, what makes it fragile a warning, so the scan block's red flags never read "none
 * found" under a dossier's DANGER. `was`: the rows said before (settleDeep), not the dev's own line
 */
function deepRows(facts: ScanFacts, was: { flags: string[]; notes: string[] } = { flags: [], notes: [] }): { flags: string[]; notes: string[] } {
  const sd = scanDev(facts);
  // the dev once: its own line above stands unless the launch read or its side wallets make it worse
  const own = (xs: string[], said: string[], start: string) => xs.some((x) => x.startsWith(start) && !said.includes(x));
  const devSaid = own(facts.flags, was.flags, "dev still holds") || (sd?.dev.level !== "danger" && own(facts.notes, was.notes, "a warning: dev still holds"));
  const rows = [...(sd?.dev.level && !devSaid ? [{ label: "the dev", status: blockStatus(sd.dev.level), value: devValue(sd.dev) }] : []), ...deepChecks(facts)];
  const out = { flags: [] as string[], notes: [] as string[] };
  for (const c of rows) {
    const l = severityOf(c.status);
    if (l === "danger") out.flags.push(`${c.label}: ${c.value}`);
    else if (l === "warn") out.notes.push(`a warning: ${c.label}: ${c.value}`);
  }
  return out;
}

// ---- the card ----

/** "$1.6b", "$8.2m", "$6.2k", "$12.3", "$0.0000213" (three significant digits under $1). */
export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${trim(n / 1e9)}b`;
  if (a >= 1e6) return `$${trim(n / 1e6)}m`;
  if (a >= 1e3) return `$${trim(n / 1e3)}k`;
  if (a >= 1) return `$${trim(n)}`;
  if (a === 0) return "$0";
  return `$${Number(n.toPrecision(3)).toFixed(Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(a)))))}`.replace(/(\.\d*?[1-9])0+$/, "$1");
}
/** One decimal under 100, none above ("8.2", "41"). */
function trim(x: number): string {
  return Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
}
/** "38%", "3.5%", "0.4%", "0%"; under 0.1 "under 0.1%". */
export function pct(n: number): string {
  if (n === 0) return "0%";
  if (n < 0.1) return "under 0.1%";
  return n >= 10 ? `${Math.round(n)}%` : `${Math.round(n * 10) / 10}%`;
}
/** "40 min", "5 h", "12 days", "4 months", "2.9 years". */
function age(days: number): string {
  const min = days * 1440;
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (days < 2) return `${Math.round(days * 24)} h`;
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return `${Math.round((days / 365) * 10) / 10} years`;
}

/**
 * A scan's lines for code's short answer (scanBrief): plain, lower case, every number with its unit and from a source,
 * no address, link, $ before a ticker, handle or domain. A token: what it is and its age, its market, its authorities
 * (solana), its holders, its dev; a wallet: its balance and activity. The musts first, then the rest by rank. "" when
 * there is nothing to print.
 */
function scanCard(f: ScanFacts): string {
  const lines: { text: string; must: boolean; rank: number }[] = [];
  if (f.kind === "token") {
    const m = f.market;
    const what = `${f.symbol ?? "this token"} on ${f.chain ?? "chain unknown"}`;
    const old = m?.oldestPoolAgeDays != null ? `, ${age(m.oldestPoolAgeDays)} old` : f.dev?.found && f.dev.ageDays !== null ? `, ${age(f.dev.ageDays)} old` : "";
    lines.push({ text: `${what}${old}${m?.curve ? ", still on its bonding curve" : ""}`, must: true, rank: 0 });
    if (m) {
      const cap = m.mcapUsd ?? m.fdvUsd;
      const parts = [
        cap !== null ? `mcap ${usd(cap)}` : m.priceUsd !== null ? `price ${usd(m.priceUsd)}` : null,
        m.liquidityUsd !== null ? `liq ${usd(m.liquidityUsd)}${m.pools && m.pools > 1 ? ` (${m.pools} pools)` : ""}` : null,
        m.volume24hUsd !== null ? `24h vol ${usd(m.volume24hUsd)}` : null,
      ].filter(Boolean);
      if (parts.length) lines.push({ text: parts.join(", "), must: true, rank: 1 });
    } else {
      lines.push({ text: "no dex pools found", must: true, rank: 1 });
    }
    const a = f.authorities;
    if (a) {
      const text =
        a.mint === "revoked" && a.freeze === "revoked"
          ? "mint and freeze authority revoked"
          : a.mint === "on" && a.freeze === "on"
            ? "mint and freeze authority still on"
            : a.mint === "on"
              ? "mint authority on, freeze revoked"
              : "mint authority revoked, freeze authority on";
      lines.push({ text, must: true, rank: 2 });
    }
    const h = f.holders;
    if (h && (h.top10WalletsPct !== null || h.top10Pct !== null)) {
      const text = h.top10WalletsPct !== null ? `top 10 wallets hold ${pct(h.top10WalletsPct)}${(h.programPct ?? 0) >= 1 ? ", pools left out" : ""}` : `top 10 accounts hold ${pct(h.top10Pct!)}, pools included`;
      lines.push({ text, must: false, rank: 3 });
    }
    const d = f.dev;
    if (d?.found && d.holdsPct !== null) {
      const text = (d.gotPct ?? 0) > 0 ? `dev got ${pct(d.gotPct!)} at launch, holds ${pct(d.holdsPct)} now` : `dev holds ${pct(d.holdsPct)} now`;
      lines.push({ text, must: false, rank: 4 });
    }
  } else if (f.kind === "wallet" && f.wallet) {
    const w = f.wallet;
    lines.push({ text: `a wallet on solana${w.sol !== null ? `, ${trimSol(w.sol)} sol` : ""}`, must: true, rank: 0 });
    if (w.lastTxAgoMin !== null) {
      const span = w.spanMin !== null && w.recentTxs > 1 ? `, ${w.recentTxs} txs in the last ${age(Math.max(w.spanMin, 1) / 1440)}` : "";
      lines.push({ text: `last tx ${age(w.lastTxAgoMin / 1440)} ago${span}`, must: true, rank: 1 });
    } else lines.push({ text: "no transactions found", must: true, rank: 1 });
  }
  if (lines.length === 0) return "";
  // the musts in order, then the optional lines by rank
  const must = lines.filter((l) => l.must).sort((a, b) => a.rank - b.rank);
  const optional = lines.filter((l) => !l.must).sort((a, b) => a.rank - b.rank);
  return [...must, ...optional].map((l) => l.text).join("\n");
}

function trimSol(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n >= 1 ? String(Math.round(n * 100) / 100) : String(Number(n.toPrecision(3)));
}

// ---- the token block ----

/** A token's explorer by DEX Screener's chain id: its name and the page a token's address follows. */
const EXPLORERS: Record<string, [string, string]> = {
  solana: ["solscan", "https://solscan.io/token/"],
  ethereum: ["etherscan", "https://etherscan.io/token/"],
  base: ["basescan", "https://basescan.org/token/"],
  bsc: ["bscscan", "https://bscscan.com/token/"],
  arbitrum: ["arbiscan", "https://arbiscan.io/token/"],
  polygon: ["polygonscan", "https://polygonscan.com/token/"],
  optimism: ["optimism explorer", "https://optimistic.etherscan.io/token/"],
  avalanche: ["snowtrace", "https://snowtrace.io/token/"],
};

/** Code's one check a later read settles: a token-2022 mint's fee and hook before the risk flags said (withLateChecks) */
const UNSETTLED = { label: "transfer tax / hook", value: "possible (token-2022)" };

export interface TokenBlockCheck {
  label: string;
  /** "na": no colour of its own (the page's grey dot): context, never a strength */
  status: "ok" | "warn" | "bad" | "na";
  value: string;
}

/** "40m", "5h", "12d", "2.9y": a token block's age as the card prints it. */
function shortAge(days: number): string {
  if (days * 24 < 1) return `${Math.max(1, Math.round(days * 1440))}m`;
  if (days < 2) return `${Math.round(days * 24)}h`;
  if (days < 365) return `${Math.round(days)}d`;
  return `${Math.round((days / 365) * 10) / 10}y`;
}

/**
 * The token block's checks on the one severity scale (@crawlnet/shared severity.ts): what can take the money is danger
 * (written "bad"), what makes the coin fragile warn, context a note ("na", no colour), the worst first. Every value a
 * source returned (pct and usd keep three digits); her own token's too.
 */
export function tokenChecks(f: ScanFacts): TokenBlockCheck[] {
  const out: { label: string; level: Severity; value: string }[] = [];
  const add = (label: string, level: Severity, value: string) => out.push({ label, level, value });
  const { market: m, authorities: a, holders: h } = f;
  if (a) {
    add("mint authority", a.mint === "on" ? "danger" : "ok", a.mint);
    add("freeze authority", a.freeze === "on" ? "danger" : "ok", a.freeze);
  }
  const sec = f.security;
  // a token-2022 mint's fee and hook under the classic mint's label, so a later read of the flags settles that check in
  // the answer's block (withLateChecks)
  if (f.program === "spl") add(UNSETTLED.label, "ok", "none possible (classic spl token)");
  else if (f.program === "token-2022") {
    // the flags first, the mint's own extensions for what they leave unsaid
    const taxed = sec?.taxed ?? f.ext?.fee ?? null;
    const hook = sec?.hook ?? f.ext?.hook ?? null;
    const fee = taxed ? (f.ext?.feePct != null ? `fee ${f.ext.feePct}%` : "fee") : "";
    const set = [fee, hook ? "hook" : ""].filter(Boolean);
    if (set.length) add(UNSETTLED.label, "danger", `${set.join(" and ")} set`);
    else if (taxed === false && hook === false) add(UNSETTLED.label, "ok", "none (token-2022)");
    else add(UNSETTLED.label, "warn", UNSETTLED.value);
    if (f.ext?.permanentDelegate) add("permanent delegate", "danger", "set");
  }
  if (sec?.honeypot != null) add("honeypot", sec.honeypot ? "danger" : "ok", sec.honeypot ? "yes" : "no");
  if (sec?.taxed != null && f.program === null) add("taxes", sec.taxed ? "danger" : "ok", sec.taxed ? "set" : "none");
  if (sec?.nonTransferable === true && f.program !== "spl") add("transfers", "danger", "blocked");
  if (sec?.balanceMutable === true && f.program !== "spl") add("balance authority", "danger", "set");
  // a pool its deployer can pull is danger, whatever else holds; still on its
  // curve there is no lp to pull (a note)
  if (m?.curve) add("bonding curve", "note", "still on its curve: no lp to pull yet");
  else if (sec && (sec.lpLocked != null || sec.lpLockedPct != null)) {
    const lockedPct = sec.lpLockedPct ?? null;
    const locked = lockedPct !== null ? lockedPct >= SEVERITY.lpLockedPct : sec.lpLocked === true;
    add("lp lock", locked ? "ok" : "danger", lockedPct !== null ? `${pct(lockedPct)} locked or burned` : sec.lpLocked ? "locked" : "not locked");
  }
  if (m && m.liquidityUsd !== null && !m.curve && m.liquidityUsd < SEVERITY.liquidityWarnUsd) add("liquidity", m.liquidityUsd < SEVERITY.liquidityDangerUsd ? "danger" : "warn", usd(m.liquidityUsd));
  // a mint with no pool says so; a pools read that failed says nothing, nor one on another address: a pasted pair's own
  // read finds no pools under the pair's address, and its token has that pool
  const pair = f.notes.some((n) => n.startsWith("the address asked is a trading pair's"));
  const noPool = f.results.some((r) => r.name === "token_pairs" && r.args.token_address === f.address && !r.result.ok && r.result.error === "not_found");
  if (!f.market && !pair && noPool) add("liquidity", "warn", "no pool");
  if (m && (m.buys24h ?? 0) >= 10 && m.sells24h === 0) add("sells 24h", "danger", `0 against ${m.buys24h} buys`);
  if (sec?.rugged === true) add("rugged", "danger", "marked by rugcheck");
  if ((sec?.insiders ?? 0) > 0) add("insiders", "warn", `${sec!.insiders} wallet${sec!.insiders === 1 ? "" : "s"}`);
  if ((sec?.creatorOther ?? 0) > 0) add("dev's other coins", sec!.creatorOther! >= SEVERITY.devCoinsWarn ? "warn" : "note", String(sec!.creatorOther));
  if (h?.equalBags) add("same-size bags", "warn", `${h.equalBags.wallets} wallets at ${pct(h.equalBags.pctEach)} each`);
  // an old, large token's concentration is a warning, a young or small one's danger
  const old = mature(f.market);
  if (h?.top10WalletsPct != null) {
    const l = byShare(h.top10WalletsPct, SEVERITY.top10DangerPct, SEVERITY.top10WarnPct);
    add("top 10 wallets", old && l === "danger" ? "warn" : l, pct(h.top10WalletsPct));
  } else if (h?.top10Pct != null) add("top 10 accounts", h.top10Pct >= 50 ? (old ? "warn" : "danger") : "ok", `${pct(h.top10Pct)} with pools`);
  if (h?.largestWalletPct != null) {
    const l = byShare(h.largestWalletPct, SEVERITY.largestDangerPct, SEVERITY.largestWarnPct);
    add("largest wallet", old && l === "danger" ? "warn" : l, pct(h.largestWalletPct));
  }
  // the dev: the launch read's or the creator read's, with the top holders it sent tokens to (scanDev)
  const dev = scanDev(f)?.dev ?? null;
  if (dev?.level && dev.holdsPct !== null) add("dev holds", dev.level, devValue(dev));
  return worstFirst(out.map((c) => ({ label: c.label, status: blockStatus(c.level), value: c.value })));
}

/** The verdict level of a token block's checks: its worst (danger: high risk, warn: mixed, else low); the model words it */
export function checksVerdict(checks: readonly unknown[]): "high" | "mixed" | "low" {
  return verdictLevel(worst(checks.map((c) => (isObj(c) ? severityOf(c.status) : null)).filter((l): l is Severity => l !== null)));
}

/** A deeper read that is back (ScanFacts.deep): its data; null for one that failed, is still running or was not asked */
const deepData = (v: Record<string, unknown> | null | "running" | undefined): Record<string, unknown> | null => (v && v !== "running" ? v : null);

/**
 * The scan's dev on the dev scale (trench.ts): the launch read's when it read what the dev holds (its dev is the first
 * buyer), else the creator read's (the scan's dev), each with the top holders it sent tokens to when the holder links are
 * in (sideWallets); null when neither read it. The dossier's dev line and the token block's "dev holds" are this one
 */
export function scanDev(f: ScanFacts): { from: "launch" | "creator"; dev: DevRead } | null {
  const links = deepData(f.deep?.links);
  const launched = launchParts(deepData(f.deep?.launch), links)?.dev ?? null;
  if (launched && launched.holdsPct !== null) return { from: "launch", dev: launched };
  const c = f.dev?.found ? f.dev : null;
  return c && c.holdsPct !== null ? { from: "creator", dev: creatorRead(c, sideWallets(links, c.creator ?? null)) } : null;
}

/** The dev's check value: what it holds, with its side wallets when it sent tokens to some, or a big bag that left it unplaced */
function devValue(d: DevRead): string {
  const holds = d.holdsPct ?? 0;
  // one hand made most of the coin at launch: said whatever it holds now
  if ((d.boughtPct ?? 0) >= DEV_MAJORITY_PCT) return `${pct(holds)}, bought ${pct(d.boughtPct!)} at launch`;
  if (d.side && d.side.wallets > 0) return `${pct(holds + d.side.pct)} with ${d.side.wallets} side wallet${d.side.wallets === 1 ? "" : "s"}`;
  return d.side === null && (d.leftPct ?? 0) >= SEVERITY.devDangerPct ? `${pct(holds)}, ${pct(d.leftPct!)} sold or sent` : pct(holds);
}

/** A turnover as the dossier writes it ("58x", "4.2x") */
const times = (x: number): string => `${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}x`;

/**
 * The market as a trencher reads it, by code: liquidity against the cap and the day's turnover, a warning when it is thin
 * for its size (off an old, large coin) or its volume looks farmed (SEVERITY), with the day's buys and sells; `value`:
 * the token block's market check, null when nothing warns. Null on a curve (its depth is not listed) or without
 * liquidity. The dossier's market line (harness.ts) and the token block's check are this one
 */
export function marketRead(m: ScanFacts["market"]): { level: Severity; parts: string[]; value: string | null } | null {
  if (!m || m.curve || m.liquidityUsd === null || m.liquidityUsd <= 0) return null;
  const cap = m.mcapUsd ?? m.fdvUsd;
  const parts: string[] = [];
  let thin: number | null = null;
  let farmed: number | null = null;
  if (cap) {
    const share = (m.liquidityUsd / cap) * 100;
    parts.push(`liquidity ${pct(share)} of its cap`);
    // an old, large coin's pools are a few percent of its cap by nature (exchanges carry its volume): never thin by that
    if (share < SEVERITY.thinLiquidityPct && !mature(m)) {
      thin = share;
      parts.push("thin for its size");
    }
  }
  if (m.volume24hUsd !== null) {
    const turn = m.volume24hUsd / m.liquidityUsd;
    parts.push(`24h volume ${times(turn)} its liquidity`);
    if (turn > SEVERITY.farmedTurnover && (m.oldestPoolAgeDays ?? 0) > 1) {
      farmed = turn;
      parts.push("turnover that high on a coin this old is often farmed");
    }
  }
  if (m.buys24h !== null && m.sells24h !== null) parts.push(`${m.buys24h} buys, ${m.sells24h} sells in 24h`);
  if (parts.length === 0) return null;
  const value = thin !== null && farmed !== null ? `thin, volume ${times(farmed)} liquidity` : thin !== null ? `thin: liquidity ${pct(thin)} of cap` : farmed !== null ? `volume ${times(farmed)} its liquidity` : null;
  return { level: value ? "warn" : "note", parts, value };
}

/**
 * The token block's checks from the dossier's reads beside the scan's own, on the one scale, so the card's level is the
 * dossier's worst: a thin or farmed market (any chain's: the dossier says it of an evm coin too), and from the chat
 * app's deeper reads (ScanFacts.deep) the launch's bundle and snipers (a screen's snipers only once their floor is over
 * the line), the largest tied cluster, a story copied or farmed. The dev is tokenChecks' own (scanDev)
 */
function deepChecks(f: ScanFacts): TokenBlockCheck[] {
  const out: { label: string; level: Severity; value: string }[] = [];
  const market = marketRead(f.market);
  if (market?.value) out.push({ label: "market", level: market.level, value: market.value });
  const d = f.deep ?? {};
  const launch = launchParts(deepData(d.launch));
  for (const [label, r] of [["bundle", launch?.bundle], ["snipers", launch?.snipers]] as const) {
    if (!r?.level || r.holdsPct === null) continue;
    // a screen's snipers are a floor (the creation block's bundle is whole on the first page)
    const floor = label === "snipers" && launch!.seen !== null ? "+" : "";
    out.push({ label, level: r.level, value: `${pct(r.holdsPct)}${floor} held, ${r.wallets} wallet${r.wallets === 1 ? "" : "s"}` });
  }
  const cluster = clusterOf(deepData(d.links));
  if (cluster) out.push({ label: "tied cluster", level: cluster.level, value: cluster.sharePct !== null ? `${pct(cluster.sharePct)} in ${cluster.wallets} wallets${cluster.funders ? `, ${cluster.funders} funder${cluster.funders === 1 ? "" : "s"}` : ""}` : "none in the top holders" });
  // past the top holders: a cabal spread thin, on the card when it is one (a wide band alone is none)
  const thin = spreadOf(deepData(d.spread));
  if (thin?.cabal) out.push({ label: "cabal", level: thin.level, value: `${pct(thin.bandPct)} in ${thin.wallets} small wallets` });
  // a story's level is its copy or its farm (a live meta is context): its words name no coin on the card (the index's
  // names are anyone's text)
  const story = storyOf(deepData(d.narrative), { narratives: [], groups: [] });
  if (story && story.level !== "ok") out.push({ label: "story", level: story.level, value: story.copied && story.farmed ? "a copy, farmed" : story.copied ? "a copy of another coin" : "farmed" });
  // where the dev's bag went (its money trail): sent on to wallets outside the top holders, the dev's warning
  const trail = f.address ? devTrailOf(deepData(d.trail), f.address, scanDev(f)?.dev.leftPct ?? null, deepData(d.links)) : null;
  if (trail && trail.level !== "note") out.push({ label: "dev's bag", level: trail.level, value: trail.value });
  return out.map((c) => ({ label: c.label, status: blockStatus(c.level), value: c.value }));
}

/** Checks worst first, the same level keeping its order (a card cuts at 12: what can take the money is never the one cut) */
function worstFirst(checks: TokenBlockCheck[]): TokenBlockCheck[] {
  const rank = (c: TokenBlockCheck) => SEVERITY_ORDER.indexOf(severityOf(c.status) ?? "note");
  return checks
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i)
    .map(({ c }) => c);
}

/** The token block's checks: the scan's own (tokenChecks) and the deeper reads' (deepChecks), worst first */
function cardChecks(f: ScanFacts): TokenBlockCheck[] {
  return worstFirst([...tokenChecks(f), ...deepChecks(f)]);
}

/**
 * The ```token block of a scanned token, built by code from the facts: the fields a chat UI reads (docs/BLOCKS.md),
 * only those a source returned, market numbers that cannot be true left out (finish), her own token's as
 * any other's. The model adds its verdict. Null for anything but a token, or with neither a printable symbol nor a
 * valid address.
 */
export function tokenBlock(f: ScanFacts): Record<string, unknown> | null {
  if (f.kind !== "token") return null;
  const chain = f.chain && /^[a-z][a-z0-9-]{1,19}$/.test(f.chain) ? f.chain : null;
  const address = f.address && (chain === "solana" ? MINT.test(f.address) : /^0x[0-9a-fA-F]{40}$/.test(f.address)) ? f.address : null;
  const symbol = f.symbol?.toUpperCase() ?? null;
  if (!symbol && !address) return null;
  const m = f.market;
  const days = f.market?.oldestPoolAgeDays ?? (f.dev?.found ? f.dev.ageDays : null);
  const explorer = chain ? EXPLORERS[chain] : undefined;
  const links = address && explorer ? [{ label: explorer[0], url: `${explorer[1]}${address}` }, { label: "dex screener", url: `https://dexscreener.com/${chain}/${address}` }] : [];
  const money = (key: string, v: number | null | undefined) => (typeof v === "number" ? { [key]: v } : {});
  return {
    ...(symbol ? { symbol } : {}),
    ...(chain ? { chain } : {}),
    ...(address ? { address } : {}),
    ...money("price", m?.priceUsd),
    ...money("mcap", m?.mcapUsd),
    ...money("fdv", m?.fdvUsd),
    ...money("liquidity", m?.liquidityUsd),
    ...money("volume24h", m?.volume24hUsd),
    ...(days != null ? { age: shortAge(days) } : {}),
    checks: cardChecks(f),
    ...(links.length ? { links } : {}),
    ...(f.unreliable.length ? { note: "its dex market numbers look unreliable: left out" } : {}),
  };
}

/** An answer's ```token fences */
const TOKEN_FENCE = /```token[ \t]*\n([\s\S]*?)\n[ \t]*```/g;

/** What a check is about, so one the model wrote under its own words is not added twice ("lp locked" beside "lp lock") */
function checkKind(label: string): string {
  const l = label.toLowerCase().trim();
  if (l.includes("honeypot")) return "honeypot";
  if (/tax|fee|hook/.test(l)) return "tax";
  if (l.includes("lock")) return "lock";
  if (/risk|verdict/.test(l)) return "verdict";
  if (/other coins|serial/.test(l)) return "dev history";
  if (/\bdev\b|creator/.test(l)) return "dev";
  if (l.includes("bundl")) return "bundle";
  if (l.includes("sniper")) return "snipers";
  if (/cluster|tied/.test(l)) return "cluster";
  return l;
}

/**
 * An answer's ```token block of the scanned token with what its facts hold now (a call left running is read whenever
 * it lands, runScan whenBack): code's check of a kind the block lacks is added, code's unsettled one
 * (UNSETTLED) takes what code reads now, in place; a check the block holds otherwise stays (the model's own, from the
 * same data). The answer as is without such a block (another token's is left alone), with one that does not parse, or
 * with nothing new.
 */
export function withLateChecks(answer: string, f: ScanFacts): string {
  if (f.kind !== "token" || !f.address || !answer.includes("```token")) return answer;
  const code = cardChecks(f);
  return answer.replace(TOKEN_FENCE, (whole, body: string) => {
    let block: unknown;
    try {
      block = JSON.parse(body);
    } catch {
      return whole;
    }
    if (!isObj(block) || block.address !== f.address || !Array.isArray(block.checks)) return whole;
    const labelOf = (c: unknown): string | null => (isObj(c) && typeof c.label === "string" ? c.label : null);
    const unsettled = (c: unknown): boolean => isObj(c) && c.label === UNSETTLED.label && c.value === UNSETTLED.value;
    const checks: unknown[] = block.checks.map((c) => (unsettled(c) ? (code.find((k) => k.label === UNSETTLED.label) ?? c) : c));
    const kinds = new Set(checks.map(labelOf).filter((l): l is string => l !== null).map(checkKind));
    for (const k of code) {
      if (checks.includes(k) || kinds.has(checkKind(k.label))) continue;
      checks.push(k);
      kinds.add(checkKind(k.label));
    }
    // the verdict's level is its worst check's, whatever the model wrote (one scale: @crawlnet/shared severity.ts); the
    // model words it
    const level = checksVerdict(checks);
    const verdict = isObj(block.verdict) ? { ...block.verdict, level } : null;
    const next = { ...block, checks, ...(verdict ? { verdict } : {}) };
    const json = JSON.stringify(next);
    return json === JSON.stringify(block) ? whole : `\`\`\`token\n${json}\n\`\`\``;
  });
}

/**
 * A short answer code writes from a scan, with no model: the card's lines under a bold head, the red flags, and the
 * token block. For what is no token or wallet, what the scan found about it (no "nothing found" when a read behind it
 * failed); "" when there is nothing to say.
 */
export function scanBrief(f: ScanFacts): string {
  if (f.kind !== "token" && f.kind !== "wallet") {
    // "nothing found" stands only when every read behind it answered
    if (f.kind === "none" && (f.calls.length === 0 || f.calls.some((c) => !c.ok && c.error !== "not_found"))) return "";
    const said = f.notes.filter((n) => n !== UNRELIABLE_NOTE);
    return said.length ? `${said.join(". ")}.` : "";
  }
  const [first, ...rest] = scanCard(f).split("\n").filter(Boolean);
  if (!first) return "";
  const flags = f.flags;
  const lines = [
    `**${first}**, right now:`,
    ...rest.map((l) => `- ${l}`),
    ...(f.kind === "token" ? [`- red flags: ${flags.length ? flags.join("; ") : "none found"}`] : []),
  ];
  const card = tokenBlock(f);
  return card ? `${lines.join("\n")}\n\n\`\`\`token\n${JSON.stringify(card)}\n\`\`\`` : lines.join("\n");
}
/** The dossier's data, in characters, shared by its reads */
export const SCAN_DATA_CHARS_SITE = 24_000;

/** Pairs of a token's pool list the model reads (its totals carry the rest). */
const CHAT_SCAN_PAIRS = 3;
/** Holders the model reads (a clusters map draws about 12). */
const CHAT_SCAN_HOLDERS = 12;
/** Tokens of a ticker's search the model reads (the scanned one first). */
const CHAT_SCAN_TOKENS = 3;

const rowsOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
/** A pair's key fields: where it trades, against what, how deep, how traded, how old */
const pairKeys = (p: Record<string, unknown>): Record<string, unknown> => ({
  dex: p.dex,
  pair_address: p.pair_address,
  quote: isObj(p.quote) ? p.quote.symbol : null,
  liquidity_usd: p.liquidity_usd,
  volume_24h_usd: p.volume_24h_usd,
  pair_age_days: p.pair_age_days,
});

/**
 * A holder row without its token account where its owner is known (the address she names, links and asks about); an
 * owner the chain read did not give (ownersOf failed) leaves the token account as the row's only address
 */
const holderKeys = (r: Record<string, unknown>): Record<string, unknown> => {
  if (typeof r.owner !== "string" || !r.owner) return r;
  const { token_account: _ta, ...rest } = r;
  return rest;
};

/**
 * One scan result as the model reads it: totals and the key rows. A token's pools: its totals and its top
 * CHAT_SCAN_PAIRS pairs' key fields; a ticker's searches: the first CHAT_SCAN_TOKENS tokens (the scanned `address`
 * first), no pair list; its largest holders: the top CHAT_SCAN_HOLDERS (holderKeys). The token block and the flags are
 * code's, from the facts, and the rest come as returned, as do every result's sources.
 */
export function chatScanResult(name: string, result: ToolResult, address: string | null): ToolResult {
  if (!result.ok || !isObj(result.data)) return result;
  const d = result.data;
  const tokens = () => {
    const all = rowsOf(d.tokens);
    const mine = (t: Record<string, unknown>) => address !== null && [t.address, t.mint].some((a) => typeof a === "string" && a.toLowerCase() === address.toLowerCase());
    return [...all.filter(mine), ...all.filter((t) => !mine(t))].slice(0, CHAT_SCAN_TOKENS);
  };
  switch (name) {
    case "token_pairs":
      return { ...result, data: { ...d, pairs: rowsOf(d.pairs).slice(0, CHAT_SCAN_PAIRS).map(pairKeys) } };
    case "dex_pair_lookup": {
      const { pairs: _pairs, ...rest } = d;
      return { ...result, data: { ...rest, tokens: tokens() } };
    }
    case "sol_ticker_mint":
      return { ...result, data: { ...d, tokens: tokens() } };
    case "sol_largest_accounts":
      return { ...result, data: { ...d, accounts: rowsOf(d.accounts).slice(0, CHAT_SCAN_HOLDERS).map(holderKeys) } };
    default:
      return result;
  }
}
