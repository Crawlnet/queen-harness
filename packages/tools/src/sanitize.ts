// Plain-text cleaning shared by the tools layer: no control or format characters, links only to primary
// hosts, whitespace collapsed, capped.

import { primaryUrl } from "./links.ts";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const LINKS = /(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;

/** Plain text: no control or format characters, links only to primary hosts, whitespace collapsed, capped. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // format characters (zero-width, bidi controls, soft hyphens) go without a trace; other controls become spaces
  let s = v.replace(/\p{Cf}/gu, "").replace(CONTROL, " ");
  s = s.replace(LINKS, (m) => primaryUrl(m.replace(/[.,;:!?]+$/, "")) ?? "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
