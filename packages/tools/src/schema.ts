// The small JSON-schema subset our tool arguments use, validated here (no dependency): an object of
// plain string / integer / number / boolean fields with enum, pattern, length and range limits, and
// arrays of such plain values.

import type { ToolParameter, ToolParameterItems, ToolParameters } from "@crawlnet/shared";

export type ArgsCheck = { ok: true; args: Record<string, unknown> } | { ok: false; message: string };

const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/;
/** Property names: snake_case, or camelCase where a source's own inputs are passed through */
const PROP_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SCALARS = ["string", "integer", "number", "boolean"];

/**
 * Check a model's arguments against a tool's schema. Unknown fields are dropped (models add stray
 * ones); strings are trimmed; numbers given as numeric strings are accepted; defaults are applied.
 * Messages are ours and name only our own fields.
 */
export function validateArgs(schema: ToolParameters, raw: unknown): ArgsCheck {
  let input: Record<string, unknown>;
  if (raw === undefined || raw === null || raw === "") input = {};
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, message: "arguments must be a JSON object" };
      input = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, message: "arguments must be a JSON object" };
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) input = raw as Record<string, unknown>;
  else return { ok: false, message: "arguments must be a JSON object" };

  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    let v = input[key];
    if (v === null || v === "") v = undefined;
    if (v === undefined) {
      if (schema.required?.includes(key)) return { ok: false, message: `${key} is required` };
      if (prop.default !== undefined) out[key] = prop.default;
      continue;
    }
    const r = checkValue(key, prop, v);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return { ok: true, args: out };
}

type Checked = { ok: true; value: unknown } | { ok: false; message: string };

function checkValue(key: string, p: ToolParameter, v: unknown): Checked {
  if (p.type === "array") {
    // a list given as JSON text is read as the list; a single value where a list is expected as a list of one
    if (typeof v === "string" && v.trim().startsWith("[")) {
      try {
        v = JSON.parse(v) as unknown;
      } catch {
        return { ok: false, message: `${key} must be a list` };
      }
    }
    const list = Array.isArray(v) ? v : [v];
    if (p.minItems !== undefined && list.length < p.minItems) return { ok: false, message: `${key} needs at least ${p.minItems} items` };
    if (p.maxItems !== undefined && list.length > p.maxItems) return { ok: false, message: `${key} takes at most ${p.maxItems} items` };
    const out: unknown[] = [];
    for (const x of list) {
      if (x === null || x === undefined || x === "") continue;
      const r = checkScalar(key, p.items ?? { type: "string" }, x);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  return checkScalar(key, p, v);
}

function checkScalar(key: string, p: ToolParameter | ToolParameterItems, v: unknown): Checked {
  switch (p.type) {
    case "string": {
      if (typeof v === "number" && Number.isFinite(v)) v = String(v);
      if (typeof v !== "string") return { ok: false, message: `${key} must be a string` };
      const s = v.trim();
      if ("minLength" in p && p.minLength !== undefined && s.length < p.minLength) return { ok: false, message: `${key} is too short` };
      if (p.maxLength !== undefined && s.length > p.maxLength) return { ok: false, message: `${key} is too long` };
      if (p.enum) {
        const hit = p.enum.find((e) => typeof e === "string" && e.toLowerCase() === s.toLowerCase());
        if (hit === undefined) return { ok: false, message: `${key} must be one of: ${p.enum.join(", ")}` };
        return { ok: true, value: hit };
      }
      if (p.pattern && !new RegExp(p.pattern, "u").test(s)) return { ok: false, message: `${key} has the wrong format` };
      return { ok: true, value: s };
    }
    case "integer":
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, message: `${key} must be a number` };
      if (p.type === "integer" && !Number.isInteger(n)) return { ok: false, message: `${key} must be a whole number` };
      // a number past its bounds is brought to them, never refused: asking for 30 rows of 25 at most means as many as
      // there are
      const c = Math.min(p.maximum ?? Infinity, Math.max(p.minimum ?? -Infinity, n));
      if (p.enum && !p.enum.includes(c)) return { ok: false, message: `${key} must be one of: ${p.enum.join(", ")}` };
      return { ok: true, value: c };
    }
    case "boolean": {
      if (typeof v === "boolean") return { ok: true, value: v };
      if (v === "true" || v === "false") return { ok: true, value: v === "true" };
      return { ok: false, message: `${key} must be true or false` };
    }
    default:
      return { ok: false, message: `${key} has an unsupported type` };
  }
}

