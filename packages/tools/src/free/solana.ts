// Solana reads over the configured RPC endpoints (HELIUS_API_KEYS, SOLANA_RPC_URLS or SOLANA_RPC_URL; the public RPC
// without them). Read-only methods only: getAccountInfo, getTokenLargestAccounts,
// getTokenSupply, getSignaturesForAddress, getTransaction and, on Helius, the DAS getAsset and getTokenAccounts. Endpoint
// URLs may hold keys: they are never logged, returned or put in an error. Sources: Solscan pages.
// Also getMultipleAccounts (who owns the largest token accounts, what those owners are, what a trail's tokens are: their
// mint and metadata accounts) and getTokenAccountsByOwner (what a token's creator holds of it now, a wallet's token
// accounts for its money trail).

import { createHash } from "node:crypto";
import { base58Decode, base58Encode } from "@crawlnet/shared";
import { solAccount, solToken, solTx, src, uniqueSources } from "../links.ts";
import type { WindowLimiter } from "../limits.ts";
import { limitParam, SOL_ADDRESS, SOL_SIGNATURE } from "../schema.ts";
import { HOUR, MINUTE, ToolFail, type Outcome, type ToolDef } from "../types.ts";
import { isObj, num, round, str, take, type CallTag, type FreeContext } from "./common.ts";
import { MB, readCapped, statusError } from "../http.ts";
import { exchangeLabel, MAJOR_TOKENS, poolLabel, SQUADS_V4 } from "./labels.ts";

export const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com/?api-key=";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
/** PumpSwap (pump.fun's AMM) and its pool account: 8 bytes of discriminator, bump (1), index (2), then the creator, the base mint, the quote mint and the lp mint (32 each) */
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMPSWAP_BASE_AT = 43;
const PUMPSWAP_LP_AT = 107;
/** Owners whose lp tokens can never come back: the incinerator and the system program */
const LP_BURN_OWNERS = new Set(["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"]);
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A PumpSwap pool account's lp mint, when `mint` is one of its two sides; null for any other account */
export function pumpswapLpMint(data: Buffer, mint: string): string | null {
  if (data.length < PUMPSWAP_LP_AT + 32) return null;
  const at = (o: number) => base58Encode(data.subarray(o, o + 32));
  const base = at(PUMPSWAP_BASE_AT);
  const quote = at(PUMPSWAP_BASE_AT + 32);
  return base === mint || quote === mint ? at(PUMPSWAP_LP_AT) : null;
}

/**
 * The read-only methods this layer may call. Anything else is refused before a request is made.
 */
const RPC_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTokenAccountsByOwner",
  "getSignaturesForAddress",
  "getTransaction",
  "getAsset",
  "getTokenAccounts",
]);

/** Helius's DAS methods: its endpoints alone answer them */
const DAS_METHODS = new Set(["getAsset", "getTokenAccounts"]);

/**
 * Owners of pool vaults that hold no account of their own (program-derived authorities of the big AMMs and launchpads):
 * a token account they own is a pool's, never a wallet's. Raydium's AMM v4, its CPMM and its LaunchLab (bonk.fun's
 * bonding curves), Meteora's bonding curves (DBC) and its DAMM v2. Any other such authority is off the curve (onCurve).
 */
export const POOL_AUTHORITIES = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
  "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh",
  "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM",
  "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC",
]);

/** ed25519's field prime, and the curve's d (-121665/121666) */
const P = (1n << 255n) - 19n;
const powMod = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= P; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};
const D = (P - ((121665n * powMod(121666n, P - 2n)) % P)) % P;

/**
 * Whether an address is a point of ed25519, a key someone can hold the private key of; a program-derived address (a
 * pool's or a launchpad's vault authority, a multisig vault, an escrow) never is. As the chain decides it: y from the
 * 32 bytes (little-endian, the sign bit dropped), on the curve when x² = (y² - 1) / (d*y² + 1) has a root mod p, which
 * is when (y² - 1)(d*y² + 1) is zero or a square (Euler's criterion).
 */
export function onCurve(address: string): boolean {
  const b = base58Decode(address);
  return !!b && b.length === 32 && pointBytes(b);
}

function pointBytes(b: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i]! & 0x7f : b[i]!);
  const yy = (y * y) % P;
  const uv = (((yy + P - 1n) % P) * ((D * yy + 1n) % P)) % P;
  return uv === 0n || powMod(uv, (P - 1n) / 2n) === 1n;
}

/** What an address is: the one answer the holder list, the holder links and the money trail give */
export type AddressKind = "wallet" | "exchange" | "vault" | "pool" | "program" | "burn" | "unknown";
const BURN_ADDRESSES = new Set(["1nc1nerator11111111111111111111111111111111"]);

/**
 * What an address is, by the program owning its account (`program`: null when it has none, undefined when that was not
 * read), one rule for every tool. A known exchange's hot wallet is the exchange. Off the curve no one holds the key: a
 * System-owned account there holds SOL for a program, a multisig's or a treasury's vault (Squads' own accounts too),
 * and so may an address with no account at all; one a program owns is that program's account (a pool, a bonding curve,
 * an escrow), and so is one not read. On the curve: a wallet, a program's account when a program owns it, unknown with
 * no account (a wallet holding no SOL). An account a big AMM's program owns is a pool on either side where it holds
 * tokens; elsewhere it is that program's.
 */
export function addressKind(address: string, program: string | null | undefined, holdsTokens = false): AddressKind {
  if (BURN_ADDRESSES.has(address)) return "burn";
  if (POOL_AUTHORITIES.has(address) || (holdsTokens && poolLabel(program))) return "pool";
  if (exchangeLabel(address)) return "exchange";
  if (!onCurve(address)) return program === SYSTEM_PROGRAM || program === SQUADS_V4 || program === null ? "vault" : "program";
  return program === undefined || program === null ? "unknown" : program === SYSTEM_PROGRAM ? "wallet" : "program";
}

/** What each kind means for a holder, in plain words */
const KIND_NOTES: Partial<Record<AddressKind, string>> = {
  exchange: "an exchange's hot wallet: its customers' funds, not one holder's",
  vault: "no private key: a multisig's or a treasury's vault (a team's, a project's or a fund's), not a person's wallet",
  pool: "a liquidity pool: its tokens are the pool's liquidity, no one's holding",
  program: "no private key: a program account or address (a pool, a bonding curve, a launchpad's or a multisig's vault, an escrow)",
  burn: "the burn address",
  unknown: "no SOL account: a wallet holding no SOL",
};
/** A vault with no account of its own: whose it is is less sure (a program's authority holds none either) */
const BARE_VAULT_NOTE = "no private key and no SOL account: an address a program keeps tokens for (a multisig's vault, a locker's or a staking pool's), not a person's wallet";
const noteOf = (kind: AddressKind, program: string | null | undefined): string | undefined => (kind === "vault" && program === null ? BARE_VAULT_NOTE : KIND_NOTES[kind]);

/** What is known of who an address is without a profile call: an exchange's hot wallet, a Squads multisig's own account, a pool holding tokens by its AMM */
const labelOf = (address: string, program?: string | null, holdsTokens = false): string | null =>
  exchangeLabel(address) ?? (program === SQUADS_V4 ? "Squads multisig" : holdsTokens ? poolLabel(program) : null);

/** The address a program derives from seeds (findProgramAddress): the first bump from 255 down whose hash is off the curve */
export function programAddress(seeds: Uint8Array[], program: string): string | null {
  const id = base58Decode(program);
  if (!id || id.length !== 32) return null;
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    const b = h.update(Uint8Array.of(bump)).update(id).update("ProgramDerivedAddress").digest();
    if (!pointBytes(b)) return base58Encode(b);
  }
  return null;
}

/** The associated token account program */
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** A wallet's associated token account of `mint` under `tokenProgram`, or null */
export function associatedAccount(wallet: string, mint: string, tokenProgram: string): string | null {
  const w = base58Decode(wallet);
  const t = base58Decode(tokenProgram);
  const m = base58Decode(mint);
  return w && t && m && w.length === 32 && t.length === 32 && m.length === 32 ? programAddress([w, t, m], ATA_PROGRAM) : null;
}

/** A Squads v4 multisig's vault `index` (its program's seeds: "multisig", the multisig, "vault", the index as one byte) */
export function squadsVault(multisig: string, index: number): string | null {
  const m = base58Decode(multisig);
  return m && m.length === 32 ? programAddress([Buffer.from("multisig"), m, Buffer.from("vault"), Uint8Array.of(index)], SQUADS_V4) : null;
}

/** A Squads multisig's vaults tried: most keep everything in their first */
const SQUADS_VAULTS = 4;
/**
 * Whether a parsed transaction proves an address a Squads v4 vault: it calls Squads (the program is among its keys, as
 * in every Squads instruction; a plain deposit names no multisig anyway) and one of its keys off the curve is a
 * multisig that derives it, as one of its first SQUADS_VAULTS vaults. A vault tried is a hash per bump and a curve
 * check, ~1 ms a key, so a transaction that does not call Squads is never tried.
 */
export function squadsVaultIn(r: unknown, address: string): boolean {
  const msg = isObj(r) && isObj(r.transaction) && isObj(r.transaction.message) ? r.transaction.message : {};
  const keys = Array.isArray(msg.accountKeys) ? msg.accountKeys.map((k) => (isObj(k) ? k.pubkey : k)) : [];
  if (!keys.includes(SQUADS_V4)) return false;
  const derives = (multisig: string) => Array.from({ length: SQUADS_VAULTS }, (_, i) => i).some((i) => squadsVault(multisig, i) === address);
  return keys.some((k) => typeof k === "string" && k !== address && !onCurve(k) && derives(k));
}

/** Token Metadata: a classic mint's name and symbol are kept in an account it derives from the mint */
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const metadataAddress = (mint: string): string | null => {
  const m = base58Decode(mint);
  return m && m.length === 32 ? programAddress([Buffer.from("metadata"), base58Decode(METADATA_PROGRAM)!, m], METADATA_PROGRAM) : null;
};

/**
 * A Token Metadata account's symbol, update authority and verified creators (Borsh: its kind, 4 for a token's; the
 * update authority; the mint; the name, the symbol and the uri, each a u32 length and bytes padded with zeros; the
 * seller fee, a u16; then maybe the creators: a u32 count of an address, a verified flag and a share each); null for
 * anything else. A verified creator signed the token's metadata.
 */
export function readMetadata(b: Uint8Array): { symbol: string | null; update: string; creators: string[] } | null {
  if (b.length < 69 || b[0] !== 4) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 65;
  const text = (): string | null => {
    const n = at + 4 <= b.length ? view.getUint32(at, true) : -1;
    if (n < 0 || n > 200 || at + 4 + n > b.length) return null;
    const s = Buffer.from(b.subarray(at + 4, at + 4 + n)).toString("utf8").replace(/\0+$/, "");
    at += 4 + n;
    return s;
  };
  if (text() === null) return null;
  const symbol = tickerOf(text());
  const update = base58Encode(b.subarray(1, 33));
  const creators: string[] = [];
  if (text() !== null && at + 7 <= b.length && b[at + 2] === 1) {
    const n = view.getUint32(at + 3, true);
    for (let i = 0, c = at + 7; i < Math.min(n, 5) && c + 34 <= b.length; i++, c += 34) if (b[c + 32] === 1) creators.push(base58Encode(b.subarray(c, c + 32)));
  }
  return { symbol, update, creators };
}

/** A symbol fit to name an asset: printable, short, no cashtag; a known asset's ticker on another mint is none */
const KNOWN_TICKERS = new Set(["SOL", "WSOL", "USDC", "USDT", ...Object.values(MAJOR_TOKENS).map((t) => t.toUpperCase())]);
function tickerOf(v: unknown): string | null {
  const s = typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().replace(/^\$/, "").slice(0, 12) : "";
  return s && !KNOWN_TICKERS.has(s.toUpperCase()) ? s : null;
}

/** Transactions sol_money_trail reads at once, and the counterparties it lists each way */
const TRAIL_PARALLEL = 6;
const TRAIL_ROWS = 15;
const WSOL = "So11111111111111111111111111111111111111112";
/** Names of the assets everyone knows by name (others are their mint) */
const ASSET_NAMES: Record<string, string> = {
  SOL: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};
/** An asset's name known without a read: SOL, the stablecoins, the best-known tokens */
const knownName = (asset: string): string | null => (Object.hasOwn(ASSET_NAMES, asset) ? ASSET_NAMES[asset]! : Object.hasOwn(MAJOR_TOKENS, asset) ? MAJOR_TOKENS[asset]! : null);
/** Less than this moved is fees and rent, not a transfer */
const dust = (asset: string) => (asset === "SOL" ? 0.003 : 1e-9);

/** Endpoints a call tries at most, and the attempts each try may send (the registry's FREE_HEDGE: hedge legs) */
const RPC_TRIES = 3;
const HEDGE_LEGS = 3;
/** On Helius, credit-billed, a try is sent again only after a network failure (the registry's GECKO_HEDGE): two at most */
const HELIUS_HEDGE_LEGS = 2;
/** What a long read leaves of the shared RPC limiter for the scan and the other reads */
const RPC_RESERVE = 40;

/**
 * The calls of one long read (sol_holder_links, sol_money_trail): at most `max`, none once out of time, and none while
 * the shared RPC limiter is down to RPC_RESERVE plus what the calls in flight and the next may still take (a token per
 * endpoint tried and per hedge leg: `perCall`), so a scan never finds it empty. A refusal of the limiter stops them
 * all. The loops keep the room of the read's last calls (`tail`), what the addresses it found are. `cut`: why it
 * stopped; `passing`: whether a later read gets further.
 */
class ReadBudget {
  calls: number;
  cut: "time" | "cap" | "limit" | null = null;
  private refused = false;
  private inFlight = 0;
  private readonly limiter: WindowLimiter;
  private readonly signal: AbortSignal;
  private readonly max: number;
  private readonly perCall: number;
  private readonly tail: number;

  /** `used`: calls already made before it (counted against `max`); `tail`: the read's last calls, made after the loops */
  constructor(limiter: WindowLimiter, signal: AbortSignal, max: number, perCall: number, used = 0, tail = 1) {
    this.limiter = limiter;
    this.signal = signal;
    this.max = max;
    this.perCall = perCall;
    this.calls = used;
    this.tail = tail;
  }

  /** Room for a call and, after it, the read's last ones */
  room(): boolean {
    if (this.signal.aborted) this.cut = "time";
    else if (this.calls + this.tail >= this.max) this.cut ??= "cap";
    else if (this.limiter.left() <= RPC_RESERVE + (this.inFlight + 1 + this.tail) * this.perCall) this.cut ??= "limit";
    else return true;
    return false;
  }

