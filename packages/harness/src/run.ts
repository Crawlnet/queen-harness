// The harness put together from env: the tools layer over its own SQLite file (caches, call counts, the wallet memory),
// the page reader, and the harness. Reads a .env in the working directory when there is one.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb, type ModuleContext, type ToolsModule } from "@crawlnet/shared";
import { createToolsWith } from "@crawlnet/tools";
import { createHarness, type Harness } from "./ask.ts";
import { loadHarnessConfig } from "./config.ts";
import { withPageReader } from "./page.ts";

export interface Running {
  harness: Harness;
  tools: ToolsModule;
  stop(): void;
}

/** One log line as JSON on stderr: the message and its fields, never a key */
function jsonLog(msg: string, extra?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), msg, ...(extra ?? {}) })}\n`);
}

export function start(o: { env?: NodeJS.ProcessEnv; log?: ModuleContext["log"]; background?: boolean } = {}): Running {
  if (!o.env && existsSync(".env")) process.loadEnvFile(".env");
  const env = o.env ?? process.env;
  const log = o.log ?? (env.HARNESS_QUIET === "1" ? () => {} : jsonLog);
  const dir = resolve(env.DATA_DIR?.trim() || "data");
  mkdirSync(dir, { recursive: true });
  const db = openDb(join(dir, "harness.sqlite"));
  const raw = createToolsWith({ db, env, log }, { background: o.background !== false });
  const tools = withPageReader(raw, { log });
  const harness = createHarness({ cfg: loadHarnessConfig(env), tools, db, log });
  return {
    harness,
    tools,
    stop() {
      raw.stop();
      db.close();
    },
  };
}
