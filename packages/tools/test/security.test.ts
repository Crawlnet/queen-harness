// The security check on RugCheck and GoPlus (src/free/security.ts): token_risk_flags as a free tool, its arguments,
// its flags under the keys the queen's scan reads. The reports below keep the shapes of RugCheck's answers (a token-2022
// mint with its authorities kept, a pump.fun coin on its curve, BERN's transfer fee, a classic mint's pools), with
// made-up coins, wallets and pools but BERN's own; the honeypot is made up in GoPlus's own fields and values (its docs:
// "1" true, taxes on a 0-1 scale, sell_tax "1" a token that cannot be sold).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chainOf, goplusFacts } from "../src/free/security.ts";
import { primaryUrl } from "../src/links.ts";
import { createToolsWith } from "../src/registry.ts";
import { schemaProblems } from "../src/schema.ts";
import { makeCtx, solKey, tableFetch } from "./helpers.ts";

const NOW = Date.parse("2026-10-17T18:00:00Z");
const MIN = 60_000;
const AUTH_MINT = solKey("t22-authority-mint");
const DEV = solKey("t22-dev");
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const holder = (address: string, pct: number, owner: string, insider = false) => ({ address, amount: 1, decimals: 6, pct, owner, insider });
const extensions = (set: Record<string, unknown>) => ({
  nonTransferable: false,
  transferFeeConfig: null,
  defaultAccountState: null,
  permanentDelegate: null,
  metadataPointer: { authority: null, metadataAddress: AUTH_MINT },
  groupPointer: null,
  groupMemberPointer: null,
  mintCloseAuthority: null,
  confidentialTransferMint: null,
  interestBearingConfig: null,
  transferHook: null,
  confidentialTransferFeeConfig: null,
  tokenGroup: null,
  tokenGroupMember: null,
  scaledUiAmountConfig: null,
  pausableConfig: null,
  ...set,
});

/** A token-2022 mint: a mint authority, a permanent delegate and a close authority kept, no pool, RugCheck's 81 of 100 */
const AUTH_REPORT = {
  mint: AUTH_MINT,
  tokenProgram: T22,
  creator: DEV,
  creatorBalance: 0,
  token: { mintAuthority: DEV, supply: 493699925, decimals: 6, isInitialized: true, freezeAuthority: null },
  token_extensions: extensions({ permanentDelegate: { delegate: DEV }, mintCloseAuthority: { closeAuthority: DEV } }),
  tokenMeta: { name: "Example Outcome (Yes)", symbol: "EXO-Y", uri: `https://example.org/meta/${AUTH_MINT}`, mutable: true, updateAuthority: SYSTEM },
  topHolders: [38.841890851006305, 23.625347320034535, 12.168415054954687, 6.202219495982302, 4.2706271425907145, 3.7835033092216896, 2.281620358763474, 2.135131983258859, 1.8146316307420949, 1.6375710407490947, 1.399444004371684].map((pct, i) => holder(solKey(`t22-holder-${i}`), pct, solKey(`t22-owner-${i}`))),
  freezeAuthority: null,
  // the authority's account as RugCheck reads it (not its address: that is token.mintAuthority)
  mintAuthority: { lamports: 2275840, owner: solKey("authority-owner-program"), data: ["277VNwDj", "base64"] },
  risks: [
    { name: "Mint Authority still enabled", value: "", description: "More tokens can be minted by the owner", score: 50000, level: "danger" },
    { name: "Permanent Control Enabled", value: "", description: "The token creator can permanently control all tokens", score: 50000, level: "danger" },
    { name: "Top 10 holders high ownership", value: "", description: "The top 10 users hold more than 70% token supply", score: 9776, level: "danger" },
    { name: "Single holder ownership", value: "23.63%", description: "One user holds a large amount of the token supply", score: 6246, level: "warn" },
    { name: "Single holder ownership", value: "38.84%", description: "One user holds a large amount of the token supply", score: 3884, level: "warn" },
    { name: "Low Liquidity", value: "$0.00", description: "Low amount of liquidity in the token pool", score: 3000, level: "danger" },
    { name: "High ownership", value: "", description: "The top users hold more than 80% token supply", score: 1467, level: "danger" },
    { name: "Mutable metadata", value: "", description: "Token metadata can be changed by the owner", score: 100, level: "warn" },
  ],
  score: 124474,
  score_normalised: 81,
  fileMeta: { description: "", name: "Example Outcome (Yes)", symbol: "EXO-Y", image: "https://example.org/meta/exo.png" },
  lockerOwners: {},
  lockers: {},
  lockerScanStatus: "none",
  markets: null,
  totalMarketLiquidity: 0,
  totalStableLiquidity: 0,
  totalLPProviders: 0,
  totalHolders: 16,
  price: 0,
  rugged: false,
  tokenType: "",
  transferFee: { pct: 0, maxAmount: 0, authority: SYSTEM },
  knownAccounts: { [DEV]: { name: "Creator", type: "CREATOR" }, [solKey("t22-locker")]: { name: "Example Stake Pool", type: "LOCKER" } },
  events: [],
  verification: null,
  graphInsidersDetected: 0,
  insiderNetworks: null,
  detectedAt: "2026-10-17T17:17:06.900961093Z",
  creatorTokens: null,
  launchpad: null,
  deployPlatform: "unknown",
};