  /** n calls, TRAIL_PARALLEL at once, while there is room: the results of those made, in order (a cut read makes the first ones), a failed one null */
  async each(n: number, work: (i: number) => Promise<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(TRAIL_PARALLEL, n) }, async () => {
        while (next < n && this.room()) {
          const i = next++;
          out[i] = null;
          this.calls++;
          this.inFlight++;
          try {
            out[i] = await work(i);
          } catch (err) {
            if (err instanceof ToolFail && err.code === "rate_limited") {
              this.cut ??= "limit";
              this.refused = true;
              next = n;
            }
          } finally {
            this.inFlight--;
          }
        }
      }),
    );
    return out;
  }

  /** One of the read's last calls, in the room the loops kept for them; null when out of time, without room after all, or failed */
  async last<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.signal.aborted || this.calls >= this.max || this.limiter.left() <= RPC_RESERVE + this.perCall) return null;
    this.calls++;
    try {
      return await work();
    } catch {
      return null;
    }
  }

  /**
   * Whether a later read gets further: out of time, refused by the limiter, or stopped by it before making half the
   * calls a read alone makes (other reads held the rest). A read that made them is cut at its own size: read again each
   * minute it would stop there again.
   */
  get passing(): boolean {
    return this.cut === "time" || this.refused || (this.cut === "limit" && this.calls * 2 < this.limiter.perWindow - RPC_RESERVE);
  }

  /** Why it stopped, for the model (complete: false) */
  why(): string | null {
    return this.cut === "time" ? "out of time: what was read so far" : this.cut ? `the read stopped at ${this.calls} data calls (the rest of the data budget is kept for other reads)` : null;
  }
}

/**
 * One parsed transaction's balance changes per asset and owner: "SOL" by account, each token by its mint and its token
 * account's owner.
 */
export function trailDeltas(r: Record<string, unknown>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const add = (asset: string, owner: string | null, d: number) => {
    if (!owner || !Number.isFinite(d) || d === 0) return;
    const m = out.get(asset) ?? new Map<string, number>();
    m.set(owner, (m.get(owner) ?? 0) + d);
    out.set(asset, m);
  };
  const meta = isObj(r.meta) ? r.meta : {};
  const tx = isObj(r.transaction) ? r.transaction : {};
  const msg = isObj(tx.message) ? tx.message : {};
  const keys = Array.isArray(msg.accountKeys) ? msg.accountKeys.map((k) => (isObj(k) ? str(k.pubkey, 50) : str(k, 50))) : [];
  const pre = Array.isArray(meta.preBalances) ? meta.preBalances : [];
  const post = Array.isArray(meta.postBalances) ? meta.postBalances : [];
  keys.forEach((k, i) => add("SOL", k, ((num(post[i]) ?? 0) - (num(pre[i]) ?? 0)) / 1e9));
  const tokenBal = (list: unknown) => {
    const m = new Map<number, { owner: string | null; mint: string | null; ui: number }>();
    if (Array.isArray(list))
      for (const b of list.filter(isObj)) {
        const idx = num(b.accountIndex);
        const ui = isObj(b.uiTokenAmount) ? num(b.uiTokenAmount.uiAmountString) : null;
        if (idx !== null) m.set(idx, { owner: str(b.owner, 50), mint: str(b.mint, 50), ui: ui ?? 0 });
      }
    return m;
  };
  const preT = tokenBal(meta.preTokenBalances);
  const postT = tokenBal(meta.postTokenBalances);
  for (const i of new Set([...preT.keys(), ...postT.keys()])) {
    const a = preT.get(i);
    const b = postT.get(i);
    const mint = b?.mint ?? a?.mint ?? null;
    if (!mint) continue;
    // a wrapped SOL account's lamports already count as SOL by its key: its owner gets them instead
    if (mint === WSOL) {
      const key = keys[i] ?? null;
      const d = (b?.ui ?? 0) - (a?.ui ?? 0);
      if (key) add("SOL", key, -d);
      add("SOL", b?.owner ?? a?.owner ?? null, d);
      continue;
    }
    add(mint, b?.owner ?? a?.owner ?? null, (b?.ui ?? 0) - (a?.ui ?? 0));
  }
  return out;
}

/**
 * Who sent `wallet` SOL in a transaction (jsonParsed): the account whose balance fell the most while the wallet's rose,
 * null when its balance did not rise
 */
export function firstSolFrom(tx: Record<string, unknown>, wallet: string): string | null {
  const meta = isObj(tx.meta) ? tx.meta : null;
  const msg = isObj(tx.transaction) && isObj(tx.transaction.message) ? tx.transaction.message : null;
  const keys = msg && Array.isArray(msg.accountKeys) ? msg.accountKeys.map((k) => (isObj(k) ? str(k.pubkey, 50) : str(k, 50))) : [];
  const pre = meta && Array.isArray(meta.preBalances) ? meta.preBalances : [];
  const post = meta && Array.isArray(meta.postBalances) ? meta.postBalances : [];
  const delta = (i: number): number => (num(post[i]) ?? 0) - (num(pre[i]) ?? 0);
  const at = keys.indexOf(wallet);
  if (at < 0 || delta(at) <= 0) return null;
  let from: string | null = null;
  let most = 0;
  keys.forEach((k, i) => {
    if (k && i !== at && delta(i) < most) {
      most = delta(i);
      from = k;
    }
  });
  return from;
}

/**
 * A transaction as kept once read (a confirmed one never changes): what the reads use of it (its time and slot, its keys
 * and signers, its SOL and token balances, its programs), never its instructions' data, inner instructions and logs: a
 * few kilobytes where the whole is tens
 */
export function slimTx(r: Record<string, unknown>): Record<string, unknown> {
  const meta = isObj(r.meta) ? r.meta : {};
  const tx = isObj(r.transaction) ? r.transaction : {};
  const msg = isObj(tx.message) ? tx.message : {};
  const balances = (list: unknown) =>
    (Array.isArray(list) ? list.filter(isObj) : []).map((b) => ({
      accountIndex: b.accountIndex,
      mint: b.mint,
      owner: b.owner,
      ...(typeof b.programId === "string" ? { programId: b.programId } : {}),
      uiTokenAmount: isObj(b.uiTokenAmount) ? { uiAmountString: b.uiTokenAmount.uiAmountString, uiAmount: b.uiTokenAmount.uiAmount } : {},
    }));
  return {
    slot: r.slot,
    blockTime: r.blockTime,
    ...(r.transactionIndex !== undefined ? { transactionIndex: r.transactionIndex } : {}),
    meta: { err: meta.err ?? null, fee: meta.fee, preBalances: meta.preBalances, postBalances: meta.postBalances, preTokenBalances: balances(meta.preTokenBalances), postTokenBalances: balances(meta.postTokenBalances) },
    transaction: {
      signatures: Array.isArray(tx.signatures) ? tx.signatures.slice(0, 1) : [],
      message: {
        accountKeys: Array.isArray(msg.accountKeys) ? msg.accountKeys.map((k) => (isObj(k) ? { pubkey: k.pubkey, signer: k.signer === true } : k)) : [],
        ...(isObj(msg.header) ? { header: msg.header } : {}),
        instructions: (Array.isArray(msg.instructions) ? msg.instructions.filter(isObj) : []).map((ix) => (typeof ix.programId === "string" ? { programId: ix.programId } : { programIdIndex: ix.programIdIndex })),
      },
    },
  };
}

/** Transactions kept by signature, in all (their JSON's length) at most: about ten thousand */
const TX_KEPT_BYTES = 32 * MB;
/** Addresses whose newest page was read lately, remembered at most */
const PAGED_MAX = 20_000;
/**
 * An address's newest page is read in one history call when this many of the transactions wanted of it are not kept:
 * 10 credits for up to 100, where each alone is 1
 */
const PAGE_WORTH = 10;

/**
 * Transactions kept by signature once read, as slimTx keeps them (a confirmed one never changes): the holder maps and
 * the money trails read the same holders' and wallets' newest transactions on every turn, so only those never read are
 * fetched. Each as its JSON, TX_KEPT_BYTES in all, the least read lately out first
 */
class TxStore {
  private readonly map = new Map<string, string>();
  private bytes = 0;

  get(signature: string): Record<string, unknown> | null {
    const s = this.map.get(signature);
    if (s === undefined) return null;
    this.map.delete(signature);
    this.map.set(signature, s);
    return JSON.parse(s) as Record<string, unknown>;
  }

  has(signature: string): boolean {
    return this.map.has(signature);
  }

  /** Keep a transaction as read: it comes back as kept (slimTx) */
  put(signature: string, tx: Record<string, unknown>): Record<string, unknown> {
    const slim = slimTx(tx);
    const s = JSON.stringify(slim);
    const was = this.map.get(signature);
    if (was !== undefined) {
      this.bytes -= was.length;
      this.map.delete(signature);
    }
    this.map.set(signature, s);
    this.bytes += s.length;
    while (this.bytes > TX_KEPT_BYTES && this.map.size > 1) {
      const [k, v] = this.map.entries().next().value!;
      this.map.delete(k);
      this.bytes -= v.length;
    }
    return slim;
  }
}

/** The owners of the token accounts a parsed transaction holds balances of */
function tokenOwnersOf(r: Record<string, unknown>): string[] {
  const meta = isObj(r.meta) ? r.meta : {};
  return [meta.preTokenBalances, meta.postTokenBalances].flatMap((l) => (Array.isArray(l) ? l.filter(isObj).flatMap((b) => str(b.owner, 50) ?? []) : []));
}

/** The launch keys' weight in the tools' RPC pool: above the other endpoints (weight 1 by default) */
const LAUNCH_KEY_WEIGHT = 2;

/** Signatures read per page (getSignaturesForAddress's maximum), and pages read at most looking for a mint's first one. */
export const ORIGIN_PAGE = 1000;
export const ORIGIN_PAGES = 5;

export interface RpcEndpoint {
  url: string;
  weight: number;
  helius: boolean;
}

/** Endpoints from env, highest weight first; the public RPC only when nothing is set. */
export function rpcEndpoints(env: NodeJS.ProcessEnv): RpcEndpoint[] {
  const out: RpcEndpoint[] = [];
  const seen = new Set<string>();
  const split = (raw: string | undefined) => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const weight = (token: string): { body: string; weight: number } => {
    const at = token.lastIndexOf("@");
    if (at > 0 && /^\d+(\.\d+)?$/.test(token.slice(at + 1).trim())) return { body: token.slice(0, at).trim(), weight: Number(token.slice(at + 1)) || 1 };
    return { body: token, weight: 1 };
  };
  const add = (url: string, w: number) => {
    if (!/^https?:\/\//.test(url) || seen.has(url)) return;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    seen.add(url);
    out.push({ url, weight: w, helius: /(^|\.)helius-rpc\.com$/i.test(host) });
  };
  for (const t of split(env.SOLANA_RPC_URLS)) {
    const { body, weight: w } = weight(t);
    add(body, w);
  }
  for (const t of split(env.HELIUS_API_KEYS)) {
    const { body, weight: w } = weight(t);
    if (/^[A-Za-z0-9_-]+$/.test(body)) add(HELIUS_RPC_BASE + body, w);
  }
  // the launch keys: the tools' reads go to them first, in turn, and the other endpoints (SOLANA_RPC_URLS) carry the
  // tools only when they fail
  for (const t of split(env.HELIUS_LAUNCH_KEYS)) if (/^[A-Za-z0-9_-]{20,64}$/.test(t)) add(HELIUS_RPC_BASE + t, LAUNCH_KEY_WEIGHT);
  const single = env.SOLANA_RPC_URL?.trim();
  if (single) add(single, out.length ? 0.5 : 1);
  if (!out.length) add(PUBLIC_RPC, 1);
  return out.sort((a, b) => b.weight - a.weight);
}

export class SolanaRpc {
  private readonly fc: FreeContext;
  readonly endpoints: RpcEndpoint[];
  /** Where the next call starts among the highest-weight endpoints */
  private turn = 0;

  constructor(fc: FreeContext, endpoints: RpcEndpoint[]) {
    this.fc = fc;
    this.endpoints = endpoints;
  }

  /**
   * The endpoints a call tries, in order: the highest-weight ones in turn (each call starts at the next), then the
   * rest. A launch key the launch read holds as spent is never tried, one resting goes last, and a call's tries reach
   * the lower endpoints after RPC_TRIES - 1 of the group
   */
  order(eps: readonly RpcEndpoint[]): RpcEndpoint[] {
    const keys = this.fc.launchKeys;
    const state = (e: RpcEndpoint) => keys?.state(e.url) ?? "ready";
    if (eps.length < 2) return eps.filter((e) => state(e) !== "spent");
    const top = Math.max(...eps.map((e) => e.weight));
    const group = eps.filter((e) => e.weight === top);
    const k = this.turn++ % group.length;
    const turned = [...group.slice(k), ...group.slice(0, k)];
    const ready = turned.filter((e) => state(e) === "ready");
    const rest = eps.filter((e) => e.weight !== top && state(e) === "ready");
    const resting = [...turned, ...eps.filter((e) => e.weight !== top)].filter((e) => state(e) === "resting");
    const head = rest.length ? ready.slice(0, RPC_TRIES - 1) : ready;
    return [...head, ...rest, ...ready.slice(head.length), ...resting];
  }

  get hasDas(): boolean {
    return this.endpoints.some((e) => e.helius);
  }

  /** The limiter's tokens one call may take: a token per endpoint tried, each try with its hedge legs, two on Helius */
  get tokensPerCall(): number {
    return Math.min(RPC_TRIES, this.endpoints.length) * (this.endpoints.every((e) => e.helius) ? HELIUS_HEDGE_LEGS : HEDGE_LEGS);
  }

  /**
   * One JSON-RPC call, failing over to the next endpoint on 429 / 5xx / network trouble (at most 3 tries). On a launch
   * key a 429's body is read (out of credits, the launch read spends the key at once; else it rests), and an answer is
   * booked under the key, the tool and the asker (`tag`)
   */
  async call(method: string, params: unknown, signal: AbortSignal, tag?: CallTag): Promise<unknown> {
    if (!RPC_METHODS.has(method)) throw new ToolFail("unavailable");
    const eps = DAS_METHODS.has(method) ? this.endpoints.filter((e) => e.helius) : this.endpoints;
    if (!eps.length) throw new ToolFail("unavailable");
    const keys = this.fc.launchKeys;
    let last: ToolFail = new ToolFail("unavailable");
    for (const ep of this.order(eps).slice(0, RPC_TRIES)) {
      take(this.fc.limit.rpc);
      let res: Response;
      try {
        res = await this.fc.http.raw(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal,
        });
      } catch {
        if (signal.aborted) throw new ToolFail("unavailable");
        continue;
      }
      if (!res.ok) {
        if (res.status === 429 && keys && keys.state(ep.url) !== null) keys.limited(ep.url, await readCapped(res, 4096).catch(() => ""));
        else await res.body?.cancel().catch(() => {});
        const code = statusError(res.status);
        last = new ToolFail(code === "not_found" ? "unavailable" : code);
        if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) continue;
        throw last;
      }
      let body: unknown;
      try {
        body = JSON.parse(await readCapped(res, 4 * MB));
      } catch {
        continue;
      }
      if (!isObj(body)) continue;
      if (body.error) {
        const msg = isObj(body.error) && typeof body.error.message === "string" ? body.error.message : "";
        // invalid params (a bad address) is the caller's; anything else (too many accounts, "account index service
        // overloaded", a node behind) is this endpoint's: the next one is tried
        if (isObj(body.error) && body.error.code === -32602 && !/too many/i.test(msg)) throw new ToolFail("bad_args");
        last = new ToolFail("unavailable");
        continue;
      }
      keys?.answered(ep.url, method, params, body.result, tag);
      return body.result;
    }
    throw last;
  }
}

