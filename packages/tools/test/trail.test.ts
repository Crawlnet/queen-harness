// sol_money_trail: where a wallet's money went and came from, read from its transactions: SOL sent to a wallet, a swap
// through a pool (USDC out, a token in), SOL received; wrapped SOL is SOL; fees and rent are no transfer. A transfer
// into a token account it already has is read through that account, an emptied one included, those of the tokens it
// traded first; the read keeps room in the shared RPC limiter for the other reads and for what its counterparties are,
// and a cut one says so. A token is named by its ticker (its mint cut short when none is read, a known ticker on
// another mint never, the best-known tokens by their mint alone), and a counterparty that made a token it moved is
// tagged; a known exchange's hot wallet is named without a profile call. Who made a token is looked for in its history
// only when its metadata names no creator, and only in the room left: that room is never kept from the trail's own
// reads.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolsWith } from "../src/registry.ts";
import { associatedAccount, metadataAddress, programAddress, readMetadata, trailDeltas } from "../src/free/solana.ts";
import { makeCtx, metadataBytes, solKey, tableFetch } from "./helpers.ts";

const ME = solKey("trail-me");
const FRIEND = solKey("trail-friend");
const POOL = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SENDER = solKey("trail-sender");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = solKey("trail-meme");
const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const sig = (n: number) => `${n}`.repeat(88).slice(0, 88);
const T0 = 1_790_000_000;
/** A mint as the trail names a token it read no ticker for: cut short */
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

const tb = (accountIndex: number, mint: string, owner: string, ui: number) => ({ accountIndex, mint, owner, uiTokenAmount: { uiAmountString: String(ui) } });
const TXS: Record<string, unknown> = {
  // 1: 12 SOL to a friend, twice (two transactions)
  [sig(1)]: { blockTime: T0, meta: { err: null, fee: 5000, preBalances: [20e9, 1e9], postBalances: [8e9 - 5000, 13e9] }, transaction: { message: { accountKeys: [ME, FRIEND] } } },
  [sig(2)]: { blockTime: T0 + 60, meta: { err: null, fee: 5000, preBalances: [8e9, 13e9], postBalances: [5e9 - 5000, 16e9] }, transaction: { message: { accountKeys: [ME, FRIEND] } } },
  // 3: a swap: 500 USDC to the pool, 1,000,000 MEME back (token accounts 2-5); rent of a new account is no transfer
  [sig(3)]: {
    blockTime: T0 + 120,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [5e9, 0, 0, 0, 0, 0],
      postBalances: [5e9 - 5000 - 2039280, 2039280, 0, 0, 0, 0],
      preTokenBalances: [tb(2, USDC, ME, 800), tb(3, USDC, POOL, 10_000), tb(5, MEME, POOL, 50_000_000)],
      postTokenBalances: [tb(2, USDC, ME, 300), tb(3, USDC, POOL, 10_500), tb(4, MEME, ME, 1_000_000), tb(5, MEME, POOL, 49_000_000)],
    },
    transaction: { message: { accountKeys: [ME, "4ata111111111111111111111111111111111111111", "u1", "u2", "m1", "m2"] } },
  },
  // 4: 3.5 SOL in, as wrapped SOL from a sender's token account to mine
  [sig(4)]: {
    blockTime: T0 + 180,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1e9, 4e9, 2e9],
      postBalances: [1e9 - 5000, 4e9 - 3.5e9, 2e9 + 3.5e9],
      preTokenBalances: [tb(1, WSOL, SENDER, 4), tb(2, WSOL, ME, 2)],
      postTokenBalances: [tb(1, WSOL, SENDER, 0.5), tb(2, WSOL, ME, 5.5)],
    },
    transaction: { message: { accountKeys: [SENDER, "wsolA1111111111111111111111111111111111111", "wsolB1111111111111111111111111111111111111"] } },
  },
};

const INSIDER = solKey("insider");
// a deployer's 50M into my existing account (index 2): my own key is not in it
const GIFT = {
  blockTime: T0 + 240,
  meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0], postBalances: [1e9 - 5000, 0, 0], preTokenBalances: [tb(1, MEME, INSIDER, 80_000_000), tb(2, MEME, ME, 1_000_000)], postTokenBalances: [tb(1, MEME, INSIDER, 30_000_000), tb(2, MEME, ME, 51_000_000)] },
  transaction: { message: { accountKeys: [INSIDER, "insiderTa", "meMeme"] } },
};

interface Chain {
  /** an address (a wallet, or a token account) → its signatures, newest first */
  sigs: Record<string, { signature: string; err: unknown; slot?: number }[]>;
  txs: Record<string, unknown>;
  /** a wallet → its token accounts of the token program, [account, balance, mint] */
  accounts?: Record<string, [string, number, string?][]>;
  /** signatures, or token accounts' transaction lists, whose read the RPC fails */
  failing?: Set<string>;
  /** accounts as getMultipleAccounts returns them (a mint, a metadata account); any other is a System account */
  infos?: Record<string, unknown>;
}

