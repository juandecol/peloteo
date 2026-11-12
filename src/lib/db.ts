// Subconjunto de la API de D1 que usa la lógica de negocio.
// D1Database lo cumple; en las pruebas lo cumple un adaptador sobre node:sqlite.

export interface DbResult {
  meta: { changes: number };
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<DbResult>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  /** Ejecuta las sentencias en una sola transacción: todas o ninguna. */
  batch(statements: DbStatement[]): Promise<DbResult[]>;
}

/** Genera "n" signos de interrogación separados por coma para una lista IN (...). */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** ID corto con prefijo, por ejemplo "E-7KQ2M". */
export function newId(prefix: string, length = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return prefix + "-" + out;
}

/** Token aleatorio en hex (32 caracteres), para enlaces de cancelación. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
