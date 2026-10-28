import Database from "better-sqlite3";

export type Db = Database.Database;
/** A prepared statement, for packages that prepare once and keep it (no per-call Statement churn). */
export type Stmt = Database.Statement<unknown[], unknown>;

/**
 * One SQLite file for the harness. Each package owns tables with its own prefix (tools_*, queen_*) and runs its own
 * migrations through `migrate`.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, at TEXT NOT NULL)`);
  return db;
}

/** Apply each named migration once. Ids must be prefixed by the owning package: "harness/001_wallet_roles". */
export function migrate(db: Db, migrations: { id: string; sql: string }[]): void {
  const done = new Set(
    (db.prepare(`SELECT id FROM _migrations`).all() as { id: string }[]).map((r) => r.id),
  );
  const mark = db.prepare(`INSERT INTO _migrations (id, at) VALUES (?, ?)`);
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      mark.run(m.id, new Date().toISOString());
    })();
  }
}
