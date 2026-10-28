// Solana ids written in a text (a project's site, an x bio, a readme): its addresses (base58 of 32 bytes: a mint, a
// wallet, a program) and its transaction signatures (base58 of 64 bytes), for the larp check: a site that names its
// coin's address names it back, one that names another coin's was made for that one; a "live feed" of signatures the
// chain never saw is a feed made up.

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Base58 (Bitcoin alphabet) → bytes; null for a string that is not base58. */
export function base58Decode(s: string): Uint8Array | null {
  if (!s || !BASE58_RE.test(s)) return null;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (const ch of s.slice(zeros)) n = n * 58n + BigInt(BASE58.indexOf(ch));
  const body: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) body.push(Number(v & 0xffn));
  const out = new Uint8Array(zeros + body.length);
  body.reverse().forEach((b, i) => (out[zeros + i] = b));
  return out;
}
const BASE58_RUN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,88}(?![1-9A-HJ-NP-Za-km-z])/g;

/** The addresses and the transaction signatures in `text`, each in its order, at most `max` of each */
export function chainIdsIn(text: string, max = 12): { addresses: string[]; signatures: string[] } {
  const addresses: string[] = [];
  const signatures: string[] = [];
  for (const m of text.matchAll(BASE58_RUN)) {
    const s = m[0];
    const bytes = s.length <= 44 || s.length >= 86 ? base58Decode(s) : null;
    if (bytes?.length === 32 && !addresses.includes(s) && addresses.length < max) addresses.push(s);
    else if (bytes?.length === 64 && !signatures.includes(s) && signatures.length < max) signatures.push(s);
    if (addresses.length >= max && signatures.length >= max) break;
  }
  return { addresses, signatures };
}

/** Bytes → base58 (Bitcoin alphabet, as Solana). */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}