/** A pump.fun coin on its curve: the curve (an AMM RugCheck knows) holds 97.9%, the creator the rest */
const CURVE_MINT = solKey("curve-coin");
const CURVE_DEV = solKey("curve-dev");
const CURVE = solKey("curve-account");
const curveReport = (detectedAt: string) => ({
  mint: CURVE_MINT,
  tokenProgram: T22,
  creator: CURVE_DEV,
  creatorBalance: 20740100873027,
  token: { mintAuthority: null, supply: 1000000000000000, decimals: 6, isInitialized: true, freezeAuthority: null },
  token_extensions: extensions({ metadataPointer: { authority: null, metadataAddress: CURVE_MINT }, tokenMetadata: { authority: null, mint: CURVE_MINT, name: "Example Dog", symbol: "exdog" } }),
  tokenMeta: { name: "Example Dog", symbol: "exdog", uri: "https://ipfs.io/ipfs/x", mutable: false, updateAuthority: SYSTEM },
  topHolders: [holder(solKey("curve-token-account"), 97.9259899126973, CURVE), holder(solKey("curve-dev-token-account"), 2.0740100873027, CURVE_DEV)],
  risks: [],
  score: 1,
  score_normalised: 1,
  markets: [{ pubkey: CURVE, marketType: "pump_fun", mintA: CURVE_MINT, mintB: "So11111111111111111111111111111111111111112", lp: { baseUSD: 0, quoteUSD: 61.035965455116376, lpLockedUSD: 61.035965455116376, lpLockedPct: 100, holders: null } }],
  totalMarketLiquidity: 61.035965455116376,
  totalHolders: 2,
  rugged: false,
  transferFee: { pct: 0, maxAmount: 0, authority: SYSTEM },
  knownAccounts: { [CURVE]: { name: "Pump Fun", type: "AMM" }, [CURVE_DEV]: { name: "Creator", type: "CREATOR" }, [solKey("curve-other-amm-account")]: { name: "Pump Fun", type: "AMM" } },
  graphInsidersDetected: 0,
  detectedAt,
  creatorTokens: [{ mint: solKey("curve-dev-other-coin"), marketCap: 3479.1390329215337, createdAt: "2026-10-17T06:15:42.855595748Z" }],
  launchpad: { name: "Pump.Fun", logo: "https://api.rugcheck.xyz/public/logos/pump_fun.png", url: "https://x.com/pumpfun", platform: "pump_fun" },
});

