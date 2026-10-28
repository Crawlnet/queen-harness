// A token's security check from two free, keyless sources: token_risk_flags, its arguments ({ chain, address }: what
// scan.ts and the model send), its flags under the keys the dossier reads (scan.ts readSecurity: is_honeypot,
// a buy/sell/transfer tax or fee, transfer_hook, non_transferable, balance_mutable, lp_locked_pct).
//   - Solana: RugCheck's full report (api.rugcheck.xyz/v1/tokens/{mint}/report; BONK's is 2.5 MB, its pools mostly):
//     the mint and freeze authority, the token-2022 extensions (transfer fee, transfer hook, permanent delegate,
//     non-transferable, close authority), the largest holders without the pools and lockers RugCheck knows (a bonding
//     curve is one, as in its own risks), the creator's share and other tokens, the pools' liquidity and the share of
//     it locked (its summary's lpLockedPct: locked USD over all pools' USD), its score (normalised 0-100: higher is
//     riskier) and its named risks;
//   - EVM chains: GoPlus's token security (api.gopluslabs.io/api/v1/token_security/{chain id}): honeypot, cannot buy or
//     sell all, buy/sell/transfer tax (unknown when it finds no DEX pool to simulate on), mint function, owner (hidden,
//     reclaimable, can change balances), proxy, blacklist, pausable transfers, the top 10 holders without burn
//     addresses and pools, the creator's and the owner's shares, the share of the pool's LP tokens locked or burned.
//     Facts as the source states them, never a verdict that a token is safe. RUGCHECK_PER_MIN and GOPLUS_PER_MIN reads
//     a minute, every caller together (RugCheck's keyless limit is 15 a second).

import { MB } from "../http.ts";
import { evmToken, goplusToken, rugcheckToken, solToken, src, uniqueSources } from "../links.ts";
import type { WindowLimiter } from "../limits.ts";
import { ANY_ADDRESS } from "../schema.ts";
import { MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, round, str, take, type FreeContext } from "./common.ts";

export const RUGCHECK_HOST = "api.rugcheck.xyz";
export const GOPLUS_HOST = "api.gopluslabs.io";
/** Reads a minute at most, every caller together */
export const RUGCHECK_PER_MIN = 20;
export const GOPLUS_PER_MIN = 30;
/** A full report's largest size read (its pools: BONK's 2.5 MB, WIF's 1.8 MB) */
const REPORT_MAX_BYTES = 16 * MB;
/** A token RugCheck first saw this recently: its read may still change (kept a minute, not the tool's TTL) */
const FRESH_MS = 15 * MINUTE;
/** RugCheck's named risks listed at most */
const RISKS_MAX = 12;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** The system program's address: an authority set to it is none */
const SYSTEM = "11111111111111111111111111111111";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
/** Token-2022 extensions that only describe the token (its name, its group): never listed */
const PLAIN_EXTENSIONS = new Set(["metadataPointer", "tokenMetadata", "groupPointer", "groupMemberPointer", "tokenGroup", "tokenGroupMember"]);
/** The addresses EVM tokens are burned to */
const BURN = new Set(["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"]);

/** GoPlus's chain ids by our chain names (links.ts's explorer names) */
const EVM_CHAIN_IDS: Readonly<Record<string, string>> = { ethereum: "1", bsc: "56", base: "8453", arbitrum: "42161", polygon: "137", optimism: "10", avalanche: "43114" };
/** A chain as a caller may name it, case and separators aside: ours (DEX Screener's), GeckoTerminal's, short ones */
const CHAIN_NAMES: Readonly<Record<string, string>> = {
  solana: "solana",
  sol: "solana",
  ethereum: "ethereum",
  eth: "ethereum",
  mainnet: "ethereum",
  bsc: "bsc",
  bnb: "bsc",
  bnbchain: "bsc",
  bnbsmartchain: "bsc",
  binance: "bsc",
  binancesmartchain: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  arbitrumone: "arbitrum",
  arb: "arbitrum",
  polygon: "polygon",
  polygonpos: "polygon",
  matic: "polygon",
  pol: "polygon",
  optimism: "optimism",
  op: "optimism",
  avalanche: "avalanche",
  avax: "avalanche",
  avalanchec: "avalanche",
  avalanchecchain: "avalanche",
};
const CHAINS = ["solana", ...Object.keys(EVM_CHAIN_IDS)];

