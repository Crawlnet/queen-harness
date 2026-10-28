// Primary-source links, built by us from identifiers (a signature, an address, a post id, a slug).
// A URL handed to us by a data source passes only when its host is one of PRIMARY_HOSTS (and is then
// rebuilt from its parts); web search results are the one exception (the page itself is the source,
// see webPageUrl).

import type { ToolSource } from "@crawlnet/shared";

/** Hosts we link to as sources. */
const PRIMARY_HOSTS = new Set([
  "solscan.io",
  "explorer.solana.com",
  "etherscan.io",
  "basescan.org",
  "arbiscan.io",
  "optimistic.etherscan.io",
  "polygonscan.com",
  "bscscan.com",
  "snowtrace.io",
  "x.com",
  "polymarket.com",
  "defillama.com",
  "dexscreener.com",
  "www.geckoterminal.com",
  "app.hyperliquid.xyz",
  "www.bybit.com",
  "www.binance.com",
  "www.coingecko.com",
  "jup.ag",
  "mempool.space",
  // the security check's sources (free/security.ts): a token's report page on each
  "rugcheck.xyz",
  "gopluslabs.io",
  // a pump.fun coin's page (meme_narrative: built from the mint)
  "pump.fun",
  // an address's or entity's page on arkham's explorer (the data hub's labels: free/hub.ts)
  "intel.arkm.com",
]);

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,150}$/i;

export const solTx = (sig: string): string | null => (SOL_RE.test(sig) ? `https://solscan.io/tx/${sig}` : null);
export const solAccount = (addr: string): string | null => (SOL_RE.test(addr) ? `https://solscan.io/account/${addr}` : null);
export const solToken = (mint: string): string | null => (SOL_RE.test(mint) ? `https://solscan.io/token/${mint}` : null);
/** A Solana token's page on jup.ag */
export const jupToken = (mint: string): string | null => (SOL_RE.test(mint) ? `https://jup.ag/tokens/${mint}` : null);
/** An address's page on arkham's explorer (its labels, through the data hub: free/hub.ts) */
export const arkhamAddress = (addr: string): string | null => (EVM_ADDR_RE.test(addr) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) ? `https://intel.arkm.com/explorer/address/${addr}` : null);
/** A Solana token's report page on RugCheck */
export const rugcheckToken = (mint: string): string | null => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? `https://rugcheck.xyz/tokens/${mint}` : null);

/** Our chain names → explorer host */
const EVM_EXPLORERS: Record<string, string> = {
  ethereum: "etherscan.io",
  eth: "etherscan.io",
  base: "basescan.org",
  arbitrum: "arbiscan.io",
  optimism: "optimistic.etherscan.io",
  polygon: "polygonscan.com",
  bsc: "bscscan.com",
  avalanche: "snowtrace.io",
};

export function evmTx(chain: string | null | undefined, hash: string): string | null {
  const host = EVM_EXPLORERS[(chain ?? "ethereum").toLowerCase()];
  return host && EVM_HASH_RE.test(hash) ? `https://${host}/tx/${hash.toLowerCase()}` : null;
}

export function evmAddress(chain: string | null | undefined, addr: string): string | null {
  const host = EVM_EXPLORERS[(chain ?? "ethereum").toLowerCase()];
  return host && EVM_ADDR_RE.test(addr) ? `https://${host}/address/${addr.toLowerCase()}` : null;
}

export function evmToken(chain: string | null | undefined, addr: string): string | null {
  const host = EVM_EXPLORERS[(chain ?? "ethereum").toLowerCase()];
  return host && EVM_ADDR_RE.test(addr) ? `https://${host}/token/${addr.toLowerCase()}` : null;
}

/** An EVM token's security page on GoPlus, by the chain's numeric id (it forwards to its console) */
export function goplusToken(chainId: string, addr: string): string | null {
  return /^\d{1,9}$/.test(chainId) && EVM_ADDR_RE.test(addr) ? `https://gopluslabs.io/token-security/${chainId}/${addr.toLowerCase()}` : null;
}