/** BERN: a token-2022 transfer fee, 4.2% until epoch 698 and 2.69% since; RugCheck's own flat transferFee reads 0 */
const BERN = "CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo";
const BERN_REPORT = {
  mint: BERN,
  tokenProgram: T22,
  creator: null,
  creatorBalance: 0,
  token: { mintAuthority: null, supply: 94369006091637, decimals: 5, isInitialized: true, freezeAuthority: null },
  token_extensions: extensions({
    transferFeeConfig: {
      transferFeeConfigAuthority: "BeRNwDN8aGHvxYRVhNyMkF1wsxuEeceux2xn5deFWyEe",
      withdrawWithheldAuthority: "BeRNwDN8aGHvxYRVhNyMkF1wsxuEeceux2xn5deFWyEe",
      withheldAmount: 305131466,
      olderTransferFee: { epoch: 624, maximumFee: 3906250000000000000, transferFeeBasisPoints: 420 },
      newerTransferFee: { epoch: 698, maximumFee: 3906250000000000000, transferFeeBasisPoints: 269 },
    },
  }),
  tokenMeta: { name: "BonkEarn", symbol: "BERN", uri: "https://api.npoint.io/6276c0cc3ab046e9b770", mutable: false, updateAuthority: "7MyTjmRygJoCuDBUtAuSugiYZFULD2SWaoUTmtjtRDzD" },
  topHolders: [],
  risks: [{ name: "Fee config enabled", value: "", description: "The owner can change the fees at any time", score: 200, level: "warn" }],
  score: 201,
  score_normalised: 10,
  markets: [],
  totalMarketLiquidity: 0,
  totalHolders: 72083,
  rugged: false,
  transferFee: { pct: 0, maxAmount: 0, authority: SYSTEM },
  knownAccounts: {},
  detectedAt: "2024-05-29T00:49:41.496157718Z",
};

/** A classic mint, no authority; its pools' liquidity in two (the summary's lpLockedPct: 43.140413471186896) */
const CLASSIC = solKey("classic-mint");
const CLASSIC_DLMM = solKey("classic-dlmm-pool");
const CLASSIC_REPORT = {
  mint: CLASSIC,
  tokenProgram: SPL,
  creator: null,
  creatorBalance: 0,
  token: { mintAuthority: null, supply: 998836820306241, decimals: 6, isInitialized: true, freezeAuthority: null },
  token_extensions: null,
  tokenMeta: { name: "Example Classic", symbol: "$EXCL", uri: "https://example.org/classic.json", mutable: false, updateAuthority: solKey("classic-update-authority") },
  topHolders: [holder(solKey("classic-holder-1"), 13.724538280104937, solKey("classic-owner-1")), holder(solKey("classic-holder-2"), 9.669739226265737, solKey("classic-owner-2"))],
  risks: [],
  score: 1,
  score_normalised: 1,
  markets: [
    { pubkey: solKey("classic-raydium-pool"), marketType: "raydium", lp: { baseUSD: 2886704.153997228, quoteUSD: 2836522.1580010178, lpLockedUSD: 5708345.923586066, lpLockedPct: 99.74 } },
    { pubkey: CLASSIC_DLMM, marketType: "meteoraDlmm", lp: { baseUSD: 3758302.74, quoteUSD: 3758302.744929729, lpLockedUSD: 3372.256498341, lpLockedPct: 0.04 } },
  ],
  totalMarketLiquidity: 13239831.796927989,
  totalHolders: 813438,
  rugged: false,
  transferFee: { pct: 0, maxAmount: 0, authority: SYSTEM },
  knownAccounts: { [CLASSIC_DLMM]: { name: "Meteora DLMM Pool", type: "AMM" } },
  verification: { mint: CLASSIC, payer: "", name: "Example Classic", symbol: "$excl", description: "", jup_verified: true, jup_strict: true, validated: false, links: [] },
  graphInsidersDetected: 120,
  detectedAt: "2024-05-29T00:47:54.994464097Z",
};

