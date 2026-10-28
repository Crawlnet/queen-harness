// DexScreener: the feed of token profile updates (the paid "Enhanced Token Info") and of CTOs.
// This is where the description, site, socials, picture and header the team or community set after launch show up.
const get = async url => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`dexscreener ${r.status}`);
  return r.json();
};

const slimLinks = links => (links || []).map(l => ({ type: l.type || l.label || null, url: l.url })).filter(l => l.url);

export async function dexProfileUpdates() {
  const out = [];
  const [profiles, ctos] = await Promise.all([
    get('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => []),
    get('https://api.dexscreener.com/community-takeovers/latest/v1').catch(() => []),
  ]);
  for (const p of profiles || []) if (p.chainId === 'solana')
    out.push({ mint: p.tokenAddress, description: p.description || null, links: slimLinks(p.links), icon: p.icon, header: p.header, cto: !!p.cto });
  for (const p of ctos || []) if (p.chainId === 'solana')
    out.push({ mint: p.tokenAddress, description: p.description || null, links: slimLinks(p.links), icon: p.icon, header: p.header, cto: true, ctoAt: p.claimDate || null });
  return out;
}