/**
 * The chain to read: the one named (null for one we do not read), the address's own when none is (a base58 address is a
 * Solana mint whatever chain is named: no EVM chain writes its addresses so; a 0x one with no chain is read on ethereum)
 */
export function chainOf(raw: unknown, address: string): string | null {
  const named = typeof raw === "string" && raw.trim() ? (CHAIN_NAMES[raw.toLowerCase().replace(/[\s_.-]+/g, "")] ?? null) : undefined;
  if (named === null) return null;
  if (BASE58.test(address)) return "solana";
  return named ?? "ethereum";
}

/** GoPlus's yes or no ("1", "0", or a number), null when it says neither */
const yes = (v: unknown): boolean | null => (v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : null);
/** A share GoPlus gives on a 0-1 scale ("0.05": 5%), as a percent; null when it gives none ("": unknown) */
const pctOf = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : round(n * 100, 4);
};
/** A Solana authority: "none" when revoked, its address when set, null when not read */
function authority(v: unknown): string | null {
  if (v === null || v === "" || v === SYSTEM) return "none";
  return typeof v === "string" && BASE58.test(v) ? v : null;
}
const set = (a: string | null): boolean | null => (a === null ? null : a !== "none");
/** RugCheck's market type of a Meteora DLMM pool ("meteoraDlmm"): positions, never an lp to lock */
const DLMM = /dlmm/i;
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
/** A share of supply as a percent, kept to 4 significant digits and within 0-100 */
const share = (x: number): number => round(Math.min(100, Math.max(0, x)), 4)!;
/**
 * The facts without those the source left unsaid, except the `core` ones, null then (the queen's scan reads them, and
 * the model should see what was not said): a long list of nulls is only noise in the model's share of the data
 */
const compact = (o: Record<string, unknown>, core: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && (v !== null || core.has(k))));
/** Facts said even when unknown (null) */
const SOLANA_CORE = new Set(["mint_authority", "freeze_authority", "transfer_fee_pct", "transfer_hook", "non_transferable", "balance_mutable", "holders", "top10_holders_pct", "creator", "liquidity_usd", "lp_locked_pct", "rugcheck_score_normalised"]);
const EVM_CORE = new Set(["is_honeypot", "cannot_sell_all", "buy_tax_pct", "sell_tax_pct", "transfer_tax_pct", "is_open_source", "is_proxy", "mintable", "owner", "hidden_owner", "balance_mutable", "holders", "top10_holders_pct", "lp_locked_pct"]);

