// Helius keys (HELIUS_KEYS, a comma list): the live keys in turn; a key that reports "max usage" is set aside, a
// transient error moves on to the next key.
import fs from 'fs';
const envText = (() => { try { return fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return ''; } })();
const get = k => process.env[k] ?? envText.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const KEYS = (get('HELIUS_KEYS') || '').split(',').map(k => k.trim()).filter(Boolean);
const dead = new Set();
let rr = Math.floor(Math.random() * 1e6); // a random first key: a run of spent keys at the head of the list would use up the tries
const pick = () => {
  for (let i = 0; i < KEYS.length; i++) { const k = KEYS[rr++ % KEYS.length]; if (!dead.has(k)) return k; }
  return null;
};
// With no live Helius key, plain RPC (signatures, transactions) goes to the public Solana RPC: migrations are few, a couple
// of calls a minute. DAS (getAssetBatch) is Helius's alone: without a key, pump.mjs takes the metadata from Jupiter.
const PUBLIC_RPC = (get('PUBLIC_RPC_URL') || 'https://api.mainnet-beta.solana.com').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(url, body, das = false) {
  for (let i = 0; i < 25; i++) {
    const k = pick();
    if (k === null && das) throw Error('no live Helius key');
    try {
      const r = await fetch(k === null ? PUBLIC_RPC : url(k), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const t = await r.text(); if (process.env.DBG) console.error(r.status, t.slice(0,80));
      if (k !== null && /max usage reached/i.test(t)) { dead.add(k); continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(k === null ? 2000 : 300); continue; }
      const j = JSON.parse(t);
      if (j.error) { if (process.env.DBG) console.error(j.error);
        if ([-32700, -32600, -32601, -32602, -32015].includes(j.error.code)) throw Object.assign(Error(j.error.message), { fatal: true });
        await sleep(300); continue;
      }
      return j.result;
    } catch (e) { if (process.env.DBG) console.error(e.message); if (e.fatal) throw e; await sleep(300); }
  }
  throw Error('rpc fail ' + body.method);
}
export const rpc = (method, params) => call(k => `https://mainnet.helius-rpc.com/?api-key=${k}`, { jsonrpc: '2.0', id: 1, method, params });
export const getTx = sig => rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]);
export const getAssetBatch = ids => call(k => `https://mainnet.helius-rpc.com/?api-key=${k}`, { jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids } }, true);
export const aliveKeys = () => KEYS.length - dead.size;