/** The fake chain over the shared RPC and the launch keys' host alike (the history call only there) */
function fakeRpc(c: Chain) {
  const counts: Record<string, number> = {};
  /** the addresses whose signatures were listed, and the accounts each getMultipleAccounts asked for */
  const listed: string[] = [];
  const multiple: string[][] = [];
  const answer = (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    counts[body.method] = (counts[body.method] ?? 0) + 1;
    const r = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });
    const p0 = String(body.params[0]);
    switch (body.method) {
      case "getSignaturesForAddress":
        listed.push(p0);
        if (c.failing?.has(p0)) return new Response("down", { status: 503 });
        return r((c.sigs[p0] ?? []).slice(0, (body.params[1] as { limit: number }).limit));
      case "getTransaction":
        return c.failing?.has(p0) ? new Response("down", { status: 500 }) : r(c.txs[p0] ?? null);
      case "getTokenAccountsByOwner": {
        const program = (body.params[1] as { programId: string }).programId;
        const list = program === TOKEN ? (c.accounts?.[p0] ?? []) : [];
        return r({ value: list.map(([pubkey, ui, mint]) => ({ pubkey, account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString: String(ui) } } } } } })) });
      }
      case "getMultipleAccounts":
        multiple.push(body.params[0] as string[]);
        return r({ value: (body.params[0] as string[]).map((o) => c.infos?.[o] ?? (o === POOL ? null : { owner: SYSTEM })) });
      case "getTokenLargestAccounts":
        return r({ value: [{ address: "ta01", uiAmountString: "100" }] });
      case "getTokenSupply":
        return r({ value: { uiAmountString: "1000", decimals: 6 } });
      case "getAccountInfo":
        return r({ value: { lamports: 1e9, owner: SYSTEM, executable: false, space: 0, data: ["", "base64"] } });
      case "getTransactionsForAddress": {
        // an address's newest successful transactions, each with its signature, as Helius pages them
        const limit = (body.params[1] as { limit: number }).limit;
        const ok = (c.sigs[p0] ?? []).filter((x) => x.err === null && c.txs[x.signature]).slice(0, limit);
        const data = ok.map((x) => {
          const tx = c.txs[x.signature] as { transaction: Record<string, unknown> };
          return { ...tx, transaction: { ...tx.transaction, signatures: [x.signature] } };
        });
        return r({ data, paginationToken: null });
      }
      default:
        return r(null);
    }
  };
  const t = tableFetch({ "https://rpc.example.org/": answer, "https://mainnet.helius-rpc.com/": answer });
  return { fetch: t.fetch, counts, listed, multiple };
}

const toolsWith = (fetch: (url: string, init?: RequestInit) => Promise<Response>, o: { now?: () => number; urls?: string } = {}) =>
  createToolsWith(makeCtx({ SOLANA_RPC_URLS: o.urls ?? "https://rpc.example.org/", TOOLS_MAX_CALLS_PER_ANSWER: "5" }), { background: false, fetch, ...(o.now ? { now: o.now } : {}) });

const BASIC: Chain = {
  sigs: { [ME]: [1, 2, 3, 4].map((n) => ({ signature: sig(n), err: null })).concat([{ signature: sig(5), err: { InstructionError: [0, "x"] } } as never]) },
  txs: TXS,
};

type Trail = { label?: string; tags?: string[]; transactions_read: number; outgoing: Record<string, unknown>[]; incoming: Record<string, unknown>[]; token_accounts_read: number; token_accounts?: number; complete: boolean; why?: string };

