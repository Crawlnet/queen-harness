// Internal shapes of the tools layer. The public contract (ToolSpec, ToolResult, ToolsModule) is in
// @crawlnet/shared modules.ts.

import type { ToolError, ToolParameters, ToolSource } from "@crawlnet/shared";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * What a provider hands back before the registry redacts and caches it. `detail`: a query tool's error as
 * the upstream put it (redacted, short), for the model to fix its query; never logged. `brief`: a read cut short for a
 * passing reason (the limiter busy with other reads, out of time, reads that failed), kept a minute only: a later call
 * gets further. A read cut at its own size is kept the tool's TTL: reading it again gets no further.
 */
export type Outcome =
  | { ok: true; data: unknown; sources: ToolSource[]; brief?: boolean }
  /** `message`: ours, for a refusal of ours the model can act on (an argument it needs) */
  | { ok: false; error: ToolError; detail?: string; message?: string };

/** Everything one tool call may use. */
interface RunIO {
  /** Fires on the tool's timeout or when the caller's answer gives up */
  signal: AbortSignal;
  /**
   * Who asked, by the kind of its answer id (callerOf: chat, scan, plan…), for a provider's spend by caller (the launch read's Helius credits); the first asker of a shared read
   */
  caller?: string;
}

/** The kind of an answer id, never the id: what a provider's spend is booked under */
export function callerOf(answerId: string | undefined): string {
  const id = typeof answerId === "string" ? answerId : "";
  const head = /^([a-z][a-z0-9_-]{1,20})(?::|$)/i.exec(id)?.[1];
  if (head && !/^[0-9a-f]{8}$/i.test(head)) return head.toLowerCase();
  // a uuid: a chat answer, with its scan's or plan's suffix
  if (/:plan:/.test(id)) return "plan";
  if (/^[0-9a-f-]{36}:[a-z_]+$/i.test(id)) return "scan";
  return "answer";
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** How long an ok result is reused (ms, <= 24 h) */
  ttlMs: number;
  /** A slow search (seconds to tens of seconds): it runs up to SLOW_TOOL_TIMEOUT_MS, not the tools' timeout */
  slow?: boolean;
  /** Its results are web pages found by a search (any public host): its sources are kept as such (links.ts webPageUrl) */
  webSources?: boolean;
  /** Its source refuses us for now (a block it cannot pass): left out of the offered tools while this says so */
  down?: () => boolean;
  /** Arguments are already validated against `parameters` (defaults applied, strings trimmed) */
  run(args: Record<string, unknown>, io: RunIO): Promise<Outcome>;
}

/** Thrown inside providers; the registry turns it into a generic ToolResult error. */
export class ToolFail extends Error {
  readonly code: ToolError;

  constructor(code: ToolError) {
    super(code);
    this.name = "ToolFail";
    this.code = code;
  }
}

export const GENERIC_MESSAGE: Record<ToolError, string> = {
  unavailable: "this data is not available right now",
  bad_args: "the arguments are not valid for this tool",
  not_found: "nothing was found for these arguments",
  rate_limited: "too many data requests right now, try later",
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
