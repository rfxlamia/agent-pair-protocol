import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type RelayDatabase = Database.Database;

export function createDatabase(path = ":memory:"): RelayDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}