/** x.com/<handle>/status/<id>, or x.com/i/status/<id> when the handle is unknown */
export function xPost(handle: string | null | undefined, id: string): string | null {
  if (!/^\d{5,25}$/.test(id)) return null;
  const h = handle?.replace(/^@/, "");
  return h && HANDLE_RE.test(h) ? `https://x.com/${h}/status/${id}` : `https://x.com/i/status/${id}`;
}

/** Pull the handle and post id out of an x.com / twitter.com post URL */
export function parsePostUrl(u: string): { handle: string | null; id: string } | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|mobile\.)/, "");
  if (host !== "x.com" && host !== "twitter.com") return null;
  const m = /^\/(?:i\/web|i|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d{5,25})/.exec(url.pathname);
  if (!m) return null;
  return { handle: m[1] ?? null, id: m[2]! };
}

/** A pump.fun callout's id (a UUID) */
const CALLOUT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A pump.fun callout on its coin's page, which opens on it: /coin/<mint>?highlight_callout=<id> */
export const pumpCallout = (mint: string, id: string): string | null =>
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) && CALLOUT_ID_RE.test(id) ? `https://pump.fun/coin/${mint}?highlight_callout=${id.toLowerCase()}` : null;

/**
 * A pump.fun callout's id from what a caller gave: its link (a coin page's highlight_callout, or the callout's own page
 * /callouts/<mint>/<id>, a reply's or an update's under it too) or the id itself, lower case; null for anything else
 */
export function pumpCalloutId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (CALLOUT_ID_RE.test(s)) return s.toLowerCase();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase().replace(/^www\./, "") !== "pump.fun") return null;
  const id = url.searchParams.get("highlight_callout") ?? /^\/callouts\/[^/]+\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
  return CALLOUT_ID_RE.test(id) ? id.toLowerCase() : null;
}

export const polymarketEvent = (slug: string): string | null => (SLUG_RE.test(slug) ? `https://polymarket.com/event/${slug.toLowerCase()}` : null);

export const llamaProtocol = (slug: string): string | null => (SLUG_RE.test(slug) ? `https://defillama.com/protocol/${slug.toLowerCase()}` : null);
export const llamaChain = (name: string): string | null => (/^[A-Za-z0-9 ._-]{1,40}$/.test(name) ? `https://defillama.com/chain/${encodeURIComponent(name)}` : null);
export const llamaYieldPool = (id: string): string | null => (/^[0-9a-f-]{8,64}$/i.test(id) ? `https://defillama.com/yields/pool/${id}` : null);
/** A token's unlocks page (its slugs may hold a dot: ether.fi, maha.xyz) */
export const llamaUnlocks = (slug: string): string | null => (/^[a-z0-9][a-z0-9.-]{0,150}$/i.test(slug) ? `https://defillama.com/unlocks/${slug.toLowerCase()}` : null);
export const LLAMA_PAGES = {
  chains: "https://defillama.com/chains",
  protocols: "https://defillama.com/",
  fees: "https://defillama.com/fees",
  dexs: "https://defillama.com/dexs",
  yields: "https://defillama.com/yields",
  stablecoins: "https://defillama.com/stablecoins",
} as const;

export function dexscreenerPair(chain: string, pair: string): string | null {
  if (!/^[a-z0-9_-]{2,30}$/i.test(chain) || !/^[A-Za-z0-9_:-]{20,100}$/.test(pair)) return null;
  return `https://dexscreener.com/${chain.toLowerCase()}/${pair.toLowerCase()}`;
}

export function geckoPool(network: string, pool: string): string | null {
  if (!/^[a-z0-9_-]{2,30}$/i.test(network) || !/^[A-Za-z0-9_:-]{20,100}$/.test(pool)) return null;
  return `https://www.geckoterminal.com/${network.toLowerCase()}/pools/${pool}`;
}

