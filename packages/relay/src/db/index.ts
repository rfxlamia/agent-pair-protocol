import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALLOWLIST_WIRE_VERSION = "sign-the-blob-v1";

export type RelayDatabase = Database.Database;

export function createDatabase(path = ":memory:"): RelayDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  // Cutover: relay_meta stores allowlist_wire_version; first open after upgrade truncates legacy allowlists once.
  db.exec("CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const versionRow = db
    .prepare("SELECT value FROM relay_meta WHERE key = 'allowlist_wire_version'")
    .get() as { value: string } | undefined;

  if (versionRow?.value !== ALLOWLIST_WIRE_VERSION) {
    db.prepare("DELETE FROM allowlists").run();
    db.prepare(
      "INSERT OR REPLACE INTO relay_meta (key, value) VALUES ('allowlist_wire_version', ?)",
    ).run(ALLOWLIST_WIRE_VERSION);
  }

  return db;
}