/** A made-up BNB Chain honeypot in GoPlus's fields: it cannot be sold, taxes, an owner who can change balances */
const POT = "0x9f1e8a3c2b7d4e5f6a0b1c2d3e4f5a6b7c8d9e0f";
const PAIR = "0x5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f";
const OWNER = "0x00000000000000000000000000000000000000a1";
const DEAD = "0x000000000000000000000000000000000000dead";
const POT_RECORD = {
  anti_whale_modifiable: "1",
  buy_tax: "0.1",
  can_take_back_ownership: "1",
  cannot_buy: "0",
  cannot_sell_all: "1",
  creator_address: OWNER,
  creator_balance: "50000000",
  creator_percent: "0.050000",
  dex: [{ liquidity_type: "UniV2", name: "PancakeV2", liquidity: "8421.5", pool_fee: "0.0025", pair: PAIR }],
  external_call: "0",
  hidden_owner: "1",
  holder_count: "212",
  holders: [
    { address: DEAD, tag: "", is_contract: 0, balance: "500000000", percent: "0.5", is_locked: 1 },
    { address: PAIR, tag: "", is_contract: 1, balance: "200000000", percent: "0.2", is_locked: 0 },
    { address: "0x1111111111111111111111111111111111111111", tag: "", is_contract: 0, balance: "120000000", percent: "0.12", is_locked: 0 },
    { address: OWNER, tag: "", is_contract: 0, balance: "50000000", percent: "0.05", is_locked: 0 },
    { address: "0x2222222222222222222222222222222222222222", tag: "", is_contract: 0, balance: "30000000", percent: "0.03", is_locked: 0 },
  ],
  honeypot_with_same_creator: "1",
  is_anti_whale: "1",
  is_blacklisted: "1",
  is_honeypot: "1",
  is_in_dex: "1",
  is_mintable: "1",
  is_open_source: "1",
  is_proxy: "0",
  is_whitelisted: "1",
  lp_holder_count: "2",
  lp_holders: [
    { address: DEAD, tag: "", value: "8000", is_contract: 0, balance: "950", percent: "0.95", NFT_list: null, is_locked: 1 },
    { address: OWNER, tag: "", value: "421", is_contract: 0, balance: "50", percent: "0.05", NFT_list: null, is_locked: 0 },
  ],
  lp_total_supply: "1000",
  owner_address: OWNER,
  owner_balance: "50000000",
  owner_change_balance: "1",
  owner_percent: "0.050000",
  personal_slippage_modifiable: "1",
  selfdestruct: "0",
  sell_tax: "1",
  slippage_modifiable: "1",
  token_name: "Example Inu",
  token_symbol: "EXINU",
  total_supply: "1000000000",
  trading_cooldown: "0",
  transfer_pausable: "1",
  transfer_tax: "0",
  other_potential_risks: "Owner can set different transaction taxes for each user, which can trigger serious losses.",
};

/**
 * The keys the queen's scan reads in these results (packages/harness/src/scan.ts readSecurity, mirrored: its keys and its
 * walk, two levels down): renamed on either side, the token block's honeypot, tax, hook and lp lock checks go quiet
 */