/** Query parameters a primary host keeps (a value must match); every other parameter is dropped */
const PRIMARY_PARAMS: Record<string, Record<string, RegExp>> = {
  "solscan.io": { cluster: /^(devnet|testnet)$/ },
  "explorer.solana.com": { cluster: /^(devnet|testnet)$/ },
  // a coin's page opened on one callout (pump_callouts: free/pumpcallouts.ts)
  "pump.fun": { highlight_callout: CALLOUT_ID_RE },
};

/** arkham's explorer: an address's, an entity's, a token's or a transaction's page */
const ARKHAM_PATH = /^\/explorer\/(address|entity|token|tx)\/[A-Za-z0-9_:.-]{1,100}$/;
/** A pump.fun coin's page: /coin/<mint> */
const PUMP_COIN_PATH = /^\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A URL from a data source, kept only on a primary host (https, no credentials, no port), rebuilt
 * from its host and path (twitter.com becomes x.com). The query string is dropped (a referral or
 * tracking tag rides there), except a parameter the host needs (PRIMARY_PARAMS); the fragment too.
 * Anything else is null.
 */
export function primaryUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 400) return null;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  let host = url.hostname.toLowerCase();
  if (host === "twitter.com" || host === "www.twitter.com" || host === "www.x.com" || host === "mobile.twitter.com") host = "x.com";
  if (host === "geckoterminal.com") host = "www.geckoterminal.com";
  if (host === "www.solscan.io") host = "solscan.io";
  if (host === "coingecko.com") host = "www.coingecko.com";
  if (host === "www.jup.ag") host = "jup.ag";
  if (host === "www.polymarket.com") host = "polymarket.com";
  if (host === "www.defillama.com") host = "defillama.com";
  if (host === "www.dexscreener.com") host = "dexscreener.com";
  if (host === "www.rugcheck.xyz") host = "rugcheck.xyz";
  if (host === "www.gopluslabs.io") host = "gopluslabs.io";
  if (!PRIMARY_HOSTS.has(host)) return null;
  // pump.fun: a coin's page only (a referral, a profile or the board are no primary source)
  if (host === "pump.fun" && !PUMP_COIN_PATH.test(url.pathname)) return null;
  // arkham: an explorer page only (its front page, a sign-up or a referral are none)
  if (host === "intel.arkm.com" && !ARKHAM_PATH.test(url.pathname)) return null;
  const keep = new URLSearchParams();
  for (const [k, re] of Object.entries(PRIMARY_PARAMS[host] ?? {})) {
    const v = url.searchParams.get(k);
    if (v !== null && re.test(v)) keep.set(k, v);
  }
  const q = keep.toString();
  return `https://${host}${url.pathname}${q ? `?${q}` : ""}`;
}

/** Query parameters that tag where a click came from (tracking, referral, affiliate), never the page itself */
const TRACKING_PARAM = /^(utm_.*|ref|ref_.*|refs?rc|referr?er|referral.*|source|src|via|aff|aff_.*|affiliate.*|partner.*|campaign.*|cmp|cmpid|fbclid|gclid|gclsrc|dclid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_hs.*|hs_.*|mkt_tok|trk|trk_.*|tracking.*|share|si|s_cid|cid|clickid|click_id|from)$/i;

/**
 * A web search result's own URL: the page is the primary source. https/http, a public-looking DNS
 * host (no IP, no localhost, no credentials, no port), fragment and tracking/referral parameters
 * dropped. The redaction guard still runs over it afterwards.
 */
export function webPageUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 400) return null;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") return null;
  url.hash = "";
  for (const k of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(k)) url.searchParams.delete(k);
  url.search = url.searchParams.toString();
  return url.toString();
}

/** Sources without duplicates or empty URLs, at most `max` */
export function uniqueSources(list: (ToolSource | null | undefined)[], max = 8): ToolSource[] {
  const seen = new Set<string>();
  const out: ToolSource[] = [];
  for (const s of list) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ title: s.title.slice(0, 120), url: s.url });
    if (out.length >= max) break;
  }
  return out;
}

export const src = (title: string, url: string | null): ToolSource | null => (url ? { title, url } : null);