/** RugCheck's full report as our facts and whether RugCheck first saw the token lately; null when it holds no token */
function rugcheckFacts(r: Record<string, unknown>, mint: string, now: number): { data: Record<string, unknown>; fresh: boolean } | null {
  const token = isObj(r.token) ? r.token : null;
  if (!token || (typeof r.mint === "string" && r.mint !== mint)) return null;
  const supply = num(token.supply);
  const program = r.tokenProgram === TOKEN_PROGRAM ? "spl" : r.tokenProgram === TOKEN_2022 ? "token-2022" : null;
  const ext = isObj(r.token_extensions) ? r.token_extensions : null;
  // what the mint's extensions allow: nothing on a classic mint; unknown on a token-2022 one whose extensions were not read
  const known = program === "spl" || (program === "token-2022" && ext !== null);
  const sub = (k: string): Record<string, unknown> | null => {
    const v = ext ? ext[k] : null;
    return isObj(v) ? v : null;
  };
  const fee = sub("transferFeeConfig");
  const newer = fee && isObj(fee.newerTransferFee) ? fee.newerTransferFee : null;
  const older = fee && isObj(fee.olderTransferFee) ? fee.olderTransferFee : null;
  const bps = num(newer?.transferFeeBasisPoints);
  // the fee config's newer fee (it rules from its epoch on: a change takes two epochs); RugCheck's own flat transferFee
  // can read 0 where the config sets a fee, so it stands in only without a config
  const flat = isObj(r.transferFee) ? num(r.transferFee.pct) : null;
  const feePct = !known ? null : !fee ? (flat !== null && flat > 0 ? flat : 0) : bps === null ? null : round(bps / 100, 4);
  const hook = sub("transferHook");
  const delegate = sub("permanentDelegate") ? authority(sub("permanentDelegate")!.delegate) : known ? "none" : null;
  const closer = sub("mintCloseAuthority") ? authority(sub("mintCloseAuthority")!.closeAuthority) : known ? "none" : null;
  const extensions = ext ? Object.keys(ext).filter((k) => !PLAIN_EXTENSIONS.has(k) && ext[k] !== null && ext[k] !== false && ext[k] !== undefined) : [];

  // the largest holders: RugCheck's top token accounts less those it knows as pools or lockers (an AMM's, a bonding curve's)
  const knownAccounts = isObj(r.knownAccounts) ? r.knownAccounts : {};
  const pool = (a: unknown): boolean => {
    const k = typeof a === "string" ? knownAccounts[a] : null;
    return isObj(k) && /^(?:AMM|LOCKER)$/.test(String(k.type));
  };
  const top = Array.isArray(r.topHolders) ? r.topHolders.filter(isObj) : [];
  const wallets = top.filter((h) => !pool(h.owner) && !pool(h.address)).sort((a, b) => (num(b.pct) ?? 0) - (num(a.pct) ?? 0));
  const pcts = wallets.map((h) => num(h.pct) ?? 0);
  const creator = typeof r.creator === "string" && BASE58.test(r.creator) ? r.creator : null;
  const creatorBalance = num(r.creatorBalance);
  // the pools' liquidity and the share of it locked: RugCheck's summary lpLockedPct (WIF's 43.14 from its 928 pools);
  // and the same over the pools an lp can be locked in, Meteora DLMM's left out
  const markets = Array.isArray(r.markets) ? r.markets.filter(isObj) : null;
  let poolUsd = 0;
  let lockedUsd = 0;
  let lockableUsd = 0;
  let lockableLockedUsd = 0;
  for (const m of markets ?? []) {
    const lp = isObj(m.lp) ? m.lp : null;
    if (!lp) continue;
    const usd = (num(lp.baseUSD) ?? 0) + (num(lp.quoteUSD) ?? 0);
    const locked = num(lp.lpLockedUSD) ?? 0;
    poolUsd += usd;
    lockedUsd += locked;
    if (DLMM.test(String(m.marketType))) continue;
    lockableUsd += usd;
    lockableLockedUsd += Math.min(locked, usd);
  }
  const meta = isObj(r.tokenMeta) ? r.tokenMeta : null;
  const mutable = meta ? meta.mutable : undefined;
  const named = meta ?? (isObj(r.fileMeta) ? r.fileMeta : null);
  const holders = num(r.totalHolders);
  // its named risks as it names them ("Mint Authority still enabled", "Single holder ownership" 23.63%), its level of each
  // (danger, warn); their descriptions only repeat the names
  const risks = (Array.isArray(r.risks) ? r.risks : [])
    .filter(isObj)
    .slice(0, RISKS_MAX)
    .flatMap((x) => {
      const name = str(x.name, 60);
      const value = str(x.value, 60);
      return name ? [{ name, level: str(x.level, 12), ...(value ? { value } : {}) }] : [];
    });
  const seen = typeof r.detectedAt === "string" ? Date.parse(r.detectedAt) : NaN;
  const fresh = Number.isFinite(seen) && now >= seen && now - seen < FRESH_MS;
  const notes = [
    "no honeypot or tax simulation on Solana: what can stop or tax a sale is a freeze authority, a transfer fee or hook, or a permanent delegate (balance_mutable)",
    "top10_holders_pct leaves out the pools and lockers RugCheck knows (pools_hold_pct)",
    "lp_locked_pct: the locked or burned share of all pools' liquidity in USD (a bonding curve's counts as locked)",
    "lp_locked_pct_lockable: the same over the pools an lp can be locked in (Meteora DLMM's positions never are: left out, dlmm_liquidity_usd); what the deployer's own unlocked lp can pull is the rest of them",
    ...(fresh ? [`RugCheck first saw it ${Math.max(1, Math.round((now - seen) / MINUTE))} min ago: its read may still change`] : []),
  ];
  const facts: Record<string, unknown> = {
    chain: "solana",
    address: mint,
    name: str(named?.name, 40),
    symbol: str(named?.symbol, 20),
    source: "RugCheck",
    token_program: program,
    mint_authority: authority(token.mintAuthority),
    freeze_authority: authority(token.freezeAuthority),
    transfer_fee_pct: feePct,
    transfer_fee_changeable: fee ? set(authority(fee.transferFeeConfigAuthority)) : undefined,
    transfer_fee_from_epoch: newer && older && num(newer.transferFeeBasisPoints) !== num(older.transferFeeBasisPoints) ? (num(newer.epoch) ?? undefined) : undefined,
    transfer_hook: !known ? null : hook ? set(authority(hook.programId)) : false,
    transfer_hook_changeable: hook ? set(authority(hook.authority)) : undefined,
    non_transferable: !known ? null : ext?.nonTransferable === true,
    balance_mutable: set(delegate),
    permanent_delegate: delegate && delegate !== "none" ? delegate : undefined,
    mint_closable: closer && closer !== "none" ? true : undefined,
    extensions: extensions.length ? extensions : undefined,
    metadata_mutable: typeof mutable === "boolean" ? mutable : null,
    holders: holders !== null && holders > 0 ? holders : null,
    top10_holders_pct: top.length ? share(sum(pcts.slice(0, 10))) : null,
    largest_holder_pct: top.length ? share(pcts[0] ?? 0) : null,
    pools_hold_pct: top.length ? share(sum(top.filter((h) => pool(h.owner) || pool(h.address)).map((h) => num(h.pct) ?? 0))) : null,
    insiders_in_top_holders: top.length ? wallets.filter((h) => h.insider === true).length : null,
    insider_wallets_detected: (num(r.graphInsidersDetected) ?? 0) > 0 ? num(r.graphInsidersDetected) : undefined,
    creator,
    creator_holds_pct: creator && supply && supply > 0 && creatorBalance !== null ? share((creatorBalance / supply) * 100) : null,
    creator_other_tokens: creator && Array.isArray(r.creatorTokens) ? r.creatorTokens.length : undefined,
    launchpad: isObj(r.launchpad) ? (str(r.launchpad.name, 30) ?? undefined) : undefined,
    liquidity_usd: markets ? round(num(r.totalMarketLiquidity) ?? poolUsd, 4) : null,
    lp_locked_pct: poolUsd > 0 ? share((lockedUsd / poolUsd) * 100) : null,
    lp_locked_usd: poolUsd > 0 ? round(lockedUsd, 0) : undefined,
    lp_locked_pct_lockable: lockableUsd > 0 ? share((lockableLockedUsd / lockableUsd) * 100) : null,
    dlmm_liquidity_usd: poolUsd - lockableUsd > 0 ? round(poolUsd - lockableUsd, 0) : undefined,
    pools: markets ? markets.length : null,
    rugged: typeof r.rugged === "boolean" ? r.rugged : null,
    jupiter_verified: isObj(r.verification) ? r.verification.jup_verified === true : undefined,
    rugcheck_score: num(r.score),
    rugcheck_score_normalised: num(r.score_normalised),
    risks,
    note: notes.join("; "),
  };
  return { data: compact(facts, SOLANA_CORE), fresh };
}