/** An ok outcome; `brief`: a read cut short for a passing reason (Outcome) */
const ok = (data: unknown, sources: (ReturnType<typeof src>)[], brief = false): Outcome => ({ ok: true, data, sources: uniqueSources(sources), ...(brief ? { brief } : {}) });
const lamportsToSol = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n / 1e9;
};
const uiFromRaw = (amount: unknown, decimals: unknown): number | null => {
  const a = num(amount);
  const d = num(decimals);
  return a === null || d === null ? null : a / Math.pow(10, d);
};

export function solanaTools(fc: FreeContext, rpc: SolanaRpc): ToolDef[] {
  const keptTxs = new TxStore();
  /** Addresses whose newest page was read here (their transactions kept): read again, their list first, then what is missing */
  const paged = new Map<string, true>();
  /** A transaction by signature (jsonParsed): kept once read, never bought twice; null when the chain has none */
  const txOf = async (signature: string, signal: AbortSignal, callTag: CallTag): Promise<Record<string, unknown> | null> => {
    const kept = keptTxs.get(signature);
    if (kept) return kept;
    const r = await rpc.call("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], signal, callTag);
    return isObj(r) ? keptTxs.put(signature, r) : null;
  };
  /**
   * `address`'s newest successful transactions, `limit` at most, in one history call over the launch keys (fc.newestTxs),
   * kept by signature: its signature list as getSignaturesForAddress gives it, newest first
   */
  const pageOf = async (address: string, limit: number, signal: AbortSignal, callTag: CallTag): Promise<{ signature: string; slot: number; err: null }[]> => {
    const list: { signature: string; slot: number; err: null }[] = [];
    for (const tx of await fc.newestTxs!(address, limit, signal, callTag)) {
      const t = isObj(tx.transaction) ? tx.transaction : {};
      const sig = Array.isArray(t.signatures) && typeof t.signatures[0] === "string" ? t.signatures[0] : null;
      if (!sig) continue;
      keptTxs.put(sig, tx);
      list.push({ signature: sig, slot: num(tx.slot) ?? 0, err: null });
    }
    paged.delete(address);
    paged.set(address, true);
    while (paged.size > PAGED_MAX) paged.delete(paged.keys().next().value!);
    return list;
  };
  /**
   * An address's newest signatures, `limit` at most: read for the first time with the launch keys there, its newest page
   * (the list and its transactions at once, kept); after that its list alone (1 credit), the transactions it lacks read by
   * readTxs
   */
  const newestList = (address: string, limit: number, signal: AbortSignal, callTag: CallTag): Promise<unknown> => {
    const list = () => rpc.call("getSignaturesForAddress", [address, { limit, commitment: "confirmed" }], signal, callTag);
    return fc.newestTxs && !paged.has(address) ? pageOf(address, limit, signal, callTag).catch(list) : list();
  };
  /**
   * The transactions of `sigs` into `got` (a failed read null; none once the budget stops): kept ones at no call; then,
   * `page` given, with PAGE_WORTH or more of them missing and the launch keys there, its address's newest page; the rest
   * one by one, in the order given
   */
  const readTxs = async (sigs: string[], got: Map<string, unknown>, budget: ReadBudget, signal: AbortSignal, callTag: CallTag, page?: { address: string; limit: number }): Promise<void> => {
    const fromKept = () => {
      for (const s of sigs) {
        const k = got.has(s) ? null : keptTxs.get(s);
        if (k) got.set(s, k);
      }
      return sigs.filter((s) => !got.has(s));
    };
    let missing = fromKept();
    if (page && fc.newestTxs && missing.length >= PAGE_WORTH) {
      await budget.each(1, () => pageOf(page.address, page.limit, signal, callTag));
      missing = fromKept();
    }
    (await budget.each(missing.length, (i) => txOf(missing[i]!, signal, callTag))).forEach((r, i) => got.set(missing[i]!, r));
  };

  const accountInfo = async (address: string, signal: AbortSignal, callTag: CallTag): Promise<Record<string, unknown> | null> => {
    const r = await rpc.call("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }], signal, callTag);
    return isObj(r) && isObj(r.value) ? r.value : null;
  };

  const accountBasics: ToolDef = {
    name: "sol_account_basics",
    description:
      "What a Solana address is, read from the chain: a wallet, a token mint, a token account or a program, with its SOL balance and owner program; for a token mint its supply, decimals, mint and freeze authority; for a token account its mint, owner and amount.",
    parameters: {
      type: "object",
      properties: { address: { type: "string", description: "Solana address (base58)", pattern: SOL_ADDRESS } },
      required: ["address"],
      additionalProperties: false,
    },
    ttlMs: MINUTE,
    async run(args, { signal, caller }) {
      const address = String(args.address);
      const v = await accountInfo(address, signal, { tool: "sol_account_basics", caller });
      if (!v) {
        // no account is no proof of no wallet: a wallet holding no SOL has none, and an app's relayer can pay its
        // users' fees, so their wallets trade all day on zero SOL; one signature says whether it is in use
        const last = await rpc.call("getSignaturesForAddress", [address, { limit: 1, commitment: "confirmed" }], signal, { tool: "sol_account_basics", caller }).catch(() => null);
        const seen = Array.isArray(last) && isObj(last[0]) ? last[0] : null;
        const at = seen ? num(seen.blockTime) : null;
        if (seen)
          return ok(
            { address, exists: false, kind: "wallet", sol: 0, in_use: true, last_tx_utc: at ? new Date(at * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null, note: "a wallet holding no SOL (no account until it holds some): its fees are paid by another signer, as an app's relayer may pay its users'; it trades on chain", link: solAccount(address) },
            [src("Solscan: account", solAccount(address))],
          );
        return ok({ address, exists: false, link: solAccount(address) }, [src("Solscan: account", solAccount(address))]);
      }
      const owner = str(v.owner, 50);
      const data = isObj(v.data) ? v.data : null;
      const parsed = data && isObj(data.parsed) ? data.parsed : null;
      const info = parsed && isObj(parsed.info) ? parsed.info : null;
      const type = parsed ? str(parsed.type, 30) : null;
      const out: Record<string, unknown> = {
        address,
        exists: true,
        sol: lamportsToSol(v.lamports),
        owner_program: owner,
        executable: v.executable === true,
        data_bytes: num(v.space),
      };
      let link = solAccount(address);
      if (owner && TOKEN_PROGRAMS.has(owner) && type === "mint" && info) {
        out.kind = "token_mint";
        out.mint = {
          decimals: num(info.decimals),
          supply: uiFromRaw(info.supply, info.decimals),
          mint_authority: str(info.mintAuthority, 50) ?? "none",
          freeze_authority: str(info.freezeAuthority, 50) ?? "none",
          token_2022: owner.startsWith("Tokenz"),
          ...(owner.startsWith("Tokenz") ? mintExtensions(info) : {}),
        };
        link = solToken(address);
      } else if (owner && TOKEN_PROGRAMS.has(owner) && type === "account" && info) {
        const ta = isObj(info.tokenAmount) ? info.tokenAmount : {};
        out.kind = "token_account";
        out.token_account = { mint: str(info.mint, 50), owner: str(info.owner, 50), amount: num(ta.uiAmountString), decimals: num(ta.decimals), state: str(info.state, 20) };
      } else if (v.executable === true) out.kind = "program";
      else if (owner === SYSTEM_PROGRAM) out.kind = "wallet";
      else out.kind = "other";
      // the account's kind stays (a scan reads a System account as a wallet); who holds it is said as the holder reads say it
      if (out.kind === "wallet" && addressKind(address, owner) === "vault") out.note = KIND_NOTES.vault;
      const label = labelOf(address, owner);
      if (label) out.label = label;
      out.link = link;
      return ok(out, [src(out.kind === "token_mint" ? "Solscan: token" : "Solscan: account", link)]);
    },
  };

  /**
   * A token-2022 mint's extensions as the chain lists them, and what they can do to a holder: a transfer fee (with its
   * basis points now), a transfer hook (a program run on every transfer), a permanent delegate (moves anyone's tokens),
   * and non-transferable tokens.
   */
  function mintExtensions(info: Record<string, unknown>): Record<string, unknown> {
    const exts = Array.isArray(info.extensions) ? info.extensions.filter(isObj) : [];
    const names = exts.map((e) => str(e.extension, 40)).filter((n): n is string => n !== null);
    const fee = exts.find((e) => e.extension === "transferFeeConfig");
    const state = fee && isObj(fee.state) ? fee.state : null;
    const bps = (k: string) => (state && isObj(state[k]) ? num((state[k] as Record<string, unknown>).transferFeeBasisPoints) : null);
    const feeBps = Math.max(bps("newerTransferFee") ?? 0, bps("olderTransferFee") ?? 0);
    return {
      extensions: names,
      transfer_fee: names.includes("transferFeeConfig"),
      ...(fee ? { transfer_fee_pct: feeBps / 100 } : {}),
      transfer_hook: names.includes("transferHook"),
      permanent_delegate: names.includes("permanentDelegate"),
      non_transferable: names.includes("nonTransferable"),
    };
  }

  /** The parsed owner of each token account (getMultipleAccounts, one call), by token account; empty on any failure. */
  const ownersOf = async (accounts: string[], signal: AbortSignal, callTag: CallTag): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    if (accounts.length === 0) return out;
    try {
      const r = await rpc.call("getMultipleAccounts", [accounts, { encoding: "jsonParsed", commitment: "confirmed" }], signal, callTag);
      const list = isObj(r) && Array.isArray(r.value) ? r.value : [];
      accounts.forEach((a, i) => {
        const v = list[i];
        const info = isObj(v) && isObj(v.data) && isObj(v.data.parsed) && isObj(v.data.parsed.info) ? v.data.parsed.info : null;
        const owner = info ? str(info.owner, 50) : null;
        if (owner) out.set(a, owner);
      });
    } catch {
      // owners unknown: shares only
    }
    return out;
  };
  /**
   * The program owning each address's account (getMultipleAccounts without data, one call), null for an address that
   * holds no account at all (a wallet with no SOL, an authority with no account). Empty on any failure.
   */
  const programsOf = async (addresses: string[], signal: AbortSignal, callTag: CallTag): Promise<Map<string, string | null>> => {
    const out = new Map<string, string | null>();
    if (addresses.length === 0) return out;
    try {
      const r = await rpc.call("getMultipleAccounts", [addresses, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }], signal, callTag);
      const list = isObj(r) && Array.isArray(r.value) ? r.value : null;
      if (!list) return out;
      addresses.forEach((a, i) => out.set(a, isObj(list[i]) ? str(list[i].owner, 50) : null));
    } catch {
      // programs unknown
    }
    return out;
  };
  /**
   * What each address is (addressKind) and who it is when known (labelOf), by the programs owning them and whether each
   * holds tokens; empty on any failure
   */
  const kindsOf = async (addresses: string[], signal: AbortSignal, callTag: CallTag, holdsTokens: (address: string) => boolean = () => false): Promise<Map<string, { kind: AddressKind; label: string | null }>> =>
    new Map([...(await programsOf(addresses, signal, callTag))].map(([a, p]) => [a, { kind: addressKind(a, p, holdsTokens(a)), label: labelOf(a, p, holdsTokens(a)) }]));
  /** What an address is when its account was not read: what the address alone says */
  const unread = (address: string) => ({ kind: addressKind(address, undefined), label: labelOf(address) });

  const largest: ToolDef = {
    name: "sol_largest_accounts",
    description:
      "The ranked holder list of a Solana token mint, one quick chain read: each token account's share of supply, its owner and what the owner is (holder: wallet; exchange, named in label; vault: a multisig's or a treasury's, no private key; pool, its AMM in label; program: a bonding curve, an escrow; burn); the top 10's share with and without pools and programs (top10_wallets_share_pct groups a wallet's accounts, vaults and exchanges counted with them). Who holds it, not whether they are tied.",
    parameters: {
      type: "object",
      properties: { mint: { type: "string", description: "Token mint address (base58)", pattern: SOL_ADDRESS }, limit: limitParam(10, 20, "accounts") },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal, caller }) {
      const mint = String(args.mint);
      const callTag: CallTag = { tool: "sol_largest_accounts", caller };
      const [largestRaw, supplyRaw] = await Promise.all([
        rpc.call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], signal, callTag),
        rpc.call("getTokenSupply", [mint, { commitment: "confirmed" }], signal, callTag),
      ]);
      const accounts = isObj(largestRaw) && Array.isArray(largestRaw.value) ? largestRaw.value.filter(isObj) : null;
      const supplyV = isObj(supplyRaw) && isObj(supplyRaw.value) ? supplyRaw.value : null;
      if (!accounts || !supplyV) return { ok: false, error: "not_found" };
      const supply = num(supplyV.uiAmountString);
      const share = (amount: number | null): number | null => (supply && amount !== null ? (amount / supply) * 100 : null);
      // every account the chain returned (20 at most): the shares are read over all of them, the rows cut to `limit`
      const all = accounts
        .map((a) => ({ token_account: str(a.address, 50), amount: num(a.uiAmountString) }))
        .filter((a): a is { token_account: string; amount: number | null } => a.token_account !== null);
      const owners = await ownersOf(all.map((a) => a.token_account), signal, callTag);
      const kinds = await kindsOf([...new Set(owners.values())], signal, callTag, () => true);
      const rows = all.map((a) => {
        const owner = owners.get(a.token_account) ?? null;
        const k = owner ? (kinds.get(owner) ?? unread(owner)) : null;
        return { token_account: a.token_account, amount: a.amount, share_pct: round(share(a.amount), 4), owner, holder: k?.kind ?? "unknown", ...(k?.label ? { label: k.label } : {}) };
      });
      const sum = (xs: (number | null)[]) => xs.reduce<number>((t, x) => t + (x ?? 0), 0);
      const top10 = sum(all.slice(0, 10).map((a) => share(a.amount)));
      // wallets (and the other owners that are no pool or program: an exchange, a vault, one with no SOL account even
      // off the curve, unknown, counted as wallets: a concentration is never under-stated), each owner once
      const byOwner = new Map<string, number>();
      let program = 0;
      let known = owners.size > 0;
      for (const r of rows) {
        const sh = share(r.amount) ?? 0;
        if (r.holder === "program" || r.holder === "pool") program += sh;
        else byOwner.set(r.owner ?? r.token_account, (byOwner.get(r.owner ?? r.token_account) ?? 0) + sh);
      }
      if (kinds.size === 0) known = false;
      const wallets = [...byOwner.values()].sort((a, b) => b - a);
      const link = solToken(mint);
      return ok(
        {
          mint,
          supply,
          decimals: num(supplyV.decimals),
          accounts_read: rows.length,
          top10_share_pct: round(top10, 4),
          ...(known
            ? {
                top10_wallets_share_pct: round(sum(wallets.slice(0, 10)), 4),
                largest_wallet_share_pct: round(wallets[0] ?? 0, 4),
                program_accounts_share_pct: round(program, 4),
              }
            : {}),
          accounts: rows.slice(0, Number(args.limit ?? 10)),
          link: link ? `${link}#holders` : null,
        },
        [src("Solscan: token holders", link ? `${link}#holders` : null)],
      );
    },
  };

  /**
   * A mint's first transaction: back through its history, a page at a time, until a page is not full (its last signature
   * is the first ever), `pages` pages at most; first: null when the history is longer, or there is none (read: 0).
   */
  const firstOf = async (mint: string, pages: number, signal: AbortSignal, callTag: CallTag): Promise<{ first: string | null; read: number }> => {
    let before: string | null = null;
    let read = 0;
    for (let page = 0; page < pages; page++) {
      const r = await rpc.call("getSignaturesForAddress", [mint, { limit: ORIGIN_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }], signal, callTag);
      if (!Array.isArray(r)) throw new ToolFail("unavailable");
      const sigs = r.filter(isObj).map((x) => str(x.signature, 100)).filter((x): x is string => x !== null);
      read += sigs.length;
      // a full page and then nothing: that page's last signature was the first ever (exactly 1000, 2000… of them)
      if (sigs.length === 0) return { first: before, read };
      before = sigs[sigs.length - 1]!;
      if (r.length < ORIGIN_PAGE) return { first: before, read };
    }
    return { first: null, read };
  };
  /** A parsed transaction's fee payer: a mint's creator in its first one */
  const payerOf = (tx: Record<string, unknown>): string | null => {
    const msg = isObj(tx.transaction) && isObj(tx.transaction.message) ? tx.transaction.message : {};
    const keys = Array.isArray(msg.accountKeys) ? msg.accountKeys : [];
    return keys.length > 0 ? (isObj(keys[0]) ? str(keys[0].pubkey, 50) : str(keys[0], 50)) : null;
  };

  /**
   * Who made a token whose first transaction is out of reach, by its metadata: the verified creator it names (a wallet:
   * a launchpad's own address is no one's), else the fee payer of the metadata account's first transaction when its
   * history fits a page (made once, with the token most often, and touched only by updates: a pump.fun token's names no
   * creator); that transaction, when read, is when the metadata was made. null: neither.
   */
  const madeByMetadata = async (mint: string, signal: AbortSignal, callTag: CallTag): Promise<{ creator: string; tx: Record<string, unknown> | null; first: string | null; basis: string } | null> => {
    const meta = metadataAddress(mint);
    const [tokens, page] = await Promise.all([tokensOf([mint], signal, callTag).catch(() => null), meta ? firstOf(meta, 1, signal, callTag).catch(() => null) : null]);
    const tx = page?.first ? await txOf(page.first, signal, callTag).catch(() => null) : null;
    const verified = tokens?.get(mint)?.creators.find(onCurve) ?? null;
    const creator = verified ?? (tx ? payerOf(tx) : null);
    if (!creator) return null;
    const basis = `${verified ? "the verified creator in its token metadata" : "the fee payer of its token metadata's first transaction"}${tx ? "; created_at: when that metadata was made" : ""}`;
    return { creator, tx, first: tx ? page!.first : null, basis };
  };

  const origin: ToolDef = {
    name: "sol_token_origin",
    description:
      "Who created a Solana token and what that wallet holds of it now, read from the chain: the fee payer of the mint's first transaction (its creator, the dev wallet of a launchpad token), when it was created, what the creator got in that transaction and what it holds now (amount and share of supply). For a token older than its last 5000 transactions: the verified creator in its token metadata, else the fee payer of that metadata's first transaction (basis says which; created_at is then when the metadata was made); found false when neither is read.",
    parameters: {
      type: "object",
      properties: { mint: { type: "string", description: "Token mint address (base58)", pattern: SOL_ADDRESS } },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: 2 * MINUTE,
    async run(args, { signal, caller }) {
      const mint = String(args.mint);
      const link = solToken(mint);
      const callTag: CallTag = { tool: "sol_token_origin", caller };
      // the first transaction in one call of Helius's history read when the launch keys are there (any age), else its
      // signatures newest first, ORIGIN_PAGES at most
      const viaHistory = fc.firstTx ? await fc.firstTx(mint, signal, callTag).catch(() => null) : null;
      const { first, read } = viaHistory ? { first: viaHistory.signature, read: 1 } : await firstOf(mint, ORIGIN_PAGES, signal, callTag);
      // no history at all is no token
      if (!first && read === 0) return { ok: false, error: "not_found" };
      let made: { creator: string; tx: Record<string, unknown> | null; first: string | null; basis?: string } | null;
      if (viaHistory) {
        const payer = payerOf(viaHistory.tx);
        made = payer ? { creator: payer, tx: viaHistory.tx, first: viaHistory.signature } : await madeByMetadata(mint, signal, callTag);
      } else if (first) {
        const tx = await txOf(first, signal, callTag);
        if (!tx) throw new ToolFail("unavailable");
        const payer = payerOf(tx);
        if (!payer) throw new ToolFail("unavailable");
        made = { creator: payer, tx, first };
      } else made = await madeByMetadata(mint, signal, callTag);
      // a history longer than we read is an older token, and its metadata names no one
      if (!made) return ok({ mint, found: false, transactions_read: read, why: `more than ${read} transactions: its first one is older than what is read here`, link }, [src("Solscan: token", link)]);
      const { creator, tx } = made;
      const meta = tx && isObj(tx.meta) ? tx.meta : {};
      const bt = tx ? num(tx.blockTime) : null;
      const got = (Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances.filter(isObj) : [])
        .filter((b) => b.mint === mint && b.owner === creator)
        .reduce<number>((t, b) => t + (isObj(b.uiTokenAmount) ? (num(b.uiTokenAmount.uiAmountString) ?? 0) : 0), 0);
      const [heldRaw, supplyRaw] = await Promise.all([
        rpc.call("getTokenAccountsByOwner", [creator, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }], signal, callTag),
        rpc.call("getTokenSupply", [mint, { commitment: "confirmed" }], signal, callTag),
      ]);
      const held = isObj(heldRaw) && Array.isArray(heldRaw.value) ? heldRaw.value.filter(isObj) : [];
      const now = held.reduce<number>((t, a) => {
        const info = isObj(a.account) && isObj(a.account.data) && isObj(a.account.data.parsed) && isObj(a.account.data.parsed.info) ? a.account.data.parsed.info : null;
        return t + (info && isObj(info.tokenAmount) ? (num(info.tokenAmount.uiAmountString) ?? 0) : 0);
      }, 0);
      const supply = isObj(supplyRaw) && isObj(supplyRaw.value) ? num(supplyRaw.value.uiAmountString) : null;
      const pct = (x: number) => (supply ? round((x / supply) * 100, 4) : null);
      return ok(
        {
          mint,
          found: true,
          creator,
          ...(made.basis ? { basis: made.basis } : {}),
          created_at: bt ? new Date(bt * 1000).toISOString() : null,
          age_days: bt ? round((fc.now() - bt * 1000) / 86_400_000, 3) : null,
          // what it got then: in the metadata's transaction only when it got some (its tokens may be minted after)
          ...(!made.basis || got > 0 ? { creator_got_at_creation: { amount: round(got, 6), share_pct: pct(got) } } : {}),
          creator_holds_now: { amount: round(now, 6), share_pct: pct(now), token_accounts: held.length },
          supply,
          transactions_read: read,
          creation_tx: made.first ? solTx(made.first) : null,
          link,
        },
        [src("Solscan: token", link), src("Solscan: creation transaction", made.first ? solTx(made.first) : null), src("Solscan: creator", solAccount(creator))],
      );
    },
  };

  const signatures: ToolDef = {
    name: "sol_recent_signatures",
    description: "Recent transactions of a Solana address, newest first, read from the chain: signature, slot, time, success, memo, with a link to each.",
    parameters: {
      type: "object",
      properties: { address: { type: "string", description: "Solana address (base58)", pattern: SOL_ADDRESS }, limit: limitParam(10, 20, "transactions") },
      required: ["address"],
      additionalProperties: false,
    },
    ttlMs: 30_000,
    async run(args, { signal, caller }) {
      const address = String(args.address);
      const r = await rpc.call("getSignaturesForAddress", [address, { limit: Number(args.limit ?? 10), commitment: "confirmed" }], signal, { tool: "sol_recent_signatures", caller });
      if (!Array.isArray(r)) throw new ToolFail("unavailable");
      const txs = r.filter(isObj).map((s) => {
        const sig = str(s.signature, 100);
        return {
          signature: sig,
          slot: num(s.slot),
          time: num(s.blockTime) ? new Date(num(s.blockTime)! * 1000).toISOString() : null,
          ok: s.err === null || s.err === undefined,
          memo: typeof s.memo === "string" ? s.memo.replace(/[\u0000-\u001f]/g, " ").slice(0, 120) : null,
          link: sig ? solTx(sig) : null,
        };
      });
      return ok({ address, transactions: txs, link: solAccount(address) }, [src("Solscan: account", solAccount(address))]);
    },
  };

  const balanceChanges: ToolDef = {
    name: "sol_balance_changes",
    description: "What one Solana transaction changed, read from the chain: time, success, fee, signers, programs called, SOL and token balance changes per account.",
    parameters: {
      type: "object",
      properties: { signature: { type: "string", description: "Transaction signature (base58)", pattern: SOL_SIGNATURE } },
      required: ["signature"],
      additionalProperties: false,
    },
    ttlMs: 6 * HOUR,
    async run(args, { signal, caller }) {
      const signature = String(args.signature);
      const r = await txOf(signature, signal, { tool: "sol_balance_changes", caller });
      if (!r) return { ok: false, error: "not_found" };
      const meta = isObj(r.meta) ? r.meta : {};
      const tx = isObj(r.transaction) ? r.transaction : {};
      const msg = isObj(tx.message) ? tx.message : {};
      const keys = Array.isArray(msg.accountKeys) ? msg.accountKeys.map((k) => (isObj(k) ? { key: str(k.pubkey, 50), signer: k.signer === true } : { key: str(k, 50), signer: false })) : [];
      const pre = Array.isArray(meta.preBalances) ? meta.preBalances : [];
      const post = Array.isArray(meta.postBalances) ? meta.postBalances : [];
      const solChanges = keys
        .map((k, i) => ({ account: k.key, delta_sol: (num(post[i]) ?? 0) / 1e9 - (num(pre[i]) ?? 0) / 1e9 }))
        .filter((c) => c.account && Math.abs(c.delta_sol) > 0)
        .sort((a, b) => Math.abs(b.delta_sol) - Math.abs(a.delta_sol))
        .slice(0, 10)
        .map((c) => ({ ...c, delta_sol: round(c.delta_sol, 9) }));
      const tokenBal = (list: unknown) => {
        const m = new Map<number, { owner: string | null; mint: string | null; ui: number }>();
        if (Array.isArray(list))
          for (const b of list.filter(isObj)) {
            const idx = num(b.accountIndex);
            const ui = isObj(b.uiTokenAmount) ? num(b.uiTokenAmount.uiAmountString) : null;
            if (idx !== null) m.set(idx, { owner: str(b.owner, 50), mint: str(b.mint, 50), ui: ui ?? 0 });
          }
        return m;
      };
      const preT = tokenBal(meta.preTokenBalances);
      const postT = tokenBal(meta.postTokenBalances);
      const tokenChanges = [...new Set([...preT.keys(), ...postT.keys()])]
        .map((i) => {
          const a = preT.get(i);
          const b = postT.get(i);
          return { owner: b?.owner ?? a?.owner ?? null, mint: b?.mint ?? a?.mint ?? null, delta: round((b?.ui ?? 0) - (a?.ui ?? 0), 9) };
        })
        .filter((c) => c.delta !== 0 && c.delta !== null)
        .slice(0, 10);
      const programs = new Set<string>();
      if (Array.isArray(msg.instructions)) for (const ix of msg.instructions.filter(isObj)) if (typeof ix.programId === "string") programs.add(ix.programId);
      const bt = num(r.blockTime);
      const link = solTx(signature);
      return ok(
        {
          signature,
          slot: num(r.slot),
          time: bt ? new Date(bt * 1000).toISOString() : null,
          ok: meta.err === null || meta.err === undefined,
          fee_sol: lamportsToSol(meta.fee),
          signers: keys.filter((k) => k.signer).map((k) => k.key).slice(0, 5),
          programs: [...programs].slice(0, 10),
          sol_changes: solChanges,
          token_changes: tokenChanges,
          link,
        },
        [src("Solscan: transaction", link)],
      );
    },
  };

  /** A signature list's transactions that did not fail, newest first as the chain gives them, with their slot */
  const sigsOf = (r: unknown): { signature: string; slot: number }[] =>
    Array.isArray(r)
      ? r
          .filter(isObj)
          .filter((x) => (x.err === null || x.err === undefined) && typeof x.signature === "string")
          .map((x) => ({ signature: String(x.signature), slot: num(x.slot) ?? 0 }))
      : [];
  /** Several signature lists as one, newest first, each transaction once */
  const newestOf = (lists: { signature: string; slot: number }[][]): string[] => {
    const slots = new Map<string, number>();
    for (const s of lists.flat()) if (!slots.has(s.signature)) slots.set(s.signature, s.slot);
    return [...slots].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  };
  /** Each token account, its mint and its balance in a jsonParsed account list (getTokenAccountsByOwner) */
  const tokenAccountsOf = (r: unknown): { account: string; mint: string | null; ui: number }[] =>
    (isObj(r) && Array.isArray(r.value) ? r.value.filter(isObj) : []).flatMap((a) => {
      const info = isObj(a.account) && isObj(a.account.data) && isObj(a.account.data.parsed) && isObj(a.account.data.parsed.info) ? a.account.data.parsed.info : null;
      const account = str(a.pubkey, 50);
      const ui = info && isObj(info.tokenAmount) ? (num(info.tokenAmount.uiAmountString) ?? 0) : 0;
      return account ? [{ account, mint: info ? str(info.mint, 50) : null, ui }] : [];
    });
  /** Whether a wallet signed a parsed transaction: its fee payer, or a key flagged a signer */
  const signedBy = (r: Record<string, unknown>, address: string): boolean => {
    const msg = isObj(r.transaction) && isObj(r.transaction.message) ? r.transaction.message : {};
    const keys = Array.isArray(msg.accountKeys) ? msg.accountKeys : [];
    return keys.some((k, i) => (isObj(k) ? k.pubkey === address && (i === 0 || k.signer === true) : i === 0 && k === address));
  };
  /**
   * What tokens are, in one getMultipleAccounts (jsonParsed: a mint parses, its Token Metadata account comes back as
   * base64): each one's ticker (Token-2022's own metadata first), mint authority, update authority and verified creators;
   * not a mint, left out.
   */
  const tokensOf = async (mints: string[], signal: AbortSignal, callTag: CallTag): Promise<Map<string, { symbol: string | null; mintAuthority: string | null; update: string | null; creators: string[] }>> => {
    const metas = mints.map(metadataAddress);
    const keys = [...mints, ...metas.filter((m): m is string => m !== null)];
    const r = await rpc.call("getMultipleAccounts", [keys, { encoding: "jsonParsed", commitment: "confirmed" }], signal, callTag);
    const list = isObj(r) && Array.isArray(r.value) ? r.value : [];
    const at = new Map(keys.map((k, i) => [k, list[i]]));
    const metaOf = (v: unknown) => (isObj(v) && v.owner === METADATA_PROGRAM && Array.isArray(v.data) && v.data[1] === "base64" && typeof v.data[0] === "string" ? readMetadata(Buffer.from(v.data[0], "base64")) : null);
    const out = new Map<string, { symbol: string | null; mintAuthority: string | null; update: string | null; creators: string[] }>();
    mints.forEach((mint, i) => {
      const v = at.get(mint);
      const parsed = isObj(v) && isObj(v.data) && isObj(v.data.parsed) ? v.data.parsed : null;
      const info = parsed && parsed.type === "mint" && isObj(parsed.info) ? parsed.info : null;
      if (!info) return;
      const ext = Array.isArray(info.extensions) ? info.extensions.filter(isObj).find((e) => e.extension === "tokenMetadata") : undefined;
      const own = ext && isObj(ext.state) ? ext.state : null;
      const md = metas[i] ? metaOf(at.get(metas[i]!)) : null;
      out.set(mint, { symbol: tickerOf(own?.symbol) ?? md?.symbol ?? null, mintAuthority: str(info.mintAuthority, 50), update: str(own?.updateAuthority, 50) ?? md?.update ?? null, creators: md?.creators ?? [] });
    });
    return out;
  };

  /**
   * Where a wallet's money went and came from: its newest transactions read from the chain, each one's SOL and token
   * balance changes by owner; what the wallet lost went to the owners that gained the same asset in that transaction,
   * what it gained came from those that lost it. Per counterparty, asset and direction: the amount, the transfer count,
   * the first and last time, and what the counterparty is (addressKind). A transfer into a token account the wallet
   * already has never names the wallet, so the chain does not list it under the wallet: the newest transactions of
   * TRAIL_TOKEN_ACCOUNTS of its token accounts are read with its own, emptied ones included (an insider who sold it all
   * keeps his), those of the tokens it moved in transactions it signed first, so its own are read before them. Then
   * what the tokens it moved are (by ticker; the best-known ones by their mint alone) and who made them: a counterparty
   * that is a token's creator (a verified creator in its metadata, else the fee payer of its first transaction when its
   * history fits one page), got its first mint, or holds its mint or update authority is tagged so; a vault whose
   * transactions read hold the Squads multisig that derives it is named so. The read keeps to a ReadBudget
   * (TRAIL_RPC_MAX calls); a cut read, reads that failed and token accounts left unread say so (complete: false, why).
   */
  const TRAIL_TOKEN_ACCOUNTS = 8;
  const TRAIL_RPC_MAX = 100;
  /**
   * The read's last calls, their room kept: what the counterparties and the tokens are. Then, in what room is left,
   * never kept, who made TRAIL_ORIGINS of the tokens whose metadata names no verified creator: each one's first
   * signature and transaction
   */
  const TRAIL_TAIL = 2;
  const TRAIL_ORIGINS = 2;
  const moneyTrail: ToolDef = {
    name: "sol_money_trail",
    description:
      "Where a Solana wallet's money went and came from, read from its recent transactions on the chain (its own and up to 8 of its token accounts'; with mint, that token's moves of any age): per counterparty, the SOL and tokens sent and received (a token by its ticker, its mint beside), transfers, first and last time, what the counterparty is (wallet; exchange, named in label; vault: a multisig's or a treasury's; pool; program) and, in tags, whether it made a token moved here (creator, first mint, mint or update authority). Call it again on a counterparty to follow the money a hop further.",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "Solana wallet address (base58)", pattern: SOL_ADDRESS },
        limit: limitParam(40, 80, "transactions to read"),
        mint: { type: "string", description: "A token whose moves by this wallet to read whatever their age (a dev's coin: where its bag went), beside its newest transactions", pattern: SOL_ADDRESS },
      },
      required: ["address"],
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal, caller }) {
      const address = String(args.address);
      const limit = Math.max(1, Math.min(80, Number(args.limit ?? 40)));
      const mint = typeof args.mint === "string" && args.mint !== address ? args.mint : null;
      const callTag: CallTag = { tool: "sol_money_trail", caller };
      const budget = new ReadBudget(fc.limit.rpc, signal, TRAIL_RPC_MAX, rpc.tokensPerCall, 0, TRAIL_TAIL);
      // no room for even its own list: no trail (an empty one would read as a wallet that never moved)
      if (!budget.room()) throw new ToolFail(budget.cut === "time" ? "unavailable" : "rate_limited");
      budget.calls++;
      const programs = [...TOKEN_PROGRAMS];
      const [own, held] = await Promise.all([
        // read for the first time with the launch keys there: its newest page, its list and transactions at once
        newestList(address, limit, signal, callTag),
        budget.each(programs.length, (i) => rpc.call("getTokenAccountsByOwner", [address, { programId: programs[i] }, { encoding: "jsonParsed", commitment: "confirmed" }], signal, callTag)),
      ]);
      if (!Array.isArray(own)) throw new ToolFail("unavailable");
      const listed = held.length === programs.length && held.every((r) => isObj(r) && Array.isArray(r.value));
      // its own transactions first (kept ones at no call; its page again when most are new): the tokens it moved in those
      // it signed, newest first, pick the token accounts read
      const ownSigs = sigsOf(own).map((s) => s.signature);
      const got = new Map<string, unknown>();
      await readTxs(ownSigs, got, budget, signal, callTag, { address, limit });
      const moved = new Map<string, number>();
      for (const r of got.values())
        if (isObj(r) && signedBy(r, address)) for (const [asset, deltas] of trailDeltas(r)) if (asset !== "SOL" && deltas.has(address) && !moved.has(asset)) moved.set(asset, moved.size);
      const owned = held.flatMap(tokenAccountsOf);
      // a token asked for (a dev's coin): the wallet's own accounts of it under both token programs, open or closed (a
      // sold bag's account is often closed; its history stays), read first and whatever their age
      const coinAccounts = mint ? programs.map((p) => associatedAccount(address, mint, p)).filter((a): a is string => a !== null) : [];
      const rank = (a: { mint: string | null; ui: number }) => moved.get(a.mint ?? "") ?? (a.ui > 0 ? moved.size : moved.size + 1);
      const accounts = [...owned]
        .filter((a) => !coinAccounts.includes(a.account))
        .sort((a, b) => rank(a) - rank(b) || b.ui - a.ui)
        .slice(0, TRAIL_TOKEN_ACCOUNTS)
        .map((a) => a.account);
      const lists = await budget.each(coinAccounts.length + accounts.length, (i) => rpc.call("getSignaturesForAddress", [[...coinAccounts, ...accounts][i], { limit, commitment: "confirmed" }], signal, callTag));
      const coin = lists.slice(0, coinAccounts.length);
      const theirs = lists.slice(coinAccounts.length);
      // the newest `limit` of all the lists, and the coin's own: what its own list did not have is read now
      const list = [...new Set([...newestOf([own, ...theirs].map(sigsOf)).slice(0, limit), ...newestOf(coin.map(sigsOf)).slice(0, limit)])];
      await readTxs(list.filter((s) => !got.has(s)), got, budget, signal, callTag);
      const flows = new Map<string, { dir: "out" | "in"; party: string; asset: string; amount: number; count: number; first: number; last: number }>();
      // the owners of the token accounts in them: a pool's state holds its tokens, an LP's position or a bin array none
      const tokenOwners = new Set<string>();
      let read = 0;
      let missed = 0;
      let oldest = Infinity;
      let newest = 0;
      for (const s of list) {
        const r = got.get(s);
        if (r !== undefined && !isObj(r)) missed++;
        if (!isObj(r)) continue;
        read++;
        for (const o of tokenOwnersOf(r)) tokenOwners.add(o);
        const t = (num(r.blockTime) ?? 0) * 1000;
        if (t) {
          oldest = Math.min(oldest, t);
          newest = Math.max(newest, t);
        }
        for (const [asset, deltas] of trailDeltas(r)) {
          const mine = deltas.get(address) ?? 0;
          if (Math.abs(mine) < dust(asset)) continue;
          const dir = mine < 0 ? "out" : "in";
          // the other side: owners that moved the same asset the opposite way, each up to what this wallet moved
          let left = Math.abs(mine);
          const others = [...deltas.entries()].filter(([o, d]) => o !== address && (dir === "out" ? d > 0 : d < 0) && Math.abs(d) >= dust(asset)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
          for (const [party, d] of others) {
            if (left <= 0) break;
            const amount = Math.min(left, Math.abs(d));
            left -= amount;
            const key = `${dir}|${party}|${asset}`;
            const f = flows.get(key) ?? { dir, party, asset, amount: 0, count: 0, first: t, last: t };
            f.amount += amount;
            f.count++;
            if (t) {
              f.first = f.first ? Math.min(f.first, t) : t;
              f.last = Math.max(f.last, t);
            }
            flows.set(key, f);
          }
        }
      }
      const top = (dir: "out" | "in") =>
        [...flows.values()]
          .filter((f) => f.dir === dir)
          .sort((a, b) => b.count - a.count || b.amount - a.amount)
          .slice(0, TRAIL_ROWS);
      const shown = { out: top("out"), in: top("in") };
      const parties = [...new Set([...shown.out, ...shown.in].map((f) => f.party))];
      // the tokens it moved that are not known by name, the most moved first: what they are, then who made them
      const mints = [...new Set([...shown.out, ...shown.in].sort((a, b) => b.count - a.count || b.amount - a.amount).map((f) => f.asset))].filter((a) => knownName(a) === null);
      const [kinds, tokens] = await Promise.all([
        parties.length > 0 ? budget.last(() => kindsOf(parties, signal, callTag, (a) => tokenOwners.has(a))) : null,
        mints.length > 0 ? budget.last(() => tokensOf(mints, signal, callTag)) : null,
      ]);
      // a verified creator in its metadata made it; else the payer of its first transaction, when its history fits a
      // page
      const unmade = mints.filter((m) => !tokens?.get(m)?.creators.length).slice(0, TRAIL_ORIGINS);
      const made = new Map(
        await Promise.all(
          unmade.map(async (m) => {
            const f = await budget.last(() => firstOf(m, 1, signal, callTag));
            const tx = f?.first ? (keptTxs.get(f.first) ?? (await budget.last(() => txOf(f.first!, signal, callTag)))) : null;
            return [m, isObj(tx) ? { creator: payerOf(tx), minted: [...(trailDeltas(tx).get(m) ?? [])].filter(([, d]) => d > 0).map(([o]) => o) } : null] as const;
          }),
        ),
      );
      const kindsLost = parties.length > 0 && !kinds?.size;
      // a token by its ticker, else its mint cut short
      const assetName = (a: string) => knownName(a) ?? tokens?.get(a)?.symbol ?? `${a.slice(0, 4)}…${a.slice(-4)}`;
      // who made the tokens it moved
      const tags = new Map<string, string[]>();
      const tag = (who: string | null | undefined, what: string) => {
        if (who && !tags.get(who)?.includes(what)) tags.set(who, [...(tags.get(who) ?? []), what]);
      };
      mints.forEach((m) => {
        const name = assetName(m);
        const first = made.get(m);
        for (const c of [first?.creator, ...(tokens?.get(m)?.creators ?? [])]) tag(c, `creator of ${name}`);
        for (const o of first?.minted ?? []) if (o !== first?.creator) tag(o, `got the first mint of ${name}`);
        tag(tokens?.get(m)?.mintAuthority, `mint authority of ${name}`);
        tag(tokens?.get(m)?.update, `update authority of ${name}`);
      });
      const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
      const rows = (dir: "out" | "in") =>
        shown[dir].map((f) => {
          const k = kinds?.get(f.party) ?? unread(f.party);
          return {
            [dir === "out" ? "to" : "from"]: f.party,
            asset: assetName(f.asset),
            ...(f.asset !== "SOL" ? { mint: f.asset } : {}),
            amount: round(f.amount, 6),
            transfers: f.count,
            first: iso(f.first),
            last: iso(f.last),
            counterparty: k.kind,
            ...(k.label ? { label: k.label } : {}),
            ...(tags.has(f.party) ? { tags: tags.get(f.party) } : {}),
            link: solAccount(f.party),
          };
        });
      const accountsRead = theirs.filter(Array.isArray).length;
      const unlisted = theirs.length - accountsRead;
      // reads that failed are passing; token accounts left unread past the 8 are not, and are said too
      const failed =
        missed > 0
          ? `${missed} of ${list.length} transactions could not be read`
          : unlisted > 0
            ? `${unlisted} of its token accounts' transactions could not be listed: transfers into them may be missing`
            : !listed
              ? "its token accounts could not be listed: transfers into them may be missing"
              : kindsLost
                ? "what the counterparties are could not be read"
                : null;
      const why = budget.why() ?? failed ?? (owned.length > accounts.length ? `${accountsRead} of its ${owned.length} token accounts read: transfers into the others may be missing` : null);
      // a vault's own transactions name its Squads multisig
      const label = labelOf(address) ?? (!onCurve(address) && [...got.values()].some((r) => squadsVaultIn(r, address)) ? "Squads multisig vault" : null);
      return ok(
        {
          address,
          ...(label ? { label } : {}),
          ...(tags.has(address) ? { tags: tags.get(address) } : {}),
          transactions_read: read,
          from: iso(oldest === Infinity ? 0 : oldest),
          to: iso(newest),
          outgoing: rows("out"),
          incoming: rows("in"),
          token_accounts_read: accountsRead,
          ...(mint ? { coin: { mint, accounts_read: coin.filter(Array.isArray).length } } : {}),
          ...(owned.length > accountsRead ? { token_accounts: owned.length } : {}),
          complete: why === null,
          ...(why ? { why } : {}),
          link: solAccount(address),
        },
        [src("Solscan: account", solAccount(address))],
        budget.passing || failed !== null,
      );
    },
  };

  /** One asset's balance changes in one transaction as transfers: each sender's loss goes to the receivers, largest first */
  const pairTransfers = (deltas: Map<string, number>, min: number): [string, string, number][] => {
    const give = [...deltas].filter(([, d]) => d <= -min).map(([o, d]) => ({ o, left: -d })).sort((a, b) => b.left - a.left);
    const get = [...deltas].filter(([, d]) => d >= min).map(([o, d]) => ({ o, left: d })).sort((a, b) => b.left - a.left);
    const out: [string, string, number][] = [];
    for (const g of give)
      for (const k of get) {
        if (g.left < min) break;
        if (k.left < min || k.o === g.o) continue;
        const amount = Math.min(g.left, k.left);
        g.left -= amount;
        k.left -= amount;
        out.push([g.o, k.o, amount]);
      }
    return out;
  };

  /**
   * Who handed out the top holders' first tokens (each holder's first incoming transfer, or none): the wallet (on the
   * curve, no exchange) that gave two of them or more theirs, one `bigMin` or more, the most given first; null when none did
   */
  const firstAllocator = (firsts: ({ from: string; amount: number } | undefined)[], bigMin: number): string | null => {
    const gave = new Map<string, { holders: number; amount: number; big: boolean }>();
    for (const f of firsts) {
      if (!f || !onCurve(f.from) || exchangeLabel(f.from)) continue;
      const g = gave.get(f.from) ?? { holders: 0, amount: 0, big: false };
      gave.set(f.from, { holders: g.holders + 1, amount: g.amount + f.amount, big: g.big || f.amount >= bigMin });
    }
    return [...gave].filter(([, g]) => g.holders >= 2 && g.big).sort((a, b) => b[1].amount - a[1].amount)[0]?.[0] ?? null;
  };

  /**
   * How a token's top holders are tied together: the top holders by owner, then the newest transactions of the largest
   * wallets among them, their own and their token account's (a transfer into a token account never names the wallet),
   * read round-robin (a cut read leaves every wallet read as deep): any asset one top holder moved to another is a
   * link; an address outside the top that sent SOL, a stablecoin or this token to two or more of them is a common
   * funder, a distributor when it sent this token (other tokens never count: spam airdrops reach every large holder;
   * nor does dust, address poisoning: fundMin). Read before those: each holder's first transactions, when its token
   * account's history is short enough to reach them (LINK_FIRST_SIGS): its earliest incoming transfer of this token is
   * where its first tokens came from, a pool or a program included. An address off the curve has no private key (a
   * pool's or a launchpad's vault authority, a multisig's vault): like pools, program accounts, exchanges and the burn
   * address it never links, clusters or funds, and while what the owners are cannot be read nothing links. A vault is
   * named a Squads multisig's when its oldest or newest transaction read holds the multisig that derives it: the
   * vaults' histories are read before anything else, a whole page for one of MAP_BIG_PCT and more, so a cut read still
   * names them. A vault's first tokens from a wallet, an allocation (MAP_MIN_PCT of supply and more), tie the vault to
   * it: a link from a top holder, else a common funder. Holders tied by links or a common funder are a cluster;
   * withdrawals from one exchange tie no one. Who made the token: its verified creator in its metadata, else the wallet
   * that handed out the first tokens of two holders or more, one of them MAP_BIG_PCT of supply or more (the likely
   * deployer), tagged wherever it shows. The map gets the holders of MAP_BIG_PCT and more, then those in a cluster,
   * then the others of at least MAP_MIN_PCT, MAP_HOLDERS in all, the rest counted; an exchange that paid none of them
   * is left out. The largest cluster's share and the pools' are said apart, for the answer to state them. The read
   * keeps to a ReadBudget (LINK_RPC_MAX calls); what was read is returned, complete: false, as when reads failed.
   */
  const LINK_WALLETS = 15;
  const LINK_SIGS = 25;
  /** A holder's token account history read this deep: when it is shorter, its first transactions are read too */
  const LINK_FIRST_SIGS = 100;
  /** Those first transactions: the account's creation, and its first tokens when they came after */
  const LINK_FIRST_TXS = 2;
  const LINK_RPC_MAX = 400;
  const LINK_ROWS = 40;
  const FUNDER_ROWS = 15;
  /** Vaults whose own history is read for whose multisig they are */
  const LINK_VAULTS = 5;
  const MAP_HOLDERS = 12;
  const MAP_BIG_PCT = 5;
  const MAP_MIN_PCT = 0.5;
  const holderLinks: ToolDef = {
    name: "sol_holder_links",
    // what it answers that the holder list does not, said first
    description:
      "Whether a Solana token's top holders are one group in disguise, read from the chain (slower than the holder list): for bundles, insiders, sybils, concentration. The top holders by owner (12 at most, holders_left_out counts the rest): share, kind (wallet, exchange, vault, pool, program, burn), label, tags, where their first tokens came from; links between them; common funders (outside the top, paid 2+ of them; distributor: it sent this token; an exchange ties no one); clusters; creator (verified, else likely deployer); connected_share_pct (the largest cluster's), pools_share_pct.",
    parameters: {
      type: "object",
      properties: { mint: { type: "string", description: "Token mint address (base58)", pattern: SOL_ADDRESS } },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: 10 * MINUTE,
    async run(args, { signal, caller }) {
      const mint = String(args.mint);
      const callTag: CallTag = { tool: "sol_holder_links", caller };
      const budget = new ReadBudget(fc.limit.rpc, signal, LINK_RPC_MAX, rpc.tokensPerCall, 5);
      // its metadata beside: the creator it names, a wallet
      const [largestRaw, supplyRaw, metadata] = await Promise.all([
        rpc.call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], signal, callTag),
        rpc.call("getTokenSupply", [mint, { commitment: "confirmed" }], signal, callTag),
        tokensOf([mint], signal, callTag).catch(() => null),
      ]);
      const creator = metadata?.get(mint)?.creators.find(onCurve) ?? null;
      const accounts = isObj(largestRaw) && Array.isArray(largestRaw.value) ? largestRaw.value.filter(isObj) : null;
      const supplyV = isObj(supplyRaw) && isObj(supplyRaw.value) ? supplyRaw.value : null;
      if (!accounts || !supplyV) return { ok: false, error: "not_found" };
      const supply = num(supplyV.uiAmountString);
      const all = accounts
        .slice(0, 20)
        .map((a) => ({ account: str(a.address, 50), amount: num(a.uiAmountString) ?? 0 }))
        .filter((a): a is { account: string; amount: number } => a.account !== null);
      const owners = await ownersOf(all.map((a) => a.account), signal, callTag);
      // no owners, no wallets to read: nothing here would be true
      if (owners.size === 0) throw new ToolFail("unavailable");
      const programs = await programsOf([...new Set(owners.values())], signal, callTag);
      // each owner with its largest token account (the list comes largest first)
      const byOwner = new Map<string, { owner: string; account: string; amount: number; accounts: number; resolved: boolean }>();
      for (const a of all) {
        const owner = owners.get(a.account) ?? a.account;
        const h = byOwner.get(owner) ?? { owner, account: a.account, amount: 0, accounts: 0, resolved: owners.has(a.account) };
        h.amount += a.amount;
        h.accounts++;
        byOwner.set(owner, h);
      }
      // the holders and the senders of their first tokens: token accounts' owners all
      const kindOf = (o: string): AddressKind => addressKind(o, programs.get(o), true);
      const holders = [...byOwner.values()].sort((a, b) => b.amount - a.amount).map((h) => ({ ...h, kind: kindOf(h.owner) }));
      const share = (amount: number): number | null => (supply ? (amount / supply) * 100 : null);
      const isHolder = new Set(holders.map((h) => h.owner));
      // what the owners are could not be read: a wallet is not told from a bonding curve, so nothing links
      const known = programs.size > 0;
      // wallets (and keys on the curve with no SOL account) link and cluster; pools, programs, vaults, exchanges and the burn address never do
      const linkable = new Set(known ? holders.filter((h) => h.resolved && (h.kind === "wallet" || h.kind === "unknown")).map((h) => h.owner) : []);
      const toRead = holders.filter((h) => linkable.has(h.owner)).slice(0, LINK_WALLETS);
      const reading = new Set(toRead.map((h) => h.owner));
      // whose first tokens are looked for: those and the vaults (a multisig vault's came from someone)
      const toTrace = holders.filter((h) => reading.has(h.owner) || (known && h.resolved && h.kind === "vault"));
      // the vaults whose multisig is not known yet: their own history, for a multisig among the keys of its transactions
      const toName = holders.filter((h) => known && h.resolved && h.kind === "vault" && !labelOf(h.owner, programs.get(h.owner))).slice(0, LINK_VAULTS);

      // the vaults' own histories first (a large one's a whole page, so its oldest is its first), then the wallets', then the token accounts'
      const vaultSigs = (h: { amount: number }) => ((share(h.amount) ?? 0) >= MAP_BIG_PCT ? ORIGIN_PAGE : LINK_FIRST_SIGS);
      const toList = [...toName.map((h) => [h.owner, vaultSigs(h), false] as const), ...toRead.map((h) => [h.owner, LINK_SIGS, true] as const), ...toTrace.map((h) => [h.account, LINK_FIRST_SIGS, false] as const)];
      // a wallet read for the first time with the launch keys there: its newest page, its list and transactions at once
      const lists = await budget.each(toList.length, (i) => {
        const [address, limit, wallet] = toList[i]!;
        return wallet ? newestList(address, limit, signal, callTag) : rpc.call("getSignaturesForAddress", [address, { limit, commitment: "confirmed" }], signal, callTag);
      });
      const listOf = new Map(toList.map(([a], i) => [a, lists[i]] as const));
      const accountSigs = new Map(toTrace.map((h) => [h.owner, listOf.get(h.account)] as const));
      // a vault's oldest transaction read (its first when the whole history came back: a multisig's creation), then its
      // newest: a multisig's own transactions (a vault's payments) name the multisig, a deposit into it may not
      const named = toName.map((h) => {
        const s = sigsOf(listOf.get(h.owner)).map((x) => x.signature);
        return [...new Set([s.at(-1), s[0]].filter((x): x is string => x !== undefined))];
      });
      const traced = new Set(toTrace.map((h) => h.owner));
      const readWallets = new Set(toRead.filter((h) => Array.isArray(listOf.get(h.owner))).map((h) => h.owner));
      // first: each holder's first transactions, oldest first, when its token account's whole history came back
      const whole = toTrace.map((h) => {
        const r = accountSigs.get(h.owner);
        return Array.isArray(r) && r.length < LINK_FIRST_SIGS;
      });
      const first = toTrace.map((h, i) => (whole[i] ? sigsOf(accountSigs.get(h.owner)).slice(-LINK_FIRST_TXS).reverse().map((s) => s.signature) : []));
      // then newest first over the wallets, each one's own and its token account's
      const recent = toRead.map((h) => newestOf([sigsOf(listOf.get(h.owner)), sigsOf(accountSigs.get(h.owner)).slice(0, LINK_SIGS)]).slice(0, LINK_SIGS));
      // round-robin, each transaction once (a transfer between two of them is in both lists): the vaults' first
      const order: string[] = [];
      const seen = new Set<string>();
      for (const group of [named, first, recent])
        for (let d = 0; d < Math.max(0, ...group.map((l) => l.length)); d++)
          for (const l of group) {
            const sg = l[d];
            if (sg && !seen.has(sg)) {
              seen.add(sg);
              order.push(sg);
            }
          }
      // the transactions: a read wallet whose newest are mostly not kept, its newest page first (one call where each
      // alone is one); then the rest one by one, round-robin, kept ones at no call
      const got = new Map<string, unknown>();
      if (fc.newestTxs) {
        const paging = toRead.filter((_, i) => recent[i]!.filter((sg) => !keptTxs.has(sg)).length >= PAGE_WORTH);
        await budget.each(paging.length, (i) => pageOf(paging[i]!.owner, LINK_SIGS, signal, callTag));
      }
      await readTxs(order, got, budget, signal, callTag);
      // each one in the order: kept or read (null when its read failed), none where the read stopped before it
      const txs: unknown[] = [];
      order.forEach((sg, i) => {
        if (got.has(sg)) txs[i] = got.get(sg);
      });
      // whose first tokens are known: those whose token account's whole history came back and its first transactions read
      const gotTx = new Set(order.filter((_, i) => isObj(txs[i])));
      const reached = new Set(toTrace.filter((_, i) => whole[i] && first[i]!.every((sg) => gotTx.has(sg))).map((h) => h.owner));
      const txAt = new Map(order.map((sg, i) => [sg, txs[i]]));
      const squads = new Set(toName.filter((h, i) => named[i]!.some((sg) => squadsVaultIn(txAt.get(sg), h.owner))).map((h) => h.owner));
      const holderLabel = (o: string) => (squads.has(o) ? "Squads multisig vault" : labelOf(o, programs.get(o), true));

      const links = new Map<string, { from: string; to: string; asset: string; amount: number; count: number; first: number; last: number }>();
      const funded = new Map<string, Map<string, { sent: Map<string, number>; count: number; last: number }>>();
      const tokensFrom = new Map<string, { from: string; amount: number; t: number }>();
      // less than this sent is no funding and no origin: address poisoning and spam send dust
      const fundMin = (asset: string) => (asset === mint ? (supply ? supply * 1e-4 : dust(asset)) : asset === "SOL" ? dust(asset) : 1);
      let readTx = 0;
      let oldest = Infinity;
      let newest = 0;
      for (const r of txs) {
        if (!isObj(r)) continue;
        readTx++;
        const t = (num(r.blockTime) ?? 0) * 1000;
        if (t) {
          oldest = Math.min(oldest, t);
          newest = Math.max(newest, t);
        }
        for (const [asset, deltas] of trailDeltas(r)) {
          for (const [from, to, amount] of pairTransfers(deltas, dust(asset))) {
            // where a traced holder's tokens came from: its earliest incoming transfer of this token, whoever sent it
            if (asset === mint && traced.has(to) && amount >= fundMin(asset)) {
              const was = tokensFrom.get(to);
              if (!was || (t > 0 && (was.t === 0 || t < was.t))) tokensFrom.set(to, { from, amount, t });
            }
            if (linkable.has(from) && linkable.has(to)) {
              const key = `${from}|${to}|${asset}`;
              const l = links.get(key) ?? { from, to, asset, amount: 0, count: 0, first: t, last: t };
              l.amount += amount;
              l.count++;
              if (t) {
                l.first = l.first ? Math.min(l.first, t) : t;
                l.last = Math.max(l.last, t);
              }
              links.set(key, l);
            } else if (linkable.has(to) && !isHolder.has(from) && (asset === mint || Object.hasOwn(ASSET_NAMES, asset)) && amount >= fundMin(asset) && onCurve(from)) {
              const m = funded.get(from) ?? new Map<string, { sent: Map<string, number>; count: number; last: number }>();
              const f = m.get(to) ?? { sent: new Map<string, number>(), count: 0, last: 0 };
              f.sent.set(asset, (f.sent.get(asset) ?? 0) + amount);
              f.count++;
              f.last = Math.max(f.last, t);
              m.set(to, f);
              funded.set(from, m);
            }
          }
        }
      }
      // a vault's first tokens from a wallet, an allocation, tie it to that wallet: a link from a top holder, else a funding
      const allotMin = (supply ?? Infinity) * (MAP_MIN_PCT / 100);
      for (const h of holders) {
        const f = h.kind === "vault" && reached.has(h.owner) ? tokensFrom.get(h.owner) : undefined;
        if (!f || f.amount < allotMin || !onCurve(f.from) || exchangeLabel(f.from)) continue;
        if (linkable.has(f.from)) links.set(`${f.from}|${h.owner}|${mint}`, { from: f.from, to: h.owner, asset: mint, amount: f.amount, count: 1, first: f.t, last: f.t });
        else if (!isHolder.has(f.from)) funded.set(f.from, (funded.get(f.from) ?? new Map()).set(h.owner, { sent: new Map([[mint, f.amount]]), count: 1, last: f.t }));
      }
      // who made the token: its verified creator; the wallet that handed out the first big allocations, the likely
      // deployer when no creator is named
      const deployer = firstAllocator(holders.filter((h) => reached.has(h.owner)).map((h) => tokensFrom.get(h.owner)), (supply ?? Infinity) * (MAP_BIG_PCT / 100));
      const tags = new Map<string, string[]>();
      const tag = (who: string, what: string) => tags.set(who, [...(tags.get(who) ?? []), what]);
      if (creator) tag(creator, "creator of this token (verified in its metadata)");
      if (deployer) tag(deployer, creator ? "handed out the first big allocations" : "handed out the first big allocations: the likely deployer");
      const maker = creator ?? deployer;
      const tagsOf = (address: string) => (tags.has(address) ? { tags: tags.get(address) } : {});
      const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
      const assetName = (asset: string) => (asset === mint ? "this token" : (ASSET_NAMES[asset] ?? asset));
      const sentOf = (m: Map<string, number>) => Object.fromEntries([...m].map(([a, v]) => [assetName(a), round(v, 6)]));
      type Funded = Map<string, { sent: Map<string, number> }>;
      const total = (m: Funded, asset: string) => [...m.values()].reduce((x, f) => x + (f.sent.get(asset) ?? 0), 0);
      // common funders: two or more holders, the most first, then the most of this token, then of SOL
      const candidates = [...funded].filter(([, m]) => m.size >= 2).sort((a, b) => b[1].size - a[1].size || total(b[1], mint) - total(a[1], mint) || total(b[1], "SOL") - total(a[1], "SOL")).slice(0, 100);
      // what they are: an exchange's hot wallet by its address alone, the others read
      const toAsk = candidates.map(([f]) => f).filter((f) => !exchangeLabel(f));
      const fundKinds = (toAsk.length > 0 ? await budget.last(() => kindsOf(toAsk, signal, callTag)) : null) ?? new Map<string, { kind: AddressKind; label: string | null }>();
      // what they are could not be read: listed as unknown (on the curve, never a derived address; a program may own one)
      const fundersKnown = toAsk.length === 0 || fundKinds.size > 0;
      const funders = candidates
        .map(([f, m]) => [f, m, fundKinds.get(f) ?? unread(f)] as const)
        .filter(([, , k]) => k.kind !== "program")
        .slice(0, FUNDER_ROWS)
        .map(([f, m, k]) => {
          const assets = new Set([...m.values()].flatMap((x) => [...x.sent.keys()]));
          const by = (x: { sent: Map<string, number> }, asset: string) => x.sent.get(asset) ?? 0;
          return {
            funder: f,
            kind: k.kind,
            ...(k.label ? { label: k.label } : {}),
            ...tagsOf(f),
            role: assets.has(mint) ? "distributor" : "funder",
            holders: [...m].sort((a, b) => by(b[1], mint) - by(a[1], mint) || by(b[1], "SOL") - by(a[1], "SOL")).map(([h, x]) => ({ holder: h, sent: sentOf(x.sent), count: x.count, last: iso(x.last) })),
            sent: sentOf(new Map([...assets].map((a) => [a, total(m, a)]))),
            link: solAccount(f),
          };
        });
      // clusters: holders tied by links or a common funder (union-find), two holders at least, the largest share first
      const parent = new Map<string, string>();
      const find = (x: string): string => {
        let root = x;
        while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
        parent.set(x, root);
        return root;
      };
      const join = (a: string, b: string) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
      };
      for (const l of links.values()) join(l.from, l.to);
      // an exchange's withdrawals to two holders tie them no more than any two of its customers
      for (const f of funders) if (f.kind !== "exchange") for (const h of f.holders) join(f.funder, h.holder);
      const groups = new Map<string, { holders: string[]; funders: string[] }>();
      for (const h of holders) {
        if (!linkable.has(h.owner) && h.kind !== "vault") continue;
        const g = groups.get(find(h.owner)) ?? { holders: [], funders: [] };
        g.holders.push(h.owner);
        groups.set(find(h.owner), g);
      }
      for (const f of funders) groups.get(find(f.funder))?.funders.push(f.funder);
      const shareOf = new Map(holders.map((h) => [h.owner, share(h.amount) ?? 0]));
      const clusters = [...groups.values()]
        .filter((g) => g.holders.length >= 2)
        .map((g) => {
          const vaults = g.holders.filter((h) => !linkable.has(h)).length;
          return { holders: g.holders, wallets: g.holders.length - vaults, ...(vaults > 0 ? { vaults } : {}), share_pct: round(g.holders.reduce((x, h) => x + (shareOf.get(h) ?? 0), 0), 4), funders: g.funders };
        })
        .sort((a, b) => (b.share_pct ?? 0) - (a.share_pct ?? 0))
        .map((c, i) => ({ cluster: i + 1, ...c }));
      const clusterOf = new Map(clusters.flatMap((c) => c.holders.map((h) => [h, c.cluster] as const)));
      const listsLost = lists.filter((r) => !Array.isArray(r)).length;
      const txsLost = txs.filter((r) => !isObj(r)).length;
      // reads that failed are passing: the next caller reads it again a minute later
      const failed = !known
        ? "what the top holders are could not be read: nothing is linked"
        : listsLost > 0
          ? `${listsLost} of ${lists.length} transaction lists could not be read`
          : txsLost > 0
            ? `${txsLost} of ${txs.length} transactions could not be read`
            : fundersKnown
              ? null
              : "what the common funders are could not be read: a program account may be among them";
      const why = budget.why() ?? failed;
      // the map's holders, MAP_HOLDERS at most: those of MAP_BIG_PCT and more whatever they are, then those in a
      // cluster, then the others of at least MAP_MIN_PCT, the largest first in each (dust an exchange paid, which ties
      // no one, pushed out holders of 1%)
      const pct = (h: { amount: number }) => share(h.amount) ?? MAP_MIN_PCT;
      const rank = (h: { owner: string; amount: number }) => (pct(h) >= MAP_BIG_PCT ? 0 : clusterOf.has(h.owner) ? 1 : pct(h) >= MAP_MIN_PCT ? 2 : 3);
      const onMap = new Set(holders.filter((h) => rank(h) < 3).sort((a, b) => rank(a) - rank(b)).slice(0, MAP_HOLDERS).map((h) => h.owner));
      const left = holders.filter((h) => !onMap.has(h.owner));
      const link = solToken(mint);
      return ok(
        {
          mint,
          supply,
          // what the answer states of the concentration: the largest group tied together, and what pools hold
          ...(known ? { connected_share_pct: clusters[0]?.share_pct ?? 0, pools_share_pct: round(holders.filter((h) => h.kind === "pool").reduce((x, h) => x + (share(h.amount) ?? 0), 0), 4) } : {}),
          ...(maker ? { creator: { address: maker, basis: tags.get(maker)![0], link: solAccount(maker) } } : {}),
          holders: holders
            .filter((h) => onMap.has(h.owner))
            .map((h) => {
              const from = reached.has(h.owner) ? tokensFrom.get(h.owner) : undefined;
              const fromKind = from ? kindOf(from.from) : null;
              const note = known || h.kind !== "unknown" ? noteOf(h.kind, programs.get(h.owner)) : undefined;
              const label = holderLabel(h.owner);
              return {
                owner: h.owner,
                share_pct: round(share(h.amount), 4),
                accounts: h.accounts,
                kind: h.kind,
                ...(label ? { label } : {}),
                ...tagsOf(h.owner),
                ...(note ? { note } : {}),
                read: readWallets.has(h.owner),
                cluster: clusterOf.get(h.owner) ?? null,
                ...(from ? { tokens_from: { from: from.from, kind: fromKind === "pool" || fromKind === "program" || fromKind === "vault" || fromKind === "exchange" ? fromKind : "wallet", ...tagsOf(from.from), amount: round(from.amount, 6), time: iso(from.t) } } : {}),
                link: solAccount(h.owner),
              };
            }),
          ...(left.length > 0 ? { holders_left_out: { holders: left.length, share_pct: round(left.reduce((x, h) => x + (share(h.amount) ?? 0), 0), 4) } } : {}),
          links: [...links.values()]
            .sort((a, b) => b.count - a.count || b.amount - a.amount)
            .slice(0, LINK_ROWS)
            .map((l) => ({ from: l.from, to: l.to, asset: assetName(l.asset), amount: round(l.amount, 6), count: l.count, first: iso(l.first), last: iso(l.last) })),
          // an exchange ties no one: one that paid only holders off the map would be a dot with no line on it
          funders: funders.filter((f) => f.kind !== "exchange" || f.holders.some((x) => onMap.has(x.holder))),
          clusters,
          wallets_read: readWallets.size,
          transactions_read: readTx,
          rpc_calls: budget.calls,
          from: iso(oldest === Infinity ? 0 : oldest),
          to: iso(newest),
          complete: why === null,
          ...(why ? { why } : {}),
          link: link ? `${link}#holders` : null,
        },
        [src("Solscan: token holders", link ? `${link}#holders` : null)],
        budget.passing || failed !== null,
      );
    },
  };

  /**
   * A coin's pools' lp lock read from the chain: its pools as DexScreener lists them; a PumpSwap pool's account (its lp
   * mint), the lp mint's supply now and, when some is out, its largest holders: none out (burned, as pump.fun's
   * migration burns it) or all of it in the incinerator is locked, any other holder can pull its share. Meteora's DLMM
   * bins are positions (never locked); any other pool is unread. Its shares in token_risk_flags' keys
   * (lp_locked_pct_lockable, lp_locked_usd, dlmm_liquidity_usd)
   */
  const lpLock: ToolDef = {
    name: "sol_lp_lock",
    description:
      "Whether a Solana coin's pool liquidity can be pulled, read from the chain: per pool (DexScreener's list) its dex, liquidity and lp: burned (none left to pull), held (its holders can pull it), dlmm positions or unread; the share of the lockable liquidity locked or burned. PumpSwap pools are read; other pools' lp is unread.",
    parameters: {
      type: "object",
      properties: { mint: { type: "string", description: "The coin's mint (base58)", pattern: SOL_ADDRESS } },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: 2 * MINUTE,
    async run(args, { signal, caller }): Promise<Outcome> {
      const mint = String(args.mint);
      const callTag: CallTag = { tool: "sol_lp_lock", ...(caller ? { caller } : {}) };
      take(fc.limit.dexscreener);
      const listed = await fc.http.json(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal }).catch(() => null);
      const pairs = (Array.isArray(listed) ? listed : []).filter(isObj).filter((p) => p.chainId === "solana" || p.chainId === undefined);
      const pools = pairs
        .map((p) => ({ dex: str(p.dexId, 40) ?? "?", pool: str(p.pairAddress, 50) ?? "", usd: num(isObj(p.liquidity) ? p.liquidity.usd : null) ?? 0, labels: Array.isArray(p.labels) ? p.labels.map(String) : [] }))
        .filter((p) => SOL_ADDRESS_RE.test(p.pool) && p.usd > 0);
      if (pools.length === 0) return { ok: false, error: "not_found", message: "no pool with liquidity listed for this coin" };
      const swaps = pools.filter((p) => p.dex === "pumpswap");
      const accounts = swaps.length ? await rpc.call("getMultipleAccounts", [swaps.map((p) => p.pool), { encoding: "base64", commitment: "confirmed" }], signal, callTag) : null;
      const values = isObj(accounts) && Array.isArray(accounts.value) ? accounts.value : [];
      const rows: { dex: string; pool: string; liquidity_usd: number; lp: "burned" | "held" | "dlmm" | "unread"; lp_burned_pct: number | null }[] = [];
      for (const p of pools) {
        if (/dlmm/i.test(p.dex) || p.labels.some((l) => /dlmm/i.test(l))) {
          rows.push({ dex: p.dex, pool: p.pool, liquidity_usd: round(p.usd, 0)!, lp: "dlmm", lp_burned_pct: null });
          continue;
        }
        if (p.dex !== "pumpswap") {
          rows.push({ dex: p.dex, pool: p.pool, liquidity_usd: round(p.usd, 0)!, lp: "unread", lp_burned_pct: null });
          continue;
        }
        const v = values[swaps.indexOf(p)];
        const lpMint = isObj(v) && v.owner === PUMPSWAP_PROGRAM && Array.isArray(v.data) && typeof v.data[0] === "string" ? pumpswapLpMint(Buffer.from(v.data[0], "base64"), mint) : null;
        let burned: number | null = null;
        if (lpMint) {
          const sup = await rpc.call("getTokenSupply", [lpMint, { commitment: "confirmed" }], signal, callTag).catch(() => null);
          const out = isObj(sup) && isObj(sup.value) ? Number(sup.value.amount) : NaN;
          if (out === 0) burned = 100;
          else if (Number.isFinite(out) && out > 0) {
            // some lp is out: the share of it in the incinerator is burned, the rest its holders' to pull
            const big = await rpc.call("getTokenLargestAccounts", [lpMint, { commitment: "confirmed" }], signal, callTag).catch(() => null);
            const list = isObj(big) && Array.isArray(big.value) ? big.value.filter(isObj) : [];
            const owners = list.length ? await rpc.call("getMultipleAccounts", [list.map((a) => String(a.address)), { encoding: "jsonParsed", commitment: "confirmed" }], signal, callTag).catch(() => null) : null;
            const parsed = isObj(owners) && Array.isArray(owners.value) ? owners.value : [];
            let inFire = 0;
            list.forEach((a, i) => {
              const info = isObj(parsed[i]) && isObj(parsed[i].data) && isObj(parsed[i].data.parsed) && isObj(parsed[i].data.parsed.info) ? parsed[i].data.parsed.info : null;
              if (info && LP_BURN_OWNERS.has(String(info.owner))) inFire += Number(a.amount) || 0;
            });
            burned = Math.max(0, Math.min(100, (inFire / out) * 100));
          }
        }
        rows.push({ dex: p.dex, pool: p.pool, liquidity_usd: round(p.usd, 0)!, lp: burned === null ? "unread" : burned >= 99.5 ? "burned" : "held", lp_burned_pct: burned === null ? null : round(burned, 1) });
      }
      const lockable = rows.filter((r) => r.lp !== "dlmm");
      const lockableUsd = lockable.reduce((t, r) => t + r.liquidity_usd, 0);
      const lockedUsd = lockable.reduce((t, r) => t + (r.lp_burned_pct !== null ? (r.liquidity_usd * r.lp_burned_pct) / 100 : 0), 0);
      const unreadUsd = lockable.filter((r) => r.lp === "unread").reduce((t, r) => t + r.liquidity_usd, 0);
      const dlmmUsd = rows.filter((r) => r.lp === "dlmm").reduce((t, r) => t + r.liquidity_usd, 0);
      const link = solToken(mint);
      return ok(
        {
          mint,
          pools: rows,
          lp_locked_pct_lockable: lockableUsd > 0 && unreadUsd < lockableUsd ? round((lockedUsd / lockableUsd) * 100, 1) : null,
          lp_locked_usd: round(lockedUsd, 0),
          lp_unread_usd: round(unreadUsd, 0),
          dlmm_liquidity_usd: round(dlmmUsd, 0),
          source: "chain",
          link,
        },
        [src("Solscan: token", link)],
      );
    },
  };

  /**
   * The holders past the top: a cabal spread thin (its top 10 held 5.5% and the holder links, which read the top 20,
   * found an 8% cluster). How much the wallets a band wide hold (SPREAD_BAND_MIN_PCT to SPREAD_BAND_MAX_PCT of supply
   * each: pools, vaults, programs and exchanges left out) does not tell it: plain pump.fun coins hold 40-79% of supply
   * in wallets of that size, their sizes as even. Who made the wallets does: a cabal's are fresh (a few transactions,
   * hours old) and one wallet sent them all their first SOL. So: every token account of the mint (DAS getTokenAccounts, SPREAD_PAGES pages of
   * SPREAD_PAGE at most), by owner; SPREAD_SAMPLE band wallets spaced evenly by size; each one's history (its count,
   * its age when it came back whole) and its first SOL: the wallet that sent it, read off its oldest transaction. An
   * exchange's hot wallet ties no one. Plain coins hold 25-51% in the band with 0-1 of 16 sampled fresh; a cabal's
   * coin 15-16 of 16, one short-lived funder of thousands of wallets. It tells a cabal, not which way it trades
   */
  const SPREAD_PAGE = 1000;
  const SPREAD_PAGES = 5;
  const SPREAD_BAND_MIN_PCT = 0.1;
  const SPREAD_BAND_MAX_PCT = 1;
  const SPREAD_SAMPLE = 16;
  /** A wallet is fresh under this many transactions, its whole history this young */
  const FRESH_SIGS = 200;
  const FRESH_HOURS = 72;
  const SPREAD_RPC_MAX = 2 + SPREAD_PAGES + 2 * SPREAD_SAMPLE;
  const spread: ToolDef = {
    name: "sol_holder_spread",
    description:
      "Whether a Solana coin hides a cabal spread thin past its top holders (many small wallets one hand made: they dump at once or pump it), read from the chain: every holder by owner, the band of wallets holding 0.1-1% of supply each (pools, programs, vaults and exchanges left out) and its share; 16 of them sampled evenly by size, each with its transactions, age and the wallet that sent its first SOL; how many are fresh (under 200 transactions, under 72 h old) and the funders that made several of them. For a young coin whose top holders look spread out.",
    parameters: {
      type: "object",
      properties: { mint: { type: "string", description: "The coin's mint (base58)", pattern: SOL_ADDRESS } },
      required: ["mint"],
      additionalProperties: false,
    },
    ttlMs: 5 * MINUTE,
    async run(args, { signal, caller }): Promise<Outcome> {
      const mint = String(args.mint);
      const callTag: CallTag = { tool: "sol_holder_spread", ...(caller ? { caller } : {}) };
      const budget = new ReadBudget(fc.limit.rpc, signal, SPREAD_RPC_MAX, rpc.tokensPerCall, 0, 0);
      const supplyRaw = await rpc.call("getTokenSupply", [mint, { commitment: "confirmed" }], signal, callTag);
      const supply = isObj(supplyRaw) && isObj(supplyRaw.value) ? Number(supplyRaw.value.amount) : NaN;
      if (!Number.isFinite(supply) || supply <= 0) return { ok: false, error: "not_found" };
      const owned = new Map<string, number>();
      let accounts = 0;
      let complete = false;
      for (let page = 1; page <= SPREAD_PAGES; page++) {
        const r = await rpc.call("getTokenAccounts", { mint, limit: SPREAD_PAGE, page }, signal, callTag);
        const list = isObj(r) && Array.isArray(r.token_accounts) ? r.token_accounts.filter(isObj) : [];
        for (const a of list) {
          const owner = str(a.owner, 50);
          const amount = Number(a.amount);
          if (!owner || !Number.isFinite(amount) || amount <= 0) continue;
          owned.set(owner, (owned.get(owner) ?? 0) + amount);
          accounts++;
        }
        if (list.length < SPREAD_PAGE) {
          complete = true;
          break;
        }
      }
      if (owned.size === 0) return { ok: false, error: "not_found" };
      // the band: keys someone holds (a pool's, a vault's or a program's authority is off the curve), no exchange
      const band = [...owned]
        .map(([owner, amount]) => ({ owner, pct: (amount / supply) * 100 }))
        .filter((h) => h.pct >= SPREAD_BAND_MIN_PCT && h.pct <= SPREAD_BAND_MAX_PCT && onCurve(h.owner) && !POOL_AUTHORITIES.has(h.owner) && !exchangeLabel(h.owner))
        .sort((a, b) => b.pct - a.pct);
      const bandPct = band.reduce((t, h) => t + h.pct, 0);
      // evenly by size, the largest first: one bundle's wallets are often one size, so a slice of the top would miss it
      const n = Math.min(SPREAD_SAMPLE, band.length);
      const sample = Array.from({ length: n }, (_, i) => band[Math.floor((i * band.length) / n)]!);
      // the tools' clock (fc.now), never the wall clock: a wallet's age is read against the same time as every other read
      const now = fc.now();
      const lists = await budget.each(sample.length, (i) => rpc.call("getSignaturesForAddress", [sample[i]!.owner, { limit: ORIGIN_PAGE, commitment: "confirmed" }], signal, callTag));
      const sigsOf = (i: number): Record<string, unknown>[] => (Array.isArray(lists[i]) ? (lists[i] as unknown[]).filter(isObj) : []);
      // the oldest transaction of each history that came back whole: the wallet's first, its first SOL in it
      const firsts = sample.map((_, i) => {
        const s = sigsOf(i);
        return s.length > 0 && s.length < ORIGIN_PAGE ? str(s[s.length - 1]!.signature, 100) : null;
      });
      const want = firsts.map((sig, i) => [sig, i] as const).filter((x): x is readonly [string, number] => x[0] !== null);
      const txs = await budget.each(want.length, (j) => txOf(want[j]![0], signal, callTag));
      const firstTx = new Map(want.map(([, i], j) => [i, isObj(txs[j]) ? (txs[j] as Record<string, unknown>) : null] as const));
      const wallets = sample.map((h, i) => {
        const s = sigsOf(i);
        const read = lists[i] !== null && lists[i] !== undefined;
        const whole = s.length > 0 && s.length < ORIGIN_PAGE;
        const t = whole ? num(s[s.length - 1]!.blockTime) : null;
        const ageH = t !== null ? Math.max(0, (now / 1000 - t) / 3600) : null;
        const tx = firstTx.get(i) ?? null;
        const funder = tx ? firstSolFrom(tx, h.owner) : null;
        return {
          wallet: h.owner,
          share_pct: round(h.pct, 3),
          transactions: read ? (whole ? s.length : `${ORIGIN_PAGE}+`) : null,
          age_h: ageH !== null ? round(ageH, 1) : null,
          funder,
          fresh: read ? whole && s.length < FRESH_SIGS && ageH !== null && ageH < FRESH_HOURS : null,
        };
      });
      const seen = wallets.filter((w) => w.fresh !== null);
      const counts = new Map<string, number>();
      for (const w of wallets) if (w.funder && !exchangeLabel(w.funder)) counts.set(w.funder, (counts.get(w.funder) ?? 0) + 1);
      const funders = [...counts].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([address, c]) => ({ address, wallets: c }));
      const mid = <T>(xs: T[]): T | null => (xs.length ? xs[Math.floor(xs.length / 2)]! : null);
      const link = solToken(mint);
      return ok(
        {
          mint,
          holders: owned.size,
          token_accounts_read: accounts,
          complete,
          band: { min_pct: SPREAD_BAND_MIN_PCT, max_pct: SPREAD_BAND_MAX_PCT, wallets: band.length, share_pct: round(bandPct, 2) },
          sample: {
            read: seen.length,
            fresh: seen.filter((w) => w.fresh).length,
            fresh_rule: `under ${FRESH_SIGS} transactions and under ${FRESH_HOURS} h old`,
            funders,
            median_transactions: mid(seen.map((w) => (typeof w.transactions === "number" ? w.transactions : ORIGIN_PAGE)).sort((a, b) => a - b)),
            median_age_h: mid(wallets.map((w) => w.age_h).filter((x): x is number => x !== null).sort((a, b) => a - b)),
          },
          wallets,
          ...(budget.cut ? { cut: budget.cut } : {}),
          link,
        },
        [src("Solscan: token", link)],
        budget.cut !== null,
      );
    },
  };

  const tools = [accountBasics, largest, origin, signatures, balanceChanges, moneyTrail, holderLinks, lpLock];
  if (rpc.hasDas) tools.push(spread);
  if (rpc.hasDas) {
    tools.push({
      name: "sol_asset_card",
      description: "A Solana token's name, symbol and metadata by mint, from the indexer: standard, decimals, supply, update authority and whether the metadata is mutable, mint and freeze authority, and a price when the indexer has one.",
      parameters: {
        type: "object",
        properties: { mint: { type: "string", description: "Token mint address (base58)", pattern: SOL_ADDRESS } },
        required: ["mint"],
        additionalProperties: false,
      },
      ttlMs: 3 * HOUR,
      async run(args, { signal, caller }) {
        const mint = String(args.mint);
        const r = await rpc.call("getAsset", { id: mint }, signal, { tool: "sol_asset_card", caller });
        if (!isObj(r)) return { ok: false, error: "not_found" };
        const content = isObj(r.content) ? r.content : {};
        const meta = isObj(content.metadata) ? content.metadata : {};
        const ti = isObj(r.token_info) ? r.token_info : {};
        const price = isObj(ti.price_info) ? ti.price_info : {};
        const auth = Array.isArray(r.authorities) ? r.authorities.filter(isObj) : [];
        const link = solToken(mint);
        return ok(
          {
            mint,
            interface: str(r.interface, 30),
            name: str(meta.name, 80),
            symbol: str(meta.symbol, 24) ?? str(ti.symbol, 24),
            decimals: num(ti.decimals),
            supply: uiFromRaw(ti.supply, ti.decimals),
            mint_authority: str(ti.mint_authority, 50) ?? "none",
            freeze_authority: str(ti.freeze_authority, 50) ?? "none",
            update_authority: auth.length ? str(auth[0]!.address, 50) : null,
            mutable: typeof r.mutable === "boolean" ? r.mutable : null,
            burnt: typeof r.burnt === "boolean" ? r.burnt : null,
            price_usd: str(price.currency, 10)?.toUpperCase().startsWith("USD") ? round(num(price.price_per_token), 6) : null,
            link,
          },
          [src("Solscan: token", link)],
        );
      },
    });
  }
  return tools;
}
