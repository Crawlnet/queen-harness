// Text from a source as the model may read it: a callout's thesis, a display name. Plain, short, with no link that
// could lure a reader (a bare domain, a t.me or discord.gg invite).

import { cleanText } from "../sanitize.ts";
import { MINUTE } from "../types.ts";

const NAME_MAX = 24;
const THESIS_MAX = 200;
const RETRY_AFTER_MAX_MS = 10 * MINUTE;

/**
 * A link written without its scheme: a bare domain ("claim-example.io", "claim.example.xyz/x"), a t.me or discord.gg invite.
 * Not one inside a full link (cleanText keeps those only to primary pages), not an SNS name ("mike.sol")
 */
const BARE_LINK =
  /(?<![\p{L}\p{N}_@./:\\-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|io|fun|xyz|net|org|app|gg|me|co|so|sh|ai|to|ly|cc|tv|in|info|biz|pro|vip|club|top|site|online|link|live|lol|finance|money|exchange|cash|dev|tech|gl|ink|wtf|meme|bot|ws|us|uk|ru|de|claim|claims|gift|win|bet|casino|trade|market|markets|network|digital|world|today|space|store|shop|page|social|chat|wiki|cloud|zone|click|one|tools|email)(?![\p{L}\p{N}_-])/iu;

/**
 * ...and any other lower-case host on any short TLD ("claim-example.pw", "drop-example.su", "claim-example.sx") or an IPv4 address; not
 * an SNS or ENS-like name ("mike.sol", "vitalik.eth"), not a number ("1.2m"), not a sentence's end ("it.Then")
 */
const BARE_HOST =
  /(?<![\p{L}\p{N}_@./:\\-])(?:[a-z][a-z0-9-]{0,62}\.)+(?!(?:sol|eth|bnb|base|ton|sui|apt|btc|arb|avax)(?![a-z0-9-]))[a-z]{2,6}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])|(?<![\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?![\p{N}]|\.\p{N})/u;
const bareLink = (s: string) => BARE_LINK.test(s) || BARE_HOST.test(s);

/**
 * A thesis as the model may read it: plain text, 200 characters, no fence or code marks, links only to primary pages;
 * none at all when it holds a link without its scheme
 */
export function cleanThesis(text: string): string | null {
  const s = cleanText(text.replace(/[`<>]/g, "'"), THESIS_MAX) ?? null;
  return s !== null && bareLink(s) ? null : s;
}

/** A display name as the model may read it: plain, 24 characters; none when it holds a link of any kind */
export function cleanName(v: string | null | undefined, max = NAME_MAX): string | null {
  if (typeof v !== "string") return null;
  if (/(?:https?:\/\/|www\.)/i.test(v) || bareLink(v)) return null;
  return cleanText(v.replace(/[`<>]/g, "'"), max) ?? null;
}

/** Milliseconds a Retry-After asks for (seconds or an HTTP date), 1 s when it says nothing */
export function retryAfterMs(v: string | null, now: number): number {
  const s = v?.trim() ?? "";
  if (s && /^\d+(\.\d+)?$/.test(s)) return Math.min(RETRY_AFTER_MAX_MS, Number(s) * 1000);
  const at = s ? Date.parse(s) : NaN;
  if (Number.isFinite(at)) return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, at - now));
  return 1000;
}