/** GoPlus's token security record as our facts (`partial`: GoPlus said it was still reading the token) */
export function goplusFacts(t: Record<string, unknown>, chain: string, address: string, partial = false): Record<string, unknown> {
  const inDex = yes(t.is_in_dex);
  // its taxes come from a trade it simulates on a pool it trades on: none found, none simulated (it still answers "0")
  const tax = (v: unknown): number | null => (inDex === false ? null : pctOf(v));
  const ownerRaw = t.owner_address;
  const owner = typeof ownerRaw !== "string" ? null : ownerRaw === "" || BURN.has(ownerRaw.toLowerCase()) ? "none" : EVM.test(ownerRaw) ? ownerRaw.toLowerCase() : null;
  const dexListed = Array.isArray(t.dex);
  const dex = Array.isArray(t.dex) ? t.dex.filter(isObj) : [];
  const pairs = new Set(dex.map((d) => (typeof d.pair === "string" ? d.pair.toLowerCase() : "")).filter(Boolean));
  // the top 10 holders GoPlus lists, less the burn addresses and the pools it lists
  const list = (Array.isArray(t.holders) ? t.holders : []).filter(isObj).map((h) => ({ address: typeof h.address === "string" ? h.address.toLowerCase() : "", tag: typeof h.tag === "string" ? h.tag : "", pct: pctOf(h.percent) ?? 0 }));
  const burned = (h: (typeof list)[number]): boolean => BURN.has(h.address) || /\bburn|black ?hole/i.test(h.tag);
  const wallets = list.filter((h) => !burned(h) && !pairs.has(h.address)).sort((a, b) => b.pct - a.pct);
  // the main pool's LP tokens locked (a locker GoPlus knows) or burned, among its 10 largest LP holders
  const lp = Array.isArray(t.lp_holders) ? t.lp_holders.filter(isObj) : [];
  const lpLocked = sum(lp.filter((h) => yes(h.is_locked) === true || (typeof h.address === "string" && BURN.has(h.address.toLowerCase()))).map((h) => num(h.percent) ?? 0));
  const cex = isObj(t.is_in_cex) && yes(t.is_in_cex.listed) === true && Array.isArray(t.is_in_cex.cex_list) ? t.is_in_cex.cex_list.map((c) => str(c, 30)).filter((c): c is string => c !== null).slice(0, 6) : [];
  const fake = isObj(t.fake_token) && num(t.fake_token.value) === 1 ? str(t.fake_token.true_token_address, 200) : null;
  const creator = typeof t.creator_address === "string" && EVM.test(t.creator_address) ? t.creator_address.toLowerCase() : null;
  const holders = num(t.holder_count);
  const notes = [
    "top10_holders_pct leaves out burn addresses and the pools GoPlus lists (burned_pct, pools_hold_pct)",
    "lp_locked_pct: the main pool's LP tokens locked or burned, among its 10 largest LP holders",
    ...(inDex === false ? ["GoPlus finds no DEX pool it trades on: no taxes were simulated"] : []),
    ...(yes(t.is_open_source) === false ? ["closed source: GoPlus cannot read its functions (honeypot, mint and owner flags unknown)"] : []),
    ...(yes(t.is_proxy) === true ? ["a proxy: its code can be changed, and some flags may be missing"] : []),
    ...(partial ? ["GoPlus was still reading it: partial"] : []),
  ];
  const facts: Record<string, unknown> = {
    chain,
    address,
    name: str(t.token_name, 40),
    symbol: str(t.token_symbol, 20),
    source: "GoPlus",
    is_honeypot: yes(t.is_honeypot),
    cannot_buy: yes(t.cannot_buy),
    cannot_sell_all: yes(t.cannot_sell_all),
    buy_tax_pct: tax(t.buy_tax),
    sell_tax_pct: tax(t.sell_tax),
    transfer_tax_pct: tax(t.transfer_tax),
    tax_modifiable: yes(t.slippage_modifiable),
    personal_tax_modifiable: yes(t.personal_slippage_modifiable),
    is_open_source: yes(t.is_open_source),
    is_proxy: yes(t.is_proxy),
    mintable: yes(t.is_mintable),
    owner,
    owner_holds_pct: owner && owner !== "none" ? pctOf(t.owner_percent) : undefined,
    hidden_owner: yes(t.hidden_owner),
    can_take_back_ownership: yes(t.can_take_back_ownership),
    // the owner can change holders' balances: the key the queen reads for "an authority can change holders' balances"
    balance_mutable: yes(t.owner_change_balance),
    selfdestruct: yes(t.selfdestruct),
    external_call: yes(t.external_call),
    transfer_pausable: yes(t.transfer_pausable),
    has_blacklist: yes(t.is_blacklisted),
    has_whitelist: yes(t.is_whitelisted),
    anti_whale: yes(t.is_anti_whale),
    anti_whale_modifiable: yes(t.anti_whale_modifiable),
    trading_cooldown: yes(t.trading_cooldown),
    holders,
    top10_holders_pct: list.length ? share(sum(wallets.slice(0, 10).map((h) => h.pct))) : null,
    largest_holder_pct: list.length ? share(wallets[0]?.pct ?? 0) : null,
    burned_pct: list.length ? share(sum(list.filter(burned).map((h) => h.pct))) : null,
    pools_hold_pct: list.length ? share(sum(list.filter((h) => !burned(h) && pairs.has(h.address)).map((h) => h.pct))) : null,
    creator,
    creator_holds_pct: creator ? pctOf(t.creator_percent) : null,
    honeypot_with_same_creator: yes(t.honeypot_with_same_creator),
    lp_holders: num(t.lp_holder_count),
    lp_locked_pct: lp.length ? share(lpLocked * 100) : null,
    dex_pools: dexListed ? dex.length : null,
    dex_liquidity_usd: dex.length ? round(sum(dex.map((d) => num(d.liquidity) ?? 0)), 4) : null,
    listed_on_cex: cex.length ? cex : undefined,
    airdrop_scam: yes(t.is_airdrop_scam) === true ? true : undefined,
    fake_token_of: fake ?? undefined,
    other_risks: str(t.other_potential_risks, 200) ?? undefined,
    goplus_note: str(t.note, 200) ?? undefined,
    note: notes.join("; "),
  };
  return compact(facts, EVM_CORE);
}

