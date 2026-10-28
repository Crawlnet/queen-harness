// In-memory LRU with a TTL per entry (capped at 24 h), plus in-flight sharing so concurrent identical
// calls make one request.

import { DAY } from "./types.ts";

export class TtlCache<V> {
  private readonly map = new Map<string, { v: V; until: number }>();
  private readonly inflight = new Map<string, Promise<V>>();

  private readonly max: number;
  private readonly now: () => number;

  constructor(max: number, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.until <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: V, ttlMs: number): void {
    const ttl = Math.max(0, Math.min(ttlMs, DAY));
    if (ttl === 0) return;
    this.map.delete(key);
    this.map.set(key, { v, until: this.now() + ttl });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** The cached value, or the one `load` gives (shared by concurrent callers of the same key); `ttl` decides per value. */
  async through(key: string, load: () => Promise<V>, ttl: (v: V) => number): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = load().then(
      (v) => {
        this.set(key, v, ttl(v));
        return v;
      },
    ).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** A stable cache key for a tool call: name + arguments with sorted keys. */
export function callKey(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return name + "?" + keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join("&");
}
