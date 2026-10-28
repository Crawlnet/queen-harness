// pump.fun → PumpSwap migrations. 39azUY… is pump.fun's migration authority and signs ONLY migrate txs,
// so getSignaturesForAddress on it = a ready list of migrations (no scan of all the pump traffic).
import { rpc, getTx, getAssetBatch, aliveKeys } from '../helius.mjs';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MIGRATION_AUTHORITY = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
/** Without Helius: the catch-up window, in seconds */
const PUBLIC_ARM_S = 1800;
const MINT_IDX = 2; // migrate / migrate_v2: [global, withdraw_authority, mint, bonding_curve, ...]

export async function pumpMigrations(sinceSec, seenSigs = new Set()) {
  const sigs = [];
  let before;
  for (;;) {
    const page = await rpc('getSignaturesForAddress', [MIGRATION_AUTHORITY, { limit: 1000, before }]);
    // without Helius (the public RPC limits getTransaction) catch up half an hour at most: a day of backfill would hold the tick for hours
    if (!aliveKeys()) sinceSec = Math.max(sinceSec, Math.floor(Date.now() / 1000) - PUBLIC_ARM_S);
    if (!page.length) break;
    for (const s of page) if (s.blockTime >= sinceSec && !s.err && !seenSigs.has(s.signature)) sigs.push(s);
    if (page.at(-1).blockTime < sinceSec) break;
    before = page.at(-1).signature;
  }
  const out = [];
  // without Helius, the public RPC: 2 at a time (it limits bursts)
  const par = aliveKeys() ? 8 : 2;
  for (let i = 0; i < sigs.length; i += par) {
    const txs = await Promise.all(sigs.slice(i, i + par).map(s => getTx(s.signature).catch(() => null)));
    txs.forEach((tx, j) => {
      const s = sigs[i + j];
      if (tx) seenSigs.add(s.signature); // a handled one is not fetched again (repeated migrate txs of the same mint)
      if (!tx || tx.meta.err || !/Instruction: Migrate/.test(tx.meta.logMessages.join('\n'))) return;
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
      const ixs = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions || []).flatMap(x => x.instructions)];
      const ix = ixs.find(ix => keys[ix.programIdIndex] === PUMP_PROGRAM && ix.accounts.length > 20);
      if (!ix) return;
      out.push({ platform: 'pump', mint: keys[ix.accounts[MINT_IDX]], sig: s.signature, migratedAt: s.blockTime });
    });
  }
  return out;
}

// metadata (name, ticker, description): Helius DAS getAssetBatch, 1 call per ≤1000 mints.
// (pump.fun's frontend API /coins/{mint} answers 404)
export async function assetMeta(mints) {
  const res = {};
  if (!aliveKeys()) return jupiterMeta(mints);
  for (let i = 0; i < mints.length; i += 1000) {
    const assets = await getAssetBatch(mints.slice(i, i + 1000));
    for (const a of assets || []) {
      if (!a) continue;
      const m = a.content?.metadata || {};
      res[a.id] = { name: m.name, symbol: m.symbol, description: m.description || '', image: a.content?.links?.image, uri: a.content?.json_uri };
    }
  }
  return res;
}

// without Helius (no DAS): the name, ticker and picture from Jupiter's token list (no key, up to 100 mints a request); no description
async function jupiterMeta(mints) {
  const res = {};
  for (let i = 0; i < mints.length; i += 100) {
    try {
      const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.slice(i, i + 100).join(',')}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      for (const t of await r.json()) if (t?.id) res[t.id] = { name: t.name, symbol: t.symbol, description: '', image: t.icon, uri: null };
    } catch {}
  }
  return res;
}