/** Longest descriptions */
const DESCRIPTION_LIMITS = { tool: 600, property: 300 };

/**
 * Problems with a tool definition as function calling expects it; empty when fine. Used by the tests over every tool
 * and at start-up (a broken definition is left out).
 */
export function schemaProblems(spec: { name: string; description: string; parameters: ToolParameters }, limits = DESCRIPTION_LIMITS): string[] {
  const out: string[] = [];
  if (!NAME_RE.test(spec.name)) out.push(`name ${spec.name} must match ${NAME_RE}`);
  if (!spec.description || spec.description.length > limits.tool) out.push(`${spec.name}: description must be 1..${limits.tool} chars`);
  const s = spec.parameters;
  if (s.type !== "object") out.push(`${spec.name}: parameters.type must be object`);
  if (s.additionalProperties !== false) out.push(`${spec.name}: additionalProperties must be false`);
  const props = Object.entries(s.properties ?? {});
  for (const r of s.required ?? []) if (!(r in (s.properties ?? {}))) out.push(`${spec.name}: required ${r} is not a property`);
  for (const [k, p] of props) {
    if (!PROP_RE.test(k)) out.push(`${spec.name}.${k}: bad property name`);
    if (![...SCALARS, "array"].includes(p.type)) out.push(`${spec.name}.${k}: bad type`);
    if (!p.description || p.description.length > limits.property) out.push(`${spec.name}.${k}: description must be 1..${limits.property} chars`);
    for (const pat of [p.pattern, p.items?.pattern]) {
      if (!pat) continue;
      try {
        new RegExp(pat, "u");
      } catch {
        out.push(`${spec.name}.${k}: pattern does not compile`);
      }
    }
    if (p.enum && (!Array.isArray(p.enum) || p.enum.length === 0)) out.push(`${spec.name}.${k}: empty enum`);
    if (p.type === "array") {
      if (!p.items || !SCALARS.includes(p.items.type)) out.push(`${spec.name}.${k}: array items must be plain values`);
      if (p.default !== undefined) out.push(`${spec.name}.${k}: an array takes no default`);
    } else if (p.items || p.minItems !== undefined || p.maxItems !== undefined) out.push(`${spec.name}.${k}: items only for an array`);
    if (p.default !== undefined && p.type !== "array") {
      const r = checkValue(k, p, p.default);
      if (!r.ok) out.push(`${spec.name}.${k}: default does not validate`);
    }
    const allowed = new Set(["type", "description", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum", "default", "items", "minItems", "maxItems"]);
    for (const kw of Object.keys(p)) if (!allowed.has(kw)) out.push(`${spec.name}.${k}: keyword ${kw} is not supported`);
  }
  return out;
}

// Shared argument shapes (patterns are anchored; base58 has no 0, O, I, l).
export const SOL_ADDRESS = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";
export const SOL_SIGNATURE = "^[1-9A-HJ-NP-Za-km-z]{64,90}$";
export const ANY_ADDRESS = "^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$";
/** A search phrase: letters, digits, spaces and a little punctuation, no URLs */
export const QUERY = "^[\\p{L}\\p{N} $#@&'.,_+\\-/()?!]{1,120}$";

export function limitParam(def: number, max: number, what = "results"): ToolParameter {
  return { type: "integer", description: `How many ${what} to return (1-${max}, default ${def})`, minimum: 1, maximum: max, default: def };
}