function queenReads(d: Record<string, unknown>) {
  const entries: [string, unknown][] = [];
  const walk = (o: Record<string, unknown>, depth: number): void => {
    for (const [k, v] of Object.entries(o)) {
      entries.push([k.toLowerCase().replace(/[^a-z0-9]+/g, "_"), v]);
      if (depth < 2 && v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, depth + 1);
    }
  };
  walk(d, 0);
  const values = (key: RegExp) => entries.filter(([k]) => key.test(k)).map(([, v]) => v);
  return {
    honeypot: values(/(?:^|_)honeypot$/),
    tax: values(/(?:^|_)(?:buy|sell|transfer)_?(?:tax|fee)(?:_pct|_percent|_bps|_rate)?$/),
    hook: values(/(?:^|_)transfer_hook$/),
    nonTransferable: values(/(?:^|_)non_transferable$/),
    balanceMutable: values(/(?:^|_)balance_mutable(?:_authority)?$/),
    lpLocked: values(/^(?:is_)?(?:lp|liquidity)_(?:is_)?locked$/),
    lpLockedPct: values(/^(?:lp|liquidity)_locked_(?:pct|percent)$/),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function world(table: Parameters<typeof tableFetch>[0], env: Record<string, string> = {}, clock = { t: NOW }) {
  const f = tableFetch(table);
  const t = createToolsWith(makeCtx({ TOOLS_SECURITY: "on", TOOLS_MAX_CALLS_PER_ANSWER: "50", ...env }), { fetch: f.fetch, background: false, now: () => clock.t });
  return { t, urls: f.urls, clock };
}
const dataOf = (r: Awaited<ReturnType<ReturnType<typeof createToolsWith>["run"]>>) => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.data as Record<string, unknown>;
};

describe("the security check on RugCheck and GoPlus (free/security.ts)", () => {
  it("is on by default: free, its arguments (chain, address), a valid definition; TOOLS_SECURITY=off leaves it out", () => {
    const { t } = world({});
    const spec = t.list().find((s) => s.name === "token_risk_flags");
    assert.ok(spec, "offered");
    assert.deepEqual(Object.keys(spec!.parameters.properties), ["chain", "address"]);
    assert.deepEqual(spec!.parameters.required, ["address"]);
    assert.deepEqual(schemaProblems(spec!), []);
    assert.match(spec!.description, /not a verdict and not investment advice/);
    const off = createToolsWith(makeCtx({ TOOLS_SECURITY: "off" }), { fetch: async () => json({}), background: false });
    assert.equal(off.list().some((s) => s.name === "token_risk_flags"), false);
    assert.equal(createToolsWith({ ...makeCtx(), env: {} }, { fetch: async () => json({}), background: false }).config.security, true, "on with nothing set");
  });

  it("a Solana mint with its authorities kept and RugCheck's high score: the authorities, the delegate, the holders, the score and named risks, as facts", async () => {
    const { t, urls } = world({ [`https://api.rugcheck.xyz/v1/tokens/${AUTH_MINT}/report`]: AUTH_REPORT });
    const r = await t.run("token_risk_flags", { address: AUTH_MINT, chain: "solana" }, { answerId: "s1" });
    const d = dataOf(r);
    assert.deepEqual(urls, [`https://api.rugcheck.xyz/v1/tokens/${AUTH_MINT}/report`]);
    assert.equal(d.source, "RugCheck");
    assert.deepEqual([d.name, d.symbol, d.token_program], ["Example Outcome (Yes)", "EXO-Y", "token-2022"]);
    assert.deepEqual([d.mint_authority, d.freeze_authority], [DEV, "none"], "the address from token.mintAuthority, never the account object beside it");
    assert.deepEqual([d.transfer_fee_pct, d.transfer_hook, d.non_transferable, d.balance_mutable, d.permanent_delegate, d.mint_closable], [0, false, false, true, DEV, true]);
    assert.deepEqual(d.extensions, ["permanentDelegate", "mintCloseAuthority"]);
    assert.equal(d.metadata_mutable, true);
    assert.deepEqual([d.holders, d.top10_holders_pct, d.largest_holder_pct, d.pools_hold_pct, d.insiders_in_top_holders], [16, 96.76, 38.84, 0, 0]);
    assert.deepEqual([d.creator, d.creator_holds_pct], [DEV, 0]);
    assert.deepEqual([d.liquidity_usd, d.lp_locked_pct], [null, null], "no pool read: no liquidity, nothing said locked (said as unknown)");
    assert.ok(!("pools" in d), "a fact left unsaid is left out unless the queen reads it");
    assert.deepEqual([d.rugcheck_score, d.rugcheck_score_normalised, d.rugged], [124474, 81, false]);
    const risks = d.risks as { name: string; level: string; value?: string }[];
    assert.equal(risks.length, 8);
    assert.deepEqual(risks[0], { name: "Mint Authority still enabled", level: "danger" });
    assert.deepEqual(risks[3], { name: "Single holder ownership", level: "warn", value: "23.63%" });
    assert.deepEqual(queenReads(d), { honeypot: [], tax: [0], hook: [false], nonTransferable: [false], balanceMutable: [true], lpLocked: [], lpLockedPct: [null] });
    assert.ok(r.ok);
    assert.deepEqual(
      r.sources.map((s) => s.url),
      [`https://rugcheck.xyz/tokens/${AUTH_MINT}`, `https://solscan.io/token/${AUTH_MINT}`],
    );
    for (const s of r.sources) assert.equal(primaryUrl(s.url), s.url);
    assert.doesNotMatch(JSON.stringify(d), /\bverdict|\bsafe\b|\blegit/i, "never a verdict");
  });

  it("a curve's own holdings and lockers apart, the creator's share and other tokens; a token RugCheck first saw minutes ago is kept a minute, an older one ten", async () => {
    const clock = { t: NOW };
    const fresh = curveReport(new Date(NOW - 4 * MIN).toISOString());
    const { t, urls } = world({ [`https://api.rugcheck.xyz/v1/tokens/${CURVE_MINT}/report`]: fresh, [`https://api.rugcheck.xyz/v1/tokens/${AUTH_MINT}/report`]: AUTH_REPORT }, {}, clock);
    const d = dataOf(await t.run("token_risk_flags", { address: CURVE_MINT }, { answerId: "c1" }));
    assert.equal(d.chain, "solana", "a base58 address with no chain is a Solana mint");
    assert.deepEqual([d.top10_holders_pct, d.largest_holder_pct, d.pools_hold_pct], [2.074, 2.074, 97.93], "the curve is no holder");
    assert.deepEqual([d.creator, d.creator_holds_pct, d.creator_other_tokens, d.launchpad], [CURVE_DEV, 2.074, 1, "Pump.Fun"]);
    assert.deepEqual([d.liquidity_usd, d.lp_locked_pct, d.pools], [61.04, 100, 1]);
    assert.deepEqual([d.mint_authority, d.freeze_authority, d.balance_mutable, d.transfer_hook], ["none", "none", false, false]);
    assert.equal(d.extensions, undefined, "the metadata extensions are not listed");
    assert.match(String(d.note), /RugCheck first saw it 4 min ago/);
    clock.t += 61_000;
    await t.run("token_risk_flags", { address: CURVE_MINT }, { answerId: "c2" });
    assert.equal(urls.filter((u) => u.includes(CURVE_MINT)).length, 2, "a fresh read is kept a minute");
    await t.run("token_risk_flags", { address: AUTH_MINT }, { answerId: "c3" });
    clock.t += 9 * MIN;
    await t.run("token_risk_flags", { address: AUTH_MINT }, { answerId: "c4" });
    assert.equal(urls.filter((u) => u.includes(AUTH_MINT)).length, 1, "kept ten minutes");
    clock.t += 2 * MIN;
    await t.run("token_risk_flags", { address: AUTH_MINT }, { answerId: "c5" });
    assert.equal(urls.filter((u) => u.includes(AUTH_MINT)).length, 2);
  });

  it("a token-2022 transfer fee from its config (RugCheck's flat transferFee says 0); a classic mint can have none; the pools' locked share by their USD", async () => {
    const { t } = world({ [`https://api.rugcheck.xyz/v1/tokens/${BERN}/report`]: BERN_REPORT, [`https://api.rugcheck.xyz/v1/tokens/${CLASSIC}/report`]: CLASSIC_REPORT });
    const bern = dataOf(await t.run("token_risk_flags", { address: BERN, chain: "solana" }, { answerId: "f1" }));
    assert.deepEqual([bern.transfer_fee_pct, bern.transfer_fee_changeable, bern.transfer_fee_from_epoch, bern.balance_mutable], [2.69, true, 698, false]);
    assert.deepEqual(queenReads(bern).tax, [2.69], "the queen reads it taxed");
    assert.deepEqual([bern.holders, bern.top10_holders_pct, bern.liquidity_usd, bern.pools], [72083, null, 0, 0]);
    const classic = dataOf(await t.run("token_risk_flags", { address: CLASSIC, chain: "solana" }, { answerId: "f2" }));
    assert.deepEqual([classic.token_program, classic.transfer_fee_pct, classic.transfer_hook, classic.non_transferable, classic.balance_mutable], ["spl", 0, false, false, false]);
    assert.deepEqual([classic.lp_locked_pct, classic.liquidity_usd, classic.pools], [43.14, 13239832, 2], "RugCheck's own summary: 43.140413471186896");
    assert.deepEqual([classic.lp_locked_pct_lockable, classic.lp_locked_usd, classic.dlmm_liquidity_usd], [99.74, 5711718, 7516605], "its raydium pool's lp locked; the DLMM bins apart");
    assert.deepEqual([classic.jupiter_verified, classic.insider_wallets_detected, classic.top10_holders_pct], [true, 120, 23.39]);
  });

  it("the locked share over the pools an lp can be locked in, DLMM left out: a deployer's own pump pool reads unlocked, a graduated coin's burned pool beside DLMM bins reads locked", async () => {
    // a coin whose $340k pump pool's lp its deployer holds, beside its launch's small DAMM v2 pool; a graduated coin whose
    // pump pool's lp is burned, beside market makers' DLMM bins
    const HELD = solKey("lp-held-coin");
    const BURNED = solKey("lp-burned-coin");
    const report = (mint: string, markets: Record<string, unknown>[]) => ({ ...CLASSIC_REPORT, mint, markets, totalMarketLiquidity: null, verification: null, graphInsidersDetected: 0 });
    const { t } = world({
      [`https://api.rugcheck.xyz/v1/tokens/${HELD}/report`]: report(HELD, [
        { pubkey: solKey("held-pump-pool"), marketType: "pump_fun_amm", lp: { baseUSD: 170000, quoteUSD: 170000, lpLockedUSD: 0, lpLockedPct: 0 } },
        { pubkey: solKey("held-damm-pool"), marketType: "meteora_damm_v2", lp: { baseUSD: 2500, quoteUSD: 2500, lpLockedUSD: 5000, lpLockedPct: 100 } },
      ]),
      [`https://api.rugcheck.xyz/v1/tokens/${BURNED}/report`]: report(BURNED, [
        { pubkey: solKey("burned-dlmm-pool"), marketType: "meteoraDlmm", lp: { baseUSD: 217000, quoteUSD: 218000, lpLockedUSD: 0, lpLockedPct: 0 } },
        { pubkey: solKey("burned-pump-pool"), marketType: "pump_fun_amm", lp: { baseUSD: 178500, quoteUSD: 178500, lpLockedUSD: 357000, lpLockedPct: 100 } },
      ]),
    });
    const held = dataOf(await t.run("token_risk_flags", { address: HELD, chain: "solana" }, { answerId: "l1" }));
    assert.deepEqual([held.lp_locked_pct, held.lp_locked_pct_lockable, held.lp_locked_usd, held.dlmm_liquidity_usd], [1.449, 1.449, 5000, undefined]);
    const burned = dataOf(await t.run("token_risk_flags", { address: BURNED, chain: "solana" }, { answerId: "l2" }));
    assert.deepEqual([burned.lp_locked_pct, burned.lp_locked_pct_lockable, burned.lp_locked_usd, burned.dlmm_liquidity_usd], [45.08, 100, 357000, 435000]);
    assert.deepEqual(queenReads(burned).lpLockedPct, [45.08], "the scan's key keeps its meaning: all pools");
    assert.match(String(burned.note), /lp_locked_pct_lockable: the same over the pools an lp can be locked in/);
  });

  it("an EVM honeypot with taxes: GoPlus's flags as facts, taxes as percents, the top 10 without the burn address and the pool, the LP burned", async () => {
    const { t, urls } = world({ "https://api.gopluslabs.io/api/v1/token_security/56": { code: 1, message: "OK", result: { [POT]: POT_RECORD } } });
    const r = await t.run("token_risk_flags", { address: POT.toUpperCase().replace("0X", "0x"), chain: "BNB Chain" }, { answerId: "e1" });
    const d = dataOf(r);
    assert.deepEqual(urls, [`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${POT}`]);
    assert.deepEqual([d.chain, d.address, d.source, d.name, d.symbol], ["bsc", POT, "GoPlus", "Example Inu", "EXINU"]);
    assert.deepEqual([d.is_honeypot, d.cannot_buy, d.cannot_sell_all, d.buy_tax_pct, d.sell_tax_pct, d.transfer_tax_pct], [true, false, true, 10, 100, 0]);
    assert.deepEqual([d.tax_modifiable, d.personal_tax_modifiable, d.mintable, d.hidden_owner, d.can_take_back_ownership, d.balance_mutable], [true, true, true, true, true, true]);
    assert.deepEqual([d.is_open_source, d.is_proxy, d.has_blacklist, d.has_whitelist, d.transfer_pausable, d.selfdestruct], [true, false, true, true, true, false]);
    assert.deepEqual([d.owner, d.owner_holds_pct, d.creator, d.creator_holds_pct, d.honeypot_with_same_creator], [OWNER, 5, OWNER, 5, true]);
    assert.deepEqual([d.holders, d.top10_holders_pct, d.largest_holder_pct, d.burned_pct, d.pools_hold_pct], [212, 20, 12, 50, 20]);
    assert.deepEqual([d.lp_holders, d.lp_locked_pct, d.dex_pools, d.dex_liquidity_usd], [2, 95, 1, 8422]);
    assert.match(String(d.other_risks), /different transaction taxes/);
    assert.deepEqual(queenReads(d), { honeypot: [true], tax: [10, 100, 0], hook: [], nonTransferable: [], balanceMutable: [true], lpLocked: [], lpLockedPct: [95] });
    assert.ok(r.ok);
    assert.deepEqual(
      r.sources.map((s) => s.url),
      [`https://gopluslabs.io/token-security/56/${POT}`, `https://bscscan.com/token/${POT}`],
    );
    for (const s of r.sources) assert.equal(primaryUrl(s.url), s.url);
    assert.doesNotMatch(JSON.stringify(d), /\bverdict|\bsafe\b|\blegit/i, "never a verdict");
  });

  it("GoPlus with no DEX pool simulates no trade: its taxes unknown, not 0; closed source says what cannot be read", () => {
    const d = goplusFacts({ ...POT_RECORD, is_in_dex: "0", dex: [], buy_tax: "0", sell_tax: "0", transfer_tax: "", is_open_source: "0" }, "base", POT);
    assert.deepEqual([d.buy_tax_pct, d.sell_tax_pct, d.transfer_tax_pct, d.dex_pools, d.dex_liquidity_usd], [null, null, null, 0, undefined]);
    assert.match(String(d.note), /no taxes were simulated/);
    assert.match(String(d.note), /closed source/);
    assert.deepEqual(queenReads(d).tax, [null, null, null], "the queen reads no tax either way");
    const renounced = goplusFacts({ ...POT_RECORD, owner_address: "0x0000000000000000000000000000000000000000", owner_percent: "0.0" }, "base", POT);
    assert.deepEqual([renounced.owner, renounced.owner_holds_pct], ["none", undefined]);
  });

  it("an unknown token: not_found from RugCheck's 400 and GoPlus's empty result; GoPlus's limit is rate_limited", async () => {
    const random = solKey("no such mint");
    const { t } = world({
      "https://api.rugcheck.xyz/v1/tokens/": () => json({ error: "not found" }, 400),
      "https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=0x1234": { code: 1, message: "OK", result: {} },
      "https://api.gopluslabs.io/api/v1/token_security/8453": { code: 4029, message: "Request limit reached", result: null },
    });
    const sol = await t.run("token_risk_flags", { address: random, chain: "solana" }, { answerId: "u1" });
    assert.equal(!sol.ok && sol.error, "not_found");
    const evm = await t.run("token_risk_flags", { address: "0x1234567890abcdef1234567890abcdef12345678" }, { answerId: "u2" });
    assert.equal(!evm.ok && evm.error, "not_found", "a 0x address with no chain is read on ethereum");
    const busy = await t.run("token_risk_flags", { address: "0x1234567890abcdef1234567890abcdef12345678", chain: "base" }, { answerId: "u3" });
    assert.equal(!busy.ok && busy.error, "rate_limited");
  });

  it("the chain: names as callers give them; a chain it does not read, or a 0x address on solana, is bad_args with nothing sent", async () => {
    assert.deepEqual(["eth", "Ethereum", "BSC", "bnb-chain", "polygon_pos", "avax", "Arbitrum One", "op", undefined].map((c) => chainOf(c, POT)), ["ethereum", "ethereum", "bsc", "bsc", "polygon", "avalanche", "arbitrum", "optimism", "ethereum"]);
    assert.equal(chainOf("ethereum", AUTH_MINT), "solana", "a base58 address is a Solana mint whatever chain is named");
    assert.equal(chainOf("tron", AUTH_MINT), null);
    const { t, urls } = world({});
    const tron = await t.run("token_risk_flags", { address: POT, chain: "tron" }, { answerId: "b1" });
    assert.ok(!tron.ok && tron.error === "bad_args" && /chain must be one of: solana, ethereum, bsc, base/.test(tron.message), JSON.stringify(tron));
    const mixed = await t.run("token_risk_flags", { address: POT, chain: "solana" }, { answerId: "b2" });
    assert.ok(!mixed.ok && mixed.error === "bad_args" && /0x address is an EVM contract/.test(mixed.message), JSON.stringify(mixed));
    assert.equal((await t.run("token_risk_flags", { token_address: AUTH_MINT }, { answerId: "b3" })).ok, false, "address is required");
    assert.deepEqual(urls, []);
  });

  it("RugCheck's limiter: 20 reads a minute, every caller together; the next is rate_limited and never sent", async () => {
    const { t, urls } = world({ "https://api.rugcheck.xyz/v1/tokens/": (url: string) => ({ ...AUTH_REPORT, mint: url.split("/")[5] }) });
    for (let i = 0; i < 20; i++) assert.equal((await t.run("token_risk_flags", { address: solKey(`mint ${i}`) }, { answerId: `l${i}` })).ok, true, `read ${i}`);
    const over = await t.run("token_risk_flags", { address: solKey("mint 20") }, { answerId: "l20" });
    assert.equal(!over.ok && over.error, "rate_limited");
    assert.equal(urls.length, 20);
  });
});
