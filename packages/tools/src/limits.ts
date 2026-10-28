// Budgets: tool calls per answer, a paid provider's calls per UTC day (kept in SQLite, table tools_usage, one column
// per provider, so a restart does not reset it) and per-provider rate limiters.

import { migrate, type Db } from "@crawlnet/shared";
import { MINUTE } from "./types.ts";

/** An answer id's count starts over this long after its first call (an id reused later is a new answer) */
export const ANSWER_WINDOW_MS = 30 * MINUTE;

/** At most `max` calls per answer id; an id older than ANSWER_WINDOW_MS starts over. */
export class AnswerBudget {
  private readonly used = new Map<string, { n: number; at: number }>();
  readonly max: number;
  private readonly now: () => number;

  constructor(max: number, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
  }

  take(answerId: string): boolean {
    const t = this.now();
    if (this.used.size > 500) for (const [k, v] of this.used) if (t - v.at > ANSWER_WINDOW_MS) this.used.delete(k);
    let e = this.used.get(answerId);
    if (!e || t - e.at > ANSWER_WINDOW_MS) e = { n: 0, at: t };
    if (e.n >= this.max) return false;
    e.n += 1;
    this.used.set(answerId, e);
    return true;
  }

  usedBy(answerId: string): number {
    const e = this.used.get(answerId);
    return e && this.now() - e.at <= ANSWER_WINDOW_MS ? e.n : 0;
  }
}

/** At most `perWindow` takes in any sliding window of `windowMs`. */
export class WindowLimiter {
  private stamps: number[] = [];
  readonly perWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(perWindow: number, windowMs = MINUTE, now: () => number = Date.now) {
    this.perWindow = perWindow;
    this.windowMs = windowMs;
    this.now = now;
  }

  take(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    if (this.stamps.length >= this.perWindow) return false;
    this.stamps.push(t);
    return true;
  }

  /** Takes left in the window now (a long read stops while others still have room: sol_holder_links) */
  left(): number {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    return Math.max(0, this.perWindow - this.stamps.length);
  }
}

const MIGRATIONS = [
  {
    id: "tools/001_usage",
    sql: `CREATE TABLE tools_usage (day TEXT PRIMARY KEY)`,
  },
  {
    // the X search on Grok, paid per post it fetches (free/grokx.ts)
    id: "tools/002_usage_xsearch",
    sql: `ALTER TABLE tools_usage ADD COLUMN xsearch_calls INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // the web search on Grok, paid per call (free/grokweb.ts)
    id: "tools/003_usage_news",
    sql: `ALTER TABLE tools_usage ADD COLUMN news_calls INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // the data hub: its calls, and the weight of its credit-billed routes (free/hub.ts)
    id: "tools/004_usage_hub",
    sql: `ALTER TABLE tools_usage ADD COLUMN hub_calls INTEGER NOT NULL DEFAULT 0; ALTER TABLE tools_usage ADD COLUMN hub_credits INTEGER NOT NULL DEFAULT 0`,
  },
];

/** What a DailyCounter counts: a column of tools_usage */
export type UsageColumn = "xsearch_calls" | "news_calls" | "hub_calls" | "hub_credits";
/** Each column by its own name: a name not listed here counts nowhere (never into another provider's column) */
const USAGE_COLUMNS: Record<UsageColumn, string> = { xsearch_calls: "xsearch_calls", news_calls: "news_calls", hub_calls: "hub_calls", hub_credits: "hub_credits" };

/**
 * Calls per UTC day, capped, in a paid provider's column (the data hub's credits: a call's weight at once, take(n)).
 * Persisted when a db is given.
 */
export class DailyCounter {
  private day = "";
  private n = 0;
  private readonly bump: ((day: string, n: number) => void) | null;
  private readonly read: ((day: string) => number) | null;
  readonly limit: number;
  private readonly now: () => number;

  constructor(limit: number, db: Db | null, now: () => number, column: UsageColumn) {
    this.limit = limit;
    this.now = now;
    if (db) {
      migrate(db, MIGRATIONS);
      const c = Object.hasOwn(USAGE_COLUMNS, column) ? USAGE_COLUMNS[column] : null;
      if (!c) throw new Error("tools: no such usage column");
      const up = db.prepare(`INSERT INTO tools_usage (day, ${c}) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ${c} = ${c} + excluded.${c}`);
      const get = db.prepare(`SELECT ${c} AS n FROM tools_usage WHERE day = ?`);
      this.bump = (day, n) => void up.run(day, n);
      this.read = (day) => ((get.get(day) as { n: number } | undefined)?.n ?? 0);
    } else {
      this.bump = null;
      this.read = null;
    }
  }

  private sync(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.n = this.read ? this.read(d) : 0;
    }
  }

  count(): number {
    this.sync();
    return this.n;
  }

  /** `n` at once (1: one call); refused, and nothing counted, when they would pass the cap */
  take(n = 1): boolean {
    this.sync();
    if (this.n + n > this.limit) return false;
    this.n += n;
    try {
      this.bump?.(this.day, n);
    } catch {
      // the count in memory still holds the cap for this process
    }
    return true;
  }
}
