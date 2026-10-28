// The interfaces the harness and the tools share: the module context and the tools module.

import type { Db } from "./db.ts";

export interface ModuleContext {
  db: Db;
  env: NodeJS.ProcessEnv;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** The page reader's function (harness page.ts): a public web page opened and read */
export const QUEEN_PAGE_SNAPSHOT_TOOL = "page_snapshot";

/** The JSON schema of a tool's arguments: an object of plain fields, as function calling expects. */
export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameter>;
  required?: string[];
  additionalProperties?: false;
}

/** One argument of a tool. Only the keywords below are used (and checked by the tools layer). */
export interface ToolParameter {
  type: "string" | "integer" | "number" | "boolean" | "array";
  description: string;
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
  /** An array's items: plain values only */
  items?: ToolParameterItems;
  minItems?: number;
  maxItems?: number;
}

/** The items of an array argument. */
export interface ToolParameterItems {
  type: "string" | "integer" | "number" | "boolean";
  enum?: (string | number)[];
  pattern?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

/** What the brain is told about a tool: `{ type: "function", function: spec }` in an OpenAI-style request. */
export interface ToolSpec {
  /** ^[a-z][a-z0-9_]{2,47}$ */
  name: string;
  /** Short and factual, written for the model */
  description: string;
  parameters: ToolParameters;
}

/** A primary source behind a tool result (explorer, post, market or data page), built by the tools layer. */
export interface ToolSource {
  title: string;
  url: string;
}

/** Generic on purpose: a tool error's code never carries text from where the data came from. */
export type ToolError = "unavailable" | "bad_args" | "not_found" | "rate_limited";

/**
 * `message` is ours, except a query tool's error: there it also says what the data service found wrong
 * with the query (redacted, short), for the model to fix it in its next round. Never shown to users or logged.
 */
export type ToolResult =
  | {
      ok: true;
      data: unknown;
      sources: ToolSource[];
    }
  | { ok: false; error: ToolError; message: string };

/** Who is calling: one answer of the harness (the per-answer call budget counts by `answerId`). */
export interface ToolRunContext {
  /** One id per user question, shared by all its rounds; required (a call without one is refused) */
  answerId: string;
  /** Aborts the call (the answer's own deadline); each tool also has its own timeout */
  signal?: AbortSignal;
}

export interface ToolsModule {
  /** The tools callable right now. */
  list(): ToolSpec[];
  /** Validate the arguments and run one tool. Never throws. */
  run(name: string, args: unknown, ctx: ToolRunContext): Promise<ToolResult>;
  /**
   * Removes the redaction terms (TOOLS_REDACT_TERMS) from text: apply to every final answer.
   */
  redact(text: string): string;
  /** Drops sources whose title or URL holds a redaction term: apply to the sources shown under an answer. */
  redactSources(sources: ToolSource[]): ToolSource[];
  stop(): void;
}

export type CreateTools = (ctx: ModuleContext) => ToolsModule;
