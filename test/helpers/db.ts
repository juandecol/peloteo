// Base de datos de prueba: SQLite en memoria (node:sqlite) con la misma API
// mínima de D1 que usa la lógica (prepare/bind/first/all/run y batch transaccional).
// Aplica las migraciones reales de migrations/.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Value = string | number | null;

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

class Statement {
  readonly sql: string;
  readonly params: Value[];
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, sql: string, params: Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): Statement {
    return new Statement(
      this.db,
      this.sql,
      values.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : (v as Value))),
    );
  }

  runSync() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return ((this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
  }

  async run() {
    return this.runSync();
  }
}

export class TestDb {
  readonly raw: DatabaseSync;

  /** Aplica las migraciones en orden; con `upTo`, solo hasta ese archivo (incluido). */
  constructor(upTo?: string) {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const file of migrationFiles()) {
      if (upTo && file > upTo) break;
      this.applyMigration(file);
    }
  }

  /** Aplica una migración dentro de una transacción, como D1. */
  applyMigration(file: string): void {
    this.raw.exec("BEGIN");
    try {
      this.raw.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  prepare(sql: string): Statement {
    return new Statement(this.raw, sql);
  }

  async batch(statements: Statement[]) {
    // Como D1: una transacción; si una sentencia falla, se revierte todo.
    this.raw.exec("BEGIN");
    try {
      const results = statements.map((s) => s.runSync());
      this.raw.exec("COMMIT");
      return results;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  /** Ejecuta SQL directo (para preparar escenarios). */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get<T>(sql: string, ...params: Value[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  count(sql: string, ...params: Value[]): number {
    return Number((this.raw.prepare(sql).get(...params) as { n: number }).n);
  }
}

/** Base con el esquema y los datos de ejemplo, pero sin encuentros. */
export function emptyGamesDb(): TestDb {
  const db = new TestDb();
  db.exec("DELETE FROM players; DELETE FROM games;");
  return db;
}
