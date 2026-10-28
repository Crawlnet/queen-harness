// Outbound HTTP of the tools layer: only to a fixed set of hosts (the free data APIs, the RPC
// endpoints from env), never to a URL a user or a data source supplied.
// The registry hands it a hedged fetch (every request here is a read): see FREE_HEDGE and toolsHedge in registry.ts.

import { ToolFail, type FetchLike } from "./types.ts";

export const MB = 1024 * 1024;

export interface JsonRequest {
  signal: AbortSignal;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Refuse bodies larger than this (default 4 MB) */
  maxBytes?: number;
}

export class Http {
  private readonly hosts = new Set<string>();
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike) {
    this.fetchImpl = fetchImpl;
  }

  /** Allow requests to this host (host[:port]) */
  allow(host: string): void {
    this.hosts.add(host.toLowerCase());
  }

  allows(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === "https:" || u.protocol === "http:") && this.hosts.has(u.host.toLowerCase());
    } catch {
      return false;
    }
  }

  /** The raw response of an allowed request (callers read it themselves; redirects fail unless `init.redirect` says otherwise); network trouble → ToolFail("unavailable"). */
  async raw(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    if (!this.allows(url)) throw new ToolFail("unavailable");
    try {
      return await this.fetchImpl(url, { redirect: "error", ...init });
    } catch {
      throw new ToolFail("unavailable");
    }
  }

  /** GET/POST and parse JSON. 404/400/410 → not_found, 429 → rate_limited, anything else → unavailable. */
  async json(url: string, req: JsonRequest): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.raw(url, {
      method: req.method ?? (req.body !== undefined ? "POST" : "GET"),
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: req.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ToolFail(statusError(res.status));
    }
    const text = await readCapped(res, req.maxBytes ?? 4 * MB);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ToolFail("unavailable");
    }
  }
}

export function statusError(status: number): "not_found" | "rate_limited" | "unavailable" {
  if (status === 404 || status === 400 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

/** The body as text, refusing more than `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => {});
    throw new ToolFail("unavailable");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new ToolFail("unavailable");
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ToolFail) throw err;
    throw new ToolFail("unavailable");
  }
  return Buffer.concat(chunks).toString("utf8");
}
