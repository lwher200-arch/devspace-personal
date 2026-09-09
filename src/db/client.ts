import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrateDatabase } from "./migrations.js";

export type SqliteDatabase = Database.Database;
export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;

export interface DatabaseHandle {
  sqlite: SqliteDatabase;
  db: AppDatabase;
  close(): void;
}

export function databasePath(stateDir: string): string {
  return join(stateDir, "devspace.sqlite");
}

export function openDatabase(
  stateDir: string,
  initialize?: (sqlite: SqliteDatabase) => void,
): DatabaseHandle {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = databasePath(stateDir);
  const sqlite = new Database(path);
  try {
    chmodSync(path, 0o600);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    migrateDatabase(sqlite);
    // Keep synchronous store-specific setup inside the connection owner's
    // failure boundary; a throwing constructor cannot return a handle to close.
    initialize?.(sqlite);

    return {
      sqlite,
      db: createDrizzleDatabase(sqlite),
      close: () => sqlite.close(),
    };
  } catch (error) {
    try { sqlite.close(); }
    catch (closeError) {
      throw new AggregateError([error, closeError], `Database initialization and cleanup failed: ${String(error)}`);
    }
    throw error;
  }
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