describe("sol_money_trail", () => {
  it("per counterparty and asset: what went out and came in, how often and when; a pool's authority is a pool", async () => {
    const f = fakeRpc(BASIC);
    const r = await toolsWith(f.fetch).run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    assert.equal(d.transactions_read, 4, "the failed one is not read");
    const out = (to: string, asset: string) => d.outgoing.find((x) => x.to === to && x.asset === asset);
    const inc = (from: string, asset: string) => d.incoming.find((x) => x.from === from && x.asset === asset);
    assert.deepEqual([out(FRIEND, "SOL")?.amount, out(FRIEND, "SOL")?.transfers, out(FRIEND, "SOL")?.counterparty], [15, 2, "wallet"]);
    assert.equal(out(FRIEND, "SOL")?.first, new Date(T0 * 1000).toISOString());
    assert.deepEqual([out(POOL, "USDC")?.amount, out(POOL, "USDC")?.counterparty], [500, "pool"]);
    assert.deepEqual([inc(POOL, short(MEME))?.amount, inc(POOL, short(MEME))?.mint], [1_000_000, MEME], "a token with no ticker read: its mint cut short, in full beside it");
    assert.equal(inc(SENDER, "SOL")?.amount, 3.5, "wrapped SOL is SOL, by its owner");
    assert.ok(!d.outgoing.some((x) => String(x.to).startsWith("4ata")), "rent is no transfer");
    assert.deepEqual([d.complete, d.why], [true, undefined]);
    assert.ok(r.sources.some((x) => x.url.includes(ME)));
  });

  it("tokens sent to a token account the wallet already has are read through that account, an emptied one too", async () => {
    // a deployer's 50M into my existing account: my own key is not in it, so it is not in my own list
    const f = fakeRpc({
      sigs: { [ME]: BASIC.sigs[ME]!, meMeme: [{ signature: sig(6), err: null }, { signature: sig(3), err: null }] },
      txs: { ...TXS, [sig(6)]: GIFT },
      // an emptied account is still open, and read (an insider who sold it all keeps his)
      accounts: { [ME]: [["meUsdc", 300, USDC], ["meMeme", 51_000_000, MEME], ["meEmpty", 0, solKey("old-mint")]] },
    });
    const r = await toolsWith(f.fetch).run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    const inc = d.incoming.find((x) => x.from === INSIDER);
    assert.deepEqual([inc?.mint, inc?.amount, inc?.counterparty], [MEME, 50_000_000, "wallet"]);
    assert.equal(d.transactions_read, 5, "the swap is in both lists, read once");
    assert.deepEqual([d.token_accounts_read, d.token_accounts], [3, undefined]);
    // its own list, its 3 token accounts', and the token it got (its first signatures: who made it)
    assert.equal(f.counts.getSignaturesForAddress, 1 + 3 + 1);
    assert.equal(f.counts.getTransaction, 5, "each transaction once");
    assert.deepEqual([d.complete, d.why], [true, undefined]);
  });

  it("an insider who got tokens into his account and sold them all: both sides are in his trail", async () => {
    // he sells the 50M to the pool, signing: his account is left open and empty
    const sell = {
      blockTime: T0 + 300,
      meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0], postBalances: [1e9 - 5000, 0, 0], preTokenBalances: [tb(1, MEME, ME, 50_000_000), tb(2, MEME, POOL, 1_000_000)], postTokenBalances: [tb(1, MEME, ME, 0), tb(2, MEME, POOL, 51_000_000)] },
      transaction: { message: { accountKeys: [ME, "meMeme", "m2"] } },
    };
    const gift = { ...GIFT, meta: { ...GIFT.meta, preTokenBalances: [tb(1, MEME, INSIDER, 80_000_000), tb(2, MEME, ME, 0)], postTokenBalances: [tb(1, MEME, INSIDER, 30_000_000), tb(2, MEME, ME, 50_000_000)] } };
    const f = fakeRpc({ sigs: { [ME]: [{ signature: sig(7), err: null }], meMeme: [sig(7), sig(6)].map((s) => ({ signature: s, err: null })) }, txs: { [sig(7)]: sell, [sig(6)]: gift }, accounts: { [ME]: [["meMeme", 0, MEME]] } });
    const r = await toolsWith(f.fetch).run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    assert.deepEqual(d.incoming.map((x) => [x.from, x.amount]), [[INSIDER, 50_000_000]]);
    assert.deepEqual(d.outgoing.map((x) => [x.to, x.amount, x.counterparty]), [[POOL, 50_000_000, "pool"]]);
    assert.deepEqual([d.token_accounts_read, d.complete], [1, true]);
  });

  it("with a mint, the wallet's own account of that coin is read whatever its age, closed too: a sale past its newest transactions is in the trail", async () => {
    const ata = associatedAccount(ME, MEME, TOKEN)!;
    // the dev sold 130M of the coin to the pool long ago, then closed the account; its newest transactions are SOL sends
    const sale = {
      blockTime: T0 - 40_000,
      meta: { err: null, fee: 5000, preBalances: [1e9, 2039280, 0], postBalances: [1e9 + 2039280 - 5000, 0, 0], preTokenBalances: [tb(1, MEME, ME, 130_000_000), tb(2, MEME, POOL, 1_000_000)], postTokenBalances: [tb(1, MEME, ME, 0), tb(2, MEME, POOL, 131_000_000)] },
      transaction: { message: { accountKeys: [ME, ata, "poolMeme"] } },
    };
    const f = fakeRpc({ sigs: { [ME]: [1, 2].map((n) => ({ signature: sig(n), err: null })), [ata]: [{ signature: sig(9), err: null }] }, txs: { ...TXS, [sig(9)]: sale } });
    const without = await toolsWith(f.fetch).run("sol_money_trail", { address: ME, limit: 2 }, { answerId: "t" });
    assert.ok(without.ok, JSON.stringify(without));
    assert.ok(!(without.data as Trail).outgoing.some((x) => x.mint === MEME), "past its newest two: unread");
    const r = await toolsWith(f.fetch).run("sol_money_trail", { address: ME, limit: 2, mint: MEME }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail & { coin?: { mint: string; accounts_read: number } };
    assert.deepEqual(d.outgoing.filter((x) => x.mint === MEME).map((x) => [x.to, x.amount, x.counterparty]), [[POOL, 130_000_000, "pool"]]);
    assert.ok(d.outgoing.some((x) => x.to === FRIEND), "its newest transactions still read");
    assert.deepEqual(d.coin, { mint: MEME, accounts_read: 2 }, "the coin's account under both token programs");
    assert.ok(f.listed.includes(ata));
  });

  it("past 8 token accounts, those of the tokens it traded are read first; the rest unread say so, kept ten minutes", async () => {
    let clock = 1_800_000_000_000;
    // it sold 1M of the token it was given (signing); spam tokens with far more units sit in 8 other accounts
    const sold = {
      blockTime: T0 + 300,
      meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0], postBalances: [1e9 - 5000, 0, 0], preTokenBalances: [tb(1, MEME, ME, 51_000_000), tb(2, MEME, POOL, 1_000_000)], postTokenBalances: [tb(1, MEME, ME, 50_000_000), tb(2, MEME, POOL, 2_000_000)] },
      transaction: { message: { accountKeys: [ME, "meMeme", "m2"] } },
    };
    const spam = Array.from({ length: 8 }, (_, i) => [`spam${i}`, 1e12, solKey(`spam-${i}`)] as [string, number, string]);
    const f = fakeRpc({ sigs: { [ME]: [{ signature: sig(7), err: null }], meMeme: [sig(7), sig(6)].map((s) => ({ signature: s, err: null })) }, txs: { [sig(7)]: sold, [sig(6)]: GIFT }, accounts: { [ME]: [...spam, ["meMeme", 50_000_000, MEME]] } });
    const tools = toolsWith(f.fetch, { now: () => clock });
    const r = await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    assert.equal(d.incoming.find((x) => x.from === INSIDER)?.amount, 50_000_000);
    assert.deepEqual([d.token_accounts_read, d.token_accounts, d.complete], [8, 9, false]);
    assert.equal(d.why, "8 of its 9 token accounts read: transfers into the others may be missing");
    clock += 61_000;
    await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "b" });
    assert.equal(f.counts.getTokenAccountsByOwner, 2, "from the cache: read again it would leave the same ones");
  });

  it("a token account whose transactions could not be listed is not counted read: incomplete, kept a minute", async () => {
    let clock = 1_800_000_000_000;
    const f = fakeRpc({ sigs: { [ME]: BASIC.sigs[ME]! }, txs: TXS, accounts: { [ME]: [["meMeme", 51_000_000, MEME]] }, failing: new Set(["meMeme"]) });
    const tools = toolsWith(f.fetch, { now: () => clock });
    const r = await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    assert.deepEqual([d.token_accounts_read, d.token_accounts, d.complete], [0, 1, false]);
    assert.match(d.why ?? "", /could not be listed/);
    clock += 61_000;
    await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "b" });
    assert.equal(f.counts.getTokenAccountsByOwner, 4, "read again");
  });

  it("three trails at once leave the scan's reads their room; a cut trail says so", async () => {
    const chain: Chain = { sigs: {}, txs: {} };
    const wallets = [1, 2, 3, 4].map((n) => solKey(`trail-${n}`));
    for (const w of wallets) {
      chain.sigs[w] = Array.from({ length: 80 }, (_, k) => ({ signature: `${w}-${k}`, err: null }));
      for (let k = 0; k < 80; k++) chain.txs[`${w}-${k}`] = { blockTime: T0 + k, meta: { err: null, fee: 5000, preBalances: [5e9, 0], postBalances: [4e9 - 5000, 1e9] }, transaction: { message: { accountKeys: [w, FRIEND] } } };
    }
    const f = fakeRpc(chain);
    const tools = toolsWith(f.fetch);
    const runs = await Promise.all(wallets.slice(0, 3).map((w, i) => tools.run("sol_money_trail", { address: w, limit: 80 }, { answerId: `t${i}` })));
    const cut = runs.flatMap((r) => (r.ok && !(r.data as Trail).complete ? [r.data as Trail] : []));
    assert.ok(cut.length >= 1, "the limiter could not take all three whole");
    for (const d of cut) assert.match(d.why ?? "", /data calls/);
    // what the counterparties are is still read: the room for it was kept
    for (const r of runs) assert.ok(r.ok && (r.data as Trail).outgoing[0]?.counterparty === "wallet", JSON.stringify(r).slice(0, 300));
    assert.equal(f.counts.getMultipleAccounts, 3);
    // what a scan reads right after: the largest accounts (4 calls) and an account
    const largest = await tools.run("sol_largest_accounts", { mint: MEME }, { answerId: "scan" });
    const basics = await tools.run("sol_account_basics", { address: ME }, { answerId: "scan" });
    assert.ok(largest.ok && basics.ok, JSON.stringify([largest, basics]));
    // no room left for a whole fourth: refused, never an empty trail
    const fourth = await tools.run("sol_money_trail", { address: wallets[3]!, limit: 80 }, { answerId: "t4" });
    assert.ok(!fourth.ok ? fourth.error === "rate_limited" : !(fourth.data as Trail).complete, JSON.stringify(fourth).slice(0, 200));
  });

  it("with room for its own reads and what they found, a trail runs: none is kept for who made its tokens", async () => {
    const f = fakeRpc(BASIC);
    const tools = toolsWith(f.fetch);
    // other reads leave 55 of the 240 a minute: 40 kept for the scan, room for a call in flight and the 2 last ones (3 each)
    for (let i = 0; i < 185; i++) assert.ok((await tools.run("sol_account_basics", { address: solKey(`other-${i}`) }, { answerId: `o${i}` })).ok);
    const r = await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    const d = r.data as Trail;
    assert.deepEqual([d.complete, /data calls/.test(d.why ?? "")], [false, true], "cut, and said so");
    assert.equal(d.outgoing.find((x) => x.to === FRIEND)?.counterparty, "wallet", "what the counterparties are was read in the room kept");
  });

  it("an endpoint failing over takes a token per try: the room kept counts them", async () => {
    const chain: Chain = { sigs: { [ME]: Array.from({ length: 80 }, (_, k) => ({ signature: `me-${k}`, err: null })) }, txs: {} };
    for (let k = 0; k < 80; k++) chain.txs[`me-${k}`] = TXS[sig(1)];
    const f = fakeRpc(chain);
    // two endpoints down (tried first), the third answers
    const fetch = (url: string, init?: RequestInit) => (url.startsWith("https://rpc.example.org/") ? f.fetch(url, init) : Promise.resolve(new Response("down", { status: 503 })));
    const tools = toolsWith(fetch, { urls: "https://down1.example.org/@2,https://down2.example.org/@2,https://rpc.example.org/@1" });
    const r = await tools.run("sol_money_trail", { address: ME, limit: 80 }, { answerId: "t" });
    assert.ok(r.ok && !(r.data as Trail).complete, JSON.stringify(r).slice(0, 300));
    const other = await tools.run("sol_account_basics", { address: ME }, { answerId: "t2" });
    assert.ok(other.ok, JSON.stringify(other));
  });

  it("transactions that could not be read make it incomplete, kept a minute instead of ten", async () => {
    let clock = 1_800_000_000_000;
    const f = fakeRpc({ ...BASIC, failing: new Set([sig(2)]) });
    const tools = toolsWith(f.fetch, { now: () => clock });
    const r = await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "a" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    assert.deepEqual([d.transactions_read, d.complete, d.why], [3, false, "1 of 4 transactions could not be read"]);
    clock += 61_000;
    await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "b" });
    assert.equal(f.listed.filter((a) => a === ME).length, 2, "read again after a minute");

    const whole = fakeRpc(BASIC);
    const t2 = toolsWith(whole.fetch, { now: () => clock });
    await t2.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "c" });
    clock += 61_000;
    await t2.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "d" });
    assert.equal(whole.listed.filter((a) => a === ME).length, 1, "a whole one from the cache");
  });

  it("tokens by their ticker, mint beside; who made a token tagged; an exchange named", async () => {
    const CITY = solKey("city-mint");
    const CREATOR = solKey("city-creator");
    const GEM = solKey("gem-mint");
    const DEV = solKey("gem-dev");
    const FAKE = solKey("fake-usdc-mint");
    const SPAMMER = solKey("spammer");
    const FAKE_JUP = solKey("fake-jup-mint");
    const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
    const send = (t: number, mint: string, from: string, ui: number, keys: string[]) => ({
      blockTime: t,
      meta: { err: null, fee: 5000, preBalances: keys.map(() => 1e9), postBalances: keys.map((_, i) => (i === 0 ? 1e9 - 5000 : 1e9)), preTokenBalances: [tb(1, mint, from, ui * 2), tb(2, mint, ME, 0)], postTokenBalances: [tb(1, mint, from, ui), tb(2, mint, ME, ui)] },
      transaction: { message: { accountKeys: keys } },
    });
    const many = (n: number, p: string) => Array.from({ length: n }, (_, k) => ({ signature: `${p}${k}`, err: null }));
    const f = fakeRpc({
      // the city token's history is longer than a page: its creator is the one its metadata names
      sigs: { [ME]: ["gift", "cex", "drop", "gem", "jup", "fake-jup"].map((s) => ({ signature: s, err: null })), [CITY]: many(1000, "city"), [GEM]: [{ signature: "gem-create", err: null }], [FAKE]: many(3, "fake") },
      txs: {
        // the creator sends the holder 700M of its token; an exchange 5 SOL; a spammer 10 of a fake USDC; a dev 50 of his
        gift: send(T0, CITY, CREATOR, 700_000_000, [CREATOR, "creatorTa", "meCity"]),
        cex: { blockTime: T0 + 60, meta: { err: null, fee: 5000, preBalances: [1000e9, 1e9], postBalances: [995e9 - 5000, 6e9] }, transaction: { message: { accountKeys: [BINANCE, ME] } } },
        drop: send(T0 + 120, FAKE, SPAMMER, 10, [SPAMMER, "spamTa", "meFake"]),
        gem: send(T0 + 180, GEM, DEV, 50, [DEV, "devTa", "meGem"]),
        // a friend sends 5 JUP; the spammer 4 of a token whose metadata calls it JUP
        jup: send(T0 + 240, JUP, FRIEND, 5, [FRIEND, "friendJup", "meJup"]),
        "fake-jup": send(T0 + 300, FAKE_JUP, SPAMMER, 4, [SPAMMER, "spamJupTa", "meFakeJup"]),
        // GEM's first transaction: its dev pays, and mints the first tokens to himself and to this wallet
        "gem-create": { blockTime: T0 - 600, meta: { err: null, fee: 5000, preBalances: [5e9, 0, 0, 0], postBalances: [4e9, 1e9, 0, 0], preTokenBalances: [], postTokenBalances: [tb(2, GEM, DEV, 900), tb(3, GEM, ME, 100)] }, transaction: { message: { accountKeys: [DEV, GEM, "devTa", "meGem"] } } },
      },
      infos: {
        [CITY]: { owner: TOKEN, data: { parsed: { type: "mint", info: { decimals: 9, mintAuthority: null } } } },
        // its metadata: a cashtag symbol, the creator verified, a spammer's name added unverified
        [metadataAddress(CITY)!]: { owner: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", data: [metadataBytes(CREATOR, CITY, "Example City", "$EXCITY", [[CREATOR, true], [SPAMMER, false]]).toString("base64"), "base64"] },
        [GEM]: { owner: TOKEN, data: { parsed: { type: "mint", info: { decimals: 6, mintAuthority: null } } } },
        // a Token-2022 mint whose own metadata calls it USDC
        [FAKE]: { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: { parsed: { type: "mint", info: { decimals: 6, mintAuthority: SPAMMER, extensions: [{ extension: "tokenMetadata", state: { symbol: "USDC", updateAuthority: SPAMMER } }] } } } },
        [FAKE_JUP]: { owner: TOKEN, data: { parsed: { type: "mint", info: { decimals: 6, mintAuthority: null } } } },
        [metadataAddress(FAKE_JUP)!]: { owner: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", data: [metadataBytes(SPAMMER, FAKE_JUP, "Jupiter", "$jup").toString("base64"), "base64"] },
      },
    });
    const r = await toolsWith(f.fetch).run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "t" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    const from = (who: string) => d.incoming.find((x) => x.from === who)!;
    assert.deepEqual([from(CREATOR).asset, from(CREATOR).mint, from(CREATOR).amount], ["EXCITY", CITY, 700_000_000]);
    assert.deepEqual(from(CREATOR).tags, ["creator of EXCITY", "update authority of EXCITY"], "the sender made the token");
    assert.deepEqual([from(DEV).asset, from(DEV).tags], [short(GEM), [`creator of ${short(GEM)}`]], "no metadata: by its mint; the payer of its first transaction made it");
    assert.deepEqual(d.tags, [`got the first mint of ${short(GEM)}`], "so is the wallet itself tagged");
    assert.deepEqual([from(BINANCE).asset, from(BINANCE).counterparty, from(BINANCE).label, "mint" in from(BINANCE)], ["SOL", "exchange", "Binance hot wallet", false]);
    assert.deepEqual([from(SPAMMER).asset, from(SPAMMER).mint], [short(FAKE), FAKE], "a known ticker on another mint is no name");
    assert.deepEqual(from(SPAMMER).tags, [`mint authority of ${short(FAKE)}`, `update authority of ${short(FAKE)}`, `update authority of ${short(FAKE_JUP)}`], "an unverified creator is none");
    // the real JUP by its mint alone; a copy of its ticker is no name
    assert.deepEqual([from(FRIEND).asset, from(FRIEND).mint, from(FRIEND).tags], ["JUP", JUP, undefined]);
    assert.deepEqual(d.incoming.filter((x) => x.mint === FAKE_JUP).map((x) => x.asset), [short(FAKE_JUP)]);
    // what the tokens are in one call beside what the counterparties are (JUP needs no read); then the first transactions
    // of the two most moved whose metadata names no creator: the city token's history is never read
    assert.equal(f.counts.getMultipleAccounts, 2);
    assert.equal(f.multiple.flat().includes(JUP), false);
    assert.deepEqual(f.listed, [ME, GEM, FAKE]);
    assert.equal(f.counts.getTransaction, 6 + 2, "its own 6, GEM's first, FAKE's first (none)");
    assert.equal(d.complete, true);
  });

  it("a vault's own transactions name its Squads multisig; another multisig's payment into an address names none", async () => {
    // a made-up Squads v4 multisig and its first vault (computed with @solana/web3.js, as in holder-links.test.ts)
    const SQ_MULTISIG = "J51FQbD4oxypy4u7ozva4L4BWctNFk9Yfcioipd2mJdb";
    const SQ_VAULT = "CZRFxt8YAVsUGZi7ZwXrNZMEBLCeGxMHwZSe9sfYN6iR";
    const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
    const OTHER = programAddress([Buffer.from("other-vault")], SQUADS)!;
    // the multisig made, 0.001 SOL to its first vault; then the creator's 700M into the vault's account
    const create = { blockTime: T0, meta: { err: null, fee: 5000, preBalances: [10e9, 0, 0, 1, 1], postBalances: [10e9 - 3_503_640, 2_498_640, 1_000_000, 1, 1] }, transaction: { message: { accountKeys: [FRIEND, SQ_MULTISIG, SQ_VAULT, SQUADS, SYSTEM] } } };
    const gift = { blockTime: T0 + 60, meta: { err: null, fee: 5000, preBalances: [1e9, 0, 0], postBalances: [1e9 - 5000, 0, 0], preTokenBalances: [tb(1, MEME, SENDER, 1_400_000_000), tb(2, MEME, SQ_VAULT, 0)], postTokenBalances: [tb(1, MEME, SENDER, 700_000_000), tb(2, MEME, SQ_VAULT, 700_000_000)] }, transaction: { message: { accountKeys: [SENDER, "senderTa", "vaultTa"] } } };
    const vault = await toolsWith(fakeRpc({ sigs: { [SQ_VAULT]: [{ signature: "gift", err: null }, { signature: "create", err: null }] }, txs: { create, gift } }).fetch).run("sol_money_trail", { address: SQ_VAULT }, { answerId: "v" });
    assert.ok(vault.ok, JSON.stringify(vault));
    assert.equal((vault.data as Trail).label, "Squads multisig vault");
    // the same multisig's vault pays another address off the curve: that one is no vault of it
    const paid = { ...create, transaction: { message: { accountKeys: [FRIEND, SQ_MULTISIG, SQ_VAULT, SQUADS, OTHER] } } };
    const other = await toolsWith(fakeRpc({ sigs: { [OTHER]: [{ signature: "paid", err: null }] }, txs: { paid } }).fetch).run("sol_money_trail", { address: OTHER }, { answerId: "o" });
    assert.ok(other.ok, JSON.stringify(other));
    assert.equal((other.data as Trail).label, undefined);
  });

  it("an LP's rent into its own position and a bin array is SOL to that program's accounts; a swap into the pool's reserve is to the pool", async () => {
    const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    const LB_PAIR = programAddress([Buffer.from("lb-pair")], DLMM)!;
    const BIN_ARRAY = programAddress([Buffer.from("bin-array")], DLMM)!;
    const POSITION = solKey("lp-position");
    // a position made with a key (8120 bytes: 0.0574 SOL) and a bin array (10136 bytes: 0.0714 SOL), both DLMM's
    const open = { blockTime: T0, meta: { err: null, fee: 5000, preBalances: [5e9, 0, 0], postBalances: [5e9 - 5000 - 57_400_000 - 71_400_000, 57_400_000, 71_400_000] }, transaction: { message: { accountKeys: [ME, POSITION, BIN_ARRAY] } } };
    // 2 SOL, wrapped, into the reserve the pair owns; 1M MEME back
    const swap = {
      blockTime: T0 + 60,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [5e9, 2e9, 0, 0, 0],
        postBalances: [3e9 - 5000, 0, 0, 0, 0],
        preTokenBalances: [tb(1, WSOL, ME, 2), tb(2, WSOL, LB_PAIR, 100), tb(3, MEME, LB_PAIR, 50_000_000), tb(4, MEME, ME, 0)],
        postTokenBalances: [tb(1, WSOL, ME, 0), tb(2, WSOL, LB_PAIR, 102), tb(3, MEME, LB_PAIR, 49_000_000), tb(4, MEME, ME, 1_000_000)],
      },
      transaction: { message: { accountKeys: [ME, "meWsol", "pairWsol", "pairMeme", "meMeme"] } },
    };
    const infos = Object.fromEntries([LB_PAIR, BIN_ARRAY, POSITION].map((a) => [a, { owner: DLMM }]));
    const r = await toolsWith(fakeRpc({ sigs: { [ME]: [{ signature: "swap", err: null }, { signature: "open", err: null }] }, txs: { open, swap }, infos }).fetch).run("sol_money_trail", { address: ME }, { answerId: "lp" });
    assert.ok(r.ok, JSON.stringify(r));
    const d = r.data as Trail;
    const to = (who: string) => d.outgoing.find((x) => x.to === who)!;
    assert.deepEqual([to(POSITION).amount, to(POSITION).counterparty, to(POSITION).label], [0.0574, "program", undefined]);
    assert.deepEqual([to(BIN_ARRAY).amount, to(BIN_ARRAY).counterparty, to(BIN_ARRAY).label], [0.0714, "program", undefined]);
    assert.deepEqual([to(LB_PAIR).asset, to(LB_PAIR).amount, to(LB_PAIR).counterparty, to(LB_PAIR).label], ["SOL", 2, "pool", "Meteora DLMM pool"]);
    const from = d.incoming.find((x) => x.from === LB_PAIR)!;
    assert.deepEqual([from.mint, from.counterparty, from.label], [MEME, "pool", "Meteora DLMM pool"]);
  });

  it("with the launch keys a wallet's first trail is its newest page in one history call; a trail of it to another depth reads its list and only what it lacks", async () => {
    const classic = await toolsWith(fakeRpc(BASIC).fetch).run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "c" });
    assert.ok(classic.ok, JSON.stringify(classic));
    const f = fakeRpc(BASIC);
    const tools = createToolsWith(makeCtx({ SOLANA_RPC_URLS: "https://rpc.example.org/", HELIUS_LAUNCH_KEYS: "key-good-0000000000000000", TOOLS_MAX_CALLS_PER_ANSWER: "5" }), { background: false, fetch: f.fetch });
    const first = await tools.run("sol_money_trail", { address: ME, limit: 10 }, { answerId: "p" });
    assert.ok(first.ok, JSON.stringify(first));
    assert.deepEqual(first.data, classic.data, "the same trail");
    // its own list and transactions in the one page (the token it got: its first signatures, who made it, as before)
    assert.deepEqual([f.counts.getTransactionsForAddress, f.listed.filter((a) => a === ME).length, f.counts.getTransaction ?? 0], [1, 0, 0]);
    // a deeper trail of the same wallet: one read of its transactions
    const deeper = await tools.run("sol_money_trail", { address: ME, limit: 20 }, { answerId: "q" });
    assert.ok(deeper.ok && (deeper.data as Trail).transactions_read === 4, JSON.stringify(deeper));
    assert.deepEqual([f.counts.getTransactionsForAddress, f.listed.filter((a) => a === ME).length, f.counts.getTransaction ?? 0], [1, 1, 0]);
  });

  it("the Token Metadata account: its address derived from the mint, its symbol and update authority read", () => {
    // computed with @solana/web3.js's findProgramAddressSync (bumps 255 and 252)
    assert.equal(metadataAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), "5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq");
    assert.equal(metadataAddress(MEME), "E2uxC8vqpfuxHgmexTo5GzdWMopWBnLbAuSxS8FsKgiG");
    assert.equal(metadataAddress("not-base58"), null);
    assert.deepEqual(readMetadata(metadataBytes(SENDER, MEME, "Meme", "MEME")), { symbol: "MEME", update: SENDER, creators: [] });
    assert.deepEqual(readMetadata(metadataBytes(SENDER, MEME, "Meme", "$MEME", [[FRIEND, false], [ME, true]])), { symbol: "MEME", update: SENDER, creators: [ME] }, "verified creators only; no cashtag");
    assert.equal(readMetadata(metadataBytes(SENDER, MEME, "Meme", ""))?.symbol, null, "no symbol");
    assert.equal(readMetadata(Uint8Array.of(6, ...new Uint8Array(100))), null, "an edition, not a token's metadata");
  });

  it("trailDeltas: SOL by account, tokens by owner, wrapped SOL moved to its owner", () => {
    const d = trailDeltas(TXS[sig(4)] as Record<string, unknown>);
    assert.equal(d.get("SOL")!.get(ME), 3.5);
    assert.equal(d.get("SOL")!.get(SENDER)! < -3.4, true);
  });
});