export function securityTools(fc: FreeContext & { limit: { rugcheck: WindowLimiter; goplus: WindowLimiter } }): ToolDef[] {
  /** A Solana mint's report from RugCheck */
  async function solana(mint: string, signal: AbortSignal): Promise<Outcome> {
    take(fc.limit.rugcheck);
    const r = await fc.http.json(`https://${RUGCHECK_HOST}/v1/tokens/${mint}/report`, { signal, maxBytes: REPORT_MAX_BYTES });
    const read = isObj(r) ? rugcheckFacts(r, mint, fc.now()) : null;
    if (!read) return { ok: false, error: "not_found" };
    return {
      ok: true,
      data: read.data,
      sources: uniqueSources([src("RugCheck: token report", rugcheckToken(mint)), src("Solscan: token", solToken(mint))]),
      ...(read.fresh ? { brief: true } : {}),
    };
  }

  /** An EVM contract's record from GoPlus */
  async function evm(chain: string, address: string, signal: AbortSignal): Promise<Outcome> {
    take(fc.limit.goplus);
    const id = EVM_CHAIN_IDS[chain]!;
    const contract = address.toLowerCase();
    const r = await fc.http.json(`https://${GOPLUS_HOST}/api/v1/token_security/${id}?contract_addresses=${contract}`, { signal });
    if (!isObj(r)) throw new ToolFail("unavailable");
    // its status codes: 1 complete, 2 partial (complete in about 15 s), 2004 a bad address, 2020 not a contract, 2021 no
    // info for it, 4029 its request limit, 5000 its own error
    const code = num(r.code);
    if (code === 4029) throw new ToolFail("rate_limited");
    if (code === 2004 || code === 2020 || code === 2021) return { ok: false, error: "not_found" };
    if (code !== 1 && code !== 2) throw new ToolFail("unavailable");
    const result = isObj(r.result) ? r.result : null;
    const entry = result ? (result[contract] ?? (Object.keys(result).length === 1 ? Object.values(result)[0] : null)) : null;
    // an address it knows nothing about: {"code":1,"result":{}}
    if (!isObj(entry) || Object.keys(entry).length === 0) return { ok: false, error: "not_found" };
    return {
      ok: true,
      data: goplusFacts(entry, chain, contract, code === 2),
      sources: uniqueSources([src("GoPlus: token security", goplusToken(id, contract)), src("Explorer: token", evmToken(chain, contract))]),
      ...(code === 2 ? { brief: true } : {}),
    };
  }

  const flags: ToolDef = {
    name: "token_risk_flags",
    description:
      "Security facts of a token by address. Solana (RugCheck): mint and freeze authority, token-2022 transfer fee, hook, permanent delegate (balance_mutable), non-transferable; holders, top 10 share without pools, creator's share; liquidity and share locked; RugCheck's score (0-100, higher is riskier) and named risks. EVM (GoPlus): honeypot, cannot sell all, buy/sell/transfer tax, mintable, owner, hidden owner, owner can change balances, proxy, blacklist, pausable; holders; LP locked. The source's facts, not a verdict and not investment advice.",
    parameters: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description: "The token's chain: solana, ethereum, bsc, base, arbitrum, polygon, optimism or avalanche (a base58 address is read on Solana; a 0x one on ethereum when none is given)",
          maxLength: 40,
        },
        address: { type: "string", description: "The token's address: a Solana mint (base58) or an EVM contract (0x…)", pattern: ANY_ADDRESS },
      },
      required: ["address"],
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal }): Promise<Outcome> {
      const address = String(args.address);
      const chain = chainOf(args.chain, address);
      if (chain === null) return { ok: false, error: "bad_args", message: `chain must be one of: ${CHAINS.join(", ")}` };
      if (chain !== "solana") return evm(chain, address, signal);
      if (!BASE58.test(address)) return { ok: false, error: "bad_args", message: "a 0x address is an EVM contract: give its chain (ethereum, bsc, base, arbitrum, polygon, optimism or avalanche)" };
      return solana(address, signal);
    },
  };
  return [flags];
}
